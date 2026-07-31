/**
 * Env-facing reads and evidence exports over the audit ledger (NAS-1502).
 *
 * These are plain functions the future admin GUI (NAS-1503) will call from its
 * admin-gated endpoints, and that the secret-gated test route drives in the
 * smoke. They own NO HTTP surface and NO auth of their own: this ticket builds
 * the storage, recording, and export logic; the GUI wraps it in authorization.
 *
 * The authoritative ledger lives in the ONE policy coordinator Durable Object
 * (policy-coordinator.ts): mutations record their audit rows inside the same
 * transaction as the document they change, so ordering is authoritative and the
 * ledger cannot drift from the policy documents. This module resolves that DO by
 * the same fixed name every policy read/write uses and RPCs its audit methods.
 *
 * The two observational recorders (recordGrantCreated / recordAdmissionDenied)
 * are best-effort by contract: a failed audit append must NOT fail the
 * user-facing /callback flow, so they swallow and log rather than throw.
 */
import { logger } from '../../src/utils/logger.js';
import type { Env } from './mcp-agent.js';
import {
  POLICY_COORDINATOR_NAME,
  accessListToCsv,
  auditEntriesToCsv,
  type AccessListRow,
  type AdminConfig,
  type AuditEntry,
  type AuditEventInput,
  type AuditListOptions,
  type AuditListPage,
  type UserPolicy,
  type WriteFlagSet,
} from './policy.js';

/** The coordinator's audit RPC surface, as seen through its Durable Object stub. */
interface AuditCoordinatorStub {
  appendAuditEvent(input: AuditEventInput): Promise<void>;
  listAuditPage(options: AuditListOptions): Promise<AuditListPage>;
  listAuditRange(options: { from?: string; to?: string }): Promise<AuditEntry[]>;
  listUserPolicies(): Promise<Array<{ hsUserId: string; policy: UserPolicy }>>;
  computeAccessList(ceiling: WriteFlagSet): Promise<{ config: AdminConfig; rows: AccessListRow[] }>;
}

/** The subset of the worker env the audit reads/exports need. */
export interface AuditStoreEnv {
  POLICY_OBJECT: DurableObjectNamespace;
  HELPSCOUT_ENABLE_WRITES?: string;
  HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES?: string;
}

/** Resolve the single coordinator instance by its fixed name (same as policy-store). */
function coordinator(env: AuditStoreEnv): AuditCoordinatorStub {
  const namespace = env.POLICY_OBJECT;
  if (!namespace) {
    throw new Error(
      "POLICY_OBJECT Durable Object binding is missing from this deployment's wrangler config. " +
        "The audit trail requires it. Add the POLICY_OBJECT binding and the v2 migration to your " +
        'wrangler.deploy.jsonc, then re-deploy. See the upgrade section of guides/remote-self-host.md.',
    );
  }
  const id = namespace.idFromName(POLICY_COORDINATOR_NAME);
  return namespace.get(id) as unknown as AuditCoordinatorStub;
}

/**
 * A stable per-deployment identifier stamped on every export, derived WITHOUT any
 * new config: the coordinator Durable Object id is idFromName(POLICY_COORDINATOR_NAME),
 * a deterministic hash of the name within THIS deployment's DO namespace, so its
 * hex string is stable across restarts and distinct across deployments.
 */
export function deploymentId(env: AuditStoreEnv): string {
  return env.POLICY_OBJECT.idFromName(POLICY_COORDINATOR_NAME).toString();
}

/** The deployment write ceiling read off the env vars (the same gate the agent uses). */
function ceilingFromEnv(env: AuditStoreEnv): WriteFlagSet {
  return {
    enabled: env.HELPSCOUT_ENABLE_WRITES === 'true',
    customerVisibleEnabled: env.HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES === 'true',
  };
}

/**
 * Record a grant.created event after completeAuthorization succeeds. The actor is
 * the user themselves. Best-effort: a failed append is logged, never thrown, so a
 * completed sign-in is never turned into a failure by an audit hiccup.
 */
export async function recordGrantCreated(
  env: Env,
  args: { hsUserId: string | number; email: string; clientId: string },
): Promise<void> {
  try {
    await coordinator(env).appendAuditEvent({
      action: 'grant.created',
      actorId: String(args.hsUserId),
      actorEmail: args.email,
      targetId: String(args.hsUserId),
      before: null,
      after: { clientId: args.clientId },
      outcome: 'success',
    });
  } catch (error) {
    logger.warn('Audit append failed (grant.created)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Record an admission.denied event when the /callback gate denies a sign-in. The
 * reason is the evaluateAccess reason (explicit-block | allowlist). Best-effort,
 * for the same reason as recordGrantCreated.
 */
export async function recordAdmissionDenied(
  env: Env,
  args: { hsUserId: string | number; email: string; reason: 'explicit-block' | 'allowlist' | undefined },
): Promise<void> {
  try {
    await coordinator(env).appendAuditEvent({
      action: 'admission.denied',
      actorId: String(args.hsUserId),
      actorEmail: args.email,
      targetId: String(args.hsUserId),
      before: null,
      after: { reason: args.reason ?? 'denied' },
      outcome: 'denied',
    });
  } catch (error) {
    logger.warn('Audit append failed (admission.denied)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A newest-first page of audit entries plus the cursor for the next (older) page. */
export async function listAuditEntries(env: AuditStoreEnv, options: AuditListOptions = {}): Promise<AuditListPage> {
  return coordinator(env).listAuditPage(options);
}

/** Discriminated JSON audit export: the full range plus provenance stamps. */
export interface AuditExportJson {
  format: 'json';
  generatedAt: string;
  deploymentId: string;
  count: number;
  entries: AuditEntry[];
}

/** Discriminated CSV audit export: an RFC-4180 document plus provenance stamps. */
export interface AuditExportCsv {
  format: 'csv';
  generatedAt: string;
  deploymentId: string;
  count: number;
  csv: string;
}

export type AuditExport = AuditExportJson | AuditExportCsv;

/**
 * Export the full audit range (bounded by retention) as JSON or CSV, stamped with
 * generatedAt and the stable deploymentId. JSON carries the structured entries;
 * CSV is RFC-4180 with a header row and quoted before/after JSON columns.
 */
export async function exportAuditLog(
  env: AuditStoreEnv,
  options: { from?: string; to?: string; format: 'json' | 'csv' },
): Promise<AuditExport> {
  const entries = await coordinator(env).listAuditRange({ from: options.from, to: options.to });
  const generatedAt = new Date().toISOString();
  const id = deploymentId(env);
  if (options.format === 'csv') {
    return { format: 'csv', generatedAt, deploymentId: id, count: entries.length, csv: auditEntriesToCsv(entries) };
  }
  return { format: 'json', generatedAt, deploymentId: id, count: entries.length, entries };
}

/** The config provenance stamped on an access-list export. */
export interface AccessListConfigSummary {
  allowlistMode: boolean;
  adminRole: AdminConfig['adminRole'];
  ceiling: WriteFlagSet;
}

/** Discriminated JSON access-list export: current effective entitlements + stamps. */
export interface AccessListExportJson {
  format: 'json';
  generatedAt: string;
  deploymentId: string;
  count: number;
  config: AccessListConfigSummary;
  rows: AccessListRow[];
}

/** Discriminated CSV access-list export. */
export interface AccessListExportCsv {
  format: 'csv';
  generatedAt: string;
  deploymentId: string;
  count: number;
  config: AccessListConfigSummary;
  csv: string;
}

export type AccessListExport = AccessListExportJson | AccessListExportCsv;

/**
 * Export the CURRENT effective entitlements: every user policy evaluated against
 * the deployment config and the env write ceiling, each row carrying the stored
 * grants, the effective flags under the ceiling, and the mutation provenance.
 * Stamped with generatedAt, the stable deploymentId, and the config summary.
 */
export async function exportAccessList(
  env: AuditStoreEnv,
  options: { format: 'json' | 'csv' },
): Promise<AccessListExport> {
  const ceiling = ceilingFromEnv(env);
  const { config, rows } = await coordinator(env).computeAccessList(ceiling);
  const generatedAt = new Date().toISOString();
  const id = deploymentId(env);
  const summary: AccessListConfigSummary = {
    allowlistMode: config.allowlistMode,
    adminRole: config.adminRole,
    ceiling,
  };
  if (options.format === 'csv') {
    return { format: 'csv', generatedAt, deploymentId: id, count: rows.length, config: summary, csv: accessListToCsv(rows) };
  }
  return { format: 'json', generatedAt, deploymentId: id, count: rows.length, config: summary, rows };
}
