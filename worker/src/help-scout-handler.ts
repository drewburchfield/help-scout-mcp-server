/**
 * The OAuth shell's defaultHandler: the downstream (Leg A) consent surface.
 *
 * T4 SCOPE — STUB UPSTREAM. This renders a minimal consent page and, on
 * approval, completes the authorization with STUB Help Scout props. The real
 * Help Scout Authorization Code leg (Leg B) is T5: on approval T5 will instead
 * redirect the user to `HELPSCOUT_AUTHORIZE_URL`, handle the `/callback`, and
 * exchange the code for a real token pair before calling completeAuthorization.
 *
 * The structure is deliberately shaped for that swap: `renderConsent` is the
 * only place a redirect-to-Help-Scout is introduced, and `handleApprove` is the
 * only place `completeAuthorization` is called. T5 replaces the STUB_PROPS block
 * in `handleApprove` (and the plaintext `oauth_req` round-trip below with a
 * signed, CSRF-protected cookie) without touching the OAuth shell wiring.
 */
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from './mcp-agent.js';

/**
 * The stub grant the T4 consent flow issues. Shape matches HelpScoutProps.
 * `expiresAt: 0` marks the (stub) token expiry as unknown, which the fetch
 * client treats as "refresh before first use". T5 replaces this whole object
 * with the real per-user token pair and identity from the Help Scout callback.
 */
const STUB_PROPS = {
  accessToken: 'stub',
  refreshToken: 'stub',
  expiresAt: 0,
  userId: 0,
  name: 'Stub',
  email: 'stub@example.invalid',
} as const;

/** HTML-escape untrusted values before echoing them into the consent page. */
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

/**
 * Render the MCP consent gate. The form posts to `/approve`.
 *
 * The whole parsed AuthRequest is round-tripped as a single base64 hidden field
 * so `completeAuthorization` gets it back byte-for-byte (PKCE challenge and
 * RFC 8707 resource included). The individual hidden inputs below it mirror the
 * production reference's shape (client_id, redirect_uri, code_challenge, state,
 * scope, resource) and are display/parity only — `oauth_req` is load-bearing.
 *
 * T5 REPLACES this plaintext round-trip with a signed, short-lived cookie bound
 * to the pending authorization (the confused-deputy defense the MCP spec makes
 * a MUST for proxy servers), and adds the redirect to Help Scout.
 */
async function renderConsent(request: Request, env: Env): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) {
    return new Response('Unknown OAuth client.', { status: 400 });
  }

  const encoded = btoa(JSON.stringify(oauthReq));
  const clientLabel = client.clientName ? esc(client.clientName) : esc(oauthReq.clientId);
  const hidden = (name: string, value: unknown): string =>
    `<input type="hidden" name="${name}" value="${esc(value)}">`;

  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Authorize Help Scout MCP</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f3ee;color:#1f2528;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fffdfa;border:1px solid #d8d1c7;border-radius:12px;padding:28px;width:340px;box-shadow:0 18px 45px rgba(55,47,38,.1)}
h1{font-size:18px;margin:0 0 4px}p{color:#667174;font-size:13px;margin:0 0 18px}
button{width:100%;padding:10px;background:#5b8cff;color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer}</style></head>
<body><form method="POST" action="/approve">
<h1>Authorize Help Scout MCP</h1>
<p>Connect <strong>${clientLabel}</strong> to Help Scout as your user. (T4 stub: no real Help Scout login yet.)</p>
${hidden('oauth_req', encoded)}
${hidden('client_id', oauthReq.clientId)}
${hidden('redirect_uri', oauthReq.redirectUri)}
${hidden('code_challenge', oauthReq.codeChallenge)}
${hidden('state', oauthReq.state)}
${hidden('scope', oauthReq.scope.join(' '))}
${hidden('resource', firstResource(oauthReq.resource))}
<button type="submit" name="approve" value="true">Authorize</button>
</form></body></html>`;

  return new Response(page, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Handle the consent submit: reconstruct the AuthRequest and complete the grant
 * with STUB props. T5 replaces STUB_PROPS with the real Help Scout token pair
 * obtained from the callback, and validates the signed consent cookie here.
 */
async function handleApprove(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const encoded = form.get('oauth_req');
  if (typeof encoded !== 'string' || encoded === '') {
    return new Response('Missing authorization request.', { status: 400 });
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(atob(encoded)) as AuthRequest;
  } catch {
    return new Response('Malformed authorization request.', { status: 400 });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: String(STUB_PROPS.userId),
    metadata: { label: STUB_PROPS.name },
    scope: oauthReq.scope,
    props: { ...STUB_PROPS },
  });

  return new Response(null, { status: 302, headers: { Location: redirectTo } });
}

/**
 * The defaultHandler the OAuth shell delegates to for everything it does not
 * handle itself (metadata, /token, /register, and the protected /mcp route are
 * the library's; /authorize and /approve are ours).
 */
export const helpScoutHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/authorize' && request.method === 'GET') {
      return renderConsent(request, env);
    }
    if (url.pathname === '/approve' && request.method === 'POST') {
      return handleApprove(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};
