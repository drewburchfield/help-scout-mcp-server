import fs from 'fs';
import path from 'path';
import { isDirectCliInvocation, runCli } from '../cli.js';
import { logger } from '../utils/logger.js';

jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('CLI entrypoint', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should log startup failures and exit non-zero', async () => {
    const start = jest.fn().mockRejectedValue(new Error('startup boom'));

    await expect(runCli(start)).rejects.toThrow('process.exit called');

    expect(start).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Failed to start application', {
      error: 'startup boom',
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Application startup failed:', 'startup boom');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should resolve without exiting when startup succeeds', async () => {
    const start = jest.fn().mockResolvedValue(undefined);

    await expect(runCli(start)).resolves.toBeUndefined();

    expect(start).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should keep the package bin pointed at the built CLI entrypoint', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    );

    expect(packageJson.bin['help-scout-mcp-server']).toBe('dist/cli.js');
    expect(packageJson.scripts.prepare).toBe('node scripts/prepare.cjs');
  });

  it('should detect installed package bin shims as direct CLI invocation', () => {
    expect(isDirectCliInvocation('/usr/local/bin/help-scout-mcp-server')).toBe(true);
    expect(isDirectCliInvocation('C:\\Users\\dev\\AppData\\help-scout-mcp-server.cmd')).toBe(true);
  });

  it('should detect direct execution by real entrypoint path', () => {
    const cliPath = path.join(process.cwd(), 'src/cli.ts');

    expect(isDirectCliInvocation(cliPath)).toBe(true);
    expect(isDirectCliInvocation('/tmp/not-this-command')).toBe(false);
  });
});
