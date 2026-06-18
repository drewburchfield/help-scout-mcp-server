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

    it('should validate getThreads conversation ID format', () => {
      const context: ToolCallContext = {
        toolName: 'getThreads',
        arguments: { conversationId: 'invalid-id' },
        userQuery: '',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid conversation ID format');
      expect(result.suggestions).toContain('Conversation IDs should be numeric strings');
    });

    it('should suggest explicit status control for searches without status', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { query: 'urgent refund' },
        userQuery: 'find messages about urgent refunds',
        previousCalls: []
      };

      const result = HelpScoutAPIConstraints.validateToolCall(context);

      expect(result.isValid).toBe(true);
      expect(result.suggestions.some(s => s.includes('explicit status'))).toBe(true);
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

    it('should block searchConversations when an inbox is named without inboxId', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: { query: 'urgent' },
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

  describe('generateToolGuidance (constraint-warning composition point)', () => {
    // NAS-1308: the content-aware NEXT-STEP text for listAllInboxes and
    // searchConversations moved to the unified response-guidance layer
    // (src/tools/response-guidance.ts GUIDANCE_MAP, covered by
    // response-guidance.test.ts). generateToolGuidance now only carries genuine
    // API-constraint warnings (currently none) and must not duplicate next-step
    // text anymore.
    it('no longer emits listAllInboxes next-step text', () => {
      const context: ToolCallContext = {
        toolName: 'listAllInboxes',
        arguments: {},
        userQuery: '',
        previousCalls: []
      };
      const guidance = HelpScoutAPIConstraints.generateToolGuidance(
        'listAllInboxes',
        { inboxes: [{ id: '12345', name: 'Support' }] },
        context
      );
      expect(guidance).toEqual([]);
    });

    it('no longer emits searchConversations next-step text', () => {
      const context: ToolCallContext = {
        toolName: 'searchConversations',
        arguments: {},
        userQuery: '',
        previousCalls: []
      };
      expect(
        HelpScoutAPIConstraints.generateToolGuidance('searchConversations', { results: [] }, context)
      ).toEqual([]);
      expect(
        HelpScoutAPIConstraints.generateToolGuidance(
          'searchConversations',
          { results: [{ id: '1' }] },
          context
        )
      ).toEqual([]);
    });
  });
});
