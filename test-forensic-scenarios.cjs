#!/usr/bin/env node

/**
 * Forensic Use Case Integration Tests
 * Tests real-world scenarios that users would ask:
 * - "Tell me all summaries of tickets in the last 30 days"
 * - "Tell me everything discussed about X or Y in the past two weeks"
 * - "Tell me about the performance of a particular rep"
 * - Multi-tool workflows and complex queries
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env file
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found. Please create one from .env.example');
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

class ForensicTester {
  constructor() {
    this.serverProcess = null;
    this.messageId = 1;
    this.responseBuffer = '';
    this.conversationIds = [];
  }

  log(message, type = 'INFO') {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const emoji = type === 'ERROR' ? '❌' : type === 'SUCCESS' ? '✅' : type === 'SCENARIO' ? '🔍' : 'ℹ️';
    console.log(`[${timestamp}] ${emoji} ${message}`);
  }

  async startServer(env) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(SERVER_PATH)) {
        reject(new Error('Server not built. Run: npm run build'));
        return;
      }

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
        reject(new Error(`Timeout waiting for response to: ${message.method}`));
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
    const response = await this.sendMessage({
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'forensic-test', version: '1.0.0' }
      }
    });
    return response.result;
  }

  async cleanup() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Forensic test scenarios
  async runForensicScenarios() {
    const scenarios = [
      {
        name: '🔍 Scenario 1: "Show me all tickets from the last 30 days"',
        description: 'Time-based listing without search terms',
        workflow: async () => {
          // Step 1: Get server time
          const timeResp = await this.sendMessage({
            method: 'tools/call',
            params: { name: 'getServerTime', arguments: {} }
          });
          const serverTime = JSON.parse(timeResp.result.content[0].text);

          // Step 2: Calculate 30 days ago
          const thirtyDaysAgo = new Date(serverTime.isoTime);
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

          // Step 3: Search conversations without query (list all)
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'searchConversations',
              arguments: {
                createdAfter: thirtyDaysAgo.toISOString(),
                status: 'closed',
                limit: 10
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);
          this.log(`  Found ${results.results.length} conversations`, 'INFO');
          this.log(`  Inbox scope: ${results.searchInfo.inboxScope}`, 'INFO');
          this.log(`  Applied defaults: ${JSON.stringify(results.searchInfo.appliedDefaults)}`, 'INFO');

          // Store conversation IDs for later scenarios
          if (results.results.length > 0) {
            this.conversationIds = results.results.slice(0, 3).map(c => c.id);
          }

          return {
            passed: true,
            toolsUsed: ['getServerTime', 'searchConversations'],
            conversationCount: results.results.length
          };
        }
      },
      {
        name: '🔍 Scenario 2: "Tell me everything discussed about billing in the past 2 weeks"',
        description: 'Content search with time range and multi-status',
        workflow: async () => {
          // Use comprehensiveConversationSearch for multi-status content search
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'comprehensiveConversationSearch',
              arguments: {
                searchTerms: ['billing', 'invoice', 'payment'],
                timeframeDays: 14,
                searchIn: ['both'],
                statuses: ['active', 'pending', 'closed'],
                limitPerStatus: 10
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);
          this.log(`  Found ${results.totalConversationsFound} total conversations`, 'INFO');
          this.log(`  Inbox scope: ${results.inboxScope}`, 'INFO');
          this.log(`  Searched in: ${results.searchIn.join(', ')}`, 'INFO');

          // Show breakdown by status
          results.resultsByStatus.forEach(statusResult => {
            this.log(`    ${statusResult.status}: ${statusResult.conversations.length} conversations`, 'INFO');
          });

          return {
            passed: true,
            toolsUsed: ['comprehensiveConversationSearch'],
            conversationCount: results.totalConversationsFound,
            statusBreakdown: results.resultsByStatus
          };
        }
      },
      {
        name: '🔍 Scenario 3: "Get summaries of all tickets in the last 30 days"',
        description: 'Multi-step workflow: search → get summaries for each',
        workflow: async () => {
          // Step 1: Search for recent conversations
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'comprehensiveConversationSearch',
              arguments: {
                searchTerms: ['support', 'help', 'issue'],
                timeframeDays: 30,
                limitPerStatus: 5
              }
            }
          });

          const searchResults = JSON.parse(searchResp.result.content[0].text);
          const allConversations = searchResults.resultsByStatus.flatMap(s => s.conversations);

          this.log(`  Found ${allConversations.length} conversations to summarize`, 'INFO');

          // Step 2: Get summary for each conversation
          const summaries = [];
          for (const conv of allConversations.slice(0, 3)) { // Limit to 3 for test speed
            const summaryResp = await this.sendMessage({
              method: 'tools/call',
              params: {
                name: 'getConversationSummary',
                arguments: { conversationId: conv.id.toString() }
              }
            });

            const summary = JSON.parse(summaryResp.result.content[0].text);
            summaries.push(summary);
            this.log(`    Summary for #${conv.number}: ${summary.conversation.subject}`, 'INFO');
          }

          return {
            passed: true,
            toolsUsed: ['comprehensiveConversationSearch', 'getConversationSummary'],
            conversationCount: allConversations.length,
            summariesRetrieved: summaries.length
          };
        }
      },
      {
        name: '🔍 Scenario 4: "Find all conversations from company X (email domain search)"',
        description: 'Organization-level search by email domain',
        workflow: async () => {
          // Use advancedConversationSearch with emailDomain
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'advancedConversationSearch',
              arguments: {
                emailDomain: 'example.com',
                createdAfter: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
                limit: 20
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);
          this.log(`  Found ${results.results.length} conversations from @example.com`, 'INFO');
          this.log(`  Inbox scope: ${results.inboxScope}`, 'INFO');

          return {
            passed: true,
            toolsUsed: ['advancedConversationSearch'],
            conversationCount: results.results.length
          };
        }
      },
      {
        name: '🔍 Scenario 5: "Show me urgent/priority tagged tickets"',
        description: 'Tag-based filtering',
        workflow: async () => {
          // Use advancedConversationSearch with tags
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'advancedConversationSearch',
              arguments: {
                tags: ['urgent', 'priority', 'escalated'],
                status: 'active',
                limit: 25
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);
          this.log(`  Found ${results.results.length} urgent/priority tickets`, 'INFO');
          this.log(`  Search criteria: ${JSON.stringify(results.searchCriteria.tags)}`, 'INFO');

          return {
            passed: true,
            toolsUsed: ['advancedConversationSearch'],
            conversationCount: results.results.length
          };
        }
      },
      {
        name: '🔍 Scenario 6: "Get full thread history for conversation deep dive"',
        description: 'Deep dive into specific conversation',
        workflow: async () => {
          // Use a conversation ID from earlier search
          if (this.conversationIds.length === 0) {
            this.log('  Skipping - no conversation IDs available', 'INFO');
            return { passed: true, skipped: true };
          }

          const convId = this.conversationIds[0];

          // Get full thread history
          const threadsResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'getThreads',
              arguments: {
                conversationId: convId.toString(),
                limit: 50
              }
            }
          });

          const results = JSON.parse(threadsResp.result.content[0].text);
          this.log(`  Conversation #${convId}: ${results.threads.length} thread messages`, 'INFO');

          // Count message types
          const messageTypes = results.threads.reduce((acc, t) => {
            acc[t.type] = (acc[t.type] || 0) + 1;
            return acc;
          }, {});

          this.log(`  Message breakdown: ${JSON.stringify(messageTypes)}`, 'INFO');

          return {
            passed: true,
            toolsUsed: ['getThreads'],
            threadCount: results.threads.length
          };
        }
      },
      {
        name: '🔍 Scenario 7: "Complex boolean search - (billing OR invoice) AND urgent"',
        description: 'Complex multi-term search with AND/OR logic',
        workflow: async () => {
          // Use advancedConversationSearch for complex queries
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'advancedConversationSearch',
              arguments: {
                contentTerms: ['billing', 'invoice', 'payment'],
                tags: ['urgent'],
                status: 'active',
                limit: 15
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);
          this.log(`  Found ${results.results.length} urgent billing conversations`, 'INFO');
          this.log(`  Search query: ${results.searchQuery}`, 'INFO');

          return {
            passed: true,
            toolsUsed: ['advancedConversationSearch'],
            conversationCount: results.results.length
          };
        }
      },
      {
        name: '🔍 Scenario 8: "Find conversations about product X in subject line only"',
        description: 'Subject-only search',
        workflow: async () => {
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'advancedConversationSearch',
              arguments: {
                subjectTerms: ['product', 'feature', 'request'],
                status: 'closed',
                createdAfter: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
                limit: 20
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);
          this.log(`  Found ${results.results.length} conversations with product in subject`, 'INFO');

          return {
            passed: true,
            toolsUsed: ['advancedConversationSearch'],
            conversationCount: results.results.length
          };
        }
      },
      {
        name: '🔍 Scenario 9: "List recent activity across all statuses"',
        description: 'Multi-status listing without specific search terms',
        workflow: async () => {
          // Get time range
          const now = new Date();
          const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

          // Search each status separately
          const statuses = ['active', 'pending', 'closed'];
          const allResults = [];

          for (const status of statuses) {
            const searchResp = await this.sendMessage({
              method: 'tools/call',
              params: {
                name: 'searchConversations',
                arguments: {
                  status: status,
                  createdAfter: sevenDaysAgo.toISOString(),
                  limit: 10
                }
              }
            });

            const results = JSON.parse(searchResp.result.content[0].text);
            allResults.push({
              status,
              count: results.results.length,
              inboxScope: results.searchInfo.inboxScope
            });
          }

          this.log(`  Activity breakdown:`, 'INFO');
          allResults.forEach(r => {
            this.log(`    ${r.status}: ${r.count} conversations (${r.inboxScope})`, 'INFO');
          });

          return {
            passed: true,
            toolsUsed: ['searchConversations (multiple calls)'],
            statusBreakdown: allResults
          };
        }
      },
      {
        name: '🔍 Scenario 10: "Default inbox behavior test"',
        description: 'Verify default inbox is applied when configured',
        workflow: async () => {
          const envVars = loadEnvFile();
          const hasDefaultInbox = !!envVars.HELPSCOUT_DEFAULT_INBOX_ID;

          // Search without specifying inbox
          const searchResp = await this.sendMessage({
            method: 'tools/call',
            params: {
              name: 'searchConversations',
              arguments: {
                status: 'active',
                limit: 5
              }
            }
          });

          const results = JSON.parse(searchResp.result.content[0].text);

          if (hasDefaultInbox) {
            const expectedScope = `Default inbox: ${envVars.HELPSCOUT_DEFAULT_INBOX_ID}`;
            const actualScope = results.searchInfo.inboxScope;

            this.log(`  Expected: ${expectedScope}`, 'INFO');
            this.log(`  Actual: ${actualScope}`, 'INFO');

            return {
              passed: actualScope === expectedScope,
              toolsUsed: ['searchConversations'],
              defaultInboxApplied: actualScope.includes('Default inbox')
            };
          } else {
            this.log(`  No default inbox configured - searching ALL inboxes`, 'INFO');
            this.log(`  Inbox scope: ${results.searchInfo.inboxScope}`, 'INFO');

            return {
              passed: results.searchInfo.inboxScope === 'ALL inboxes',
              toolsUsed: ['searchConversations'],
              defaultInboxApplied: false
            };
          }
        }
      }
    ];

    const results = [];

    for (const scenario of scenarios) {
      try {
        this.log(`\n${scenario.name}`, 'SCENARIO');
        this.log(`Description: ${scenario.description}`, 'INFO');

        const result = await scenario.workflow();

        if (result.skipped) {
          this.log(`SKIPPED: ${scenario.name}`, 'INFO');
          results.push({ ...scenario, ...result, passed: true });
        } else {
          this.log(`✅ PASSED: Used ${result.toolsUsed.join(', ')}`, 'SUCCESS');
          results.push({ ...scenario, ...result });
        }
      } catch (error) {
        this.log(`❌ FAILED: ${error.message}`, 'ERROR');
        results.push({ ...scenario, passed: false, error: error.message });
      }
    }

    return results;
  }

  printResults(results) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 Forensic Test Results Summary');
    console.log('='.repeat(80));

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    results.forEach((result, idx) => {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`\n${idx + 1}. ${status} - ${result.name}`);
      if (result.toolsUsed) {
        console.log(`   Tools: ${result.toolsUsed.join(', ')}`);
      }
      if (result.conversationCount !== undefined) {
        console.log(`   Results: ${result.conversationCount} conversations`);
      }
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    });

    console.log('\n' + '='.repeat(80));
    console.log(`Total: ${passed} passed, ${failed} failed out of ${results.length} scenarios`);
    console.log('='.repeat(80));

    // Tool coverage analysis
    const toolsUsed = new Set();
    results.forEach(r => {
      if (r.toolsUsed) {
        r.toolsUsed.forEach(t => toolsUsed.add(t.split(' ')[0]));
      }
    });

    console.log('\n📊 Tool Coverage:');
    console.log(`Tested: ${Array.from(toolsUsed).join(', ')}`);
    console.log('\nAvailable tools:');
    console.log('  - searchInboxes');
    console.log('  - searchConversations');
    console.log('  - getConversationSummary');
    console.log('  - getThreads');
    console.log('  - getServerTime');
    console.log('  - listAllInboxes');
    console.log('  - advancedConversationSearch');
    console.log('  - comprehensiveConversationSearch');

    return failed === 0;
  }
}

async function main() {
  const tester = new ForensicTester();

  console.log('🔬 Help Scout MCP Forensic Use Case Tests');
  console.log('Testing real-world scenarios users would ask');
  console.log('='.repeat(80));

  try {
    const env = loadEnvFile();

    if (!env.HELPSCOUT_CLIENT_ID || !env.HELPSCOUT_CLIENT_SECRET) {
      console.error('❌ Missing credentials in .env file');
      process.exit(1);
    }

    console.log(`ℹ️  OAuth2 Client ID: ${env.HELPSCOUT_CLIENT_ID.substring(0, 10)}...`);
    if (env.HELPSCOUT_DEFAULT_INBOX_ID) {
      console.log(`ℹ️  Default inbox configured: ${env.HELPSCOUT_DEFAULT_INBOX_ID}`);
    } else {
      console.log('ℹ️  No default inbox (will test ALL inboxes behavior)');
    }

    // Start server
    await tester.startServer(env);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Initialize MCP connection
    await tester.initialize();

    // Run forensic scenarios
    const results = await tester.runForensicScenarios();

    // Print results
    const allPassed = tester.printResults(results);

    // Cleanup
    await tester.cleanup();

    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
    await tester.cleanup();
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
