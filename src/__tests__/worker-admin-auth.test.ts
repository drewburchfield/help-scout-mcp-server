/**
 * Unit coverage for the admin surface's pure authorization logic (NAS-1503).
 *
 * The highest-value pieces are exercised here in CI against injected inputs: the
 * role gate (which decides whether a demoted admin keeps access), the CSRF check,
 * the signed admin session round-trip, and the roster merge + write-tier ceiling
 * logic. The HTTP wiring and the full admin login are exercised by the worker
 * smoke suite, which drives the real handler and coordinator DO.
 */
import {
  ADMIN_SESSION_COOKIE_NAME,
  buildAdminSessionSetCookie,
  buildRoster,
  ceilingTierCap,
  csrfTokensMatch,
  parseHelpScoutRole,
  policyInputFromTier,
  roleSatisfiesAdmin,
  signAdminSession,
  signAdminState,
  tierFromPolicy,
  tierWithinCeiling,
  verifyAdminSession,
  verifyAdminState,
  type AdminSession,
} from '../../worker/src/admin-auth.js';
import type { AdminConfig, DirectoryUser, UserPolicy, WriteFlagSet } from '../../worker/src/policy.js';

const SECRET = 'admin-cookie-signing-secret-for-tests';

const config = (over: Partial<AdminConfig> = {}): AdminConfig => ({
  schemaVersion: 1,
  allowlistMode: false,
  adminRole: 'owner',
  policyCacheTtlSeconds: 45,
  version: 3,
  updatedAt: '2026-07-31T00:00:00Z',
  updatedBy: 'admin',
  ...over,
});

const policy = (over: Partial<UserPolicy> = {}): UserPolicy => ({
  v: 1,
  allowed: true,
  writes: false,
  customerVisibleWrites: false,
  email: 'user@example.test',
  updatedAt: '2026-07-31T00:00:00Z',
  updatedBy: 'admin',
  version: 1,
  ...over,
});

const session = (over: Partial<AdminSession> = {}): AdminSession => ({
  hsUserId: '987',
  email: 'owner@example.test',
  role: 'Owner',
  csrf: 'csrf-token-abc',
  ...over,
});

describe('roleSatisfiesAdmin (the demotion gate)', () => {
  it('always admits an Owner', () => {
    expect(roleSatisfiesAdmin('Owner', 'owner')).toBe(true);
    expect(roleSatisfiesAdmin('Owner', 'administrator')).toBe(true);
  });

  it('admits an Administrator only when the config opens the role to administrators', () => {
    expect(roleSatisfiesAdmin('Administrator', 'administrator')).toBe(true);
    // The demotion case: an Administrator loses access the moment adminRole drops to owner.
    expect(roleSatisfiesAdmin('Administrator', 'owner')).toBe(false);
  });

  it('never admits a plain User or a Light user', () => {
    expect(roleSatisfiesAdmin('User', 'administrator')).toBe(false);
    expect(roleSatisfiesAdmin('Light', 'administrator')).toBe(false);
  });
});

describe('csrfTokensMatch', () => {
  it('matches only an exact, non-empty pair', () => {
    expect(csrfTokensMatch('abc123', 'abc123')).toBe(true);
    expect(csrfTokensMatch('abc123', 'abc124')).toBe(false);
    expect(csrfTokensMatch('abc123', 'abc12')).toBe(false);
  });

  it('rejects a missing or empty submitted token', () => {
    expect(csrfTokensMatch('abc123', null)).toBe(false);
    expect(csrfTokensMatch('abc123', undefined)).toBe(false);
    expect(csrfTokensMatch('abc123', '')).toBe(false);
    expect(csrfTokensMatch('', 'abc123')).toBe(false);
  });
});

describe('admin session cookie', () => {
  it('round-trips a session and its expiry', async () => {
    const exp = Date.now() + 60_000;
    const cookie = await signAdminSession(session(), exp, SECRET);
    const decoded = await verifyAdminSession(cookie, SECRET);
    expect(decoded?.session).toEqual(session());
    expect(decoded?.exp).toBe(exp);
  });

  it('rejects a session signed with a different secret', async () => {
    const cookie = await signAdminSession(session(), Date.now() + 60_000, 'other-secret');
    expect(await verifyAdminSession(cookie, SECRET)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const cookie = await signAdminSession(session(), Date.now() - 1, SECRET);
    expect(await verifyAdminSession(cookie, SECRET)).toBeNull();
  });

  it('rejects a decoded-but-malformed payload (no csrf)', async () => {
    // Sign a session missing its csrf and confirm the shape guard refuses it.
    const bad = await signAdminSession({ hsUserId: '1', email: 'x', role: 'Owner', csrf: '' } as AdminSession, Date.now() + 60_000, SECRET);
    expect(await verifyAdminSession(bad, SECRET)).toBeNull();
  });

  it('mints an HttpOnly, Secure, Lax, /admin-scoped cookie', () => {
    const header = buildAdminSessionSetCookie('value');
    expect(header).toContain(`${ADMIN_SESSION_COOKIE_NAME}=value`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/admin');
  });
});

describe('admin login state cookie', () => {
  it('round-trips the bound state nonce', async () => {
    const cookie = await signAdminState('state-nonce-1', Date.now() + 60_000, SECRET);
    expect(await verifyAdminState(cookie, SECRET)).toBe('state-nonce-1');
  });

  it('rejects a tampered or expired state cookie', async () => {
    expect(await verifyAdminState(await signAdminState('s', Date.now() - 1, SECRET), SECRET)).toBeNull();
    expect(await verifyAdminState('garbage', SECRET)).toBeNull();
    expect(await verifyAdminState(undefined, SECRET)).toBeNull();
  });
});

describe('parseHelpScoutRole', () => {
  it('maps role/type strings case-insensitively', () => {
    expect(parseHelpScoutRole('Owner')).toBe('Owner');
    expect(parseHelpScoutRole('administrator')).toBe('Administrator');
    expect(parseHelpScoutRole('admin')).toBe('Administrator');
    expect(parseHelpScoutRole('user')).toBe('User');
    expect(parseHelpScoutRole('user', 'light')).toBe('Light');
    expect(parseHelpScoutRole('light')).toBe('Light');
    expect(parseHelpScoutRole(undefined)).toBe('User');
  });
});

describe('write-tier ceiling logic', () => {
  it('derives the tier a policy grants', () => {
    expect(tierFromPolicy(null)).toBe('none');
    expect(tierFromPolicy(policy())).toBe('none');
    expect(tierFromPolicy(policy({ writes: true }))).toBe('writes');
    expect(tierFromPolicy(policy({ writes: true, customerVisibleWrites: true }))).toBe('writes+customerVisible');
  });

  it('caps the grantable tier at the deployment ceiling', () => {
    expect(ceilingTierCap({ enabled: false, customerVisibleEnabled: false })).toBe('none');
    expect(ceilingTierCap({ enabled: true, customerVisibleEnabled: false })).toBe('writes');
    expect(ceilingTierCap({ enabled: true, customerVisibleEnabled: true })).toBe('writes+customerVisible');
  });

  it('rejects a tier above the ceiling (fail closed)', () => {
    const writesOnly: WriteFlagSet = { enabled: true, customerVisibleEnabled: false };
    expect(tierWithinCeiling('writes', writesOnly)).toBe(true);
    expect(tierWithinCeiling('writes+customerVisible', writesOnly)).toBe(false);
    const readOnly: WriteFlagSet = { enabled: false, customerVisibleEnabled: false };
    expect(tierWithinCeiling('writes', readOnly)).toBe(false);
  });

  it('maps a tier back into a policy input, raising writes for customer-visible', () => {
    expect(policyInputFromTier(true, 'none')).toEqual({ allowed: true, writes: false, customerVisibleWrites: false, email: undefined });
    expect(policyInputFromTier(true, 'writes')).toEqual({ allowed: true, writes: true, customerVisibleWrites: false, email: undefined });
    expect(policyInputFromTier(false, 'writes+customerVisible')).toEqual({ allowed: false, writes: true, customerVisibleWrites: true, email: undefined });
  });
});

describe('buildRoster merge', () => {
  const directory: DirectoryUser[] = [
    { hsUserId: '10', email: 'owner@example.test', name: 'Owner One', role: 'Owner' },
    { hsUserId: '20', email: 'blocked@example.test', name: 'Blocked Two', role: 'User' },
    { hsUserId: '30', email: 'light@example.test', name: 'Light Three', role: 'Light' },
    { hsUserId: '40', email: 'writer@example.test', name: 'Writer Four', role: 'User' },
  ];
  const ceiling: WriteFlagSet = { enabled: true, customerVisibleEnabled: false };

  it('merges policy + grant state, flags light users, and sorts by email', () => {
    const policies = new Map<string, UserPolicy>([
      ['20', policy({ allowed: false, version: 2 })],
      ['40', policy({ allowed: true, writes: true, customerVisibleWrites: true, version: 5 })],
    ]);
    const connected = new Set<string>(['10']);
    const rows = buildRoster(directory, policies, connected, config(), ceiling);

    // Sorted by email: blocked, light, owner, writer.
    expect(rows.map((r) => r.hsUserId)).toEqual(['20', '30', '10', '40']);

    const owner = rows.find((r) => r.hsUserId === '10')!;
    expect(owner.policyState).toBe('open-default');
    expect(owner.connected).toBe(true);
    expect(owner.writeTier).toBe('writes'); // open-default inherits the ceiling cap
    expect(owner.version).toBe(0);

    const blocked = rows.find((r) => r.hsUserId === '20')!;
    expect(blocked.policyState).toBe('blocked');
    expect(blocked.effectiveAllowed).toBe(false);
    expect(blocked.version).toBe(2);

    const light = rows.find((r) => r.hsUserId === '30')!;
    expect(light.eligible).toBe(false);

    // Writer granted customer-visible, but the ceiling withholds it: configured
    // tier reflects the grant, effective tier is narrowed to the ceiling.
    const writer = rows.find((r) => r.hsUserId === '40')!;
    expect(writer.writeTier).toBe('writes+customerVisible');
    expect(writer.effectiveWriteTier).toBe('writes');
    expect(writer.hasPolicy).toBe(true);
  });

  it('reflects allowlist admission in effectiveAllowed', () => {
    const rows = buildRoster(directory, new Map(), new Set(), config({ allowlistMode: true }), ceiling);
    // In allowlist mode, an unconfigured user is not admitted.
    expect(rows.every((r) => r.effectiveAllowed === false)).toBe(true);
  });
});
