#!/usr/bin/env node

/**
 * MCP Client Integration Test
 * Tests the MCP server by running it as a subprocess and interacting via stdio
 * This tests the actual built server with real credentials from .env
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env file
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found. Please create one from .env.example');
    console.error('   Copy .env.example to .env and add your Help Scout credentials');
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

// Test configuration
const TEST_TIMEOUT = 30000; // 30 seconds
const SERVER_PATH = path.join(__dirname, 'dist/index.js');

class MCPClientTester {
  constructor() {
    this.serverProcess = null;
    this.testResults = [];
    this.messageId = 1;
    this.responseBuffer = '';
  }

  log(message, type = 'INFO') {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const emoji = type === 'ERROR' ? '❌' : type === 'SUCCESS' ? '✅' : type === 'TEST' ? '🧪' : 'ℹ️';
    console.error(`[${timestamp}] ${emoji} ${message}`);
  }

  async startServer(env) {
    return new Promise((resolve, reject) => {
      this.log('Starting MCP server...', 'INFO');

      // Check if server file exists
      if (!fs.existsSync(SERVER_PATH)) {
        reject(new Error('Server not built. Run: npm run build'));
        return;
      }

      this.serverProcess = spawn('node', [SERVER_PATH], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let startupBuffer = '';
      let serverReady = false;

      // Listen for startup messages on stderr (server logs)
      this.serverProcess.stderr.on('data', (data) => {
        const message = data.toString();
        startupBuffer += message;

        if (message.includes('Help Scout MCP Server started')) {
          serverReady = true;
          this.log('Server started successfully', 'SUCCESS');
          resolve();
        }

        if (message.includes('startup failed') || message.includes('Failed to start')) {
          reject(new Error(`Server startup failed: ${message}`));
        }
      });

      // Listen for responses on stdout (MCP protocol)
      this.serverProcess.stdout.on('data', (data) => {
        this.responseBuffer += data.toString();
      });

      this.serverProcess.on('error', (error) => {
        reject(error);
      });

      // Timeout if server doesn't start
      setTimeout(() => {
        if (!serverReady) {
          reject(new Error('Server startup timeout. Startup output: ' + startupBuffer));
        }
      }, 10000);
    });
  }

  async sendMessage(message) {
    return new Promise((resolve, reject) => {
      const request = { ...message, id: this.messageId++ };
      const requestStr = JSON.stringify(request) + '\n';

      this.log(`Sending: ${message.method}`, 'TEST');

      // Clear response buffer
      this.responseBuffer = '';

      // Send the request
      this.serverProcess.stdin.write(requestStr);

      // Wait for response (looking for complete JSON-RPC response)
      const responseTimeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for response to: ${message.method}`));
      }, 5000);

      const checkResponse = () => {
        try {
          // Try to parse accumulated buffer as JSON-RPC response
          const lines = this.responseBuffer.split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const response = JSON.parse(line);
              if (response.id === request.id) {
                clearTimeout(responseTimeout);
                this.log(`Received response for: ${message.method}`, 'SUCCESS');
                resolve(response);
                return;
              }
            } catch (e) {
              // Not valid JSON, keep waiting
            }
          }

          // If we haven't found the response yet, wait a bit and check again
          setTimeout(checkResponse, 100);
        } catch (error) {
          clearTimeout(responseTimeout);
          reject(error);
        }
      };

      checkResponse();
    });
  }

  async runTests() {
    const tests = [
      {
        name: 'Initialize MCP connection',
        message: {
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' }
          }
        },
        validate: (response) => {
          if (response.error) throw new Error(response.error.message);
          if (!response.result) throw new Error('No result in initialize response');
          if (!response.result.serverInfo) throw new Error('No serverInfo in response');
          return true;
        }
      },
      {
        name: 'List available tools',
        message: {
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {}
        },
        validate: (response) => {
          if (response.error) throw new Error(response.error.message);
          if (!response.result.tools) throw new Error('No tools in response');
          const toolNames = response.result.tools.map(t => t.name);
          this.log(`  Found ${toolNames.length} tools: ${toolNames.join(', ')}`, 'INFO');
          return toolNames.length >= 5;
        }
      },
      {
        name: 'List all inboxes',
        message: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'listAllInboxes',
            arguments: { limit: 10 }
          }
        },
        validate: (response) => {
          if (response.error) throw new Error(response.error.message);
          if (!response.result.content) throw new Error('No content in response');
          const content = JSON.parse(response.result.content[0].text);
          this.log(`  Found ${content.inboxes?.length || 0} inboxes`, 'INFO');
          return content.inboxes !== undefined;
        }
      },
      {
        name: 'Search conversations (with default inbox if configured)',
        message: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'comprehensiveConversationSearch',
            arguments: {
              searchTerms: ['test'],
              timeframeDays: 30,
              limitPerStatus: 5
            }
          }
        },
        validate: (response) => {
          if (response.error) throw new Error(response.error.message);
          if (!response.result.content) throw new Error('No content in response');
          const content = JSON.parse(response.result.content[0].text);
          this.log(`  Inbox scope: ${content.inboxScope}`, 'INFO');
          this.log(`  Found ${content.totalConversationsFound} conversations`, 'INFO');
          return content.inboxScope !== undefined;
        }
      },
      {
        name: 'Get server time',
        message: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'getServerTime',
            arguments: {}
          }
        },
        validate: (response) => {
          if (response.error) throw new Error(response.error.message);
          if (!response.result.content) throw new Error('No content in response');
          const content = JSON.parse(response.result.content[0].text);
          this.log(`  Server time: ${content.isoTime}`, 'INFO');
          return content.isoTime !== undefined;
        }
      },
      {
        name: 'List resources',
        message: {
          jsonrpc: '2.0',
          method: 'resources/list',
          params: {}
        },
        validate: (response) => {
          if (response.error) throw new Error(response.error.message);
          if (!response.result.resources) throw new Error('No resources in response');
          this.log(`  Found ${response.result.resources.length} resources`, 'INFO');
          return response.result.resources.length >= 4;
        }
      },
      {
        name: 'List prompts',
        message: {
          jsonrpc: '2.0',
          method: 'prompts/list',
          params: {}
        },
        validate: (response) => {
          if (response.error) throw new Error(response.error.message);
          if (!response.result.prompts) throw new Error('No prompts in response');
          this.log(`  Found ${response.result.prompts.length} prompts`, 'INFO');
          return response.result.prompts.length >= 3;
        }
      }
    ];

    for (const test of tests) {
      try {
        this.log(`Running: ${test.name}`, 'TEST');
        const response = await this.sendMessage(test.message);
        const passed = test.validate(response);
        this.testResults.push({ name: test.name, passed, error: null });
        this.log(`PASSED: ${test.name}`, 'SUCCESS');
      } catch (error) {
        this.testResults.push({ name: test.name, passed: false, error: error.message });
        this.log(`FAILED: ${test.name} - ${error.message}`, 'ERROR');
      }
    }
  }

  async cleanup() {
    if (this.serverProcess) {
      this.log('Stopping server...', 'INFO');
      this.serverProcess.kill('SIGTERM');

      // Wait for graceful shutdown
      await new Promise(resolve => {
        this.serverProcess.on('exit', resolve);
        setTimeout(resolve, 2000); // Force after 2s
      });
    }
  }

  printResults() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 Test Results Summary');
    console.log('='.repeat(60));

    const passed = this.testResults.filter(r => r.passed).length;
    const failed = this.testResults.filter(r => !r.passed).length;

    this.testResults.forEach(result => {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} - ${result.name}`);
      if (result.error) {
        console.log(`       Error: ${result.error}`);
      }
    });

    console.log('='.repeat(60));
    console.log(`Total: ${passed} passed, ${failed} failed out of ${this.testResults.length} tests`);
    console.log('='.repeat(60));

    return failed === 0;
  }
}

async function main() {
  const tester = new MCPClientTester();

  console.log('🧪 Help Scout MCP Client Integration Test');
  console.log('='.repeat(60));

  try {
    // Load environment
    const env = loadEnvFile();

    // Validate credentials are present
    if (!env.HELPSCOUT_CLIENT_ID || !env.HELPSCOUT_CLIENT_SECRET) {
      console.error('❌ Missing credentials in .env file');
      console.error('   Please set HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET');
      process.exit(1);
    }

    if (env.HELPSCOUT_DEFAULT_INBOX_ID) {
      console.log(`ℹ️  Default inbox configured: ${env.HELPSCOUT_DEFAULT_INBOX_ID}`);
    } else {
      console.log('ℹ️  No default inbox configured (will search all inboxes)');
    }

    // Start server
    await tester.startServer(env);

    // Wait a bit for full initialization
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Run all tests
    await tester.runTests();

    // Print results
    const allPassed = tester.printResults();

    // Cleanup
    await tester.cleanup();

    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
    await tester.cleanup();
    process.exit(1);
  }
}

// Handle cleanup on interruption
process.on('SIGINT', async () => {
  console.log('\n⚠️  Interrupted, cleaning up...');
  process.exit(1);
});

main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
