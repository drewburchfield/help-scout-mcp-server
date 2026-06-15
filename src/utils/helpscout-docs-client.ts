import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { config } from './config.js';
import { cache } from './cache.js';
import { logger } from './logger.js';
import { ApiError } from '../schema/types.js';

interface DocsRequestMetadata {
  requestId: string;
  startTime: number;
}

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    docsMetadata?: DocsRequestMetadata;
  }
}

export interface DocsCollectionEnvelope<T> {
  page?: number;
  pages?: number;
  count?: number;
  items?: T[];
}

export class HelpScoutDocsClient {
  private readonly client: AxiosInstance;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;

  constructor() {
    this.httpAgent = new HttpAgent({
      keepAlive: config.connectionPool.keepAlive,
      keepAliveMsecs: config.connectionPool.keepAliveMsecs,
      maxSockets: config.connectionPool.maxSockets,
      maxFreeSockets: config.connectionPool.maxFreeSockets,
      timeout: config.connectionPool.timeout,
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: config.connectionPool.keepAlive,
      keepAliveMsecs: config.connectionPool.keepAliveMsecs,
      maxSockets: config.connectionPool.maxSockets,
      maxFreeSockets: config.connectionPool.maxFreeSockets,
      timeout: config.connectionPool.timeout,
    });

    this.client = axios.create({
      timeout: 30000,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.client.interceptors.request.use((requestConfig) => {
      requestConfig.docsMetadata = {
        requestId: Math.random().toString(36).substring(7),
        startTime: Date.now(),
      };

      logger.debug('Docs API request', {
        requestId: requestConfig.docsMetadata.requestId,
        method: requestConfig.method?.toUpperCase(),
        url: requestConfig.url,
      });

      return requestConfig;
    });

    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        const duration = response.config.docsMetadata
          ? Date.now() - response.config.docsMetadata.startTime
          : 0;
        logger.debug('Docs API response', {
          requestId: response.config.docsMetadata?.requestId || 'unknown',
          status: response.status,
          duration,
        });
        return response;
      },
      (error: AxiosError) => {
        const duration = error.config?.docsMetadata
          ? Date.now() - error.config.docsMetadata.startTime
          : 0;
        logger.error('Docs API error', {
          requestId: error.config?.docsMetadata?.requestId || 'unknown',
          status: error.response?.status,
          message: error.message,
          duration,
        });
        return Promise.reject(error);
      }
    );
  }

  private getBaseUrl(): string {
    const baseUrl = process.env.HELPSCOUT_DOCS_BASE_URL || config.helpscout.docsBaseUrl;
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid Help Scout Docs API base URL: ${baseUrl}`);
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('HELPSCOUT_DOCS_BASE_URL must use HTTPS to protect Docs API credentials');
    }

    return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  }

  private getApiKey(): string {
    if (process.env.HELPSCOUT_DISABLE_DOCS === 'true') {
      throw {
        code: 'UNAUTHORIZED',
        message: 'Help Scout Docs API tools are disabled by HELPSCOUT_DISABLE_DOCS=true.',
        details: {
          suggestion: 'Unset HELPSCOUT_DISABLE_DOCS to use Docs API tools.',
        },
      } satisfies ApiError;
    }

    const apiKey = process.env.HELPSCOUT_DOCS_API_KEY || config.helpscout.docsApiKey;
    if (!apiKey) {
      throw {
        code: 'UNAUTHORIZED',
        message: 'Help Scout Docs API credentials missing. Set HELPSCOUT_DOCS_API_KEY to use Docs API tools.',
        details: {
          suggestion: 'Create a Help Scout Docs API key and provide it as HELPSCOUT_DOCS_API_KEY.',
        },
      } satisfies ApiError;
    }

    return apiKey;
  }

  private buildUrl(endpoint: string): string {
    const normalizedEndpoint = endpoint.replace(/^\/+/, '');
    return new URL(normalizedEndpoint, this.getBaseUrl()).toString();
  }

  private cleanParams(params?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!params) return undefined;
    const cleaned = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  private transformError(error: AxiosError): ApiError {
    const requestId = error.config?.docsMetadata?.requestId || 'unknown';
    const responseData = error.response?.data as Record<string, unknown> | undefined;
    const apiMessage = typeof responseData?.error === 'string'
      ? responseData.error
      : typeof responseData?.message === 'string'
        ? responseData.message
        : undefined;

    if (error.response?.status === 401 || error.response?.status === 403) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Help Scout Docs API authentication failed. Check HELPSCOUT_DOCS_API_KEY and Docs permissions.',
        details: { requestId, statusCode: error.response.status, apiResponse: responseData },
      };
    }

    if (error.response?.status === 404) {
      return {
        code: 'NOT_FOUND',
        message: `Help Scout Docs API resource not found${apiMessage ? `: ${apiMessage}` : ''}.`,
        details: { requestId, apiResponse: responseData },
      };
    }

    if (error.response?.status === 429) {
      return {
        code: 'RATE_LIMIT',
        message: 'Help Scout Docs API rate limit exceeded.',
        details: {
          requestId,
          limit: error.response.headers['x-ratelimit-limit'],
          remaining: error.response.headers['x-ratelimit-remaining'],
          reset: error.response.headers['x-ratelimit-reset'],
        },
      };
    }

    if (error.response?.status && error.response.status >= 400 && error.response.status < 500) {
      return {
        code: 'INVALID_INPUT',
        message: `Help Scout Docs API client error${apiMessage ? `: ${apiMessage}` : ''}.`,
        details: { requestId, statusCode: error.response.status, apiResponse: responseData },
      };
    }

    return {
      code: 'UPSTREAM_ERROR',
      message: `Help Scout Docs API error: ${error.message || 'Unknown upstream service error'}`,
      details: { requestId, statusCode: error.response?.status, errorCode: error.code },
    };
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>, cacheOptions?: { ttl?: number }): Promise<T> {
    const apiKey = this.getApiKey();
    const url = this.buildUrl(endpoint);
    const requestParams = this.cleanParams(params);
    const cacheKey = `DOCS_GET:${url}`;
    const bypassCache = cacheOptions?.ttl !== undefined && cacheOptions.ttl <= 0;

    if (!bypassCache) {
      const cachedResult = cache.get<T>(cacheKey, requestParams);
      if (cachedResult) return cachedResult;
    }

    try {
      const response = await this.client.get<T>(url, {
        params: requestParams,
        auth: {
          username: apiKey,
          password: 'X',
        },
      });

      const ttl = cacheOptions?.ttl ?? 300;
      if (!bypassCache) {
        cache.set(cacheKey, requestParams, response.data, { ttl });
      }

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw this.transformError(error);
      }
      throw error;
    }
  }
}

export const helpScoutDocsClient = new HelpScoutDocsClient();
