#!/usr/bin/env node

/**
 * Data Discovery Test
 * Explores what data actually exists in Help Scout account
 * Tests various time ranges, statuses, and inboxes
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found');
    process.exit(1);
  }

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

class DataDiscovery {
  constructor() {
    this.serverProcess = null;
    this.messageId = 1;
    this.responseBuffer = '';
  }

  async startServer(env) {
    return new Promise((resolve, reject) => {
      this.serverProcess = spawn('node', [SERVER_PATH], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let serverReady = false;
      this.serverProcess.stderr.on('data', (data) => {
        if (data.toString().includes('Help Scout MCP Server started')) {
          serverReady = true;
          resolve();
        }
      });

      this.serverProcess.stdout.on('data', (data) => {
        this.responseBuffer += data.toString();
      });

      setTimeout(() => {
        if (!serverReady) reject(new Error('Server startup timeout'));
      }, 10000);
    });
  }

  async sendMessage(message) {
    return new Promise((resolve, reject) => {
      const request = { ...message, jsonrpc: '2.0', id: this.messageId++ };
      this.responseBuffer = '';
      this.serverProcess.stdin.write(JSON.stringify(request) + '\n');

      const responseTimeout = setTimeout(() => {
        reject(new Error(`Timeout: ${message.method}`));
      }, 10000);

      const checkResponse = () => {
        const lines = this.responseBuffer.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const response = JSON.parse(line);
            if (response.id === request.id) {
              clearTimeout(responseTimeout);
              resolve(response);
              return;
            }
          } catch (e) {}
        }
        setTimeout(checkResponse, 100);
      };
      checkResponse();
    });
  }

  async initialize() {
    await this.sendMessage({
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'data-discovery', version: '1.0.0' }
      }
    });
  }

  async exploreData() {
    console.log('\n🔍 EXPLORING HELP SCOUT DATA\n');

    // 1. Get all inboxes
    console.log('📥 Step 1: Discovering Inboxes...');
    const inboxResp = await this.sendMessage({
      method: 'tools/call',
      params: { name: 'listAllInboxes', arguments: { limit: 100 } }
    });

    const inboxData = JSON.parse(inboxResp.result.content[0].text);
    const inboxes = inboxData.inboxes;

    console.log(`   Found ${inboxes.length} inboxes:\n`);
    inboxes.forEach((inbox, idx) => {
      console.log(`   ${idx + 1}. ${inbox.name} (${inbox.email}) - ID: ${inbox.id}`);
    });

    // 2. Search each inbox for data
    console.log('\n📊 Step 2: Searching for conversations in each inbox...\n');

    const statuses = ['active', 'pending', 'closed', 'spam'];
    const timeRanges = [
      { label: 'Last 7 days', days: 7 },
      { label: 'Last 30 days', days: 30 },
      { label: 'Last 90 days', days: 90 },
      { label: 'Last 365 days', days: 365 }
    ];

    for (const inbox of inboxes) {
      console.log(`\n📮 Inbox: ${inbox.name}`);

      for (const timeRange of timeRanges) {
        const since = new Date();
        since.setDate(since.getDate() - timeRange.days);

        let foundAny = false;

        for (const status of statuses) {
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'searchConversations',
              arguments: {
                inboxId: inbox.id.toString(),
                status: status,
                createdAfter: since.toISOString(),
                limit: 5
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);

          if (results.results && results.results.length > 0) {
            console.log(`   ✅ ${timeRange.label}, ${status}: ${results.results.length} conversations`);

            // Show first conversation details to understand structure
            if (!foundAny) {
              foundAny = true;
              const firstConv = results.results[0];
              console.log(`\n   📋 Sample Conversation Structure:`);
              console.log(`      ID: ${firstConv.id}`);
              console.log(`      Number: #${firstConv.number}`);
              console.log(`      Subject: ${firstConv.subject}`);
              console.log(`      Status: ${firstConv.status}`);
              console.log(`      Assignee: ${firstConv.assignee ? `${firstConv.assignee.firstName} ${firstConv.assignee.lastName} (ID: ${firstConv.assignee.id})` : 'Unassigned'}`);
              console.log(`      Customer: ${firstConv.customer.firstName} ${firstConv.customer.lastName} (${firstConv.customer.email})`);
              console.log(`      Tags: ${firstConv.tags.map(t => t.name).join(', ') || 'None'}`);
              console.log(`      Created: ${firstConv.createdAt}`);
              console.log(`      Threads: ${firstConv.threads} messages\n`);
            }
          }
        }

        if (foundAny) break; // Found data, no need to try older ranges
      }
    }

    // 3. Try a very broad search
    console.log('\n\n🌍 Step 3: Broad search across ALL inboxes and statuses...\n');

    for (const timeRange of timeRanges) {
      const since = new Date();
      since.setDate(since.getDate() - timeRange.days);

      for (const status of statuses) {
        const searchResp = await this.sendMessage({
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: {
              status: status,
              createdAfter: since.toISOString(),
              limit: 10
            }
          }
        });

        const results = JSON.parse(searchResp.result.content[0].text);

        if (results.results && results.results.length > 0) {
          console.log(`   ✅ ${timeRange.label}, ${status}: ${results.results.length} conversations`);
          console.log(`      Inbox scope: ${results.searchInfo.inboxScope}`);

          // Show assignee distribution
          const assigneeMap = {};
          results.results.forEach(conv => {
            const assignee = conv.assignee
              ? `${conv.assignee.firstName} ${conv.assignee.lastName}`
              : 'Unassigned';
            assigneeMap[assignee] = (assigneeMap[assignee] || 0) + 1;
          });

          console.log(`      Assignee distribution:`, assigneeMap);
          return; // Found data, stop searching
        }
      }
    }

    console.log('\n   ⚠️  No conversations found in any time range or status');
  }

  async cleanup() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  const discovery = new DataDiscovery();

  console.log('🔬 Help Scout Data Discovery');
  console.log('Finding what data exists and understanding structure');
  console.log('='.repeat(80));

  try {
    const env = loadEnvFile();

    if (!env.HELPSCOUT_CLIENT_ID || !env.HELPSCOUT_CLIENT_SECRET) {
      console.error('❌ Missing credentials');
      process.exit(1);
    }

    await discovery.startServer(env);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await discovery.initialize();
    await discovery.exploreData();
    await discovery.cleanup();

    console.log('\n✅ Discovery complete');

  } catch (error) {
    console.error('❌ Error:', error.message);
    await discovery.cleanup();
    process.exit(1);
  }
}

main();
