import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock logger to reduce test output noise
jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

/**
 * Integration Tests for Complete User Workflows
 * 
 * These tests simulate real user scenarios from start to finish,
 * testing the complete chain of operations that users actually perform.
 */
describe('Complete User Workflows - Integration Tests', () => {
  let toolHandler: ToolHandler;
  const baseURL = 'https://api.helpscout.net/v2';

  beforeEach(() => {
    // Mock environment for tests
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    
    // Clean all nock interceptors and restore HTTP
    nock.cleanAll();
    nock.restore();
    nock.activate();
    
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

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Workflow 1: Search by Inbox Name → Find Conversations → Get Details', () => {
    it('should complete the full customer support workflow', async () => {
      // SCENARIO: User wants to "find urgent tickets in the support inbox from last week"
      
      // Step 1: Mock inbox search
      const mockInboxes = [
        { id: '123', name: 'Support', email: 'support@company.com' },
        { id: '456', name: 'Sales', email: 'sales@company.com' }
      ];

      nock(baseURL)
        .get('/mailboxes')
        .query({ page: 1, size: 50 })
        .reply(200, { _embedded: { mailboxes: mockInboxes } });

      // Step 2: Mock conversation search
      const mockConversations = {
        _embedded: {
          conversations: [
            {
              id: 789,
              subject: 'Urgent: System is down',
              status: 'active',
              createdAt: '2024-01-15T10:00:00Z',
              customer: { id: 1, firstName: 'John', lastName: 'Doe' },
              tags: [{ name: 'urgent' }]
            }
          ]
        },
        page: { size: 50, totalElements: 1 }
      };

      nock(baseURL)
        .get('/conversations')
        .query(params => 
          params.mailbox === '123' && 
          params.query === 'urgent' &&
          params.status === 'active'
        )
        .reply(200, mockConversations);

      // Step 3: Mock thread details
      const mockThreads = {
        _embedded: {
          threads: [
            {
              id: 1,
              type: 'customer',
              body: 'Our system has been down for 2 hours!',
              createdAt: '2024-01-15T10:00:00Z',
              customer: { id: 1, firstName: 'John', lastName: 'Doe' }
            },
            {
              id: 2,
              type: 'message',
              body: 'We are looking into this immediately.',
              createdAt: '2024-01-15T10:15:00Z',
              createdBy: { id: 1, firstName: 'Agent', lastName: 'Smith' }
            }
          ]
        }
      };

      nock(baseURL)
        .get('/conversations/789/threads')
        .query({ page: 1, size: 200 })
        .reply(200, mockThreads);

      // Execute the complete workflow
      
      // User input: "find urgent tickets in the support inbox"
      toolHandler.setUserContext('find urgent tickets in the support inbox');

      // Step 1: Search for "support" inbox
      const inboxSearchRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchInboxes',
          arguments: { query: 'support' }
        }
      };

      const inboxResult = await toolHandler.callTool(inboxSearchRequest);
      expect(inboxResult.content[0]).toHaveProperty('type', 'text');

      const inboxResponse = JSON.parse((inboxResult.content[0] as any).text);
      expect(inboxResponse.results).toHaveLength(1);
      expect(inboxResponse.results[0].name).toBe('Support');
      const supportInboxId = inboxResponse.results[0].id;

      // Step 2: Search conversations in that inbox
      const conversationSearchRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: 'urgent',
            inboxId: supportInboxId,
            status: 'active'
          }
        }
      };

      const conversationResult = await toolHandler.callTool(conversationSearchRequest);
      const conversationResponse = JSON.parse((conversationResult.content[0] as any).text);
      expect(conversationResponse.results).toHaveLength(1);
      expect(conversationResponse.results[0].subject).toContain('Urgent');
      const conversationId = conversationResponse.results[0].id;

      // Step 3: Get thread details
      const threadRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getThreads',
          arguments: { conversationId: conversationId.toString() }
        }
      };

      const threadResult = await toolHandler.callTool(threadRequest);
      const threadResponse = JSON.parse((threadResult.content[0] as any).text);
      expect(threadResponse.threads).toHaveLength(2);
      expect(threadResponse.threads[0].type).toBe('customer');
      expect(threadResponse.threads[1].type).toBe('message');

      // Workflow completed successfully - user found urgent ticket details
      expect(threadResponse.conversationId).toBe(conversationId.toString());
    });
  });

  describe('Workflow 2: Comprehensive Multi-Status Search → Analysis', () => {
    it('should handle complex search across all conversation statuses', async () => {
      // SCENARIO: Manager wants to "analyze all billing-related conversations from the last month"
      
      // Mock comprehensive search across all statuses
      const mockActiveConversations = {
        _embedded: { conversations: [
          { id: 1, subject: 'Billing question', status: 'active', createdAt: '2024-01-01T00:00:00Z' }
        ]},
        page: { size: 25, totalElements: 1 }
      };

      const mockPendingConversations = {
        _embedded: { conversations: [
          { id: 2, subject: 'Billing dispute', status: 'pending', createdAt: '2024-01-02T00:00:00Z' }
        ]},
        page: { size: 25, totalElements: 1 }
      };

      const mockClosedConversations = {
        _embedded: { conversations: [
          { id: 3, subject: 'Billing resolved', status: 'closed', createdAt: '2024-01-03T00:00:00Z' },
          { id: 4, subject: 'Payment processed', status: 'closed', createdAt: '2024-01-04T00:00:00Z' }
        ]},
        page: { size: 25, totalElements: 2 }
      };

      // Set up nock interceptors for each status
      nock(baseURL)
        .get('/conversations')
        .query(params => 
          params.status === 'active' && 
          params.query === '(body:"billing" OR subject:"billing")'
        )
        .reply(200, mockActiveConversations);

      nock(baseURL)
        .get('/conversations')
        .query(params => 
          params.status === 'pending' && 
          params.query === '(body:"billing" OR subject:"billing")'
        )
        .reply(200, mockPendingConversations);

      nock(baseURL)
        .get('/conversations')
        .query(params => 
          params.status === 'closed' && 
          params.query === '(body:"billing" OR subject:"billing")'
        )
        .reply(200, mockClosedConversations);

      // Execute comprehensive search
      const comprehensiveSearchRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'comprehensiveConversationSearch',
          arguments: {
            searchTerms: ['billing'],
            statuses: ['active', 'pending', 'closed'],
            timeframeDays: 30
          }
        }
      };

      const result = await toolHandler.callTool(comprehensiveSearchRequest);
      const response = JSON.parse((result.content[0] as any).text);

      // Verify comprehensive analysis
      expect(response.totalConversationsFound).toBe(4);
      expect(response.resultsByStatus).toHaveLength(3);
      
      // Verify status-specific results
      const activeResults = response.resultsByStatus.find((r: any) => r.status === 'active');
      const pendingResults = response.resultsByStatus.find((r: any) => r.status === 'pending');
      const closedResults = response.resultsByStatus.find((r: any) => r.status === 'closed');

      expect(activeResults.conversations).toHaveLength(1);
      expect(pendingResults.conversations).toHaveLength(1);
      expect(closedResults.conversations).toHaveLength(2);

      // Verify search metadata
      expect(response.searchTerms).toEqual(['billing']);
      expect(response.timeframe.days).toBe(30);
    });
  });

  describe('Workflow 3: Advanced Search with Complex Criteria', () => {
    it('should handle advanced search with multiple criteria types', async () => {
      // SCENARIO: "Find all conversations from VIP customers about refunds in the last 7 days"
      
      const mockAdvancedResults = {
        _embedded: {
          conversations: [
            {
              id: 100,
              subject: 'Refund request for premium service',
              status: 'pending',
              createdAt: '2024-01-20T00:00:00Z',
              customer: { id: 5, firstName: 'VIP', lastName: 'Customer' },
              tags: [{ name: 'vip' }, { name: 'refund' }]
            }
          ]
        },
        page: { size: 50, totalElements: 1 }
      };

      nock(baseURL)
        .get('/conversations')
        .query(params => {
          // Verify complex query construction
          const query = params.query as string;
          return !!(query && 
                   query.includes('body:"refund"') &&
                   query.includes('subject:"refund"') &&
                   query.includes('tag:"vip"'));
        })
        .reply(200, mockAdvancedResults);

      const advancedSearchRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'advancedConversationSearch',
          arguments: {
            contentTerms: ['refund'],
            subjectTerms: ['refund'],
            tags: ['vip'],
            createdAfter: '2024-01-14T00:00:00Z',
            status: 'pending'
          }
        }
      };

      const result = await toolHandler.callTool(advancedSearchRequest);
      const response = JSON.parse((result.content[0] as any).text);

      expect(response.results).toHaveLength(1);
      expect(response.results[0].subject).toContain('Refund');
      expect(response.searchCriteria.contentTerms).toEqual(['refund']);
      expect(response.searchCriteria.tags).toEqual(['vip']);
    });
  });

  describe('Workflow 4: Error Recovery and Validation', () => {
    it('should guide users through correct workflow when they skip steps', async () => {
      // SCENARIO: User tries to search without getting inbox ID first
      
      toolHandler.setUserContext('search conversations in the billing inbox for overdue payments');

      // User incorrectly tries to search without inbox ID
      const incorrectSearchRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'searchConversations',
          arguments: {
            query: 'overdue',
            // Missing inboxId - user mentioned "billing inbox" but didn't search for it first
          }
        }
      };

      const errorResult = await toolHandler.callTool(incorrectSearchRequest);
      const errorResponse = JSON.parse((errorResult.content[0] as any).text);

      // Should get API constraint validation error
      expect(errorResponse.error).toBe('API Constraint Validation Failed');
      expect(errorResponse.details.requiredPrerequisites).toContain('searchInboxes');
      expect(errorResponse.details.suggestions[0]).toContain('REQUIRED: Call searchInboxes first');

      // Verify the error provides actionable guidance
      expect(errorResponse.helpScoutAPIRequirements.message).toContain('Help Scout API constraints');
      expect(errorResponse.helpScoutAPIRequirements.suggestions).toBeDefined();
    });
  });

  describe('Workflow 5: Real-time Customer Support Scenario', () => {
    it('should support live customer support workflow', async () => {
      // SCENARIO: Support agent gets escalation, needs to quickly find customer history
      
      // Customer email: jane@bigcorp.com
      // Agent needs: Recent conversations, conversation summary, thread details

      // Step 1: Search by customer email
      const customerSearchResult = {
        _embedded: {
          conversations: [
            {
              id: 201,
              subject: 'Account access issues',
              status: 'closed',
              createdAt: '2024-01-10T00:00:00Z',
              customer: { id: 10, firstName: 'Jane', lastName: 'Smith', email: 'jane@bigcorp.com' }
            },
            {
              id: 202, 
              subject: 'New escalation - urgent',
              status: 'active',
              createdAt: '2024-01-22T00:00:00Z',
              customer: { id: 10, firstName: 'Jane', lastName: 'Smith', email: 'jane@bigcorp.com' }
            }
          ]
        },
        page: { size: 50, totalElements: 2 }
      };

      nock(baseURL)
        .get('/conversations')
        .query(params => params.query === 'email:"jane@bigcorp.com"')
        .reply(200, customerSearchResult);

      // Step 2: Get summary of latest conversation
      const conversationDetails = {
        id: 202,
        subject: 'New escalation - urgent',
        status: 'active',
        customer: { id: 10, firstName: 'Jane', lastName: 'Smith' },
        assignee: { id: 5, firstName: 'Agent', lastName: 'Jones' },
        tags: [{ name: 'escalation' }, { name: 'urgent' }]
      };

      const summaryThreads = {
        _embedded: {
          threads: [
            {
              id: 1,
              type: 'customer',
              body: 'This is the third time I am contacting support about this issue!',
              createdAt: '2024-01-22T09:00:00Z'
            },
            {
              id: 2,
              type: 'message', 
              body: 'I understand your frustration. Let me escalate this immediately.',
              createdAt: '2024-01-22T09:30:00Z',
              createdBy: { id: 5, firstName: 'Agent', lastName: 'Jones' }
            }
          ]
        }
      };

      nock(baseURL)
        .get('/conversations/202')
        .reply(200, conversationDetails);

      nock(baseURL)
        .get('/conversations/202/threads')
        .query({ page: 1, size: 50 })
        .reply(200, summaryThreads);

      // Execute customer support workflow

      // Step 1: Find customer's conversations
      const customerSearchRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'advancedConversationSearch',
          arguments: {
            customerEmail: 'jane@bigcorp.com'
          }
        }
      };

      const customerResult = await toolHandler.callTool(customerSearchRequest);
      const customerResponse = JSON.parse((customerResult.content[0] as any).text);
      
      expect(customerResponse.results).toHaveLength(2);
      const latestConversation = customerResponse.results
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      expect(latestConversation.subject).toContain('escalation');

      // Step 2: Get conversation summary 
      const summaryRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'getConversationSummary',
          arguments: { conversationId: latestConversation.id.toString() }
        }
      };

      const summaryResult = await toolHandler.callTool(summaryRequest);
      const summaryResponse = JSON.parse((summaryResult.content[0] as any).text);

      expect(summaryResponse.conversation.subject).toBe('New escalation - urgent');
      expect(summaryResponse.firstCustomerMessage.body).toContain('[REDACTED]'); // PII protection
      expect(summaryResponse.latestStaffReply.body).toContain('[REDACTED]'); // PII protection

      // Workflow provides agent with complete customer context
      expect(summaryResponse.conversation.assignee.firstName).toBe('Agent');
    });
  });
});