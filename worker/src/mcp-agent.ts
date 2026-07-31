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
  type CallToolRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { GatewayHandler, WRITE_TOOL_NAME } from '../../src/tools/gateway.js';
import { toolHandler } from '../../src/tools/index.js';
import { writeHandler } from '../../src/tools/writes.js';
import { withHelpScoutApi } from '../../src/utils/api.js';
import { logger } from '../../src/utils/logger.js';
import {
  HelpScoutFetchClient,
  RefreshMutex,
  type UserTokenContext,
} from '../../src/worker/helpscout-fetch-client.js';
import {
  effectiveWriteFlags,
  evaluateAccess,
  type AdminConfig,
  type UserPolicy,
  type WriteFlagSet,
} from './policy.js';
import { getConfig, getUserPolicy } from './policy-store.js';

/** Kept in step with the stdio server identity in `src/index.ts`. */
const SERVER_NAME = 'helpscout-search';
const SERVER_VERSION = '2.1.0';

/**
 * The per-user grant, decrypted by workers-oauth-provider and re-injected as
 * `this.props` on every authorized `/mcp` request. The first three fields are
 * the Help Scout token pair the fetch client reads; the rest identify the user.
 * These are filled by the real Help Scout Authorization Code login in
 * help-scout-handler.ts and rotated durably via helpscout-oauth.ts.
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
  /**
   * The per-deployment access-policy coordinator DO (NAS-1501). Bound by name
   * POLICY_OBJECT in wrangler.jsonc; every policy read/write RPCs the single
   * instance so reads are strongly consistent and version writes are atomic CAS.
   */
  POLICY_OBJECT: DurableObjectNamespace;
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
   * Test-harness only, and its VALUE is a secret. When set to a non-empty string,
   * it (a) marks the deployment as test-mode, which is the ONLY thing that lets
   * the consent handler and fetch client tolerate an http loopback upstream, and
   * (b) mounts the internal policy-seeding route the smoke suite uses, but only
   * for a request that presents this exact value in the X-Test-Policy-Key header.
   * Never set in a real deployment: it both weakens the https guard and exposes an
   * unauthenticated policy-mutation surface to anyone who knows the key.
   */
  HELPSCOUT_TEST_POLICY_ROUTES?: string;
  /**
   * Optional. Docs API operations are part of the shared registry and stay
   * advertised; without this secret they fail at call time with a
   * credentials-missing error. The Docs client reads it from process.env
   * (populated from vars/secrets under nodejs_compat), so declaring it here
   * is for documentation and wrangler type generation.
   */
  HELPSCOUT_DOCS_API_KEY?: string;
}

/** A structured tool error result, matching the gateway's error envelope shape. */
function policyErrorResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

/** Access is denied (revoked, or not enabled under allowlist mode). */
function accessRevokedResult(): CallToolResult {
  return policyErrorResult({
    error: 'Your access to this Help Scout deployment is not enabled or was revoked.',
    code: 'ACCESS_REVOKED',
    hint: 'Disconnect the Help Scout connector. If you believe this is a mistake, contact the administrator of this deployment.',
  });
}

/** The deployment allows writes, but this user's policy withholds them. */
function writePermissionDeniedResult(): CallToolResult {
  return policyErrorResult({
    error: 'Your Help Scout access here does not include write operations. Nothing was sent to Help Scout.',
    code: 'PERMISSION_DENIED',
    hint: 'Write access is granted per user by the administrator of this deployment. Contact them to enable it for your account.',
  });
}

/** A write could not verify policy against the coordinator: fail closed without attempting the write. */
function policyUnavailableWriteResult(): CallToolResult {
  return policyErrorResult({
    error: 'Your access could not be verified right now, so this write was not attempted.',
    code: 'UPSTREAM_ERROR',
    hint: 'This is a temporary problem reaching the deployment policy store. Try again in a moment.',
  });
}

/** A read could not verify policy against the coordinator and no unexpired snapshot was available. */
function policyUnavailableReadResult(): CallToolResult {
  return policyErrorResult({
    error: 'Your access could not be verified right now.',
    code: 'TEMPORARY_ERROR',
    hint: 'This is a temporary problem reaching the deployment policy store. Try again in a moment.',
  });
}

export class HelpScoutMCP extends McpAgent<Env, unknown, HelpScoutProps> {
  // Constructed once, in init(): the instructions read the grant props, which
  // are only injected by the time init() runs. A field initializer here would
  // create a second Server the base class might capture; McpAgent connects the
  // transport only after init() resolves, so this single construction site is
  // the safe pattern.
  server!: Server;

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

  /**
   * Instance-scoped snapshot of the access policy for this session's user.
   *
   * Reads are served from this snapshot while it is unexpired, so a read call
   * costs no coordinator round trip inside the window — and that window IS the
   * revocation SLA: after allowed flips to false, reads keep working only until
   * the snapshot lapses, then the next read re-reads the coordinator and is
   * denied. Because the coordinator's reads are strongly consistent, that
   * re-read sees the deny with no eventual-consistency lag on top of the TTL. The
   * TTL comes from the config document (clamped 15-300s). Writes never read this
   * snapshot; they always re-read policy fresh (see dispatchWrite).
   */
  private policySnapshot?: { userId: string; config: AdminConfig; userPolicy: UserPolicy | null; expiresAtMs: number };

  async init(): Promise<void> {
    // Build the server with instructions that name the connected user, read
    // from the grant props. This is the confirmation that the grant carried a
    // real per-user identity through the Help Scout leg, surfaced to the client
    // in the initialize response without any Help Scout call.
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: this.buildInstructions() },
    );

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

    // Every dispatch runs through the policy gate, then constructs this user's
    // client and runs the whole async call tree under it via AsyncLocalStorage,
    // so the 40+ getClient() call sites resolve to the per-user, fetch-backed
    // client with no shared state.
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.dispatchToolCall(request);
    });
  }

  /**
   * The policy-enforced dispatch path for every tools/call.
   *
   * Access is checked on every call. A write additionally re-reads the policy
   * fresh (bypassing the read cache) and dispatches through a gateway configured
   * with the user's effective write flags, so a per-user write grant is enforced
   * at execution even though advertisement (tools/list) stays ceiling-only.
   */
  private async dispatchToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const isWrite = request.params.name === WRITE_TOOL_NAME;

    const gate = await this.checkAccess(isWrite);
    if (!gate.ok) return gate.result;

    if (isWrite) {
      return this.dispatchWrite(request, gate.userPolicy);
    }

    const client = this.buildClient();
    return withHelpScoutApi(client, () => this.gateway.callTool(request));
  }

  /**
   * Resolve the access decision for this call. Reads may serve from an unexpired
   * policy snapshot without touching the coordinator; writes force a fresh read.
   * On a coordinator failure the gate fails closed: a write returns an
   * upstream-error result and a read returns a temporary-error result (an
   * unexpired snapshot would already have been served above, so reaching the
   * coordinator read means there was nothing safe to serve).
   */
  private async checkAccess(
    forceFresh: boolean,
  ): Promise<
    | { ok: true; config: AdminConfig; userPolicy: UserPolicy | null }
    | { ok: false; result: CallToolResult }
  > {
    const userId = String(this.requireProps().userId);
    const now = Date.now();

    // The snapshot is only valid for the user it was read for. Sessions are
    // per-grant today, but if any routing change ever let a different grant's
    // props reach this instance, an identity mismatch must force a fresh read
    // rather than inherit another user's cached access decision.
    if (
      !forceFresh &&
      this.policySnapshot &&
      this.policySnapshot.userId === userId &&
      now < this.policySnapshot.expiresAtMs
    ) {
      return this.decideAccess(this.policySnapshot.config, this.policySnapshot.userPolicy);
    }

    let config: AdminConfig;
    let userPolicy: UserPolicy | null;
    try {
      config = await getConfig(this.env);
      userPolicy = await getUserPolicy(this.env, userId);
    } catch (error) {
      logger.error('Policy read failed at dispatch', {
        error: error instanceof Error ? error.message : String(error),
        forceFresh,
      });
      return {
        ok: false,
        result: forceFresh ? policyUnavailableWriteResult() : policyUnavailableReadResult(),
      };
    }

    this.policySnapshot = {
      userId,
      config,
      userPolicy,
      expiresAtMs: now + config.policyCacheTtlSeconds * 1000,
    };
    return this.decideAccess(config, userPolicy);
  }

  private decideAccess(
    config: AdminConfig,
    userPolicy: UserPolicy | null,
  ):
    | { ok: true; config: AdminConfig; userPolicy: UserPolicy | null }
    | { ok: false; result: CallToolResult } {
    const decision = evaluateAccess(config, userPolicy);
    if (!decision.allowed) {
      return { ok: false, result: accessRevokedResult() };
    }
    return { ok: true, config, userPolicy };
  }

  /**
   * Execute a write under the caller's effective write flags. `userPolicy` is
   * the freshly-read policy from checkAccess (writes never use the cache).
   *
   * When the deployment ceiling has writes off, behavior is identical to before
   * the policy layer: write_help_scout is not advertised, and a direct call
   * falls through to the gateway's unknown-tool path. When the deployment allows
   * writes but this user's policy withholds them, a structured permission error
   * is returned before any Help Scout request. Otherwise the write runs through a
   * gateway configured with the effective flags, which enforces the
   * customer-visible narrowing and the existing confirmation envelope.
   */
  private async dispatchWrite(request: CallToolRequest, userPolicy: UserPolicy | null): Promise<CallToolResult> {
    const ceiling: WriteFlagSet = {
      enabled: this.env.HELPSCOUT_ENABLE_WRITES === 'true',
      customerVisibleEnabled: this.env.HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES === 'true',
    };
    const effective = effectiveWriteFlags(ceiling, userPolicy);

    if (!ceiling.enabled) {
      const client = this.buildClient();
      return withHelpScoutApi(client, () => this.gateway.callTool(request));
    }

    if (!effective.enabled) {
      logger.warn('Write refused: user policy withholds write access', { userId: String(this.requireProps().userId) });
      return writePermissionDeniedResult();
    }

    const gateway = new GatewayHandler(toolHandler, {
      writes: writeHandler,
      writeFlags: effective,
    });
    const client = this.buildClient();
    return withHelpScoutApi(client, () => gateway.callTool(request));
  }

  /**
   * A one-line description of the connected Help Scout user, surfaced as the MCP
   * server instructions so the client can show who the session acts as. Reads
   * only the grant props; falls back cleanly if a session somehow lacks them.
   */
  private buildInstructions(): string {
    const base = 'Help Scout MCP gateway. Search, describe, and read (and, when enabled, write) Help Scout data.';
    const props = this.props;
    if (!props || !props.email) return base;
    // The name and email come from the Help Scout profile, which other account
    // admins can edit: flatten and cap them so profile text cannot smuggle
    // multi-line content into the server instructions the model reads.
    const name = String(props.name).replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    const email = String(props.email).replace(/[\s]+/g, '').slice(0, 120);
    return `${base} Connected to Help Scout as ${name} <${email}>.`;
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
      // Strict https unless the deployment is in test mode (the smoke's http
      // loopback mock). Production never sets the var, so this stays false.
      allowInsecureLoopback: Boolean(this.env.HELPSCOUT_TEST_POLICY_ROUTES),
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
        // In-session safety net for a Help Scout token that expires mid-session.
        // updateProps writes both this.props and DO storage, so the rest of this
        // instance's requests read the rotated pair. This is NOT the durable
        // path: on a cold wake, onStart re-injects the access token's props
        // snapshot over DO storage, so a rotation here does not reach the grant
        // or other instances. Durable, cross-instance rotation is the OAuth
        // shell's tokenExchangeCallback (see helpscout-oauth.ts); OUR token TTL
        // is aligned so that path fires ahead of this one in normal operation.
        const current = this.requireProps();
        await this.updateProps({
          ...current,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        });
      },
      refreshMutex: this.refreshMutex,
    });
  }
}
