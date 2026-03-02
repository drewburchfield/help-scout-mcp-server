#!/usr/bin/env npx tsx
/**
 * MCP Client Dogfood Test
 *
 * Spawns the built MCP server as a child process and communicates
 * over stdio using the MCP JSON-RPC protocol. Tests all 16 tools
 * against the live Help Scout API.
 *
 * Usage: npx tsx tests/mcp-client-dogfood.ts
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_PATH = resolve(import.meta.dirname, '../dist/index.js');
const GOLDEN = {
  customerId: '860587086',
  customerEmail: 'testuser@meridian-testing.com',
  orgId: '33911683',
  inboxId: '359402',
};

// ---------------------------------------------------------------------------
// JSON-RPC over stdio transport
// ---------------------------------------------------------------------------

let server: ChildProcess;
let requestId = 0;
let buffer = '';
const pendingRequests = new Map<
  number,
  { resolve: (val: any) => void; reject: (err: Error) => void }
>();

function startServer(): Promise<void> {
  return new Promise((resolveInit, rejectInit) => {
    server = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ALLOW_PII: 'true',
        LOG_LEVEL: 'error',
      },
    });

    server.stderr?.on('data', (data: Buffer) => {
      // Log server stderr for debugging but don't clutter output
      const msg = data.toString().trim();
      if (msg && !msg.includes('Server running')) {
        process.stderr.write(`  [server stderr] ${msg}\n`);
      }
    });

    server.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      processBuffer();
    });

    server.on('error', (err) => {
      rejectInit(err);
    });

    // Give server a moment to start
    setTimeout(() => resolveInit(), 500);
  });
}

function processBuffer() {
  // MCP SDK uses newline-delimited JSON (not Content-Length framing)
  while (true) {
    const newlineIdx = buffer.indexOf('\n');
    if (newlineIdx === -1) break;

    const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
    buffer = buffer.slice(newlineIdx + 1);

    if (!line.trim()) continue; // skip empty lines

    try {
      const message = JSON.parse(line);
      handleMessage(message);
    } catch {
      process.stderr.write(`  [parse error] ${line.slice(0, 200)}\n`);
    }
  }
}

function handleMessage(message: any) {
  if ('id' in message && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id)!;
    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }
}

function sendRequest(method: string, params?: any): Promise<any> {
  const id = ++requestId;
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, 30000);

    pendingRequests.set(id, {
      resolve: (val) => {
        clearTimeout(timeout);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    server.stdin?.write(line);
  });
}

function sendNotification(method: string, params?: any): void {
  const line = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  server.stdin?.write(line);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function test(
  name: string,
  toolName: string,
  args: Record<string, unknown>,
  check: (data: any, raw: any) => boolean | string,
): Promise<void> {
  process.stderr.write(`  ${name}...`);
  const start = Date.now();
  try {
    const result = await sendRequest('tools/call', { name: toolName, arguments: args });
    const duration = Date.now() - start;
    const text = result?.content?.[0]?.text;
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    const checkResult = check(data, result);
    if (checkResult === true) {
      process.stderr.write(` PASS (${duration}ms)\n`);
      results.push({ name, status: 'PASS', durationMs: duration });
    } else {
      const detail = typeof checkResult === 'string' ? checkResult : 'Check failed';
      process.stderr.write(` FAIL - ${detail}\n`);
      results.push({ name, status: 'FAIL', detail, durationMs: duration });
    }
  } catch (err: any) {
    const duration = Date.now() - start;
    // Some tests expect errors
    const checkResult = check(null, { error: err.message });
    if (checkResult === true) {
      process.stderr.write(` PASS (${duration}ms)\n`);
      results.push({ name, status: 'PASS', durationMs: duration });
    } else {
      process.stderr.write(` FAIL - ${err.message?.slice(0, 100)}\n`);
      results.push({ name, status: 'FAIL', detail: err.message, durationMs: duration });
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  process.stderr.write('\n=== MCP Client Dogfood: All 16 Tools via Stdio ===\n\n');

  // --- Initialize handshake ---
  process.stderr.write('--- MCP Handshake ---\n');
  const initResult = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dogfood-test', version: '1.0.0' },
  });
  process.stderr.write(`  Server: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}\n`);
  process.stderr.write(`  Protocol: ${initResult.protocolVersion}\n`);
  process.stderr.write(`  Capabilities: ${JSON.stringify(Object.keys(initResult.capabilities || {}))}\n\n`);

  // Send initialized notification
  sendNotification('notifications/initialized');

  // --- List tools ---
  process.stderr.write('--- Tool Discovery ---\n');
  const toolsResult = await sendRequest('tools/list', {});
  const toolNames = toolsResult.tools.map((t: any) => t.name);
  process.stderr.write(`  Found ${toolNames.length} tools: ${toolNames.join(', ')}\n\n`);

  // --- Tool tests ---

  // 1. getServerTime
  process.stderr.write('--- Category: Server & Inbox ---\n');
  await test('getServerTime', 'getServerTime', {}, (d) =>
    d?.isoTime ? true : 'Missing isoTime',
  );

  // 2. listAllInboxes
  await test('listAllInboxes', 'listAllInboxes', {}, (d) =>
    Array.isArray(d?.inboxes || d?.results) && (d?.inboxes || d?.results).length > 0
      ? true : 'No inboxes returned',
  );

  // 3. searchInboxes
  await test('searchInboxes (query="Client")', 'searchInboxes', { query: 'Client' }, (d) =>
    (d?.results || d?.inboxes)?.some((i: any) => i.name?.includes('Client'))
      ? true : 'No matching inbox',
  );

  await test('searchInboxes (empty query = list all)', 'searchInboxes', { query: '' }, (d) =>
    Array.isArray(d?.results || d?.inboxes) && (d?.results || d?.inboxes).length >= 2
      ? true : 'Expected 2+ inboxes',
  );

  // 4. searchConversations
  process.stderr.write('\n--- Category: Conversation Search ---\n');
  await test('searchConversations (inbox)', 'searchConversations', {
    inboxId: GOLDEN.inboxId,
    limit: 5,
  }, (d) =>
    Array.isArray(d?.results || d?.conversations) ? true : 'Missing results array',
  );

  // 5. advancedConversationSearch
  await test('advancedConversationSearch (status=active)', 'advancedConversationSearch', {
    inboxId: GOLDEN.inboxId,
    status: 'active',
    limit: 3,
  }, (d) =>
    Array.isArray(d?.results || d?.conversations) ? true : 'Missing results array',
  );

  // 6. comprehensiveConversationSearch (returns resultsByStatus, not flat array)
  await test('comprehensiveConversationSearch (keyword)', 'comprehensiveConversationSearch', {
    searchTerms: ['test'],
    limit: 3,
  }, (d) =>
    Array.isArray(d?.resultsByStatus) ? true : 'Missing resultsByStatus array',
  );

  // 7. structuredConversationFilter
  await test('structuredConversationFilter (customerIds)', 'structuredConversationFilter', {
    customerIds: [Number(GOLDEN.customerId)],
    limit: 5,
  }, (d) =>
    Array.isArray(d?.results || d?.conversations) ? true : 'Missing results array',
  );

  // 8. getConversationSummary - need a real conversation ID
  let conversationId: string | null = null;
  {
    const searchRes = await sendRequest('tools/call', {
      name: 'searchConversations',
      arguments: { inboxId: GOLDEN.inboxId, limit: 1 },
    });
    const searchData = JSON.parse(searchRes?.content?.[0]?.text || '{}');
    const convos = searchData?.results || searchData?.conversations || [];
    conversationId = convos[0]?.id ? String(convos[0].id) : null;
  }

  if (conversationId) {
    process.stderr.write('\n--- Category: Conversation Detail ---\n');
    await test(`getConversationSummary (ID: ${conversationId})`, 'getConversationSummary', {
      conversationId,
    }, (d) =>
      d?.conversation?.id ? true : 'Missing conversation data',
    );

    // 9. getThreads
    await test(`getThreads (ID: ${conversationId})`, 'getThreads', {
      conversationId,
    }, (d) =>
      Array.isArray(d?.threads) ? true : 'Missing threads array',
    );
  } else {
    process.stderr.write('\n  [skip] No conversation found for detail tests\n');
  }

  // 10-12. Customer tools
  process.stderr.write('\n--- Category: Customer ---\n');
  await test(`getCustomer (golden: ${GOLDEN.customerId})`, 'getCustomer', {
    customerId: GOLDEN.customerId,
  }, (d) => {
    if (!d?.customer) return 'Missing customer data';
    const c = d.customer;
    if (c.firstName !== 'Meridian') return `Wrong firstName: ${c.firstName}`;
    if (c.lastName !== 'TestUser') return `Wrong lastName: ${c.lastName}`;
    if (!c._embedded?.emails?.length) return 'Missing embedded emails';
    return true;
  });

  await test('listCustomers (page 1)', 'listCustomers', { page: 1 }, (d) =>
    Array.isArray(d?.results) ? true : 'Missing results array',
  );

  await test(`searchCustomersByEmail (${GOLDEN.customerEmail})`, 'searchCustomersByEmail', {
    email: GOLDEN.customerEmail,
  }, (d) =>
    d?.results?.some((c: any) => String(c.id) === GOLDEN.customerId)
      ? true
      : 'Golden customer not found by email',
  );

  // 13-16. Organization tools
  process.stderr.write('\n--- Category: Organization ---\n');
  await test(`getOrganization (golden: ${GOLDEN.orgId})`, 'getOrganization', {
    organizationId: GOLDEN.orgId,
  }, (d) => {
    if (!d?.organization) return 'Missing organization data';
    if (d.organization.name !== 'Meridian Testing Corp') return `Wrong name: ${d.organization.name}`;
    return true;
  });

  await test('listOrganizations (page 1)', 'listOrganizations', { page: 1 }, (d) =>
    Array.isArray(d?.results) && d.results.length > 0 ? true : 'No orgs returned',
  );

  await test(`getOrganizationMembers (golden org)`, 'getOrganizationMembers', {
    organizationId: GOLDEN.orgId,
  }, (d) =>
    Array.isArray(d?.members) ? true : 'Missing members array',
  );

  await test(`getOrganizationConversations (golden org)`, 'getOrganizationConversations', {
    organizationId: GOLDEN.orgId,
  }, (d) =>
    Array.isArray(d?.conversations) ? true : 'Missing conversations array',
  );

  // --- Edge cases ---
  process.stderr.write('\n--- Category: Edge Cases ---\n');

  await test('getCustomer (invalid ID)', 'getCustomer', {
    customerId: '999999999999',
  }, (d) =>
    d?.error ? true : 'Expected error for invalid ID',
  );

  await test('searchConversations (special chars)', 'searchConversations', {
    inboxId: GOLDEN.inboxId,
    query: 'test <script>alert("xss")</script>',
    limit: 1,
  }, (d) =>
    // Should not crash, either returns results or an error
    Array.isArray(d?.results) || Array.isArray(d?.conversations) || d?.error
      ? true : 'Unexpected response',
  );

  await test('comprehensiveConversationSearch (emoji)', 'comprehensiveConversationSearch', {
    query: '🎉 celebration',
    limit: 1,
  }, (d) =>
    Array.isArray(d?.results) || Array.isArray(d?.conversations) || d?.error
      ? true : 'Unexpected response',
  );

  await test('searchCustomersByEmail (malformed)', 'searchCustomersByEmail', {
    email: 'not-an-email',
  }, (d) =>
    // Should handle gracefully
    d !== undefined ? true : 'No response',
  );

  await test('getOrganization (invalid ID)', 'getOrganization', {
    organizationId: '0',
  }, (d) =>
    d?.error ? true : 'Expected error for invalid ID',
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.stderr.write(`Starting MCP server from: ${SERVER_PATH}\n`);
  await startServer();

  try {
    await runTests();
  } finally {
    // Shutdown
    server.stdin?.end();
    server.kill('SIGTERM');
  }

  // Summary
  process.stderr.write('\n=== Summary ===\n\n');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  for (const r of results) {
    process.stderr.write(
      `  [${r.status}] ${r.name}${r.detail ? ` - ${r.detail.slice(0, 120)}` : ''}\n`,
    );
  }

  process.stderr.write(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests`);
  process.stderr.write(` (${(totalMs / 1000).toFixed(1)}s total)\n\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  server?.kill('SIGTERM');
  process.exit(1);
});
