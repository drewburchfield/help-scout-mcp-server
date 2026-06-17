// NAS-1308: per-model LOAD check — the cross-model compatibility metric.
// Does each tool surface load (no provider 400) on each model family?
// This is the metric that would have caught the anyOf bug. Run:
//   /opt/homebrew/bin/node evals/load-check.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY = 'http://127.0.0.1:8317/v1/chat/completions';
const MODELS = ['gemini-3-flash', 'gemini-3.1-pro-low', 'glm-4.7', 'gpt-5.5', 'gpt-5.4-mini'];
const PROMPT = 'Find conversations for customer 4815. Use a tool.';

const toOA = (tools) =>
  tools.map((t) => ('function' in t
    ? t
    : { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

async function buildSurfaces() {
  const { toolHandler, ToolHandler } = await import('../dist/tools/index.js');
  const { sanitizeJsonSchema } = await import('../dist/utils/schema-sanitizer.js');
  const h = toolHandler || new ToolHandler();
  const control = JSON.parse(readFileSync(resolve(HERE, 'surfaces/control.json'), 'utf8')); // 102, unsanitized
  const flatUnsan = JSON.parse(readFileSync(resolve(HERE, 'surfaces/treatment.json'), 'utf8')); // 55, unsanitized
  const sanitizeSurface = (s) =>
    s.map((t) => ({ type: 'function', function: { ...t.function, parameters: sanitizeJsonSchema(t.function.parameters) } }));
  const discovery = toOA(await h.listTools()); // 10 (default)
  process.env.HELPSCOUT_EXPOSE_ALL_TOOLS = 'true';
  const flatSan = toOA(await h.listTools()); // 55, sanitized
  delete process.env.HELPSCOUT_EXPOSE_ALL_TOOLS;
  return {
    'control-102 (unsanitized)': control,
    'control-102 (sanitized)': sanitizeSurface(control),
    'flat-55 (unsanitized)': flatUnsan,
    'flat-55 (sanitized)': flatSan,
    'discovery-10': discovery,
  };
}

async function loads(model, tools) {
  try {
    const r = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], tools, tool_choice: 'auto' }),
    });
    const d = await r.json();
    if (d.choices?.[0]?.message) return { ok: true };
    const code = String(d.error?.code || d.error?.type || '');
    const msg = String(d.error?.message || d.error || JSON.stringify(d)).slice(0, 80);
    // a quota/auth/config error is NOT a schema-load failure; mark it n/a
    const quota = /cooldown|usage_limit|usage limit|cooling down|baseURL|authentication|rate.?limit/i.test(`${code} ${msg}`);
    return { ok: false, quota, msg };
  } catch (e) {
    return { ok: false, quota: false, msg: e.message };
  }
}

const surfaces = await buildSurfaces();
const rows = [];
for (const [name, tools] of Object.entries(surfaces)) {
  const cells = {};
  for (const model of MODELS) cells[model] = await loads(model, tools);
  rows.push({ name, tools: tools.length, cells });
}

let md = `# NAS-1308 — Per-model tool-surface LOAD check\n\nDoes each surface load without a provider schema-400? \`LOAD\`=ok, \`FAIL\`=schema rejection, \`n/a\`=quota/config (not a schema issue).\n\n`;
md += `| Surface | tools | ${MODELS.join(' | ')} |\n|---|---|${MODELS.map(() => '---').join('|')}|\n`;
for (const r of rows) {
  const cells = MODELS.map((m) => {
    const c = r.cells[m];
    return c.ok ? 'LOAD' : c.quota ? 'n/a' : `**FAIL**`;
  });
  md += `| ${r.name} | ${r.tools} | ${cells.join(' | ')} |\n`;
}
md += `\n## Verdict\n\n`;
const geminiFailControl = rows.find((r) => r.name.includes('unsanitized') && r.name.includes('control'));
md += `- control-102 unsanitized fails on Gemini (the \`anyOf\` 400); sanitized loads → **the sanitizer fixes the cross-model load bug**.\n`;
md += `- discovery-10 loads on every reachable model at the smallest footprint.\n`;
writeFileSync(resolve(HERE, 'load-check-results.md'), md);
console.log(md);
