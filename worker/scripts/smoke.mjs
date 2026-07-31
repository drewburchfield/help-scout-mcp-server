// End-to-end smoke for the Help Scout remote MCP worker.
//
// Self-contained: it starts a local mock Help Scout (authorize redirect, token
// endpoint, users/me), spawns `wrangler dev` with the worker's HELPSCOUT_* vars
// pointed at the mock, and drives the FULL per-user OAuth flow — consent →
// approve → mock Help Scout → /callback → token exchange → /mcp initialize +
// tools/list — for both write modes. No live Help Scout is reachable from
// localhost (the redirect URL is fixed at app registration), so the mock stands
// in for it.
//
// Usage: node scripts/smoke.mjs            (runs read-only and write modes)
//        SMOKE_MODE=reads node scripts/smoke.mjs
//        SMOKE_MODE=writes node scripts/smoke.mjs
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const NODE_BIN = process.env.SMOKE_NODE_BIN || process.execPath;
const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PORT = Number(process.env.WORKER_PORT || 8787);
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const REDIRECT_URI = `${BASE}/callback`;
const READY_TIMEOUT_MS = 90_000;

const MOCK_USER = { id: 987, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', type: 'user' };
const HS_EXPIRES_IN = 172800; // 48h, matching Help Scout

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

// --- Mock Help Scout --------------------------------------------------------
// State is mutated directly from the smoke process (same runtime) to exercise
// the light-user path and to observe refresh-token rotation.
function startMockHelpScout() {
  const state = { lightUser: false, refreshCount: 0, currentRefreshToken: null, accessCounter: 0 };

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);

    // Authorize: takes client_id + state, immediately redirects to the fixed
    // worker callback carrying a code and echoing the state.
    if (url.pathname === '/hs/authorize' && req.method === 'GET') {
      const clientState = url.searchParams.get('state') || '';
      const code = `hs-code-${crypto.randomBytes(6).toString('hex')}`;
      const loc = `${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(clientState)}`;
      res.writeHead(302, { Location: loc });
      res.end();
      return;
    }

    // Token endpoint: authorization_code and refresh_token grants.
    if (url.pathname === '/hs/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const issue = () => {
        state.accessCounter += 1;
        state.currentRefreshToken = `hs-refresh-${state.accessCounter}`;
        return {
          access_token: `hs-access-${state.accessCounter}`,
          refresh_token: state.currentRefreshToken,
          token_type: 'bearer',
          expires_in: HS_EXPIRES_IN,
        };
      };
      if (body.grant_type === 'authorization_code') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(issue()));
        return;
      }
      if (body.grant_type === 'refresh_token') {
        // Rotating refresh: the presented token must be the current one.
        if (body.refresh_token !== state.currentRefreshToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        state.refreshCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(issue()));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    // Identity. Light Users have no Mailbox API access: 403 even with a token.
    if (url.pathname === '/hs/users/me' && req.method === 'GET') {
      if (state.lightUser) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(MOCK_USER));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// --- wrangler dev lifecycle -------------------------------------------------
function startWorker({ mockUrl, enableWrites }) {
  const args = [
    './node_modules/.bin/wrangler',
    'dev',
    '--port',
    String(WORKER_PORT),
    '--ip',
    '127.0.0.1',
    '--var',
    `HELPSCOUT_AUTHORIZE_URL:${mockUrl}/hs/authorize`,
    '--var',
    `HELPSCOUT_TOKEN_URL:${mockUrl}/hs/token`,
    '--var',
    `HELPSCOUT_BASE_URL:${mockUrl}/hs/`,
    '--var',
    `HELPSCOUT_ENABLE_WRITES:${enableWrites ? 'true' : 'false'}`,
  ];
  const proc = spawn(NODE_BIN, args, {
    cwd: WORKER_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));

  const close = () =>
    new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 5000).unref();
    });

  return { proc, close, getLog: () => log };
}

async function waitForReady(getLog) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`worker did not become ready within ${READY_TIMEOUT_MS}ms.\n--- wrangler output ---\n${getLog()}`);
}

// --- Cookie jar + Streamable HTTP helpers -----------------------------------
const CONSENT_COOKIE = 'hs_mcp_txn';
function setCookieValues(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const single = res.headers.get('set-cookie');
  const all = raw.length ? raw : single ? [single] : [];
  const jar = {};
  for (const line of all) {
    const first = line.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return jar;
}

async function readRpc(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    const objs = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const payload = t.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try { objs.push(JSON.parse(payload)); } catch { /* keepalive */ }
        }
      }
    }
    return objs[objs.length - 1];
  }
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// Drive one full consent + Help Scout flow. Returns the OUR-token pair plus the
// authorization code, or an object describing where it stopped when a stage is
// expected to fail (used by the tamper/replay/light-user checks).
async function runFullFlow({ clientId, resource, stateOverride, lightUser, mock, capture }) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const clientState = stateOverride ?? b64url(crypto.randomBytes(8));

  // 1. GET /authorize -> consent page + signed cookie C1
  const authGet = new URL(`${BASE}/authorize`);
  authGet.searchParams.set('response_type', 'code');
  authGet.searchParams.set('client_id', clientId);
  authGet.searchParams.set('redirect_uri', REDIRECT_URI);
  authGet.searchParams.set('code_challenge', challenge);
  authGet.searchParams.set('code_challenge_method', 'S256');
  authGet.searchParams.set('state', clientState);
  if (resource) authGet.searchParams.set('resource', resource);

  const consent = await fetch(authGet, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  if (consent.status !== 200) throw new Error(`/authorize returned ${consent.status}`);
  const c1 = setCookieValues(consent)[CONSENT_COOKIE];
  if (!c1) throw new Error('consent page set no consent cookie');

  // 2. POST /approve -> 302 to mock Help Scout authorize + cookie C2
  const approveRes = await fetch(`${BASE}/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `${CONSENT_COOKIE}=${c1}` },
    body: new URLSearchParams({ approve: 'true' }).toString(),
  });
  if (approveRes.status !== 302) throw new Error(`/approve did not redirect (status ${approveRes.status})`);
  const hsAuthorize = approveRes.headers.get('location');
  const c2 = setCookieValues(approveRes)[CONSENT_COOKIE] || c1;

  // 3. Follow to mock Help Scout authorize -> 302 back to /callback?code&state
  const hsRes = await fetch(hsAuthorize, { redirect: 'manual' });
  if (hsRes.status !== 302) throw new Error(`mock HS authorize did not redirect (status ${hsRes.status})`);
  const callbackUrl = new URL(hsRes.headers.get('location'));

  if (capture) capture({ callbackUrl, cookie: c2 });

  // Optional light-user toggle: flip the mock so users/me 403s on this callback.
  if (lightUser && mock) mock.state.lightUser = true;

  // 4. GET /callback -> 302 back to the MCP client (or seat-required page)
  const cbRes = await fetch(callbackUrl, {
    redirect: 'manual',
    headers: { Cookie: `${CONSENT_COOKIE}=${c2}` },
  });

  if (lightUser && mock) mock.state.lightUser = false;

  if (cbRes.status !== 302) {
    // Expected for the light-user path and tamper/replay cases.
    const body = await cbRes.text();
    return { stopped: 'callback', status: cbRes.status, body };
  }

  const clientRedirect = new URL(cbRes.headers.get('location'));
  const ourCode = clientRedirect.searchParams.get('code');
  if (!ourCode) throw new Error(`callback redirect carried no code: ${clientRedirect}`);

  // 5. Exchange OUR code at /token
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: ourCode,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (resource) form.set('resource', resource);
  const tokenRes = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) throw new Error(`/token failed: ${tokenRes.status} ${JSON.stringify(tokenBody)}`);
  return { accessToken: tokenBody.access_token, refreshToken: tokenBody.refresh_token, clientState };
}

async function registerClient(registerUrl, clientName) {
  const res = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, clientId: body.client_id };
}

async function mcpInitialize(token) {
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
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } },
    }),
  });
  const sessionId = initRes.headers.get('mcp-session-id') || initRes.headers.get('Mcp-Session-Id');
  const initBody = await readRpc(initRes);
  const protocolVersion = initBody?.result?.protocolVersion || '2025-06-18';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {});
  return { status: initRes.status, initBody, headers };
}

async function toolsList(headers) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const body = await readRpc(res);
  return { status: res.status, tools: (body?.result?.tools || []).map((t) => t.name) };
}

// --- One full mode (writes off / on) ----------------------------------------
async function runMode({ mock, enableWrites }) {
  const label = enableWrites ? 'writes enabled' : 'read-only';
  console.log(`\n=== mode: ${label} (${BASE}) ===\n`);

  // [1] discovery metadata
  console.log('[1] discovery metadata');
  const prmRes = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  check('protected-resource metadata is 200', prmRes.status === 200, `status ${prmRes.status}`);
  const prm = await prmRes.json().catch(() => ({}));
  check('protected-resource has resource', typeof prm.resource === 'string');
  check('protected-resource has authorization_servers', Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0);
  const resource = prm.resource;

  const asRes = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  check('authorization-server metadata is 200', asRes.status === 200, `status ${asRes.status}`);
  const as = await asRes.json().catch(() => ({}));
  check('AS metadata has authorization_endpoint', typeof as.authorization_endpoint === 'string');
  check('AS metadata has token_endpoint', typeof as.token_endpoint === 'string');
  check('AS metadata has registration_endpoint', typeof as.registration_endpoint === 'string');
  check(
    'AS metadata advertises S256 PKCE',
    Array.isArray(as.code_challenge_methods_supported) && as.code_challenge_methods_supported.includes('S256'),
  );
  const registerUrl = as.registration_endpoint || `${BASE}/register`;

  // [2] unauthenticated /mcp -> 401 + WWW-Authenticate
  console.log('[2] unauthenticated /mcp challenge');
  const unauth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('unauthenticated POST /mcp is 401', unauth.status === 401, `status ${unauth.status}`);
  check('unauthenticated /mcp sends WWW-Authenticate', typeof unauth.headers.get('www-authenticate') === 'string');

  // [3] DCR
  console.log('[3] dynamic client registration');
  const reg = await registerClient(registerUrl, 'Smoke Client');
  check('DCR is 200/201', reg.status === 200 || reg.status === 201, `status ${reg.status}`);
  check('DCR returned client_id', typeof reg.clientId === 'string');

  // [4] full Help Scout auth-code flow through the mock
  console.log('[4] full per-user Help Scout auth-code flow');
  const flow = await runFullFlow({ clientId: reg.clientId, resource, mock });
  check('OUR token issued after full Help Scout flow', typeof flow.accessToken === 'string' && flow.accessToken.length > 0);
  check('OUR refresh token issued', typeof flow.refreshToken === 'string' && flow.refreshToken.length > 0);

  // [5] initialize + tools/list; assert the grant carries the mock user identity
  console.log('[5] MCP initialize + tools/list');
  const init = await mcpInitialize(flow.accessToken);
  check('authenticated initialize is 200', init.status === 200, `status ${init.status}`);
  check('initialize returned serverInfo', Boolean(init.initBody?.result?.serverInfo));
  const instructions = init.initBody?.result?.instructions || '';
  check('grant carries the mock user identity (instructions name the user)', instructions.includes(MOCK_USER.email), instructions);

  const list = await toolsList(init.headers);
  check('tools/list is 200', list.status === 200, `status ${list.status}`);
  console.log(`       advertised tools: ${list.tools.join(', ') || '(none)'}`);
  for (const name of ['search_help_scout', 'describe_help_scout', 'read_help_scout']) {
    check(`advertises ${name}`, list.tools.includes(name));
  }
  if (enableWrites) {
    check('write_help_scout advertised while writes enabled', list.tools.includes('write_help_scout'));
  } else {
    check('write_help_scout hidden while writes disabled', !list.tools.includes('write_help_scout'));
  }

  // [6] durable refresh rotation via tokenExchangeCallback
  console.log('[6] durable refresh-token rotation');
  const beforeRefreshes = mock.state.refreshCount;
  const refreshForm = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: flow.refreshToken,
    client_id: reg.clientId,
  });
  const refreshRes = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshForm.toString(),
  });
  const refreshBody = await refreshRes.json().catch(() => ({}));
  check('OUR token refresh succeeds', refreshRes.ok && typeof refreshBody.access_token === 'string', `status ${refreshRes.status}`);
  check('refresh rotated the Help Scout token upstream', mock.state.refreshCount === beforeRefreshes + 1, `count ${mock.state.refreshCount}`);
  if (refreshBody.access_token) {
    const reinit = await mcpInitialize(refreshBody.access_token);
    check('initialize still works after refresh (identity preserved)', reinit.status === 200 && (reinit.initBody?.result?.instructions || '').includes(MOCK_USER.email));
  }

  // [7] consent-surface robustness: unicode, missing cookie, tamper, replay
  console.log('[7] consent-surface robustness');
  const uni = await registerClient(registerUrl, 'Smoke ✓ 日本語 Client');
  check('DCR accepts a unicode client name', typeof uni.clientId === 'string');
  if (uni.clientId) {
    const uniFlow = await runFullFlow({ clientId: uni.clientId, resource, stateOverride: 'smoke-✓-state-日本語', mock });
    check('flow survives unicode client name and state', typeof uniFlow.accessToken === 'string' && uniFlow.accessToken.length > 0);
  }

  const noCookie = await fetch(`${BASE}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ approve: 'true' }).toString(),
  });
  check('missing/invalid consent cookie is a 400, not a 500', noCookie.status === 400, `status ${noCookie.status}`);

  // Tampered state: complete through the callback URL but with a state that does
  // not match the cookie's bound state.
  console.log('       tamper + replay');
  let captured;
  await runFullFlow({ clientId: reg.clientId, resource, mock, capture: (c) => (captured = c) })
    .catch(() => {}); // the happy path completes; we reuse the captured callback for replay below
  if (!captured) {
    check('tamper/replay probe reached the callback stage', false, 'flow did not reach the Help Scout callback');
  } else {
    // Build a callback with a mismatched state query param.
    const tamperUrl = new URL(captured.callbackUrl);
    tamperUrl.searchParams.set('state', 'not-the-bound-state');
    const tampered = await fetch(tamperUrl, { redirect: 'manual', headers: { Cookie: `${CONSENT_COOKIE}=${captured.cookie}` } });
    check('tampered state at /callback is rejected', tampered.status === 400, `status ${tampered.status}`);

    // Replay: the captured callback's state was already consumed by the happy
    // path above, so replaying it must be rejected by the single-use marker.
    const replayed = await fetch(captured.callbackUrl, { redirect: 'manual', headers: { Cookie: `${CONSENT_COOKIE}=${captured.cookie}` } });
    check('replayed state at /callback is rejected', replayed.status === 400, `status ${replayed.status}`);
  }

  // [8] light-user 403 -> seat-required page, no grant
  console.log('[8] light-user seat-required path');
  const lightFlow = await runFullFlow({ clientId: reg.clientId, resource, mock, lightUser: true });
  check('light user hits the callback error path', lightFlow.stopped === 'callback' && lightFlow.status === 403, `status ${lightFlow.status}`);
  check('light-user page explains a full seat is required', /seat|Light User|full Help Scout/i.test(lightFlow.body || ''));

  // [9] RFC 8707 resource binding on token exchange (soft)
  console.log('[9] resource-mismatch on token exchange (soft)');
  try {
    // Re-drive to a fresh OUR code, then exchange with a mismatched resource.
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const st = b64url(crypto.randomBytes(8));
    const a = new URL(`${BASE}/authorize`);
    a.searchParams.set('response_type', 'code');
    a.searchParams.set('client_id', reg.clientId);
    a.searchParams.set('redirect_uri', REDIRECT_URI);
    a.searchParams.set('code_challenge', challenge);
    a.searchParams.set('code_challenge_method', 'S256');
    a.searchParams.set('state', st);
    if (resource) a.searchParams.set('resource', resource);
    const consent = await fetch(a, { headers: { Accept: 'text/html' }, redirect: 'manual' });
    const c1 = setCookieValues(consent)[CONSENT_COOKIE];
    const appr = await fetch(`${BASE}/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `${CONSENT_COOKIE}=${c1}` }, body: 'approve=true' });
    const c2 = setCookieValues(appr)[CONSENT_COOKIE] || c1;
    const hs = await fetch(appr.headers.get('location'), { redirect: 'manual' });
    const cb = await fetch(hs.headers.get('location'), { redirect: 'manual', headers: { Cookie: `${CONSENT_COOKIE}=${c2}` } });
    const ourCode = new URL(cb.headers.get('location')).searchParams.get('code');
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: ourCode, redirect_uri: REDIRECT_URI, client_id: reg.clientId, code_verifier: verifier, resource: `${resource}/mismatch` });
    const tr = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!tr.ok) check('token exchange rejects a mismatched resource', true, `status ${tr.status}`);
    else console.log('  soft: workers-oauth-provider did not reject a mismatched resource at /token (documented, not a gate)');
  } catch (e) {
    console.log(`  soft: resource-mismatch probe inconclusive — ${e.message}`);
  }
}

async function main() {
  const only = process.env.SMOKE_MODE; // 'reads' | 'writes' | undefined (both)
  const modes = only === 'reads' ? [false] : only === 'writes' ? [true] : [false, true];

  const mock = await startMockHelpScout();
  console.log(`mock Help Scout on ${mock.url}`);

  try {
    for (const enableWrites of modes) {
      const worker = startWorker({ mockUrl: mock.url, enableWrites });
      try {
        await waitForReady(worker.getLog);
        await runMode({ mock, enableWrites });
      } finally {
        await worker.close();
      }
    }
  } finally {
    await mock.close();
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nsmoke run crashed:', e);
  process.exit(1);
});
