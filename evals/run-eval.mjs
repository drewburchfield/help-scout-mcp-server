// NAS-1300 tool-consolidation eval runner.
// For each TASK x SURFACE x MODEL, run 3 trials against the local OpenAI-compatible proxy,
// capture the first tool_call, score selection + param accuracy.
//
// Resilient design for a flaky/rate-limited proxy:
//   - 45s per-request timeout (AbortController)
//   - spec "retry once" plus a couple extra retries for TRANSIENT upstream errors only
//   - incremental checkpoint to results-raw.json after every (model,task,surface) cell
//   - RESCUE mode (node run-eval.mjs --rescue): only re-run cells whose 3 trials were all
//     errors, so the eval can be re-run across cooldown windows until cells fill in.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:8317/v1/chat/completions';
// Antigravity-owned Gemini IDs (account-tier, reliable) — the *-preview IDs route
// through a rate-limited provider (model_cooldown). openai=gpt-*, zai=glm-*.
const MODELS = ['gemini-3-flash', 'gemini-3.1-pro-low', 'gpt-5.5', 'gpt-5.4-mini', 'glm-4.7', 'glm-4-plus'];
const TRIALS = 3;
const REQ_TIMEOUT_MS = 45000;
const SYSTEM =
  'You are an agent with Help Scout tools. Call exactly ONE tool to satisfy the user. Do not ask questions.';
const RESCUE = process.argv.includes('--rescue');

const tasks = JSON.parse(readFileSync(resolve(HERE, 'tasks.json'), 'utf8'));
const surfaces = {
  control: JSON.parse(readFileSync(resolve(HERE, 'surfaces/control.json'), 'utf8')),
  treatment: JSON.parse(readFileSync(resolve(HERE, 'surfaces/treatment.json'), 'utf8')),
};

const tokensFor = (s) => Math.round(JSON.stringify(s).length / 4);
const toolsListTokens = { control: tokensFor(surfaces.control), treatment: tokensFor(surfaces.treatment) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAW_PATH = resolve(HERE, 'results-raw.json');

// Returns {name, args} | {error} | {none:true}
async function callModel(model, tools, prompt) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    tools,
    tool_choice: 'auto',
    temperature: 0,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    return { error: `fetch-failed: ${String(e).slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: `non-json (${res.status}): ${text.slice(0, 100)}` };
  }
  if (data.error) return { error: data.error.message || JSON.stringify(data.error) };
  const msg = data?.choices?.[0]?.message;
  const tc = msg?.tool_calls?.[0];
  if (!tc) return { none: true };
  let args = {};
  try {
    args = JSON.parse(tc.function.arguments || '{}');
  } catch {
    args = { __malformed: tc.function.arguments };
  }
  return { name: tc.function.name, args };
}

// Persistent = will not improve on retry (cooldown / usage limit / capacity / tools-parse incompat).
function isPersistent(errMsg) {
  const m = (errMsg || '').toLowerCase();
  return (
    m.includes('cooldown') ||
    m.includes('cooling down') ||
    m.includes('usage limit') ||
    m.includes('no capacity') ||
    m.includes('json parse error') ||
    m.includes('jsonmapping') ||
    m.includes('baseurl')
  );
}

async function callWithRetry(model, tools, prompt) {
  let r = await callModel(model, tools, prompt);
  if (!r.error) return r;
  if (isPersistent(r.error)) return r; // fail fast on cooldown/incompat
  // spec retry-once + 2 extra transient retries
  for (let i = 0; i < 3 && r.error && !isPersistent(r.error); i++) {
    await sleep(1200 + i * 800);
    r = await callModel(model, tools, prompt);
  }
  return r;
}

// ---- scoring ----
const eqScalar = (exp, got) => {
  if (typeof exp === 'number') return Number(got) === exp;
  if (typeof exp === 'boolean') return got === exp;
  if (typeof exp === 'string') return String(got).toLowerCase() === exp.toLowerCase();
  return exp === got;
};
function paramKeyMatch(expectedKey, args) {
  if (!args || typeof args !== 'object') return false;
  for (const [k, expVal] of Object.entries(expectedKey)) {
    if (!(k in args)) return false;
    const got = args[k];
    if (Array.isArray(expVal)) {
      if (!Array.isArray(got)) return false;
      const gotNorm = got.map((g) => (typeof g === 'string' ? g.toLowerCase() : g));
      for (const e of expVal) {
        const en = typeof e === 'string' ? e.toLowerCase() : e;
        if (!gotNorm.includes(en)) return false;
      }
    } else if (!eqScalar(expVal, got)) {
      return false;
    }
  }
  return true;
}

function scoreCell(task, surfaceName, results) {
  const expectedSet = task[surfaceName];
  const trialScores = [];
  const trialDetails = [];
  for (const r of results) {
    if (r.error || r.none) {
      trialScores.push({ selection: 0, param: 0, note: r.error ? 'error' : 'no-tool-call' });
      trialDetails.push({ name: r.error ? `ERR:${r.error.slice(0, 60)}` : 'NONE', args: {} });
      continue;
    }
    const selection = expectedSet.includes(r.name) ? 1 : 0;
    // Per-surface param key: control's old tools often used different param names
    // (or encoded the discriminator in the tool itself), so scoring control
    // against the treatment-shaped key is unfair. Use task.controlKey for control.
    const surfaceKey = surfaceName === 'control' && task.controlKey !== undefined ? task.controlKey : task.key;
    const param = selection === 1 && paramKeyMatch(surfaceKey, r.args) ? 1 : 0;
    trialScores.push({ selection, param });
    trialDetails.push({ name: r.name, args: r.args });
  }
  const avg = (f) => trialScores.reduce((a, x) => a + f(x), 0) / trialScores.length;
  const allError = trialDetails.every((d) => d.name.startsWith('ERR:') || d.name === 'NONE');
  return {
    selectionAvg: avg((x) => x.selection),
    paramAvg: avg((x) => x.param),
    allError,
    trials: trialDetails,
  };
}

const cellKey = (m, ti, s) => `${m}::${ti}::${s}`;

async function main() {
  // load checkpoint if present (so re-runs accumulate)
  let prior = {};
  if (existsSync(RAW_PATH)) {
    try {
      const j = JSON.parse(readFileSync(RAW_PATH, 'utf8'));
      for (const rec of j.records || []) prior[cellKey(rec.model, rec.taskIndex, rec.surface)] = rec;
    } catch {}
  }

  const records = Object.values(prior);
  const recIndex = new Map(records.map((r) => [cellKey(r.model, r.taskIndex, r.surface), r]));
  const modelAvailable = {};

  const flush = () => {
    const out = {
      generatedAt: new Date().toISOString(),
      models: MODELS,
      toolsListTokens,
      modelAvailable,
      records: Array.from(recIndex.values()),
    };
    writeFileSync(RAW_PATH, JSON.stringify(out, null, 2));
  };

  for (const model of MODELS) {
    modelAvailable[model] = { available: false };

    // availability probe (skip if model already has any non-error cell from a prior run)
    const hasGood = Array.from(recIndex.values()).some(
      (r) => r.model === model && !r.allError,
    );
    if (!hasGood) {
      const probe = await callWithRetry(model, surfaces.treatment, tasks[0].prompt);
      if (probe.error && isPersistent(probe.error)) {
        modelAvailable[model].unavailableReason = probe.error.slice(0, 140);
        process.stderr.write(`[${model}] UNAVAILABLE: ${probe.error.slice(0, 90)}\n`);
        flush();
        continue;
      }
    }
    modelAvailable[model].available = true;

    for (const [ti, task] of tasks.entries()) {
      for (const surfaceName of ['control', 'treatment']) {
        const key = cellKey(model, ti, surfaceName);
        const existing = recIndex.get(key);
        // skip cells already done well; in rescue mode, redo only all-error cells
        if (existing && (!existing.allError || (!RESCUE && existing.attempted))) {
          if (!existing.allError) continue;
          if (!RESCUE) continue;
        }
        const tools = surfaces[surfaceName];
        const results = [];
        for (let t = 0; t < TRIALS; t++) results.push(await callWithRetry(model, tools, task.prompt));
        const scored = scoreCell(task, surfaceName, results);
        const rec = {
          model,
          taskIndex: ti,
          prompt: task.prompt,
          surface: surfaceName,
          expectedSet: task[surfaceName],
          attempted: true,
          ...scored,
        };
        recIndex.set(key, rec);
        flush();
        process.stderr.write(
          `[${model}] task${ti + 1} ${surfaceName}: sel=${scored.selectionAvg.toFixed(2)} param=${scored.paramAvg.toFixed(2)}${scored.allError ? ' (ALL-ERR)' : ''}\n`,
        );
      }
    }
  }

  flush();
  process.stderr.write('Wrote results-raw.json\n');
}

main();
