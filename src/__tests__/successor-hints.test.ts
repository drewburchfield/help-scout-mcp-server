import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import { cache } from '../utils/cache.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * NAS-1305 phase 3: response-bootstrapped successor hints.
 *
 * When a "hub" tool returns, the full sanitized schemas of its logically-next
 * (non-core) tools are appended to `result._meta.suggestedTools` so the model
 * can call them next with correct args and no search detour. Successors already
 * in CORE_TOOLS (the always-on surface) are filtered out — only additive tail
 * tools are surfaced. Typed schema hints are compact-mode only.
 */
describe('Successor hints (NAS-1305 phase 3)', () => {
  let toolHandler: ToolHandler;
  const baseURL = 'https://api.helpscout.net/v2';

  const CORE_TOOLS = [
    'searchConversations',
    'getConversation',
    'getThreads',
    'getCustomer',
    'getCustomerContacts',
    'listAllInboxes',
    'searchDocsArticles',
  ];

  beforeEach(() => {
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    process.env.HELPSCOUT_TOOL_SURFACE = 'compact';

    nock.cleanAll();
    cache.clear();

    nock(baseURL)
      .persist()
      .post('/oauth2/token')
      .reply(200, {
        access_token: 'mock-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

    toolHandler = new ToolHandler();
  });

  afterEach(async () => {
    delete process.env.HELPSCOUT_TOOL_SURFACE;
    nock.cleanAll();
    await new Promise((resolve) => setImmediate(resolve));
  });

  function makeRequest(name: string, args: Record<string, unknown> = {}): CallToolRequest {
    return { params: { name, arguments: args } } as unknown as CallToolRequest;
  }

  function suggestedTools(result: CallToolResult): Array<Record<string, any>> | undefined {
    const meta = result._meta as { suggestedTools?: Array<Record<string, any>> } | undefined;
    return meta?.suggestedTools;
  }

  describe('hub tools attach _meta.suggestedTools', () => {
    it('searchConversations surfaces tail successors but NOT core successors', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(true)
        .reply(200, {
          _embedded: { conversations: [{ id: 789, subject: 'Help', status: 'active' }] },
          page: { size: 50, totalElements: 1 },
        });

      const result = await toolHandler.callTool(
        makeRequest('searchConversations', { query: 'help' }),
      );

      const hints = suggestedTools(result);
      expect(hints).toBeDefined();
      const names = hints!.map((h) => h.name);
      // Tail (non-core) successors are surfaced.
      expect(names).toContain('getOriginalSource');
      expect(names).toContain('getAttachment');
      // Core successors are filtered out — the model already has them.
      expect(names).not.toContain('getConversation');
      expect(names).not.toContain('getThreads');
      // Capped at 3.
      expect(names.length).toBeLessThanOrEqual(3);
    });

    it('getOrganization surfaces members/conversations/properties with full sanitized schemas', async () => {
      nock(baseURL)
        .get('/organizations/456')
        .query(true)
        .reply(200, {
          id: 456,
          name: 'Acme Corp',
          customerCount: 10,
          conversationCount: 25,
        });

      const result = await toolHandler.callTool(
        makeRequest('getOrganization', { organizationId: '456' }),
      );

      const hints = suggestedTools(result);
      expect(hints).toBeDefined();
      const names = hints!.map((h) => h.name);
      expect(names).toEqual([
        'getOrganizationMembers',
        'getOrganizationConversations',
        'listOrganizationProperties',
      ]);

      // Each hint carries a full sanitized inputSchema.
      for (const hint of hints!) {
        expect(hint.inputSchema).toBeDefined();
        expect(hint.inputSchema).toMatchObject({ additionalProperties: false });
        expect(hint.description).toBeDefined();
        // Sanitizer guarantees no raw number types leak through.
        expect(JSON.stringify(hint.inputSchema)).not.toContain('"type":"number"');
      }
    });
  });

  describe('terminal tools attach no hints', () => {
    it('getServerTime yields no _meta.suggestedTools', async () => {
      const result = await toolHandler.callTool(makeRequest('getServerTime', {}));
      expect(suggestedTools(result)).toBeUndefined();
    });
  });

  describe('default flat surface gate', () => {
    it('attaches no typed schema hints when HELPSCOUT_TOOL_SURFACE is unset', async () => {
      delete process.env.HELPSCOUT_TOOL_SURFACE;
      nock(baseURL)
        .get('/conversations')
        .query(true)
        .reply(200, {
          _embedded: { conversations: [] },
          page: { size: 50, totalElements: 0 },
        });

      const result = await toolHandler.callTool(
        makeRequest('searchConversations', { query: 'help' }),
      );
      expect(suggestedTools(result)).toBeUndefined();
    });
  });

  describe('call_tool re-entry', () => {
    it('hint rides along when a hub tool is dispatched via call_tool', async () => {
      nock(baseURL)
        .get('/organizations/456')
        .query(true)
        .reply(200, { id: 456, name: 'Acme Corp' });

      const result = await toolHandler.callTool(
        makeRequest('call_tool', {
          name: 'getOrganization',
          arguments: { organizationId: '456' },
        }),
      );

      const hints = suggestedTools(result);
      expect(hints).toBeDefined();
      expect(hints!.map((h) => h.name)).toContain('getOrganizationMembers');
    });

    it('the call_tool meta-result itself carries no hints', async () => {
      const result = await toolHandler.callTool(
        makeRequest('call_tool', { name: 'getServerTime', arguments: {} }),
      );
      expect(suggestedTools(result)).toBeUndefined();
    });
  });

  describe('hints are purely additive (no core duplication)', () => {
    it('every suggested tool is absent from the core surface', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(true)
        .reply(200, {
          _embedded: { conversations: [] },
          page: { size: 50, totalElements: 0 },
        });

      const result = await toolHandler.callTool(
        makeRequest('searchConversations', { query: 'help' }),
      );
      const hints = suggestedTools(result) ?? [];
      for (const hint of hints) {
        expect(CORE_TOOLS).not.toContain(hint.name);
      }
    });
  });
});
