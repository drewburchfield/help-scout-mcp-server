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
export const SearchInboxesInputSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100).default(50),
  page: z.number().int().min(1).default(1),
});

export const SearchConversationsInputSchema = z.object({
  query: z.string().optional(),
  inboxId: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(['active', 'pending', 'closed', 'spam']).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  page: z.number().int().min(1).default(1),
  sort: z.enum(['createdAt', 'modifiedAt', 'number']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  fields: z.array(z.string()).optional(),
});

export const GetThreadsInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
  limit: z.number().int().min(1).max(200).default(200),
  page: z.number().int().min(1).default(1),
});

export const GetConversationInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
  embed: z.enum(['threads']).optional(),
});

export const GetConversationSummaryInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
});

export const AdvancedConversationSearchInputSchema = z.object({
  contentTerms: z.array(z.string()).optional(),
  subjectTerms: z.array(z.string()).optional(),
  customerEmail: z.string().optional(),
  emailDomain: z.string().optional(),
  tags: z.array(z.string()).optional(),
  inboxId: z.string().optional(),
  status: z.enum(['active', 'pending', 'closed', 'spam']).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  page: z.number().int().min(1).default(1),
});

export const MultiStatusConversationSearchInputSchema = z.object({
  searchTerms: z.array(z.string()).min(1, 'At least one search term is required'),
  inboxId: z.string().optional(),
  statuses: z.array(z.enum(['active', 'pending', 'closed', 'spam'])).default(['active', 'pending', 'closed']),
  searchIn: z.array(z.enum(['body', 'subject', 'both'])).default(['both']),
  timeframeDays: z.number().int().min(1).max(365).default(60),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limitPerStatus: z.number().int().min(1).max(100).default(25),
});

export const StructuredConversationFilterInputSchema = z.object({
  assignedTo: z.number().int().min(-1).describe('User ID (-1 for unassigned)').optional(),
  folderId: z.number().int().min(0).describe('Folder ID must be positive').optional(),
  customerIds: z.array(z.number().int().min(0)).max(100).describe('Max 100 customer IDs').optional(),
  conversationNumber: z.number().int().min(1).describe('Conversation number must be positive').optional(),
  status: z.enum(['active', 'pending', 'closed', 'spam', 'all']).default('all'),
  inboxId: z.string().optional(),
  tag: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  modifiedSince: z.string().optional(),
  sortBy: z.enum(['createdAt', 'modifiedAt', 'number', 'waitingSince', 'customerName', 'customerEmail', 'mailboxId', 'status', 'subject']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(100).default(50),
  page: z.number().int().min(1).default(1),
}).refine(
  (data) => !!(data.assignedTo !== undefined || data.folderId !== undefined || data.customerIds !== undefined || data.conversationNumber !== undefined || (data.sortBy && ['waitingSince', 'customerName', 'customerEmail'].includes(data.sortBy))),
  { message: 'Must use at least one unique field: assignedTo, folderId, customerIds, conversationNumber, or unique sorting. For content search, use comprehensiveConversationSearch.' }
);

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

const ReportDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}(T[\d:.]+([+-]\d{2}:\d{2}|Z)?)?$/,
  'Report dates must be ISO 8601 strings'
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
const ReportSortOrderSchema = z.enum(['ASC', 'DESC', 'asc', 'desc'])
  .default('DESC')
  .transform((value) => value.toUpperCase() as 'ASC' | 'DESC');
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
const ReportCurrentInputObjectSchema = ReportBaseInputObjectSchema.omit({
  previousStart: true,
  previousEnd: true,
});

export const ReportBaseInputSchema = ReportBaseInputObjectSchema.refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const GetCompanyReportInputSchema = ReportBaseInputSchema;
export const GetConversationsReportInputSchema = ReportBaseInputSchema;
export const GetHappinessReportInputSchema = ReportBaseInputSchema;

export const CompanyTimelineReportInputSchema = ReportBaseInputObjectSchema.extend({
  viewBy: ReportViewBySchema.default('day').describe('Report granularity: day, week, or month'),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

const ReportDrilldownRangeSchema = z.enum([
  'replies',
  'firstReplyResolved',
  'resolved',
  'responseTime',
  'firstResponseTime',
  'handleTime',
]);

export const ReportDrilldownInputSchema = ReportCurrentInputObjectSchema.extend({
  page: z.number().int().min(1).default(1),
  rows: z.number().int().min(1).max(50).default(25),
  range: ReportDrilldownRangeSchema,
  rangeId: z.number().int().min(1).max(10).optional(),
});

export const ReportCurrentDrilldownInputSchema = ReportCurrentInputObjectSchema.extend({
  page: z.number().int().min(1).default(1),
  rows: z.number().int().min(1).max(50).default(25),
});

export const ConversationTimelineReportInputSchema = ReportBaseInputObjectSchema.extend({
  viewBy: ReportViewBySchema.default('day').describe('Report granularity: day, week, or month'),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const ConversationFieldDrilldownFieldSchema = z.enum(['tagid', 'replyid', 'workflowid', 'customerid']);

export const ConversationFieldDrilldownReportInputSchema = ReportCurrentInputObjectSchema.extend({
  field: ConversationFieldDrilldownFieldSchema.describe('Conversation field to drill into'),
  fieldid: ReportIdSchema.describe('Identifier for the selected field value'),
  page: z.number().int().min(1).default(1),
  rows: z.number().int().min(1).max(50).default(25),
});

export const DocsReportInputSchema = z.object({
  start: ReportDateSchema.describe('Start of the reporting interval, ISO 8601'),
  end: ReportDateSchema.describe('End of the reporting interval, ISO 8601'),
  previousStart: ReportDateSchema.optional().describe('Optional start of the comparison interval'),
  previousEnd: ReportDateSchema.optional().describe('Optional end of the comparison interval'),
  sites: z.array(z.string().min(1)).min(1).max(50).optional().describe('Docs site IDs to filter by'),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const ChannelReportInputSchema = ReportBaseInputObjectSchema.omit({ types: true }).extend({
  officeHours: z.boolean().optional().describe('Whether to take office hours into consideration'),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const GetCompanyCustomersHelpedReportInputSchema = CompanyTimelineReportInputSchema;
export const GetCompanyDrilldownReportInputSchema = ReportDrilldownInputSchema;
export const GetConversationVolumeByChannelReportInputSchema = ConversationTimelineReportInputSchema;
export const GetConversationBusyTimesReportInputSchema = ReportBaseInputSchema;
export const GetConversationDrilldownReportInputSchema = ReportCurrentDrilldownInputSchema;
export const GetConversationFieldDrilldownReportInputSchema = ConversationFieldDrilldownReportInputSchema;
export const GetConversationNewReportInputSchema = ConversationTimelineReportInputSchema;
export const GetConversationNewDrilldownReportInputSchema = ReportCurrentDrilldownInputSchema;
export const GetConversationReceivedMessagesReportInputSchema = ConversationTimelineReportInputSchema;
export const GetDocsReportInputSchema = DocsReportInputSchema;
export const GetChatReportInputSchema = ChannelReportInputSchema;
export const GetEmailReportInputSchema = ChannelReportInputSchema;
export const GetPhoneReportInputSchema = ChannelReportInputSchema;

const ProductivityReportBaseInputObjectSchema = ReportBaseInputObjectSchema.extend({
  officeHours: z.boolean().optional().describe('Whether to take office hours into consideration'),
});

export const GetProductivityReportInputSchema = ProductivityReportBaseInputObjectSchema.refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const ProductivityTimelineReportInputSchema = ProductivityReportBaseInputObjectSchema.extend({
  viewBy: ReportViewBySchema.default('day').describe('Report granularity: day, week, or month'),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const GetProductivityFirstResponseTimeReportInputSchema = ProductivityTimelineReportInputSchema;
export const GetProductivityRepliesSentReportInputSchema = ProductivityTimelineReportInputSchema;
export const GetProductivityResolutionTimeReportInputSchema = ProductivityTimelineReportInputSchema;
export const GetProductivityResolvedReportInputSchema = ProductivityTimelineReportInputSchema;
export const GetProductivityResponseTimeReportInputSchema = ProductivityTimelineReportInputSchema;

export const GetHappinessRatingsReportInputSchema = ReportBaseInputObjectSchema.extend({
  page: z.number().int().min(1).default(1),
  sortField: z.enum(['number', 'modifiedAt', 'rating']).default('modifiedAt'),
  sortOrder: ReportSortOrderSchema,
  rating: z.enum(['great', 'ok', 'all', 'not-good']).optional(),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

const UserReportBaseInputObjectSchema = ReportBaseInputObjectSchema.extend({
  user: ReportIdSchema.describe('User ID or team ID for the report'),
});

const UserOfficeHoursReportInputObjectSchema = UserReportBaseInputObjectSchema.extend({
  officeHours: z.boolean().optional().describe('Whether to take office hours into consideration'),
});

export const GetUserReportInputSchema = UserOfficeHoursReportInputObjectSchema.refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const UserTimelineReportInputSchema = UserReportBaseInputObjectSchema.extend({
  viewBy: ReportViewBySchema.default('day').describe('Report granularity: day, week, or month'),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const GetUserCustomersHelpedReportInputSchema = UserTimelineReportInputSchema;
export const GetUserRepliesReportInputSchema = UserTimelineReportInputSchema;
export const GetUserResolutionsReportInputSchema = UserTimelineReportInputSchema;

export const GetUserHappinessReportInputSchema = UserReportBaseInputObjectSchema.refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const GetUserRatingsReportInputSchema = UserReportBaseInputObjectSchema.extend({
  page: z.number().int().min(1).default(1),
  sortField: z.enum(['number', 'modifiedAt', 'rating']).optional(),
  sortOrder: OptionalReportSortOrderSchema,
  rating: z.enum(['great', 'ok', 'all', 'not-good']).optional(),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const GetUserConversationHistoryReportInputSchema = UserOfficeHoursReportInputObjectSchema.extend({
  status: z.enum(['active', 'pending', 'closed']).optional(),
  page: z.number().int().min(1).default(1),
  sortField: z.enum(['number', 'repliesSent', 'responseTime', 'resolveTime']).default('number'),
  sortOrder: ReportSortOrderSchema,
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

export const GetUserDrilldownReportInputSchema = ReportCurrentInputObjectSchema.extend({
  user: ReportIdSchema.describe('User ID or team ID for the report'),
  page: z.number().int().min(1).default(1),
  rows: z.number().int().min(1).max(50).default(25),
});

export const GetUserChatReportInputSchema = z.object({
  user: ReportIdSchema.describe('User ID or team ID for the report'),
  start: ReportDateSchema.describe('Start of the reporting interval, ISO 8601'),
  end: ReportDateSchema.describe('End of the reporting interval, ISO 8601'),
  previousStart: ReportDateSchema.optional().describe('Optional start of the comparison interval'),
  previousEnd: ReportDateSchema.optional().describe('Optional end of the comparison interval'),
  mailboxes: ReportIdListSchema.optional().describe('Inbox IDs to filter by'),
  tags: ReportIdListSchema.optional().describe('Tag IDs to filter by'),
  officeHours: z.boolean().optional().describe('Whether to take office hours into consideration'),
}).refine(
  (data) => (!!data.previousStart) === (!!data.previousEnd),
  { message: 'previousStart and previousEnd must be provided together' }
);

// Customer & Organization Input Schemas
export const GetCustomerInputSchema = z.object({
  customerId: z.string().regex(/^\d+$/, 'Customer ID must be numeric').describe('Customer ID'),
});

export const ListCustomersInputSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  query: z.string().optional().describe('Advanced query syntax, e.g. (email:"john@example.com")'),
  mailbox: z.coerce.number().int().optional().describe('Filter by inbox ID'),
  modifiedSince: z.string().optional().describe('ISO 8601 date'),
  sortField: z.enum(['createdAt', 'firstName', 'lastName', 'modifiedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).default(1),
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
});

export const GetUserInputSchema = z.object({
  userId: z.union([
    z.literal('me'),
    z.string().regex(/^\d+$/, 'User ID must be numeric or "me"'),
  ]).describe('User ID or "me" for the authenticated resource owner'),
});

export const ListSystemUsersInputSchema = z.object({
  page: z.number().int().min(1).default(1),
});

export const GetSystemUserInputSchema = z.object({
  systemUserId: z.string().regex(/^\d+$/, 'System user ID must be numeric'),
});

export const ListUserStatusesInputSchema = z.object({
  page: z.number().int().min(1).default(1),
});

export const GetUserStatusInputSchema = z.object({
  userId: z.string().regex(/^\d+$/, 'User ID must be numeric'),
});

export const ListTeamsInputSchema = z.object({
  page: z.number().int().min(1).default(1),
});

export const GetTeamMembersInputSchema = z.object({
  teamId: z.string().regex(/^\d+$/, 'Team ID must be numeric').describe('Team ID'),
  page: z.number().int().min(1).default(1),
});

export const ListInboxCustomFieldsInputSchema = z.object({
  inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric').describe('Inbox ID'),
});

export const ListInboxFoldersInputSchema = z.object({
  inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric').describe('Inbox ID'),
});

export const GetInboxRoutingInputSchema = z.object({
  inboxId: z.string().regex(/^\d+$/, 'Inbox ID must be numeric'),
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
});

export const GetAttachmentInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric').describe('Conversation ID'),
  attachmentId: z.string().regex(/^\d+$/, 'Attachment ID must be numeric').describe('Attachment ID'),
});

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
export type SearchInboxesInput = z.infer<typeof SearchInboxesInputSchema>;
export type SearchConversationsInput = z.infer<typeof SearchConversationsInputSchema>;
export type GetThreadsInput = z.infer<typeof GetThreadsInputSchema>;
export type GetConversationInput = z.infer<typeof GetConversationInputSchema>;
export type GetConversationSummaryInput = z.infer<typeof GetConversationSummaryInputSchema>;
export type AdvancedConversationSearchInput = z.infer<typeof AdvancedConversationSearchInputSchema>;
export type MultiStatusConversationSearchInput = z.infer<typeof MultiStatusConversationSearchInputSchema>;
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
export type ListTagsInput = z.infer<typeof ListTagsInputSchema>;
export type GetTagInput = z.infer<typeof GetTagInputSchema>;
export type ListUsersInput = z.infer<typeof ListUsersInputSchema>;
export type GetUserInput = z.infer<typeof GetUserInputSchema>;
export type ListSystemUsersInput = z.infer<typeof ListSystemUsersInputSchema>;
export type GetSystemUserInput = z.infer<typeof GetSystemUserInputSchema>;
export type ListUserStatusesInput = z.infer<typeof ListUserStatusesInputSchema>;
export type GetUserStatusInput = z.infer<typeof GetUserStatusInputSchema>;
export type ListTeamsInput = z.infer<typeof ListTeamsInputSchema>;
export type GetTeamMembersInput = z.infer<typeof GetTeamMembersInputSchema>;
export type ListInboxCustomFieldsInput = z.infer<typeof ListInboxCustomFieldsInputSchema>;
export type ListInboxFoldersInput = z.infer<typeof ListInboxFoldersInputSchema>;
export type GetInboxRoutingInput = z.infer<typeof GetInboxRoutingInputSchema>;
export type ListSavedRepliesInput = z.infer<typeof ListSavedRepliesInputSchema>;
export type GetSavedReplyInput = z.infer<typeof GetSavedReplyInputSchema>;
export type GetOriginalSourceInput = z.infer<typeof GetOriginalSourceInputSchema>;
export type GetAttachmentInput = z.infer<typeof GetAttachmentInputSchema>;
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
export type GetCompanyReportInput = z.infer<typeof GetCompanyReportInputSchema>;
export type GetConversationsReportInput = z.infer<typeof GetConversationsReportInputSchema>;
export type GetHappinessReportInput = z.infer<typeof GetHappinessReportInputSchema>;
export type GetHappinessRatingsReportInput = z.infer<typeof GetHappinessRatingsReportInputSchema>;
export type GetProductivityReportInput = z.infer<typeof GetProductivityReportInputSchema>;
export type ProductivityTimelineReportInput = z.infer<typeof ProductivityTimelineReportInputSchema>;
export type GetUserReportInput = z.infer<typeof GetUserReportInputSchema>;
export type UserTimelineReportInput = z.infer<typeof UserTimelineReportInputSchema>;
export type ServerTime = z.infer<typeof ServerTimeSchema>;
export type ApiError = z.infer<typeof ErrorSchema>;
