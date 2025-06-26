#!/usr/bin/env node

/**
 * Docker Integration Test
 * Tests Docker build, run, and MCP functionality end-to-end
 */

const { spawn } = require('child_process');
const fs = require('fs');

// Test configuration
const IMAGE_NAME = 'help-scout-mcp-server:test';
const TEST_TIMEOUT = 30000; // 30 seconds

// Environment variables for the container
const ENV_VARS = [
  'HELPSCOUT_API_KEY=your-helpscout-api-key-here',
  'HELPSCOUT_APP_SECRET=your-helpscout-app-secret-here',
  'HELPSCOUT_BASE_URL=https://api.helpscout.net/v2/',
  'LOG_LEVEL=info'
];

// MCP test messages
const MCP_MESSAGES = [
  // Initialize MCP connection
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" }
    }
  },
  // List available resources
  {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/list"
  },
  // Test search tool
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "searchInboxes",
      arguments: { query: "support" }
    }
  }
];

class DockerTester {
  constructor() {
    this.container = null;
    this.testResults = [];
  }

  log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    ;
  }

  async runCommand(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { 
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options 
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => stdout += data.toString());
      proc.stderr?.on('data', (data) => stderr += data.toString());
      
      proc.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      
      proc.on('error', reject);
      
      // Timeout protection
      setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Command timeout'));
      }, TEST_TIMEOUT);
    });
  }

  async testDockerBuild() {
    this.log('Testing Docker build...');
    
    try {
      const result = await this.runCommand('docker', ['build', '-t', IMAGE_NAME, '.']);
      
      if (result.code !== 0) {
        throw new Error(`Docker build failed: ${result.stderr}`);
      }
      
      this.log('✅ Docker build successful');
      this.testResults.push({ test: 'docker-build', status: 'PASS' });
      return true;
    } catch (error) {
      this.log(`❌ Docker build failed: ${error.message}`, 'ERROR');
      this.testResults.push({ test: 'docker-build', status: 'FAIL', error: error.message });
      return false;
    }
  }

  async startContainer() {
    this.log('Starting Docker container...');
    
    const envArgs = ENV_VARS.flatMap(env => ['-e', env]);
    const args = ['run', '--rm', '-i', ...envArgs, IMAGE_NAME];
    
    this.container = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // Wait for container to start
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        reject(new Error('Container startup timeout'));
      }, 10000);
      
      this.container.stderr.on('data', (data) => {
        output += data.toString();
        if (output.includes('Help Scout MCP Server started and listening on stdio')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      
      this.container.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    
    this.log('✅ Container started successfully');
  }

  async testMCPCommunication() {
    this.log('Testing MCP communication...');
    
    for (let i = 0; i < MCP_MESSAGES.length; i++) {
      const message = MCP_MESSAGES[i];
      const testName = `mcp-${message.method || 'message'}-${message.id}`;
      
      try {
        // Send MCP message
        const messageStr = JSON.stringify(message) + '\n';
        this.container.stdin.write(messageStr);
        
        // Wait for response
        const response = await this.waitForMCPResponse(message.id);
        
        // Validate response
        if (this.validateMCPResponse(message, response)) {
          this.log(`✅ MCP test ${testName} passed`);
          this.testResults.push({ test: testName, status: 'PASS', response });
        } else {
          throw new Error(`Invalid MCP response: ${JSON.stringify(response)}`);
        }
        
        // Small delay between messages
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        this.log(`❌ MCP test ${testName} failed: ${error.message}`, 'ERROR');
        this.testResults.push({ test: testName, status: 'FAIL', error: error.message });
      }
    }
  }

  async waitForMCPResponse(expectedId, timeout = 5000) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for MCP response with id ${expectedId}`));
      }, timeout);
      
      const onData = (data) => {
        buffer += data.toString();
        
        // Try to parse complete JSON messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              if (response.id === expectedId) {
                clearTimeout(timer);
                this.container.stdout.removeListener('data', onData);
                resolve(response);
                return;
              }
            } catch (e) {
              // Ignore JSON parse errors, might be log messages
            }
          }
        }
      };
      
      this.container.stdout.on('data', onData);
    });
  }

  validateMCPResponse(request, response) {
    // Basic MCP response validation
    if (!response || typeof response !== 'object') return false;
    if (response.id !== request.id) return false;
    if (response.jsonrpc !== '2.0') return false;
    
    // Method-specific validation
    switch (request.method) {
      case 'initialize':
        return response.result && response.result.capabilities;
      case 'resources/list':
        return response.result && Array.isArray(response.result.resources);
      case 'tools/call':
        return response.result && !response.error;
      default:
        return !response.error;
    }
  }

  async cleanup() {
    if (this.container) {
      this.log('Stopping container...');
      this.container.kill('SIGTERM');
      
      // Wait for container to stop
      await new Promise(resolve => {
        this.container.on('close', resolve);
        setTimeout(resolve, 2000); // Force resolve after 2s
      });
    }
  }

  async runFullTest() {
    this.log('🚀 Starting Docker integration test suite...');
    
    try {
      // Test 1: Build Docker image
      const buildSuccess = await this.testDockerBuild();
      if (!buildSuccess) {
        throw new Error('Docker build failed, aborting tests');
      }
      
      // Test 2: Start container and test MCP
      await this.startContainer();
      await this.testMCPCommunication();
      
    } catch (error) {
      this.log(`💥 Test suite failed: ${error.message}`, 'ERROR');
    } finally {
      await this.cleanup();
    }
    
    // Print test summary
    this.printTestSummary();
  }

  printTestSummary() {
    this.log('📊 Test Summary:');
    
    const passed = this.testResults.filter(r => r.status === 'PASS').length;
    const failed = this.testResults.filter(r => r.status === 'FAIL').length;
    
    this.log(`✅ Passed: ${passed}`);
    this.log(`❌ Failed: ${failed}`);
    
    if (failed > 0) {
      this.log('Failed tests:');
      this.testResults
        .filter(r => r.status === 'FAIL')
        .forEach(r => this.log(`  - ${r.test}: ${r.error}`));
    }
    
    const success = failed === 0;
    this.log(`🎯 Overall result: ${success ? 'SUCCESS' : 'FAILURE'}`);
    
    process.exit(success ? 0 : 1);
  }
}

// Run the test suite
if (require.main === module) {
  const tester = new DockerTester();
  tester.runFullTest().catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
}

module.exports = DockerTester;