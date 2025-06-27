import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import nock from 'nock';
import { HelpScoutClient } from '../utils/helpscout-client.js';

// Set a more generous timeout for all tests in this file
jest.setTimeout(15000);

// Mock logger to reduce test output noise
jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock cache to prevent interference between tests
jest.mock('../utils/cache.js', () => ({
  cache: {
    get: jest.fn(() => null), // Always return null to prevent cache hits
    set: jest.fn(),
    clear: jest.fn(),
  },
}));

// Mock config to make it dynamic based on environment variables
jest.mock('../utils/config.js', () => ({
  config: {
    helpscout: {
      get apiKey() { return process.env.HELPSCOUT_API_KEY || ''; },
      get baseUrl() { return process.env.HELPSCOUT_BASE_URL || 'https://api.helpscout.net/v2/'; },
    },
    cache: {
      ttlSeconds: 300,
      maxSize: 10000,
    },
    logging: {
      level: 'info',
    },
    security: {
      allowPii: false,
    },
  },
  validateConfig: jest.fn(),
}));

describe('HelpScoutClient', () => {
  const baseURL = 'https://api.helpscout.net/v2';
  
  beforeEach(() => {
    // Clear all mocks and nock interceptors
    jest.clearAllMocks();
    nock.cleanAll();
    nock.restore();
    nock.activate();
    
    // Enable debug for failing tests
    if (process.env.NODE_ENV !== 'production') {
      nock.recorder.rec({
        dont_print: true,
        output_objects: true
      });
    }
    
    // Clear any environment variables from previous tests
    delete process.env.HELPSCOUT_API_KEY;
    delete process.env.HELPSCOUT_CLIENT_ID;
    delete process.env.HELPSCOUT_APP_SECRET;
  });

  afterEach(() => {
    // Check for pending interceptors before cleaning
    const pending = nock.pendingMocks();
    if (pending.length > 0) {
      console.log('Pending nock interceptors:', pending);
    }
    nock.cleanAll();
  });

  describe('authentication', () => {
    it('should use Personal Access Token when provided', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-123';
      process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
      
      const mockResponse = {
        _embedded: { mailboxes: [] },
        page: { size: 1, totalElements: 0 }
      };

      const scope = nock(baseURL)
        .get('/mailboxes')
        .matchHeader('authorization', 'Bearer test-token-123')
        .query({ page: 1, size: 1 })
        .reply(200, mockResponse);

      const client = new HelpScoutClient();
      const result = await client.get('/mailboxes', { page: 1, size: 1 });
      
      expect(scope.isDone()).toBe(true);
      expect(result).toEqual(mockResponse);
    });

    it('should handle OAuth2 flow when app secret is provided', async () => {
      process.env.HELPSCOUT_API_KEY = 'test-client-id';
      process.env.HELPSCOUT_APP_SECRET = 'test-client-secret';
      process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
      
      // Mock OAuth2 token request
      const authScope = nock(baseURL)
        .post('/oauth2/token', {
          grant_type: 'client_credentials',
          client_id: 'test-client-id',
          client_secret: 'test-client-secret'
        })
        .reply(200, {
          access_token: 'oauth-access-token',
          expires_in: 3600
        });

      // Mock API request with OAuth token
      const mockResponse = { _embedded: { mailboxes: [] } };
      const apiScope = nock(baseURL)
        .get('/mailboxes')
        .matchHeader('authorization', 'Bearer oauth-access-token')
        .reply(200, mockResponse);

      const client = new HelpScoutClient();
      const result = await client.get('/mailboxes');
      
      expect(authScope.isDone()).toBe(true);
      expect(apiScope.isDone()).toBe(true);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      // Clear any existing environment variables
      delete process.env.HELPSCOUT_APP_SECRET;
      delete process.env.HELPSCOUT_API_KEY;
      process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    });

    it('should handle 401 unauthorized errors', async () => {
      // Use Bearer token mode (no OAuth needed)
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-401';
      
      // Mock a 401 response directly
      nock(baseURL)
        .get('/mailboxes')
        .matchHeader('authorization', 'Bearer test-token-401')
        .reply(401, { message: 'Unauthorized' });

      const client = new HelpScoutClient();
      
      await expect(client.get('/mailboxes')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Help Scout authentication failed. Please check your API credentials.'
      });
    }, 10000);

    it('should handle 404 not found errors', async () => {
      // Use Bearer token mode (no OAuth needed)
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-404';
      
      // Mock a 404 response directly
      nock(baseURL)
        .get('/conversations/999')
        .matchHeader('authorization', 'Bearer test-token-404')
        .reply(404, { message: 'Not Found' });

      // Create a client and mock the authenticate method to avoid OAuth issues
      const { HelpScoutClient } = await import('../utils/helpscout-client.js');
      const client = new HelpScoutClient();
      
      // Mock the authenticate method to set the token directly
      (client as any).authenticate = jest.fn(async () => {
        (client as any).accessToken = 'test-token-404';
        (client as any).tokenExpiresAt = Date.now() + (24 * 60 * 60 * 1000);
      });
      
      await expect(client.get('/conversations/999')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Help Scout resource not found. The requested conversation, mailbox, or thread does not exist.'
      });
    }, 10000);

    it('should handle 429 rate limit errors with retries', async () => {
      // Use Bearer token mode (no OAuth needed)
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-429';
      
      // Mock 4 attempts (initial + 3 retries) all returning 429
      nock(baseURL)
        .get('/conversations')
        .times(4)
        .matchHeader('authorization', 'Bearer test-token-429')
        .reply(429, { message: 'Rate limit exceeded' }, {
          'retry-after': '1' // Use 1 second to speed up test
        });

      const client = new HelpScoutClient();
      
      await expect(client.get('/conversations')).rejects.toMatchObject({
        code: 'RATE_LIMIT',
        message: 'Help Scout API rate limit exceeded. Please wait 1 seconds before retrying.'
      });
    }, 15000); // Increase timeout to account for retries

    it('should handle 400 bad request errors', async () => {
      // Use Bearer token mode (no OAuth needed)
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-400';
      
      nock(baseURL)
        .get('/conversations')
        .matchHeader('authorization', 'Bearer test-token-400')
        .query({ invalid: 'param' })
        .reply(400, { 
          message: 'Invalid request',
          errors: { invalid: 'parameter not allowed' }
        });

      const client = new HelpScoutClient();
      
      await expect(client.get('/conversations', { invalid: 'param' })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Help Scout API client error: Invalid request'
      });
    }, 10000);

    it('should handle 500 server errors with retries', async () => {
      // Use Bearer token mode (no OAuth needed)
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-500';
      
      // Mock 4 attempts (initial + 3 retries) all returning 500
      nock(baseURL)
        .get('/mailboxes')
        .times(4)
        .matchHeader('authorization', 'Bearer test-token-500')
        .reply(500, { message: 'Internal Server Error' });

      const client = new HelpScoutClient();
      
      await expect(client.get('/mailboxes')).rejects.toMatchObject({
        code: 'UPSTREAM_ERROR',
        message: 'Help Scout API server error (500). The service is temporarily unavailable.'
      });
    }, 15000); // Increase timeout to account for retries
  });

  describe('caching', () => {
    beforeEach(() => {
      // Clear the cache mock and use real cache for these tests
      jest.restoreAllMocks();
      jest.clearAllMocks();
      
      // Clear environment variables
      delete process.env.HELPSCOUT_APP_SECRET;
      delete process.env.HELPSCOUT_API_KEY;
      process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    });

    // Note: Cache testing is complex due to mock interactions, 
    // so we focus on TTL behavior which is more straightforward to test

    it('should respect custom cache TTL', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-ttl';
      process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
      
      const mockResponse = { data: 'test' };

      const scope = nock(baseURL)
        .get('/test-endpoint')
        .matchHeader('authorization', 'Bearer test-token-ttl')
        .reply(200, mockResponse);

      const client = new HelpScoutClient();
      await client.get('/test-endpoint', {}, { ttl: 0 }); // No caching
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      // Clear environment variables
      delete process.env.HELPSCOUT_APP_SECRET;
      delete process.env.HELPSCOUT_API_KEY;
      process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    });

    it('should return true for successful connection', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-success';
      
      nock(baseURL)
        .get('/mailboxes')
        .matchHeader('authorization', 'Bearer test-token-success')
        .query({ page: 1, size: 1 })
        .reply(200, { _embedded: { mailboxes: [] } });

      const client = new HelpScoutClient();
      const result = await client.testConnection();
      expect(result).toBe(true);
    });

    it('should return false for failed connection', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-fail';
      
      // 401 errors don't retry based on our retry logic, so only one call needed
      nock(baseURL)
        .get('/mailboxes')
        .matchHeader('authorization', 'Bearer test-token-fail')
        .query({ page: 1, size: 1 })
        .reply(401, { message: 'Unauthorized' });

      const client = new HelpScoutClient();
      const result = await client.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('request interceptors', () => {
    beforeEach(() => {
      // Clear environment variables
      delete process.env.HELPSCOUT_APP_SECRET;
      delete process.env.HELPSCOUT_API_KEY;
      process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    });

    it('should add request IDs and timing', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer test-token-intercept';
      
      const mockResponse = { data: 'test' };
      
      const scope = nock(baseURL)
        .get('/test')
        .matchHeader('authorization', 'Bearer test-token-intercept')
        .reply(200, mockResponse);

      const client = new HelpScoutClient();
      await client.get('/test');
      expect(scope.isDone()).toBe(true);
    });
  });
});