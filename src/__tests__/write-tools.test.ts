import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('Write Tools', () => {
  let toolHandler: ToolHandler;
  const baseURL = 'https://api.helpscout.net/v2';

  beforeEach(() => {
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;

    nock.cleanAll();

    // Mock OAuth2 authentication
    // The auth endpoint is hardcoded to https://api.helpscout.net/v2/oauth2/token
    nock(baseURL)
      .persist()
      .post('/oauth2/token')
      .reply(200, {
        access_token: 'mock-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

    toolHandler = new ToolHandler();
  });

  afterEach(async () => {
    nock.cleanAll();
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('when writes are disabled', () => {
    beforeEach(() => {
      delete process.env.HELPSCOUT_ENABLE_WRITES;
    });

    it('should not list write tools when writes are disabled', async () => {
      const tools = await toolHandler.listTools();
      const toolNames = tools.map(t => t.name);

      expect(toolNames).not.toContain('createReply');
      expect(toolNames).not.toContain('updateConversationStatus');
      expect(toolNames).not.toContain('createNote');
    });

    it('should return error when calling createReply with writes disabled', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'createReply',
          arguments: {
            conversationId: '123',
            text: 'Hello',
            customer: { email: 'test@example.com' },
          },
        },
      };

      const result = await toolHandler.callTool(request);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.error.message).toContain('Write operations are disabled');
    });

    it('should return error when calling createNote with writes disabled', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'createNote',
          arguments: {
            conversationId: '123',
            text: 'Internal note',
          },
        },
      };

      const result = await toolHandler.callTool(request);
      expect(result.isError).toBe(true);
    });

    it('should return error when calling updateConversationStatus with writes disabled', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'updateConversationStatus',
          arguments: {
            conversationId: '123',
            status: 'closed',
          },
        },
      };

      const result = await toolHandler.callTool(request);
      expect(result.isError).toBe(true);
    });
  });

  describe('when writes are enabled', () => {
    beforeEach(() => {
      process.env.HELPSCOUT_ENABLE_WRITES = 'true';
    });

    afterEach(() => {
      delete process.env.HELPSCOUT_ENABLE_WRITES;
    });

    describe('createReply', () => {
      it('should create a draft reply by default', async () => {
        const scope = nock(baseURL)
          .post('/conversations/123/reply', (body: any) => {
            expect(body.text).toBe('Hello customer');
            expect(body.customer.email).toBe('test@example.com');
            expect(body.draft).toBe(true);
            return true;
          })
          .reply(201);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createReply',
            arguments: {
              conversationId: '123',
              text: 'Hello customer',
              customer: { email: 'test@example.com' },
            },
          },
        };

        const result = await toolHandler.callTool(request);
        const parsed = JSON.parse((result.content[0] as any).text);

        expect(parsed.success).toBe(true);
        expect(parsed.mode).toBe('draft');
        expect(parsed.action).toBe('reply_created');
        expect(scope.isDone()).toBe(true);
      });

      it('should create a sent reply when draft=false', async () => {
        const scope = nock(baseURL)
          .post('/conversations/456/reply', (body: any) => {
            expect(body.draft).toBe(false);
            return true;
          })
          .reply(201);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createReply',
            arguments: {
              conversationId: '456',
              text: 'Sent reply',
              customer: { email: 'customer@example.com' },
              draft: false,
            },
          },
        };

        const result = await toolHandler.callTool(request);
        const parsed = JSON.parse((result.content[0] as any).text);

        expect(parsed.success).toBe(true);
        expect(parsed.mode).toBe('sent');
        expect(parsed.warning).toContain('cannot be undone');
        expect(scope.isDone()).toBe(true);
      });

      it('should include cc and bcc when provided', async () => {
        const scope = nock(baseURL)
          .post('/conversations/123/reply', (body: any) => {
            expect(body.cc).toEqual(['cc@example.com']);
            expect(body.bcc).toEqual(['bcc@example.com']);
            return true;
          })
          .reply(201);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createReply',
            arguments: {
              conversationId: '123',
              text: 'Reply with cc',
              customer: { email: 'test@example.com' },
              cc: ['cc@example.com'],
              bcc: ['bcc@example.com'],
            },
          },
        };

        await toolHandler.callTool(request);
        expect(scope.isDone()).toBe(true);
      });

      it('should reject invalid customer email', async () => {
        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createReply',
            arguments: {
              conversationId: '123',
              text: 'Hello',
              customer: { email: 'not-an-email' },
            },
          },
        };

        const result = await toolHandler.callTool(request);
        expect(result.isError).toBe(true);
      });

      it('should reject empty text', async () => {
        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createReply',
            arguments: {
              conversationId: '123',
              text: '',
              customer: { email: 'test@example.com' },
            },
          },
        };

        const result = await toolHandler.callTool(request);
        expect(result.isError).toBe(true);
      });
    });

    describe('updateConversationStatus', () => {
      it('should update conversation status to closed', async () => {
        const scope = nock(baseURL)
          .patch('/conversations/123', (body: any) => {
            expect(body.op).toBe('replace');
            expect(body.path).toBe('/status');
            expect(body.value).toBe('closed');
            return true;
          })
          .reply(204);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'updateConversationStatus',
            arguments: {
              conversationId: '123',
              status: 'closed',
            },
          },
        };

        const result = await toolHandler.callTool(request);
        const parsed = JSON.parse((result.content[0] as any).text);

        expect(parsed.success).toBe(true);
        expect(parsed.newStatus).toBe('closed');
        expect(parsed.warning).toContain('automations');
        expect(scope.isDone()).toBe(true);
      });

      it('should update conversation status to active', async () => {
        const scope = nock(baseURL)
          .patch('/conversations/789', (body: any) => {
            expect(body.value).toBe('active');
            return true;
          })
          .reply(204);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'updateConversationStatus',
            arguments: {
              conversationId: '789',
              status: 'active',
            },
          },
        };

        const result = await toolHandler.callTool(request);
        const parsed = JSON.parse((result.content[0] as any).text);

        expect(parsed.success).toBe(true);
        expect(parsed.warning).toBeUndefined();
        expect(scope.isDone()).toBe(true);
      });

      it('should reject invalid status', async () => {
        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'updateConversationStatus',
            arguments: {
              conversationId: '123',
              status: 'spam',
            },
          },
        };

        const result = await toolHandler.callTool(request);
        expect(result.isError).toBe(true);
      });
    });

    describe('createNote', () => {
      it('should create an internal note', async () => {
        const scope = nock(baseURL)
          .post('/conversations/123/notes', (body: any) => {
            expect(body.text).toBe('Internal note text');
            return true;
          })
          .reply(201);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createNote',
            arguments: {
              conversationId: '123',
              text: 'Internal note text',
            },
          },
        };

        const result = await toolHandler.callTool(request);
        const parsed = JSON.parse((result.content[0] as any).text);

        expect(parsed.success).toBe(true);
        expect(parsed.action).toBe('note_created');
        expect(parsed.message).toContain('only visible to support agents');
        expect(scope.isDone()).toBe(true);
      });

      it('should reject empty note text', async () => {
        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createNote',
            arguments: {
              conversationId: '123',
              text: '',
            },
          },
        };

        const result = await toolHandler.callTool(request);
        expect(result.isError).toBe(true);
      });
    });

    describe('error handling', () => {
      it('should handle 412 precondition failed (thread limit)', async () => {
        nock(baseURL)
          .post('/conversations/123/notes')
          .reply(412, { message: 'Thread limit exceeded' });

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createNote',
            arguments: {
              conversationId: '123',
              text: 'Note',
            },
          },
        };

        const result = await toolHandler.callTool(request);
        expect(result.isError).toBe(true);
        const parsed = JSON.parse((result.content[0] as any).text);
        expect(parsed.error.message).toContain('precondition failed');
      });

      it('should handle 422 validation error', async () => {
        nock(baseURL)
          .post('/conversations/123/reply')
          .reply(422, { message: 'Invalid request' });

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'createReply',
            arguments: {
              conversationId: '123',
              text: 'Hello',
              customer: { email: 'test@example.com' },
            },
          },
        };

        const result = await toolHandler.callTool(request);
        expect(result.isError).toBe(true);
      });

      it('should handle 404 not found', async () => {
        nock(baseURL)
          .patch('/conversations/999')
          .reply(404, { message: 'Not found' });

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'updateConversationStatus',
            arguments: {
              conversationId: '999',
              status: 'active',
            },
          },
        };

        const result = await toolHandler.callTool(request);
        expect(result.isError).toBe(true);
      });
    });
  });
});
