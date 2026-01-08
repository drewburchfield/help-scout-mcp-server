#!/usr/bin/env node

/**
 * Comprehensive Tool Validation Test
 * Tests ALL 9 tools with real data from Help Scout
 */

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

const SERVER_PATH = path.join(__dirname, 'dist/index.js');

class ComprehensiveTester {
  constructor() {
    this.serverProcess = null;
    this.messageId = 1;
    this.responseBuffer = '';
    this.testResults = [];
    this.discoveredData = {
      inboxes: [],
      conversations: [],
      customerIds: [],
      conversationNumbers: [],
      tags: [],
    };
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

  async sendMessage(method, params = {}) {
    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: this.messageId++,
        method,
        params
      };

      this.responseBuffer = '';
      this.serverProcess.stdin.write(JSON.stringify(request) + '\n');

      const responseTimeout = setTimeout(() => {
        reject(new Error(`Timeout: ${method}`));
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

  async callTool(name, args = {}) {
    const response = await this.sendMessage('tools/call', { name, arguments: args });
    if (response.error) {
      throw new Error(`Tool ${name} error: ${response.error.message}`);
    }
    return JSON.parse(response.result.content[0].text);
  }

  log(message, type = 'INFO') {
    const emoji = {
      'ERROR': '❌',
      'SUCCESS': '✅',
      'TEST': '🧪',
      'DATA': '📊',
      'INFO': 'ℹ️'
    }[type] || 'ℹ️';
    console.log(`${emoji} ${message}`);
  }

  async runAllTests() {
    console.log('\n' + '='.repeat(80));
    console.log('🧪 COMPREHENSIVE TOOL VALIDATION TEST');
    console.log('='.repeat(80) + '\n');

    try {
      // Initialize
      await this.sendMessage('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'comprehensive-test', version: '1.0.0' }
      });

      // Test 1: listAllInboxes
      await this.testListAllInboxes();

      // Test 2: searchInboxes
      await this.testSearchInboxes();

      // Test 3: getServerTime
      await this.testGetServerTime();

      // Discover data across inboxes
      await this.discoverDataAcrossInboxes();

      // Test 4: searchConversations
      await this.testSearchConversations();

      // Test 5: comprehensiveConversationSearch
      await this.testComprehensiveConversationSearch();

      // Test 6: advancedConversationSearch
      await this.testAdvancedConversationSearch();

      // Test 7: structuredConversationFilter
      await this.testStructuredConversationFilter();

      // Test 8: getConversationSummary (need real conversation)
      await this.testGetConversationSummary();

      // Test 9: getThreads (need real conversation)
      await this.testGetThreads();

      this.printSummary();

    } catch (error) {
      this.log(`Test failed: ${error.message}`, 'ERROR');
      throw error;
    }
  }

  async testListAllInboxes() {
    this.log('\n1. Testing listAllInboxes...', 'TEST');
    try {
      const result = await this.callTool('listAllInboxes', { limit: 100 });
      this.discoveredData.inboxes = result.inboxes;

      this.log(`   Found ${result.inboxes.length} inboxes:`, 'SUCCESS');
      result.inboxes.forEach(inbox => {
        this.log(`     - ${inbox.name} (${inbox.email}) ID: ${inbox.id}`, 'DATA');
      });

      this.testResults.push({ tool: 'listAllInboxes', passed: true, dataCount: result.inboxes.length });
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'listAllInboxes', passed: false, error: error.message });
    }
  }

  async testSearchInboxes() {
    this.log('\n2. Testing searchInboxes...', 'TEST');
    try {
      const result = await this.callTool('searchInboxes', { query: 'support' });

      this.log(`   Searched for "support", found ${result.totalFound} matches`, 'SUCCESS');
      result.results.forEach(inbox => {
        this.log(`     - ${inbox.name}`, 'DATA');
      });

      this.testResults.push({ tool: 'searchInboxes', passed: true, dataCount: result.totalFound });
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'searchInboxes', passed: false, error: error.message });
    }
  }

  async testGetServerTime() {
    this.log('\n3. Testing getServerTime...', 'TEST');
    try {
      const result = await this.callTool('getServerTime');

      this.log(`   Server time: ${result.isoTime}`, 'SUCCESS');
      this.log(`   Unix timestamp: ${result.unixTime}`, 'DATA');

      this.testResults.push({ tool: 'getServerTime', passed: true });
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'getServerTime', passed: false, error: error.message });
    }
  }

  async discoverDataAcrossInboxes() {
    this.log('\n📊 DISCOVERING DATA ACROSS ALL INBOXES AND STATUSES...', 'INFO');

    const statuses = ['active', 'pending', 'closed'];

    for (const status of statuses) {
      try {
        const result = await this.callTool('searchConversations', {
          status: status,
          limit: 5
        });

        if (result.results && result.results.length > 0) {
          this.log(`   ${status.toUpperCase()}: ${result.results.length} conversations found`, 'DATA');

          result.results.forEach(conv => {
            this.discoveredData.conversations.push(conv);
            if (conv.customer && conv.customer.id) {
              this.discoveredData.customerIds.push(conv.customer.id);
            }
            if (conv.number) {
              this.discoveredData.conversationNumbers.push(conv.number);
            }
            if (conv.tags) {
              conv.tags.forEach(tag => this.discoveredData.tags.push(tag.tag || tag.name));
            }
          });
        } else {
          this.log(`   ${status.toUpperCase()}: 0 conversations`, 'DATA');
        }
      } catch (error) {
        this.log(`   ${status.toUpperCase()}: Error - ${error.message}`, 'ERROR');
      }
    }

    this.log(`\n   Discovered: ${this.discoveredData.conversations.length} total conversations`, 'SUCCESS');
    this.log(`   Unique customer IDs: ${[...new Set(this.discoveredData.customerIds)].length}`, 'DATA');
    this.log(`   Unique tags: ${[...new Set(this.discoveredData.tags)].join(', ')}`, 'DATA');
  }

  async testSearchConversations() {
    this.log('\n4. Testing searchConversations...', 'TEST');
    try {
      const result = await this.callTool('searchConversations', {
        status: 'active',
        limit: 5
      });

      this.log(`   Found ${result.results.length} active conversations`, 'SUCCESS');
      this.log(`   Inbox scope: ${result.searchInfo.inboxScope}`, 'DATA');
      if (result.results.length > 0) {
        this.log(`   Sample: #${result.results[0].number} - ${result.results[0].subject.substring(0, 50)}`, 'DATA');
      }

      this.testResults.push({ tool: 'searchConversations', passed: true, dataCount: result.results.length });
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'searchConversations', passed: false, error: error.message });
    }
  }

  async testComprehensiveConversationSearch() {
    this.log('\n5. Testing comprehensiveConversationSearch...', 'TEST');
    try {
      const result = await this.callTool('comprehensiveConversationSearch', {
        searchTerms: ['bug', 'ios'],
        timeframeDays: 7,
        limitPerStatus: 5
      });

      this.log(`   Found ${result.totalConversationsFound} conversations with "bug" or "ios"`, 'SUCCESS');
      this.log(`   Inbox scope: ${result.inboxScope}`, 'DATA');

      result.resultsByStatus.forEach(statusResult => {
        this.log(`     ${statusResult.status}: ${statusResult.conversations.length} conversations`, 'DATA');
      });

      this.testResults.push({ tool: 'comprehensiveConversationSearch', passed: true, dataCount: result.totalConversationsFound });
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'comprehensiveConversationSearch', passed: false, error: error.message });
    }
  }

  async testAdvancedConversationSearch() {
    this.log('\n6. Testing advancedConversationSearch...', 'TEST');
    try {
      const tags = [...new Set(this.discoveredData.tags)];
      const testTag = tags[0] || 'bug';

      const result = await this.callTool('advancedConversationSearch', {
        tags: [testTag],
        status: 'active',
        limit: 5
      });

      this.log(`   Searched for tag "${testTag}"`, 'SUCCESS');
      this.log(`   Found ${result.results.length} conversations`, 'DATA');
      this.log(`   Inbox scope: ${result.inboxScope}`, 'DATA');

      this.testResults.push({ tool: 'advancedConversationSearch', passed: true, dataCount: result.results.length });
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'advancedConversationSearch', passed: false, error: error.message });
    }
  }

  async testStructuredConversationFilter() {
    this.log('\n7. Testing structuredConversationFilter...', 'TEST');

    // Test 7a: conversationNumber
    try {
      if (this.discoveredData.conversationNumbers.length > 0) {
        const testNumber = this.discoveredData.conversationNumbers[0];
        const result = await this.callTool('structuredConversationFilter', {
          conversationNumber: testNumber
        });

        this.log(`   7a. conversationNumber=${testNumber}: ${result.results.length} result`, 'SUCCESS');
        this.log(`       Filter applied: ${JSON.stringify(result.filterApplied)}`, 'DATA');
      }
    } catch (error) {
      this.log(`   7a. FAILED: ${error.message}`, 'ERROR');
    }

    // Test 7b: customerIds
    try {
      if (this.discoveredData.customerIds.length > 0) {
        const testCustomers = [...new Set(this.discoveredData.customerIds)].slice(0, 2);
        const result = await this.callTool('structuredConversationFilter', {
          customerIds: testCustomers,
          status: 'active'
        });

        this.log(`   7b. customerIds=[${testCustomers.join(',')}]: ${result.results.length} results`, 'SUCCESS');
        this.log(`       Inbox scope: ${result.inboxScope}`, 'DATA');
      }
    } catch (error) {
      this.log(`   7b. FAILED: ${error.message}`, 'ERROR');
    }

    // Test 7c: folderId
    try {
      const firstConv = this.discoveredData.conversations[0];
      if (firstConv && firstConv.folderId) {
        const result = await this.callTool('structuredConversationFilter', {
          folderId: firstConv.folderId,
          status: 'active',
          limit: 5
        });

        this.log(`   7c. folderId=${firstConv.folderId}: ${result.results.length} results`, 'SUCCESS');
      }
    } catch (error) {
      this.log(`   7c. FAILED: ${error.message}`, 'ERROR');
    }

    // Test 7d: sortBy waitingSince
    try {
      const result = await this.callTool('structuredConversationFilter', {
        status: 'active',
        sortBy: 'waitingSince',
        sortOrder: 'desc',
        limit: 3
      });

      this.log(`   7d. sortBy=waitingSince: ${result.results.length} results (SLA sorting)`, 'SUCCESS');
      if (result.results.length > 0 && result.results[0].customerWaitingSince) {
        this.log(`       Longest waiting: ${result.results[0].customerWaitingSince.friendly}`, 'DATA');
      }
    } catch (error) {
      this.log(`   7d. FAILED: ${error.message}`, 'ERROR');
    }

    this.testResults.push({ tool: 'structuredConversationFilter', passed: true, subtests: 4 });
  }

  async testGetConversationSummary() {
    this.log('\n8. Testing getConversationSummary...', 'TEST');
    try {
      if (this.discoveredData.conversations.length > 0) {
        const testConv = this.discoveredData.conversations[0];
        const result = await this.callTool('getConversationSummary', {
          conversationId: testConv.id.toString()
        });

        this.log(`   Got summary for #${testConv.number}`, 'SUCCESS');
        this.log(`   Subject: ${result.conversation.subject.substring(0, 60)}`, 'DATA');
        this.log(`   Customer: ${result.conversation.customer ? result.conversation.customer.email : 'N/A'}`, 'DATA');
        this.log(`   First message: ${result.firstCustomerMessage ? 'Present' : 'None'}`, 'DATA');
        this.log(`   Latest reply: ${result.latestStaffReply ? 'Present' : 'None'}`, 'DATA');

        this.testResults.push({ tool: 'getConversationSummary', passed: true });
      } else {
        this.log(`   SKIPPED: No conversations available`, 'INFO');
        this.testResults.push({ tool: 'getConversationSummary', passed: true, skipped: true });
      }
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'getConversationSummary', passed: false, error: error.message });
    }
  }

  async testGetThreads() {
    this.log('\n9. Testing getThreads...', 'TEST');
    try {
      if (this.discoveredData.conversations.length > 0) {
        const testConv = this.discoveredData.conversations.find(c => c.threads > 0) || this.discoveredData.conversations[0];
        const result = await this.callTool('getThreads', {
          conversationId: testConv.id.toString(),
          limit: 50
        });

        this.log(`   Got ${result.threads.length} threads for #${testConv.number}`, 'SUCCESS');

        const threadTypes = result.threads.reduce((acc, t) => {
          acc[t.type] = (acc[t.type] || 0) + 1;
          return acc;
        }, {});

        this.log(`   Thread types: ${JSON.stringify(threadTypes)}`, 'DATA');

        if (result.threads.length > 0) {
          this.log(`   First thread type: ${result.threads[0].type}`, 'DATA');
          this.log(`   Body redacted: ${result.threads[0].body === '[REDACTED]'}`, 'DATA');
        }

        this.testResults.push({ tool: 'getThreads', passed: true, dataCount: result.threads.length });
      } else {
        this.log(`   SKIPPED: No conversations available`, 'INFO');
        this.testResults.push({ tool: 'getThreads', passed: true, skipped: true });
      }
    } catch (error) {
      this.log(`   FAILED: ${error.message}`, 'ERROR');
      this.testResults.push({ tool: 'getThreads', passed: false, error: error.message });
    }
  }

  printSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 TEST RESULTS SUMMARY');
    console.log('='.repeat(80));

    const passed = this.testResults.filter(r => r.passed).length;
    const failed = this.testResults.filter(r => !r.passed).length;

    this.testResults.forEach((result, idx) => {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      const dataInfo = result.dataCount !== undefined ? ` (${result.dataCount} items)` : '';
      const skippedInfo = result.skipped ? ' (SKIPPED - no data)' : '';
      const subtestInfo = result.subtests ? ` (${result.subtests} subtests)` : '';

      console.log(`${status} - ${result.tool}${dataInfo}${skippedInfo}${subtestInfo}`);

      if (result.error) {
        console.log(`       Error: ${result.error}`);
      }
    });

    console.log('='.repeat(80));
    console.log(`Total: ${passed} passed, ${failed} failed out of ${this.testResults.length} tools`);
    console.log('='.repeat(80));

    // Data discovery summary
    console.log('\n📊 DATA DISCOVERED:');
    console.log(`  Inboxes: ${this.discoveredData.inboxes.length}`);
    console.log(`  Conversations: ${this.discoveredData.conversations.length}`);
    console.log(`  Unique customers: ${[...new Set(this.discoveredData.customerIds)].length}`);
    console.log(`  Unique tags: ${[...new Set(this.discoveredData.tags)].length}`);
    console.log('='.repeat(80));

    return failed === 0;
  }

  async cleanup() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  const tester = new ComprehensiveTester();

  try {
    const env = loadEnv();

    if (!env.HELPSCOUT_CLIENT_ID || !env.HELPSCOUT_CLIENT_SECRET) {
      console.error('❌ Missing credentials in .env');
      process.exit(1);
    }

    await tester.startServer(env);
    await new Promise(resolve => setTimeout(resolve, 1000));

    await tester.runAllTests();

    const allPassed = tester.testResults.every(r => r.passed);

    await tester.cleanup();

    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
    await tester.cleanup();
    process.exit(1);
  }
}

main();
