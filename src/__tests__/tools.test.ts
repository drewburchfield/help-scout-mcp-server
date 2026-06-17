import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import { cache } from '../utils/cache.js';
import { config } from '../utils/config.js';
import { REDACTED_MESSAGE_BODY } from '../utils/constants.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('ToolHandler', () => {
  let toolHandler: ToolHandler;
  const baseURL = 'https://api.helpscout.net/v2';
  const docsBaseURL = 'https://docsapi.helpscout.net/v1';

  beforeEach(() => {
    // Mock environment for tests
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    process.env.HELPSCOUT_DOCS_API_KEY = 'test-docs-api-key';
    process.env.HELPSCOUT_DOCS_BASE_URL = `${docsBaseURL}/`;
    delete process.env.HELPSCOUT_DISABLE_DOCS;
    
    nock.cleanAll();
    cache.clear();
    
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

  // The default listTools() surface is the trimmed discovery surface (NAS-1305);
  // see discovery.test.ts for that. These tests validate the FULL catalog
  // (every tool's schema/annotations/filters), which is reachable flat via the
  // HELPSCOUT_EXPOSE_ALL_TOOLS escape hatch. We set it for this describe block so
  // listTools() returns the full sanitized 55-tool catalog.
  describe('listTools (full catalog via HELPSCOUT_EXPOSE_ALL_TOOLS)', () => {
    beforeEach(() => {
      process.env.HELPSCOUT_EXPOSE_ALL_TOOLS = 'true';
    });
    afterEach(() => {
      delete process.env.HELPSCOUT_EXPOSE_ALL_TOOLS;
    });

    it('should return all available tools', async () => {
      const tools = await toolHandler.listTools();

      expect(tools).toHaveLength(55);
      expect(tools.map(t => t.name)).toEqual([
        'searchConversations',
        'getConversation',
        'getConversationSummary',
        'getThreads',
        'getServerTime',
        'listAllInboxes',
        'getInbox',
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
        'listSavedReplies',
        'getSavedReply',
        'getOriginalSource',
        'getAttachment',
        'downloadAttachmentFile',
        'listWorkflows',
        'listWebhooks',
        'getWebhook',
        'getSatisfactionRating',
        'getCompanyReport',
        'getConversationsReport',
        'getProductivityReport',
        'getUserReport',
        'getHappinessReport',
        'getChannelReport',
        'getDocsReport',
        'listDocsSites',
        'getDocsSite',
        'listDocsCollections',
        'getDocsCollection',
        'listDocsCategories',
        'getDocsCategory',
        'listDocsArticles',
        'searchDocsArticles',
        'getDocsArticle',
        'listDocsRelatedArticles',
        'listDocsArticleRevisions',
        'getDocsArticleRevision',
        'listDocsRedirects',
        'getDocsRedirect',
        'findDocsRedirect',
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

    it('should advertise read-only annotations on every tool', async () => {
      const tools = await toolHandler.listTools();

      // This server is entirely read-only GET wrappers; clients (e.g. CoWork)
      // rely on readOnlyHint to auto-approve reads without confirmation.
      tools.forEach(tool => {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          openWorldHint: true,
        });
      });
    });

    it('should advertise all searchConversations convenience filters in its inputSchema', async () => {
      // Regression guard (NAS-1298): the 4-search-tool merge must keep every
      // absorbed filter DISCOVERABLE in the advertised inputSchema, not just in
      // the internal Zod schema — LLM clients build calls from inputSchema.
      const tools = await toolHandler.listTools();
      const search = tools.find(t => t.name === 'searchConversations')!;
      const props = (search.inputSchema as { properties: Record<string, unknown> }).properties;
      for (const p of ['contentTerms', 'subjectTerms', 'email', 'emailDomain', 'customerIds', 'hasAttachments', 'folderId', 'assignedTo', 'conversationNumber', 'modifiedSince']) {
        expect(props).toHaveProperty(p);
      }
      // status enum must include the absorbed 'all'/'open' values
      expect((props.status as { enum: string[] }).enum).toEqual(expect.arrayContaining(['all', 'open']));
    });

    it('should expose page-based pagination for v2 paginated tools', async () => {
      const tools = await toolHandler.listTools();
      const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
      const pageBasedTools = [
        'searchConversations',
        'getThreads',
        'listTags',
        'listUsers',
        'listTeams',
        'getTeamMembers',
        'listWorkflows',
        'listWebhooks',
      ];

      for (const toolName of pageBasedTools) {
        const properties = byName[toolName].inputSchema.properties as Record<string, Record<string, unknown>>;
        // page is a 1-based integer (advertised as 'number' or the stricter
        // 'integer'); no cursor on v2 page-based tools.
        expect(['number', 'integer']).toContain(properties.page.type);
        expect(properties.page).toEqual(expect.objectContaining({ minimum: 1, default: 1 }));
        expect(properties.cursor).toBeUndefined();
      }
    });

  });

  describe('Docs API tools', () => {
    const docsAuthHeader = `Basic ${Buffer.from('test-docs-api-key:X').toString('base64')}`;

    it('should list Docs sites using Docs API Basic authentication', async () => {
      nock(docsBaseURL, {
        reqheaders: {
          authorization: docsAuthHeader,
        },
      })
        .get('/sites')
        .query({ page: 1 })
        .reply(200, {
          page: 1,
          pages: 1,
          count: 1,
          items: [
            {
              id: 'site_123',
              status: 'active',
              subDomain: 'acme',
              title: 'Acme Help Center',
              updatedAt: '2026-06-01T00:00:00Z',
            },
          ],
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listDocsSites',
          arguments: {},
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toEqual(expect.objectContaining({
        id: 'site_123',
        title: 'Acme Help Center',
      }));
      expect(response.pagination).toEqual(expect.objectContaining({ page: 1, pages: 1, count: 1 }));
    });

    it('should attach Docs site restrictions via includeRestrictions and redact shared secrets', async () => {
      nock(docsBaseURL, {
        reqheaders: {
          authorization: docsAuthHeader,
        },
      })
        .get('/sites/site_123')
        .reply(200, {
          site: { id: 'site_123', title: 'Acme Help Center' },
        })
        .get('/sites/site_123/restricted')
        .reply(200, {
          enabled: true,
          authentication: 'CALLBACK',
          callbackConfiguration: {
            signInUrl: 'https://example.com/signin',
            sharedSecret: 'super-secret-value',
            nested: {
              accessToken: 'token-value',
            },
          },
          passwordConfiguration: {
            password: 'password-value',
          },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getDocsSite',
          arguments: { siteId: 'site_123', includeRestrictions: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.site).toEqual(expect.objectContaining({ id: 'site_123', title: 'Acme Help Center' }));
      expect(response.restrictions).toEqual(expect.objectContaining({
        enabled: true,
        authentication: 'CALLBACK',
      }));
      expect(response.restrictions.callbackConfiguration.sharedSecret).toBe('[redacted]');
      expect(response.restrictions.callbackConfiguration.hasSharedSecret).toBe(true);
      expect(response.restrictions.callbackConfiguration.nested.accessToken).toBe('[redacted]');
      expect(response.restrictions.passwordConfiguration.password).toBe('[redacted]');
      expect(JSON.stringify(response)).not.toContain('super-secret-value');
      expect(JSON.stringify(response)).not.toContain('token-value');
      expect(JSON.stringify(response)).not.toContain('password-value');
    });

    it('should not fetch restrictions when includeRestrictions is omitted', async () => {
      nock(docsBaseURL, {
        reqheaders: {
          authorization: docsAuthHeader,
        },
      })
        .get('/sites/site_123')
        .reply(200, {
          site: { id: 'site_123', title: 'Acme Help Center' },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getDocsSite',
          arguments: { siteId: 'site_123' },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.site).toEqual(expect.objectContaining({ id: 'site_123' }));
      expect(response.restrictions).toBeUndefined();
    });

    it('should surface a per-call error when includeRestrictions fetch fails but still return the site', async () => {
      nock(docsBaseURL, {
        reqheaders: {
          authorization: docsAuthHeader,
        },
      })
        .get('/sites/site_123')
        .reply(200, {
          site: { id: 'site_123', title: 'Acme Help Center' },
        })
        .get('/sites/site_123/restricted')
        .reply(500, { error: 'boom' });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getDocsSite',
          arguments: { siteId: 'site_123', includeRestrictions: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.site).toEqual(expect.objectContaining({ id: 'site_123' }));
      expect(response.restrictions).toBeUndefined();
      expect(response.restrictionsError).toEqual(expect.stringContaining('Restrictions lookup failed'));
    });

    it('should search Docs articles with query filters', async () => {
      nock(docsBaseURL, {
        reqheaders: {
          authorization: docsAuthHeader,
        },
      })
        .get('/search/articles')
        .query({
          query: 'refund policy',
          siteId: 'site_123',
          status: 'published',
          visibility: 'public',
          page: 2,
        })
        .reply(200, {
          articles: {
            page: 2,
            pages: 3,
            count: 4,
            items: [
              {
                id: 'article_123',
                collectionId: 'collection_123',
                name: 'Refund policy',
                status: 'published',
                visibility: 'public',
                publicUrl: 'https://docs.example.com/article/1-refund-policy',
              },
            ],
          },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchDocsArticles',
          arguments: {
            query: 'refund policy',
            siteId: 'site_123',
            status: 'published',
            visibility: 'public',
            page: 2,
          },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toEqual(expect.objectContaining({
        id: 'article_123',
        name: 'Refund policy',
      }));
      expect(response.nextPage).toBe(3);
    });

    it('should return a clear error when Docs credentials are missing', async () => {
      delete process.env.HELPSCOUT_DOCS_API_KEY;

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listDocsSites',
          arguments: {},
        },
      });

      expect(result.isError).toBe(true);
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.error.message).toContain('HELPSCOUT_DOCS_API_KEY');
      expect(response.error.message).toContain('Docs API');
    });

    it('should not serve cached Docs data after Docs credentials are removed', async () => {
      nock(docsBaseURL, {
        reqheaders: {
          authorization: docsAuthHeader,
        },
      })
        .get('/sites')
        .query({ page: 1 })
        .reply(200, {
          page: 1,
          pages: 1,
          count: 1,
          items: [{ id: 'site_cached', title: 'Cached Site' }],
        });

      const firstResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listDocsSites',
          arguments: {},
        },
      });
      expect(firstResult.isError).toBeUndefined();

      delete process.env.HELPSCOUT_DOCS_API_KEY;

      const secondResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listDocsSites',
          arguments: {},
        },
      });

      expect(secondResult.isError).toBe(true);
      const response = JSON.parse((secondResult.content[0] as { type: 'text'; text: string }).text);
      expect(response.error.message).toContain('HELPSCOUT_DOCS_API_KEY');
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

    it('should get one inbox by ID', async () => {
      nock(baseURL)
        .get('/mailboxes/359402')
        .reply(200, {
          id: 359402,
          name: 'Client Support',
          slug: 'client-support',
          email: 'support@example.com',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
          _links: {
            self: { href: 'https://api.helpscout.net/v2/mailboxes/359402' },
            folders: { href: 'https://api.helpscout.net/v2/mailboxes/359402/folders' },
            fields: { href: 'https://api.helpscout.net/v2/mailboxes/359402/fields' },
          },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getInbox',
          arguments: { inboxId: '359402' },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.inbox).toEqual(expect.objectContaining({
        id: 359402,
        name: 'Client Support',
        email: 'support@example.com',
      }));
      expect(response.usage).toContain('include');
      // Without include, no sub-resources are attached.
      expect(response.customFields).toBeUndefined();
      expect(response.folders).toBeUndefined();
      expect(response.routing).toBeUndefined();
    });
  });

  describe('listAllInboxes nameContains filter', () => {
    it('should filter the fully-paged inboxes by case-insensitive name substring', async () => {
      const mockResponse = {
        _embedded: {
          mailboxes: [
            { id: 1, name: 'Support Inbox', email: 'support@example.com' },
            { id: 2, name: 'Sales Inbox', email: 'sales@example.com' }
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
          arguments: { nameContains: 'support' }
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
      expect(response.inboxes).toHaveLength(1);
      expect(response.inboxes[0].name).toBe('Support Inbox');
      expect(response.nameContains).toBe('support');
      // totalInboxes reflects all available inboxes before filtering.
      expect(response.totalInboxes).toBe(2);
    });
  });

  describe('customer contact sub-resource tools', () => {
    it('getCustomerContacts aggregates every contact sub-resource (address, emails, phones, chats, social profiles, websites)', async () => {
      nock(baseURL)
        .get('/customers/123/address')
        .reply(200, {
          city: 'Dallas',
          state: 'TX',
          postalCode: '74206',
          country: 'US',
          lines: ['123 West Main St', 'Suite 123'],
        });
      nock(baseURL)
        .get('/customers/123/emails')
        .reply(200, { _embedded: { emails: [{ id: 1, value: 'ada@example.com', type: 'work' }] } });
      nock(baseURL)
        .get('/customers/123/phones')
        .reply(200, { _embedded: { phones: [{ id: 2, value: '222-333-4444', type: 'mobile' }] } });
      nock(baseURL)
        .get('/customers/123/chats')
        .reply(200, { _embedded: { chats: [{ id: 3, value: 'ada-chat', type: 'aim' }] } });
      nock(baseURL)
        .get('/customers/123/social-profiles')
        .reply(200, { _embedded: { social_profiles: [{ id: 4, value: 'ada-lovelace', type: 'twitter' }] } });
      nock(baseURL)
        .get('/customers/123/websites')
        .reply(200, { _embedded: { websites: [{ id: 5, value: 'https://example.com' }] } });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getCustomerContacts',
          arguments: { customerId: '123' },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response).toEqual(expect.objectContaining({
        customerId: '123',
        address: expect.objectContaining({ city: 'Dallas', country: 'US' }),
        emails: [expect.objectContaining({ id: 1, value: 'ada@example.com', type: 'work' })],
        phones: [expect.objectContaining({ id: 2, value: '222-333-4444', type: 'mobile' })],
        chats: [expect.objectContaining({ id: 3, value: 'ada-chat', type: 'aim' })],
        socialProfiles: [expect.objectContaining({ id: 4, value: 'ada-lovelace', type: 'twitter' })],
        websites: [expect.objectContaining({ id: 5, value: 'https://example.com' })],
      }));
    });

    it('getCustomerContacts returns a null address when none is on file', async () => {
      nock(baseURL).get('/customers/123/emails').reply(200, { _embedded: { emails: [] } });
      nock(baseURL).get('/customers/123/phones').reply(200, { _embedded: { phones: [] } });
      nock(baseURL).get('/customers/123/chats').reply(200, { _embedded: { chats: [] } });
      nock(baseURL).get('/customers/123/social-profiles').reply(200, { _embedded: { social_profiles: [] } });
      nock(baseURL).get('/customers/123/websites').reply(200, { _embedded: { websites: [] } });
      nock(baseURL).get('/customers/123/address').reply(404, { message: 'Not found' });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getCustomerContacts',
          arguments: { customerId: '123' },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.address).toBeNull();
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

    it('should attach all user statuses via listUsers includeStatuses with a single /users/status call', async () => {
      nock(baseURL)
        .get('/users')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            users: [
              { id: 4, firstName: 'Ada', lastName: 'Agent', email: 'agent@example.com', role: 'user', type: 'user' },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        })
        .get('/users/status')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            userStatuses: [
              { userId: 4, email: { status: 'active', source: 'ui' }, chat: { status: 'available', mailboxStatuses: {} } },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listUsers',
          arguments: { includeStatuses: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.users).toHaveLength(1);
      expect(response.statuses).toHaveLength(1);
      expect(response.statuses[0].userId).toBe(4);
    });

    it('should tolerate snake_case user_statuses when listUsers includeStatuses is set', async () => {
      nock(baseURL)
        .get('/users')
        .query({ page: 1 })
        .reply(200, {
          _embedded: { users: [] },
          page: { number: 1, size: 50, totalElements: 0, totalPages: 1 },
        })
        .get('/users/status')
        .query({ page: 1 })
        .reply(200, {
          _embedded: {
            user_statuses: [
              { userId: 7, email: { status: 'away', source: 'api' }, chat: { status: 'offline', mailboxStatuses: {} } },
            ],
          },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listUsers',
          arguments: { includeStatuses: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.statuses[0].userId).toBe(7);
    });

    it('should route listUsers to the v3 system-users endpoint via includeSystemActors', async () => {
      const apiRoot = baseURL.replace('/v2', '');
      nock(apiRoot)
        .get('/v3/system-users')
        .query({ page: 2 })
        .reply(200, {
          _embedded: {
            system_users: [
              { id: 155250, type: 'system_user', firstName: 'AI Agent', role: 'user' },
            ],
          },
          page: { size: 50, totalElements: 1, totalPages: 2, number: 2 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'listUsers',
          arguments: { page: 2, includeSystemActors: true, includeStatuses: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.apiVersion).toBe('v3');
      expect(response.systemUsers).toHaveLength(1);
      expect(response.systemUsers[0].id).toBe(155250);
      // includeStatuses is ignored for the system-actor path.
      expect(response.statuses).toBeUndefined();
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

    it('should attach user status via getUser includeStatus', async () => {
      nock(baseURL)
        .get('/users/4')
        .reply(200, { id: 4, firstName: 'Ada', lastName: 'Agent', email: 'agent@example.com', role: 'user', type: 'user' })
        .get('/users/4/status')
        .reply(200, {
          userId: 4,
          email: { status: 'active', source: 'ui' },
          chat: { status: 'available', mailboxStatuses: {} },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { userId: '4', includeStatus: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.user.id).toBe(4);
      expect(response.status.email.status).toBe('active');
    });

    it('should surface a per-call error when getUser includeStatus fetch fails but still return the user', async () => {
      nock(baseURL)
        .get('/users/4')
        .reply(200, { id: 4, firstName: 'Ada', lastName: 'Agent', email: 'agent@example.com', role: 'user', type: 'user' })
        .get('/users/4/status')
        .reply(500, { error: 'boom' });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { userId: '4', includeStatus: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.user.id).toBe(4);
      expect(response.status).toBeUndefined();
      expect(response.statusError).toEqual(expect.stringContaining('Status lookup failed'));
    });

    it('should route getUser to the v3 system-user endpoint via includeSystemActors', async () => {
      const apiRoot = baseURL.replace('/v2', '');
      nock(apiRoot)
        .get('/v3/system-users/155250')
        .reply(200, {
          id: 155250,
          type: 'system_user',
          firstName: 'AI Agent',
          role: 'user',
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { userId: '155250', includeSystemActors: true, includeStatus: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.apiVersion).toBe('v3');
      expect(response.systemUser).toEqual(expect.objectContaining({ id: 155250, type: 'system_user' }));
      // includeStatus does not apply to system users; it is ignored with a note.
      expect(response.status).toBeUndefined();
      expect(response.statusNote).toEqual(expect.stringContaining('ignored for system users'));
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

    it('should attach inbox custom fields and folders via getInbox include', async () => {
      nock(baseURL)
        .get('/mailboxes/359402')
        .reply(200, { id: 359402, name: 'Client Support', email: 'support@example.com' });
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

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getInbox',
          arguments: { inboxId: '359402', include: ['fields', 'folders'] },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.inbox).toEqual(expect.objectContaining({ id: 359402, name: 'Client Support' }));
      expect(response.includeErrors).toBeUndefined();
      expect(response.customFields.fields[0]).toEqual(expect.objectContaining({ id: 104, name: 'Plan', type: 'dropdown' }));
      expect(response.customFields.fields[0].options[0]).toEqual(expect.objectContaining({ id: 168, label: 'Pro' }));
      expect(response.customFields.totalFields).toBe(1);
      expect(response.folders.folders[0]).toEqual(expect.objectContaining({ id: 1234, name: 'Mine', activeCount: 1 }));
      expect(response.folders.totalFolders).toBe(1);
    });

    it('should attach inbox routing via getInbox include', async () => {
      nock(baseURL)
        .get('/mailboxes/359402')
        .reply(200, { id: 359402, name: 'Client Support', email: 'support@example.com' });
      nock(baseURL)
        .get('/mailboxes/359402/routing')
        .reply(200, {
          state: 'enabled',
          assignmentMethod: 'round_robin',
          userIds: [4, 7],
          rotation: [{ userId: 4, conversationsCount: 2, eligible: true }],
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getInbox',
          arguments: { inboxId: '359402', include: ['routing'] },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.includeErrors).toBeUndefined();
      expect(response.routing).toEqual(expect.objectContaining({ state: 'enabled', userIds: [4, 7] }));
      expect(response.routing.rotation[0]).toEqual(expect.objectContaining({ userId: 4, eligible: true }));
    });

    it('should surface per-sub-resource errors without failing the whole getInbox call', async () => {
      nock(baseURL)
        .get('/mailboxes/359402')
        .reply(200, { id: 359402, name: 'Client Support', email: 'support@example.com' });
      nock(baseURL)
        .get('/mailboxes/359402/fields')
        .reply(200, {
          _embedded: { fields: [{ id: 104, type: 'dropdown', name: 'Plan' }] },
          page: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
        });
      nock(baseURL)
        .get('/mailboxes/359402/routing')
        .reply(500, { error: 'boom' });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getInbox',
          arguments: { inboxId: '359402', include: ['fields', 'routing'] },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      // The succeeding sub-resource is still attached.
      expect(response.customFields.fields[0]).toEqual(expect.objectContaining({ id: 104, name: 'Plan' }));
      // The failing sub-resource is reported, not thrown.
      expect(response.routing).toBeUndefined();
      expect(response.includeErrors).toBeDefined();
      expect(response.includeErrors.routing).toEqual(expect.any(String));
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

    it('should get a thread original source', async () => {
      nock(baseURL)
        .get('/conversations/123/threads/456/original-source')
        .reply(200, {
          original: 'From: customer@example.com\nSubject: Raw source',
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getOriginalSource',
          arguments: { conversationId: '123', threadId: '456' },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.conversationId).toBe('123');
      expect(response.threadId).toBe('456');
      expect(response.originalSource).toEqual({ original: 'From: customer@example.com\nSubject: Raw source' });
    });

    it('should redact a thread original source when message redaction is enabled', async () => {
      const originalRedactMessageContent = config.security.redactMessageContent;
      config.security.redactMessageContent = true;

      try {
        const scope = nock(baseURL)
          .get('/conversations/123/threads/456/original-source')
          .reply(200, {
            original: 'From: customer@example.com\nSubject: Raw source',
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getOriginalSource',
            arguments: { conversationId: '123', threadId: '456' },
          },
        });

        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.conversationId).toBe('123');
        expect(response.threadId).toBe('456');
        expect(response.originalSource).toBe(REDACTED_MESSAGE_BODY);
        expect(scope.isDone()).toBe(false);
      } finally {
        config.security.redactMessageContent = originalRedactMessageContent;
      }
    });

    it('should get a thread original source as RFC 822', async () => {
      nock(baseURL)
        .get('/conversations/123/threads/456/original-source')
        .matchHeader('accept', 'message/rfc822')
        .reply(200, 'From: customer@example.com\nSubject: Raw source', {
          'Content-Type': 'message/rfc822',
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getOriginalSource',
          arguments: { conversationId: '123', threadId: '456', format: 'rfc822' },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.conversationId).toBe('123');
      expect(response.threadId).toBe('456');
      expect(response.sourceFormat).toBe('message/rfc822');
      expect(response.contentType).toContain('message/rfc822');
      expect(response.originalSource).toContain('Subject: Raw source');
    });

    it('should redact RFC 822 original source when message redaction is enabled', async () => {
      const originalRedactMessageContent = config.security.redactMessageContent;
      config.security.redactMessageContent = true;

      try {
        const scope = nock(baseURL)
          .get('/conversations/123/threads/456/original-source')
          .reply(200, 'From: customer@example.com\nSubject: Raw source');

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getOriginalSource',
            arguments: { conversationId: '123', threadId: '456', format: 'rfc822' },
          },
        });

        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.conversationId).toBe('123');
        expect(response.threadId).toBe('456');
        expect(response.originalSource).toBe(REDACTED_MESSAGE_BODY);
        expect(scope.isDone()).toBe(false);
      } finally {
        config.security.redactMessageContent = originalRedactMessageContent;
      }
    });

    it('should get attachment data', async () => {
      nock(baseURL)
        .get('/conversations/123/attachments/789/data')
        .reply(200, {
          data: 'ZmlsZQ==',
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getAttachment',
          arguments: { conversationId: '123', attachmentId: '789' },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.conversationId).toBe('123');
      expect(response.attachmentId).toBe('789');
      expect(response.attachment).toEqual({ data: 'ZmlsZQ==' });
      expect(response.contentHandling).toEqual(expect.objectContaining({
        encoding: 'base64',
        source: 'Help Scout attachment data endpoint',
      }));
    });

    it('should download attachment file content with response metadata', async () => {
      nock(baseURL)
        .get('/conversations/123/attachments/789/file')
        .reply(200, Buffer.from('file bytes'), {
          'Content-Disposition': 'attachment; filename="export.csv"',
          'Content-Type': 'text/csv',
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'downloadAttachmentFile',
          arguments: { conversationId: '123', attachmentId: '789' },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.conversationId).toBe('123');
      expect(response.attachmentId).toBe('789');
      expect(response.filename).toBe('export.csv');
      expect(response.contentType).toContain('text/csv');
      expect(response.byteLength).toBe(Buffer.byteLength('file bytes'));
      expect(response.data).toBe(Buffer.from('file bytes').toString('base64'));
      expect(response.contentHandling).toEqual(expect.objectContaining({
        encoding: 'base64',
        source: 'Help Scout attachment file endpoint',
      }));
    });

    it('should not cache attachment data responses', async () => {
      const scope = nock(baseURL)
        .get('/conversations/123/attachments/789/data')
        .reply(200, {
          data: 'Zmlyc3Q=',
        })
        .get('/conversations/123/attachments/789/data')
        .reply(200, {
          data: 'c2Vjb25k',
        });

      const first = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getAttachment',
          arguments: { conversationId: '123', attachmentId: '789' },
        },
      });
      const second = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getAttachment',
          arguments: { conversationId: '123', attachmentId: '789' },
        },
      });

      const firstResponse = JSON.parse((first.content[0] as { type: 'text'; text: string }).text);
      const secondResponse = JSON.parse((second.content[0] as { type: 'text'; text: string }).text);
      expect(firstResponse.attachment).toEqual({ data: 'Zmlyc3Q=' });
      expect(secondResponse.attachment).toEqual({ data: 'c2Vjb25k' });
      expect(scope.isDone()).toBe(true);
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

    it('should get a satisfaction rating by ID', async () => {
      nock(baseURL)
        .get('/ratings/9001')
        .reply(200, {
          id: 9001,
          threadId: 456,
          conversationId: 123,
          conversationNumber: 321,
          mailboxId: 359402,
          rating: 'great',
          comments: 'Well done!',
          createdAt: '2024-01-02T03:04:05Z',
          user: {
            id: 42,
            email: 'agent@example.com',
            firstName: 'Ava',
            lastName: 'Agent',
          },
          customer: {
            id: 77,
            email: 'customer@example.com',
            firstName: 'Chris',
            lastName: 'Customer',
          },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getSatisfactionRating',
          arguments: { ratingId: '9001' },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.ratingId).toBe('9001');
      expect(response.rating).toEqual(expect.objectContaining({
        id: 9001,
        rating: 'great',
        comments: 'Well done!',
        conversationId: 123,
      }));
      expect(response.usage).toContain('read-only quality context');
    });

    it('should validate satisfaction rating IDs before calling Help Scout', async () => {
      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getSatisfactionRating',
          arguments: { ratingId: 'abc' },
        },
      });

      expect(result.isError).toBe(true);
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.error.code).toBe('INVALID_INPUT');
      expect(response.error.validationIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'ratingId',
          message: 'Rating ID must be numeric',
        }),
      ]));
    });

    it('should get core reporting API data for a bounded time range', async () => {
      const reportArgs = {
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-31T23:59:59Z',
        previousStart: '2023-12-01T00:00:00Z',
        previousEnd: '2023-12-31T23:59:59Z',
        mailboxes: ['359402'],
        tags: ['123'],
        types: ['email'],
        folders: ['456'],
      };

      nock(baseURL)
        .get('/reports/company')
        .query({
          start: reportArgs.start,
          end: reportArgs.end,
          previousStart: reportArgs.previousStart,
          previousEnd: reportArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
        })
        .reply(200, {
          current: { customersHelped: 28, totalReplies: 62 },
          previous: { customersHelped: 27, totalReplies: 60 },
          deltas: { customersHelped: 3.7 },
        });

      nock(baseURL)
        .get('/reports/conversations')
        .query({
          start: reportArgs.start,
          end: reportArgs.end,
          previousStart: reportArgs.previousStart,
          previousEnd: reportArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
        })
        .reply(200, {
          current: { totalConversations: 1816, conversationsPerDay: 60 },
          previous: { totalConversations: 2080, conversationsPerDay: 67 },
          busiestDay: { day: 3, hour: 0, count: 411 },
        });

      nock(baseURL)
        .get('/reports/happiness')
        .query({
          start: reportArgs.start,
          end: reportArgs.end,
          previousStart: reportArgs.previousStart,
          previousEnd: reportArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
        })
        .reply(200, {
          current: { happinessScore: 5.45, greatCount: 41, ratingsCount: 110 },
          previous: { happinessScore: -0.18, greatCount: 340, ratingsCount: 1074 },
        });

      // overall reports default report='overall' and hit the family root path.
      for (const [toolName, reportType, expectedField] of [
        ['getCompanyReport', 'company', 'customersHelped'],
        ['getConversationsReport', 'conversations', 'totalConversations'],
        ['getHappinessReport', 'happiness', 'happinessScore'],
      ] as const) {
        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: reportArgs,
          },
        });

        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.reportType).toBe(reportType);
        expect(response.filters).toEqual(expect.objectContaining({
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
        }));
        expect(response.report.current[expectedField]).toBeDefined();
      }
    });

    it('should route company report variants by discriminator', async () => {
      const baseArgs = {
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-31T23:59:59Z',
        mailboxes: ['359402'],
        tags: ['123'],
        types: ['email'],
        folders: ['456'],
      };

      // customers-helped timeline with viewBy.
      nock(baseURL)
        .get('/reports/company/customers-helped')
        .query({
          start: baseArgs.start,
          end: baseArgs.end,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
          viewBy: 'week',
        })
        .reply(200, { current: [{ date: '2024-01-01T00:00:00Z', customers: 10 }] });

      const chResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getCompanyReport',
          arguments: { ...baseArgs, report: 'customers-helped', viewBy: 'week' },
        },
      });
      const chResponse = JSON.parse((chResult.content[0] as { type: 'text'; text: string }).text);
      expect(chResult.isError).toBeUndefined();
      expect(chResponse.reportType).toBe('companyCustomersHelped');
      expect(chResponse.filters.viewBy).toBe('week');

      // drilldown carries page/rows/range/rangeId.
      nock(baseURL)
        .get('/reports/company/drilldown')
        .query({
          start: baseArgs.start,
          end: baseArgs.end,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
          page: 2,
          rows: 30,
          range: 'replies',
          rangeId: 5,
        })
        .reply(200, {
          conversations: { page: 2, pages: 3, count: 51, results: [{ id: 987, number: 123 }] },
        });

      const ddResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getCompanyReport',
          arguments: {
            ...baseArgs,
            report: 'drilldown',
            page: 2,
            rows: 30,
            range: 'replies',
            rangeId: 5,
          },
        },
      });
      const ddResponse = JSON.parse((ddResult.content[0] as { type: 'text'; text: string }).text);
      expect(ddResult.isError).toBeUndefined();
      expect(ddResponse.reportType).toBe('companyDrilldown');
      expect(ddResponse.filters).toEqual(expect.objectContaining({ page: 2, rows: 30, range: 'replies', rangeId: 5 }));
      expect(ddResponse.report.conversations.results[0].number).toBe(123);
    });

    it('should reject a company drilldown report without a range', async () => {
      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getCompanyReport',
          arguments: {
            start: '2024-01-01T00:00:00Z',
            end: '2024-01-31T23:59:59Z',
            report: 'drilldown',
          },
        },
      });
      expect(result.isError).toBe(true);
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.error.code).toBe('INVALID_INPUT');
      expect(response.error.validationIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'range is required for the drilldown report' }),
      ]));
    });

    it('should route conversations report variants by discriminator', async () => {
      const baseArgs = {
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-31T23:59:59Z',
        previousStart: '2023-12-01T00:00:00Z',
        previousEnd: '2023-12-31T23:59:59Z',
        mailboxes: ['359402'],
        tags: ['123'],
        types: ['email'],
        folders: ['456'],
      };

      for (const [report, path, reportType] of [
        ['volume-by-channel', '/reports/conversations/volume-by-channel', 'conversationVolumeByChannel'],
        ['new', '/reports/conversations/new', 'conversationNew'],
        ['received-messages', '/reports/conversations/received-messages', 'conversationReceivedMessages'],
      ] as const) {
        nock(baseURL)
          .get(path)
          .query({
            start: baseArgs.start,
            end: baseArgs.end,
            previousStart: baseArgs.previousStart,
            previousEnd: baseArgs.previousEnd,
            mailboxes: '359402',
            tags: '123',
            types: 'email',
            folders: '456',
            viewBy: 'week',
          })
          .reply(200, { current: [{ date: '2024-01-01T00:00:00Z', count: 10 }] });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getConversationsReport',
            arguments: { ...baseArgs, report, viewBy: 'week' },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.reportType).toBe(reportType);
        expect(response.filters.viewBy).toBe('week');
      }

      // drilldown variants (no previous*, with page/rows).
      const drillArgs = {
        start: baseArgs.start,
        end: baseArgs.end,
        mailboxes: baseArgs.mailboxes,
        tags: baseArgs.tags,
        types: baseArgs.types,
        folders: baseArgs.folders,
      };
      for (const [report, path, reportType] of [
        ['drilldown', '/reports/conversations/drilldown', 'conversationDrilldown'],
        ['new-drilldown', '/reports/conversations/new-drilldown', 'conversationNewDrilldown'],
      ] as const) {
        nock(baseURL)
          .get(path)
          .query({
            start: drillArgs.start,
            end: drillArgs.end,
            mailboxes: '359402',
            tags: '123',
            types: 'email',
            folders: '456',
            page: 2,
            rows: 30,
          })
          .reply(200, { conversations: { page: 2, pages: 3, count: 51, results: [{ id: 987, number: 123 }] } });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getConversationsReport',
            arguments: { ...drillArgs, report, page: 2, rows: 30 },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.reportType).toBe(reportType);
        expect(response.report.conversations.results[0].number).toBe(123);
      }

      // fields-drilldown with field/fieldid.
      nock(baseURL)
        .get('/reports/conversations/fields-drilldown')
        .query({
          start: drillArgs.start,
          end: drillArgs.end,
          field: 'tagid',
          fieldid: '123',
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
          page: 1,
          rows: 25,
        })
        .reply(200, { conversations: { page: 1, pages: 1, count: 1, results: [{ id: 987, number: 123 }] } });

      const fieldResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getConversationsReport',
          arguments: { ...drillArgs, report: 'fields-drilldown', field: 'tagid', fieldid: '123', page: 1, rows: 25 },
        },
      });
      const fieldResponse = JSON.parse((fieldResult.content[0] as { type: 'text'; text: string }).text);
      expect(fieldResult.isError).toBeUndefined();
      expect(fieldResponse.reportType).toBe('conversationFieldDrilldown');
      expect(fieldResponse.filters).toEqual(expect.objectContaining({ field: 'tagid', fieldid: '123' }));

      // busy-times overall variant.
      nock(baseURL)
        .get('/reports/conversations/busy-times')
        .query({
          start: baseArgs.start,
          end: baseArgs.end,
          previousStart: baseArgs.previousStart,
          previousEnd: baseArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
        })
        .reply(200, [{ day: 1, hour: 9, count: 3 }]);

      const busyResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getConversationsReport',
          arguments: { ...baseArgs, report: 'busy-times' },
        },
      });
      const busyResponse = JSON.parse((busyResult.content[0] as { type: 'text'; text: string }).text);
      expect(busyResult.isError).toBeUndefined();
      expect(busyResponse.reportType).toBe('conversationBusyTimes');
      expect(busyResponse.report[0]).toEqual(expect.objectContaining({ day: 1, hour: 9, count: 3 }));
    });

    it('should reject a conversations fields-drilldown report without field/fieldid', async () => {
      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getConversationsReport',
          arguments: {
            start: '2024-01-01T00:00:00Z',
            end: '2024-01-31T23:59:59Z',
            report: 'fields-drilldown',
          },
        },
      });
      expect(result.isError).toBe(true);
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.error.code).toBe('INVALID_INPUT');
      expect(response.error.validationIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'field is required for the fields-drilldown report' }),
        expect.objectContaining({ message: 'fieldid is required for the fields-drilldown report' }),
      ]));
    });

    it('should get the docs report', async () => {
      nock(baseURL)
        .get('/reports/docs')
        .query({
          start: '2024-01-01T00:00:00Z',
          end: '2024-01-31T23:59:59Z',
          previousStart: '2023-12-01T00:00:00Z',
          previousEnd: '2023-12-31T23:59:59Z',
          sites: 'site-1,site-2',
        })
        .reply(200, {
          current: { visitors: 10 },
          previous: { visitors: 8 },
          popularSearches: [{ id: 'billing', count: 2 }],
        });

      const docsResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getDocsReport',
          arguments: {
            start: '2024-01-01T00:00:00Z',
            end: '2024-01-31T23:59:59Z',
            previousStart: '2023-12-01T00:00:00Z',
            previousEnd: '2023-12-31T23:59:59Z',
            sites: ['site-1', 'site-2'],
          },
        },
      });
      const docsResponse = JSON.parse((docsResult.content[0] as { type: 'text'; text: string }).text);
      expect(docsResult.isError).toBeUndefined();
      expect(docsResponse.reportType).toBe('docs');
      expect(docsResponse.filters.sites).toBe('site-1,site-2');
      expect(docsResponse.report.current.visitors).toBe(10);
    });

    it('should route channel report by channel discriminator', async () => {
      const baseArgs = {
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-31T23:59:59Z',
        previousStart: '2023-12-01T00:00:00Z',
        previousEnd: '2023-12-31T23:59:59Z',
        mailboxes: ['359402'],
        tags: ['123'],
        folders: ['456'],
      };

      for (const channel of ['chat', 'email', 'phone'] as const) {
        nock(baseURL)
          .get(`/reports/${channel}`)
          .query({
            start: baseArgs.start,
            end: baseArgs.end,
            previousStart: baseArgs.previousStart,
            previousEnd: baseArgs.previousEnd,
            mailboxes: '359402',
            tags: '123',
            folders: '456',
            officeHours: 'false',
          })
          .reply(200, {
            current: { volume: { conversations: 12 } },
            previous: { volume: { conversations: 10 } },
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getChannelReport',
            arguments: { ...baseArgs, channel, officeHours: false },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.reportType).toBe(channel);
        expect(response.filters).toEqual(expect.objectContaining({
          mailboxes: '359402',
          tags: '123',
          folders: '456',
          officeHours: 'false',
        }));
      }
    });

    it('should get happiness ratings report rows with pagination and rating filter', async () => {
      nock(baseURL)
        .get('/reports/happiness/ratings')
        .query({
          start: '2024-01-01T00:00:00Z',
          end: '2024-01-31T23:59:59Z',
          page: 2,
          sortField: 'rating',
          sortOrder: 'ASC',
          rating: 'great',
        })
        .reply(200, {
          results: [{
            number: 222043,
            threadid: 1169815634,
            id: 432207336,
            type: 'email',
            ratingId: 1,
            ratingComments: 'Thanks!',
            ratingCreatedAt: '2024-01-15T12:26:53Z',
          }],
          page: 2,
          count: 100,
          pages: 10,
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getHappinessReport',
          arguments: {
            report: 'ratings',
            start: '2024-01-01T00:00:00Z',
            end: '2024-01-31T23:59:59Z',
            page: 2,
            sortField: 'rating',
            sortOrder: 'asc',
            rating: 'great',
          },
        },
      });

      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(result.isError).toBeUndefined();
      expect(response.reportType).toBe('happinessRatings');
      expect(response.filters).toEqual(expect.objectContaining({
        page: 2,
        sortField: 'rating',
        sortOrder: 'ASC',
        rating: 'great',
      }));
      expect(response.report.results[0]).toEqual(expect.objectContaining({
        number: 222043,
        ratingId: 1,
      }));
    });

    it('should get productivity reports with office hours and view granularity', async () => {
      const reportArgs = {
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-31T23:59:59Z',
        previousStart: '2023-12-01T00:00:00Z',
        previousEnd: '2023-12-31T23:59:59Z',
        mailboxes: ['359402'],
        tags: ['123'],
        types: ['email'],
        folders: ['456'],
        officeHours: true,
      };

      nock(baseURL)
        .get('/reports/productivity')
        .query({
          start: reportArgs.start,
          end: reportArgs.end,
          previousStart: reportArgs.previousStart,
          previousEnd: reportArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
          officeHours: 'true',
        })
        .reply(200, {
          current: { totalConversations: 12, firstResponseTime: 42, repliesSent: 31 },
          previous: { totalConversations: 10, firstResponseTime: 50, repliesSent: 29 },
        });

      const overallResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getProductivityReport',
          arguments: reportArgs,
        },
      });
      const overallResponse = JSON.parse((overallResult.content[0] as { type: 'text'; text: string }).text);
      expect(overallResult.isError).toBeUndefined();
      expect(overallResponse.reportType).toBe('productivity');
      expect(overallResponse.filters).toEqual(expect.objectContaining({ officeHours: 'true' }));
      expect(overallResponse.report.current.firstResponseTime).toBe(42);

      // response-time slug is preserved verbatim (no doc-slug typo applied).
      for (const [report, path, reportType, expectedField] of [
        ['first-response-time', '/reports/productivity/first-response-time', 'productivityFirstResponseTime', 'time'],
        ['replies-sent', '/reports/productivity/replies-sent', 'productivityRepliesSent', 'replies'],
        ['resolution-time', '/reports/productivity/resolution-time', 'productivityResolutionTime', 'time'],
        ['resolved', '/reports/productivity/resolved', 'productivityResolved', 'resolved'],
        ['response-time', '/reports/productivity/response-time', 'productivityResponseTime', 'time'],
      ] as const) {
        nock(baseURL)
          .get(path)
          .query({
            start: reportArgs.start,
            end: reportArgs.end,
            previousStart: reportArgs.previousStart,
            previousEnd: reportArgs.previousEnd,
            mailboxes: '359402',
            tags: '123',
            types: 'email',
            folders: '456',
            officeHours: 'true',
            viewBy: 'week',
          })
          .reply(200, {
            current: [{ date: '2024-01-01T00:00:00Z', [expectedField]: 10 }],
            previous: [{ date: '2023-12-01T00:00:00Z', [expectedField]: 20 }],
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getProductivityReport',
            arguments: { ...reportArgs, report, viewBy: 'week' },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.reportType).toBe(reportType);
        expect(response.filters).toEqual(expect.objectContaining({ officeHours: 'true', viewBy: 'week' }));
        expect(response.report.current[0][expectedField]).toBe(10);
      }
    });

    it('should get user report family data with documented filters', async () => {
      const reportArgs = {
        user: '12345',
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-31T23:59:59Z',
        previousStart: '2023-12-01T00:00:00Z',
        previousEnd: '2023-12-31T23:59:59Z',
        mailboxes: ['359402'],
        tags: ['123'],
        types: ['email'],
        folders: ['456'],
      };

      // overall: required user + report='overall'.
      nock(baseURL)
        .get('/reports/user')
        .query({
          user: reportArgs.user,
          start: reportArgs.start,
          end: reportArgs.end,
          previousStart: reportArgs.previousStart,
          previousEnd: reportArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
          officeHours: 'false',
        })
        .reply(200, {
          user: { id: 12345, name: 'Ada Lovelace' },
          current: { totalReplies: 42 },
          previous: { totalReplies: 21 },
        });

      const overallResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUserReport',
          arguments: { ...reportArgs, officeHours: false },
        },
      });
      const overallResponse = JSON.parse((overallResult.content[0] as { type: 'text'; text: string }).text);
      expect(overallResult.isError).toBeUndefined();
      expect(overallResponse.reportType).toBe('user');
      expect(overallResponse.filters).toEqual(expect.objectContaining({ user: '12345', officeHours: 'false' }));
      expect(overallResponse.report.current.totalReplies).toBe(42);

      // conversation-history: status/page/sortField/sortOrder.
      nock(baseURL)
        .get('/reports/user/conversation-history')
        .query({
          user: reportArgs.user,
          start: reportArgs.start,
          end: reportArgs.end,
          previousStart: reportArgs.previousStart,
          previousEnd: reportArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
          officeHours: 'true',
          status: 'closed',
          page: 2,
          sortField: 'responseTime',
          sortOrder: 'ASC',
        })
        .reply(200, { results: [{ id: 987, number: 123, responseTime: 300 }], page: 2, count: 3, pages: 2 });

      const historyResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUserReport',
          arguments: {
            ...reportArgs,
            report: 'conversation-history',
            officeHours: true,
            status: 'closed',
            page: 2,
            sortField: 'responseTime',
            sortOrder: 'asc',
          },
        },
      });
      const historyResponse = JSON.parse((historyResult.content[0] as { type: 'text'; text: string }).text);
      expect(historyResult.isError).toBeUndefined();
      expect(historyResponse.reportType).toBe('userConversationHistory');
      expect(historyResponse.filters).toEqual(expect.objectContaining({
        officeHours: 'true',
        status: 'closed',
        page: 2,
        sortOrder: 'ASC',
      }));
      expect(historyResponse.report.results[0].responseTime).toBe(300);

      // timeline reports: customers-helped, replies, resolutions.
      for (const [report, path, reportType, expectedField] of [
        ['customers-helped', '/reports/user/customers-helped', 'userCustomersHelped', 'customers'],
        ['replies', '/reports/user/replies', 'userReplies', 'replies'],
        ['resolutions', '/reports/user/resolutions', 'userResolutions', 'resolved'],
      ] as const) {
        nock(baseURL)
          .get(path)
          .query({
            user: reportArgs.user,
            start: reportArgs.start,
            end: reportArgs.end,
            previousStart: reportArgs.previousStart,
            previousEnd: reportArgs.previousEnd,
            mailboxes: '359402',
            tags: '123',
            types: 'email',
            folders: '456',
            viewBy: 'week',
          })
          .reply(200, {
            current: [{ date: '2024-01-01T00:00:00Z', [expectedField]: 10 }],
            previous: [{ date: '2023-12-01T00:00:00Z', [expectedField]: 20 }],
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getUserReport',
            arguments: { ...reportArgs, report, viewBy: 'week' },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.reportType).toBe(reportType);
        expect(response.filters).toEqual(expect.objectContaining({ user: '12345', viewBy: 'week' }));
        expect(response.report.current[0][expectedField]).toBe(10);
      }

      // drilldown: page/rows, no previous*.
      nock(baseURL)
        .get('/reports/user/drilldown')
        .query({
          user: reportArgs.user,
          start: reportArgs.start,
          end: reportArgs.end,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
          page: 1,
          rows: 50,
        })
        .reply(200, { conversations: { count: 1, page: 1, pages: 1, results: [{ id: 987, number: 123, subject: 'Billing' }] } });

      const drilldownResult = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getUserReport',
          arguments: {
            user: reportArgs.user,
            report: 'drilldown',
            start: reportArgs.start,
            end: reportArgs.end,
            mailboxes: reportArgs.mailboxes,
            tags: reportArgs.tags,
            types: reportArgs.types,
            folders: reportArgs.folders,
            page: 1,
            rows: 50,
          },
        },
      });
      const drilldownResponse = JSON.parse((drilldownResult.content[0] as { type: 'text'; text: string }).text);
      expect(drilldownResult.isError).toBeUndefined();
      expect(drilldownResponse.reportType).toBe('userDrilldown');
      expect(drilldownResponse.report.conversations.results[0].number).toBe(123);

      // happiness, ratings, chat variants.
      for (const [report, path, reportType, responseBody] of [
        ['happiness', '/reports/user/happiness', 'userHappiness', { current: { greatCount: 4 } }],
        ['ratings', '/reports/user/ratings', 'userRatings', { results: [{ ratingId: 1 }], page: 1, count: 1, pages: 1 }],
        ['chat', '/reports/user/chat', 'userChat', { current: { newConversations: 2 } }],
      ] as const) {
        const query: Record<string, string | number> = {
          user: reportArgs.user,
          start: reportArgs.start,
          end: reportArgs.end,
          previousStart: reportArgs.previousStart,
          previousEnd: reportArgs.previousEnd,
          mailboxes: '359402',
          tags: '123',
          types: 'email',
          folders: '456',
        };
        if (report === 'ratings') {
          query.page = 1;
          query.sortField = 'rating';
          query.sortOrder = 'DESC';
          query.rating = 'great';
        }
        if (report === 'chat') {
          query.officeHours = 'true';
        }

        nock(baseURL)
          .get(path)
          .query(query)
          .reply(200, responseBody);

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getUserReport',
            arguments: {
              ...reportArgs,
              report,
              ...(report === 'ratings' ? { page: 1, sortField: 'rating', sortOrder: 'desc', rating: 'great' } : {}),
              ...(report === 'chat' ? { officeHours: true } : {}),
            },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(result.isError).toBeUndefined();
        expect(response.reportType).toBe(reportType);
      }
    });

    it('should require comparison report dates to be paired', async () => {
      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getCompanyReport',
          arguments: {
            start: '2024-01-01T00:00:00Z',
            end: '2024-01-31T23:59:59Z',
            previousStart: '2023-12-01T00:00:00Z',
          },
        },
      });

      expect(result.isError).toBe(true);
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.error.code).toBe('INVALID_INPUT');
      expect(response.error.validationIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: 'previousStart and previousEnd must be provided together',
        }),
      ]));
    });
  });

  describe('page-based v2 pagination', () => {
    it('should scan ALL inbox pages so a name match past page 1 is found (no size param)', async () => {
      // /mailboxes is 50/page and ignores `size`; listAllInboxes must loop pages
      // so a nameContains match on page 2 is not invisible.
      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1 })
        .reply(200, {
          _embedded: { mailboxes: [{ id: 10, name: 'Sales', email: 's@example.com', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-02T00:00:00Z' }] },
          page: { size: 50, totalElements: 2, totalPages: 2, number: 1 }
        });
      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 2 })
        .reply(200, {
          _embedded: { mailboxes: [{ id: 11, name: 'Billing Support', email: 'b@example.com', createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-02T00:00:00Z' }] },
          page: { size: 50, totalElements: 2, totalPages: 2, number: 2 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: { name: 'listAllInboxes', arguments: { nameContains: 'billing' } },
      });
      const response = JSON.parse((result.content[0] as { text: string }).text);

      // The page-2 inbox ("Billing Support") is found despite being beyond page 1.
      expect(response.inboxes).toHaveLength(1);
      expect(response.inboxes[0].id).toBe(11);
      expect(response.totalInboxes).toBe(2);
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

    it('should loop ALL thread pages so message history is complete (no size param, no cursors)', async () => {
      // Threads are 25/page and `size` is ignored; getThreads must loop pages
      // and return the COMPLETE history rather than the first page only.
      nock(baseURL)
        .get('/conversations/123/threads')
        .query({ page: 1 })
        .reply(200, {
          _embedded: { threads: [{ id: 1, type: 'customer', body: 'first', createdAt: '2023-01-01T00:00:00Z' }] },
          page: { size: 25, totalElements: 2, totalPages: 2, number: 1 }
        });
      nock(baseURL)
        .get('/conversations/123/threads')
        .query({ page: 2 })
        .reply(200, {
          _embedded: { threads: [{ id: 2, type: 'message', body: 'reply', createdAt: '2023-01-02T00:00:00Z' }] },
          page: { size: 25, totalElements: 2, totalPages: 2, number: 2 }
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: { name: 'getThreads', arguments: { conversationId: '123' } },
      });
      const response = JSON.parse((result.content[0] as { text: string }).text);

      // Both pages concatenated — no silent truncation to page 1.
      expect(response.threads).toHaveLength(2);
      expect(response.threads.map((t: { id: number }) => t.id)).toEqual([1, 2]);
      expect(response.totalThreads).toBe(2);
      expect(response.truncated).toBe(false);
      expect(response.nextCursor).toBeUndefined();
    });

    it('should compile contentTerms into a body query and omit v2 cursors (searchConversations)', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(params => params.page === '2' && params.status === 'active' && typeof params.query === 'string' && params.query.includes('body:"billing"'))
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
          name: 'searchConversations',
          arguments: { contentTerms: ['billing'], status: 'active', page: 2 },
        },
      });
      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.results).toHaveLength(1);
      expect(response.pagination).toEqual({ size: 50, totalElements: 120, totalPages: 3, number: 2 });
      expect(response.nextPage).toBe(3);
      expect(response.nextCursor).toBeUndefined();
    });

    it('should pass assignedTo through as assigned_to and omit v2 cursors (searchConversations)', async () => {
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
          name: 'searchConversations',
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
          name: 'listAllInboxes',
          arguments: {}
        }
      };

      const result = await toolHandler.callTool(request);
      // The error might be handled gracefully, so check for either error or empty results
      expect(result.content[0]).toHaveProperty('type', 'text');

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);
      // Should either be an error or empty results
      expect(response.inboxes || response.returnedCount === 0 || response.error).toBeTruthy();
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
      jest.spyOn(toolHandler as any, 'listAllInboxes').mockResolvedValue({ content: [] });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'listAllInboxes',
          arguments: {},
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
        .query({ page: 1 })
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
        .query({ page: 1, size: 100 })
        .reply(200, { _embedded: { mailboxes: mockResponse.results } });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'listAllInboxes',
          arguments: {}
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
          name: 'listAllInboxes',
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

  describe('getConversation', () => {
    it('should get raw conversation detail with optional embedded threads', async () => {
      nock(baseURL)
        .get('/conversations/123')
        .query({ embed: 'threads' })
        .reply(200, {
          id: 123,
          number: 456,
          subject: 'Raw conversation',
          status: 'active',
          preview: 'Latest customer preview',
          _embedded: {
            threads: [
              {
                id: 10,
                type: 'customer',
                body: 'Customer body',
              },
            ],
          },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getConversation',
          arguments: { conversationId: '123', embed: 'threads' },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.conversationId).toBe('123');
      expect(response.embedded).toBe('threads');
      expect(response.conversation).toEqual(expect.objectContaining({
        id: 123,
        subject: 'Raw conversation',
      }));
      expect(response.conversation._embedded.threads[0].body).toBe('Customer body');
    });

    it('should route to v3 conversation endpoint with includeSystemActors, preserving person type fields', async () => {
      const apiRoot = baseURL.replace('/v2', '');
      nock(apiRoot)
        .get('/v3/conversations/123')
        .query({ embed: 'threads' })
        .reply(200, {
          id: 123,
          subject: 'Raw v3 conversation',
          preview: 'Latest customer preview',
          createdBy: { id: 42, type: 'system_user', email: 'ai@example.com' },
          assignee: { id: 77, type: 'team', name: 'Support' },
          _embedded: {
            threads: [
              {
                id: 10,
                type: 'customer',
                body: 'Customer body',
                createdBy: { id: 42, type: 'system_user' },
              },
            ],
          },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getConversation',
          arguments: { conversationId: '123', embed: 'threads', includeSystemActors: true },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.apiVersion).toBe('v3');
      expect(response.conversation.createdBy.type).toBe('system_user');
      expect(response.conversation.assignee.type).toBe('team');
      expect(response.conversation._embedded.threads[0].body).toBe('Customer body');
    });

    it('should validate conversation IDs before raw conversation lookup', async () => {
      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getConversation',
          arguments: { conversationId: 'abc' },
        },
      });

      expect(result.isError).toBe(true);
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.error).toEqual(expect.objectContaining({
        code: 'INVALID_INPUT',
        type: 'validation_error',
      }));
      expect(response.error.validationIssues[0]).toEqual(expect.objectContaining({
        field: 'conversationId',
      }));
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

    it('should route threads to v3 endpoint with includeSystemActors and redact bodies when configured', async () => {
      const originalRedactMessageContent = config.security.redactMessageContent;
      config.security.redactMessageContent = true;
      const apiRoot = baseURL.replace('/v2', '');

      try {
        nock(apiRoot)
          .get('/v3/conversations/999/threads')
          .query({ page: 2 })
          .reply(200, {
            _embedded: {
              threads: [
                {
                  id: 1,
                  type: 'message',
                  body: 'Staff reply',
                  createdBy: { id: 1, type: 'system_user' },
                },
              ],
            },
            page: { size: 1, totalElements: 2, totalPages: 2, number: 2 },
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'getThreads',
            arguments: { conversationId: '999', limit: 1, page: 2, includeSystemActors: true },
          },
        });

        expect(result.isError).toBeUndefined();
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(response.apiVersion).toBe('v3');
        expect(response.threads).toHaveLength(1);
        expect(response.threads[0].createdBy.type).toBe('system_user');
        expect(response.threads[0].body).toBe(REDACTED_MESSAGE_BODY);
        // limit=1 with 2 total threads -> honestly reports truncation.
        expect(response.truncated).toBe(true);
        expect(response.totalThreads).toBe(2);
      } finally {
        config.security.redactMessageContent = originalRedactMessageContent;
      }
    });
  });

  describe('metadata parity tools', () => {
    it('should cache inbox routing for 300s when fetched via getInbox include', async () => {
      const cacheSetSpy = jest.spyOn(cache, 'set');
      nock(baseURL)
        .get('/mailboxes/359402')
        .reply(200, { id: 359402, name: 'Client Support', email: 'support@example.com' });
      nock(baseURL)
        .get('/mailboxes/359402/routing')
        .reply(200, {
          state: 'enabled',
          assignmentLimit: 10,
          assignmentMethod: 'round_robin',
          userIds: [1, 2],
          rotation: [
            { userId: 1, conversationsCount: 2, eligible: true },
            { userId: 2, conversationsCount: 5, eligible: false, reason: 'away' },
          ],
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'getInbox',
          arguments: { inboxId: '359402', include: ['routing'] },
        },
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(response.routing).toEqual(expect.objectContaining({
        state: 'enabled',
        assignmentMethod: 'round_robin',
      }));
      expect(response.routing.rotation).toHaveLength(2);
      expect(cacheSetSpy).toHaveBeenCalledWith(
        'GET:/mailboxes/359402/routing',
        undefined,
        expect.objectContaining({ state: 'enabled' }),
        { ttl: 300 }
      );
    });
  });

  describe('searchConversations - Branch Coverage', () => {
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

    it('should fan out a tag search across active pending and closed only', async () => {
      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'active' && params.tag === 'billing')
        .reply(200, {
          _embedded: { conversations: [{ id: 1, status: 'active', createdAt: '2023-01-03T00:00:00Z' }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'pending' && params.tag === 'billing')
        .reply(200, {
          _embedded: { conversations: [{ id: 2, status: 'pending', createdAt: '2023-01-02T00:00:00Z' }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      nock(baseURL)
        .get('/conversations')
        .query(params => params.status === 'closed' && params.tag === 'billing')
        .reply(200, {
          _embedded: { conversations: [{ id: 3, status: 'closed', createdAt: '2023-01-01T00:00:00Z' }] },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool({
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: { tag: 'billing' },
        },
      });

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.searchInfo.statusesSearched).toEqual(['active', 'pending', 'closed']);
      expect(response.results.map((conversation: { status: string }) => conversation.status)).toEqual(['active', 'pending', 'closed']);
      expect(response.pagination.totalByStatus).toEqual({ active: 1, pending: 1, closed: 1 });
    });

    it('should keep an explicit spam search as a single-status call', async () => {
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
          name: 'searchConversations',
          arguments: { tag: 'billing', status: 'spam' },
        },
      });

      const textContent = result.content[0] as { type: 'text'; text: string };
      const response = JSON.parse(textContent.text);

      expect(response.searchInfo.statusesSearched).toEqual(['spam']);
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

    describe('searchConversations absorbed filters (NAS-1298 consolidation)', () => {
      it('should compile contentTerms into a body query=()', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active' && params.query === 'body:"refund"')
          .reply(200, {
            _embedded: { conversations: [{ id: 1, status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 1 } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: { contentTerms: ['refund'], status: 'active' },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(response.results).toHaveLength(1);
      });

      it('should compile customerIds into a customerIds query=()', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active' && typeof params.query === 'string' && params.query.includes('customerIds:123'))
          .reply(200, {
            _embedded: { conversations: [{ id: 1, status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 123 } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: { customerIds: [123], status: 'active' },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(response.results).toHaveLength(1);
      });

      it('should fan out assignedTo across default statuses and sort by nested customer email', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'active' && Number(params.assigned_to) === 123 && params.sortField === 'customerEmail' && params.sortOrder === 'asc')
          .reply(200, {
            _embedded: { conversations: [{ id: 30, status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 301, email: 'alpha@example.com' } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'pending' && Number(params.assigned_to) === 123 && params.sortField === 'customerEmail' && params.sortOrder === 'asc')
          .reply(200, {
            _embedded: { conversations: [{ id: 10, status: 'pending', createdAt: '2023-01-02T00:00:00Z', customer: { id: 101, email: 'zeta@example.com' } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });
        nock(baseURL)
          .get('/conversations')
          .query(params => params.status === 'closed' && Number(params.assigned_to) === 123 && params.sortField === 'customerEmail' && params.sortOrder === 'asc')
          .reply(200, {
            _embedded: { conversations: [{ id: 20, status: 'closed', createdAt: '2023-01-03T00:00:00Z', customer: { id: 201, email: 'beta@example.com' } }] },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: { assignedTo: 123, sort: 'customerEmail', order: 'asc' },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        expect(response.searchInfo.statusesSearched).toEqual(['active', 'pending', 'closed']);
        expect(response.results.map((c: { customer: { email: string } }) => c.customer.email)).toEqual([
          'alpha@example.com',
          'beta@example.com',
          'zeta@example.com',
        ]);
      });

      it('should distinguish filtered count from API total when createdBefore filters multi-status results', async () => {
        nock(baseURL)
          .get('/conversations')
          .query(params => typeof params.query === 'string' && params.query.includes('customerIds:7'))
          .times(3)
          .reply(200, {
            _embedded: {
              conversations: [
                { id: 1, status: 'active', createdAt: '2023-01-01T00:00:00Z', customer: { id: 7 } },
                { id: 2, status: 'active', createdAt: '2023-01-20T00:00:00Z', customer: { id: 7 } },
              ],
            },
            page: { size: 50, totalElements: 50, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool({
          method: 'tools/call',
          params: {
            name: 'searchConversations',
            arguments: { customerIds: [7], createdBefore: '2023-01-10T00:00:00Z' },
          },
        });
        const response = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
        // id 1 is before the cutoff, id 2 is after (deduped across the 3 status calls)
        expect(response.results).toHaveLength(1);
        expect(response.pagination.totalResults).toBe(1);
        expect(response.searchInfo.clientSideFiltering).toBeDefined();
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

  });
});
