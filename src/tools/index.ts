import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PaginatedResponse, helpScoutClient } from '../utils/helpscout-client.js';
import { DocsCollectionEnvelope, helpScoutDocsClient } from '../utils/helpscout-docs-client.js';
import { createMcpToolError, isApiError } from '../utils/mcp-errors.js';
import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { REDACTED_MESSAGE_BODY } from '../utils/constants.js';
import { sanitizeJsonSchema, coerceJsonStringArgs } from '../utils/schema-sanitizer.js';
import { buildResponseGuidance } from './response-guidance.js';
import {
  Inbox,
  Conversation,
  Thread,
  Customer,
  CustomerAddress,
  Organization,
  PropertyDefinition,
  Tag,
  User,
  SystemUser,
  UserStatus,
  Team,
  InboxRouting,
  InboxCustomField,
  InboxFolder,
  SavedReply,
  Workflow,
  Webhook,
  SatisfactionRating,
  ReportResponse,
  HappinessRatingsReport,
  ReportBaseInput,
  ServerTime,
  SearchConversationsInputSchema,
  GetThreadsInputSchema,
  GetConversationInputSchema,
  GetConversationSummaryInputSchema,
  GetCustomerInputSchema,
  ListCustomersInputSchema,
  SearchCustomersByEmailInputSchema,
  GetCustomerContactsInputSchema,
  ListAllInboxesInputSchema,
  GetInboxInputSchema,
  GetOrganizationInputSchema,
  ListOrganizationsInputSchema,
  GetOrganizationMembersInputSchema,
  GetOrganizationConversationsInputSchema,
  ListCustomerPropertiesInputSchema,
  ListOrganizationPropertiesInputSchema,
  GetOrganizationPropertyInputSchema,
  ListTagsInputSchema,
  GetTagInputSchema,
  ListUsersInputSchema,
  GetUserInputSchema,
  ListTeamsInputSchema,
  GetTeamMembersInputSchema,
  ListSavedRepliesInputSchema,
  GetSavedReplyInputSchema,
  GetOriginalSourceInputSchema,
  GetAttachmentInputSchema,
  DownloadAttachmentFileInputSchema,
  ListWorkflowsInputSchema,
  ListWebhooksInputSchema,
  GetWebhookInputSchema,
  GetSatisfactionRatingInputSchema,
  GetCompanyReportInputSchemaUnion,
  GetConversationsReportInputSchemaUnion,
  GetProductivityReportInputSchemaUnion,
  GetUserReportInputSchemaUnion,
  GetHappinessReportInputSchemaUnion,
  GetChannelReportInputSchemaUnion,
  GetDocsReportInputSchema,
  ListDocsSitesInputSchema,
  GetDocsSiteInputSchema,
  ListDocsCollectionsInputSchema,
  GetDocsCollectionInputSchema,
  ListDocsCategoriesInputSchema,
  GetDocsCategoryInputSchema,
  ListDocsArticlesInputSchema,
  SearchDocsArticlesInputSchema,
  GetDocsArticleInputSchema,
  ListDocsRelatedArticlesInputSchema,
  ListDocsArticleRevisionsInputSchema,
  GetDocsArticleRevisionInputSchema,
  ListDocsRedirectsInputSchema,
  GetDocsRedirectInputSchema,
  FindDocsRedirectInputSchema,
} from '../schema/types.js';

type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam';
const DEFAULT_CONVERSATION_STATUSES = ['active', 'pending', 'closed'] as const satisfies readonly ConversationStatus[];

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

function getNextPage(page?: { number?: number; totalPages?: number }): number | null {
  if (!page || page.number === undefined || page.totalPages === undefined) return null;
  return page.number < page.totalPages ? page.number + 1 : null;
}

function getDocsNextPage(page?: number, pages?: number): number | null {
  if (page === undefined || pages === undefined) return null;
  return page < pages ? page + 1 : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split text into lowercased alphanumeric word tokens for the search_tools
 * scorer. Splits camelCase boundaries (searchConversations -> search,
 * conversations) so tool names contribute their words.
 */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * Lightweight relevance score for search_tools (NAS-1305): term frequency over
 * a tool's name + description, expanded with the Help Scout synonym map, with a
 * strong boost when a query term matches the tool NAME. Pure, no external deps.
 */
function scoreTool(
  tool: Tool,
  queryTerms: readonly string[],
  expandedTerms: ReadonlySet<string>,
): number {
  const nameTokens = new Set(tokenize(tool.name));
  const descTokens = tokenize(tool.description ?? '');
  const descCounts = new Map<string, number>();
  for (const token of descTokens) {
    descCounts.set(token, (descCounts.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const term of expandedTerms) {
    // Direct query terms weigh more than synonym-only expansions.
    const isDirect = queryTerms.includes(term);
    const weight = isDirect ? 1 : 0.5;
    if (nameTokens.has(term)) {
      score += 4 * weight; // name match is the strongest signal
    }
    const inDesc = descCounts.get(term);
    if (inDesc) {
      score += weight * (1 + Math.log(inDesc));
    }
  }
  return score;
}

export class ToolHandler {
  private callHistory: string[] = [];

  /**
   * The core read tools advertised directly in the default discovery surface
   * (NAS-1305). These cover the ~90% path; everything else is reached via the
   * search_tools / get_tool_schema / call_tool meta tools.
   */
  private static readonly CORE_TOOLS: readonly string[] = [
    'searchConversations',
    'getConversation',
    'getThreads',
    'getCustomer',
    'getCustomerContacts',
    'listAllInboxes',
    'searchDocsArticles',
  ];

  /** The discovery meta-tool names. They are never dispatched via call_tool. */
  private static readonly META_TOOLS: readonly string[] = [
    'search_tools',
    'get_tool_schema',
    'call_tool',
  ];

  /**
   * Response-bootstrapped successor hints (NAS-1305 phase 3). Maps a "hub" tool
   * to the logically-next tools in the Help Scout entity graph
   * (2026-06-16-helpscout-read-api-contract.md). When a hub tool returns, the
   * full sanitized schemas of its (non-core) successors are appended to the
   * result's `_meta.suggestedTools` so the model can call them next with correct
   * args and no search detour. Successors already in CORE_TOOLS are filtered out
   * (the model already has those); only additive tail tools are surfaced.
   */
  private static readonly SUCCESSOR_MAP: Record<string, readonly string[]> = {
    searchConversations: ['getConversation', 'getThreads', 'getOriginalSource', 'getAttachment'],
    getConversation: ['getThreads', 'getOriginalSource', 'getCustomer'],
    getThreads: ['getOriginalSource', 'getAttachment', 'downloadAttachmentFile'],
    getCustomer: ['getCustomerContacts', 'getOrganization'],
    getOrganization: [
      'getOrganizationMembers',
      'getOrganizationConversations',
      'listOrganizationProperties',
    ],
    listAllInboxes: ['getInbox', 'listSavedReplies'],
    getInbox: ['listSavedReplies'],
    searchDocsArticles: ['getDocsArticle', 'listDocsArticleRevisions', 'listDocsRelatedArticles'],
    getCompanyReport: ['getConversationsReport', 'getProductivityReport', 'getHappinessReport'],
  };

  /**
   * Help Scout domain synonyms for search_tools (NAS-1305). Each entry maps a
   * canonical term to the words a model might use for the same concept. Used to
   * expand query terms so e.g. 'mailbox' surfaces inbox tools. Bidirectional:
   * a hit on any word in a group boosts tools mentioning any other word.
   */
  private static readonly SYNONYM_GROUPS: readonly (readonly string[])[] = [
    ['inbox', 'inboxes', 'mailbox', 'mailboxes'],
    ['conversation', 'conversations', 'ticket', 'tickets', 'case', 'cases'],
    ['customer', 'customers', 'contact', 'contacts', 'person', 'people'],
    ['message', 'messages', 'thread', 'threads', 'reply', 'replies'],
    ['report', 'reports', 'analytics', 'metrics', 'reporting'],
    ['tag', 'tags', 'label', 'labels'],
    ['user', 'users', 'agent', 'agents', 'teammate', 'teammates'],
    ['article', 'articles', 'doc', 'docs', 'knowledge', 'base'],
    ['attachment', 'attachments', 'file', 'files', 'download'],
    ['rating', 'ratings', 'satisfaction', 'happiness'],
    ['webhook', 'webhooks'],
    ['workflow', 'workflows'],
  ];

  constructor() {
    // Direct imports, no DI needed
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

    // Validate date format to prevent query injection and match Help Scout expectations
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T[\d:.]+([+-]\d{2}:\d{2}|Z)?)?$/;
    if (createdAfter && !isoDatePattern.test(createdAfter)) {
      throw new Error(`Invalid createdAfter date format: ${createdAfter}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }
    if (createdBefore && !isoDatePattern.test(createdBefore)) {
      throw new Error(`Invalid createdBefore date format: ${createdBefore}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }

    // Strip milliseconds (Help Scout rejects .xxx format)
    const normalize = (d: string) => d.replace(/\.\d{3}(Z|[+-]\d{2}:\d{2})$/, '$1');
    const start = createdAfter ? normalize(createdAfter) : '*';
    const end = createdBefore ? normalize(createdBefore) : '*';
    const clause = `(createdAt:[${start} TO ${end}])`;

    if (!existingQuery) return clause;
    return `(${existingQuery}) AND ${clause}`;
  }

  private normalizeApiDateParam(date: string | undefined): string | undefined {
    return date?.replace(/\.\d{3}(Z|[+-]\d{2}:\d{2})$/, '$1');
  }

  private buildReportQueryParams(input: ReportBaseInput): Record<string, string | number> {
    const params: Record<string, string | number> = {
      start: this.normalizeApiDateParam(input.start) ?? input.start,
      end: this.normalizeApiDateParam(input.end) ?? input.end,
    };

    if (input.previousStart) params.previousStart = this.normalizeApiDateParam(input.previousStart) ?? input.previousStart;
    if (input.previousEnd) params.previousEnd = this.normalizeApiDateParam(input.previousEnd) ?? input.previousEnd;
    if (input.mailboxes) params.mailboxes = input.mailboxes.join(',');
    if (input.tags) params.tags = input.tags.join(',');
    if (input.types) params.types = input.types.join(',');
    if (input.folders) params.folders = input.folders.join(',');

    return params;
  }

  private buildProductivityReportQueryParams(
    input: ReportBaseInput & { officeHours?: boolean; viewBy?: 'day' | 'week' | 'month' }
  ): Record<string, string | number> {
    const params = this.buildReportQueryParams(input);
    if (typeof input.officeHours === 'boolean') params.officeHours = String(input.officeHours);
    if (input.viewBy) params.viewBy = input.viewBy;
    return params;
  }

  private buildUserReportQueryParams(
    input: ReportBaseInput & {
      user: string;
      officeHours?: boolean;
      viewBy?: 'day' | 'week' | 'month';
      status?: 'active' | 'pending' | 'closed';
      page?: number;
      rows?: number;
      sortField?: string;
      sortOrder?: 'ASC' | 'DESC';
      rating?: 'great' | 'ok' | 'all' | 'not-good';
    }
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      ...this.buildReportQueryParams(input),
      user: input.user,
    };
    if (typeof input.officeHours === 'boolean') params.officeHours = String(input.officeHours);
    if (input.viewBy) params.viewBy = input.viewBy;
    if (input.status) params.status = input.status;
    if (input.page) params.page = input.page;
    if (input.rows) params.rows = input.rows;
    if (input.sortField) params.sortField = input.sortField;
    if (input.sortOrder) params.sortOrder = input.sortOrder;
    if (input.rating) params.rating = input.rating;
    return params;
  }

  private buildReportQueryParamsWithExtras(
    input: Record<string, unknown>,
    extraKeys: readonly string[] = []
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      start: this.normalizeApiDateParam(String(input.start)) ?? String(input.start),
      end: this.normalizeApiDateParam(String(input.end)) ?? String(input.end),
    };

    const addValue = (key: string): void => {
      const value = input[key];
      if (value === undefined) return;
      if (Array.isArray(value)) {
        params[key] = value.join(',');
        return;
      }
      if (typeof value === 'boolean') {
        params[key] = String(value);
        return;
      }
      if (typeof value === 'string') {
        params[key] = this.normalizeApiDateParam(value) ?? value;
        return;
      }
      if (typeof value === 'number') {
        params[key] = value;
      }
    };

    for (const key of [
      'previousStart',
      'previousEnd',
      'mailboxes',
      'tags',
      'types',
      'folders',
      'sites',
      ...extraKeys,
    ]) {
      addValue(key);
    }

    return params;
  }

  /**
   * Deprecated compatibility no-op. Pass __userQuery in tool arguments instead.
   */
  setUserContext(_userQuery: string): void {
    // Request-scoped context is carried by __userQuery to avoid shared mutable state.
  }

  private getToolCallUserQuery(args: Record<string, unknown>): string | undefined {
    const userQuery = args.__userQuery;
    return typeof userQuery === 'string' && userQuery.trim() ? userQuery : undefined;
  }

  private buildV3ApiUrl(path: string): string {
    const normalizedPath = path.replace(/^\/+/, '');
    const v3BaseUrl = config.helpscout.baseUrl.replace(/\/v2\/?$/, '/v3/');
    if (v3BaseUrl === config.helpscout.baseUrl) {
      logger.warn('v3 URL construction: baseUrl did not match /v2/ pattern, URL may be incorrect', {
        baseUrl: config.helpscout.baseUrl,
        path,
      });
    }
    return new URL(normalizedPath, v3BaseUrl).toString();
  }

  private redactThreadBody(thread: unknown): unknown {
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return thread;
    const threadRecord = { ...(thread as Record<string, unknown>) };
    threadRecord.body = config.security.redactMessageContent ? REDACTED_MESSAGE_BODY : threadRecord.body;
    return threadRecord;
  }

  private redactConversationMessageContent(conversation: Record<string, unknown>): Record<string, unknown> {
    if (!config.security.redactMessageContent) return conversation;

    const processedConversation: Record<string, unknown> = { ...conversation };
    if (typeof processedConversation.preview === 'string') {
      processedConversation.preview = REDACTED_MESSAGE_BODY;
    }

    const embedded = processedConversation._embedded;
    if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
      const embeddedRecord = embedded as Record<string, unknown>;
      const threads = embeddedRecord.threads;
      if (Array.isArray(threads)) {
        processedConversation._embedded = {
          ...embeddedRecord,
          threads: threads.map((thread) => this.redactThreadBody(thread)),
        };
      }
    }

    return processedConversation;
  }

  // Apply the optional message-content trim to a list of conversations. List and
  // search endpoints return a `preview` snippet of the latest message body, so
  // when REDACT_MESSAGE_CONTENT is on these results must be trimmed too,
  // consistent with the single-conversation detail tools. No-op when off.
  private redactConversationListContent<T>(conversations: T[]): T[] {
    if (!config.security.redactMessageContent) return conversations;
    return conversations.map(
      (conversation) =>
        this.redactConversationMessageContent(conversation as Record<string, unknown>) as unknown as T,
    );
  }

  private getResponseHeader(headers: Record<string, unknown>, name: string): string | undefined {
    const value = headers[name.toLowerCase()] ?? headers[name];
    if (Array.isArray(value)) return value.join(', ');
    return typeof value === 'string' ? value : undefined;
  }

  private parseContentDispositionFilename(contentDisposition?: string): string | undefined {
    if (!contentDisposition) return undefined;
    const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (filenameStarMatch?.[1]) {
      const encodedFilename = filenameStarMatch[1].trim().replace(/^"|"$/g, '');
      try {
        return decodeURIComponent(encodedFilename);
      } catch {
        return encodedFilename;
      }
    }

    const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    return filenameMatch?.[1]?.trim();
  }

  private responseDataToBuffer(data: unknown): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    return Buffer.from(JSON.stringify(data), 'utf8');
  }

  /**
   * Build the full raw (un-sanitized, un-annotated) catalog of all Help Scout
   * tool definitions. This is the single source of truth for the registry;
   * `allToolDefs()` sanitizes + annotates it, and the discovery meta-tools
   * (search_tools / get_tool_schema / call_tool) all read from it.
   */
  private buildToolDefs(): Tool[] {
    const tools: Tool[] = [
      {
        name: 'searchConversations',
        description: 'Search and list conversations. Filter by status, date range, inbox, or tags, and search content with contentTerms/subjectTerms, email/emailDomain, customerIds, assignedTo, folderId, or conversationNumber. Searches all statuses by default.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Raw HelpScout query syntax (power users). The convenience filters below are compiled into this automatically. Example: (body:"keyword")',
            },
            contentTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Match these terms in the message body (compiled to body:"term")',
            },
            subjectTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Match these terms in the subject (compiled to subject:"term")',
            },
            email: {
              type: 'string',
              description: 'Match conversations involving this email (to/cc/bcc or customer)',
            },
            emailDomain: {
              type: 'string',
              description: 'Match conversations involving any email at this domain',
            },
            customerIds: {
              type: 'array',
              items: { type: 'integer', minimum: 0 },
              description: 'Conversations belonging to these customer IDs (the customer->conversations bridge)',
            },
            hasAttachments: {
              type: 'boolean',
              description: 'Only conversations that have attachments',
            },
            inboxId: {
              type: 'string',
              description: 'Inbox (mailbox) ID from server instructions',
            },
            folderId: {
              type: 'integer',
              minimum: 0,
              description: 'Filter by folder ID',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name (comma-separated for multiple)',
            },
            assignedTo: {
              type: 'integer',
              minimum: -1,
              description: 'Filter by assignee user ID (-1 for unassigned)',
            },
            conversationNumber: {
              type: 'integer',
              minimum: 1,
              description: 'Look up by conversation number',
            },
            status: {
              type: 'string',
              enum: ['active', 'pending', 'closed', 'open', 'spam', 'all'],
              description: 'Filter by status. Omit to search active+pending+closed (excludes spam).',
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
            modifiedSince: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations modified after this timestamp (ISO8601)',
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of results (1-200)',
              minimum: 1,
              maximum: 200,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            page: {
              type: 'integer',
              minimum: 1,
              default: 1,
              description: 'Page number',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'modifiedAt', 'number', 'waitingSince', 'customerName', 'customerEmail', 'mailboxid', 'status', 'subject', 'score'],
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
        name: 'getConversation',
        description: 'Get the raw Help Scout conversation object by ID. Optionally embeds threads for direct API parity; use getThreads when full thread pagination is needed. Set includeSystemActors to distinguish user, team, and system_user person types.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to retrieve',
            },
            embed: {
              type: 'string',
              enum: ['threads'],
              description: 'Optional sub-entity to embed. Help Scout currently supports "threads".',
            },
            includeSystemActors: {
              type: 'boolean',
              default: false,
              description: 'When true, routes to the v3 conversation endpoint, which preserves the user, team, and system_user person types (v2 collapses system_user into user).',
            },
          },
          required: ['conversationId'],
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
        description: 'Retrieve full message history for a conversation. Returns all thread messages. Set includeSystemActors to distinguish user, team, and system_user person types.',
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
            page: {
              type: 'number',
              minimum: 1,
              default: 1,
              description: 'Page number',
            },
            includeSystemActors: {
              type: 'boolean',
              default: false,
              description: 'When true, routes to the v3 threads endpoint, which preserves the user, team, and system_user person types (v2 collapses system_user into user).',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getServerTime',
        description: 'Get the current MCP host timestamp. Use before date-relative searches to calculate time ranges.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listAllInboxes',
        description: 'List all inboxes with IDs. Pass nameContains to filter by a case-insensitive name substring. Deprecated: inbox IDs now in server instructions. Only needed mid-session.',
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
            nameContains: {
              type: 'string',
              description: 'Case-insensitive substring filter applied to inbox names after all pages are fetched. Omit to list every inbox.',
            },
          },
        },
      },
      {
        name: 'getInbox',
        description: 'Get one Help Scout inbox by ID, including inbox email and resource links. Pass include to fan out and attach sub-resources in one call: "fields" (customFields with dropdown option IDs), "folders" (folder IDs and counts), and "routing" (rotation users and eligibility state). Each sub-resource is fetched from its own endpoint; a failure of one is reported under includeErrors without failing the whole call.',
        inputSchema: {
          type: 'object',
          properties: {
            inboxId: {
              type: 'string',
              description: 'Inbox ID from listAllInboxes or server instructions',
            },
            include: {
              type: 'array',
              items: { type: 'string', enum: ['fields', 'folders', 'routing'] },
              description: 'Sub-resources to fetch and attach: "fields" -> customFields, "folders" -> folders, "routing" -> routing. Omit for just the inbox.',
            },
          },
          required: ['inboxId'],
        },
      },
      // Customer tools (NAS-680, NAS-727, NAS-728)
      {
        name: 'getCustomer',
        description: 'Get a customer profile by ID. Returns profile with contact details (emails, phones, chat handles, social profiles, websites) plus address from a separate lookup.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: {
              type: 'string',
              description: 'Customer ID',
            },
          },
          required: ['customerId'],
        },
      },
      {
        name: 'listCustomers',
        description: 'List or search customers by name, query syntax, or dates. Defaults to v2 page-based pagination. Set useV3 (or pass a cursor) to use the v3 Customers API with cursor pagination, which also enables the email and createdSince filters.',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: { type: 'string', description: 'Filter by first name' },
            lastName: { type: 'string', description: 'Filter by last name' },
            query: { type: 'string', description: 'Advanced query syntax, e.g. (email:"john@example.com")' },
            mailbox: { type: 'number', description: 'Filter by inbox ID (v2 page path only)' },
            modifiedSince: { type: 'string', description: 'ISO 8601 date - only customers modified after this date' },
            sortField: { type: 'string', enum: ['createdAt', 'firstName', 'lastName', 'modifiedAt'], default: 'createdAt', description: 'Sort field (v2 page path only)' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: 'Sort order (v2 page path only)' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number for the default v2 page-based pagination (API returns 50 results per page)' },
            useV3: { type: 'boolean', default: false, description: 'Route to the v3 Customers endpoint (cursor-based pagination). Implied when a cursor is supplied.' },
            cursor: { type: 'string', description: 'Cursor for v3 pagination (from nextCursor in a previous v3 response). Supplying this forces the v3 path.' },
            email: { type: 'string', description: 'Filter by email address. v3 path only (requires useV3 or cursor).' },
            createdSince: { type: 'string', description: 'ISO 8601 date - only customers created after this date. v3 path only (requires useV3 or cursor).' },
          },
        },
      },
      {
        name: 'searchCustomersByEmail',
        description: 'Search customers by email address using the v3 API. Provides email as a dedicated filter parameter (vs query syntax in v2) and cursor-based pagination.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Email address to search for' },
            firstName: { type: 'string', description: 'Filter by first name' },
            lastName: { type: 'string', description: 'Filter by last name' },
            query: { type: 'string', description: 'Advanced query syntax' },
            modifiedSince: { type: 'string', description: 'ISO 8601 date' },
            createdSince: { type: 'string', description: 'ISO 8601 date - only in v3' },
            cursor: { type: 'string', description: 'Cursor for pagination (from nextCursor in previous response)' },
          },
          required: ['email'],
        },
      },
      // NAS-727: Customer sub-resource tools
      {
        name: 'getCustomerContacts',
        description: 'Get all contact details for a customer: emails, phones, chat handles, social profiles, websites, and address. Calls dedicated sub-resource endpoints for complete data. Use after getCustomer or listCustomers.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: {
              type: 'string',
              description: 'Customer ID',
            },
          },
          required: ['customerId'],
        },
      },
      // Organization tools (NAS-684, NAS-712)
      {
        name: 'getOrganization',
        description: 'Get an organization by ID with optional customer/conversation counts.',
        inputSchema: {
          type: 'object',
          properties: {
            organizationId: { type: 'string', description: 'Organization ID' },
            includeCounts: { type: 'boolean', default: true, description: 'Include customerCount and conversationCount' },
            includeProperties: { type: 'boolean', default: false, description: 'Include organization property values' },
          },
          required: ['organizationId'],
        },
      },
      {
        name: 'listOrganizations',
        description: 'List all organizations with sorting options. Use for discovering organizations before drilling into members or conversations. Returns 50 per page.',
        inputSchema: {
          type: 'object',
          properties: {
            sortField: { type: 'string', enum: ['name', 'customerCount', 'conversationCount', 'lastInteractionAt'], default: 'lastInteractionAt' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (50 results per page)' },
          },
        },
      },
      {
        name: 'getOrganizationMembers',
        description: 'Get all customers belonging to an organization. Use after getOrganization to see who is in the org. Returns 50 per page.',
        inputSchema: {
          type: 'object',
          properties: {
            organizationId: { type: 'string', description: 'Organization ID' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (50 results per page)' },
          },
          required: ['organizationId'],
        },
      },
      {
        name: 'getOrganizationConversations',
        description: 'Get all conversations associated with an organization. Traverses org-to-conversations without needing individual customer lookups. Returns 50 per page.',
        inputSchema: {
          type: 'object',
          properties: {
            organizationId: { type: 'string', description: 'Organization ID' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (50 results per page)' },
          },
          required: ['organizationId'],
        },
      },
      {
        name: 'listCustomerProperties',
        description: 'List customer property definitions. Use to interpret custom property values embedded on customer records.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listOrganizationProperties',
        description: 'List organization property definitions. Use to interpret custom company property values embedded on organizations.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'getOrganizationProperty',
        description: 'Get one organization property definition by slug. Use after listOrganizationProperties when exact option labels are needed.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Organization property slug from listOrganizationProperties' },
          },
          required: ['slug'],
        },
      },
      {
        name: 'listTags',
        description: 'List Help Scout tags used across inboxes. Use to discover tag IDs and exact names before filtering conversations or reports.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional case-insensitive client-side tag name filter' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'getTag',
        description: 'Get a Help Scout tag by ID. Use after listTags when an exact tag record is needed.',
        inputSchema: {
          type: 'object',
          properties: {
            tagId: { type: 'string', description: 'Tag ID from listTags' },
          },
          required: ['tagId'],
        },
      },
      {
        name: 'listUsers',
        description: 'List Help Scout users with optional exact email or inbox filter. Use to discover assignee IDs, mentions, and roles. Set includeStatuses to attach all user availability statuses; set includeSystemActors to list v3 system users (AI agents, integrations) instead.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Exact user email filter' },
            inboxId: { type: 'string', description: 'Inbox ID to find users with access to that inbox' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
            includeStatuses: {
              type: 'boolean',
              default: false,
              description: 'When true, additionally calls /users/status once and attaches all user email/chat availability statuses under "statuses" (not fanned out per user).',
            },
            includeSystemActors: {
              type: 'boolean',
              default: false,
              description: 'When true, routes to the v3 /system-users endpoint, returning system actors (AI agents, integration users) instead of standard users. Emits apiVersion: "v3". Ignores includeStatuses.',
            },
          },
        },
      },
      {
        name: 'getUser',
        description: 'Get a Help Scout user by ID, or pass "me" to get the authenticated resource owner. Set includeStatus to attach the user availability status; set includeSystemActors to fetch the v3 system-user record instead.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'User ID from listUsers, or "me" for the authenticated resource owner' },
            includeStatus: {
              type: 'boolean',
              default: false,
              description: 'When true, also fetches /users/{id}/status and attaches the email/chat availability status under "status". Ignored when includeSystemActors is true.',
            },
            includeSystemActors: {
              type: 'boolean',
              default: false,
              description: 'When true, routes to the v3 /system-users/{id} endpoint, returning the system actor record instead of a standard user. Emits apiVersion: "v3". Takes precedence over includeStatus.',
            },
          },
          required: ['userId'],
        },
      },
      {
        name: 'listTeams',
        description: 'List Help Scout teams. Use to discover team IDs before team-member lookup or team-scoped reporting.',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'getTeamMembers',
        description: 'List members of a Help Scout team. Use after listTeams to discover user IDs in a team.',
        inputSchema: {
          type: 'object',
          properties: {
            teamId: { type: 'string', description: 'Team ID from listTeams' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
          required: ['teamId'],
        },
      },
      {
        name: 'listSavedReplies',
        description: 'List saved replies for a Help Scout inbox. Use to discover saved reply IDs and inspect reusable response templates.',
        inputSchema: {
          type: 'object',
          properties: {
            inboxId: { type: 'string', description: 'Inbox ID from listAllInboxes or server instructions' },
            includeChatReplies: { type: 'boolean', default: false, description: 'Include chat-only saved replies in the response' },
          },
          required: ['inboxId'],
        },
      },
      {
        name: 'getSavedReply',
        description: 'Get one saved reply from a Help Scout inbox by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            inboxId: { type: 'string', description: 'Inbox ID from listAllInboxes or server instructions' },
            replyId: { type: 'string', description: 'Saved reply ID from listSavedReplies' },
          },
          required: ['inboxId', 'replyId'],
        },
      },
      {
        name: 'getOriginalSource',
        description: 'Get the original source for a Help Scout conversation thread. Set format to "rfc822" for raw email source, or "json" (default) for parsed source.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Conversation ID from searchConversations or getConversationSummary' },
            threadId: { type: 'string', description: 'Thread ID from getThreads' },
            format: { type: 'string', enum: ['json', 'rfc822'], default: 'json', description: "Source format: 'json' (parsed) or 'rfc822' (raw email source)" },
          },
          required: ['conversationId', 'threadId'],
        },
      },
      {
        name: 'getAttachment',
        description: 'Get base64-encoded Help Scout attachment data by conversation and attachment ID.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Conversation ID from searchConversations or getConversationSummary' },
            attachmentId: { type: 'string', description: 'Attachment ID from getThreads attachment links' },
          },
          required: ['conversationId', 'attachmentId'],
        },
      },
      {
        name: 'downloadAttachmentFile',
        description: 'Download a Help Scout attachment file as base64 with response metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Conversation ID from searchConversations or getConversationSummary' },
            attachmentId: { type: 'string', description: 'Attachment ID from getThreads attachment links' },
          },
          required: ['conversationId', 'attachmentId'],
        },
      },
      {
        name: 'listWorkflows',
        description: 'List Help Scout workflows. Use to inspect account workflow configuration and discover workflow IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'listWebhooks',
        description: 'List Help Scout webhooks. Use to inspect webhook configuration and discover webhook IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'getWebhook',
        description: 'Get a Help Scout webhook by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            webhookId: { type: 'string', description: 'Webhook ID from listWebhooks' },
          },
          required: ['webhookId'],
        },
      },
      {
        name: 'getSatisfactionRating',
        description: 'Get a Help Scout satisfaction rating by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            ratingId: { type: 'string', description: 'Satisfaction rating ID' },
          },
          required: ['ratingId'],
        },
      },
      {
        name: 'getCompanyReport',
        description: 'Get a Help Scout company report for a bounded time range. report=overall (/reports/company), customers-helped (/reports/company/customers-helped), or drilldown (/reports/company/drilldown).',
        inputSchema: {
          type: 'object',
          properties: {
            report: { type: 'string', enum: ['overall', 'customers-helped', 'drilldown'], default: 'overall', description: 'Which company report to fetch' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601 (overall, customers-helped)' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601 (overall, customers-helped)' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], description: 'Report granularity (customers-helped only)' },
            page: { type: 'number', minimum: 1, description: 'Drilldown page number (drilldown only)' },
            rows: { type: 'number', minimum: 1, maximum: 50, description: 'Drilldown rows per page, max 50 (drilldown only)' },
            range: { type: 'string', enum: ['replies', 'firstReplyResolved', 'resolved', 'responseTime', 'firstResponseTime', 'handleTime'], description: 'Drilldown range filter (required for drilldown)' },
            rangeId: { type: 'number', minimum: 1, maximum: 10, description: 'Drilldown range bucket ID (drilldown only)' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getConversationsReport',
        description: 'Get a Help Scout conversations report for a bounded time range. report selects /reports/conversations[/<report>]: overall, volume-by-channel, busy-times, drilldown, fields-drilldown, new, new-drilldown, received-messages.',
        inputSchema: {
          type: 'object',
          properties: {
            report: { type: 'string', enum: ['overall', 'volume-by-channel', 'busy-times', 'drilldown', 'fields-drilldown', 'new', 'new-drilldown', 'received-messages'], default: 'overall', description: 'Which conversations report to fetch' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601 (non-drilldown reports)' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601 (non-drilldown reports)' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], description: 'Report granularity (volume-by-channel, new, received-messages)' },
            page: { type: 'number', minimum: 1, description: 'Drilldown page number (drilldown reports)' },
            rows: { type: 'number', minimum: 1, maximum: 50, description: 'Drilldown rows per page, max 50 (drilldown reports)' },
            field: { type: 'string', enum: ['tagid', 'replyid', 'workflowid', 'customerid'], description: 'Field to drill into (required for fields-drilldown)' },
            fieldid: { type: 'string', description: 'Field value identifier (required for fields-drilldown)' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getProductivityReport',
        description: 'Get a Help Scout productivity report for a bounded time range. report selects /reports/productivity[/<report>]: overall, first-response-time, replies-sent, resolved, response-time, resolution-time.',
        inputSchema: {
          type: 'object',
          properties: {
            report: { type: 'string', enum: ['overall', 'first-response-time', 'replies-sent', 'resolved', 'response-time', 'resolution-time'], default: 'overall', description: 'Which productivity report to fetch' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], description: 'Report granularity (timeline reports only)' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getUserReport',
        description: 'Get a Help Scout user or team report for a bounded time range. report selects /reports/user[/<report>]: overall, conversation-history, customers-helped, drilldown, happiness, ratings, replies, resolutions, chat.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'number', description: 'User ID or team ID for the report' },
            report: { type: 'string', enum: ['overall', 'conversation-history', 'customers-helped', 'drilldown', 'happiness', 'ratings', 'replies', 'resolutions', 'chat'], default: 'overall', description: 'Which user report to fetch' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration (overall, conversation-history, chat)' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], description: 'Report granularity (customers-helped, replies, resolutions)' },
            status: { type: 'string', enum: ['active', 'pending', 'closed'], description: 'Conversation status filter (conversation-history only)' },
            page: { type: 'number', minimum: 1, description: 'Page number (drilldown, ratings, conversation-history)' },
            rows: { type: 'number', minimum: 1, maximum: 50, description: 'Rows per page, max 50 (drilldown only)' },
            sortField: { type: 'string', description: 'Sort field (conversation-history, ratings)' },
            sortOrder: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'], description: 'Sort order (conversation-history, ratings)' },
            rating: { type: 'string', enum: ['great', 'ok', 'all', 'not-good'], description: 'Rating filter (ratings only)' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getHappinessReport',
        description: 'Get a Help Scout happiness report for a bounded time range. report=overall (/reports/happiness) or ratings (/reports/happiness/ratings).',
        inputSchema: {
          type: 'object',
          properties: {
            report: { type: 'string', enum: ['overall', 'ratings'], default: 'overall', description: 'Which happiness report to fetch' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601 (overall only)' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601 (overall only)' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            page: { type: 'number', minimum: 1, description: 'Page number (ratings only)' },
            sortField: { type: 'string', enum: ['number', 'modifiedAt', 'rating'], description: 'Sort field (ratings only)' },
            sortOrder: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'], description: 'Sort order (ratings only)' },
            rating: { type: 'string', enum: ['great', 'ok', 'all', 'not-good'], description: 'Rating filter (ratings only)' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getChannelReport',
        description: 'Get a Help Scout channel report for a bounded time range. channel selects /reports/chat, /reports/email, or /reports/phone.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', enum: ['chat', 'email', 'phone'], description: 'Which channel report to fetch' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
          },
          required: ['channel', 'start', 'end'],
        },
      },
      {
        name: 'getDocsReport',
        description: 'Get the Help Scout Docs overall report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            sites: { type: 'array', items: { type: 'string' }, description: 'Docs site IDs to filter by' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'listDocsSites',
        description: 'List Help Scout Docs sites using the Docs API v1.',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'getDocsSite',
        description: 'Get one Help Scout Docs site by ID. Set includeRestrictions to also attach the restricted-site settings (secrets redacted).',
        inputSchema: {
          type: 'object',
          properties: {
            siteId: { type: 'string', description: 'Docs site ID' },
            includeRestrictions: {
              type: 'boolean',
              default: false,
              description: 'When true, also fetches the restricted-site settings (/sites/{id}/restricted) and attaches them under "restrictions" with shared secrets redacted.',
            },
          },
          required: ['siteId'],
        },
      },
      {
        name: 'listDocsCollections',
        description: 'List Help Scout Docs collections, optionally scoped to a site.',
        inputSchema: {
          type: 'object',
          properties: {
            siteId: { type: 'string', description: 'Optional Docs site ID' },
            visibility: { type: 'string', enum: ['all', 'public', 'private'], default: 'all' },
            sort: { type: 'string', enum: ['number', 'visibility', 'order', 'name', 'createdAt', 'updatedAt'], default: 'order' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'getDocsCollection',
        description: 'Get one Help Scout Docs collection by ID or number.',
        inputSchema: {
          type: 'object',
          properties: {
            collectionId: { type: 'string', description: 'Docs collection ID or number' },
          },
          required: ['collectionId'],
        },
      },
      {
        name: 'listDocsCategories',
        description: 'List Help Scout Docs categories for a collection.',
        inputSchema: {
          type: 'object',
          properties: {
            collectionId: { type: 'string', description: 'Docs collection ID' },
            sort: { type: 'string', enum: ['number', 'order', 'name', 'articleCount', 'createdAt', 'updatedAt'], default: 'order' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
          required: ['collectionId'],
        },
      },
      {
        name: 'getDocsCategory',
        description: 'Get one Help Scout Docs category by ID or number.',
        inputSchema: {
          type: 'object',
          properties: {
            categoryId: { type: 'string', description: 'Docs category ID or number' },
          },
          required: ['categoryId'],
        },
      },
      {
        name: 'listDocsArticles',
        description: 'List Help Scout Docs articles for a collection or category.',
        inputSchema: {
          type: 'object',
          properties: {
            collectionId: { type: 'string', description: 'Docs collection ID. Provide this or categoryId.' },
            categoryId: { type: 'string', description: 'Docs category ID. Provide this or collectionId.' },
            status: { type: 'string', enum: ['all', 'published', 'notpublished'], default: 'all' },
            sort: { type: 'string', enum: ['order', 'number', 'status', 'name', 'popularity', 'createdAt', 'updatedAt'], default: 'order' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            pageSize: { type: 'number', minimum: 1, maximum: 100, default: 50 },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'searchDocsArticles',
        description: 'Search Help Scout Docs articles by query, site, collection, status, or visibility.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            collectionId: { type: 'string', description: 'Optional Docs collection ID' },
            siteId: { type: 'string', description: 'Optional Docs site ID' },
            status: { type: 'string', enum: ['all', 'published', 'notpublished'], default: 'all' },
            visibility: { type: 'string', enum: ['all', 'public', 'private'], default: 'all' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'getDocsArticle',
        description: 'Get one Help Scout Docs article by ID or number.',
        inputSchema: {
          type: 'object',
          properties: {
            articleId: { type: 'string', description: 'Docs article ID or number' },
            draft: { type: 'boolean', default: false, description: 'Return draft content when unpublished changes exist' },
          },
          required: ['articleId'],
        },
      },
      {
        name: 'listDocsRelatedArticles',
        description: 'List Help Scout Docs articles related to an article.',
        inputSchema: {
          type: 'object',
          properties: {
            articleId: { type: 'string', description: 'Docs article ID' },
            status: { type: 'string', enum: ['all', 'published', 'notpublished'], default: 'all' },
            sort: { type: 'string', enum: ['order', 'number', 'status', 'name', 'popularity', 'createdAt', 'updatedAt'], default: 'order' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
          required: ['articleId'],
        },
      },
      {
        name: 'listDocsArticleRevisions',
        description: 'List Help Scout Docs article revisions.',
        inputSchema: {
          type: 'object',
          properties: {
            articleId: { type: 'string', description: 'Docs article ID' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
          required: ['articleId'],
        },
      },
      {
        name: 'getDocsArticleRevision',
        description: 'Get one Help Scout Docs article revision by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            revisionId: { type: 'string', description: 'Docs article revision ID' },
          },
          required: ['revisionId'],
        },
      },
      {
        name: 'listDocsRedirects',
        description: 'List Help Scout Docs redirects for a site.',
        inputSchema: {
          type: 'object',
          properties: {
            siteId: { type: 'string', description: 'Docs site ID' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
          required: ['siteId'],
        },
      },
      {
        name: 'getDocsRedirect',
        description: 'Get one Help Scout Docs redirect by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            redirectId: { type: 'string', description: 'Docs redirect ID' },
          },
          required: ['redirectId'],
        },
      },
      {
        name: 'findDocsRedirect',
        description: 'Resolve a Help Scout Docs redirect target from a site ID and URL path.',
        inputSchema: {
          type: 'object',
          properties: {
            siteId: { type: 'string', description: 'Docs site ID' },
            url: { type: 'string', description: 'URL path to redirect from, e.g. /old/path' },
          },
          required: ['siteId', 'url'],
        },
      },
    ];

    return tools;
  }

  /**
   * The full internal registry: every Help Scout tool, sanitized + annotated,
   * exactly as the flat surface used to advertise it. This is what
   * `search_tools`, `get_tool_schema`, `call_tool`, and the EXPOSE_ALL escape
   * hatch all read from. Rebuilt each call (no cache → no drift).
   *
   * Every tool in this server is a read-only GET wrapper over the external
   * Help Scout API. We advertise MCP tool annotations so clients (e.g. Claude
   * CoWork) can auto-approve reads and skip "may modify data" confirmations.
   * openWorldHint is true because results depend on an external service.
   * A tool may still override by declaring its own `annotations`.
   *
   * Every inputSchema is run through sanitizeJsonSchema so it loads across
   * Gemini / OpenAI / GLM / Claude (NAS-1307): strips object-level
   * anyOf/oneOf/allOf, adds additionalProperties:false to object nodes, and
   * converts number -> integer.
   */
  private allToolDefs(): Tool[] {
    return this.buildToolDefs().map((tool) => ({
      annotations: { readOnlyHint: true, openWorldHint: true },
      ...tool,
      inputSchema: sanitizeJsonSchema(tool.inputSchema) as Tool['inputSchema'],
    }));
  }

  /**
   * Build the three discovery meta-tool definitions. Their schemas are run
   * through the same sanitizer so they load across model families. The
   * search_tools description carries the live total tool count so the model
   * knows the full catalog exists behind the meta layer.
   */
  private metaToolDefs(totalToolCount: number): Tool[] {
    const defs: Tool[] = [
      {
        name: 'search_tools',
        description:
          `This server exposes ${totalToolCount} Help Scout tools, but only the core few are loaded by default. ` +
          `Search the rest by keyword (e.g. 'report', 'attachment', 'tags', 'webhook') to get their names and ` +
          `descriptions, then call get_tool_schema to load one and call_tool to invoke it.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                "Keywords describing the capability you need (e.g. 'happiness report', 'mailbox folders', 'webhook'). Help Scout synonyms (mailbox=inbox, ticket=conversation, contact=customer) are expanded automatically.",
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_tool_schema',
        description:
          'Return the full input schema for one or more tool names (from search_tools or a suggestedTools hint) so you can call them via call_tool.',
        inputSchema: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'One or more exact tool names to load schemas for.',
            },
          },
          required: ['names'],
        },
      },
      {
        name: 'call_tool',
        description:
          'Invoke any Help Scout tool by name with its arguments (after loading its schema via get_tool_schema).',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The exact name of the Help Scout tool to invoke.',
            },
            arguments: {
              type: 'object',
              description: "The tool's input arguments object, matching its loaded input schema.",
            },
          },
          required: ['name', 'arguments'],
        },
      },
    ];
    return defs.map((tool) => ({
      annotations: { readOnlyHint: true, openWorldHint: true },
      ...tool,
      inputSchema: sanitizeJsonSchema(tool.inputSchema) as Tool['inputSchema'],
    }));
  }

  /**
   * The advertised `tools/list` surface (NAS-1305 discovery layer).
   *
   * DEFAULT (opinionated, no mode flag): the 7 core read tools + the 3 meta
   * tools (search_tools / get_tool_schema / call_tool). All ~55 tools stay
   * reachable through the meta layer. This keeps the always-on tool-definition
   * footprint tiny (~10 tools) so the server loads cheaply across model families.
   *
   * ESCAPE HATCH: `HELPSCOUT_EXPOSE_ALL_TOOLS=true` returns the full sanitized
   * flat catalog (every tool, no meta tools) for clients that explicitly want
   * everything flat. This is the ONLY branch — a single conditional.
   */
  async listTools(): Promise<Tool[]> {
    const all = this.allToolDefs();

    if (process.env.HELPSCOUT_EXPOSE_ALL_TOOLS === 'true') {
      return all;
    }

    const byName = new Map(all.map((tool) => [tool.name, tool]));
    const core = ToolHandler.CORE_TOOLS.map((name) => byName.get(name)).filter(
      (tool): tool is Tool => tool !== undefined,
    );

    return [...core, ...this.metaToolDefs(all.length)];
  }

  /**
   * Best-effort JSON-string argument coercion (NAS-1307). Looks the tool's
   * sanitized inputSchema up from the same registry listTools() advertises and
   * coerces stringified arrays/objects to native. Defensive: never throws; on
   * any failure (or unknown tool) the original arguments are returned unchanged.
   */
  private async coerceArgumentsForTool(
    toolName: string,
    args: CallToolRequest['params']['arguments'],
  ): Promise<CallToolRequest['params']['arguments']> {
    try {
      // Resolve against the FULL registry (+ meta-tools), not the trimmed
      // discovery surface — tail tools must still coerce when invoked directly.
      const all = this.allToolDefs();
      const tools = [...all, ...this.metaToolDefs(all.length)];
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (!tool?.inputSchema) {
        return args;
      }
      return coerceJsonStringArgs(args, tool.inputSchema) as CallToolRequest['params']['arguments'];
    } catch {
      return args;
    }
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    logger.info('Tool call started', {
      requestId,
      toolName: request.params.name,
      argumentKeys: Object.keys(request.params.arguments || {}).filter(key => key !== '__userQuery'),
    });

    // NAS-1307: weaker / non-Claude models stringify complex args (`"[1,2]"`
    // instead of `[1,2]`). Coerce stringified-JSON arrays/objects back to native
    // against the tool's sanitized inputSchema before validation/parsing. This
    // is best-effort and never throws; on any failure args are left untouched.
    request.params.arguments = await this.coerceArgumentsForTool(
      request.params.name,
      request.params.arguments,
    );

    const args = request.params.arguments || {};
    const userQuery = this.getToolCallUserQuery(args);

    // REVERSE LOGIC VALIDATION: Check API constraints before making the call
    const validationContext: ToolCallContext = {
      toolName: request.params.name,
      arguments: args,
      userQuery,
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
      
      // Return helpful error with API constraint guidance (NAS-472: isError per MCP spec)
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
        }],
        isError: true,
      };
    }

    try {
      const result = await this.dispatchTool(
        request.params.name,
        request.params.arguments || {},
      );

      const duration = Date.now() - startTime;
      // Add to call history for future validation
      this.callHistory.push(request.params.name);

      const firstContent = result.content?.[0];
      if (!firstContent || firstContent.type !== 'text' || typeof firstContent.text !== 'string') {
        return createMcpToolError(
          new Error('Tool returned an invalid MCP response: missing text content'),
          {
            toolName: request.params.name,
            requestId,
            duration,
          }
        );
      }
      
      // Unified content-aware response guidance (NAS-1308): a single producer
      // sets both the result body's apiGuidance and _meta.suggestedTools, driven
      // by the actual result shape. Best-effort: never turns a success into a
      // failure. callToolMeta applies this against the real hub name for the
      // call_tool re-entry path, so we skip the meta-tool here to avoid a
      // double-attach (applyResponseGuidance also no-ops on meta-tools).
      const guided = this.applyResponseGuidance(request.params.name, result);

      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
        validationPassed: true,
        guidanceProvided: Boolean(guided._meta?.suggestedTools),
      });

      return guided;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return createMcpToolError(error, {
        toolName: request.params.name,
        requestId,
        duration,
      });
    }
  }

  /**
   * Dispatch a tool by name to its handler. Extracted from callTool so the
   * call_tool meta-tool can re-enter dispatch (NAS-1305). Includes the three
   * discovery meta-tools (search_tools / get_tool_schema / call_tool) alongside
   * the ~55 Help Scout tools. callTool() owns logging, arg coercion, constraint
   * validation, and guidance injection; this method is the pure name → handler
   * switch.
   */
  private async dispatchTool(name: string, args: object): Promise<CallToolResult> {
    return this.dispatchToolInner(name, args);
  }

  /**
   * The unified content-aware response-guidance layer (NAS-1308). Replaces the
   * two prior half-mechanisms — the static `_meta.suggestedTools` successor
   * hints and the 2-tool `generateToolGuidance` next-step text — with a SINGLE
   * producer (`buildResponseGuidance`) driven by what actually happened (was the
   * result empty or populated? what real id can anchor an example?).
   *
   * Mutates the result in place to carry both:
   *   - `_meta.suggestedTools`: sanitized, core/meta-filtered, capped schemas for
   *     the logically-next tools.
   *   - the result body's `apiGuidance` field: next-step text with a real id
   *     interpolated into the example.
   *
   * Gated OFF in HELPSCOUT_EXPOSE_ALL_TOOLS mode (every tool already advertised,
   * so schema hints are redundant). Meta-tool results are never guided. Total:
   * never throws and never turns a success into a failure — on any failure the
   * original result is returned untouched. Keyed on the dispatched tool name, so
   * when call_tool re-enters a hub tool the guidance is attached against the real
   * hub name (callToolMeta invokes this after dispatch).
   */
  private applyResponseGuidance(name: string, result: CallToolResult): CallToolResult {
    try {
      if ((ToolHandler.META_TOOLS as readonly string[]).includes(name)) {
        return result;
      }

      // Parse the primary text payload once (needed for both shape classification
      // and apiGuidance injection). If it isn't JSON text we can still attach the
      // static-fallback schema hints, just with no content-aware text.
      const firstContent = result.content?.[0];
      let parsedBody: unknown;
      if (firstContent && firstContent.type === 'text' && typeof firstContent.text === 'string') {
        try {
          parsedBody = JSON.parse(firstContent.text);
        } catch {
          parsedBody = undefined;
        }
      }

      const guidance = buildResponseGuidance(name, parsedBody, {
        toolDefs: this.allToolDefs(),
        coreTools: ToolHandler.CORE_TOOLS,
        metaTools: ToolHandler.META_TOOLS,
        successorMap: ToolHandler.SUCCESSOR_MAP,
      });

      const exposeAll = process.env.HELPSCOUT_EXPOSE_ALL_TOOLS === 'true';

      // Inject next-step text into the result body (only when we have a parsed
      // JSON body to extend, mirroring the prior apiGuidance behavior).
      if (
        guidance.apiGuidance &&
        guidance.apiGuidance.length > 0 &&
        parsedBody &&
        typeof parsedBody === 'object' &&
        !Array.isArray(parsedBody)
      ) {
        (parsedBody as Record<string, unknown>).apiGuidance = guidance.apiGuidance;
        result.content[0] = {
          type: 'text',
          text: JSON.stringify(parsedBody, null, 2),
        };
      }

      // Attach typed successor schemas (suppressed in expose-all mode).
      if (!exposeAll && guidance.suggestedTools && guidance.suggestedTools.length > 0) {
        result._meta = { ...result._meta, suggestedTools: guidance.suggestedTools };
      }

      return result;
    } catch {
      return result;
    }
  }

  /**
   * The pure name → handler switch. Extracted from dispatchTool so the latter
   * can attach successor hints around it (NAS-1305 phase 3).
   */
  private async dispatchToolInner(name: string, args: object): Promise<CallToolResult> {
    switch (name) {
      // --- Discovery meta-tools (NAS-1305) ---
      case 'search_tools':
        return this.searchTools(args);
      case 'get_tool_schema':
        return this.getToolSchema(args);
      case 'call_tool':
        return this.callToolMeta(args);

      case 'searchConversations':
        return this.searchConversations(args);
      case 'getConversation':
        return this.getConversation(args);
      case 'getConversationSummary':
        return this.getConversationSummary(args);
      case 'getThreads':
        return this.getThreads(args);
      case 'getServerTime':
        return this.getServerTime();
      case 'listAllInboxes':
        return this.listAllInboxes(args);
      case 'getInbox':
        return this.getInbox(args);
      case 'getCustomer':
        return this.getCustomer(args);
      case 'listCustomers':
        return this.listCustomers(args);
      case 'searchCustomersByEmail':
        return this.searchCustomersByEmail(args);
      case 'getCustomerContacts':
        return this.getCustomerContacts(args);
      case 'getOrganization':
        return this.getOrganization(args);
      case 'listOrganizations':
        return this.listOrganizations(args);
      case 'getOrganizationMembers':
        return this.getOrganizationMembers(args);
      case 'getOrganizationConversations':
        return this.getOrganizationConversations(args);
      case 'listCustomerProperties':
        return this.listCustomerProperties(args);
      case 'listOrganizationProperties':
        return this.listOrganizationProperties(args);
      case 'getOrganizationProperty':
        return this.getOrganizationProperty(args);
      case 'listTags':
        return this.listTags(args);
      case 'getTag':
        return this.getTag(args);
      case 'listUsers':
        return this.listUsers(args);
      case 'getUser':
        return this.getUser(args);
      case 'listTeams':
        return this.listTeams(args);
      case 'getTeamMembers':
        return this.getTeamMembers(args);
      case 'listSavedReplies':
        return this.listSavedReplies(args);
      case 'getSavedReply':
        return this.getSavedReply(args);
      case 'getOriginalSource':
        return this.getOriginalSource(args);
      case 'getAttachment':
        return this.getAttachment(args);
      case 'downloadAttachmentFile':
        return this.downloadAttachmentFile(args);
      case 'listWorkflows':
        return this.listWorkflows(args);
      case 'listWebhooks':
        return this.listWebhooks(args);
      case 'getWebhook':
        return this.getWebhook(args);
      case 'getSatisfactionRating':
        return this.getSatisfactionRating(args);
      case 'getCompanyReport':
        return this.getCompanyReport(args);
      case 'getConversationsReport':
        return this.getConversationsReport(args);
      case 'getProductivityReport':
        return this.getProductivityReport(args);
      case 'getUserReport':
        return this.getUserReport(args);
      case 'getHappinessReport':
        return this.getHappinessReport(args);
      case 'getChannelReport':
        return this.getChannelReport(args);
      case 'getDocsReport':
        return this.getDocsReport(args);
      case 'listDocsSites':
        return this.listDocsSites(args);
      case 'getDocsSite':
        return this.getDocsSite(args);
      case 'listDocsCollections':
        return this.listDocsCollections(args);
      case 'getDocsCollection':
        return this.getDocsCollection(args);
      case 'listDocsCategories':
        return this.listDocsCategories(args);
      case 'getDocsCategory':
        return this.getDocsCategory(args);
      case 'listDocsArticles':
        return this.listDocsArticles(args);
      case 'searchDocsArticles':
        return this.searchDocsArticles(args);
      case 'getDocsArticle':
        return this.getDocsArticle(args);
      case 'listDocsRelatedArticles':
        return this.listDocsRelatedArticles(args);
      case 'listDocsArticleRevisions':
        return this.listDocsArticleRevisions(args);
      case 'getDocsArticleRevision':
        return this.getDocsArticleRevision(args);
      case 'listDocsRedirects':
        return this.listDocsRedirects(args);
      case 'getDocsRedirect':
        return this.getDocsRedirect(args);
      case 'findDocsRedirect':
        return this.findDocsRedirect(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Build a plain text-content CallToolResult from a JSON-serializable payload,
   * the standard shape used by every handler in this file.
   */
  private jsonResult(payload: unknown): CallToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  /**
   * search_tools meta handler (NAS-1305). BM25-ish keyword rank over each tool's
   * name + description, expanded with the Help Scout synonym map, with a boost
   * for name matches. Returns the top matches as { name, description } only (no
   * schemas — that is get_tool_schema's job). Core + meta tools are excluded
   * from results because they are already loaded.
   */
  private async searchTools(args: unknown): Promise<CallToolResult> {
    const query = isPlainRecord(args) && typeof args.query === 'string' ? args.query : '';
    const terms = tokenize(query);

    if (terms.length === 0) {
      return this.jsonResult({
        query,
        results: [],
        message: 'Provide one or more keywords to search the Help Scout tool catalog (e.g. "report", "attachment", "tags").',
      });
    }

    // Expand query terms with synonyms so e.g. "mailbox" also matches "inbox".
    const expanded = new Set(terms);
    for (const group of ToolHandler.SYNONYM_GROUPS) {
      if (group.some((word) => expanded.has(word))) {
        for (const word of group) {
          expanded.add(word);
        }
      }
    }

    const excluded = new Set<string>([...ToolHandler.CORE_TOOLS, ...ToolHandler.META_TOOLS]);
    const candidates = this.allToolDefs().filter((tool) => !excluded.has(tool.name));

    const scored = candidates
      .map((tool) => ({ tool, score: scoreTool(tool, terms, expanded) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (scored.length === 0) {
      return this.jsonResult({
        query,
        results: [],
        message: `No tools matched "${query}". Broaden or rephrase your terms (e.g. try "report", "customer", "docs", "inbox").`,
      });
    }

    return this.jsonResult({
      query,
      results: scored.map(({ tool }) => ({ name: tool.name, description: tool.description })),
      next: 'Call get_tool_schema with one of these names to load its input schema, then call_tool to invoke it.',
    });
  }

  /**
   * get_tool_schema meta handler (NAS-1305). Returns the sanitized inputSchema
   * (plus description) for each requested name. Unknown names get an entry
   * flagging them and pointing back at search_tools.
   */
  private async getToolSchema(args: unknown): Promise<CallToolResult> {
    const rawNames = isPlainRecord(args) ? args.names : undefined;
    const names = Array.isArray(rawNames) ? rawNames.filter((n): n is string => typeof n === 'string') : [];

    if (names.length === 0) {
      return this.jsonResult({
        error: 'get_tool_schema requires a non-empty `names` array of tool names.',
        hint: 'Use search_tools to find tool names first.',
      });
    }

    const byName = new Map(this.allToolDefs().map((tool) => [tool.name, tool]));
    const schemas = names.map((name) => {
      const tool = byName.get(name);
      if (!tool) {
        return {
          name,
          unknown: true,
          message: `Unknown tool '${name}'. Use search_tools to find the correct name.`,
        };
      }
      return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
    });

    return this.jsonResult({ schemas });
  }

  /**
   * call_tool meta handler (NAS-1305). Invokes any real Help Scout tool by name
   * with coerced arguments, by re-entering dispatchTool. Rejects meta-tools
   * (recursion guard) and unknown names with an actionable error.
   */
  private async callToolMeta(args: unknown): Promise<CallToolResult> {
    const name = isPlainRecord(args) && typeof args.name === 'string' ? args.name : '';
    const innerArgs =
      isPlainRecord(args) && isPlainRecord(args.arguments) ? args.arguments : {};

    if (!name) {
      return this.jsonResult({
        error: 'call_tool requires a `name` (the tool to invoke) and an `arguments` object.',
        hint: 'Use search_tools to find a tool, then get_tool_schema to load its arguments.',
      });
    }

    // Recursion guard: call_tool must not invoke itself or the other meta-tools.
    if ((ToolHandler.META_TOOLS as readonly string[]).includes(name)) {
      return this.jsonResult({
        error: `call_tool cannot invoke the meta-tool '${name}'. Call search_tools / get_tool_schema / call_tool directly instead.`,
      });
    }

    const tool = this.allToolDefs().find((candidate) => candidate.name === name);
    if (!tool) {
      return this.jsonResult({
        error: `Unknown tool '${name}'. Use search_tools to find it.`,
      });
    }

    const coerced = coerceJsonStringArgs(innerArgs, tool.inputSchema ?? {}) as object;
    const dispatched = await this.dispatchTool(name, coerced);
    // Apply unified response guidance against the REAL hub name so the hint +
    // next-step text ride along (NAS-1308). The outer callTool() guidance pass
    // sees only the `call_tool` meta name and no-ops, leaving this as the single
    // attach for the re-entry path.
    return this.applyResponseGuidance(name, dispatched);
  }


  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);

    const baseParams: Record<string, unknown> = {
      page: input.page,
      sortField: input.sort,
      sortOrder: input.order,
    };

    // Compile the convenience filters into the documented query=() mini-language,
    // then AND them with any raw `query` the caller supplied. This absorbs what
    // the old advanced/comprehensive/structured search tools did, so callers get
    // one tool instead of four.
    const esc = (t: string): string => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const clauses: string[] = [];
    if (input.query) clauses.push(input.query);
    if (input.contentTerms?.length) clauses.push(input.contentTerms.map(t => `body:"${esc(t)}"`).join(' OR '));
    if (input.subjectTerms?.length) clauses.push(input.subjectTerms.map(t => `subject:"${esc(t)}"`).join(' OR '));
    if (input.email) clauses.push(`email:"${esc(input.email)}"`);
    if (input.emailDomain) clauses.push(`email:"${esc(input.emailDomain.replace(/^@/, ''))}"`);
    if (input.customerIds?.length) clauses.push(input.customerIds.map(id => `customerIds:${id}`).join(' OR '));
    if (input.hasAttachments) clauses.push('attachments:true');
    if (input.assignedTo === -1) clauses.push('assigned:"Unassigned"');
    if (clauses.length) {
      baseParams.query = clauses.length === 1 ? clauses[0] : clauses.map(c => `(${c})`).join(' AND ');
    }

    // Documented top-level structured filters.
    if (input.folderId !== undefined) baseParams.folder = input.folderId;
    if (typeof input.assignedTo === 'number' && input.assignedTo >= 0) baseParams.assigned_to = input.assignedTo;
    if (input.conversationNumber !== undefined) baseParams.number = input.conversationNumber;
    if (input.modifiedSince) baseParams.modifiedSince = input.modifiedSince;

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      baseParams.mailbox = effectiveInboxId;
    }

    if (input.tag) baseParams.tag = input.tag;

    const queryWithDate = this.appendCreatedAtFilter(
      baseParams.query as string | undefined,
      input.createdAfter,
      input.createdBefore
    );
    if (queryWithDate) baseParams.query = queryWithDate;

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
      const statusResult = await this.searchConversationStatusSet(
        baseParams,
        DEFAULT_CONVERSATION_STATUSES,
        input.limit || 50,
      );
      conversations = statusResult.conversations;
      searchedStatuses = statusResult.searchedStatuses;
      pagination = statusResult.pagination;
      logger.info('Multi-status search completed', {
        statusesSearched: searchedStatuses,
        failedStatuses: statusResult.pagination.errors,
        totalResults: conversations.length,
        totalAvailable: statusResult.pagination.errors ? 'partial failure' : statusResult.pagination.totalAvailable
      });
    }

    // Apply client-side createdBefore filtering
    // NOTE: Help Scout API doesn't support createdBefore natively, so this filters after fetching
    // Pagination is rebuilt below to distinguish filtered count from API total
    let clientSideFiltered = false;
    const originalPagination = pagination;

    if (input.createdBefore) {
      const filterResult = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'searchConversations');
      conversations = filterResult.filtered;
      clientSideFiltered = filterResult.wasFiltered;

      if (clientSideFiltered) {
        // Rebuild pagination to show both filtered and pre-filter counts
        if (input.status) {
          // Single-status path: originalPagination is Help Scout's page object with totalElements
          pagination = this.buildFilteredPagination(
            conversations.length,
            originalPagination as { totalElements?: number } | undefined,
            true
          );
        } else {
          // Multi-status path: originalPagination has our custom merged structure
          const merged = originalPagination as {
            totalAvailable?: number;
            totalByStatus?: Record<string, number>;
            errors?: Array<{ status: string; message: string; code: string }>;
            note?: string;
          } | null;
          pagination = {
            totalResults: conversations.length,
            totalAvailable: merged?.totalAvailable,
            totalByStatus: merged?.totalByStatus,
            errors: merged?.errors,
            note: `Client-side createdBefore filter applied to merged results. totalResults shows filtered count (${conversations.length}), totalAvailable shows pre-filter total (${merged?.totalAvailable}). ${merged?.note || ''}`
          };
        }
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
      results: this.redactConversationListContent(conversations),
      pagination,
      nextPage: input.status ? getNextPage(originalPagination as { number?: number; totalPages?: number } | undefined) : null,
      searchInfo: {
        query: input.query,
        statusesSearched: searchedStatuses,
        inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
        clientSideFiltering: clientSideFiltered ? 'createdBefore filter applied after API fetch - see pagination.totalResults for filtered count and pagination.totalAvailable for API total' : undefined,
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

  private async getConversation(args: unknown): Promise<CallToolResult> {
    const input = GetConversationInputSchema.parse(args);
    const params = input.embed ? { embed: input.embed } : undefined;

    // includeSystemActors routes to the v3 conversation endpoint, which
    // preserves the user/team/system_user person types (v2 collapses
    // system_user into user).
    const conversation = await helpScoutClient.get<Record<string, unknown>>(
      input.includeSystemActors
        ? this.buildV3ApiUrl(`/conversations/${input.conversationId}`)
        : `/conversations/${input.conversationId}`,
      params
    );

    const processedConversation = this.redactConversationMessageContent(conversation);

    const embedUsage = input.includeSystemActors
      ? 'Embedded threads are included for API parity; use getThreads(includeSystemActors:true) for pagination.'
      : 'Embedded threads are included for API parity; use getThreads for pagination or full chat thread retrieval.';
    const plainUsage = input.includeSystemActors
      ? 'This v3 view distinguishes user, team, and system_user in createdBy/assignee. Use getThreads for full message history, getOriginalSource for raw thread source, or getAttachment for attachment data.'
      : 'Use getThreads for full message history, getOriginalSource for raw thread source, or getAttachment for attachment data.';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          conversationId: input.conversationId,
          embedded: input.embed,
          ...(input.includeSystemActors ? { apiVersion: 'v3' } : {}),
          conversation: processedConversation,
          usage: input.embed === 'threads' ? embedUsage : plainUsage,
        }, null, 2),
      }],
    };
  }

  private async getConversationSummary(args: unknown): Promise<CallToolResult> {
    const input = GetConversationSummaryInputSchema.parse(args);
    
    // Get conversation details
    const conversation = await helpScoutClient.get<Conversation>(`/conversations/${input.conversationId}`);
    
    // Get ALL threads to find first customer message and latest staff reply.
    // The endpoint is 25/page and ignores `size`, so a single call would only
    // see the first 25 threads and pick the wrong "first"/"latest" on long
    // conversations. Loop pages for a correct summary.
    const { items: threads } = await helpScoutClient.getAllPages<Thread>(
      `/conversations/${input.conversationId}/threads`,
      'threads',
    );
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
        body: config.security.redactMessageContent ? REDACTED_MESSAGE_BODY : firstCustomerMessage.body,
        createdAt: firstCustomerMessage.createdAt,
        customer: firstCustomerMessage.customer,
      } : null,
      latestStaffReply: latestStaffReply ? {
        id: latestStaffReply.id,
        body: config.security.redactMessageContent ? REDACTED_MESSAGE_BODY : latestStaffReply.body,
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

    // Threads ARE the messages. Both the v2 and v3 threads endpoints are
    // page-based and ignore `size`, so loop pages (getAllPages) to return the
    // complete history up to `limit` instead of silently truncating.
    //
    // includeSystemActors routes to the v3 threads endpoint, which preserves the
    // user/team/system_user person types (v2 collapses system_user into user).
    if (input.includeSystemActors) {
      const { items: threads, totalElements, truncated } = await helpScoutClient.getAllPages<Record<string, unknown>>(
        this.buildV3ApiUrl(`/conversations/${input.conversationId}/threads`),
        'threads',
        { page: input.page },
        input.limit,
      );

      const processedThreads = config.security.redactMessageContent
        ? threads.map((thread) => this.redactThreadBody(thread))
        : threads;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              conversationId: input.conversationId,
              apiVersion: 'v3',
              threads: processedThreads,
              returnedCount: processedThreads.length,
              totalThreads: totalElements,
              truncated,
              usage: 'This v3 thread view distinguishes user, team, and system_user in createdBy/assignedTo.',
            }, null, 2),
          },
        ],
      };
    }

    const { items: threads, totalElements, truncated } = await helpScoutClient.getAllPages<Thread>(
      `/conversations/${input.conversationId}/threads`,
      'threads',
      { page: input.page },
      input.limit,
    );

    // Redact message bodies if configured.
    const processedThreads = threads.map(thread => ({
      ...thread,
      body: config.security.redactMessageContent ? REDACTED_MESSAGE_BODY : thread.body,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threads: processedThreads,
            returnedCount: processedThreads.length,
            totalThreads: totalElements,
            truncated,
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
      source: 'mcp_host_clock',
      note: 'Timestamp from the local MCP host process clock, not the Help Scout API.',
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
    const input = ListAllInboxesInputSchema.parse(args);

    // "List ALL inboxes" must mean all: /mailboxes is 50/page and ignores
    // `size`, so loop pages up to `limit` instead of returning only the first 50
    // and mislabeling it as the total.
    const { items: allInboxes, totalElements, truncated } = await helpScoutClient.getAllPages<Inbox>(
      '/mailboxes',
      'mailboxes',
      {},
      input.limit,
    );

    // /mailboxes has no name filter, so the nameContains match is done
    // client-side over ALL fully-paged inboxes (case-insensitive substring).
    const inboxes = input.nameContains
      ? allInboxes.filter(inbox =>
          inbox.name.toLowerCase().includes(input.nameContains!.toLowerCase())
        )
      : allInboxes;

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
            ...(input.nameContains ? { nameContains: input.nameContains } : {}),
            totalInboxes: totalElements,
            returnedCount: inboxes.length,
            truncated,
            usage: 'Use the "id" field from these results in your conversation searches',
            nextSteps: [
              'To search in a specific inbox, use the inbox ID with searchConversations',
              'To search across all inboxes, omit the inboxId parameter',
            ],
          }, null, 2),
        },
      ],
    };
  }

  private async getInbox(args: unknown): Promise<CallToolResult> {
    const input = GetInboxInputSchema.parse(args);
    const inbox = await helpScoutClient.get<Inbox>(`/mailboxes/${input.inboxId}`);

    const payload: Record<string, unknown> = {
      inbox,
      usage: 'Use inbox.id with conversation searches, saved reply tools, or call getInbox again with include: ["fields","folders","routing"] to attach inbox sub-resources.',
    };

    const include = input.include ? Array.from(new Set(input.include)) : [];
    if (include.length > 0) {
      const includeErrors: Record<string, string> = {};

      const settled = await Promise.allSettled(
        include.map(part => this.fetchInboxSubResource(input.inboxId, part))
      );

      settled.forEach((outcome, index) => {
        const part = include[index];
        if (outcome.status === 'fulfilled') {
          Object.assign(payload, outcome.value);
        } else {
          const reason = outcome.reason;
          includeErrors[part] = reason instanceof Error ? reason.message : String(reason);
        }
      });

      if (Object.keys(includeErrors).length > 0) {
        payload.includeErrors = includeErrors;
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      }],
    };
  }

  /**
   * Fetch a single inbox sub-resource from its dedicated Help Scout endpoint and
   * return the response fragment to merge into the getInbox payload. Each sub-resource
   * lives at its own endpoint (the API does not embed them on the inbox), so getInbox
   * fans these out server-side when requested via the include parameter.
   */
  private async fetchInboxSubResource(
    inboxId: string,
    part: 'fields' | 'folders' | 'routing'
  ): Promise<Record<string, unknown>> {
    switch (part) {
      case 'fields': {
        const response = await helpScoutClient.get<PaginatedResponse<InboxCustomField>>(`/mailboxes/${inboxId}/fields`);
        const fields = response._embedded?.fields || [];
        return {
          customFields: {
            fields,
            totalFields: fields.length,
            pagination: response.page,
          },
        };
      }
      case 'folders': {
        const response = await helpScoutClient.get<PaginatedResponse<InboxFolder>>(`/mailboxes/${inboxId}/folders`);
        const folders = response._embedded?.folders || [];
        return {
          folders: {
            folders,
            totalFolders: folders.length,
            pagination: response.page,
          },
        };
      }
      case 'routing': {
        const routing = await helpScoutClient.get<InboxRouting>(`/mailboxes/${inboxId}/routing`, undefined, { ttl: 300 });
        return { routing };
      }
    }
  }

  private async listTags(args: unknown): Promise<CallToolResult> {
    const input = ListTagsInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<Tag>>('/tags', {
      page: input.page,
    });

    const tags = response._embedded?.tags || [];
    const filteredTags = input.name
      ? tags.filter(tag => tag.name.toLowerCase().includes(input.name!.toLowerCase()))
      : tags;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          tags: filteredTags,
          nameFilter: input.name,
          totalFound: filteredTags.length,
          totalAvailable: response.page?.totalElements ?? tags.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: filteredTags.length > 0
            ? 'Use tag.id for report filters that require IDs, or tag.name with conversation tag filters.'
            : 'No tags matched. Omit name to list tags alphabetically across all inboxes.',
        }, null, 2),
      }],
    };
  }

  private async listCustomerProperties(args: unknown): Promise<CallToolResult> {
    ListCustomerPropertiesInputSchema.parse(args);
    const response = await helpScoutClient.get<{
      _embedded?: { 'customer-properties'?: PropertyDefinition[] };
    }>('/customer-properties');
    const properties = response._embedded?.['customer-properties'] || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          customerProperties: properties,
          totalProperties: properties.length,
          usage: properties.length > 0
            ? 'Use property.slug to interpret values embedded on customer records.'
            : 'No customer property definitions returned for this account.',
        }, null, 2),
      }],
    };
  }

  private async listOrganizationProperties(args: unknown): Promise<CallToolResult> {
    ListOrganizationPropertiesInputSchema.parse(args);
    const response = await helpScoutClient.get<{
      _embedded?: { 'organization-properties'?: PropertyDefinition[] };
    }>('/organizations/properties');
    const properties = response._embedded?.['organization-properties'] || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organizationProperties: properties,
          totalProperties: properties.length,
          usage: properties.length > 0
            ? 'Use property.slug with getOrganizationProperty, and to interpret values embedded on organization records.'
            : 'No organization property definitions returned for this account.',
        }, null, 2),
      }],
    };
  }

  private async getOrganizationProperty(args: unknown): Promise<CallToolResult> {
    const input = GetOrganizationPropertyInputSchema.parse(args);
    const property = await helpScoutClient.get<PropertyDefinition>(`/organizations/properties/${input.slug}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organizationProperty: property,
          usage: property.type === 'dropdown'
            ? 'Use option labels exactly as returned when interpreting or setting organization property values.'
            : 'Use property.slug to interpret values embedded on organization records.',
        }, null, 2),
      }],
    };
  }

  private async getTag(args: unknown): Promise<CallToolResult> {
    const input = GetTagInputSchema.parse(args);
    const tag = await helpScoutClient.get<Tag>(`/tags/${input.tagId}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          tag,
          usage: 'Use tag.name with conversation tag filters; use tag.id for report endpoints that expect tag IDs.',
        }, null, 2),
      }],
    };
  }

  private async listUsers(args: unknown): Promise<CallToolResult> {
    const input = ListUsersInputSchema.parse(args);

    // includeSystemActors routes to the v3 /system-users endpoint, which
    // returns system actors (AI agents, integration users) that v2 /users
    // does not expose. It supersedes the standard-user listing and ignores
    // includeStatuses (statuses do not apply to system actors).
    if (input.includeSystemActors) {
      const response = await helpScoutClient.get<PaginatedResponse<SystemUser>>(
        this.buildV3ApiUrl('/system-users'),
        { page: input.page }
      );
      const systemUsers = response._embedded?.system_users || response._embedded?.systemUsers || [];

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            apiVersion: 'v3',
            systemUsers,
            totalSystemUsers: systemUsers.length,
            pagination: response.page,
            nextPage: getNextPage(response.page),
            usage: systemUsers.length > 0
              ? 'Use getUser(userId, includeSystemActors:true) when you need the full system-user record.'
              : 'No system users returned for this Help Scout account.',
          }, null, 2),
        }],
      };
    }

    const params: Record<string, unknown> = { page: input.page };
    if (input.email) params.email = input.email;
    if (input.inboxId) params.mailbox = Number(input.inboxId);

    // includeStatuses additionally calls /users/status ONCE (it returns all
    // user statuses in a single call). We never fan out per user.
    const [usersResponse, statusesResult] = await Promise.allSettled([
      helpScoutClient.get<PaginatedResponse<User>>('/users', params),
      input.includeStatuses
        ? helpScoutClient.get<PaginatedResponse<UserStatus>>('/users/status', { page: 1 })
        : Promise.resolve(null),
    ]);

    if (usersResponse.status === 'rejected') {
      throw usersResponse.reason;
    }

    const response = usersResponse.value;
    const users = response._embedded?.users || [];

    const result: Record<string, unknown> = {
      users,
      filters: {
        email: input.email,
        inboxId: input.inboxId,
      },
      totalUsers: users.length,
      pagination: response.page,
      nextPage: getNextPage(response.page),
      usage: users.length > 0
        ? 'Use user.id for assignee filters and user.mention when composing Help Scout note/reply text.'
        : 'No users matched these filters. Try omitting email or inboxId.',
    };

    if (input.includeStatuses) {
      if (statusesResult.status === 'fulfilled' && statusesResult.value) {
        const statusEnvelope = statusesResult.value;
        result.statuses = statusEnvelope._embedded?.userStatuses || statusEnvelope._embedded?.user_statuses || [];
      } else {
        const reason = statusesResult.status === 'rejected' ? statusesResult.reason : new Error('Unknown error');
        const errorMessage = reason instanceof Error ? reason.message : String(reason);
        logger.error('User status fetch failed for listUsers', { error: errorMessage });
        result.statusesError = `Status lookup failed: ${errorMessage}`;
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }

  private async getUser(args: unknown): Promise<CallToolResult> {
    const input = GetUserInputSchema.parse(args);

    // includeSystemActors routes to the v3 /system-users/{id} endpoint, which
    // returns the system actor record (v2 /users collapses these). It takes
    // precedence over includeStatus, which does not apply to system actors.
    if (input.includeSystemActors) {
      const systemUser = await helpScoutClient.get<SystemUser>(
        this.buildV3ApiUrl(`/system-users/${input.userId}`)
      );

      const result: Record<string, unknown> = {
        apiVersion: 'v3',
        systemUser,
        usage: 'System users identify non-human or integration actors in Help Scout account data.',
      };
      if (input.includeStatus) {
        result.statusNote = 'includeStatus is ignored for system users; availability statuses apply only to standard users.';
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }

    const path = input.userId === 'me' ? '/users/me' : `/users/${input.userId}`;

    // includeStatus adds the /users/{id}/status sub-fetch. Surface a per-call
    // error rather than failing the whole call if only the status lookup fails.
    const [userResult, statusResult] = await Promise.allSettled([
      helpScoutClient.get<User>(path),
      input.includeStatus
        ? helpScoutClient.get<UserStatus>(
            input.userId === 'me' ? '/users/me/status' : `/users/${input.userId}/status`
          )
        : Promise.resolve(null),
    ]);

    if (userResult.status === 'rejected') {
      throw userResult.reason;
    }

    const result: Record<string, unknown> = {
      user: userResult.value,
      usage: 'Use user.id for assignment, assignee filters, and user/team report filters.',
    };

    if (input.includeStatus) {
      if (statusResult.status === 'fulfilled' && statusResult.value) {
        result.status = statusResult.value;
      } else {
        const reason = statusResult.status === 'rejected' ? statusResult.reason : new Error('Unknown error');
        const errorMessage = reason instanceof Error ? reason.message : String(reason);
        logger.error('User status fetch failed for getUser', { userId: input.userId, error: errorMessage });
        result.statusError = `Status lookup failed: ${errorMessage}`;
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }

  private async listTeams(args: unknown): Promise<CallToolResult> {
    const input = ListTeamsInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<Team>>('/teams', {
      page: input.page,
    });
    const teams = response._embedded?.teams || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          teams,
          totalTeams: teams.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: teams.length > 0
            ? 'Use team.id with getTeamMembers to discover team member user IDs.'
            : 'No teams returned for this Help Scout account.',
        }, null, 2),
      }],
    };
  }

  private async getTeamMembers(args: unknown): Promise<CallToolResult> {
    const input = GetTeamMembersInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<User>>(`/teams/${input.teamId}/members`, {
      page: input.page,
    });
    const members = response._embedded?.users || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          teamId: input.teamId,
          members,
          totalMembers: members.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: members.length > 0
            ? 'Use member.id for assignee filters or user report filters.'
            : 'No users returned for this team.',
        }, null, 2),
      }],
    };
  }

  private async listSavedReplies(args: unknown): Promise<CallToolResult> {
    const input = ListSavedRepliesInputSchema.parse(args);
    const response = await helpScoutClient.get<SavedReply[] | PaginatedResponse<SavedReply>>(
      `/mailboxes/${input.inboxId}/saved-replies`,
      { includeChatReplies: input.includeChatReplies }
    );
    const savedReplies = Array.isArray(response)
      ? response
      : response._embedded?.['saved-replies'] || response._embedded?.savedReplies || response._embedded?.replies || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          inboxId: input.inboxId,
          includeChatReplies: input.includeChatReplies,
          savedReplies,
          totalSavedReplies: savedReplies.length,
          pagination: Array.isArray(response) ? undefined : response.page,
          nextPage: Array.isArray(response) ? null : getNextPage(response.page),
          usage: savedReplies.length > 0
            ? 'Use savedReply.id with getSavedReply to inspect the full reusable response template.'
            : 'No saved replies returned for this inbox.',
        }, null, 2),
      }],
    };
  }

  private async getSavedReply(args: unknown): Promise<CallToolResult> {
    const input = GetSavedReplyInputSchema.parse(args);
    const savedReply = await helpScoutClient.get<SavedReply>(`/mailboxes/${input.inboxId}/saved-replies/${input.replyId}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          inboxId: input.inboxId,
          replyId: input.replyId,
          savedReply,
          usage: 'Use saved reply content as reference context only; this tool does not send or draft replies.',
        }, null, 2),
      }],
    };
  }

  private async getOriginalSource(args: unknown): Promise<CallToolResult> {
    const input = GetOriginalSourceInputSchema.parse(args);
    const endpoint = `/conversations/${input.conversationId}/threads/${input.threadId}/original-source`;

    if (config.security.redactMessageContent) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threadId: input.threadId,
            format: input.format,
            originalSource: REDACTED_MESSAGE_BODY,
            usage: 'Original source content is hidden because REDACT_MESSAGE_CONTENT is enabled.',
          }, null, 2),
        }],
      };
    }

    // The Help Scout endpoint selects format via the Accept header.
    if (input.format === 'rfc822') {
      const response = await helpScoutClient.getRaw<string>(endpoint, undefined, {
        responseType: 'text',
        headers: { Accept: 'message/rfc822' },
      });
      const headers = response.headers as Record<string, unknown>;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threadId: input.threadId,
            format: 'rfc822',
            sourceFormat: 'message/rfc822',
            contentType: this.getResponseHeader(headers, 'content-type') ?? 'message/rfc822',
            originalSource: response.data,
            usage: 'Use RFC 822 source for read-only inspection of raw email source when JSON original source is insufficient.',
          }, null, 2),
        }],
      };
    }

    const originalSource = await helpScoutClient.get<Record<string, unknown>>(endpoint);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          conversationId: input.conversationId,
          threadId: input.threadId,
          format: 'json',
          originalSource,
          usage: 'Use original source for read-only inspection of raw thread content when rendered thread fields are insufficient.',
        }, null, 2),
      }],
    };
  }

  private async getAttachment(args: unknown): Promise<CallToolResult> {
    const input = GetAttachmentInputSchema.parse(args);
    const attachment = await helpScoutClient.get<Record<string, unknown>>(
      `/conversations/${input.conversationId}/attachments/${input.attachmentId}/data`,
      undefined,
      { ttl: 0 }
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          conversationId: input.conversationId,
          attachmentId: input.attachmentId,
          attachment,
          contentHandling: {
            encoding: 'base64',
            source: 'Help Scout attachment data endpoint',
          },
          usage: 'Decode attachment.data only when the caller explicitly needs the file content; avoid logging decoded attachment bytes.',
        }, null, 2),
      }],
    };
  }

  private async downloadAttachmentFile(args: unknown): Promise<CallToolResult> {
    const input = DownloadAttachmentFileInputSchema.parse(args);
    const response = await helpScoutClient.getRaw<Buffer>(
      `/conversations/${input.conversationId}/attachments/${input.attachmentId}/file`,
      undefined,
      { responseType: 'arraybuffer' }
    );
    const headers = response.headers as Record<string, unknown>;
    const contentDisposition = this.getResponseHeader(headers, 'content-disposition');
    const contentType = this.getResponseHeader(headers, 'content-type') ?? 'application/octet-stream';
    const fileBuffer = this.responseDataToBuffer(response.data);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          conversationId: input.conversationId,
          attachmentId: input.attachmentId,
          filename: this.parseContentDispositionFilename(contentDisposition),
          contentType,
          contentDisposition,
          byteLength: fileBuffer.byteLength,
          data: fileBuffer.toString('base64'),
          contentHandling: {
            encoding: 'base64',
            source: 'Help Scout attachment file endpoint',
          },
          usage: 'Decode data only when the caller explicitly needs the file content; avoid logging decoded attachment bytes.',
        }, null, 2),
      }],
    };
  }

  private async listWorkflows(args: unknown): Promise<CallToolResult> {
    const input = ListWorkflowsInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<Workflow>>('/workflows', {
      page: input.page,
    });
    const workflows = response._embedded?.workflows || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          workflows,
          totalWorkflows: workflows.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: workflows.length > 0
            ? 'Use workflow.id when a direct workflow lookup or future API parity tool requires it.'
            : 'No workflows returned for this Help Scout account.',
        }, null, 2),
      }],
    };
  }

  private async listWebhooks(args: unknown): Promise<CallToolResult> {
    const input = ListWebhooksInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<Webhook>>('/webhooks', {
      page: input.page,
    });
    const webhooks = response._embedded?.webhooks || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          webhooks,
          totalWebhooks: webhooks.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: webhooks.length > 0
            ? 'Use webhook.id with getWebhook to inspect a specific webhook configuration.'
            : 'No webhooks returned for this Help Scout account.',
        }, null, 2),
      }],
    };
  }

  private async getWebhook(args: unknown): Promise<CallToolResult> {
    const input = GetWebhookInputSchema.parse(args);
    const webhook = await helpScoutClient.get<Webhook>(`/webhooks/${input.webhookId}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          webhook,
          usage: 'Use webhook configuration for integration inspection only; this tool does not create or update webhooks.',
        }, null, 2),
      }],
    };
  }

  private async getSatisfactionRating(args: unknown): Promise<CallToolResult> {
    const input = GetSatisfactionRatingInputSchema.parse(args);
    const rating = await helpScoutClient.get<SatisfactionRating>(`/ratings/${input.ratingId}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ratingId: input.ratingId,
          rating,
          usage: 'Use satisfaction rating data as read-only quality context; this tool does not compute reports or trends.',
        }, null, 2),
      }],
    };
  }

  private async getCompanyReport(args: unknown): Promise<CallToolResult> {
    const input = GetCompanyReportInputSchemaUnion.parse(args);
    switch (input.report) {
      case 'customers-helped': {
        const params = this.buildReportQueryParamsWithExtras(input, ['viewBy']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/company/customers-helped', params);
        return this.formatReportResult('companyCustomersHelped', params, report);
      }
      case 'drilldown': {
        const params = this.buildReportQueryParamsWithExtras(input, ['page', 'rows', 'range', 'rangeId']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/company/drilldown', params);
        return this.formatReportResult('companyDrilldown', params, report);
      }
      case 'overall':
      default: {
        const params = this.buildReportQueryParams(input);
        const report = await helpScoutClient.get<ReportResponse>('/reports/company', params);
        return this.formatReportResult('company', params, report);
      }
    }
  }

  private async getConversationsReport(args: unknown): Promise<CallToolResult> {
    const input = GetConversationsReportInputSchemaUnion.parse(args);
    switch (input.report) {
      case 'volume-by-channel': {
        const params = this.buildReportQueryParamsWithExtras(input, ['viewBy']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations/volume-by-channel', params);
        return this.formatReportResult('conversationVolumeByChannel', params, report);
      }
      case 'busy-times': {
        const params = this.buildReportQueryParams(input);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations/busy-times', params);
        return this.formatReportResult('conversationBusyTimes', params, report);
      }
      case 'drilldown': {
        const params = this.buildReportQueryParamsWithExtras(input, ['page', 'rows']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations/drilldown', params);
        return this.formatReportResult('conversationDrilldown', params, report);
      }
      case 'fields-drilldown': {
        const params = this.buildReportQueryParamsWithExtras(input, ['field', 'fieldid', 'page', 'rows']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations/fields-drilldown', params);
        return this.formatReportResult('conversationFieldDrilldown', params, report);
      }
      case 'new': {
        const params = this.buildReportQueryParamsWithExtras(input, ['viewBy']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations/new', params);
        return this.formatReportResult('conversationNew', params, report);
      }
      case 'new-drilldown': {
        const params = this.buildReportQueryParamsWithExtras(input, ['page', 'rows']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations/new-drilldown', params);
        return this.formatReportResult('conversationNewDrilldown', params, report);
      }
      case 'received-messages': {
        const params = this.buildReportQueryParamsWithExtras(input, ['viewBy']);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations/received-messages', params);
        return this.formatReportResult('conversationReceivedMessages', params, report);
      }
      case 'overall':
      default: {
        const params = this.buildReportQueryParams(input);
        const report = await helpScoutClient.get<ReportResponse>('/reports/conversations', params);
        return this.formatReportResult('conversations', params, report);
      }
    }
  }

  private async getProductivityReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityReportInputSchemaUnion.parse(args);
    const params = this.buildProductivityReportQueryParams(input);
    const map: Record<string, { path: string; reportType: string }> = {
      'first-response-time': { path: '/reports/productivity/first-response-time', reportType: 'productivityFirstResponseTime' },
      'replies-sent': { path: '/reports/productivity/replies-sent', reportType: 'productivityRepliesSent' },
      'resolved': { path: '/reports/productivity/resolved', reportType: 'productivityResolved' },
      'response-time': { path: '/reports/productivity/response-time', reportType: 'productivityResponseTime' },
      'resolution-time': { path: '/reports/productivity/resolution-time', reportType: 'productivityResolutionTime' },
      'overall': { path: '/reports/productivity', reportType: 'productivity' },
    };
    const { path, reportType } = map[input.report] ?? map.overall;
    const report = await helpScoutClient.get<ReportResponse>(path, params);
    return this.formatReportResult(reportType, params, report);
  }

  private async getUserReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserReportInputSchemaUnion.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const map: Record<string, { path: string; reportType: string }> = {
      'conversation-history': { path: '/reports/user/conversation-history', reportType: 'userConversationHistory' },
      'customers-helped': { path: '/reports/user/customers-helped', reportType: 'userCustomersHelped' },
      'drilldown': { path: '/reports/user/drilldown', reportType: 'userDrilldown' },
      'happiness': { path: '/reports/user/happiness', reportType: 'userHappiness' },
      'ratings': { path: '/reports/user/ratings', reportType: 'userRatings' },
      'replies': { path: '/reports/user/replies', reportType: 'userReplies' },
      'resolutions': { path: '/reports/user/resolutions', reportType: 'userResolutions' },
      'chat': { path: '/reports/user/chat', reportType: 'userChat' },
      'overall': { path: '/reports/user', reportType: 'user' },
    };
    const { path, reportType } = map[input.report] ?? map.overall;
    const report = await helpScoutClient.get<ReportResponse>(path, params);
    return this.formatReportResult(reportType, params, report);
  }

  private async getHappinessReport(args: unknown): Promise<CallToolResult> {
    const input = GetHappinessReportInputSchemaUnion.parse(args);
    if (input.report === 'ratings') {
      const params: Record<string, string | number> = {
        ...this.buildReportQueryParams(input),
        page: input.page ?? 1,
        sortField: input.sortField ?? 'modifiedAt',
        sortOrder: input.sortOrder ?? 'DESC',
        ...(input.rating ? { rating: input.rating } : {}),
      };
      const report = await helpScoutClient.get<HappinessRatingsReport>('/reports/happiness/ratings', params);
      return this.formatReportResult('happinessRatings', params, report);
    }
    const params = this.buildReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/happiness', params);
    return this.formatReportResult('happiness', params, report);
  }

  private async getChannelReport(args: unknown): Promise<CallToolResult> {
    const input = GetChannelReportInputSchemaUnion.parse(args);
    const params = this.buildReportQueryParamsWithExtras(input, ['officeHours']);
    const report = await helpScoutClient.get<ReportResponse>(`/reports/${input.channel}`, params);
    return this.formatReportResult(input.channel, params, report);
  }

  private async getDocsReport(args: unknown): Promise<CallToolResult> {
    const input = GetDocsReportInputSchema.parse(args);
    const params = this.buildReportQueryParamsWithExtras(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/docs', params);

    return this.formatReportResult('docs', params, report);
  }

  private formatReportResult(
    reportType: string,
    filters: Record<string, string | number>,
    report: ReportResponse | HappinessRatingsReport
  ): CallToolResult {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          reportType,
          filters,
          report,
          usage: 'Reporting data is read-only Help Scout API output for the requested bounded interval; this tool does not compute dashboard summaries or trends beyond API-provided fields.',
        }, null, 2),
      }],
    };
  }

  private formatDocsCollection<T>(
    response: DocsCollectionEnvelope<T> | Record<string, DocsCollectionEnvelope<T>>,
    envelopeKey: string,
  ): { results: T[]; pagination: { page?: number; pages?: number; count?: number }; nextPage: number | null } {
    const responseRecord = response as Record<string, DocsCollectionEnvelope<T>>;
    const envelope = responseRecord[envelopeKey] || response as DocsCollectionEnvelope<T>;
    const page = envelope.page;
    const pages = envelope.pages;
    return {
      results: envelope.items || [],
      pagination: {
        page,
        pages,
        count: envelope.count,
      },
      nextPage: getDocsNextPage(page, pages),
    };
  }

  private docsTextResponse(data: Record<string, unknown>): CallToolResult {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data, null, 2),
      }],
    };
  }

  private redactDocsSiteRestrictions(data: Record<string, unknown>): Record<string, unknown> {
    const clone = structuredClone(data) as Record<string, unknown>;

    const redact = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(redact);
        return;
      }

      const record = value as Record<string, unknown>;
      for (const [key, nestedValue] of Object.entries(record)) {
        if (/secret|password|token|credential/i.test(key) && typeof nestedValue === 'string' && nestedValue.length > 0) {
          record[key] = '[redacted]';
          if (key === 'sharedSecret') {
            record.hasSharedSecret = true;
          }
        } else {
          redact(nestedValue);
        }
      }
    };

    redact(clone);
    return clone;
  }

  private async listDocsSites(args: unknown): Promise<CallToolResult> {
    const input = ListDocsSitesInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<DocsCollectionEnvelope<Record<string, unknown>>>('/sites', {
      page: input.page,
    });
    return this.docsTextResponse({
      ...this.formatDocsCollection(response, 'sites'),
      usage: 'Use site.id with listDocsCollections or getDocsSite.',
    });
  }

  private async getDocsSite(args: unknown): Promise<CallToolResult> {
    const input = GetDocsSiteInputSchema.parse(args);

    // includeRestrictions adds the /sites/{id}/restricted sub-fetch. Surface a
    // per-call error rather than failing the whole call if only the
    // restrictions lookup fails. Shared secrets are always redacted.
    const [siteResult, restrictionsResult] = await Promise.allSettled([
      helpScoutDocsClient.get<{ site: Record<string, unknown> }>(`/sites/${input.siteId}`),
      input.includeRestrictions
        ? helpScoutDocsClient.get<Record<string, unknown>>(`/sites/${input.siteId}/restricted`)
        : Promise.resolve(null),
    ]);

    if (siteResult.status === 'rejected') {
      throw siteResult.reason;
    }

    const payload: Record<string, unknown> = {
      site: siteResult.value.site,
      usage: input.includeRestrictions
        ? 'Use site.id with listDocsCollections and listDocsRedirects. restrictions.callbackConfiguration.sharedSecret is always redacted.'
        : 'Use site.id with listDocsCollections and listDocsRedirects. Set includeRestrictions to inspect access controls.',
    };

    if (input.includeRestrictions) {
      if (restrictionsResult.status === 'fulfilled' && restrictionsResult.value) {
        payload.restrictions = this.redactDocsSiteRestrictions(restrictionsResult.value);
      } else {
        const reason = restrictionsResult.status === 'rejected' ? restrictionsResult.reason : new Error('Unknown error');
        const errorMessage = reason instanceof Error ? reason.message : String(reason);
        logger.error('Docs site restrictions fetch failed for getDocsSite', { siteId: input.siteId, error: errorMessage });
        payload.restrictionsError = `Restrictions lookup failed: ${errorMessage}`;
      }
    }

    return this.docsTextResponse(payload);
  }

  private async listDocsCollections(args: unknown): Promise<CallToolResult> {
    const input = ListDocsCollectionsInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<Record<string, DocsCollectionEnvelope<Record<string, unknown>>>>('/collections', {
      page: input.page,
      siteId: input.siteId,
      visibility: input.visibility,
      sort: input.sort,
      order: input.order,
    });
    return this.docsTextResponse({
      ...this.formatDocsCollection(response, 'collections'),
      usage: 'Use collection.id with listDocsCategories, listDocsArticles, or getDocsCollection.',
    });
  }

  private async getDocsCollection(args: unknown): Promise<CallToolResult> {
    const input = GetDocsCollectionInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<{ collection: Record<string, unknown> }>(`/collections/${input.collectionId}`);
    return this.docsTextResponse({
      collection: response.collection,
      usage: 'Use collection.id with listDocsCategories or listDocsArticles.',
    });
  }

  private async listDocsCategories(args: unknown): Promise<CallToolResult> {
    const input = ListDocsCategoriesInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<Record<string, DocsCollectionEnvelope<Record<string, unknown>>>>(
      `/collections/${input.collectionId}/categories`,
      {
        page: input.page,
        sort: input.sort,
        order: input.order,
      }
    );
    return this.docsTextResponse({
      collectionId: input.collectionId,
      ...this.formatDocsCollection(response, 'categories'),
      usage: 'Use category.id with listDocsArticles or getDocsCategory.',
    });
  }

  private async getDocsCategory(args: unknown): Promise<CallToolResult> {
    const input = GetDocsCategoryInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<{ category: Record<string, unknown> }>(`/categories/${input.categoryId}`);
    return this.docsTextResponse({
      category: response.category,
      usage: 'Use category.id with listDocsArticles.',
    });
  }

  private async listDocsArticles(args: unknown): Promise<CallToolResult> {
    const input = ListDocsArticlesInputSchema.parse(args);
    const parentType = input.collectionId ? 'collection' : 'category';
    const parentId = input.collectionId || input.categoryId;
    const endpoint = input.collectionId
      ? `/collections/${input.collectionId}/articles`
      : `/categories/${input.categoryId}/articles`;
    const response = await helpScoutDocsClient.get<Record<string, DocsCollectionEnvelope<Record<string, unknown>>>>(endpoint, {
      page: input.page,
      status: input.status,
      sort: input.sort,
      order: input.order,
      pageSize: input.pageSize,
    });
    return this.docsTextResponse({
      parentType,
      parentId,
      ...this.formatDocsCollection(response, 'articles'),
      usage: 'Use article.id with getDocsArticle, listDocsRelatedArticles, or listDocsArticleRevisions.',
    });
  }

  private async searchDocsArticles(args: unknown): Promise<CallToolResult> {
    const input = SearchDocsArticlesInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<Record<string, DocsCollectionEnvelope<Record<string, unknown>>>>('/search/articles', {
      page: input.page,
      query: input.query,
      collectionId: input.collectionId,
      siteId: input.siteId,
      status: input.status,
      visibility: input.visibility,
    });
    return this.docsTextResponse({
      query: input.query,
      ...this.formatDocsCollection(response, 'articles'),
      usage: 'Use article.id with getDocsArticle for full article text and freshness metadata.',
    });
  }

  private async getDocsArticle(args: unknown): Promise<CallToolResult> {
    const input = GetDocsArticleInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<{ article: Record<string, unknown> }>(`/articles/${input.articleId}`, {
      draft: input.draft,
    });
    return this.docsTextResponse({
      article: response.article,
      usage: 'Use listDocsRelatedArticles for related public references or listDocsArticleRevisions for freshness checks.',
    });
  }

  private async listDocsRelatedArticles(args: unknown): Promise<CallToolResult> {
    const input = ListDocsRelatedArticlesInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<Record<string, DocsCollectionEnvelope<Record<string, unknown>>>>(
      `/articles/${input.articleId}/related`,
      {
        page: input.page,
        status: input.status,
        sort: input.sort,
        order: input.order,
      }
    );
    return this.docsTextResponse({
      articleId: input.articleId,
      ...this.formatDocsCollection(response, 'articles'),
      usage: 'Use related article ids with getDocsArticle for full text.',
    });
  }

  private async listDocsArticleRevisions(args: unknown): Promise<CallToolResult> {
    const input = ListDocsArticleRevisionsInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<Record<string, DocsCollectionEnvelope<Record<string, unknown>>>>(
      `/articles/${input.articleId}/revisions`,
      { page: input.page }
    );
    return this.docsTextResponse({
      articleId: input.articleId,
      ...this.formatDocsCollection(response, 'revisions'),
      usage: 'Use revision.id with getDocsArticleRevision to inspect revision text.',
    });
  }

  private async getDocsArticleRevision(args: unknown): Promise<CallToolResult> {
    const input = GetDocsArticleRevisionInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<{ revision: Record<string, unknown> }>(`/revisions/${input.revisionId}`);
    return this.docsTextResponse({
      revision: response.revision,
      usage: 'Use revision.createdAt and createdBy for article freshness checks.',
    });
  }

  private async listDocsRedirects(args: unknown): Promise<CallToolResult> {
    const input = ListDocsRedirectsInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<Record<string, DocsCollectionEnvelope<Record<string, unknown>>>>(
      `/redirects/site/${input.siteId}`,
      { page: input.page }
    );
    return this.docsTextResponse({
      siteId: input.siteId,
      ...this.formatDocsCollection(response, 'redirects'),
      usage: 'Use redirect.id with getDocsRedirect, or findDocsRedirect to resolve a URL path.',
    });
  }

  private async getDocsRedirect(args: unknown): Promise<CallToolResult> {
    const input = GetDocsRedirectInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<{ redirect: Record<string, unknown> }>(`/redirects/${input.redirectId}`);
    return this.docsTextResponse({
      redirect: response.redirect,
      usage: 'Use findDocsRedirect to resolve a source URL path through redirect chains.',
    });
  }

  private async findDocsRedirect(args: unknown): Promise<CallToolResult> {
    const input = FindDocsRedirectInputSchema.parse(args);
    const response = await helpScoutDocsClient.get<{ redirectedUrl: Record<string, unknown> | null }>('/redirects', {
      siteId: input.siteId,
      url: input.url,
    });
    return this.docsTextResponse({
      siteId: input.siteId,
      url: input.url,
      redirectedUrl: response.redirectedUrl,
      usage: response.redirectedUrl
        ? 'Use redirectedUrl to follow the resolved Docs target.'
        : 'No redirect was found for this site and URL path.',
    });
  }

  /**
   * Apply client-side createdBefore filter (Help Scout API does not support this natively).
   * Returns filtered conversations and metadata about what was removed.
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
   * Build inbox scope description string for response metadata.
   */
  private formatInboxScope(effectiveInboxId: string | undefined, explicitInboxId: string | undefined): string {
    if (!effectiveInboxId) return 'ALL inboxes';
    return explicitInboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`;
  }

  /**
   * Build pagination info that distinguishes filtered count from API total.
   * Used when createdBefore client-side filtering modifies a single API response.
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

  private async searchConversationStatusSet(
    baseParams: Record<string, unknown>,
    statuses: readonly ConversationStatus[],
    limit: number,
  ): Promise<{
    conversations: Conversation[];
    pagination: {
      totalResults: number;
      totalAvailable?: number;
      totalByStatus?: Record<string, number>;
      errors?: Array<{ status: string; message: string; code: string }>;
      note: string;
    };
    searchedStatuses: string[];
  }> {
    const results = await Promise.allSettled(
      statuses.map(status =>
        helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
          ...baseParams,
          status,
        })
      )
    );

    const conversations: Conversation[] = [];
    const seenIds = new Set<number>();
    const failedStatuses: Array<{ status: string; message: string; code: string }> = [];
    const totalByStatus: Record<string, number> = {};
    let totalAvailable = 0;

    for (const [index, result] of results.entries()) {
      const statusName = statuses[index];

      if (result.status === 'fulfilled') {
        const statusTotal = result.value.page?.totalElements || 0;
        totalByStatus[statusName] = statusTotal;
        totalAvailable += statusTotal;

        for (const conversation of result.value._embedded?.conversations || []) {
          if (!seenIds.has(conversation.id)) {
            seenIds.add(conversation.id);
            conversations.push(conversation);
          }
        }
        continue;
      }

      const reason = result.reason;
      if (!isApiError(reason)) {
        throw reason;
      }
      if (reason.code === 'UNAUTHORIZED' || reason.code === 'INVALID_INPUT') {
        throw reason;
      }

      failedStatuses.push({
        status: statusName,
        message: reason.message,
        code: reason.code,
      });

      logger.error('Status search failed - partial results will be returned', {
        status: statusName,
        errorCode: reason.code,
        message: reason.message,
        note: 'This status will be excluded from results'
      });
    }

    const searchedStatuses = failedStatuses.length > 0
      ? statuses.filter(status => !failedStatuses.some(failure => failure.status === status))
      : [...statuses];

    const sortField = typeof baseParams.sortField === 'string' ? baseParams.sortField : TOOL_CONSTANTS.DEFAULT_SORT_FIELD;
    const sortOrder = typeof baseParams.sortOrder === 'string' ? baseParams.sortOrder : TOOL_CONSTANTS.DEFAULT_SORT_ORDER;
    conversations.sort((a, b) => this.compareConversationsForSort(a, b, sortField, sortOrder));
    const limitedConversations = conversations.slice(0, limit);

    return {
      conversations: limitedConversations,
      searchedStatuses,
      pagination: {
        totalResults: limitedConversations.length,
        totalAvailable: Object.keys(totalByStatus).length > 0 ? totalAvailable : undefined,
        totalByStatus: Object.keys(totalByStatus).length > 0 ? totalByStatus : undefined,
        errors: failedStatuses.length > 0 ? failedStatuses : undefined,
        note: failedStatuses.length > 0
          ? `[WARNING] ${failedStatuses.length} status(es) failed - results incomplete! Failed: ${failedStatuses.map(f => `${f.status} (${f.code})`).join(', ')}. Totals reflect successful statuses only.`
          : `Merged results from ${Object.keys(totalByStatus).length} statuses. Returned ${limitedConversations.length} of ${totalAvailable} total conversations.`,
      },
    };
  }

  private compareConversationsForSort(
    a: Conversation,
    b: Conversation,
    sortField: string,
    sortOrder: string,
  ): number {
    const direction = sortOrder.toLowerCase() === 'asc' ? 1 : -1;
    const aValue = this.getConversationSortValue(a, sortField);
    const bValue = this.getConversationSortValue(b, sortField);
    let comparison: number;

    if (sortField === 'number' || sortField === 'mailboxId') {
      comparison = Number(aValue ?? 0) - Number(bValue ?? 0);
    } else if (this.isConversationDateSortField(sortField)) {
      comparison = Date.parse(String(aValue ?? '')) - Date.parse(String(bValue ?? ''));
    } else {
      comparison = String(aValue ?? '').localeCompare(String(bValue ?? ''), undefined, { numeric: true });
    }

    if (Number.isNaN(comparison) || comparison === 0) {
      comparison = a.id - b.id;
    }

    return comparison * direction;
  }

  private getConversationSortValue(conversation: Conversation, sortField: string): unknown {
    const record = conversation as unknown as Record<string, unknown>;
    const customer = this.toRecord(record.customer);
    const mailbox = this.toRecord(record.mailbox);

    switch (sortField) {
      case 'customerName': {
        const explicitName = this.asString(customer?.name ?? record.customerName);
        if (explicitName) return explicitName;
        return [this.asString(customer?.firstName), this.asString(customer?.lastName)]
          .filter(Boolean)
          .join(' ');
      }
      case 'customerEmail':
        return customer?.email ?? record.customerEmail;
      case 'mailboxId':
        return mailbox?.id ?? record.mailboxId;
      case 'modifiedAt':
        return record.modifiedAt ?? record.updatedAt;
      default:
        return record[sortField];
    }
  }

  private isConversationDateSortField(sortField: string): boolean {
    return ['createdAt', 'modifiedAt', 'updatedAt', 'waitingSince', 'closedAt'].includes(sortField);
  }

  private toRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  // ── Customer Tools (NAS-680, NAS-727) ──

  private formatAddress(address: CustomerAddress): Record<string, unknown> {
    return address as unknown as Record<string, unknown>;
  }

  private formatContactEntry(entry: { id: number; value: string; type?: string }): Record<string, unknown> {
    return {
      id: entry.id,
      value: entry.value,
      ...(entry.type ? { type: entry.type } : {}),
    };
  }

  private formatCustomer(customer: Customer): Record<string, unknown> {
    return customer as unknown as Record<string, unknown>;
  }

  private async getCustomer(args: unknown): Promise<CallToolResult> {
    const input = GetCustomerInputSchema.parse(args);

    // Fetch customer profile and address in parallel
    const [customerResponse, addressResponse] = await Promise.allSettled([
      helpScoutClient.get<Customer>(`/customers/${input.customerId}`),
      helpScoutClient.get<CustomerAddress>(`/customers/${input.customerId}/address`),
    ]);

    if (customerResponse.status === 'rejected') {
      throw customerResponse.reason;
    }

    const customer = customerResponse.value;

    // Handle address response: 404 means no address on file (expected), all other errors should surface
    let address: CustomerAddress | null = null;
    let addressNote: string | undefined;
    if (addressResponse.status === 'fulfilled') {
      address = addressResponse.value;
    } else {
      const reason = addressResponse.reason;
      const is404 = isApiError(reason) && reason.code === 'NOT_FOUND';
      if (!is404) {
        // Critical errors (auth, rate limit) should abort entirely
        if (isApiError(reason) && (reason.code === 'UNAUTHORIZED' || reason.code === 'RATE_LIMIT')) {
          throw reason;
        }
        // Non-API errors (TypeError, network) should propagate
        if (!isApiError(reason)) {
          throw reason;
        }
        // Other API errors: log and surface in response
        const errorMessage = reason.message || String(reason);
        logger.error('Address fetch failed for customer', { customerId: input.customerId, error: errorMessage });
        addressNote = `Address lookup failed: ${errorMessage}`;
      }
    }

    const result: Record<string, unknown> = this.formatCustomer(customer);
    if (address) {
      result.address = this.formatAddress(address);
    }
    if (addressNote) {
      result.addressNote = addressNote;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          customer: result,
          usage: 'NEXT STEPS: Use organizationId to explore their org with getOrganization. Use customer.id with searchConversations(customerIds) to find their conversations.',
        }, null, 2),
      }],
    };
  }

  private async listCustomers(args: unknown): Promise<CallToolResult> {
    const input = ListCustomersInputSchema.parse(args);

    // v3 cursor path: requested explicitly via useV3 or implied by a cursor.
    // The v3 Customers API uses cursor-based pagination (_links.next) and adds
    // the email/createdSince filters that the v2 page path does not support.
    if (input.useV3 || input.cursor) {
      const v3Params: Record<string, unknown> = {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        query: input.query,
        modifiedSince: this.normalizeApiDateParam(input.modifiedSince),
        createdSince: this.normalizeApiDateParam(input.createdSince),
        cursor: input.cursor,
      };

      const { customers, links, nextCursor } = await this.fetchCustomersV3(v3Params);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            results: customers.map(c => this.formatCustomer(c)),
            returnedCount: customers.length,
            links,
            nextCursor,
            pagination: { type: 'cursor', hasNext: Boolean(nextCursor) },
            note: 'v3 API uses cursor-based pagination. Pass nextCursor value back as cursor parameter for more results.',
            usage: 'Use customer.id with getCustomer for full profile with sub-resources.',
          }, null, 2),
        }],
      };
    }

    // v2 API: page size is fixed at 50, 'size' param is not documented/supported
    const params: Record<string, unknown> = {
      page: input.page,
      sortField: input.sortField,
      sortOrder: input.sortOrder,
      firstName: input.firstName,
      lastName: input.lastName,
      query: input.query,
      mailbox: input.mailbox,
      modifiedSince: this.normalizeApiDateParam(input.modifiedSince),
    };

    const response = await helpScoutClient.get<PaginatedResponse<Customer>>('/customers', params);
    const customers = response._embedded?.customers || [];

    // Slim view: strip _links and _embedded to keep response concise for browsing.
    // Use getCustomer for the full profile with all sub-resources.
    const slimResults = customers.map(c => {
      const formatted = this.formatCustomer(c);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _links, _embedded, ...slim } = formatted;
      // Extract primary email from _embedded for slim view.
      const emails = (_embedded as Record<string, unknown[]> | undefined)?.emails;
      if (Array.isArray(emails) && emails.length > 0) {
        slim.primaryEmail = (emails[0] as Record<string, unknown>).value;
      }
      return slim;
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: slimResults,
          returnedCount: customers.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: 'Use customer.id with getCustomer for full profile (includes emails, phones, address, etc.), or with searchConversations(customerIds) for their conversations.',
        }, null, 2),
      }],
    };
  }

  private extractV3NextCursor(links?: { next?: { href: string } }): string | undefined {
    const nextHref = links?.next?.href;
    if (!nextHref) return undefined;
    try {
      const url = new URL(nextHref);
      return url.searchParams.get('cursor') || nextHref;
    } catch (parseError) {
      logger.debug('Could not parse v3 next link as URL, using raw href as cursor', {
        nextHref,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      return nextHref;
    }
  }

  private async fetchCustomersV3(params: Record<string, unknown>): Promise<{
    customers: Customer[];
    links?: { self?: { href: string }; first?: { href: string }; next?: { href: string } };
    nextCursor?: string;
  }> {
    const v3Url = this.buildV3ApiUrl('/customers');
    const v3Response = await helpScoutClient.get<{
      _embedded: { customers: Customer[] };
      _links?: { self?: { href: string }; first?: { href: string }; next?: { href: string } };
    }>(v3Url, params);

    const customers = v3Response._embedded?.customers || [];
    const nextCursor = this.extractV3NextCursor(v3Response._links);

    return {
      customers,
      links: v3Response._links,
      nextCursor,
    };
  }

  // NAS-728: v3 Customer search with email filter
  private async searchCustomersByEmail(args: unknown): Promise<CallToolResult> {
    const input = SearchCustomersByEmailInputSchema.parse(args);

    const params: Record<string, unknown> = {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      query: input.query,
      modifiedSince: this.normalizeApiDateParam(input.modifiedSince),
      createdSince: this.normalizeApiDateParam(input.createdSince),
      cursor: input.cursor,
    };

    const { customers, nextCursor } = await this.fetchCustomersV3(params);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: customers.map(c => this.formatCustomer(c)),
          returnedCount: customers.length,
          searchedEmail: input.email,
          nextCursor,
          note: 'v3 API uses cursor-based pagination. Pass nextCursor value back as cursor parameter for more results.',
          usage: 'Use customer.id with getCustomer for full profile with sub-resources.',
        }, null, 2),
      }],
    };
  }

  // NAS-727: Customer sub-resource contacts tool
  private extractContactEntries(
    data: { _embedded?: Record<string, Array<{ id: number; value: string; type?: string }>> } | null,
    ...embeddedKeys: string[]
  ): Array<{ id: number; value: string; type?: string }> {
    if (!data?._embedded) return [];
    for (const key of embeddedKeys) {
      const entries = data._embedded[key];
      if (entries) return entries;
    }
    return [];
  }

  private async getCustomerContacts(args: unknown): Promise<CallToolResult> {
    const input = GetCustomerContactsInputSchema.parse(args);
    const cid = input.customerId;

    // Fetch all 6 sub-resources in parallel via dedicated endpoints
    const [emailsRes, phonesRes, chatsRes, socialRes, websitesRes, addressRes] = await Promise.allSettled([
      helpScoutClient.get<{ _embedded?: { emails?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/emails`),
      helpScoutClient.get<{ _embedded?: { phones?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/phones`),
      helpScoutClient.get<{ _embedded?: { chats?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/chats`),
      helpScoutClient.get<{ _embedded?: Record<string, Array<{ id: number; value: string; type: string }>> }>(`/customers/${cid}/social-profiles`),
      helpScoutClient.get<{ _embedded?: { websites?: Array<{ id: number; value: string }> } }>(`/customers/${cid}/websites`),
      helpScoutClient.get<CustomerAddress>(`/customers/${cid}/address`),
    ]);

    // Helper: extract data or note the error
    const extract = <T>(settled: PromiseSettledResult<T>, label: string): { data: T | null; error?: string } => {
      if (settled.status === 'fulfilled') return { data: settled.value };
      const reason = settled.reason;
      // 404 = no data on file (normal)
      if (isApiError(reason) && reason.code === 'NOT_FOUND') return { data: null };
      // Auth/rate limit errors should abort
      if (isApiError(reason) && (reason.code === 'UNAUTHORIZED' || reason.code === 'RATE_LIMIT')) throw reason;
      // Non-API errors (TypeError, ReferenceError, etc.) are programming bugs; propagate them
      if (!isApiError(reason)) throw reason;
      return { data: null, error: `${label} fetch failed (${reason.code}): ${reason.message}` };
    };

    const emails = extract(emailsRes, 'emails');
    const phones = extract(phonesRes, 'phones');
    const chats = extract(chatsRes, 'chats');
    const social = extract(socialRes, 'social profiles');
    const websites = extract(websitesRes, 'websites');
    const address = extract(addressRes, 'address');

    const result: Record<string, unknown> = {
      customerId: cid,
      emails: emails.data ? (emails.data._embedded?.emails || []).map((entry) => this.formatContactEntry(entry)) : [],
      phones: phones.data ? (phones.data._embedded?.phones || []).map((entry) => this.formatContactEntry(entry)) : [],
      chats: chats.data ? (chats.data._embedded?.chats || []).map((entry) => this.formatContactEntry(entry)) : [],
      socialProfiles: this.extractContactEntries(social.data, 'social-profiles', 'social_profiles').map((entry) => this.formatContactEntry(entry)),
      websites: websites.data ? (websites.data._embedded?.websites || []).map(e => ({ id: e.id, value: e.value })) : [],
      address: address.data ? this.formatAddress(address.data as CustomerAddress) : null,
    };

    // Collect any partial errors
    const errors = [emails, phones, chats, social, websites, address]
      .map(r => r.error).filter(Boolean);
    if (errors.length > 0) {
      logger.error('getCustomerContacts returned partial results', {
        customerId: cid,
        failedResources: errors,
        successCount: 6 - errors.length,
      });
      result.partialErrors = errors;
    }

    // Warn if all sub-resources returned no data (likely invalid customerId)
    const allEmpty = !emails.data && !phones.data && !chats.data && !social.data && !websites.data && !address.data;
    if (allEmpty && errors.length === 0) {
      result.warning = 'No contact data found. Verify the customerId exists using getCustomer.';
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...result,
          usage: 'This returns all contact channels for a customer. Use getCustomer for the full profile with demographics.',
        }, null, 2),
      }],
    };
  }

  // ── Organization Tools (NAS-684, NAS-712) ──

  private formatOrganization(org: Organization): Record<string, unknown> {
    return org as unknown as Record<string, unknown>;
  }

  private async getOrganization(args: unknown): Promise<CallToolResult> {
    const input = GetOrganizationInputSchema.parse(args);

    const params: Record<string, unknown> = {};
    if (input.includeCounts) params.includeCounts = true;
    if (input.includeProperties) params.includeProperties = true;

    const org = await helpScoutClient.get<Organization>(
      `/organizations/${input.organizationId}`,
      params
    );

    const orgResult = this.formatOrganization(org);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organization: orgResult,
          usage: 'NEXT STEPS: Use getOrganizationMembers to see customers in this org. Use getOrganizationConversations to see all conversations.',
        }, null, 2),
      }],
    };
  }

  private async listOrganizations(args: unknown): Promise<CallToolResult> {
    const input = ListOrganizationsInputSchema.parse(args);

    // v2 API: page size is fixed at 50
    const response = await helpScoutClient.get<PaginatedResponse<Organization>>('/organizations', {
      page: input.page,
      sort: `${input.sortField},${input.sortOrder}`,
    });

    const organizations = response._embedded?.organizations || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: organizations.map(org => this.formatOrganization(org)),
          returnedCount: organizations.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: 'Use organization.id with getOrganization for details, getOrganizationMembers for customers, or getOrganizationConversations for support history.',
        }, null, 2),
      }],
    };
  }

  // NAS-712: Customer-Org relational traversal
  private async getOrganizationMembers(args: unknown): Promise<CallToolResult> {
    const input = GetOrganizationMembersInputSchema.parse(args);

    // v2 API: page size is fixed at 50
    const response = await helpScoutClient.get<PaginatedResponse<Customer>>(
      `/organizations/${input.organizationId}/customers`,
      { page: input.page }
    );

    const customers = response._embedded?.customers || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organizationId: input.organizationId,
          members: customers.map(c => this.formatCustomer(c)),
          returnedCount: customers.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: 'Use customer.id with getCustomer for full profile or searchConversations(customerIds) for their conversations.',
        }, null, 2),
      }],
    };
  }

  private async getOrganizationConversations(args: unknown): Promise<CallToolResult> {
    const input = GetOrganizationConversationsInputSchema.parse(args);

    // v2 API: page size is fixed at 50
    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>(
      `/organizations/${input.organizationId}/conversations`,
      { page: input.page }
    );

    const conversations = response._embedded?.conversations || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organizationId: input.organizationId,
          conversations: conversations.map(c => ({
            id: c.id,
            number: c.number,
            subject: c.subject,
            status: c.status,
            customer: c.customer,
            assignee: c.assignee,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            closedAt: c.closedAt,
            tags: c.tags,
          })),
          returnedCount: conversations.length,
          pagination: response.page,
          nextPage: getNextPage(response.page),
          usage: 'Use conversation.id with getThreads to read full message history, or getConversationSummary for a quick overview.',
        }, null, 2),
      }],
    };
  }
}

export const toolHandler = new ToolHandler();
