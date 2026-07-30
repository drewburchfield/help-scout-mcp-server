#!/usr/bin/env node
import fs from 'fs';
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

  // Follow symlinks (npm bin shims) before matching layouts; nonexistent
  // paths keep their literal form.
  let resolvedPath = normalizedInvokedPath;
  try {
    resolvedPath = fs.realpathSync(invokedPath).replace(/\\/g, '/');
  } catch {
    // keep the unresolved path
  }

  // The MCPB extension repacks this file to build/server/cli.js; missing that
  // layout here made the packed extension import, do nothing, and exit 0.
  return (
    resolvedPath.endsWith('/dist/cli.js') ||
    resolvedPath.endsWith('/src/cli.ts') ||
    resolvedPath.endsWith('/build/server/cli.js')
  );
}

if (isDirectCliInvocation()) {
  void runCli();
}
