// Extracts the MCP tool surface from a built dist and writes OpenAI-format tools JSON.
// Usage: node extract-surface.mjs <distToolsIndexPath> <outputJsonPath>
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const distPath = process.argv[2] || '../dist/tools/index.js';
const outPath = process.argv[3] || './surfaces/treatment.json';

const mod = await import(pathToFileURL(resolve(distPath)).href);
const handler = mod.toolHandler;
if (!handler || typeof handler.listTools !== 'function') {
  throw new Error('toolHandler.listTools not found in ' + distPath);
}
const tools = await handler.listTools();
const openai = tools.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  },
}));
writeFileSync(resolve(outPath), JSON.stringify(openai, null, 2));
console.log(`Wrote ${openai.length} tools to ${outPath}`);
