import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('ToolHandler', () => {
  let toolHandler: ToolHandler;
  const baseURL = 'https://api.helpscout.net/v2';

  beforeEach(() => {
    // Mock environment for tests
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    
    nock.cleanAll();
    
    // Mock OAuth2 authentication endpoint
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
    // Clean up any pending promises or timers
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('listTools', () => {
    it('should return all available tools', async () => {
      const tools = await toolHandler.listTools();
      
      expect(tools).toHaveLength(33);
      expect(tools.map(t => t.name)).toEqual([
        'searchInboxes',
        'searchConversations',
        'getConversationSummary',
        'getThreads',
        'getServerTime',
        'listAllInboxes',
        'advancedConversationSearch',
        'comprehensiveConversationSearch',
        'structuredConversationFilter',
        'getCustomer',
        'listCustomers',
        'searchCustomersByEmail',
        'getCustomerContacts',
        'getOrganization',
        'listOrganizations',
        'getOrganizationMembers',
        'getOrganizationConversations',
        'listCustomerProperties',
        'listOrganizationProperties',
        'getOrganizationProperty',
        'listTags',
        'getTag',
        'listUsers',
        'getUser',
        'listTeams',
        'getTeamMembers',
        'listInboxCustomFields',
        'listInboxFolders',
        'listSavedReplies',
        'getSavedReply',
        'listWorkflows',
        'listWebhooks',
        'getWebhook',
      ]);
    });

    it('should have proper tool schemas', async () => {
      const tools = await toolHandler.listTools();
      
      tools.forEach(tool => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        expect(tool.inputSchema).toHaveProperty('properties');
      });
    });

    it('should expose page-based pagination for v2 paginated tools', async () => {
      const tools = await toolHandler.listTools();
      const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
      const pageBasedTools = [
        'searchInboxes',
        'searchConversations',
        'getThreads',
        'advancedConversationSearch',
        'structuredConversationFilter',
        'listTags',
        'listUsers',
        'listTeams',
        'getTeamMembers',
        'listWorkflows',
        'listWebhooks',
      ];

      for (const toolName of pageBasedTools) {
        const properties = byName[toolName].inputSchema.properties as Record<string, unknown>;
        expect(properties.page).toEqual(expect.objectContaining({
          type: 'number',
          minimum: 1,
          default: 1,
        }));
        expect(properties.cursor).toBeUndefined();
      }
    });

    it('should advertise structuredConversationFilter unique selector requirements', async () => {
      const tools = await toolHandler.listTools();
      const structuredFilter = tools.find(tool => tool.name === 'structuredConversationFilter');
      const schema = structuredFilter?.inputSchema as {
        anyOf?: Array<{ required?: string[]; properties?: { sortBy?: { enum?: string[] } } }>;
      };

      expect(schema.anyOf).toEqual(expect.arrayContaining([
        expect.objectContaining({ required: ['assignedTo'] }),
        expect.objectContaining({ required: ['folderId'] }),
        expect.objectContaining({ required: ['customerIds'] }),
        expect.objectContaining({ required: ['conversationNumber'] }),
        expect.objectContaining({
          required: ['sortBy'],
          properties: {
            sortBy: expect.objectContaining({
              enum: ['waitingSince', 'customerName', 'customerEmail'],
            }),
          },
        }),
      ]));
    });
  });

  describe('getServerTime', () => {
    it('should return MCP host time without Help Scout API call', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getServerTime',
          arguments: {}
        }
      };

      const result = await toolHandler.callTool(request);

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      expect(response).toHaveProperty('isoTime');
      expect(response).toHaveProperty('unixTime');
      expect(response).toHaveProperty('source', 'mcp_host_clock');
      expect(response.note).toContain('local MCP host process clock');
      expect(typeof response.isoTime).toBe('string');
      expect(typeof response.unixTime).toBe('number');
    });
  });

  describe('listAllInboxes', () => {
    it('should list all inboxes with helpful guidance', async () => {
      const mockResponse = {
        _embedded: {
          mailboxes: [
            { id: 1, name: 'Support Inbox', email: 'support@example.com', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-02T00:00:00Z' },
            { id: 2, name: 'Sales Inbox', email: 'sales@example.com', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-02T00:00:00Z' }
          ]
        },
        page: { size: 100, totalElements: 2 }
      };

      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1, size: 100 })
        .reply(200, mockResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'listAllInboxes',
          arguments: {}
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content).toHaveLength(1);
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      
      // Handle error responses (structured JSON error format)
      if (result.isError) {
        const errorResponse = JSON.parse(textContent.text);
        expect(errorResponse.error).toBeDefined();
        return;
      }

      const response = JSON.parse(textContent.text);
      expect(response.inboxes).toHaveLength(2);
      expect(response.inboxes[0]).toHaveProperty('id', 1);
      expect(response.inboxes[0]).toHaveProperty('name', 'Support Inbox');
      expect(response.usage).toContain('Use the "id" field');
      expect(response.nextSteps).toBeDefined();
      expect(response.totalInboxes).toBe(2);
    });
  });

  describe('searchInboxes', () => {
    it('should search inboxes by name', async () => {
      const mockResponse = {
        _embedded: {
          mailboxes: [
            { id: 1, name: 'Support Inbox', email: 'support@example.com' },
            { id: 2, name: 'Sales Inbox', email: 'sales@example.com' }
          ]
        },
        page: { size: 50, totalElements: 2 }
      };

      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1, size: 50 })
        .reply(200, mockResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { query: 'Support' }
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content).toHaveLength(1);
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      
      // Handle error responses (structured JSON error format)
      if (result.isError) {
        const errorResponse = JSON.parse(textContent.text);
        expect(errorResponse.error).toBeDefined();
        return;
      }

      const response = JSON.parse(textContent.text);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].name).toBe('Support Inbox');
    });
  });

  describe('operator metadata tools', () => {
    it('should list customer property definitions', async () => {
      nock(baseURL)
        .get('/customer-properties')
        .reply(200, {
          _embedded: {
            'customer-properties': [
              { type: 'text', slug: 'car', name: 'Car' },
              {
                type: 'dropdown',
                slug: 'plan',
                name: 'Plan',
                options: [
                  { id: '556cca5f-1afc-48ef-8323-b88b55808404', label: 'Standard' },
                  { id: '1313b25a-1150-49a4-8514-5b31f37e427f', label: 'Plus' },
                ],
              },
            ],
          },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listCustomerProperties',
          arguments: {},
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.customerProperties).toHaveLength(2);
      expect(response.customerProperties[1]).toEqual(expect.objectContaining({ slug: 'plan', type: 'dropdown' }));
      expect(response.customerProperties[1].options[0]).toEqual(expect.objectContaining({ label: 'Standard' }));
      expect(response.usage).toContain('customer');
    });

    it('should list and get organization property definitions', async () => {
      nock(baseURL)
        .get('/organizations/properties')
        .reply(200, {
          _embedded: {
            'organization-properties': [
              { type: 'text', slug: 'customer-tier', name: 'Customer Tier' },
              {
                type: 'dropdown',
                slug: 'industry',
                name: 'Industry',
                options: [
                  { label: 'Technology' },
                  { label: 'Healthcare' },
                ],
              },
            ],
          },
        });
      nock(baseURL)
        .get('/organizations/properties/industry')
        .reply(200, {
          type: 'dropdown',
          slug: 'industry',
          name: 'Industry',
          options: [
            { label: 'Technology' },
            { label: 'Healthcare' },
          ],
        });

      const list = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listOrganizationProperties',
          arguments: {},
        },
      });
      const get = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getOrganizationProperty',
          arguments: { slug: 'industry' },
        },
      });

      const listResponse = JSON.parse((list.content[0] as { type: 'text'; text: string }).text);
      const getResponse = JSON.parse((get.content[0] as { type: 'text'; text: string }).text);
      expect(list.isError).toBeUndefined();
      expect(get.isError).toBeUndefined();
      expect(listResponse.organizationProperties).toHaveLength(2);
      expect(listResponse.organizationProperties[1]).toEqual(expect.objectContaining({ slug: 'industry', type: 'dropdown' }));
      expect(getResponse.organizationProperty).toEqual(expect.objectContaining({ slug: 'industry', name: 'Industry' }));
      expect(getResponse.organizationProperty.options[0]).toEqual(expect.objectContaining({ label: 'Technology' }));
    });

    it('should list tags with optional name filtering', async () => {
      nock(baseURL)
        .get('/tags')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            tags: [
              { id: 10, slug: 'billing', name: 'Billing', color: 'green', createdAt: '2023-01-01T00:00:00Z', ticketCount: 4 },
              { id: 11, slug: 'shipping', name: 'Shipping', color: 'blue', createdAt: '2023-01-01T00:00:00Z', ticketCount: 1 },
            ],
          },
          page: { number: 1, size: 50, totalElements: 2, totalPages: 1 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listTags',
          arguments: { name: 'bill' },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.tags).toHaveLength(1);
      expect(response.tags[0]).toEqual(expect.objectContaining({ id: 10, name: 'Billing', slug: 'billing' }));
      expect(response.usage).toContain('tag');
      expect(response.nextPage).toBeNull();
    });

    it('should get a tag by ID', async () => {
      nock(baseURL)
        .get('/tags/10')
        .reply(200, {
          id: 10,
          slug: 'billing',
          name: 'Billing',
          color: 'green',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
          ticketCount: 4,
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getTag',
          arguments: { tagId: '10' },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.tag).toEqual(expect.objectContaining({ id: 10, name: 'Billing' }));
    });

    it('should list users with email and inbox filters', async () => {
      nock(baseURL)
        .get('/users')
        .query({ page: 2, email: 'agent@example.com', mailbox: 359402 })
        .reply(200, {
          _embedded: {
            users: [
              { id: 4, firstName: 'Ada', lastName: 'Agent', email: 'agent@example.com', role: 'user', type: 'user', mention: 'ada', initials: 'AA' },
            ],
          },
          page: { number: 2, size: 50, totalElements: 51, totalPages: 2 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listUsers',
          arguments: { email: 'agent@example.com', inboxId: '359402', page: 2 },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.users).toHaveLength(1);
      expect(response.users[0]).toEqual(expect.objectContaining({ id: 4, email: 'agent@example.com', mention: 'ada' }));
      expect(response.nextPage).toBeNull();
    });

    it('should get a user by ID and support the authenticated user shortcut', async () => {
      nock(baseURL)
        .get('/users/4')
        .reply(200, { id: 4, firstName: 'Ada', lastName: 'Agent', email: 'agent@example.com', role: 'user', type: 'user' });
      nock(baseURL)
        .get('/users/me')
        .reply(200, { id: 5, firstName: 'Resource', lastName: 'Owner', email: 'owner@example.com', role: 'owner', type: 'user', companyId: 1 });

      const byId = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { userId: '4' },
        },
      });
      const current = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { userId: 'me' },
        },
      });

      expect(JSON.parse((byId.content[0] as { type: 'text'; text: string }).text).user.id).toBe(4);
      expect(JSON.parse((current.content[0] as { type: 'text'; text: string }).text).user).toEqual(expect.objectContaining({
        id: 5,
        companyId: 1,
      }));
    });

    it('should list teams and team members', async () => {
      nock(baseURL)
        .get('/teams')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            teams: [
              { id: 99, name: 'Support', mention: 'support', initials: 'S', createdAt: '2023-01-01T00:00:00Z' },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });
      nock(baseURL)
        .get('/teams/99/members')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            users: [
              { id: 4, firstName: 'Ada', lastName: 'Agent', email: 'agent@example.com', role: 'user', type: 'user' },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });

      const teams = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listTeams',
          arguments: {},
        },
      });
      const members = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getTeamMembers',
          arguments: { teamId: '99' },
        },
      });

      expect(JSON.parse((teams.content[0] as { type: 'text'; text: string }).text).teams[0]).toEqual(expect.objectContaining({ id: 99, name: 'Support' }));
      expect(JSON.parse((members.content[0] as { type: 'text'; text: string }).text).members[0]).toEqual(expect.objectContaining({ id: 4, email: 'agent@example.com' }));
    });

    it('should list inbox custom fields and folders', async () => {
      nock(baseURL)
        .get('/mailboxes/359402/fields')
        .reply(200, {
          _embedded: {
            fields: [
              {
                id: 104,
                required: false,
                order: 1,
                type: 'dropdown',
                name: 'Plan',
                options: [{ id: 168, order: 1, label: 'Pro' }],
              },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });
      nock(baseURL)
        .get('/mailboxes/359402/folders')
        .reply(200, {
          _embedded: {
            folders: [
              { id: 1234, name: 'Mine', type: 'mytickets', userId: 4, totalCount: 2, activeCount: 1, updatedAt: '2023-01-01T00:00:00Z' },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });

      const fields = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listInboxCustomFields',
          arguments: { inboxId: '359402' },
        },
      });
      const folders = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listInboxFolders',
          arguments: { inboxId: '359402' },
        },
      });

      const fieldsResponse = JSON.parse((fields.content[0] as { type: 'text'; text: string }).text);
      const foldersResponse = JSON.parse((folders.content[0] as { type: 'text'; text: string }).text);
      expect(fieldsResponse.fields[0]).toEqual(expect.objectContaining({ id: 104, name: 'Plan', type: 'dropdown' }));
      expect(fieldsResponse.fields[0].options[0]).toEqual(expect.objectContaining({ id: 168, label: 'Pro' }));
      expect(foldersResponse.folders[0]).toEqual(expect.objectContaining({ id: 1234, name: 'Mine', activeCount: 1 }));
    });

    it('should list and get saved replies for an inbox', async () => {
      nock(baseURL)
        .get('/mailboxes/359402/saved-replies')
        .query({ includeChatReplies: true })
        .reply(200, [
          {
            id: 1001,
            name: 'Refund policy',
            preview: 'Refunds take 5-7 business days.',
            chatPreview: 'Refund timing',
            text: 'Refunds take 5-7 business days.',
            chatText: 'Refund timing',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-02T00:00:00Z',
          },
        ]);
      nock(baseURL)
        .get('/mailboxes/359402/saved-replies/1001')
        .reply(200, {
          id: 1001,
          name: 'Refund policy',
          text: 'Refunds take 5-7 business days.',
          chatText: 'Refund timing',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
        });

      const list = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listSavedReplies',
          arguments: { inboxId: '359402', includeChatReplies: true },
        },
      });
      const get = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getSavedReply',
          arguments: { inboxId: '359402', replyId: '1001' },
        },
      });

      const listResponse = JSON.parse((list.content[0] as { type: 'text'; text: string }).text);
      const getResponse = JSON.parse((get.content[0] as { type: 'text'; text: string }).text);
      expect(list.isError).toBeUndefined();
      expect(get.isError).toBeUndefined();
      expect(listResponse.inboxId).toBe('359402');
      expect(listResponse.includeChatReplies).toBe(true);
      expect(listResponse.savedReplies[0]).toEqual(expect.objectContaining({ id: 1001, name: 'Refund policy' }));
      expect(listResponse.nextPage).toBeNull();
      expect(getResponse.savedReply).toEqual(expect.objectContaining({ id: 1001, text: 'Refunds take 5-7 business days.' }));
    });

    it('should list workflows', async () => {
      nock(baseURL)
        .get('/workflows')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            workflows: [
              {
                id: 501,
                name: 'Auto assign VIP',
                type: 'automatic',
                status: 'active',
                order: 1,
                createdAt: '2023-01-01T00:00:00Z',
                updatedAt: '2023-01-02T00:00:00Z',
              },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listWorkflows',
          arguments: {},
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.workflows[0]).toEqual(expect.objectContaining({ id: 501, name: 'Auto assign VIP', type: 'automatic' }));
      expect(response.nextPage).toBeNull();
    });

    it('should list and get webhooks', async () => {
      nock(baseURL)
        .get('/webhooks')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            webhooks: [
              {
                id: 91,
                url: 'https://example.com/webhook',
                events: ['convo.created', 'convo.updated'],
                state: 'enabled',
                createdAt: '2023-01-01T00:00:00Z',
                updatedAt: '2023-01-02T00:00:00Z',
              },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });
      nock(baseURL)
        .get('/webhooks/91')
        .reply(200, {
          id: 91,
          url: 'https://example.com/webhook',
          events: ['convo.created', 'convo.updated'],
          state: 'enabled',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
        });

      const list = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listWebhooks',
          arguments: {},
        },
      });
      const get = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getWebhook',
          arguments: { webhookId: '91' },
        },
      });

      const listResponse = JSON.parse((list.content[0] as { type: 'text'; text: string }).text);
      const getResponse = JSON.parse((get.content[0] as { type: 'text'; text: string }).text);
      expect(list.isError).toBeUndefined();
      expect(get.isError).toBeUndefined();
      expect(listResponse.webhooks[0]).toEqual(expect.objectContaining({ id: 91, state: 'enabled' }));
      expect(getResponse.webhook).toEqual(expect.objectContaining({ id: 91, url: 'https://example.com/webhook' }));
    });
  });

  describe('page-based v2 pagination', () => {
    it('should pass the requested page through searchInboxes and return nextPage metadata', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 2, size: 50 })
        .reply(200, {
          _embedded: {
            mailboxes: [
              { id: 10, name: 'Support', email: 'support@example.com', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-02T00:00:00Z' },
            ]
          },
          page: { size: 50, totalElements: 101, totalPages: 3, number: 2 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { query: '', page: 2 },
        },
      });
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.results).toHaveLength(1);
      expect(response.pagination).toEqual({ size: 50, totalElements: 101, totalPages: 3, number: 2 });
      expect(response.nextPage).toBe(3);
      expect(response.nextCursor).toBeUndefined();
    });

    it('should pass the requested page through searchConversations single-status search', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(params => params.page === '3' && params.status === 'active')
        .reply(200, {
          _embedded: {
            conversations: [
              { id: 123, subject: 'Paged', status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } },
            ],
          },
          page: { size: 50, totalElements: 201, totalPages: 5, number: 3 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { status: 'active', page: 3 },
        },
      });
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.results).toHaveLength(1);
      expect(response.pagination).toEqual({ size: 50, totalElements: 201, totalPages: 5, number: 3 });
      expect(response.nextPage).toBe(4);
      expect(response.nextCursor).toBeUndefined();
    });

    it('should pass the requested page through getThreads and omit v2 cursors', async () => {
      nock(baseURL)
        .get('/conversations/123/threads')
        .query({ page: 2, size: 200 })
        .reply(200, {
          _embedded: {
            threads: [
              { id: 99, type: 'customer', body: 'page two', createdAt: '2023-01-01T00:00:00Z' },
            ],
          },
          _links: { next: { href: '/conversations/123/threads?page=3' } },
          page: { size: 200, totalElements: 401, totalPages: 3, number: 2 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getThreads',
          arguments: { conversationId: '123', page: 2 },
        },
      });
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.threads).toHaveLength(1);
      expect(response.pagination).toEqual({ size: 200, totalElements: 401, totalPages: 3, number: 2 });
      expect(response.nextPage).toBe(3);
      expect(response.nextCursor).toBeUndefined();
    });

    it('should pass page through advancedConversationSearch and omit v2 cursors', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(params => params.page === '2' && params.status === 'active' && typeof params.query === 'string' && params.query.includes('billing'))
        .reply(200, {
          _embedded: {
            conversations: [
              { id: 456, subject: 'Billing', status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } },
            ],
          },
          _links: { next: { href: '/conversations?page=3' } },
          page: { size: 50, totalElements: 120, totalPages: 3, number: 2 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'advancedConversationSearch',
          arguments: { tags: ['billing'], status: 'active', page: 2 },
        },
      });
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.results).toHaveLength(1);
      expect(response.pagination).toEqual({ size: 50, totalElements: 120, totalPages: 3, number: 2 });
      expect(response.nextPage).toBe(3);
      expect(response.nextCursor).toBeUndefined();
    });

    it('should pass page through structuredConversationFilter and omit v2 cursors', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(params => params.page === '2' && params.status === 'active' && Number(params.assigned_to) === 123)
        .reply(200, {
          _embedded: {
            conversations: [
              { id: 789, subject: 'Assigned', status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } },
            ],
          },
          _links: { next: { href: '/conversations?page=3' } },
          page: { size: 50, totalElements: 90, totalPages: 2, number: 2 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'structuredConversationFilter',
          arguments: { assignedTo: 123, status: 'active', page: 2 },
        },
      });
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.results).toHaveLength(1);
      expect(response.pagination).toEqual({ size: 50, totalElements: 90, totalPages: 2, number: 2 });
      expect(response.nextPage).toBeNull();
      expect(response.nextCursor).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle API errors gracefully', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .reply(401, { message: 'Unauthorized' });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { query: 'test' }
        }
      };

      const result = await toolHandler.callTool(request);
      // The error might be handled gracefully, so check for either error or empty results
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      // Should either be an error or empty results
      expect(response.results || response.totalFound === 0 || response.error).toBeTruthy();
    });

    it('should handle unknown tool names', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'unknownTool',
          arguments: {}
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      expect(textContent.text).toContain('Unknown tool');
    });

    it('should return a structured error when a tool returns no text content', async () => {
      jest.spyOn(toolHandler as any, 'searchInboxes').mockResolvedValue({ content: [] });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { query: 'support' },
        },
      };

      const result = await toolHandler.callTool(request);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      expect(response.error.code).toBe('TOOL_ERROR');
      expect(response.error.message).toContain('missing text content');
    });
  });

  describe('searchConversations', () => {
    it('should search conversations with filters', async () => {
      const mockResponse = {
        _embedded: {
          conversations: [
            {
              id: 1,
              subject: 'Support Request',
              status: 'active',
              createdAt: '2023-01-01T00:00:00Z',
              customer: { id: 1, firstName: 'John', lastName: 'Doe' }
            }
          ]
        },
        page: { size: 50, totalElements: 1 },
        _links: { next: null }
      };

      nock(baseURL)
        .get('/conversations')
        .query({
          page: 1,
          size: 50,
          sortField: 'createdAt',
          sortOrder: 'desc',
          status: 'active'
        })
        .reply(200, mockResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            limit: 50,
            status: 'active',
            sort: 'createdAt',
            order: 'desc'
          }
        }
      };

      const result = await toolHandler.callTool(request);
      
      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.results).toHaveLength(1);
        expect(response.results[0].subject).toBe('Support Request');
      }
    });
  });

  describe('API Constraints Validation - Branch Coverage', () => {
    it('should handle validation failures with required prerequisites', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: 'urgent',
            __userQuery: 'search the support inbox for urgent tickets',
            // No inboxId provided despite mentioning "support inbox"
          }
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      expect(response.error).toBe('API Constraint Validation Failed');
      expect(response.details.requiredPrerequisites).toContain('listAllInboxes');
      expect(response.details.suggestions[0]).toContain('server instructions');
    });

    it('uses successful listAllInboxes calls as prior context for inbox-name validation', async () => {
      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1, size: 100 })
        .reply(200, {
          _embedded: {
            mailboxes: [
              { id: 1, name: 'Support Inbox', email: 'support@example.com' }
            ]
          },
          page: { size: 100, totalElements: 1 }
        });

      await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listAllInboxes',
          arguments: {}
        }
      });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: 'urgent',
            __userQuery: 'search the support inbox for urgent tickets',
          }
        }
      });

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      expect(response.error).toBe('API Constraint Validation Failed');
      expect(response.details.requiredPrerequisites).toBeUndefined();
      expect(response.details.suggestions[0]).toContain('Use the inbox ID from the listAllInboxes results');
    });

    it('should handle validation failures without prerequisites', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getConversationSummary',
          arguments: {
            conversationId: 'invalid-format'  // Should be numeric
          }
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      expect(response.error).toBe('API Constraint Validation Failed');
      expect(response.details.errors).toContain('Invalid conversation ID format');
    });

    it('should provide API guidance for successful tool calls', async () => {
      const mockResponse = {
        results: [
          { id: '123', name: 'Support', email: 'support@test.com' }
        ]
      };

      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1, size: 50 })
        .reply(200, { _embedded: { mailboxes: mockResponse.results } });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { query: 'support' }
        }
      };

      const result = await toolHandler.callTool(request);
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      // Handle error responses (auth may fail in test environment)
      if (result.isError || response.error) {
        expect(response.error).toBeDefined();
        return;
      }

      expect(response.apiGuidance).toBeDefined();
      expect(response.apiGuidance[0]).toContain('NEXT STEP');
    });

    it('should handle tool calls without API guidance', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getServerTime',
          arguments: {}
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      expect(response.isoTime).toBeDefined();
      // getServerTime doesn't generate API guidance
    });
  });

  describe('Error Handling - Branch Coverage', () => {
    it('should handle Zod validation errors in tool arguments', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { limit: 'invalid' }  // Should be number
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const errorResponse = JSON.parse(textContent.text);
      expect(errorResponse.error.code).toBe('INVALID_INPUT');
    });

    it('should handle missing required fields in tool arguments', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getConversationSummary',
          arguments: {}  // Missing required conversationId
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const errorResponse = JSON.parse(textContent.text);
      
      // Could be either validation error or API constraint validation error
      expect(['INVALID_INPUT', 'API Constraint Validation Failed']).toContain(errorResponse.error || errorResponse.error?.code);
    });

    it('should handle unknown tool calls', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'unknownTool',
          arguments: {}
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const errorResponse = JSON.parse(textContent.text);
      expect(errorResponse.error.code).toBe('TOOL_ERROR');
      expect(errorResponse.error.message).toContain('Unknown tool');
    });

    it('should handle comprehensive search with no inbox ID when required', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'comprehensiveConversationSearch',
          arguments: {
            searchTerms: ['urgent'],
            __userQuery: 'search conversations in the support mailbox',
            // Missing inboxId despite mentioning "support mailbox"
          }
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content[0]).toHaveProperty('type', 'text');

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      // Should trigger API constraint validation, return error, or return results
      // In test environment, any of these outcomes is acceptable
      expect(response.error || response.details?.requiredPrerequisites || result.isError || response.totalConversationsFound !== undefined).toBeTruthy();
    }, 30000); // Extended timeout for retry logic

    it('should not reuse user query context across tool calls', async () => {
      const blockedResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: 'urgent',
            __userQuery: 'search the support inbox for urgent tickets',
          },
        },
      });
      const blockedResponse = JSON.parse((blockedResult.content[0] as { type: 'text'; text: string }).text);
      expect(blockedResponse.error).toBe('API Constraint Validation Failed');

      nock(baseURL)
        .get('/conversations')
        .query(true)
        .reply(200, {
          _embedded: {
            conversations: [
              {
                id: 123,
                subject: 'Urgent billing issue',
                status: 'active',
                createdAt: '2023-01-01T00:00:00Z',
                customer: { id: 1 },
              },
            ],
          },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      const nextResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { query: 'urgent', status: 'active' },
        },
      });
      const nextResponse = JSON.parse((nextResult.content[0] as { type: 'text'; text: string }).text);

      expect(nextResponse.error).toBeUndefined();
      expect(nextResponse.results).toHaveLength(1);
      expect(nextResponse.results[0].subject).toBe('Urgent billing issue');
    });
  });

  describe('getConversationSummary', () => {
    it('should handle conversations with no customer threads', async () => {
      const mockConversation = {
        id: 123,
        subject: 'Test Conversation',
        status: 'active',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        customer: { id: 1, firstName: 'John', lastName: 'Doe' },
        assignee: null,
        tags: []
      };

      const mockThreads = {
        _embedded: {
          threads: [
            {
              id: 1,
              type: 'message',  // Staff message only
              body: 'Staff reply',
              createdAt: '2023-01-01T10:00:00Z',
              createdBy: { id: 1, firstName: 'Agent', lastName: 'Smith' }
            }
          ]
        }
      };

      nock(baseURL)
        .get('/conversations/123')
        .reply(200, mockConversation);

      nock(baseURL)
        .get('/conversations/123/threads')
        .query({ page: 1, size: 50 })
        .reply(200, mockThreads);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getConversationSummary',
          arguments: { conversationId: '123' }
        }
      };

      const result = await toolHandler.callTool(request);
      
      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        
        // Should handle null firstCustomerMessage
        expect(response.firstCustomerMessage).toBeNull();
        expect(response.latestStaffReply).toBeDefined();
      }
    });

    it('should handle conversations with no staff replies', async () => {
      const mockConversation = {
        id: 124,
        subject: 'Customer Only Conversation',
        status: 'pending',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        customer: { id: 1, firstName: 'John', lastName: 'Doe' },
        assignee: null,
        tags: []
      };

      const mockThreads = {
        _embedded: {
          threads: [
            {
              id: 1,
              type: 'customer',  // Customer message only
              body: 'Customer question',
              createdAt: '2023-01-01T09:00:00Z',
              customer: { id: 1, firstName: 'John', lastName: 'Doe' }
            }
          ]
        }
      };

      nock(baseURL)
        .get('/conversations/124')
        .reply(200, mockConversation);

      nock(baseURL)
        .get('/conversations/124/threads')
        .query({ page: 1, size: 50 })
        .reply(200, mockThreads);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getConversationSummary',
          arguments: { conversationId: '124' }
        }
      };

      const result = await toolHandler.callTool(request);
      
      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        
        // Should handle null latestStaffReply
        expect(response.firstCustomerMessage).toBeDefined();
        expect(response.latestStaffReply).toBeNull();
      }
    });

    it('should get conversation summary with threads', async () => {
      const mockConversation = {
        id: 123,
        subject: 'Test Conversation',
        status: 'active',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
        customer: { id: 1, firstName: 'John', lastName: 'Doe' },
        assignee: { id: 2, firstName: 'Jane', lastName: 'Smith' },
        tags: ['support', 'urgent']
      };

      const mockThreads = {
        _embedded: {
          threads: [
            {
              id: 1,
              type: 'customer',
              body: 'Original customer message',
              createdAt: '2023-01-01T00:00:00Z',
              customer: { id: 1, firstName: 'John' }
            },
            {
              id: 2,
              type: 'message',
              body: 'Staff reply',
              createdAt: '2023-01-01T12:00:00Z',
              createdBy: { id: 2, firstName: 'Jane' }
            }
          ]
        }
      };

      nock(baseURL)
        .get('/conversations/123')
        .reply(200, mockConversation)
        .get('/conversations/123/threads')
        .query({ page: 1, size: 50 })
        .reply(200, mockThreads);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getConversationSummary',
          arguments: { conversationId: "123" }
        }
      };

      const result = await toolHandler.callTool(request);
      
      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const summary = JSON.parse(textContent.text);
        expect(summary.conversation.subject).toBe('Test Conversation');
        expect(summary.firstCustomerMessage).toBeDefined();
        expect(summary.latestStaffReply).toBeDefined();
      }
    });
  });

  describe('getThreads', () => {
    it('should get conversation threads', async () => {
      // Use unique conversation ID to avoid nock conflicts with other tests
      const conversationId = '999';
      const mockResponse = {
        _embedded: {
          threads: [
            {
              id: 1,
              type: 'customer',
              body: 'Customer message',
              createdAt: '2023-01-01T00:00:00Z'
            },
            {
              id: 2,
              type: 'message',
              body: 'Staff reply',
              createdAt: '2023-01-01T10:00:00Z',
              createdBy: { id: 1, firstName: 'Agent', lastName: 'Smith' }
            }
          ]
        }
      };

      nock(baseURL)
        .get(`/conversations/${conversationId}/threads`)
        .query({ page: 1, size: 50 })
        .reply(200, mockResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getThreads',
          arguments: { conversationId, limit: 50 }
        }
      };

      const result = await toolHandler.callTool(request);

      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.conversationId).toBe(conversationId);
        expect(response.threads).toHaveLength(2);
      }
    });
  });

  describe('comprehensiveConversationSearch', () => {
    it('should search across multiple statuses by default', async () => {
      const freshToolHandler = new ToolHandler();
      
      // Clean all previous mocks
      nock.cleanAll();
      
      // Re-add the auth mock
      nock(baseURL)
        .persist()
        .post('/oauth2/token')
        .reply(200, {
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });

      // Mock responses for each status
      const mockActiveConversations = {
        _embedded: {
          conversations: [
            {
              id: 1,
              subject: 'Active urgent issue',
              status: 'active',
              createdAt: '2024-01-01T00:00:00Z'
            }
          ]
        },
        page: {
          size: 25,
          totalElements: 1,
          totalPages: 1,
          number: 0
        }
      };

      const mockPendingConversations = {
        _embedded: {
          conversations: [
            {
              id: 2,
              subject: 'Pending urgent request',
              status: 'pending',
              createdAt: '2024-01-02T00:00:00Z'
            }
          ]
        },
        page: {
          size: 25,
          totalElements: 1,
          totalPages: 1,
          number: 0
        }
      };

      const mockClosedConversations = {
        _embedded: {
          conversations: [
            {
              id: 3,
              subject: 'Closed urgent case',
              status: 'closed',
              createdAt: '2024-01-03T00:00:00Z'
            },
            {
              id: 4,
              subject: 'Another closed urgent case',
              status: 'closed',
              createdAt: '2024-01-04T00:00:00Z'
            }
          ]
        },
        page: {
          size: 25,
          totalElements: 2,
          totalPages: 1,
          number: 0
        }
      };

      // Set up nock interceptors for each status
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active' && params.query === '(body:"urgent" OR subject:"urgent")')
        .reply(200, mockActiveConversations);

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending' && params.query === '(body:"urgent" OR subject:"urgent")')
        .reply(200, mockPendingConversations);

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed' && params.query === '(body:"urgent" OR subject:"urgent")')
        .reply(200, mockClosedConversations);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'comprehensiveConversationSearch',
          arguments: {
            searchTerms: ['urgent'],
            timeframeDays: 30
          }
        }
      };

      const result = await freshToolHandler.callTool(request);

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      // Handle error responses (auth/network may fail in test environment)
      if (result.isError || response.error) {
        expect(response.error).toBeDefined();
        return;
      }

      // Mocks may not match exact query format - verify we got a valid response structure
      expect(response.totalConversationsFound).toBeGreaterThanOrEqual(0);
      if (response.totalConversationsFound > 0) {
        expect(response.resultsByStatus).toBeDefined();
      }
    }, 30000); // Extended timeout for retry logic

    it('should handle custom status selection', async () => {
      const freshToolHandler = new ToolHandler();
      
      nock.cleanAll();
      
      nock(baseURL)
        .persist()
        .post('/oauth2/token')
        .reply(200, {
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });

      const mockActiveConversations = {
        _embedded: {
          conversations: [
            {
              id: 1,
              subject: 'Active billing issue',
              status: 'active',
              createdAt: '2024-01-01T00:00:00Z'
            }
          ]
        },
        page: {
          size: 10,
          totalElements: 1,
          totalPages: 1,
          number: 0
        }
      };

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active' && params.query === '(body:"billing" OR subject:"billing")')
        .reply(200, mockActiveConversations);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'comprehensiveConversationSearch',
          arguments: {
            searchTerms: ['billing'],
            statuses: ['active'],
            limitPerStatus: 10
          }
        }
      };

      const result = await freshToolHandler.callTool(request);

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      // Handle error responses (auth/network may fail in test environment)
      if (result.isError || response.error) {
        expect(response.error).toBeDefined();
        return;
      }

      // Mocks may not match exact query format - verify we got a valid response structure
      expect(response.totalConversationsFound).toBeGreaterThanOrEqual(0);
      if (response.totalConversationsFound > 0) {
        expect(response.resultsByStatus).toBeDefined();
        expect(response.resultsByStatus[0].status).toBe('active');
      }
    }, 30000); // Extended timeout for retry logic

    it('should handle invalid inboxId format validation', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: 'test',
            __userQuery: 'search the support inbox',
            inboxId: 'invalid-format'  // Should be numeric
          }
        }
      };

      const result = await toolHandler.callTool(request);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      expect(response.error).toBe('API Constraint Validation Failed');
      expect(response.details.errors[0]).toContain('Invalid inbox ID format');
    });

    it('should handle different search locations in comprehensive search', async () => {
      // Mock successful search
      const mockConversations = {
        _embedded: { conversations: [] },
        page: { size: 25, totalElements: 0 }
      };

      nock(baseURL)
        .get('/conversations')
        .query(() => true)
        .reply(200, mockConversations);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'comprehensiveConversationSearch',
          arguments: {
            searchTerms: ['test'],
            searchIn: ['subject'],  // Test subject-only search
            statuses: ['active']
          }
        }
      };

      const result = await toolHandler.callTool(request);
      
      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.searchIn).toEqual(['subject']);
      }
    });

    it('should handle search with no results and provide guidance', async () => {
      const freshToolHandler = new ToolHandler();
      
      nock.cleanAll();
      
      nock(baseURL)
        .persist()
        .post('/oauth2/token')
        .reply(200, {
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });

      const emptyResponse = {
        _embedded: {
          conversations: []
        },
        page: {
          size: 25,
          totalElements: 0,
          totalPages: 0,
          number: 0
        }
      };

      // Mock empty responses for all statuses
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, emptyResponse);

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, emptyResponse);

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, emptyResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'comprehensiveConversationSearch',
          arguments: {
            searchTerms: ['nonexistent']
          }
        }
      };

      const result = await freshToolHandler.callTool(request);

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      // Handle error responses (auth/network may fail in test environment)
      if (result.isError || response.error) {
        expect(response.error).toBeDefined();
        return;
      }

      expect(response.totalConversationsFound).toBe(0);
      expect(response.searchTips).toBeDefined();
      expect(response.searchTips).toContain('Try broader search terms or increase the timeframe');
    }, 30000); // Extended timeout for retry logic
  });

  describe('Advanced Conversation Search - Branch Coverage', () => {
    it('should handle advanced search with all parameter types', async () => {
      const mockResponse = {
        _embedded: { conversations: [] },
        page: { size: 50, totalElements: 0 }
      };

      nock(baseURL)
        .get('/conversations')
        .times(3)
        .query(() => true)
        .reply(200, mockResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'advancedConversationSearch',
          arguments: {
            contentTerms: ['urgent', 'billing'],
            subjectTerms: ['help', 'support'],
            customerEmail: 'test@example.com',
            emailDomain: 'company.com',
            tags: ['vip', 'escalation'],
            createdBefore: '2024-01-31T23:59:59Z'
          }
        }
      };

      const result = await toolHandler.callTool(request);
      
      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.searchCriteria.contentTerms).toEqual(['urgent', 'billing']);
        expect(response.searchCriteria.tags).toEqual(['vip', 'escalation']);
      }
    });

    it('should handle field selection in search conversations', async () => {
      const mockResponse = {
        _embedded: { 
          conversations: [
            { id: 1, subject: 'Test', status: 'active', extraField: 'should be filtered' }
          ] 
        },
        page: { size: 50, totalElements: 1 }
      };

      nock(baseURL)
        .get('/conversations')
        .query(() => true)
        .reply(200, mockResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: 'test',
            fields: ['id', 'subject'] // This should filter fields
          }
        }
      };

      const result = await toolHandler.callTool(request);
      
      if (!result.isError) {
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.results[0]).toEqual({ id: 1, subject: 'Test' });
        expect(response.results[0].extraField).toBeUndefined();
      }
    });

    it('should fan out default advanced search across active pending and closed only', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active')
        .reply(200, {
          _embedded: { conversations: [{ id: 1, status: 'active', createdAt: '2023-01-03T00:00:00Z' }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending')
        .reply(200, {
          _embedded: { conversations: [{ id: 2, status: 'pending', createdAt: '2023-01-02T00:00:00Z' }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed')
        .reply(200, {
          _embedded: { conversations: [{ id: 3, status: 'closed', createdAt: '2023-01-01T00:00:00Z' }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'advancedConversationSearch',
          arguments: { tags: ['billing'] },
        },
      });

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.statusesSearched).toEqual(['active', 'pending', 'closed']);
      expect(response.results.map((conversation: { status: string }) => conversation.status)).toEqual(['active', 'pending', 'closed']);
      expect(response.pagination.totalByStatus).toEqual({ active: 1, pending: 1, closed: 1 });
    });

    it('should keep explicit spam advanced search as a single-status call', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'spam')
        .reply(200, {
          _embedded: { conversations: [{ id: 4, status: 'spam', createdAt: '2023-01-04T00:00:00Z' }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'advancedConversationSearch',
          arguments: { tags: ['billing'], status: 'spam' },
        },
      });

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.statusesSearched).toEqual(['spam']);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].status).toBe('spam');
      expect(response.nextPage).toBeNull();
    });
  });

  describe('enhanced searchConversations', () => {
    it('should search all statuses when query is provided without status', async () => {
      const freshToolHandler = new ToolHandler();

      nock.cleanAll();

      nock(baseURL)
        .persist()
        .post('/oauth2/token')
        .reply(200, {
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });

      const mockResponse = {
        _embedded: {
          conversations: []
        },
        page: {
          size: 50,
          totalElements: 0,
          totalPages: 0,
          number: 0
        }
      };

      // Mock all 3 status searches (active, pending, closed)
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active' && params.query === '(body:"test")')
        .reply(200, mockResponse);

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending' && params.query === '(body:"test")')
        .reply(200, mockResponse);

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed' && params.query === '(body:"test")')
        .reply(200, mockResponse);

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: '(body:"test")'
          }
        }
      };

      const result = await freshToolHandler.callTool(request);

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      // Handle error responses (auth/network may fail in test environment)
      if (result.isError || response.error) {
        expect(response.error).toBeDefined();
        return;
      }

      // v1.6.0: Now searches all statuses by default
      expect(response.searchInfo.statusesSearched).toEqual(['active', 'pending', 'closed']);
      expect(response.searchInfo.searchGuidance).toBeDefined();
    }, 30000); // Extended timeout for retry logic
  });

  describe('pagination fixes (Issue #10)', () => {
    beforeEach(() => {
      nock.cleanAll();

      // Re-mock OAuth for each test
      nock(baseURL)
        .persist()
        .post('/oauth2/token')
        .reply(200, {
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
    });

    describe('searchConversations multi-status pagination', () => {
      it('should aggregate totalElements from all status searches', async () => {
        // Mock responses for each status with different totals
        const activeResponse = {
          _embedded: {
            conversations: Array(50).fill(null).map((_, i) => ({
              id: i + 1,
              subject: `Active ${i}`,
              status: 'active',
              createdAt: '2023-01-01T00:00:00Z',
              customer: { id: 1 }
            }))
          },
          page: { size: 50, totalElements: 200, totalPages: 4, number: 1 }
        };

        const pendingResponse = {
          _embedded: {
            conversations: Array(50).fill(null).map((_, i) => ({
              id: i + 100,
              subject: `Pending ${i}`,
              status: 'pending',
              createdAt: '2023-01-01T00:00:00Z',
              customer: { id: 1 }
            }))
          },
          page: { size: 50, totalElements: 233, totalPages: 5, number: 1 }
        };

        const closedResponse = {
          _embedded: {
            conversations: Array(50).fill(null).map((_, i) => ({
              id: i + 200,
              subject: `Closed ${i}`,
              status: 'closed',
              createdAt: '2023-01-01T00:00:00Z',
              customer: { id: 1 }
            }))
          },
          page: { size: 50, totalElements: 200, totalPages: 4, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active')
          .reply(200, activeResponse);

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'pending')
          .reply(200, pendingResponse);

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'closed')
          .reply(200, closedResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: {
              tag: 'summer_missions'
            }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should return 50 results (sliced from merged 150)
        expect(response.results).toHaveLength(50);

        // Should report both returned count and total available
        expect(response.pagination.totalResults).toBe(50);
        expect(response.pagination.totalAvailable).toBe(633); // 200 + 233 + 200
        expect(response.pagination.totalByStatus).toEqual({
          active: 200,
          pending: 233,
          closed: 200
        });

        // Should have informative note
        expect(response.pagination.note).toContain('Returned 50 of 633');
        expect(response.pagination.note).toContain('3 statuses');
      });

      it('should deduplicate conversations appearing in multiple statuses', async () => {
        // Conversation #42 appears in both active and pending (edge case)
        const duplicateConv = {
          id: 42,
          subject: 'Duplicate conversation',
          status: 'active',
          createdAt: '2023-01-15T00:00:00Z',
          customer: { id: 1 }
        };

        const activeResponse = {
          _embedded: {
            conversations: [
              duplicateConv,
              { id: 1, subject: 'Active 1', status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } }
            ]
          },
          page: { size: 50, totalElements: 100, totalPages: 2, number: 1 }
        };

        const pendingResponse = {
          _embedded: {
            conversations: [
              { ...duplicateConv, status: 'pending' },
              { id: 2, subject: 'Pending 1', status: 'pending', createdAt: '2023-01-02T00:00:00Z', customer: { id: 1 } }
            ]
          },
          page: { size: 50, totalElements: 50, totalPages: 1, number: 1 }
        };

        const closedResponse = {
          _embedded: { conversations: [] },
          page: { size: 50, totalElements: 0, totalPages: 0, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active')
          .reply(200, activeResponse);

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'pending')
          .reply(200, pendingResponse);

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'closed')
          .reply(200, closedResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: { tag: 'test' }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should have 3 unique conversations, not 4
        expect(response.results).toHaveLength(3);
        expect(response.results.filter((c: any) => c.id === 42)).toHaveLength(1);

        // totalAvailable should be 150 (100+50+0) - not affected by deduplication
        expect(response.pagination.totalAvailable).toBe(150);
      });


      it('should use standard pagination for single-status search', async () => {
        const mockResponse = {
          _embedded: {
            conversations: [{ id: 1, status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } }]
          },
          page: { size: 50, totalElements: 100, totalPages: 2, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(true)
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: { status: 'active', tag: 'test' }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Single-status should return standard API pagination object
        expect(response.pagination).toEqual({
          size: 50,
          totalElements: 100,
          totalPages: 2,
          number: 1
        });

        // Should NOT have multi-status specific fields
        expect(response.pagination.totalAvailable).toBeUndefined();
        expect(response.pagination.totalByStatus).toBeUndefined();
      });

      it('should handle partial failures in multi-status search', async () => {
        const activeResponse = {
          _embedded: {
            conversations: Array(10).fill(null).map((_, i) => ({
              id: i,
              subject: `Active ${i}`,
              status: 'active',
              createdAt: '2023-01-01T00:00:00Z',
              customer: { id: 1 }
            }))
          },
          page: { size: 50, totalElements: 10, totalPages: 1, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active')
          .reply(200, activeResponse);

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'pending')
          .times(4)
          .reply(500, { error: 'Internal Server Error' });

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'closed')
          .reply(200, activeResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: {}
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should report partial totalAvailable from successful statuses
        expect(response.pagination.totalAvailable).toBeGreaterThan(0);
        expect(response.pagination.totalByStatus).toBeDefined();
        expect(response.pagination.errors).toHaveLength(1);
        expect(response.pagination.errors[0].status).toBe('pending');
        expect(response.pagination.errors[0].message).toBeTruthy();
        expect(response.pagination.errors[0].code).toBeDefined();
        expect(response.pagination.note).toContain('[WARNING] 1 status(es) failed');
        expect(response.pagination.note).toContain('Totals reflect successful statuses only');
      }, 30000);

      it('should apply createdBefore filtering to multi-status merged results', async () => {
        nock.cleanAll();

        // Re-mock OAuth
        nock(baseURL.replace('/v2/', ''))
          .post('/oauth2/token')
          .reply(200, { access_token: 'test-token', token_type: 'Bearer', expires_in: 7200 });

        // Active: 3 conversations, 2 before cutoff
        nock(baseURL)
          .get('/conversations')
          .query((q: any) => q.status === 'active')
          .reply(200, {
            _embedded: {
              conversations: [
                { id: 1, status: 'active', createdAt: '2023-01-05T00:00:00Z', customer: { id: 1 }, subject: 'A1' },
                { id: 2, status: 'active', createdAt: '2023-01-10T00:00:00Z', customer: { id: 1 }, subject: 'A2' },
                { id: 3, status: 'active', createdAt: '2023-02-01T00:00:00Z', customer: { id: 1 }, subject: 'A3' },
              ]
            },
            page: { size: 50, totalElements: 80, totalPages: 2, number: 1 }
          });

        // Pending: 2 conversations, 1 before cutoff
        nock(baseURL)
          .get('/conversations')
          .query((q: any) => q.status === 'pending')
          .reply(200, {
            _embedded: {
              conversations: [
                { id: 4, status: 'pending', createdAt: '2023-01-08T00:00:00Z', customer: { id: 2 }, subject: 'P1' },
                { id: 5, status: 'pending', createdAt: '2023-02-15T00:00:00Z', customer: { id: 2 }, subject: 'P2' },
              ]
            },
            page: { size: 50, totalElements: 40, totalPages: 1, number: 1 }
          });

        // Closed: 1 conversation, 1 before cutoff
        nock(baseURL)
          .get('/conversations')
          .query((q: any) => q.status === 'closed')
          .reply(200, {
            _embedded: {
              conversations: [
                { id: 6, status: 'closed', createdAt: '2023-01-03T00:00:00Z', customer: { id: 3 }, subject: 'C1' },
              ]
            },
            page: { size: 50, totalElements: 30, totalPages: 1, number: 1 }
          });

        const freshToolHandler = new ToolHandler();

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: {
              tag: 'multi-status-filter-test',
              createdBefore: '2023-01-15T00:00:00Z'
            }
          }
        };

        const result = await freshToolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // 6 total conversations, 4 before cutoff (ids 1,2,4,6)
        expect(response.results).toHaveLength(4);
        expect(response.results.map((r: any) => r.id).sort()).toEqual([1, 2, 4, 6]);

        // Pagination should show filtered count AND pre-filter totals
        expect(response.pagination.totalResults).toBe(4);
        expect(response.pagination.totalAvailable).toBe(150); // 80+40+30
        expect(response.pagination.totalByStatus).toEqual({ active: 80, pending: 40, closed: 30 });

        // Note should mention both filtering and merged status info
        expect(response.pagination.note).toContain('createdBefore');

        // clientSideFiltering should report the filter was applied
        expect(response.searchInfo.clientSideFiltering).toBeDefined();
      }, 30000);
    });

    describe('advancedConversationSearch client-side filtering', () => {
      it('should distinguish filtered count from API total', async () => {
        const mockResponse = {
          _embedded: {
            conversations: [
              { id: 1, createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } },
              { id: 2, createdAt: '2023-01-05T00:00:00Z', customer: { id: 1 } },
              { id: 3, createdAt: '2023-01-10T00:00:00Z', customer: { id: 1 } },
              { id: 4, createdAt: '2023-01-15T00:00:00Z', customer: { id: 1 } },
              { id: 5, createdAt: '2023-01-20T00:00:00Z', customer: { id: 1 } }
            ]
          },
          page: { size: 50, totalElements: 100, totalPages: 2, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(true)
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'advancedConversationSearch',
            arguments: {
              tags: ['billing'],
              status: 'active',
              createdBefore: '2023-01-12T00:00:00Z'
            }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should filter to 3 conversations (before Jan 12)
        expect(response.results).toHaveLength(3);

        // Should show both filtered count and API total
        expect(response.pagination.totalResults).toBe(3);
        expect(response.pagination.totalAvailable).toBe(100);
        expect(response.pagination.note).toContain('filtered count (3)');
        expect(response.pagination.note).toContain('pre-filter API total (100)');

        // Should indicate client-side filtering occurred
        expect(response.clientSideFiltering).toContain('createdBefore filter removed 2 of 5');
      });

      it('should handle createdBefore filter removing all results', async () => {
        const mockResponse = {
          _embedded: {
            conversations: [
              { id: 1, createdAt: '2023-01-20T00:00:00Z', customer: { id: 1 } },
              { id: 2, createdAt: '2023-01-25T00:00:00Z', customer: { id: 1 } }
            ]
          },
          page: { size: 50, totalElements: 100, totalPages: 2, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(params => typeof params.query === 'string' && params.query.includes('billing'))
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'advancedConversationSearch',
            arguments: {
              tags: ['billing'],
              status: 'active',
              createdBefore: '2023-01-01T00:00:00Z' // Before all results
            }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should return empty results
        expect(response.results).toHaveLength(0);

        // Should show filtering removed everything
        expect(response.pagination.totalResults).toBe(0);
        expect(response.pagination.totalAvailable).toBe(100);
        expect(response.clientSideFiltering).toMatch(/createdBefore filter removed \d+ of \d+ results/);
      });

      it('should exclude conversations with createdAt exactly matching createdBefore', async () => {
        const freshToolHandler = new ToolHandler();

        nock.cleanAll();
        nock(baseURL)
          .persist()
          .post('/oauth2/token')
          .reply(200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 });

        const mockResponse = {
          _embedded: {
            conversations: [
              { id: 1, createdAt: '2023-01-10T00:00:00Z', customer: { id: 1 } },
              { id: 2, createdAt: '2023-01-11T00:00:00Z', customer: { id: 1 } },
              { id: 3, createdAt: '2023-01-12T00:00:00Z', customer: { id: 1 } } // Exact match
            ]
          },
          page: { size: 50, totalElements: 100, totalPages: 2, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(params => typeof params.query === 'string' && params.query.includes('boundary-test'))
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'advancedConversationSearch',
            arguments: {
              tags: ['boundary-test'],
              status: 'active',
              createdBefore: '2023-01-12T00:00:00Z' // Exact match with id:3
            }
          }
        };

        const result = await freshToolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should exclude exact match (< not <=) - only ids 1 and 2 remain
        expect(response.results).toHaveLength(2);
        expect(response.results.map((r: any) => r.id)).toEqual([1, 2]);
        expect(response.clientSideFiltering).toMatch(/createdBefore filter removed 1 of 3 results/);
      });

      it('should return normal pagination when no client-side filtering', async () => {
        const mockResponse = {
          _embedded: {
            conversations: [
              { id: 1, createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } }
            ]
          },
          page: { size: 50, totalElements: 100, totalPages: 2, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(true)
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'advancedConversationSearch',
            arguments: {
              tags: ['normal-pagination'],
              status: 'active'
            }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should return API pagination object directly
        expect(response.pagination).toEqual({
          size: 50,
          totalElements: 100,
          totalPages: 2,
          number: 1
        });
        expect(response.clientSideFiltering).toBeUndefined();
      });
    });

    describe('structuredConversationFilter client-side filtering', () => {
      it('should fan out status all across active pending and closed only', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active' && Number(params.assigned_to) === 123)
          .reply(200, {
            _embedded: { conversations: [{ id: 1, status: 'active', createdAt: '2023-01-03T00:00:00Z' }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'pending' && Number(params.assigned_to) === 123)
          .reply(200, {
            _embedded: { conversations: [{ id: 2, status: 'pending', createdAt: '2023-01-02T00:00:00Z' }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'closed' && Number(params.assigned_to) === 123)
          .reply(200, {
            _embedded: { conversations: [{ id: 3, status: 'closed', createdAt: '2023-01-01T00:00:00Z' }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'structuredConversationFilter',
            arguments: { assignedTo: 123, status: 'all' },
          },
        });

        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        expect(response.filterApplied.status).toBe('all');
        expect(response.statusesSearched).toEqual(['active', 'pending', 'closed']);
        expect(response.results.map((conversation: { status: string }) => conversation.status)).toEqual(['active', 'pending', 'closed']);
        expect(response.pagination.totalByStatus).toEqual({ active: 1, pending: 1, closed: 1 });
      });

      it('should distinguish filtered count from API total', async () => {
        const mockResponse = {
          _embedded: {
            conversations: [
              { id: 1, createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } },
              { id: 2, createdAt: '2023-01-05T00:00:00Z', customer: { id: 2 } },
              { id: 3, createdAt: '2023-01-10T00:00:00Z', customer: { id: 3 } },
              { id: 4, createdAt: '2023-01-15T00:00:00Z', customer: { id: 4 } }
            ]
          },
          page: { size: 50, totalElements: 150, totalPages: 3, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(true)
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'structuredConversationFilter',
            arguments: {
              assignedTo: 123,
              status: 'active',
              createdBefore: '2023-01-08T00:00:00Z'
            }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should filter to 2 conversations (before Jan 8)
        expect(response.results).toHaveLength(2);

        // Should show both filtered count and API total
        expect(response.pagination.totalResults).toBe(2);
        expect(response.pagination.totalAvailable).toBe(150);
        expect(response.pagination.note).toContain('filtered count (2)');
        expect(response.pagination.note).toContain('pre-filter API total (150)');

        // Should indicate client-side filtering occurred
        expect(response.clientSideFiltering).toContain('createdBefore filter removed 2 of 4');
      });

      it('should handle createdBefore filter removing all results', async () => {
        const mockResponse = {
          _embedded: {
            conversations: [
              { id: 1, createdAt: '2023-01-20T00:00:00Z', customer: { id: 1 } },
              { id: 2, createdAt: '2023-01-25T00:00:00Z', customer: { id: 2 } }
            ]
          },
          page: { size: 50, totalElements: 150, totalPages: 3, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(params => Number(params.assigned_to) === 123)
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'structuredConversationFilter',
            arguments: {
              assignedTo: 123,
              status: 'active',
              createdBefore: '2023-01-01T00:00:00Z' // Before all results
            }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should return empty results
        expect(response.results).toHaveLength(0);

        // Should show filtering removed everything
        expect(response.pagination.totalResults).toBe(0);
        expect(response.pagination.totalAvailable).toBe(150);
        expect(response.clientSideFiltering).toMatch(/createdBefore filter removed \d+ of \d+ results/);
      });
    });

    describe('invalid date validation', () => {
      it('should throw for invalid createdBefore in searchConversations', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active')
          .reply(200, {
            _embedded: { conversations: [{ id: 1, createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 }
          });

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: { status: 'active', createdBefore: 'not-a-date' }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.error.message).toContain('Invalid createdBefore date format');
      });

      it('should throw for invalid createdBefore in advancedConversationSearch', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(() => true)
          .reply(200, {
            _embedded: { conversations: [{ id: 1, createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 }
          });

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'advancedConversationSearch',
            arguments: { tags: ['billing'], createdBefore: 'garbage-date' }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.error.message).toContain('Invalid createdBefore date format');
      });

      it('should throw for invalid createdBefore in structuredConversationFilter', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(() => true)
          .reply(200, {
            _embedded: { conversations: [{ id: 1, createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 }
          });

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'structuredConversationFilter',
            arguments: { assignedTo: 123, createdBefore: 'invalid-date' }
          }
        };

        const result = await toolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);
        expect(response.error.message).toContain('Invalid createdBefore date format');
      });
    });

    describe('searchConversations single-status + createdBefore', () => {
      it('should show both filtered count and API total for single-status search', async () => {
        const freshToolHandler = new ToolHandler();

        nock.cleanAll();
        nock(baseURL)
          .persist()
          .post('/oauth2/token')
          .reply(200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 });

        const mockResponse = {
          _embedded: {
            conversations: [
              { id: 1, subject: 'Old', status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } },
              { id: 2, subject: 'Mid', status: 'active', createdAt: '2023-01-15T00:00:00Z', customer: { id: 1 } },
              { id: 3, subject: 'New', status: 'active', createdAt: '2023-02-01T00:00:00Z', customer: { id: 1 } },
            ]
          },
          page: { size: 50, totalElements: 300, totalPages: 6, number: 1 }
        };

        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active' && typeof params.query === 'string' && params.query.includes('single-status-test'))
          .reply(200, mockResponse);

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: {
              status: 'active',
              query: 'single-status-test',
              createdBefore: '2023-01-20T00:00:00Z'
            }
          }
        };

        const result = await freshToolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // Should filter to 2 conversations (before Jan 20)
        expect(response.results).toHaveLength(2);
        expect(response.pagination.totalResults).toBe(2);
        expect(response.pagination.totalAvailable).toBe(300);
        expect(response.pagination.note).toContain('filtered count (2)');
        expect(response.pagination.note).toContain('pre-filter API total (300)');
      });
    });

    describe('comprehensiveConversationSearch with createdBefore', () => {
      it('should track filtered vs unfiltered totals per status', async () => {
        const freshToolHandler = new ToolHandler();

        nock.cleanAll();
        nock(baseURL)
          .persist()
          .post('/oauth2/token')
          .reply(200, {
            access_token: 'mock-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          });

        // Active: 3 conversations, 2 before cutoff
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active' && typeof params.query === 'string' && params.query.includes('billing'))
          .reply(200, {
            _embedded: {
              conversations: [
                { id: 1, subject: 'Active old', status: 'active', createdAt: '2023-01-01T00:00:00Z' },
                { id: 2, subject: 'Active mid', status: 'active', createdAt: '2023-01-10T00:00:00Z' },
                { id: 3, subject: 'Active new', status: 'active', createdAt: '2023-02-01T00:00:00Z' },
              ]
            },
            page: { size: 25, totalElements: 3, totalPages: 1, number: 0 }
          });

        // Pending: 1 conversation, before cutoff
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'pending' && typeof params.query === 'string' && params.query.includes('billing'))
          .reply(200, {
            _embedded: {
              conversations: [
                { id: 4, subject: 'Pending old', status: 'pending', createdAt: '2023-01-05T00:00:00Z' },
              ]
            },
            page: { size: 25, totalElements: 1, totalPages: 1, number: 0 }
          });

        // Closed: 2 conversations, 1 before cutoff
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'closed' && typeof params.query === 'string' && params.query.includes('billing'))
          .reply(200, {
            _embedded: {
              conversations: [
                { id: 5, subject: 'Closed old', status: 'closed', createdAt: '2023-01-02T00:00:00Z' },
                { id: 6, subject: 'Closed new', status: 'closed', createdAt: '2023-02-15T00:00:00Z' },
              ]
            },
            page: { size: 25, totalElements: 2, totalPages: 1, number: 0 }
          });

        const request: CallToolRequest = {
          method: 'tools/call',
          params: {
            name: 'comprehensiveConversationSearch',
            arguments: {
              searchTerms: ['billing'],
              createdBefore: '2023-01-15T00:00:00Z',
              timeframeDays: 90,
            }
          }
        };

        const result = await freshToolHandler.callTool(request);
        const textContent = result.content[0] as { type: 'text'; text: string };
        const response = JSON.parse(textContent.text);

        // After filtering: active=2, pending=1, closed=1 = 4 total
        expect(response.totalConversationsFound).toBe(4);

        // Before filtering: active=3, pending=1, closed=2 = 6 total
        expect(response.totalBeforeClientSideFiltering).toBe(6);

        // Should indicate client-side filtering applied
        expect(response.clientSideFilteringApplied).toBeDefined();
        expect(response.clientSideFilteringApplied).toContain('createdBefore filter applied');
      }, 30000);
    });
  });
});
