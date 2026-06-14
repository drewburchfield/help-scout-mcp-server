#!/usr/bin/env node
import path from 'path';
import { main } from './index.js';
import { logger } from './utils/logger.js';

export async function runCli(start = main): Promise<void> {
  try {
    await start();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start application', { error: errorMessage });
    console.error('Application startup failed:', errorMessage);
    process.exit(1);
  }
}

export function isDirectCliInvocation(
  invokedPath = process.argv[1] || ''
): boolean {
  const normalizedInvokedPath = invokedPath.replace(/\\/g, '/');
  const invokedName = path.basename(normalizedInvokedPath);

  if (['help-scout-mcp-server', 'help-scout-mcp-server.cmd', 'help-scout-mcp-server.ps1'].includes(invokedName)) {
    return true;
  }

  return normalizedInvokedPath.endsWith('/dist/cli.js') || normalizedInvokedPath.endsWith('/src/cli.ts');
}

if (isDirectCliInvocation()) {
  void runCli();
}
