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
  ApiError,
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
        description: 'List or search inboxes by name. Deprecated: inbox IDs now in server instructions. Only needed to refresh list mid-session.',
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
        description: 'List conversations by status, date range, inbox, or tags. Searches all statuses by default. For keyword content search, use comprehensiveConversationSearch.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'HelpScout query syntax. Omit to list all. Example: (body:"keyword")',
            },
            inboxId: {
              type: 'string',
              description: 'Inbox ID from server instructions',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
              description: 'Filter by status. Defaults to all (active, pending, closed)',
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
        description: 'Retrieve full message history for a conversation. Returns all thread messages.',
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
        description: 'Get current server timestamp. Use before date-relative searches to calculate time ranges.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listAllInboxes',
        description: 'List all inboxes with IDs. Deprecated: inbox IDs now in server instructions. Only needed mid-session.',
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
        description: 'Filter conversations by email domain, customer email, or multiple tags. Supports boolean logic for complex queries. For simple keyword search, use comprehensiveConversationSearch.',
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
        description: 'Search conversation content by keywords. Searches subject and body across all statuses. Requires searchTerms parameter. For listing without keywords, use searchConversations.',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to search for (OR logic). Example: ["billing", "refund"]',
              minItems: 1,
            },
            inboxId: {
              type: 'string',
              description: 'Inbox ID from server instructions',
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
        description: 'Lookup conversation by ticket number or filter by assignee/customer/folder IDs. Use after discovering IDs from other searches. For initial searches, use searchConversations or comprehensiveConversationSearch.',
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

    const baseParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sort,
      sortOrder: input.order,
    };

    // Add HelpScout query parameter for content/body search
    if (input.query) {
      baseParams.query = input.query;
    }

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      baseParams.mailbox = effectiveInboxId;
    }

    if (input.tag) baseParams.tag = input.tag;
    if (input.createdAfter) baseParams.modifiedSince = input.createdAfter;

    let conversations: Conversation[] = [];
    let searchedStatuses: string[];
    let pagination: unknown = null;

    if (input.status) {
      // Explicit status: single API call
      const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
        ...baseParams,
        status: input.status,
      });
      conversations = response._embedded?.conversations || [];
      searchedStatuses = [input.status];
      pagination = response.page;
    } else {
      // No status specified: search all statuses in parallel
      const statuses = ['active', 'pending', 'closed'] as const;
      searchedStatuses = [...statuses];

      const results = await Promise.allSettled(
        statuses.map(status =>
          helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
            ...baseParams,
            status,
          })
        )
      );

      // Merge and dedupe by conversation ID, handling partial failures
      // Track both returned conversations AND total available from API
      const seenIds = new Set<number>();
      const failedStatuses: Array<{ status: string; error: string; code: string }> = [];
      let totalAvailable = 0;
      const totalByStatus: Record<string, number> = {};

      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          const statusName = statuses[index];
          const statusTotal = result.value.page?.totalElements || 0;
          totalByStatus[statusName] = statusTotal;
          totalAvailable += statusTotal;

          const responseConversations = result.value._embedded?.conversations || [];
          for (const conv of responseConversations) {
            if (!seenIds.has(conv.id)) {
              seenIds.add(conv.id);
              conversations.push(conv);
            }
          }
        } else {
          const failedStatus = statuses[index];
          const apiError = result.reason as ApiError;
          const errorDetails = {
            status: failedStatus,
            error: apiError?.message || (result.reason instanceof Error ? result.reason.message : String(result.reason)),
            code: apiError?.code || 'UNKNOWN'
          };

          failedStatuses.push(errorDetails);

          // Elevate to ERROR since this is a production failure affecting data completeness
          logger.error('Status search failed - partial results will be returned', {
            status: failedStatus,
            errorCode: errorDetails.code,
            message: errorDetails.error,
            note: 'This status will be excluded from results'
          });
        }
      }

      // Update searchedStatuses to reflect only successful searches
      if (failedStatuses.length > 0) {
        searchedStatuses = statuses.filter(s => !failedStatuses.some(f => f.status === s));
      }

      // Sort merged results by createdAt descending (most recent first)
      conversations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Limit to requested size after merging
      const effectiveLimit = input.limit || 50;
      if (conversations.length > effectiveLimit) {
        conversations = conversations.slice(0, effectiveLimit);
      }

      // Pagination for merged results - show both returned count and real total
      pagination = {
        totalResults: conversations.length,
        totalAvailable: totalAvailable > 0 ? totalAvailable : undefined,
        totalByStatus: Object.keys(totalByStatus).length > 0 ? totalByStatus : undefined,
        errors: failedStatuses.length > 0 ? failedStatuses.map(f => ({
          status: f.status,
          message: f.error,
          code: f.code
        })) : undefined,
        note: failedStatuses.length > 0
          ? `⚠️ WARNING: ${failedStatuses.length} status(es) failed - results incomplete! Failed: ${failedStatuses.map(f => `${f.status} (${f.code})`).join(', ')}. Totals reflect successful statuses only.`
          : `Merged results from ${Object.keys(totalByStatus).length} statuses. Returned ${conversations.length} of ${totalAvailable} total conversations.`
      };
      logger.info('Multi-status search completed', {
        statusesSearched: searchedStatuses,
        failedStatuses: failedStatuses.length > 0 ? failedStatuses : undefined,
        totalResults: conversations.length,
        totalAvailable: failedStatuses.length > 0 ? 'partial failure' : totalAvailable
      });
    }

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
      pagination,
      searchInfo: {
        query: input.query,
        statusesSearched: searchedStatuses,
        inboxScope: effectiveInboxId
          ? (input.inboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`)
          : 'ALL inboxes',
        clientSideFiltering: clientSideFiltered ? 'createdBefore filter applied after API fetch - pagination totals may not reflect filtered count' : undefined,
        searchGuidance: conversations.length === 0 ? [
          'If no results found, try:',
          '1. Broaden search terms or extend time range',
          '2. Check if inbox ID is correct',
          '3. Try including spam status explicitly',
          !effectiveInboxId ? '4. Set HELPSCOUT_DEFAULT_INBOX_ID to scope searches to your primary inbox' : undefined
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
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
      clientSideFiltered = originalCount !== conversations.length;

      if (clientSideFiltered) {
        logger.warn('Client-side createdBefore filter applied - API limitation', {
          originalCount,
          filteredCount: conversations.length,
          removedCount: originalCount - conversations.length,
          note: 'Help Scout API does not support createdBefore parameter natively'
        });
      }
    }

    // Build pagination object - distinguish between filtered results and API totals
    const paginationInfo = clientSideFiltered ? {
      totalResults: conversations.length,
      totalAvailable: response.page?.totalElements,
      note: `Results filtered client-side by createdBefore. totalResults shows filtered count (${conversations.length}), totalAvailable shows pre-filter API total (${response.page?.totalElements}).`
    } : response.page;

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
            pagination: paginationInfo,
            nextCursor: response._links?.next?.href,
            clientSideFiltering: clientSideFiltered ? `createdBefore filter removed ${originalCount - conversations.length} of ${originalCount} results` : undefined,
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
        const apiError = error as ApiError;

        // Critical errors should fail the entire operation
        if (apiError?.code === 'UNAUTHORIZED' || apiError?.code === 'INVALID_INPUT') {
          logger.error('Critical error in multi-status search - aborting', {
            status,
            errorCode: apiError.code,
            message: apiError.message
          });
          throw error; // Fail fast for auth/validation errors
        }

        // Non-critical errors: log as ERROR and include in response
        logger.error('Status search failed - partial results will be returned', {
          status,
          errorCode: apiError?.code || 'UNKNOWN',
          message: apiError?.message || (error instanceof Error ? error.message : String(error)),
          note: 'This status will be excluded from results'
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
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
      clientSideFiltered = originalCount !== conversations.length;

      if (clientSideFiltered) {
        logger.warn('Client-side createdBefore filter applied - API limitation', {
          originalCount,
          filteredCount: conversations.length,
          removedCount: originalCount - conversations.length,
          note: 'Help Scout API does not support createdBefore parameter natively'
        });
      }
    }

    // Build pagination object - distinguish between filtered results and API totals
    const paginationInfo = clientSideFiltered ? {
      totalResults: conversations.length,
      totalAvailable: response.page?.totalElements,
      note: `Results filtered client-side by createdBefore. totalResults shows filtered count (${conversations.length}), totalAvailable shows pre-filter API total (${response.page?.totalElements}).`
    } : response.page;

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
          pagination: paginationInfo,
          nextCursor: response._links?.next?.href,
          clientSideFiltering: clientSideFiltered ? `createdBefore filter removed ${originalCount - conversations.length} of ${originalCount} results` : undefined,
          note: 'Structural filtering applied. For content-based search or rep activity, use comprehensiveConversationSearch.',
        }, null, 2),
      }],
    };
  }
}

export const toolHandler = new ToolHandler();