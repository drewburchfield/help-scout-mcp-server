#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Live Help Scout API contract checks.
 *
 * This validates raw Help Scout GET responses against the Zod schemas used by
 * the server. It is intentionally read-only and skips cleanly when credentials
 * are not configured.
 */

import 'dotenv/config';
import { z, type ZodTypeAny } from 'zod';

type JsonObject = Record<string, unknown>;

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

interface ContractCase {
  name: string;
  endpoint: string;
  params?: Record<string, unknown>;
  extract: (response: unknown, ctx: ContractContext) => unknown[];
  skipIf?: (ctx: ContractContext) => string | undefined;
  after?: (items: unknown[], response: unknown, ctx: ContractContext) => void;
  schema: ZodTypeAny;
  minItems?: number;
}

interface ContractContext {
  inboxId?: string;
  conversationId?: string;
  customerId?: string;
  organizationId?: string;
  tagId?: string;
  userId?: string;
  teamId?: string;
  organizationPropertySlug?: string;
}

interface ContractResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail?: string;
}

const hasCredentials = Boolean(
  (process.env.HELPSCOUT_APP_ID || process.env.HELPSCOUT_CLIENT_ID || process.env.HELPSCOUT_API_KEY) &&
  (process.env.HELPSCOUT_APP_SECRET || process.env.HELPSCOUT_CLIENT_SECRET)
);

if (!hasCredentials) {
  process.stdout.write('SKIP: Missing live Help Scout credentials for API contract tests.\n');
  process.exit(0);
}

const {
  CustomerAddressSchema,
  CustomerSchema,
  InboxCustomFieldSchema,
  InboxFolderSchema,
  InboxSchema,
  OrganizationSchema,
  PropertyDefinitionSchema,
  TagSchema,
  TeamSchema,
  UserSchema,
} = await import('../src/schema/types.js');
const { helpScoutClient } = await import('../src/utils/helpscout-client.js');

const ApiPersonSchema = z.object({
  id: z.number(),
  type: z.string().optional(),
  first: z.string().nullable().optional(),
  last: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
}).passthrough();

const ApiConversationSchema = z.object({
  id: z.number(),
  number: z.number(),
  threads: z.number(),
  type: z.string().optional(),
  folderId: z.number().optional(),
  status: z.enum(['active', 'pending', 'closed', 'spam']),
  state: z.enum(['published', 'draft', 'hidden']).optional(),
  subject: z.string().nullable().optional(),
  preview: z.string().nullable().optional(),
  mailboxId: z.number().optional(),
  createdBy: ApiPersonSchema.optional().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  userUpdatedAt: z.string().optional(),
  closedAt: z.string().nullable().optional(),
  closedBy: z.number().nullable().optional(),
  closedByUser: ApiPersonSchema.optional().nullable(),
  customerWaitingSince: z.union([
    z.string(),
    z.object({
      time: z.string().optional(),
      friendly: z.string().optional(),
    }).passthrough(),
  ]).nullable().optional(),
  source: z.object({
    type: z.string(),
    via: z.string().optional(),
  }).passthrough().optional(),
  tags: z.array(z.object({
    id: z.number(),
    name: z.string().optional(),
    tag: z.string().optional(),
    color: z.string().optional(),
  }).passthrough()).optional(),
  cc: z.array(z.unknown()).optional(),
  bcc: z.array(z.unknown()).optional(),
  primaryCustomer: ApiPersonSchema.optional().nullable(),
  customer: ApiPersonSchema.optional().nullable(),
  mailbox: z.object({
    id: z.number(),
    name: z.string().optional(),
  }).passthrough().optional(),
  customFields: z.array(z.unknown()).optional(),
  _embedded: z.object({
    threads: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();

const ApiThreadSchema = z.object({
  id: z.number(),
  type: z.string(),
  status: z.string().optional(),
  state: z.string().optional(),
  action: z.object({
    type: z.string().optional(),
    text: z.string().optional(),
  }).passthrough().nullable().optional(),
  body: z.string().nullable().optional(),
  source: z.object({
    type: z.string().optional(),
    via: z.string().optional(),
  }).passthrough().optional(),
  customer: ApiPersonSchema.optional().nullable(),
  createdBy: ApiPersonSchema.optional().nullable(),
  assignedTo: ApiPersonSchema.optional().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
}).passthrough();

const ContactEntrySchema = z.object({
  id: z.number(),
  value: z.string(),
  type: z.string().optional(),
}).passthrough();

const WebsiteSchema = z.object({
  id: z.number(),
  value: z.string(),
}).passthrough();

function embedded(response: unknown, key: string): unknown[] {
  if (!response || typeof response !== 'object') return [];
  const value = (response as JsonObject)._embedded;
  if (!value || typeof value !== 'object') return [];
  const items = (value as JsonObject)[key];
  return Array.isArray(items) ? items : [];
}

function single(response: unknown): unknown[] {
  return response && typeof response === 'object' ? [response] : [];
}

function firstId(items: unknown[]): string | undefined {
  const id = (items[0] as JsonObject | undefined)?.id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;
}

function firstString(items: unknown[], key: string): string | undefined {
  const value = (items[0] as JsonObject | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function summarize(value: unknown): string {
  return JSON.stringify(value, null, 2)?.slice(0, 3000) ?? String(value);
}

const ctx: ContractContext = {};

const cases: ContractCase[] = [
  {
    name: 'GET /v2/mailboxes',
    endpoint: '/mailboxes',
    params: { page: 1, size: 10 },
    extract: (response) => embedded(response, 'mailboxes'),
    after: (items) => { ctx.inboxId = firstId(items); },
    schema: InboxSchema,
    minItems: 1,
  },
  {
    name: 'GET /v2/conversations',
    endpoint: '/conversations',
    params: { page: 1, size: 10, status: 'active' },
    extract: (response) => embedded(response, 'conversations'),
    after: (items) => {
      ctx.conversationId = firstId(items);
      const customer = (items[0] as JsonObject | undefined)?.customer as JsonObject | undefined;
      const primaryCustomer = (items[0] as JsonObject | undefined)?.primaryCustomer as JsonObject | undefined;
      const mailbox = (items[0] as JsonObject | undefined)?.mailbox as JsonObject | undefined;
      const mailboxId = (items[0] as JsonObject | undefined)?.mailboxId;
      if (customer?.id || primaryCustomer?.id) ctx.customerId = String(customer?.id ?? primaryCustomer?.id);
      if (!ctx.inboxId && mailbox?.id) ctx.inboxId = String(mailbox.id);
      if (!ctx.inboxId && mailboxId) ctx.inboxId = String(mailboxId);
    },
    schema: ApiConversationSchema,
  },
  {
    name: 'GET /v2/conversations/{id}',
    endpoint: '',
    skipIf: (context) => context.conversationId ? undefined : 'No conversation available from list response',
    extract: single,
    schema: ApiConversationSchema,
  },
  {
    name: 'GET /v2/conversations/{id}/threads',
    endpoint: '',
    params: { page: 1, size: 20 },
    skipIf: (context) => context.conversationId ? undefined : 'No conversation available from list response',
    extract: (response) => embedded(response, 'threads'),
    schema: ApiThreadSchema,
  },
  {
    name: 'GET /v2/customers',
    endpoint: '/customers',
    params: { page: 1, size: 10 },
    extract: (response) => embedded(response, 'customers'),
    after: (items) => { ctx.customerId = ctx.customerId ?? firstId(items); },
    schema: CustomerSchema,
  },
  {
    name: 'GET /v2/customers/{id}',
    endpoint: '',
    skipIf: (context) => context.customerId ? undefined : 'No customer available from list/conversation response',
    extract: single,
    schema: CustomerSchema,
  },
  {
    name: 'GET /v2/customers/{id}/address',
    endpoint: '',
    skipIf: (context) => context.customerId ? undefined : 'No customer available from list/conversation response',
    extract: single,
    schema: CustomerAddressSchema,
  },
  {
    name: 'GET /v2/customers/{id}/emails',
    endpoint: '',
    skipIf: (context) => context.customerId ? undefined : 'No customer available from list/conversation response',
    extract: (response) => embedded(response, 'emails'),
    schema: ContactEntrySchema,
  },
  {
    name: 'GET /v2/customers/{id}/phones',
    endpoint: '',
    skipIf: (context) => context.customerId ? undefined : 'No customer available from list/conversation response',
    extract: (response) => embedded(response, 'phones'),
    schema: ContactEntrySchema,
  },
  {
    name: 'GET /v2/customers/{id}/chats',
    endpoint: '',
    skipIf: (context) => context.customerId ? undefined : 'No customer available from list/conversation response',
    extract: (response) => embedded(response, 'chats'),
    schema: ContactEntrySchema,
  },
  {
    name: 'GET /v2/customers/{id}/social-profiles',
    endpoint: '',
    skipIf: (context) => context.customerId ? undefined : 'No customer available from list/conversation response',
    extract: (response) => embedded(response, 'social_profiles'),
    schema: ContactEntrySchema,
  },
  {
    name: 'GET /v2/customers/{id}/websites',
    endpoint: '',
    skipIf: (context) => context.customerId ? undefined : 'No customer available from list/conversation response',
    extract: (response) => embedded(response, 'websites'),
    schema: WebsiteSchema,
  },
  {
    name: 'GET /v2/organizations',
    endpoint: '/organizations',
    params: { page: 1, size: 10 },
    extract: (response) => embedded(response, 'organizations'),
    after: (items) => { ctx.organizationId = firstId(items); },
    schema: OrganizationSchema,
  },
  {
    name: 'GET /v2/organizations/{id}',
    endpoint: '',
    skipIf: (context) => context.organizationId ? undefined : 'No organization available from list response',
    extract: single,
    schema: OrganizationSchema,
  },
  {
    name: 'GET /v2/organizations/{id}/customers',
    endpoint: '',
    params: { page: 1, size: 10 },
    skipIf: (context) => context.organizationId ? undefined : 'No organization available from list response',
    extract: (response) => embedded(response, 'customers'),
    schema: CustomerSchema,
  },
  {
    name: 'GET /v2/organizations/{id}/conversations',
    endpoint: '',
    params: { page: 1, size: 10 },
    skipIf: (context) => context.organizationId ? undefined : 'No organization available from list response',
    extract: (response) => embedded(response, 'conversations'),
    schema: ApiConversationSchema,
  },
  {
    name: 'GET /v2/customer-properties',
    endpoint: '/customer-properties',
    extract: (response) => embedded(response, 'customer-properties'),
    schema: PropertyDefinitionSchema,
  },
  {
    name: 'GET /v2/organizations/properties',
    endpoint: '/organizations/properties',
    extract: (response) => embedded(response, 'organization-properties'),
    after: (items) => { ctx.organizationPropertySlug = firstString(items, 'slug'); },
    schema: PropertyDefinitionSchema,
  },
  {
    name: 'GET /v2/organizations/properties/{slug}',
    endpoint: '',
    skipIf: (context) => context.organizationPropertySlug ? undefined : 'No organization property available from list response',
    extract: single,
    schema: PropertyDefinitionSchema,
  },
  {
    name: 'GET /v2/tags',
    endpoint: '/tags',
    params: { page: 1 },
    extract: (response) => embedded(response, 'tags'),
    after: (items) => { ctx.tagId = firstId(items); },
    schema: TagSchema,
  },
  {
    name: 'GET /v2/tags/{id}',
    endpoint: '',
    skipIf: (context) => context.tagId ? undefined : 'No tag available from list response',
    extract: single,
    schema: TagSchema,
  },
  {
    name: 'GET /v2/users',
    endpoint: '/users',
    params: { page: 1 },
    extract: (response) => embedded(response, 'users'),
    after: (items) => { ctx.userId = firstId(items); },
    schema: UserSchema,
  },
  {
    name: 'GET /v2/users/me',
    endpoint: '/users/me',
    extract: single,
    after: (items) => { ctx.userId = ctx.userId ?? firstId(items); },
    schema: UserSchema,
  },
  {
    name: 'GET /v2/users/{id}',
    endpoint: '',
    skipIf: (context) => context.userId ? undefined : 'No user available from list/me response',
    extract: single,
    schema: UserSchema,
  },
  {
    name: 'GET /v2/teams',
    endpoint: '/teams',
    params: { page: 1 },
    extract: (response) => embedded(response, 'teams'),
    after: (items) => { ctx.teamId = firstId(items); },
    schema: TeamSchema,
  },
  {
    name: 'GET /v2/teams/{id}/members',
    endpoint: '',
    params: { page: 1 },
    skipIf: (context) => context.teamId ? undefined : 'No team available from list response',
    extract: (response) => embedded(response, 'users'),
    schema: UserSchema,
  },
  {
    name: 'GET /v2/mailboxes/{id}/fields',
    endpoint: '',
    skipIf: (context) => context.inboxId ? undefined : 'No inbox available from list response',
    extract: (response) => embedded(response, 'fields'),
    schema: InboxCustomFieldSchema,
  },
  {
    name: 'GET /v2/mailboxes/{id}/folders',
    endpoint: '',
    skipIf: (context) => context.inboxId ? undefined : 'No inbox available from list response',
    extract: (response) => embedded(response, 'folders'),
    schema: InboxFolderSchema,
  },
];

function endpointFor(contractCase: ContractCase, context: ContractContext): string {
  if (contractCase.endpoint) return contractCase.endpoint;

  switch (contractCase.name) {
    case 'GET /v2/conversations/{id}':
      return `/conversations/${context.conversationId}`;
    case 'GET /v2/conversations/{id}/threads':
      return `/conversations/${context.conversationId}/threads`;
    case 'GET /v2/customers/{id}':
      return `/customers/${context.customerId}`;
    case 'GET /v2/customers/{id}/address':
      return `/customers/${context.customerId}/address`;
    case 'GET /v2/customers/{id}/emails':
      return `/customers/${context.customerId}/emails`;
    case 'GET /v2/customers/{id}/phones':
      return `/customers/${context.customerId}/phones`;
    case 'GET /v2/customers/{id}/chats':
      return `/customers/${context.customerId}/chats`;
    case 'GET /v2/customers/{id}/social-profiles':
      return `/customers/${context.customerId}/social-profiles`;
    case 'GET /v2/customers/{id}/websites':
      return `/customers/${context.customerId}/websites`;
    case 'GET /v2/organizations/{id}':
      return `/organizations/${context.organizationId}`;
    case 'GET /v2/organizations/{id}/customers':
      return `/organizations/${context.organizationId}/customers`;
    case 'GET /v2/organizations/{id}/conversations':
      return `/organizations/${context.organizationId}/conversations`;
    case 'GET /v2/organizations/properties/{slug}':
      return `/organizations/properties/${context.organizationPropertySlug}`;
    case 'GET /v2/tags/{id}':
      return `/tags/${context.tagId}`;
    case 'GET /v2/users/{id}':
      return `/users/${context.userId}`;
    case 'GET /v2/teams/{id}/members':
      return `/teams/${context.teamId}/members`;
    case 'GET /v2/mailboxes/{id}/fields':
      return `/mailboxes/${context.inboxId}/fields`;
    case 'GET /v2/mailboxes/{id}/folders':
      return `/mailboxes/${context.inboxId}/folders`;
    default:
      throw new Error(`No endpoint mapping for ${contractCase.name}`);
  }
}

async function runCase(contractCase: ContractCase): Promise<ContractResult> {
  const skipReason = contractCase.skipIf?.(ctx);
  if (skipReason) return { name: contractCase.name, status: 'SKIP', detail: skipReason };

  const endpoint = endpointFor(contractCase, ctx);
  let response: unknown;
  try {
    response = await helpScoutClient.get<unknown>(endpoint, contractCase.params, { ttl: 0 });
  } catch (error) {
    return {
      name: contractCase.name,
      status: 'FAIL',
      detail: `Request failed for ${endpoint}: ${error instanceof Error ? error.message : summarize(error)}`,
    };
  }
  const items = contractCase.extract(response, ctx);

  if (contractCase.minItems && items.length < contractCase.minItems) {
    return {
      name: contractCase.name,
      status: 'FAIL',
      detail: `Expected at least ${contractCase.minItems} item(s), got ${items.length}. Response: ${summarize(response)}`,
    };
  }

  for (const [index, item] of items.entries()) {
    const result = contractCase.schema.safeParse(item);
    if (!result.success) {
      return {
        name: contractCase.name,
        status: 'FAIL',
        detail: `Item ${index} failed schema validation: ${result.error.message}\nResponse sample: ${summarize(item)}`,
      };
    }
  }

  contractCase.after?.(items, response, ctx);
  return { name: contractCase.name, status: 'PASS', detail: `${items.length} item(s) validated` };
}

const results: ContractResult[] = [];

try {
  for (const contractCase of cases) {
    process.stderr.write(`  ${contractCase.name}...`);
    const result = await runCase(contractCase);
    results.push(result);
    process.stderr.write(` ${result.status}${result.detail ? ` (${result.detail.split('\n')[0]})` : ''}\n`);
  }
} finally {
  await helpScoutClient.closePool().catch((error: unknown) => {
    process.stderr.write(`WARN: Failed to close Help Scout connection pool: ${error instanceof Error ? error.message : summarize(error)}\n`);
  });
}

const failed = results.filter((result) => result.status === 'FAIL');
const skipped = results.filter((result) => result.status === 'SKIP');
const passed = results.filter((result) => result.status === 'PASS');

process.stdout.write('\n=== Help Scout API Contract Summary ===\n');
process.stdout.write(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped, ${results.length} total\n`);

if (failed.length > 0) {
  console.error('\nFailures:');
  for (const result of failed) {
    console.error(`\n${result.name}\n${result.detail ?? ''}`);
  }
  process.exit(1);
}
