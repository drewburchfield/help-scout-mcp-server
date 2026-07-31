/**
 * Durable Help Scout token rotation via the OAuth shell's tokenExchangeCallback.
 *
 * This is the sanctioned, cross-instance-durable persistence hook. The provider
 * invokes the callback on every token exchange it performs for OUR token and,
 * on a refresh exchange, persists whatever `newProps` we return into the grant
 * record in KV (re-encrypted) — a write no Durable Object can make, because the
 * grant's encryption key is wrapped by the refresh token the /token endpoint
 * holds. See the blueprint (docs/plans/2026-07-31-t5-helpscout-leg-blueprint.md)
 * for the full evidence trail with library file/line citations.
 *
 * Strategy:
 *   - authorization_code exchange: align OUR access-token TTL to the Help Scout
 *     token so OUR token expires ~5 minutes BEFORE the Help Scout one. That
 *     makes the MCP client's refresh of OUR token the primary rotation trigger,
 *     ahead of the tool path's own proactive-refresh window.
 *   - refresh_token exchange (the MCP client refreshing OUR token): refresh the
 *     Help Scout pair upstream and return it as newProps so the rotation is
 *     persisted durably; re-align the TTL to the fresh Help Scout expiry. On a
 *     spent/revoked Help Scout refresh token, throw OAuthError('invalid_grant')
 *     so the client re-runs authorization (re-consent) instead of a 500.
 *
 * Credentials arrive through process.env: the callback is a module-scope closure
 * the provider calls with no `env` param, and process.env is populated from
 * vars/secrets under nodejs_compat at the configured compatibility date.
 */
import {
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import type { HelpScoutProps } from './mcp-agent.js';

/** OUR token expires this far before the Help Scout token, ahead of the fetch client's 60s proactive window. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * OUR access-token lifetime, in seconds, aligned to the Help Scout token expiry
 * minus the skew. Returns undefined when the Help Scout expiry is unknown (0),
 * so the provider keeps its default TTL. Floored at 60s (the provider's minimum).
 */
function alignedAccessTokenTtl(expiresAt: number): number | undefined {
  if (!expiresAt) return undefined;
  const seconds = Math.floor((expiresAt - Date.now() - REFRESH_SKEW_MS) / 1000);
  return Math.max(60, seconds);
}

interface HelpScoutTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

/**
 * Exchange the stored Help Scout refresh token for a rotated pair. Throws
 * OAuthError so the failure surfaces as a standard /token error (re-consent for
 * a spent grant, a retryable error otherwise) rather than a generic 500.
 */
async function refreshHelpScoutTokens(props: HelpScoutProps): Promise<HelpScoutProps> {
  const clientId = process.env.HELPSCOUT_CLIENT_ID;
  const clientSecret = process.env.HELPSCOUT_CLIENT_SECRET;
  const tokenUrl = process.env.HELPSCOUT_TOKEN_URL;
  if (!clientId || !clientSecret || !tokenUrl) {
    // No credentials to refresh with: leave the grant untouched rather than
    // spend the refresh token. The tool-path fallback + re-consent still cover
    // an expired Help Scout token.
    return props;
  }

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: props.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new OAuthError('temporarily_unavailable', { description: 'Help Scout was unreachable during token refresh.' });
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as HelpScoutTokenResponse;
    if ((response.status === 400 || response.status === 401) && body.error === 'invalid_grant') {
      throw new OAuthError('invalid_grant', { description: 'The Help Scout session has expired or was revoked. Reconnect the connector.' });
    }
    throw new OAuthError('temporarily_unavailable', { description: `Help Scout rejected the token refresh (status ${response.status}).` });
  }

  const data = (await response.json().catch(() => ({}))) as HelpScoutTokenResponse;
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;
  if (typeof accessToken !== 'string' || accessToken === '' || typeof refreshToken !== 'string' || refreshToken === '') {
    throw new OAuthError('temporarily_unavailable', { description: 'Help Scout returned a malformed token refresh response.' });
  }

  return {
    ...props,
    accessToken,
    refreshToken,
    expiresAt: typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : 0,
  };
}

/**
 * The tokenExchangeCallback wired into the OAuthProvider. Kept side-effect-light:
 * it only touches Help Scout on a refresh exchange, and returns the result the
 * provider persists.
 */
export async function helpScoutTokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | void> {
  const props = options.props as HelpScoutProps | undefined;
  if (!props) return;

  if (options.grantType === 'authorization_code') {
    const accessTokenTTL = alignedAccessTokenTtl(props.expiresAt);
    return accessTokenTTL ? { accessTokenTTL } : undefined;
  }

  if (options.grantType === 'refresh_token') {
    const rotated = await refreshHelpScoutTokens(props);
    const accessTokenTTL = alignedAccessTokenTtl(rotated.expiresAt);
    // Only claim a props change when the pair actually rotated (refresh may be a
    // no-op when credentials are absent), so the provider skips a needless write.
    const rotatedPair = rotated.accessToken !== props.accessToken || rotated.refreshToken !== props.refreshToken;
    return {
      ...(rotatedPair ? { newProps: rotated } : {}),
      ...(accessTokenTTL ? { accessTokenTTL } : {}),
    };
  }

  return;
}
