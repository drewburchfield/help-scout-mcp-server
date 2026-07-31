/**
 * Self-hosted access-policy engine for the Help Scout remote MCP worker (NAS-1501).
 *
 * This module is the single source of truth for two questions the worker asks on
 * the authorization boundary:
 *   1. May this Help Scout user connect at all (the /callback gate)?
 *   2. For an already-connected session, is the user still allowed, and which
 *      write operations may they execute (the McpAgent dispatch gate)?
 *
 * It is pure and storage-agnostic. The documents themselves live in ONE
 * per-deployment coordinator Durable Object (policy-coordinator.ts); this module
 * owns the DECISION logic (evaluateAccess / effectiveWriteFlags), the document
 * schema and its fail-closed normalization, and the storage-injectable CAS core
 * (readConfigDoc / writeConfigDoc / readUserPolicyDoc / writeUserPolicyDoc /
 * pinUserPolicyRevoked). The core runs over a minimal transactional-storage
 * interface (PolicyStorage), so the coordinator wires it to its own
 * ctx.storage and the unit suite wires it to an in-memory transactional fake.
 *
 * The env-facing entry points callers actually invoke (getConfig, putConfig,
 * getUserPolicy, putUserPolicy, deleteConfig, deleteUserPolicy, revokeUser) live
 * in policy-store.ts, which RPCs the coordinator; keeping them there keeps THIS
 * module free of any ambient Workers runtime types so the root unit suite can
 * type-check and exercise the core directly.
 *
 * Document layout (both live in the coordinator DO's transactional storage):
 *   admin:config:v1        one deployment-wide config document
 *   policy:user:{hsUserId}  one document per Help Scout user id
 *
 * A missing admin:config document means all defaults (open mode): behavior is
 * byte-identical to a deployment with no policy layer configured. A missing
 * policy:user document means the user has no explicit entry (read as null),
 * which is allowed in open mode and denied under allowlist mode.
 *
 * `userId` consistency: completeAuthorization stores the grant userId as
 * String(hsUserId) (help-scout-handler.ts), so this module keys policy documents
 * and lists/revokes grants by the same String(hsUserId).
 */

/** Current schema version of the admin config document. */
export const POLICY_CONFIG_SCHEMA_VERSION = 1 as const;

/** Current schema version of a per-user policy document. */
export const POLICY_USER_SCHEMA_VERSION = 1 as const;

/** The single admin config storage key. Exported so an admin API / harness can target it. */
export const ADMIN_CONFIG_KEY = 'admin:config:v1';

/**
 * The fixed name every worker request resolves the coordinator DO by
 * (idFromName), so all reads and writes across the deployment hit the ONE
 * instance whose single-threaded storage gives strongly-consistent reads and
 * atomic compare-and-swap writes.
 */
export const POLICY_COORDINATOR_NAME = 'policy-coordinator';

/** The storage key for one user's policy document. */
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

/**
 * The minimal transactional key-value storage the CAS core runs over.
 *
 * `transaction` runs its closure as an atomic, isolated unit: concurrent
 * transactions on the same storage are serialized, so a read-modify-write inside
 * one sees a consistent snapshot and its write cannot be lost to a racing
 * transaction. The coordinator DO satisfies this with its own ctx.storage (a
 * single-threaded, input-gated Durable Object); the unit suite satisfies it with
 * an in-memory transactional fake. The core is written so the read and the write
 * of each mutation sit inside one such closure, which is what makes the
 * version check-and-increment an atomic compare-and-swap.
 */
export interface PolicyStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  transaction<T>(closure: () => Promise<T>): Promise<T>;
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
 * A stored config document this build cannot interpret. This is an
 * authorization boundary, so an unsupported or malformed document must fail
 * closed (callers surface it as policy-unavailable) rather than silently
 * normalize into open mode: a future-schema document that meant allowlist
 * must never admit everyone.
 */
export class PolicyInvalidError extends Error {
  readonly code = 'POLICY_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PolicyInvalidError';
  }
}

/**
 * Audit seam for NAS-1502. The env-facing mutation functions (policy-store.ts)
 * call this after a successful write; a no-op by default. Kept synchronous-or-
 * async so an audit sink can await a KV/queue write. It stays worker-side (not
 * inside the coordinator) because a real sink is worker infrastructure and an
 * audit hook is a function, which cannot cross the DO RPC boundary.
 */
export type PolicyAuditEvent =
  | { type: 'config.updated'; version: number; updatedBy: string; config: AdminConfig }
  | { type: 'user.policy.updated'; hsUserId: string; version: number; updatedBy: string; policy: UserPolicy }
  | { type: 'user.revoked'; hsUserId: string; grantsRevoked: number; updatedBy: string; policy: UserPolicy };

export type PolicyAuditHook = (event: PolicyAuditEvent) => void | Promise<void>;

/** The version guard + identity a mutation carries across the DO boundary (audit-free). */
export interface MutationMeta {
  /** Optimistic-concurrency guard: the version the caller believes is current. */
  expectedVersion: number;
  /** Identity of the admin performing the change; stored for display/audit. */
  updatedBy: string;
}

/** What the env-facing mutation functions accept: a MutationMeta plus the audit sink. */
export interface MutationOptions extends MutationMeta {
  /** Optional audit sink (NAS-1502). Fired worker-side after the DO confirms the write. */
  audit?: PolicyAuditHook;
}

// --- Cross-boundary result envelopes --------------------------------------
//
// The coordinator DO cannot throw a typed PolicyConflictError/PolicyInvalidError
// across the RPC boundary and have `instanceof` survive, so its methods return a
// discriminated envelope and policy-store.ts reconstructs the real error class.
// Callers therefore keep seeing the exact same thrown types they did under KV.

/** A policy error flattened for transport across the DO boundary. */
export type PolicyErrorEnvelope =
  | { kind: 'conflict'; message: string; expectedVersion: number; currentVersion: number }
  | { kind: 'invalid'; message: string };

/** Coordinator read/write result for the config document. */
export type ConfigDocResult = { ok: true; value: AdminConfig } | { ok: false; error: PolicyErrorEnvelope };

/** Coordinator read result for a user document (value is null when there is no entry). */
export type UserPolicyDocResult = { ok: true; value: UserPolicy | null } | { ok: false; error: PolicyErrorEnvelope };

/** Coordinator write result for a user document (a write always yields a document). */
export type UserPolicyWriteResult = { ok: true; value: UserPolicy } | { ok: false; error: PolicyErrorEnvelope };

/** Flatten a known policy error for transport, or null for an unexpected (e.g. storage) error. */
export function toPolicyErrorEnvelope(error: unknown): PolicyErrorEnvelope | null {
  if (error instanceof PolicyConflictError) {
    return {
      kind: 'conflict',
      message: error.message,
      expectedVersion: error.expectedVersion,
      currentVersion: error.currentVersion,
    };
  }
  if (error instanceof PolicyInvalidError) {
    return { kind: 'invalid', message: error.message };
  }
  return null;
}

/** Rebuild and throw the real error class from a transported envelope. */
export function throwPolicyError(envelope: PolicyErrorEnvelope): never {
  if (envelope.kind === 'conflict') {
    throw new PolicyConflictError(envelope.message, envelope.expectedVersion, envelope.currentVersion);
  }
  throw new PolicyInvalidError(envelope.message);
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

/**
 * Coerce an untrusted stored config document into a well-formed AdminConfig.
 * Only a genuinely MISSING document means defaults (open mode). A present
 * document must carry the supported schema version and a boolean
 * allowlistMode; anything else throws PolicyInvalidError.
 */
function normalizeConfig(raw: Partial<AdminConfig> | null | undefined): AdminConfig {
  if (!raw) return { ...DEFAULT_CONFIG };
  if (raw.schemaVersion !== POLICY_CONFIG_SCHEMA_VERSION) {
    throw new PolicyInvalidError(
      `Unsupported admin config schemaVersion ${String(raw.schemaVersion)}; this build supports ${POLICY_CONFIG_SCHEMA_VERSION}.`,
    );
  }
  if (typeof raw.allowlistMode !== 'boolean') {
    throw new PolicyInvalidError('Malformed admin config: allowlistMode must be a boolean.');
  }
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

/** The fields putConfig accepts. Omitted fields keep their current value. */
export interface ConfigPatch {
  allowlistMode?: boolean;
  adminRole?: 'owner' | 'administrator';
  policyCacheTtlSeconds?: number;
}

/**
 * Read the deployment config from strongly-consistent storage. A missing
 * document is all defaults (open mode). The TTL is clamped defensively here, so
 * a hand-edited out-of-range value never reaches the cache logic.
 */
export async function readConfigDoc(storage: PolicyStorage): Promise<AdminConfig> {
  const raw = await storage.get<Partial<AdminConfig>>(ADMIN_CONFIG_KEY);
  return normalizeConfig(raw ?? null);
}

/**
 * Write the deployment config with an atomic version check-and-increment. The
 * whole read-compare-write runs inside one storage transaction, so two
 * concurrent writers presenting the same expectedVersion cannot both win: the
 * one that commits second reads the first's incremented version and throws
 * PolicyConflictError. A stale expectedVersion writes nothing.
 */
export async function writeConfigDoc(
  storage: PolicyStorage,
  patch: ConfigPatch,
  meta: MutationMeta,
): Promise<AdminConfig> {
  return storage.transaction(async () => {
    const current = normalizeConfig((await storage.get<Partial<AdminConfig>>(ADMIN_CONFIG_KEY)) ?? null);
    if (current.version !== meta.expectedVersion) {
      throw new PolicyConflictError(
        `Config version conflict: expected ${meta.expectedVersion}, found ${current.version}. Re-read and retry.`,
        meta.expectedVersion,
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
      updatedBy: meta.updatedBy,
    };
    await storage.put(ADMIN_CONFIG_KEY, next);
    return next;
  });
}

/** Delete the config document (harness/admin seam). Absence reads as open-mode defaults. */
export async function clearConfigDoc(storage: PolicyStorage): Promise<void> {
  await storage.delete(ADMIN_CONFIG_KEY);
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

/** Read one user's policy from strongly-consistent storage, or null with no entry. */
export async function readUserPolicyDoc(storage: PolicyStorage, hsUserId: string | number): Promise<UserPolicy | null> {
  const raw = await storage.get<Partial<UserPolicy>>(userPolicyKey(hsUserId));
  return raw ? normalizeUserPolicy(raw) : null;
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
 * Write one user's policy with an atomic version check-and-increment, enforcing
 * the customerVisibleWrites => writes invariant (a customer-visible grant raises
 * writes to true). The read-compare-write runs inside one storage transaction,
 * so a racing same-version write cannot silently overwrite this one; the loser
 * throws PolicyConflictError.
 */
export async function writeUserPolicyDoc(
  storage: PolicyStorage,
  hsUserId: string | number,
  input: UserPolicyInput,
  meta: MutationMeta,
): Promise<UserPolicy> {
  const id = String(hsUserId);
  return storage.transaction(async () => {
    const raw = await storage.get<Partial<UserPolicy>>(userPolicyKey(id));
    const current = raw ? normalizeUserPolicy(raw) : null;
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== meta.expectedVersion) {
      throw new PolicyConflictError(
        `User policy version conflict for ${id}: expected ${meta.expectedVersion}, found ${currentVersion}. Re-read and retry.`,
        meta.expectedVersion,
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
      updatedBy: meta.updatedBy,
      version: currentVersion + 1,
    };
    await storage.put(userPolicyKey(id), next);
    return next;
  });
}

/** Delete one user's policy document (harness/admin seam). */
export async function clearUserPolicyDoc(storage: PolicyStorage, hsUserId: string | number): Promise<void> {
  await storage.delete(userPolicyKey(String(hsUserId)));
}

/**
 * Pin a user to allowed:false inside one atomic transaction. This is the final,
 * authoritative step of a hard revoke: unlike writeUserPolicyDoc it takes NO
 * expectedVersion and cannot conflict, because a revoke must win over any
 * concurrent edit. Running the read-modify-write in one transaction means the
 * bumped version reflects whatever it displaced, and no racing allow can slip in
 * between the read and the write to re-open the account.
 */
export async function pinUserPolicyRevoked(
  storage: PolicyStorage,
  hsUserId: string | number,
  updatedBy: string,
): Promise<UserPolicy> {
  const id = String(hsUserId);
  return storage.transaction(async () => {
    const raw = await storage.get<Partial<UserPolicy>>(userPolicyKey(id));
    const current = raw ? normalizeUserPolicy(raw) : null;
    const next: UserPolicy = {
      v: POLICY_USER_SCHEMA_VERSION,
      allowed: false,
      writes: false,
      customerVisibleWrites: false,
      email: current?.email ?? '',
      updatedAt: new Date().toISOString(),
      updatedBy,
      version: (current?.version ?? 0) + 1,
    };
    await storage.put(userPolicyKey(id), next);
    return next;
  });
}

/** Result of a revokeUser call. */
export interface RevokeUserResult {
  hsUserId: string;
  grantsRevoked: number;
  policy: UserPolicy;
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
