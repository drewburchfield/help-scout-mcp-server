/**
 * @jest-environment node
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock logger first
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
};

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: mockLogger,
}));

describe('PromptHandler', () => {
  let PromptHandler: any;
  let promptHandler: any;

  beforeEach(async () => {
    // Clear all mocks
    jest.clearAllMocks();

    // Import the module after mocks are set up
    const module = await import('../prompts/index.js');
    PromptHandler = module.PromptHandler;
    promptHandler = new PromptHandler();
  });

  describe('listPrompts', () => {
    it('should return all available prompts', async () => {
      const prompts = await promptHandler.listPrompts();
      
      expect(prompts).toHaveLength(4);
      expect(prompts.map((p: any) => p.name)).toEqual([
        'helpscout-best-practices',
        'search-last-7-days',
        'find-urgent-tags',
        'list-inbox-activity'
      ]);
    });

    it('should have proper prompt metadata', async () => {
      const prompts = await promptHandler.listPrompts();
      
      prompts.forEach((prompt: any) => {
        expect(prompt).toHaveProperty('name');
        expect(prompt).toHaveProperty('description');
        expect(prompt).toHaveProperty('arguments');
        expect(Array.isArray(prompt.arguments)).toBe(true);
      });
    });

    it('should have search-last-7-days prompt with correct structure', async () => {
      const prompts = await promptHandler.listPrompts();
      const searchPrompt = prompts.find((p: any) => p.name === 'search-last-7-days');
      
      expect(searchPrompt).toBeDefined();
      expect(searchPrompt!.description).toContain('last 7 days');
      expect(searchPrompt!.arguments).toHaveLength(3);
      
      const argNames = searchPrompt!.arguments!.map((arg: any) => arg.name);
      expect(argNames).toEqual(['inboxId', 'status', 'tag']);
      
      // All arguments should be optional
      searchPrompt!.arguments!.forEach((arg: any) => {
        expect(arg.required).toBe(false);
      });
    });

    it('should have find-urgent-tags prompt with correct structure', async () => {
      const prompts = await promptHandler.listPrompts();
      const urgentPrompt = prompts.find((p: any) => p.name === 'find-urgent-tags');
      
      expect(urgentPrompt).toBeDefined();
      expect(urgentPrompt!.description).toContain('urgent or priority tags');
      expect(urgentPrompt!.arguments).toHaveLength(2);
      
      const argNames = urgentPrompt!.arguments!.map((arg: any) => arg.name);
      expect(argNames).toEqual(['inboxId', 'timeframe']);
    });

    it('should have list-inbox-activity prompt with correct structure', async () => {
      const prompts = await promptHandler.listPrompts();
      const activityPrompt = prompts.find((p: any) => p.name === 'list-inbox-activity');
      
      expect(activityPrompt).toBeDefined();
      expect(activityPrompt!.description).toContain('activity');
      expect(activityPrompt!.arguments).toHaveLength(3);
      
      const argNames = activityPrompt!.arguments!.map((arg: any) => arg.name);
      expect(argNames).toEqual(['inboxId', 'hours', 'includeThreads']);
      
      // Check required arguments
      const inboxIdArg = activityPrompt!.arguments!.find((arg: any) => arg.name === 'inboxId');
      const hoursArg = activityPrompt!.arguments!.find((arg: any) => arg.name === 'hours');
      const includeThreadsArg = activityPrompt!.arguments!.find((arg: any) => arg.name === 'includeThreads');
      
      expect(inboxIdArg!.required).toBe(true);
      expect(hoursArg!.required).toBe(true);
      expect(includeThreadsArg!.required).toBe(false);
    });

    it('should have helpscout-best-practices prompt with correct structure', async () => {
      const prompts = await promptHandler.listPrompts();
      const bestPracticesPrompt = prompts.find((p: any) => p.name === 'helpscout-best-practices');
      
      expect(bestPracticesPrompt).toBeDefined();
      expect(bestPracticesPrompt!.description).toContain('workflow guide');
      expect(bestPracticesPrompt!.arguments).toHaveLength(0);
    });
  });

  describe('getPrompt', () => {
    describe('helpscout-best-practices prompt', () => {
      it('should generate helpscout-best-practices prompt', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'helpscout-best-practices',
            arguments: {}
          }
        };

        const result = await promptHandler.getPrompt(request);
        
        expect(result.description).toContain('workflow guide');
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content.type).toBe('text');
        
        const promptText = result.messages[0].content.text;
        expect(promptText).toContain('Golden Rule');
        expect(promptText).toContain('searchInboxes');
        expect(promptText).toContain('comprehensiveConversationSearch');
        expect(promptText).toContain('CRITICAL WORKFLOW');
        expect(promptText).toContain('Common Pitfalls to Avoid');
      });
    });

    describe('search-last-7-days prompt', () => {
      it('should generate basic search-last-7-days prompt', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'search-last-7-days',
            arguments: {}
          }
        };

        const result = await promptHandler.getPrompt(request);
        
        expect(result.description).toContain('searching conversations from the last 7 days');
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content.type).toBe('text');
        
        const promptText = result.messages[0].content.text;
        expect(promptText).toContain('getServerTime');
        expect(promptText).toContain('searchConversations');
        expect(promptText).toContain('7 days ago');
      });

      it('should include inboxId when provided', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'search-last-7-days',
            arguments: { inboxId: '123' }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('"inboxId": "123"');
      });

      it('should include status filter when provided', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'search-last-7-days',
            arguments: { status: 'active' }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('"status": "active"');
      });

      it('should include tag filter when provided', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'search-last-7-days',
            arguments: { tag: 'support' }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('"tag": "support"');
      });

      it('should include all parameters when provided', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'search-last-7-days',
            arguments: { 
              inboxId: '456', 
              status: 'pending', 
              tag: 'urgent' 
            }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('"inboxId": "456"');
        expect(promptText).toContain('"status": "pending"');
        expect(promptText).toContain('"tag": "urgent"');
      });
    });

    describe('find-urgent-tags prompt', () => {
      it('should generate basic find-urgent-tags prompt', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'find-urgent-tags',
            arguments: {}
          }
        };

        const result = await promptHandler.getPrompt(request);
        
        expect(result.description).toContain('urgent or priority tags');
        expect(result.messages).toHaveLength(1);
        
        const promptText = result.messages[0].content.text;
        expect(promptText).toContain('urgent');
        expect(promptText).toContain('priority');
        expect(promptText).toContain('high-priority');
        expect(promptText).toContain('getServerTime');
        expect(promptText).toContain('searchConversations');
      });

      it('should include inboxId when provided', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'find-urgent-tags',
            arguments: { inboxId: '789' }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('"inboxId": "789"');
      });

      it('should include timeframe calculations when provided', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'find-urgent-tags',
            arguments: { timeframe: '24h' }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('24h');
        expect(promptText).toContain('subtract 24 hours');
        expect(promptText).toContain('"createdAfter": "<calculated_time>"');
      });
    });

    describe('list-inbox-activity prompt', () => {
      it('should generate list-inbox-activity prompt with required parameters', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'list-inbox-activity',
            arguments: { 
              inboxId: 'inbox-123', 
              hours: 24 
            }
          }
        };

        const result = await promptHandler.getPrompt(request);
        
        expect(result.description).toContain('inbox inbox-123');
        expect(result.description).toContain('24 hours');
        expect(result.messages).toHaveLength(1);
        
        const promptText = result.messages[0].content.text;
        expect(promptText).toContain('inbox-123');
        expect(promptText).toContain('24 hours');
        expect(promptText).toContain('"inboxId": "inbox-123"');
        expect(promptText).toContain('getServerTime');
        expect(promptText).toContain('searchConversations');
      });

      it('should include thread details when includeThreads is true', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'list-inbox-activity',
            arguments: { 
              inboxId: 'inbox-456', 
              hours: 12,
              includeThreads: true
            }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('getConversationSummary');
        expect(promptText).toContain('getThreads');
        expect(promptText).toContain('Since includeThreads is enabled');
      });

      it('should not include thread details when includeThreads is false', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'list-inbox-activity',
            arguments: { 
              inboxId: 'inbox-789', 
              hours: 6,
              includeThreads: false
            }
          }
        };

        const result = await promptHandler.getPrompt(request);
        const promptText = result.messages[0].content.text;
        
        expect(promptText).toContain('For a quick overview');
        expect(promptText).not.toContain('Since includeThreads is enabled');
      });

      it('should throw error when inboxId is missing', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'list-inbox-activity',
            arguments: { hours: 24 }
          }
        };

        await expect(promptHandler.getPrompt(request)).rejects.toThrow(
          'inboxId argument is required for list-inbox-activity prompt'
        );
      });

      it('should throw error when hours is missing', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'list-inbox-activity',
            arguments: { inboxId: 'inbox-123' }
          }
        };

        await expect(promptHandler.getPrompt(request)).rejects.toThrow(
          'hours argument is required and must be a number for list-inbox-activity prompt'
        );
      });

      it('should throw error when hours is not a number', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'list-inbox-activity',
            arguments: { 
              inboxId: 'inbox-123', 
              hours: 'twenty-four' 
            }
          }
        };

        await expect(promptHandler.getPrompt(request)).rejects.toThrow(
          'hours argument is required and must be a number for list-inbox-activity prompt'
        );
      });
    });

    describe('error handling', () => {
      it('should throw error for unknown prompt name', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'unknown-prompt',
            arguments: {}
          }
        };

        await expect(promptHandler.getPrompt(request)).rejects.toThrow(
          'Unknown prompt: unknown-prompt'
        );
      });

      it('should handle missing arguments gracefully', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'search-last-7-days'
            // Missing arguments
          }
        };

        const result = await promptHandler.getPrompt(request);
        expect(result).toBeDefined();
        expect(result.messages).toHaveLength(1);
      });

      it('should log prompt requests properly', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'search-last-7-days',
            arguments: { inboxId: 'test-123' }
          }
        };

        await promptHandler.getPrompt(request);

        expect(mockLogger.info).toHaveBeenCalledWith('Prompt request started', expect.objectContaining({
          promptName: 'search-last-7-days',
          arguments: { inboxId: 'test-123' }
        }));

        expect(mockLogger.info).toHaveBeenCalledWith('Prompt request completed', expect.objectContaining({
          promptName: 'search-last-7-days'
        }));
      });

      it('should log errors properly', async () => {
        const request = {
          method: 'prompts/get',
          params: {
            name: 'unknown-prompt',
            arguments: {}
          }
        };

        try {
          await promptHandler.getPrompt(request);
        } catch (error) {
          // Expected error
        }

        expect(mockLogger.error).toHaveBeenCalledWith('Prompt request failed', expect.objectContaining({
          promptName: 'unknown-prompt',
          error: 'Unknown prompt: unknown-prompt'
        }));
      });
    });
  });
});