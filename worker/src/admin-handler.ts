/**
 * The self-hosted admin surface (NAS-1503): /admin + /admin/api/*.
 *
 * This is a thin auth + CSRF + HTTP layer over the policy engine, the audit
 * ledger, and the evidence exports that already exist. It adds NO policy logic:
 * the pure decisions live in admin-auth.ts and the storage in the coordinator.
 *
 * Security model:
 *   - The admin session is SEPARATE from the MCP OAuth token. An admin logs in
 *     through the same Help Scout Authorization Code dance the consent flow uses,
 *     but the credential is a short-lived (8h) signed HTTP-only cookie THIS
 *     surface owns (admin-auth.ts). No Help Scout token is retained past login.
 *   - The Help Scout app has ONE registered Redirection URL (the worker's
 *     /callback), so the admin login's authorize leg lands on /callback too. It
 *     is disambiguated from the MCP consent callback by its own signed state
 *     cookie (tryAdminCallback), mirroring the consent flow's state discipline:
 *     signed state, exact-match, single-use via the Help Scout code.
 *   - The role gate requires Owner (or Administrator only when
 *     config.adminRole === 'administrator'). It is re-evaluated against the LIVE
 *     config on EVERY /admin/api/* request, so a demoted admin loses access on
 *     their next request even with a still-valid session cookie.
 *   - Every mutating request must carry a CSRF token matching the one bound in
 *     the session cookie (a synchronizer token embedded in the page).
 *   - Strict security headers on every response: a self-contained CSP (no
 *     third-party origins, nonce'd inline CSS/JS), frame-ancestors none,
 *     nosniff, no-referrer.
 */
import type { Env } from './mcp-agent.js';
import { SERVER_VERSION } from './mcp-agent.js';
import { readCookie } from './oauth-cookie.js';
import { isSecureUpstreamUrl, joinUrl } from './upstream-url.js';
import {
  PolicyConflictError,
  type AdminConfig,
  type DirectoryUser,
  type UserDirectory,
  type WriteFlagSet,
} from './policy.js';
import { getConfig, putConfig, putUserPolicy, revokeUser } from './policy-store.js';
import { deploymentId, exportAccessList, exportAuditLog, listAuditEntries } from './audit-store.js';
import { getDirectory, listUserPolicies, putDirectory } from './admin-store.js';
import {
  ADMIN_STATE_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  ADMIN_STATE_TTL_MS,
  buildAdminSessionClearCookie,
  buildAdminSessionSetCookie,
  buildAdminStateClearCookie,
  buildAdminStateSetCookie,
  buildRoster,
  ceilingTierCap,
  csrfTokensMatch,
  parseHelpScoutRole,
  policyInputFromTier,
  randomToken,
  roleSatisfiesAdmin,
  signAdminSession,
  signAdminState,
  tierWithinCeiling,
  verifyAdminSession,
  verifyAdminState,
  type AdminSession,
  type WriteTier,
} from './admin-auth.js';
import { renderAdminPage, renderAdminNotice } from './admin-page.js';

const HELP_SCOUT_FETCH_TIMEOUT_MS = 30_000;
/** Cap the /v2/users pagination so a hostile or broken upstream cannot loop unbounded. */
const MAX_USER_PAGES = 200;

// --- Response helpers ------------------------------------------------------

/** Security headers applied to every admin response. */
function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      ...extra,
    }),
  });
}

/** A self-contained HTML page with a per-response nonce'd CSP (no third-party origins). */
function htmlResponse(html: string, nonce: string, status = 200, extra: Record<string, string> = {}): Response {
  const csp =
    "default-src 'none'; " +
    `script-src 'nonce-${nonce}'; ` +
    `style-src 'nonce-${nonce}'; ` +
    "connect-src 'self'; " +
    "img-src data:; " +
    "form-action 'self'; " +
    "base-uri 'none'; " +
    "frame-ancestors 'none'";
  return new Response(html, {
    status,
    headers: securityHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      ...extra,
    }),
  });
}

/** A minimal notice page (login prompt, not-an-administrator, errors). */
function noticePage(title: string, heading: string, message: string, status: number, extra: Record<string, string> = {}): Response {
  const nonce = randomToken(16);
  return htmlResponse(renderAdminNotice(nonce, title, heading, message), nonce, status, extra);
}

// --- The deployment write ceiling (env-only, never raised from the GUI) ----

function ceilingFromEnv(env: Env): WriteFlagSet {
  return {
    enabled: env.HELPSCOUT_ENABLE_WRITES === 'true',
    customerVisibleEnabled: env.HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES === 'true',
  };
}

// --- Help Scout calls (admin token, only during login) ---------------------

interface HelpScoutMe {
  id?: unknown;
  email?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  role?: unknown;
  type?: unknown;
}

function displayName(u: { firstName?: unknown; lastName?: unknown; email?: unknown }, fallbackId: string): string {
  const name = [u.firstName, u.lastName]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ');
  if (name) return name;
  if (typeof u.email === 'string' && u.email.length > 0) return u.email;
  return `Help Scout user ${fallbackId}`;
}

/** Page through GET /v2/users with the admin's token, mapping to the cached directory shape. */
async function fetchDirectory(env: Env, token: string, allowLoopback: boolean): Promise<DirectoryUser[]> {
  const users: DirectoryUser[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url = new URL(joinUrl(env.HELPSCOUT_BASE_URL, 'users'));
    url.searchParams.set('page', String(page));
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HELP_SCOUT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Help Scout GET /users failed with status ${res.status}`);
    }
    const body = (await res.json()) as {
      _embedded?: { users?: HelpScoutMe[] };
      page?: { totalPages?: number };
    };
    const batch = body._embedded?.users ?? [];
    for (const u of batch) {
      const id = typeof u.id === 'number' ? u.id : Number(u.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const hsUserId = String(id);
      users.push({
        hsUserId,
        email: typeof u.email === 'string' ? u.email : '',
        name: displayName(u, hsUserId),
        role: parseHelpScoutRole(u.role, u.type),
      });
    }
    totalPages = typeof body.page?.totalPages === 'number' ? body.page.totalPages : 1;
    page += 1;
  } while (page <= totalPages && page <= MAX_USER_PAGES);
  return users;
}

// --- Admin login (authorize leg) -------------------------------------------

/** GET /admin with no valid session: start the Help Scout authorization dance. */
async function startAdminLogin(env: Env): Promise<Response> {
  const key = env.COOKIE_ENCRYPTION_KEY ?? '';
  const allowLoopback = Boolean(env.HELPSCOUT_TEST_POLICY_ROUTES);
  if (!isSecureUpstreamUrl(env.HELPSCOUT_AUTHORIZE_URL, allowLoopback)) {
    return noticePage(
      'Admin sign-in',
      'Deployment misconfigured',
      'This server is configured with a non-https Help Scout URL. Ask whoever operates it to fix HELPSCOUT_AUTHORIZE_URL.',
      500,
    );
  }

  const state = randomToken(24);
  const stateCookie = await signAdminState(state, Date.now() + ADMIN_STATE_TTL_MS, key);

  const authorizeUrl = new URL(env.HELPSCOUT_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', env.HELPSCOUT_CLIENT_ID);
  authorizeUrl.searchParams.set('state', state);

  const headers = new Headers(securityHeaders({ Location: authorizeUrl.toString() }));
  headers.append('Set-Cookie', buildAdminStateSetCookie(stateCookie));
  return new Response(null, { status: 302, headers });
}

/**
 * Handle the admin-login callback at /callback. Returns a Response when this
 * callback carries an admin-login state cookie (admin intent), otherwise null so
 * the MCP consent callback runs unchanged. Once an admin-state cookie is present
 * we own the callback and never fall through, so a dangling admin cookie cannot
 * hijack an MCP sign-in (which never carries this cookie).
 */
export async function tryAdminCallback(request: Request, env: Env): Promise<Response | null> {
  const stateCookie = readCookie(request, ADMIN_STATE_COOKIE_NAME);
  if (!stateCookie) return null;
  return handleAdminCallback(request, env, stateCookie);
}

async function handleAdminCallback(request: Request, env: Env, stateCookie: string): Promise<Response> {
  const key = env.COOKIE_ENCRYPTION_KEY ?? '';
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const boundState = await verifyAdminState(stateCookie, key);
  if (!boundState || !state || !code || boundState !== state) {
    return noticePage(
      'Admin sign-in',
      'Could not verify this sign-in',
      'The admin sign-in could not be verified. Start again from /admin.',
      400,
      { 'Set-Cookie': buildAdminStateClearCookie() },
    );
  }

  const allowLoopback = Boolean(env.HELPSCOUT_TEST_POLICY_ROUTES);
  if (
    !isSecureUpstreamUrl(env.HELPSCOUT_TOKEN_URL, allowLoopback) ||
    !isSecureUpstreamUrl(env.HELPSCOUT_BASE_URL, allowLoopback)
  ) {
    return noticePage(
      'Admin sign-in',
      'Deployment misconfigured',
      'This server is configured with a non-https Help Scout URL. Ask whoever operates it to fix HELPSCOUT_TOKEN_URL / HELPSCOUT_BASE_URL.',
      500,
      { 'Set-Cookie': buildAdminStateClearCookie() },
    );
  }

  // Exchange the single-use code for the admin's Help Scout token (used only to
  // read identity + the user directory during this login, then discarded).
  let accessToken: string;
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
      signal: AbortSignal.timeout(HELP_SCOUT_FETCH_TIMEOUT_MS),
    });
    if (!tokenRes.ok) {
      return noticePage(
        'Admin sign-in',
        'Help Scout sign-in failed',
        'Help Scout could not complete the sign-in. Start again from /admin.',
        502,
        { 'Set-Cookie': buildAdminStateClearCookie() },
      );
    }
    const tokenData = (await tokenRes.json()) as { access_token?: unknown };
    if (typeof tokenData.access_token !== 'string' || tokenData.access_token === '') {
      return noticePage('Admin sign-in', 'Help Scout sign-in failed', 'Help Scout returned an unexpected response. Start again from /admin.', 502, {
        'Set-Cookie': buildAdminStateClearCookie(),
      });
    }
    accessToken = tokenData.access_token;
  } catch {
    return noticePage('Admin sign-in', 'Help Scout is unreachable', 'Could not reach Help Scout to complete the sign-in. Try again in a moment.', 502, {
      'Set-Cookie': buildAdminStateClearCookie(),
    });
  }

  // Identity. A 403 here is a Light User (no Mailbox API), who cannot administer.
  let me: HelpScoutMe;
  try {
    const meRes = await fetch(joinUrl(env.HELPSCOUT_BASE_URL, 'users/me'), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HELP_SCOUT_FETCH_TIMEOUT_MS),
    });
    if (!meRes.ok) {
      return noticePage(
        'Admin sign-in',
        'You are not an administrator of this deployment',
        'Your Help Scout account could not be verified as an administrator of this deployment. If you believe this is a mistake, contact whoever operates it.',
        403,
        { 'Set-Cookie': buildAdminStateClearCookie() },
      );
    }
    me = (await meRes.json()) as HelpScoutMe;
  } catch {
    return noticePage('Admin sign-in', 'Help Scout is unreachable', 'Could not reach Help Scout to read your profile. Try again in a moment.', 502, {
      'Set-Cookie': buildAdminStateClearCookie(),
    });
  }

  const userId = typeof me.id === 'number' ? me.id : Number(me.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return noticePage('Admin sign-in', 'Could not read your Help Scout profile', 'Help Scout returned a profile without a usable identity. Try again in a moment.', 502, {
      'Set-Cookie': buildAdminStateClearCookie(),
    });
  }
  const hsUserId = String(userId);
  const email = typeof me.email === 'string' ? me.email : '';
  const role = parseHelpScoutRole(me.role, me.type);

  // Role gate against the LIVE config. An insufficient role gets a clear page and
  // NO session cookie.
  let config: AdminConfig;
  try {
    config = await getConfig(env);
  } catch {
    return noticePage('Admin sign-in', 'Access could not be verified', 'This deployment could not verify administrator access right now. Try again in a moment.', 503, {
      'Set-Cookie': buildAdminStateClearCookie(),
    });
  }
  if (!roleSatisfiesAdmin(role, config.adminRole)) {
    return noticePage(
      'Admin sign-in',
      'You are not an administrator of this deployment',
      `Your Help Scout role (${role}) is not permitted to administer this deployment. Access is limited to ${config.adminRole === 'administrator' ? 'Owners and Administrators' : 'Owners'}. Contact whoever operates it if you believe this is a mistake.`,
      403,
      { 'Set-Cookie': buildAdminStateClearCookie() },
    );
  }

  // Fetch + cache the account directory once, so the roster endpoint needs no
  // Help Scout token for the life of the session.
  try {
    const users = await fetchDirectory(env, accessToken, allowLoopback);
    const directory: UserDirectory = { users, fetchedAt: new Date().toISOString(), fetchedBy: hsUserId };
    await putDirectory(env, directory);
  } catch {
    return noticePage('Admin sign-in', 'Could not load the account roster', 'Help Scout accepted the sign-in but the account user list could not be read. Try again in a moment.', 502, {
      'Set-Cookie': buildAdminStateClearCookie(),
    });
  }

  const session: AdminSession = { hsUserId, email, role, csrf: randomToken(24) };
  const sessionCookie = await signAdminSession(session, Date.now() + ADMIN_SESSION_TTL_MS, key);

  const headers = new Headers(securityHeaders({ Location: '/admin' }));
  headers.append('Set-Cookie', buildAdminSessionSetCookie(sessionCookie));
  headers.append('Set-Cookie', buildAdminStateClearCookie());
  return new Response(null, { status: 302, headers });
}

// --- Authenticated admin surface -------------------------------------------

/** Resolve and re-validate the admin session for an /admin/api/* request. */
async function requireSession(
  request: Request,
  env: Env,
): Promise<{ session: AdminSession; config: AdminConfig } | { error: Response }> {
  const key = env.COOKIE_ENCRYPTION_KEY ?? '';
  const cookie = readCookie(request, ADMIN_SESSION_COOKIE_NAME);
  const verified = await verifyAdminSession(cookie, key);
  if (!verified) {
    return { error: jsonResponse({ error: 'Not authenticated.', code: 'UNAUTHENTICATED' }, 401) };
  }
  let config: AdminConfig;
  try {
    config = await getConfig(env);
  } catch {
    return { error: jsonResponse({ error: 'Access could not be verified right now.', code: 'TEMPORARY_ERROR' }, 503) };
  }
  // Re-check the role against the LIVE config: a demoted admin loses access here.
  if (!roleSatisfiesAdmin(verified.session.role, config.adminRole)) {
    return { error: jsonResponse({ error: 'Your administrator access is no longer permitted by this deployment.', code: 'FORBIDDEN' }, 403) };
  }
  return { session: verified.session, config };
}

/** GET /admin/api/roster: the merged roster plus deployment state. */
async function handleRoster(env: Env, config: AdminConfig): Promise<Response> {
  const ceiling = ceilingFromEnv(env);
  const directory = await getDirectory(env);
  const policies = await listUserPolicies(env);

  const users = directory?.users ?? [];
  const connectedIds = new Set<string>();
  await Promise.all(
    users.map(async (u) => {
      try {
        const page = await env.OAUTH_PROVIDER.listUserGrants(u.hsUserId);
        if (page.items.length > 0) connectedIds.add(u.hsUserId);
      } catch {
        // Grant lookup is informational; a failure just leaves "connected" false.
      }
    }),
  );

  const rows = buildRoster(users, policies, connectedIds, config, ceiling);
  return jsonResponse({
    deployment: {
      allowlistMode: config.allowlistMode,
      adminRole: config.adminRole,
      configVersion: config.version,
      ceiling,
      ceilingCap: ceilingTierCap(ceiling),
      workerVersion: SERVER_VERSION,
      deploymentId: deploymentId(env),
      directoryFetchedAt: directory?.fetchedAt ?? null,
    },
    rows,
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function conflictResponse(error: PolicyConflictError): Response {
  return jsonResponse(
    {
      error: 'This record changed since you loaded it. Reload the page and try again.',
      code: 'POLICY_CONFLICT',
      expectedVersion: error.expectedVersion,
      currentVersion: error.currentVersion,
    },
    409,
  );
}

/** POST /admin/api/user-policy: set a user's allowed state and write tier together. */
async function handleUserPolicy(request: Request, env: Env, session: AdminSession): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ error: 'Body must be JSON.' }, 400);

  const hsUserId = typeof body.hsUserId === 'string' ? body.hsUserId : String(body.hsUserId ?? '');
  const allowed = body.allowed === true;
  const writeTier = body.writeTier as WriteTier;
  const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : Number(body.expectedVersion);

  if (!/^\d+$/.test(hsUserId)) return jsonResponse({ error: 'hsUserId must be a Help Scout user id.' }, 400);
  if (writeTier !== 'none' && writeTier !== 'writes' && writeTier !== 'writes+customerVisible') {
    return jsonResponse({ error: 'writeTier must be none, writes, or writes+customerVisible.' }, 400);
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return jsonResponse({ error: 'expectedVersion must be a non-negative integer.' }, 400);
  }

  // Fail closed: never let the GUI grant a tier above the deployment env ceiling,
  // regardless of what the client sent (the control greys these out client-side).
  const ceiling = ceilingFromEnv(env);
  if (!tierWithinCeiling(writeTier, ceiling)) {
    return jsonResponse(
      { error: 'That write tier exceeds this deployment write ceiling, which is set at deploy time and cannot be raised from here.', code: 'CEILING_EXCEEDED' },
      400,
    );
  }

  try {
    const policy = await putUserPolicy(env, hsUserId, policyInputFromTier(allowed, writeTier), {
      expectedVersion,
      updatedBy: session.hsUserId,
      actorEmail: session.email,
    });
    return jsonResponse({ policy });
  } catch (error) {
    if (error instanceof PolicyConflictError) return conflictResponse(error);
    throw error;
  }
}

/** POST /admin/api/revoke: hard-revoke a user's grants and pin allowed:false. */
async function handleRevoke(request: Request, env: Env, session: AdminSession): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ error: 'Body must be JSON.' }, 400);
  const hsUserId = typeof body.hsUserId === 'string' ? body.hsUserId : String(body.hsUserId ?? '');
  if (!/^\d+$/.test(hsUserId)) return jsonResponse({ error: 'hsUserId must be a Help Scout user id.' }, 400);

  const result = await revokeUser(env, hsUserId, { updatedBy: session.hsUserId, actorEmail: session.email });
  return jsonResponse({ result });
}

/** POST /admin/api/config: set the allowlist-mode switch (the only GUI-mutable config). */
async function handleConfig(request: Request, env: Env, session: AdminSession): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ error: 'Body must be JSON.' }, 400);
  if (typeof body.allowlistMode !== 'boolean') return jsonResponse({ error: 'allowlistMode must be a boolean.' }, 400);
  const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return jsonResponse({ error: 'expectedVersion must be a non-negative integer.' }, 400);
  }

  try {
    const config = await putConfig(env, { allowlistMode: body.allowlistMode }, {
      expectedVersion,
      updatedBy: session.hsUserId,
      actorEmail: session.email,
    });
    return jsonResponse({ config });
  } catch (error) {
    if (error instanceof PolicyConflictError) return conflictResponse(error);
    throw error;
  }
}

/** GET /admin/api/audit: a newest-first page of audit rows. */
async function handleAudit(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : undefined;
  const page = await listAuditEntries(env, { cursor, limit: Number.isFinite(limit) ? limit : undefined });
  return jsonResponse({ page });
}

/** GET /admin/api/export/*: evidence downloads with a Content-Disposition attachment. */
async function handleExport(env: Env, kind: string): Promise<Response> {
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'audit.json') {
    const data = await exportAuditLog(env, { format: 'json' });
    return download(JSON.stringify(data, null, 2), 'application/json; charset=utf-8', `helpscout-audit-${stamp}.json`);
  }
  if (kind === 'audit.csv') {
    const data = await exportAuditLog(env, { format: 'csv' });
    const csv = data.format === 'csv' ? data.csv : '';
    return download(csv, 'text/csv; charset=utf-8', `helpscout-audit-${stamp}.csv`);
  }
  if (kind === 'access-list.json') {
    const data = await exportAccessList(env, { format: 'json' });
    return download(JSON.stringify(data, null, 2), 'application/json; charset=utf-8', `helpscout-access-list-${stamp}.json`);
  }
  if (kind === 'access-list.csv') {
    const data = await exportAccessList(env, { format: 'csv' });
    const csv = data.format === 'csv' ? data.csv : '';
    return download(csv, 'text/csv; charset=utf-8', `helpscout-access-list-${stamp}.csv`);
  }
  return jsonResponse({ error: 'Unknown export.' }, 404);
}

function download(body: string, contentType: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: securityHeaders({
      'Content-Type': contentType,
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Content-Disposition': `attachment; filename="${filename}"`,
    }),
  });
}

/** Dispatch every /admin/api/* request behind session + role + (for POST) CSRF gates. */
async function handleAdminApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const gate = await requireSession(request, env);
  if ('error' in gate) return gate.error;
  const { session, config } = gate;

  // Every mutating request must carry the session's CSRF token.
  if (request.method === 'POST') {
    if (!csrfTokensMatch(session.csrf, request.headers.get('X-Admin-CSRF'))) {
      return jsonResponse({ error: 'Missing or invalid CSRF token.', code: 'CSRF_FAILED' }, 403);
    }
  }

  if (pathname === '/admin/api/roster' && request.method === 'GET') return handleRoster(env, config);
  if (pathname === '/admin/api/user-policy' && request.method === 'POST') return handleUserPolicy(request, env, session);
  if (pathname === '/admin/api/revoke' && request.method === 'POST') return handleRevoke(request, env, session);
  if (pathname === '/admin/api/config' && request.method === 'POST') return handleConfig(request, env, session);
  if (pathname === '/admin/api/audit' && request.method === 'GET') return handleAudit(request, env);
  if (pathname.startsWith('/admin/api/export/') && request.method === 'GET') {
    return handleExport(env, pathname.slice('/admin/api/export/'.length));
  }
  return jsonResponse({ error: 'Not found.' }, 404);
}

/** GET /admin: render the console for a valid session, or start the login dance. */
async function handleAdminRoot(request: Request, env: Env): Promise<Response> {
  const key = env.COOKIE_ENCRYPTION_KEY ?? '';
  const cookie = readCookie(request, ADMIN_SESSION_COOKIE_NAME);
  const verified = await verifyAdminSession(cookie, key);
  if (!verified) return startAdminLogin(env);
  const nonce = randomToken(16);
  return htmlResponse(renderAdminPage(nonce, verified.session.csrf), nonce);
}

/** GET /admin/logout: clear the admin session and return to /admin. */
function handleLogout(): Response {
  const headers = new Headers(securityHeaders({ Location: '/admin' }));
  headers.append('Set-Cookie', buildAdminSessionClearCookie());
  return new Response(null, { status: 302, headers });
}

/** The entry point help-scout-handler delegates every /admin and /admin/api/* path to. */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/admin') {
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed.' }, 405);
    return handleAdminRoot(request, env);
  }
  if (pathname === '/admin/logout') {
    return handleLogout();
  }
  if (pathname.startsWith('/admin/api/')) {
    try {
      return await handleAdminApi(request, env, pathname);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Internal error.', code: 'INTERNAL' },
        500,
      );
    }
  }
  return noticePage('Admin', 'Not found', 'This admin page does not exist.', 404);
}
