import { 
  GetOrganizationConversationsInputSchema,
  GetOrganizationMembersInputSchema,
  GetThreadsInputSchema,
  ListAllInboxesInputSchema,
  ListCustomersInputSchema,
  ListOrganizationsInputSchema,
  MultiStatusConversationSearchInputSchema,
  SearchConversationsInputSchema,
  SearchInboxesInputSchema,
  StructuredConversationFilterInputSchema,
} from '../schema/types.js';

describe('Schema Validation', () => {
  describe('MultiStatusConversationSearchInputSchema', () => {
    it('should require searchTerms', () => {
      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({});
      }).toThrow();

      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: []
        });
      }).toThrow('At least one search term is required');
    });

    it('should accept valid input with defaults', () => {
      const input = {
        searchTerms: ['urgent', 'billing']
      };

      const parsed = MultiStatusConversationSearchInputSchema.parse(input);
      
      expect(parsed.searchTerms).toEqual(['urgent', 'billing']);
      expect(parsed.statuses).toEqual(['active', 'pending', 'closed']);
      expect(parsed.searchIn).toEqual(['both']);
      expect(parsed.timeframeDays).toBe(60);
      expect(parsed.limitPerStatus).toBe(25);
    });

    it('should accept custom statuses', () => {
      const input = {
        searchTerms: ['test'],
        statuses: ['active', 'spam']
      };

      const parsed = MultiStatusConversationSearchInputSchema.parse(input);
      
      expect(parsed.statuses).toEqual(['active', 'spam']);
    });

    it('should validate enum values', () => {
      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          statuses: ['invalid']
        });
      }).toThrow();

      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          searchIn: ['invalid']
        });
      }).toThrow();
    });

    it('should validate number ranges', () => {
      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          timeframeDays: 0
        });
      }).toThrow();

      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          timeframeDays: 400
        });
      }).toThrow();

      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          limitPerStatus: 0
        });
      }).toThrow();

      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          limitPerStatus: 101
        });
      }).toThrow();
    });

    it('should reject fractional numeric controls', () => {
      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          timeframeDays: 30.5
        });
      }).toThrow();

      expect(() => {
        MultiStatusConversationSearchInputSchema.parse({
          searchTerms: ['test'],
          limitPerStatus: 10.5
        });
      }).toThrow();
    });

    it('should accept date overrides', () => {
      const input = {
        searchTerms: ['test'],
        createdAfter: '2024-01-01T00:00:00Z',
        createdBefore: '2024-12-31T23:59:59Z'
      };

      const parsed = MultiStatusConversationSearchInputSchema.parse(input);
      
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

  describe('integer-only numeric tool inputs', () => {
    it('should reject fractional paging and limit values', () => {
      const cases = [
        () => SearchInboxesInputSchema.parse({ query: '', limit: 1.5 }),
        () => GetThreadsInputSchema.parse({ conversationId: '123', limit: 1.5 }),
        () => StructuredConversationFilterInputSchema.parse({ assignedTo: -1, limit: 1.5 }),
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
});
