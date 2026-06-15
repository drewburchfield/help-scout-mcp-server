import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PaginatedResponse, helpScoutClient } from '../utils/helpscout-client.js';
import { createMcpToolError, isApiError } from '../utils/mcp-errors.js';
import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { REDACTED_MESSAGE_BODY } from '../utils/constants.js';
import { z } from 'zod';
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
  Team,
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
  SearchInboxesInputSchema,
  SearchConversationsInputSchema,
  GetThreadsInputSchema,
  GetConversationSummaryInputSchema,
  AdvancedConversationSearchInputSchema,
  MultiStatusConversationSearchInputSchema,
  StructuredConversationFilterInputSchema,
  GetCustomerInputSchema,
  ListCustomersInputSchema,
  SearchCustomersByEmailInputSchema,
  GetCustomerContactsInputSchema,
  ListAllInboxesInputSchema,
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
  ListInboxCustomFieldsInputSchema,
  ListInboxFoldersInputSchema,
  ListSavedRepliesInputSchema,
  GetSavedReplyInputSchema,
  GetOriginalSourceInputSchema,
  GetAttachmentInputSchema,
  ListWorkflowsInputSchema,
  ListWebhooksInputSchema,
  GetWebhookInputSchema,
  GetSatisfactionRatingInputSchema,
  GetCompanyReportInputSchema,
  GetConversationsReportInputSchema,
  GetHappinessReportInputSchema,
  GetHappinessRatingsReportInputSchema,
  GetProductivityReportInputSchema,
  GetProductivityFirstResponseTimeReportInputSchema,
  GetProductivityRepliesSentReportInputSchema,
  GetProductivityResolutionTimeReportInputSchema,
  GetProductivityResolvedReportInputSchema,
  GetProductivityResponseTimeReportInputSchema,
  GetUserReportInputSchema,
  GetUserConversationHistoryReportInputSchema,
  GetUserCustomersHelpedReportInputSchema,
  GetUserDrilldownReportInputSchema,
  GetUserHappinessReportInputSchema,
  GetUserRatingsReportInputSchema,
  GetUserRepliesReportInputSchema,
  GetUserResolutionsReportInputSchema,
  GetUserChatReportInputSchema,
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

export class ToolHandler {
  private callHistory: string[] = [];

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

  private appendQueryClause(existingQuery: string | undefined, clause: string): string {
    return existingQuery ? `(${existingQuery}) AND (${clause})` : `(${clause})`;
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
            page: {
              type: 'number',
              minimum: 1,
              default: 1,
              description: 'Page number',
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
            page: {
              type: 'number',
              minimum: 1,
              default: 1,
              description: 'Page number',
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
            page: {
              type: 'number',
              minimum: 1,
              default: 1,
              description: 'Page number',
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
            page: {
              type: 'number',
              minimum: 1,
              default: 1,
              description: 'Page number',
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
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
          anyOf: [
            { required: ['assignedTo'] },
            { required: ['folderId'] },
            { required: ['customerIds'] },
            { required: ['conversationNumber'] },
            {
              required: ['sortBy'],
              properties: {
                sortBy: { type: 'string', enum: ['waitingSince', 'customerName', 'customerEmail'] },
              },
            },
          ],
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
        description: 'List or search customers by name, query syntax, or modification date. Page-based pagination (v2 API).',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: { type: 'string', description: 'Filter by first name' },
            lastName: { type: 'string', description: 'Filter by last name' },
            query: { type: 'string', description: 'Advanced query syntax, e.g. (email:"john@example.com")' },
            mailbox: { type: 'number', description: 'Filter by inbox ID' },
            modifiedSince: { type: 'string', description: 'ISO 8601 date - only customers modified after this date' },
            sortField: { type: 'string', enum: ['createdAt', 'firstName', 'lastName', 'modifiedAt'], default: 'createdAt' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (API returns 50 results per page)' },
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
        description: 'List Help Scout users with optional exact email or inbox filter. Use to discover assignee IDs, mentions, and roles.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Exact user email filter' },
            inboxId: { type: 'string', description: 'Inbox ID to find users with access to that inbox' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
          },
        },
      },
      {
        name: 'getUser',
        description: 'Get a Help Scout user by ID, or pass "me" to get the authenticated resource owner.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'User ID from listUsers, or "me" for the authenticated resource owner' },
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
        name: 'listInboxCustomFields',
        description: 'List custom field definitions for an inbox, including dropdown option IDs used by conversation filters and updates.',
        inputSchema: {
          type: 'object',
          properties: {
            inboxId: { type: 'string', description: 'Inbox ID from listAllInboxes or server instructions' },
          },
          required: ['inboxId'],
        },
      },
      {
        name: 'listInboxFolders',
        description: 'List Help Scout folders for an inbox. Use to discover folder IDs and counts before folder-scoped lookups.',
        inputSchema: {
          type: 'object',
          properties: {
            inboxId: { type: 'string', description: 'Inbox ID from listAllInboxes or server instructions' },
          },
          required: ['inboxId'],
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
        description: 'Get the original source JSON for a Help Scout conversation thread.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Conversation ID from searchConversations or getConversationSummary' },
            threadId: { type: 'string', description: 'Thread ID from getThreads' },
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
        description: 'Get the Help Scout company overall report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getConversationsReport',
        description: 'Get the Help Scout conversations overall report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getHappinessReport',
        description: 'Get the Help Scout happiness overall report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getHappinessRatingsReport',
        description: 'Get Help Scout happiness rating rows for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
            sortField: { type: 'string', enum: ['number', 'modifiedAt', 'rating'], default: 'modifiedAt' },
            sortOrder: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' },
            rating: { type: 'string', enum: ['great', 'ok', 'all', 'not-good'], description: 'Rating value filter' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getProductivityReport',
        description: 'Get the Help Scout productivity overall report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getProductivityFirstResponseTimeReport',
        description: 'Get Help Scout productivity first response time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getProductivityRepliesSentReport',
        description: 'Get Help Scout productivity replies sent time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getProductivityResolutionTimeReport',
        description: 'Get Help Scout productivity resolution time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getProductivityResolvedReport',
        description: 'Get Help Scout productivity resolved conversations time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getProductivityResponseTimeReport',
        description: 'Get Help Scout productivity response time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'getUserReport',
        description: 'Get the Help Scout user or team overall report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserConversationHistoryReport',
        description: 'Get Help Scout user conversation history rows for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            status: { type: 'string', enum: ['active', 'pending', 'closed'], description: 'Conversation status filter' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
            sortField: { type: 'string', enum: ['number', 'repliesSent', 'responseTime', 'resolveTime'], default: 'number' },
            sortOrder: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'], default: 'DESC' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserCustomersHelpedReport',
        description: 'Get Help Scout user customers helped time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserDrilldownReport',
        description: 'Get Help Scout user report drilldown conversations for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
            rows: { type: 'number', minimum: 1, maximum: 50, default: 25, description: 'Rows per page' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserHappinessReport',
        description: 'Get Help Scout user happiness report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserRatingsReport',
        description: 'Get Help Scout user happiness rating rows for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number' },
            sortField: { type: 'string', enum: ['number', 'modifiedAt', 'rating'] },
            sortOrder: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'] },
            rating: { type: 'string', enum: ['great', 'ok', 'all', 'not-good'], description: 'Rating filter' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserRepliesReport',
        description: 'Get Help Scout user replies time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserResolutionsReport',
        description: 'Get Help Scout user resolutions time series for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            types: { type: 'array', items: { type: 'string', enum: ['email', 'chat', 'phone'] }, description: 'Conversation types to filter by' },
            folders: { type: 'array', items: { type: 'string' }, description: 'Folder IDs to filter by' },
            viewBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Report granularity' },
          },
          required: ['user', 'start', 'end'],
        },
      },
      {
        name: 'getUserChatReport',
        description: 'Get Help Scout user or team chat report for a bounded time range.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'User ID or team ID for the report' },
            start: { type: 'string', description: 'Start of the reporting interval, ISO 8601' },
            end: { type: 'string', description: 'End of the reporting interval, ISO 8601' },
            previousStart: { type: 'string', description: 'Optional comparison interval start, ISO 8601' },
            previousEnd: { type: 'string', description: 'Optional comparison interval end, ISO 8601' },
            mailboxes: { type: 'array', items: { type: 'string' }, description: 'Inbox IDs to filter by' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to filter by' },
            officeHours: { type: 'boolean', description: 'Whether to take office hours into consideration' },
          },
          required: ['user', 'start', 'end'],
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
      argumentKeys: Object.keys(request.params.arguments || {}).filter(key => key !== '__userQuery'),
    });

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
        case 'getCustomer':
          result = await this.getCustomer(request.params.arguments || {});
          break;
        case 'listCustomers':
          result = await this.listCustomers(request.params.arguments || {});
          break;
        case 'searchCustomersByEmail':
          result = await this.searchCustomersByEmail(request.params.arguments || {});
          break;
        case 'getCustomerContacts':
          result = await this.getCustomerContacts(request.params.arguments || {});
          break;
        case 'getOrganization':
          result = await this.getOrganization(request.params.arguments || {});
          break;
        case 'listOrganizations':
          result = await this.listOrganizations(request.params.arguments || {});
          break;
        case 'getOrganizationMembers':
          result = await this.getOrganizationMembers(request.params.arguments || {});
          break;
        case 'getOrganizationConversations':
          result = await this.getOrganizationConversations(request.params.arguments || {});
          break;
        case 'listCustomerProperties':
          result = await this.listCustomerProperties(request.params.arguments || {});
          break;
        case 'listOrganizationProperties':
          result = await this.listOrganizationProperties(request.params.arguments || {});
          break;
        case 'getOrganizationProperty':
          result = await this.getOrganizationProperty(request.params.arguments || {});
          break;
        case 'listTags':
          result = await this.listTags(request.params.arguments || {});
          break;
        case 'getTag':
          result = await this.getTag(request.params.arguments || {});
          break;
        case 'listUsers':
          result = await this.listUsers(request.params.arguments || {});
          break;
        case 'getUser':
          result = await this.getUser(request.params.arguments || {});
          break;
        case 'listTeams':
          result = await this.listTeams(request.params.arguments || {});
          break;
        case 'getTeamMembers':
          result = await this.getTeamMembers(request.params.arguments || {});
          break;
        case 'listInboxCustomFields':
          result = await this.listInboxCustomFields(request.params.arguments || {});
          break;
        case 'listInboxFolders':
          result = await this.listInboxFolders(request.params.arguments || {});
          break;
        case 'listSavedReplies':
          result = await this.listSavedReplies(request.params.arguments || {});
          break;
        case 'getSavedReply':
          result = await this.getSavedReply(request.params.arguments || {});
          break;
        case 'getOriginalSource':
          result = await this.getOriginalSource(request.params.arguments || {});
          break;
        case 'getAttachment':
          result = await this.getAttachment(request.params.arguments || {});
          break;
        case 'listWorkflows':
          result = await this.listWorkflows(request.params.arguments || {});
          break;
        case 'listWebhooks':
          result = await this.listWebhooks(request.params.arguments || {});
          break;
        case 'getWebhook':
          result = await this.getWebhook(request.params.arguments || {});
          break;
        case 'getSatisfactionRating':
          result = await this.getSatisfactionRating(request.params.arguments || {});
          break;
        case 'getCompanyReport':
          result = await this.getCompanyReport(request.params.arguments || {});
          break;
        case 'getConversationsReport':
          result = await this.getConversationsReport(request.params.arguments || {});
          break;
        case 'getHappinessReport':
          result = await this.getHappinessReport(request.params.arguments || {});
          break;
        case 'getHappinessRatingsReport':
          result = await this.getHappinessRatingsReport(request.params.arguments || {});
          break;
        case 'getProductivityReport':
          result = await this.getProductivityReport(request.params.arguments || {});
          break;
        case 'getProductivityFirstResponseTimeReport':
          result = await this.getProductivityFirstResponseTimeReport(request.params.arguments || {});
          break;
        case 'getProductivityRepliesSentReport':
          result = await this.getProductivityRepliesSentReport(request.params.arguments || {});
          break;
        case 'getProductivityResolutionTimeReport':
          result = await this.getProductivityResolutionTimeReport(request.params.arguments || {});
          break;
        case 'getProductivityResolvedReport':
          result = await this.getProductivityResolvedReport(request.params.arguments || {});
          break;
        case 'getProductivityResponseTimeReport':
          result = await this.getProductivityResponseTimeReport(request.params.arguments || {});
          break;
        case 'getUserReport':
          result = await this.getUserReport(request.params.arguments || {});
          break;
        case 'getUserConversationHistoryReport':
          result = await this.getUserConversationHistoryReport(request.params.arguments || {});
          break;
        case 'getUserCustomersHelpedReport':
          result = await this.getUserCustomersHelpedReport(request.params.arguments || {});
          break;
        case 'getUserDrilldownReport':
          result = await this.getUserDrilldownReport(request.params.arguments || {});
          break;
        case 'getUserHappinessReport':
          result = await this.getUserHappinessReport(request.params.arguments || {});
          break;
        case 'getUserRatingsReport':
          result = await this.getUserRatingsReport(request.params.arguments || {});
          break;
        case 'getUserRepliesReport':
          result = await this.getUserRepliesReport(request.params.arguments || {});
          break;
        case 'getUserResolutionsReport':
          result = await this.getUserResolutionsReport(request.params.arguments || {});
          break;
        case 'getUserChatReport':
          result = await this.getUserChatReport(request.params.arguments || {});
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

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
      
      // Enhance result with API constraint guidance (best-effort: never turn a success into a failure)
      let guidanceProvided = false;
      try {
        const originalContent = JSON.parse(firstContent.text);
        const guidance = HelpScoutAPIConstraints.generateToolGuidance(
          request.params.name,
          originalContent,
          validationContext
        );

        if (guidance.length > 0) {
          originalContent.apiGuidance = guidance;
          result.content[0] = {
            type: 'text',
            text: JSON.stringify(originalContent, null, 2)
          };
          guidanceProvided = true;
        }
      } catch (guidanceError) {
        logger.warn('Failed to inject API guidance into tool response', {
          requestId,
          toolName: request.params.name,
          error: guidanceError instanceof Error ? guidanceError.message : String(guidanceError),
        });
      }

      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
        validationPassed: true,
        guidanceProvided
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
      page: input.page,
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
            totalAvailable: response.page?.totalElements ?? inboxes.length,
            pagination: response.page,
            nextPage: getNextPage(response.page),
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

    const baseParams: Record<string, unknown> = {
      page: input.page,
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
      results: conversations,
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
    
    const response = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      {
        page: input.page,
        size: input.limit,
      }
    );

    const threads = (response._embedded?.threads || []).slice(0, input.limit);
    
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
            pagination: response.page,
            nextPage: getNextPage(response.page),
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
    const params: Record<string, unknown> = { page: input.page };
    if (input.email) params.email = input.email;
    if (input.inboxId) params.mailbox = Number(input.inboxId);

    const response = await helpScoutClient.get<PaginatedResponse<User>>('/users', params);
    const users = response._embedded?.users || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
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
        }, null, 2),
      }],
    };
  }

  private async getUser(args: unknown): Promise<CallToolResult> {
    const input = GetUserInputSchema.parse(args);
    const path = input.userId === 'me' ? '/users/me' : `/users/${input.userId}`;
    const user = await helpScoutClient.get<User>(path);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          user,
          usage: 'Use user.id for assignment, assignee filters, and user/team report filters.',
        }, null, 2),
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

  private async listInboxCustomFields(args: unknown): Promise<CallToolResult> {
    const input = ListInboxCustomFieldsInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<InboxCustomField>>(`/mailboxes/${input.inboxId}/fields`);
    const fields = response._embedded?.fields || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          inboxId: input.inboxId,
          fields,
          totalFields: fields.length,
          pagination: response.page,
          usage: fields.length > 0
            ? 'Use field.id and dropdown option IDs when filtering or interpreting custom field values.'
            : 'No custom fields returned for this inbox.',
        }, null, 2),
      }],
    };
  }

  private async listInboxFolders(args: unknown): Promise<CallToolResult> {
    const input = ListInboxFoldersInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<InboxFolder>>(`/mailboxes/${input.inboxId}/folders`);
    const folders = response._embedded?.folders || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          inboxId: input.inboxId,
          folders,
          totalFolders: folders.length,
          pagination: response.page,
          usage: folders.length > 0
            ? 'Use folder.id with structuredConversationFilter for folder-scoped lookups.'
            : 'No folders returned for this inbox.',
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
    if (config.security.redactMessageContent) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threadId: input.threadId,
            originalSource: REDACTED_MESSAGE_BODY,
            usage: 'Original source content is hidden because REDACT_MESSAGE_CONTENT is enabled.',
          }, null, 2),
        }],
      };
    }

    const originalSource = await helpScoutClient.get<Record<string, unknown>>(
      `/conversations/${input.conversationId}/threads/${input.threadId}/original-source`
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          conversationId: input.conversationId,
          threadId: input.threadId,
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
    const input = GetCompanyReportInputSchema.parse(args);
    const params = this.buildReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/company', params);

    return this.formatReportResult('company', params, report);
  }

  private async getConversationsReport(args: unknown): Promise<CallToolResult> {
    const input = GetConversationsReportInputSchema.parse(args);
    const params = this.buildReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/conversations', params);

    return this.formatReportResult('conversations', params, report);
  }

  private async getHappinessReport(args: unknown): Promise<CallToolResult> {
    const input = GetHappinessReportInputSchema.parse(args);
    const params = this.buildReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/happiness', params);

    return this.formatReportResult('happiness', params, report);
  }

  private async getHappinessRatingsReport(args: unknown): Promise<CallToolResult> {
    const input = GetHappinessRatingsReportInputSchema.parse(args);
    const params = {
      ...this.buildReportQueryParams(input),
      page: input.page,
      sortField: input.sortField,
      sortOrder: input.sortOrder,
      ...(input.rating ? { rating: input.rating } : {}),
    };
    const report = await helpScoutClient.get<HappinessRatingsReport>('/reports/happiness/ratings', params);

    return this.formatReportResult('happinessRatings', params, report);
  }

  private async getProductivityReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityReportInputSchema.parse(args);
    const params = this.buildProductivityReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/productivity', params);

    return this.formatReportResult('productivity', params, report);
  }

  private async getProductivityFirstResponseTimeReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityFirstResponseTimeReportInputSchema.parse(args);
    const params = this.buildProductivityReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/productivity/first-response-time', params);

    return this.formatReportResult('productivityFirstResponseTime', params, report);
  }

  private async getProductivityRepliesSentReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityRepliesSentReportInputSchema.parse(args);
    const params = this.buildProductivityReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/productivity/replies-sent', params);

    return this.formatReportResult('productivityRepliesSent', params, report);
  }

  private async getProductivityResolutionTimeReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityResolutionTimeReportInputSchema.parse(args);
    const params = this.buildProductivityReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/productivity/resolution-time', params);

    return this.formatReportResult('productivityResolutionTime', params, report);
  }

  private async getProductivityResolvedReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityResolvedReportInputSchema.parse(args);
    const params = this.buildProductivityReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/productivity/resolved', params);

    return this.formatReportResult('productivityResolved', params, report);
  }

  private async getProductivityResponseTimeReport(args: unknown): Promise<CallToolResult> {
    const input = GetProductivityResponseTimeReportInputSchema.parse(args);
    const params = this.buildProductivityReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/productivity/response-time', params);

    return this.formatReportResult('productivityResponseTime', params, report);
  }

  private async getUserReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user', params);

    return this.formatReportResult('user', params, report);
  }

  private async getUserConversationHistoryReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserConversationHistoryReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/conversation-history', params);

    return this.formatReportResult('userConversationHistory', params, report);
  }

  private async getUserCustomersHelpedReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserCustomersHelpedReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/customers-helped', params);

    return this.formatReportResult('userCustomersHelped', params, report);
  }

  private async getUserDrilldownReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserDrilldownReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/drilldown', params);

    return this.formatReportResult('userDrilldown', params, report);
  }

  private async getUserHappinessReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserHappinessReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/happiness', params);

    return this.formatReportResult('userHappiness', params, report);
  }

  private async getUserRatingsReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserRatingsReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/ratings', params);

    return this.formatReportResult('userRatings', params, report);
  }

  private async getUserRepliesReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserRepliesReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/replies', params);

    return this.formatReportResult('userReplies', params, report);
  }

  private async getUserResolutionsReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserResolutionsReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/resolutions', params);

    return this.formatReportResult('userResolutions', params, report);
  }

  private async getUserChatReport(args: unknown): Promise<CallToolResult> {
    const input = GetUserChatReportInputSchema.parse(args);
    const params = this.buildUserReportQueryParams(input);
    const report = await helpScoutClient.get<ReportResponse>('/reports/user/chat', params);

    return this.formatReportResult('userChat', params, report);
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

  private async advancedConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = AdvancedConversationSearchInputSchema.parse(args);

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
      page: input.page,
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

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter,
      input.createdBefore
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    let conversations: Conversation[];
    let paginationInfo: unknown;
    let nextPage: number | null = null;
    let searchedStatuses: string[];

    if (input.status) {
      const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
        ...queryParams,
        status: input.status,
      });
      conversations = response._embedded?.conversations || [];
      paginationInfo = response.page;
      nextPage = getNextPage(response.page);
      searchedStatuses = [input.status];
    } else {
      const statusResult = await this.searchConversationStatusSet(
        queryParams,
        DEFAULT_CONVERSATION_STATUSES,
        input.limit || 50,
      );
      conversations = statusResult.conversations;
      paginationInfo = statusResult.pagination;
      searchedStatuses = statusResult.searchedStatuses;
    }

    let clientSideFiltered = false;
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'advancedConversationSearch');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    if (clientSideFiltered) {
      if (input.status) {
        paginationInfo = this.buildFilteredPagination(
          conversations.length,
          paginationInfo as { totalElements?: number } | undefined,
          true
        );
      } else {
        const merged = paginationInfo as {
          totalAvailable?: number;
          totalByStatus?: Record<string, number>;
          errors?: Array<{ status: string; message: string; code: string }>;
          note?: string;
        };
        paginationInfo = {
          totalResults: conversations.length,
          totalAvailable: merged.totalAvailable,
          totalByStatus: merged.totalByStatus,
          errors: merged.errors,
          note: `Client-side createdBefore filter applied to merged results. totalResults shows filtered count (${conversations.length}), totalAvailable shows pre-filter total (${merged.totalAvailable}). ${merged.note || ''}`
        };
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: conversations,
            searchQuery: queryString,
            inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
            searchCriteria: {
              contentTerms: input.contentTerms,
              subjectTerms: input.subjectTerms,
              customerEmail: input.customerEmail,
              emailDomain: input.emailDomain,
              tags: input.tags,
              status: input.status,
            },
            statusesSearched: searchedStatuses,
            pagination: paginationInfo,
            nextPage,
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
    const allResults: Array<{
      status: string;
      totalCount: number;
      totalCountBeforeFilter?: number;
      conversations: Conversation[];
      searchQuery: string;
      filteredByCreatedBefore?: boolean;
      error?: string;
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
        // Use type guard instead of unsafe cast
        if (!isApiError(error)) {
          // Non-API errors (TypeError, network failures) should not be silently swallowed
          logger.error('Unexpected non-API error in multi-status search', {
            status,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        // Critical API errors should fail the entire operation.
        if (error.code === 'UNAUTHORIZED' || error.code === 'INVALID_INPUT') {
          logger.error('Critical API error in multi-status search - aborting', {
            status,
            errorCode: error.code,
            message: error.message
          });
          throw error;
        }

        // Non-critical API errors: log and include in response
        logger.error('Status search failed - partial results will be returned', {
          status,
          errorCode: error.code,
          message: error.message,
          note: 'This status will be excluded from results'
        });

        allResults.push({
          status,
          totalCount: 0,
          conversations: [],
          searchQuery,
          error: `Search failed (${error.code}): ${error.message}`,
        });
      }
    }

    return allResults;
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
    const queryWithDate = this.appendCreatedAtFilter(
      params.searchQuery,
      params.createdAfter,
      params.createdBefore
    );

    const queryParams: Record<string, unknown> = {
      page: 1,
      size: params.limitPerStatus,
      sortField: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
      sortOrder: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
      query: queryWithDate || params.searchQuery,
      status: params.status,
    };

    if (params.inboxId) {
      queryParams.mailbox = params.inboxId;
    }

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];
    const apiTotalElements = response.page?.totalElements || conversations.length;

    let filteredByDate = false;
    if (params.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, params.createdBefore, `searchSingleStatus(${params.status})`);
      conversations = result.filtered;
      filteredByDate = result.wasFiltered;
    }

    return {
      status: params.status,
      totalCount: filteredByDate ? conversations.length : apiTotalElements,
      totalCountBeforeFilter: filteredByDate ? apiTotalElements : undefined,
      conversations,
      searchQuery: params.searchQuery,
      filteredByCreatedBefore: filteredByDate,
    };
  }

  /**
   * Format comprehensive search results into summary response
   */
  private formatComprehensiveSearchResults(
    allResults: Array<{
      status: string;
      totalCount: number;
      totalCountBeforeFilter?: number;
      conversations: Conversation[];
      searchQuery: string;
      filteredByCreatedBefore?: boolean;
      error?: string;
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
    const hasClientSideFiltering = allResults.some(r => r.filteredByCreatedBefore);
    const totalBeforeFilter = hasClientSideFiltering
      ? allResults.reduce((sum, result) => sum + (result.totalCountBeforeFilter || result.totalCount), 0)
      : undefined;

    return {
      searchTerms: input.searchTerms,
      searchQuery,
      searchIn: input.searchIn,
      inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
      timeframe: {
        createdAfter,
        createdBefore: input.createdBefore,
        days: input.timeframeDays,
      },
      totalConversationsFound: totalConversations,
      totalAvailableAcrossStatuses: totalAvailable,
      totalBeforeClientSideFiltering: totalBeforeFilter,
      clientSideFilteringApplied: hasClientSideFiltering ?
        `createdBefore filter applied - totalConversationsFound (${totalConversations}) reflects filtered results, totalBeforeClientSideFiltering (${totalBeforeFilter}) shows pre-filter API totals` : undefined,
      failedStatuses: allResults.filter(r => r.error).map(r => `[WARNING] Status "${r.status}" search failed: ${r.error}`),
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
      page: input.page,
      size: input.limit,
      sortField: input.sortBy,
      sortOrder: input.sortOrder,
    };

    // Apply unique structural filters
    if (input.assignedTo !== undefined && input.assignedTo !== -1) {
      queryParams.assigned_to = input.assignedTo;
    }
    if (input.folderId !== undefined) queryParams.folder = input.folderId;
    if (input.conversationNumber !== undefined) queryParams.number = input.conversationNumber;

    if (input.assignedTo === -1) {
      queryParams.query = this.appendQueryClause(queryParams.query as string | undefined, 'assigned:"Unassigned"');
    }

    // Apply customerIds via query syntax if provided
    if (input.customerIds && input.customerIds.length > 0) {
      queryParams.query = this.appendQueryClause(
        queryParams.query as string | undefined,
        input.customerIds.map(id => `customerIds:${id}`).join(' OR ')
      );
    }

    // Apply combination filters
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) queryParams.mailbox = effectiveInboxId;
    const shouldSearchDefaultStatuses = input.status === 'all';
    if (!shouldSearchDefaultStatuses) {
      queryParams.status = input.status;
    }
    if (input.tag) queryParams.tag = input.tag;
    if (input.modifiedSince) queryParams.modifiedSince = this.normalizeApiDateParam(input.modifiedSince);

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter,
      input.createdBefore
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    let conversations: Conversation[];
    let paginationInfo: unknown;
    let nextPage: number | null = null;
    let searchedStatuses: string[];

    if (shouldSearchDefaultStatuses) {
      const statusResult = await this.searchConversationStatusSet(
        queryParams,
        DEFAULT_CONVERSATION_STATUSES,
        input.limit,
      );
      conversations = statusResult.conversations;
      paginationInfo = statusResult.pagination;
      searchedStatuses = statusResult.searchedStatuses;
    } else {
      const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
      conversations = response._embedded?.conversations || [];
      paginationInfo = response.page;
      nextPage = getNextPage(response.page);
      searchedStatuses = [input.status];
    }

    let clientSideFiltered = false;
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'structuredConversationFilter');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    if (clientSideFiltered) {
      if (shouldSearchDefaultStatuses) {
        const merged = paginationInfo as {
          totalAvailable?: number;
          totalByStatus?: Record<string, number>;
          errors?: Array<{ status: string; message: string; code: string }>;
          note?: string;
        };
        paginationInfo = {
          totalResults: conversations.length,
          totalAvailable: merged.totalAvailable,
          totalByStatus: merged.totalByStatus,
          errors: merged.errors,
          note: `Client-side createdBefore filter applied to merged results. totalResults shows filtered count (${conversations.length}), totalAvailable shows pre-filter total (${merged.totalAvailable}). ${merged.note || ''}`
        };
      } else {
        paginationInfo = this.buildFilteredPagination(
          conversations.length,
          paginationInfo as { totalElements?: number } | undefined,
          true
        );
      }
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
            status: input.status,
          },
          inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
          statusesSearched: searchedStatuses,
          pagination: paginationInfo,
          nextPage,
          clientSideFiltering: clientSideFiltered ? `createdBefore filter removed ${originalCount - conversations.length} of ${originalCount} results` : undefined,
          note: 'Structural filtering applied. For content-based search or rep activity, use comprehensiveConversationSearch.',
        }, null, 2),
      }],
    };
  }

  // ── Customer Tools (NAS-680, NAS-727) ──

  private formatAddress(address: CustomerAddress): Record<string, unknown> {
    return address as unknown as Record<string, unknown>;
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
          usage: 'NEXT STEPS: Use organizationId to explore their org with getOrganization. Use customer.id with structuredConversationFilter(customerIds) to find their conversations.',
        }, null, 2),
      }],
    };
  }

  private async listCustomers(args: unknown): Promise<CallToolResult> {
    const input = ListCustomersInputSchema.parse(args);

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
          usage: 'Use customer.id with getCustomer for full profile (includes emails, phones, address, etc.), or with structuredConversationFilter(customerIds) for their conversations.',
        }, null, 2),
      }],
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

    // v3 endpoint: construct absolute URL from configured base URL
    const v3Url = config.helpscout.baseUrl.replace(/\/v2\/?$/, '/v3/customers');
    if (v3Url === config.helpscout.baseUrl) {
      logger.warn('v3 URL construction: baseUrl did not match /v2/ pattern, URL may be incorrect', { baseUrl: config.helpscout.baseUrl, v3Url });
    }
    const v3Response = await helpScoutClient.get<{
      _embedded: { customers: Customer[] };
      _links?: { next?: { href: string } };
    }>(v3Url, params);

    const customers = v3Response._embedded?.customers || [];

    // Extract cursor token from v3 next link (full URL -> just the cursor param value)
    let nextCursor: string | undefined;
    const nextHref = v3Response._links?.next?.href;
    if (nextHref) {
      try {
        const url = new URL(nextHref);
        nextCursor = url.searchParams.get('cursor') || nextHref;
      } catch (parseError) {
        logger.debug('Could not parse v3 next link as URL, using raw href as cursor', {
          nextHref,
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        nextCursor = nextHref;
      }
    }

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
  private async getCustomerContacts(args: unknown): Promise<CallToolResult> {
    const input = GetCustomerContactsInputSchema.parse(args);
    const cid = input.customerId;

    // Fetch all 6 sub-resources in parallel via dedicated endpoints
    const [emailsRes, phonesRes, chatsRes, socialRes, websitesRes, addressRes] = await Promise.allSettled([
      helpScoutClient.get<{ _embedded?: { emails?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/emails`),
      helpScoutClient.get<{ _embedded?: { phones?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/phones`),
      helpScoutClient.get<{ _embedded?: { chats?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/chats`),
      helpScoutClient.get<{ _embedded?: { social_profiles?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/social-profiles`),
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

    const formatEntry = (e: { id: number; value: string; type?: string }) => ({
      id: e.id, value: e.value, ...(e.type ? { type: e.type } : {}),
    });

    const result: Record<string, unknown> = {
      customerId: cid,
      emails: emails.data ? (emails.data._embedded?.emails || []).map(formatEntry) : [],
      phones: phones.data ? (phones.data._embedded?.phones || []).map(formatEntry) : [],
      chats: chats.data ? (chats.data._embedded?.chats || []).map(formatEntry) : [],
      socialProfiles: social.data ? (social.data._embedded?.social_profiles || []).map(formatEntry) : [],
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
          usage: 'Use customer.id with getCustomer for full profile or structuredConversationFilter(customerIds) for their conversations.',
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
