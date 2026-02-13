import { isApiError } from '../utils/mcp-errors.js';

describe('isApiError', () => {
  it('should return true for valid ApiError objects', () => {
    expect(isApiError({ code: 'UNAUTHORIZED', message: 'bad creds' })).toBe(true);
    expect(isApiError({ code: 'RATE_LIMIT', message: 'slow down' })).toBe(true);
    expect(isApiError({ code: 'INVALID_INPUT', message: 'bad input' })).toBe(true);
    expect(isApiError({ code: 'NOT_FOUND', message: 'missing' })).toBe(true);
    expect(isApiError({ code: 'UPSTREAM_ERROR', message: 'api down' })).toBe(true);
  });

  it('should return true when extra fields are present', () => {
    expect(isApiError({ code: 'UNAUTHORIZED', message: 'test', retryAfter: 5, details: {} })).toBe(true);
  });

  it('should reject Node.js system errors with string codes', () => {
    expect(isApiError({ code: 'ECONNREFUSED', message: 'connect failed' })).toBe(false);
    expect(isApiError({ code: 'ENOTFOUND', message: 'dns failed' })).toBe(false);
    expect(isApiError({ code: 'ETIMEDOUT', message: 'timeout' })).toBe(false);
    expect(isApiError({ code: 'ECONNRESET', message: 'reset' })).toBe(false);
  });

  it('should reject unknown error codes', () => {
    expect(isApiError({ code: 'UNKNOWN', message: 'something' })).toBe(false);
    expect(isApiError({ code: 'TIMEOUT', message: 'timed out' })).toBe(false);
    expect(isApiError({ code: '', message: 'empty code' })).toBe(false);
  });

  it('should reject objects missing required fields', () => {
    expect(isApiError({ code: 'UNAUTHORIZED' })).toBe(false);
    expect(isApiError({ message: 'no code' })).toBe(false);
    expect(isApiError({})).toBe(false);
  });

  it('should reject non-object values', () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError('string error')).toBe(false);
    expect(isApiError(42)).toBe(false);
    expect(isApiError(true)).toBe(false);
  });

  it('should reject objects with non-string code or message', () => {
    expect(isApiError({ code: 401, message: 'unauthorized' })).toBe(false);
    expect(isApiError({ code: 'UNAUTHORIZED', message: 123 })).toBe(false);
  });
});
