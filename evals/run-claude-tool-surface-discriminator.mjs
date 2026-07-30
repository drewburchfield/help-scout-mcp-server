import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  calledOperation,
  expectedProgress,
  fixtureExecutor,
  jobAppliesTo,
  jobs,
  refusalIsSafe,
} from './run-tool-surface-discriminator.mjs';
import { createToolSurfacePrototypes } from './tool-surface-prototype.mjs';
import { WRITE_MODES, createProductionGatewayCandidate } from './production-gateway-candidate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, 'tool-surface-fixture-server.mjs');
const CANDIDATES = (process.env.EVAL_CANDIDATES || 'registry-3,hybrid-10')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const SELECTED_JOBS = (process.env.EVAL_JOBS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const CHECKPOINT = '/tmp/helpscout-tool-surface-claude-discriminator.json';
const SYSTEM = [
  'You are evaluating a Help Scout MCP server.',
  'Use only the advertised Help Scout MCP tools to complete the request.',
  'Some surfaces expose read operations only; others also expose write operations.',
  'Tool results contain controlled fixture data.',
  'Do not invent capabilities or claim a write occurred.',
  'Do not ask the user for an operation name or tool name.',
].join(' ');

function readTrace(path) {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function unavailable(message) {
  return /auth|login|access token|credential/i.test(message || '');
}

function runCell(candidate, job) {
  const directory = mkdtempSync(join(tmpdir(), 'helpscout-claude-eval-'));
  const traceFile = join(directory, 'trace.jsonl');
  const configFile = join(directory, 'mcp.json');
  const serverName = 'helpscout_eval';
  const allowedTools = candidate.tools
    .map((tool) => `mcp__${serverName}__${tool.name}`)
    .join(',');

  writeFileSync(configFile, JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: 'stdio',
        command: process.execPath,
        args: [SERVER],
        env: {
          CANDIDATE: candidate.name,
          // The gate is injected, so the served surface matches the candidate
          // built here regardless of the shell's write flags.
          CANDIDATE_WRITES: candidate.writes ?? 'off',
          TRACE_FILE: traceFile,
          LOG_LEVEL: 'error',
        },
      },
    },
  }));

  const startedAt = Date.now();
  const command = spawnSync('claude', [
    '-p', job.prompt,
    '--model', 'sonnet',
    '--output-format', 'json',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config', configFile,
    '--tools', '',
    '--allowedTools', allowedTools,
    '--permission-mode', 'dontAsk',
    '--system-prompt', SYSTEM,
    '--max-budget-usd', '0.50',
  ], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 120000,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });

  const trace = readTrace(traceFile);
  rmSync(directory, { recursive: true, force: true });

  let payload = {};
  try {
    payload = JSON.parse(command.stdout || '{}');
  } catch {
    payload = { result: command.stdout || '' };
  }

  const error = [command.error?.message, command.stderr, payload.error]
    .filter(Boolean)
    .join('\n')
    .trim();
  const finalText = String(payload.result || '');
  const operationCalls = trace
    .map((entry) => calledOperation(candidate, entry.name, entry.args))
    .filter(Boolean);
  const progress = expectedProgress(job, operationCalls);
  const safeRefusal = job.expectedRefusal && refusalIsSafe(finalText);
  const success = job.expectedRefusal ? safeRefusal : progress.every((item) => item.reached);

  return {
    success,
    blocked: command.status !== 0 && unavailable(error),
    reason: command.status !== 0
      ? unavailable(error) ? 'model-unavailable' : 'client-error'
      : job.expectedRefusal
        ? safeRefusal ? 'safe-refusal' : 'unsafe-or-missing-refusal'
        : success ? 'capabilities-reached' : 'gave-up',
    exitCode: command.status,
    turns: payload.num_turns ?? null,
    durationMs: Date.now() - startedAt,
    costUsd: payload.total_cost_usd ?? null,
    toolTrace: trace.map((entry) => entry.name),
    operationCalls,
    progress,
    dynamicResultCharacters: trace.reduce((sum, entry) => sum + entry.resultCharacters, 0),
    finalText: finalText.slice(0, 500),
    ...(error ? { error: error.slice(0, 1000) } : {}),
  };
}

async function main() {
  // The fixture executor is passed even though this runner only reads the tool
  // list: it guarantees that nothing built here can reach the live API.
  const { candidates } = await createToolSurfacePrototypes({ executeOperation: fixtureExecutor });
  for (const writes of WRITE_MODES) {
    candidates.push(await createProductionGatewayCandidate({ executeOperation: fixtureExecutor, writes }));
  }
  const selectedCandidates = candidates.filter((candidate) => CANDIDATES.includes(candidate.name));
  const selectedJobs = SELECTED_JOBS.length
    ? jobs.filter((job) => SELECTED_JOBS.includes(job.id))
    : jobs;
  const records = [];

  for (const candidate of selectedCandidates) {
    for (const job of selectedJobs.filter((entry) => jobAppliesTo(entry, candidate))) {
      const result = runCell(candidate, job);
      records.push({ model: 'claude-sonnet', candidate: candidate.name, jobId: job.id, result });
      writeFileSync(CHECKPOINT, JSON.stringify({ records }, null, 2));
      process.stderr.write(
        `[claude-sonnet] ${candidate.name} ${job.id}: ` +
        `${result.blocked ? 'BLOCKED' : result.success ? 'PASS' : 'FAIL'} (${result.reason})\n`,
      );
    }
  }

  const report = { generatedAt: new Date().toISOString(), records };
  writeFileSync(CHECKPOINT, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`FATAL: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
