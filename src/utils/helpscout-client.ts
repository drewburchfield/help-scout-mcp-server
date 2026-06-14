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
  private authenticationPromise: Promise<void> | null = null;
  private httpAgent: HttpAgent;
  private httpsAgent: HttpsAgent;
  private readonly poolConfig: ConnectionPoolConfig;
  private defaultRetryConfig: RetryConfig = {
    retries: 3,
    retryDelay: 1000, // 1 second
    maxRetryDelay: 10000, // 10 seconds
    retryCondition: (error: AxiosError) => {
      // Retry on network errors, timeouts, OAuth token refresh, and 5xx responses
      return !error.response || 
             error.code === 'ECONNABORTED' ||
             (error.response.status === 401 && Boolean(config.helpscout.clientSecret)) ||
             (error.response.status >= 500 && error.response.status < 600) ||
             error.response.status === 429; // Rate limits
    }
  };

  constructor(poolConfig: Partial<ConnectionPoolConfig> = {}) {
    this.validateHttpsBaseUrl(config.helpscout.baseUrl);

    // Merge default pool config with any custom settings
    this.poolConfig = { ...DEFAULT_POOL_CONFIG, ...poolConfig };
    
    // Create HTTP agents with connection pooling
    this.httpAgent = new HttpAgent({
      keepAlive: this.poolConfig.keepAlive,
      keepAliveMsecs: this.poolConfig.keepAliveMsecs,
      maxSockets: this.poolConfig.maxSockets,
      maxFreeSockets: this.poolConfig.maxFreeSockets,
      timeout: this.poolConfig.timeout,
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: this.poolConfig.keepAlive,
      keepAliveMsecs: this.poolConfig.keepAliveMsecs,
      maxSockets: this.poolConfig.maxSockets,
      maxFreeSockets: this.poolConfig.maxFreeSockets,
      timeout: this.poolConfig.timeout,
    });

    // Create Axios instance with connection pooling agents
    this.client = axios.create({
      baseURL: config.helpscout.baseUrl,
      timeout: 30000,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      // Additional connection optimizations
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300, // Only accept 2xx; non-2xx errors throw as AxiosError for retry logic and transformError
    });

    this.setupInterceptors();
    
    logger.info('HTTP connection pool initialized', {
      maxSockets: this.poolConfig.maxSockets,
      maxFreeSockets: this.poolConfig.maxFreeSockets,
      keepAlive: this.poolConfig.keepAlive,
      timeout: this.poolConfig.timeout,
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private validateHttpsBaseUrl(baseUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid Help Scout base URL: ${baseUrl}`);
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('HELPSCOUT_BASE_URL must use HTTPS to protect OAuth2 credentials');
    }
  }

  private parseRetryAfterMs(value: unknown, fallbackMs = 60000): number {
    const rawValue = Array.isArray(value) ? value[0] : value;

    if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0) {
      return rawValue * 1000;
    }

    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }

      const retryAt = Date.parse(trimmed);
      if (Number.isFinite(retryAt)) {
        return Math.max(retryAt - Date.now(), 0);
      }
    }

    return fallbackMs;
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
        if (!axios.isAxiosError(error)) {
          throw error;
        }

        lastError = error as AxiosError;
        
        // Don't retry if it's the last attempt
        if (attempt === retryConfig.retries) {
          break;
        }
        
        // Check if we should retry this error
        if (!retryConfig.retryCondition?.(lastError)) {
          break;
        }
        
        // Handle retryable auth failures by forcing a fresh OAuth token.
        if (lastError.response?.status === 401) {
          this.invalidateAccessToken();

          logger.warn('Authentication failed, refreshing token before retry', {
            attempt: attempt + 1,
            requestId: lastError.config?.metadata?.requestId,
          });

          await this.sleep(this.calculateRetryDelay(attempt, retryConfig.retryDelay, retryConfig.maxRetryDelay));
        } else if (lastError.response?.status === 429) {
          const delay = this.parseRetryAfterMs(lastError.response.headers['retry-after']);
          
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
    
    // All errors arrive here as raw AxiosError (interceptor passes them through unchanged).
    // Transform to structured ApiError at this boundary, after all retries are exhausted.
    if (lastError) {
      throw this.transformError(lastError);
    }
    throw new Error('Request failed without error details');
  }

  private invalidateAccessToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.authenticationPromise = null;
  }

  private setupInterceptors(): void {
    // Request interceptor for authentication
    this.client.interceptors.request.use(async (config) => {
      delete (config.headers as Record<string, unknown>).Authorization;
      delete (config.headers as Record<string, unknown>).authorization;

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

        // Pass all errors through as raw AxiosError so executeWithRetry can
        // inspect .response.status for retry decisions. transformError is called
        // only after retries are exhausted (in executeWithRetry).
        return Promise.reject(error);
      }
    );
  }

  private async ensureAuthenticated(): Promise<void> {
    // Check if token is still valid
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return;
    }

    // If authentication is already in progress, wait for it
    if (this.authenticationPromise) {
      return this.authenticationPromise;
    }

    // Start authentication and cache the promise to prevent concurrent auth requests
    this.authenticationPromise = this.authenticate().finally(() => {
      this.authenticationPromise = null;
    });

    return this.authenticationPromise;
  }

  private async authenticate(): Promise<void> {
    try {
      // OAuth2 Client Credentials flow (only supported method)
      const currentApiKey = process.env.HELPSCOUT_API_KEY || '';
      const clientId = process.env.HELPSCOUT_APP_ID ||
        process.env.HELPSCOUT_CLIENT_ID ||
        (currentApiKey.startsWith('Bearer ') ? '' : currentApiKey) ||
        config.helpscout.clientId;
      const clientSecret = process.env.HELPSCOUT_APP_SECRET ||
        process.env.HELPSCOUT_CLIENT_SECRET ||
        config.helpscout.clientSecret;

      if (!clientId || !clientSecret) {
        throw new Error(
          'OAuth2 authentication required. Help Scout API only supports OAuth2 Client Credentials flow.\n' +
          'Set HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET. HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET are also supported.'
        );
      }

      const configuredBaseUrl = this.client.defaults.baseURL || config.helpscout.baseUrl;
      const baseUrl = configuredBaseUrl.endsWith('/')
        ? configuredBaseUrl
        : `${configuredBaseUrl}/`;
      const tokenUrl = new URL('oauth2/token', baseUrl).toString();
      const authRetryConfig: RetryConfig = {
        ...this.defaultRetryConfig,
        retryCondition: (error) =>
          error.response?.status !== 401 &&
          Boolean(this.defaultRetryConfig.retryCondition?.(error)),
      };

      const response = await this.executeWithRetry(() => axios.post(tokenUrl, {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }, {
        timeout: 30000,
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent,
        validateStatus: (status) => status >= 200 && status < 300,
      }), authRetryConfig);

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 minute buffer

      logger.info('Authenticated with Help Scout API using OAuth2 Client Credentials');
    } catch (error) {
      logger.error('OAuth2 authentication failed', { error: error instanceof Error ? error.message : String(error) });
      throw new Error('Failed to authenticate with Help Scout API. Check your OAuth2 credentials.');
    }
  }

  private transformError(error: AxiosError): ApiError {
    const requestId = error.config?.metadata?.requestId || 'unknown';
    const url = error.config?.url;
    const method = error.config?.method?.toUpperCase();

    // Log internal details but don't expose in API response
    logger.error('API request failed', {
      requestId,
      url,
      method,
      status: error.response?.status,
    });

    if (error.response?.status === 401) {
      this.invalidateAccessToken(); // Force re-authentication
      return {
        code: 'UNAUTHORIZED',
        message: 'Help Scout authentication failed. Please check your API credentials.',
        details: {
          requestId,
          suggestion: 'Verify HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET are valid. HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET are also supported.',
        },
      };
    }

    if (error.response?.status === 403) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Access forbidden. Insufficient permissions for this Help Scout resource.',
        details: {
          requestId,
          suggestion: 'Check if your OAuth2 app has access to this mailbox or resource',
        },
      };
    }

    if (error.response?.status === 404) {
      return {
        code: 'NOT_FOUND',
        message: 'Help Scout resource not found. The requested conversation, mailbox, or thread does not exist.',
        details: {
          requestId,
          suggestion: 'Verify the ID is correct and the resource exists',
        },
      };
    }

    if (error.response?.status === 429) {
      const retryAfter = Math.ceil(this.parseRetryAfterMs(error.response.headers['retry-after']) / 1000);
      return {
        code: 'RATE_LIMIT',
        message: `Help Scout API rate limit exceeded. Please wait ${retryAfter} seconds before retrying.`,
        retryAfter,
        details: {
          requestId,
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
        errorCode: error.code,
        suggestion: 'Check your network connection and Help Scout service status',
      },
    };
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>, cacheOptions?: { ttl?: number }): Promise<T> {
    const cacheKey = `GET:${endpoint}`;
    const bypassCache = cacheOptions?.ttl !== undefined && cacheOptions.ttl <= 0;

    if (!bypassCache) {
      const cachedResult = cache.get<T>(cacheKey, params);
      
      if (cachedResult) {
        return cachedResult;
      }
    }

    const response = await this.executeWithRetry<T>(() => 
      this.client.get<T>(endpoint, { params })
    );

    if (bypassCache) {
      return response.data;
    }
    
    if (cacheOptions?.ttl !== undefined) {
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
    if (endpoint.includes('/saved-replies')) return 300; // 5 minutes
    if (endpoint.includes('/mailboxes')) return 86400; // 24 hours
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

  private countAgentBucketEntries(buckets: { [key: string]: readonly unknown[] | undefined }): number {
    return Object.values(buckets).reduce((total, entries) => total + (entries?.length ?? 0), 0);
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
        sockets: this.countAgentBucketEntries(this.httpAgent.sockets),
        freeSockets: this.countAgentBucketEntries(this.httpAgent.freeSockets),
        pending: this.countAgentBucketEntries(this.httpAgent.requests),
      },
      https: {
        sockets: this.countAgentBucketEntries(this.httpsAgent.sockets),
        freeSockets: this.countAgentBucketEntries(this.httpsAgent.freeSockets),
        pending: this.countAgentBucketEntries(this.httpsAgent.requests),
      },
    };
  }

  /**
   * Gracefully close all connections in the pool
   */
  async closePool(): Promise<void> {
    logger.info('Closing HTTP connection pool');
    
    // Agent.destroy() is synchronous and immediately closes connections
    // so we don't need to wait for async callbacks
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    
    // Give a small delay to ensure connections are cleaned up
    await this.sleep(100);
    
    logger.info('All HTTP connections closed');
  }

  private closeIdleSockets(agent: HttpAgent | HttpsAgent): number {
    let closed = 0;
    const freeSockets = agent.freeSockets as Record<string, Array<{ destroy: () => void }>>;

    for (const [socketKey, sockets] of Object.entries(freeSockets)) {
      for (const socket of sockets || []) {
        socket.destroy();
        closed++;
      }
      delete freeSockets[socketKey];
    }

    return closed;
  }

  /**
   * Clear idle connections to free up resources
   */
  clearIdleConnections(): void {
    const stats = this.getPoolStats();
    const clearedHttp = this.closeIdleSockets(this.httpAgent);
    const clearedHttps = this.closeIdleSockets(this.httpsAgent);

    logger.debug('Cleared idle connections', {
      clearedHttp,
      clearedHttps,
      activeHttp: stats.http.sockets,
      activeHttps: stats.https.sockets,
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
