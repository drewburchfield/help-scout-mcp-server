/**
 * fetch-based Help Scout client for the Cloudflare Workers build.
 *
 * This is a port of the axios-backed `HelpScoutClient`
 * (`src/utils/helpscout-client.ts`) onto the platform `fetch`, implementing the
 * same `HelpScoutApi` seam so every tool, write, and resource handler resolves
 * it through `getClient()` unchanged. The two clients coexist: the stdio server
 * keeps the axios client with its connection pool and shared cache; a per-user
 * remote request constructs one of these and scopes it with `withHelpScoutApi()`.
 *
 * Two things fall away in the Workers runtime and are deliberately gone here:
 * the http.Agent connection pool (Workers has no sockets) and the shared read
 * cache (a process-wide cache would leak one user's data to the next). Two
 * things are net-new: per-user OAuth token injection and a serialized
 * refresh-with-rotation flow. Everything else is either a verbatim port of a
 * pure helper or a mechanical axios -> fetch rewrite.
 */
import {
  HelpScoutWriteError,
  type HelpScoutApi,
  type PaginatedResponse,
  type RawGetOptions,
  type RawResponse,
  type WriteMethod,
  type WriteResponse,
} from '../utils/api.js';
import { logger } from '../utils/logger.js';
import { ApiError } from '../schema/types.js';

/** Refresh proactively once the access token is within this window of expiry. */
const REFRESH_BUFFER_MS = 60_000;

/** Default request timeout, enforced with AbortSignal.timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

interface RetryConfig {
  retries: number;
  retryDelay: number;
  maxRetryDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  retries: 3,
  retryDelay: 1000, // 1 second
  maxRetryDelay: 10000, // 10 seconds
};

/**
 * The per-user OAuth pair the client reads for every request. `expiresAt`
 * (epoch ms) drives proactive refresh; it is optional so a caller that only has
 * the tokens still works, falling back to reactive refresh on a 401.
 */
export interface UserTokenContext {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

/**
 * Everything the client needs, injected per request. Tokens are read through
 * `getTokens()` (not captured by value) so a mid-request rotation is picked up
 * by the very next request; `persistTokens` writes the rotated pair back to
 * wherever the caller stores grant state, keeping the client storage-agnostic.
 */
export interface FetchClientDeps {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  getTokens: () => UserTokenContext;
  persistTokens: (tokens: UserTokenContext) => Promise<void>;
  refreshMutex: RefreshMutex;
  timeoutMs?: number;
}

/**
 * Serializes token refresh for one user so concurrent 401s (or concurrent
 * proactive refreshes) spend the rotating refresh token exactly once. The first
 * caller starts the refresh and stores the promise; concurrent callers await
 * the same one; the slot is cleared in `finally`, but only if it still points at
 * that promise, so a refresh that starts after this one completes is never
 * clobbered.
 *
 * This mirrors the axios client's `authenticationPromise` guard. It covers a
 * single Durable Object instance; a user with two live sessions is two
 * instances with two mutexes, and account-wide serialization (a per-user DO or
 * a KV compare-and-swap) is the follow-up fix, not this layer's job.
 */
export class RefreshMutex {
  private inFlight: Promise<UserTokenContext> | null = null;

  run(operation: () => Promise<UserTokenContext>): Promise<UserTokenContext> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const promise = operation().finally(() => {
      if (this.inFlight === promise) {
        this.inFlight = null;
      }
    });
    this.inFlight = promise;
    return promise;
  }
}

/**
 * Refresh failed because the refresh token is spent or revoked (invalid_grant).
 * Distinct from the generic UNAUTHORIZED prose because the only recovery is for
 * the user to reconnect the connector, and the model should say exactly that
 * rather than suggest checking credentials it cannot see.
 */
export class ReauthRequiredError extends Error {
  readonly code = 'REAUTH_REQUIRED' as const;

  constructor(
    message: string,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/** The subset of a failed response `transformError` reasons about. */
interface ErrorContext {
  status?: number;
  headers: Record<string, string>;
  data?: unknown;
  requestId: string;
  /** Set to 'ECONNABORTED' for a timeout, mirroring the axios timeout code. */
  code?: string;
}

/** Copy a fetch `Headers` into a plain object; fetch keys are already lowercase. */
function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export class HelpScoutFetchClient implements HelpScoutApi {
  private readonly timeoutMs: number;
  private readonly retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG;

  constructor(private readonly deps: FetchClientDeps) {
    this.validateHttpsBaseUrl(deps.baseUrl);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // --- Pure helpers, ported verbatim from the axios client -------------------

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private validateHttpsBaseUrl(baseUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid Help Scout base URL: ${baseUrl}`);
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('HELPSCOUT_BASE_URL must use HTTPS to protect OAuth2 credentials');
    }
  }

  private parseRetryAfterMs(value: unknown, fallbackMs = 60000): number {
    const rawValue = Array.isArray(value) ? value[0] : value;

    if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0) {
      return rawValue * 1000;
    }

    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }

      const retryAt = Date.parse(trimmed);
      if (Number.isFinite(retryAt)) {
        return Math.max(retryAt - Date.now(), 0);
      }
    }

    return fallbackMs;
  }

  private calculateRetryDelay(attempt: number, baseDelay: number, maxDelay: number): number {
    // Exponential backoff with jitter
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  // --- Request construction --------------------------------------------------

  private newRequestId(): string {
    return Math.random().toString(36).substring(7);
  }

  /**
   * Join the base URL and endpoint the way axios joins baseURL + url: by
   * concatenating trimmed paths, NOT via `new URL(endpoint, base)`, which would
   * treat a leading-slash endpoint as absolute and drop the `/v2` prefix.
   */
  private buildUrl(endpoint: string, params?: Record<string, unknown>): string {
    const base = this.deps.baseUrl.replace(/\/+$/, '');
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = new URL(base + path);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item === undefined || item === null) continue;
            url.searchParams.append(key, String(item));
          }
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    return url.toString();
  }

  /**
   * Refresh proactively when the token is set to expire within the buffer,
   * before ever issuing the request. This is what keeps writes usable: they
   * never retry a 401, so they rely on almost never meeting an expired token.
   */
  private async maybeProactiveRefresh(): Promise<void> {
    const tokens = this.deps.getTokens();
    if (tokens.expiresAt === undefined) return;
    if (Date.now() > tokens.expiresAt - REFRESH_BUFFER_MS) {
      await this.refresh();
    }
  }

  /**
   * Exchange the current refresh token for a rotated pair, serialized through
   * the injected mutex so concurrent callers refresh once. Persists the new pair
   * before returning so the next `getTokens()` reads the rotated tokens.
   */
  private async refresh(): Promise<UserTokenContext> {
    return this.deps.refreshMutex.run(() => this.performRefresh());
  }

  private async performRefresh(): Promise<UserTokenContext> {
    const requestId = this.newRequestId();
    const current = this.deps.getTokens();

    let response: Response;
    try {
      response = await fetch(this.deps.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: this.deps.clientId,
          client_secret: this.deps.clientSecret,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A network failure or timeout reaching the token endpoint says nothing
      // about the grant. Surface it as a temporary upstream error; telling the
      // user to reconnect over a blip would burn a working refresh token's
      // grant for no reason.
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Token refresh request failed', { requestId, error: message });
      throw this.transformError({
        headers: {},
        requestId,
        code: this.isTimeout(error) ? 'ECONNABORTED' : undefined,
      });
    }

    if (!response.ok) {
      const body = await this.safeJson(response);
      const oauthError =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>).error
          : undefined;

      logger.error('Token refresh rejected', { requestId, status: response.status, oauthError });

      // A 400/401 (invalid_grant) means the refresh token is spent or the
      // grant was revoked: no retry can recover it, only re-consent. Anything
      // else (a 5xx from the token endpoint, a 429) is Help Scout misbehaving,
      // not a dead grant, and must not tell the user to reconnect.
      if (response.status === 400 || response.status === 401) {
        throw new ReauthRequiredError(
          'Your Help Scout session has expired or was revoked. Please reconnect the Help Scout connector to continue.',
          requestId,
        );
      }
      throw this.transformError({
        status: response.status,
        headers: headersToObject(response.headers),
        data: body,
        requestId,
      });
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const rotated: UserTokenContext = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    // Persist the rotated pair atomically (both tokens + expiry together) before
    // any request uses it, so a crash never leaves a spent refresh token stored.
    await this.deps.persistTokens(rotated);

    logger.info('Refreshed Help Scout access token', { requestId });

    return rotated;
  }

  /** Issue a single GET, injecting the current per-user bearer token. */
  private async sendGet(
    endpoint: string,
    params?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Response> {
    await this.maybeProactiveRefresh();

    const tokens = this.deps.getTokens();
    return fetch(this.buildUrl(endpoint, params), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  // --- Read path with retry --------------------------------------------------

  /**
   * Run a GET with the read retry policy: retry on a network throw, an
   * AbortController timeout, a 5xx, or a 429; refresh-then-retry-once on a 401.
   * Returns the raw `Response` so the caller decodes the body (JSON, text, or
   * bytes). Non-retryable failures and exhausted retries throw a transformed
   * `ApiError`.
   */
  private async executeWithRetry(
    endpoint: string,
    params?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const requestId = this.newRequestId();
    let refreshedOn401 = false;
    let lastError: ErrorContext | undefined;

    for (let attempt = 0; attempt <= this.retryConfig.retries; attempt++) {
      let response: Response;

      try {
        response = await this.sendGet(endpoint, params, headers);
      } catch (error) {
        // A refresh that failed with invalid_grant must surface as re-consent,
        // not be swallowed as a retryable network blip.
        if (error instanceof ReauthRequiredError) {
          throw error;
        }

        const timedOut = this.isTimeout(error);
        lastError = {
          headers: {},
          requestId,
          code: timedOut ? 'ECONNABORTED' : undefined,
        };

        logger.warn('Request failed, retrying', {
          attempt: attempt + 1,
          totalAttempts: this.retryConfig.retries + 1,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });

        if (attempt === this.retryConfig.retries) break;
        await this.sleep(
          this.calculateRetryDelay(attempt, this.retryConfig.retryDelay, this.retryConfig.maxRetryDelay),
        );
        continue;
      }

      if (response.ok) {
        return response;
      }

      const status = response.status;

      // Reactive refresh: a single 401 refreshes the token and retries once.
      // A second 401 (token still rejected) is a real auth failure. The retry
      // does not consume a read attempt: a 401 on the final attempt must still
      // get the retry the refresh exists for, and the refreshedOn401 guard
      // keeps this from looping.
      if (status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        logger.warn('Authentication failed, refreshing token before retry', { attempt: attempt + 1, requestId });
        await this.refresh(); // throws ReauthRequiredError on invalid_grant
        attempt--;
        continue;
      }

      const responseHeaders = headersToObject(response.headers);
      lastError = {
        status,
        headers: responseHeaders,
        data: await this.safeJson(response),
        requestId,
      };

      if (attempt === this.retryConfig.retries) break;
      if (!this.isRetryableStatus(status)) break;

      if (status === 429) {
        const delay = this.compute429Delay(responseHeaders, attempt);
        logger.warn('Rate limit hit, waiting before retry', { attempt: attempt + 1, retryAfter: delay, requestId });
        await this.sleep(delay);
      } else {
        const delay = this.calculateRetryDelay(
          attempt,
          this.retryConfig.retryDelay,
          this.retryConfig.maxRetryDelay,
        );
        logger.warn('Request failed, retrying', {
          attempt: attempt + 1,
          totalAttempts: this.retryConfig.retries + 1,
          delay,
          status,
          requestId,
        });
        await this.sleep(delay);
      }
    }

    if (lastError) {
      throw this.transformError(lastError);
    }
    throw new Error('Request failed without error details');
  }

  private isTimeout(error: unknown): boolean {
    // AbortSignal.timeout aborts with a TimeoutError; a manual abort throws
    // AbortError. Treat both as a retryable timeout for reads.
    return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  /**
   * Adaptive 429 wait, in priority order: the account-scoped
   * `X-RateLimit-Retry-After`, then the standard `Retry-After`, then exponential
   * backoff. Never a hardcoded limit — the account bucket is shared and only the
   * headers know the true window.
   */
  private compute429Delay(headers: Record<string, string>, attempt: number): number {
    const rateLimitRetryAfter = headers['x-ratelimit-retry-after'];
    if (rateLimitRetryAfter !== undefined) {
      return this.parseRetryAfterMs(rateLimitRetryAfter);
    }
    const retryAfter = headers['retry-after'];
    if (retryAfter !== undefined) {
      return this.parseRetryAfterMs(retryAfter);
    }
    return this.calculateRetryDelay(attempt, this.retryConfig.retryDelay, this.retryConfig.maxRetryDelay);
  }

  private async safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  private transformError(context: ErrorContext): ApiError {
    const { requestId, status, headers } = context;

    logger.error('API request failed', { requestId, status });

    if (status === 401) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Help Scout authentication failed. Your session may have expired.',
        details: {
          requestId,
          suggestion: 'Reconnect the Help Scout connector to re-authorize access.',
        },
      };
    }

    if (status === 403) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Access forbidden. Insufficient permissions for this Help Scout resource.',
        details: {
          requestId,
          suggestion: 'Check whether your Help Scout account has access to this mailbox or resource',
        },
      };
    }

    if (status === 404) {
      return {
        code: 'NOT_FOUND',
        message: 'Help Scout resource not found. The requested conversation, mailbox, or thread does not exist.',
        details: {
          requestId,
          suggestion: 'Verify the ID is correct and the resource exists',
        },
      };
    }

    if (status === 429) {
      const headerValue = headers['x-ratelimit-retry-after'] ?? headers['retry-after'];
      const retryAfter = Math.ceil(this.parseRetryAfterMs(headerValue) / 1000);
      return {
        code: 'RATE_LIMIT',
        message: `Help Scout API rate limit exceeded. Please wait ${retryAfter} seconds before retrying.`,
        retryAfter,
        details: {
          requestId,
          suggestion: 'Reduce request frequency or implement request batching',
        },
      };
    }

    if (status === 422) {
      const responseData = (context.data as Record<string, unknown>) || {};
      return {
        code: 'INVALID_INPUT',
        message: `Help Scout API validation error: ${responseData.message || 'Invalid request data'}`,
        details: {
          requestId,
          validationErrors: responseData.errors || responseData,
          suggestion: 'Check the request parameters match Help Scout API requirements',
        },
      };
    }

    if (status && status >= 400 && status < 500) {
      const responseData = (context.data as Record<string, unknown>) || {};
      return {
        code: 'INVALID_INPUT',
        message: `Help Scout API client error: ${responseData.message || 'Invalid request'}`,
        details: {
          requestId,
          statusCode: status,
          apiResponse: responseData,
        },
      };
    }

    if (context.code === 'ECONNABORTED') {
      return {
        code: 'UPSTREAM_ERROR',
        message: 'Help Scout API request timed out. The service may be experiencing high load.',
        details: {
          requestId,
          errorCode: context.code,
          suggestion: 'Request will be automatically retried with exponential backoff',
        },
      };
    }

    if (status && status >= 500) {
      return {
        code: 'UPSTREAM_ERROR',
        message: `Help Scout API server error (${status}). The service is temporarily unavailable.`,
        details: {
          requestId,
          statusCode: status,
          suggestion: 'Request will be automatically retried with exponential backoff',
        },
      };
    }

    return {
      code: 'UPSTREAM_ERROR',
      message: 'Help Scout API error: Unknown upstream service error',
      details: {
        requestId,
        errorCode: context.code,
        suggestion: 'Check your network connection and Help Scout service status',
      },
    };
  }

  // --- HelpScoutApi: reads ---------------------------------------------------

  async get<T>(
    endpoint: string,
    params?: Record<string, unknown>,
    // Accepted for interface parity with the axios client and ignored: the
    // Workers build has no shared cache to read or write (a process-wide cache
    // would leak one user's data to the next request).
    _cacheOptions?: { ttl?: number },
  ): Promise<T> {
    const response = await this.executeWithRetry(endpoint, params);
    return (await response.json()) as T;
  }

  /**
   * Fetch successive pages of a v2 list endpoint and accumulate the embedded
   * collection. The Mailbox v2 API has NO `size`/`pageSize` parameter — page
   * size is fixed (25 for conversations/threads, 50 elsewhere) and any `size`
   * is silently ignored — so callers that need more than one page must loop.
   *
   * Stops at `maxItems`, at the last page (`page.totalPages`), or when a page
   * returns no items. Safe when the endpoint returns no `page` block (e.g. a
   * cursor-based or bare-array response): `totalPages` defaults to 1, so only
   * the first page is fetched and no over-fetch/infinite loop can occur.
   */
  async getAllPages<T>(
    endpoint: string,
    collectionKey: string,
    params: Record<string, unknown> = {},
    maxItems: number = Number.POSITIVE_INFINITY,
  ): Promise<{ items: T[]; totalElements: number; pagesFetched: number; truncated: boolean }> {
    const items: T[] = [];
    let pageNum = typeof params.page === 'number' && params.page > 0 ? params.page : 1;
    let totalElements = 0;
    let totalPages = 1;
    let pagesFetched = 0;

    do {
      const resp = await this.get<PaginatedResponse<T>>(endpoint, { ...params, page: pageNum });
      pagesFetched++;
      const batch = resp._embedded?.[collectionKey] ?? [];
      items.push(...batch);
      totalElements = resp.page?.totalElements ?? items.length;
      totalPages = resp.page?.totalPages ?? 1;
      if (batch.length === 0) break;
      pageNum++;
    } while (pageNum <= totalPages && items.length < maxItems);

    const capped = Number.isFinite(maxItems) && items.length > maxItems;
    return {
      items: capped ? items.slice(0, maxItems) : items,
      totalElements,
      pagesFetched,
      // truncated = there is more data than we are returning to the caller.
      truncated: capped || totalElements > items.length,
    };
  }

  async getRaw<T>(
    endpoint: string,
    params?: Record<string, unknown>,
    options: RawGetOptions = {},
  ): Promise<RawResponse<T>> {
    const response = await this.executeWithRetry(endpoint, params, options.headers);

    let data: unknown;
    switch (options.responseType) {
      case 'text':
        data = await response.text();
        break;
      case 'arraybuffer':
        data = await response.arrayBuffer();
        break;
      case 'json':
      default:
        data = await response.json();
        break;
    }

    return {
      status: response.status,
      data: data as T,
      headers: headersToObject(response.headers),
    };
  }

  // --- HelpScoutApi: writes --------------------------------------------------

  /**
   * Issue a non-idempotent request exactly once.
   *
   * This deliberately bypasses the read retry loop. Reads keep retrying 429 and
   * 5xx because a repeated GET costs nothing; a repeated POST is a second
   * customer email or a duplicate note, and a 5xx never proves the first attempt
   * failed. Backoff is the caller's decision, because only the caller can read
   * the target back and check whether the first attempt landed.
   *
   * A 401 surfaces as a HelpScoutWriteError rather than triggering a
   * refresh-and-retry: proactive refresh (run before the write) is what keeps a
   * write from meeting an expired token, so a 401 here is a genuine failure the
   * caller must handle. Every failure carries the upstream status.
   */
  private async writeRequest<T>(
    method: WriteMethod,
    endpoint: string,
    body?: unknown,
  ): Promise<WriteResponse<T>> {
    const requestId = this.newRequestId();

    // Refresh before the write if the token is near expiry. A refresh failure
    // (invalid_grant) surfaces as re-consent guidance and the write never fires,
    // which is safe: nothing was sent.
    await this.maybeProactiveRefresh();

    let response: Response;
    try {
      const tokens = this.deps.getTokens();
      response = await fetch(this.buildUrl(endpoint), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Write request failed', { requestId, method, endpoint, status: undefined });
      throw new HelpScoutWriteError(message, undefined, undefined, method, endpoint, requestId);
    }

    if (!response.ok) {
      const responseBody = await this.safeJson(response);
      logger.error('Write request failed', { requestId, method, endpoint, status: response.status });
      throw new HelpScoutWriteError(
        `Request failed with status ${response.status}`,
        response.status,
        responseBody,
        method,
        endpoint,
        requestId,
      );
    }

    return {
      status: response.status,
      data: await this.parseWriteBody<T>(response),
      headers: headersToObject(response.headers),
    };
  }

  /**
   * Decode a write response body. Mailbox v2 answers most mutations with
   * `204 No Content` (and sometimes an empty 200/201); in that case the body is
   * null and the created resource ID lives in the `Resource-Id` header instead.
   */
  private async parseWriteBody<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      return null as T;
    }
    const text = await response.text();
    if (text === '') {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** Single-attempt POST. See writeRequest for why writes are never retried. */
  async post<T = unknown>(endpoint: string, body?: unknown): Promise<WriteResponse<T>> {
    return this.writeRequest<T>('POST', endpoint, body);
  }

  /** Single-attempt PUT. See writeRequest for why writes are never retried. */
  async put<T = unknown>(endpoint: string, body?: unknown): Promise<WriteResponse<T>> {
    return this.writeRequest<T>('PUT', endpoint, body);
  }

  /** Single-attempt PATCH. See writeRequest for why writes are never retried. */
  async patch<T = unknown>(endpoint: string, body?: unknown): Promise<WriteResponse<T>> {
    return this.writeRequest<T>('PATCH', endpoint, body);
  }

  /** Single-attempt DELETE. See writeRequest for why writes are never retried. */
  async delete<T = unknown>(endpoint: string): Promise<WriteResponse<T>> {
    return this.writeRequest<T>('DELETE', endpoint);
  }
}
