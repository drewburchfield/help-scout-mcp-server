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

/**
 * Parse a comma-separated host allowlist env var into a Set of trimmed,
 * non-empty, lower-cased hostnames. Returns null when the env var is unset
 * or empty so callers can fall back to the built-in default set.
 */
function parseHostAllowlist(envVar: string | undefined): Set<string> | null {
  if (!envVar) return null;
  const hosts = envVar
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(h => h.length > 0);
  return hosts.length > 0 ? new Set(hosts) : null;
}

/**
 * Default Help Scout API hosts. The OAuth2 bearer token is sent on every
 * authenticated request, so a repointed base URL would exfiltrate it to an
 * attacker host. Default-closed to these; override only for self-hosted or
 * proxy setups via HELPSCOUT_ALLOWED_API_HOSTS.
 */
const DEFAULT_ALLOWED_API_HOSTS = new Set(['api.helpscout.net', 'api.helpscout.com']);

/**
 * Default Help Scout Docs API host. The Docs API key travels via HTTP basic
 * auth, which is just as sensitive. Override via HELPSCOUT_ALLOWED_DOCS_HOSTS.
 */
const DEFAULT_ALLOWED_DOCS_HOSTS = new Set(['docsapi.helpscout.net']);

/**
 * Validate that a configured base URL resolves to a host in the allowlist.
 * `null` allowlist means use the provided default set. Empty/whitespace
 * URLs are skipped (the default applies elsewhere). Throws on an invalid URL
 * or a host outside the allowlist.
 */
function validateHostAllowlist(
  rawUrl: string | undefined,
  envVarName: string,
  override: Set<string> | null,
  defaults: Set<string>,
): void {
  if (!rawUrl || !rawUrl.trim()) return;
  const allowed = override ?? defaults;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `Security Error: ${envVarName} is not a valid URL.\nCurrent value: ${rawUrl}`,
    );
  }
  if (!allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Security Error: ${envVarName} host "${parsed.hostname}" is not in the allowlist. ` +
      `Allowed hosts: ${[...allowed].join(', ')}. ` +
      `Set ${envVarName === 'HELPSCOUT_BASE_URL' ? 'HELPSCOUT_ALLOWED_API_HOSTS' : 'HELPSCOUT_ALLOWED_DOCS_HOSTS'} ` +
      `to override for self-hosted or proxy setups.`,
    );
  }
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

  // Constrain HELPSCOUT_BASE_URL to known Help Scout hosts (SSRF defense).
  // The OAuth2 bearer token is sent on every authenticated request, so a
  // misconfigured or attacker-controlled base URL would leak it.
  validateHostAllowlist(
    config.helpscout.baseUrl,
    'HELPSCOUT_BASE_URL',
    parseHostAllowlist(process.env.HELPSCOUT_ALLOWED_API_HOSTS),
    DEFAULT_ALLOWED_API_HOSTS,
  );

  // Same treatment for the Docs API host. The Docs API key travels via HTTP
  // basic auth, which is just as sensitive.
  if (config.helpscout.docsBaseUrl && !config.helpscout.docsBaseUrl.startsWith('https://')) {
    throw new Error(
      'Security Error: HELPSCOUT_DOCS_BASE_URL must use HTTPS to protect Docs API credentials in transit.\n' +
      `Current value: ${config.helpscout.docsBaseUrl}\n` +
      'Please use: https://docsapi.helpscout.net/v1/'
    );
  }
  validateHostAllowlist(
    config.helpscout.docsBaseUrl,
    'HELPSCOUT_DOCS_BASE_URL',
    parseHostAllowlist(process.env.HELPSCOUT_ALLOWED_DOCS_HOSTS),
    DEFAULT_ALLOWED_DOCS_HOSTS,
  );
}
