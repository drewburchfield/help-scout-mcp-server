import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  HelpScoutFetchClient,
  RefreshMutex,
  ReauthRequiredError,
  TokenPersistenceError,
  type FetchClientDeps,
  type UserTokenContext,
} from '../worker/helpscout-fetch-client.js';
import { HelpScoutWriteError } from '../utils/api.js';

// Keep the client's inline logging out of the test output.
jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const BASE_URL = 'https://api.helpscout.net/v2/';
const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';

/** Build a fresh JSON Response on every call so bodies are never read twice. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface Harness {
  deps: FetchClientDeps;
  client: HelpScoutFetchClient;
  persistTokens: jest.Mock<(tokens: UserTokenContext) => Promise<void>>;
  getTokens: jest.Mock<() => UserTokenContext>;
  current: () => UserTokenContext;
}

function makeHarness(overrides: Partial<FetchClientDeps> = {}, initial?: Partial<UserTokenContext>): Harness {
  let tokens: UserTokenContext = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    // Far from expiry so proactive refresh never fires unless a test asks for it.
    expiresAt: Date.now() + 3_600_000,
    ...initial,
  };
  const persistTokens = jest.fn<(t: UserTokenContext) => Promise<void>>(async (t) => {
    tokens = t;
  });
  const getTokens = jest.fn<() => UserTokenContext>(() => tokens);

  const deps: FetchClientDeps = {
    baseUrl: BASE_URL,
    tokenUrl: TOKEN_URL,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    getTokens,
    persistTokens,
    refreshMutex: new RefreshMutex(),
    ...overrides,
  };

  return { deps, client: new HelpScoutFetchClient(deps), persistTokens, getTokens, current: () => tokens };
}

let fetchMock: jest.Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.fn<typeof fetch>();
  (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

type FetchInit = { method?: string; body?: unknown; headers?: Record<string, string> };

function lastInit(callIndex: number): FetchInit {
  return fetchMock.mock.calls[callIndex][1] as FetchInit;
}

function authHeader(callIndex: number): string | undefined {
  return lastInit(callIndex).headers?.Authorization;
}

describe('HelpScoutFetchClient', () => {
  describe('auth injection', () => {
    it('sets the injected bearer token on every request', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      await client.get('/conversations/1');

      expect(authHeader(0)).toBe('Bearer access-1');
    });

    it('never leaks tokens between two client instances', async () => {
      const a = makeHarness({}, { accessToken: 'token-A' });
      const b = makeHarness({}, { accessToken: 'token-B' });
      fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));

      await a.client.get('/mailboxes');
      await b.client.get('/mailboxes');

      expect(authHeader(0)).toBe('Bearer token-A');
      expect(authHeader(1)).toBe('Bearer token-B');
    });
  });

  describe('get', () => {
    it('parses a JSON body on the happy path', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(jsonResponse({ id: 42, subject: 'Hi' }));

      const result = await client.get<{ id: number; subject: string }>('/conversations/42');

      expect(result).toEqual({ id: 42, subject: 'Hi' });
    });

    it('does not cache: two identical gets issue two fetches', async () => {
      const { client } = makeHarness();
      fetchMock.mockImplementation(async () => jsonResponse({ id: 1 }));

      await client.get('/conversations/1', undefined, { ttl: 300 });
      await client.get('/conversations/1', undefined, { ttl: 300 });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('serializes query params onto the URL', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      await client.get('/conversations', { page: 2, status: 'active' });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toBe('https://api.helpscout.net/v2/conversations?page=2&status=active');
    });
  });

  describe('getAllPages', () => {
    it('accumulates multiple pages and stops at totalPages', async () => {
      const { client } = makeHarness();
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(input as string);
        const page = url.searchParams.get('page');
        if (page === '1') {
          return jsonResponse({
            _embedded: { conversations: [{ id: 1 }, { id: 2 }] },
            page: { size: 2, totalElements: 3, totalPages: 2, number: 1 },
          });
        }
        return jsonResponse({
          _embedded: { conversations: [{ id: 3 }] },
          page: { size: 2, totalElements: 3, totalPages: 2, number: 2 },
        });
      });

      const result = await client.getAllPages<{ id: number }>('/conversations', 'conversations');

      expect(result.items).toHaveLength(3);
      expect(result.pagesFetched).toBe(2);
      expect(result.totalElements).toBe(3);
      expect(result.truncated).toBe(false);
    });

    it('caps at maxItems and flags truncation', async () => {
      const { client } = makeHarness();
      fetchMock.mockImplementation(async () =>
        jsonResponse({
          _embedded: { conversations: [{ id: 1 }, { id: 2 }] },
          page: { size: 2, totalElements: 10, totalPages: 5, number: 1 },
        }),
      );

      const result = await client.getAllPages<{ id: number }>('/conversations', 'conversations', {}, 1);

      expect(result.items).toEqual([{ id: 1 }]);
      expect(result.truncated).toBe(true);
    });

    it('stops after a single page when totalPages is 1', async () => {
      const { client } = makeHarness();
      fetchMock.mockImplementation(async () =>
        jsonResponse({
          _embedded: { conversations: [{ id: 1 }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        }),
      );

      const result = await client.getAllPages('/conversations', 'conversations');

      expect(result.pagesFetched).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe('getRaw', () => {
    it('returns text with lowercase headers and forwards Accept', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(
        new Response('raw email source', {
          status: 200,
          headers: { 'Content-Type': 'message/rfc822' },
        }),
      );

      const result = await client.getRaw<string>('/conversations/1/threads/2/original-source', undefined, {
        responseType: 'text',
        headers: { Accept: 'message/rfc822' },
      });

      expect(result.status).toBe(200);
      expect(result.data).toBe('raw email source');
      expect(result.headers['content-type']).toBe('message/rfc822');
      expect((lastInit(0).headers as Record<string, string>).Accept).toBe('message/rfc822');
    });

    it('returns an ArrayBuffer with the correct bytes for arraybuffer', async () => {
      const { client } = makeHarness();
      const bytes = new Uint8Array([1, 2, 3, 4]);
      fetchMock.mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );

      const result = await client.getRaw<ArrayBuffer>('/conversations/1/attachments/2/file', undefined, {
        responseType: 'arraybuffer',
      });

      expect(result.data).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(result.data))).toEqual([1, 2, 3, 4]);
    });
  });

  describe('write verbs', () => {
    it('returns a WriteResponse carrying status, data, and resource-id', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(
        jsonResponse({ id: 555 }, 201, { 'Resource-Id': '555' }),
      );

      const result = await client.post('/conversations/1/threads', { text: 'hello' });

      expect(result.status).toBe(201);
      expect(result.data).toEqual({ id: 555 });
      expect(result.headers['resource-id']).toBe('555');
    });

    it('maps a 204 empty body to null data', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(new Response(null, { status: 204, headers: { 'Resource-Id': '9' } }));

      const result = await client.patch('/conversations/1', { subject: 'x' });

      expect(result.status).toBe(204);
      expect(result.data).toBeNull();
      expect(result.headers['resource-id']).toBe('9');
    });

    it('sends a JSON body and content-type when a body is provided', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

      await client.post('/conversations', { subject: 'New' });

      const init = lastInit(0);
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ subject: 'New' }));
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });
  });

  describe('write no-retry contract', () => {
    it.each([500, 429, 401])(
      'issues exactly one fetch and throws HelpScoutWriteError on %s',
      async (status) => {
        const { client } = makeHarness();
        fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, status));

        await expect(client.post('/conversations', { subject: 'x' })).rejects.toBeInstanceOf(
          HelpScoutWriteError,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const error = await client.post('/conversations', { subject: 'x' }).catch((e) => e);
        expect(error).toBeInstanceOf(HelpScoutWriteError);
        expect((error as HelpScoutWriteError).status).toBe(status);
      },
    );

    it('surfaces a network throw on a write as HelpScoutWriteError', async () => {
      const { client } = makeHarness();
      fetchMock.mockRejectedValue(new Error('connection reset'));

      const error = await client.delete('/conversations/1').catch((e) => e);
      expect(error).toBeInstanceOf(HelpScoutWriteError);
      expect((error as HelpScoutWriteError).status).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('read retry', () => {
    it('retries a 500 then succeeds', async () => {
      jest.useFakeTimers();
      const { client } = makeHarness();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

      const promise = client.get('/conversations/1');
      await jest.advanceTimersByTimeAsync(5000);

      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a network throw then succeeds', async () => {
      jest.useFakeTimers();
      const { client } = makeHarness();
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

      const promise = client.get('/conversations/1');
      await jest.advanceTimersByTimeAsync(5000);

      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('waits the X-RateLimit-Retry-After window on a 429 then retries', async () => {
      jest.useFakeTimers();
      const { client } = makeHarness();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429, { 'X-RateLimit-Retry-After': '2' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

      const promise = client.get('/conversations/1');

      // Not yet elapsed: still only the first attempt has run.
      await jest.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1500);
      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws a transformed ApiError once retries are exhausted', async () => {
      jest.useFakeTimers();
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(jsonResponse({ error: 'down' }, 500));

      const promise = client.get('/conversations/1').catch((e) => e);
      await jest.advanceTimersByTimeAsync(60000);

      const error = (await promise) as { code: string };
      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
    });
  });

  describe('transformError mapping', () => {
    // Exercise the pure mapping directly across the status table.
    const map = (context: Record<string, unknown>) =>
      (
        makeHarness().client as unknown as {
          transformError: (c: Record<string, unknown>) => { code: string; retryAfter?: number };
        }
      ).transformError({ requestId: 'r', headers: {}, ...context });

    it.each([
      [401, 'UNAUTHORIZED'],
      [403, 'UNAUTHORIZED'],
      [404, 'NOT_FOUND'],
      [422, 'INVALID_INPUT'],
      [429, 'RATE_LIMIT'],
      [400, 'INVALID_INPUT'],
      [500, 'UPSTREAM_ERROR'],
      [503, 'UPSTREAM_ERROR'],
    ])('maps status %s to %s', (status, code) => {
      expect(map({ status }).code).toBe(code);
    });

    it('maps a timeout (ECONNABORTED) to UPSTREAM_ERROR', () => {
      expect(map({ code: 'ECONNABORTED' }).code).toBe('UPSTREAM_ERROR');
    });

    it('prefers X-RateLimit-Retry-After for the 429 retryAfter', () => {
      const result = map({
        status: 429,
        headers: { 'x-ratelimit-retry-after': '30', 'retry-after': '120' },
      });
      expect(result.code).toBe('RATE_LIMIT');
      expect(result.retryAfter).toBe(30);
    });

    it('maps a 404 end-to-end through get', async () => {
      const { client } = makeHarness();
      fetchMock.mockResolvedValue(jsonResponse({ message: 'missing' }, 404));

      const error = (await client.get('/conversations/nope').catch((e) => e)) as { code: string };
      expect(error.code).toBe('NOT_FOUND');
    });
  });

  describe('token refresh with rotation', () => {
    it('refreshes on a 401, retries with the new token, and persists the rotated pair once', async () => {
      const harness = makeHarness();
      const { client, persistTokens } = harness;
      fetchMock.mockImplementation(async (input, init) => {
        const url = input as string;
        if (url === TOKEN_URL) {
          return jsonResponse({
            access_token: 'access-2',
            refresh_token: 'refresh-2',
            expires_in: 172800,
          });
        }
        const auth = (init?.headers as Record<string, string>).Authorization;
        if (auth === 'Bearer access-1') {
          return jsonResponse({ error: 'unauthorized' }, 401);
        }
        return jsonResponse({ ok: true });
      });

      const result = await client.get('/conversations/1');

      expect(result).toEqual({ ok: true });
      expect(persistTokens).toHaveBeenCalledTimes(1);
      expect(persistTokens).toHaveBeenCalledWith({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresAt: expect.any(Number),
      });

      // The token endpoint was called with the OLD refresh token, and the
      // rotated pair is now what the client holds.
      const tokenCall = fetchMock.mock.calls.find((c) => c[0] === TOKEN_URL);
      expect(JSON.parse(tokenCall![1]!.body as string).refresh_token).toBe('refresh-1');
      expect(harness.current().refreshToken).toBe('refresh-2');
    });

    it('refreshes exactly once for concurrent 401s (serialization)', async () => {
      const { client } = makeHarness();
      let refreshCalls = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = input as string;
        if (url === TOKEN_URL) {
          refreshCalls++;
          return jsonResponse({
            access_token: 'access-2',
            refresh_token: 'refresh-2',
            expires_in: 172800,
          });
        }
        const auth = (init?.headers as Record<string, string>).Authorization;
        if (auth === 'Bearer access-1') {
          return jsonResponse({ error: 'unauthorized' }, 401);
        }
        return jsonResponse({ ok: true });
      });

      const results = await Promise.all([
        client.get('/a'),
        client.get('/b'),
        client.get('/c'),
        client.get('/d'),
      ]);

      expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
      expect(refreshCalls).toBe(1);
    });

    it('proactively refreshes before a request when the token is near expiry', async () => {
      const { client, persistTokens } = makeHarness({}, { expiresAt: Date.now() + 10_000 });
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 172800 });
        }
        return jsonResponse({ ok: true });
      });

      await client.get('/conversations/1');

      expect(persistTokens).toHaveBeenCalledTimes(1);
      // The API request used the freshly rotated token.
      const apiCall = fetchMock.mock.calls.find((c) => c[0] !== TOKEN_URL)!;
      expect((apiCall[1]!.headers as Record<string, string>).Authorization).toBe('Bearer access-2');
    });
  });

  describe('refresh failure', () => {
    it('throws REAUTH_REQUIRED (not UNAUTHORIZED) on invalid_grant', async () => {
      const { client } = makeHarness();
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          return jsonResponse({ error: 'invalid_grant' }, 400);
        }
        return jsonResponse({ error: 'unauthorized' }, 401);
      });

      const error = (await client.get('/conversations/1').catch((e) => e)) as ReauthRequiredError;

      expect(error).toBeInstanceOf(ReauthRequiredError);
      expect(error.code).toBe('REAUTH_REQUIRED');
    });

    it('surfaces a temporary token-endpoint failure as an upstream error, not re-consent', async () => {
      const { client } = makeHarness();
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          return jsonResponse({ error: 'server_error' }, 503);
        }
        return jsonResponse({ error: 'unauthorized' }, 401);
      });

      const error = (await client.get('/conversations/1').catch((e) => e)) as { code: string };

      // A 503 from the token endpoint says nothing about the grant; telling
      // the user to reconnect here would be wrong and destructive advice.
      expect(error).not.toBeInstanceOf(ReauthRequiredError);
      expect(error.code).toBe('UPSTREAM_ERROR');
    });

    it('still retries after a refresh when the 401 lands on the final attempt', async () => {
      jest.useFakeTimers();
      const { client } = makeHarness();
      let apiCalls = 0;
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 172800 });
        }
        apiCalls++;
        if (apiCalls <= 3) return jsonResponse({ error: 'down' }, 500);
        if (apiCalls === 4) return jsonResponse({ error: 'unauthorized' }, 401);
        return jsonResponse({ ok: true }, 200);
      });

      const promise = client.get('/conversations/1');
      await jest.advanceTimersByTimeAsync(60000);

      // Three 5xx retries exhaust the budget; the 401 on the final attempt
      // must still get its post-refresh retry rather than running the loop out.
      await expect(promise).resolves.toEqual({ ok: true });
      expect(apiCalls).toBe(5);
    });

    it('does not repeat the exchange when persisting the rotated pair fails', async () => {
      // Near expiry so the proactive refresh fires before the read.
      const { client, persistTokens } = makeHarness({}, { expiresAt: Date.now() + 1000 });
      persistTokens.mockRejectedValue(new Error('KV write failed'));
      let tokenCalls = 0;
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          tokenCalls++;
          return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 172800 });
        }
        return jsonResponse({ ok: true });
      });

      const error = (await client.get('/conversations/1').catch((e) => e)) as TokenPersistenceError;

      // The old refresh token is already spent; a retry would exchange it
      // again and manufacture an invalid_grant on top of a storage failure.
      expect(error).toBeInstanceOf(TokenPersistenceError);
      expect(error).not.toBeInstanceOf(ReauthRequiredError);
      expect(tokenCalls).toBe(1);
    });

    it('does not tell the user to reconnect when the deployment credentials are rejected', async () => {
      const { client } = makeHarness();
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          return jsonResponse({ error: 'invalid_client' }, 401);
        }
        return jsonResponse({ error: 'unauthorized' }, 401);
      });

      const error = (await client.get('/conversations/1').catch((e) => e)) as { code: string; message: string };

      // invalid_client is a bad deployment secret; reconnecting cannot fix it.
      expect(error).not.toBeInstanceOf(ReauthRequiredError);
      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(error.message).toContain('invalid_client');
    });

    it('refuses to persist a malformed token refresh response', async () => {
      const { client, persistTokens } = makeHarness();
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          // 200 but missing refresh_token: persisting would corrupt the grant.
          return jsonResponse({ access_token: 'access-2', expires_in: 172800 });
        }
        return jsonResponse({ error: 'unauthorized' }, 401);
      });

      const error = (await client.get('/conversations/1').catch((e) => e)) as { code: string };

      expect(persistTokens).not.toHaveBeenCalled();
      expect(error.code).toBe('UPSTREAM_ERROR');
    });

    it.each([0, -1, Number.NaN])(
      'refuses to persist a refresh response with a nonsensical lifetime (%p)',
      async (expiresIn) => {
        const { client, persistTokens } = makeHarness();
        fetchMock.mockImplementation(async (input) => {
          if ((input as string) === TOKEN_URL) {
            return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: expiresIn });
          }
          return jsonResponse({ error: 'unauthorized' }, 401);
        });

        const error = (await client.get('/conversations/1').catch((e) => e)) as { code: string };

        expect(persistTokens).not.toHaveBeenCalled();
        expect(error.code).toBe('UPSTREAM_ERROR');
      },
    );

    it('retries a stale 401 with the current token instead of rotating again', async () => {
      const harness = makeHarness();
      let apiCalls = 0;
      let tokenCalls = 0;
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          tokenCalls++;
          return jsonResponse({ access_token: 'access-3', refresh_token: 'refresh-3', expires_in: 172800 });
        }
        apiCalls++;
        if (apiCalls === 1) {
          // While this response was in flight, another session rotated the
          // token: the 401 below was produced under access-1, not access-2.
          await harness.deps.persistTokens({
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            expiresAt: Date.now() + 3_600_000,
          });
          return jsonResponse({ error: 'unauthorized' }, 401);
        }
        return jsonResponse({ ok: true });
      });

      await expect(harness.client.get('/conversations/1')).resolves.toEqual({ ok: true });

      expect(tokenCalls).toBe(0);
      expect(authHeader(1)).toBe('Bearer access-2');
    });
  });

  describe('token URL validation', () => {
    it('rejects a non-HTTPS token URL', () => {
      expect(() => makeHarness({ tokenUrl: 'http://api.helpscout.net/v2/oauth2/token' })).toThrow(/HTTPS/);
    });
  });

  describe('proactive refresh failure classification', () => {
    it('propagates a classified token-endpoint outage once instead of retrying it per attempt', async () => {
      const { client } = makeHarness({}, { expiresAt: Date.now() + 1000 });
      let tokenCalls = 0;
      fetchMock.mockImplementation(async (input) => {
        if ((input as string) === TOKEN_URL) {
          tokenCalls++;
          return jsonResponse({ error: 'server_error' }, 503);
        }
        return jsonResponse({ ok: true });
      });

      const error = (await client.get('/conversations/1').catch((e) => e)) as { code: string; message: string };

      // The refresh path already classified this; the read retry loop must
      // not flatten it into an unknown error or hammer the token endpoint.
      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(error.message).toContain('503');
      expect(tokenCalls).toBe(1);
    });
  });

  describe('unknown expiry', () => {
    it('forces a refresh before a write when the expiry is unknown', async () => {
      // expiresAt 0 is the contract for "expiry unknown": refresh first.
      const { client } = makeHarness({}, { expiresAt: 0 });
      let tokenCalls = 0;
      fetchMock.mockImplementation(async (input, init) => {
        if ((input as string) === TOKEN_URL) {
          tokenCalls++;
          return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 172800 });
        }
        const auth = (init as { headers?: Record<string, string> })?.headers?.Authorization;
        // The write must run under the freshly rotated token, never the stale one.
        expect(auth).toBe('Bearer access-2');
        return jsonResponse({ id: 99 }, 201, { 'resource-id': '99' });
      });

      const result = await client.post('/conversations/1/notes', { text: 'hi' });

      expect(tokenCalls).toBe(1);
      expect(result.status).toBe(201);
    });
  });

  describe('validateHttpsBaseUrl', () => {
    it('rejects a non-HTTPS base URL', () => {
      expect(() => makeHarness({ baseUrl: 'http://api.helpscout.net/v2/' })).toThrow(/HTTPS/);
    });

    it('rejects a malformed base URL', () => {
      expect(() => makeHarness({ baseUrl: 'not a url' })).toThrow(/Invalid Help Scout base URL/);
    });
  });
});
