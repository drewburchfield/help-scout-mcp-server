import { config } from './config.js';

export interface LogContext {
  requestId?: string;
  duration?: number;
  [key: string]: unknown;
}

export class Logger {
  private level: string;

  constructor() {
    this.level = config.logging.level;
  }

  private shouldLog(level: string): boolean {
    const levels = ['error', 'warn', 'info', 'debug'];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex <= currentLevelIndex;
  }

  private log(level: string, message: string, context: LogContext = {}): void {
    if (!this.shouldLog(level)) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };

    // Write logs to stderr to avoid interfering with MCP protocol on stdout
    console.error(JSON.stringify(logEntry));
  }

  error(message: string, context: LogContext = {}): void {
    this.log('error', message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.log('warn', message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.log('info', message, context);
  }

  debug(message: string, context: LogContext = {}): void {
    this.log('debug', message, context);
  }
}

export const logger = new Logger();