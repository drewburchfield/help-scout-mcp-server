import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import {
  GatewayHandler,
  GATEWAY_TOOL_NAMES,
  SEARCH_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from '../tools/gateway.js';
import { WriteHandler } from '../tools/writes.js';
import { cache } from '../utils/cache.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const baseURL = 'https://api.helpscout.net/v2';
const docsBaseURL = 'https://docsapi.helpscout.net/v1';

const TIER_1_OPERATIONS = [
  'createNote',
  'createDraftReply',
  'updateConversationStatus',
  'assignConversation',
  'unassignConversation',
  'addConversationTags',
  'removeConversationTags',
  'updateConversationFields',
  'snoozeConversation',
  'unsnoozeConversation',
  'moveConversation',
];

const TIER_2_OPERATIONS = ['sendReply', 'publishDraft'];

function callGateway(
  gateway: GatewayHandler,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  return gateway.callTool({
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function parsePayload(result: CallToolResult): Record<string, unknown> {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') throw new Error('Expected text content');
  return JSON.parse(first.text as string);
}

describe('GatewayHandler', () => {
  let toolHandler: ToolHandler;
  let gateway: GatewayHandler;

  beforeEach(() => {
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    process.env.HELPSCOUT_DOCS_API_KEY = 'test-docs-api-key';
    process.env.HELPSCOUT_DOCS_BASE_URL = `${docsBaseURL}/`;
    // The default surface is the 2.0 surface: both write gates off.
    delete process.env.HELPSCOUT_ENABLE_WRITES;
    delete process.env.HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES;

    nock.cleanAll();
    cache.clear();

    toolHandler = new ToolHandler();
    gateway = new GatewayHandler(toolHandler);
  });

  afterEach(async () => {
    nock.cleanAll();
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('registry completeness', () => {
    it('exposes every ToolHandler operation with unique names', async () => {
      const operations = await toolHandler.listTools();
      const registryNames = await gateway.listOperationNames();

      expect(registryNames).toHaveLength(operations.length);
      expect(new Set(registryNames).size).toBe(registryNames.length);
      expect(registryNames.sort()).toEqual(operations.map(tool => tool.name).sort());
    });
  });

  describe('listTools', () => {
    it('advertises exactly the three gateway tools', async () => {
      const tools = await gateway.listTools();

      expect(tools.map(tool => tool.name)).toEqual([...GATEWAY_TOOL_NAMES]);
      for (const tool of tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        expect(typeof tool.description).toBe('string');
      }
    });

    it('states the reachable operation count in the search tool description', async () => {
      const operations = await toolHandler.listTools();
      const [searchTool] = await gateway.listTools();

      expect(searchTool.description).toContain(String(operations.length));
    });
  });

  describe(SEARCH_TOOL_NAME, () => {
    it.each([
      ['find tickets about billing refunds', 'searchConversations'],
      ['read the full conversation thread', 'getThreads'],
      ['customer profile by email', 'searchCustomersByEmail'],
      ['raw original email source', 'getOriginalSource'],
      ['knowledge base article search', 'searchDocsArticles'],
      ['happiness ratings report', 'getHappinessReport'],
      ['which agents are on the team', 'listUsers'],
      ['company org members', 'getOrganizationMembers'],
    ])('recalls the expected operation for %j', async (query, expectedOperation) => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query });
      const payload = parsePayload(result);
      const names = (payload.results as { name: string }[]).map(entry => entry.name);

      expect(result.isError).toBeUndefined();
      expect(names).toContain(expectedOperation);
    });

    it('returns compact summaries without input schemas', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query: 'conversations' });
      const payload = parsePayload(result);
      const results = payload.results as Record<string, unknown>[];

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(8);
      for (const entry of results) {
        expect(entry).not.toHaveProperty('inputSchema');
      }
    });

    it('offers a hint when nothing matches', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query: 'zzzz qqqq' });
      const payload = parsePayload(result);

      expect(payload.results).toEqual([]);
      expect(typeof payload.hint).toBe('string');
    });

    it('rejects a missing query', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, {});

      expect(result.isError).toBe(true);
    });
  });

  describe(DESCRIBE_TOOL_NAME, () => {
    it('returns the full input schema for selected operations', async () => {
      const operations = await toolHandler.listTools();
      const expected = operations.find(tool => tool.name === 'searchConversations');

      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, {
        names: ['searchConversations', 'getThreads'],
      });
      const payload = parsePayload(result);
      const schemas = payload.schemas as Record<string, unknown>[];

      expect(result.isError).toBeUndefined();
      expect(schemas).toHaveLength(2);
      expect(schemas[0]).toEqual({
        name: 'searchConversations',
        description: expected?.description,
        inputSchema: expected?.inputSchema,
      });
    });

    it('flags unknown operation names without failing the call', async () => {
      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, {
        names: ['getThreads', 'notARealOperation'],
      });
      const schemas = parsePayload(result).schemas as Record<string, unknown>[];

      expect(result.isError).toBeUndefined();
      expect(schemas[1]).toEqual({ name: 'notARealOperation', unknown: true });
    });

    it('rejects malformed name lists', async () => {
      for (const names of [undefined, [], 'searchConversations', [42]]) {
        const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, { names });
        expect(result.isError).toBe(true);
      }
    });

    it('rejects more than the per-call name limit', async () => {
      const names = (await gateway.listOperationNames()).slice(0, 11);
      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, { names });

      expect(result.isError).toBe(true);
    });

    it('accepts exactly the per-call name limit', async () => {
      const names = (await gateway.listOperationNames()).slice(0, 10);
      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, { names });

      expect(result.isError).toBeUndefined();
      expect(parsePayload(result).schemas).toHaveLength(10);
    });
  });

  describe(READ_TOOL_NAME, () => {
    it('rejects unknown operations with suggestions', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, {
        name: 'searchConversation',
        arguments: {},
      });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(payload.didYouMean).toContain('searchConversations');
    });

    it('rejects malformed arguments', async () => {
      for (const args of ['not-an-object', 42, ['x']]) {
        const result = await callGateway(gateway, READ_TOOL_NAME, {
          name: 'getServerTime',
          arguments: args,
        });
        expect(result.isError).toBe(true);
      }
    });

    it('rejects a missing operation name', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, { arguments: {} });

      expect(result.isError).toBe(true);
    });

    it('dispatches with empty arguments when arguments are omitted', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, { name: 'getServerTime' });
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload.source).toBe('mcp_host_clock');
    });

    it('propagates operation error results unchanged', async () => {
      const errorResult: CallToolResult = {
        content: [{ type: 'text', text: '{"error":"upstream failed"}' }],
        isError: true,
      };
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue(errorResult);

      const result = await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual(errorResult.content);
      spy.mockRestore();
    });

    it('strips client-supplied __userQuery from operation arguments', async () => {
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      });

      await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: { __userQuery: 'spoofed by client' },
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          arguments: expect.not.objectContaining({ __userQuery: expect.anything() }),
        }),
      }));
      spy.mockRestore();
    });

    it('executes a registered operation end to end', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: {},
      });
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload.source).toBe('mcp_host_clock');
      expect(typeof payload.isoTime).toBe('string');
    });

    it('dispatches every registered operation to the operation handler', async () => {
      const names = await gateway.listOperationNames();
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      });

      for (const name of names) {
        const result = await callGateway(gateway, READ_TOOL_NAME, { name, arguments: {} });
        expect(result.isError).toBeUndefined();
      }

      expect(spy).toHaveBeenCalledTimes(names.length);
      expect(spy.mock.calls.map(call => call[0].params.name).sort()).toEqual([...names].sort());
      spy.mockRestore();
    });

    it('forwards the injected user query to the operation call', async () => {
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      });

      await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: {},
        __userQuery: 'what time is it for the server',
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          name: 'getServerTime',
          arguments: expect.objectContaining({ __userQuery: 'what time is it for the server' }),
        }),
      }));
      spy.mockRestore();
    });
  });

  describe('legacy direct calls', () => {
    it('still dispatches registered operation names called directly', async () => {
      const result = await callGateway(gateway, 'getServerTime', {});
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload.source).toBe('mcp_host_clock');
    });

    it('rejects names that are neither gateway tools nor operations', async () => {
      const result = await callGateway(gateway, 'definitelyNotATool', {});
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(String(payload.error)).toContain('definitelyNotATool');
    });
  });

  describe('registry guards', () => {
    function stubHandler(tools: Array<{ name: string; description: string }>): ToolHandler {
      return {
        listTools: jest.fn().mockResolvedValue(tools),
        callTool: jest.fn(),
      } as unknown as ToolHandler;
    }

    it('rejects duplicate operation names at build time', async () => {
      const broken = new GatewayHandler(stubHandler([
        { name: 'getThing', description: 'a' },
        { name: 'getThing', description: 'b' },
      ]));

      await expect(broken.listOperationNames()).rejects.toThrow('Duplicate operation name');
    });

    it('rejects operations that would be shadowed by gateway tool names', async () => {
      const broken = new GatewayHandler(stubHandler([
        { name: 'search_help_scout', description: 'colliding operation' },
      ]));

      await expect(broken.listOperationNames()).rejects.toThrow('collides with a gateway tool');
    });

    it('reserves write_help_scout even while writes are disabled', async () => {
      // The name is reserved, not merely taken: an operation may not claim a
      // name that would become unreachable the moment an operator flips the flag.
      const broken = new GatewayHandler(stubHandler([
        { name: WRITE_TOOL_NAME, description: 'colliding operation' },
      ]), { writeFlags: { enabled: false, customerVisibleEnabled: false } });

      await expect(broken.listOperationNames()).rejects.toThrow('collides with a gateway tool');
    });

    it('does not cache a failed registry build', async () => {
      const listTools = jest.fn()
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValue([{ name: 'getThing', description: 'a' }]);
      const flaky = new GatewayHandler({ listTools, callTool: jest.fn() } as unknown as ToolHandler);

      await expect(flaky.listOperationNames()).rejects.toThrow('transient failure');
      await expect(flaky.listOperationNames()).resolves.toEqual(['getThing']);
    });
  });

  describe('response shape', () => {
    it('returns structured content mirroring the text payload', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query: 'inbox folders' });
      const payload = parsePayload(result);

      expect(result.structuredContent).toEqual(payload);
    });
  });

  describe('write gating', () => {
    function tierOneGateway(): GatewayHandler {
      return new GatewayHandler(toolHandler, {
        writeFlags: { enabled: true, customerVisibleEnabled: false },
      });
    }

    function tierTwoGateway(): GatewayHandler {
      return new GatewayHandler(toolHandler, {
        writeFlags: { enabled: true, customerVisibleEnabled: true },
      });
    }

    async function describeNames(handler: GatewayHandler, names: string[]) {
      const result = await callGateway(handler, DESCRIBE_TOOL_NAME, { names });
      return parsePayload(result).schemas as Record<string, unknown>[];
    }

    describe('with both flags off', () => {
      it('advertises exactly the three read tools', async () => {
        const tools = await gateway.listTools();

        expect(tools.map(tool => tool.name)).toEqual([...GATEWAY_TOOL_NAMES]);
      });

      it('keeps write operations out of the registry entirely', async () => {
        const names = await gateway.listOperationNames();

        for (const operation of [...TIER_1_OPERATIONS, ...TIER_2_OPERATIONS]) {
          expect(names).not.toContain(operation);
        }
      });

      it('does not surface write operations in search results', async () => {
        for (const query of ['add a note to the ticket', 'reply to the customer', 'tag the conversation']) {
          const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query });
          const names = (parsePayload(result).results as { name: string }[]).map(entry => entry.name);

          for (const operation of [...TIER_1_OPERATIONS, ...TIER_2_OPERATIONS]) {
            expect(names).not.toContain(operation);
          }
        }
      });

      it('reports write operation names as unknown rather than gated', async () => {
        const schemas = await describeNames(gateway, ['createNote', 'sendReply']);

        expect(schemas).toEqual([
          { name: 'createNote', unknown: true },
          { name: 'sendReply', unknown: true },
        ]);
      });

      it('gives a write name the same read_help_scout error as a nonexistent one', async () => {
        const gated = parsePayload(await callGateway(gateway, READ_TOOL_NAME, { name: 'createNote' }));
        const missing = parsePayload(await callGateway(gateway, READ_TOOL_NAME, { name: 'notARealOperation' }));

        expect(String(gated.error)).toBe('Unknown Help Scout operation: createNote');
        expect(Object.keys(gated).sort()).toEqual(Object.keys(missing).sort());
        expect(gated).not.toHaveProperty('mutationClass');
      });

      it('rejects a direct write_help_scout call as an unknown tool', async () => {
        const result = await callGateway(gateway, WRITE_TOOL_NAME, { name: 'createNote' });
        const payload = parsePayload(result);

        expect(result.isError).toBe(true);
        expect(String(payload.error)).toBe(`Unknown tool: ${WRITE_TOOL_NAME}`);
      });

      it('rejects a write operation called directly as an unknown tool', async () => {
        const result = await callGateway(gateway, 'createNote', { conversationId: '123', text: 'hi' });

        expect(result.isError).toBe(true);
        expect(String(parsePayload(result).error)).toBe('Unknown tool: createNote');
      });

      it('does not tell the caller to execute an unknown name through read_help_scout', async () => {
        const result = await callGateway(gateway, 'sendReply', { conversationId: '123' });
        const hint = String(parsePayload(result).hint);

        expect(hint).toContain(SEARCH_TOOL_NAME);
        expect(hint).not.toContain(READ_TOOL_NAME);
      });
    });

    describe('with the customer-visible flag on but writes off', () => {
      it('advertises exactly the three read tools and registers no write operation', async () => {
        // Tier 2 is additive and inert on its own: the customer-visible flag
        // must not create a write path when writes are off entirely.
        const handler = new GatewayHandler(toolHandler, {
          writeFlags: { enabled: false, customerVisibleEnabled: true },
        });

        expect((await handler.listTools()).map(tool => tool.name)).toEqual([...GATEWAY_TOOL_NAMES]);

        const names = await handler.listOperationNames();
        for (const operation of [...TIER_1_OPERATIONS, ...TIER_2_OPERATIONS]) {
          expect(names).not.toContain(operation);
        }

        const search = await callGateway(handler, SEARCH_TOOL_NAME, { query: 'reply to the customer' });
        const found = (parsePayload(search).results as { name: string }[]).map(entry => entry.name);
        for (const operation of [...TIER_1_OPERATIONS, ...TIER_2_OPERATIONS]) {
          expect(found).not.toContain(operation);
        }

        const direct = await callGateway(handler, WRITE_TOOL_NAME, { name: 'sendReply' });
        expect(String(parsePayload(direct).error)).toBe(`Unknown tool: ${WRITE_TOOL_NAME}`);
      });
    });

    describe('with HELPSCOUT_ENABLE_WRITES only', () => {
      it('advertises write_help_scout alongside the three read tools', async () => {
        const tools = await tierOneGateway().listTools();

        expect(tools.map(tool => tool.name)).toEqual([...GATEWAY_TOOL_NAMES, WRITE_TOOL_NAME]);
      });

      it('states the confirmation contract in the write tool description', async () => {
        const tools = await tierOneGateway().listTools();
        const writeTool = tools.find(tool => tool.name === WRITE_TOOL_NAME);

        expect(writeTool?.description).toContain('confirm');
        expect(writeTool?.description).toContain('confirmOperation');
        expect(writeTool?.description).toContain('targetId');
        expect(writeTool?.description).toContain('externallyVisible');
        expect(writeTool?.description).toContain('dryRun');
      });

      it('makes every tier 1 operation discoverable and schema-loadable', async () => {
        const handler = tierOneGateway();
        const names = await handler.listOperationNames();

        expect(names).toEqual(expect.arrayContaining(TIER_1_OPERATIONS));

        const schemas = await describeNames(handler, TIER_1_OPERATIONS.slice(0, 10));
        for (const schema of schemas) {
          expect(schema).not.toHaveProperty('unknown');
          expect(schema.tier).toBe(1);
          expect(['nonDestructive', 'reversible']).toContain(schema.mutationClass);
        }
      });

      it('labels write entries in search results and leaves read entries unchanged', async () => {
        const result = await callGateway(tierOneGateway(), SEARCH_TOOL_NAME, { query: 'internal note on a ticket' });
        const results = parsePayload(result).results as Record<string, unknown>[];
        const note = results.find(entry => entry.name === 'createNote');
        const read = results.find(entry => entry.name === 'getThreads');

        expect(note?.access).toBe('write (nonDestructive)');
        if (read) {
          expect(read).not.toHaveProperty('access');
        }
      });

      it('keeps tier 2 operations unknown', async () => {
        const handler = tierOneGateway();

        expect(await describeNames(handler, TIER_2_OPERATIONS)).toEqual([
          { name: 'sendReply', unknown: true },
          { name: 'publishDraft', unknown: true },
        ]);
        expect(await handler.listOperationNames()).not.toContain('sendReply');
      });

      it('redirects a mutating operation off read_help_scout', async () => {
        const result = await callGateway(tierOneGateway(), READ_TOOL_NAME, {
          name: 'createNote',
          arguments: { conversationId: '123', text: 'hi' },
        });
        const payload = parsePayload(result);

        expect(result.isError).toBe(true);
        expect(String(payload.error)).toContain('createNote');
        expect(String(payload.hint)).toContain(WRITE_TOOL_NAME);
        expect(payload.mutationClass).toBe('nonDestructive');
      });

      it('still refuses a write operation on the legacy direct path', async () => {
        const result = await callGateway(tierOneGateway(), 'createNote', {
          conversationId: '123',
          text: 'hi',
        });

        expect(result.isError).toBe(true);
        expect(String(parsePayload(result).error)).toBe('Unknown tool: createNote');
      });

      it('refuses a read operation sent to write_help_scout', async () => {
        const result = await callGateway(tierOneGateway(), WRITE_TOOL_NAME, {
          name: 'getServerTime',
        });

        expect(result.isError).toBe(true);
        expect(String(parsePayload(result).hint)).toContain(READ_TOOL_NAME);
      });
    });

    describe('with both flags on', () => {
      it('adds the tier 2 operations', async () => {
        const handler = tierTwoGateway();
        const names = await handler.listOperationNames();

        expect(names).toEqual(expect.arrayContaining([...TIER_1_OPERATIONS, ...TIER_2_OPERATIONS]));

        const schemas = await describeNames(handler, TIER_2_OPERATIONS);
        for (const schema of schemas) {
          expect(schema.tier).toBe(2);
          expect(schema.mutationClass).toBe('externallyVisible');
        }
      });

      it('labels tier 2 entries as externally visible writes in search', async () => {
        const result = await callGateway(tierTwoGateway(), SEARCH_TOOL_NAME, { query: 'send a reply to the customer' });
        const results = parsePayload(result).results as Record<string, unknown>[];

        expect(results.find(entry => entry.name === 'sendReply')?.access).toBe('write (externallyVisible)');
      });
    });
  });

  describe('annotations', () => {
    it('marks the three read tools read-only and the write tool destructive', async () => {
      const tools = await new GatewayHandler(toolHandler, {
        writeFlags: { enabled: true, customerVisibleEnabled: true },
      }).listTools();

      for (const name of GATEWAY_TOOL_NAMES) {
        expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true });
      }
      expect(tools.find(tool => tool.name === WRITE_TOOL_NAME)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it('never marks a write operation read-only, whatever its mutation class', () => {
      for (const operation of new WriteHandler().listOperations()) {
        expect(operation.tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      }
    });
  });

  describe(`${WRITE_TOOL_NAME} confirmation`, () => {
    let writeGateway: GatewayHandler;

    beforeEach(() => {
      writeGateway = new GatewayHandler(toolHandler, {
        writeFlags: { enabled: true, customerVisibleEnabled: true },
      });
      nock(baseURL)
        .persist()
        .post('/oauth2/token')
        .reply(200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 });
    });

    const replyArgs = { conversationId: '4242', text: 'Thanks for reaching out.' };

    it.each([
      ['confirm missing', {}],
      ['confirm false', { confirm: false, confirmOperation: 'sendReply', targetId: '4242' }],
      ['confirmOperation missing', { confirm: true, targetId: '4242' }],
      ['confirmOperation naming another operation', { confirm: true, confirmOperation: 'publishDraft', targetId: '4242' }],
      ['targetId missing', { confirm: true, confirmOperation: 'sendReply' }],
      ['targetId for another conversation', { confirm: true, confirmOperation: 'sendReply', targetId: '9999' }],
    ])('refuses sendReply when %s', async (_case, confirmation) => {
      const scope = nock(baseURL).post('/conversations/4242/reply').reply(201);

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'sendReply',
        arguments: replyArgs,
        ...confirmation,
      });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(payload.operation).toBe('sendReply');
      expect(payload.mutationClass).toBe('externallyVisible');
      expect(payload.required).toEqual({
        confirm: true,
        confirmOperation: 'sendReply',
        targetId: '4242',
      });
      expect(scope.isDone()).toBe(false);
    });

    it('dispatches sendReply when the full confirmation triple matches', async () => {
      const scope = nock(baseURL)
        .get('/conversations/4242')
        .reply(200, { primaryCustomer: { id: 500 } })
        .post('/conversations/4242/reply', body => body.customer?.id === 500)
        .reply(201, '', { 'Resource-Id': '99' });

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'sendReply',
        arguments: replyArgs,
        confirm: true,
        confirmOperation: 'sendReply',
        targetId: '4242',
      });
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload.status).toBe('succeeded');
      expect(scope.isDone()).toBe(true);
    });

    it('refuses publishDraft without confirmation and accepts it with', async () => {
      const refused = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'publishDraft',
        arguments: { conversationId: '4242' },
        confirm: true,
        confirmOperation: 'publishDraft',
      });
      expect(refused.isError).toBe(true);

      const scope = nock(baseURL).patch('/conversations/4242').reply(204);
      const accepted = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'publishDraft',
        arguments: { conversationId: '4242' },
        confirm: true,
        confirmOperation: 'publishDraft',
        targetId: '4242',
      });

      expect(accepted.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('does not require confirmation for tier 1 operations', async () => {
      const scope = nock(baseURL).post('/conversations/4242/notes').reply(201, '', { 'Resource-Id': '7' });

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createNote',
        arguments: { conversationId: '4242', text: 'internal' },
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('accepts a numeric targetId that matches the conversation ID', async () => {
      const scope = nock(baseURL)
        .get('/conversations/4242')
        .reply(200, { primaryCustomer: { id: 500 } })
        .post('/conversations/4242/reply')
        .reply(201, '', { 'Resource-Id': '99' });

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'sendReply',
        arguments: replyArgs,
        confirm: true,
        confirmOperation: 'sendReply',
        targetId: 4242,
      });

      expect(result.isError).toBeUndefined();
      expect(parsePayload(result).status).toBe('succeeded');
      expect(scope.isDone()).toBe(true);
    });

    it('names the missing target argument when arguments carry no conversationId', async () => {
      const scope = nock(baseURL).post('/conversations/4242/reply').reply(201);

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'sendReply',
        arguments: { text: 'Thanks for reaching out.' },
        confirm: true,
        confirmOperation: 'sendReply',
        targetId: '4242',
      });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect((payload.required as Record<string, unknown>).targetId)
        .toBe('the conversationId in "arguments"');
      expect(scope.isDone()).toBe(false);
    });

    it('refuses an externallyVisible operation the moment the gate is revoked', async () => {
      // The registry is built once per process. Execution is not: an operator
      // who turns the flag off mid-process must lose the path immediately, even
      // though tools/list keeps advertising it until a restart.
      const flags = { enabled: true, customerVisibleEnabled: true };
      const revocable = new GatewayHandler(toolHandler, { writeFlags: flags });

      const described = await callGateway(revocable, DESCRIBE_TOOL_NAME, { names: ['sendReply'] });
      expect((parsePayload(described).schemas as Record<string, unknown>[])[0].tier).toBe(2);

      flags.customerVisibleEnabled = false;

      const scope = nock(baseURL).post('/conversations/4242/reply').reply(201);
      const result = await callGateway(revocable, WRITE_TOOL_NAME, {
        name: 'sendReply',
        arguments: replyArgs,
        confirm: true,
        confirmOperation: 'sendReply',
        targetId: '4242',
      });

      expect(result.isError).toBe(true);
      expect(String(parsePayload(result).error)).toContain('customer-visible write gate is off');
      expect(scope.isDone()).toBe(false);
    });

    it('refuses a tier-1-labelled operation whose mutation class is externallyVisible', async () => {
      // Gating reads the mutation class, not the declared tier: a registry
      // whose tier disagreed with its class must not become a bypass.
      const writes = new WriteHandler();
      const mislabelled = {
        listOperations: () => writes.listOperations().map(operation => (
          operation.mutationClass === 'externallyVisible'
            ? { ...operation, tier: 1 as const }
            : operation
        )),
      };
      const handler = new GatewayHandler(toolHandler, {
        writes: mislabelled,
        writeFlags: { enabled: true, customerVisibleEnabled: false },
      });

      const names = await handler.listOperationNames();
      expect(names).not.toContain('sendReply');
    });
  });

  describe(`${WRITE_TOOL_NAME} dry run`, () => {
    let writeGateway: GatewayHandler;

    beforeEach(() => {
      writeGateway = new GatewayHandler(toolHandler, {
        writeFlags: { enabled: true, customerVisibleEnabled: true },
      });
    });

    it('reports the planned request without contacting Help Scout', async () => {
      const scope = nock(baseURL).post('/conversations/4242/notes').reply(201);

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createNote',
        arguments: { conversationId: '4242', text: 'internal' },
        dryRun: true,
      });
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload).toMatchObject({
        operation: 'createNote',
        mutationClass: 'nonDestructive',
        dryRun: true,
        wouldSend: {
          method: 'POST',
          path: '/conversations/4242/notes',
          body: { text: 'internal' },
        },
      });
      expect(String(payload.note)).toContain('Help Scout state was not checked');
      expect(scope.isDone()).toBe(false);
    });

    it('validates arguments before reporting the planned request', async () => {
      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createNote',
        arguments: { conversationId: 'not-numeric', text: '' },
        dryRun: true,
      });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(payload).not.toHaveProperty('wouldSend');
      expect(payload.validationIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'conversationId' }),
      ]));
    });

    it('still enforces confirmation before a customer-visible dry run', async () => {
      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'sendReply',
        arguments: { conversationId: '4242', text: 'hello' },
        dryRun: true,
      });

      expect(result.isError).toBe(true);
      expect(parsePayload(result)).not.toHaveProperty('wouldSend');
    });

    it('names the preceding read for a read-modify-write operation', async () => {
      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'addConversationTags',
        arguments: { conversationId: '4242', tags: ['urgent'] },
        dryRun: true,
      });
      const wouldSend = parsePayload(result).wouldSend as Record<string, unknown>;

      expect(wouldSend.method).toBe('PUT');
      expect(wouldSend.precededBy).toEqual({ method: 'GET', path: '/conversations/4242' });
      expect(typeof wouldSend.bodyNote).toBe('string');
      // No `body`: the requested tags are not the body that gets sent, and
      // showing them under that name reads as a full tag replacement.
      expect(wouldSend).not.toHaveProperty('body');
      expect(wouldSend.bodyBeforeMerge).toEqual({ tags: ['urgent'] });
    });

    it('never presents a reply body without its recipient', async () => {
      const withoutCustomer = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createDraftReply',
        arguments: { conversationId: '4242', text: 'looking into it' },
        dryRun: true,
      });
      const planned = parsePayload(withoutCustomer).wouldSend as Record<string, unknown>;

      // The recipient is decided by a read, so the preview must not offer a
      // customer-less body as the exact request that will be sent.
      expect(planned).not.toHaveProperty('body');
      expect(planned.precededBy).toEqual({ method: 'GET', path: '/conversations/4242' });
      expect(String(planned.bodyNote)).toContain('primary customer');
      expect(planned.bodyBeforeMerge).toMatchObject({ text: 'looking into it' });

      const withCustomer = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createDraftReply',
        arguments: { conversationId: '4242', text: 'looking into it', customerId: '77' },
        dryRun: true,
      });
      const exact = parsePayload(withCustomer).wouldSend as Record<string, unknown>;

      expect(exact.body).toMatchObject({ customer: { id: 77 } });
      expect(exact).not.toHaveProperty('precededBy');
    });
  });

  describe(`${WRITE_TOOL_NAME} envelope`, () => {
    let writeGateway: GatewayHandler;

    beforeEach(() => {
      writeGateway = new GatewayHandler(toolHandler, {
        writeFlags: { enabled: true, customerVisibleEnabled: true },
      });
      nock(baseURL)
        .persist()
        .post('/oauth2/token')
        .reply(200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 });
    });

    const noteArgs = { conversationId: '4242', text: 'internal' };

    it.each([
      ['a string "true"', 'true'],
      ['the number 1', 1],
      ['null', null],
    ])('refuses a dryRun that is %s rather than executing the write', async (_case, dryRun) => {
      const scope = nock(baseURL).post('/conversations/4242/notes').reply(201);

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createNote',
        arguments: noteArgs,
        dryRun,
      });

      expect(result.isError).toBe(true);
      expect(String(parsePayload(result).error)).toContain('"dryRun" must be a boolean');
      expect(scope.isDone()).toBe(false);
    });

    it('refuses an unknown top-level field', async () => {
      const scope = nock(baseURL).post('/conversations/4242/notes').reply(201);

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createNote',
        arguments: noteArgs,
        conversationId: '4242',
      });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(String(payload.error)).toContain('conversationId');
      expect(payload.allowedFields).toContain('arguments');
      expect(scope.isDone()).toBe(false);
    });

    it.each(['dryRun', 'confirm', 'confirmOperation', 'targetId'])(
      'refuses %s inside "arguments" instead of stripping it',
      async (field) => {
        const scope = nock(baseURL).post('/conversations/4242/notes').reply(201);

        const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
          name: 'createNote',
          arguments: { ...noteArgs, [field]: true },
        });

        expect(result.isError).toBe(true);
        expect(String(parsePayload(result).error)).toContain(field);
        expect(scope.isDone()).toBe(false);
      },
    );

    it('tolerates the server-injected __userQuery and keeps it out of the operation', async () => {
      const scope = nock(baseURL).post('/conversations/4242/notes', { text: 'internal' })
        .reply(201, '', { 'Resource-Id': '7' });

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createNote',
        arguments: noteArgs,
        __userQuery: 'add a note about the refund',
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('refuses a misspelled operation argument rather than dropping it', async () => {
      const scope = nock(baseURL).post('/conversations/4242/reply').reply(201);

      const result = await callGateway(writeGateway, WRITE_TOOL_NAME, {
        name: 'createDraftReply',
        arguments: { conversationId: '4242', text: 'hello', customerId: '77', bcc_: ['quiet@example.com'] },
      });

      expect(result.isError).toBe(true);
      expect(scope.isDone()).toBe(false);
    });
  });
});
