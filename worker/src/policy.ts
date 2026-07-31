/**
 * Self-hosted access-policy engine for the Help Scout remote MCP worker (NAS-1501).
 *
 * This module is the single source of truth for two questions the worker asks on
 * the authorization boundary:
 *   1. May this Help Scout user connect at all (the /callback gate)?
 *   2. For an already-connected session, is the user still allowed, and which
 *      write operations may they execute (the McpAgent dispatch gate)?
 *
 * It is pure over two dependencies: the existing OAUTH_KV namespace (namespaced
 * away from the workers-oauth-provider library keys) and the provider's
 * OAuthHelpers surface (for grant revocation). The mutation functions
 * (putConfig, putUserPolicy, revokeUser) are the seams a future admin API
 * (NAS-1503) calls, and each accepts an optional audit hook so an audit trail
 * (NAS-1502) can be attached without touching call sites.
 *
 * KV layout (both documents live in OAUTH_KV):
 *   admin:config:v1        one deployment-wide config document
 *   policy:user:{hsUserId}  one document per Help Scout user id
 *
 * A missing admin:config document means all defaults (open mode): behavior is
 * byte-identical to a deployment with no policy layer configured. A missing
 * policy:user document means the user has no explicit entry (getUserPolicy
 * returns null), which is allowed in open mode and denied under allowlist mode.
 *
 * `userId` consistency: completeAuthorization stores the grant userId as
 * String(hsUserId) (help-scout-handler.ts), so this module keys policy documents
 * and lists/revokes grants by the same String(hsUserId).
 */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/** Current schema version of the admin config document. */
export const POLICY_CONFIG_SCHEMA_VERSION = 1 as const;

/** Current schema version of a per-user policy document. */
export const POLICY_USER_SCHEMA_VERSION = 1 as const;

/** The single admin config KV key. Exported so an admin API / harness can target it. */
export const ADMIN_CONFIG_KEY = 'admin:config:v1';

/** The KV key for one user's policy document. */
export function userPolicyKey(hsUserId: string | number): string {
  return `policy:user:${String(hsUserId)}`;
}

/** Default policy cache TTL, in seconds, when the config document is missing. */
export const DEFAULT_POLICY_CACHE_TTL_SECONDS = 45;

/** The TTL is clamped to this inclusive range on both read and write. */
export const MIN_POLICY_CACHE_TTL_SECONDS = 15;
export const MAX_POLICY_CACHE_TTL_SECONDS = 300;

function clampTtl(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_POLICY_CACHE_TTL_SECONDS;
  return Math.min(MAX_POLICY_CACHE_TTL_SECONDS, Math.max(MIN_POLICY_CACHE_TTL_SECONDS, Math.floor(value)));
}

/**
 * The deployment-wide policy configuration.
 *
 * `version` is an optimistic-concurrency counter: 0 for a document that has
 * never been written, incremented on every putConfig. `adminRole` is stored but
 * not enforced in this ticket (the admin API in NAS-1503 will enforce it).
 */
export interface AdminConfig {
  schemaVersion: typeof POLICY_CONFIG_SCHEMA_VERSION;
  allowlistMode: boolean;
  adminRole: 'owner' | 'administrator';
  policyCacheTtlSeconds: number;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

/**
 * One user's access policy.
 *
 * Invariant: customerVisibleWrites === true implies writes === true. It is
 * enforced when a document is written (a customer-visible grant raises writes)
 * and defensively when one is read (a stored document that violates it is read
 * down to least privilege).
 *
 * `email` is display-only. Lookups are always by hsUserId, never by email.
 */
export interface UserPolicy {
  v: typeof POLICY_USER_SCHEMA_VERSION;
  allowed: boolean;
  writes: boolean;
  customerVisibleWrites: boolean;
  email: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
}

/** The subset of the worker env the read/write policy functions need. */
export interface PolicyKvEnv {
  OAUTH_KV: KVNamespace;
}

/** revokeUser additionally needs the provider helpers to list and revoke grants. */
export interface PolicyRevokeEnv extends PolicyKvEnv {
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * A stale-version write. The admin API surfaces this as a 409 so the caller
 * re-reads and retries rather than clobbering a concurrent edit.
 */
export class PolicyConflictError extends Error {
  readonly code = 'POLICY_CONFLICT' as const;

  constructor(
    message: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(message);
    this.name = 'PolicyConflictError';
  }
}

/**
 * Audit seam for NAS-1502. Mutation functions call this after a successful
 * write; a no-op by default. Kept synchronous-or-async so an audit sink can
 * await a KV/queue write.
 */
export type PolicyAuditEvent =
  | { type: 'config.updated'; version: number; updatedBy: string; config: AdminConfig }
  | { type: 'user.policy.updated'; hsUserId: string; version: number; updatedBy: string; policy: UserPolicy }
  | { type: 'user.revoked'; hsUserId: string; grantsRevoked: number; updatedBy: string; policy: UserPolicy };

export type PolicyAuditHook = (event: PolicyAuditEvent) => void | Promise<void>;

interface MutationOptions {
  /** Optimistic-concurrency guard: the version the caller believes is current. */
  expectedVersion: number;
  /** Identity of the admin performing the change; stored for display/audit. */
  updatedBy: string;
  /** Optional audit sink (NAS-1502). */
  audit?: PolicyAuditHook;
}

// --- Config ---------------------------------------------------------------

const DEFAULT_CONFIG: AdminConfig = {
  schemaVersion: POLICY_CONFIG_SCHEMA_VERSION,
  allowlistMode: false,
  adminRole: 'owner',
  policyCacheTtlSeconds: DEFAULT_POLICY_CACHE_TTL_SECONDS,
  version: 0,
  updatedAt: '',
  updatedBy: '',
};

/** Coerce an untrusted stored config document into a well-formed AdminConfig. */
function normalizeConfig(raw: Partial<AdminConfig> | null | undefined): AdminConfig {
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    schemaVersion: POLICY_CONFIG_SCHEMA_VERSION,
    allowlistMode: raw.allowlistMode === true,
    adminRole: raw.adminRole === 'administrator' ? 'administrator' : 'owner',
    policyCacheTtlSeconds: clampTtl(
      typeof raw.policyCacheTtlSeconds === 'number' ? raw.policyCacheTtlSeconds : DEFAULT_POLICY_CACHE_TTL_SECONDS,
    ),
    version: typeof raw.version === 'number' && raw.version >= 0 ? Math.floor(raw.version) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : '',
  };
}

/**
 * Read the deployment config. A missing document is all defaults (open mode).
 * The TTL is clamped defensively here, so a hand-edited out-of-range value never
 * reaches the cache logic.
 */
export async function getConfig(env: PolicyKvEnv): Promise<AdminConfig> {
  const raw = (await env.OAUTH_KV.get(ADMIN_CONFIG_KEY, 'json')) as Partial<AdminConfig> | null;
  return normalizeConfig(raw);
}

/** The fields putConfig accepts. Omitted fields keep their current value. */
export interface ConfigPatch {
  allowlistMode?: boolean;
  adminRole?: 'owner' | 'administrator';
  policyCacheTtlSeconds?: number;
}

/**
 * Write the deployment config with a version check-and-increment. A stale
 * expectedVersion throws PolicyConflictError and writes nothing.
 */
export async function putConfig(env: PolicyKvEnv, patch: ConfigPatch, opts: MutationOptions): Promise<AdminConfig> {
  const current = await getConfig(env);
  if (current.version !== opts.expectedVersion) {
    throw new PolicyConflictError(
      `Config version conflict: expected ${opts.expectedVersion}, found ${current.version}. Re-read and retry.`,
      opts.expectedVersion,
      current.version,
    );
  }
  const next: AdminConfig = {
    schemaVersion: POLICY_CONFIG_SCHEMA_VERSION,
    allowlistMode: patch.allowlistMode ?? current.allowlistMode,
    adminRole: patch.adminRole ?? current.adminRole,
    policyCacheTtlSeconds: clampTtl(patch.policyCacheTtlSeconds ?? current.policyCacheTtlSeconds),
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: opts.updatedBy,
  };
  await env.OAUTH_KV.put(ADMIN_CONFIG_KEY, JSON.stringify(next));
  await opts.audit?.({ type: 'config.updated', version: next.version, updatedBy: opts.updatedBy, config: next });
  return next;
}

// --- User policy ----------------------------------------------------------

/**
 * Coerce an untrusted stored user document into a well-formed UserPolicy,
 * enforcing the customerVisibleWrites => writes invariant down to least
 * privilege: a stored document with customerVisibleWrites true but writes false
 * is read with customerVisibleWrites dropped to false.
 */
function normalizeUserPolicy(raw: Partial<UserPolicy>): UserPolicy {
  const writes = raw.writes === true;
  const customerVisibleWrites = writes && raw.customerVisibleWrites === true;
  return {
    v: POLICY_USER_SCHEMA_VERSION,
    allowed: raw.allowed === true,
    writes,
    customerVisibleWrites,
    email: typeof raw.email === 'string' ? raw.email : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : '',
    version: typeof raw.version === 'number' && raw.version >= 0 ? Math.floor(raw.version) : 0,
  };
}

/** Read one user's policy, or null when the user has no explicit entry. */
export async function getUserPolicy(env: PolicyKvEnv, hsUserId: string | number): Promise<UserPolicy | null> {
  const raw = (await env.OAUTH_KV.get(userPolicyKey(hsUserId), 'json')) as Partial<UserPolicy> | null;
  if (!raw) return null;
  return normalizeUserPolicy(raw);
}

/** The fields putUserPolicy accepts. */
export interface UserPolicyInput {
  allowed: boolean;
  writes: boolean;
  customerVisibleWrites: boolean;
  /** Display-only. Preserved from the current document when omitted. */
  email?: string;
}

/**
 * Write one user's policy with a version check-and-increment, enforcing the
 * customerVisibleWrites => writes invariant (a customer-visible grant raises
 * writes to true). A stale expectedVersion throws PolicyConflictError.
 */
export async function putUserPolicy(
  env: PolicyKvEnv,
  hsUserId: string | number,
  input: UserPolicyInput,
  opts: MutationOptions,
): Promise<UserPolicy> {
  const id = String(hsUserId);
  const current = await getUserPolicy(env, id);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== opts.expectedVersion) {
    throw new PolicyConflictError(
      `User policy version conflict for ${id}: expected ${opts.expectedVersion}, found ${currentVersion}. Re-read and retry.`,
      opts.expectedVersion,
      currentVersion,
    );
  }
  const customerVisibleWrites = input.customerVisibleWrites === true;
  const writes = customerVisibleWrites || input.writes === true;
  const next: UserPolicy = {
    v: POLICY_USER_SCHEMA_VERSION,
    allowed: input.allowed === true,
    writes,
    customerVisibleWrites,
    email: input.email ?? current?.email ?? '',
    updatedAt: new Date().toISOString(),
    updatedBy: opts.updatedBy,
    version: currentVersion + 1,
  };
  await env.OAUTH_KV.put(userPolicyKey(id), JSON.stringify(next));
  await opts.audit?.({ type: 'user.policy.updated', hsUserId: id, version: next.version, updatedBy: opts.updatedBy, policy: next });
  return next;
}

/** Result of a revokeUser call. */
export interface RevokeUserResult {
  hsUserId: string;
  grantsRevoked: number;
  policy: UserPolicy;
}

/**
 * Hard-revoke a user: revoke every OAuth grant the provider holds for them, then
 * pin their policy to allowed:false (writes off). Listing is paged in case a
 * user holds many grants. The policy write retries on a version conflict because
 * a revoke is authoritative and must win over a concurrent edit.
 *
 * The two effects are complementary: revoking grants invalidates every live
 * access token immediately (the next /mcp request fails auth at the library
 * layer), and allowed:false denies any re-connection attempt and any session
 * that is serving reads from an unexpired policy cache once that cache lapses.
 */
export async function revokeUser(
  env: PolicyRevokeEnv,
  hsUserId: string | number,
  opts: { updatedBy: string; audit?: PolicyAuditHook },
): Promise<RevokeUserResult> {
  const id = String(hsUserId);

  let grantsRevoked = 0;
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(id, cursor ? { cursor } : undefined);
    for (const grant of page.items) {
      await env.OAUTH_PROVIDER.revokeGrant(grant.id, id);
      grantsRevoked += 1;
    }
    cursor = page.cursor;
  } while (cursor);

  // Pin allowed:false. Retry the version-checked write on conflict so the revoke
  // is not lost to a racing admin edit; the audit hook fires only for the write
  // that actually lands.
  let policy: UserPolicy | undefined;
  for (let attempt = 0; attempt < 3 && !policy; attempt += 1) {
    const current = await getUserPolicy(env, id);
    try {
      policy = await putUserPolicy(
        env,
        id,
        { allowed: false, writes: false, customerVisibleWrites: false, email: current?.email },
        { expectedVersion: current?.version ?? 0, updatedBy: opts.updatedBy },
      );
    } catch (error) {
      if (error instanceof PolicyConflictError && attempt < 2) continue;
      throw error;
    }
  }

  const settled = policy as UserPolicy;
  await opts.audit?.({ type: 'user.revoked', hsUserId: id, grantsRevoked, updatedBy: opts.updatedBy, policy: settled });
  return { hsUserId: id, grantsRevoked, policy: settled };
}

// --- Pure decision helpers ------------------------------------------------

export interface AccessDecision {
  allowed: boolean;
  /** Why access was denied, for logging and error copy. Absent when allowed. */
  reason?: 'explicit-block' | 'allowlist';
}

/**
 * The access rule, in one place so /callback and the DO dispatch gate agree:
 *   - An explicit allowed:false blocks, even in open mode.
 *   - Under allowlist mode, only an explicit allowed:true admits; a missing
 *     entry is denied.
 *   - Otherwise (open mode, no explicit block) access is allowed.
 */
export function evaluateAccess(config: AdminConfig, userPolicy: UserPolicy | null): AccessDecision {
  if (userPolicy && userPolicy.allowed === false) {
    return { allowed: false, reason: 'explicit-block' };
  }
  if (config.allowlistMode && !(userPolicy && userPolicy.allowed === true)) {
    return { allowed: false, reason: 'allowlist' };
  }
  return { allowed: true };
}

/** The deployment write ceiling (the env gates), and the effective per-user flags. */
export interface WriteFlagSet {
  enabled: boolean;
  customerVisibleEnabled: boolean;
}

/**
 * Effective write flags = the deployment ceiling AND the user's grants.
 *
 * A user with no policy document (open mode) inherits the ceiling unchanged, so
 * a deployment that turns writes on at the env level keeps working for everyone
 * exactly as it did before the policy layer existed. A user with a document is
 * narrowed: writes only when both the ceiling and their `writes` allow it, and
 * customer-visible only when the ceiling, their `writes`, and their
 * `customerVisibleWrites` all allow it.
 */
export function effectiveWriteFlags(ceiling: WriteFlagSet, userPolicy: UserPolicy | null): WriteFlagSet {
  if (!userPolicy) {
    return { enabled: ceiling.enabled, customerVisibleEnabled: ceiling.customerVisibleEnabled };
  }
  const enabled = ceiling.enabled && userPolicy.writes === true;
  const customerVisibleEnabled = enabled && ceiling.customerVisibleEnabled && userPolicy.customerVisibleWrites === true;
  return { enabled, customerVisibleEnabled };
}
