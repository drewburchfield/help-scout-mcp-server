import {
  GetCompanyReportInputSchema,
  GetOrganizationConversationsInputSchema,
  GetOrganizationMembersInputSchema,
  GetThreadsInputSchema,
  ListAllInboxesInputSchema,
  ListCustomersInputSchema,
  ListOrganizationsInputSchema,
  SearchConversationsInputSchema,
  SearchInboxesInputSchema,
} from '../schema/types.js';

describe('Schema Validation', () => {
  describe('SearchConversationsInputSchema multi-status defaults', () => {
    it('should accept content filters with sensible defaults', () => {
      const parsed = SearchConversationsInputSchema.parse({
        contentTerms: ['urgent', 'billing'],
      });

      expect(parsed.contentTerms).toEqual(['urgent', 'billing']);
      expect(parsed.status).toBeUndefined();
      expect(parsed.limit).toBe(50);
      expect(parsed.sort).toBe('createdAt');
      expect(parsed.order).toBe('desc');
    });

    it('should validate status enum and reject invalid values', () => {
      expect(SearchConversationsInputSchema.parse({ status: 'spam' }).status).toBe('spam');
      expect(() => SearchConversationsInputSchema.parse({ status: 'invalid' })).toThrow();
    });

    it('should reject out-of-range and fractional limits', () => {
      expect(() => SearchConversationsInputSchema.parse({ limit: 0 })).toThrow();
      expect(() => SearchConversationsInputSchema.parse({ limit: 201 })).toThrow();
      expect(() => SearchConversationsInputSchema.parse({ limit: 10.5 })).toThrow();
    });

    it('should accept date overrides', () => {
      const parsed = SearchConversationsInputSchema.parse({
        contentTerms: ['test'],
        createdAfter: '2024-01-01T00:00:00Z',
        createdBefore: '2024-12-31T23:59:59Z',
      });

      expect(parsed.createdAfter).toBe('2024-01-01T00:00:00Z');
      expect(parsed.createdBefore).toBe('2024-12-31T23:59:59Z');
    });
  });

  describe('SearchConversationsInputSchema', () => {
    it('should accept query without status', () => {
      const input = {
        query: '(body:"test")'
      };

      const parsed = SearchConversationsInputSchema.parse(input);
      
      expect(parsed.query).toBe('(body:"test")');
      expect(parsed.status).toBeUndefined();
      expect(parsed.limit).toBe(50);
      expect(parsed.page).toBe(1);
    });

    it('should validate status enum', () => {
      const validStatuses = ['active', 'pending', 'closed', 'spam'];
      
      validStatuses.forEach(status => {
        const parsed = SearchConversationsInputSchema.parse({
          status
        });
        expect(parsed.status).toBe(status);
      });

      expect(() => {
        SearchConversationsInputSchema.parse({
          status: 'invalid'
        });
      }).toThrow();
    });

    it('should reject fractional limit values', () => {
      expect(() => {
        SearchConversationsInputSchema.parse({
          limit: 25.7
        });
      }).toThrow();
    });
  });

  describe('v2 page-based pagination schemas', () => {
    it('should accept numeric page inputs for v2 paginated tools', () => {
      expect(SearchInboxesInputSchema.parse({ query: '', page: 2 }).page).toBe(2);
      expect(SearchConversationsInputSchema.parse({ page: 3 }).page).toBe(3);
      expect(GetThreadsInputSchema.parse({ conversationId: '123', page: 4 }).page).toBe(4);
      expect(SearchConversationsInputSchema.parse({ tag: 'billing', page: 5 }).page).toBe(5);
      expect(SearchConversationsInputSchema.parse({ assignedTo: -1, page: 6 }).page).toBe(6);
    });

    it('should reject fractional page inputs for v2 paginated tools', () => {
      const cases = [
        () => SearchInboxesInputSchema.parse({ query: '', page: 1.5 }),
        () => SearchConversationsInputSchema.parse({ page: 1.5 }),
        () => GetThreadsInputSchema.parse({ conversationId: '123', page: 1.5 }),
        () => SearchConversationsInputSchema.parse({ tag: 'billing', page: 1.5 }),
        () => SearchConversationsInputSchema.parse({ assignedTo: -1, page: 1.5 }),
      ];

      cases.forEach(parse => expect(parse).toThrow());
    });
  });

  describe('integer-only numeric tool inputs', () => {
    it('should reject fractional paging and limit values', () => {
      const cases = [
        () => SearchInboxesInputSchema.parse({ query: '', limit: 1.5 }),
        () => GetThreadsInputSchema.parse({ conversationId: '123', limit: 1.5 }),
        () => SearchConversationsInputSchema.parse({ assignedTo: -1, limit: 1.5 }),
        () => ListCustomersInputSchema.parse({ page: 1.5 }),
        () => ListCustomersInputSchema.parse({ mailbox: 123.5 }),
        () => ListOrganizationsInputSchema.parse({ page: 1.5 }),
        () => GetOrganizationMembersInputSchema.parse({ organizationId: '123', page: 1.5 }),
        () => GetOrganizationConversationsInputSchema.parse({ organizationId: '123', page: 1.5 }),
        () => ListAllInboxesInputSchema.parse({ limit: 1.5 }),
      ];

      cases.forEach(parse => expect(parse).toThrow());
    });
  });

  describe('report date schemas', () => {
    it('should accept valid date-only and datetime report inputs', () => {
      expect(GetCompanyReportInputSchema.parse({
        start: '2026-01-01',
        end: '2026-01-31T23:59:59Z',
      })).toEqual(expect.objectContaining({
        start: '2026-01-01',
        end: '2026-01-31T23:59:59Z',
      }));

      expect(GetCompanyReportInputSchema.parse({
        start: '2026-02-01T00:00:00.250-06:00',
        end: '2026-02-28T23:59:59+05:30',
      })).toEqual(expect.objectContaining({
        start: '2026-02-01T00:00:00.250-06:00',
        end: '2026-02-28T23:59:59+05:30',
      }));
    });

    it('should reject malformed or impossible report dates', () => {
      const invalidDateCases = [
        '2026-99-99',
        '2026-02-31',
        '2026-01-01T99:00:00Z',
        '2026-01-01T23:99:00Z',
        '2026-01-01T23:59:99Z',
        '2026-01-01T23:59:59+99:00',
        '2026-01-01T23:59:59+05:99',
        '2026-01-01T',
      ];

      for (const invalidDate of invalidDateCases) {
        expect(() => GetCompanyReportInputSchema.parse({
          start: invalidDate,
          end: '2026-01-31',
        })).toThrow('Report dates must be valid ISO 8601 strings');
      }
    });
  });
});
