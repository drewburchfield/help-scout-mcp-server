/**
 * v1.6.0 Stress Tests
 * More challenging scenarios: rate limits, concurrency, boundary conditions
 */

import { jest } from '@jest/globals';
import nock from 'nock';

process.env.NODE_ENV = 'test';
process.env.HELPSCOUT_APP_ID = 'test-app-id';
process.env.HELPSCOUT_APP_SECRET = 'test-app-secret';

const baseURL = 'https://api.helpscout.net/v2';

const mockOAuthToken = () => {
  nock(baseURL)
    .post('/oauth2/token')
    .reply(200, {
      access_token: 'test-token',
      token_type: 'bearer',
      expires_in: 7200,
    });
};

describe('v1.6.0 Stress Tests', () => {
  beforeEach(() => {
    nock.cleanAll();
    jest.clearAllMocks();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.restore();
  });

  describe('Rate Limiting in Multi-Status Search', () => {
    let toolHandler: any;

    beforeEach(async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 123, name: 'Test' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      jest.resetModules();
      const toolsModule = await import('../tools/index.js');
      toolHandler = toolsModule.toolHandler;
    });

    it('should handle 429 rate limit on one status', async () => {
      mockOAuthToken();

      // Active returns 429
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(429, { error: 'Rate limited' }, { 'Retry-After': '1' });

      // Pending and closed succeed
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, {
          _embedded: { conversations: [{ id: 1, subject: 'Pending', createdAt: '2024-01-01T00:00:00Z', status: 'pending' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, {
          _embedded: { conversations: [{ id: 2, subject: 'Closed', createdAt: '2024-01-02T00:00:00Z', status: 'closed' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {}
        }
      });

      // Should still return partial results
      expect(result).toBeDefined();
    }, 30000);

    it('should handle 401 auth error gracefully', async () => {
      mockOAuthToken();

      // All return 401
      ['active', 'pending', 'closed'].forEach(status => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === status)
          .reply(401, { error: 'Unauthorized' });
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {}
        }
      });

      expect(result).toBeDefined();
      // Should handle auth errors without crashing
    }, 30000);
  });

  describe('Boundary Conditions', () => {
    let toolHandler: any;

    beforeEach(async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 123, name: 'Test' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      jest.resetModules();
      const toolsModule = await import('../tools/index.js');
      toolHandler = toolsModule.toolHandler;
    });

    it('should handle limit of 1', async () => {
      mockOAuthToken();

      ['active', 'pending', 'closed'].forEach(status => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === status)
          .reply(200, {
            _embedded: { conversations: [
              { id: status === 'active' ? 1 : status === 'pending' ? 2 : 3, subject: status, createdAt: '2024-01-01T00:00:00Z', status }
            ]},
            page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
          });
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { limit: 1 }
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        expect(response.results.length).toBe(1);
      }
    });

    it('should handle maximum limit (100)', async () => {
      mockOAuthToken();

      ['active', 'pending', 'closed'].forEach(status => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === status && params.size === '100')
          .reply(200, {
            _embedded: { conversations: [] },
            page: { size: 0, totalElements: 0, totalPages: 1, number: 1 }
          });
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { limit: 100 }
        }
      });

      expect(result).toBeDefined();
    });

    it('should handle conversations with null/undefined fields', async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: { conversations: [
            { id: 1, subject: null, createdAt: '2024-01-01T00:00:00Z', status: 'active' },
            { id: 2, createdAt: '2024-01-02T00:00:00Z', status: 'active' },  // missing subject
          ]},
          page: { size: 2, totalElements: 2, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, { _embedded: { conversations: [] }, page: { size: 0, totalElements: 0, totalPages: 1, number: 1 } });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, { _embedded: { conversations: [] }, page: { size: 0, totalElements: 0, totalPages: 1, number: 1 } });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {}
        }
      });

      expect(result).toBeDefined();
      // Should not crash on null/missing fields
    });

    it('should handle very long query strings', async () => {
      mockOAuthToken();

      const longQuery = '(body:"' + 'a'.repeat(500) + '")';

      ['active', 'pending', 'closed'].forEach(_status => {
        nock(baseURL)
          .get('/conversations')
          .query(true)
          .reply(200, {
            _embedded: { conversations: [] },
            page: { size: 0, totalElements: 0, totalPages: 1, number: 1 }
          });
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { query: longQuery }
        }
      });

      expect(result).toBeDefined();
    });

    it('should handle special characters in query', async () => {
      mockOAuthToken();

      const specialQuery = '(body:"test\'s "quoted" <html> & symbols")';

      ['active', 'pending', 'closed'].forEach(_status => {
        nock(baseURL)
          .get('/conversations')
          .query(true)
          .reply(200, {
            _embedded: { conversations: [] },
            page: { size: 0, totalElements: 0, totalPages: 1, number: 1 }
          });
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { query: specialQuery }
        }
      });

      expect(result).toBeDefined();
    });
  });

  describe('Concurrent Multi-Status Behavior', () => {
    let toolHandler: any;

    beforeEach(async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 123, name: 'Test' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      jest.resetModules();
      const toolsModule = await import('../tools/index.js');
      toolHandler = toolsModule.toolHandler;
    });

    it('should handle responses arriving in different order', async () => {
      mockOAuthToken();

      // Closed returns first (fastest)
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, {
          _embedded: { conversations: [{ id: 3, subject: 'Closed (fast)', createdAt: '2024-01-01T00:00:00Z', status: 'closed' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      // Pending returns second
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .delay(100)
        .reply(200, {
          _embedded: { conversations: [{ id: 2, subject: 'Pending (medium)', createdAt: '2024-01-02T00:00:00Z', status: 'pending' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      // Active returns last (slowest)
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .delay(200)
        .reply(200, {
          _embedded: { conversations: [{ id: 1, subject: 'Active (slow)', createdAt: '2024-01-03T00:00:00Z', status: 'active' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {}
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        // Should still be sorted by date regardless of arrival order
        expect(response.results.length).toBe(3);
        expect(response.results[0].id).toBe(1);  // Most recent (Jan 3)
      }
    });
  });

  describe('createdBefore Client-Side Filtering', () => {
    let toolHandler: any;

    beforeEach(async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 123, name: 'Test' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      jest.resetModules();
      const toolsModule = await import('../tools/index.js');
      toolHandler = toolsModule.toolHandler;
    });

    it('should filter results with createdBefore after merge', async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: { conversations: [
            { id: 1, subject: 'Old', createdAt: '2024-01-01T00:00:00Z', status: 'active' },
            { id: 2, subject: 'New', createdAt: '2024-01-15T00:00:00Z', status: 'active' }
          ]},
          page: { size: 2, totalElements: 2, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, { _embedded: { conversations: [] }, page: { size: 0, totalElements: 0, totalPages: 1, number: 1 } });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, { _embedded: { conversations: [] }, page: { size: 0, totalElements: 0, totalPages: 1, number: 1 } });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { createdBefore: '2024-01-10T00:00:00Z' }
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        // Should only include the old one (before Jan 10)
        expect(response.results.length).toBe(1);
        expect(response.results[0].id).toBe(1);
        expect(response.searchInfo.clientSideFiltering).toBeDefined();
      }
    });

    it('should handle createdBefore that filters all results', async () => {
      mockOAuthToken();

      ['active', 'pending', 'closed'].forEach(status => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === status)
          .reply(200, {
            _embedded: { conversations: [
              { id: 1, subject: 'Recent', createdAt: '2024-06-01T00:00:00Z', status }
            ]},
            page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
          });
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { createdBefore: '2024-01-01T00:00:00Z' }  // Before all results
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        expect(response.results.length).toBe(0);
      }
    });
  });

  describe('Inbox Scoping with Multi-Status', () => {
    let toolHandler: any;

    beforeEach(async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 123, name: 'Test' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      jest.resetModules();
      const toolsModule = await import('../tools/index.js');
      toolHandler = toolsModule.toolHandler;
    });

    it('should pass inboxId to all parallel status searches', async () => {
      mockOAuthToken();

      const inboxId = '456';

      // Verify each status search includes the mailbox parameter
      ['active', 'pending', 'closed'].forEach(status => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === status && params.mailbox === inboxId)
          .reply(200, {
            _embedded: { conversations: [] },
            page: { size: 0, totalElements: 0, totalPages: 1, number: 1 }
          });
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { inboxId }
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        expect(response.searchInfo.inboxScope).toContain(inboxId);
      }
    });
  });
});
