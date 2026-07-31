/**
 * The OAuth shell's defaultHandler: the consent surface (Leg A, downstream) plus
 * the real Help Scout Authorization Code client (Leg B, upstream).
 *
 * Flow: GET /authorize renders a signed-cookie consent gate; POST /approve
 * redirects the browser to Help Scout's authorize URL bound to a cookie-signed
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
import { evaluateAccess, type AccessDecision } from './policy.js';
import { getConfig, getUserPolicy } from './policy-store.js';
import { recordAdmissionDenied, recordGrantCreated } from './audit-store.js';
import { handleTestPolicyRoute } from './test-policy-route.js';

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

/** A random, URL-safe nonce used as the Help Scout `state`. */
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
 * Codes, client secrets, and fresh bearer tokens flow to these URLs, so they
 * must be https, the same invariant the fetch client enforces.
 *
 * `allowLoopback` opens a narrow exception for the smoke harness's http mock
 * upstream, and ONLY the smoke turns it on: it is the deployment's test-mode
 * signal (Boolean(HELPSCOUT_TEST_POLICY_ROUTES)), which production never sets.
 * With it false, only https passes: a loopback http URL is rejected like any
 * other non-https URL, so a production deployment cannot be pointed at http.
 * The loopback allow-list is exact-match so `http://127.0.0.1.evil.com` (which
 * merely starts with 127.0.0.1) is rejected.
 */
function isSecureUpstreamUrl(value: string, allowLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (!allowLoopback) return false;
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1')
  );
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
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The consent surface carries an approval control; refuse all framing so
      // it cannot be overlaid in a clickjacking frame.
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      ...extraHeaders,
    },
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

  const txn: ConsentTransaction<AuthRequest> = { oauthReq, exp: Date.now() + CONSENT_TTL_MS };
  const cookie = await signConsentCookie(txn, env.COOKIE_ENCRYPTION_KEY ?? '');
  const clientLabel = client.clientName ? esc(client.clientName) : esc(oauthReq.clientId);

  const body = `<p>Connect <strong>${clientLabel}</strong> to Help Scout. You will sign in to Help Scout, and this connection will act with your own Help Scout access.</p>
<form method="POST" action="/approve"><button type="submit" name="approve" value="true">Continue to Help Scout</button></form>`;

  return htmlResponse(page('Authorize Help Scout', 'Authorize Help Scout', body), 200, {
    'Set-Cookie': buildConsentSetCookie(cookie),
  });
}

/**
 * POST /approve — mint the state nonce, then redirect to Help Scout.
 *
 * Rebuilds the AuthRequest from the signed cookie (a missing or tampered cookie
 * is a 400), re-validates the client binding, and re-signs the cookie with the
 * freshly minted state bound in. The browser is sent to
 * Help Scout's authorize URL carrying only our client id and that state.
 */
async function handleApprove(request: Request, env: Env): Promise<Response> {
  // Defense in depth on top of the SameSite=Lax cookie: a cross-origin POST
  // must not be able to advance the consent flow even if a cookie somehow rides
  // along, and the submit must carry the explicit approval field the consent
  // form posts.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return htmlResponse(
      page('Authorize Help Scout', 'Could not verify this request', '<p>This approval did not come from the consent page. Reconnect the connector to try again.</p>'),
      403,
    );
  }
  const form = await request.formData().catch(() => null);
  if (form?.get('approve') !== 'true') {
    return htmlResponse(
      page('Authorize Help Scout', 'Could not verify this request', '<p>This approval did not come from the consent page. Reconnect the connector to try again.</p>'),
      400,
    );
  }

  const cookieValue = readCookie(request, CONSENT_COOKIE_NAME);
  const txn = await verifyConsentCookie<AuthRequest>(cookieValue, env.COOKIE_ENCRYPTION_KEY ?? '');
  if (!txn) {
    return htmlResponse(
      page('Authorize Help Scout', 'Session expired', '<p>This authorization session is missing or expired. Reconnect the connector to try again.</p>'),
      400,
    );
  }

  // The browser is about to be sent to this URL; hold it to the same https
  // bar as the other upstream endpoints (loopback tolerated only in test mode).
  const allowLoopback = Boolean(env.HELPSCOUT_TEST_POLICY_ROUTES);
  if (!isSecureUpstreamUrl(env.HELPSCOUT_AUTHORIZE_URL, allowLoopback)) {
    return htmlResponse(
      page('Authorize Help Scout', 'Deployment misconfigured', '<p>This server is configured with a non-https Help Scout URL. Ask whoever operates it to fix HELPSCOUT_AUTHORIZE_URL.</p>'),
      500,
    );
  }

  const client = await validateClientBinding(env, txn.oauthReq);
  if (!client) {
    return htmlResponse(
      page('Authorize Help Scout', 'Unknown client', '<p>This connection request could not be verified.</p>'),
      400,
    );
  }

  // The state binds the Help Scout redirect to this browser's signed cookie;
  // single-use enforcement rides on the authorization code (see /callback).
  const state = newState();
  const boundTxn: ConsentTransaction<AuthRequest> = { oauthReq: txn.oauthReq, state, exp: Date.now() + CONSENT_TTL_MS };
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
 * Validates the state against the signed cookie, exchanges the code for a per-user token pair, reads the user's
 * identity (403 => a Light User without Mailbox access, shown a seat-required
 * page and NO grant), then completes the MCP authorization with the real tokens.
 */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const cookieValue = readCookie(request, CONSENT_COOKIE_NAME);
  const txn = await verifyConsentCookie<AuthRequest>(cookieValue, env.COOKIE_ENCRYPTION_KEY ?? '');

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

  // Replay protection deliberately does NOT use a KV marker here. KV only
  // guarantees read-after-write from the writing location, so a marker written
  // at /approve can be invisible to a legitimate /callback that lands in a
  // different colo (mobile handoff, egress rotation mid-login) — a valid
  // sign-in would be rejected. The authorization code itself is single-use at
  // Help Scout, so a replayed callback fails the exchange below; that is the
  // authoritative defense, and the signed cookie's state binding above is the
  // CSRF boundary.
  const client = await validateClientBinding(env, txn.oauthReq);
  if (!client) {
    return htmlResponse(
      page('Authorize Help Scout', 'Unknown client', '<p>This connection request could not be verified.</p>'),
      400,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }

  // Refuse to send the code, client secret, or a fresh bearer token anywhere
  // that is not https (loopback tolerated only in test mode for the mock).
  const allowLoopback = Boolean(env.HELPSCOUT_TEST_POLICY_ROUTES);
  if (
    !isSecureUpstreamUrl(env.HELPSCOUT_TOKEN_URL, allowLoopback) ||
    !isSecureUpstreamUrl(env.HELPSCOUT_BASE_URL, allowLoopback)
  ) {
    return htmlResponse(
      page('Authorize Help Scout', 'Deployment misconfigured', '<p>This server is configured with a non-https Help Scout URL. Ask whoever operates it to fix HELPSCOUT_TOKEN_URL / HELPSCOUT_BASE_URL.</p>'),
      500,
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
  // A missing lifetime is tolerated (0 = unknown = refresh before first use); a
  // present-but-nonsensical one is a malformed response we refuse to persist.
  const expiresIn = tokenData.expires_in;
  if (expiresIn !== undefined && (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)) {
    return htmlResponse(
      page('Authorize Help Scout', 'Help Scout sign-in failed', '<p>Help Scout returned an unexpected response. Reconnect the connector and try again.</p>'),
      502,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }
  const expiresAt = typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : 0;

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

  // The grant is keyed by this identity, so a malformed users/me response must
  // reject the authorization rather than collapse onto a shared user id.
  const userId = typeof user.id === 'number' ? user.id : Number(user.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return htmlResponse(
      page('Authorize Help Scout', 'Could not read your Help Scout profile', '<p>Help Scout returned a profile without a usable identity. Try again in a moment.</p>'),
      502,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }
  const email = typeof user.email === 'string' ? user.email : '';
  const name =
    [user.firstName, user.lastName]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ') ||
    email ||
    `Help Scout user ${userId}`;

  // --- Access policy gate (NAS-1501). Runs after identity, before the grant. ---
  // An explicit allowed:false blocks even in open mode; allowlist mode blocks any
  // user without an explicit allowed:true entry. The coordinator's reads are
  // strongly consistent, so a user blocked moments earlier is denied here with no
  // stale-colo admit. A coordinator failure fails closed: no grant is completed.
  // The consent cookie is cleared like every terminal path.
  let decision: AccessDecision;
  try {
    const [config, userPolicy] = await Promise.all([
      getConfig(env),
      getUserPolicy(env, userId),
    ]);
    decision = evaluateAccess(config, userPolicy);
  } catch {
    return htmlResponse(
      page(
        'Authorize Help Scout',
        'Access could not be verified',
        '<p>This deployment could not verify whether your account is enabled right now. Try again in a moment. If this persists, contact the administrator of this deployment.</p>',
      ),
      503,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }
  if (!decision.allowed) {
    // Observational audit row; best-effort, never fails the user-facing deny.
    await recordAdmissionDenied(env, { hsUserId: userId, email, reason: decision.reason });
    return htmlResponse(
      page(
        'Help Scout access not enabled',
        'Access is not enabled for your account',
        '<p>Your Help Scout account is not enabled to use this connection. Contact the administrator of this deployment to request access, then reconnect the connector.</p>',
      ),
      403,
      { 'Set-Cookie': buildConsentClearCookie() },
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: txn.oauthReq,
    userId: String(userId),
    metadata: { label: name },
    scope: txn.oauthReq.scope,
    props: { accessToken, refreshToken, expiresAt, userId, name, email },
  });

  // Observational audit row after the grant is minted; best-effort, off the path.
  await recordGrantCreated(env, { hsUserId: userId, email, clientId: txn.oauthReq.clientId });

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

    // Test-harness-only policy-seeding route. This can read and rewrite the whole
    // access-policy store with no OAuth, so it is gated by a SECRET, not a boolean:
    // HELPSCOUT_TEST_POLICY_ROUTES holds a random per-run key, and the request must
    // present that exact key in X-Test-Policy-Key. When the var is unset/empty, or
    // the header is missing or wrong, the route is completely invisible: it falls
    // through to the 404 below, never revealing that it exists (no 403). Production
    // never sets the var, so the route can never be reached there even if a caller
    // guesses the path. The smoke seeds config/policy and drives revokeUser through
    // it, and asserts a missing/wrong key 404s.
    const testPolicyKey = env.HELPSCOUT_TEST_POLICY_ROUTES;
    if (
      typeof testPolicyKey === 'string' &&
      testPolicyKey.length > 0 &&
      request.headers.get('X-Test-Policy-Key') === testPolicyKey &&
      url.pathname === '/__test__/policy' &&
      request.method === 'POST'
    ) {
      return handleTestPolicyRoute(request, env);
    }

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
