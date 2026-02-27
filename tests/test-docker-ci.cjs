#!/usr/bin/env node

/**
 * CI-Safe Docker Test
 * Tests Docker build and basic container functionality without requiring authentication
 */

const { spawn } = require('child_process');

// Test configuration
const IMAGE_NAME = 'help-scout-mcp-server:ci-test';
const TEST_TIMEOUT = 30000; // 30 seconds

class CIDockerTester {
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

  async testDockerImageStructure() {
    this.log('Testing Docker image structure...');
    
    try {
      // Test that image was created
      const inspectResult = await this.runCommand('docker', ['inspect', IMAGE_NAME]);
      if (inspectResult.code !== 0) {
        throw new Error('Docker image not found');
      }

      // Test that required files exist in image
      const result = await this.runCommand('docker', [
        'run', '--rm', '--entrypoint', 'ls', IMAGE_NAME, '-la', '/app'
      ]);
      
      if (result.code !== 0) {
        throw new Error(`Failed to list app directory: ${result.stderr}`);
      }

      const output = result.stdout;
      const requiredFiles = ['dist', 'package.json', 'mcp.json'];
      
      for (const file of requiredFiles) {
        if (!output.includes(file)) {
          throw new Error(`Required file missing: ${file}`);
        }
      }
      
      this.log('✅ Docker image structure validation passed');
      this.testResults.push({ test: 'docker-structure', status: 'PASS' });
      return true;
    } catch (error) {
      this.log(`❌ Docker image structure test failed: ${error.message}`, 'ERROR');
      this.testResults.push({ test: 'docker-structure', status: 'FAIL', error: error.message });
      return false;
    }
  }

  async testDockerStartup() {
    this.log('Testing Docker container startup (without auth)...');
    
    try {
      // Test container starts and shows expected error for missing credentials
      const result = await this.runCommand('docker', [
        'run', '--rm', IMAGE_NAME
      ], { timeout: 5000 });
      
      // We expect this to fail due to missing credentials
      // But it should fail with the right error message
      const stderr = result.stderr;
      
      if (!stderr.includes('HELPSCOUT_API_KEY environment variable is required')) {
        throw new Error(`Unexpected error message: ${stderr}`);
      }
      
      this.log('✅ Docker startup validation passed (correct error handling)');
      this.testResults.push({ test: 'docker-startup', status: 'PASS' });
      return true;
    } catch (error) {
      this.log(`❌ Docker startup test failed: ${error.message}`, 'ERROR');
      this.testResults.push({ test: 'docker-startup', status: 'FAIL', error: error.message });
      return false;
    }
  }

  async testDockerEntrypoint() {
    this.log('Testing Docker entrypoint executable...');
    
    try {
      // Test that the main entry file exists and is executable
      const result = await this.runCommand('docker', [
        'run', '--rm', '--entrypoint', 'ls', IMAGE_NAME, '-la', '/app/dist/index.js'
      ]);
      
      if (result.code !== 0) {
        throw new Error('Main entry file not found or not accessible');
      }

      // Test Node.js can load the file (syntax check)
      const nodeResult = await this.runCommand('docker', [
        'run', '--rm', '--entrypoint', 'node', IMAGE_NAME, '-e', 
        'try { require("/app/dist/index.js"); console.log("OK"); } catch(e) { console.error(e.message); process.exit(1); }'
      ]);
      
      if (nodeResult.code !== 0) {
        throw new Error(`Entry file has syntax errors: ${nodeResult.stderr}`);
      }
      
      this.log('✅ Docker entrypoint validation passed');
      this.testResults.push({ test: 'docker-entrypoint', status: 'PASS' });
      return true;
    } catch (error) {
      this.log(`❌ Docker entrypoint test failed: ${error.message}`, 'ERROR');
      this.testResults.push({ test: 'docker-entrypoint', status: 'FAIL', error: error.message });
      return false;
    }
  }

  async cleanup() {
    this.log('Cleaning up test image...');
    try {
      await this.runCommand('docker', ['rmi', IMAGE_NAME]);
    } catch (error) {
      // Ignore cleanup errors
      this.log(`Cleanup warning: ${error.message}`, 'WARN');
    }
  }

  async runFullTest() {
    this.log('🚀 Starting CI-safe Docker test suite...');
    
    try {
      // Test 1: Build Docker image
      const buildSuccess = await this.testDockerBuild();
      if (!buildSuccess) {
        throw new Error('Docker build failed, aborting tests');
      }
      
      // Test 2: Validate image structure
      await this.testDockerImageStructure();
      
      // Test 3: Test container startup behavior
      await this.testDockerStartup();
      
      // Test 4: Test entrypoint
      await this.testDockerEntrypoint();
      
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
  const tester = new CIDockerTester();
  tester.runFullTest().catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
}

module.exports = CIDockerTester;