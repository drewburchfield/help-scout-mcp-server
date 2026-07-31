/**
 * Signed-cookie helpers for the Help Scout consent transaction.
 *
 * The consent flow carries the pending MCP authorization request across three
 * requests (/authorize -> /approve -> /callback) that Help Scout redirects
 * between. Instead of a plaintext round-trip, the transaction rides in an
 * HTTP-only cookie whose integrity is guaranteed by an HMAC-SHA256 signature
 * (WebCrypto) keyed by COOKIE_ENCRYPTION_KEY. This, together with re-validating
 * the client and redirect URI at approve/callback time, is the confused-deputy
 * defense the MCP spec makes a MUST for a proxy server with a static upstream
 * client id.
 *
 * All encoding is TextEncoder-based: the payload holds client-supplied text
 * (state, scope, client-chosen redirect) and bare btoa throws on any code point
 * above U+00FF.
 */
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';

/** The cookie name for the pending consent transaction. */
export const CONSENT_COOKIE_NAME = 'hs_mcp_txn';

/** Consent transactions live 10 minutes: long enough to log in, short enough to bound replay. */
export const CONSENT_TTL_MS = 10 * 60 * 1000;

/**
 * The signed transaction. `oauthReq` is the whole parsed MCP authorization
 * request (its integrity is what the signature protects); `state` is the random
 * nonce we hand Help Scout and expect echoed back (absent until /approve mints
 * it); `exp` is the epoch-ms expiry.
 */
export interface ConsentTransaction {
  oauthReq: AuthRequest;
  state?: string;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** URL-safe base64 of raw bytes (no padding). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of base64UrlEncode. Throws on malformed input (callers treat that as a rejected cookie). */
function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Sign a consent transaction into a cookie value: `body.signature`, where body
 * is base64url(JSON) and signature is base64url(HMAC-SHA256(body)).
 */
export async function signConsentCookie(
  txn: ConsentTransaction,
  secret: string,
): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(txn)));
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify and decode a cookie value. Returns null (never throws) when the value
 * is missing, malformed, has a bad signature, or is expired, so callers treat
 * every failure the same way: reject the request.
 */
export async function verifyConsentCookie(
  value: string | undefined,
  secret: string,
): Promise<ConsentTransaction | null> {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = value.slice(0, dot);
  const providedSig = value.slice(dot + 1);

  let key: CryptoKey;
  let providedSigBytes: Uint8Array;
  try {
    key = await importHmacKey(secret);
    providedSigBytes = base64UrlDecode(providedSig);
  } catch {
    return null;
  }

  // crypto.subtle.verify is constant-time over the signature comparison.
  const ok = await crypto.subtle
    .verify('HMAC', key, providedSigBytes, encoder.encode(body))
    .catch(() => false);
  if (!ok) return null;

  try {
    const txn = JSON.parse(decoder.decode(base64UrlDecode(body))) as ConsentTransaction;
    if (typeof txn.exp !== 'number' || Date.now() > txn.exp) return null;
    return txn;
  } catch {
    return null;
  }
}

/** Build the Set-Cookie header for a signed transaction. */
export function buildConsentSetCookie(value: string): string {
  const maxAge = Math.floor(CONSENT_TTL_MS / 1000);
  return `${CONSENT_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Build the Set-Cookie header that clears the consent cookie. */
export function buildConsentClearCookie(): string {
  return `${CONSENT_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Read one cookie value out of a request's Cookie header. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
