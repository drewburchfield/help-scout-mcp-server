import { z } from 'zod';

// Help Scout API Types
export const InboxSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ConversationSchema = z.object({
  id: z.number(),
  number: z.number(),
  subject: z.string(),
  status: z.enum(['active', 'pending', 'closed', 'spam']),
  state: z.enum(['published', 'draft']),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  assignee: z.object({
    id: z.number(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
  }).nullable(),
  customer: z.object({
    id: z.number(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
  }),
  mailbox: z.object({
    id: z.number(),
    name: z.string(),
  }),
  tags: z.array(z.object({
    id: z.number(),
    name: z.string(),
    color: z.string(),
  })),
  threads: z.number(),
});

export const ThreadSchema = z.object({
  id: z.number(),
  type: z.enum(['customer', 'note', 'lineitem', 'phone', 'message']),
  status: z.enum(['active', 'pending', 'closed', 'spam']),
  state: z.enum(['published', 'draft', 'hidden']),
  action: z.object({
    type: z.string(),
    text: z.string(),
  }).nullable(),
  body: z.string(),
  source: z.object({
    type: z.string(),
    via: z.string(),
  }),
  customer: z.object({
    id: z.number(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
  }).nullable(),
  createdBy: z.object({
    id: z.number(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
  }).nullable(),
  assignedTo: z.object({
    id: z.number(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
  }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// MCP Tool Input Schemas
export const SearchConversationsInputSchema = z.object({
  // Raw Help Scout query passthrough (power users). Convenience params below are
  // compiled into this query syntax automatically, so most callers never need it.
  query: z.string().optional(),
  // Content/metadata convenience filters (compiled into the `query=()` syntax):
  contentTerms: z.array(z.string()).optional().describe('Match these terms in the message body (body:"term")'),
  subjectTerms: z.array(z.string()).optional().describe('Match these terms in the subject (subject:"term")'),
  email: z.string().optional().describe('Match conversations involving this email (to/cc/bcc or customer)'),
  emailDomain: z.string().optional().describe('Match conversations involving any email at this domain'),
  customerIds: z.array(z.number().int().min(0)).max(100).optional().describe('Conversations belonging to these customer IDs (customer -> conversations bridge)'),
  hasAttachments: z.boolean().optional().describe('Only conversations with attachments'),
  // Documented top-level structured filters:
  inboxId: z.string().optional().describe('Inbox (mailbox) ID'),
  folderId: z.number().int().min(0).optional().describe('Folder ID'),
  tag: z.string().optional().describe('Tag name (comma-separated for multiple)'),
  assignedTo: z.number().int().min(-1).optional().describe('Assignee user ID (-1 = unassigned)'),
  conversationNumber: z.number().int().min(1).optional().describe('Look up by conversation number'),
  status: z.enum(['active', 'pending', 'closed', 'open', 'spam', 'all']).optional().describe('Conversation status; omit to search active+pending+closed (excludes spam)'),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  modifiedSince: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1),
  sort: z.enum(['createdAt', 'modifiedAt', 'number', 'waitingSince', 'customerName', 'customerEmail', 'mailboxid', 'status', 'subject', 'score']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  fields: z.array(z.string()).optional(),
});

export const GetThreadsInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
  limit: z.number().int().min(1).max(200).default(200),
  page: z.number().int().min(1).default(1),
  includeSystemActors: z
    .boolean()
    .default(false)
    .describe('When true, routes to the v3 threads endpoint, which preserves the user, team, and system_user person types (v2 collapses system_user into user).'),
});

export const GetConversationInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
  embed: z.enum(['threads']).optional(),
  includeSystemActors: z
    .boolean()
    .default(false)
    .describe('When true, routes to the v3 conversation endpoint, which preserves the user, team, and system_user person types (v2 collapses system_user into user).'),
});

export const GetConversationSummaryInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
});

// Customer API Types

// Shared schema for contact sub-resources (emails, phones, chats, social profiles)
const ContactEntrySchema = z.object({ id: z.number(), value: z.string(), type: z.string() });

export const CustomerSchema = z.object({
  id: z.number(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  gender: z.string().optional(),
  jobTitle: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  organizationId: z.number().nullable().optional(),
  photoType: z.string().optional(),
  photoUrl: z.string().nullable().optional(),
  age: z.string().nullable().optional(),
  background: z.string().nullable().optional(),
  conversationCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  draft: z.boolean().optional(),
  _embedded: z.object({
    emails: z.array(ContactEntrySchema).optional(),
    phones: z.array(ContactEntrySchema).optional(),
    chats: z.array(ContactEntrySchema).optional(),
    social_profiles: z.array(ContactEntrySchema).optional(),
    'social-profiles': z.array(ContactEntrySchema).optional(),
    websites: z.array(z.object({ id: z.number(), value: z.string() })).optional(),
    properties: z.array(z.object({
      type: z.string().optional(),
      slug: z.string().optional(),
      name: z.string().optional(),
      value: z.unknown().optional(),
      text: z.string().nullable().optional(),
      source: z.union([
        z.string(),
        z.object({ name: z.string().optional() }).passthrough(),
      ]).nullable().optional(),
    })).optional(),
  }).optional(),
});

export const CustomerAddressSchema = z.object({
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  lines: z.array(z.string()).optional(),
});

export const OrganizationSchema = z.object({
  id: z.number(),
  name: z.string(),
  website: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  domains: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  brandColor: z.string().nullable().optional(),
  customerCount: z.number().optional(),
  conversationCount: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const PropertyDefinitionSchema = z.object({
  type: z.enum(['text', 'number', 'url', 'date', 'dropdown']),
  slug: z.string(),
  name: z.string(),
  options: z.array(z.object({
    id: z.string().optional(),
    label: z.string(),
  })).optional(),
});

export const TagSchema = z.object({
  id: z.number(),
  slug: z.string().optional(),
  name: z.string(),
  color: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  ticketCount: z.number().optional(),
});

export const UserSchema = z.object({
  id: z.number(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  role: z.string().optional(),
  timezone: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  type: z.string().optional(),
  mention: z.string().nullable().optional(),
  initials: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  alternateEmails: z.array(z.string()).optional(),
  companyId: z.number().optional(),
});

export const SystemUserSchema = UserSchema.extend({
  type: z.literal('system_user').optional(),
});

export const UserStatusSchema = z.object({
  userId: z.number(),
  email: z.object({
    status: z.enum(['active', 'away']),
    updatedAt: z.string().optional(),
    performedBy: z.number().optional(),
    source: z.enum(['ui', 'api', 'presence_detection']).optional(),
    customStatus: z.object({
      text: z.string().optional(),
      emoji: z.string().optional(),
      emojiName: z.string().optional(),
    }).optional(),
  }).optional(),
  chat: z.object({
    status: z.enum(['unavailable', 'available', 'assign', 'custom']),
    mailboxStatuses: z.record(z.string()).optional(),
  }).optional(),
}).passthrough();

export const TeamSchema = z.object({
  id: z.number(),
  name: z.string(),
  timezone: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  mention: z.string().nullable().optional(),
  initials: z.string().nullable().optional(),
});

export const InboxRoutingSchema = z.object({
  state: z.enum(['enabled', 'disabled']),
  assignmentLimit: z.number().optional(),
  assignmentMethod: z.enum(['round_robin', 'balanced']).optional(),
  userIds: z.array(z.number()).optional(),
  rotation: z.array(z.object({
    userId: z.number(),
    conversationsCount: z.number().optional(),
    eligible: z.boolean().optional(),
    reason: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const InboxCustomFieldSchema = z.object({
  id: z.number(),
  required: z.boolean().optional(),
  order: z.number().optional(),
  type: z.string(),
  name: z.string(),
  options: z.array(z.object({
    id: z.number(),
    order: z.number().optional(),
    label: z.string(),
  })).optional(),
});

export const InboxFolderSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
  userId: z.number().optional(),
  totalCount: z.number().optional(),
  activeCount: z.number().optional(),
  updatedAt: z.string().optional(),
});

export const SavedReplySchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  preview: z.string().nullable().optional(),
  chatPreview: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  chatText: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  folderId: z.number().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const WorkflowSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  order: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const WebhookSchema = z.object({
  id: z.number(),
  url: z.string().optional(),
  events: z.array(z.string()).optional(),
  state: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const SatisfactionRatingSchema = z.object({
  id: z.number(),
  threadId: z.number().optional(),
  conversationId: z.number().optional(),
  conversationNumber: z.number().optional(),
  mailboxId: z.number().optional(),
  rating: z.enum(['great', 'not_good', 'okay', 'unknown']).or(z.string()).optional(),
  comments: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
  user: z.object({
    id: z.number(),
    email: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
  }).passthrough().optional(),
  customer: z.object({
    id: z.number(),
    email: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

export const ReportResponseSchema = z.object({
  current: z.unknown().optional(),
  previous: z.unknown().optional(),
  deltas: z.unknown().optional(),
}).passthrough();

export const HappinessRatingsReportSchema = z.object({
  facets: z.record(z.unknown()).optional(),
  results: z.array(z.object({
    number: z.number().optional(),
    threadid: z.number().optional(),
    threadCreatedAt: z.string().optional(),
    id: z.number().optional(),
    type: z.enum(['email', 'chat', 'phone']).or(z.string()).optional(),
    ratingId: z.number().optional(),
    ratingCustomerId: z.number().optional(),
    ratingComments: z.string().nullable().optional(),
    ratingCreatedAt: z.string().optional(),
    ratingCustomerName: z.string().nullable().optional(),
    ratingUserId: z.number().optional(),
    ratingUserName: z.string().nullable().optional(),
  }).passthrough()).optional(),
  page: z.number().optional(),
  count: z.number().optional(),
  pages: z.number().optional(),
}).passthrough();

const isValidReportDate = (value: string): boolean => {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/
  );

  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const normalizedDate = new Date(Date.UTC(year, month - 1, day));

  if (
    normalizedDate.getUTCFullYear() !== year ||
    normalizedDate.getUTCMonth() !== month - 1 ||
    normalizedDate.getUTCDate() !== day
  ) {
    return false;
  }

  if (hourText === undefined) return true;

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);

  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetSign === undefined) return true;

  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  return offsetHour <= 23 && offsetMinute <= 59;
};

const ReportDateSchema = z.string().refine(
  isValidReportDate,
  'Report dates must be valid ISO 8601 strings'
);
const ReportIdListSchema = z.array(
  z.string().regex(/^\d+$/, 'Report filter IDs must be numeric')
).min(1).max(50);
const ReportIdSchema = z.union([
  z.string().regex(/^\d+$/, 'Report IDs must be numeric'),
  z.number().int().positive(),
]).transform(String);
const ReportConversationTypesSchema = z.array(z.enum(['email', 'chat', 'phone'])).min(1).max(3);
const ReportViewBySchema = z.enum(['day', 'week', 'month']);
const OptionalReportSortOrderSchema = z.enum(['ASC', 'DESC', 'asc', 'desc'])
  .transform((value) => value.toUpperCase() as 'ASC' | 'DESC')
  .optional();

const ReportBaseInputObjectSchema = z.object({
  start: ReportDateSchema.describe('Start of the reporting interval, ISO 8601'),
  end: ReportDateSchema.describe('End of the reporting interval, ISO 8601'),
  previousStart: ReportDateSchema.optional().describe('Optional start of the comparison interval'),
  previousEnd: ReportDateSchema.optional().describe('Optional end of the comparison interval'),
  mailboxes: ReportIdListSchema.optional().describe('Inbox IDs to filter by'),
  tags: ReportIdListSchema.optional().describe('Tag IDs to filter by'),
  types: ReportConversationTypesSchema.optional().describe('Conversation types to filter by'),
  folders: ReportIdListSchema.optional().describe('Folder IDs to filter by'),
});

export const ReportBaseInputSchema = ReportBaseInputObjectSchema.refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

// Retained as the company-overall base; reused by the consolidated getCompanyReport tool.
export const GetCompanyReportInputSchema = ReportBaseInputSchema;

// Shared enums for the consolidated report tools.
const ReportDrilldownRangeSchema = z.enum([
  'replies',
  'firstReplyResolved',
  'resolved',
  'responseTime',
  'firstResponseTime',
  'handleTime',
]);
export const ConversationFieldDrilldownFieldSchema = z.enum(['tagid', 'replyid', 'workflowid', 'customerid']);
const ReportRatingSchema = z.enum(['great', 'ok', 'all', 'not-good']);

const pairedComparison = (data: { previousStart?: string; previousEnd?: string }): boolean =>
  (!!data.previousStart) === (!!data.previousEnd);
const pairedComparisonMessage = { message: 'previousStart and previousEnd must be provided together' };

// ---------------------------------------------------------------------------
// Consolidated report tools: one tool per report family, routed by discriminator.
// Each schema exposes the union of params its report values can use; the handler
// forwards only the params the selected report path documents.
// ---------------------------------------------------------------------------

// 1. getCompanyReport: overall | customers-helped | drilldown
export const GetCompanyReportInputSchemaUnion = ReportBaseInputObjectSchema.extend({
  report: z.enum(['overall', 'customers-helped', 'drilldown']).default('overall'),
  viewBy: ReportViewBySchema.optional().describe('Report granularity (customers-helped only)'),
  page: z.number().int().min(1).optional().describe('Drilldown page number'),
  rows: z.number().int().min(1).max(50).optional().describe('Drilldown rows per page (max 50)'),
  range: ReportDrilldownRangeSchema.optional().describe('Drilldown range filter (drilldown only)'),
  rangeId: z.number().int().min(1).max(10).optional().describe('Drilldown range bucket ID (drilldown only)'),
}).superRefine((data, ctx) => {
  if (!pairedComparison(data)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, ...pairedComparisonMessage, path: ['previousStart'] });
  }
  if (data.report === 'drilldown' && !data.range) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required for the drilldown report', path: ['range'] });
  }
});

// 2. getConversationsReport: overall | volume-by-channel | busy-times | drilldown
//    | fields-drilldown | new | new-drilldown | received-messages
export const GetConversationsReportInputSchemaUnion = ReportBaseInputObjectSchema.extend({
  report: z.enum([
    'overall',
    'volume-by-channel',
    'busy-times',
    'drilldown',
    'fields-drilldown',
    'new',
    'new-drilldown',
    'received-messages',
  ]).default('overall'),
  viewBy: ReportViewBySchema.optional().describe('Report granularity (timeline reports only)'),
  page: z.number().int().min(1).optional().describe('Drilldown page number'),
  rows: z.number().int().min(1).max(50).optional().describe('Drilldown rows per page (max 50)'),
  field: ConversationFieldDrilldownFieldSchema.optional().describe('Field to drill into (fields-drilldown only)'),
  fieldid: ReportIdSchema.optional().describe('Field value identifier (fields-drilldown only)'),
}).superRefine((data, ctx) => {
  if (!pairedComparison(data)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, ...pairedComparisonMessage, path: ['previousStart'] });
  }
  if (data.report === 'fields-drilldown') {
    if (!data.field) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'field is required for the fields-drilldown report', path: ['field'] });
    }
    if (!data.fieldid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fieldid is required for the fields-drilldown report', path: ['fieldid'] });
    }
  }
});

// 3. getProductivityReport: overall | first-response-time | replies-sent
//    | resolved | response-time | resolution-time
export const GetProductivityReportInputSchemaUnion = ReportBaseInputObjectSchema.extend({
  report: z.enum([
    'overall',
    'first-response-time',
    'replies-sent',
    'resolved',
    'response-time',
    'resolution-time',
  ]).default('overall'),
  officeHours: z.boolean().optional().describe('Whether to take office hours into consideration'),
  viewBy: ReportViewBySchema.optional().describe('Report granularity (timeline reports only)'),
}).refine(pairedComparison, pairedComparisonMessage);

// 4. getUserReport: overall | conversation-history | customers-helped | drilldown
//    | happiness | ratings | replies | resolutions | chat
export const GetUserReportInputSchemaUnion = ReportBaseInputObjectSchema.extend({
  user: ReportIdSchema.describe('User ID or team ID for the report'),
  report: z.enum([
    'overall',
    'conversation-history',
    'customers-helped',
    'drilldown',
    'happiness',
    'ratings',
    'replies',
    'resolutions',
    'chat',
  ]).default('overall'),
  officeHours: z.boolean().optional().describe('Whether to take office hours into consideration'),
  viewBy: ReportViewBySchema.optional().describe('Report granularity (timeline reports only)'),
  page: z.number().int().min(1).optional().describe('Page number (drilldown, ratings, conversation-history)'),
  rows: z.number().int().min(1).max(50).optional().describe('Rows per page (drilldown only, max 50)'),
  status: z.enum(['active', 'pending', 'closed']).optional().describe('Conversation status (conversation-history only)'),
  sortField: z.string().optional().describe('Sort field (conversation-history, ratings)'),
  sortOrder: OptionalReportSortOrderSchema.describe('Sort order ASC/DESC (conversation-history, ratings)'),
  rating: ReportRatingSchema.optional().describe('Rating value filter (ratings only)'),
}).refine(pairedComparison, pairedComparisonMessage);

// 5. getHappinessReport: overall | ratings
export const GetHappinessReportInputSchemaUnion = ReportBaseInputObjectSchema.extend({
  report: z.enum(['overall', 'ratings']).default('overall'),
  page: z.number().int().min(1).optional().describe('Page number (ratings only)'),
  sortField: z.enum(['number', 'modifiedAt', 'rating']).optional().describe('Sort field (ratings only)'),
  sortOrder: OptionalReportSortOrderSchema.describe('Sort order ASC/DESC (ratings only)'),
  rating: ReportRatingSchema.optional().describe('Rating value filter (ratings only)'),
}).refine(pairedComparison, pairedComparisonMessage);

// 6. getChannelReport: chat | email | phone (each /reports/<channel>)
export const GetChannelReportInputSchemaUnion = ReportBaseInputObjectSchema.omit({ types: true }).extend({
  channel: z.enum(['chat', 'email', 'phone']),
  officeHours: z.boolean().optional().describe('Whether to take office hours into consideration'),
}).refine(pairedComparison, pairedComparisonMessage);

// 7. getDocsReport: single /reports/docs (kept as-is).
export const GetDocsReportInputSchema = z.object({
  start: ReportDateSchema.describe('Start of the reporting interval, ISO 8601'),
  end: ReportDateSchema.describe('End of the reporting interval, ISO 8601'),
  previousStart: ReportDateSchema.optional().describe('Optional start of the comparison interval'),
  previousEnd: ReportDateSchema.optional().describe('Optional end of the comparison interval'),
  sites: z.array(z.string().min(1)).min(1).max(50).optional().describe('Docs site IDs to filter by'),
}).refine(pairedComparison, pairedComparisonMessage);

// Customer & Organization Input Schemas
export const GetCustomerInputSchema = z.object({
  customerId: z.string().regex(/^\d+$/, 'Customer ID must be numeric').describe('Customer ID'),
});

export const ListCustomersInputSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  query: z.string().optional().describe('Advanced query syntax, e.g. (email:"john@example.com")'),
  mailbox: z.coerce.number().int().optional().describe('Filter by inbox ID (v2 page path only)'),
  modifiedSince: z.string().optional().describe('ISO 8601 date'),
  sortField: z.enum(['createdAt', 'firstName', 'lastName', 'modifiedAt']).default('createdAt').describe('Sort field (v2 page path only)'),
  sortOrder: z.enum(['asc', 'desc']).default('desc').describe('Sort order (v2 page path only)'),
  page: z.number().int().min(1).default(1).describe('Page number for the default v2 page-based pagination'),
  // v3 cursor path: providing `cursor` or setting `useV3` routes to the v3 Customers
  // endpoint, which uses cursor pagination and exposes the email/createdSince filters.
  useV3: z.boolean().default(false).describe('Route to the v3 Customers endpoint (cursor-based pagination). Implied when a cursor is supplied.'),
  cursor: z.string().trim().min(1, 'Cursor cannot be empty').optional().describe('Cursor for v3 pagination (from nextCursor in a previous v3 response). Supplying this forces the v3 path.'),
  email: z.string().optional().describe('Filter by email address. v3 path only (requires useV3 or cursor).'),
  createdSince: z.string().optional().describe('ISO 8601 date - only customers created after this date. v3 path only (requires useV3 or cursor).'),
});

export const SearchCustomersByEmailInputSchema = z.object({
  email: z.string().describe('Email address to search for'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  query: z.string().optional(),
  modifiedSince: z.string().optional(),
  createdSince: z.string().optional(),
  cursor: z.string().optional().describe('Cursor for v3 pagination (from nextCursor in previous response)'),
});

export const GetOrganizationInputSchema = z.object({
  organizationId: z.string().regex(/^\d+$/, 'Organization ID must be numeric').describe('Organization ID'),
  includeCounts: z.boolean().default(true),
  includeProperties: z.boolean().default(false),
});

export const ListOrganizationsInputSchema = z.object({
  sortField: z.enum(['name', 'customerCount', 'conversationCount', 'lastInteractionAt']).default('lastInteractionAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).default(1),
});

export const GetOrganizationMembersInputSchema = z.object({
  organizationId: z.string().regex(/^\d+$/, 'Organization ID must be numeric').describe('Organization ID'),
  page: z.number().int().min(1).default(1),
});

export const GetOrganizationConversationsInputSchema = z.object({
  organizationId: z.string().regex(/^\d+$/, 'Organization ID must be numeric').describe('Organization ID'),
  page: z.number().int().min(1).default(1),
});

export const ListCustomerPropertiesInputSchema = z.object({});

export const ListOrganizationPropertiesInputSchema = z.object({});

export const GetOrganizationPropertyInputSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Property slug must be alphanumeric and may include hyphens or underscores'),
});

export const GetCustomerContactsInputSchema = z.object({
  customerId: z.string().regex(/^\d+$/, 'Customer ID must be numeric').describe('Customer ID'),
});

export const ListAllInboxesInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(100),
  nameContains: z
    .string()
    .optional()
    .describe('Case-insensitive substring filter applied to inbox names after all pages are fetched. Omit to list every inbox.'),
});

export const GetInboxInputSchema = z.object({
  inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric').describe('Inbox ID'),
  include: z
    .array(z.enum(['fields', 'folders', 'routing']))
    .optional()
    .describe(
      'Sub-resources to fetch server-side and attach to the response. ' +
        '"fields" -> customFields, "folders" -> folders, "routing" -> routing.'
    ),
});

export const ListTagsInputSchema = z.object({
  name: z.string().optional().describe('Case-insensitive client-side filter by tag name'),
  page: z.number().int().min(1).default(1),
});

export const GetTagInputSchema = z.object({
  tagId: z.string().regex(/^\d+$/, 'Tag ID must be numeric').describe('Tag ID'),
});

export const ListUsersInputSchema = z.object({
  email: z.string().optional().describe('Exact email match'),
  inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric').optional().describe('Filter by inbox ID'),
  page: z.number().int().min(1).default(1),
  includeStatuses: z
    .boolean()
    .default(false)
    .describe('When true, also fetches /users/status once and attaches all user email/chat availability statuses under "statuses". Does not fan out per user.'),
  includeSystemActors: z
    .boolean()
    .default(false)
    .describe('When true, routes to the v3 /system-users endpoint, returning system actors (AI agents, integration users) instead of standard users. Emits apiVersion: "v3". Ignores includeStatuses.'),
});

export const GetUserInputSchema = z.object({
  userId: z.union([
    z.literal('me'),
    z.string().regex(/^\d+$/, 'User ID must be numeric or "me"'),
  ]).describe('User ID or "me" for the authenticated resource owner'),
  includeStatus: z
    .boolean()
    .default(false)
    .describe('When true, also fetches /users/{id}/status and attaches the email/chat availability status under "status". Ignored when includeSystemActors is true.'),
  includeSystemActors: z
    .boolean()
    .default(false)
    .describe('When true, routes to the v3 /system-users/{id} endpoint, returning the system actor record instead of a standard user. Emits apiVersion: "v3". Takes precedence over includeStatus.'),
});

export const ListTeamsInputSchema = z.object({
  page: z.number().int().min(1).default(1),
});

export const GetTeamMembersInputSchema = z.object({
  teamId: z.string().regex(/^\d+$/, 'Team ID must be numeric').describe('Team ID'),
  page: z.number().int().min(1).default(1),
});

export const ListSavedRepliesInputSchema = z.object({
  inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric').describe('Inbox ID'),
  includeChatReplies: z.boolean().default(false),
});

export const GetSavedReplyInputSchema = z.object({
  inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric').describe('Inbox ID'),
  replyId: z.string().regex(/^\d+$/, 'Saved reply ID must be numeric').describe('Saved reply ID'),
});

export const GetOriginalSourceInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric').describe('Conversation ID'),
  threadId: z.string().regex(/^\d+$/, 'Thread ID must be numeric').describe('Thread ID'),
  format: z.enum(['json', 'rfc822']).default('json').describe("Source format: 'json' (parsed) or 'rfc822' (raw email source)"),
});

export const GetAttachmentInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric').describe('Conversation ID'),
  attachmentId: z.string().regex(/^\d+$/, 'Attachment ID must be numeric').describe('Attachment ID'),
});

export const DownloadAttachmentFileInputSchema = GetAttachmentInputSchema;

export const ListWorkflowsInputSchema = z.object({
  page: z.number().int().min(1).default(1),
});

export const ListWebhooksInputSchema = z.object({
  page: z.number().int().min(1).default(1),
});

export const GetWebhookInputSchema = z.object({
  webhookId: z.string().regex(/^\d+$/, 'Webhook ID must be numeric').describe('Webhook ID'),
});

export const GetSatisfactionRatingInputSchema = z.object({
  ratingId: z.string().regex(/^\d+$/, 'Rating ID must be numeric').describe('Satisfaction rating ID'),
});

const DocsIdSchema = z.union([
  z.string().trim().min(1),
  z.number().int().positive(),
]).transform(String);

const DocsPageInputSchema = z.object({
  page: z.number().int().min(1).default(1),
});

const DocsOrderSchema = z.enum(['asc', 'desc']);
const DocsStatusSchema = z.enum(['all', 'published', 'notpublished']);
const DocsVisibilitySchema = z.enum(['all', 'public', 'private']);

export const ListDocsSitesInputSchema = DocsPageInputSchema;

export const GetDocsSiteInputSchema = z.object({
  siteId: DocsIdSchema.describe('Docs site ID'),
  includeRestrictions: z
    .boolean()
    .default(false)
    .describe('When true, also fetches the restricted-site settings (/sites/{id}/restricted) and attaches them under "restrictions" with shared secrets redacted.'),
});

export const ListDocsCollectionsInputSchema = DocsPageInputSchema.extend({
  siteId: DocsIdSchema.describe('Docs site ID').optional(),
  visibility: DocsVisibilitySchema.default('all'),
  sort: z.enum(['number', 'visibility', 'order', 'name', 'createdAt', 'updatedAt']).default('order'),
  order: DocsOrderSchema.default('asc'),
});

export const GetDocsCollectionInputSchema = z.object({
  collectionId: DocsIdSchema.describe('Docs collection ID or number'),
});

export const ListDocsCategoriesInputSchema = DocsPageInputSchema.extend({
  collectionId: DocsIdSchema.describe('Docs collection ID'),
  sort: z.enum(['number', 'order', 'name', 'articleCount', 'createdAt', 'updatedAt']).default('order'),
  order: DocsOrderSchema.default('asc'),
});

export const GetDocsCategoryInputSchema = z.object({
  categoryId: DocsIdSchema.describe('Docs category ID or number'),
});

export const ListDocsArticlesInputSchema = DocsPageInputSchema.extend({
  collectionId: DocsIdSchema.describe('Docs collection ID').optional(),
  categoryId: DocsIdSchema.describe('Docs category ID').optional(),
  status: DocsStatusSchema.default('all'),
  sort: z.enum(['order', 'number', 'status', 'name', 'popularity', 'createdAt', 'updatedAt']).default('order'),
  order: DocsOrderSchema.default('desc'),
  pageSize: z.number().int().min(1).max(100).default(50),
}).refine(
  (data) => Boolean(data.collectionId || data.categoryId) && !(data.collectionId && data.categoryId),
  { message: 'Provide exactly one of collectionId or categoryId' }
);

export const SearchDocsArticlesInputSchema = DocsPageInputSchema.extend({
  query: z.string().trim().min(1),
  collectionId: DocsIdSchema.describe('Docs collection ID').optional(),
  siteId: DocsIdSchema.describe('Docs site ID').optional(),
  status: DocsStatusSchema.default('all'),
  visibility: DocsVisibilitySchema.default('all'),
});

export const GetDocsArticleInputSchema = z.object({
  articleId: DocsIdSchema.describe('Docs article ID or number'),
  draft: z.boolean().default(false),
});

export const ListDocsRelatedArticlesInputSchema = DocsPageInputSchema.extend({
  articleId: DocsIdSchema.describe('Docs article ID'),
  status: DocsStatusSchema.default('all'),
  sort: z.enum(['order', 'number', 'status', 'name', 'popularity', 'createdAt', 'updatedAt']).default('order'),
  order: DocsOrderSchema.default('desc'),
});

export const ListDocsArticleRevisionsInputSchema = DocsPageInputSchema.extend({
  articleId: DocsIdSchema.describe('Docs article ID'),
});

export const GetDocsArticleRevisionInputSchema = z.object({
  revisionId: DocsIdSchema.describe('Docs article revision ID'),
});

export const ListDocsRedirectsInputSchema = DocsPageInputSchema.extend({
  siteId: DocsIdSchema.describe('Docs site ID'),
});

export const GetDocsRedirectInputSchema = z.object({
  redirectId: DocsIdSchema.describe('Docs redirect ID'),
});

export const FindDocsRedirectInputSchema = z.object({
  siteId: DocsIdSchema.describe('Docs site ID'),
  url: z.string().trim().min(1).describe('Docs URL path to resolve, e.g. /old/path'),
});

// Response Types
export const ServerTimeSchema = z.object({
  isoTime: z.string(),
  unixTime: z.number(),
  source: z.literal('mcp_host_clock'),
  note: z.string(),
});

export const ErrorSchema = z.object({
  code: z.enum(['INVALID_INPUT', 'NOT_FOUND', 'UNAUTHORIZED', 'RATE_LIMIT', 'UPSTREAM_ERROR']),
  message: z.string(),
  retryAfter: z.number().optional(),
  details: z.record(z.unknown()).default({}),
});

// Type exports
export type Inbox = z.infer<typeof InboxSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type Customer = z.infer<typeof CustomerSchema>;
export type CustomerAddress = z.infer<typeof CustomerAddressSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type PropertyDefinition = z.infer<typeof PropertyDefinitionSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type User = z.infer<typeof UserSchema>;
export type SystemUser = z.infer<typeof SystemUserSchema>;
export type UserStatus = z.infer<typeof UserStatusSchema>;
export type Team = z.infer<typeof TeamSchema>;
export type InboxRouting = z.infer<typeof InboxRoutingSchema>;
export type InboxCustomField = z.infer<typeof InboxCustomFieldSchema>;
export type InboxFolder = z.infer<typeof InboxFolderSchema>;
export type SavedReply = z.infer<typeof SavedReplySchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Webhook = z.infer<typeof WebhookSchema>;
export type SatisfactionRating = z.infer<typeof SatisfactionRatingSchema>;
export type ReportResponse = z.infer<typeof ReportResponseSchema>;
export type HappinessRatingsReport = z.infer<typeof HappinessRatingsReportSchema>;
export type SearchConversationsInput = z.infer<typeof SearchConversationsInputSchema>;
export type GetThreadsInput = z.infer<typeof GetThreadsInputSchema>;
export type GetConversationInput = z.infer<typeof GetConversationInputSchema>;
export type GetConversationSummaryInput = z.infer<typeof GetConversationSummaryInputSchema>;
export type GetCustomerInput = z.infer<typeof GetCustomerInputSchema>;
export type ListCustomersInput = z.infer<typeof ListCustomersInputSchema>;
export type SearchCustomersByEmailInput = z.infer<typeof SearchCustomersByEmailInputSchema>;
export type GetOrganizationInput = z.infer<typeof GetOrganizationInputSchema>;
export type ListOrganizationsInput = z.infer<typeof ListOrganizationsInputSchema>;
export type GetOrganizationMembersInput = z.infer<typeof GetOrganizationMembersInputSchema>;
export type GetOrganizationConversationsInput = z.infer<typeof GetOrganizationConversationsInputSchema>;
export type ListCustomerPropertiesInput = z.infer<typeof ListCustomerPropertiesInputSchema>;
export type ListOrganizationPropertiesInput = z.infer<typeof ListOrganizationPropertiesInputSchema>;
export type GetOrganizationPropertyInput = z.infer<typeof GetOrganizationPropertyInputSchema>;
export type GetCustomerContactsInput = z.infer<typeof GetCustomerContactsInputSchema>;
export type ListAllInboxesInput = z.infer<typeof ListAllInboxesInputSchema>;
export type GetInboxInput = z.infer<typeof GetInboxInputSchema>;
export type ListTagsInput = z.infer<typeof ListTagsInputSchema>;
export type GetTagInput = z.infer<typeof GetTagInputSchema>;
export type ListUsersInput = z.infer<typeof ListUsersInputSchema>;
export type GetUserInput = z.infer<typeof GetUserInputSchema>;
export type ListTeamsInput = z.infer<typeof ListTeamsInputSchema>;
export type GetTeamMembersInput = z.infer<typeof GetTeamMembersInputSchema>;
export type ListSavedRepliesInput = z.infer<typeof ListSavedRepliesInputSchema>;
export type GetSavedReplyInput = z.infer<typeof GetSavedReplyInputSchema>;
export type GetOriginalSourceInput = z.infer<typeof GetOriginalSourceInputSchema>;
export type GetAttachmentInput = z.infer<typeof GetAttachmentInputSchema>;
export type DownloadAttachmentFileInput = z.infer<typeof DownloadAttachmentFileInputSchema>;
export type ListWorkflowsInput = z.infer<typeof ListWorkflowsInputSchema>;
export type ListWebhooksInput = z.infer<typeof ListWebhooksInputSchema>;
export type GetWebhookInput = z.infer<typeof GetWebhookInputSchema>;
export type GetSatisfactionRatingInput = z.infer<typeof GetSatisfactionRatingInputSchema>;
export type ListDocsSitesInput = z.infer<typeof ListDocsSitesInputSchema>;
export type GetDocsSiteInput = z.infer<typeof GetDocsSiteInputSchema>;
export type ListDocsCollectionsInput = z.infer<typeof ListDocsCollectionsInputSchema>;
export type GetDocsCollectionInput = z.infer<typeof GetDocsCollectionInputSchema>;
export type ListDocsCategoriesInput = z.infer<typeof ListDocsCategoriesInputSchema>;
export type GetDocsCategoryInput = z.infer<typeof GetDocsCategoryInputSchema>;
export type ListDocsArticlesInput = z.infer<typeof ListDocsArticlesInputSchema>;
export type SearchDocsArticlesInput = z.infer<typeof SearchDocsArticlesInputSchema>;
export type GetDocsArticleInput = z.infer<typeof GetDocsArticleInputSchema>;
export type ListDocsRelatedArticlesInput = z.infer<typeof ListDocsRelatedArticlesInputSchema>;
export type ListDocsArticleRevisionsInput = z.infer<typeof ListDocsArticleRevisionsInputSchema>;
export type GetDocsArticleRevisionInput = z.infer<typeof GetDocsArticleRevisionInputSchema>;
export type ListDocsRedirectsInput = z.infer<typeof ListDocsRedirectsInputSchema>;
export type GetDocsRedirectInput = z.infer<typeof GetDocsRedirectInputSchema>;
export type FindDocsRedirectInput = z.infer<typeof FindDocsRedirectInputSchema>;
export type ReportBaseInput = z.infer<typeof ReportBaseInputSchema>;
export type GetCompanyReportInput = z.infer<typeof GetCompanyReportInputSchemaUnion>;
export type GetConversationsReportInput = z.infer<typeof GetConversationsReportInputSchemaUnion>;
export type GetProductivityReportInput = z.infer<typeof GetProductivityReportInputSchemaUnion>;
export type GetUserReportInput = z.infer<typeof GetUserReportInputSchemaUnion>;
export type GetHappinessReportInput = z.infer<typeof GetHappinessReportInputSchemaUnion>;
export type GetChannelReportInput = z.infer<typeof GetChannelReportInputSchemaUnion>;
export type GetDocsReportInput = z.infer<typeof GetDocsReportInputSchema>;
export type ServerTime = z.infer<typeof ServerTimeSchema>;
export type ApiError = z.infer<typeof ErrorSchema>;
