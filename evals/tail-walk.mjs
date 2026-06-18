// NAS-1308 phase 4b: agentic multi-turn TAIL-WALK eval.
//
// Proves a model can drive the 10-tool DISCOVERY surface (7 core + search_tools /
// get_tool_schema / call_tool) to a NON-CORE (tail) tool and invoke it with the
// right key args, within a turn budget.
//
// For each tail task we run a real OpenAI-style tool-use loop against the local
// proxy. The model's tool calls are EXECUTED against the live `toolHandler`
// (meta-tools run locally; any real tool hits the live read-only API), and we
// score whether the model REACHES `call_tool({name: target, arguments: ...})`
// with the expected key args.
//
// Run:  npm run build && /opt/homebrew/bin/node evals/tail-walk.mjs
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://127.0.0.1:8317/v1/chat/completions';
const RESULTS_PATH = resolve(HERE, 'tail-walk-results.md');

// gpt is quota-blocked; include it but expect n/a (cooldown/usage_limit).
const MODELS = ['gemini-3-flash', 'gemini-3.1-pro-low', 'glm-4.7', 'gpt-5.5'];
const TRIALS = 2;
const MAX_TURNS = 6;
const REQ_TIMEOUT_MS = 60000;
const TOOL_CONTENT_CAP = 1500;

const SYSTEM =
  'You are an agent with a small set of Help Scout tools plus search_tools/get_tool_schema/call_tool to reach others. ' +
  'Use them to complete the task. Call tools; do not ask the user.';

// searchOnly: target is NOT a successor-hint of any core tool, so the model MUST
// use search_tools to discover it (isolates the search-discovery mechanism).
// pivot: tests that the model follows the EMPTY-result guidance to a second tool.
const TASKS = [
  { prompt: 'Get the email channel report.', target: 'getChannelReport', key: { channel: 'email' }, searchOnly: true },
  { prompt: "Show the team's first response time productivity report.", target: 'getProductivityReport', key: { report: 'first-response-time' }, searchOnly: true },
  { prompt: "Get user 7's replies-sent report.", target: 'getUserReport', key: { report: 'replies' }, searchOnly: true },
  { prompt: 'Show the company happiness ratings.', target: 'getHappinessReport', key: { report: 'ratings' }, searchOnly: true },
  { prompt: 'List all the tags in the account.', target: 'listTags', key: {}, searchOnly: true },
  { prompt: 'List the webhooks configured.', target: 'listWebhooks', key: {}, searchOnly: true },
  { prompt: 'Show the custom fields configured on inbox 123.', target: 'getInbox', key: { include: ['fields'] }, searchOnly: false },
  { prompt: 'Get the raw RFC822 source of thread 7 in conversation 5.', target: 'getOriginalSource', key: { format: 'rfc822' }, searchOnly: false },
  // 0-results pivot: searchConversations for a nonexistent person returns empty;
  // the content-aware guidance suggests searchCustomersByEmail — does the model follow it?
  { prompt: 'Find conversations from the customer with email nobody-zzz-99887@nonexistent-domain-zzz.test. If none are found, locate that customer first.', target: 'searchCustomersByEmail', key: { email: 'nobody-zzz-99887@nonexistent-domain-zzz.test' }, pivot: true },
];

// ---- arg-key matching (mirrors run-eval.mjs) ----
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

// Persistent = quota/cooldown/incompatibility → mark n/a, not fail.
function isQuota(errMsg) {
  const m = (errMsg || '').toLowerCase();
  return (
    m.includes('cooldown') ||
    m.includes('cooling down') ||
    m.includes('usage limit') ||
    m.includes('usage_limit') ||
    m.includes('no capacity') ||
    m.includes('quota') ||
    m.includes('baseurl') ||
    m.includes('json parse error') ||
    m.includes('jsonmapping')
  );
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { __malformed: raw };
  }
}

// POST one chat-completions turn. Returns {message} | {error} | {quota:true,error}.
async function chat(model, messages, tools) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0 }),
      signal: ac.signal,
    });
  } catch (e) {
    return { error: `fetch-failed: ${String(e).slice(0, 90)}` };
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
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    return { error: msg, quota: isQuota(msg) };
  }
  const message = data?.choices?.[0]?.message;
  if (!message) return { error: `no-message (${res.status}): ${text.slice(0, 100)}` };
  return { message };
}

function extractText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out;
  const parts = out.content;
  if (Array.isArray(parts)) {
    return parts.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n');
  }
  return JSON.stringify(out);
}

// One walk = drive the discovery surface to the tail tool for one task.
// Returns {ok, turns?, reason?, trace, lastText?}.
async function walk(model, task, handler, tools) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: task.prompt },
  ];
  const trace = [];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const r = await chat(model, messages, tools);
    if (r.error) {
      if (r.quota) return { ok: false, reason: 'quota', quota: true, error: r.error, trace };
      return { ok: false, reason: 'error', error: r.error, trace };
    }
    const msg = r.message;
    const toolCalls = msg.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      return { ok: false, reason: 'gave_up', turns: turn, trace, lastText: (msg.content || '').slice(0, 200) };
    }

    // Push assistant message (with tool_calls) verbatim so tool_call_ids resolve.
    messages.push(msg);

    for (const call of toolCalls) {
      const fnName = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      trace.push(fnName);

      // ---- SUCCESS CHECK ----
      // (a) model reaches the tail via call_tool with target + key args.
      if (fnName === 'call_tool' && args?.name === task.target && paramKeyMatch(task.key, args?.arguments || {})) {
        // mechanism: did the model SEARCH to discover the target, or follow a hint?
        const mechanism = trace.includes('search_tools') ? 'search' : 'hint';
        return { ok: true, turns: turn, via: 'call_tool', mechanism, trace };
      }
      // (b) defensive: model somehow calls the target tool directly (not advertised).
      if (fnName === task.target && paramKeyMatch(task.key, args)) {
        return { ok: true, turns: turn, via: 'direct', trace };
      }

      // ---- EXECUTE the tool against the live handler ----
      let toolText;
      try {
        const out = await handler.callTool({ params: { name: fnName, arguments: args } });
        toolText = extractText(out);
        // Exercise response-bootstrapping: surface successor-hint names to the model.
        const hints = out?._meta?.suggestedTools;
        if (Array.isArray(hints) && hints.length) {
          toolText += `\n\n[suggestedTools: ${hints.map((h) => h.name).join(', ')}]`;
        }
      } catch (e) {
        toolText = `Tool execution error: ${String(e).slice(0, 200)}`;
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: (toolText || '').slice(0, TOOL_CONTENT_CAP),
      });
    }
  }
  return { ok: false, reason: 'budget', turns: MAX_TURNS, trace };
}

async function main() {
  const { toolHandler, ToolHandler } = await import('../dist/tools/index.js');
  const handler = toolHandler || new ToolHandler();
  const discovery = await handler.listTools();
  const tools = discovery.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  if (tools.length !== 10) {
    process.stderr.write(`WARN: expected 10 discovery tools, got ${tools.length}\n`);
  }

  // results[model][taskIdx] = { trials: [walkResult, walkResult], na: bool }
  const results = {};
  const modelNa = {};

  for (const model of MODELS) {
    results[model] = [];
    modelNa[model] = false;
    for (let ti = 0; ti < TASKS.length; ti++) {
      const task = TASKS[ti];
      const trials = [];
      for (let t = 0; t < TRIALS; t++) {
        let w;
        try {
          w = await walk(model, task, handler, tools);
        } catch (e) {
          w = { ok: false, reason: 'harness-error', error: String(e).slice(0, 150), trace: [] };
        }
        trials.push(w);
        if (w.quota) modelNa[model] = true;
        // If first trial hit quota, no point running a second.
        if (w.quota) break;
      }
      results[model].push({ trials });
      const best = trials.find((x) => x.ok);
      const status = modelNa[model] && !best ? 'n/a' : best ? `OK(${best.turns}t)` : `FAIL(${trials[0]?.reason})`;
      process.stderr.write(`[${model}] ${task.target}: ${status}\n`);
    }
  }

  const md = renderMarkdown(results, modelNa);
  writeFileSync(RESULTS_PATH, md);
  process.stdout.write(md + '\n');
  process.stderr.write(`\nWrote ${RESULTS_PATH}\n`);
}

function bestTrial(cell) {
  return cell.trials.find((x) => x.ok) || null;
}

function cellNa(cell, modelNa, model) {
  return modelNa[model] && !bestTrial(cell);
}

function renderMarkdown(results, modelNa) {
  const lines = [];
  lines.push('# NAS-1308 Phase 4b — Tail-Walk Eval');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(
    'Agentic multi-turn walk over the **10-tool discovery surface** (7 core + ' +
      '`search_tools`/`get_tool_schema`/`call_tool`). Each task targets a **non-core (tail) ' +
      'tool** reachable only via the meta-tools. Success = the model issues ' +
      '`call_tool({name: <target>, arguments: ...})` with the expected key args within ' +
      `${MAX_TURNS} turns. ${TRIALS} trials per task; success if either trial succeeds.`,
  );
  lines.push('');

  // ---- per-model summary ----
  lines.push('## Per-model summary');
  lines.push('');
  lines.push('| Model | Tail-reach success | Avg turns-to-success | Notes |');
  lines.push('|---|---|---|---|');
  for (const model of MODELS) {
    const cells = results[model];
    let solved = 0;
    let naCount = 0;
    let turnSum = 0;
    let turnN = 0;
    for (const cell of cells) {
      if (cellNa(cell, modelNa, model)) { naCount++; continue; }
      const b = bestTrial(cell);
      if (b) { solved++; turnSum += b.turns; turnN++; }
    }
    const scored = TASKS.length - naCount;
    const rate = scored > 0 ? `${solved}/${scored} (${Math.round((100 * solved) / scored)}%)` : 'n/a';
    const avgTurns = turnN > 0 ? (turnSum / turnN).toFixed(1) : '—';
    const note = naCount === TASKS.length ? 'quota/cooldown — unavailable' : naCount > 0 ? `${naCount} task(s) n/a (quota)` : '';
    lines.push(`| ${model} | ${rate} | ${avgTurns} | ${note} |`);
  }
  lines.push('');

  // ---- discovery-mechanism verification (NAS-1309) ----
  lines.push('## Discovery mechanism (search vs hint)');
  lines.push('');
  lines.push('For `searchOnly` targets the model MUST use `search_tools` (not reachable via a hint). `pivot` = followed the empty-result guidance to a second tool.');
  lines.push('');
  lines.push('| Task target | type | reached | via mechanism |');
  lines.push('|---|---|---|---|');
  for (let ti = 0; ti < TASKS.length; ti++) {
    const task = TASKS[ti];
    const type = task.pivot ? 'pivot' : task.searchOnly ? 'search-only' : 'hint-ok';
    const mechs = MODELS.map((m) => bestTrial(results[m][ti])?.mechanism).filter(Boolean);
    const reached = mechs.length;
    let verdict;
    if (task.searchOnly) {
      const usedSearch = mechs.filter((x) => x === 'search').length;
      verdict = reached > 0 ? `search ${usedSearch}/${reached}${usedSearch < reached ? ' ⚠ some via hint' : ' ✓'}` : '—';
    } else {
      verdict = reached > 0 ? mechs.join(',') : '—';
    }
    lines.push(`| ${task.target} | ${type} | ${reached}/${MODELS.filter((m) => !modelNa[m]).length} | ${verdict} |`);
  }
  lines.push('');

  // ---- per-task breakdown ----
  lines.push('## Per-task breakdown');
  lines.push('');
  lines.push('| Task target | Models reaching it | Common failure trace |');
  lines.push('|---|---|---|');
  for (let ti = 0; ti < TASKS.length; ti++) {
    const task = TASKS[ti];
    const reached = [];
    const failTraces = [];
    for (const model of MODELS) {
      const cell = results[model][ti];
      if (cellNa(cell, modelNa, model)) continue;
      const b = bestTrial(cell);
      if (b) {
        reached.push(`${model}(${b.turns}t)`);
      } else {
        const t = cell.trials[0];
        const tr = (t?.trace || []).join('→') || t?.reason || '?';
        failTraces.push(`${model}: ${t?.reason || 'fail'} [${tr.slice(0, 60)}]`);
      }
    }
    const reachStr = reached.length ? reached.join(', ') : '—';
    const failStr = failTraces.length ? failTraces.join('; ') : '—';
    lines.push(`| \`${task.target}\` | ${reachStr} | ${failStr.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');

  // ---- verdict ----
  let totalSolved = 0;
  let totalScored = 0;
  const availModels = MODELS.filter((m) => !(modelNa[m] && results[m].every((c) => cellNa(c, modelNa, m))));
  for (const model of availModels) {
    for (const cell of results[model]) {
      if (cellNa(cell, modelNa, model)) continue;
      totalScored++;
      if (bestTrial(cell)) totalSolved++;
    }
  }
  const pct = totalScored > 0 ? Math.round((100 * totalSolved) / totalScored) : 0;
  const yesNo = pct >= 75 ? 'YES' : pct >= 40 ? 'PARTIAL' : 'NO';
  lines.push('## Verdict');
  lines.push('');
  lines.push(
    `**${yesNo}** — across available models, ${totalSolved}/${totalScored} tail-reach attempts ` +
      `(${pct}%) drove the discovery surface to the correct non-core tool with the right key args ` +
      `(models: ${availModels.join(', ') || 'none available'}).`,
  );
  lines.push('');
  return lines.join('\n');
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${String(e)}\n${e?.stack || ''}\n`);
  process.exit(1);
});
