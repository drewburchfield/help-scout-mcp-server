#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IMAGE_NAME = 'help-scout-mcp-server:live-test';
const COMMAND_TIMEOUT_MS = 180_000;
const MCP_RESPONSE_TIMEOUT_MS = 30_000;

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return process.env;
  }

  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }

  return env;
}

class DockerLiveTester {
  constructor() {
    this.results = [];
    this.container = null;
    this.stdoutBuffer = '';
    this.pendingResponses = new Map();
  }

  log(message) {
    console.log(message);
  }

  async runCommand(command, args = [], options = {}) {
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
      }, timeoutMs);

      proc.stdout?.on('data', data => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', data => {
        stderr += data.toString();
      });

      proc.on('close', code => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });

      proc.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  record(name, ok, details = '') {
    this.results.push({ name, ok, details });
    this.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details ? `: ${details}` : ''}`);
  }

  async buildImage() {
    const result = await this.runCommand('docker', ['build', '-t', IMAGE_NAME, '.']);
    if (result.code !== 0) {
      throw new Error(`Docker build failed:\n${result.stderr}`);
    }

    this.record('docker build', true);
  }

  startContainer(envFromFile) {
    const appId = envFromFile.HELPSCOUT_APP_ID || envFromFile.HELPSCOUT_CLIENT_ID || envFromFile.HELPSCOUT_API_KEY;
    const appSecret = envFromFile.HELPSCOUT_APP_SECRET || envFromFile.HELPSCOUT_CLIENT_SECRET;

    if (!appId || !appSecret) {
      throw new Error('Missing HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET in .env.');
    }

    const envArgs = [
      ['HELPSCOUT_APP_ID', appId],
      ['HELPSCOUT_APP_SECRET', appSecret],
      ['HELPSCOUT_BASE_URL', envFromFile.HELPSCOUT_BASE_URL || 'https://api.helpscout.net/v2/'],
      ['HELPSCOUT_DEFAULT_INBOX_ID', envFromFile.HELPSCOUT_DEFAULT_INBOX_ID || ''],
      ['REDACT_MESSAGE_CONTENT', envFromFile.REDACT_MESSAGE_CONTENT || 'false'],
      ['LOG_LEVEL', envFromFile.LOG_LEVEL || 'info'],
    ].flatMap(([key, value]) => ['-e', `${key}=${value}`]);

    this.container = spawn('docker', ['run', '--rm', '-i', ...envArgs, IMAGE_NAME], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.container.stdout.on('data', data => this.handleStdout(data));
  }

  async waitForStartup() {
    await new Promise((resolve, reject) => {
      let stderr = '';
      const timeout = setTimeout(() => {
        reject(new Error(`Container startup timed out:\n${stderr}`));
      }, 60_000);

      this.container.stderr.on('data', data => {
        stderr += data.toString();
        if (stderr.includes('Help Scout MCP Server started and listening on stdio')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.container.on('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`Container exited before startup with code ${code}:\n${stderr}`));
      });

      this.container.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    this.record('container startup', true);
  }

  handleStdout(data) {
    this.stdoutBuffer += data.toString();

    let newlineIndex;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (message.id !== undefined && this.pendingResponses.has(message.id)) {
        const pending = this.pendingResponses.get(message.id);
        this.pendingResponses.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  send(message) {
    this.container.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(message) {
    this.send(message);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(message.id);
        reject(new Error(`Timed out waiting for MCP response id ${message.id}`));
      }, MCP_RESPONSE_TIMEOUT_MS);

      this.pendingResponses.set(message.id, {
        resolve: response => {
          clearTimeout(timeout);
          resolve(response);
        },
      });
    });
  }

  assertNoError(response, name) {
    if (response.error) {
      throw new Error(`${name} returned MCP error: ${JSON.stringify(response.error)}`);
    }
  }

  async testMcpProtocol() {
    const init = await this.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'docker-live-test', version: '1.0.0' },
      },
    });
    this.assertNoError(init, 'initialize');
    this.record('mcp initialize', true);

    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const tools = await this.request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    this.assertNoError(tools, 'tools/list');
    const toolNames = tools.result.tools.map(tool => tool.name);
    for (const required of ['getServerTime', 'listAllInboxes', 'searchInboxes', 'listTags', 'listUsers', 'listInboxFolders', 'listCustomerProperties', 'listOrganizationProperties']) {
      if (!toolNames.includes(required)) {
        throw new Error(`Missing expected tool ${required}`);
      }
    }
    this.record('mcp tools/list', true, `${toolNames.length} tools`);

    const serverTime = await this.request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'getServerTime',
        arguments: {},
      },
    });
    this.assertNoError(serverTime, 'getServerTime');
    this.record('mcp getServerTime', true);

    const inboxes = await this.request({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'searchInboxes',
        arguments: { query: '' },
      },
    });
    this.assertNoError(inboxes, 'searchInboxes');
    this.record('mcp searchInboxes', true);
  }

  async cleanup() {
    if (this.container && !this.container.killed) {
      this.container.kill('SIGTERM');
    }

    await this.runCommand('docker', ['rmi', IMAGE_NAME], { timeoutMs: 30_000 }).catch(() => undefined);
  }

  async run() {
    const envFromFile = loadEnvFile();

    try {
      await this.buildImage();
      this.startContainer(envFromFile);
      await this.waitForStartup();
      await this.testMcpProtocol();
    } finally {
      await this.cleanup();
    }

    const failed = this.results.filter(result => !result.ok);
    if (failed.length > 0) {
      process.exit(1);
    }
  }
}

if (require.main === module) {
  new DockerLiveTester().run().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = DockerLiveTester;
module.exports.loadEnvFile = loadEnvFile;
