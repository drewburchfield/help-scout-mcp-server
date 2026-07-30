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
 *   - defaultHandler: our consent surface at /authorize + /approve (T4 stub;
 *     T5 turns it into the real Help Scout Authorization Code client).
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

import { HelpScoutMCP } from './mcp-agent.js';
import { helpScoutHandler } from './help-scout-handler.js';
import type { Env } from './mcp-agent.js';

// The Durable Object class must be exported for the wrangler migration binding.
export { HelpScoutMCP };

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

  // TTL of the token WE issue to the MCP client (independent of the Help Scout
  // token). 30 days with library-managed refresh rotation, matching the
  // production reference server's contract.
  accessTokenTTL: 2592000,
});
