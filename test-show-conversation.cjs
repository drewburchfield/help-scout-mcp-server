#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadEnv() {
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

async function main() {
  const env = loadEnv();
  const proc = spawn('node', ['dist/index.js'], {
    env: { ...process.env, ...env, ALLOW_PII: 'true' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let buffer = '';
  let id = 1;
  proc.stdout.on('data', d => buffer += d.toString());

  await new Promise(r => setTimeout(r, 2000));

  async function send(msg) {
    const req = { ...msg, jsonrpc: '2.0', id: id++ };
    buffer = '';
    proc.stdin.write(JSON.stringify(req) + '\n');
    await new Promise(r => setTimeout(r, 1500));
    const lines = buffer.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const resp = JSON.parse(line);
        if (resp.id === req.id) return resp;
      } catch (e) {}
    }
    return null;
  }

  console.log('🔍 Fetching active conversations with full details...\n');

  await send({ method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' }}});

  const resp = await send({
    method: 'tools/call',
    params: {
      name: 'searchConversations',
      arguments: { status: 'active', limit: 2 }
    }
  });

  if (resp && resp.result) {
    const data = JSON.parse(resp.result.content[0].text);

    console.log('📊 CONVERSATION STRUCTURE ANALYSIS\n');
    console.log(`Total found: ${data.results.length}`);
    console.log(`Inbox scope: ${data.searchInfo.inboxScope}\n`);

    data.results.forEach((conv, idx) => {
      console.log(`\n--- Conversation ${idx + 1} ---`);
      console.log(`ID: ${conv.id}`);
      console.log(`Number: #${conv.number}`);
      console.log(`Subject: ${conv.subject}`);
      console.log(`Status: ${conv.status}`);
      console.log(`Assignee: ${conv.assignee ? `${conv.assignee.firstName} ${conv.assignee.lastName} (ID: ${conv.assignee.id}, ${conv.assignee.email})` : 'Unassigned'}`);
      console.log(`Customer: ${conv.customer.firstName} ${conv.customer.lastName} (${conv.customer.email})`);
      console.log(`Mailbox: ${conv.mailbox.name}`);
      console.log(`Tags: ${conv.tags.map(t => t.name).join(', ') || 'None'}`);
      console.log(`Threads: ${conv.threads} messages`);
      console.log(`Created: ${conv.createdAt}`);
      console.log(`Updated: ${conv.updatedAt}`);
    });

    // Now get threads for first conversation
    if (data.results.length > 0) {
      console.log(`\n\n🧵 GETTING THREAD MESSAGES FOR FIRST CONVERSATION...\n`);

      const convId = data.results[0].id;
      const threadResp = await send({
        method: 'tools/call',
        params: {
          name: 'getThreads',
          arguments: { conversationId: convId.toString(), limit: 50 }
        }
      });

      if (threadResp && threadResp.result) {
        const threadData = JSON.parse(threadResp.result.content[0].text);
        console.log(`Total threads: ${threadData.threads.length}\n`);

        threadData.threads.forEach((thread, idx) => {
          console.log(`Thread ${idx + 1}:`);
          console.log(`  Type: ${thread.type}`);
          console.log(`  Created: ${thread.createdAt}`);
          if (thread.createdBy) {
            console.log(`  Created by: ${thread.createdBy.firstName} ${thread.createdBy.lastName} (${thread.createdBy.email})`);
          }
          if (thread.customer) {
            console.log(`  Customer: ${thread.customer.firstName} ${thread.customer.lastName}`);
          }
          console.log(`  Body: ${thread.body.substring(0, 100)}...`);
          console.log('');
        });
      }
    }
  }

  proc.kill();
}

main().catch(console.error);
