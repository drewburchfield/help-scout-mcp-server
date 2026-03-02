#!/usr/bin/env npx tsx
/**
 * Debug: What does the raw API return for org members?
 */
import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import 'dotenv/config';

const SERVER_PATH = resolve(import.meta.dirname, '../dist/index.js');

let server: ChildProcess;
let requestId = 0;
let buffer = '';
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function start(): Promise<void> {
  return new Promise((res) => {
    server = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ALLOW_PII: 'true', LOG_LEVEL: 'debug' },
    });
    server.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      // Only show API-related debug lines
      if (msg.includes('organizations/33911683') || msg.includes('_embedded')) {
        process.stderr.write(`[server] ${msg}\n`);
      }
    });
    server.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if ('id' in msg && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch {}
      }
    });
    setTimeout(() => res(), 500);
  });
}

function rpc(method: string, params?: any): Promise<any> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, 30000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    server.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function main() {
  await start();
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'debug', version: '1.0.0' },
  });

  // Test 1: getOrganizationMembers for golden org
  console.log('\n=== getOrganizationMembers(33911683) ===');
  const membersResult = await rpc('tools/call', {
    name: 'getOrganizationMembers',
    arguments: { organizationId: '33911683' },
  });
  const membersData = JSON.parse(membersResult.content[0].text);
  console.log('Members returned:', membersData.returnedCount);
  console.log('Pagination:', JSON.stringify(membersData.pagination));

  // Test 2: getOrganization to see customerCount
  console.log('\n=== getOrganization(33911683) ===');
  const orgResult = await rpc('tools/call', {
    name: 'getOrganization',
    arguments: { organizationId: '33911683', includeCounts: true },
  });
  const orgData = JSON.parse(orgResult.content[0].text);
  console.log('customerCount:', orgData.organization?.customerCount);
  console.log('conversationCount:', orgData.organization?.conversationCount);

  // Test 3: getCustomer to verify org link
  console.log('\n=== getCustomer(860587086) ===');
  const custResult = await rpc('tools/call', {
    name: 'getCustomer',
    arguments: { customerId: '860587086' },
  });
  const custData = JSON.parse(custResult.content[0].text);
  console.log('organizationId:', custData.customer?.organizationId);
  console.log('organization:', custData.customer?.organization);

  // Test 4: Try Kahn Media org (known to work) for comparison
  console.log('\n=== getOrganizationMembers(31981744) [Kahn Media - known working] ===');
  const kahnResult = await rpc('tools/call', {
    name: 'getOrganizationMembers',
    arguments: { organizationId: '31981744' },
  });
  const kahnData = JSON.parse(kahnResult.content[0].text);
  console.log('Members returned:', kahnData.returnedCount);

  server.stdin?.end();
  server.kill('SIGTERM');
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  server?.kill('SIGTERM');
  process.exit(1);
});
