#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_URL = 'https://github.com/drewburchfield/helpscout-navigator.git';
const pluginParentDir = process.env.PLUGIN_SYNC_ROOT
  ? path.resolve(process.env.PLUGIN_SYNC_ROOT)
  : path.resolve(__dirname, '..', 'plugins');
const targetDir = path.join(pluginParentDir, 'helpscout-navigator');
const force = process.argv.includes('--force') || process.env.PLUGIN_SYNC_FORCE === 'true';

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
}

if (fs.existsSync(targetDir) && !force) {
  console.error(`Refusing to replace ${targetDir}; remove it first or pass --force.`);
  process.exit(1);
}

const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'helpscout-plugin-sync-'));
const tempDir = path.join(tempParent, 'helpscout-navigator');

try {
  execFileSync('git', ['clone', '--depth', '1', REPO_URL, tempDir], { stdio: 'inherit' });
  removeIfExists(path.join(tempDir, '.git'));

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  removeIfExists(targetDir);
  fs.renameSync(tempDir, targetDir);

  console.log(`Synced Help Scout navigator plugin to ${targetDir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  removeIfExists(tempParent);
}
