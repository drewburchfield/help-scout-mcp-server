#!/usr/bin/env node
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

const invokedPath = (process.argv[1] || '').replace(/\\/g, '/');

if (invokedPath.endsWith('/dist/cli.js') || invokedPath.endsWith('/src/cli.ts')) {
  void runCli();
}
