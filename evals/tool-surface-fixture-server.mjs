import { appendFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { fixtureExecutor } from './run-tool-surface-discriminator.mjs';
import { createToolSurfacePrototypes } from './tool-surface-prototype.mjs';
import { createProductionGatewayCandidate } from './production-gateway-candidate.mjs';

const candidateName = process.env.CANDIDATE;
const traceFile = process.env.TRACE_FILE;
// Which write gate the production gateway candidate is built with. The gate is
// injected rather than read from HELPSCOUT_ENABLE_WRITES so a screen can serve
// a writes-disabled surface from a shell that has writes enabled.
const candidateWrites = process.env.CANDIDATE_WRITES || 'off';

if (!candidateName || !traceFile) {
  throw new Error('CANDIDATE and TRACE_FILE are required');
}

const { candidates } = await createToolSurfacePrototypes({ executeOperation: fixtureExecutor });
candidates.push(await createProductionGatewayCandidate({
  executeOperation: fixtureExecutor,
  writes: candidateWrites,
}));
const candidate = candidates.find((item) => item.name === candidateName);

if (!candidate) {
  throw new Error(
    `Unknown candidate: ${candidateName} (CANDIDATE_WRITES=${candidateWrites}). ` +
    `Available: ${candidates.map((item) => item.name).join(', ')}.`,
  );
}

const server = new Server(
  { name: `helpscout-eval-${candidate.name}`, version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: candidate.tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  const result = await candidate.call(name, args);
  appendFileSync(traceFile, `${JSON.stringify({
    name,
    args,
    resultCharacters: String(result.content?.[0]?.text || JSON.stringify(result)).length,
  })}\n`);
  return result;
});

await server.connect(new StdioServerTransport());
