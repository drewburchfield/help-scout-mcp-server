import { 
  AttachmentSchema,
  DownloadAttachmentInputSchema,
  MultiStatusConversationSearchInputSchema,
  SearchConversationsInputSchema,
  ThreadSchema,
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
  });

  describe('AttachmentSchema', () => {
    it('should validate a valid attachment', () => {
      const attachment = {
        id: 123,
        filename: 'screenshot.png',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        size: 45000,
      };

      const parsed = AttachmentSchema.parse(attachment);

      expect(parsed.id).toBe(123);
      expect(parsed.filename).toBe('screenshot.png');
      expect(parsed.mimeType).toBe('image/png');
      expect(parsed.width).toBe(800);
      expect(parsed.height).toBe(600);
      expect(parsed.size).toBe(45000);
    });

    it('should validate attachment without optional dimensions', () => {
      const attachment = {
        id: 456,
        filename: 'report.pdf',
        mimeType: 'application/pdf',
      };

      const parsed = AttachmentSchema.parse(attachment);

      expect(parsed.id).toBe(456);
      expect(parsed.filename).toBe('report.pdf');
      expect(parsed.mimeType).toBe('application/pdf');
      expect(parsed.width).toBeUndefined();
      expect(parsed.height).toBeUndefined();
      expect(parsed.size).toBeUndefined();
    });
  });

  describe('ThreadSchema with _embedded.attachments', () => {
    const baseThread = {
      id: 1,
      type: 'customer' as const,
      status: 'active' as const,
      state: 'published' as const,
      action: null,
      body: 'Hello',
      source: { type: 'email', via: 'customer' },
      customer: { id: 1, firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
      createdBy: { id: 1, firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
      assignedTo: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    it('should validate thread with attachments', () => {
      const thread = {
        ...baseThread,
        _embedded: {
          attachments: [
            { id: 10, filename: 'file.txt', mimeType: 'text/plain', size: 1024 },
            { id: 11, filename: 'image.png', mimeType: 'image/png', width: 100, height: 200 },
          ],
        },
      };

      const parsed = ThreadSchema.parse(thread);

      expect(parsed._embedded).toBeDefined();
      expect(parsed._embedded!.attachments).toHaveLength(2);
      expect(parsed._embedded!.attachments[0].filename).toBe('file.txt');
      expect(parsed._embedded!.attachments[1].width).toBe(100);
    });

    it('should validate thread without _embedded', () => {
      const parsed = ThreadSchema.parse(baseThread);

      expect(parsed._embedded).toBeUndefined();
    });
  });

  describe('DownloadAttachmentInputSchema', () => {
    it('should validate valid input', () => {
      const input = {
        conversationId: '12345',
        attachmentId: '67890',
      };

      const parsed = DownloadAttachmentInputSchema.parse(input);

      expect(parsed.conversationId).toBe('12345');
      expect(parsed.attachmentId).toBe('67890');
    });

    it('should reject missing conversationId', () => {
      expect(() => {
        DownloadAttachmentInputSchema.parse({
          attachmentId: '67890',
        });
      }).toThrow();
    });

    it('should reject missing attachmentId', () => {
      expect(() => {
        DownloadAttachmentInputSchema.parse({
          conversationId: '12345',
        });
      }).toThrow();
    });
  });
});