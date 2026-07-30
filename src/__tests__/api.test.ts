import { jest } from '@jest/globals';

// The last test imports the real axios client, whose config module needs
// credentials at load time.
process.env.HELPSCOUT_CLIENT_ID = process.env.HELPSCOUT_CLIENT_ID || 'test-client-id';
process.env.HELPSCOUT_CLIENT_SECRET = process.env.HELPSCOUT_CLIENT_SECRET || 'test-client-secret';

import {
  getClient,
  setDefaultHelpScoutApi,
  withHelpScoutApi,
  type HelpScoutApi,
} from '../utils/api.js';

function stubApi(label: string): HelpScoutApi {
  const unreachable = () => Promise.reject(new Error(`unexpected call on ${label}`));
  return {
    get: unreachable,
    getAllPages: unreachable,
    getRaw: unreachable,
    post: unreachable,
    put: unreachable,
    patch: unreachable,
    delete: unreachable,
    // Not part of HelpScoutApi; lets assertions tell instances apart.
    ...( { label } as object ),
  } as HelpScoutApi;
}

function labelOf(api: HelpScoutApi): string {
  return (api as unknown as { label: string }).label;
}

describe('Help Scout client seam', () => {
  it('refuses to resolve when no client has been configured', async () => {
    jest.resetModules();
    const fresh = await import('../utils/api.js');
    expect(() => fresh.getClient()).toThrow('No Help Scout client is configured');
  });

  it('resolves the process default outside any request context', () => {
    setDefaultHelpScoutApi(stubApi('default'));
    expect(labelOf(getClient())).toBe('default');
  });

  it('carries a request-scoped client across awaits and restores the default after', async () => {
    setDefaultHelpScoutApi(stubApi('default'));
    const scoped = stubApi('user-scoped');

    const seenInside = await withHelpScoutApi(scoped, async () => {
      await new Promise(resolve => setImmediate(resolve));
      return labelOf(getClient());
    });

    expect(seenInside).toBe('user-scoped');
    expect(labelOf(getClient())).toBe('default');
  });

  it('isolates concurrent request contexts from each other', async () => {
    setDefaultHelpScoutApi(stubApi('default'));

    const [a, b] = await Promise.all([
      withHelpScoutApi(stubApi('user-a'), async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return labelOf(getClient());
      }),
      withHelpScoutApi(stubApi('user-b'), async () => {
        return labelOf(getClient());
      }),
    ]);

    expect(a).toBe('user-a');
    expect(b).toBe('user-b');
  });

  it('registers the stdio singleton as the default when the client module loads', async () => {
    jest.resetModules();
    const fresh = await import('../utils/api.js');
    const { helpScoutClient } = await import('../utils/helpscout-client.js');
    expect(fresh.getClient()).toBe(helpScoutClient);
  });
});
