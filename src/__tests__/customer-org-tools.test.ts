import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { cache } from '../utils/cache.js';
import { config } from '../utils/config.js';

describe('Customer & Organization Tools', () => {
  let toolHandler: ToolHandler;
  const baseURL = 'https://api.helpscout.net/v2';

  beforeEach(() => {
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;

    nock.cleanAll();
    cache.clear();

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

  function makeRequest(name: string, args: Record<string, unknown>): CallToolRequest {
    return {
      method: 'tools/call',
      params: { name, arguments: args },
    } as CallToolRequest;
  }

  function parseResult(result: { content: Array<{ type: string; text?: string }> }) {
    return JSON.parse(result.content[0].text as string);
  }

  describe('getCustomer', () => {
    it('should fetch a customer profile with address', async () => {
      nock(baseURL)
        .get('/customers/123')
        .query(true)
        .reply(200, {
          id: 123,
          firstName: 'Jane',
          lastName: 'Doe',
          organizationId: 456,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-06-01T00:00:00Z',
          _embedded: {
            emails: [{ id: 1, value: 'jane@example.com', type: 'work' }],
            phones: [{ id: 2, value: '+1234567890', type: 'mobile' }],
          },
        })
        .get('/customers/123/address')
        .query(true)
        .reply(200, {
          city: 'Nashville',
          state: 'TN',
          postalCode: '37201',
          country: 'US',
        });

      const result = await toolHandler.callTool(makeRequest('getCustomer', { customerId: '123' }));
      const data = parseResult(result);

      expect(data.customer.id).toBe(123);
      expect(data.customer.firstName).toBe('Jane');
      expect(data.customer.address).toBeDefined();
      expect(data.usage).toContain('getOrganization');
    });

    it('should handle missing address gracefully', async () => {
      nock(baseURL)
        .get('/customers/123')
        .query(true)
        .reply(200, {
          id: 123,
          firstName: 'Jane',
          lastName: 'Doe',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-06-01T00:00:00Z',
        })
        .get('/customers/123/address')
        .query(true)
        .reply(404, { message: 'Not Found' });

      const result = await toolHandler.callTool(makeRequest('getCustomer', { customerId: '123' }));
      const data = parseResult(result);

      expect(data.customer.id).toBe(123);
      // Address key should not be present when 404
      expect(data.customer.address).toBeUndefined();
    });

    it('should redact PII when allowPii is false', async () => {
      const originalAllowPii = config.security.allowPii;
      config.security.allowPii = false;

      try {
        nock(baseURL)
          .get('/customers/123')
          .query(true)
          .reply(200, {
            id: 123,
            firstName: 'Jane',
            lastName: 'Doe',
            background: 'Some personal notes',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-06-01T00:00:00Z',
            _embedded: {
              emails: [{ id: 1, value: 'jane@example.com', type: 'work' }],
              phones: [{ id: 2, value: '+1234567890', type: 'mobile' }],
            },
          })
          .get('/customers/123/address')
          .query(true)
          .reply(200, {
            city: 'Nashville',
            state: 'TN',
            postalCode: '37201',
            country: 'US',
          });

        const result = await toolHandler.callTool(makeRequest('getCustomer', { customerId: '123' }));
        const data = parseResult(result);

        expect(data.customer.background).toBe('[redacted]');
        expect(data.customer._embedded.emails[0].value).toBe('[redacted]');
        expect(data.customer._embedded.phones[0].value).toBe('[redacted]');
        expect(data.customer.address.city).toBe('[redacted]');
        expect(data.customer.address.state).toBe('[redacted]');
        expect(data.customer.address.postalCode).toBe('[redacted]');
        expect(data.customer.address.country).toBe('US'); // Country is not PII
      } finally {
        config.security.allowPii = originalAllowPii;
      }
    });
  });

  describe('listCustomers', () => {
    it('should list customers with pagination', async () => {
      nock(baseURL)
        .get('/customers')
        .query(true)
        .reply(200, {
          _embedded: {
            customers: [
              { id: 1, firstName: 'John', lastName: 'Doe', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
              { id: 2, firstName: 'Jane', lastName: 'Smith', createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z' },
            ],
          },
          page: { size: 50, totalElements: 2, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool(makeRequest('listCustomers', {}));
      const data = parseResult(result);

      expect(data.results).toHaveLength(2);
      expect(data.pagination.totalElements).toBe(2);
    });

    it('should filter by firstName', async () => {
      nock(baseURL)
        .get('/customers')
        .query(true)
        .reply(200, {
          _embedded: {
            customers: [
              { id: 1, firstName: 'John', lastName: 'Doe', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
            ],
          },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool(makeRequest('listCustomers', { firstName: 'John' }));
      const data = parseResult(result);

      expect(data.results).toHaveLength(1);
      expect(data.results[0].firstName).toBe('John');
    });
  });

  describe('searchCustomersByEmail', () => {
    it('should search customers via v3 API', async () => {
      nock('https://api.helpscout.net')
        .get('/v3/customers')
        .query(true)
        .reply(200, {
          _embedded: {
            customers: [
              { id: 1, firstName: 'Jane', lastName: 'Doe', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
                _embedded: { emails: [{ id: 1, value: 'jane@example.com', type: 'work' }] } },
            ],
          },
          _links: { next: { href: 'https://api.helpscout.net/v3/customers?cursor=abc' } },
        });

      const result = await toolHandler.callTool(makeRequest('searchCustomersByEmail', { email: 'jane@example.com' }));
      const data = parseResult(result);

      expect(data.results).toHaveLength(1);
      expect(data.results[0].firstName).toBe('Jane');
      expect(data.returnedCount).toBe(1);
      expect(data.nextCursor).toBe('abc');
    });

    it('should redact email and customer data when allowPii is false', async () => {
      const originalAllowPii = config.security.allowPii;
      config.security.allowPii = false;

      try {
        nock('https://api.helpscout.net')
          .get('/v3/customers')
          .query(true)
          .reply(200, {
            _embedded: {
              customers: [
                { id: 1, firstName: 'Jane', lastName: 'Doe', background: 'VIP client', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
                  _embedded: { emails: [{ id: 1, value: 'jane@example.com', type: 'work' }] } },
              ],
            },
          });

        const result = await toolHandler.callTool(makeRequest('searchCustomersByEmail', { email: 'jane@example.com' }));
        const data = parseResult(result);

        expect(data.searchedEmail).toBe('[redacted]');
        expect(data.results[0].background).toBe('[redacted]');
        expect(data.results[0]._embedded.emails[0].value).toBe('[redacted]');
      } finally {
        config.security.allowPii = originalAllowPii;
      }
    });

    it('should handle empty results', async () => {
      nock('https://api.helpscout.net')
        .get('/v3/customers')
        .query(true)
        .reply(200, { _embedded: { customers: [] } });

      const result = await toolHandler.callTool(makeRequest('searchCustomersByEmail', { email: 'nobody@example.com' }));
      const data = parseResult(result);

      expect(data.results).toHaveLength(0);
      expect(data.returnedCount).toBe(0);
    });
  });

  describe('getCustomer - error handling', () => {
    it('should propagate 429 rate limit from address endpoint', async () => {
      nock(baseURL)
        .get('/customers/123')
        .query(true)
        .reply(200, {
          id: 123, firstName: 'Jane', lastName: 'Doe',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        });

      // Persist the 429 so retries also get rate-limited, with short retry-after
      nock(baseURL)
        .get('/customers/123/address')
        .query(true)
        .times(4) // 1 initial + 3 retries
        .reply(429, { message: 'Rate limit exceeded' }, { 'Retry-After': '0' });

      const result = await toolHandler.callTool(makeRequest('getCustomer', { customerId: '123' }));
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('RATE_LIMIT');
    });

    it('should surface non-critical address errors in response', async () => {
      nock(baseURL)
        .get('/customers/123')
        .query(true)
        .reply(200, {
          id: 123, firstName: 'Jane', lastName: 'Doe',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        })
        .get('/customers/123/address')
        .query(true)
        .times(4) // 1 initial + 3 retries
        .reply(500, { message: 'Internal Server Error' });

      const result = await toolHandler.callTool(makeRequest('getCustomer', { customerId: '123' }));
      const data = parseResult(result);

      expect(data.customer.id).toBe(123);
      expect(data.customer.address).toBeUndefined();
      expect(data.customer.addressNote).toContain('Address lookup failed');
    });
  });

  describe('getOrganization', () => {
    it('should fetch organization with counts', async () => {
      nock(baseURL)
        .get('/organizations/456')
        .query(true)
        .reply(200, {
          id: 456,
          name: 'Acme Corp',
          website: 'https://acme.com',
          domains: ['acme.com'],
          customerCount: 10,
          conversationCount: 25,
        });

      const result = await toolHandler.callTool(makeRequest('getOrganization', { organizationId: '456' }));
      const data = parseResult(result);

      expect(data.organization.id).toBe(456);
      expect(data.organization.name).toBe('Acme Corp');
      expect(data.organization.customerCount).toBe(10);
      expect(data.usage).toContain('getOrganizationMembers');
    });
  });

  describe('listOrganizations', () => {
    it('should list organizations with default sorting', async () => {
      nock(baseURL)
        .get('/organizations')
        .query(true)
        .reply(200, {
          _embedded: {
            organizations: [
              { id: 1, name: 'Org A' },
              { id: 2, name: 'Org B' },
            ],
          },
          page: { size: 50, totalElements: 2, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool(makeRequest('listOrganizations', {}));
      const data = parseResult(result);

      expect(data.results).toHaveLength(2);
    });
  });

  describe('getOrganizationMembers', () => {
    it('should fetch customers belonging to an organization', async () => {
      nock(baseURL)
        .get('/organizations/456/customers')
        .query(true)
        .reply(200, {
          _embedded: {
            customers: [
              { id: 1, firstName: 'John', lastName: 'Doe', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
              { id: 2, firstName: 'Jane', lastName: 'Smith', createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z' },
            ],
          },
          page: { size: 50, totalElements: 2, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool(makeRequest('getOrganizationMembers', { organizationId: '456' }));
      const data = parseResult(result);

      expect(data.organizationId).toBe('456');
      expect(data.members).toHaveLength(2);
      expect(data.usage).toContain('getCustomer');
    });
  });

  describe('getOrganizationConversations', () => {
    it('should fetch conversations for an organization', async () => {
      nock(baseURL)
        .get('/organizations/456/conversations')
        .query(true)
        .reply(200, {
          _embedded: {
            conversations: [
              {
                id: 100,
                number: 1001,
                subject: 'Billing question',
                status: 'active',
                customer: { id: 1, firstName: 'John', lastName: 'Doe', email: 'john@acme.com' },
                assignee: null,
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-02T00:00:00Z',
                closedAt: null,
                tags: [],
              },
            ],
          },
          page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
        });

      const result = await toolHandler.callTool(makeRequest('getOrganizationConversations', { organizationId: '456' }));
      const data = parseResult(result);

      expect(data.organizationId).toBe('456');
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].subject).toBe('Billing question');
      expect(data.usage).toContain('getThreads');
    });
  });

  // ── PII Redaction Tests (F9) ──

  describe('PII redaction for organizations', () => {
    it('should redact PII in getOrganization when allowPii is false', async () => {
      const originalAllowPii = config.security.allowPii;
      config.security.allowPii = false;

      try {
        nock(baseURL)
          .get('/organizations/456')
          .query(true)
          .reply(200, {
            id: 456,
            name: 'Acme Corp',
            website: 'https://acme.com',
            domains: ['acme.com', 'acme.io'],
            phones: ['+1-555-0100'],
            location: 'Nashville, TN',
            note: 'Key account, handle with care',
            description: 'Enterprise SaaS company',
            logoUrl: 'https://acme.com/logo.png',
            brandColor: '#FF0000',
            customerCount: 10,
            conversationCount: 25,
          });

        const result = await toolHandler.callTool(makeRequest('getOrganization', { organizationId: '456' }));
        const data = parseResult(result);

        // Preserved fields
        expect(data.organization.id).toBe(456);
        expect(data.organization.name).toBe('Acme Corp');
        expect(data.organization.customerCount).toBe(10);
        expect(data.organization.logoUrl).toBe('https://acme.com/logo.png');
        expect(data.organization.brandColor).toBe('#FF0000');

        // Redacted fields (arrays preserve element count)
        expect(data.organization.website).toBe('[redacted]');
        expect(data.organization.domains).toEqual(['[redacted]', '[redacted]']);
        expect(data.organization.phones).toEqual(['[redacted]']);
        expect(data.organization.location).toBe('[redacted]');
        expect(data.organization.note).toBe('[redacted]');
        expect(data.organization.description).toBe('[redacted]');
      } finally {
        config.security.allowPii = originalAllowPii;
      }
    });

    it('should redact PII in listOrganizations when allowPii is false', async () => {
      const originalAllowPii = config.security.allowPii;
      config.security.allowPii = false;

      try {
        nock(baseURL)
          .get('/organizations')
          .query(true)
          .reply(200, {
            _embedded: {
              organizations: [
                {
                  id: 1, name: 'Org A', website: 'https://orga.com',
                  domains: ['orga.com'], phones: ['+1-555-0101'],
                  location: 'Austin, TX', note: 'Notes here', description: 'Desc here',
                },
              ],
            },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool(makeRequest('listOrganizations', {}));
        const data = parseResult(result);

        expect(data.results[0].name).toBe('Org A');
        expect(data.results[0].website).toBe('[redacted]');
        expect(data.results[0].domains).toEqual(['[redacted]']);
        expect(data.results[0].phones).toEqual(['[redacted]']);
        expect(data.results[0].location).toBe('[redacted]');
        expect(data.results[0].note).toBe('[redacted]');
        expect(data.results[0].description).toBe('[redacted]');
      } finally {
        config.security.allowPii = originalAllowPii;
      }
    });

    it('should redact customer PII in getOrganizationConversations when allowPii is false', async () => {
      const originalAllowPii = config.security.allowPii;
      config.security.allowPii = false;

      try {
        nock(baseURL)
          .get('/organizations/456/conversations')
          .query(true)
          .reply(200, {
            _embedded: {
              conversations: [
                {
                  id: 100, number: 1001, subject: 'Billing question', status: 'active',
                  customer: { id: 1, firstName: 'John', lastName: 'Doe', email: 'john@acme.com' },
                  assignee: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z',
                  closedAt: null, tags: [],
                },
              ],
            },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool(makeRequest('getOrganizationConversations', { organizationId: '456' }));
        const data = parseResult(result);

        // Customer ID preserved, PII redacted
        expect(data.conversations[0].customer.id).toBe(1);
        expect(data.conversations[0].customer.email).toBe('[redacted]');
        expect(data.conversations[0].customer.firstName).toBe('[redacted]');
        expect(data.conversations[0].customer.lastName).toBe('[redacted]');
      } finally {
        config.security.allowPii = originalAllowPii;
      }
    });

    it('should redact customer fields in getOrganizationMembers when allowPii is false', async () => {
      const originalAllowPii = config.security.allowPii;
      config.security.allowPii = false;

      try {
        nock(baseURL)
          .get('/organizations/456/customers')
          .query(true)
          .reply(200, {
            _embedded: {
              customers: [
                {
                  id: 1, firstName: 'John', lastName: 'Doe',
                  jobTitle: 'CTO', location: 'Nashville, TN',
                  photoUrl: 'https://example.com/photo.jpg', age: '35',
                  createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
                },
              ],
            },
            page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
          });

        const result = await toolHandler.callTool(makeRequest('getOrganizationMembers', { organizationId: '456' }));
        const data = parseResult(result);

        // ID preserved
        expect(data.members[0].id).toBe(1);
        // PII redacted
        expect(data.members[0].firstName).toBe('[redacted]');
        expect(data.members[0].lastName).toBe('[redacted]');
        expect(data.members[0].jobTitle).toBe('[redacted]');
        expect(data.members[0].location).toBe('[redacted]');
        expect(data.members[0].photoUrl).toBe('[redacted]');
        expect(data.members[0].age).toBe('[redacted]');
      } finally {
        config.security.allowPii = originalAllowPii;
      }
    });
  });

  describe('getCustomerContacts', () => {
    const mockEmails = { _embedded: { emails: [{ id: 1, value: 'jane@example.com', type: 'work' }] } };
    const mockPhones = { _embedded: { phones: [{ id: 2, value: '+1-555-0100', type: 'work' }] } };
    const mockChats = { _embedded: { chats: [{ id: 3, value: 'jane.doe', type: 'other' }] } };
    const mockSocial = { _embedded: { social_profiles: [{ id: 4, value: '@janedoe', type: 'twitter' }] } };
    const mockWebsites = { _embedded: { websites: [{ id: 5, value: 'https://janedoe.com' }] } };
    const mockAddress = { city: 'Nashville', state: 'TN', postalCode: '37201', country: 'US', lines: ['100 Broadway'] };

    function mockAllSubResources(cid: string) {
      nock(baseURL).get(`/customers/${cid}/emails`).query(true).reply(200, mockEmails);
      nock(baseURL).get(`/customers/${cid}/phones`).query(true).reply(200, mockPhones);
      nock(baseURL).get(`/customers/${cid}/chats`).query(true).reply(200, mockChats);
      nock(baseURL).get(`/customers/${cid}/social-profiles`).query(true).reply(200, mockSocial);
      nock(baseURL).get(`/customers/${cid}/websites`).query(true).reply(200, mockWebsites);
      nock(baseURL).get(`/customers/${cid}/address`).query(true).reply(200, mockAddress);
    }

    it('should fetch all 6 sub-resources in parallel', async () => {
      mockAllSubResources('123');
      const result = await toolHandler.callTool(makeRequest('getCustomerContacts', { customerId: '123' }));
      const data = parseResult(result);

      expect(data.customerId).toBe('123');
      expect(data.emails).toHaveLength(1);
      expect(data.emails[0].value).toBe('jane@example.com');
      expect(data.phones).toHaveLength(1);
      expect(data.phones[0].value).toBe('+1-555-0100');
      expect(data.chats).toHaveLength(1);
      expect(data.socialProfiles).toHaveLength(1);
      expect(data.websites).toHaveLength(1);
      expect(data.address).toBeTruthy();
      expect(data.address.city).toBe('Nashville');
      expect(data.partialErrors).toBeUndefined();
    });

    it('should handle 404s as empty data (no error)', async () => {
      // All sub-resources return 404
      for (const path of ['/emails', '/phones', '/chats', '/social-profiles', '/websites', '/address']) {
        nock(baseURL).get(`/customers/999${path}`).query(true).reply(404, { message: 'Not found' });
      }
      const result = await toolHandler.callTool(makeRequest('getCustomerContacts', { customerId: '999' }));
      const data = parseResult(result);

      expect(data.emails).toEqual([]);
      expect(data.phones).toEqual([]);
      expect(data.chats).toEqual([]);
      expect(data.socialProfiles).toEqual([]);
      expect(data.websites).toEqual([]);
      expect(data.address).toBeNull();
      expect(data.warning).toContain('No contact data found');
    });

    it('should report partial errors when some sub-resources fail', async () => {
      nock(baseURL).get('/customers/123/emails').query(true).reply(200, mockEmails);
      nock(baseURL).get('/customers/123/phones').query(true).reply(500, { message: 'Server Error' });
      nock(baseURL).get('/customers/123/chats').query(true).reply(200, mockChats);
      nock(baseURL).get('/customers/123/social-profiles').query(true).reply(200, mockSocial);
      nock(baseURL).get('/customers/123/websites').query(true).reply(200, mockWebsites);
      nock(baseURL).get('/customers/123/address').query(true).reply(200, mockAddress);

      const result = await toolHandler.callTool(makeRequest('getCustomerContacts', { customerId: '123' }));
      const data = parseResult(result);

      expect(data.emails).toHaveLength(1);
      expect(data.phones).toEqual([]);
      expect(data.partialErrors).toBeDefined();
      expect(data.partialErrors.length).toBeGreaterThan(0);
    });

    it('should redact PII when allowPii is false', async () => {
      const originalAllowPii = config.security.allowPii;
      config.security.allowPii = false;
      try {
        mockAllSubResources('123');
        const result = await toolHandler.callTool(makeRequest('getCustomerContacts', { customerId: '123' }));
        const data = parseResult(result);

        expect(data.emails[0].value).toBe('[redacted]');
        expect(data.phones[0].value).toBe('[redacted]');
        expect(data.chats[0].value).toBe('[redacted]');
        expect(data.socialProfiles[0].value).toBe('[redacted]');
        expect(data.websites[0].value).toBe('[redacted]');
        // Address: city/state/postal redacted, country preserved
        expect(data.address.city).toBe('[redacted]');
        expect(data.address.state).toBe('[redacted]');
        expect(data.address.postalCode).toBe('[redacted]');
        expect(data.address.country).toBe('US');
      } finally {
        config.security.allowPii = originalAllowPii;
      }
    });

    it('should reject non-numeric customerId', async () => {
      const result = await toolHandler.callTool(makeRequest('getCustomerContacts', { customerId: 'abc' }));
      expect((result as any).isError).toBe(true);
    });
  });
});
