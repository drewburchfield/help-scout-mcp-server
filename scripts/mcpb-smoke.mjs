#!/usr/bin/env node
/**
 * Smoke test for the packed MCPB extension build.
 *
 * Spawns the extension's real entry point (helpscout-mcp-extension/build/
 * server/cli.js) exactly as Claude Desktop would and requires an initialize
 * response over stdio. This exists because a build whose entry guard failed
 * once shipped: it imported its modules, did nothing, and exited 0, which
 * every static validator passed. Run from the repo root after mcpb:build so
 * the server's dotenv loads credentials from .env; in CI, provide
 * HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET in the environment.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const ENTRY = 'helpscout-mcp-extension/build/server/cli.js';

if (!existsSync(ENTRY)) {
  console.error(`mcpb-smoke: ${ENTRY} not found. Run "npm run mcpb:build" first.`);
  process.exit(1);
}

const startedAt = Date.now();
const child = spawn(process.execPath, [ENTRY], { env: process.env });
let stdout = '';
let stderrTail = '';

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  if (stdout.includes('"id":0')) {
    console.log(`mcpb-smoke: initialize answered in ${Date.now() - startedAt}ms`);
    child.kill();
    process.exit(0);
  }
});

child.stderr.on('data', (chunk) => {
  stderrTail = (stderrTail + chunk.toString()).slice(-2000);
});

child.on('exit', (code) => {
  console.error(`mcpb-smoke: server exited (code ${code}) after ${Date.now() - startedAt}ms without answering initialize.`);
  if (stderrTail) console.error(stderrTail);
  process.exit(1);
});

setTimeout(() => {
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpb-smoke', version: '1.0' } },
  }) + '\n');
}, 300);

setTimeout(() => {
  console.error('mcpb-smoke: no initialize response within 30s.');
  child.kill();
  process.exit(1);
}, 30000);
