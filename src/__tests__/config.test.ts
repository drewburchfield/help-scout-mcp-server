describe('Config Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateConfig', () => {
    it('should pass with valid Personal Access Token configuration', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer valid-token-here';
      process.env.HELPSCOUT_BASE_URL = 'https://api.helpscout.net/v2/';

      // Clear module cache and re-import to get fresh config
      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should pass with valid OAuth2 configuration', async () => {
      process.env.HELPSCOUT_API_KEY = 'client-id';
      process.env.HELPSCOUT_APP_SECRET = 'client-secret';
      process.env.HELPSCOUT_BASE_URL = 'https://api.helpscout.net/v2/';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw error when authentication is missing', async () => {
      process.env.HELPSCOUT_API_KEY = '';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).toThrow(/Authentication required/);
    });

    it('should throw error when only API key is provided without app secret (non-bearer token)', async () => {
      process.env.HELPSCOUT_API_KEY = 'client-id'; // Not a Bearer token
      delete process.env.HELPSCOUT_APP_SECRET;
      delete process.env.HELPSCOUT_CLIENT_SECRET;

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      // Now validateConfig checks for complete OAuth2 credentials
      expect(() => validateConfig()).toThrow(/Authentication required/);
    });

    it('should use default base URL when not provided', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer token';
      delete process.env.HELPSCOUT_BASE_URL;

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should handle boolean environment variables correctly', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer token';
      process.env.ALLOW_PII = 'true';
      process.env.CACHE_TTL_SECONDS = '600';
      process.env.LOG_LEVEL = 'debug';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should handle invalid boolean values gracefully', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer token';
      process.env.ALLOW_PII = 'invalid-boolean';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });

    it('should handle invalid numeric values gracefully', async () => {
      process.env.HELPSCOUT_API_KEY = 'Bearer token';
      process.env.CACHE_TTL_SECONDS = 'not-a-number';

      jest.resetModules();
      const { validateConfig } = await import('../utils/config.js');
      expect(() => validateConfig()).not.toThrow();
    });
  });
});