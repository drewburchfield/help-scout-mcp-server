/**
 * Shared upstream-URL helpers for the Help Scout legs.
 *
 * These were originally private to help-scout-handler.ts. The admin surface
 * (NAS-1503) runs the SAME Help Scout Authorization Code dance (authorize +
 * token exchange + a users lookup) as the consent flow, so it needs the exact
 * same https guard and URL join. Keeping ONE copy here means the two callers can
 * never drift on the security-critical https rule: a real deployment is always
 * https, and only 127.0.0.1 / localhost / [::1] over http is tolerated, and only
 * in test mode (the smoke's http loopback mock).
 */

/**
 * Codes, client secrets, and fresh bearer tokens flow to these URLs, so they
 * must be https.
 *
 * `allowLoopback` opens a narrow exception for the smoke harness's http mock
 * upstream, and ONLY the smoke turns it on: it is the deployment's test-mode
 * signal (Boolean(HELPSCOUT_TEST_POLICY_ROUTES)), which production never sets.
 * With it false, only https passes: a loopback http URL is rejected like any
 * other non-https URL, so a production deployment cannot be pointed at http.
 * The loopback allow-list is exact-match so `http://127.0.0.1.evil.com` (which
 * merely starts with 127.0.0.1) is rejected.
 */
export function isSecureUpstreamUrl(value: string, allowLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (!allowLoopback) return false;
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1')
  );
}

/** Join base URL + path the way the fetch client does, tolerating a trailing slash on the base. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
