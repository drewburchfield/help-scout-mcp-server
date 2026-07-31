/**
 * Unit coverage for the worker's signed consent-cookie helpers. The module is
 * dependency-free (WebCrypto + TextEncoder, all Node globals), so the
 * security-critical signing logic is exercised here in CI while the full
 * consent flow is exercised by the worker smoke suite.
 */
import {
  CONSENT_COOKIE_NAME,
  CONSENT_TTL_MS,
  buildConsentClearCookie,
  buildConsentSetCookie,
  readCookie,
  signConsentCookie,
  verifyConsentCookie,
  type ConsentTransaction,
} from '../../worker/src/oauth-cookie.js';

const SECRET = 'test-secret-key-for-consent-cookies';

interface FakeAuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
}

function freshTxn(overrides: Partial<ConsentTransaction<FakeAuthRequest>> = {}): ConsentTransaction<FakeAuthRequest> {
  return {
    oauthReq: {
      clientId: 'client-1',
      redirectUri: 'https://example.com/callback',
      state: 'client-state',
    },
    exp: Date.now() + CONSENT_TTL_MS,
    ...overrides,
  };
}

describe('consent cookie signing', () => {
  it('round-trips a transaction, preserving client-supplied unicode', async () => {
    const txn = freshTxn({
      oauthReq: { clientId: 'client-✓-日本語', redirectUri: 'https://example.com/cb', state: 'état-✓' },
      state: 'hs-state-1',
    });

    const cookie = await signConsentCookie(txn, SECRET);
    const decoded = await verifyConsentCookie<FakeAuthRequest>(cookie, SECRET);

    expect(decoded).toEqual(txn);
  });

  it('rejects a tampered body even when the signature is untouched', async () => {
    const cookie = await signConsentCookie(freshTxn(), SECRET);
    const [body, sig] = [cookie.slice(0, cookie.lastIndexOf('.')), cookie.slice(cookie.lastIndexOf('.') + 1)];
    const other = await signConsentCookie(
      freshTxn({ oauthReq: { clientId: 'attacker', redirectUri: 'https://attacker.example/cb', state: 'x' } }),
      SECRET,
    );
    const otherBody = other.slice(0, other.lastIndexOf('.'));

    expect(otherBody).not.toBe(body);
    expect(await verifyConsentCookie(`${otherBody}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects a valid body signed with a different secret', async () => {
    const cookie = await signConsentCookie(freshTxn(), 'some-other-secret');

    expect(await verifyConsentCookie(cookie, SECRET)).toBeNull();
  });

  it('rejects an expired transaction', async () => {
    const cookie = await signConsentCookie(freshTxn({ exp: Date.now() - 1 }), SECRET);

    expect(await verifyConsentCookie(cookie, SECRET)).toBeNull();
  });

  it.each([undefined, '', 'no-dot', '.leading-dot', 'not!base64.not!base64'])(
    'rejects malformed cookie value %p without throwing',
    async (value) => {
      expect(await verifyConsentCookie(value as string | undefined, SECRET)).toBeNull();
    },
  );
});

describe('cookie header helpers', () => {
  it('sets an HTTP-only, secure, lax cookie bounded by the consent TTL', () => {
    const header = buildConsentSetCookie('abc');

    expect(header).toContain(`${CONSENT_COOKIE_NAME}=abc`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${Math.floor(CONSENT_TTL_MS / 1000)}`);
  });

  it('clears the cookie with a zero max-age', () => {
    expect(buildConsentClearCookie()).toContain('Max-Age=0');
  });

  it('reads the named cookie out of a multi-cookie header', () => {
    const request = new Request('https://example.com/', {
      headers: { Cookie: `other=1; ${CONSENT_COOKIE_NAME}=the-value; another=2` },
    });

    expect(readCookie(request, CONSENT_COOKIE_NAME)).toBe('the-value');
    expect(readCookie(request, 'missing')).toBeUndefined();
    expect(readCookie(new Request('https://example.com/'), CONSENT_COOKIE_NAME)).toBeUndefined();
  });
});
