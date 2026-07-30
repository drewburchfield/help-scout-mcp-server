import nock from 'nock';
import { WriteHandler, WriteOperation } from '../tools/writes.js';
import { cache } from '../utils/cache.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const baseURL = 'https://api.helpscout.net/v2';
const CONVERSATION_ID = '4242';

/** Unconsumed mocks other than the persistent OAuth token endpoint. */
function pendingWriteMocks(): string[] {
  return nock.pendingMocks().filter(pending => !pending.includes('oauth2/token'));
}

function parsePayload(result: CallToolResult): Record<string, unknown> {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') throw new Error('Expected text content');
  return JSON.parse(first.text as string);
}

describe('WriteHandler', () => {
  let handler: WriteHandler;
  let operations: Map<string, WriteOperation>;

  function operation(name: string): WriteOperation {
    const found = operations.get(name);
    if (!found) throw new Error(`No write operation named ${name}`);
    return found;
  }

  function run(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return operation(name).execute(args);
  }

  beforeEach(() => {
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;

    nock.cleanAll();
    cache.clear();

    nock(baseURL)
      .persist()
      .post('/oauth2/token')
      .reply(200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 });

    handler = new WriteHandler();
    operations = new Map(handler.listOperations().map(op => [op.tool.name, op]));
  });

  afterEach(async () => {
    nock.cleanAll();
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('operation catalogue', () => {
    it('classes each operation and derives its tier from that class', () => {
      const expected: Record<string, string> = {
        createNote: 'nonDestructive',
        createDraftReply: 'nonDestructive',
        updateConversationStatus: 'reversible',
        assignConversation: 'reversible',
        unassignConversation: 'reversible',
        addConversationTags: 'reversible',
        removeConversationTags: 'reversible',
        updateConversationFields: 'reversible',
        snoozeConversation: 'reversible',
        unsnoozeConversation: 'reversible',
        moveConversation: 'reversible',
        sendReply: 'externallyVisible',
        publishDraft: 'externallyVisible',
      };

      expect([...operations.keys()].sort()).toEqual(Object.keys(expected).sort());
      for (const [name, mutationClass] of Object.entries(expected)) {
        const op = operation(name);
        expect(op.mutationClass).toBe(mutationClass);
        expect(op.tier).toBe(mutationClass === 'externallyVisible' ? 2 : 1);
        expect(op.targetArgument).toBe('conversationId');
      }
    });

    it('derives an input schema that requires a numeric conversationId', () => {
      for (const op of operations.values()) {
        const schema = op.tool.inputSchema as {
          type: string;
          required?: string[];
          properties: Record<string, { pattern?: string }>;
        };

        expect(schema.type).toBe('object');
        expect(schema.required).toContain('conversationId');
        expect(schema.properties.conversationId.pattern).toBe('^\\d+$');
        expect(schema).not.toHaveProperty('$schema');
      }
    });

    it('rejects a non-numeric conversationId without sending a request', async () => {
      const result = await run('createNote', { conversationId: 'abc', text: 'hi' });

      expect(result.isError).toBe(true);
      expect(pendingWriteMocks()).toEqual([]);
    });
  });

  describe('request construction', () => {
    it('posts only the note text', async () => {
      const scope = nock(baseURL)
        .post(`/conversations/${CONVERSATION_ID}/notes`, { text: 'internal only' })
        .reply(201, '', { 'Resource-Id': '881' });

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'internal only' });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
      expect((parsePayload(result).result as Record<string, unknown>).threadId).toBe('881');
    });

    it('pins draft true on createDraftReply', async () => {
      const scope = nock(baseURL)
        .post(`/conversations/${CONVERSATION_ID}/reply`, {
          text: 'draft body',
          draft: true,
          customer: { id: 77 },
          cc: ['cc@example.com'],
        })
        .reply(201, '', { 'Resource-Id': '882' });

      const result = await run('createDraftReply', {
        conversationId: CONVERSATION_ID,
        text: 'draft body',
        customerId: '77',
        cc: ['cc@example.com'],
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('refuses a caller-supplied draft flag on createDraftReply', async () => {
      // The schema has no `draft` property and is strict, so an argument that
      // tries to flip the operation into a send is refused rather than dropped:
      // a caller who believes the flag was honored must be told it was not.
      const scope = nock(baseURL)
        .post(`/conversations/${CONVERSATION_ID}/reply`)
        .reply(201);

      const result = await run('createDraftReply', {
        conversationId: CONVERSATION_ID,
        text: 'draft body',
        draft: false,
      });

      expect(result.isError).toBe(true);
      expect(scope.isDone()).toBe(false);
      expect((operation('createDraftReply').tool.inputSchema as {
        properties: Record<string, unknown>;
      }).properties).not.toHaveProperty('draft');
    });

    it('resolves the primary customer when the caller names none', async () => {
      const scope = nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, { primaryCustomer: { id: 500 } })
        .post(`/conversations/${CONVERSATION_ID}/reply`, body =>
          body.draft === true && body.customer?.id === 500)
        .reply(201);

      const result = await run('createDraftReply', {
        conversationId: CONVERSATION_ID,
        text: 'draft body',
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('refuses a misspelled argument instead of dropping it', async () => {
      const scope = nock(baseURL).post(`/conversations/${CONVERSATION_ID}/reply`).reply(201);

      const result = await run('createDraftReply', {
        conversationId: CONVERSATION_ID,
        text: 'draft body',
        customerId: '77',
        bcc_: ['quiet@example.com'],
      });

      expect(result.isError).toBe(true);
      expect(scope.isDone()).toBe(false);
    });

    it('advertises strict operation schemas so unknown arguments are visible as errors', () => {
      for (const op of operations.values()) {
        expect(op.tool.inputSchema as { additionalProperties?: unknown })
          .toMatchObject({ additionalProperties: false });
      }
    });

    it('sends draft false and inline status on sendReply', async () => {
      const scope = nock(baseURL)
        .post(`/conversations/${CONVERSATION_ID}/reply`, {
          text: 'sent body',
          draft: false,
          customer: { email: 'rob@acme.com' },
          assignTo: 12,
          status: 'closed',
        })
        .reply(201, '', { 'Resource-Id': '883' });

      const result = await run('sendReply', {
        conversationId: CONVERSATION_ID,
        text: 'sent body',
        customerEmail: 'rob@acme.com',
        assignTo: '12',
        status: 'closed',
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it.each([
      ['updateConversationStatus', { status: 'pending' }, { op: 'replace', path: '/status', value: 'pending' }],
      ['assignConversation', { userId: '9' }, { op: 'replace', path: '/assignTo', value: 9 }],
      ['unassignConversation', {}, { op: 'remove', path: '/assignTo' }],
      ['moveConversation', { mailboxId: '31' }, { op: 'move', path: '/mailboxId', value: 31 }],
      ['publishDraft', {}, { op: 'replace', path: '/draft', value: false }],
    ])('patches the conversation for %s', async (name, args, expectedBody) => {
      const scope = nock(baseURL)
        .patch(`/conversations/${CONVERSATION_ID}`, expectedBody as nock.RequestBodyMatcher)
        .reply(204);

      const result = await run(name, { conversationId: CONVERSATION_ID, ...args });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('merges requested tags into the current list, ignoring case', async () => {
      nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, { id: 4242, tags: [{ tag: 'vip' }, { tag: 'Billing' }] });
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/tags`, { tags: ['vip', 'Billing', 'urgent'] })
        .reply(204);

      const result = await run('addConversationTags', {
        conversationId: CONVERSATION_ID,
        tags: ['billing', 'urgent'],
      });
      const payload = parsePayload(result).result as Record<string, unknown>;

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
      expect(payload.previousTags).toEqual(['vip', 'Billing']);
      expect(payload.added).toEqual(['urgent']);
      expect(payload.alreadyPresent).toEqual(['billing']);
    });

    it('subtracts requested tags from the current list, ignoring case', async () => {
      nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, { id: 4242, tags: [{ tag: 'vip' }, { tag: 'Billing' }] });
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/tags`, { tags: ['vip'] })
        .reply(204);

      const result = await run('removeConversationTags', {
        conversationId: CONVERSATION_ID,
        tags: ['BILLING', 'absent'],
      });
      const payload = parsePayload(result).result as Record<string, unknown>;

      expect(scope.isDone()).toBe(true);
      expect(payload.removed).toEqual(['Billing']);
      expect(payload.notPresent).toEqual(['absent']);
    });

    it('sends one entry for a requested list that repeats a tag in another case', async () => {
      nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, { id: 4242, tags: [] });
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/tags`, { tags: ['urgent'] })
        .reply(204);

      const result = await run('addConversationTags', {
        conversationId: CONVERSATION_ID,
        tags: ['urgent', 'URGENT'],
      });
      const payload = parsePayload(result).result as Record<string, unknown>;

      expect(scope.isDone()).toBe(true);
      expect(payload.added).toEqual(['urgent']);
      expect(payload.alreadyPresent).toEqual([]);
    });

    it('merges custom fields by id and preserves untouched ones', async () => {
      nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, {
          id: 4242,
          customFields: [
            { id: 8, name: 'Account Type', value: '8518' },
            { id: 9, name: 'Region', value: 'emea' },
          ],
        });
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/fields`, {
          fields: [{ id: 8, value: '1234' }, { id: 9, value: 'emea' }],
        })
        .reply(204);

      const result = await run('updateConversationFields', {
        conversationId: CONVERSATION_ID,
        fields: [{ id: '8', value: '1234' }],
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('omits untouched custom fields that Help Scout returned without a value', async () => {
      nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, {
          id: 4242,
          customFields: [
            { id: 8, name: 'Account Type', value: '8518' },
            { id: 9, name: 'Region' },
          ],
        });
      // Field 9 has no value key: echoing `{ id: 9 }` into the full-replace
      // PUT has undefined semantics, and omitting an unset field leaves it
      // unset, so it must not appear in the body at all.
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/fields`, {
          fields: [{ id: 8, value: '8518' }, { id: 12, value: 'new' }],
        })
        .reply(204);

      const result = await run('updateConversationFields', {
        conversationId: CONVERSATION_ID,
        fields: [{ id: '12', value: 'new' }],
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('echoes untouched custom field values back exactly as Help Scout returned them', async () => {
      nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, {
          id: 4242,
          customFields: [
            { id: 8, name: 'Account Type', value: '8518' },
            { id: 9, name: 'Seats', value: 12 },
            { id: 10, name: 'Renewal', value: null },
          ],
        });
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/fields`, {
          fields: [{ id: 8, value: '1234' }, { id: 9, value: 12 }, { id: 10, value: null }],
        })
        .reply(204);

      const result = await run('updateConversationFields', {
        conversationId: CONVERSATION_ID,
        fields: [{ id: '8', value: '1234' }],
      });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('reads the conversation fresh rather than from cache before merging tags', async () => {
      // Prime the cache the way a getConversation read would.
      nock(baseURL).get(`/conversations/${CONVERSATION_ID}`).reply(200, { id: 4242, tags: [{ tag: 'stale' }] });
      const { helpScoutClient } = await import('../utils/helpscout-client.js');
      await helpScoutClient.get(`/conversations/${CONVERSATION_ID}`);

      nock(baseURL).get(`/conversations/${CONVERSATION_ID}`).reply(200, { id: 4242, tags: [{ tag: 'fresh' }] });
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/tags`, { tags: ['fresh', 'added'] })
        .reply(204);

      await run('addConversationTags', { conversationId: CONVERSATION_ID, tags: ['added'] });

      expect(scope.isDone()).toBe(true);
    });

    it('puts the snooze window with the customer-reply flag defaulted on', async () => {
      const snoozedUntil = new Date(Date.now() + 86_400_000).toISOString();
      const scope = nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/snooze`, { snoozedUntil, unsnoozeOnCustomerReply: true })
        .reply(204);

      const result = await run('snoozeConversation', { conversationId: CONVERSATION_ID, snoozedUntil });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('rejects a snooze time in the past before sending a request', async () => {
      const result = await run('snoozeConversation', {
        conversationId: CONVERSATION_ID,
        snoozedUntil: '2020-01-01T00:00:00Z',
      });

      expect(result.isError).toBe(true);
      expect(pendingWriteMocks()).toEqual([]);
    });

    it.each([
      ['a prose date Date.parse would accept', 'August 1 2099'],
      ['a US-format date', '08/01/2099'],
      ['a year alone', '2099'],
    ])('rejects %s as a snooze time', async (_case, snoozedUntil) => {
      const scope = nock(baseURL).put(`/conversations/${CONVERSATION_ID}/snooze`).reply(204);

      const result = await run('snoozeConversation', { conversationId: CONVERSATION_ID, snoozedUntil });

      expect(result.isError).toBe(true);
      expect(scope.isDone()).toBe(false);
    });

    it('deletes the snooze to wake a conversation', async () => {
      const scope = nock(baseURL).delete(`/conversations/${CONVERSATION_ID}/snooze`).reply(204);

      const result = await run('unsnoozeConversation', { conversationId: CONVERSATION_ID });

      expect(result.isError).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('result envelope', () => {
    it('reports a succeeded write with its target and cleanup plan', async () => {
      nock(baseURL).post(`/conversations/${CONVERSATION_ID}/notes`).reply(201, '', { 'Resource-Id': '881' });

      const payload = parsePayload(await run('createNote', {
        conversationId: CONVERSATION_ID,
        text: 'internal only',
      }));

      expect(payload).toMatchObject({
        operation: 'createNote',
        mutationClass: 'nonDestructive',
        target: { type: 'conversation', id: CONVERSATION_ID },
        status: 'succeeded',
      });
      expect(payload.cleanup).toEqual({
        required: false,
        performed: false,
        instructions: expect.any(String),
      });
    });

    it('reports a failed write with the upstream status and guidance', async () => {
      nock(baseURL).post(`/conversations/${CONVERSATION_ID}/notes`).reply(403, { message: 'no access' });

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'internal only' });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(payload).toMatchObject({
        operation: 'createNote',
        mutationClass: 'nonDestructive',
        target: { type: 'conversation', id: CONVERSATION_ID },
        status: 'failed',
        result: null,
      });
      const error = payload.error as Record<string, unknown>;
      expect(error.upstreamStatus).toBe(403);
      expect(error.upstreamBody).toEqual({ message: 'no access' });
      expect(String(error.guidance)).toContain('permission');
      expect((payload.cleanup as Record<string, unknown>).required).toBe(false);
    });

    it.each([
      [404, 'merged'],
      [412, '100 threads'],
      [423, 'locked'],
    ])('maps upstream %s to model-correctable guidance', async (status, phrase) => {
      nock(baseURL).post(`/conversations/${CONVERSATION_ID}/notes`).reply(status, {});

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'note' });
      const error = parsePayload(result).error as Record<string, unknown>;

      expect(result.isError).toBe(true);
      expect(error.upstreamStatus).toBe(status);
      expect(String(error.guidance)).toContain(phrase);
    });

    it('flags cleanup as required when the outcome is unknown', async () => {
      nock(baseURL).post(`/conversations/${CONVERSATION_ID}/notes`).reply(503, {});

      const payload = parsePayload(await run('createNote', {
        conversationId: CONVERSATION_ID,
        text: 'note',
      }));

      expect((payload.cleanup as Record<string, unknown>).required).toBe(true);
      expect(String((payload.cleanup as Record<string, unknown>).instructions)).toContain('getConversation');
    });

    it('reports a network failure as an unknown outcome with no upstream status', async () => {
      nock(baseURL)
        .post(`/conversations/${CONVERSATION_ID}/notes`)
        .replyWithError('socket hang up');

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'note' });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect((payload.error as Record<string, unknown>).upstreamStatus).toBeNull();
      expect((payload.cleanup as Record<string, unknown>).required).toBe(true);
    });

    it('names re-authentication for a 401 without claiming the write landed', async () => {
      nock(baseURL).post(`/conversations/${CONVERSATION_ID}/notes`).reply(401, { message: 'unauthorized' });

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'note' });
      const payload = parsePayload(result);
      const error = payload.error as Record<string, unknown>;

      expect(result.isError).toBe(true);
      expect(error.upstreamStatus).toBe(401);
      expect(String(error.guidance)).toContain('re-authenticates');
      expect(String(error.guidance)).toContain('nothing was applied');
      // A 401 is refused before processing, so the outcome is not in doubt.
      expect((payload.cleanup as Record<string, unknown>).required).toBe(false);
    });

    it('reports a failed pre-write read as a write that was never attempted', async () => {
      // 404 rather than 5xx: reads retry a 5xx, and the retry backoff would
      // dominate the test without changing what it proves.
      nock(baseURL).get(`/conversations/${CONVERSATION_ID}`).reply(404, {});
      const scope = nock(baseURL).put(`/conversations/${CONVERSATION_ID}/tags`).reply(204);

      const result = await run('addConversationTags', {
        conversationId: CONVERSATION_ID,
        tags: ['urgent'],
      });
      const payload = parsePayload(result);
      const error = payload.error as Record<string, unknown>;

      expect(result.isError).toBe(true);
      expect(payload.status).toBe('failed');
      expect(payload.result).toBeNull();
      expect(error.phase).toBe('preWriteRead');
      expect(String(error.guidance)).toContain('No mutation was attempted');
      expect(scope.isDone()).toBe(false);
    });

    it('refuses a reply with no named customer and no primary customer to fall back on', async () => {
      nock(baseURL).get(`/conversations/${CONVERSATION_ID}`).reply(200, {});
      const scope = nock(baseURL).post(`/conversations/${CONVERSATION_ID}/reply`).reply(201);

      const result = await run('createDraftReply', {
        conversationId: CONVERSATION_ID,
        text: 'draft body',
      });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(payload.status).toBe('failed');
      expect(JSON.stringify(payload)).toContain('customerId');
      expect(scope.isDone()).toBe(false);
    });

    it('says a 204 carries no body and names the read that confirms it', async () => {
      nock(baseURL).patch(`/conversations/${CONVERSATION_ID}`).reply(204);

      const payload = parsePayload(await run('updateConversationStatus', {
        conversationId: CONVERSATION_ID,
        status: 'closed',
      }));
      const result = payload.result as Record<string, unknown>;

      expect(result.httpStatus).toBe(204);
      expect(result.body).toBeNull();
      expect(String(result.note)).toContain('no response body');
      expect(String(result.verifyWith)).toContain('getConversation');
    });
  });

  describe('retry policy', () => {
    it('surfaces a 429 on a POST without a second attempt', async () => {
      let attempts = 0;
      nock(baseURL)
        .post(`/conversations/${CONVERSATION_ID}/notes`)
        .times(3)
        .reply(() => {
          attempts += 1;
          return [429, { message: 'rate limited' }, { 'retry-after': '1' }];
        });

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'note' });
      const payload = parsePayload(result);
      const error = payload.error as Record<string, unknown>;

      expect(attempts).toBe(1);
      expect(result.isError).toBe(true);
      expect(error.upstreamStatus).toBe(429);
      expect(String(error.guidance)).toContain('never retried automatically');
      expect((payload.cleanup as Record<string, unknown>).required).toBe(true);
    });

    it('surfaces a 429 on a PUT without a second attempt', async () => {
      nock(baseURL)
        .get(`/conversations/${CONVERSATION_ID}`)
        .reply(200, { id: 4242, tags: [] });
      let attempts = 0;
      nock(baseURL)
        .put(`/conversations/${CONVERSATION_ID}/tags`)
        .times(3)
        .reply(() => {
          attempts += 1;
          return [429, { message: 'rate limited' }];
        });

      const result = await run('addConversationTags', { conversationId: CONVERSATION_ID, tags: ['urgent'] });

      expect(attempts).toBe(1);
      expect(result.isError).toBe(true);
      expect((parsePayload(result).error as Record<string, unknown>).upstreamStatus).toBe(429);
    });

    it('surfaces a 500 on a DELETE without a second attempt', async () => {
      let attempts = 0;
      nock(baseURL)
        .delete(`/conversations/${CONVERSATION_ID}/snooze`)
        .times(3)
        .reply(() => {
          attempts += 1;
          return [500, {}];
        });

      const result = await run('unsnoozeConversation', { conversationId: CONVERSATION_ID });

      expect(attempts).toBe(1);
      expect(result.isError).toBe(true);
    });

    it('surfaces a 500 on a PATCH without a second attempt', async () => {
      let attempts = 0;
      nock(baseURL)
        .patch(`/conversations/${CONVERSATION_ID}`)
        .times(3)
        .reply(() => {
          attempts += 1;
          return [500, {}];
        });

      const result = await run('moveConversation', { conversationId: CONVERSATION_ID, mailboxId: '31' });

      expect(attempts).toBe(1);
      expect(result.isError).toBe(true);
    });
  });

  describe('cache invalidation', () => {
    /** Prime the read cache the way a getConversation call would. */
    async function primeCache(payload: Record<string, unknown>): Promise<void> {
      nock(baseURL).get(`/conversations/${CONVERSATION_ID}`).reply(200, payload);
      const { helpScoutClient } = await import('../utils/helpscout-client.js');
      await helpScoutClient.get(`/conversations/${CONVERSATION_ID}`);
    }

    async function readConversation(): Promise<Record<string, unknown>> {
      const { helpScoutClient } = await import('../utils/helpscout-client.js');
      return helpScoutClient.get(`/conversations/${CONVERSATION_ID}`);
    }

    it('drops the cache after a successful write so the read-back sees new state', async () => {
      await primeCache({ id: 4242, status: 'active' });
      nock(baseURL).post(`/conversations/${CONVERSATION_ID}/notes`).reply(201, '', { 'Resource-Id': '881' });

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'note' });
      expect(result.isError).toBeUndefined();

      nock(baseURL).get(`/conversations/${CONVERSATION_ID}`).reply(200, { id: 4242, status: 'closed' });
      expect((await readConversation()).status).toBe('closed');
    });

    it('drops the cache after an uncertain failure so the read-back is not a stale confirmation', async () => {
      await primeCache({ id: 4242, status: 'active' });
      nock(baseURL).post(`/conversations/${CONVERSATION_ID}/notes`).reply(429, { message: 'rate limited' });

      const result = await run('createNote', { conversationId: CONVERSATION_ID, text: 'note' });
      expect(result.isError).toBe(true);

      // The failure envelope tells the caller to read the conversation back. A
      // cached pre-write copy would answer "the write did not land" whether or
      // not it did, which is exactly the case that invites a duplicate.
      nock(baseURL).get(`/conversations/${CONVERSATION_ID}`).reply(200, { id: 4242, status: 'closed' });
      expect((await readConversation()).status).toBe('closed');
    });
  });

  describe('plan', () => {
    it('describes the request without sending it', () => {
      const planned = operation('moveConversation').plan({
        conversationId: CONVERSATION_ID,
        mailboxId: '31',
      });

      expect(planned).toEqual({
        method: 'PATCH',
        path: `/conversations/${CONVERSATION_ID}`,
        body: { op: 'move', path: '/mailboxId', value: 31 },
      });
      expect(pendingWriteMocks()).toEqual([]);
    });

    it('throws on invalid arguments rather than reporting a request', () => {
      expect(() => operation('moveConversation').plan({ conversationId: '1', mailboxId: 'abc' }))
        .toThrow();
    });
  });
});
