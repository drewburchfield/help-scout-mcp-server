import dotenv from 'dotenv';

// Only load .env in non-test environments
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

export interface Config {
  helpscout: {
    apiKey: string;         // Deprecated: kept for backwards compatibility only
    clientId?: string;      // OAuth2 client ID (required)
    clientSecret?: string;  // OAuth2 client secret (required)
    baseUrl: string;
    defaultInboxId?: string; // Optional: default inbox for scoped searches
    docsApiKey?: string;    // Docs API v1 key (optional; required only for Docs tools)
    docsBaseUrl: string;    // Docs API v1 base URL
  };
  cache: {
    ttlSeconds: number;
    maxSize: number;
  };
  logging: {
    level: string;
  };
  security: {
    redactMessageContent: boolean;
  };
  connectionPool: {
    maxSockets: number;
    maxFreeSockets: number;
    timeout: number;
    keepAlive: boolean;
    keepAliveMsecs: number;
  };
}

function parseIntegerEnv(name: string, defaultValue: number, min = 0): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed >= min ? parsed : defaultValue;
}

function parseLogLevel(defaultValue = 'info'): string {
  const rawValue = process.env.LOG_LEVEL?.trim();
  const levels = ['error', 'warn', 'info', 'debug'];
  return rawValue && levels.includes(rawValue) ? rawValue : defaultValue;
}

export const config: Config = {
  helpscout: {
    // OAuth2 authentication (Client Credentials flow)
    apiKey: process.env.HELPSCOUT_API_KEY || '', // Deprecated, kept for backwards compatibility
    clientId: process.env.HELPSCOUT_APP_ID || process.env.HELPSCOUT_CLIENT_ID || process.env.HELPSCOUT_API_KEY || '',
    clientSecret: process.env.HELPSCOUT_APP_SECRET || process.env.HELPSCOUT_CLIENT_SECRET || '',
    baseUrl: process.env.HELPSCOUT_BASE_URL || 'https://api.helpscout.net/v2/',
    defaultInboxId: process.env.HELPSCOUT_DEFAULT_INBOX_ID,
    docsApiKey: process.env.HELPSCOUT_DOCS_API_KEY,
    docsBaseUrl: process.env.HELPSCOUT_DOCS_BASE_URL || 'https://docsapi.helpscout.net/v1/',
  },
  cache: {
    ttlSeconds: parseIntegerEnv('CACHE_TTL_SECONDS', 300),
    maxSize: parseIntegerEnv('MAX_CACHE_SIZE', 10000, 1),
  },
  logging: {
    level: parseLogLevel(),
  },
  security: {
    // Default: show content. Set REDACT_MESSAGE_CONTENT=true to hide message bodies.
    redactMessageContent: process.env.REDACT_MESSAGE_CONTENT === 'true',
  },
  connectionPool: {
    maxSockets: parseIntegerEnv('HTTP_MAX_SOCKETS', 50, 1),
    maxFreeSockets: parseIntegerEnv('HTTP_MAX_FREE_SOCKETS', 10),
    timeout: parseIntegerEnv('HTTP_SOCKET_TIMEOUT', 30000, 1),
    keepAlive: process.env.HTTP_KEEP_ALIVE !== 'false', // Default to true
    keepAliveMsecs: parseIntegerEnv('HTTP_KEEP_ALIVE_MSECS', 1000, 1),
  },
};

export function validateConfig(): void {
  const hasOAuth2 = Boolean(
    config.helpscout.clientId &&
    config.helpscout.clientSecret &&
    !config.helpscout.clientId.startsWith('Bearer ')
  );

  // Check if user is trying to use deprecated Personal Access Token as the only credential.
  if (process.env.HELPSCOUT_API_KEY?.startsWith('Bearer ') && !hasOAuth2) {
    throw new Error(
      'Personal Access Tokens are no longer supported.\n\n' +
      'Help Scout API now requires OAuth2 Client Credentials.\n' +
      'Please migrate your configuration:\n\n' +
      '  OLD (deprecated):\n' +
      '    HELPSCOUT_API_KEY=Bearer your-token\n\n' +
      '  NEW (required):\n' +
      '    HELPSCOUT_APP_ID=your-app-id\n' +
      '    HELPSCOUT_APP_SECRET=your-app-secret\n\n' +
      'Get OAuth2 credentials: Help Scout → My Apps → Create Private App'
    );
  }

  if (!hasOAuth2) {
    throw new Error(
      'OAuth2 authentication required. Help Scout API only supports OAuth2 Client Credentials flow.\n' +
      'Please provide:\n' +
      '  - HELPSCOUT_APP_ID: Your App ID from Help Scout\n' +
      '  - HELPSCOUT_APP_SECRET: Your App Secret from Help Scout\n\n' +
      'Get these from: Help Scout → My Apps → Create Private App\n\n' +
      'Optional configuration:\n' +
      '  - HELPSCOUT_DEFAULT_INBOX_ID: Default inbox for scoped searches (improves LLM context)'
    );
  }

  // Enforce HTTPS for API base URL to prevent credential exposure
  if (config.helpscout.baseUrl && !config.helpscout.baseUrl.startsWith('https://')) {
    throw new Error(
      'Security Error: HELPSCOUT_BASE_URL must use HTTPS to protect credentials in transit.\n' +
      `Current value: ${config.helpscout.baseUrl}\n` +
      'Please use: https://api.helpscout.net/v2/'
    );
  }
}
