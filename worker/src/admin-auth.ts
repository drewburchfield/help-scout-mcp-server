/**
 * Pure authorization logic for the self-hosted admin surface (NAS-1503).
 *
 * This module owns everything the admin surface can decide WITHOUT the Workers
 * runtime, so the root unit suite can drive it directly against injected inputs:
 *   - the admin session + login-state signed cookies (reusing the tested HMAC
 *     envelope from oauth-cookie.ts, so there is ONE signing primitive);
 *   - the CSRF token check;
 *   - the role gate (which Help Scout role may administer, given config.adminRole);
 *   - the write-tier ceiling cap and the tier<->policy mapping;
 *   - the roster merge (Help Scout directory + policy docs + grant state).
 *
 * The admin session is deliberately NOT the MCP OAuth token. An admin logs in
 * through the same Help Scout Authorization Code dance the consent flow uses, but
 * the resulting credential is a short-lived signed cookie this surface owns. The
 * cookie carries only identity + role + a CSRF token; it holds no Help Scout
 * token (the login fetches the roster directory once and caches it).
 */
import {
  signConsentCookie,
  verifyConsentCookie,
} from './oauth-cookie.js';
import {
  evaluateAccess,
  effectiveWriteFlags,
  type AdminConfig,
  type DirectoryUser,
  type HelpScoutRole,
  type UserPolicy,
  type WriteFlagSet,
} from './policy.js';

// --- Cookies ---------------------------------------------------------------

/** The admin session cookie. Scoped to /admin so it never rides other routes. */
export const ADMIN_SESSION_COOKIE_NAME = 'hs_admin_session';

/** The transient admin-login state cookie (the OAuth CSRF nonce for the dance). */
export const ADMIN_STATE_COOKIE_NAME = 'hs_admin_state';

/** Admin sessions live 8 hours: long enough for real work, short enough to bound a stolen cookie. */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** The admin-login state cookie lives 10 minutes, like the consent transaction. */
export const ADMIN_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The identity + CSRF token carried in the signed admin session cookie. `role`
 * is the Help Scout role captured at login and is display/short-circuit only:
 * the config admin-role gate is re-evaluated on every request, so a role cached
 * here can never widen access beyond what the live config allows.
 */
export interface AdminSession {
  hsUserId: string;
  email: string;
  role: HelpScoutRole;
  /** Per-session CSRF token, embedded in the page and required on every mutation. */
  csrf: string;
}

/** Sign an admin session into a cookie value with the given absolute expiry (epoch ms). */
export async function signAdminSession(session: AdminSession, exp: number, secret: string): Promise<string> {
  return signConsentCookie({ oauthReq: session, exp }, secret);
}

/** Verify + decode an admin session cookie. Returns null on any failure (missing, tampered, expired). */
export async function verifyAdminSession(
  value: string | undefined,
  secret: string,
): Promise<{ session: AdminSession; exp: number } | null> {
  const txn = await verifyConsentCookie<AdminSession>(value, secret);
  if (!txn) return null;
  const s = txn.oauthReq;
  // Defensive shape check: a decoded-but-malformed payload must not be trusted.
  if (!s || typeof s.hsUserId !== 'string' || typeof s.csrf !== 'string' || s.csrf.length === 0) return null;
  return { session: s, exp: txn.exp };
}

/** Sign the admin-login state nonce into the transient state cookie. */
export async function signAdminState(state: string, exp: number, secret: string): Promise<string> {
  return signConsentCookie({ oauthReq: {}, state, exp }, secret);
}

/** Verify the admin-login state cookie and return the bound state nonce, or null. */
export async function verifyAdminState(value: string | undefined, secret: string): Promise<string | null> {
  const txn = await verifyConsentCookie(value, secret);
  if (!txn || typeof txn.state !== 'string' || txn.state.length === 0) return null;
  return txn.state;
}

/** Build the Set-Cookie header for the admin session (HttpOnly, Secure, Lax, /admin-scoped). */
export function buildAdminSessionSetCookie(value: string): string {
  const maxAge = Math.floor(ADMIN_SESSION_TTL_MS / 1000);
  return `${ADMIN_SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${maxAge}`;
}

/** Clear the admin session cookie. */
export function buildAdminSessionClearCookie(): string {
  return `${ADMIN_SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`;
}

/**
 * Build the Set-Cookie for the transient login-state cookie. Path=/ so it is
 * sent on the Help Scout redirect back to /callback (which is outside /admin).
 */
export function buildAdminStateSetCookie(value: string): string {
  const maxAge = Math.floor(ADMIN_STATE_TTL_MS / 1000);
  return `${ADMIN_STATE_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Clear the transient login-state cookie. */
export function buildAdminStateClearCookie(): string {
  return `${ADMIN_STATE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// --- CSRF ------------------------------------------------------------------

/** A random, URL-safe token (used for CSRF and the login state nonce). */
export function randomToken(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Constant-time-ish string equality for the CSRF check: length-independent
 * short-circuit avoided by folding every character. Both values must be present
 * and equal; an empty submitted token never matches.
 */
export function csrfTokensMatch(sessionToken: string, submitted: string | null | undefined): boolean {
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) return false;
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  if (sessionToken.length !== submitted.length) return false;
  let diff = 0;
  for (let i = 0; i < sessionToken.length; i++) {
    diff |= sessionToken.charCodeAt(i) ^ submitted.charCodeAt(i);
  }
  return diff === 0;
}

// --- Role gate -------------------------------------------------------------

/**
 * Whether a Help Scout role may administer this deployment under the current
 * config. An Owner always may. An Administrator may only when the deployment's
 * adminRole is set to 'administrator'. Everyone else (User, Light) never may.
 *
 * This is re-evaluated on EVERY admin request against the LIVE config, so an
 * admin demoted by lowering config.adminRole from 'administrator' to 'owner'
 * loses access on their next request even though their session cookie still
 * says 'Administrator'.
 */
export function roleSatisfiesAdmin(role: HelpScoutRole, adminRole: AdminConfig['adminRole']): boolean {
  if (role === 'Owner') return true;
  if (role === 'Administrator') return adminRole === 'administrator';
  return false;
}

/** Parse an untrusted Help Scout role/type into the roles the admin surface knows. */
export function parseHelpScoutRole(role: unknown, type?: unknown): HelpScoutRole {
  const r = typeof role === 'string' ? role.toLowerCase() : '';
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (r === 'light' || t === 'light') return 'Light';
  if (r.includes('owner')) return 'Owner';
  if (r.includes('admin')) return 'Administrator';
  return 'User';
}

// --- Write tiers -----------------------------------------------------------

/** The three write tiers the per-user control exposes. */
export type WriteTier = 'none' | 'writes' | 'writes+customerVisible';

/** The tier a stored policy grants (before intersecting with the deployment ceiling). */
export function tierFromPolicy(policy: UserPolicy | null): WriteTier {
  if (!policy || !policy.writes) return 'none';
  return policy.customerVisibleWrites ? 'writes+customerVisible' : 'writes';
}

/** The highest tier the deployment ceiling permits granting. Above it the control is greyed. */
export function ceilingTierCap(ceiling: WriteFlagSet): WriteTier {
  if (!ceiling.enabled) return 'none';
  return ceiling.customerVisibleEnabled ? 'writes+customerVisible' : 'writes';
}

const TIER_RANK: Record<WriteTier, number> = { none: 0, writes: 1, 'writes+customerVisible': 2 };

/** Whether `tier` is within the deployment ceiling cap (fail-closed server-side check). */
export function tierWithinCeiling(tier: WriteTier, ceiling: WriteFlagSet): boolean {
  return TIER_RANK[tier] <= TIER_RANK[ceilingTierCap(ceiling)];
}

/** Map a desired allowed + tier into the UserPolicyInput the policy store accepts. */
export function policyInputFromTier(
  allowed: boolean,
  tier: WriteTier,
  email?: string,
): { allowed: boolean; writes: boolean; customerVisibleWrites: boolean; email?: string } {
  return {
    allowed,
    writes: tier !== 'none',
    customerVisibleWrites: tier === 'writes+customerVisible',
    email,
  };
}

// --- Roster merge ----------------------------------------------------------

/** Where a user sits in the access policy, for display. */
export type PolicyState = 'open-default' | 'explicitly-allowed' | 'blocked';

/** One roster row: a Help Scout user merged with policy + grant state. */
export interface RosterRow {
  hsUserId: string;
  email: string;
  name: string;
  role: HelpScoutRole;
  /** Light users 403 the Mailbox API, so they can never use the connector. */
  eligible: boolean;
  policyState: PolicyState;
  /** The configured write tier (from the policy doc, or the ceiling for open-default users). */
  writeTier: WriteTier;
  /** The tier actually in force after intersecting the grant with the ceiling. */
  effectiveWriteTier: WriteTier;
  /** Admission decision under the current config (allowlist mode + explicit block). */
  effectiveAllowed: boolean;
  connected: boolean;
  hasPolicy: boolean;
  /** Policy doc version, for the optimistic-concurrency guard on a write (0 = no doc). */
  version: number;
  updatedAt: string;
  updatedBy: string;
}

function effectiveTier(ceiling: WriteFlagSet, policy: UserPolicy | null): WriteTier {
  const flags = effectiveWriteFlags(ceiling, policy);
  if (!flags.enabled) return 'none';
  return flags.customerVisibleEnabled ? 'writes+customerVisible' : 'writes';
}

function policyState(policy: UserPolicy | null): PolicyState {
  if (!policy) return 'open-default';
  if (!policy.allowed) return 'blocked';
  return 'explicitly-allowed';
}

/**
 * Merge the cached Help Scout directory with the live policy documents and grant
 * state into roster rows. A user with no policy document is open-default (and
 * inherits the ceiling as their write tier); a policy document narrows both
 * admission and the write tier. Light users are flagged ineligible. Sorted by
 * email for a stable, human-scannable roster.
 */
export function buildRoster(
  directory: DirectoryUser[],
  policies: Map<string, UserPolicy>,
  connectedIds: Set<string>,
  config: AdminConfig,
  ceiling: WriteFlagSet,
): RosterRow[] {
  const rows = directory.map((user): RosterRow => {
    const policy = policies.get(user.hsUserId) ?? null;
    const configuredTier = policy ? tierFromPolicy(policy) : ceilingTierCap(ceiling);
    return {
      hsUserId: user.hsUserId,
      email: user.email,
      name: user.name,
      role: user.role,
      eligible: user.role !== 'Light',
      policyState: policyState(policy),
      writeTier: configuredTier,
      effectiveWriteTier: effectiveTier(ceiling, policy),
      effectiveAllowed: evaluateAccess(config, policy).allowed,
      connected: connectedIds.has(user.hsUserId),
      hasPolicy: policy !== null,
      version: policy?.version ?? 0,
      updatedAt: policy?.updatedAt ?? '',
      updatedBy: policy?.updatedBy ?? '',
    };
  });
  return rows.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}
