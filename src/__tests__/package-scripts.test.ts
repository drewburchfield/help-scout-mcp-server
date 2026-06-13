import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

describe('package scripts', () => {
  it('keeps operational scripts aligned with documented Help Scout credential names', () => {
    const credentialScripts = [
      'scripts/check-conversations.ts',
      'scripts/debug-api.ts',
      'scripts/generate-synthetic-data.ts',
      'scripts/import-conversations.ts',
      'scripts/live-api-test.ts',
      'scripts/verify-credentials.ts',
    ];

    for (const scriptPath of credentialScripts) {
      const content = fs.readFileSync(path.join(process.cwd(), scriptPath), 'utf8');

      expect(content).toContain('HELPSCOUT_APP_ID');
      expect(content).toContain('HELPSCOUT_APP_SECRET');
      expect(content).toContain('HELPSCOUT_CLIENT_ID');
      expect(content).toContain('HELPSCOUT_CLIENT_SECRET');
    }
  });

  it('guards sync:plugin when the target checkout has local files', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'helpscout-sync-plugin-'));
    const pluginDir = path.join(tempRoot, 'helpscout-navigator');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'local-change.txt'), 'do not delete');

    try {
      const result = spawnSync('node', ['scripts/sync-plugin.cjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PLUGIN_SYNC_ROOT: tempRoot,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Refusing to replace');
      expect(fs.existsSync(path.join(pluginDir, 'local-change.txt'))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
