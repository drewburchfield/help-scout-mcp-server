/**
 * Transport-neutral seam between the capability surface and the Help Scout
 * HTTP client.
 *
 * Tool, write, and resource handlers resolve their client through
 * `getClient()` instead of importing the axios-backed singleton, so a
 * request-scoped client (per-user OAuth in a remote deployment) can be swapped
 * in without touching any call site. The stdio server registers its single
 * app-wide client as the process default; a remote entry point wraps each
 * request in `withHelpScoutApi()` and the async context carries that user's
 * client for everything the request touches, including nested awaits.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Outcome of a non-idempotent request. Mailbox v2 answers most mutations with
 * `204 No Content`, so the status and headers carry more than the body does:
 * `Resource-Id` is the only place a newly created thread ID appears.
 */
export interface WriteResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/**
 * Failure of a non-idempotent request, carrying the upstream status so a write
 * handler can map it to model-correctable guidance.
 *
 * Writes deliberately do not reuse `transformError`: that path flattens 403 and
 * 404 into prose without a status code, and its suggestions promise automatic
 * retries that writes never perform.
 */
export class HelpScoutWriteError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: unknown,
    readonly method: WriteMethod,
    readonly path: string,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'HelpScoutWriteError';
  }
}

export interface PaginatedResponse<T> {
  _embedded: { [key: string]: T[] };
  _links?: {
    next?: { href: string };
    prev?: { href: string };
  };
  page?: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

export interface RawGetOptions {
  responseType?: 'json' | 'text' | 'arraybuffer';
  headers?: Record<string, string>;
}

/**
 * The subset of an HTTP response that raw-format handlers consume. The axios
 * client's responses satisfy this structurally; a fetch-backed client returns
 * it directly.
 */
export interface RawResponse<T> {
  status: number;
  data: T;
  headers: Record<string, unknown>;
}

export interface HelpScoutApi {
  get<T>(
    endpoint: string,
    params?: Record<string, unknown>,
    cacheOptions?: { ttl?: number },
  ): Promise<T>;
  getAllPages<T>(
    endpoint: string,
    collectionKey: string,
    params?: Record<string, unknown>,
    maxItems?: number,
  ): Promise<{ items: T[]; totalElements: number; pagesFetched: number; truncated: boolean }>;
  getRaw<T>(
    endpoint: string,
    params?: Record<string, unknown>,
    options?: RawGetOptions,
  ): Promise<RawResponse<T>>;
  post<T = unknown>(endpoint: string, body?: unknown): Promise<WriteResponse<T>>;
  put<T = unknown>(endpoint: string, body?: unknown): Promise<WriteResponse<T>>;
  patch<T = unknown>(endpoint: string, body?: unknown): Promise<WriteResponse<T>>;
  delete<T = unknown>(endpoint: string): Promise<WriteResponse<T>>;
}

const clientStorage = new AsyncLocalStorage<HelpScoutApi>();

let defaultClient: HelpScoutApi | undefined;

/**
 * Register the process-wide fallback client. The stdio server calls this once
 * at module load with its app-wide axios client, preserving today's behavior
 * exactly. A multi-user deployment must NOT rely on the default: it would
 * execute one user's request with another identity.
 */
export function setDefaultHelpScoutApi(client: HelpScoutApi): void {
  defaultClient = client;
}

/**
 * Run `fn` with `client` as the Help Scout client for the whole async call
 * tree, overriding the process default.
 */
export function withHelpScoutApi<T>(client: HelpScoutApi, fn: () => T): T {
  return clientStorage.run(client, fn);
}

/**
 * Resolve the Help Scout client for the current request context: the
 * async-local client when one is set, otherwise the process default.
 */
export function getClient(): HelpScoutApi {
  const client = clientStorage.getStore() ?? defaultClient;
  if (!client) {
    throw new Error(
      'No Help Scout client is configured. Register one with setDefaultHelpScoutApi() or wrap the request in withHelpScoutApi().',
    );
  }
  return client;
}
