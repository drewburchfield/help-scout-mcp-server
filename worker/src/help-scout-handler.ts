/**
 * The OAuth shell's defaultHandler: the consent surface (Leg A, downstream) plus
 * the real Help Scout Authorization Code client (Leg B, upstream).
 *
 * Flow: GET /authorize renders a signed-cookie consent gate; POST /approve
 * redirects the browser to Help Scout's authorize URL bound to a single-use
 * `state`; GET /callback validates that state, exchanges the code for a per-user
 * Help Scout token pair, reads the user's identity, and completes the MCP
 * authorization with those real tokens in the encrypted grant props.
 *
 * SETUP CAVEAT (load-bearing): the Help Scout app's Redirection URL is fixed at
 * registration and must be the deployed worker's `https://.../callback`. An app
 * born with an `http://` redirect is permanently broken for the authorize flow
 * (Help Scout silently bounces it and editing the URL later does not heal it),
 * so the worker must be reachable over https and the app registered with the
 * https callback from the start.
 */
import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';
import type { Env } from './mcp-agent.js';
import {
  CONSENT_TTL_MS,
  CONSENT_COOKIE_NAME,
  buildConsentClearCookie,
  buildConsentSetCookie,
  readCookie,
  signConsentCookie,
  verifyConsentCookie,
  type ConsentTransaction,
} from './oauth-cookie.js';

/** KV key prefix for the single-use consent-state marker (namespaced away from library keys). */
const STATE_MARKER_PREFIX = 'hsmcp_txn:';
/** Marker TTL matches the cookie TTL. KV enforces a 60s floor; 600 is safe. */
const STATE_MARKER_TTL_S = Math.floor(CONSENT_TTL_MS / 1000);

/** HTML-escape untrusted values before echoing them into a page. */
function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function firstResource(resource: AuthRequest['resource']): string {
  if (Array.isArray(resource)) return resource[0] ?? '';
  return resource ?? '';
}

/** A random, URL-safe nonce used as the Help Scout `state` and single-use key. */
function newState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Join base URL + path the way the fetch client does, tolerating a trailing slash on the base. */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Both binding checks the NAS-1492 review makes mandatory: the clientId must
 * still resolve to a registered client AND the redirect URI must be one that
 * client registered. Run at approve AND callback so a crafted request cannot
 * complete a grant for an arbitrary client/redirect pair. Returns the client on
 * success, or null when either check fails.
 */
async function validateClientBinding(
  env: Env,
  oauthReq: AuthRequest,
): Promise<ClientInfo | null> {
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return null;
  if (!client.redirectUris?.includes(oauthReq.redirectUri)) return null;
  return client;
}

function htmlResponse(body: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders },
  });
}

function page(title: string, heading: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f3ee;color:#1f2528;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fffdfa;border:1px solid #d8d1c7;border-radius:12px;padding:28px;width:360px;box-shadow:0 18px 45px rgba(55,47,38,.1)}
h1{font-size:18px;margin:0 0 8px}p{color:#667174;font-size:13px;margin:0 0 16px;line-height:1.5}
button{width:100%;padding:10px;background:#5b8cff;color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer}</style></head>
<body><div class="card"><h1>${esc(heading)}</h1>${bodyHtml}</div></body></html>`;
}

/**
 * GET /authorize — render the MCP consent gate.
 *
 * Validates the client binding, then stores the whole parsed AuthRequest in a
 * signed HTTP-only cookie (no plaintext round-trip) and shows an explicit
 * approve button. The form posts to /approve.
 */
async function renderConsent(request: Request, env: Env): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await validateClientBinding(env, oauthReq);
  if (!client) {
    return htmlResponse(
      page('Authorize Help Scout', 'Unknown client', '<p>This connection request could not be verified. Reconnect the connector and try again.</p>'),
      400,
    );
  }

  const txn: ConsentTransaction = { oauthReq, exp: Date.now() + CONSENT_TTL_MS };
  const cookie = await signConsentCookie(txn, env.COOKIE_ENCRYPTION_KEY ?? '');
  const clientLabel = client.clientName ? esc(client.clientName) : esc(oauthReq.clientId);

  const body = `<p>Connect <strong>${clientLabel}</strong> to Help Scout. You will sign in to Help Scout, and this connection will act with your own Help Scout access.</p>
<form method="POST" action="/approve"><button type="submit" name="approve" value="true">Continue to Help Scout</button></form>`;

  return htmlResponse(page('Authorize Help Scout', 'Authorize Help Scout', body), 200, {
    'Set-Cookie': buildConsentSetCookie(cookie),
  });
}

/**
 * POST /approve — mint the single-use state, then redirect to Help Scout.
 *
 * Rebuilds the AuthRequest from the signed cookie (a missing or tampered cookie
 * is a 400), re-validates the client binding, records the state as single-use in
 * KV, and re-signs the cookie with the state bound in. The browser is sent to
 * Help Scout's authorize URL carrying only our client id and that state.
 */
async function handleApprove(request: Request, env: Env): Promise<Response> {
  const cookieValue = readCookie(request, CONSENT_COOKIE_NAME);
  const txn = await verifyConsentCookie(cookieValue, env.COOKIE_ENCRYPTION_KEY ?? '');
  if (!txn) {
    return htmlResponse(
      page('Authorize Help Scout', 'Session expired', '<p>This authorization session is missing or expired. Reconnect the connector to try again.</p>'),
      400,
    );
  }

  const client = await validateClientBinding(env, txn.oauthReq);
  if (!client) {
    return htmlResponse(
      page('Authorize Help Scout', 'Unknown client', '<p>This connection request could not be verified.</p>'),
      400,
    );
  }

  const state = newState();
  // Mark the state single-use before sending the browser upstream. Consumed
  // (get-then-delete) at /callback so a replayed callback finds nothing.
  await env.OAUTH_KV.put(`${STATE_MARKER_PREFIX}${state}`, '1', { expirationTtl: STATE_MARKER_TTL_S });

  const boundTxn: ConsentTransaction = { oauthReq: txn.oauthReq, state, exp: Date.now() + CONSENT_TTL_MS };
  const cookie = await signConsentCookie(boundTxn, env.COOKIE_ENCRYPTION_KEY ?? '');

  const authorizeUrl = new URL(env.HELPSCOUT_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', env.HELPSCOUT_CLIENT_ID);
  authorizeUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl.toString(), 'Set-Cookie': buildConsentSetCookie(cookie) },
  });
}

interface HelpScoutTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

interface HelpScoutUser {
  id?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
}

/**
 * GET /callback — the Help Scout redirect target.
 *
 * Validates the state against both the signed cookie and the single-use KV
 * marker, exchanges the code for a per-user token pair, reads the user's
 * identity (403 => a Light User without Mailbox access, shown a seat-required
 * page and NO grant), then completes the MCP authorization with the real tokens.
 */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const cookieValue = readCookie(request, CONSENT_COOKIE_NAME);
  const txn = await verifyConsentCookie(cookieValue, env.COOKIE_ENCRYPTION_KEY ?? '');

  // The cookie must verify, carry the same state Help Scout echoed back, and the
  // request must actually carry a code and state. Any mismatch is a hard reject:
  // this is the confused-deputy / CSRF boundary.
  if (!txn || !state || !code || txn.state !== state) {
    return htmlResponse(
      page('Authorize Help Scout', 'Could not verify this sign-in', '<p>The Help Scout sign-in could not be verified. Reconnect the connector and try again.</p>'),
      400,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }

  // Consume the single-use marker. A replayed callback (state already spent, or
  // expired) finds nothing and is rejected before any code is exchanged.
  const markerKey = `${STATE_MARKER_PREFIX}${state}`;
  const marker = await env.OAUTH_KV.get(markerKey);
  if (marker === null) {
    return htmlResponse(
      page('Authorize Help Scout', 'This sign-in link was already used', '<p>This Help Scout sign-in link has expired or was already used. Reconnect the connector to start again.</p>'),
      400,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }
  await env.OAUTH_KV.delete(markerKey);

  const client = await validateClientBinding(env, txn.oauthReq);
  if (!client) {
    return htmlResponse(
      page('Authorize Help Scout', 'Unknown client', '<p>This connection request could not be verified.</p>'),
      400,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }

  // --- Exchange the code for a per-user Help Scout token pair, server-side. ---
  let tokenData: HelpScoutTokenResponse;
  try {
    const tokenRes = await fetch(env.HELPSCOUT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: env.HELPSCOUT_CLIENT_ID,
        client_secret: env.HELPSCOUT_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!tokenRes.ok) {
      return htmlResponse(
        page('Authorize Help Scout', 'Help Scout sign-in failed', '<p>Help Scout could not complete the sign-in. Reconnect the connector and try again. If this persists, the deployment credentials may need attention.</p>'),
        502,
        { 'Set-Cookie': buildConsentClearCookie() },
      );
    }
    tokenData = (await tokenRes.json()) as HelpScoutTokenResponse;
  } catch {
    return htmlResponse(
      page('Authorize Help Scout', 'Help Scout is unreachable', '<p>Could not reach Help Scout to complete the sign-in. Try again in a moment.</p>'),
      502,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  if (typeof accessToken !== 'string' || accessToken === '' || typeof refreshToken !== 'string' || refreshToken === '') {
    return htmlResponse(
      page('Authorize Help Scout', 'Help Scout sign-in failed', '<p>Help Scout returned an unexpected response. Reconnect the connector and try again.</p>'),
      502,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }
  const expiresIn = tokenData.expires_in;
  const expiresAt = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : 0;

  // --- Identity. A 403 here means a Light User (no Mailbox API access). ---
  let user: HelpScoutUser;
  try {
    const meRes = await fetch(joinUrl(env.HELPSCOUT_BASE_URL, 'users/me'), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (meRes.status === 403) {
      return htmlResponse(
        page(
          'Help Scout access required',
          'A full Help Scout User seat is required',
          '<p>Your Help Scout account is a Light User, which cannot access the Mailbox API. Ask a Help Scout administrator to grant you a full User seat, then reconnect the connector.</p>',
        ),
        403,
        { 'Set-Cookie': buildConsentClearCookie() },
      );
    }
    if (!meRes.ok) {
      return htmlResponse(
        page('Authorize Help Scout', 'Could not read your Help Scout profile', '<p>Help Scout accepted the sign-in but the profile lookup failed. Try again in a moment.</p>'),
        502,
        { 'Set-Cookie': buildConsentClearCookie() },
      );
    }
    user = (await meRes.json()) as HelpScoutUser;
  } catch {
    return htmlResponse(
      page('Authorize Help Scout', 'Help Scout is unreachable', '<p>Could not reach Help Scout to read your profile. Try again in a moment.</p>'),
      502,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }

  const userId = typeof user.id === 'number' ? user.id : Number(user.id) || 0;
  const email = typeof user.email === 'string' ? user.email : '';
  const name =
    [user.firstName, user.lastName]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ') ||
    email ||
    `Help Scout user ${userId}`;

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: txn.oauthReq,
    userId: String(userId),
    metadata: { label: name },
    scope: txn.oauthReq.scope,
    props: { accessToken, refreshToken, expiresAt, userId, name, email },
  });

  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo, 'Set-Cookie': buildConsentClearCookie() },
  });
}

/**
 * The defaultHandler the OAuth shell delegates to. Metadata, /token, and
 * /register are the library's; /authorize, /approve, and /callback are ours.
 */
export const helpScoutHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Refuse to run the consent flow with a missing signing key: an empty-key
    // HMAC would still "verify", silently weakening the confused-deputy
    // boundary instead of surfacing the deployment mistake.
    if (!env.COOKIE_ENCRYPTION_KEY) {
      return htmlResponse(
        page('Authorize Help Scout', 'Deployment misconfigured', '<p>This server is missing its COOKIE_ENCRYPTION_KEY secret. Ask whoever operates it to set one with <code>wrangler secret put COOKIE_ENCRYPTION_KEY</code>.</p>'),
        500,
      );
    }

    if (url.pathname === '/authorize' && request.method === 'GET') {
      return renderConsent(request, env);
    }
    if (url.pathname === '/approve' && request.method === 'POST') {
      return handleApprove(request, env);
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      return handleCallback(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};
