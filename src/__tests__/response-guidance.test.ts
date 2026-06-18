import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import { cache } from '../utils/cache.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * NAS-1308: unified content-aware response guidance layer.
 *
 * One producer (buildResponseGuidance) drives both the result body's
 * `apiGuidance` next-step text (with a REAL id interpolated into the example)
 * and `_meta.suggestedTools` (sanitized, core/meta-filtered, capped) — keyed on
 * what actually happened (empty vs populated), replacing the static successor
 * hints and the 2-tool generateToolGuidance text.
 */
describe('Response guidance layer (NAS-1308)', () => {
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
    delete process.env.HELPSCOUT_EXPOSE_ALL_TOOLS;

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
    delete process.env.HELPSCOUT_EXPOSE_ALL_TOOLS;
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

  function body(result: CallToolResult): any {
    const first = result.content?.[0];
    if (!first || first.type !== 'text' || typeof first.text !== 'string') return undefined;
    return JSON.parse(first.text);
  }

  describe('searchConversations — populated', () => {
    it('apiGuidance references getThreads + the REAL conversation id; suggests drill-in tail', async () => {
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

      const apiGuidance: string[] = body(result).apiGuidance;
      expect(apiGuidance).toBeDefined();
      const joined = apiGuidance.join('\n');
      expect(joined).toContain('getThreads');
      // REAL id from the result, not a literal placeholder.
      expect(joined).toContain("conversationId:'789'");
      expect(joined).not.toContain('<id>');
      expect(joined).not.toContain('<conversationId>');

      const names = (suggestedTools(result) ?? []).map((h) => h.name);
      expect(names).toContain('getOriginalSource');
      expect(names).toContain('getAttachment');
      // Core successors filtered out.
      for (const core of CORE_TOOLS) {
        expect(names).not.toContain(core);
      }
      expect(names.length).toBeLessThanOrEqual(3);
    });
  });

  describe('searchConversations — empty', () => {
    it('apiGuidance has broaden/searchCustomersByEmail text; no drill-in tail', async () => {
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

      const apiGuidance: string[] = body(result).apiGuidance;
      expect(apiGuidance).toBeDefined();
      const joined = apiGuidance.join('\n');
      expect(joined).toContain('Broaden');
      expect(joined).toContain('searchCustomersByEmail');

      // The drill-in tail (getOriginalSource/getAttachment) must NOT appear on an
      // empty result — there is nothing to drill into.
      const names = (suggestedTools(result) ?? []).map((h) => h.name);
      expect(names).not.toContain('getOriginalSource');
      expect(names).not.toContain('getAttachment');
    });
  });

  describe('getCustomer — populated', () => {
    it('apiGuidance includes searchConversations({customerIds:[<realid>]}) with the real id', async () => {
      nock(baseURL)
        .get('/customers/321')
        .query(true)
        .reply(200, { id: 321, firstName: 'Ada', lastName: 'Lovelace' });

      const result = await toolHandler.callTool(
        makeRequest('getCustomer', { customerId: '321' }),
      );

      const joined: string = (body(result).apiGuidance as string[]).join('\n');
      expect(joined).toContain('getCustomerContacts');
      expect(joined).toContain('customerIds:[321]');
      expect(joined).not.toContain('<customerId>');

      const names = (suggestedTools(result) ?? []).map((h) => h.name);
      // getCustomerContacts is in the core surface → filtered out of the schema
      // hints (the model already has it), though the text still names it.
      expect(names).not.toContain('getCustomerContacts');
      expect(names).toContain('getOrganization');
    });
  });

  describe('getOrganization — populated', () => {
    it('surfaces members/conversations/properties with the org id', async () => {
      nock(baseURL)
        .get('/organizations/456')
        .query(true)
        .reply(200, { id: 456, name: 'Acme Corp' });

      const result = await toolHandler.callTool(
        makeRequest('getOrganization', { organizationId: '456' }),
      );

      const joined: string = (body(result).apiGuidance as string[]).join('\n');
      expect(joined).toContain('getOrganizationMembers');
      expect(joined).toContain("organizationId:'456'");

      const names = (suggestedTools(result) ?? []).map((h) => h.name);
      expect(names).toEqual([
        'getOrganizationMembers',
        'getOrganizationConversations',
        'listOrganizationProperties',
      ]);
      // Each hint carries a sanitized schema.
      for (const hint of suggestedTools(result)!) {
        expect(hint.inputSchema).toMatchObject({ additionalProperties: false });
        expect(JSON.stringify(hint.inputSchema)).not.toContain('"type":"number"');
      }
    });
  });

  describe('listAllInboxes — migrated text', () => {
    it('populated → inbox-id example + getInbox successor', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [{ id: 12345, name: 'Support', email: 's@x.com' }] },
          page: { size: 50, totalElements: 1 },
        });

      const result = await toolHandler.callTool(makeRequest('listAllInboxes', {}));
      const joined: string = (body(result).apiGuidance as string[]).join('\n');
      expect(joined).toContain('✅ NEXT STEP');
      expect(joined).toContain('"inboxId": "12345"');

      const names = (suggestedTools(result) ?? []).map((h) => h.name);
      expect(names).toContain('getInbox');
    });

    it('empty → broaden nameContains text', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .query(true)
        .reply(200, {
          _embedded: { mailboxes: [] },
          page: { size: 50, totalElements: 0 },
        });

      const result = await toolHandler.callTool(
        makeRequest('listAllInboxes', { nameContains: 'zzz' }),
      );
      const joined: string = (body(result).apiGuidance as string[]).join('\n');
      expect(joined).toContain('No inboxes found');
      expect(joined).toContain('nameContains');
    });
  });

  describe('terminal tools', () => {
    it('getServerTime yields no apiGuidance and no suggestedTools', async () => {
      const result = await toolHandler.callTool(makeRequest('getServerTime', {}));
      expect(suggestedTools(result)).toBeUndefined();
      expect(body(result)?.apiGuidance).toBeUndefined();
    });
  });

  describe('error responses keep fix-guidance, no suggestedTools', () => {
    it('a validation-failure (isError) response carries its fix guidance', async () => {
      // searchConversations with an inbox mentioned in the query but no inboxId
      // trips the constraint validator → isError with fix suggestions.
      const result = await toolHandler.callTool(
        makeRequest('searchConversations', {
          query: 'refund',
          __userQuery: 'find tickets in the billing inbox',
        }),
      );

      expect(result.isError).toBe(true);
      const parsed = body(result);
      expect(parsed.error).toBe('API Constraint Validation Failed');
      expect(parsed.helpScoutAPIRequirements).toBeDefined();
      // No success-path next-step text or successor schemas on an error.
      expect(parsed.apiGuidance).toBeUndefined();
      expect(suggestedTools(result)).toBeUndefined();
    });
  });

  describe('call_tool re-entry', () => {
    it('hub guidance rides along when dispatched via call_tool', async () => {
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

      const names = (suggestedTools(result) ?? []).map((h) => h.name);
      expect(names).toContain('getOrganizationMembers');
      const joined: string = (body(result).apiGuidance as string[]).join('\n');
      expect(joined).toContain('getOrganizationMembers');
    });
  });

  describe('expose-all gate', () => {
    it('suppresses suggestedTools but keeps apiGuidance text', async () => {
      process.env.HELPSCOUT_EXPOSE_ALL_TOOLS = 'true';
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
      expect(suggestedTools(result)).toBeUndefined();
      // Next-step text is still useful and not gated.
      expect(body(result).apiGuidance).toBeDefined();
    });
  });
});
