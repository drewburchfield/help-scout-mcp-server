describe('Config Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules before modifying environment
    jest.resetModules();
    // Create fresh environment without any HELPSCOUT vars
    process.env = Object.keys(originalEnv).reduce((env, key) => {
      if (!key.startsWith('HELPSCOUT_')) {
        env[key] = originalEnv[key];
      }
      return env;
    }, {} as typeof process.env);
    delete process.env.REDACT_MESSAGE_CONTENT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateConfig', () => {
    it('should pass with valid OAuth2 configuration', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'valid-client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'valid-client-secret';
      process.env.HELPSCOUT_BASE_URL = 'https://api.helpscout.net/v2/';

      // Clear module cache and re-import to get fresh config
      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should pass with OAuth2 configuration when stale bearer API key remains set', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer old-personal-token';
      process.env.HELPSCOUT_CLIENT_ID = 'valid-client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'valid-client-secret';
      process.env.HELPSCOUT_BASE_URL = 'https://api.helpscout.net/v2/';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should reject stale bearer API key when no OAuth2 credentials are configured', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer old-personal-token';
      process.env.HELPSCOUT_APP_SECRET = 'client-secret';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/Personal Access Tokens are no longer supported/);
    });

    it('should pass with legacy OAuth2 naming (HELPSCOUT_API_KEY/APP_SECRET)', async () => {
      process.env.HELPSCOUT_API_KEY = 'client-id';
      process.env.HELPSCOUT_APP_SECRET = 'client-secret';
      process.env.HELPSCOUT_BASE_URL = 'https://api.helpscout.net/v2/';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw error when authentication is missing', async () => {
      // All HELPSCOUT_ vars already cleared by beforeEach
      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/OAuth2 authentication required/);
    });

    it('should throw error when only API key is provided without app secret', async () => {
      process.env.HELPSCOUT_API_KEY = 'client-id';
      delete process.env.HELPSCOUT_APP_SECRET;
      delete process.env.HELPSCOUT_CLIENT_SECRET;

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/OAuth2 authentication required/);
    });

    it('should use default base URL when not provided', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';
      delete process.env.HELPSCOUT_BASE_URL;

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should enable message content redaction only when REDACT_MESSAGE_CONTENT is true', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';
      process.env.REDACT_MESSAGE_CONTENT = 'true';
      process.env.CACHE_TTL_SECONDS = '600';
      process.env.LOG_LEVEL = 'debug';

      jest.resetModules();
      const { config, validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
      expect(config.security.redactMessageContent).toBe(true);
    });

    it('should leave message content visible for invalid redaction values', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';
      process.env.REDACT_MESSAGE_CONTENT = 'invalid-boolean';

      jest.resetModules();
      const { config, validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
      expect(config.security.redactMessageContent).toBe(false);
    });

    it('should handle invalid numeric values gracefully', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';
      process.env.CACHE_TTL_SECONDS = 'not-a-number';
      process.env.MAX_CACHE_SIZE = '100.5';
      process.env.HTTP_MAX_SOCKETS = 'zero';
      process.env.HTTP_MAX_FREE_SOCKETS = '-1';
      process.env.HTTP_SOCKET_TIMEOUT = '30s';
      process.env.HTTP_KEEP_ALIVE_MSECS = '1.5';

      jest.resetModules();
      const { config, validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
      expect(config.cache.ttlSeconds).toBe(300);
      expect(config.cache.maxSize).toBe(10000);
      expect(config.connectionPool.maxSockets).toBe(50);
      expect(config.connectionPool.maxFreeSockets).toBe(10);
      expect(config.connectionPool.timeout).toBe(30000);
      expect(config.connectionPool.keepAliveMsecs).toBe(1000);
    });

    it('should fall back to info for invalid logging levels', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';
      process.env.LOG_LEVEL = 'infos';

      jest.resetModules();
      const { config, validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
      expect(config.logging.level).toBe('info');
    });
  });

  describe('host allowlist (SSRF defense)', () => {
    beforeEach(() => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';
      delete process.env.HELPSCOUT_ALLOWED_API_HOSTS;
      delete process.env.HELPSCOUT_ALLOWED_DOCS_HOSTS;
    });

    it('accepts the default Help Scout API hosts', async () => {
      for (const host of ['api.helpscout.net', 'api.helpscout.com']) {
        process.env.HELPSCOUT_BASE_URL = `https://${host}/v2/`;
        jest.resetModules();
        const { validateConfig } = await import('../utils/config.js');
        expect(() => validateConfig()).not.toThrow();
      }
    });

    it('rejects an API base URL pointed at an attacker host', async () => {
      process.env.HELPSCOUT_BASE_URL = 'https://evil.example.com/v2/';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/HELPSCOUT_BASE_URL host "evil.example.com" is not in the allowlist/);
    });

    it('rejects a look-alike subdomain not in the allowlist', async () => {
      process.env.HELPSCOUT_BASE_URL = 'https://api.helpscout.net.evil.com/v2/';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/is not in the allowlist/);
    });

    it('honors HELPSCOUT_ALLOWED_API_HOSTS override for self-hosted/proxy setups', async () => {
      process.env.HELPSCOUT_BASE_URL = 'https://helpscout.internal.corp/v2/';
      process.env.HELPSCOUT_ALLOWED_API_HOSTS = 'helpscout.internal.corp';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('still requires HTTPS even when the host is allowed', async () => {
      process.env.HELPSCOUT_BASE_URL = 'http://api.helpscout.net/v2/';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/HELPSCOUT_BASE_URL must use HTTPS/);
    });

    it('rejects a Docs base URL pointed at an attacker host', async () => {
      process.env.HELPSCOUT_DOCS_BASE_URL = 'https://evil.example.com/v1/';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/HELPSCOUT_DOCS_BASE_URL host "evil.example.com" is not in the allowlist/);
    });

    it('accepts the default Docs host and honors its override', async () => {
      process.env.HELPSCOUT_DOCS_BASE_URL = 'https://docsapi.helpscout.net/v1/';
      jest.resetModules();
      let mod = await import('../utils/config.js');
      expect(() => mod.validateConfig()).not.toThrow();

      process.env.HELPSCOUT_DOCS_BASE_URL = 'https://docs.internal.corp/v1/';
      process.env.HELPSCOUT_ALLOWED_DOCS_HOSTS = 'docs.internal.corp';
      jest.resetModules();
      mod = await import('../utils/config.js');
      expect(() => mod.validateConfig()).not.toThrow();
    });
  });
});
