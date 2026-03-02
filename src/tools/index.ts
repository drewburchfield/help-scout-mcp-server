import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PaginatedResponse, helpScoutClient } from '../utils/helpscout-client.js';
import { createMcpToolError, isApiError } from '../utils/mcp-errors.js';
import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';
import { ServiceContainer } from '../utils/service-container.js';
import { DocsToolHandler } from './docs-tools.js';
import { ReportsToolHandler } from './reports-tools.js';
import { logger } from '../utils/logger.js';
import { config, isVerbose } from '../utils/config.js';
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
  StructuredConversationFilterInputSchema,
} from '../schema/types.js';

/**
 * Add the `verbose` property to a tool's inputSchema.
 */
function addVerboseParam(tool: Tool): Tool {
  const schema = tool.inputSchema as any;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        verbose: {
          type: 'boolean',
          description: 'Return full API response objects instead of slim summaries. Default: false (slim).',
          default: false,
        },
      },
    },
  };
}

export class ToolHandler {
  private callHistory: string[] = [];
  private currentUserQuery?: string;
  private docsToolHandler: DocsToolHandler;
  private reportsToolHandler: ReportsToolHandler;

  constructor(container?: ServiceContainer) {
    // Initialize DocsToolHandler with the same container
    this.docsToolHandler = new DocsToolHandler(container);
    // Initialize ReportsToolHandler with the same container
    this.reportsToolHandler = new ReportsToolHandler(container);
  }

  /**
   * Strip a raw Help Scout conversation object down to the fields that matter.
   * The API returns huge objects with _links, _embedded, tag styles, photo URLs,
   * closedByUser, source metadata, etc. — none of which the LLM needs.
   */
  private slimConversation(conv: Conversation): Record<string, unknown> {
    return {
      id: conv.id,
      number: (conv as any).number,
      subject: (conv as any).subject,
      status: (conv as any).status,
      preview: (conv as any).preview,
      mailboxId: (conv as any).mailboxId,
      assignee: (conv as any).assignee ? {
        id: (conv as any).assignee.id,
        first: (conv as any).assignee.first || (conv as any).assignee.firstName,
        last: (conv as any).assignee.last || (conv as any).assignee.lastName,
        email: (conv as any).assignee.email,
      } : null,
      customer: (conv as any).createdBy?.type === 'customer' ? {
        id: (conv as any).createdBy.id,
        first: (conv as any).createdBy.first || (conv as any).createdBy.firstName,
        last: (conv as any).createdBy.last || (conv as any).createdBy.lastName,
        email: (conv as any).createdBy.email,
      } : (conv as any).customer ? {
        id: (conv as any).customer.id,
        first: (conv as any).customer.first || (conv as any).customer.firstName,
        last: (conv as any).customer.last || (conv as any).customer.lastName,
        email: (conv as any).customer.email,
      } : null,
      tags: ((conv as any).tags || []).map((t: any) => t.tag || t.name || t),
      createdAt: (conv as any).createdAt,
      closedAt: (conv as any).closedAt,
      waitingSince: (conv as any).customerWaitingSince?.friendly,
    };
  }

  /**
   * Fetch multiple pages from the Help Scout conversations API until we reach
   * the desired count or run out of pages. Help Scout ignores the `size` param
   * and always returns ~25 conversations per page, so we must paginate to get
   * more than 25 results.
   */
  private async fetchConversationPages(
    params: Record<string, unknown>,
    desiredCount: number,
    maxPages?: number
  ): Promise<{ conversations: Conversation[]; totalElements: number }> {
    const conversations: Conversation[] = [];
    let totalElements = 0;
    let currentPage = 1;
    let hasMore = true;

    const effectiveMaxPages = maxPages || Math.ceil(desiredCount / 25) + 1;

    while (conversations.length < desiredCount && hasMore && currentPage <= effectiveMaxPages) {
      const response = await helpScoutClient.get<PaginatedResponse<Conversation>>(
        '/conversations',
        { ...params, page: currentPage }
      );

      const pageConversations = response._embedded?.conversations || [];
      conversations.push(...pageConversations);
      totalElements = response.page?.totalElements || totalElements;
      hasMore = !!response._links?.next;
      currentPage++;
    }

    return { conversations, totalElements };
  }

  /**
   * Fetch multiple pages of threads from a conversation until we reach
   * the desired count or run out of pages.
   */
  private async fetchThreadPages(
    conversationId: string,
    desiredCount: number
  ): Promise<{ threads: Thread[]; totalElements: number }> {
    const threads: Thread[] = [];
    let totalElements = 0;
    let currentPage = 1;
    let hasMore = true;
    const maxPages = Math.ceil(desiredCount / 25) + 1;

    while (threads.length < desiredCount && hasMore && currentPage <= maxPages) {
      const response = await helpScoutClient.get<PaginatedResponse<Thread>>(
        `/conversations/${conversationId}/threads`,
        { page: currentPage, size: desiredCount }
      );

      const pageThreads = response._embedded?.threads || [];
      threads.push(...pageThreads);
      totalElements = response.page?.totalElements || totalElements;
      hasMore = !!response._links?.next;
      currentPage++;
    }

    return { threads, totalElements };
  }

  /**
   * Escape special characters in Help Scout query syntax to prevent injection
   */
  private escapeQueryTerm(term: string): string {
    return term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Append a createdAt date range to an existing Help Scout query string.
   * Help Scout has no native createdAfter/createdBefore URL params, so we
   * use query syntax: (createdAt:[start TO end]).
   */
  private appendCreatedAtFilter(
    existingQuery: string | undefined,
    createdAfter?: string,
    createdBefore?: string
  ): string | undefined {
    if (!createdAfter && !createdBefore) return existingQuery;

    // Validate date format to prevent query injection
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
    if (createdAfter && !isoDatePattern.test(createdAfter)) {
      throw new Error(`Invalid createdAfter date format: ${createdAfter}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }
    if (createdBefore && !isoDatePattern.test(createdBefore)) {
      throw new Error(`Invalid createdBefore date format: ${createdBefore}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }

    // Strip milliseconds (Help Scout rejects .xxx format)
    const normalize = (d: string) => d.replace(/\.\d{3}Z$/, 'Z');
    const start = createdAfter ? normalize(createdAfter) : '*';
    const end = createdBefore ? normalize(createdBefore) : '*';
    const clause = `(createdAt:[${start} TO ${end}])`;

    if (!existingQuery) return clause;
    return `(${existingQuery}) AND ${clause}`;
  }

  /**
   * Apply client-side createdBefore filter (Help Scout API does not support this natively).
   */
  private applyCreatedBeforeFilter(
    conversations: Conversation[],
    createdBefore: string,
    context: string
  ): { filtered: Conversation[]; wasFiltered: boolean; removedCount: number } {
    const beforeDate = new Date(createdBefore);
    if (isNaN(beforeDate.getTime())) {
      throw new Error(`Invalid createdBefore date format: ${createdBefore}. Expected ISO 8601 format (e.g., 2023-01-15T00:00:00Z)`);
    }

    const originalCount = conversations.length;
    const filtered = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    const removedCount = originalCount - filtered.length;

    if (removedCount > 0) {
      logger.warn(`Client-side createdBefore filter applied - ${context}`, {
        originalCount,
        filteredCount: filtered.length,
        removedCount,
        note: 'Help Scout API does not support createdBefore parameter natively'
      });
    }

    return { filtered, wasFiltered: removedCount > 0, removedCount };
  }

  /**
   * Build pagination info that distinguishes filtered count from API total.
   */
  private buildFilteredPagination(
    filteredCount: number,
    apiPage: { totalElements?: number } | undefined,
    wasFiltered: boolean
  ): unknown {
    if (!wasFiltered) return apiPage;
    return {
      totalResults: filteredCount,
      totalAvailable: apiPage?.totalElements,
      note: `Results filtered client-side by createdBefore. totalResults shows filtered count (${filteredCount}), totalAvailable shows pre-filter API total (${apiPage?.totalElements}).`
    };
  }

  /**
   * Set the current user query for context-aware validation
   */
  setUserContext(userQuery: string): void {
    this.currentUserQuery = userQuery;
  }

  async listTools(): Promise<Tool[]> {
    const conversationTools: Tool[] = [
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
        description: 'Search conversations by keywords, structured filters, or list by status/date/inbox. Searches ALL statuses (active, pending, closed) by default — do NOT filter statuses unless the user explicitly asks for a specific status.\n\n- For keyword search: provide searchTerms (searches across all statuses)\n- For structured filters: provide contentTerms, subjectTerms, customerEmail, emailDomain, or tags\n- For listing/browsing: use inboxId, tag, createdAfter/createdBefore\n- Set includeTranscripts:true to fetch message transcripts inline (great for summarization). Defaults to 10 conversations when enabled.',
        inputSchema: {
          type: 'object',
          properties: {
            // --- Simple search / listing ---
            query: {
              type: 'string',
              description: 'Raw HelpScout query syntax. Omit to list all. Example: (body:"keyword")',
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
              description: 'Filter by single status. Omit to search ALL statuses (active+pending+closed). Only set this if the user explicitly requests a specific status.',
            },
            statuses: {
              type: 'array',
              items: { type: 'string', enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM] },
              description: 'Filter by multiple statuses. Omit to search ALL statuses. Only use if the user explicitly requests specific statuses.',
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
              description: 'Maximum number of results. Auto-paginates to fetch all.',
              minimum: 1,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'modifiedAt', 'number'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
              description: 'Sort field',
            },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
              description: 'Sort order',
            },
            // --- Keyword search (multi-status parallel) ---
            searchTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to search for (OR logic across all statuses). Example: ["billing", "refund"]',
            },
            searchIn: {
              type: 'array',
              items: { enum: ['body', 'subject', 'both'] },
              description: 'Where to search for terms (defaults to both body and subject)',
              default: ['both'],
            },
            timeframeDays: {
              type: 'number',
              description: `Number of days back to search (defaults to ${TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS}, used with searchTerms)`,
              minimum: 1,
              maximum: 365,
              default: TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS,
            },
            // --- Structured search (field-specific queries) ---
            contentTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation body/content (OR combined)',
            },
            subjectTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation subject (OR combined)',
            },
            customerEmail: {
              type: 'string',
              description: 'Exact customer email to search for',
            },
            emailDomain: {
              type: 'string',
              description: 'Email domain to search for (e.g., "company.com")',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tag names to filter by (OR combined)',
            },
            // --- Transcript inclusion ---
            includeTranscripts: {
              type: 'boolean',
              default: false,
              description: 'When true, fetches message transcripts for each conversation (customer/staff dialogue, HTML stripped). Limit defaults to 10 when enabled. Higher limits with transcripts may be slow.',
            },
            transcriptMaxMessages: {
              type: 'number',
              default: 10,
              minimum: 1,
              maximum: 50,
              description: 'Max messages per conversation transcript (default 10). Only used when includeTranscripts is true.',
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
        description: 'Retrieve message history for a conversation. Use format:"transcript" for a minimal customer/staff dialogue optimized for AI analysis.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get threads for',
            },
            format: {
              type: 'string',
              enum: ['full', 'transcript'],
              default: 'full',
              description: 'Output format. "full" returns all threads with metadata. "transcript" returns only customer/staff messages as a minimal dialogue (strips notes, lineitems, HTML).',
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
        name: 'getAttachment',
        description: 'Download an attachment from a Help Scout conversation thread. Returns the file saved to a temp path that can be read with the Read tool. Use getThreads first to find attachment IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            attachmentId: {
              type: 'string',
              description: 'The attachment ID (from getThreads attachment metadata)',
            },
            conversationId: {
              type: 'string',
              description: 'The conversation ID the attachment belongs to',
            },
            filename: {
              type: 'string',
              description: 'Original filename (from getThreads attachment metadata). Used for the saved file.',
            },
          },
          required: ['attachmentId', 'conversationId'],
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
        name: 'structuredConversationFilter',
        description: 'Lookup conversation by ticket number or filter by assignee/customer/folder IDs. Use after discovering IDs from other searches. For initial searches, use searchConversations.',
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
            limit: { type: 'number', minimum: 1, default: 50 },
            cursor: { type: 'string' },
          },
        },
      },
    ];

    // Get Docs tools from the Docs handler (unless disabled via HELPSCOUT_DISABLE_DOCS=true)
    const docsTools = config.helpscout.disableDocs ? [] : await this.docsToolHandler.listDocsTools();

    // Get Reports tools from the Reports handler
    const reportsTools = await this.reportsToolHandler.listReportsTools();

    // Combine all tools and add `verbose` parameter to each
    return [...conversationTools, ...docsTools, ...reportsTools].map(addVerboseParam);
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

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
          })
        }]
      };
    }

    try {
      let result: CallToolResult;

      // Check if this is a Docs tool (unless disabled)
      const isDocsTool = !config.helpscout.disableDocs &&
        (await this.docsToolHandler.listDocsTools()).some(tool => tool.name === request.params.name);

      // Check if this is a Reports tool
      const reportsTools = await this.reportsToolHandler.listReportsTools();
      const isReportsTool = reportsTools.some(tool => tool.name === request.params.name);

      if (isDocsTool) {
        // Delegate to Docs tool handler
        result = await this.docsToolHandler.callDocsTool(request);
      } else if (isReportsTool) {
        // Delegate to Reports tool handler
        result = await this.reportsToolHandler.callReportsTool(request);
      } else {
        // Handle conversation tools
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
          case 'getAttachment':
            result = await this.getAttachment(request.params.arguments || {});
            break;
          case 'getServerTime':
            result = await this.getServerTime();
            break;
          case 'listAllInboxes':
            result = await this.listAllInboxes(request.params.arguments || {});
            break;
          case 'structuredConversationFilter':
            result = await this.structuredConversationFilter(request.params.arguments || {});
            break;
          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
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
          text: JSON.stringify(originalContent)
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
    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: input.limit,
    });

    const inboxes = response._embedded?.mailboxes || [];
    const filteredInboxes = inboxes.filter(inbox =>
      inbox.name.toLowerCase().includes(input.query.toLowerCase())
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: isVerbose(args) ? filteredInboxes : filteredInboxes.map(inbox => ({
            id: inbox.id,
            name: inbox.name,
            email: inbox.email,
          })),
          totalFound: filteredInboxes.length,
        }),
      }],
    };
  }

  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);
    const verbose = isVerbose(args);

    // When transcripts are requested and no explicit limit was set, default to 10
    if (input.includeTranscripts && !(args as any)?.limit) {
      input.limit = 10;
    }

    // --- Route to the appropriate search strategy ---
    let result: CallToolResult;

    // 1. Keyword search mode: searchTerms provided → multi-status parallel search
    if (input.searchTerms && input.searchTerms.length > 0) {
      result = await this.searchConversationsKeyword(input, verbose);
    }
    // 2. Structured search mode: contentTerms/subjectTerms/customerEmail/emailDomain/tags
    else if (input.contentTerms?.length || input.subjectTerms?.length || input.customerEmail || input.emailDomain || input.tags?.length) {
      result = await this.searchConversationsStructured(input, verbose);
    }
    // 3. Simple/list mode: filter by status, date, inbox, tag
    else {
      result = await this.searchConversationsList(input, verbose);
    }

    // --- Attach transcripts if requested ---
    if (input.includeTranscripts) {
      result = await this.enrichWithTranscripts(result, input.transcriptMaxMessages);
    }

    return result;
  }

  /**
   * Keyword search: multi-status parallel search across active/pending/closed
   */
  private async searchConversationsKeyword(
    input: z.infer<typeof SearchConversationsInputSchema>,
    verbose: boolean
  ): Promise<CallToolResult> {
    const createdAfter = input.createdAfter || this.calculateTimeRange(input.timeframeDays);
    const searchQuery = this.buildSearchQuery(input.searchTerms!, input.searchIn);
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    const statuses = input.statuses?.length ? input.statuses : (['active', 'pending', 'closed'] as const);
    const limitPerStatus = input.limit || TOOL_CONSTANTS.DEFAULT_PAGE_SIZE;

    const allResults: Array<{
      status: string;
      totalCount: number;
      conversations: Record<string, unknown>[];
    }> = [];

    const settled = await Promise.allSettled(
      statuses.map(status =>
        this.searchSingleStatus({
          status,
          searchQuery,
          createdAfter,
          limitPerStatus,
          inboxId: effectiveInboxId,
          createdBefore: input.createdBefore,
          verbose,
        })
      )
    );

    for (const [index, result] of settled.entries()) {
      const status = statuses[index];
      if (result.status === 'fulfilled') {
        allResults.push(result.value);
      } else {
        const error = result.reason;
        if (!isApiError(error)) throw error;
        if (error.code === 'UNAUTHORIZED' || error.code === 'INVALID_INPUT') throw error;

        logger.error('Status search failed - partial results will be returned', {
          status, errorCode: error.code, message: error.message,
        });
        allResults.push({ status, totalCount: 0, conversations: [] });
      }
    }

    const totalConversations = allResults.reduce((sum, r) => sum + r.conversations.length, 0);
    const totalAvailable = allResults.reduce((sum, r) => sum + r.totalCount, 0);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: searchQuery,
          totalConversationsFound: totalConversations,
          totalAvailable,
          resultsByStatus: allResults.map(r => ({
            status: r.status,
            count: r.conversations.length,
            totalAvailable: r.totalCount,
            conversations: r.conversations,
          })),
        }),
      }],
    };
  }

  /**
   * Structured search: builds Help Scout query syntax with field prefixes
   */
  private async searchConversationsStructured(
    input: z.infer<typeof SearchConversationsInputSchema>,
    verbose: boolean
  ): Promise<CallToolResult> {
    const queryParts: string[] = [];

    if (input.contentTerms && input.contentTerms.length > 0) {
      const bodyQueries = input.contentTerms.map(term => `body:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${bodyQueries.join(' OR ')})`);
    }

    if (input.subjectTerms && input.subjectTerms.length > 0) {
      const subjectQueries = input.subjectTerms.map(term => `subject:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${subjectQueries.join(' OR ')})`);
    }

    if (input.customerEmail) {
      queryParts.push(`email:"${this.escapeQueryTerm(input.customerEmail)}"`);
    }

    if (input.emailDomain) {
      const domain = input.emailDomain.replace('@', '');
      queryParts.push(`email:"${this.escapeQueryTerm(domain)}"`);
    }

    if (input.tags && input.tags.length > 0) {
      const tagQueries = input.tags.map(tag => `tag:"${this.escapeQueryTerm(tag)}"`);
      queryParts.push(`(${tagQueries.join(' OR ')})`);
    }

    const queryString = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

    const effectiveLimit = input.limit || TOOL_CONSTANTS.DEFAULT_PAGE_SIZE;

    const queryParams: Record<string, unknown> = {
      size: effectiveLimit,
      sortField: 'createdAt',
      sortOrder: 'desc',
    };

    if (queryString) queryParams.query = queryString;

    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) queryParams.mailbox = effectiveInboxId;

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    // Multi-status parallel search if statuses array provided
    const statuses = input.statuses && input.statuses.length > 0
      ? input.statuses
      : null;

    let conversations: Conversation[] = [];
    let clientSideFiltered = false;

    if (statuses) {
      const results = await Promise.allSettled(
        statuses.map(status =>
          this.fetchConversationPages(
            { ...queryParams, status },
            effectiveLimit
          )
        )
      );

      const seenIds = new Set<number>();
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const conv of result.value.conversations) {
            if (!seenIds.has(conv.id)) {
              seenIds.add(conv.id);
              conversations.push(conv);
            }
          }
        }
      }

      conversations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } else {
      queryParams.status = input.status || 'all';
      const { conversations: fetched } = await this.fetchConversationPages(
        queryParams, effectiveLimit
      );
      conversations = fetched;
    }

    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'searchConversations(structured)');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    if (conversations.length > effectiveLimit) {
      conversations = conversations.slice(0, effectiveLimit);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: verbose ? conversations : conversations.map(c => this.slimConversation(c)),
          query: queryString,
          pagination: { returned: conversations.length },
          ...(statuses ? { statuses } : {}),
          ...(clientSideFiltered ? { clientSideFiltering: true } : {}),
        }),
      }],
    };
  }

  /**
   * Simple/list search: filter by status, date, inbox, tag
   */
  private async searchConversationsList(
    input: z.infer<typeof SearchConversationsInputSchema>,
    verbose: boolean
  ): Promise<CallToolResult> {
    const baseParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sort,
      sortOrder: input.order,
    };

    if (input.query) baseParams.query = input.query;

    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) baseParams.mailbox = effectiveInboxId;
    if (input.tag) baseParams.tag = input.tag;

    const queryWithDate = this.appendCreatedAtFilter(
      baseParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) baseParams.query = queryWithDate;

    let conversations: Conversation[] = [];
    let searchedStatuses: string[];
    let pagination: unknown = null;

    const effectiveLimit = input.limit || TOOL_CONSTANTS.DEFAULT_PAGE_SIZE;

    if (input.status && !input.statuses) {
      // Single status — auto-paginate
      const { conversations: fetched, totalElements } = await this.fetchConversationPages(
        { ...baseParams, status: input.status },
        effectiveLimit
      );
      conversations = fetched.slice(0, effectiveLimit);
      searchedStatuses = [input.status];
      pagination = { returned: conversations.length, totalAvailable: totalElements };
    } else {
      // Multi-status — auto-paginate each status in parallel
      const statuses = input.statuses?.length ? input.statuses : (['active', 'pending', 'closed'] as const);
      searchedStatuses = [...statuses];

      const results = await Promise.allSettled(
        statuses.map(status =>
          this.fetchConversationPages(
            { ...baseParams, status },
            effectiveLimit
          )
        )
      );

      const seenIds = new Set<number>();
      const failedStatuses: Array<{ status: string; message: string; code: string }> = [];
      let totalAvailable = 0;

      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          totalAvailable += result.value.totalElements;

          for (const conv of result.value.conversations) {
            if (!seenIds.has(conv.id)) {
              seenIds.add(conv.id);
              conversations.push(conv);
            }
          }
        } else {
          const failedStatus = statuses[index];
          const reason = result.reason;
          const errorMessage = isApiError(reason)
            ? reason.message
            : (reason instanceof Error ? reason.message : String(reason));
          const errorCode = isApiError(reason) ? reason.code : 'UNKNOWN';

          if (!isApiError(reason)) throw reason;
          if (errorCode === 'UNAUTHORIZED' || errorCode === 'INVALID_INPUT') throw reason;

          failedStatuses.push({ status: failedStatus, message: errorMessage, code: errorCode });
          logger.error('Status search failed - partial results will be returned', {
            status: failedStatus, errorCode, message: errorMessage,
          });
        }
      }

      if (failedStatuses.length > 0) {
        searchedStatuses = statuses.filter(s => !failedStatuses.some(f => f.status === s));
      }

      conversations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      if (conversations.length > effectiveLimit) {
        conversations = conversations.slice(0, effectiveLimit);
      }

      pagination = {
        returned: conversations.length,
        totalAvailable,
        ...(failedStatuses.length > 0 ? { errors: failedStatuses } : {}),
      };
    }

    // Apply client-side createdBefore filtering
    let clientSideFiltered = false;
    const originalPagination = pagination;

    if (input.createdBefore) {
      const filterResult = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'searchConversations');
      conversations = filterResult.filtered;
      clientSideFiltered = filterResult.wasFiltered;

      if (clientSideFiltered) {
        if (input.status) {
          pagination = this.buildFilteredPagination(
            conversations.length,
            originalPagination as { totalElements?: number } | undefined,
            true
          );
        } else {
          const merged = originalPagination as {
            totalAvailable?: number;
            errors?: Array<{ status: string; message: string; code: string }>;
            note?: string;
          } | null;
          pagination = {
            totalResults: conversations.length,
            totalAvailable: merged?.totalAvailable,
            errors: merged?.errors,
            note: `Client-side createdBefore filter applied to merged results. ${merged?.note || ''}`
          };
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: verbose ? conversations : conversations.map(c => this.slimConversation(c)),
          pagination,
          ...(input.query ? { query: input.query } : {}),
          statuses: searchedStatuses,
          ...(clientSideFiltered ? { clientSideFiltering: true } : {}),
        }),
      }],
    };
  }

  /**
   * Post-process a searchConversations result to attach transcripts.
   * Works with all three search paths (keyword, structured, list).
   */
  private async enrichWithTranscripts(
    result: CallToolResult,
    maxMessages: number
  ): Promise<CallToolResult> {
    const data = JSON.parse((result.content[0] as any).text);

    // Keyword path uses resultsByStatus[].conversations, others use results[]
    if (data.resultsByStatus) {
      for (const statusGroup of data.resultsByStatus) {
        statusGroup.conversations = await this.attachTranscripts(
          statusGroup.conversations,
          maxMessages
        );
      }
    } else if (data.results) {
      data.results = await this.attachTranscripts(data.results, maxMessages);
    }

    data.includeTranscripts = true;
    data.transcriptMaxMessages = maxMessages;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data),
      }],
    };
  }

  private async getConversationSummary(args: unknown): Promise<CallToolResult> {
    const input = GetConversationSummaryInputSchema.parse(args);
    const verbose = isVerbose(args);

    // Get conversation details
    const conversation = await helpScoutClient.get<Conversation>(`/conversations/${input.conversationId}`);

    // Get all threads to find first customer message and latest staff reply
    const { threads } = await this.fetchThreadPages(input.conversationId, 200);

    // Verbose: return full conversation + all threads
    if (verbose) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ conversation, threads }),
        }],
      };
    }

    const customerThreads = threads.filter(t => t.type === 'customer');
    const staffThreads = threads.filter(t => t.type === 'message' && t.createdBy);

    const firstCustomerMessage = customerThreads.sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0];

    const latestStaffReply = staffThreads.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    const summary = {
      conversation: this.slimConversation(conversation),
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
      content: [{
        type: 'text',
        text: JSON.stringify(summary),
      }],
    };
  }

  /**
   * Extract clean message from Help Scout Beacon form HTML.
   * Beacon forms come in two variants:
   * 1. Hidden span + form table: actual message in <span style="display: none">
   * 2. Form table only: Q&A pairs, last long answer is the message body
   * Both may have a "View Full Ticket" source link to preserve.
   */
  private cleanBeaconForm(html: string): string {
    // Detect Beacon form pattern: table with bgcolor="#EAEAEA"
    const isBeaconForm = /bgcolor="#EAEAEA"/.test(html);
    if (!isBeaconForm) return html;

    // Extract source URL from "View Full Ticket" link (present in both variants)
    const linkMatch = html.match(/<a\s+href="([^"]+)"[^>]*>View Full Ticket<\/a>/i);
    const sourceUrl = linkMatch
      ? linkMatch[1].replace(/&amp;/gi, '&')
      : '';

    // Variant 1: Hidden span contains the actual message
    const hiddenMatch = html.match(/<span style="display: none">([\s\S]*?)<\/span>/i);
    if (hiddenMatch && hiddenMatch[1].trim()) {
      let cleaned = hiddenMatch[1];
      if (sourceUrl) {
        cleaned += `<br>\n<br>\nSource: ${sourceUrl}`;
      }
      return cleaned;
    }

    // Variant 2: Form table only — extract Q&A pairs, use last long answer as message
    // Parse answer cells: they follow question cells in alternating bg-colored rows
    const answerRegex = /<tr\s+bgcolor="#FFFFFF"[^>]*>[\s\S]*?<td[\s\S]*?<font[^>]*>([\s\S]*?)<\/font>[\s\S]*?<\/tr>/gi;
    const answers: string[] = [];
    let match;
    while ((match = answerRegex.exec(html)) !== null) {
      const text = match[1].trim();
      if (text && text !== '&nbsp;') {
        answers.push(text);
      }
    }

    // The last answer is typically the detailed message ("Further describe...")
    // Use it as the message body if it's substantially longer than other answers
    let message = '';
    if (answers.length > 0) {
      const lastAnswer = answers[answers.length - 1];
      message = lastAnswer;
    }

    if (sourceUrl) {
      message += `<br>\n<br>\nSource: ${sourceUrl}`;
    }

    return message || html;
  }

  /**
   * Strip HTML tags and collapse whitespace for transcript output.
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n').map(line => line.trim()).join('\n')
      .trim();
  }

  /**
   * Build a transcript from threads: filter to customer/staff messages,
   * strip HTML, respect redaction, sort chronologically.
   */
  private buildTranscript(threads: Thread[], maxMessages: number): Array<{
    role: string;
    from: string;
    date: string;
    body: string;
    attachments?: number;
  }> {
    const dialogueThreads = threads.filter(t => {
      const type = (t as any).type;
      const state = (t as any).state;
      if (type !== 'customer' && type !== 'message') return false;
      if (state === 'draft') return false;
      return true;
    });

    dialogueThreads.sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    const limited = dialogueThreads.slice(0, maxMessages);

    return limited.map(t => {
      const type = (t as any).type;
      const isCustomer = type === 'customer';
      const person = isCustomer ? (t as any).customer : (t as any).createdBy;
      const name = person
        ? `${person.first || person.firstName || ''} ${person.last || person.lastName || ''}`.trim()
        : (isCustomer ? 'Customer' : 'Staff');
      const role = isCustomer ? 'customer' : 'staff';
      const rawBody = t.body || '';
      const body = config.security.allowPii
        ? this.stripHtml(this.cleanBeaconForm(rawBody))
        : '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]';

      return {
        role,
        from: name,
        date: t.createdAt,
        body,
        ...((((t as any)._embedded?.attachments || (t as any).attachments)?.length > 0) ? {
          attachments: ((t as any)._embedded?.attachments || (t as any).attachments).map((a: any) => ({
            id: a.id,
            filename: a.filename || a.fileName,
            mimeType: a.mimeType,
            size: a.size,
            width: a.width,
            height: a.height,
          }))
        } : {}),
      };
    });
  }

  /**
   * For an array of conversations, fetch threads and build transcripts in parallel.
   */
  private async attachTranscripts(
    conversations: Array<Record<string, unknown>>,
    maxMessages: number
  ): Promise<Array<Record<string, unknown>>> {
    const results = await Promise.allSettled(
      conversations.map(async (conv) => {
        const id = String(conv.id);
        const { threads } = await this.fetchThreadPages(id, maxMessages);
        const transcript = this.buildTranscript(threads, maxMessages);
        return { ...conv, transcript };
      })
    );

    return results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      logger.error('Failed to fetch transcript', {
        conversationId: conversations[i].id,
        error: result.reason?.message || String(result.reason),
      });
      return { ...conversations[i], transcript: null, transcriptError: 'Failed to fetch' };
    });
  }

  private async getThreads(args: unknown): Promise<CallToolResult> {
    const input = GetThreadsInputSchema.parse(args);
    const verbose = isVerbose(args);

    // Auto-paginate: Help Scout may ignore size param for threads
    const { threads: allThreads, totalElements } = await this.fetchThreadPages(
      input.conversationId,
      input.limit
    );

    const threads = allThreads.slice(0, input.limit);

    // Transcript format: minimal customer/staff dialogue for AI analysis
    if (input.format === 'transcript') {
      const transcript = this.buildTranscript(threads, threads.length);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            format: 'transcript',
            messages: transcript,
            totalMessages: transcript.length,
            totalThreads: totalElements,
          }),
        }],
      };
    }

    // Verbose: return raw thread objects (still redact if needed)
    if (verbose) {
      const redactedThreads = config.security.allowPii ? threads : threads.map(t => ({
        ...t,
        body: '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]',
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threads: redactedThreads,
            pagination: { returned: threads.length, total: totalElements },
          }),
        }],
      };
    }

    // Slim and redact threads
    const processedThreads = threads.map(thread => ({
      id: thread.id,
      type: (thread as any).type,
      status: (thread as any).status,
      body: config.security.allowPii ? thread.body : '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]',
      createdBy: (thread as any).createdBy ? {
        id: (thread as any).createdBy.id,
        type: (thread as any).createdBy.type,
        first: (thread as any).createdBy.first || (thread as any).createdBy.firstName,
        last: (thread as any).createdBy.last || (thread as any).createdBy.lastName,
        email: (thread as any).createdBy.email,
      } : null,
      customer: (thread as any).customer ? {
        id: (thread as any).customer.id,
        first: (thread as any).customer.first || (thread as any).customer.firstName,
        last: (thread as any).customer.last || (thread as any).customer.lastName,
        email: (thread as any).customer.email,
      } : null,
      createdAt: thread.createdAt,
      ...((((thread as any)._embedded?.attachments || (thread as any).attachments)?.length > 0) ? {
        attachments: ((thread as any)._embedded?.attachments || (thread as any).attachments).map((a: any) => ({
          id: a.id,
          filename: a.filename || a.fileName,
          mimeType: a.mimeType,
          size: a.size,
          width: a.width,
          height: a.height,
        }))
      } : {}),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          conversationId: input.conversationId,
          threads: processedThreads,
          pagination: { returned: threads.length, total: totalElements },
        }),
      }],
    };
  }

  private async getAttachment(args: unknown): Promise<CallToolResult> {
    const input = z.object({
      attachmentId: z.string(),
      conversationId: z.string(),
      filename: z.string().optional(),
    }).parse(args);

    try {
      // Fetch attachment data from Help Scout API
      const response = await helpScoutClient.get<{ data: string }>(
        `/conversations/${input.conversationId}/attachments/${input.attachmentId}/data`,
        {}
      );

      if (!response.data) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No attachment data returned from API' }) }],
          isError: true,
        };
      }

      // Decode base64 data
      const buffer = Buffer.from(response.data, 'base64');
      const filename = input.filename || `attachment-${input.attachmentId}`;

      // Write to temp file
      const fs = await import('fs');
      const path = await import('path');
      const dir = path.join('/tmp', 'helpscout-attachments', input.conversationId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, filename);
      fs.writeFileSync(filePath, buffer);

      // Detect mime type from extension
      const ext = path.extname(filename).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
        '.zip': 'application/zip', '.csv': 'text/csv', '.json': 'application/json',
        '.xml': 'application/xml', '.txt': 'text/plain', '.log': 'text/plain',
        '.html': 'text/html', '.htm': 'text/html',
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            attachmentId: input.attachmentId,
            conversationId: input.conversationId,
            filename,
            filePath,
            size: buffer.length,
            mimeType: mimeMap[ext] || 'application/octet-stream',
            hint: 'Use the Read tool on filePath to view this file. Claude can natively view images (PNG, JPG, GIF, WEBP) and PDFs. For ZIP files, use Bash: unzip -l to list contents.',
          }),
        }],
      };
    } catch (error: any) {
      const message = isApiError(error) ? `Help Scout API error: ${error.message}` : `Failed to download attachment: ${error.message}`;
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
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
          text: JSON.stringify(serverTime),
        },
      ],
    };
  }

  private async listAllInboxes(args: unknown): Promise<CallToolResult> {
    const input = args as { limit?: number };
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
            inboxes: isVerbose(args) ? inboxes : inboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
            })),
            totalInboxes: inboxes.length,
          }),
        },
      ],
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


  private async searchSingleStatus(params: {
    status: string;
    searchQuery: string;
    createdAfter: string;
    limitPerStatus: number;
    inboxId?: string;
    createdBefore?: string;
    verbose?: boolean;
  }) {
    const queryWithDate = this.appendCreatedAtFilter(
      params.searchQuery,
      params.createdAfter
    );

    const queryParams: Record<string, unknown> = {
      size: params.limitPerStatus,
      sortField: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
      sortOrder: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
      query: queryWithDate || params.searchQuery,
      status: params.status,
    };

    if (params.inboxId) {
      queryParams.mailbox = params.inboxId;
    }

    // Auto-paginate: Help Scout returns ~25/page regardless of size param
    const { conversations: fetched, totalElements: apiTotalElements } =
      await this.fetchConversationPages(queryParams, params.limitPerStatus);

    let conversations = fetched;

    let filteredByDate = false;
    if (params.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, params.createdBefore, `searchSingleStatus(${params.status})`);
      conversations = result.filtered;
      filteredByDate = result.wasFiltered;
    }

    if (conversations.length > params.limitPerStatus) {
      conversations = conversations.slice(0, params.limitPerStatus);
    }

    return {
      status: params.status,
      totalCount: filteredByDate ? conversations.length : apiTotalElements,
      conversations: params.verbose ? conversations : conversations.map(c => this.slimConversation(c)),
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
    queryParams.status = input.status || 'all';
    if (input.tag) queryParams.tag = input.tag;
    if (input.modifiedSince) queryParams.modifiedSince = input.modifiedSince;

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    // Auto-paginate: Help Scout returns ~25/page regardless of size param
    const { conversations: fetched, totalElements } = await this.fetchConversationPages(
      queryParams,
      input.limit
    );
    let conversations = fetched;

    let clientSideFiltered = false;
    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'structuredConversationFilter');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    if (conversations.length > input.limit) {
      conversations = conversations.slice(0, input.limit);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: isVerbose(args) ? conversations : conversations.map(c => this.slimConversation(c)),
          pagination: { returned: conversations.length, total: totalElements },
          ...(clientSideFiltered ? { clientSideFiltering: true } : {}),
        }),
      }],
    };
  }
}

export const toolHandler = new ToolHandler();
