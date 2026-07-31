/**
 * The per-deployment access-policy coordinator (NAS-1501), a Durable Object that
 * OWNS the policy documents in its own transactional storage.
 *
 * Every worker request resolves this DO by the fixed name POLICY_COORDINATOR_NAME
 * (env.POLICY_OBJECT.idFromName), so the whole deployment funnels through the ONE
 * instance. A Durable Object is single-threaded and input-gated: while a request
 * is awaiting a storage operation no other event is delivered to the instance, so
 * a read-modify-write that only awaits storage between its read and its write is
 * atomic with respect to every other request. That is what upgrades the two
 * defects the KV store had:
 *   1. Reads are strongly consistent — a /callback right after a revoke sees the
 *      deny, with no eventually-consistent colo lag.
 *   2. The version check-and-increment is an atomic compare-and-swap — two admins
 *      presenting the same expectedVersion cannot both succeed; the second reads
 *      the first's write and gets a conflict. No lost update.
 *
 * The transactional CAS logic itself lives in policy.ts over the PolicyStorage
 * interface (so it is unit-testable against an in-memory fake). This class is the
 * thin adapter that (a) binds that interface to ctx.storage and (b) flattens the
 * typed policy errors into transport envelopes, because a thrown custom Error
 * does not keep its class across the RPC boundary.
 *
 * Cloudflare storage notes relied on (developers.cloudflare.com, Durable Objects
 * Storage API): storage.get(key) returns the stored value or `undefined` when the
 * key does not exist; ctx.storage.transaction(closure) runs its body atomically,
 * and on the SQLite-backed engine any operations performed directly on
 * ctx.storage inside the closure are part of that transaction (the passed `txn`
 * object is obsolete there). Cloudflare recommends all new Durable Object
 * namespaces use the SQLite storage backend, which this class does
 * (new_sqlite_classes, migration v2 in wrangler.jsonc), matching HelpScoutMCP.
 */
import { DurableObject } from 'cloudflare:workers';

import {
  clearConfigDoc,
  clearUserPolicyDoc,
  pinUserPolicyRevoked,
  readConfigDoc,
  readUserPolicyDoc,
  toPolicyErrorEnvelope,
  writeConfigDoc,
  writeUserPolicyDoc,
  type ConfigDocResult,
  type ConfigPatch,
  type MutationMeta,
  type PolicyErrorEnvelope,
  type PolicyStorage,
  type UserPolicyDocResult,
  type UserPolicyInput,
  type UserPolicyWriteResult,
} from './policy.js';

export class PolicyCoordinator extends DurableObject {
  /**
   * The PolicyStorage the CAS core runs over, bound to this instance's storage.
   * `transaction` delegates to ctx.storage.transaction and the closure reads and
   * writes through the same adapter (i.e. directly on ctx.storage), which the
   * SQLite engine counts as part of the transaction. Even absent the explicit
   * transaction, the closure only awaits storage between its read and write, so
   * the input gate already serializes concurrent requests; the transaction makes
   * the atomic-commit guarantee explicit and survives a future edit.
   */
  private readonly store: PolicyStorage = {
    get: <T>(key: string): Promise<T | undefined> => this.ctx.storage.get<T>(key),
    put: (key: string, value: unknown): Promise<void> => this.ctx.storage.put(key, value),
    delete: async (key: string): Promise<void> => {
      await this.ctx.storage.delete(key);
    },
    transaction: <T>(closure: () => Promise<T>): Promise<T> => this.ctx.storage.transaction(() => closure()),
  };

  async getConfigDoc(): Promise<ConfigDocResult> {
    return this.envelope(() => readConfigDoc(this.store));
  }

  async putConfigDoc(patch: ConfigPatch, meta: MutationMeta): Promise<ConfigDocResult> {
    return this.envelope(() => writeConfigDoc(this.store, patch, meta));
  }

  async deleteConfigDoc(): Promise<void> {
    await clearConfigDoc(this.store);
  }

  async getUserPolicyDoc(hsUserId: string): Promise<UserPolicyDocResult> {
    return this.envelope(() => readUserPolicyDoc(this.store, hsUserId));
  }

  async putUserPolicyDoc(hsUserId: string, input: UserPolicyInput, meta: MutationMeta): Promise<UserPolicyWriteResult> {
    return this.envelope(() => writeUserPolicyDoc(this.store, hsUserId, input, meta));
  }

  async deleteUserPolicyDoc(hsUserId: string): Promise<void> {
    await clearUserPolicyDoc(this.store, hsUserId);
  }

  async pinRevokedUser(hsUserId: string, updatedBy: string): Promise<UserPolicyWriteResult> {
    return this.envelope(() => pinUserPolicyRevoked(this.store, hsUserId, updatedBy));
  }

  /**
   * Run a core op and flatten a known policy error into a transport envelope.
   * An unexpected error (a storage failure) is re-thrown so it crosses the RPC
   * boundary as a rejection and the worker-side caller fails closed.
   */
  private async envelope<T>(
    op: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: PolicyErrorEnvelope }> {
    try {
      return { ok: true, value: await op() };
    } catch (error) {
      const envelope = toPolicyErrorEnvelope(error);
      if (envelope) return { ok: false, error: envelope };
      throw error;
    }
  }
}
