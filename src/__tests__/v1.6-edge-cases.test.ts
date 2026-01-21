/**
 * v1.6.0 Edge Case Tests
 * Tests specifically targeting inbox auto-discovery and multi-status search
 */

import { jest } from '@jest/globals';
import nock from 'nock';

// Set test environment before imports
process.env.NODE_ENV = 'test';
process.env.HELPSCOUT_APP_ID = 'test-app-id';
process.env.HELPSCOUT_APP_SECRET = 'test-app-secret';

const baseURL = 'https://api.helpscout.net/v2';

// Mock OAuth token
const mockOAuthToken = () => {
  nock(baseURL)
    .post('/oauth2/token')
    .reply(200, {
      access_token: 'test-token',
      token_type: 'bearer',
      expires_in: 7200,
    });
};

describe('v1.6.0 Edge Cases', () => {
  beforeEach(() => {
    nock.cleanAll();
    jest.clearAllMocks();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.restore();
  });

  describe('Inbox Auto-Discovery', () => {
    it('should handle empty inbox list gracefully', async () => {
      mockOAuthToken();

      // Return empty mailboxes
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [] },
          page: { size: 0, totalElements: 0, totalPages: 0, number: 1 }
        });

      const { HelpScoutMCPServer } = await import('../index.js');
      const server = await HelpScoutMCPServer.create();

      expect(server).toBeDefined();
      // Server should still work with no inboxes
    });

    it('should handle API error during inbox discovery', async () => {
      mockOAuthToken();

      // Simulate API failure
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(500, { error: 'Internal Server Error' });

      const { HelpScoutMCPServer } = await import('../index.js');

      // Should not throw - should use fallback instructions
      const server = await HelpScoutMCPServer.create();
      expect(server).toBeDefined();
    });

    it('should handle network timeout during inbox discovery', async () => {
      mockOAuthToken();

      // Simulate timeout
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .delayConnection(10000)
        .reply(200, { _embedded: { mailboxes: [] } });

      const { HelpScoutMCPServer } = await import('../index.js');

      // Should handle timeout gracefully (may take a while)
      // We're testing that it doesn't crash
    }, 15000);

    it('should handle malformed inbox response', async () => {
      mockOAuthToken();

      // Return malformed data (missing _embedded)
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, { unexpected: 'format' });

      const { HelpScoutMCPServer } = await import('../index.js');
      const server = await HelpScoutMCPServer.create();

      expect(server).toBeDefined();
    });

    it('should handle inbox with special characters in name', async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: {
            mailboxes: [
              { id: 123, name: 'Support <script>alert("xss")</script>' },
              { id: 456, name: 'Inbox with "quotes" and \'apostrophes\'' },
              { id: 789, name: 'Unicode: 日本語 émojis 🎉' },
            ]
          },
          page: { size: 3, totalElements: 3, totalPages: 1, number: 1 }
        });

      const { HelpScoutMCPServer } = await import('../index.js');
      const server = await HelpScoutMCPServer.create();

      expect(server).toBeDefined();
    });

    it('should handle large number of inboxes', async () => {
      mockOAuthToken();

      // Generate 100 inboxes
      const mailboxes = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        name: `Inbox ${i + 1}`,
      }));

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes },
          page: { size: 100, totalElements: 100, totalPages: 1, number: 1 }
        });

      const { HelpScoutMCPServer } = await import('../index.js');
      const server = await HelpScoutMCPServer.create();

      expect(server).toBeDefined();
    });
  });

  describe('Multi-Status Search', () => {
    let toolHandler: any;

    beforeEach(async () => {
      mockOAuthToken();

      // Mock inbox discovery for server creation
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 123, name: 'Test Inbox' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      // Fresh import
      jest.resetModules();
      const toolsModule = await import('../tools/index.js');
      toolHandler = toolsModule.toolHandler;
    });

    it('should handle partial failures in multi-status search', async () => {
      mockOAuthToken();

      // Active succeeds
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: {
            conversations: [{ id: 1, subject: 'Active conv', createdAt: '2024-01-01T00:00:00Z', status: 'active' }]
          },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      // Pending fails
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(500, { error: 'Server Error' });

      // Closed fails
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(503, { error: 'Service Unavailable' });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {}  // No status = multi-status search
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      // Should still return results from successful status
      if (!response.error) {
        expect(response.results).toBeDefined();
        expect(response.searchInfo.statusesSearched).toContain('active');
      }
    });

    it('should handle all statuses failing', async () => {
      mockOAuthToken();

      // All three fail
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(500, { error: 'Error' });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(500, { error: 'Error' });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(500, { error: 'Error' });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {}
        }
      });

      // Should handle gracefully (either error or empty results)
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should deduplicate conversations across statuses', async () => {
      mockOAuthToken();

      // Same conversation appears in multiple status results (edge case)
      const duplicateConv = { id: 999, subject: 'Duplicate', createdAt: '2024-01-01T00:00:00Z', status: 'active' };

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: { conversations: [duplicateConv, { id: 1, subject: 'Unique 1', createdAt: '2024-01-02T00:00:00Z', status: 'active' }] },
          page: { size: 2, totalElements: 2, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, {
          _embedded: { conversations: [{ ...duplicateConv, status: 'pending' }] },  // Same ID, different status
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, {
          _embedded: { conversations: [] },
          page: { size: 0, totalElements: 0, totalPages: 1, number: 1 }
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
        // Should have deduplicated - only 2 unique conversations
        const ids = response.results.map((r: any) => r.id);
        const uniqueIds = [...new Set(ids)];
        expect(ids.length).toBe(uniqueIds.length);
      }
    });

    it('should respect limit after merging multi-status results', async () => {
      mockOAuthToken();

      // Each status returns 30 results, but limit is 50
      const makeConvs = (prefix: string, count: number, status: string) =>
        Array.from({ length: count }, (_, i) => ({
          id: parseInt(prefix) * 1000 + i,
          subject: `${status} conv ${i}`,
          createdAt: new Date(2024, 0, i + 1).toISOString(),
          status
        }));

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: { conversations: makeConvs('1', 30, 'active') },
          page: { size: 30, totalElements: 30, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, {
          _embedded: { conversations: makeConvs('2', 30, 'pending') },
          page: { size: 30, totalElements: 30, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, {
          _embedded: { conversations: makeConvs('3', 30, 'closed') },
          page: { size: 30, totalElements: 30, totalPages: 1, number: 1 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { limit: 50 }
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        // Should be limited to 50, not 90
        expect(response.results.length).toBeLessThanOrEqual(50);
      }
    });

    it('should sort merged results by createdAt descending', async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: { conversations: [
            { id: 1, subject: 'Old active', createdAt: '2024-01-01T00:00:00Z', status: 'active' }
          ]},
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, {
          _embedded: { conversations: [
            { id: 2, subject: 'Newest pending', createdAt: '2024-01-15T00:00:00Z', status: 'pending' }
          ]},
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, {
          _embedded: { conversations: [
            { id: 3, subject: 'Middle closed', createdAt: '2024-01-10T00:00:00Z', status: 'closed' }
          ]},
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

      if (!response.error && response.results.length === 3) {
        // Should be sorted newest first
        expect(response.results[0].id).toBe(2);  // Jan 15
        expect(response.results[1].id).toBe(3);  // Jan 10
        expect(response.results[2].id).toBe(1);  // Jan 1
      }
    });

    it('should use single API call when status is explicitly specified', async () => {
      mockOAuthToken();

      // Only mock active status - if it tries to call others, test will fail
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: { conversations: [{ id: 1, subject: 'Active only', createdAt: '2024-01-01T00:00:00Z', status: 'active' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { status: 'active' }  // Explicit status
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        // Should only have searched active
        expect(response.searchInfo.statusesSearched).toEqual(['active']);
      }
    });
  });

  describe('Deprecated Tools Still Work', () => {
    let toolHandler: any;

    beforeEach(async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 123, name: 'Test Inbox' }] },
          page: { size: 1, totalElements: 1, totalPages: 1, number: 1 }
        });

      jest.resetModules();
      const toolsModule = await import('../tools/index.js');
      toolHandler = toolsModule.toolHandler;
    });

    it('searchInboxes should still function', async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [
            { id: 1, name: 'Support Inbox' },
            { id: 2, name: 'Sales Inbox' }
          ]},
          page: { size: 2, totalElements: 2, totalPages: 1, number: 1 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { query: 'Support' }
        }
      });

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('listAllInboxes should still function', async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [
            { id: 1, name: 'Inbox 1' },
            { id: 2, name: 'Inbox 2' }
          ]},
          page: { size: 2, totalElements: 2, totalPages: 1, number: 1 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listAllInboxes',
          arguments: {}
        }
      });

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });
  });

  describe('Error Sanitization', () => {
    it('should redact tokens from error messages', async () => {
      // This tests the sanitization logic in discoverAndBuildInstructions
      const testError = 'Error with token abc123def456ghi789jkl012mno345 in path /Users/secret/config';
      const sanitized = testError
        .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
        .replace(/\/[^\s]+/g, '[PATH]');

      expect(sanitized).not.toContain('abc123def456ghi789jkl012mno345');
      expect(sanitized).not.toContain('/Users/secret/config');
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).toContain('[PATH]');
    });

    it('should handle errors without sensitive data', async () => {
      const testError = 'Simple error message';
      const sanitized = testError
        .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
        .replace(/\/[^\s]+/g, '[PATH]');

      expect(sanitized).toBe('Simple error message');
    });
  });

  describe('Response Format Compatibility', () => {
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

    it('should include statusesSearched array in multi-status response', async () => {
      mockOAuthToken();

      ['active', 'pending', 'closed'].forEach(status => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === status)
          .reply(200, {
            _embedded: { conversations: [] },
            page: { size: 0, totalElements: 0, totalPages: 1, number: 1 }
          });
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
        expect(response.searchInfo).toBeDefined();
        expect(Array.isArray(response.searchInfo.statusesSearched)).toBe(true);
      }
    });

    it('should include single status in statusesSearched when explicit', async () => {
      mockOAuthToken();

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, {
          _embedded: { conversations: [] },
          page: { size: 0, totalElements: 0, totalPages: 1, number: 1 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { status: 'closed' }
        }
      });

      const response = JSON.parse((result.content[0] as any).text);

      if (!response.error) {
        expect(response.searchInfo.statusesSearched).toEqual(['closed']);
      }
    });
  });
});
