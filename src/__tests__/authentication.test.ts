import { jest } from '@jest/globals';

describe('Authentication Configuration', () => {
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
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Environment Variable Priority', () => {
    it('should prioritize HELPSCOUT_CLIENT_ID over HELPSCOUT_API_KEY for OAuth2', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'new-client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'new-client-secret';
      process.env.HELPSCOUT_API_KEY = 'legacy-client-id';
      // Note: Not setting APP_SECRET, so CLIENT_SECRET will be used

      jest.resetModules();
      const { config } = await import('../utils/config.js');

      expect(config.helpscout.clientId).toBe('new-client-id');
      expect(config.helpscout.clientSecret).toBe('new-client-secret');
    });

    it('should prioritize HELPSCOUT_APP_SECRET over HELPSCOUT_CLIENT_SECRET', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_APP_SECRET = 'app-secret';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';

      jest.resetModules();
      const { config } = await import('../utils/config.js');

      expect(config.helpscout.clientSecret).toBe('app-secret');
    });

    it('should fall back to legacy naming when new naming is not present', async () => {
      process.env.HELPSCOUT_API_KEY = 'legacy-client-id';
      process.env.HELPSCOUT_APP_SECRET = 'legacy-app-secret';

      jest.resetModules();
      const { config } = await import('../utils/config.js');
      
      expect(config.helpscout.clientId).toBe('legacy-client-id');
      expect(config.helpscout.clientSecret).toBe('legacy-app-secret');
      expect(config.helpscout.apiKey).toBe('legacy-client-id');
    });
  });

  describe('validateConfig with new naming', () => {
    it('should pass with new OAuth2 naming (HELPSCOUT_CLIENT_ID/SECRET)', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should pass with legacy OAuth2 naming (HELPSCOUT_API_KEY/APP_SECRET)', async () => {
      process.env.HELPSCOUT_API_KEY = 'client-id';
      process.env.HELPSCOUT_APP_SECRET = 'client-secret';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw error when no authentication is provided', async () => {
      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/OAuth2 authentication required/);
    });

    it('should throw error when only client ID is provided', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/OAuth2 authentication required/);
    });

    it('should throw error when only client secret is provided', async () => {
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/OAuth2 authentication required/);
    });

    it('should throw helpful error message mentioning OAuth2 credentials', async () => {
      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');

      expect(() => validateConfig()).toThrow(/HELPSCOUT_APP_ID/);
      expect(() => validateConfig()).toThrow(/HELPSCOUT_APP_SECRET/);
    });
  });

  describe('Mixed naming scenarios', () => {
    it('should handle mixed new and legacy naming for OAuth2', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'new-client-id';
      process.env.HELPSCOUT_APP_SECRET = 'legacy-secret';

      jest.resetModules();
      const { config, validateConfig } = await import('../utils/config.js');
      
      expect(config.helpscout.clientId).toBe('new-client-id');
      expect(config.helpscout.clientSecret).toBe('legacy-secret');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should handle OAuth2 credentials when API key is also set', async () => {
      // OAuth2 credentials should work regardless of API key value
      process.env.HELPSCOUT_API_KEY = 'old-client-id';
      process.env.HELPSCOUT_CLIENT_ID = 'oauth-client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'oauth-secret';

      jest.resetModules();
      const { config, validateConfig } = await import('../utils/config.js');

      // Should pass validation due to OAuth2 credentials
      expect(() => validateConfig()).not.toThrow();
      expect(config.helpscout.clientId).toBe('oauth-client-id');
      expect(config.helpscout.clientSecret).toBe('oauth-secret');
    });
  });

  describe('Config object structure', () => {
    it('should have correct structure with new OAuth2 fields', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';

      jest.resetModules();
      const { config } = await import('../utils/config.js');
      
      expect(config.helpscout).toHaveProperty('apiKey');
      expect(config.helpscout).toHaveProperty('clientId');
      expect(config.helpscout).toHaveProperty('clientSecret');
      expect(config.helpscout).toHaveProperty('baseUrl');
    });

    it('should set empty strings for missing values', async () => {
      jest.resetModules();
      const { config } = await import('../utils/config.js');
      
      expect(config.helpscout.apiKey).toBe('');
      expect(config.helpscout.clientId).toBe('');
      expect(config.helpscout.clientSecret).toBe('');
    });
  });
});