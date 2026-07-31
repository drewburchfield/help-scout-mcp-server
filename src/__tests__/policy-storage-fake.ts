/**
 * Shared in-memory PolicyStorage fake for the worker policy + audit unit suites.
 *
 * It faithfully models the coordinator Durable Object's storage: values are
 * stored by structured copy (no aliasing, like real serialized storage);
 * `transaction` serializes its closures through a promise chain, the way a
 * single-threaded, input-gated Durable Object serializes concurrent requests (a
 * rejected transaction still lets the next proceed); and `list` returns a Map in
 * ascending key order honoring { prefix, limit, reverse, start, startAfter, end }
 * with `end` EXCLUSIVE, matching the Durable Objects Storage API contract the
 * audit ledger relies on.
 *
 * It deliberately does NOT model transaction rollback (a rejected DO transaction
 * rolls back, this fake does not) because the audit core never throws for
 * control flow inside a transaction, so no test depends on rollback. This is the
 * one place both suites get their storage semantics, so they cannot drift.
 */
import type { PolicyListOptions, PolicyStorage } from '../../worker/src/policy.js';

export function makeStorage(initial: Record<string, unknown> = {}): {
  map: Map<string, unknown>;
  storage: PolicyStorage;
} {
  const map = new Map<string, unknown>(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
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
    list: async <T>(options: PolicyListOptions = {}): Promise<Map<string, T>> => {
      const { prefix, limit, reverse, start, startAfter, end } = options;
      let keys = [...map.keys()].sort();
      if (prefix !== undefined) keys = keys.filter((k) => k.startsWith(prefix));
      if (start !== undefined) keys = keys.filter((k) => k >= start);
      if (startAfter !== undefined) keys = keys.filter((k) => k > startAfter);
      if (end !== undefined) keys = keys.filter((k) => k < end); // exclusive upper bound
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      const out = new Map<string, T>();
      for (const k of keys) out.set(k, structuredClone(map.get(k)) as T);
      return out;
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
