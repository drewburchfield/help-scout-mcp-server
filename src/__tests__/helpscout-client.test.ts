import nock from 'nock';
import { HelpScoutClient } from '../utils/helpscout-client.js';

describe('HelpScoutClient', () => {
  let client: HelpScoutClient;
  const baseURL = 'https://api.helpscout.net/v2';
  
  beforeEach(() => {
    // Clear any existing nock interceptors
    nock.cleanAll();
    
    // Mock environment variables
    process.env.HELPSCOUT_API_KEY = 'Bearer test-token';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    
    client = new HelpScoutClient();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('authentication', () => {
    it('should use Personal Access Token when provided', async () => {
      const mockResponse = {
        _embedded: { mailboxes: [] },
        page: { size: 1, totalElements: 0 }
      };

      const scope = nock(baseURL)
        .get('/mailboxes')
        .matchHeader('authorization', 'Bearer test-token')
        .query({ page: 1, size: 1 })
        .reply(200, mockResponse);

      await client.get('/mailboxes', { page: 1, size: 1 });
      expect(scope.isDone()).toBe(true);
    });

    it('should handle OAuth2 flow when app secret is provided', async () => {
      process.env.HELPSCOUT_API_KEY = 'client-id';
      process.env.HELPSCOUT_APP_SECRET = 'client-secret';
      
      // Mock OAuth2 token request
      nock('https://api.helpscout.net')
        .post('/v2/oauth2/token', {
          grant_type: 'client_credentials',
          client_id: 'client-id',
          client_secret: 'client-secret'
        })
        .reply(200, {
          access_token: 'oauth-access-token',
          expires_in: 3600
        });

      // Mock API request with OAuth token
      const mockResponse = { _embedded: { mailboxes: [] } };
      const scope = nock(baseURL)
        .get('/mailboxes')
        .matchHeader('authorization', 'Bearer oauth-access-token')
        .reply(200, mockResponse);

      const newClient = new HelpScoutClient();
      await newClient.get('/mailboxes');
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle 401 unauthorized errors', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .reply(401, { message: 'Unauthorized' });

      await expect(client.get('/mailboxes')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Authentication failed'
      });
    });

    it('should handle 404 not found errors', async () => {
      nock(baseURL)
        .get('/conversations/999')
        .reply(404, { message: 'Not Found' });

      await expect(client.get('/conversations/999')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Resource not found'
      });
    });

    it('should handle 429 rate limit errors', async () => {
      nock(baseURL)
        .get('/conversations')
        .reply(429, { message: 'Rate limit exceeded' }, {
          'retry-after': '60'
        });

      await expect(client.get('/conversations')).rejects.toMatchObject({
        code: 'RATE_LIMIT',
        message: 'Rate limit exceeded',
        retryAfter: 60
      });
    });

    it('should handle 400 bad request errors', async () => {
      nock(baseURL)
        .get('/conversations')
        .query({ invalid: 'param' })
        .reply(400, { 
          message: 'Invalid request',
          errors: { invalid: 'parameter not allowed' }
        });

      await expect(client.get('/conversations', { invalid: 'param' })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid request'
      });
    });

    it('should handle 500 server errors', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .reply(500, { message: 'Internal Server Error' });

      await expect(client.get('/mailboxes')).rejects.toMatchObject({
        code: 'UPSTREAM_ERROR'
      });
    });
  });

  describe('caching', () => {
    it('should cache successful responses', async () => {
      const mockResponse = {
        _embedded: { mailboxes: [{ id: 1, name: 'Test Mailbox' }] }
      };

      // First request
      const scope1 = nock(baseURL)
        .get('/mailboxes')
        .reply(200, mockResponse);

      const result1 = await client.get('/mailboxes');
      expect(scope1.isDone()).toBe(true);
      expect(result1).toEqual(mockResponse);

      // Second request should use cache (no new HTTP call)
      const result2 = await client.get('/mailboxes');
      expect(result2).toEqual(mockResponse);
      
      // Verify no additional HTTP calls were made
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it('should respect custom cache TTL', async () => {
      const mockResponse = { data: 'test' };

      const scope = nock(baseURL)
        .get('/test-endpoint')
        .reply(200, mockResponse);

      await client.get('/test-endpoint', {}, { ttl: 0 }); // No caching
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('should return true for successful connection', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1, size: 1 })
        .reply(200, { _embedded: { mailboxes: [] } });

      const result = await client.testConnection();
      expect(result).toBe(true);
    });

    it('should return false for failed connection', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1, size: 1 })
        .reply(401, { message: 'Unauthorized' });

      const result = await client.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('request interceptors', () => {
    it('should add request IDs and timing', async () => {
      const mockResponse = { data: 'test' };
      
      const scope = nock(baseURL)
        .get('/test')
        .reply(200, mockResponse);

      await client.get('/test');
      expect(scope.isDone()).toBe(true);
    });
  });
});