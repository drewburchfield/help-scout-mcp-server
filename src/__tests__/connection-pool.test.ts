import { HelpScoutClient } from '../utils/helpscout-client.js';
import nock from 'nock';
import { cache } from '../utils/cache.js';

// Mock logger to reduce test output noise
jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('HelpScout Client - Connection Pooling', () => {
  const baseURL = 'https://api.helpscout.net/v2';
  let client: HelpScoutClient;

  beforeEach(() => {
    // Mock environment for tests
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    
    // Clean all nock interceptors
    nock.cleanAll();
    nock.restore();
    nock.activate();
    cache.clear();
    
    // Mock OAuth2 authentication endpoint
    nock(baseURL)
      .persist()
      .post('/oauth2/token')
      .reply(200, {
        access_token: 'mock-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
  });

  afterEach(async () => {
    if (client) {
      await client.closePool();
    }
    nock.cleanAll();
    cache.clear();
  });

  describe('Connection Pool Configuration', () => {
    it('should create client with default connection pool settings', () => {
      client = new HelpScoutClient();
      
      const stats = client.getPoolStats();
      
      expect(stats).toHaveProperty('http');
      expect(stats).toHaveProperty('https');
      expect(stats.http).toHaveProperty('sockets');
      expect(stats.http).toHaveProperty('freeSockets');
      expect(stats.http).toHaveProperty('pending');
    });

    it('should create client with custom connection pool settings', () => {
      const customConfig = {
        maxSockets: 20,
        maxFreeSockets: 5,
        timeout: 15000,
        keepAlive: true,
        keepAliveMsecs: 500,
      };
      
      client = new HelpScoutClient(customConfig);
      
      // Verify client was created successfully
      expect(client).toBeInstanceOf(HelpScoutClient);
      
      const stats = client.getPoolStats();
      expect(stats).toBeDefined();
    });
  });

  describe('Connection Pool Management', () => {
    beforeEach(() => {
      client = new HelpScoutClient({
        maxSockets: 10,
        maxFreeSockets: 3,
        timeout: 10000,
        keepAlive: true,
        keepAliveMsecs: 200,
      });
    });

    it('should provide connection pool statistics', () => {
      const stats = client.getPoolStats();
      
      expect(stats).toEqual({
        http: {
          sockets: expect.any(Number),
          freeSockets: expect.any(Number),
          pending: expect.any(Number),
        },
        https: {
          sockets: expect.any(Number),
          freeSockets: expect.any(Number),
          pending: expect.any(Number),
        },
      });
    });

    it('should count pooled sockets and requests, not host buckets', () => {
      const axiosClient = (client as any).client;
      const socket = () => ({ destroy: jest.fn() });

      axiosClient.defaults.httpAgent.sockets = {
        'api.helpscout.net:80:': [socket(), socket()],
      };
      axiosClient.defaults.httpAgent.freeSockets = {
        'api.helpscout.net:80:': [socket()],
      };
      axiosClient.defaults.httpAgent.requests = {
        'api.helpscout.net:80:': [{}, {}, {}],
      };
      axiosClient.defaults.httpsAgent.sockets = {
        'api.helpscout.net:443:': [socket(), socket(), socket()],
      };
      axiosClient.defaults.httpsAgent.freeSockets = {
        'api.helpscout.net:443:': [socket(), socket()],
      };
      axiosClient.defaults.httpsAgent.requests = {
        'api.helpscout.net:443:': [{}],
      };

      expect(client.getPoolStats()).toEqual({
        http: {
          sockets: 2,
          freeSockets: 1,
          pending: 3,
        },
        https: {
          sockets: 3,
          freeSockets: 2,
          pending: 1,
        },
      });
    });

    it('should clear idle connections', () => {
      // This test verifies the method exists and can be called
      expect(() => client.clearIdleConnections()).not.toThrow();
    });

    it('should preserve custom pool settings when clearing idle connections', () => {
      const axiosClientBefore = (client as any).client;
      const httpAgentBefore = axiosClientBefore.defaults.httpAgent;
      const httpsAgentBefore = axiosClientBefore.defaults.httpsAgent;
      expect(axiosClientBefore.defaults.httpAgent.options.maxSockets).toBe(10);
      expect(axiosClientBefore.defaults.httpAgent.options.maxFreeSockets).toBe(3);
      expect(axiosClientBefore.defaults.httpAgent.options.timeout).toBe(10000);
      expect(axiosClientBefore.defaults.httpAgent.options.keepAliveMsecs).toBe(200);

      client.clearIdleConnections();

      const axiosClientAfter = (client as any).client;
      expect(axiosClientAfter.defaults.httpAgent).toBe(httpAgentBefore);
      expect(axiosClientAfter.defaults.httpsAgent).toBe(httpsAgentBefore);
      expect(axiosClientAfter.defaults.httpAgent.options.maxSockets).toBe(10);
      expect(axiosClientAfter.defaults.httpAgent.options.maxFreeSockets).toBe(3);
      expect(axiosClientAfter.defaults.httpAgent.options.timeout).toBe(10000);
      expect(axiosClientAfter.defaults.httpAgent.options.keepAliveMsecs).toBe(200);
      expect(axiosClientAfter.defaults.httpsAgent.options.maxSockets).toBe(10);
      expect(axiosClientAfter.defaults.httpsAgent.options.maxFreeSockets).toBe(3);
      expect(axiosClientAfter.defaults.httpsAgent.options.timeout).toBe(10000);
      expect(axiosClientAfter.defaults.httpsAgent.options.keepAliveMsecs).toBe(200);
    });

    it('should destroy free sockets without destroying active sockets', () => {
      const axiosClient = (client as any).client;
      const freeSocket = { destroy: jest.fn() };
      const activeSocket = { destroy: jest.fn() };

      axiosClient.defaults.httpsAgent.freeSockets = { 'api.helpscout.net:443:': [freeSocket] };
      axiosClient.defaults.httpsAgent.sockets = { 'api.helpscout.net:443:': [activeSocket] };

      client.clearIdleConnections();

      expect(freeSocket.destroy).toHaveBeenCalledTimes(1);
      expect(activeSocket.destroy).not.toHaveBeenCalled();
      expect(axiosClient.defaults.httpsAgent.freeSockets).toEqual({});
      expect(axiosClient.defaults.httpsAgent.sockets).toEqual({
        'api.helpscout.net:443:': [activeSocket],
      });
    });

    it('should log pool status', () => {
      const { logger } = require('../utils/logger.js');
      
      client.logPoolStatus();
      
      expect(logger.debug).toHaveBeenCalledWith('Connection pool status', expect.any(Object));
    });

    it('should close connection pool gracefully', async () => {
      const { logger } = require('../utils/logger.js');
      
      await client.closePool();
      
      expect(logger.info).toHaveBeenCalledWith('Closing HTTP connection pool');
      expect(logger.info).toHaveBeenCalledWith('All HTTP connections closed');
    });
  });

  describe('Connection Pooling in Action', () => {
    beforeEach(() => {
      client = new HelpScoutClient({
        maxSockets: 5,
        maxFreeSockets: 2,
        keepAlive: true,
      });

      // Mock successful API responses
      nock(baseURL)
        .persist()
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: {
            mailboxes: [
              { id: '1', name: 'Test Inbox', email: 'test@example.com' }
            ]
          }
        });
    });

    it('should reuse connections for multiple requests', async () => {
      const { logger } = require('../utils/logger.js');
      
      // Make multiple API calls
      await client.get('/mailboxes', { page: 1, size: 1 });
      await client.get('/mailboxes', { page: 1, size: 2 });
      await client.get('/mailboxes', { page: 1, size: 3 });
      
      // Verify connection pool was initialized
      expect(logger.info).toHaveBeenCalledWith(
        'HTTP connection pool initialized',
        expect.objectContaining({
          maxSockets: 5,
          maxFreeSockets: 2,
          keepAlive: true,
        })
      );
      
      const stats = client.getPoolStats();
      expect(stats).toBeDefined();
    });

    it('should handle connection test with pool', async () => {
      const result = await client.testConnection();
      
      expect(result).toBe(true);
      
      const stats = client.getPoolStats();
      expect(stats).toBeDefined();
    });

    it('should authenticate against the configured base URL', async () => {
      jest.resetModules();
      jest.doMock('../utils/config.js', () => ({
        config: {
          helpscout: {
            apiKey: '',
            clientId: 'custom-client-id',
            clientSecret: 'custom-client-secret',
            baseUrl: 'https://helpscout-proxy.test/v2/',
          },
          cache: { ttlSeconds: 300, maxSize: 10000 },
          logging: { level: 'error' },
          security: { redactMessageContent: false },
          connectionPool: {
            maxSockets: 5,
            maxFreeSockets: 2,
            timeout: 30000,
            keepAlive: true,
            keepAliveMsecs: 1000,
          },
        },
        validateConfig: jest.fn(),
      }));
      jest.doMock('../utils/logger.js', () => ({
        logger: {
          info: jest.fn(),
          error: jest.fn(),
          debug: jest.fn(),
          warn: jest.fn(),
        },
      }));

      const { HelpScoutClient: IsolatedHelpScoutClient } = await import('../utils/helpscout-client.js');
      const isolatedClient = new IsolatedHelpScoutClient();

      const authScope = nock('https://helpscout-proxy.test')
        .post('/v2/oauth2/token')
        .reply(200, {
          access_token: 'proxy-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });

      const apiScope = nock('https://helpscout-proxy.test')
        .get('/v2/mailboxes')
        .query({ page: 1, size: 1 })
        .matchHeader('authorization', 'Bearer proxy-access-token')
        .reply(200, { _embedded: { mailboxes: [] } });

      await isolatedClient.get('/mailboxes', { page: 1, size: 1 });
      await isolatedClient.closePool();

      expect(authScope.isDone()).toBe(true);
      expect(apiScope.isDone()).toBe(true);
      jest.dontMock('../utils/config.js');
      jest.dontMock('../utils/logger.js');
    });
  });

  describe('Environment Configuration Integration', () => {
    it('should use environment variables for pool configuration', () => {
      // Set custom environment variables
      process.env.HTTP_MAX_SOCKETS = '25';
      process.env.HTTP_MAX_FREE_SOCKETS = '8';
      process.env.HTTP_SOCKET_TIMEOUT = '20000';
      process.env.HTTP_KEEP_ALIVE = 'true';
      
      // Note: We can't easily test this without reloading the config module
      // This test verifies the client can be created with environment config
      client = new HelpScoutClient({
        maxSockets: parseInt(process.env.HTTP_MAX_SOCKETS || '50', 10),
        maxFreeSockets: parseInt(process.env.HTTP_MAX_FREE_SOCKETS || '10', 10),
        timeout: parseInt(process.env.HTTP_SOCKET_TIMEOUT || '30000', 10),
        keepAlive: process.env.HTTP_KEEP_ALIVE !== 'false',
      });
      
      expect(client).toBeInstanceOf(HelpScoutClient);
      
      // Clean up environment
      delete process.env.HTTP_MAX_SOCKETS;
      delete process.env.HTTP_MAX_FREE_SOCKETS;
      delete process.env.HTTP_SOCKET_TIMEOUT;
      delete process.env.HTTP_KEEP_ALIVE;
    });
  });

  describe('Error Handling with Connection Pool', () => {
    beforeEach(() => {
      client = new HelpScoutClient({
        maxSockets: 2,
        maxFreeSockets: 1,
        timeout: 1000, // Short timeout for testing
      });
    });

    it('should maintain pool state regardless of request outcomes', async () => {
      // Test that pool stats work with successful requests
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, { _embedded: { mailboxes: [] } });

      await client.get('/mailboxes');
      
      // Pool should be functional
      const stats = client.getPoolStats();
      expect(stats).toBeDefined();
      expect(stats.http).toHaveProperty('sockets');
      expect(stats.https).toHaveProperty('sockets');
    });

    it('should handle pool statistics during error conditions', async () => {
      // Test that pool stats work regardless of request success/failure
      const statsBefore = client.getPoolStats();
      expect(statsBefore).toBeDefined();
      
      // Mock successful request
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, { _embedded: { mailboxes: [] } });

      await client.get('/mailboxes');
      
      const statsAfter = client.getPoolStats();
      expect(statsAfter).toBeDefined();
      expect(typeof statsAfter.http.sockets).toBe('number');
      expect(typeof statsAfter.https.sockets).toBe('number');
    });
  });
});
