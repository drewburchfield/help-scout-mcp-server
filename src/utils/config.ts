import dotenv from 'dotenv';

// Only load .env in non-test environments
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

export interface Config {
  helpscout: {
    apiKey: string;         // For backwards compatibility and Personal Access Tokens
    clientId?: string;      // New: explicit OAuth2 client ID
    clientSecret?: string;  // New: explicit OAuth2 client secret
    baseUrl: string;
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
    // Priority: For OAuth2, HELPSCOUT_CLIENT_ID takes precedence over HELPSCOUT_API_KEY
    apiKey: process.env.HELPSCOUT_API_KEY || '',
    clientId: process.env.HELPSCOUT_CLIENT_ID || process.env.HELPSCOUT_API_KEY || '',
    clientSecret: process.env.HELPSCOUT_CLIENT_SECRET || process.env.HELPSCOUT_APP_SECRET || '',
    baseUrl: process.env.HELPSCOUT_BASE_URL || 'https://api.helpscout.net/v2/',
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
  const hasPersonalToken = config.helpscout.apiKey && config.helpscout.apiKey.startsWith('Bearer ');
  
  if (!hasOAuth2 && !hasPersonalToken) {
    throw new Error(
      'Authentication required. Provide either:\n' +
      '1. HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET for OAuth2, or\n' +
      '2. HELPSCOUT_API_KEY with a Personal Access Token (starting with "Bearer ")'
    );
  }
}