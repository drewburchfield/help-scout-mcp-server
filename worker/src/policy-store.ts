/**
 * The env-facing entry points to the access-policy engine (NAS-1501).
 *
 * These are the functions the /callback gate (help-scout-handler.ts), the
 * McpAgent dispatch gate (mcp-agent.ts), and the test-seeding route
 * (test-policy-route.ts) call. They keep the exact signatures the KV-backed
 * versions had, so callers changed only their import path; internally each now
 * RPCs the ONE coordinator Durable Object (policy-coordinator.ts), which owns the
 * documents in strongly-consistent, transactional storage.
 *
 * This module, not policy.ts, is where the Workers runtime types live
 * (DurableObjectNamespace, OAuthHelpers): policy.ts stays runtime-type-free so
 * the root unit suite can type-check and drive its CAS core directly.
 *
 * Error handling: the coordinator returns a discriminated envelope rather than
 * throwing across RPC (a thrown custom Error loses its class over the boundary),
 * so a policy conflict / invalid-document surfaces here as the reconstructed
 * PolicyConflictError / PolicyInvalidError — the same types callers already
 * catch. An unexpected storage failure rejects the RPC and propagates as a
 * generic error, which the read/write gates treat as fail-closed.
 *
 * The audit hook stays here, fired after the coordinator confirms a write: a
 * real sink is worker infrastructure, and a function cannot cross the RPC seam.
 */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import {
  POLICY_COORDINATOR_NAME,
  throwPolicyError,
  type AdminConfig,
  type ConfigDocResult,
  type ConfigPatch,
  type MutationMeta,
  type MutationOptions,
  type PolicyAuditHook,
  type RevokeUserResult,
  type UserPolicy,
  type UserPolicyDocResult,
  type UserPolicyInput,
  type UserPolicyWriteResult,
} from './policy.js';

/** The coordinator's RPC surface, as seen through its Durable Object stub. */
interface PolicyCoordinatorStub {
  getConfigDoc(): Promise<ConfigDocResult>;
  putConfigDoc(patch: ConfigPatch, meta: MutationMeta): Promise<ConfigDocResult>;
  deleteConfigDoc(): Promise<void>;
  getUserPolicyDoc(hsUserId: string): Promise<UserPolicyDocResult>;
  putUserPolicyDoc(hsUserId: string, input: UserPolicyInput, meta: MutationMeta): Promise<UserPolicyWriteResult>;
  deleteUserPolicyDoc(hsUserId: string): Promise<void>;
  pinRevokedUser(hsUserId: string, updatedBy: string): Promise<UserPolicyWriteResult>;
}

/** The subset of the worker env the read/write policy functions need. */
export interface PolicyStoreEnv {
  POLICY_OBJECT: DurableObjectNamespace;
}

/** revokeUser additionally needs the provider helpers to list and revoke grants. */
export interface PolicyRevokeEnv extends PolicyStoreEnv {
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Resolve the single coordinator instance by its fixed name. */
function coordinator(env: PolicyStoreEnv): PolicyCoordinatorStub {
  const namespace = env.POLICY_OBJECT;
  // A deployment upgraded with an older wrangler.deploy.jsonc that predates the
  // policy coordinator has no POLICY_OBJECT binding, so this is undefined. Left
  // unchecked, `namespace.idFromName` throws a cryptic "cannot read properties of
  // undefined", which every policy read/write turns into an opaque "access could
  // not be verified" (the gates fail closed on any throw). Name the real cause
  // instead so an operator knows exactly which config edit is missing.
  if (!namespace) {
    throw new Error(
      'POLICY_OBJECT Durable Object binding is missing from this deployment\'s wrangler config. ' +
        'This build\'s access-policy engine requires it. Add the POLICY_OBJECT binding and the v2 ' +
        'migration to your wrangler.deploy.jsonc, then re-deploy. See the upgrade section of ' +
        'guides/remote-self-host.md.',
    );
  }
  const id = namespace.idFromName(POLICY_COORDINATOR_NAME);
  return namespace.get(id) as unknown as PolicyCoordinatorStub;
}

/**
 * Read the deployment config. A missing document is open-mode defaults; a stored
 * document this build cannot interpret throws PolicyInvalidError (fail closed).
 */
export async function getConfig(env: PolicyStoreEnv): Promise<AdminConfig> {
  const result = await coordinator(env).getConfigDoc();
  if (!result.ok) throwPolicyError(result.error);
  return result.value;
}

/**
 * Write the deployment config with an atomic version check-and-increment. A
 * stale expectedVersion throws PolicyConflictError and writes nothing.
 */
export async function putConfig(env: PolicyStoreEnv, patch: ConfigPatch, opts: MutationOptions): Promise<AdminConfig> {
  const result = await coordinator(env).putConfigDoc(patch, {
    expectedVersion: opts.expectedVersion,
    updatedBy: opts.updatedBy,
  });
  if (!result.ok) throwPolicyError(result.error);
  await opts.audit?.({ type: 'config.updated', version: result.value.version, updatedBy: opts.updatedBy, config: result.value });
  return result.value;
}

/** Delete the config document (harness/admin seam). Absence reads as open-mode defaults. */
export async function deleteConfig(env: PolicyStoreEnv): Promise<void> {
  await coordinator(env).deleteConfigDoc();
}

/** Read one user's policy, or null when the user has no explicit entry. */
export async function getUserPolicy(env: PolicyStoreEnv, hsUserId: string | number): Promise<UserPolicy | null> {
  const result = await coordinator(env).getUserPolicyDoc(String(hsUserId));
  if (!result.ok) throwPolicyError(result.error);
  return result.value;
}

/**
 * Write one user's policy with an atomic version check-and-increment, enforcing
 * the customerVisibleWrites => writes invariant. A stale expectedVersion throws
 * PolicyConflictError.
 */
export async function putUserPolicy(
  env: PolicyStoreEnv,
  hsUserId: string | number,
  input: UserPolicyInput,
  opts: MutationOptions,
): Promise<UserPolicy> {
  const id = String(hsUserId);
  const result = await coordinator(env).putUserPolicyDoc(id, input, {
    expectedVersion: opts.expectedVersion,
    updatedBy: opts.updatedBy,
  });
  if (!result.ok) throwPolicyError(result.error);
  await opts.audit?.({ type: 'user.policy.updated', hsUserId: id, version: result.value.version, updatedBy: opts.updatedBy, policy: result.value });
  return result.value;
}

/** Delete one user's policy document (harness/admin seam). */
export async function deleteUserPolicy(env: PolicyStoreEnv, hsUserId: string | number): Promise<void> {
  await coordinator(env).deleteUserPolicyDoc(String(hsUserId));
}

/**
 * Hard-revoke a user: revoke every OAuth grant the provider holds for them, then
 * pin their policy to allowed:false through the coordinator's atomic put. Listing
 * is paged in case a user holds many grants.
 *
 * The two effects are complementary: allowed:false denies any re-connection
 * attempt and any session serving reads from an unexpired policy cache once that
 * cache lapses, and revoking grants invalidates every live access token
 * immediately (the next /mcp request fails auth at the library layer). The pin
 * runs inside the DO in one transaction and carries no expectedVersion, so a
 * racing admin edit cannot re-open the account: the revoke is authoritative.
 *
 * The deny is pinned FIRST, before any grant is revoked, so a partial failure
 * fails safe: if grant revocation errors midway, the user is already blocked
 * from reconnecting and their live sessions lapse at the cache boundary, rather
 * than being kicked out but left able to sign straight back in.
 */
export async function revokeUser(
  env: PolicyRevokeEnv,
  hsUserId: string | number,
  opts: { updatedBy: string; audit?: PolicyAuditHook },
): Promise<RevokeUserResult> {
  const id = String(hsUserId);

  const result = await coordinator(env).pinRevokedUser(id, opts.updatedBy);
  if (!result.ok) throwPolicyError(result.error);
  const policy = result.value;

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

  await opts.audit?.({ type: 'user.revoked', hsUserId: id, grantsRevoked, updatedBy: opts.updatedBy, policy });
  return { hsUserId: id, grantsRevoked, policy };
}
