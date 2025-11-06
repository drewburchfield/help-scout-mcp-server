#!/usr/bin/env node

/**
 * Raw Search Test - Absolutely minimal filters
 * Try to find ANY conversation that exists
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const envVars = {};
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        envVars[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
  return envVars;
}

const SERVER_PATH = path.join(__dirname, 'dist/index.js');

async function main() {
  const env = loadEnvFile();

  const serverProcess = spawn('node', [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let responseBuffer = '';
  let messageId = 1;

  serverProcess.stdout.on('data', (data) => {
    responseBuffer += data.toString();
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  async function send(message) {
    const request = { ...message, jsonrpc: '2.0', id: messageId++ };
    responseBuffer = '';
    serverProcess.stdin.write(JSON.stringify(request) + '\n');

    await new Promise(resolve => setTimeout(resolve, 1000));

    const lines = responseBuffer.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const response = JSON.parse(line);
        if (response.id === request.id) return response;
      } catch (e) {}
    }
    return null;
  }

  // Initialize
  await send({
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'raw-test', version: '1.0.0' }
    }
  });

  console.log('🔍 Testing various search strategies:\n');

  // Test 1: Absolutely no filters - just list everything
  console.log('1. Search with NO filters, NO time range, status=closed:');
  let resp = await send({
    method: 'tools/call',
    params: {
      name: 'searchConversations',
      arguments: {
        status: 'closed',
        limit: 10
      }
    }
  });
  let data = resp ? JSON.parse(resp.result.content[0].text) : null;
  console.log(`   Results: ${data?.results?.length || 0} conversations`);
  if (data?.results?.length > 0) {
    console.log(`   First: #${data.results[0].number} - ${data.results[0].subject}`);
  }

  // Test 2: Active status
  console.log('\n2. Search active conversations:');
  resp = await send({
    method: 'tools/call',
    params: {
      name: 'searchConversations',
      arguments: {
        status: 'active',
        limit: 10
      }
    }
  });
  data = resp ? JSON.parse(resp.result.content[0].text) : null;
  console.log(`   Results: ${data?.results?.length || 0} conversations`);

  // Test 3: Pending
  console.log('\n3. Search pending conversations:');
  resp = await send({
    method: 'tools/call',
    params: {
      name: 'searchConversations',
      arguments: {
        status: 'pending',
        limit: 10
      }
    }
  });
  data = resp ? JSON.parse(resp.result.content[0].text) : null;
  console.log(`   Results: ${data?.results?.length || 0} conversations`);

  // Test 4: Per-inbox search
  console.log('\n4. Search each inbox individually (closed status):');
  for (const inbox of [inboxes[0], inboxes[1]]) {
    resp = await send({
      method: 'tools/call',
      params: {
        name: 'searchConversations',
        arguments: {
          inboxId: inbox.id.toString(),
          status: 'closed',
          limit: 10
        }
      }
    });
    data = resp ? JSON.parse(resp.result.content[0].text) : null;
    console.log(`   ${inbox.name}: ${data?.results?.length || 0} conversations`);
  }

  // Test 5: Try without status filter at all (might need query parameter)
  console.log('\n5. Search with query parameter (body content):');
  resp = await send({
    method: 'tools/call',
    params: {
      name: 'searchConversations',
      arguments: {
        query: '(status:closed)',
        limit: 10
      }
    }
  });
  data = resp ? JSON.parse(resp.result.content[0].text) : null;
  console.log(`   Results: ${data?.results?.length || 0} conversations`);

  serverProcess.kill('SIGTERM');
  console.log('\n✅ Search tests complete');
}

main().catch(console.error);
