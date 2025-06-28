import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  helpscout: {
    apiKey: string;
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
    apiKey: process.env.HELPSCOUT_API_KEY || '',
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
  if (!config.helpscout.apiKey) {
    throw new Error('HELPSCOUT_API_KEY environment variable is required');
  }
}