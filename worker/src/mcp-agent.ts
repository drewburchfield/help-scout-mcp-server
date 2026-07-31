/**
 * The Help Scout MCP gateway as a Cloudflare Durable Object (McpAgent).
 *
 * This is the T4 apiHandler behind the OAuth shell. It reuses the EXACT shared
 * tool surface the stdio server uses — GatewayHandler over ToolHandler and
 * WriteHandler — across the T1 request-scoped client seam. The only Worker-
 * specific plumbing is:
 *   1. constructing a per-user HelpScoutFetchClient from the grant props
 *      (`this.props`) and wrapping every dispatch in `withHelpScoutApi()`, so
 *      each request runs as THAT user with no shared client and no shared cache;
 *   2. a per-instance RefreshMutex that serializes Help Scout token refresh.
 *
 * Registration mirrors the stdio server (`src/index.ts`): a low-level MCP
 * `Server` with ListTools/CallTool request handlers delegating to the same
 * `GatewayHandler`. Nothing about the capability surface is re-implemented here.
 */
import { McpAgent } from 'agents/mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { GatewayHandler } from '../../src/tools/gateway.js';
import { toolHandler } from '../../src/tools/index.js';
import { writeHandler } from '../../src/tools/writes.js';
import { withHelpScoutApi } from '../../src/utils/api.js';
import {
  HelpScoutFetchClient,
  RefreshMutex,
  type UserTokenContext,
} from '../../src/worker/helpscout-fetch-client.js';

/** Kept in step with the stdio server identity in `src/index.ts`. */
const SERVER_NAME = 'helpscout-search';
const SERVER_VERSION = '2.1.0';

/**
 * The per-user grant, decrypted by workers-oauth-provider and re-injected as
 * `this.props` on every authorized `/mcp` request. The first three fields are
 * the Help Scout token pair the fetch client reads; the rest identify the user.
 *
 * For T4 the OAuth leg is stubbed (see help-scout-handler.ts), so these arrive
 * as stub values; T5 fills them with a real Help Scout Authorization Code login.
 */
export interface HelpScoutProps extends Record<string, unknown> {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms; 0 means unknown and forces a refresh before first use. */
  expiresAt: number;
  userId: number;
  name: string;
  email: string;
}

/**
 * Worker bindings. Secrets (`HELPSCOUT_CLIENT_ID`/`_SECRET`, `COOKIE_ENCRYPTION_KEY`)
 * arrive via `wrangler secret` / `.dev.vars`; the rest are plain vars in
 * wrangler.jsonc. `OAUTH_PROVIDER` is injected by the OAuth shell.
 */
export interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  HELPSCOUT_BASE_URL: string;
  HELPSCOUT_TOKEN_URL: string;
  HELPSCOUT_AUTHORIZE_URL: string;
  HELPSCOUT_CLIENT_ID: string;
  HELPSCOUT_CLIENT_SECRET: string;
  HELPSCOUT_ENABLE_WRITES?: string;
  HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  /**
   * Optional. Docs API operations are part of the shared registry and stay
   * advertised; without this secret they fail at call time with a
   * credentials-missing error. The Docs client reads it from process.env
   * (populated from vars/secrets under nodejs_compat), so declaring it here
   * is for documentation and wrangler type generation.
   */
  HELPSCOUT_DOCS_API_KEY?: string;
}

export class HelpScoutMCP extends McpAgent<Env, unknown, HelpScoutProps> {
  server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  /**
   * Serializes Help Scout token refresh for THIS Durable Object instance so
   * concurrent 401s spend the rotating refresh token exactly once. This is
   * per-instance only: a user with two live sessions is two instances with two
   * mutexes. Account-wide serialization (a per-user DO keyed on userId, or a KV
   * compare-and-swap) is a known open decision on NAS-1491 and is intentionally
   * NOT implemented here — in-instance is the T4 scope.
   */
  private readonly refreshMutex = new RefreshMutex();

  private gateway!: GatewayHandler;

  async init(): Promise<void> {
    // Same registry the stdio server builds, gated by the deployment's write
    // env vars. Passed explicitly rather than read from process.env so the
    // advertised surface is deterministic under workerd (where process.env
    // population depends on the compatibility date).
    this.gateway = new GatewayHandler(toolHandler, {
      writes: writeHandler,
      writeFlags: {
        enabled: this.env.HELPSCOUT_ENABLE_WRITES === 'true',
        customerVisibleEnabled: this.env.HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES === 'true',
      },
    });

    // Discovery needs no client (the registry is pure).
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.gateway.listTools(),
    }));

    // Every dispatch constructs this user's client and runs the whole async
    // call tree under it via AsyncLocalStorage, so the 40+ getClient() call
    // sites resolve to the per-user, fetch-backed client with no shared state.
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const client = this.buildClient();
      return withHelpScoutApi(client, () => this.gateway.callTool(request));
    });
  }

  /** The grant props must be present on an authorized request; guard for TS and clarity. */
  private requireProps(): HelpScoutProps {
    if (!this.props) {
      throw new Error(
        'Help Scout MCP session is missing its OAuth grant. Reconnect the connector to re-authorize.',
      );
    }
    return this.props;
  }

  private buildClient(): HelpScoutFetchClient {
    return new HelpScoutFetchClient({
      baseUrl: this.env.HELPSCOUT_BASE_URL,
      tokenUrl: this.env.HELPSCOUT_TOKEN_URL,
      clientId: this.env.HELPSCOUT_CLIENT_ID,
      clientSecret: this.env.HELPSCOUT_CLIENT_SECRET,
      // Read tokens fresh each request so a mid-request rotation is seen next time.
      getTokens: (): UserTokenContext => {
        const props = this.requireProps();
        return {
          accessToken: props.accessToken,
          refreshToken: props.refreshToken,
          expiresAt: props.expiresAt,
        };
      },
      persistTokens: async (tokens: UserTokenContext): Promise<void> => {
        // T5 SEAM — in-memory only. Update the live props so the next
        // getTokens() and every later request on THIS instance reads the
        // rotated pair. It does NOT re-encrypt the OAuth grant props that
        // workers-oauth-provider re-injects on the next cold request, so a
        // rotation does not yet survive instance eviction or a second session.
        // Making rotation durable across instances is T5's job (open question
        // on NAS-1491: whether mutating props persists). `this.updateProps(...)`
        // would additionally write to DO storage and is the hook to build on.
        const current = this.requireProps();
        this.props = {
          ...current,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        };
      },
      refreshMutex: this.refreshMutex,
    });
  }
}
