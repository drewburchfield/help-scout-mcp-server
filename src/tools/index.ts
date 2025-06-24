import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { helpScoutClient, PaginatedResponse } from '../utils/helpscout-client.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import {
  Inbox,
  Conversation,
  Thread,
  ServerTime,
  SearchInboxesInputSchema,
  SearchConversationsInputSchema,
  GetThreadsInputSchema,
  GetConversationSummaryInputSchema,
  AdvancedConversationSearchInputSchema,
  MultiStatusConversationSearchInputSchema,
} from '../schema/types.js';

export class ToolHandler {
  async listTools(): Promise<Tool[]> {
    return [
      {
        name: 'searchInboxes',
        description: 'Search inboxes by name substring',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to match inbox names',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 50,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'searchConversations',
        description: 'Search conversations with various filters including full-text content search. IMPORTANT: Specify status (active/pending/closed/spam) for better results, or use comprehensiveConversationSearch for multi-status searching.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'HelpScout query syntax for content search. Examples: (body:"keyword"), (subject:"text"), (email:"user@domain.com"), (tag:"tagname"), (customerIds:123), complex: (body:"urgent" OR subject:"support")',
            },
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name',
            },
            status: {
              type: 'string',
              enum: ['active', 'pending', 'closed', 'spam'],
              description: 'Filter by conversation status. CRITICAL: HelpScout often returns no results without this parameter. For comprehensive search across all statuses, use comprehensiveConversationSearch instead.',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 50,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'updatedAt', 'number'],
              default: 'createdAt',
              description: 'Sort field',
            },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: 'desc',
              description: 'Sort order',
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific fields to return (for partial responses)',
            },
          },
        },
      },
      {
        name: 'getConversationSummary',
        description: 'Get conversation summary with first customer message and latest staff reply',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get summary for',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getThreads',
        description: 'Get all thread messages for a conversation',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get threads for',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of threads (1-200)',
              minimum: 1,
              maximum: 200,
              default: 200,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getServerTime',
        description: 'Get current server time for time-relative searches',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'advancedConversationSearch',
        description: 'Advanced conversation search with complex boolean queries and customer organization support',
        inputSchema: {
          type: 'object',
          properties: {
            contentTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation body/content (will be OR combined)',
            },
            subjectTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation subject (will be OR combined)',
            },
            customerEmail: {
              type: 'string',
              description: 'Exact customer email to search for',
            },
            emailDomain: {
              type: 'string',
              description: 'Email domain to search for (e.g., "company.com" to find all @company.com emails)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tag names to search for (will be OR combined)',
            },
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID',
            },
            status: {
              type: 'string',
              enum: ['active', 'pending', 'closed', 'spam'],
              description: 'Filter by conversation status',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 50,
            },
          },
        },
      },
      {
        name: 'comprehensiveConversationSearch',
        description: 'Search conversations across multiple statuses simultaneously - solves the common issue where searches return no results without specifying status. Automatically searches active, pending, and closed conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversations (will be combined with OR logic)',
              minItems: 1,
            },
            inboxId: {
              type: 'string',
              description: 'Filter by specific inbox ID',
            },
            statuses: {
              type: 'array',
              items: { enum: ['active', 'pending', 'closed', 'spam'] },
              description: 'Conversation statuses to search (defaults to active, pending, closed)',
              default: ['active', 'pending', 'closed'],
            },
            searchIn: {
              type: 'array',
              items: { enum: ['body', 'subject', 'both'] },
              description: 'Where to search for terms (defaults to both body and subject)',
              default: ['both'],
            },
            timeframeDays: {
              type: 'number',
              description: 'Number of days back to search (defaults to 60)',
              minimum: 1,
              maximum: 365,
              default: 60,
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Override timeframeDays with specific start date (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'End date for search range (ISO8601)',
            },
            limitPerStatus: {
              type: 'number',
              description: 'Maximum results per status (defaults to 25)',
              minimum: 1,
              maximum: 100,
              default: 25,
            },
            includeVariations: {
              type: 'boolean',
              description: 'Include common variations of search terms',
              default: true,
            },
          },
          required: ['searchTerms'],
        },
      },
    ];
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    logger.info('Tool call started', {
      requestId,
      toolName: request.params.name,
      arguments: request.params.arguments,
    });

    try {
      let result: CallToolResult;

      switch (request.params.name) {
        case 'searchInboxes':
          result = await this.searchInboxes(request.params.arguments || {});
          break;
        case 'searchConversations':
          result = await this.searchConversations(request.params.arguments || {});
          break;
        case 'getConversationSummary':
          result = await this.getConversationSummary(request.params.arguments || {});
          break;
        case 'getThreads':
          result = await this.getThreads(request.params.arguments || {});
          break;
        case 'getServerTime':
          result = await this.getServerTime();
          break;
        case 'advancedConversationSearch':
          result = await this.advancedConversationSearch(request.params.arguments || {});
          break;
        case 'comprehensiveConversationSearch':
          result = await this.comprehensiveConversationSearch(request.params.arguments || {});
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const duration = Date.now() - startTime;
      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Tool call failed', {
        requestId,
        toolName: request.params.name,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });
      
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async searchInboxes(args: unknown): Promise<CallToolResult> {
    const input = SearchInboxesInputSchema.parse(args);
    
    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: input.limit,
    });

    const inboxes = response._embedded?.mailboxes || [];
    const filteredInboxes = inboxes.filter(inbox => 
      inbox.name.toLowerCase().includes(input.query.toLowerCase())
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: filteredInboxes,
            query: input.query,
            totalFound: filteredInboxes.length,
          }, null, 2),
        },
      ],
    };
  }

  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);
    
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sort,
      sortOrder: input.order,
    };

    // Add HelpScout query parameter for content/body search
    if (input.query) {
      queryParams.query = input.query;
    }

    if (input.inboxId) queryParams.mailbox = input.inboxId;
    if (input.tag) queryParams.tag = input.tag;
    if (input.createdAfter) queryParams.modifiedSince = input.createdAfter;

    // Handle status parameter with helpful guidance
    if (input.status) {
      queryParams.status = input.status;
    } else if (input.query || input.tag) {
      // If search criteria are provided but no status, default to 'active' with a warning
      queryParams.status = 'active';
      logger.warn('No status specified for conversation search, defaulting to "active". For comprehensive results across all statuses, use comprehensiveConversationSearch tool.', {
        query: input.query,
        tag: input.tag,
      });
    }

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    
    let conversations = response._embedded?.conversations || [];

    // Apply additional filtering
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    }

    // Apply field selection if specified
    if (input.fields && input.fields.length > 0) {
      conversations = conversations.map(conv => {
        const filtered: Partial<Conversation> = {};
        input.fields!.forEach(field => {
          if (field in conv) {
            (filtered as any)[field] = (conv as any)[field];
          }
        });
        return filtered as Conversation;
      });
    }

    const results = {
      results: conversations,
      pagination: response.page,
      nextCursor: response._links?.next?.href,
      searchInfo: {
        query: input.query,
        status: queryParams.status || 'all',
        appliedDefaults: !input.status && (input.query || input.tag) ? ['status: active'] : undefined,
        searchGuidance: conversations.length === 0 ? [
          'If no results found, try:',
          '1. Use comprehensiveConversationSearch for multi-status search',
          '2. Try different status values: active, pending, closed, spam',
          '3. Broaden search terms or extend time range',
          '4. Check if inbox ID is correct'
        ] : undefined,
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  private async getConversationSummary(args: unknown): Promise<CallToolResult> {
    const input = GetConversationSummaryInputSchema.parse(args);
    
    // Get conversation details
    const conversation = await helpScoutClient.get<Conversation>(`/conversations/${input.conversationId}`);
    
    // Get threads to find first customer message and latest staff reply
    const threadsResponse = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      { page: 1, size: 50 }
    );
    
    const threads = threadsResponse._embedded?.threads || [];
    const customerThreads = threads.filter(t => t.type === 'customer');
    const staffThreads = threads.filter(t => t.type === 'message' && t.createdBy);
    
    const firstCustomerMessage = customerThreads.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0];
    
    const latestStaffReply = staffThreads.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    const summary = {
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        customer: conversation.customer,
        assignee: conversation.assignee,
        tags: conversation.tags,
      },
      firstCustomerMessage: firstCustomerMessage ? {
        id: firstCustomerMessage.id,
        body: config.security.allowPii ? firstCustomerMessage.body : '[REDACTED]',
        createdAt: firstCustomerMessage.createdAt,
        customer: firstCustomerMessage.customer,
      } : null,
      latestStaffReply: latestStaffReply ? {
        id: latestStaffReply.id,
        body: config.security.allowPii ? latestStaffReply.body : '[REDACTED]',
        createdAt: latestStaffReply.createdAt,
        createdBy: latestStaffReply.createdBy,
      } : null,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async getThreads(args: unknown): Promise<CallToolResult> {
    const input = GetThreadsInputSchema.parse(args);
    
    const response = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      {
        page: 1,
        size: input.limit,
      }
    );

    const threads = response._embedded?.threads || [];
    
    // Redact PII if configured
    const processedThreads = threads.map(thread => ({
      ...thread,
      body: config.security.allowPii ? thread.body : '[REDACTED]',
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threads: processedThreads,
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  private async getServerTime(): Promise<CallToolResult> {
    const now = new Date();
    const serverTime: ServerTime = {
      isoTime: now.toISOString(),
      unixTime: Math.floor(now.getTime() / 1000),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(serverTime, null, 2),
        },
      ],
    };
  }

  private async advancedConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = AdvancedConversationSearchInputSchema.parse(args);

    // Build HelpScout query syntax
    const queryParts: string[] = [];

    // Content/body search
    if (input.contentTerms && input.contentTerms.length > 0) {
      const bodyQueries = input.contentTerms.map(term => `body:"${term}"`);
      queryParts.push(`(${bodyQueries.join(' OR ')})`);
    }

    // Subject search
    if (input.subjectTerms && input.subjectTerms.length > 0) {
      const subjectQueries = input.subjectTerms.map(term => `subject:"${term}"`);
      queryParts.push(`(${subjectQueries.join(' OR ')})`);
    }

    // Email searches
    if (input.customerEmail) {
      queryParts.push(`email:"${input.customerEmail}"`);
    }

    // Handle email domain search (HelpScout supports domain-only searches)
    if (input.emailDomain) {
      const domain = input.emailDomain.replace('@', ''); // Remove @ if present
      queryParts.push(`email:"${domain}"`);
    }

    // Tag search
    if (input.tags && input.tags.length > 0) {
      const tagQueries = input.tags.map(tag => `tag:"${tag}"`);
      queryParts.push(`(${tagQueries.join(' OR ')})`);
    }

    // Build final query
    const queryString = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

    // Set up query parameters
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit || 50,
      sortField: 'createdAt',
      sortOrder: 'desc',
    };

    if (queryString) {
      queryParams.query = queryString;
    }

    if (input.inboxId) queryParams.mailbox = input.inboxId;
    if (input.status) queryParams.status = input.status;
    if (input.createdAfter) queryParams.modifiedSince = input.createdAfter;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    
    let conversations = response._embedded?.conversations || [];

    // Apply additional client-side filtering
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: conversations,
            searchQuery: queryString,
            searchCriteria: {
              contentTerms: input.contentTerms,
              subjectTerms: input.subjectTerms,
              customerEmail: input.customerEmail,
              emailDomain: input.emailDomain,
              tags: input.tags,
            },
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  private async comprehensiveConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = MultiStatusConversationSearchInputSchema.parse(args);

    // Calculate time range
    let createdAfter: string;
    if (input.createdAfter) {
      createdAfter = input.createdAfter;
    } else {
      const timeRange = new Date();
      timeRange.setDate(timeRange.getDate() - input.timeframeDays);
      createdAfter = timeRange.toISOString();
    }

    // Build search query from terms
    const buildQuery = (terms: string[], searchIn: string[]): string => {
      const queries: string[] = [];
      
      for (const term of terms) {
        const termQueries: string[] = [];
        
        if (searchIn.includes('body') || searchIn.includes('both')) {
          termQueries.push(`body:"${term}"`);
        }
        
        if (searchIn.includes('subject') || searchIn.includes('both')) {
          termQueries.push(`subject:"${term}"`);
        }
        
        if (termQueries.length > 0) {
          queries.push(`(${termQueries.join(' OR ')})`);
        }
      }
      
      return queries.join(' OR ');
    };

    const query = buildQuery(input.searchTerms, input.searchIn);
    const allResults: Array<{
      status: string;
      totalCount: number;
      conversations: Conversation[];
      searchQuery: string;
    }> = [];

    // Search each status separately
    for (const status of input.statuses) {
      try {
        const queryParams: Record<string, unknown> = {
          page: 1,
          size: input.limitPerStatus,
          sortField: 'createdAt',
          sortOrder: 'desc',
          query,
          status,
          modifiedSince: createdAfter,
        };

        if (input.inboxId) {
          queryParams.mailbox = input.inboxId;
        }

        if (input.createdBefore) {
          // Apply client-side filtering for createdBefore since HelpScout API doesn't support it directly
        }

        const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
        
        let conversations = response._embedded?.conversations || [];

        // Apply createdBefore filter if specified
        if (input.createdBefore) {
          const beforeDate = new Date(input.createdBefore);
          conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
        }

        allResults.push({
          status,
          totalCount: response.page?.totalElements || conversations.length,
          conversations,
          searchQuery: query,
        });

      } catch (error) {
        logger.warn('Failed to search conversations for status', {
          status,
          error: error instanceof Error ? error.message : String(error),
        });
        
        // Add empty result for this status to maintain completeness
        allResults.push({
          status,
          totalCount: 0,
          conversations: [],
          searchQuery: query,
        });
      }
    }

    // Calculate summary statistics
    const totalConversations = allResults.reduce((sum, result) => sum + result.conversations.length, 0);
    const totalAvailable = allResults.reduce((sum, result) => sum + result.totalCount, 0);

    const summary = {
      searchTerms: input.searchTerms,
      searchQuery: query,
      searchIn: input.searchIn,
      timeframe: {
        createdAfter,
        createdBefore: input.createdBefore,
        days: input.timeframeDays,
      },
      totalConversationsFound: totalConversations,
      totalAvailableAcrossStatuses: totalAvailable,
      resultsByStatus: allResults,
      searchTips: totalConversations === 0 ? [
        'Try broader search terms or increase the timeframe',
        'Check if the inbox ID is correct',
        'Consider searching without status restrictions first',
        'Verify that conversations exist for the specified criteria'
      ] : undefined,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }
}

export const toolHandler = new ToolHandler();