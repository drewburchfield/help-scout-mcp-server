/**
 * Unit coverage for the worker's access-policy engine (NAS-1501).
 *
 * Two layers are exercised here in CI:
 *   1. The pure decision helpers (evaluateAccess / effectiveWriteFlags).
 *   2. The storage-injectable CAS core the coordinator Durable Object runs
 *      (readConfigDoc / writeConfigDoc / readUserPolicyDoc / writeUserPolicyDoc /
 *      pinUserPolicyRevoked / clear*), driven against an in-memory transactional
 *      fake. The fake models the one property the real DO provides that KV did
 *      not: transactions are serialized, so a read-modify-write inside one sees a
 *      consistent snapshot and cannot lose its write to a racing transaction.
 *
 * The env-facing RPC wrappers (policy-store.ts) and the full enforcement flow run
 * in the worker smoke suite, which drives the actual coordinator DO.
 */
import {
  PolicyConflictError,
  PolicyInvalidError,
  ADMIN_CONFIG_KEY,
  clearConfigDoc,
  clearUserPolicyDoc,
  effectiveWriteFlags,
  evaluateAccess,
  pinUserPolicyRevoked,
  readConfigDoc,
  readUserPolicyDoc,
  userPolicyKey,
  writeConfigDoc,
  writeUserPolicyDoc,
  type AdminConfig,
  type PolicyStorage,
  type UserPolicy,
} from '../../worker/src/policy.js';

/**
 * An in-memory PolicyStorage that faithfully models the coordinator DO: values
 * are stored by structured copy (no aliasing, like real serialized storage) and
 * `transaction` serializes its closures through a promise chain, the way a
 * single-threaded, input-gated Durable Object serializes concurrent requests. A
 * rejected transaction still lets the next one proceed (a DO transaction that
 * throws rolls back and the next request runs).
 */
function makeStorage(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(
    Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]),
  );
  let tail: Promise<unknown> = Promise.resolve();
  const storage: PolicyStorage = {
    get: async <T>(key: string): Promise<T | undefined> => {
      const value = map.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    put: async (key: string, value: unknown): Promise<void> => {
      map.set(key, structuredClone(value));
    },
    delete: async (key: string): Promise<void> => {
      map.delete(key);
    },
    transaction: <T>(closure: () => Promise<T>): Promise<T> => {
      const result = tail.then(() => closure());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return { map, storage };
}

const baseConfig = (over: Partial<AdminConfig> = {}): AdminConfig => ({
  schemaVersion: 1,
  allowlistMode: false,
  adminRole: 'owner',
  policyCacheTtlSeconds: 45,
  version: 1,
  updatedAt: '2026-07-31T00:00:00Z',
  updatedBy: 'admin',
  ...over,
});

const basePolicy = (over: Partial<UserPolicy> = {}): UserPolicy => ({
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

describe('evaluateAccess', () => {
  it('allows by default in open mode with no user entry', () => {
    expect(evaluateAccess(baseConfig(), null).allowed).toBe(true);
  });

  it('blocks an explicit allowed:false even in open mode', () => {
    const decision = evaluateAccess(baseConfig(), basePolicy({ allowed: false }));
    expect(decision).toEqual({ allowed: false, reason: 'explicit-block' });
  });

  it('denies missing entries under allowlist mode and admits explicit allows', () => {
    const config = baseConfig({ allowlistMode: true });
    expect(evaluateAccess(config, null)).toEqual({ allowed: false, reason: 'allowlist' });
    expect(evaluateAccess(config, basePolicy()).allowed).toBe(true);
  });
});

describe('effectiveWriteFlags', () => {
  const ceiling = { enabled: true, customerVisibleEnabled: true };

  it('inherits the ceiling unchanged when the user has no policy document', () => {
    expect(effectiveWriteFlags(ceiling, null)).toEqual(ceiling);
  });

  it('narrows to the intersection of ceiling and user grants', () => {
    expect(effectiveWriteFlags(ceiling, basePolicy())).toEqual({ enabled: false, customerVisibleEnabled: false });
    expect(effectiveWriteFlags(ceiling, basePolicy({ writes: true }))).toEqual({ enabled: true, customerVisibleEnabled: false });
    expect(
      effectiveWriteFlags(ceiling, basePolicy({ writes: true, customerVisibleWrites: true })),
    ).toEqual({ enabled: true, customerVisibleEnabled: true });
  });

  it('never exceeds the ceiling regardless of user grants', () => {
    const readOnlyCeiling = { enabled: false, customerVisibleEnabled: false };
    expect(
      effectiveWriteFlags(readOnlyCeiling, basePolicy({ writes: true, customerVisibleWrites: true })),
    ).toEqual({ enabled: false, customerVisibleEnabled: false });
  });
});

describe('config schema fail-closed', () => {
  it('treats a missing document as open-mode defaults', async () => {
    const { storage } = makeStorage();
    const config = await readConfigDoc(storage);
    expect(config.allowlistMode).toBe(false);
    expect(config.version).toBe(0);
  });

  it.each([
    [{ schemaVersion: 2, allowlistMode: true, version: 1 }],
    [{ allowlistMode: true, version: 1 }],
    [{ schemaVersion: 1, allowlistMode: 'yes', version: 1 }],
  ])('throws PolicyInvalidError for unsupported or malformed document %p', async (doc) => {
    const { storage } = makeStorage({ [ADMIN_CONFIG_KEY]: doc });
    await expect(readConfigDoc(storage)).rejects.toBeInstanceOf(PolicyInvalidError);
  });
});

describe('user policy normalization', () => {
  it('reads a document violating the implied-writes invariant down to least privilege', async () => {
    const { storage } = makeStorage({
      [userPolicyKey('42')]: basePolicy({ writes: false, customerVisibleWrites: true }),
    });
    const policy = await readUserPolicyDoc(storage, '42');
    expect(policy?.customerVisibleWrites).toBe(false);
  });

  it('raises writes when a customer-visible grant is written', async () => {
    const { storage } = makeStorage();
    const written = await writeUserPolicyDoc(
      storage,
      '42',
      { allowed: true, writes: false, customerVisibleWrites: true },
      { expectedVersion: 0, updatedBy: 'admin' },
    );
    expect(written.writes).toBe(true);
  });
});

describe('optimistic concurrency (single-writer)', () => {
  it('rejects a stale config write and leaves the document untouched', async () => {
    const { map, storage } = makeStorage({ [ADMIN_CONFIG_KEY]: baseConfig({ version: 3 }) });
    await expect(
      writeConfigDoc(storage, { allowlistMode: true }, { expectedVersion: 2, updatedBy: 'admin' }),
    ).rejects.toBeInstanceOf(PolicyConflictError);
    expect((map.get(ADMIN_CONFIG_KEY) as AdminConfig).allowlistMode).toBe(false);
    expect((map.get(ADMIN_CONFIG_KEY) as AdminConfig).version).toBe(3);
  });

  it('rejects a stale user policy write', async () => {
    const { storage } = makeStorage({ [userPolicyKey('42')]: basePolicy({ version: 2 }) });
    await expect(
      writeUserPolicyDoc(
        storage,
        '42',
        { allowed: false, writes: false, customerVisibleWrites: false },
        { expectedVersion: 1, updatedBy: 'admin' },
      ),
    ).rejects.toBeInstanceOf(PolicyConflictError);
  });

  it('increments the version on a successful write', async () => {
    const { storage } = makeStorage();
    const first = await writeConfigDoc(storage, { allowlistMode: true }, { expectedVersion: 0, updatedBy: 'a' });
    expect(first.version).toBe(1);
    const second = await writeConfigDoc(storage, { allowlistMode: false }, { expectedVersion: 1, updatedBy: 'b' });
    expect(second.version).toBe(2);
  });
});

// The defect this whole change exists to fix: under the KV get-then-put, two
// admins reading the same version could both "succeed" and silently lose one
// update. Inside the coordinator DO the check-and-increment is one serialized
// transaction, so exactly one of two same-version writers wins and the other
// gets a conflict. These fire both writes WITHOUT awaiting the first, so the
// proof is the transactional serialization, not test sequencing.
describe('atomic compare-and-swap (concurrent writers)', () => {
  it('resolves two same-version config writes to exactly one winner + one conflict', async () => {
    const { storage } = makeStorage(); // absent config reads as version 0
    const settled = await Promise.allSettled([
      writeConfigDoc(storage, { allowlistMode: true }, { expectedVersion: 0, updatedBy: 'admin-a' }),
      writeConfigDoc(storage, { allowlistMode: false, policyCacheTtlSeconds: 200 }, { expectedVersion: 0, updatedBy: 'admin-b' }),
    ]);

    const fulfilled = settled.filter((r): r is PromiseFulfilledResult<AdminConfig> => r.status === 'fulfilled');
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(PolicyConflictError);
    expect((rejected[0].reason as PolicyConflictError).expectedVersion).toBe(0);
    expect((rejected[0].reason as PolicyConflictError).currentVersion).toBe(1);

    // The store holds exactly the winner's document at version 1 — the loser's
    // write never landed.
    const persisted = await readConfigDoc(storage);
    expect(persisted.version).toBe(1);
    expect(persisted.updatedBy).toBe(fulfilled[0].value.updatedBy);
  });

  it('resolves two same-version user writes to exactly one winner + one conflict (a racing allow cannot silently overwrite)', async () => {
    const { storage } = makeStorage({ [userPolicyKey('7')]: basePolicy({ version: 1, allowed: true }) });
    const settled = await Promise.allSettled([
      writeUserPolicyDoc(storage, '7', { allowed: false, writes: false, customerVisibleWrites: false }, { expectedVersion: 1, updatedBy: 'revoker' }),
      writeUserPolicyDoc(storage, '7', { allowed: true, writes: true, customerVisibleWrites: false }, { expectedVersion: 1, updatedBy: 'allower' }),
    ]);

    const fulfilled = settled.filter((r): r is PromiseFulfilledResult<UserPolicy> => r.status === 'fulfilled');
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(PolicyConflictError);

    const persisted = await readUserPolicyDoc(storage, '7');
    expect(persisted?.version).toBe(2);
    expect(persisted?.updatedBy).toBe(fulfilled[0].value.updatedBy);
  });
});

describe('pinUserPolicyRevoked', () => {
  it('pins allowed:false with writes off and bumps the version, preserving email', async () => {
    const { storage } = makeStorage({
      [userPolicyKey('42')]: basePolicy({ version: 4, writes: true, customerVisibleWrites: true, email: 'x@example.test' }),
    });
    const pinned = await pinUserPolicyRevoked(storage, 42, 'revoker');
    expect(pinned.allowed).toBe(false);
    expect(pinned.writes).toBe(false);
    expect(pinned.customerVisibleWrites).toBe(false);
    expect(pinned.version).toBe(5);
    expect(pinned.email).toBe('x@example.test');
  });

  it('pins a never-seen user to allowed:false at version 1', async () => {
    const { storage } = makeStorage();
    const pinned = await pinUserPolicyRevoked(storage, 'ghost', 'revoker');
    expect(pinned.allowed).toBe(false);
    expect(pinned.version).toBe(1);
  });
});

describe('clear helpers', () => {
  it('clearConfigDoc removes the document so it reads back as open-mode defaults', async () => {
    const { storage } = makeStorage({ [ADMIN_CONFIG_KEY]: baseConfig({ allowlistMode: true, version: 2 }) });
    await clearConfigDoc(storage);
    const config = await readConfigDoc(storage);
    expect(config.allowlistMode).toBe(false);
    expect(config.version).toBe(0);
  });

  it('clearUserPolicyDoc removes the document so it reads back as null', async () => {
    const { storage } = makeStorage({ [userPolicyKey('42')]: basePolicy() });
    await clearUserPolicyDoc(storage, 42);
    expect(await readUserPolicyDoc(storage, '42')).toBeNull();
  });
});
