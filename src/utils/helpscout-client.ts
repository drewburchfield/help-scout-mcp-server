import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

interface RequestMetadata {
  requestId: string;
  startTime: number;
}

interface RetryConfig {
  retries: number;
  retryDelay: number;
  maxRetryDelay: number;
  retryCondition?: (error: AxiosError) => boolean;
}

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    metadata?: RequestMetadata;
    retryConfig?: RetryConfig;
  }
}
import { config } from './config.js';
import { logger } from './logger.js';
import { cache } from './cache.js';
import { ApiError } from '../schema/types.js';

/**
 * Connection pool configuration for HTTP agents
 */
interface ConnectionPoolConfig {
  maxSockets: number;
  maxFreeSockets: number;
  timeout: number;
  keepAlive: boolean;
  keepAliveMsecs: number;
}

/**
 * Default connection pool settings optimized for Help Scout API
 */
const DEFAULT_POOL_CONFIG: ConnectionPoolConfig = {
  maxSockets: 50,        // Maximum concurrent connections
  maxFreeSockets: 10,    // Maximum idle connections to keep open
  timeout: 30000,        // Socket timeout (30s)
  keepAlive: true,       // Enable HTTP keep-alive
  keepAliveMsecs: 1000,  // Keep-alive probe interval
};

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
  private httpAgent: HttpAgent;
  private httpsAgent: HttpsAgent;
  private defaultRetryConfig: RetryConfig = {
    retries: 3,
    retryDelay: 1000, // 1 second
    maxRetryDelay: 10000, // 10 seconds
    retryCondition: (error: AxiosError) => {
      // Retry on network errors, timeouts, and 5xx responses
      return !error.response || 
             error.code === 'ECONNABORTED' ||
             (error.response.status >= 500 && error.response.status < 600) ||
             error.response.status === 429; // Rate limits
    }
  };

  constructor(poolConfig: Partial<ConnectionPoolConfig> = {}) {
    // Merge default pool config with any custom settings
    const finalPoolConfig = { ...DEFAULT_POOL_CONFIG, ...poolConfig };
    
    // Create HTTP agents with connection pooling
    this.httpAgent = new HttpAgent({
      keepAlive: finalPoolConfig.keepAlive,
      keepAliveMsecs: finalPoolConfig.keepAliveMsecs,
      maxSockets: finalPoolConfig.maxSockets,
      maxFreeSockets: finalPoolConfig.maxFreeSockets,
      timeout: finalPoolConfig.timeout,
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: finalPoolConfig.keepAlive,
      keepAliveMsecs: finalPoolConfig.keepAliveMsecs,
      maxSockets: finalPoolConfig.maxSockets,
      maxFreeSockets: finalPoolConfig.maxFreeSockets,
      timeout: finalPoolConfig.timeout,
    });

    // Create Axios instance with connection pooling agents
    this.client = axios.create({
      baseURL: config.helpscout.baseUrl,
      timeout: 30000,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      // Additional connection optimizations
      maxRedirects: 5,
      validateStatus: (status) => status < 500, // Don't throw on 4xx errors, handle them in transformError
    });

    this.setupInterceptors();
    
    logger.info('HTTP connection pool initialized', {
      maxSockets: finalPoolConfig.maxSockets,
      maxFreeSockets: finalPoolConfig.maxFreeSockets,
      keepAlive: finalPoolConfig.keepAlive,
      timeout: finalPoolConfig.timeout,
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private calculateRetryDelay(attempt: number, baseDelay: number, maxDelay: number): number {
    // Exponential backoff with jitter
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  private async executeWithRetry<T>(
    operation: () => Promise<AxiosResponse<T>>,
    retryConfig: RetryConfig = this.defaultRetryConfig
  ): Promise<AxiosResponse<T>> {
    let lastError: AxiosError | undefined;
    
    for (let attempt = 0; attempt <= retryConfig.retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as AxiosError;
        
        // Don't retry if it's the last attempt
        if (attempt === retryConfig.retries) {
          break;
        }
        
        // Check if we should retry this error
        if (!retryConfig.retryCondition?.(lastError)) {
          break;
        }
        
        // Handle rate limits specially
        if (lastError.response?.status === 429) {
          const retryAfter = parseInt(lastError.response.headers['retry-after'] || '60', 10) * 1000;
          const delay = Math.min(retryAfter, retryConfig.maxRetryDelay);
          
          logger.warn('Rate limit hit, waiting before retry', {
            attempt: attempt + 1,
            retryAfter: delay,
            requestId: lastError.config?.metadata?.requestId,
          });
          
          await this.sleep(delay);
        } else {
          // Standard exponential backoff
          const delay = this.calculateRetryDelay(attempt, retryConfig.retryDelay, retryConfig.maxRetryDelay);
          
          logger.warn('Request failed, retrying', {
            attempt: attempt + 1,
            totalAttempts: retryConfig.retries + 1,
            delay,
            error: lastError.message,
            status: lastError.response?.status,
            requestId: lastError.config?.metadata?.requestId,
          });
          
          await this.sleep(delay);
        }
      }
    }
    
    // lastError should always be defined here since we only reach this point after catching an error
    throw lastError || new Error('Request failed without error details');
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
    const requestId = error.config?.metadata?.requestId || 'unknown';
    const url = error.config?.url;
    const method = error.config?.method?.toUpperCase();

    if (error.response?.status === 401) {
      this.accessToken = null; // Force re-authentication
      return {
        code: 'UNAUTHORIZED',
        message: 'Help Scout authentication failed. Please check your API credentials.',
        details: {
          requestId,
          url,
          method,
          suggestion: 'Verify HELPSCOUT_API_KEY is valid and has proper permissions',
        },
      };
    }

    if (error.response?.status === 403) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Access forbidden. Insufficient permissions for this Help Scout resource.',
        details: {
          requestId,
          url,
          method,
          suggestion: 'Check if your API key has access to this mailbox or resource',
        },
      };
    }

    if (error.response?.status === 404) {
      return {
        code: 'NOT_FOUND',
        message: 'Help Scout resource not found. The requested conversation, mailbox, or thread does not exist.',
        details: {
          requestId,
          url,
          method,
          suggestion: 'Verify the ID is correct and the resource exists',
        },
      };
    }

    if (error.response?.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10);
      return {
        code: 'RATE_LIMIT',
        message: `Help Scout API rate limit exceeded. Please wait ${retryAfter} seconds before retrying.`,
        retryAfter,
        details: {
          requestId,
          url,
          method,
          suggestion: 'Reduce request frequency or implement request batching',
        },
      };
    }

    if (error.response?.status === 422) {
      const responseData = error.response.data as Record<string, any> || {};
      return {
        code: 'INVALID_INPUT',
        message: `Help Scout API validation error: ${responseData.message || 'Invalid request data'}`,
        details: {
          requestId,
          url,
          method,
          validationErrors: responseData.errors || responseData,
          suggestion: 'Check the request parameters match Help Scout API requirements',
        },
      };
    }

    if (error.response?.status && error.response.status >= 400 && error.response.status < 500) {
      const responseData = error.response.data as Record<string, any> || {};
      return {
        code: 'INVALID_INPUT',
        message: `Help Scout API client error: ${responseData.message || 'Invalid request'}`,
        details: {
          requestId,
          url,
          method,
          statusCode: error.response.status,
          apiResponse: responseData,
        },
      };
    }

    if (error.code === 'ECONNABORTED') {
      return {
        code: 'UPSTREAM_ERROR',
        message: 'Help Scout API request timed out. The service may be experiencing high load.',
        details: {
          requestId,
          url,
          method,
          errorCode: error.code,
          suggestion: 'Request will be automatically retried with exponential backoff',
        },
      };
    }

    if (error.response?.status && error.response.status >= 500) {
      return {
        code: 'UPSTREAM_ERROR',
        message: `Help Scout API server error (${error.response.status}). The service is temporarily unavailable.`,
        details: {
          requestId,
          url,
          method,
          statusCode: error.response.status,
          suggestion: 'Request will be automatically retried with exponential backoff',
        },
      };
    }

    return {
      code: 'UPSTREAM_ERROR',
      message: `Help Scout API error: ${error.message || 'Unknown upstream service error'}`,
      details: {
        requestId,
        url,
        method,
        errorCode: error.code,
        suggestion: 'Check your network connection and Help Scout service status',
      },
    };
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>, cacheOptions?: { ttl?: number }): Promise<T> {
    const cacheKey = `GET:${endpoint}`;
    const cachedResult = cache.get<T>(cacheKey, params);
    
    if (cachedResult) {
      return cachedResult;
    }

    const response = await this.executeWithRetry<T>(() => 
      this.client.get<T>(endpoint, { params })
    );
    
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

  /**
   * Get connection pool statistics for monitoring
   */
  getPoolStats(): {
    http: {
      sockets: number;
      freeSockets: number;
      pending: number;
    };
    https: {
      sockets: number;
      freeSockets: number;
      pending: number;
    };
  } {
    return {
      http: {
        sockets: Object.keys(this.httpAgent.sockets).length,
        freeSockets: Object.keys(this.httpAgent.freeSockets).length,
        pending: Object.keys(this.httpAgent.requests).length,
      },
      https: {
        sockets: Object.keys(this.httpsAgent.sockets).length,
        freeSockets: Object.keys(this.httpsAgent.freeSockets).length,
        pending: Object.keys(this.httpsAgent.requests).length,
      },
    };
  }

  /**
   * Gracefully close all connections in the pool
   */
  async closePool(): Promise<void> {
    logger.info('Closing HTTP connection pool');
    
    return new Promise((resolve) => {
      let closedCount = 0;
      const totalAgents = 2;

      const onClose = () => {
        closedCount++;
        if (closedCount === totalAgents) {
          logger.info('All HTTP connections closed');
          resolve();
        }
      };

      // Close HTTP agent
      this.httpAgent.destroy();
      onClose();

      // Close HTTPS agent  
      this.httpsAgent.destroy();
      onClose();
    });
  }

  /**
   * Clear idle connections to free up resources
   */
  clearIdleConnections(): void {
    const stats = this.getPoolStats();
    
    // Force destroy all agent connections by recreating them
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    
    // Recreate agents with same configuration
    const poolConfig = {
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 30000,
    };
    
    this.httpAgent = new HttpAgent(poolConfig);
    this.httpsAgent = new HttpsAgent(poolConfig);

    logger.debug('Cleared idle connections', { 
      clearedHttp: stats.http.freeSockets,
      clearedHttps: stats.https.freeSockets,
    });
  }

  /**
   * Log current connection pool status for monitoring
   */
  logPoolStatus(): void {
    const stats = this.getPoolStats();
    logger.debug('Connection pool status', stats);
  }
}

// Create client instance with connection pool config from environment
export const helpScoutClient = new HelpScoutClient(config.connectionPool);