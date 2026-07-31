/**
 * Help Scout remote MCP server — Cloudflare Worker entry point (NAS-1491, T4).
 *
 * `@cloudflare/workers-oauth-provider` is the outer shell. To an MCP client
 * (claude.ai, Cowork, Desktop) this Worker IS an OAuth 2.1 authorization server
 * and an MCP resource server; the library serves the RFC 8414 / RFC 9728
 * metadata, Dynamic Client Registration, and the /token endpoint, issues its
 * OWN token to the client, and injects the matching grant's decrypted props
 * into the McpAgent on every authorized /mcp call.
 *
 * Two handlers do the work:
 *   - apiHandler: the McpAgent (Durable Object) serving the gateway at /mcp.
 *   - defaultHandler: our consent surface at /authorize + /approve + /callback,
 *     the real Help Scout Authorization Code client (help-scout-handler.ts).
 *   - tokenExchangeCallback: durable Help Scout refresh-token rotation on the
 *     client's refresh of OUR token (helpscout-oauth.ts).
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

import { HelpScoutMCP } from './mcp-agent.js';
import { PolicyCoordinator } from './policy-coordinator.js';
import { helpScoutHandler } from './help-scout-handler.js';
import { helpScoutTokenExchangeCallback } from './helpscout-oauth.js';
import type { Env } from './mcp-agent.js';

// Both Durable Object classes must be exported for their wrangler migration
// bindings: HelpScoutMCP (v1, the per-session MCP agent) and PolicyCoordinator
// (v2, the single per-deployment access-policy owner, NAS-1501).
export { HelpScoutMCP, PolicyCoordinator };

export default new OAuthProvider<Env>({
  // The protected MCP endpoint. Unauthenticated requests get 401 +
  // WWW-Authenticate pointing at the resource metadata (library-managed).
  apiRoute: '/mcp',
  apiHandler: HelpScoutMCP.serve('/mcp'),

  // Our consent surface. The library forwards /authorize (and anything else it
  // does not own, e.g. /approve) here.
  defaultHandler: helpScoutHandler,

  // Advertised in the RFC 8414 authorization-server metadata. /token and
  // /register are implemented by the library; /authorize routes to defaultHandler.
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',

  // Fallback TTL of the token WE issue to the MCP client, used only when the
  // Help Scout token expiry is unknown. Normally the tokenExchangeCallback below
  // overrides this per grant, aligning OUR token to expire ~5 minutes before the
  // Help Scout access token so the client's refresh of OUR token is the primary,
  // durable Help Scout rotation trigger.
  accessTokenTTL: 2592000,

  // The sanctioned durable-rotation hook. On the client's refresh of OUR token,
  // this refreshes the Help Scout pair upstream and returns newProps, which the
  // provider persists into the encrypted grant record in KV (survives Durable
  // Object eviction and reaches every session). See helpscout-oauth.ts.
  tokenExchangeCallback: helpScoutTokenExchangeCallback,
});
