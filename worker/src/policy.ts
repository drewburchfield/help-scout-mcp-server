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

/** The shared prefix every per-user policy document key carries. */
export const USER_POLICY_PREFIX = 'policy:user:';

/** The storage key for one user's policy document. */
export function userPolicyKey(hsUserId: string | number): string {
  return `${USER_POLICY_PREFIX}${String(hsUserId)}`;
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
  list<T = unknown>(options?: PolicyListOptions): Promise<Map<string, T>>;
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

/**
 * The subset of the Durable Objects storage list options the audit ledger and
 * the access-list export use. Mirrors the runtime contract: results come back in
 * ascending UTF-8 key order, `prefix` scopes the range, `end` is EXCLUSIVE, and
 * `reverse` flips the returned order (developers.cloudflare.com, Durable Objects
 * Storage API `list(options)`). The coordinator binds this to ctx.storage.list
 * and the unit fake implements the same shape over an in-memory map.
 */
export interface PolicyListOptions {
  prefix?: string;
  limit?: number;
  reverse?: boolean;
  start?: string;
  startAfter?: string;
  end?: string;
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

/** The version guard + identity a mutation carries across the DO boundary. */
export interface MutationMeta {
  /** Optimistic-concurrency guard: the version the caller believes is current. */
  expectedVersion: number;
  /** Identity of the admin performing the change; stored for display/audit. */
  updatedBy: string;
  /** Optional display email of the admin, recorded on the audit row (NAS-1502). */
  actorEmail?: string;
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
  // The whole read-compare-write PLUS its audit row commit in one transaction, so
  // the ledger never drifts from the document. On conflict we write ONLY the
  // denied audit row and return a marker; the throw happens after the transaction
  // commits, so we never rely on rollback (the in-memory unit fake does not model
  // it) and the conflict row is the sole write.
  const outcome = await storage.transaction(
    async (): Promise<{ ok: true; config: AdminConfig } | { ok: false; currentVersion: number }> => {
      const current = normalizeConfig((await storage.get<Partial<AdminConfig>>(ADMIN_CONFIG_KEY)) ?? null);
      if (current.version !== meta.expectedVersion) {
        await appendAuditRow(storage, {
          action: 'config.update.conflict',
          actorId: meta.updatedBy,
          actorEmail: meta.actorEmail ?? '',
          targetId: ADMIN_CONFIG_KEY,
          before: null,
          after: { expectedVersion: meta.expectedVersion, currentVersion: current.version },
          outcome: 'denied',
        });
        return { ok: false, currentVersion: current.version };
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
      await appendAuditRow(storage, {
        action: 'config.updated',
        actorId: meta.updatedBy,
        actorEmail: meta.actorEmail ?? '',
        targetId: ADMIN_CONFIG_KEY,
        before: current.version === 0 ? null : current,
        after: next,
        outcome: 'success',
      });
      return { ok: true, config: next };
    },
  );
  if (!outcome.ok) {
    throw new PolicyConflictError(
      `Config version conflict: expected ${meta.expectedVersion}, found ${outcome.currentVersion}. Re-read and retry.`,
      meta.expectedVersion,
      outcome.currentVersion,
    );
  }
  return outcome.config;
}

/** Delete the config document (harness/admin seam). Absence reads as open-mode defaults. */
export async function clearConfigDoc(storage: PolicyStorage, meta?: MutationMeta): Promise<void> {
  // Record the deletion so the ledger has no hole: capture the removed document
  // as `before`, delete it, and append the row in one transaction.
  await storage.transaction(async () => {
    const before = (await storage.get<Partial<AdminConfig>>(ADMIN_CONFIG_KEY)) ?? null;
    await storage.delete(ADMIN_CONFIG_KEY);
    // Only record a deletion of something that existed: deleting an absent
    // document is a no-op and must not fabricate a phantom ledger entry.
    if (before !== null) {
      await appendAuditRow(storage, {
        action: 'config.deleted',
        actorId: meta?.updatedBy ?? '',
        actorEmail: meta?.actorEmail ?? '',
        targetId: ADMIN_CONFIG_KEY,
        before: before as Record<string, unknown>,
        after: null,
        outcome: 'success',
      });
    }
  });
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
  const outcome = await storage.transaction(
    async (): Promise<{ ok: true; policy: UserPolicy } | { ok: false; currentVersion: number }> => {
      const raw = await storage.get<Partial<UserPolicy>>(userPolicyKey(id));
      const current = raw ? normalizeUserPolicy(raw) : null;
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== meta.expectedVersion) {
        await appendAuditRow(storage, {
          action: 'user.policy.update.conflict',
          actorId: meta.updatedBy,
          actorEmail: meta.actorEmail ?? '',
          targetId: id,
          before: null,
          after: { expectedVersion: meta.expectedVersion, currentVersion },
          outcome: 'denied',
        });
        return { ok: false, currentVersion };
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
      await appendAuditRow(storage, {
        action: 'user.policy.updated',
        actorId: meta.updatedBy,
        actorEmail: meta.actorEmail ?? '',
        targetId: id,
        before: current,
        after: next,
        outcome: 'success',
      });
      return { ok: true, policy: next };
    },
  );
  if (!outcome.ok) {
    throw new PolicyConflictError(
      `User policy version conflict for ${id}: expected ${meta.expectedVersion}, found ${outcome.currentVersion}. Re-read and retry.`,
      meta.expectedVersion,
      outcome.currentVersion,
    );
  }
  return outcome.policy;
}

/** Delete one user's policy document (harness/admin seam). */
export async function clearUserPolicyDoc(
  storage: PolicyStorage,
  hsUserId: string | number,
  meta?: MutationMeta,
): Promise<void> {
  const id = String(hsUserId);
  await storage.transaction(async () => {
    const before = (await storage.get<Partial<UserPolicy>>(userPolicyKey(id))) ?? null;
    await storage.delete(userPolicyKey(id));
    // Only record a deletion of something that existed (see clearConfigDoc).
    if (before !== null) {
      await appendAuditRow(storage, {
        action: 'user.policy.deleted',
        actorId: meta?.updatedBy ?? '',
        actorEmail: meta?.actorEmail ?? '',
        targetId: id,
        before: before as Record<string, unknown>,
        after: null,
        outcome: 'success',
      });
    }
  });
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
  actorEmail = '',
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
    await appendAuditRow(storage, {
      action: 'user.revoked',
      actorId: updatedBy,
      actorEmail,
      targetId: id,
      before: current,
      after: next,
      outcome: 'success',
    });
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

// --- Audit trail (NAS-1502) ------------------------------------------------
//
// The coordinator DO is also the audit ledger. Every policy MUTATION records its
// audit row in the SAME storage transaction as the document it changes (see
// writeConfigDoc / writeUserPolicyDoc / pinUserPolicyRevoked above), so a row and
// the mutation it describes commit together or not at all, so the ledger cannot
// drift from the documents, and a conflict that writes nothing to a document
// still leaves a durable denied row. Observational events that are NOT mutations
// (a grant minted at /callback, an admission denied at the gate) are appended via
// appendAuditRow in their own transaction, best-effort and off the user path.
//
// Storage model (the same key-value PolicyStorage the CAS core runs over, chosen
// over the SQL API so the audit core stays unit-testable against the existing
// in-memory transactional fake, and so an audit row commits inside the very same
// transaction as its mutation with no second storage abstraction):
//   audit:seq                 a maintained monotonic counter (last-used seq)
//   audit:entry:{padded seq}  one immutable row per event, seq zero-padded so the
//                             ascending UTF-8 key order the DO lists in IS the
//                             sequence (and wall-clock) order.
// The counter is incremented inside the serialized transaction, so sequence
// numbers are gap-free and strictly ordered for free: the single-threaded,
// input-gated Durable Object provides that with no extra coordination.
//
// Retention is bounded two ways, both documented on the reader/writer:
//   - by COUNT: at most MAX_AUDIT_ENTRIES rows are kept. Each append drops the one
//     row that just fell out of the window (a single delete), so the live set
//     stays the most-recent MAX_AUDIT_ENTRIES with O(1) work per append.
//   - by AGE: rows older than AUDIT_MAX_AGE_MS are swept on append AND on list, a
//     bounded batch at a time from the oldest key forward (ascending order means
//     the first non-expired row ends the sweep).
//
// Cloudflare storage APIs relied on (developers.cloudflare.com, Durable Objects
// Storage API): storage.list(options) returns a Map in ascending UTF-8 key order
// and honors { prefix, limit, reverse, end } where `end` is EXCLUSIVE, and that
// is what makes newest-first pagination a reverse-listing bounded by the cursor key;
// storage.transaction(closure) commits its body atomically, and on the SQLite
// backend operations performed directly on ctx.storage inside the closure are
// part of the transaction. The core never throws for control flow inside a
// transaction, so it never depends on transaction rollback.

/** The counter key holding the last-used audit sequence number. */
export const AUDIT_SEQ_KEY = 'audit:seq';

/** The shared prefix every audit row key carries (kept distinct from the counter). */
export const AUDIT_ENTRY_PREFIX = 'audit:entry:';

/** Count-based retention: keep at most this many of the most recent rows. */
export const MAX_AUDIT_ENTRIES = 10_000;

/** Age-based retention: rows older than this (~1 year) are pruned on append/list. */
export const AUDIT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Zero-pad width for the seq in a row key, so lexicographic order == numeric order. */
const AUDIT_SEQ_PAD = 16;

/** Bounded number of oldest rows examined per age-prune sweep. */
const AUDIT_AGE_PRUNE_BATCH = 32;

/** Pagination clamp for the audit list. */
export const AUDIT_LIST_MIN_LIMIT = 1;
export const AUDIT_LIST_MAX_LIMIT = 200;
export const AUDIT_LIST_DEFAULT_LIMIT = 50;

/** The storage key for one audit row at a given sequence number. */
export function auditEntryKey(seq: number): string {
  return `${AUDIT_ENTRY_PREFIX}${String(seq).padStart(AUDIT_SEQ_PAD, '0')}`;
}

export type AuditOutcome = 'success' | 'denied';

/** One immutable audit row. `before`/`after` are event-shaped snapshots (nullable). */
export interface AuditEntry {
  seq: number;
  ts: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetId: string;
  before: unknown;
  after: unknown;
  outcome: AuditOutcome;
}

/** What a caller supplies to record one event; seq/ts are assigned on append. */
export interface AuditEventInput {
  action: string;
  actorId: string;
  actorEmail: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  outcome: AuditOutcome;
}

/** Options for a newest-first page of audit rows. */
export interface AuditListOptions {
  /** Opaque continuation from a previous page (the seq to read strictly below). */
  cursor?: string;
  /** Clamped to [AUDIT_LIST_MIN_LIMIT, AUDIT_LIST_MAX_LIMIT], default AUDIT_LIST_DEFAULT_LIMIT. */
  limit?: number;
  /** Inclusive lower bound on ts (ISO). */
  from?: string;
  /** Inclusive upper bound on ts (ISO). */
  to?: string;
}

/** A newest-first page plus the cursor to fetch the next (older) page, if any. */
export interface AuditListPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

function clampAuditLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return AUDIT_LIST_DEFAULT_LIMIT;
  return Math.min(AUDIT_LIST_MAX_LIMIT, Math.max(AUDIT_LIST_MIN_LIMIT, Math.floor(value)));
}

/** A cursor is the decimal seq to continue strictly below; anything else means "from newest". */
function decodeAuditCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Append one audit row, assign its sequence, and prune. MUST run inside a
 * transaction supplied by the caller (a mutation's own transaction, or a
 * standalone transaction for an observational event), so the seq read, the row
 * write, the counter bump, and the pruning all commit together.
 */
export async function appendAuditRow(storage: PolicyStorage, input: AuditEventInput): Promise<AuditEntry> {
  const seq = ((await storage.get<number>(AUDIT_SEQ_KEY)) ?? 0) + 1;
  const entry: AuditEntry = {
    seq,
    ts: new Date().toISOString(),
    actorId: input.actorId,
    actorEmail: input.actorEmail,
    action: input.action,
    targetId: input.targetId,
    before: input.before ?? null,
    after: input.after ?? null,
    outcome: input.outcome,
  };
  await storage.put(auditEntryKey(seq), entry);
  await storage.put(AUDIT_SEQ_KEY, seq);
  // Count-based retention: drop the single row that just fell out of the window.
  if (seq > MAX_AUDIT_ENTRIES) {
    await storage.delete(auditEntryKey(seq - MAX_AUDIT_ENTRIES));
  }
  await pruneAuditByAge(storage, Date.now());
  return entry;
}

/** Sweep a bounded batch of the oldest rows, deleting those past the age cutoff. */
async function pruneAuditByAge(storage: PolicyStorage, nowMs: number): Promise<void> {
  const cutoff = new Date(nowMs - AUDIT_MAX_AGE_MS).toISOString();
  const oldest = await storage.list<AuditEntry>({ prefix: AUDIT_ENTRY_PREFIX, limit: AUDIT_AGE_PRUNE_BATCH });
  for (const [key, entry] of oldest) {
    // Ascending order: the first row that is not expired ends the sweep.
    if (!entry || entry.ts >= cutoff) break;
    await storage.delete(key);
  }
}

/**
 * Read a newest-first page of audit rows, applying optional ts bounds and the
 * cursor. Also opportunistically age-prunes. Pulls descending chunks and refills
 * across the `to`/`from` filter so a page is never short because filtered rows
 * sat at the top; because ts is non-decreasing with seq, a row older than `from`
 * ends the scan.
 */
export async function readAuditPage(storage: PolicyStorage, options: AuditListOptions): Promise<AuditListPage> {
  await pruneAuditByAge(storage, Date.now());
  const limit = clampAuditLimit(options.limit);
  // Enforce the retention floor on the result regardless of the bounded sweep,
  // so a listing never surfaces a record past the one-year window.
  const floor = new Date(Date.now() - AUDIT_MAX_AGE_MS).toISOString();
  const from = options.from !== undefined && options.from > floor ? options.from : floor;
  const { to } = options;
  const chunk = limit + 1;
  const collected: AuditEntry[] = [];
  let endExclusiveSeq = decodeAuditCursor(options.cursor);
  let done = false;

  while (!done && collected.length <= limit) {
    const listOptions: PolicyListOptions = { prefix: AUDIT_ENTRY_PREFIX, reverse: true, limit: chunk };
    if (endExclusiveSeq !== undefined) listOptions.end = auditEntryKey(endExclusiveSeq);
    const page = await storage.list<AuditEntry>(listOptions);
    if (page.size === 0) break;

    let smallestSeq = Number.POSITIVE_INFINITY;
    for (const entry of page.values()) {
      if (entry.seq < smallestSeq) smallestSeq = entry.seq;
      if (to !== undefined && entry.ts > to) continue;
      if (from !== undefined && entry.ts < from) {
        done = true;
        break;
      }
      collected.push(entry);
      if (collected.length > limit) break;
    }
    if (page.size < chunk) break; // storage exhausted
    endExclusiveSeq = smallestSeq; // continue strictly below the smallest seq seen
  }

  const hasMore = collected.length > limit;
  const entries = collected.slice(0, limit);
  const nextCursor = hasMore ? String(entries[entries.length - 1].seq) : undefined;
  return { entries, nextCursor };
}

/**
 * Read the full audit range (bounded by retention) in ascending, chronological
 * order for an evidence export. Retention caps the row count, so listing the
 * whole prefix is bounded.
 */
export async function readAuditRange(
  storage: PolicyStorage,
  options: { from?: string; to?: string } = {},
): Promise<AuditEntry[]> {
  await pruneAuditByAge(storage, Date.now());
  // The retention floor is enforced on the RESULT, not just via the opportunistic
  // sweep (which is bounded per call): an export must never hand back a record
  // older than the one-year window we promise to have discarded, even if the
  // sweep has not yet reached it. The effective lower bound is the later of the
  // caller's `from` and the retention floor.
  const floor = new Date(Date.now() - AUDIT_MAX_AGE_MS).toISOString();
  const from = options.from !== undefined && options.from > floor ? options.from : floor;
  const { to } = options;
  const all = await storage.list<AuditEntry>({ prefix: AUDIT_ENTRY_PREFIX });
  const out: AuditEntry[] = [];
  for (const entry of all.values()) {
    if (entry.ts < from) continue;
    if (to !== undefined && entry.ts > to) continue;
    out.push(entry);
  }
  return out;
}

// --- Help Scout user directory cache (NAS-1503) ----------------------------
//
// The admin GUI's roster is the full set of Help Scout account users merged with
// the policy documents. Listing account users needs an admin's Help Scout token
// (GET /v2/users), which the admin surface holds only during login. Rather than
// keep that token for the life of the 8-hour admin session, the login fetches the
// directory ONCE and caches this non-secret snapshot (ids, emails, names, roles)
// in the coordinator's storage; the roster endpoint then merges the cached
// directory with LIVE policy/grant state on every request. A re-login refreshes
// the snapshot. No Help Scout token is retained past login.

/** The single storage key holding the cached Help Scout user directory. */
export const ADMIN_DIRECTORY_KEY = 'admin:directory:v1';

/** The Help Scout account roles the admin surface distinguishes. */
export type HelpScoutRole = 'Owner' | 'Administrator' | 'User' | 'Light';

/** One cached Help Scout account user (display directory data, never a secret). */
export interface DirectoryUser {
  hsUserId: string;
  email: string;
  name: string;
  role: HelpScoutRole;
}

/** The cached directory snapshot plus the provenance of when/who fetched it. */
export interface UserDirectory {
  users: DirectoryUser[];
  fetchedAt: string;
  fetchedBy: string;
}

/** Read the cached directory snapshot, or null when login has not populated it. */
export async function readDirectory(storage: PolicyStorage): Promise<UserDirectory | null> {
  const raw = await storage.get<UserDirectory>(ADMIN_DIRECTORY_KEY);
  if (!raw || !Array.isArray(raw.users)) return null;
  return raw;
}

/** Overwrite the cached directory snapshot (a cache; not versioned, not audited). */
export async function writeDirectory(storage: PolicyStorage, directory: UserDirectory): Promise<void> {
  await storage.put(ADMIN_DIRECTORY_KEY, directory);
}

/** List every stored user policy document (normalized), keyed by hsUserId. */
export async function listUserPolicyDocs(
  storage: PolicyStorage,
): Promise<Array<{ hsUserId: string; policy: UserPolicy }>> {
  const all = await storage.list<Partial<UserPolicy>>({ prefix: USER_POLICY_PREFIX });
  const out: Array<{ hsUserId: string; policy: UserPolicy }> = [];
  for (const [key, raw] of all) {
    out.push({ hsUserId: key.slice(USER_POLICY_PREFIX.length), policy: normalizeUserPolicy(raw) });
  }
  return out;
}

/** One row of the current-entitlements evidence export. */
export interface AccessListRow {
  hsUserId: string;
  email: string;
  allowed: boolean;
  writes: boolean;
  customerVisibleWrites: boolean;
  /** Admission decision under the current config (allowlist mode + explicit block). */
  effectiveAllowed: boolean;
  /** Write flag after intersecting the user grant with the deployment ceiling. */
  effectiveWrites: boolean;
  /** Customer-visible write flag after the same intersection. */
  effectiveCustomerVisibleWrites: boolean;
  updatedAt: string;
  updatedBy: string;
  version: number;
}

/**
 * Compute the current effective entitlements for every user policy, under the
 * deployment config and the env write ceiling. `effectiveAllowed` is the real
 * admission decision (evaluateAccess); the write flags are narrowed to the
 * ceiling (effectiveWriteFlags). Sorted by hsUserId for a stable export.
 */
export function buildAccessListRows(
  config: AdminConfig,
  ceiling: WriteFlagSet,
  users: Array<{ hsUserId: string; policy: UserPolicy }>,
): AccessListRow[] {
  return users
    .map(({ hsUserId, policy }) => {
      const effective = effectiveWriteFlags(ceiling, policy);
      return {
        hsUserId,
        email: policy.email,
        allowed: policy.allowed,
        writes: policy.writes,
        customerVisibleWrites: policy.customerVisibleWrites,
        effectiveAllowed: evaluateAccess(config, policy).allowed,
        effectiveWrites: effective.enabled,
        effectiveCustomerVisibleWrites: effective.customerVisibleEnabled,
        updatedAt: policy.updatedAt,
        updatedBy: policy.updatedBy,
        version: policy.version,
      };
    })
    .sort((a, b) => (a.hsUserId < b.hsUserId ? -1 : a.hsUserId > b.hsUserId ? 1 : 0));
}

/**
 * RFC-4180 field quoting, plus spreadsheet formula-injection neutralization.
 * A cell whose text begins with =, +, -, @, or a tab/CR is treated by Excel and
 * Google Sheets as a formula, so a value like `=cmd|...` in a user-controlled
 * field (email, updatedBy, the before/after JSON) could execute when an operator
 * opens the evidence export. Prefix such a cell with a single quote, which those
 * tools render as a leading text marker and strip on display, before applying
 * normal RFC-4180 quoting.
 */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build an RFC-4180 CSV (CRLF line breaks, quoted fields) from a header + rows. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

export const AUDIT_CSV_HEADERS = [
  'seq',
  'ts',
  'actorId',
  'actorEmail',
  'action',
  'targetId',
  'before',
  'after',
  'outcome',
] as const;

/** Serialize audit rows to CSV; before/after are JSON so commas/quotes get quoted. */
export function auditEntriesToCsv(entries: AuditEntry[]): string {
  return toCsv(
    [...AUDIT_CSV_HEADERS],
    entries.map((e) => [
      e.seq,
      e.ts,
      e.actorId,
      e.actorEmail,
      e.action,
      e.targetId,
      e.before === null || e.before === undefined ? '' : JSON.stringify(e.before),
      e.after === null || e.after === undefined ? '' : JSON.stringify(e.after),
      e.outcome,
    ]),
  );
}

export const ACCESS_LIST_CSV_HEADERS = [
  'hsUserId',
  'email',
  'allowed',
  'writes',
  'customerVisibleWrites',
  'effectiveAllowed',
  'effectiveWrites',
  'effectiveCustomerVisibleWrites',
  'updatedAt',
  'updatedBy',
  'version',
] as const;

/** Serialize access-list rows to CSV. */
export function accessListToCsv(rows: AccessListRow[]): string {
  return toCsv(
    [...ACCESS_LIST_CSV_HEADERS],
    rows.map((r) => [
      r.hsUserId,
      r.email,
      r.allowed,
      r.writes,
      r.customerVisibleWrites,
      r.effectiveAllowed,
      r.effectiveWrites,
      r.effectiveCustomerVisibleWrites,
      r.updatedAt,
      r.updatedBy,
      r.version,
    ]),
  );
}
