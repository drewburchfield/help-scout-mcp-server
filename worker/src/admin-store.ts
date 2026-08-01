/**
 * Env-facing reads/writes the admin surface needs beyond policy-store/audit-store
 * (NAS-1503): the cached Help Scout user directory and the full list of user
 * policy documents that the roster merges.
 *
 * Like policy-store and audit-store, this is a thin wrapper that resolves the ONE
 * coordinator Durable Object by its fixed name and RPCs it. The admin HTTP layer
 * (admin-handler.ts) wraps these in session + CSRF authorization; these functions
 * own no auth of their own.
 */
import {
  POLICY_COORDINATOR_NAME,
  type UserDirectory,
  type UserPolicy,
} from './policy.js';

/** The coordinator's admin RPC surface, as seen through its Durable Object stub. */
interface AdminCoordinatorStub {
  getDirectory(): Promise<UserDirectory | null>;
  putDirectory(directory: UserDirectory): Promise<void>;
  listUserPolicies(): Promise<Array<{ hsUserId: string; policy: UserPolicy }>>;
}

/** The subset of the worker env the admin store needs. */
export interface AdminStoreEnv {
  POLICY_OBJECT: DurableObjectNamespace;
}

/** Resolve the single coordinator instance by its fixed name (same as policy-store/audit-store). */
function coordinator(env: AdminStoreEnv): AdminCoordinatorStub {
  const namespace = env.POLICY_OBJECT;
  if (!namespace) {
    throw new Error(
      "POLICY_OBJECT Durable Object binding is missing from this deployment's wrangler config. " +
        'The admin surface requires it. Add the POLICY_OBJECT binding and the v2 migration to your ' +
        'wrangler.deploy.jsonc, then re-deploy. See the upgrade section of guides/remote-self-host.md.',
    );
  }
  const id = namespace.idFromName(POLICY_COORDINATOR_NAME);
  return namespace.get(id) as unknown as AdminCoordinatorStub;
}

/** Read the cached Help Scout user directory, or null when login has not populated it. */
export async function getDirectory(env: AdminStoreEnv): Promise<UserDirectory | null> {
  return coordinator(env).getDirectory();
}

/** Overwrite the cached Help Scout user directory (populated at admin login). */
export async function putDirectory(env: AdminStoreEnv, directory: UserDirectory): Promise<void> {
  await coordinator(env).putDirectory(directory);
}

/** List every stored user policy document, keyed by hsUserId, for the roster merge. */
export async function listUserPolicies(env: AdminStoreEnv): Promise<Map<string, UserPolicy>> {
  const rows = await coordinator(env).listUserPolicies();
  const map = new Map<string, UserPolicy>();
  for (const { hsUserId, policy } of rows) map.set(hsUserId, policy);
  return map;
}
