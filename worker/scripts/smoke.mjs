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
  const state = { lightUser: false, refreshCount: 0, currentRefreshToken: null, accessCounter: 0, issuedCodes: new Set(), userId: MOCK_USER.id, noteWrites: 0 };

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
      state.issuedCodes.add(code);
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
        // Codes are single-use, like the real Help Scout: a replayed callback
        // must fail here, which is the worker's authoritative replay defense.
        if (!state.issuedCodes.has(body.code)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        state.issuedCodes.delete(body.code);
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
    // The user id is overridable so policy tests can drive distinct users.
    if (url.pathname === '/hs/users/me' && req.method === 'GET') {
      if (state.lightUser) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...MOCK_USER, id: state.userId }));
      return;
    }

    // Write endpoint for the policy write test: createNote POSTs here. Answers
    // 201 with the Resource-Id header the write handler reads.
    if (req.method === 'POST' && /^\/hs\/conversations\/\d+\/notes$/.test(url.pathname)) {
      state.noteWrites += 1;
      res.writeHead(201, { 'Content-Type': 'application/json', 'Resource-Id': '5551' });
      res.end(JSON.stringify({}));
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
function startWorker({ mockUrl, enableWrites, enableCustomerVisible = false, testPolicyRoutes = false }) {
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
    '--var',
    `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES:${enableCustomerVisible ? 'true' : 'false'}`,
    '--var',
    `HELPSCOUT_TEST_POLICY_ROUTES:${testPolicyRoutes ? 'true' : 'false'}`,
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

// Dispatch one tools/call and return the parsed structured result. `isError`
// reflects the CallToolResult.isError flag the gateway/policy layer sets.
async function mcpCallTool(headers, name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: args ?? {} },
    }),
  });
  const body = await readRpc(res);
  const result = body?.result;
  const text = result?.content?.[0]?.text;
  let structured = result?.structuredContent;
  if (!structured && typeof text === 'string') {
    try { structured = JSON.parse(text); } catch { /* not JSON */ }
  }
  return { httpStatus: res.status, isError: Boolean(result?.isError), structured, text };
}

// Drive the test-harness policy route (only mounted when the worker is started
// with HELPSCOUT_TEST_POLICY_ROUTES=true).
async function policyRoute(command) {
  const res = await fetch(`${BASE}/__test__/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

    // Replay: the captured callback's code was already spent by the happy path
    // above, so replaying it must fail the (single-use) code exchange upstream
    // and surface as a sign-in failure, never a completed grant.
    const replayed = await fetch(captured.callbackUrl, { redirect: 'manual', headers: { Cookie: `${CONSENT_COOKIE}=${captured.cookie}` } });
    check('replayed callback is rejected via the single-use code', replayed.status === 502, `status ${replayed.status}`);
  }

  // [8] light-user 403 -> seat-required page, no grant
  console.log('[8] light-user seat-required path');
  const lightFlow = await runFullFlow({ clientId: reg.clientId, resource, mock, lightUser: true });
  check('light user hits the callback error path', lightFlow.stopped === 'callback' && lightFlow.status === 403, `status ${lightFlow.status}`);
  check('light-user page explains a full seat is required', /seat|Light User|full Help Scout/i.test(lightFlow.body || ''));

  // [8b] the test-only policy route must NOT exist without the opt-in var
  console.log('[8b] test policy route is absent by default');
  const noRoute = await fetch(`${BASE}/__test__/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'getConfig' }),
  });
  check('test policy route 404s without HELPSCOUT_TEST_POLICY_ROUTES', noRoute.status === 404, `status ${noRoute.status}`);

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

// --- Policy engine (NAS-1501) -----------------------------------------------
// Runs against its own worker: writes enabled at the deployment ceiling, and the
// test-harness policy route mounted so the smoke can seed config/policy and drive
// revokeUser. Distinct Help Scout user ids per sub-test keep the KV state clean.
async function runPolicyMode({ mock }) {
  console.log(`\n=== mode: policy engine (${BASE}) ===\n`);

  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json().catch(() => ({}));
  const resource = prm.resource;
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json().catch(() => ({}));
  const registerUrl = as.registration_endpoint || `${BASE}/register`;
  const reg = await registerClient(registerUrl, 'Policy Smoke Client');
  check('policy mode: DCR returned client_id', typeof reg.clientId === 'string', `status ${reg.status}`);
  const clientId = reg.clientId;

  const ping = await policyRoute({ op: 'getConfig' });
  check('test policy route is mounted with the opt-in var set', ping.status === 200, `status ${ping.status}`);

  // [P1] allowlist mode denies an unlisted user's callback with the friendly page
  console.log('[P1] allowlist mode denies an unlisted user');
  await policyRoute({ op: 'del', target: 'config' });
  await policyRoute({ op: 'del', target: 'user', hsUserId: 1001 });
  const cfg1 = await policyRoute({ op: 'putConfig', patch: { allowlistMode: true, policyCacheTtlSeconds: 15 }, expectedVersion: 0 });
  check('allowlist config written (version 1)', cfg1.status === 200 && cfg1.body.config?.allowlistMode === true && cfg1.body.config?.version === 1, JSON.stringify(cfg1.body));
  mock.state.userId = 1001;
  const denied1 = await runFullFlow({ clientId, resource, mock });
  check('allowlist mode denies the callback (403)', denied1.stopped === 'callback' && denied1.status === 403, `status ${denied1.status}`);
  check('denied page says access not enabled / contact administrator', /not enabled|administrator/i.test(denied1.body || ''));

  // [P2] explicit allowed:false denies in open mode (no config document)
  console.log('[P2] explicit block denies in open mode');
  await policyRoute({ op: 'del', target: 'config' });
  await policyRoute({ op: 'del', target: 'user', hsUserId: 1002 });
  const p2 = await policyRoute({ op: 'putUserPolicy', hsUserId: 1002, input: { allowed: false, writes: false, customerVisibleWrites: false }, expectedVersion: 0 });
  check('explicit-block policy written', p2.status === 200 && p2.body.policy?.allowed === false, JSON.stringify(p2.body));
  mock.state.userId = 1002;
  const denied2 = await runFullFlow({ clientId, resource, mock });
  check('explicit allowed:false denies the callback in open mode (403)', denied2.stopped === 'callback' && denied2.status === 403, `status ${denied2.status}`);

  // [P3] per-user write permission: writes:false refused, writes:true succeeds
  console.log('[P3] per-user write permission gating');
  await policyRoute({ op: 'del', target: 'config' });
  await policyRoute({ op: 'del', target: 'user', hsUserId: 1003 });
  await policyRoute({ op: 'putUserPolicy', hsUserId: 1003, input: { allowed: true, writes: false, customerVisibleWrites: false }, expectedVersion: 0 });
  mock.state.userId = 1003;
  const flow3 = await runFullFlow({ clientId, resource, mock });
  check('write-test user connects', typeof flow3.accessToken === 'string' && flow3.accessToken.length > 0);
  const init3 = await mcpInitialize(flow3.accessToken);
  check('write-test initialize is 200', init3.status === 200, `status ${init3.status}`);
  const list3 = await toolsList(init3.headers);
  check('write_help_scout advertised at the deployment ceiling', list3.tools.includes('write_help_scout'));
  const noteArgs = { name: 'createNote', arguments: { conversationId: '123', text: 'policy smoke note' } };
  const notesBefore = mock.state.noteWrites;
  const denyWrite = await mcpCallTool(init3.headers, 'write_help_scout', noteArgs);
  check('writes:false user is refused with a structured permission error', denyWrite.isError === true && denyWrite.structured?.code === 'PERMISSION_DENIED', JSON.stringify(denyWrite.structured));
  check('the refused write never reached the mock upstream', mock.state.noteWrites === notesBefore, `noteWrites ${mock.state.noteWrites}`);
  const cur3 = await policyRoute({ op: 'getUserPolicy', hsUserId: 1003 });
  await policyRoute({ op: 'putUserPolicy', hsUserId: 1003, input: { allowed: true, writes: true, customerVisibleWrites: false }, expectedVersion: cur3.body.policy?.version ?? 0 });
  const okWrite = await mcpCallTool(init3.headers, 'write_help_scout', noteArgs);
  check('writes:true user succeeds against the mock upstream', okWrite.isError === false && okWrite.structured?.status === 'succeeded', JSON.stringify(okWrite.structured));
  check('the successful write reached the mock upstream', mock.state.noteWrites === notesBefore + 1, `noteWrites ${mock.state.noteWrites}`);

  // [P4] mid-session revocation honors the policy cache TTL as the SLA
  console.log('[P4] mid-session revocation after the cache window');
  await policyRoute({ op: 'del', target: 'config' });
  await policyRoute({ op: 'del', target: 'user', hsUserId: 1004 });
  await policyRoute({ op: 'putConfig', patch: { allowlistMode: false, policyCacheTtlSeconds: 15 }, expectedVersion: 0 });
  await policyRoute({ op: 'putUserPolicy', hsUserId: 1004, input: { allowed: true, writes: false, customerVisibleWrites: false }, expectedVersion: 0 });
  mock.state.userId = 1004;
  const flow4 = await runFullFlow({ clientId, resource, mock });
  const init4 = await mcpInitialize(flow4.accessToken);
  const search1 = await mcpCallTool(init4.headers, 'search_help_scout', { query: 'conversations' });
  check('allowed read succeeds and warms the policy cache', search1.isError === false && Array.isArray(search1.structured?.results), JSON.stringify(search1.structured));
  const cur4 = await policyRoute({ op: 'getUserPolicy', hsUserId: 1004 });
  await policyRoute({ op: 'putUserPolicy', hsUserId: 1004, input: { allowed: false, writes: false, customerVisibleWrites: false }, expectedVersion: cur4.body.policy?.version ?? 0 });
  const searchWithin = await mcpCallTool(init4.headers, 'search_help_scout', { query: 'conversations' });
  check('read still served from the unexpired cache immediately after revoke', searchWithin.isError === false, JSON.stringify(searchWithin.structured));
  console.log('       waiting out the 15s policy cache TTL...');
  await new Promise((r) => setTimeout(r, 17000));
  const searchAfter = await mcpCallTool(init4.headers, 'search_help_scout', { query: 'conversations' });
  check('read denied once the cache window lapses (revocation SLA)', searchAfter.isError === true && searchAfter.structured?.code === 'ACCESS_REVOKED', JSON.stringify(searchAfter.structured));

  // [P5] revokeUser tears down grants and pins allowed:false
  console.log('[P5] revokeUser revokes grants and blocks the user');
  await policyRoute({ op: 'del', target: 'config' });
  await policyRoute({ op: 'del', target: 'user', hsUserId: 1005 });
  await policyRoute({ op: 'putUserPolicy', hsUserId: 1005, input: { allowed: true, writes: false, customerVisibleWrites: false }, expectedVersion: 0 });
  mock.state.userId = 1005;
  const flow5 = await runFullFlow({ clientId, resource, mock });
  const init5 = await mcpInitialize(flow5.accessToken);
  const list5 = await toolsList(init5.headers);
  check('revoke-test session works before revoke', list5.status === 200 && list5.tools.includes('search_help_scout'));
  const rev = await policyRoute({ op: 'revokeUser', hsUserId: 1005 });
  check('revokeUser revoked at least one grant', rev.status === 200 && (rev.body.result?.grantsRevoked ?? 0) >= 1, JSON.stringify(rev.body));
  check('revokeUser pinned the policy to allowed:false', rev.body.result?.policy?.allowed === false, JSON.stringify(rev.body.result?.policy));
  const afterRevoke = await toolsList(init5.headers);
  check('revoked grant makes the OUR token unauthorized at /mcp (401)', afterRevoke.status === 401, `status ${afterRevoke.status}`);

  // [P6] optimistic concurrency: a stale putConfig is a 409 conflict
  console.log('[P6] optimistic-concurrency conflict');
  await policyRoute({ op: 'del', target: 'config' });
  await policyRoute({ op: 'putConfig', patch: { allowlistMode: false }, expectedVersion: 0 });
  const stale = await policyRoute({ op: 'putConfig', patch: { allowlistMode: true }, expectedVersion: 0 });
  check('stale putConfig returns a 409 conflict', stale.status === 409 && stale.body.code === 'POLICY_CONFLICT', JSON.stringify(stale.body));

  // [P7] atomic CAS through the coordinator DO: two writes presenting the SAME
  // expectedVersion, fired concurrently (both requests in flight before either
  // resolves), resolve to exactly one 200 and one 409 — no lost update. This is
  // the defect the KV get-then-put had; the DO serializes the check-and-increment.
  console.log('[P7] concurrent same-version writes resolve to one winner + one conflict');
  await policyRoute({ op: 'del', target: 'config' });
  const seed7 = await policyRoute({ op: 'putConfig', patch: { allowlistMode: false }, expectedVersion: 0 });
  check('CAS seed config written (version 1)', seed7.status === 200 && seed7.body.config?.version === 1, JSON.stringify(seed7.body));
  const [w1, w2] = await Promise.all([
    policyRoute({ op: 'putConfig', patch: { allowlistMode: true }, expectedVersion: 1 }),
    policyRoute({ op: 'putConfig', patch: { policyCacheTtlSeconds: 120 }, expectedVersion: 1 }),
  ]);
  const statuses = [w1.status, w2.status].sort((a, b) => a - b);
  check('concurrent same-version writes: exactly one 200 and one 409', statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses));
  const conflict7 = [w1, w2].find((r) => r.status === 409);
  check('the losing concurrent write is a POLICY_CONFLICT', conflict7?.body?.code === 'POLICY_CONFLICT', JSON.stringify(conflict7?.body));
  const after7 = await policyRoute({ op: 'getConfig' });
  check('exactly one concurrent write landed (config advanced to version 2)', after7.body.config?.version === 2, JSON.stringify(after7.body.config));

  // [P8] strong-consistency admission gate: a fresh /callback immediately after a
  // revoke reads the deny with no stale admit. Under the old KV store a callback
  // landing in a lagging colo could still read the pre-revoke policy and mint a
  // grant; the coordinator's reads are strongly consistent, so the very next
  // sign-in is refused.
  console.log('[P8] revoke then immediate fresh callback is denied');
  await policyRoute({ op: 'del', target: 'config' });
  await policyRoute({ op: 'del', target: 'user', hsUserId: 1008 });
  await policyRoute({ op: 'putUserPolicy', hsUserId: 1008, input: { allowed: true, writes: false, customerVisibleWrites: false }, expectedVersion: 0 });
  mock.state.userId = 1008;
  const preRevoke8 = await runFullFlow({ clientId, resource, mock });
  check('user connects before revoke', typeof preRevoke8.accessToken === 'string' && preRevoke8.accessToken.length > 0);
  const rev8 = await policyRoute({ op: 'revokeUser', hsUserId: 1008 });
  check('revoke pins the policy to allowed:false', rev8.body.result?.policy?.allowed === false, JSON.stringify(rev8.body.result?.policy));
  const postRevoke8 = await runFullFlow({ clientId, resource, mock });
  check('a fresh callback immediately after revoke is denied (403, no stale admit)', postRevoke8.stopped === 'callback' && postRevoke8.status === 403, `status ${postRevoke8.status}`);
}

async function main() {
  const only = process.env.SMOKE_MODE; // 'reads' | 'writes' | 'policy' | undefined (all)
  const modes = only === 'reads' ? [false] : only === 'writes' ? [true] : only === 'policy' ? [] : [false, true];
  const runPolicy = only === undefined || only === 'policy';

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

    if (runPolicy) {
      // Reset the mutable mock user id so the policy mode starts from a known id.
      mock.state.userId = MOCK_USER.id;
      const policyWorker = startWorker({ mockUrl: mock.url, enableWrites: true, testPolicyRoutes: true });
      try {
        await waitForReady(policyWorker.getLog);
        await runPolicyMode({ mock });
      } finally {
        await policyWorker.close();
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
