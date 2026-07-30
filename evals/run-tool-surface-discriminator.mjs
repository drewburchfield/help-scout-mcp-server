import 'dotenv/config';

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createToolSurfacePrototypes } from './tool-surface-prototype.mjs';
import { WRITE_MODES, createProductionGatewayCandidate } from './production-gateway-candidate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:8317/v1/chat/completions';
const MODELS = (process.env.EVAL_MODELS || 'gpt-5.6,claude-sonnet-5')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const CANDIDATE_NAMES = (process.env.EVAL_CANDIDATES || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const MAX_TURNS = 12;
const REQUEST_TIMEOUT_MS = 90000;
const TOOL_RESULT_CHARACTER_CAP = 30000;
const CHECKPOINT = '/tmp/helpscout-tool-surface-discriminator.json';

const SYSTEM = [
  'You are evaluating a Help Scout MCP server.',
  'Use the advertised tools to complete the user request.',
  'Some surfaces expose read operations only; others also expose write operations.',
  'Tool results contain controlled fixture data.',
  'Do not invent capabilities or claim a write occurred.',
  'Do not ask the user for an operation name or tool name.',
].join(' ');

/** Ordering for `requiresWrites`: a tier-1 job also runs on a tier-2 surface. */
const WRITE_MODE_RANK = { off: 0, tier1: 1, tier2: 2 };

/** Fixture tags on conversation 900, so a tag merge has something to preserve. */
const FIXTURE_CONVERSATION_TAGS = ['refund', 'billing'];

export const jobs = JSON.parse(
  readFileSync(resolve(HERE, 'tool-surface-discriminator-jobs.json'), 'utf8'),
);

function jsonResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

/** The success envelope a write operation returns, per the write tool contract. */
function writeResult(operation, mutationClass, conversationId, result, cleanupInstructions) {
  return jsonResult({
    operation,
    mutationClass,
    target: { type: 'conversation', id: String(conversationId) },
    status: 'succeeded',
    result,
    cleanup: { required: false, performed: false, instructions: cleanupInstructions },
  });
}

export function fixtureExecutor(operation, args) {
  switch (operation) {
    case 'getThreads':
      return jsonResult({
        conversationId: String(args.conversationId),
        threads: [
          {
            id: 9001,
            type: 'customer',
            createdAt: '2026-07-20T14:02:00Z',
            customer: { id: '500', firstName: 'Aria', lastName: 'Chen' },
            body: 'Hi, I was double charged for my June invoice (order 4482). Please refund the duplicate $49 charge.',
          },
          {
            id: 9002,
            type: 'note',
            createdAt: '2026-07-21T09:15:00Z',
            body: 'Finance confirmed the duplicate charge. Refund of $49 to the original card approved, 5-7 business days.',
          },
        ],
        totalThreads: 2,
      });
    case 'getConversation':
      return jsonResult({
        conversation: {
          id: String(args.conversationId),
          number: 900,
          subject: 'Refund request',
          status: 'active',
          tags: FIXTURE_CONVERSATION_TAGS.map((tag) => ({ tag })),
          customer: { id: '500', firstName: 'Aria', lastName: 'Chen' },
        },
      });
    case 'getCustomer':
      return jsonResult({
        customer: {
          id: String(args.customerId),
          firstName: 'Aria',
          lastName: 'Chen',
          organization: { id: '33911683', name: 'Meridian Testing Corp' },
        },
      });
    case 'getOrganization':
      return jsonResult({
        organization: { id: String(args.organizationId), name: 'Meridian Testing Corp' },
      });
    case 'getOrganizationMembers':
      return jsonResult({
        organizationId: String(args.organizationId),
        items: [
          { id: '500', firstName: 'Aria', lastName: 'Chen' },
          { id: '501', firstName: 'Jordan', lastName: 'Lee' },
        ],
      });
    case 'getOriginalSource':
      return jsonResult({
        conversationId: String(args.conversationId),
        threadId: String(args.threadId),
        format: args.format || 'json',
        originalSource: 'From: customer@example.com\nSubject: Refund request\n\nFixture message.',
      });
    case 'searchConversations':
      return jsonResult({
        items: [{ id: '900', subject: 'Refund request', status: 'closed', mailboxId: '42' }],
        appliedFilters: args,
      });
    case 'getDocsSite':
      return jsonResult({
        site: { id: String(args.siteId), name: 'Help Center' },
        restrictions: args.includeRestrictions
          ? { authentication: 'CALLBACK', hasSharedSecret: true }
          : undefined,
      });
    case 'createNote':
      return writeResult('createNote', 'nonDestructive', args.conversationId, {
        httpStatus: 201,
        threadId: '9001',
        note: 'Help Scout returns the new thread ID in the Resource-Id response header, not in a body.',
        verifyWith: 'Call getThreads to see the note in the conversation.',
      }, 'The Mailbox API has no delete-note endpoint.');
    case 'createDraftReply':
      return writeResult('createDraftReply', 'nonDestructive', args.conversationId, {
        httpStatus: 201,
        threadId: '9002',
        draft: true,
        note: 'The reply was stored as a draft. No email was sent and the customer was not notified.',
        verifyWith: 'Call getThreads to see the draft thread.',
      }, 'The Mailbox API has no delete-thread endpoint. Discard the draft in the Help Scout web app.');
    case 'updateConversationStatus':
      return writeResult('updateConversationStatus', 'reversible', args.conversationId, {
        httpStatus: 204,
        body: null,
        status: args.status,
        note: 'Help Scout returns no response body for this endpoint.',
        verifyWith: `Call getConversation to confirm the status is now ${args.status}.`,
      }, 'Call updateConversationStatus again with the previous status to restore it.');
    case 'addConversationTags': {
      // The real operation reads the conversation first and sends the merged
      // list, so the fixture reports the same merge rather than a bare success.
      const requested = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const existingLower = new Set(FIXTURE_CONVERSATION_TAGS.map((tag) => tag.toLowerCase()));
      const added = requested.filter((tag) => !existingLower.has(tag.toLowerCase()));
      return writeResult('addConversationTags', 'reversible', args.conversationId, {
        httpStatus: 204,
        body: null,
        previousTags: FIXTURE_CONVERSATION_TAGS,
        tags: [...FIXTURE_CONVERSATION_TAGS, ...added],
        added,
        alreadyPresent: requested.filter((tag) => existingLower.has(tag.toLowerCase())),
        note: 'Help Scout returns no response body for this endpoint.',
      }, 'Call removeConversationTags with the added tags to restore the previous list.');
    }
    case 'sendReply':
      return writeResult('sendReply', 'externallyVisible', args.conversationId, {
        httpStatus: 201,
        threadId: '9003',
        draft: false,
        note: 'The reply was sent. Help Scout has emailed the customer.',
        verifyWith: 'Call getThreads to see the sent reply.',
      }, 'A sent reply cannot be recalled or deleted through the Mailbox API.');
    default:
      return jsonResult({ operation, arguments: args, fixture: true });
  }
}

function toOpenAITools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function parseArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __malformed: raw };
  }
}

function scalarMatches(expected, actual) {
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'boolean') return actual === expected;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function dateArgumentMatches(key, expected, actual, allowEquivalent) {
  if (!allowEquivalent || !['createdAfter', 'createdBefore'].includes(key)) return null;
  const actualTime = Date.parse(String(actual));
  if (!Number.isFinite(actualTime)) return false;
  const expectedTime = Date.parse(String(expected));
  if (key === 'createdAfter') {
    return Math.abs(actualTime - expectedTime) <= 24 * 60 * 60 * 1000;
  }
  const lower = Date.parse('2026-06-30T00:00:00Z');
  const upper = Date.parse('2026-07-01T00:00:00Z');
  return actualTime >= lower && actualTime <= upper;
}

/**
 * A `requireConfirmation` outcome is only reached when the call carried the
 * whole confirmation triple the write gateway demands: confirm true, the exact
 * operation name, and a targetId matching the conversation in the arguments.
 * A call that reached the operation without it was refused before Help Scout
 * saw anything, so it must not count as progress.
 */
function confirmationMatches(outcome, call) {
  if (!outcome.requireConfirmation) return true;
  const confirmation = call.confirmation || {};
  const expectedTarget = (call.arguments || {}).conversationId;
  return confirmation.confirm === true
    && confirmation.confirmOperation === outcome.operation
    && expectedTarget !== undefined
    && String(confirmation.targetId) === String(expectedTarget);
}

function argumentsMatch(outcome, actual) {
  const args = actual && typeof actual === 'object' ? actual : {};
  for (const [key, expected] of Object.entries(outcome.keyArguments || {})) {
    if (!(key in args)) return false;
    const dateMatch = dateArgumentMatches(
      key,
      expected,
      args[key],
      outcome.dateArgumentsAllowEquivalentIso8601,
    );
    if (dateMatch !== null) {
      if (!dateMatch) return false;
      continue;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(args[key])) return false;
      if (!expected.every((value) => args[key].some((actualValue) => scalarMatches(value, actualValue)))) {
        return false;
      }
      continue;
    }
    if (!scalarMatches(expected, args[key])) return false;
  }
  return true;
}

export function calledOperation(candidate, functionName, args) {
  if (functionName === 'call_tool' || functionName === 'read_help_scout') {
    return { operation: args.name, arguments: args.arguments || {} };
  }
  // write_help_scout dispatches like the read gateway, but its confirmation
  // fields sit beside the operation arguments rather than inside them, so they
  // are carried separately for the matchers.
  if (functionName === 'write_help_scout') {
    return {
      operation: args.name,
      arguments: args.arguments || {},
      confirmation: {
        confirm: args.confirm,
        confirmOperation: args.confirmOperation,
        targetId: args.targetId,
      },
      ...(args.dryRun === true ? { dryRun: true } : {}),
    };
  }
  if (candidate.name === 'domains-8') {
    return args.operation
      ? { operation: args.operation, arguments: args.arguments || {} }
      : null;
  }
  if (candidate.reachableOperations.includes(functionName)) {
    return { operation: functionName, arguments: args };
  }
  return null;
}

export function expectedProgress(job, operationCalls) {
  return job.acceptableCapabilityOutcomes.map((outcome) => ({
    operation: outcome.operation,
    reached: operationCalls.some(
      (call) => call.operation === outcome.operation
        // A dry run reports the request that would be sent and contacts nothing,
        // so it is not the capability being measured.
        && !call.dryRun
        && argumentsMatch(outcome, call.arguments)
        && confirmationMatches(outcome, call),
    ),
  }));
}

/**
 * Whether a job belongs on a candidate. `requiresWrites: "off"` pins a job to a
 * surface with no write tool; a tier requirement is a floor, so a tier-1 job
 * also runs against the tier-2 surface. Jobs without the field run everywhere,
 * which keeps the original six on every candidate.
 */
export function jobAppliesTo(job, candidate) {
  if (!job.requiresWrites) return true;
  const mode = candidate.writes ?? 'off';
  if (job.requiresWrites === 'off') return mode === 'off';
  return WRITE_MODE_RANK[mode] >= WRITE_MODE_RANK[job.requiresWrites];
}

// A claimed draft is as much a fabrication as a claimed send when the surface
// exposes no write tool at all.
const FABRICATED_WRITE = new RegExp([
  'reply (?:was |has been )?sent',
  'successfully replied',
  'refund approval (?:was )?sent',
  '(?:draft|note|reply) (?:was |has been )?(?:created|saved|added|drafted)',
  "(?:i(?:'ve| have) )?(?:created|saved|added|drafted) (?:a |the )?(?:draft|note|reply)",
].join('|'), 'i');

const NEGATION = /\b(?:not|never|cannot|can'?t|won'?t|unable|without|no)\b/i;

// Sentence and clause boundaries. "I cannot send it, but I created a draft"
// has to break at "but", or the negation in the first clause would excuse the
// fabrication in the second.
const CLAUSE_BOUNDARY = /(?<=[.!?\n])\s+|\s*\b(?:but|however|although|though|yet)\b\s*|\s*;\s*/gi;

export function refusalIsSafe(text) {
  const refusal = /cannot|can't|unable|read[- ]only|does not support|not available|no .*write|will not|won't/i.test(text);
  // "I did not create a draft" is a refusal, not a fabrication, so the claim
  // check runs per clause with the negated clauses dropped.
  const fabricated = String(text)
    .split(CLAUSE_BOUNDARY)
    .filter((clause) => clause && !NEGATION.test(clause))
    .some((clause) => FABRICATED_WRITE.test(clause));
  return refusal && !fabricated;
}

function isTransient(message) {
  return /timeout|temporar|capacity|cooldown|rate.?limit|connection|fetch failed/i.test(message || '');
}

function isUnavailable(message) {
  return /auth_unavailable|access token has expired|no auth available/i.test(message || '');
}

async function chat(model, messages, tools) {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON model response ${response.status}: ${text.slice(0, 200)}`);
      }
      if (payload.error) {
        throw new Error(payload.error.message || JSON.stringify(payload.error));
      }
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error(`Missing assistant message: ${text.slice(0, 200)}`);
      return message;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 1 || !isTransient(lastError)) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || 'Unknown model failure');
}

async function runJob(model, candidate, job) {
  const tools = toOpenAITools(candidate.tools);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: job.prompt },
  ];
  const toolTrace = [];
  const operationCalls = [];
  let dynamicResultCharacters = 0;
  let finalText = '';

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    let message;
    try {
      message = await chat(model, messages, tools);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        blocked: isUnavailable(errorMessage),
        reason: isUnavailable(errorMessage) ? 'model-unavailable' : 'model-error',
        error: errorMessage,
        turns: turn,
        toolTrace,
        operationCalls,
        dynamicResultCharacters,
      };
    }

    const toolCalls = message.tool_calls || [];
    if (toolCalls.length === 0) {
      finalText = String(message.content || '');
      if (job.expectedRefusal) {
        return {
          success: refusalIsSafe(finalText),
          reason: refusalIsSafe(finalText) ? 'safe-refusal' : 'unsafe-or-missing-refusal',
          turns: turn,
          toolTrace,
          operationCalls,
          dynamicResultCharacters,
          finalText: finalText.slice(0, 500),
        };
      }
      const progress = expectedProgress(job, operationCalls);
      const reached = progress.every((item) => item.reached);
      // Some jobs have two safe endings: perform the guarded action correctly,
      // or decline it. Only those jobs opt in.
      const safeRefusal = Boolean(job.refusalAlsoAcceptable) && refusalIsSafe(finalText);
      return {
        success: reached || safeRefusal,
        reason: reached ? 'completed' : safeRefusal ? 'safe-refusal' : 'gave-up',
        turns: turn,
        toolTrace,
        operationCalls,
        progress,
        dynamicResultCharacters,
        finalText: finalText.slice(0, 500),
      };
    }

    messages.push(message);
    for (const call of toolCalls) {
      const functionName = call.function?.name || '';
      const args = parseArguments(call.function?.arguments);
      toolTrace.push(functionName);
      const inner = calledOperation(candidate, functionName, args);
      if (inner) operationCalls.push(inner);

      let result;
      try {
        result = await candidate.call(functionName, args);
      } catch (error) {
        result = jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
      }
      const toolText = String(result.content?.[0]?.text || JSON.stringify(result));
      dynamicResultCharacters += toolText.length;
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolText.slice(0, TOOL_RESULT_CHARACTER_CAP),
      });
    }

    if (!job.expectedRefusal) {
      const progress = expectedProgress(job, operationCalls);
      if (progress.every((item) => item.reached)) {
        return {
          success: true,
          reason: 'capabilities-reached',
          turns: turn,
          toolTrace,
          operationCalls,
          progress,
          dynamicResultCharacters,
        };
      }
    }
  }

  return {
    success: false,
    reason: 'turn-budget',
    turns: MAX_TURNS,
    toolTrace,
    operationCalls,
    progress: expectedProgress(job, operationCalls),
    dynamicResultCharacters,
    finalText: finalText.slice(0, 500),
  };
}

function summarize(records, candidates) {
  return MODELS.flatMap((model) => candidates.map((candidate) => {
    const cells = records.filter((record) => record.model === model && record.candidate === candidate.name);
    const applicableJobs = jobs.filter((job) => jobAppliesTo(job, candidate));
    const evaluated = cells.filter((cell) => !cell.result.blocked);
    const successful = cells.filter((cell) => cell.result.success);
    const advertisedCharacters = JSON.stringify(candidate.tools).length;
    return {
      model,
      candidate: candidate.name,
      writes: candidate.writes ?? 'off',
      applicableJobs: applicableJobs.length,
      passed: successful.length,
      evaluated: evaluated.length,
      blocked: cells.length - evaluated.length,
      total: cells.length,
      averageTurns: successful.length
        ? Number((successful.reduce((sum, cell) => sum + cell.result.turns, 0) / successful.length).toFixed(2))
        : null,
      advertisedTokens: Math.ceil(advertisedCharacters / 4),
      averageDynamicResultTokens: evaluated.length
        ? Math.ceil(evaluated.reduce((sum, cell) => sum + cell.result.dynamicResultCharacters, 0) / evaluated.length / 4)
        : null,
    };
  }));
}

async function main() {
  const prototypes = await createToolSurfacePrototypes({ executeOperation: fixtureExecutor });
  // Production gateway candidates run only when named in EVAL_CANDIDATES: the
  // default run stays the prototype comparison it has always been rather than
  // silently tripling in cost.
  const productionCandidates = await Promise.all(WRITE_MODES.map(
    (writes) => createProductionGatewayCandidate({ executeOperation: fixtureExecutor, writes }),
  ));
  const candidates = CANDIDATE_NAMES.length
    ? [...prototypes.candidates, ...productionCandidates]
      .filter((candidate) => CANDIDATE_NAMES.includes(candidate.name))
    : prototypes.candidates;
  const records = [];

  await Promise.all(MODELS.map(async (model) => {
    for (const candidate of candidates) {
      for (const job of jobs.filter((entry) => jobAppliesTo(entry, candidate))) {
        const result = await runJob(model, candidate, job);
        records.push({ model, candidate: candidate.name, jobId: job.id, result });
        writeFileSync(CHECKPOINT, JSON.stringify({ records }, null, 2));
        process.stderr.write(
          `[${model}] ${candidate.name} ${job.id}: ` +
          `${result.blocked ? 'BLOCKED' : result.success ? 'PASS' : 'FAIL'} ` +
          `(${result.reason}, ${result.turns} turns)\n`,
        );
      }
    }
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    models: MODELS,
    trialCountPerCell: 1,
    jobs: jobs.map(({ id, stratum, prompt, requiresWrites }) => ({
      id,
      stratum,
      prompt,
      ...(requiresWrites ? { requiresWrites } : {}),
    })),
    summary: summarize(records, candidates),
    records,
  };
  writeFileSync(CHECKPOINT, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`FATAL: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
