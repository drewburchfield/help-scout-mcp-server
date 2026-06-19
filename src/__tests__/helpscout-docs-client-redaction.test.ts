import { describe, it, expect, jest } from '@jest/globals';

// Mock logger to reduce test output noise
jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

import { HelpScoutDocsClient, safeDocsApiResponse } from '../utils/helpscout-docs-client.js';

describe('HelpScoutDocsClient error-body whitelisting', () => {
  it('safeDocsApiResponse keeps only code/error/message and truncates message', () => {
    const result = safeDocsApiResponse({
      code: 'invalid',
      error: 'bad input',
      message: 'y'.repeat(500),
      email: 'jane@bigcorp.com',
      stack: 'secret stack',
    });

    expect(result).toEqual({
      code: 'invalid',
      error: 'bad input',
      message: 'y'.repeat(200),
    });
    expect(JSON.stringify(result)).not.toContain('jane@bigcorp.com');
    expect(JSON.stringify(result)).not.toContain('secret stack');
  });

  it('safeDocsApiResponse returns undefined for non-object bodies', () => {
    expect(safeDocsApiResponse('plain string')).toBeUndefined();
    expect(safeDocsApiResponse(undefined)).toBeUndefined();
  });

  it('does not propagate the verbatim 4xx body into the transformed error', () => {
    const client = new HelpScoutDocsClient();

    const mockAxiosError = {
      response: {
        status: 400,
        data: {
          code: 'invalid_request',
          message: 'Collection slug already exists',
          submittedBy: 'jane@bigcorp.com',
        },
      },
      config: { docsMetadata: { requestId: 'docs-400', startTime: Date.now() } },
    };

    const transformed = (client as any).transformError(mockAxiosError);

    expect(transformed.code).toBe('INVALID_INPUT');
    expect(transformed.details.apiResponse).toEqual({
      code: 'invalid_request',
      error: undefined,
      message: 'Collection slug already exists',
    });
    expect(JSON.stringify(transformed)).not.toContain('jane@bigcorp.com');
  });

  it('whitelists the 404 error body as well', () => {
    const client = new HelpScoutDocsClient();

    const mockAxiosError = {
      response: {
        status: 404,
        data: { code: 'not_found', message: 'No such article', secret: 'jane@bigcorp.com' },
      },
      config: { docsMetadata: { requestId: 'docs-404', startTime: Date.now() } },
    };

    const transformed = (client as any).transformError(mockAxiosError);

    expect(transformed.code).toBe('NOT_FOUND');
    expect(JSON.stringify(transformed)).not.toContain('jane@bigcorp.com');
  });
});
