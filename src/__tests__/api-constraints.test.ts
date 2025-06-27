import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';

describe('HelpScoutAPIConstraints', () => {
  describe('validateToolCall', () => {
    it('should detect inbox mention without inboxId', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { query: 'urgent' },
        userQuery: 'search for urgent messages in the support inbox',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('User mentioned an inbox by name but no inboxId provided');
      expect(result.requiredPrerequisites).toContain('searchInboxes');
      expect(result.suggestions[0]).toContain('REQUIRED: Call searchInboxes first');
    });

    it('should allow searchConversations with valid inboxId after searchInboxes', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { query: 'urgent', inboxId: '12345' },
        userQuery: 'search for urgent messages in the support inbox',
        previousCalls: ['searchInboxes']
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate numeric inbox ID format', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { inboxId: 'invalid-id' },
        userQuery: '',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid inbox ID format - should be numeric');
    });

    it('should validate conversation ID format', () => {
      const context: ToolCallContext = {
        toolName: 'getConversationSummary',
        arguments: { conversationId: 'invalid-id' },
        userQuery: '',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid conversation ID format');
    });

    it('should suggest comprehensiveConversationSearch for searches without status', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { query: 'urgent refund' },
        userQuery: 'find messages about urgent refunds',  // Use words not in inbox keywords
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(true);
      expect(result.suggestions.some(s => s.includes('comprehensiveConversationSearch for better results'))).toBe(true);
    });

    it('should validate comprehensiveConversationSearch searchTerms', () => {
      const context: ToolCallContext = {
        toolName: 'comprehensiveConversationSearch',
        arguments: {},
        userQuery: '',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('searchTerms is required and must be a non-empty array');
    });
  });

  describe('inbox mention detection', () => {
    const testCases = [
      'search in the support inbox',
      'find messages from billing mailbox',
      'check sales queue',
      'look at technical support',
      'customer service inbox',
      'general help desk'
    ];

    testCases.forEach(query => {
      it(`should detect inbox mention in: "${query}"`, () => {
        const context: ToolCallContext = {
          toolName: 'searchConversations',
          arguments: {},
          userQuery: query,
          previousCalls: []
        };

        const result = HelpScoutAPIConstraints.validateToolCall(context);
        
        // Should suggest searchInboxes first
        expect(result.suggestions.some(s => s.includes('searchInboxes'))).toBe(true);
      });
    });
  });

  describe('generateToolGuidance', () => {
    it('should provide next steps for searchInboxes results', () => {
      const mockResult = {
        results: [{ id: '12345', name: 'Support' }]
      };

      const context: ToolCallContext = {
        toolName: 'searchInboxes',
        arguments: {},
        userQuery: '',
        previousCalls: []
      };

      const guidance = HelpScoutAPIConstraints.generateToolGuidance('searchInboxes', mockResult, context);

      expect(guidance[0]).toContain('✅ NEXT STEP');
      expect(guidance[1]).toContain('"inboxId": "12345"');
    });

    it('should provide troubleshooting for empty conversation results', () => {
      const mockResult = {
        results: []
      };

      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: {},
        userQuery: '',
        previousCalls: []
      };

      const guidance = HelpScoutAPIConstraints.generateToolGuidance('searchConversations', mockResult, context);

      expect(guidance[0]).toContain('❌ No conversations found');
      expect(guidance.some(g => g.includes('Different status'))).toBe(true);
    });

    it('should provide next steps for successful conversation search', () => {
      const mockResult = {
        results: [{ id: '1' }, { id: '2' }]
      };

      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: {},
        userQuery: '',
        previousCalls: []
      };

      const guidance = HelpScoutAPIConstraints.generateToolGuidance('searchConversations', mockResult, context);

      expect(guidance[0]).toContain('✅ Found 2 conversations');
      expect(guidance[1]).toContain('getConversationSummary or getThreads');
    });
  });
});