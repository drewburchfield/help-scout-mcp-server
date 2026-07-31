/**
 * Test-harness-only HTTP route for seeding and inspecting the policy engine.
 *
 * The worker has no admin API yet (NAS-1503), and `wrangler dev` exposes no way
 * to reach into the coordinator DO's storage mid-run, so the smoke suite needs an
 * in-process seam to seed the config/policy documents and to drive revokeUser.
 * This route provides exactly that and NOTHING else: it is mounted only when
 * HELPSCOUT_TEST_POLICY_ROUTES === "true", which the deployment template never
 * sets and the smoke asserts is absent by default (the route 404s without it).
 *
 * It is a thin dispatch over the same exported policy functions the real admin
 * API will call, so it exercises the production seams (which now RPC the
 * coordinator) rather than a parallel path. It is intentionally not a general
 * storage console: only the two policy documents can be deleted, via typed ops.
 */
import type { Env } from './mcp-agent.js';
import { PolicyConflictError, type ConfigPatch, type UserPolicyInput } from './policy.js';
import {
  deleteConfig,
  deleteUserPolicy,
  getConfig,
  getUserPolicy,
  putConfig,
  putUserPolicy,
  revokeUser,
} from './policy-store.js';
import { exportAccessList, exportAuditLog, listAuditEntries } from './audit-store.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface TestCommand {
  op?: string;
  target?: 'config' | 'user';
  hsUserId?: string | number;
  patch?: ConfigPatch;
  input?: UserPolicyInput;
  expectedVersion?: number;
  updatedBy?: string;
  // Audit read/export parameters (NAS-1502).
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
  format?: 'json' | 'csv';
}

export async function handleTestPolicyRoute(request: Request, env: Env): Promise<Response> {
  let command: TestCommand;
  try {
    command = (await request.json()) as TestCommand;
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  const updatedBy = command.updatedBy ?? 'smoke-harness';

  try {
    switch (command.op) {
      case 'del': {
        if (command.target === 'config') {
          await deleteConfig(env);
        } else if (command.target === 'user') {
          await deleteUserPolicy(env, String(command.hsUserId));
        } else {
          return json({ error: 'del requires target "config" or "user".' }, 400);
        }
        return json({ ok: true });
      }
      case 'getConfig':
        return json({ config: await getConfig(env) });
      case 'putConfig':
        return json({
          config: await putConfig(env, command.patch ?? {}, {
            expectedVersion: command.expectedVersion ?? 0,
            updatedBy,
          }),
        });
      case 'getUserPolicy':
        return json({ policy: await getUserPolicy(env, String(command.hsUserId)) });
      case 'putUserPolicy': {
        if (!command.input) return json({ error: 'putUserPolicy requires input.' }, 400);
        return json({
          policy: await putUserPolicy(env, String(command.hsUserId), command.input, {
            expectedVersion: command.expectedVersion ?? 0,
            updatedBy,
          }),
        });
      }
      case 'revokeUser':
        return json({ result: await revokeUser(env, String(command.hsUserId), { updatedBy }) });
      case 'auditList':
        return json({
          page: await listAuditEntries(env, {
            cursor: command.cursor,
            limit: command.limit,
            from: command.from,
            to: command.to,
          }),
        });
      case 'auditExport':
        return json({ export: await exportAuditLog(env, { from: command.from, to: command.to, format: command.format ?? 'json' }) });
      case 'accessListExport':
        return json({ export: await exportAccessList(env, { format: command.format ?? 'json' }) });
      default:
        return json({ error: `Unknown op: ${command.op}` }, 400);
    }
  } catch (error) {
    if (error instanceof PolicyConflictError) {
      return json(
        {
          error: error.message,
          code: error.code,
          expectedVersion: error.expectedVersion,
          currentVersion: error.currentVersion,
        },
        409,
      );
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
