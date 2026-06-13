#!/usr/bin/env node
import { main } from './index.js';
import { logger } from './utils/logger.js';

main().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error('Failed to start application', { error: errorMessage });
  console.error('Application startup failed:', errorMessage);
  process.exit(1);
});
