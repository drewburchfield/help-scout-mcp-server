// Generates evals/results.md from results-raw.json.
// Only "clean" cells (at least one non-error trial) are scored. Cells where all 3 trials
// errored are excluded and counted as missing/unavailable so upstream flakiness does not
// masquerade as a model getting the task wrong.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(resolve(HERE, 'results-raw.json'), 'utf8'));
const tasks = JSON.parse(readFileSync(resolve(HERE, 'tasks.json'), 'utf8'));
const { toolsListTokens, modelAvailable } = raw;

const MODELS = raw.models;
const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const sign = (x) => (x > 0 ? `+${x}` : `${x}`);

// index cells: model -> taskIndex -> surface -> rec (only clean cells)
const cells = {};
for (const r of raw.records) {
  if (r.allError) continue; // skip cells with no successful trial
  (cells[r.model] ??= {})[r.taskIndex] ??= {};
  cells[r.model][r.taskIndex][r.surface] = r;
}

function modelAgg(model) {
  // average selection/param over tasks that have BOTH surfaces clean (fair paired comparison)
  let cSel = 0, tSel = 0, cParam = 0, tParam = 0, n = 0;
  const paired = [];
  for (let ti = 0; ti < tasks.length; ti++) {
    const c = cells[model]?.[ti]?.control;
    const t = cells[model]?.[ti]?.treatment;
    if (!c || !t) continue;
    cSel += c.selectionAvg; tSel += t.selectionAvg;
    cParam += c.paramAvg; tParam += t.paramAvg;
    n++;
    paired.push({ ti, c, t });
  }
  if (n === 0) return null;
  return {
    n,
    cSel: cSel / n, tSel: tSel / n,
    cParam: cParam / n, tParam: tParam / n,
    paired,
  };
}

let md = '';
md += `# NAS-1300 — Tool Consolidation Eval (102 → 55 tools)\n\n`;
md += `Generated: ${raw.generatedAt}\n\n`;
md += `Surfaces: **control = 102 tools** (pre-consolidation \`a1ab3bb\`), **treatment = 55 tools** (current \`dev\`).\n`;
md += `Each cell = mean of 3 trials at temperature 0 against the local OpenAI-compatible proxy. `;
md += `Cells where all 3 trials returned an upstream error (cooldown / capacity / timeout) are excluded as "no data" rather than scored 0, so proxy flakiness is not counted against a model.\n\n`;

// availability
md += `## Model availability\n\n`;
md += `| Model | Status | Paired tasks scored | Notes |\n|---|---|---|---|\n`;
for (const m of MODELS) {
  const agg = modelAgg(m);
  const av = modelAvailable[m] || {};
  let status, notes = '';
  if (av.unavailableReason) {
    status = 'UNAVAILABLE';
    notes = av.unavailableReason;
  } else if (!agg) {
    status = 'UNAVAILABLE';
    notes = 'all cells errored (cooldown/capacity during run)';
  } else if (agg.n < tasks.length) {
    status = 'PARTIAL';
    notes = `${agg.n}/${tasks.length} tasks have both surfaces clean`;
  } else {
    status = 'COMPLETE';
    notes = `all ${tasks.length} tasks scored`;
  }
  md += `| ${m} | ${status} | ${agg ? agg.n : 0} | ${notes} |\n`;
}
md += `\n`;

// per-model table
md += `## Per-model accuracy (paired tasks only)\n\n`;
md += `| Model | control sel% | treatment sel% | control param% | treatment param% | Δ sel | Δ param |\n`;
md += `|---|---|---|---|---|---|---|\n`;
const scored = [];
for (const m of MODELS) {
  const a = modelAgg(m);
  if (!a) continue;
  scored.push({ m, a });
  const dSel = Math.round((a.tSel - a.cSel) * 100);
  const dParam = Math.round((a.tParam - a.cParam) * 100);
  md += `| ${m} | ${pct(a.cSel)} | ${pct(a.tSel)} | ${pct(a.cParam)} | ${pct(a.tParam)} | ${sign(dSel)}pp | ${sign(dParam)}pp |\n`;
}
// overall mean across scored models
if (scored.length) {
  const mean = (f) => scored.reduce((s, x) => s + f(x.a), 0) / scored.length;
  const cS = mean((a) => a.cSel), tS = mean((a) => a.tSel), cP = mean((a) => a.cParam), tP = mean((a) => a.tParam);
  md += `| **OVERALL (mean)** | **${pct(cS)}** | **${pct(tS)}** | **${pct(cP)}** | **${pct(tP)}** | **${sign(Math.round((tS - cS) * 100))}pp** | **${sign(Math.round((tP - cP) * 100))}pp** |\n`;
}
md += `\n`;

// gate
md += `## Gate (ideal targets: selection 100%, param 100%; treatment ≥ control on both at ≤ token cost)\n\n`;
md += `Token cost is identical-or-lower for treatment by construction (fewer tools), so the gate reduces to: treatment selection% ≥ control AND treatment param% ≥ control.\n\n`;
md += `| Model | treatment ≥ control sel? | treatment ≥ control param? | token cost ok? | Verdict |\n|---|---|---|---|---|\n`;
const tokOk = toolsListTokens.treatment <= toolsListTokens.control;
for (const { m, a } of scored) {
  const selOk = a.tSel >= a.cSel - 1e-9;
  const paramOk = a.tParam >= a.cParam - 1e-9;
  const pass = selOk && paramOk && tokOk;
  md += `| ${m} | ${selOk ? 'yes' : 'NO'} | ${paramOk ? 'yes' : 'NO'} | ${tokOk ? 'yes' : 'NO'} | ${pass ? '**PASS**' : '**FAIL**'} |\n`;
}
md += `\n`;

// tokens
md += `## Token cost (full tools-list JSON, ≈ chars/4)\n\n`;
md += `- control (102 tools): **${toolsListTokens.control.toLocaleString()} tokens**\n`;
md += `- treatment (55 tools): **${toolsListTokens.treatment.toLocaleString()} tokens**\n`;
const saved = toolsListTokens.control - toolsListTokens.treatment;
md += `- savings: **${saved.toLocaleString()} tokens (${((saved / toolsListTokens.control) * 100).toFixed(0)}% smaller)** per request\n\n`;

// per-task breakdown (averaged across scored models)
md += `## Per-task breakdown (averaged across scored models; param accuracy)\n\n`;
md += `| # | Task | ctrl sel | trt sel | ctrl param | trt param | Δ param | Result |\n|---|---|---|---|---|---|---|---|\n`;
for (let ti = 0; ti < tasks.length; ti++) {
  const rowModels = scored.filter(({ m }) => cells[m]?.[ti]?.control && cells[m]?.[ti]?.treatment);
  if (!rowModels.length) {
    md += `| ${ti + 1} | ${tasks[ti].prompt.slice(0, 48)}… | n/a | n/a | n/a | n/a | n/a | no data |\n`;
    continue;
  }
  const mean = (sf, field) =>
    rowModels.reduce((s, { m }) => s + cells[m][ti][sf][field], 0) / rowModels.length;
  const cs = mean('control', 'selectionAvg'), ts = mean('treatment', 'selectionAvg');
  const cp = mean('control', 'paramAvg'), tp = mean('treatment', 'paramAvg');
  const dParam = Math.round((tp - cp) * 100);
  let result;
  if (dParam > 5) result = 'IMPROVED';
  else if (dParam < -5) result = '⚠ REGRESSED';
  else result = 'equal';
  md += `| ${ti + 1} | ${tasks[ti].prompt.slice(0, 48)}… | ${pct(cs)} | ${pct(ts)} | ${pct(cp)} | ${pct(tp)} | ${sign(dParam)}pp | ${result} |\n`;
}
md += `\n`;

// verdict
if (scored.length) {
  const mean = (f) => scored.reduce((s, x) => s + f(x.a), 0) / scored.length;
  const cS = mean((a) => a.cSel), tS = mean((a) => a.tSel), cP = mean((a) => a.cParam), tP = mean((a) => a.tParam);
  const allPass = scored.every(({ a }) => a.tSel >= a.cSel - 1e-9 && a.tParam >= a.cParam - 1e-9) && tokOk;
  md += `## Verdict\n\n`;
  md += `**${allPass ? 'YES' : 'NO'}** — across ${scored.length} available model(s), treatment (55 tools) `;
  md += `${allPass ? 'beats or matches' : 'does NOT uniformly beat'} control (102 tools): `;
  md += `selection ${pct(cS)}→${pct(tS)} (${sign(Math.round((tS - cS) * 100))}pp), `;
  md += `param ${pct(cP)}→${pct(tP)} (${sign(Math.round((tP - cP) * 100))}pp), `;
  md += `at ${saved.toLocaleString()} fewer tokens/request (${((saved / toolsListTokens.control) * 100).toFixed(0)}% smaller surface).\n`;
}

writeFileSync(resolve(HERE, 'results.md'), md);
process.stderr.write('Wrote results.md\n');
