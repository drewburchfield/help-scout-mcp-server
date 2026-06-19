import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import { cache } from '../utils/cache.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * NAS-1305 discovery layer tests.
 *
 * The default `tools/list` surface remains the full flat 55-tool catalog for
 * compatibility. `HELPSCOUT_TOOL_SURFACE=compact` opts into the 7 core read
 * tools + 3 meta tools (search_tools / get_tool_schema / call_tool).
 */
describe('Tool discovery layer (NAS-1305)', () => {
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
  const META_TOOLS = ['search_tools', 'get_tool_schema', 'call_tool'];

  beforeEach(() => {
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    delete process.env.HELPSCOUT_TOOL_SURFACE;

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

  // Helper: invoke a tool and parse its first text-content payload.
  async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const request = { params: { name, arguments: args } } as unknown as CallToolRequest;
    const result = await toolHandler.callTool(request);
    const first = result.content?.[0];
    if (!first || first.type !== 'text') {
      throw new Error('Expected text content');
    }
    return JSON.parse(first.text as string);
  }

  function validateClosedObjectSchema(schema: any, value: any, path = '$'): string[] {
    if (!schema || schema.type !== 'object' || typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [];
    }
    const errors: string[] = [];
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${path}.${key}`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateClosedObjectSchema(childSchema, value[key], `${path}.${key}`));
      }
    }
    return errors;
  }

  describe('default listTools() surface', () => {
    it('returns the full flat catalog of 55 tools (no meta tools)', async () => {
      const tools = await toolHandler.listTools();

      expect(tools).toHaveLength(55);
      const names = tools.map((t) => t.name);
      expect(names).toContain('getProductivityReport');
      for (const meta of META_TOOLS) {
        expect(names).not.toContain(meta);
      }
    });

    it('applies read-only annotations to every flat tool', async () => {
      const tools = await toolHandler.listTools();
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      }
    });
  });

  describe('compact listTools() surface', () => {
    beforeEach(() => {
      process.env.HELPSCOUT_TOOL_SURFACE = 'compact';
    });

    it('returns exactly the core tools + 3 meta tools', async () => {
      const tools = await toolHandler.listTools();
      expect(tools).toHaveLength(CORE_TOOLS.length + 3);

      const names = tools.map((t) => t.name);
      for (const meta of META_TOOLS) {
        expect(names).toContain(meta);
      }
      for (const core of CORE_TOOLS) {
        expect(names).toContain(core);
      }
      expect(names).not.toContain('getProductivityReport');
    });

    it('applies read-only annotations to core and meta tools', async () => {
      const tools = await toolHandler.listTools();
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      }
    });

    it('meta-tool schemas are sanitized (additionalProperties:false)', async () => {
      const tools = await toolHandler.listTools();
      const callToolDef = tools.find((t) => t.name === 'call_tool')!;
      expect(callToolDef.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      // The outer call_tool object is strict, but the nested arguments bag must
      // stay open so strict-schema clients can pass inner tool arguments through.
      const props = (callToolDef.inputSchema as { properties: Record<string, any> }).properties;
      expect(props.arguments.type).toBe('object');
      expect(props.arguments.additionalProperties).toBe(true);
    });

    it('keeps call_tool top-level strict while allowing nested tool arguments', async () => {
      const tools = await toolHandler.listTools();
      const callToolDef = tools.find((t) => t.name === 'call_tool')!;
      const schema = callToolDef.inputSchema as Record<string, unknown>;

      expect(validateClosedObjectSchema(schema, {
        name: 'searchConversations',
        arguments: {
          query: 'urgent',
          status: 'active',
        },
      })).toEqual([]);

      expect(validateClosedObjectSchema(schema, {
        name: 'searchConversations',
        arguments: {},
        unexpectedTopLevel: true,
      })).toContain('$.unexpectedTopLevel');
    });

    it('search_tools description carries the live total tool count', async () => {
      const tools = await toolHandler.listTools();
      const searchDef = tools.find((t) => t.name === 'search_tools')!;
      // 55 Help Scout tools advertised in the full catalog.
      expect(searchDef.description).toContain('55');
    });
  });

  describe('search_tools', () => {
    it('surfaces getHappinessReport for "happiness report"', async () => {
      const data = await call('search_tools', { query: 'happiness report' });
      const names = data.results.map((r: any) => r.name);
      expect(names).toContain('getHappinessReport');
      // Results carry name + description only (no schemas).
      expect(data.results[0]).toHaveProperty('description');
      expect(data.results[0]).not.toHaveProperty('inputSchema');
    });

    it('expands the "mailbox" synonym to surface inbox tools', async () => {
      const data = await call('search_tools', { query: 'mailbox' });
      const names = data.results.map((r: any) => r.name);
      // getInbox is a tail (non-core) inbox tool; listAllInboxes is core and
      // excluded from results.
      expect(names).toContain('getInbox');
    });

    it('returns a broaden-terms message on gibberish', async () => {
      const data = await call('search_tools', { query: 'zxqwv nonsense gibberish' });
      expect(data.results).toHaveLength(0);
      expect(data.message).toMatch(/broaden|rephrase/i);
    });
  });

  describe('get_tool_schema', () => {
    it('returns the sanitized inputSchema for a tail tool', async () => {
      const data = await call('get_tool_schema', { names: ['getProductivityReport'] });
      expect(data.schemas).toHaveLength(1);
      const entry = data.schemas[0];
      expect(entry.name).toBe('getProductivityReport');
      expect(entry.inputSchema).toBeDefined();
      // Sanitizer guarantees: object schemas get additionalProperties:false and
      // numbers become integers.
      expect(entry.inputSchema).toMatchObject({ additionalProperties: false });
      const schemaText = JSON.stringify(entry.inputSchema);
      expect(schemaText).not.toContain('"type":"number"');
    });

    it('flags an unknown name and suggests search_tools', async () => {
      const data = await call('get_tool_schema', { names: ['notARealTool'] });
      expect(data.schemas[0].unknown).toBe(true);
      expect(data.schemas[0].message).toMatch(/search_tools/);
    });
  });

  describe('call_tool', () => {
    it('dispatches a tail tool (getServerTime)', async () => {
      const data = await call('call_tool', { name: 'getServerTime', arguments: {} });
      // getServerTime returns its server-time payload directly.
      expect(data).toHaveProperty('isoTime');
      expect(data.source).toBe('mcp_host_clock');
    });

    it('validates the inner tool constraints when dispatching through call_tool', async () => {
      const data = await call('call_tool', {
        name: 'searchConversations',
        arguments: {
          query: 'urgent',
          __userQuery: 'find urgent conversations in the support inbox',
        },
      });

      expect(data.error).toBe('API Constraint Validation Failed');
      expect(data.details.requiredPrerequisites).toContain('listAllInboxes');
      expect(data.details.suggestions[0]).toContain('server instructions');
    });

    it('records the inner tool name in history for call_tool dispatch', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            mailboxes: [
              { id: 1, name: 'Support Inbox', email: 'support@example.com' },
            ],
          },
          page: { size: 100, totalElements: 1 },
        });

      await call('call_tool', { name: 'listAllInboxes', arguments: {} });

      const data = await call('call_tool', {
        name: 'searchConversations',
        arguments: {
          query: 'urgent',
          __userQuery: 'find urgent conversations in the support inbox',
        },
      });

      expect(data.error).toBe('API Constraint Validation Failed');
      expect(data.details.requiredPrerequisites).toBeUndefined();
      expect(data.details.suggestions[0]).toContain('Use the inbox ID from the listAllInboxes results');
    });

    it('returns an actionable error for an unknown tool name', async () => {
      const data = await call('call_tool', { name: 'nopeNotReal', arguments: {} });
      expect(data.error).toMatch(/Unknown tool 'nopeNotReal'\. Use search_tools/);
    });

    it('rejects recursive meta-tool invocation', async () => {
      const data = await call('call_tool', {
        name: 'call_tool',
        arguments: { name: 'getServerTime', arguments: {} },
      });
      expect(data.error).toMatch(/cannot invoke the meta-tool 'call_tool'/);
    });
  });
});
