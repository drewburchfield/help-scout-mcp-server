import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PaginatedResponse, helpScoutClient } from '../utils/helpscout-client.js';
import { createMcpToolError } from '../utils/mcp-errors.js';
import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { z } from 'zod';

/**
 * Constants for tool operations
 */
const TOOL_CONSTANTS = {
  // API pagination defaults
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  MAX_THREAD_SIZE: 200,
  DEFAULT_THREAD_SIZE: 200,
  
  // Search limits
  MAX_SEARCH_TERMS: 10,
  DEFAULT_TIMEFRAME_DAYS: 60,
  DEFAULT_LIMIT_PER_STATUS: 25,
  
  // Sort configuration
  DEFAULT_SORT_FIELD: 'createdAt',
  DEFAULT_SORT_ORDER: 'desc',
  
  // Cache and performance
  MAX_CONVERSATION_ID_LENGTH: 20,
  
  // Search locations
  SEARCH_LOCATIONS: {
    BODY: 'body',
    SUBJECT: 'subject', 
    BOTH: 'both'
  } as const,
  
  // Conversation statuses
  STATUSES: {
    ACTIVE: 'active',
    PENDING: 'pending',
    CLOSED: 'closed',
    SPAM: 'spam'
  } as const
} as const;
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
  StructuredConversationFilterInputSchema,
} from '../schema/types.js';

export class ToolHandler {
  private callHistory: string[] = [];
  private currentUserQuery?: string;

  constructor() {
    // Direct imports, no DI needed
  }

  /**
   * Escape special characters in Help Scout query syntax to prevent injection
   * Help Scout uses double quotes for exact phrases, so we need to escape them
   */
  private escapeQueryTerm(term: string): string {
    // Escape backslashes first, then double quotes
    return term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Set the current user query for context-aware validation
   */
  setUserContext(userQuery: string): void {
    this.currentUserQuery = userQuery;
  }

  async listTools(): Promise<Tool[]> {
    return [
      {
        name: 'searchInboxes',
        description: 'STEP 1: Always use this FIRST when searching conversations. Lists all available inboxes or filters by name. CRITICAL: When a user mentions an inbox by name (e.g., "support inbox", "sales mailbox"), you MUST call this tool first to get the inbox ID before searching conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to match inbox names. Use empty string "" to list ALL inboxes. This is case-insensitive substring matching.',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
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
        description: 'List or filter conversations by status and time range. USE FOR: "show recent tickets", "list closed conversations", "active tickets from last week". This is the SIMPLEST search - great for time-based listing without content keywords. Can search by status (active/pending/closed), date range, inbox, or tags. For keyword search across content, use comprehensiveConversationSearch instead.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'OPTIONAL: HelpScout query syntax for content search. OMIT this parameter to list ALL conversations. Examples: (body:"keyword"), (subject:"text"), (email:"user@domain.com"), (tag:"tagname"), (customerIds:123), complex: (body:"urgent" OR subject:"support"). Use cases: OMIT for "show recent tickets", INCLUDE for "find tickets about billing".',
            },
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID. REQUIRED when user mentions a specific inbox. Get this ID by calling searchInboxes first!',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
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
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'updatedAt', 'number'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
              description: 'Sort field',
            },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
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
              description: `Maximum number of threads (1-${TOOL_CONSTANTS.MAX_THREAD_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_THREAD_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_THREAD_SIZE,
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
        name: 'listAllInboxes',
        description: 'QUICK HELPER: Lists ALL available inboxes with their IDs. This is equivalent to searchInboxes with empty query but more explicit. Use this when you need to see all inboxes or when starting any inbox-specific search.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 100,
            },
          },
        },
      },
      {
        name: 'advancedConversationSearch',
        description: 'Search with COMPLEX FILTERS (email domains, tags, boolean logic). USE FOR: "conversations from @company.com", "urgent AND billing tags", "specific customer email". Supports: email domain filtering, tag combinations, content+subject separate terms. For simple keyword search, use comprehensiveConversationSearch. For structural IDs, use structuredConversationFilter.',
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
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
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
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
          },
        },
      },
      {
        name: 'comprehensiveConversationSearch',
        description: 'Search by KEYWORDS in conversation content (subject + body). USE FOR: "find billing issues", "conversations about refunds", "tickets mentioning bug XYZ". Searches across active+pending+closed statuses automatically. REQUIRES search terms (keywords you want to find). For listing without keywords (like "recent tickets"), use searchConversations instead. This is your PRIMARY content search tool.',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'REQUIRED: Actual search terms to find in conversations (will be combined with OR logic). Examples: ["billing", "refund"], ["urgent"], ["login issue"]. DO NOT use empty strings.',
              minItems: 1,
            },
            inboxId: {
              type: 'string',
              description: 'Filter by specific inbox ID. IMPORTANT: If user mentions an inbox by name, you MUST call searchInboxes first to get this ID!',
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
              description: `Number of days back to search (defaults to ${TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS})`,
              minimum: 1,
              maximum: 365,
              default: TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS,
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
              description: `Maximum results per status (defaults to ${TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS,
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
      {
        name: 'structuredConversationFilter',
        description: 'Filter by DISCOVERED IDs (assignee, customer, folder) or LOOKUP BY TICKET NUMBER. USE FOR: "show ticket #42839" (direct lookup), "rep John\'s assigned queue" (after discovering John\'s ID), "customers 123,456,789 history" (after discovering IDs), "sort by SLA wait time". REQUIRES: IDs from previous search OR ticket number from user. DO NOT use for first/primary searches - use comprehensiveConversationSearch or searchConversations instead.',
        inputSchema: {
          type: 'object',
          properties: {
            assignedTo: { type: 'number', description: 'User ID from previous_results[].assignee.id. Use -1 for unassigned.' },
            folderId: { type: 'number', description: 'Folder ID from Help Scout UI (not in API responses)' },
            customerIds: { type: 'array', items: { type: 'number' }, description: 'Customer IDs from previous_results[].customer.id' },
            conversationNumber: { type: 'number', description: 'Ticket number from previous_results[].number or user reference' },
            status: { type: 'string', enum: ['active', 'pending', 'closed', 'spam', 'all'], default: 'all' },
            inboxId: { type: 'string', description: 'Inbox ID to combine with filters' },
            tag: { type: 'string', description: 'Tag name to combine with filters' },
            createdAfter: { type: 'string', format: 'date-time' },
            createdBefore: { type: 'string', format: 'date-time' },
            modifiedSince: { type: 'string', format: 'date-time', description: 'Filter by last modified (different from created)' },
            sortBy: { type: 'string', enum: ['createdAt', 'modifiedAt', 'number', 'waitingSince', 'customerName', 'customerEmail', 'mailboxId', 'status', 'subject'], default: 'createdAt', description: 'waitingSince/customerName/customerEmail are unique to this tool' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
            cursor: { type: 'string' },
          },
        },
      },
    ];
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    // Using direct import
    
    logger.info('Tool call started', {
      requestId,
      toolName: request.params.name,
      arguments: request.params.arguments,
    });

    // REVERSE LOGIC VALIDATION: Check API constraints before making the call
    const validationContext: ToolCallContext = {
      toolName: request.params.name,
      arguments: request.params.arguments || {},
      userQuery: this.currentUserQuery,
      previousCalls: [...this.callHistory]
    };

    const validation = HelpScoutAPIConstraints.validateToolCall(validationContext);
    
    if (!validation.isValid) {
      const errorDetails = {
        errors: validation.errors,
        suggestions: validation.suggestions,
        requiredPrerequisites: validation.requiredPrerequisites
      };
      
      logger.warn('Tool call validation failed', {
        requestId,
        toolName: request.params.name,
        validation: errorDetails
      });
      
      // Return helpful error with API constraint guidance
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'API Constraint Validation Failed',
            details: errorDetails,
            helpScoutAPIRequirements: {
              message: 'This call violates Help Scout API constraints',
              requiredActions: validation.requiredPrerequisites || [],
              suggestions: validation.suggestions
            }
          }, null, 2)
        }]
      };
    }

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
        case 'listAllInboxes':
          result = await this.listAllInboxes(request.params.arguments || {});
          break;
        case 'advancedConversationSearch':
          result = await this.advancedConversationSearch(request.params.arguments || {});
          break;
        case 'comprehensiveConversationSearch':
          result = await this.comprehensiveConversationSearch(request.params.arguments || {});
          break;
        case 'structuredConversationFilter':
          result = await this.structuredConversationFilter(request.params.arguments || {});
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const duration = Date.now() - startTime;
      // Add to call history for future validation
      this.callHistory.push(request.params.name);
      
      // Enhance result with API constraint guidance
      const guidance = HelpScoutAPIConstraints.generateToolGuidance(
        request.params.name, 
        JSON.parse((result.content[0] as any).text), 
        validationContext
      );
      
      if (guidance.length > 0) {
        const originalContent = JSON.parse((result.content[0] as any).text);
        originalContent.apiGuidance = guidance;
        result.content[0] = {
          type: 'text',
          text: JSON.stringify(originalContent, null, 2)
        };
      }

      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
        validationPassed: true,
        guidanceProvided: guidance.length > 0
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return createMcpToolError(error, {
        toolName: request.params.name,
        requestId,
        duration,
      });
    }
  }

  private async searchInboxes(args: unknown): Promise<CallToolResult> {
    const input = SearchInboxesInputSchema.parse(args);
    // Using direct import
    
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
            results: filteredInboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            query: input.query,
            totalFound: filteredInboxes.length,
            totalAvailable: inboxes.length,
            usage: filteredInboxes.length > 0 ? 
              'NEXT STEP: Use the "id" field from these results in your conversation search tools (comprehensiveConversationSearch or searchConversations)' : 
              'No inboxes matched your query. Try a different search term or use empty string "" to list all inboxes.',
            example: filteredInboxes.length > 0 ? 
              `comprehensiveConversationSearch({ searchTerms: ["your search"], inboxId: "${filteredInboxes[0].id}" })` : 
              null,
          }, null, 2),
        },
      ],
    };
  }

  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);
    // Using direct imports

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

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      queryParams.mailbox = effectiveInboxId;
    }

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

    // Apply client-side createdBefore filtering
    // NOTE: Help Scout API doesn't support createdBefore natively, so this filters after fetching
    // This means pagination counts may not reflect filtered totals
    let clientSideFiltered = false;
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      const originalCount = conversations.length;
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
      clientSideFiltered = originalCount !== conversations.length;

      if (clientSideFiltered) {
        logger.warn('Client-side createdBefore filtering applied - pagination totals may not reflect filtered results', {
          originalCount,
          filteredCount: conversations.length,
        });
      }
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
        inboxScope: effectiveInboxId
          ? (input.inboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`)
          : 'ALL inboxes',
        appliedDefaults: !input.status && (input.query || input.tag) ? ['status: active'] : undefined,
        clientSideFiltering: clientSideFiltered ? 'createdBefore filter applied after API fetch - pagination totals may not reflect filtered count' : undefined,
        searchGuidance: conversations.length === 0 ? [
          'If no results found, try:',
          '1. Use comprehensiveConversationSearch for multi-status search',
          '2. Try different status values: active, pending, closed, spam',
          '3. Broaden search terms or extend time range',
          '4. Check if inbox ID is correct',
          !effectiveInboxId ? '5. Set HELPSCOUT_DEFAULT_INBOX_ID to scope searches to your primary inbox' : undefined
        ].filter(Boolean) : (!effectiveInboxId ? [
          'Note: Searching ALL inboxes. For better LLM context, set HELPSCOUT_DEFAULT_INBOX_ID environment variable.'
        ] : undefined),
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
    // Using direct imports
    
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
        body: config.security.allowPii ? firstCustomerMessage.body : '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]',
        createdAt: firstCustomerMessage.createdAt,
        customer: firstCustomerMessage.customer,
      } : null,
      latestStaffReply: latestStaffReply ? {
        id: latestStaffReply.id,
        body: config.security.allowPii ? latestStaffReply.body : '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]',
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
    // Using direct imports
    
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
      body: config.security.allowPii ? thread.body : '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]',
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

  private async listAllInboxes(args: unknown): Promise<CallToolResult> {
    const input = args as { limit?: number };
    // Using direct import
    const limit = input.limit || 100;

    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: limit,
    });

    const inboxes = response._embedded?.mailboxes || [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            inboxes: inboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            totalInboxes: inboxes.length,
            usage: 'Use the "id" field from these results in your conversation searches',
            nextSteps: [
              'To search in a specific inbox, use the inbox ID with comprehensiveConversationSearch or searchConversations',
              'To search across all inboxes, omit the inboxId parameter',
            ],
          }, null, 2),
        },
      ],
    };
  }

  private async advancedConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = AdvancedConversationSearchInputSchema.parse(args);
    // Using direct import

    // Build HelpScout query syntax
    const queryParts: string[] = [];

    // Content/body search (with injection protection)
    if (input.contentTerms && input.contentTerms.length > 0) {
      const bodyQueries = input.contentTerms.map(term => `body:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${bodyQueries.join(' OR ')})`);
    }

    // Subject search (with injection protection)
    if (input.subjectTerms && input.subjectTerms.length > 0) {
      const subjectQueries = input.subjectTerms.map(term => `subject:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${subjectQueries.join(' OR ')})`);
    }

    // Email searches (with injection protection)
    if (input.customerEmail) {
      queryParts.push(`email:"${this.escapeQueryTerm(input.customerEmail)}"`);
    }

    // Handle email domain search (with injection protection)
    if (input.emailDomain) {
      const domain = input.emailDomain.replace('@', ''); // Remove @ if present
      queryParts.push(`email:"${this.escapeQueryTerm(domain)}"`);
    }

    // Tag search (with injection protection)
    if (input.tags && input.tags.length > 0) {
      const tagQueries = input.tags.map(tag => `tag:"${this.escapeQueryTerm(tag)}"`);
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

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      queryParams.mailbox = effectiveInboxId;
    }

    if (input.status) queryParams.status = input.status;
    if (input.createdAfter) queryParams.modifiedSince = input.createdAfter;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);

    let conversations = response._embedded?.conversations || [];

    // Apply client-side createdBefore filtering (Help Scout API limitation)
    let clientSideFiltered = false;
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      const originalCount = conversations.length;
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
      clientSideFiltered = originalCount !== conversations.length;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: conversations,
            searchQuery: queryString,
            inboxScope: effectiveInboxId
              ? (input.inboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`)
              : 'ALL inboxes',
            searchCriteria: {
              contentTerms: input.contentTerms,
              subjectTerms: input.subjectTerms,
              customerEmail: input.customerEmail,
              emailDomain: input.emailDomain,
              tags: input.tags,
            },
            pagination: response.page,
            nextCursor: response._links?.next?.href,
            clientSideFiltering: clientSideFiltered ? 'createdBefore applied post-fetch - pagination may be incomplete' : undefined,
            note: !effectiveInboxId ? 'Searching ALL inboxes. Set HELPSCOUT_DEFAULT_INBOX_ID for better LLM context.' : undefined,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Performs comprehensive conversation search across multiple statuses
   * @param args - Search parameters including search terms, statuses, and timeframe
   * @returns Promise<CallToolResult> with search results organized by status
   * @example
   * comprehensiveConversationSearch({
   *   searchTerms: ["urgent", "billing"],
   *   timeframeDays: 30,
   *   inboxId: "123456"
   * })
   */
  private async comprehensiveConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = MultiStatusConversationSearchInputSchema.parse(args);
    
    const searchContext = this.buildComprehensiveSearchContext(input);
    const searchResults = await this.executeMultiStatusSearch(searchContext);
    const summary = this.formatComprehensiveSearchResults(searchResults, searchContext);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  /**
   * Build search context from input parameters
   */
  private buildComprehensiveSearchContext(input: z.infer<typeof MultiStatusConversationSearchInputSchema>) {
    const createdAfter = input.createdAfter || this.calculateTimeRange(input.timeframeDays);
    const searchQuery = this.buildSearchQuery(input.searchTerms, input.searchIn);
    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;

    return {
      input,
      createdAfter,
      searchQuery,
      effectiveInboxId,
    };
  }

  /**
   * Calculate time range for search
   * Note: Help Scout API requires ISO 8601 format WITHOUT milliseconds
   */
  private calculateTimeRange(timeframeDays: number): string {
    const timeRange = new Date();
    timeRange.setDate(timeRange.getDate() - timeframeDays);
    // Strip milliseconds - Help Scout rejects dates with .xxx format
    return timeRange.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Build Help Scout search query from terms and search locations (with injection protection)
   */
  private buildSearchQuery(terms: string[], searchIn: string[]): string {
    const queries: string[] = [];

    for (const term of terms) {
      const termQueries: string[] = [];
      const escapedTerm = this.escapeQueryTerm(term);

      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BODY) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`body:"${escapedTerm}"`);
      }

      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.SUBJECT) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`subject:"${escapedTerm}"`);
      }

      if (termQueries.length > 0) {
        queries.push(`(${termQueries.join(' OR ')})`);
      }
    }

    return queries.join(' OR ');
  }

  /**
   * Execute search across multiple statuses with error handling
   */
  private async executeMultiStatusSearch(context: {
    input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
    createdAfter: string;
    searchQuery: string;
    effectiveInboxId?: string;
  }) {
    const { input, createdAfter, searchQuery, effectiveInboxId } = context;
    // Using direct import
    const allResults: Array<{
      status: string;
      totalCount: number;
      conversations: Conversation[];
      searchQuery: string;
    }> = [];

    for (const status of input.statuses) {
      try {
        const result = await this.searchSingleStatus({
          status,
          searchQuery,
          createdAfter,
          limitPerStatus: input.limitPerStatus,
          inboxId: effectiveInboxId,
          createdBefore: input.createdBefore,
        });
        allResults.push(result);
      } catch (error) {
        logger.warn('Failed to search conversations for status', {
          status,
          error: error instanceof Error ? error.message : String(error),
        });

        allResults.push({
          status,
          totalCount: 0,
          conversations: [],
          searchQuery,
        });
      }
    }

    return allResults;
  }

  /**
   * Search conversations for a single status
   */
  private async searchSingleStatus(params: {
    status: string;
    searchQuery: string;
    createdAfter: string;
    limitPerStatus: number;
    inboxId?: string;
    createdBefore?: string;
  }) {
    // Using direct import
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: params.limitPerStatus,
      sortField: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
      sortOrder: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
      query: params.searchQuery,
      status: params.status,
      modifiedSince: params.createdAfter,
    };

    if (params.inboxId) {
      queryParams.mailbox = params.inboxId;
    }

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];

    // Apply client-side createdBefore filter
    if (params.createdBefore) {
      const beforeDate = new Date(params.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    }

    return {
      status: params.status,
      totalCount: response.page?.totalElements || conversations.length,
      conversations,
      searchQuery: params.searchQuery,
    };
  }

  /**
   * Format comprehensive search results into summary response
   */
  private formatComprehensiveSearchResults(
    allResults: Array<{
      status: string;
      totalCount: number;
      conversations: Conversation[];
      searchQuery: string;
    }>,
    context: {
      input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
      createdAfter: string;
      searchQuery: string;
      effectiveInboxId?: string;
    }
  ) {
    const { input, createdAfter, searchQuery, effectiveInboxId } = context;
    const totalConversations = allResults.reduce((sum, result) => sum + result.conversations.length, 0);
    const totalAvailable = allResults.reduce((sum, result) => sum + result.totalCount, 0);

    return {
      searchTerms: input.searchTerms,
      searchQuery,
      searchIn: input.searchIn,
      inboxScope: effectiveInboxId
        ? (input.inboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`)
        : 'ALL inboxes',
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
        'Verify that conversations exist for the specified criteria',
        !effectiveInboxId ? 'Set HELPSCOUT_DEFAULT_INBOX_ID to scope searches to your primary inbox' : undefined
      ].filter(Boolean) : (!effectiveInboxId ? [
        'Note: Searching ALL inboxes. For better LLM context, set HELPSCOUT_DEFAULT_INBOX_ID environment variable.'
      ] : undefined),
    };
  }

  private async structuredConversationFilter(args: unknown): Promise<CallToolResult> {
    const input = StructuredConversationFilterInputSchema.parse(args);

    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sortBy,
      sortOrder: input.sortOrder,
    };

    // Apply unique structural filters
    if (input.assignedTo !== undefined) queryParams.assigned_to = input.assignedTo;
    if (input.folderId !== undefined) queryParams.folder = input.folderId;
    if (input.conversationNumber !== undefined) queryParams.number = input.conversationNumber;

    // Apply customerIds via query syntax if provided
    if (input.customerIds && input.customerIds.length > 0) {
      queryParams.query = `(${input.customerIds.map(id => `customerIds:${id}`).join(' OR ')})`;
    }

    // Apply combination filters
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) queryParams.mailbox = effectiveInboxId;
    if (input.status && input.status !== 'all') queryParams.status = input.status;
    if (input.tag) queryParams.tag = input.tag;
    if (input.createdAfter) queryParams.modifiedSince = input.createdAfter;
    if (input.modifiedSince) queryParams.modifiedSince = input.modifiedSince;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];

    // Client-side createdBefore filtering (Help Scout API limitation)
    let clientSideFiltered = false;
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      const originalCount = conversations.length;
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
      clientSideFiltered = originalCount !== conversations.length;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: conversations,
          filterApplied: {
            filterType: 'structural',
            assignedTo: input.assignedTo,
            folderId: input.folderId,
            customerIds: input.customerIds,
            conversationNumber: input.conversationNumber,
            uniqueSorting: ['waitingSince', 'customerName', 'customerEmail'].includes(input.sortBy) ? input.sortBy : undefined,
          },
          inboxScope: effectiveInboxId ? (input.inboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`) : 'ALL inboxes',
          pagination: response.page,
          nextCursor: response._links?.next?.href,
          clientSideFiltering: clientSideFiltered ? 'createdBefore applied post-fetch - pagination may be incomplete' : undefined,
          note: 'Structural filtering applied. For content-based search or rep activity, use comprehensiveConversationSearch.',
        }, null, 2),
      }],
    };
  }
}

export const toolHandler = new ToolHandler();