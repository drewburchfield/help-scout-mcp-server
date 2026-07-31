import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import nock from 'nock';
import { HelpScoutClient } from '../utils/helpscout-client.js';
import { HelpScoutDocsClient } from '../utils/helpscout-docs-client.js';
import { cache } from '../utils/cache.js';

// NAS-1496: one process-wide cache is shared by the axios client and the Docs
// client. These tests exercise the REAL cache (not mocked) so that identity
// namespacing is observable: two identities requesting the same endpoint must
// not read each other's entries.

jest.setTimeout(15000);

jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../utils/config.js', () => ({
  config: {
    helpscout: {
      get apiKey() { return process.env.HELPSCOUT_API_KEY || ''; },
      get clientId() { return process.env.HELPSCOUT_APP_ID || process.env.HELPSCOUT_CLIENT_ID || process.env.HELPSCOUT_API_KEY || ''; },
      get clientSecret() { return process.env.HELPSCOUT_APP_SECRET || process.env.HELPSCOUT_CLIENT_SECRET || ''; },
      get baseUrl() { return process.env.HELPSCOUT_BASE_URL || 'https://api.helpscout.net/v2/'; },
      get docsBaseUrl() { return process.env.HELPSCOUT_DOCS_BASE_URL || 'https://docsapi.helpscout.net/v1/'; },
      get docsApiKey() { return process.env.HELPSCOUT_DOCS_API_KEY; },
    },
    cache: {
      ttlSeconds: 300,
      maxSize: 10000,
    },
    connectionPool: {
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 30000,
    },
    logging: { level: 'info' },
    security: { redactMessageContent: false },
  },
  validateConfig: jest.fn(),
}));

describe('cache identity isolation (NAS-1496)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nock.cleanAll();
    nock.restore();
    nock.activate();
    cache.clear();
    nock.disableNetConnect();

    delete process.env.HELPSCOUT_API_KEY;
    delete process.env.HELPSCOUT_APP_ID;
    delete process.env.HELPSCOUT_CLIENT_ID;
    delete process.env.HELPSCOUT_APP_SECRET;
    delete process.env.HELPSCOUT_CLIENT_SECRET;
    delete process.env.HELPSCOUT_DOCS_API_KEY;
    process.env.HELPSCOUT_BASE_URL = 'https://api.helpscout.net/v2/';
    process.env.HELPSCOUT_DOCS_BASE_URL = 'https://docsapi.helpscout.net/v1/';
  });

  afterEach(() => {
    nock.enableNetConnect();
    nock.cleanAll();
    nock.restore();
    cache.clear();
  });

  it('does not serve axios-client cache across OAuth identities', async () => {
    const setSpy = jest.spyOn(cache, 'set');
    const dataA = { _embedded: { mailboxes: [{ id: 'A' }] } };
    const dataB = { _embedded: { mailboxes: [{ id: 'B' }] } };

    // Identity A primes the cache.
    process.env.HELPSCOUT_APP_ID = 'app-A';
    process.env.HELPSCOUT_APP_SECRET = 'secret-A';
    const clientA = new HelpScoutClient();
    nock('https://api.helpscout.net').post('/v2/oauth2/token').reply(200, { access_token: 'tokA', expires_in: 7200 });
    const apiA = nock('https://api.helpscout.net')
      .get('/v2/mailboxes')
      .matchHeader('authorization', 'Bearer tokA')
      .reply(200, dataA);
    await expect(clientA.get('/mailboxes')).resolves.toEqual(dataA);
    expect(apiA.isDone()).toBe(true);

    // Identity B requests the same endpoint+params. A cache leak would return
    // dataA and leave apiB unconsumed; isolation forces B to its own upstream.
    process.env.HELPSCOUT_APP_ID = 'app-B';
    process.env.HELPSCOUT_APP_SECRET = 'secret-B';
    const clientB = new HelpScoutClient();
    nock('https://api.helpscout.net').post('/v2/oauth2/token').reply(200, { access_token: 'tokB', expires_in: 7200 });
    const apiB = nock('https://api.helpscout.net')
      .get('/v2/mailboxes')
      .matchHeader('authorization', 'Bearer tokB')
      .reply(200, dataB);
    await expect(clientB.get('/mailboxes')).resolves.toEqual(dataB);
    expect(apiB.isDone()).toBe(true);

    // Cache is genuinely active: with A's credentials restored, the entry is
    // served without any upstream (no nock defined, net connect disabled).
    process.env.HELPSCOUT_APP_ID = 'app-A';
    process.env.HELPSCOUT_APP_SECRET = 'secret-A';
    await expect(clientA.get('/mailboxes')).resolves.toEqual(dataA);

    // Fingerprints differ and never leak the raw credential material.
    const prefixes = setSpy.mock.calls.map((call) => String(call[0]));
    expect(prefixes.length).toBeGreaterThanOrEqual(2);
    expect(prefixes[0]).not.toEqual(prefixes[1]);
    for (const prefix of prefixes) {
      expect(prefix).not.toContain('secret-A');
      expect(prefix).not.toContain('secret-B');
      expect(prefix).not.toContain('app-A');
      expect(prefix).not.toContain('app-B');
    }

    await clientA.closePool();
    await clientB.closePool();
  });

  it('does not serve Docs-client cache across API keys', async () => {
    const setSpy = jest.spyOn(cache, 'set');
    const dataA = { items: [{ id: 'A' }] };
    const dataB = { items: [{ id: 'B' }] };

    process.env.HELPSCOUT_DOCS_API_KEY = 'docs-key-A';
    const docsA = new HelpScoutDocsClient();
    const apiA = nock('https://docsapi.helpscout.net')
      .get('/v1/collections')
      .basicAuth({ user: 'docs-key-A', pass: 'X' })
      .reply(200, dataA);
    await expect(docsA.get('collections')).resolves.toEqual(dataA);
    expect(apiA.isDone()).toBe(true);

    process.env.HELPSCOUT_DOCS_API_KEY = 'docs-key-B';
    const docsB = new HelpScoutDocsClient();
    const apiB = nock('https://docsapi.helpscout.net')
      .get('/v1/collections')
      .basicAuth({ user: 'docs-key-B', pass: 'X' })
      .reply(200, dataB);
    await expect(docsB.get('collections')).resolves.toEqual(dataB);
    expect(apiB.isDone()).toBe(true);

    // With key A restored the cached entry is served with no upstream.
    process.env.HELPSCOUT_DOCS_API_KEY = 'docs-key-A';
    await expect(docsA.get('collections')).resolves.toEqual(dataA);

    const prefixes = setSpy.mock.calls.map((call) => String(call[0]));
    expect(prefixes.length).toBeGreaterThanOrEqual(2);
    expect(prefixes[0]).not.toEqual(prefixes[1]);
    for (const prefix of prefixes) {
      expect(prefix).not.toContain('docs-key-A');
      expect(prefix).not.toContain('docs-key-B');
    }
  });

  it('rejects a cross-origin absolute URL on the Docs client', async () => {
    process.env.HELPSCOUT_DOCS_API_KEY = 'docs-key-A';
    const docs = new HelpScoutDocsClient();
    await expect(docs.get('https://attacker.example/collect')).rejects.toThrow('non-Help-Scout origin');
    expect(nock.pendingMocks()).toHaveLength(0);
  });
});
