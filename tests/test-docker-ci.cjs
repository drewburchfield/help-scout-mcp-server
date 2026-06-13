#!/usr/bin/env node

const { spawn } = require('node:child_process');

const IMAGE_NAME = 'help-scout-mcp-server:ci-test';
const COMMAND_TIMEOUT_MS = 180_000;

class DockerCiTester {
  constructor() {
    this.results = [];
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

  async checkDockerAvailable() {
    const result = await this.runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 15_000,
    });

    if (result.code !== 0) {
      throw new Error(`Docker is not available: ${result.stderr || result.stdout}`);
    }

    this.record('docker available', true, result.stdout.trim());
  }

  async buildImage() {
    const result = await this.runCommand('docker', ['build', '-t', IMAGE_NAME, '.']);
    if (result.code !== 0) {
      throw new Error(`Docker build failed:\n${result.stderr}`);
    }

    this.record('docker build', true);
  }

  async validateImageStructure() {
    const result = await this.runCommand('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE_NAME,
      '-c',
      'test -f /app/package.json && test -f /app/mcp.json && test -f /app/dist/cli.js && test -f /app/dist/index.js',
    ]);

    if (result.code !== 0) {
      throw new Error(`Docker image is missing required runtime files:\n${result.stderr}`);
    }

    this.record('runtime files present', true);
  }

  async validateEntrypointSyntax() {
    const result = await this.runCommand('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      IMAGE_NAME,
      '--check',
      '/app/dist/cli.js',
    ]);

    if (result.code !== 0) {
      throw new Error(`Docker entrypoint syntax check failed:\n${result.stderr}`);
    }

    this.record('entrypoint syntax', true);
  }

  async validateMissingCredentialFailure() {
    const result = await this.runCommand('docker', ['run', '--rm', IMAGE_NAME], {
      timeoutMs: 30_000,
    });

    const output = `${result.stdout}\n${result.stderr}`;
    const hasExpectedFailure =
      result.code !== 0 &&
      output.includes('OAuth2 authentication required') &&
      output.includes('HELPSCOUT_APP_ID') &&
      output.includes('HELPSCOUT_APP_SECRET');

    if (!hasExpectedFailure) {
      throw new Error(`Unexpected startup behavior without credentials:\n${output}`);
    }

    this.record('missing credentials fail clearly', true);
  }

  async validateNonRootUser() {
    const result = await this.runCommand('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'id',
      IMAGE_NAME,
      '-u',
    ]);

    if (result.code !== 0 || result.stdout.trim() !== '1001') {
      throw new Error(`Expected container to run as uid 1001, got:\n${result.stdout}${result.stderr}`);
    }

    this.record('non-root runtime user', true, 'uid 1001');
  }

  async cleanup() {
    await this.runCommand('docker', ['rmi', IMAGE_NAME], { timeoutMs: 30_000 }).catch(() => undefined);
  }

  async run() {
    try {
      await this.checkDockerAvailable();
      await this.buildImage();
      await this.validateImageStructure();
      await this.validateEntrypointSyntax();
      await this.validateMissingCredentialFailure();
      await this.validateNonRootUser();
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
  new DockerCiTester().run().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = DockerCiTester;
