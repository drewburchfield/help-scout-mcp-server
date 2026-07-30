import { GatewayHandler } from '../dist/tools/gateway.js';
import { toolHandler } from '../dist/tools/index.js';
import { writeHandler } from '../dist/tools/writes.js';

/**
 * The write gates a candidate can be built with. `off` is the 2.0 surface,
 * `tier1` adds the nonDestructive and reversible operations, and `tier2` adds
 * the externallyVisible ones on top.
 */
export const WRITE_MODES = ['off', 'tier1', 'tier2'];

const WRITE_FLAGS = {
  off: { enabled: false, customerVisibleEnabled: false },
  tier1: { enabled: true, customerVisibleEnabled: false },
  tier2: { enabled: true, customerVisibleEnabled: true },
};

// Each gate is a separate candidate name so a screen can compare the surfaces
// against each other and so per-candidate summaries stay unambiguous.
const CANDIDATE_NAMES = {
  off: 'production-gateway',
  tier1: 'production-gateway-writes',
  tier2: 'production-gateway-writes-tier2',
};

export function productionCandidateName(writes = 'off') {
  return CANDIDATE_NAMES[writes];
}

function jsonResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function zodIssues(error) {
  if (!error || typeof error !== 'object' || !('issues' in error)) return undefined;
  return error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
}

/**
 * The real write operations with only the Help Scout request replaced.
 *
 * Schemas, mutation classes, tiers, confirmation handling, and argument
 * validation all stay real, so the screen exercises the shipped gating. An eval
 * must never reach the live API, and a write operation executes through its own
 * handler rather than through OperationRegistry.callTool, so swapping the
 * operation executor alone would not have stopped it.
 */
function fixtureWriteRegistry(executeOperation) {
  return {
    listOperations: () => writeHandler.listOperations().map((operation) => ({
      ...operation,
      execute: async (args) => {
        try {
          // plan() parses with the operation's own schema, so invalid fixture
          // arguments still produce a model-correctable error rather than a
          // fabricated success.
          operation.plan(args);
        } catch (error) {
          return jsonResult({
            error: `Invalid arguments for ${operation.tool.name}.`,
            operation: operation.tool.name,
            validationIssues: zodIssues(error),
          }, true);
        }
        return executeOperation(operation.tool.name, args ?? {});
      },
    })),
  };
}

/**
 * Wraps the production GatewayHandler as a discriminator candidate so the
 * stdio screen exercises the shipped surface instead of the prototype.
 * Operation execution can be swapped for the fixture executor, and the write
 * gates are injected rather than read from the environment.
 */
export async function createProductionGatewayCandidate(options = {}) {
  const writes = options.writes ?? 'off';
  if (!WRITE_MODES.includes(writes)) {
    throw new Error(`Unknown write mode: ${writes}. Expected one of ${WRITE_MODES.join(', ')}.`);
  }
  // Without a fixture executor the candidate would fall back to the real write
  // handler, and an eval would mutate the live Help Scout account. Refuse to
  // build one rather than let the default decide.
  if (writes !== 'off' && typeof options.executeOperation !== 'function') {
    throw new Error(
      `Write mode "${writes}" requires an executeOperation fixture. Building it without one would run the live write handler against the real Help Scout account.`,
    );
  }

  const operations = {
    listTools: () => toolHandler.listTools(),
    callTool: async (request) => {
      if (typeof options.executeOperation !== 'function') {
        return toolHandler.callTool(request);
      }
      const args = { ...(request.params.arguments || {}) };
      delete args.__userQuery;
      return options.executeOperation(request.params.name, args);
    },
  };

  const gateway = new GatewayHandler(operations, {
    writeFlags: WRITE_FLAGS[writes],
    // `writes` here is the write operation registry, not the mode above.
    ...(typeof options.executeOperation === 'function'
      ? { writes: fixtureWriteRegistry(options.executeOperation) }
      : {}),
  });

  return {
    name: CANDIDATE_NAMES[writes],
    writes,
    tools: await gateway.listTools(),
    reachableOperations: await gateway.listOperationNames(),
    call: (name, args) => gateway.callTool({
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  };
}
