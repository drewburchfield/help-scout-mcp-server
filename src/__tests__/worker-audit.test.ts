/**
 * Unit coverage for the worker's audit trail and evidence exports (NAS-1502).
 *
 * Exercises the storage-injectable audit core the coordinator Durable Object runs
 * (appendAuditRow / readAuditPage / readAuditRange / listUserPolicyDocs /
 * buildAccessListRows / the CSV helpers) plus the atomic recording wired into the
 * CAS mutations (writeConfigDoc / writeUserPolicyDoc / pinUserPolicyRevoked). It
 * drives the same in-memory transactional fake as the policy suite, so the
 * serialized-transaction and list semantics match the real DO.
 *
 * The full RPC surface (audit-store.ts) and the end-to-end recording of
 * grant.created / admission.denied run in the worker smoke suite.
 */
import {
  PolicyConflictError,
  ADMIN_CONFIG_KEY,
  AUDIT_SEQ_KEY,
  MAX_AUDIT_ENTRIES,
  accessListToCsv,
  appendAuditRow,
  auditEntriesToCsv,
  auditEntryKey,
  buildAccessListRows,
  listUserPolicyDocs,
  pinUserPolicyRevoked,
  readAuditPage,
  readAuditRange,
  toCsv,
  userPolicyKey,
  writeConfigDoc,
  writeUserPolicyDoc,
  clearUserPolicyDoc,
  type AdminConfig,
  type AuditEntry,
  type UserPolicy,
  type WriteFlagSet,
} from '../../worker/src/policy.js';
import { makeStorage } from './policy-storage-fake.js';

const meta = (over: { expectedVersion?: number; updatedBy?: string; actorEmail?: string } = {}) => ({
  expectedVersion: over.expectedVersion ?? 0,
  updatedBy: over.updatedBy ?? 'admin',
  actorEmail: over.actorEmail ?? 'admin@example.test',
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

describe('audit rows are recorded atomically with mutations', () => {
  it('records exactly one config.updated row with correct before/after on a first write', async () => {
    const { storage } = makeStorage();
    await writeConfigDoc(storage, { allowlistMode: true }, meta({ actorEmail: 'a@x.test' }));
    const rows = await readAuditRange(storage);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe('config.updated');
    expect(row.outcome).toBe('success');
    expect(row.targetId).toBe(ADMIN_CONFIG_KEY);
    expect(row.actorId).toBe('admin');
    expect(row.actorEmail).toBe('a@x.test');
    expect(row.before).toBeNull(); // version 0 => no prior document
    expect((row.after as AdminConfig).allowlistMode).toBe(true);
    expect((row.after as AdminConfig).version).toBe(1);
  });

  it('records a before snapshot on a subsequent config write', async () => {
    const { storage } = makeStorage();
    await writeConfigDoc(storage, { allowlistMode: true }, meta({ expectedVersion: 0 }));
    await writeConfigDoc(storage, { allowlistMode: false }, meta({ expectedVersion: 1 }));
    const rows = await readAuditRange(storage);
    expect(rows).toHaveLength(2);
    expect((rows[1].before as AdminConfig).allowlistMode).toBe(true);
    expect((rows[1].after as AdminConfig).allowlistMode).toBe(false);
  });

  it('records a conflict row and does NOT write the document on a stale config write', async () => {
    const { map, storage } = makeStorage({ [ADMIN_CONFIG_KEY]: baseConfig({ version: 3, allowlistMode: false }) });
    await expect(writeConfigDoc(storage, { allowlistMode: true }, meta({ expectedVersion: 2 }))).rejects.toBeInstanceOf(
      PolicyConflictError,
    );
    // Document untouched.
    expect((map.get(ADMIN_CONFIG_KEY) as AdminConfig).allowlistMode).toBe(false);
    expect((map.get(ADMIN_CONFIG_KEY) as AdminConfig).version).toBe(3);
    // Exactly one row, and it is the denied conflict.
    const rows = await readAuditRange(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('config.update.conflict');
    expect(rows[0].outcome).toBe('denied');
    expect(rows[0].after).toEqual({ expectedVersion: 2, currentVersion: 3 });
  });

  it('records exactly one user.policy.updated row with correct before/after', async () => {
    const { storage } = makeStorage();
    await writeUserPolicyDoc(storage, '42', { allowed: true, writes: true, customerVisibleWrites: false }, meta());
    const rows = await readAuditRange(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.policy.updated');
    expect(rows[0].targetId).toBe('42');
    expect(rows[0].before).toBeNull();
    expect((rows[0].after as UserPolicy).writes).toBe(true);
  });

  it('records a user.policy.deleted row capturing the removed document as before', async () => {
    const { map, storage } = makeStorage({ [userPolicyKey('42')]: basePolicy({ version: 3, allowed: true, writes: true }) });
    await clearUserPolicyDoc(storage, '42', meta());
    expect(map.has(userPolicyKey('42'))).toBe(false);
    const rows = await readAuditRange(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.policy.deleted');
    expect(rows[0].targetId).toBe('42');
    expect((rows[0].before as UserPolicy).writes).toBe(true);
    expect(rows[0].after).toBeNull();
  });

  it('records a user.policy.update.conflict row and leaves the document untouched', async () => {
    const { map, storage } = makeStorage({ [userPolicyKey('7')]: basePolicy({ version: 2, allowed: true }) });
    await expect(
      writeUserPolicyDoc(storage, '7', { allowed: false, writes: false, customerVisibleWrites: false }, meta({ expectedVersion: 1 })),
    ).rejects.toBeInstanceOf(PolicyConflictError);
    expect((map.get(userPolicyKey('7')) as UserPolicy).allowed).toBe(true);
    expect((map.get(userPolicyKey('7')) as UserPolicy).version).toBe(2);
    const rows = await readAuditRange(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.policy.update.conflict');
    expect(rows[0].outcome).toBe('denied');
  });

  it('records a user.revoked row with the prior policy as before', async () => {
    const { storage } = makeStorage({ [userPolicyKey('9')]: basePolicy({ version: 4, allowed: true, writes: true }) });
    await pinUserPolicyRevoked(storage, '9', 'revoker', 'revoker@example.test');
    const rows = await readAuditRange(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.revoked');
    expect(rows[0].actorId).toBe('revoker');
    expect(rows[0].actorEmail).toBe('revoker@example.test');
    expect((rows[0].before as UserPolicy).allowed).toBe(true);
    expect((rows[0].after as UserPolicy).allowed).toBe(false);
  });
});

describe('sequence ordering and monotonicity', () => {
  it('assigns gap-free, strictly increasing sequence numbers in append order', async () => {
    const { storage } = makeStorage();
    await writeConfigDoc(storage, { allowlistMode: true }, meta({ expectedVersion: 0 }));
    await writeUserPolicyDoc(storage, '1', { allowed: true, writes: false, customerVisibleWrites: false }, meta());
    await pinUserPolicyRevoked(storage, '1', 'revoker');
    const rows = await readAuditRange(storage);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.action)).toEqual(['config.updated', 'user.policy.updated', 'user.revoked']);
  });

  it('gives two concurrent same-version writers distinct sequential rows (one success, one conflict)', async () => {
    const { storage } = makeStorage(); // absent config reads as version 0
    const settled = await Promise.allSettled([
      writeConfigDoc(storage, { allowlistMode: true }, meta({ expectedVersion: 0, updatedBy: 'a' })),
      writeConfigDoc(storage, { allowlistMode: false }, meta({ expectedVersion: 0, updatedBy: 'b' })),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rows = await readAuditRange(storage);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(['config.update.conflict', 'config.updated']);
  });
});

describe('retention pruning', () => {
  it('drops the row that falls out of the count window on append', async () => {
    // Seed the counter just below the cap with two recent rows in place, then
    // append one more so seq crosses the cap and the oldest in-window row is
    // pruned. Fresh timestamps keep age pruning out of it.
    const nowIso = new Date().toISOString();
    const { map, storage } = makeStorage({
      [AUDIT_SEQ_KEY]: MAX_AUDIT_ENTRIES,
      [auditEntryKey(1)]: { seq: 1, ts: nowIso, actorId: 'x', actorEmail: '', action: 'seed', targetId: 't', before: null, after: null, outcome: 'success' },
      [auditEntryKey(2)]: { seq: 2, ts: nowIso, actorId: 'x', actorEmail: '', action: 'seed', targetId: 't', before: null, after: null, outcome: 'success' },
    });
    await appendAuditRow(storage, { action: 'new', actorId: 'x', actorEmail: '', targetId: 't', outcome: 'success' });
    expect(map.has(auditEntryKey(1))).toBe(false); // seq (MAX+1) - MAX = 1 pruned
    expect(map.has(auditEntryKey(2))).toBe(true);
    expect(map.has(auditEntryKey(MAX_AUDIT_ENTRIES + 1))).toBe(true);
  });

  it('prunes rows older than the age cap on append, stopping at the first fresh row', async () => {
    jest.useFakeTimers();
    try {
      const twoYearsAgo = new Date('2024-01-01T00:00:00.000Z').toISOString();
      const recent = new Date('2026-07-01T00:00:00.000Z').toISOString();
      const { map, storage } = makeStorage({
        [AUDIT_SEQ_KEY]: 2,
        [auditEntryKey(1)]: { seq: 1, ts: twoYearsAgo, actorId: 'x', actorEmail: '', action: 'old', targetId: 't', before: null, after: null, outcome: 'success' },
        [auditEntryKey(2)]: { seq: 2, ts: recent, actorId: 'x', actorEmail: '', action: 'fresh', targetId: 't', before: null, after: null, outcome: 'success' },
      });
      jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
      await appendAuditRow(storage, { action: 'new', actorId: 'x', actorEmail: '', targetId: 't', outcome: 'success' });
      expect(map.has(auditEntryKey(1))).toBe(false); // expired
      expect(map.has(auditEntryKey(2))).toBe(true); // within a year
      expect(map.has(auditEntryKey(3))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('list pagination', () => {
  async function seed(n: number) {
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { storage } = makeStorage();
    for (let i = 0; i < n; i++) {
      jest.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      await appendAuditRow(storage, { action: `a${i}`, actorId: 'x', actorEmail: '', targetId: String(i), outcome: 'success' });
    }
    return storage;
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns newest-first pages and walks the cursor to exhaustion', async () => {
    const storage = await seed(5);
    const p1 = await readAuditPage(storage, { limit: 2 });
    expect(p1.entries.map((e) => e.seq)).toEqual([5, 4]);
    expect(p1.nextCursor).toBe('4');
    const p2 = await readAuditPage(storage, { limit: 2, cursor: p1.nextCursor });
    expect(p2.entries.map((e) => e.seq)).toEqual([3, 2]);
    expect(p2.nextCursor).toBe('2');
    const p3 = await readAuditPage(storage, { limit: 2, cursor: p2.nextCursor });
    expect(p3.entries.map((e) => e.seq)).toEqual([1]);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('clamps the limit to [1, 200]', async () => {
    const storage = await seed(3);
    expect((await readAuditPage(storage, { limit: 0 })).entries.length).toBe(1); // clamps up to 1
    expect((await readAuditPage(storage, { limit: 999 })).entries.length).toBe(3); // clamps down, only 3 exist
    expect((await readAuditPage(storage, {})).entries.length).toBe(3); // default 50, only 3 exist
  });

  it('filters by from/to timestamp bounds', async () => {
    const storage = await seed(5); // ts at seconds :00..:04 on 2026-01-01
    const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString();
    const to = new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toISOString();
    const page = await readAuditPage(storage, { from, to, limit: 50 });
    expect(page.entries.map((e) => e.seq)).toEqual([4, 3]); // seq 3 (:02) and seq 4 (:03), newest-first
  });

  it('never returns entries past the one-year retention floor, in a page or an export', async () => {
    const { storage } = makeStorage();
    jest.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
    await appendAuditRow(storage, { action: 'old', actorId: 'x', actorEmail: '', targetId: '1', outcome: 'success' });
    // Advance past the one-year window; the old row is now beyond retention.
    jest.setSystemTime(new Date(Date.UTC(2027, 1, 1, 0, 0, 0)));
    await appendAuditRow(storage, { action: 'fresh', actorId: 'x', actorEmail: '', targetId: '2', outcome: 'success' });

    const page = await readAuditPage(storage, { limit: 50 });
    expect(page.entries.map((e) => e.action)).toEqual(['fresh']);
    const range = await readAuditRange(storage);
    expect(range.map((e) => e.action)).toEqual(['fresh']);
  });
});

describe('CSV export quoting (RFC 4180)', () => {
  it('quotes and escapes a value containing a comma, quote, and newline', () => {
    const csv = toCsv(['a', 'b'], [['plain', 'has,comma "quote" and\nnewline']]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('a,b');
    expect(row).toBe('plain,"has,comma ""quote"" and\nnewline"');
  });

  it.each(['=cmd|/c calc', '+1+2', '-2+3', '@SUM(A1)', '\ttab-lead'])(
    'neutralizes a spreadsheet formula-injection cell (%p)',
    (payload) => {
      const csv = toCsv(['a'], [[payload]]);
      const cell = csv.split('\r\n')[1];
      // The value is prefixed with a single quote so Excel/Sheets treat it as
      // text, then normal RFC-4180 quoting wraps it if it also contains a comma.
      expect(cell.startsWith("'") || cell.startsWith('"\'')).toBe(true);
      expect(cell).toContain(payload.replace(/"/g, '""'));
    },
  );

  it('leaves an ordinary leading character untouched', () => {
    expect(toCsv(['a'], [['ada@example.test']]).split('\r\n')[1]).toBe('ada@example.test');
  });

  it('quotes JSON before/after columns that contain commas and quotes', () => {
    const entries: AuditEntry[] = [
      {
        seq: 1,
        ts: '2026-01-01T00:00:00.000Z',
        actorId: 'admin',
        actorEmail: 'a@x.test',
        action: 'config.updated',
        targetId: 'admin:config:v1',
        before: null,
        after: { allowlistMode: true, adminRole: 'owner' },
        outcome: 'success',
      },
    ];
    const csv = auditEntriesToCsv(entries);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('seq,ts,actorId,actorEmail,action,targetId,before,after,outcome');
    // The after JSON has a comma, so the whole cell is quoted and its quotes doubled.
    expect(lines[1]).toContain('"{""allowlistMode"":true,""adminRole"":""owner""}"');
  });
});

describe('listUserPolicyDocs', () => {
  it('returns only user policy documents, keyed by hsUserId, ignoring config and audit keys', async () => {
    const { storage } = makeStorage({
      [ADMIN_CONFIG_KEY]: baseConfig(),
      [userPolicyKey('100')]: basePolicy({ email: 'a@x.test' }),
      [userPolicyKey('200')]: basePolicy({ email: 'b@x.test' }),
    });
    await appendAuditRow(storage, { action: 'noise', actorId: 'x', actorEmail: '', targetId: 't', outcome: 'success' });
    const users = await listUserPolicyDocs(storage);
    expect(users.map((u) => u.hsUserId).sort()).toEqual(['100', '200']);
    expect(users.find((u) => u.hsUserId === '100')?.policy.email).toBe('a@x.test');
  });
});

describe('access-list effective flags', () => {
  const narrowedCeiling: WriteFlagSet = { enabled: true, customerVisibleEnabled: false };

  it('narrows a full user grant to the ceiling', () => {
    const rows = buildAccessListRows(baseConfig({ allowlistMode: false }), narrowedCeiling, [
      { hsUserId: '1010', policy: basePolicy({ allowed: true, writes: true, customerVisibleWrites: true }) },
    ]);
    expect(rows[0].writes).toBe(true);
    expect(rows[0].customerVisibleWrites).toBe(true);
    expect(rows[0].effectiveWrites).toBe(true);
    expect(rows[0].effectiveCustomerVisibleWrites).toBe(false); // ceiling withholds customer-visible
    expect(rows[0].effectiveAllowed).toBe(true);
  });

  it('reflects an explicit block and allowlist admission in effectiveAllowed', () => {
    const blocked = buildAccessListRows(baseConfig({ allowlistMode: false }), narrowedCeiling, [
      { hsUserId: '1', policy: basePolicy({ allowed: false, writes: true }) },
    ]);
    // effectiveAllowed is the admission decision; the effective WRITE flags are
    // the ceiling intersection reported independently (admission is the separate
    // column a reader gates on), so a blocked user still shows their write reach.
    expect(blocked[0].effectiveAllowed).toBe(false);
    expect(blocked[0].effectiveWrites).toBe(true);

    const allowlistBlocked = buildAccessListRows(baseConfig({ allowlistMode: true }), narrowedCeiling, [
      { hsUserId: '2', policy: basePolicy({ allowed: false }) },
    ]);
    expect(allowlistBlocked[0].effectiveAllowed).toBe(false);

    const allowlisted = buildAccessListRows(baseConfig({ allowlistMode: true }), narrowedCeiling, [
      { hsUserId: '3', policy: basePolicy({ allowed: true }) },
    ]);
    expect(allowlisted[0].effectiveAllowed).toBe(true);
  });

  it('sorts rows by hsUserId for a stable export', () => {
    const rows = buildAccessListRows(baseConfig(), narrowedCeiling, [
      { hsUserId: '30', policy: basePolicy() },
      { hsUserId: '10', policy: basePolicy() },
      { hsUserId: '20', policy: basePolicy() },
    ]);
    expect(rows.map((r) => r.hsUserId)).toEqual(['10', '20', '30']);
  });

  it('serializes access-list rows to CSV with the documented header', () => {
    const rows = buildAccessListRows(baseConfig(), narrowedCeiling, [
      { hsUserId: '1010', policy: basePolicy({ writes: true, email: 'u@x.test' }) },
    ]);
    const csv = accessListToCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'hsUserId,email,allowed,writes,customerVisibleWrites,effectiveAllowed,effectiveWrites,effectiveCustomerVisibleWrites,updatedAt,updatedBy,version',
    );
    expect(lines[1].startsWith('1010,u@x.test,true,true,false')).toBe(true);
  });
});
