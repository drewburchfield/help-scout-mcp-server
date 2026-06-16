import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

describe('package scripts', () => {
  it('exposes a dogfood account audit command', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    expect(packageJson.scripts['dogfood:audit']).toBe('TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm tests/audit-dogfood-account.ts');
    expect(fs.existsSync(path.join(process.cwd(), 'tests/audit-dogfood-account.ts'))).toBe(true);
  });

  it('exposes optional Docs dogfood seeding that skips without a Docs key', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    expect(packageJson.scripts['dogfood:seed']).toContain('npm run dogfood:seed:docs');
    expect(packageJson.scripts['dogfood:seed:docs']).toBe('TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm tests/seed-docs-data.ts');
    expect(fs.existsSync(path.join(process.cwd(), 'tests/seed-docs-data.ts'))).toBe(true);

    const result = spawnSync('node', ['--loader', 'ts-node/esm', 'tests/seed-docs-data.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HELPSCOUT_DOCS_API_KEY: '',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('skipping optional Docs fixture seed');
  });

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

  it('fails version audit when any version source cannot be parsed', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'helpscout-version-audit-'));
    await fs.promises.mkdir(path.join(tempRoot, 'src', '__tests__'), { recursive: true });

    await fs.promises.writeFile(path.join(tempRoot, 'package.json'), '{}');
    await fs.promises.writeFile(path.join(tempRoot, 'src', 'index.ts'), 'export const metadata = {};');
    await fs.promises.writeFile(path.join(tempRoot, 'Dockerfile'), 'FROM node:20-alpine\n');
    await fs.promises.writeFile(path.join(tempRoot, 'src', '__tests__', 'index.test.ts'), 'describe("version", () => {});\n');

    try {
      const result = spawnSync('bash', [path.join(process.cwd(), 'scripts/version-audit.sh')], {
        cwd: tempRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Could not parse version from package.json');
      expect(result.stdout).toContain('Fix version extraction before comparing versions');
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
