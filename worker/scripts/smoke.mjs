// T4 smoke test against a running `wrangler dev`. Verifies the OAuth shell end
// to end with the stub upstream: discovery metadata, the 401 challenge, Dynamic
// Client Registration, the full auth-code + PKCE flow, and initialize +
// tools/list over Streamable HTTP advertising the three read tools.
//
// Usage: BASE=http://localhost:8787 node scripts/smoke.mjs
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://localhost:8787').replace(/\/$/, '');
const REDIRECT_URI = `${BASE}/callback`;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// --- Streamable HTTP body decode (SSE or JSON) -----------------------------
async function readRpc(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    // Concatenate the JSON payloads of `data:` lines; return the last object.
    const objs = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const payload = t.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try { objs.push(JSON.parse(payload)); } catch { /* ignore keepalives */ }
        }
      }
    }
    return objs[objs.length - 1];
  }
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function main() {
  console.log(`\nHelp Scout MCP worker smoke — ${BASE}\n`);

  // 1. Protected-resource metadata (RFC 9728)
  console.log('[1] discovery metadata');
  const prmRes = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  check('protected-resource metadata is 200', prmRes.status === 200, `status ${prmRes.status}`);
  const prm = await prmRes.json().catch(() => ({}));
  check('protected-resource has resource', typeof prm.resource === 'string', JSON.stringify(prm.resource));
  check(
    'protected-resource has authorization_servers',
    Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0,
  );
  const resource = prm.resource;

  // Authorization-server metadata (RFC 8414)
  const asRes = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  check('authorization-server metadata is 200', asRes.status === 200, `status ${asRes.status}`);
  const as = await asRes.json().catch(() => ({}));
  check('AS metadata has issuer', typeof as.issuer === 'string');
  check('AS metadata has authorization_endpoint', typeof as.authorization_endpoint === 'string');
  check('AS metadata has token_endpoint', typeof as.token_endpoint === 'string');
  check('AS metadata has registration_endpoint', typeof as.registration_endpoint === 'string');
  check(
    'AS metadata advertises S256 PKCE',
    Array.isArray(as.code_challenge_methods_supported) &&
      as.code_challenge_methods_supported.includes('S256'),
    JSON.stringify(as.code_challenge_methods_supported),
  );

  const authorizeUrl = as.authorization_endpoint || `${BASE}/authorize`;
  const tokenUrl = as.token_endpoint || `${BASE}/token`;
  const registerUrl = as.registration_endpoint || `${BASE}/register`;

  // 2. Unauthenticated /mcp -> 401 + WWW-Authenticate
  console.log('[2] unauthenticated /mcp challenge');
  const unauth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('unauthenticated POST /mcp is 401', unauth.status === 401, `status ${unauth.status}`);
  check(
    'unauthenticated /mcp sends WWW-Authenticate',
    typeof unauth.headers.get('www-authenticate') === 'string',
    unauth.headers.get('www-authenticate') || '(missing)',
  );

  // 3. Dynamic Client Registration
  console.log('[3] dynamic client registration');
  const regRes = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'T4 Smoke Client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  check('DCR is 200/201', regRes.status === 200 || regRes.status === 201, `status ${regRes.status}`);
  const reg = await regRes.json().catch(() => ({}));
  check('DCR returned client_id', typeof reg.client_id === 'string', JSON.stringify(reg.client_id));
  const clientId = reg.client_id;

  // 4. Auth-code + PKCE flow (stub consent auto-approve)
  console.log('[4] authorization-code + PKCE flow');
  const token = await runAuthFlow({ authorizeUrl, tokenUrl, clientId, resource });
  check('token exchange returned an access_token', typeof token === 'string' && token.length > 0);

  // 5. initialize + tools/list over Streamable HTTP
  console.log('[5] MCP initialize + tools/list');
  const initRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0.0.0' },
      },
    }),
  });
  check('authenticated initialize is 200', initRes.status === 200, `status ${initRes.status}`);
  const sessionId = initRes.headers.get('mcp-session-id') || initRes.headers.get('Mcp-Session-Id');
  const initBody = await readRpc(initRes);
  const protocolVersion = initBody?.result?.protocolVersion || '2025-06-18';
  check('initialize returned serverInfo', Boolean(initBody?.result?.serverInfo), JSON.stringify(initBody?.result));

  const mcpHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
  };
  if (sessionId) mcpHeaders['Mcp-Session-Id'] = sessionId;

  // notifications/initialized (fire-and-forget)
  await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {});

  const listRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  check('tools/list is 200', listRes.status === 200, `status ${listRes.status}`);
  const listBody = await readRpc(listRes);
  const tools = (listBody?.result?.tools || []).map((t) => t.name);
  console.log(`       advertised tools: ${tools.join(', ') || '(none)'}`);
  for (const name of ['search_help_scout', 'describe_help_scout', 'read_help_scout']) {
    check(`advertises ${name}`, tools.includes(name));
  }
  if (process.env.EXPECT_WRITES === '1') {
    check('write_help_scout advertised while writes enabled', tools.includes('write_help_scout'));
  } else {
    check('write_help_scout hidden while writes disabled', !tools.includes('write_help_scout'));
  }

  // 6. Consent-surface robustness: client-supplied unicode must not break the
  // consent page (the AuthRequest round-trip is TextEncoder-based, not bare
  // btoa), and a malformed round-trip blob must be a 400, not a 500.
  console.log('[6] consent-surface robustness');
  const uniReg = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'T4 Smoke ✓ 日本語 Client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const uniClientId = (await uniReg.json().catch(() => ({}))).client_id;
  check('DCR accepts a unicode client name', typeof uniClientId === 'string');
  if (uniClientId) {
    const uniToken = await runAuthFlow({
      authorizeUrl,
      tokenUrl,
      clientId: uniClientId,
      resource,
      stateOverride: 'smoke-✓-state-日本語',
    });
    check('auth flow survives unicode client name and state', typeof uniToken === 'string' && uniToken.length > 0);
  }
  const badApprove = await fetch(`${BASE}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_req: '!!not-valid-base64!!', approve: 'true' }).toString(),
  });
  check('malformed oauth_req is a 400, not a 500', badApprove.status === 400, `status ${badApprove.status}`);

  // 7. RFC 8707 resource binding on token exchange (soft — reference oracle #2)
  console.log('[7] resource-mismatch on token exchange (soft)');
  try {
    const mismatch = await runAuthFlow({
      authorizeUrl,
      tokenUrl,
      clientId,
      resource,
      tokenResourceOverride: `${resource}/mismatch`,
      expectTokenError: true,
    });
    if (mismatch.error) {
      check('token exchange rejects a mismatched resource', true, `${mismatch.status} ${mismatch.error}`);
    } else {
      console.log('  soft: workers-oauth-provider did not reject a mismatched resource at /token (documented, not a T4 gate)');
    }
  } catch (e) {
    console.log(`  soft: resource-mismatch probe inconclusive — ${e.message}`);
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

// Drive one auth-code + PKCE flow. Returns the access token string, or when
// expectTokenError is set, an object describing the /token response.
async function runAuthFlow({ authorizeUrl, tokenUrl, clientId, resource, tokenResourceOverride, expectTokenError, stateOverride }) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = stateOverride ?? b64url(crypto.randomBytes(8));

  const authGet = new URL(authorizeUrl);
  authGet.searchParams.set('response_type', 'code');
  authGet.searchParams.set('client_id', clientId);
  authGet.searchParams.set('redirect_uri', REDIRECT_URI);
  authGet.searchParams.set('code_challenge', challenge);
  authGet.searchParams.set('code_challenge_method', 'S256');
  authGet.searchParams.set('state', state);
  if (resource) authGet.searchParams.set('resource', resource);

  const consent = await fetch(authGet, { headers: { Accept: 'text/html' } });
  if (consent.status !== 200) throw new Error(`/authorize returned ${consent.status}`);
  const html = await consent.text();
  const m = html.match(/name="oauth_req" value="([^"]*)"/);
  if (!m) throw new Error('consent page missing oauth_req field');

  const approveRes = await fetch(`${BASE}/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_req: m[1], approve: 'true' }).toString(),
  });
  const location = approveRes.headers.get('location');
  if (!location) throw new Error(`/approve did not redirect (status ${approveRes.status})`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error(`redirect carried no code: ${location}`);

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (tokenResourceOverride) form.set('resource', tokenResourceOverride);
  else if (resource) form.set('resource', resource);

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await tokenRes.json().catch(() => ({}));

  if (expectTokenError) {
    return { status: tokenRes.status, error: tokenRes.ok ? null : (body.error || `status ${tokenRes.status}`), body };
  }
  if (!tokenRes.ok) throw new Error(`/token failed: ${tokenRes.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

main().catch((e) => {
  console.error('\nsmoke run crashed:', e);
  process.exit(1);
});
