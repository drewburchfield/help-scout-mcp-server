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

export const AttachmentSchema = z.object({
  id: z.number(),
  filename: z.string(),
  mimeType: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  size: z.number().optional(),
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
  _embedded: z.object({
    attachments: z.array(AttachmentSchema).optional().default([]),
  }).optional(),
});

// MCP Tool Input Schemas
export const SearchInboxesInputSchema = z.object({
  query: z.string(),
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const SearchConversationsInputSchema = z.object({
  query: z.string().optional(),
  inboxId: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(['active', 'pending', 'closed', 'spam']).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
  sort: z.enum(['createdAt', 'modifiedAt', 'number']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  fields: z.array(z.string()).optional(),
});

export const GetThreadsInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
  limit: z.number().min(1).max(200).default(200),
  cursor: z.string().optional(),
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
  limit: z.number().min(1).max(100).default(50),
});

export const MultiStatusConversationSearchInputSchema = z.object({
  searchTerms: z.array(z.string()).min(1, 'At least one search term is required'),
  inboxId: z.string().optional(),
  statuses: z.array(z.enum(['active', 'pending', 'closed', 'spam'])).default(['active', 'pending', 'closed']),
  searchIn: z.array(z.enum(['body', 'subject', 'both'])).default(['both']),
  timeframeDays: z.number().min(1).max(365).default(60),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limitPerStatus: z.number().min(1).max(100).default(25),
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
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
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
      source: z.string().nullable().optional(),
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

// Customer & Organization Input Schemas
export const GetCustomerInputSchema = z.object({
  customerId: z.string().regex(/^\d+$/, 'Customer ID must be numeric').describe('Customer ID'),
});

export const ListCustomersInputSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  query: z.string().optional().describe('Advanced query syntax, e.g. (email:"john@example.com")'),
  mailbox: z.coerce.number().optional().describe('Filter by inbox ID'),
  modifiedSince: z.string().optional().describe('ISO 8601 date'),
  sortField: z.enum(['createdAt', 'firstName', 'lastName', 'modifiedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().min(1).default(1),
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
  page: z.number().min(1).default(1),
});

export const GetOrganizationMembersInputSchema = z.object({
  organizationId: z.string().regex(/^\d+$/, 'Organization ID must be numeric').describe('Organization ID'),
  page: z.number().min(1).default(1),
});

export const GetOrganizationConversationsInputSchema = z.object({
  organizationId: z.string().regex(/^\d+$/, 'Organization ID must be numeric').describe('Organization ID'),
  page: z.number().min(1).default(1),
});

export const GetCustomerContactsInputSchema = z.object({
  customerId: z.string().regex(/^\d+$/, 'Customer ID must be numeric').describe('Customer ID'),
});

export const ListAllInboxesInputSchema = z.object({
  limit: z.number().min(1).max(100).default(100),
});

export const DownloadAttachmentInputSchema = z.object({
  conversationId: z.string().regex(/^\d+$/, 'Conversation ID must be numeric'),
  attachmentId: z.string().regex(/^\d+$/, 'Attachment ID must be numeric'),
});

// Response Types
export const ServerTimeSchema = z.object({
  isoTime: z.string(),
  unixTime: z.number(),
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
export type Attachment = z.infer<typeof AttachmentSchema>;
export type SearchInboxesInput = z.infer<typeof SearchInboxesInputSchema>;
export type SearchConversationsInput = z.infer<typeof SearchConversationsInputSchema>;
export type GetThreadsInput = z.infer<typeof GetThreadsInputSchema>;
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
export type GetCustomerContactsInput = z.infer<typeof GetCustomerContactsInputSchema>;
export type ListAllInboxesInput = z.infer<typeof ListAllInboxesInputSchema>;
export type DownloadAttachmentInput = z.infer<typeof DownloadAttachmentInputSchema>;
export type ServerTime = z.infer<typeof ServerTimeSchema>;
export type ApiError = z.infer<typeof ErrorSchema>;