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
  };
  cache: {
    ttlSeconds: number;
    maxSize: number;
  };
  logging: {
    level: string;
  };
  security: {
    allowPii: boolean;
  };
  connectionPool: {
    maxSockets: number;
    maxFreeSockets: number;
    timeout: number;
    keepAlive: boolean;
    keepAliveMsecs: number;
  };
}

export const config: Config = {
  helpscout: {
    // OAuth2 authentication (Client Credentials flow)
    apiKey: process.env.HELPSCOUT_API_KEY || '', // Deprecated, kept for backwards compatibility
    clientId: process.env.HELPSCOUT_CLIENT_ID || process.env.HELPSCOUT_API_KEY || '',
    clientSecret: process.env.HELPSCOUT_CLIENT_SECRET || process.env.HELPSCOUT_APP_SECRET || '',
    baseUrl: process.env.HELPSCOUT_BASE_URL || 'https://api.helpscout.net/v2/',
    defaultInboxId: process.env.HELPSCOUT_DEFAULT_INBOX_ID,
  },
  cache: {
    ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '300', 10),
    maxSize: parseInt(process.env.MAX_CACHE_SIZE || '10000', 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  security: {
    allowPii: process.env.ALLOW_PII === 'true',
  },
  connectionPool: {
    maxSockets: parseInt(process.env.HTTP_MAX_SOCKETS || '50', 10),
    maxFreeSockets: parseInt(process.env.HTTP_MAX_FREE_SOCKETS || '10', 10),
    timeout: parseInt(process.env.HTTP_SOCKET_TIMEOUT || '30000', 10),
    keepAlive: process.env.HTTP_KEEP_ALIVE !== 'false', // Default to true
    keepAliveMsecs: parseInt(process.env.HTTP_KEEP_ALIVE_MSECS || '1000', 10),
  },
};

export function validateConfig(): void {
  const hasOAuth2 = (config.helpscout.clientId && config.helpscout.clientSecret);

  if (!hasOAuth2) {
    throw new Error(
      'OAuth2 authentication required. Help Scout API only supports OAuth2 Client Credentials flow.\n' +
      'Please provide:\n' +
      '  - HELPSCOUT_CLIENT_ID: Your OAuth2 Client ID\n' +
      '  - HELPSCOUT_CLIENT_SECRET: Your OAuth2 Client Secret\n\n' +
      'Get these from: Help Scout → My Apps → Create Private App\n\n' +
      'Optional configuration:\n' +
      '  - HELPSCOUT_DEFAULT_INBOX_ID: Default inbox for scoped searches (improves LLM context)'
    );
  }
}