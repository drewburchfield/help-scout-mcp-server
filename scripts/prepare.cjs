#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const hasTypeScript = existsSync(join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc'));
const omitConfig = process.env.npm_config_omit || '';
const devDependenciesOmitted =
  process.env.NODE_ENV === 'production' || omitConfig.split(/[,\s]+/).includes('dev');

if (!hasTypeScript && devDependenciesOmitted) {
  console.log('prepare: skipping build because dev dependencies are omitted');
  process.exit(0);
}

if (!hasTypeScript) {
  console.error('prepare: TypeScript is required to build this package');
  process.exit(1);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'build'], { stdio: 'inherit' });

process.exit(result.status ?? 1);
