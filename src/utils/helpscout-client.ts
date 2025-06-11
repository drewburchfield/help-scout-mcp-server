import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';

interface RequestMetadata {
  requestId: string;
  startTime: number;
}

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    metadata?: RequestMetadata;
  }
}
import { config } from './config.js';
import { logger } from './logger.js';
import { cache } from './cache.js';
import { ApiError } from '../schema/types.js';

export interface PaginatedResponse<T> {
  _embedded: { [key: string]: T[] };
  _links?: {
    next?: { href: string };
    prev?: { href: string };
  };
  page?: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

export class HelpScoutClient {
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: config.helpscout.baseUrl,
      timeout: 30000,
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor for authentication
    this.client.interceptors.request.use(async (config) => {
      await this.ensureAuthenticated();
      if (this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      }
      
      const requestId = Math.random().toString(36).substring(7);
      config.metadata = { requestId, startTime: Date.now() };
      
      logger.debug('API request', {
        requestId,
        method: config.method?.toUpperCase(),
        url: config.url,
      });
      
      return config;
    });

    // Response interceptor for logging and error handling
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        const duration = response.config.metadata ? Date.now() - response.config.metadata.startTime : 0;
        logger.debug('API response', {
          requestId: response.config.metadata?.requestId || 'unknown',
          status: response.status,
          duration,
        });
        return response;
      },
      (error: AxiosError) => {
        const duration = error.config?.metadata ? Date.now() - error.config.metadata.startTime : 0;
        const requestId = error.config?.metadata?.requestId || 'unknown';
        
        logger.error('API error', {
          requestId,
          status: error.response?.status,
          message: error.message,
          duration,
        });
        
        return Promise.reject(this.transformError(error));
      }
    );
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return;
    }

    await this.authenticate();
  }

  private async authenticate(): Promise<void> {
    try {
      // Check if we have a Personal Access Token (newer approach)
      if (config.helpscout.apiKey && config.helpscout.apiKey.startsWith('Bearer ')) {
        this.accessToken = config.helpscout.apiKey.replace('Bearer ', '');
        this.tokenExpiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        logger.info('Using Personal Access Token for Help Scout API');
        return;
      }

      // Legacy OAuth2 client credentials flow
      const appSecret = process.env.HELPSCOUT_APP_SECRET;
      if (!appSecret) {
        throw new Error('HELPSCOUT_APP_SECRET required for OAuth2 authentication');
      }

      const response = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
        grant_type: 'client_credentials',
        client_id: config.helpscout.apiKey,
        client_secret: appSecret,
      });

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 minute buffer
      
      logger.info('Authenticated with Help Scout API using OAuth2');
    } catch (error) {
      logger.error('Authentication failed', { error: error instanceof Error ? error.message : String(error) });
      throw new Error('Failed to authenticate with Help Scout API');
    }
  }

  private transformError(error: AxiosError): ApiError {
    if (error.response?.status === 401) {
      this.accessToken = null; // Force re-authentication
      return {
        code: 'UNAUTHORIZED',
        message: 'Authentication failed',
        details: {},
      };
    }

    if (error.response?.status === 404) {
      return {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        details: {},
      };
    }

    if (error.response?.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10);
      return {
        code: 'RATE_LIMIT',
        message: 'Rate limit exceeded',
        retryAfter,
        details: {},
      };
    }

    if (error.response?.status && error.response.status >= 400 && error.response.status < 500) {
      const responseData = error.response.data as Record<string, any> || {};
      return {
        code: 'INVALID_INPUT',
        message: responseData.message || 'Invalid request',
        details: responseData,
      };
    }

    return {
      code: 'UPSTREAM_ERROR',
      message: error.message || 'Upstream service error',
      details: {},
    };
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>, cacheOptions?: { ttl?: number }): Promise<T> {
    const cacheKey = `GET:${endpoint}`;
    const cachedResult = cache.get<T>(cacheKey, params);
    
    if (cachedResult) {
      return cachedResult;
    }

    const response = await this.client.get<T>(endpoint, { params });
    
    if (cacheOptions?.ttl || cacheOptions?.ttl === 0) {
      cache.set(cacheKey, params, response.data, { ttl: cacheOptions.ttl });
    } else {
      // Default cache TTL based on endpoint
      const defaultTtl = this.getDefaultCacheTtl(endpoint);
      cache.set(cacheKey, params, response.data, { ttl: defaultTtl });
    }
    
    return response.data;
  }

  private getDefaultCacheTtl(endpoint: string): number {
    if (endpoint.includes('/conversations')) return 300; // 5 minutes
    if (endpoint.includes('/mailboxes')) return 1440; // 24 hours
    if (endpoint.includes('/threads')) return 300; // 5 minutes
    return 300; // Default 5 minutes
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.get('/mailboxes', { page: 1, size: 1 });
      return true;
    } catch (error) {
      logger.error('Connection test failed', { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
}

export const helpScoutClient = new HelpScoutClient();