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
      process.env.HELPSCOUT_APP_SECRET = 'legacy-app-secret';

      jest.resetModules();
      const { config } = await import('../utils/config.js');
      
      expect(config.helpscout.clientId).toBe('new-client-id');
      expect(config.helpscout.clientSecret).toBe('new-client-secret');
    });

    it('should prioritize HELPSCOUT_CLIENT_SECRET over HELPSCOUT_APP_SECRET', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'new-secret';
      process.env.HELPSCOUT_APP_SECRET = 'legacy-secret';

      jest.resetModules();
      const { config } = await import('../utils/config.js');
      
      expect(config.helpscout.clientSecret).toBe('new-secret');
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

    it('should pass with Personal Access Token', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer personal-access-token';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw error when no authentication is provided', async () => {
      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/Authentication required/);
    });

    it('should throw error when only client ID is provided', async () => {
      process.env.HELPSCOUT_CLIENT_ID = 'client-id';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/Authentication required/);
    });

    it('should throw error when only client secret is provided', async () => {
      process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/Authentication required/);
    });

    it('should throw helpful error message with both naming options', async () => {
      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      
      expect(() => validateConfig()).toThrow(
        expect.objectContaining({
          message: expect.stringContaining('HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET')
        })
      );
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

    it('should handle API key as both Personal Access Token and OAuth2', async () => {
      // When API key is a Bearer token, it should be treated as Personal Access Token
      process.env.HELPSCOUT_API_KEY = 'Bearer personal-token';
      process.env.HELPSCOUT_CLIENT_ID = 'oauth-client-id';
      process.env.HELPSCOUT_CLIENT_SECRET = 'oauth-secret';

      jest.resetModules();
      const { config, validateConfig } = await import('../utils/config.js');
      
      // Should pass validation due to Personal Access Token
      expect(() => validateConfig()).not.toThrow();
      expect(config.helpscout.apiKey).toBe('Bearer personal-token');
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