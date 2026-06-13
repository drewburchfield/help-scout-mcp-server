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
      expect(result.requiredPrerequisites).toContain('listAllInboxes');
      expect(result.suggestions[0]).toContain('server instructions');
      expect(result.suggestions[0]).toContain('listAllInboxes');
    });

    it('should allow searchConversations with valid inboxId after listAllInboxes', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { query: 'urgent', inboxId: '12345' },
        userQuery: 'search for urgent messages in the support inbox',
        previousCalls: ['listAllInboxes']
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
        userQuery: 'find messages about urgent refunds',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(true);
      expect(result.suggestions.some(s => s.includes('comprehensiveConversationSearch'))).toBe(true);
    });

    it('should allow global searches that contain generic support topics', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { query: 'billing issues' },
        userQuery: 'find all conversations about billing issues in support history',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(true);
      expect(result.errors).not.toContain('User mentioned an inbox by name but no inboxId provided');
      expect(result.requiredPrerequisites).toBeUndefined();
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

    it('should block comprehensiveConversationSearch when an inbox is named without inboxId', () => {
      const context: ToolCallContext = {
        toolName: 'comprehensiveConversationSearch',
        arguments: { searchTerms: ['urgent'] },
        userQuery: 'find urgent conversations in the support inbox',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('User mentioned an inbox by name but no inboxId provided');
      expect(result.requiredPrerequisites).toContain('listAllInboxes');
    });
  });

  describe('inbox mention detection', () => {
    const testCases = [
      'search in the support inbox',
      'find messages from billing mailbox',
      'check sales queue',
      'customer service inbox',
      'general help desk inbox'
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
        
        // Should direct callers to the current inbox discovery path.
        expect(result.suggestions.some(s => s.includes('listAllInboxes'))).toBe(true);
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
