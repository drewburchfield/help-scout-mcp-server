#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Full MCP client dogfood harness.
 *
 * This spawns the built server entrypoint and talks to it through the official
 * MCP TypeScript client over stdio. It validates every exposed tool through the
 * same protocol path used by real MCP hosts.
 *
 * Usage:
 *   npm run build
 *   node --loader ts-node/esm tests/mcp-client-dogfood.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'path';
import 'dotenv/config';
import { INTEGRATION_ACCOUNT_FIXTURES } from './dogfood-fixtures.js';

const SERVER_PATH = resolve(import.meta.dirname, '../dist/cli.js');
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_DOGFOOD_TIMEOUT_MS ?? 90000);
const SCENARIO_COOLDOWN_MS = Number(process.env.MCP_DOGFOOD_COOLDOWN_MS ?? 0);

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const GOLDEN = {
  customerId: process.env.MCP_DOGFOOD_CUSTOMER_ID ?? '860587086',
  customerEmail: process.env.MCP_DOGFOOD_CUSTOMER_EMAIL ?? 'testuser@meridian-testing.com',
  customerFirstName: process.env.MCP_DOGFOOD_CUSTOMER_FIRST_NAME ?? 'Meridian',
  organizationId: process.env.MCP_DOGFOOD_ORG_ID ?? '33911683',
  organizationName: process.env.MCP_DOGFOOD_ORG_NAME ?? 'Meridian Testing Corp',
  organizationDomain: process.env.MCP_DOGFOOD_ORG_DOMAIN ?? 'meridian-testing.com',
  inboxId: process.env.MCP_DOGFOOD_INBOX_ID ?? '359402',
  inboxName: process.env.MCP_DOGFOOD_INBOX_NAME ?? 'Client Support',
  tag: process.env.MCP_DOGFOOD_TAG ?? 'mcp-test',
  searchTerm: process.env.MCP_DOGFOOD_SEARCH_TERM ?? 'test',
  attachmentSubject: process.env.MCP_DOGFOOD_ATTACHMENT_SUBJECT ?? 'MCP-TEST: Data export CSV failure',
  originalSourceConversationId: process.env.MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID,
  originalSourceThreadId: process.env.MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID,
  attachmentConversationId: process.env.MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID,
  attachmentId: process.env.MCP_DOGFOOD_ATTACHMENT_ID,
  satisfactionRatingId: process.env.MCP_DOGFOOD_SATISFACTION_RATING_ID,
  teamId: process.env.MCP_DOGFOOD_TEAM_ID,
  docsSiteId: process.env.MCP_DOGFOOD_DOCS_SITE_ID,
  docsCollectionId: process.env.MCP_DOGFOOD_DOCS_COLLECTION_ID,
  docsCategoryId: process.env.MCP_DOGFOOD_DOCS_CATEGORY_ID,
  docsArticleId: process.env.MCP_DOGFOOD_DOCS_ARTICLE_ID,
  docsRevisionId: process.env.MCP_DOGFOOD_DOCS_REVISION_ID,
  docsRedirectId: process.env.MCP_DOGFOOD_DOCS_REDIRECT_ID,
  docsRedirectUrl: process.env.MCP_DOGFOOD_DOCS_REDIRECT_URL,
  docsSearchQuery: process.env.MCP_DOGFOOD_DOCS_SEARCH_QUERY ?? 'test',
  reportStart: process.env.MCP_DOGFOOD_REPORT_START ?? daysAgoIso(30),
  reportEnd: process.env.MCP_DOGFOOD_REPORT_END ?? daysAgoIso(0),
  skipReports: process.env.MCP_DOGFOOD_SKIP_REPORTS === 'true',
};

const EXPECTED_TOOLS = [
  'searchInboxes',
  'searchConversations',
  'getConversation',
  'getConversationSummary',
  'getThreads',
  'getServerTime',
  'listAllInboxes',
  'advancedConversationSearch',
  'comprehensiveConversationSearch',
  'structuredConversationFilter',
  'getCustomer',
  'listCustomers',
  'searchCustomersByEmail',
  'getCustomerContacts',
  'getOrganization',
  'listOrganizations',
  'getOrganizationMembers',
  'getOrganizationConversations',
  'listCustomerProperties',
  'listOrganizationProperties',
  'getOrganizationProperty',
  'listTags',
  'getTag',
  'listUsers',
  'getUser',
  'listSystemUsers',
  'getSystemUser',
  'listUserStatuses',
  'getUserStatus',
  'listTeams',
  'getTeamMembers',
  'listInboxCustomFields',
  'listInboxFolders',
  'getInboxRouting',
  'listSavedReplies',
  'getSavedReply',
  'getOriginalSource',
  'getAttachment',
  'listWorkflows',
  'listWebhooks',
  'getWebhook',
  'getSatisfactionRating',
  'getCompanyReport',
  'getCompanyCustomersHelpedReport',
  'getCompanyDrilldownReport',
  'getConversationsReport',
  'getConversationVolumeByChannelReport',
  'getConversationBusyTimesReport',
  'getConversationDrilldownReport',
  'getConversationFieldDrilldownReport',
  'getConversationNewReport',
  'getConversationNewDrilldownReport',
  'getConversationReceivedMessagesReport',
  'getDocsReport',
  'getHappinessReport',
  'getHappinessRatingsReport',
  'getProductivityReport',
  'getProductivityFirstResponseTimeReport',
  'getProductivityRepliesSentReport',
  'getProductivityResolutionTimeReport',
  'getProductivityResolvedReport',
  'getProductivityResponseTimeReport',
  'getUserReport',
  'getUserConversationHistoryReport',
  'getUserCustomersHelpedReport',
  'getUserDrilldownReport',
  'getUserHappinessReport',
  'getUserRatingsReport',
  'getUserRepliesReport',
  'getUserResolutionsReport',
  'getUserChatReport',
  'getChatReport',
  'getEmailReport',
  'getPhoneReport',
  'listDocsSites',
  'getDocsSite',
  'listDocsCollections',
  'getDocsCollection',
  'listDocsCategories',
  'getDocsCategory',
  'listDocsArticles',
  'searchDocsArticles',
  'getDocsArticle',
  'listDocsRelatedArticles',
  'listDocsArticleRevisions',
  'getDocsArticleRevision',
  'listDocsRedirects',
  'getDocsRedirect',
  'findDocsRedirect',
] as const;

type ToolName = typeof EXPECTED_TOOLS[number];
type JsonObject = Record<string, unknown>;

interface DogfoodContext {
  tools: Tool[];
  toolNames: Set<string>;
  serverInfo?: unknown;
  serverCapabilities?: unknown;
  serverInstructions?: string;
  inboxId: string;
  customerId: string;
  customerEmail: string;
  organizationId: string;
  conversationId?: string;
  conversationNumber?: number;
  originalSourceConversationId?: string;
  originalSourceThreadId?: string;
  originalSourceProbeSkipped?: string;
  attachmentConversationId?: string;
  attachmentId?: string;
  assigneeId?: number;
  tagId?: string;
  userId?: string;
  systemUserId?: string;
  teamId?: string;
  savedReplyId?: string;
  webhookId?: string;
  satisfactionRatingId?: string;
  docsSiteId?: string;
  docsCollectionId?: string;
  docsCategoryId?: string;
  docsArticleId?: string;
  docsRevisionId?: string;
  docsRedirectId?: string;
  docsRedirectUrl?: string;
  docsSearchQuery: string;
  reportStart: string;
  reportEnd: string;
  skipReports: boolean;
  organizationPropertySlug?: string;
  createdAfter?: string;
  createdBefore?: string;
  nextCustomerCursor?: string;
}

interface Scenario {
  name: string;
  tool: ToolName;
  args: JsonObject | ((ctx: DogfoodContext) => JsonObject);
  expectError?: boolean;
  skipIf?: (ctx: DogfoodContext) => string | undefined;
  validate: (data: unknown, result: CallToolResult, ctx: DogfoodContext) => void;
  after?: (data: unknown, result: CallToolResult, ctx: DogfoodContext, session: McpDogfoodSession) => void | Promise<void>;
}

interface ScenarioResult {
  name: string;
  tool: ToolName;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  detail?: string;
}

class McpDogfoodSession {
  private readonly client = new Client({ name: 'helpscout-mcp-dogfood', version: '1.0.0' });
  private readonly transport: StdioClientTransport;
  private stderr = '';

  constructor(redactMessageContent: boolean) {
    this.transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_PATH],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: {
        ...process.env,
        REDACT_MESSAGE_CONTENT: redactMessageContent ? 'true' : 'false',
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
      } as Record<string, string>,
    });

    this.transport.stderr?.on('data', (chunk) => {
      const msg = chunk.toString();
      this.stderr += msg;
      if (process.env.MCP_DOGFOOD_VERBOSE === 'true') {
        process.stderr.write(`  [server stderr] ${msg}`);
      }
    });
  }

  async connect(): Promise<DogfoodContext> {
    await this.client.connect(this.transport, { timeout: REQUEST_TIMEOUT_MS });
    const toolsResult = await this.client.listTools({}, { timeout: REQUEST_TIMEOUT_MS });
    return {
      tools: toolsResult.tools,
      toolNames: new Set(toolsResult.tools.map((tool) => tool.name)),
      serverInfo: this.client.getServerVersion(),
      serverCapabilities: this.client.getServerCapabilities(),
      serverInstructions: this.client.getInstructions(),
      inboxId: GOLDEN.inboxId,
      customerId: GOLDEN.customerId,
      customerEmail: GOLDEN.customerEmail,
      organizationId: GOLDEN.organizationId,
      originalSourceConversationId: GOLDEN.originalSourceConversationId,
      originalSourceThreadId: GOLDEN.originalSourceThreadId,
      attachmentConversationId: GOLDEN.attachmentConversationId,
      attachmentId: GOLDEN.attachmentId,
      satisfactionRatingId: GOLDEN.satisfactionRatingId,
      teamId: GOLDEN.teamId,
      docsSiteId: GOLDEN.docsSiteId,
      docsCollectionId: GOLDEN.docsCollectionId,
      docsCategoryId: GOLDEN.docsCategoryId,
      docsArticleId: GOLDEN.docsArticleId,
      docsRevisionId: GOLDEN.docsRevisionId,
      docsRedirectId: GOLDEN.docsRedirectId,
      docsRedirectUrl: GOLDEN.docsRedirectUrl,
      docsSearchQuery: GOLDEN.docsSearchQuery,
      reportStart: GOLDEN.reportStart,
      reportEnd: GOLDEN.reportEnd,
      skipReports: GOLDEN.skipReports,
    };
  }

  async callTool(name: ToolName, args: JsonObject): Promise<CallToolResult> {
    return this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS, resetTimeoutOnProgress: true, maxTotalTimeout: REQUEST_TIMEOUT_MS },
    ) as Promise<CallToolResult>;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  getStderr(): string {
    return this.stderr;
  }
}

const results: ScenarioResult[] = [];

function parseToolData(result: CallToolResult): unknown {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getArray(data: unknown, keys: string[]): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function getObject(data: unknown, key: string): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getThreadAttachments(thread: JsonObject): JsonObject[] {
  if (Array.isArray(thread.attachments)) return thread.attachments as JsonObject[];

  const embedded = thread._embedded;
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
    const attachments = (embedded as JsonObject).attachments;
    if (Array.isArray(attachments)) return attachments as JsonObject[];
  }

  return [];
}

function getThreadId(thread: JsonObject): string | undefined {
  const id = thread.id;
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  return undefined;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireArray(data: unknown, keys: string[], label: string): unknown[] {
  const arr = getArray(data, keys);
  requireCondition(Array.isArray(arr), `${label} is not an array`);
  return arr;
}

function requirePositiveMetric(data: Record<string, unknown>, keys: string[], label: string): void {
  const found = keys.some((key) => typeof data[key] === 'number' && data[key] > 0);
  requireCondition(found, `${label} did not include a positive metric in ${keys.join(', ')}`);
}

async function probeOriginalSourceFixture(
  session: McpDogfoodSession,
  ctx: DogfoodContext,
  conversationId: string | undefined,
  threads: JsonObject[]
): Promise<void> {
  if (ctx.originalSourceConversationId && ctx.originalSourceThreadId) return;
  if (!conversationId) return;

  for (const thread of threads) {
    const threadId = getThreadId(thread);
    if (!threadId) continue;

    try {
      const result = await session.callTool('getOriginalSource', { conversationId, threadId });
      const data = parseToolData(result);
      const originalSource = getObject(data, 'originalSource');
      if (!result.isError && originalSource && 'original' in originalSource) {
        ctx.originalSourceConversationId = conversationId;
        ctx.originalSourceThreadId = threadId;
        ctx.originalSourceProbeSkipped = undefined;
        return;
      }
    } catch (err) {
      ctx.originalSourceProbeSkipped = err instanceof Error ? err.message : String(err);
    }
  }
}

function isRedactedBody(body: unknown): boolean {
  return typeof body === 'string' && body.includes('[Content hidden');
}

function textFromResult(result: CallToolResult): string {
  return result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstItemId(data: unknown, keys: string[]): string | undefined {
  const [first] = getArray(data, keys);
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const id = (first as JsonObject).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return undefined;
}

function missingDocsCredentials(): string | undefined {
  return process.env.HELPSCOUT_DOCS_API_KEY
    ? undefined
    : 'missing HELPSCOUT_DOCS_API_KEY for Docs API dogfood';
}

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dateDaysAhead(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function runScenario(session: McpDogfoodSession, ctx: DogfoodContext, scenario: Scenario): Promise<void> {
  const skipReason = scenario.skipIf?.(ctx);
  if (skipReason) {
    results.push({ name: scenario.name, tool: scenario.tool, status: 'PASS', durationMs: 0, detail: `SKIP: ${skipReason}` });
    process.stderr.write(`  ${scenario.tool}: ${scenario.name}... SKIP (${skipReason})\n`);
    return;
  }

  const args = typeof scenario.args === 'function' ? scenario.args(ctx) : scenario.args;
  const label = `${scenario.tool}: ${scenario.name}`;
  process.stderr.write(`  ${label}...`);
  const start = Date.now();
  try {
    const result = await session.callTool(scenario.tool, args);
    const data = parseToolData(result);
    if (scenario.expectError && !result.isError && !(data && typeof data === 'object' && 'error' in data)) {
      throw new Error('Expected tool error, but call succeeded');
    }
    if (!scenario.expectError && result.isError) {
      throw new Error(`Unexpected tool error: ${textFromResult(result).slice(0, 300)}`);
    }
    scenario.validate(data, result, ctx);
    await scenario.after?.(data, result, ctx, session);
    const durationMs = Date.now() - start;
    results.push({ name: scenario.name, tool: scenario.tool, status: 'PASS', durationMs });
    process.stderr.write(` PASS (${durationMs}ms)\n`);
  } catch (err) {
    const durationMs = Date.now() - start;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name: scenario.name, tool: scenario.tool, status: 'FAIL', durationMs, detail });
    process.stderr.write(` FAIL: ${detail.slice(0, 240)}\n`);
  }

  if (SCENARIO_COOLDOWN_MS > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, SCENARIO_COOLDOWN_MS));
  }
}

function assertToolDiscovery(ctx: DogfoodContext): void {
  const discovered = [...ctx.toolNames].sort();
  const expected = [...EXPECTED_TOOLS].sort();
  const missing = expected.filter((name) => !ctx.toolNames.has(name));
  const extra = discovered.filter((name) => !EXPECTED_TOOLS.includes(name as ToolName));
  requireCondition(missing.length === 0, `Missing expected tools: ${missing.join(', ')}`);
  requireCondition(extra.length === 0, `New tools need dogfood scenarios: ${extra.join(', ')}`);
}

function assertScenarioCoverage(scenarios: Scenario[]): void {
  const covered = new Set(scenarios.map((scenario) => scenario.tool));
  const missing = EXPECTED_TOOLS.filter((tool) => !covered.has(tool));
  requireCondition(missing.length === 0, `Tools without dogfood scenarios: ${missing.join(', ')}`);
}

function buildScenarios(): Scenario[] {
  return [
    {
      tool: 'getServerTime',
      name: 'server clock returns ISO and unix time',
      args: {},
      validate: (data, _result, ctx) => {
        const obj = data as Record<string, unknown>;
        requireCondition(typeof obj?.isoTime === 'string', 'Missing isoTime');
        requireCondition(typeof obj?.unixTime === 'number', 'Missing unixTime');
        ctx.createdAfter = dateDaysAgo(365);
        ctx.createdBefore = dateDaysAhead(1);
      },
    },
    {
      tool: 'listAllInboxes',
      name: 'default inbox discovery',
      args: {},
      validate: (data, _result, ctx) => {
        const inboxes = requireArray(data, ['inboxes', 'results'], 'inboxes');
        requireCondition(inboxes.length > 0, 'No inboxes returned');
        const match = inboxes.find((item) => String((item as JsonObject).id) === GOLDEN.inboxId) as JsonObject | undefined;
        if (match) ctx.inboxId = String(match.id);
      },
    },
    {
      tool: 'listAllInboxes',
      name: 'limit permutation',
      args: { limit: 2 },
      validate: (data) => {
        const inboxes = requireArray(data, ['inboxes', 'results'], 'inboxes');
        requireCondition(inboxes.length <= 2, `Expected at most 2 inboxes, got ${inboxes.length}`);
      },
    },
    {
      tool: 'searchInboxes',
      name: 'empty query lists inboxes',
      args: { query: '', limit: 10 },
      validate: (data) => {
        const inboxes = requireArray(data, ['results', 'inboxes'], 'results');
        requireCondition(inboxes.length > 0, 'Empty inbox query returned no results');
      },
    },
    {
      tool: 'searchInboxes',
      name: 'name query finds target inbox',
      args: { query: GOLDEN.inboxName.split(' ')[0], limit: 10 },
      validate: (data) => {
        const inboxes = requireArray(data, ['results', 'inboxes'], 'results');
        requireCondition(
          inboxes.some((item) => getString((item as JsonObject).name).includes(GOLDEN.inboxName.split(' ')[0])),
          `No inbox matched ${GOLDEN.inboxName}`,
        );
      },
    },
    {
      tool: 'searchInboxes',
      name: 'invalid limit fails validation',
      args: { query: '', limit: 101 },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    {
      tool: 'listCustomerProperties',
      name: 'customer property definition discovery',
      args: {},
      validate: (data) => {
        requireArray(data, ['customerProperties', 'properties', 'results'], 'customerProperties');
      },
    },
    {
      tool: 'listOrganizationProperties',
      name: 'organization property definition discovery',
      args: {},
      validate: (data) => {
        requireArray(data, ['organizationProperties', 'properties', 'results'], 'organizationProperties');
      },
      after: (data, _result, ctx) => {
        const properties = getArray(data, ['organizationProperties', 'properties', 'results']) as JsonObject[];
        const preferred = properties.find((property) =>
          getString(property.slug) === INTEGRATION_ACCOUNT_FIXTURES.organizationProperty.slug
        ) ?? properties[0];
        if (preferred?.slug) ctx.organizationPropertySlug = String(preferred.slug);
      },
    },
    {
      tool: 'getOrganizationProperty',
      name: 'discovered organization property details',
      skipIf: (ctx) => ctx.organizationPropertySlug ? undefined : 'No organization property available from listOrganizationProperties',
      args: (ctx) => ({ slug: ctx.organizationPropertySlug ?? 'missing' }),
      validate: (data) => {
        const property = getObject(data, 'organizationProperty');
        requireCondition(property?.slug, 'Missing organization property');
      },
    },
    {
      tool: 'listTags',
      name: 'tag discovery',
      args: { page: 1 },
      validate: (data) => {
        requireArray(data, ['tags', 'results'], 'tags');
      },
      after: (data, _result, ctx) => {
        const tags = getArray(data, ['tags', 'results']) as JsonObject[];
        const preferred = tags.find((tag) => getString(tag.name) === GOLDEN.tag) ?? tags[0];
        if (preferred?.id) ctx.tagId = String(preferred.id);
      },
    },
    {
      tool: 'listTags',
      name: 'tag name filter',
      args: { name: GOLDEN.tag, page: 1 },
      validate: (data) => {
        requireArray(data, ['tags', 'results'], 'tags');
      },
    },
    {
      tool: 'getTag',
      name: 'discovered tag details',
      skipIf: (ctx) => ctx.tagId ? undefined : 'No tag available from listTags',
      args: (ctx) => ({ tagId: ctx.tagId ?? '0' }),
      validate: (data) => {
        const tag = getObject(data, 'tag');
        requireCondition(tag?.id, 'Missing tag');
      },
    },
    {
      tool: 'listUsers',
      name: 'user discovery',
      args: { page: 1 },
      validate: (data) => {
        const users = requireArray(data, ['users', 'results'], 'users') as JsonObject[];
        requireCondition(users.length > 0, 'No users returned');
      },
      after: (data, _result, ctx) => {
        const users = getArray(data, ['users', 'results']) as JsonObject[];
        if (users[0]?.id) ctx.userId = String(users[0].id);
      },
    },
    {
      tool: 'listUsers',
      name: 'users by inbox filter',
      args: (ctx) => ({ inboxId: ctx.inboxId, page: 1 }),
      validate: (data) => {
        requireArray(data, ['users', 'results'], 'users');
      },
    },
    {
      tool: 'getUser',
      name: 'authenticated user shortcut',
      args: { userId: 'me' },
      validate: (data, _result, ctx) => {
        const user = getObject(data, 'user');
        requireCondition(user?.id, 'Missing user');
        ctx.userId = String(user.id);
      },
    },
    {
      tool: 'getUser',
      name: 'discovered user details',
      skipIf: (ctx) => ctx.userId ? undefined : 'No user available from listUsers/getUser me',
      args: (ctx) => ({ userId: ctx.userId ?? 'me' }),
      validate: (data) => {
        const user = getObject(data, 'user');
        requireCondition(user?.id, 'Missing user');
      },
    },
    {
      tool: 'listSystemUsers',
      name: 'system user discovery',
      args: { page: 1 },
      validate: (data) => {
        requireArray(data, ['systemUsers', 'results'], 'system users');
      },
      after: (data, _result, ctx) => {
        const systemUsers = getArray(data, ['systemUsers', 'results']) as JsonObject[];
        if (systemUsers[0]?.id) ctx.systemUserId = String(systemUsers[0].id);
      },
    },
    {
      tool: 'getSystemUser',
      name: 'discovered system user details',
      skipIf: (ctx) => ctx.systemUserId ? undefined : 'No system user available from listSystemUsers',
      args: (ctx) => ({ systemUserId: ctx.systemUserId ?? '0' }),
      validate: (data) => {
        const systemUser = getObject(data, 'systemUser');
        requireCondition(systemUser?.id, 'Missing system user');
      },
    },
    {
      tool: 'listUserStatuses',
      name: 'user status discovery',
      args: { page: 1 },
      validate: (data) => {
        requireArray(data, ['userStatuses', 'results'], 'user statuses');
      },
    },
    {
      tool: 'getUserStatus',
      name: 'discovered user status',
      skipIf: (ctx) => ctx.userId ? undefined : 'No numeric user available from listUsers/getUser',
      args: (ctx) => ({ userId: ctx.userId ?? '0' }),
      validate: (data) => {
        const userStatus = getObject(data, 'userStatus');
        requireCondition(userStatus?.userId, 'Missing user status');
      },
    },
    {
      tool: 'listTeams',
      name: 'team discovery',
      args: { page: 1 },
      validate: (data) => {
        requireArray(data, ['teams', 'results'], 'teams');
      },
      after: (data, _result, ctx) => {
        const teams = getArray(data, ['teams', 'results']) as JsonObject[];
        if (teams[0]?.id) ctx.teamId = String(teams[0].id);
      },
    },
    {
      tool: 'getTeamMembers',
      name: 'discovered team members',
      skipIf: (ctx) => ctx.teamId ? undefined : 'No team available from listTeams',
      args: (ctx) => ({ teamId: ctx.teamId ?? '0', page: 1 }),
      validate: (data) => {
        requireArray(data, ['members', 'users', 'results'], 'members');
      },
    },
    {
      tool: 'listInboxCustomFields',
      name: 'inbox custom field definitions',
      args: (ctx) => ({ inboxId: ctx.inboxId }),
      validate: (data) => {
        requireArray(data, ['fields', 'results'], 'fields');
      },
    },
    {
      tool: 'listInboxFolders',
      name: 'inbox folders',
      args: (ctx) => ({ inboxId: ctx.inboxId }),
      validate: (data) => {
        requireArray(data, ['folders', 'results'], 'folders');
      },
    },
    {
      tool: 'getInboxRouting',
      name: 'inbox routing configuration',
      args: (ctx) => ({ inboxId: ctx.inboxId }),
      validate: (data) => {
        const routing = getObject(data, 'routing');
        requireCondition(routing?.state, 'Missing routing state');
      },
    },
    {
      tool: 'listSavedReplies',
      name: 'saved replies for inbox',
      args: (ctx) => ({ inboxId: ctx.inboxId, includeChatReplies: true }),
      validate: (data) => {
        requireArray(data, ['savedReplies', 'replies', 'results'], 'savedReplies');
      },
      after: (data, _result, ctx) => {
        const replies = getArray(data, ['savedReplies', 'replies', 'results']) as JsonObject[];
        const preferred = replies.find((reply) =>
          getString(reply.name) === INTEGRATION_ACCOUNT_FIXTURES.savedReply.name
        ) ?? replies[0];
        if (preferred?.id) ctx.savedReplyId = String(preferred.id);
      },
    },
    {
      tool: 'getSavedReply',
      name: 'discovered saved reply details',
      skipIf: (ctx) => ctx.savedReplyId ? undefined : 'No saved reply available from listSavedReplies',
      args: (ctx) => ({ inboxId: ctx.inboxId, replyId: ctx.savedReplyId ?? '0' }),
      validate: (data) => {
        const savedReply = getObject(data, 'savedReply');
        requireCondition(savedReply?.id, 'Missing saved reply');
      },
    },
    {
      tool: 'listWorkflows',
      name: 'workflow discovery',
      args: { page: 1 },
      validate: (data) => {
        requireArray(data, ['workflows', 'results'], 'workflows');
      },
    },
    {
      tool: 'listWebhooks',
      name: 'webhook discovery',
      args: { page: 1 },
      validate: (data) => {
        requireArray(data, ['webhooks', 'results'], 'webhooks');
      },
      after: (data, _result, ctx) => {
        const webhooks = getArray(data, ['webhooks', 'results']) as JsonObject[];
        const preferred = webhooks.find((webhook) =>
          getString(webhook.label) === INTEGRATION_ACCOUNT_FIXTURES.webhook.label
        ) ?? webhooks[0];
        if (preferred?.id) ctx.webhookId = String(preferred.id);
      },
    },
    {
      tool: 'getWebhook',
      name: 'discovered webhook details',
      skipIf: (ctx) => ctx.webhookId ? undefined : 'No webhook available from listWebhooks',
      args: (ctx) => ({ webhookId: ctx.webhookId ?? '0' }),
      validate: (data) => {
        const webhook = getObject(data, 'webhook');
        requireCondition(webhook?.id, 'Missing webhook');
      },
    },
    {
      tool: 'getCompanyReport',
      name: 'company overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId] }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing company report');
        requireCondition(getObject(report, 'current'), 'Missing current company report data');
      },
    },
    {
      tool: 'getCompanyCustomersHelpedReport',
      name: 'company customers helped series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing company customers helped report');
        requireArray(report, ['current'], 'customers helped points');
      },
    },
    {
      tool: 'getCompanyDrilldownReport',
      name: 'company drilldown conversations',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], page: 1, rows: 10, range: 'replies' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        const conversations = getObject(report, 'conversations');
        requireCondition(conversations, 'Missing company drilldown conversations');
        requireArray(conversations, ['results'], 'company drilldown rows');
      },
    },
    {
      tool: 'getConversationsReport',
      name: 'conversations overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId] }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing conversations report');
        const current = getObject(report, 'current');
        requireCondition(current, 'Missing current conversations report data');
        requirePositiveMetric(current, ['totalConversations', 'conversationsCreated', 'newConversations'], 'Seeded conversation report activity');
      },
    },
    {
      tool: 'getConversationVolumeByChannelReport',
      name: 'conversation volume by channel series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing volume by channel report');
        requireArray(report, ['current'], 'volume by channel points');
      },
    },
    {
      tool: 'getConversationBusyTimesReport',
      name: 'conversation busy times report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId] }),
      validate: (data) => {
        const report = getArray(data, ['report']);
        requireCondition(report.length >= 0, 'Missing busy times report array');
      },
    },
    {
      tool: 'getConversationDrilldownReport',
      name: 'conversation drilldown rows',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], page: 1, rows: 10 }),
      validate: (data) => {
        const report = getObject(data, 'report');
        const conversations = getObject(report, 'conversations');
        requireCondition(conversations, 'Missing conversation drilldown conversations');
        requireArray(conversations, ['results'], 'conversation drilldown rows');
      },
    },
    {
      tool: 'getConversationFieldDrilldownReport',
      name: 'conversation field drilldown by tag',
      skipIf: (ctx) => {
        if (ctx.skipReports) return 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS';
        return ctx.tagId ? undefined : 'No tag available for field drilldown';
      },
      args: (ctx) => ({
        start: ctx.reportStart,
        end: ctx.reportEnd,
        field: 'tagid',
        fieldid: ctx.tagId ?? '0',
        mailboxes: [ctx.inboxId],
        page: 1,
        rows: 10,
      }),
      validate: (data) => {
        const report = getObject(data, 'report');
        const conversations = getObject(report, 'conversations');
        requireCondition(conversations, 'Missing field drilldown conversations');
        requireArray(conversations, ['results'], 'field drilldown rows');
      },
    },
    {
      tool: 'getConversationNewReport',
      name: 'new conversations series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing new conversations report');
        requireArray(report, ['current'], 'new conversation points');
      },
    },
    {
      tool: 'getConversationNewDrilldownReport',
      name: 'new conversation drilldown rows',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], page: 1, rows: 10 }),
      validate: (data) => {
        const report = getObject(data, 'report');
        const conversations = getObject(report, 'conversations');
        requireCondition(conversations, 'Missing new conversation drilldown conversations');
        requireArray(conversations, ['results'], 'new conversation drilldown rows');
      },
    },
    {
      tool: 'getConversationReceivedMessagesReport',
      name: 'received messages series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing received messages report');
        requireArray(report, ['current'], 'received message points');
      },
    },
    {
      tool: 'getDocsReport',
      name: 'docs overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, ...(ctx.docsSiteId ? { sites: [ctx.docsSiteId] } : {}) }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing docs report');
        requireCondition(getObject(report, 'current'), 'Missing current docs report data');
      },
    },
    {
      tool: 'getHappinessReport',
      name: 'happiness overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId] }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing happiness report');
        requireCondition(getObject(report, 'current'), 'Missing current happiness report data');
      },
    },
    {
      tool: 'getHappinessRatingsReport',
      name: 'happiness ratings report rows',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], page: 1, sortField: 'modifiedAt', sortOrder: 'DESC', rating: 'all' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing happiness ratings report');
        requireArray(report, ['results'], 'rating results');
      },
      after: (data, _result, ctx) => {
        const report = getObject(data, 'report');
        const ratings = getArray(report, ['results']) as JsonObject[];
        const rating = ratings.find((row) => row.id);
        if (rating?.id) ctx.satisfactionRatingId = String(rating.id);
      },
    },
    {
      tool: 'getSatisfactionRating',
      name: 'fixture satisfaction rating details',
      skipIf: (ctx) => ctx.satisfactionRatingId ? undefined : 'No satisfaction rating fixture available',
      args: (ctx) => ({ ratingId: ctx.satisfactionRatingId ?? '0' }),
      validate: (data) => {
        const rating = getObject(data, 'rating');
        requireCondition(rating?.id, 'Missing satisfaction rating');
        requireCondition(typeof rating.rating === 'string', 'Missing rating value');
      },
    },
    {
      tool: 'getProductivityReport',
      name: 'productivity overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing productivity report');
        const current = getObject(report, 'current');
        requireCondition(current, 'Missing current productivity report data');
        requirePositiveMetric(current, ['closed', 'newConversations'], 'Seeded productivity report activity');
      },
    },
    {
      tool: 'getProductivityFirstResponseTimeReport',
      name: 'productivity first response time series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false, viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing first response time report');
        requireArray(report, ['current'], 'first response time points');
      },
    },
    {
      tool: 'getProductivityRepliesSentReport',
      name: 'productivity replies sent series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false, viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing replies sent report');
        requireArray(report, ['current'], 'replies sent points');
      },
    },
    {
      tool: 'getProductivityResolutionTimeReport',
      name: 'productivity resolution time series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false, viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing resolution time report');
        requireArray(report, ['current'], 'resolution time points');
      },
    },
    {
      tool: 'getProductivityResolvedReport',
      name: 'productivity resolved series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false, viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing resolved report');
        requireArray(report, ['current'], 'resolved points');
      },
    },
    {
      tool: 'getProductivityResponseTimeReport',
      name: 'productivity response time series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false, viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing response time report');
        requireArray(report, ['current'], 'response time points');
      },
    },
    {
      tool: 'getUserReport',
      name: 'user overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user report');
        requireCondition(getObject(report, 'current'), 'Missing current user report data');
      },
    },
    {
      tool: 'getUserConversationHistoryReport',
      name: 'user conversation history rows',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false, page: 1 }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user conversation history report');
        const rows = requireArray(report, ['results'], 'user conversation history rows');
        requireCondition(rows.length > 0, 'Expected seeded user conversation history rows');
      },
    },
    {
      tool: 'getUserCustomersHelpedReport',
      name: 'user customers helped series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user customers helped report');
        requireArray(report, ['current'], 'customers helped points');
      },
    },
    {
      tool: 'getUserDrilldownReport',
      name: 'user drilldown conversations',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], page: 1, rows: 10 }),
      validate: (data) => {
        const report = getObject(data, 'report');
        const conversations = getObject(report, 'conversations');
        requireCondition(conversations, 'Missing user drilldown conversations');
        const rows = requireArray(conversations, ['results'], 'user drilldown rows');
        requireCondition(rows.length > 0, 'Expected seeded user drilldown rows');
      },
    },
    {
      tool: 'getUserHappinessReport',
      name: 'user happiness report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId] }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user happiness report');
        requireCondition(getObject(report, 'current'), 'Missing current user happiness report data');
      },
    },
    {
      tool: 'getUserRatingsReport',
      name: 'user happiness rating rows',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], page: 1, rating: 'all' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user ratings report');
        requireArray(report, ['results'], 'user rating rows');
      },
    },
    {
      tool: 'getUserRepliesReport',
      name: 'user replies series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user replies report');
        requireArray(report, ['current'], 'user reply points');
      },
    },
    {
      tool: 'getUserResolutionsReport',
      name: 'user resolutions series',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], viewBy: 'day' }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user resolutions report');
        requireArray(report, ['current'], 'user resolution points');
      },
    },
    {
      tool: 'getUserChatReport',
      name: 'user chat report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ user: ctx.userId ?? '0', start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing user chat report');
        requireCondition(getObject(report, 'current'), 'Missing current user chat report data');
      },
    },
    {
      tool: 'getChatReport',
      name: 'chat report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing chat report');
        requireCondition(getObject(report, 'current'), 'Missing current chat report data');
      },
    },
    {
      tool: 'getEmailReport',
      name: 'email report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing email report');
        requireCondition(getObject(report, 'current'), 'Missing current email report data');
      },
    },
    {
      tool: 'getPhoneReport',
      name: 'phone report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing phone report');
        requireCondition(getObject(report, 'current'), 'Missing current phone report data');
      },
    },
    {
      tool: 'searchConversations',
      name: 'default all status search',
      args: (ctx) => ({ inboxId: ctx.inboxId, limit: 5 }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
      after: (data, _result, ctx) => {
        const conversations = getArray(data, ['results', 'conversations']) as JsonObject[];
        const first = conversations[0];
        if (!first) return;
        ctx.conversationId = String(first.id);
        if (typeof first.number === 'number') ctx.conversationNumber = first.number;
        const assignee = first.assignee as JsonObject | null | undefined;
        if (assignee && typeof assignee.id === 'number') ctx.assigneeId = assignee.id;
        const customer = first.customer as JsonObject | undefined;
        if (customer?.id) ctx.customerId = String(customer.id);
      },
    },
    ...(['active', 'pending', 'closed', 'spam'] as const).map((status): Scenario => ({
      tool: 'searchConversations',
      name: `status enum ${status}`,
      args: (ctx) => ({ inboxId: ctx.inboxId, status, limit: 3 }),
      validate: (data) => {
        const conversations = requireArray(data, ['results', 'conversations'], 'conversations') as JsonObject[];
        for (const conversation of conversations) {
          requireCondition(conversation.status === status, `Expected ${status}, got ${String(conversation.status)}`);
        }
      },
    })),
    {
      tool: 'searchConversations',
      name: 'tag filter',
      args: (ctx) => ({ inboxId: ctx.inboxId, tag: GOLDEN.tag, limit: 10 }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
      after: (data, _result, ctx) => {
        const conversations = getArray(data, ['results', 'conversations']) as JsonObject[];
        const fixture = conversations.find((conversation) =>
          getString(conversation.subject) === GOLDEN.attachmentSubject
        );
        if (fixture?.id) ctx.attachmentConversationId = String(fixture.id);
      },
    },
    {
      tool: 'searchConversations',
      name: 'query filter with escaped content',
      args: (ctx) => ({ inboxId: ctx.inboxId, query: `(body:"${GOLDEN.searchTerm}")`, limit: 3 }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'searchConversations',
      name: 'created date bounds',
      args: (ctx) => ({
        inboxId: ctx.inboxId,
        createdAfter: ctx.createdAfter ?? dateDaysAgo(365),
        createdBefore: ctx.createdBefore ?? dateDaysAhead(1),
        limit: 5,
      }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    ...(['createdAt', 'modifiedAt', 'number'] as const).flatMap((sort): Scenario[] =>
      (['asc', 'desc'] as const).map((order): Scenario => ({
        tool: 'searchConversations',
        name: `sort ${sort} ${order}`,
        args: (ctx) => ({ inboxId: ctx.inboxId, sort, order, limit: 5 }),
        validate: (data) => {
          requireArray(data, ['results', 'conversations'], 'conversations');
        },
      })),
    ),
    {
      tool: 'searchConversations',
      name: 'partial fields permutation',
      args: (ctx) => ({ inboxId: ctx.inboxId, fields: ['id', 'number', 'subject'], limit: 3 }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'advancedConversationSearch',
      name: 'content terms',
      args: { contentTerms: [GOLDEN.searchTerm], limit: 3 },
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'advancedConversationSearch',
      name: 'subject terms',
      args: { subjectTerms: [GOLDEN.searchTerm], limit: 3 },
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'advancedConversationSearch',
      name: 'customer email',
      args: { customerEmail: GOLDEN.customerEmail, limit: 5 },
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'advancedConversationSearch',
      name: 'email domain',
      args: { emailDomain: GOLDEN.organizationDomain, limit: 5 },
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'advancedConversationSearch',
      name: 'tags plus status',
      args: { tags: [GOLDEN.tag], status: 'closed', limit: 5 },
      validate: (data) => {
        const conversations = requireArray(data, ['results', 'conversations'], 'conversations') as JsonObject[];
        for (const conversation of conversations) {
          requireCondition(conversation.status === 'closed', `Expected closed, got ${String(conversation.status)}`);
        }
      },
    },
    {
      tool: 'advancedConversationSearch',
      name: 'inbox and date bounds',
      args: (ctx) => ({
        inboxId: ctx.inboxId,
        createdAfter: ctx.createdAfter ?? dateDaysAgo(365),
        createdBefore: ctx.createdBefore ?? dateDaysAhead(1),
        limit: 3,
      }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'comprehensiveConversationSearch',
      name: 'default statuses and both search',
      args: { searchTerms: [GOLDEN.searchTerm], timeframeDays: 365, limitPerStatus: 3 },
      validate: (data) => {
        requireArray(data, ['resultsByStatus'], 'resultsByStatus');
      },
    },
    ...(['body', 'subject', 'both'] as const).map((searchIn): Scenario => ({
      tool: 'comprehensiveConversationSearch',
      name: `searchIn ${searchIn}`,
      args: { searchTerms: [GOLDEN.searchTerm], searchIn: [searchIn], timeframeDays: 365, limitPerStatus: 2 },
      validate: (data) => {
        requireArray(data, ['resultsByStatus'], 'resultsByStatus');
      },
    })),
    {
      tool: 'comprehensiveConversationSearch',
      name: 'all statuses including spam',
      args: { searchTerms: [GOLDEN.searchTerm], statuses: ['active', 'pending', 'closed', 'spam'], timeframeDays: 365, limitPerStatus: 2 },
      validate: (data) => {
        requireArray(data, ['resultsByStatus'], 'resultsByStatus');
      },
    },
    {
      tool: 'comprehensiveConversationSearch',
      name: 'explicit date bounds',
      args: (ctx) => ({
        searchTerms: [GOLDEN.searchTerm],
        createdAfter: ctx.createdAfter ?? dateDaysAgo(365),
        createdBefore: ctx.createdBefore ?? dateDaysAhead(1),
        limitPerStatus: 2,
      }),
      validate: (data) => {
        requireArray(data, ['resultsByStatus'], 'resultsByStatus');
      },
    },
    {
      tool: 'comprehensiveConversationSearch',
      name: 'required search terms validation',
      args: { searchTerms: [], limitPerStatus: 1 },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    {
      tool: 'structuredConversationFilter',
      name: 'customer IDs',
      args: (ctx) => ({ customerIds: [Number(ctx.customerId)], limit: 5 }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
      after: (data, _result, ctx) => {
        const conversations = getArray(data, ['results', 'conversations']) as JsonObject[];
        const first = conversations[0];
        if (!first) return;
        ctx.conversationId = String(first.id);
        if (typeof first.number === 'number') ctx.conversationNumber = first.number;
      },
    },
    {
      tool: 'structuredConversationFilter',
      name: 'conversation number',
      args: (ctx) => ({ conversationNumber: ctx.conversationNumber ?? 1 }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    {
      tool: 'structuredConversationFilter',
      name: 'unassigned lookup',
      args: { assignedTo: -1, limit: 3 },
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    },
    ...(['all', 'active', 'pending', 'closed', 'spam'] as const).map((status): Scenario => ({
      tool: 'structuredConversationFilter',
      name: `status ${status} with customer filter`,
      args: (ctx) => ({ customerIds: [Number(ctx.customerId)], status, limit: 3 }),
      validate: (data) => {
        const conversations = requireArray(data, ['results', 'conversations'], 'conversations') as JsonObject[];
        if (status === 'all') return;
        for (const conversation of conversations) {
          requireCondition(conversation.status === status, `Expected ${status}, got ${String(conversation.status)}`);
        }
      },
    })),
    ...(['waitingSince', 'customerName', 'customerEmail'] as const).map((sortBy): Scenario => ({
      tool: 'structuredConversationFilter',
      name: `unique sort ${sortBy}`,
      args: { sortBy, sortOrder: 'asc', limit: 3 },
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
      },
    })),
    {
      tool: 'structuredConversationFilter',
      name: 'missing unique field validation',
      args: { status: 'all', limit: 1 },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    {
      tool: 'getConversation',
      name: 'raw conversation detail',
      args: (ctx) => ({ conversationId: ctx.conversationId ?? '1' }),
      validate: (data) => {
        const conversation = getObject(data, 'conversation');
        requireCondition(conversation?.id, 'Missing raw conversation');
        requireCondition(conversation?.subject, 'Missing raw conversation subject');
      },
    },
    {
      tool: 'getConversation',
      name: 'raw conversation with embedded threads',
      args: (ctx) => ({ conversationId: ctx.conversationId ?? '1', embed: 'threads' }),
      validate: (data) => {
        const conversation = getObject(data, 'conversation');
        requireCondition(conversation?.id, 'Missing raw conversation');
        const embedded = getObject(conversation, '_embedded');
        requireArray(embedded, ['threads'], 'embedded threads');
      },
    },
    {
      tool: 'getConversation',
      name: 'invalid raw conversation ID validation',
      args: { conversationId: 'not-a-number' },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    {
      tool: 'getConversationSummary',
      name: 'summary for discovered conversation',
      args: (ctx) => ({ conversationId: ctx.conversationId ?? '1' }),
      validate: (data) => {
        const conversation = getObject(data, 'conversation');
        requireCondition(conversation?.id, 'Missing conversation summary');
      },
    },
    {
      tool: 'getThreads',
      name: 'threads default limit',
      args: (ctx) => ({ conversationId: ctx.conversationId ?? '1' }),
      validate: (data) => {
        requireArray(data, ['threads'], 'threads');
      },
      after: async (data, _result, ctx, session) => {
        const threads = getArray(data, ['threads']) as JsonObject[];
        if (!ctx.attachmentId) {
          for (const thread of threads) {
            const attachments = getThreadAttachments(thread);
            const attachment = attachments.find((item) => item.id);
            if (attachment?.id) {
              ctx.attachmentConversationId = ctx.conversationId;
              ctx.attachmentId = String(attachment.id);
              break;
            }
          }
        }
        await probeOriginalSourceFixture(session, ctx, ctx.conversationId, threads);
      },
    },
    {
      tool: 'getThreads',
      name: 'threads limit permutation',
      args: (ctx) => ({ conversationId: ctx.conversationId ?? '1', limit: 1 }),
      validate: (data) => {
        const threads = requireArray(data, ['threads'], 'threads');
        requireCondition(threads.length <= 1, `Expected at most 1 thread, got ${threads.length}`);
      },
    },
    {
      tool: 'getThreads',
      name: 'invalid conversation ID validation',
      args: { conversationId: 'not-a-number' },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    {
      tool: 'getThreads',
      name: 'attachment fixture threads',
      skipIf: (ctx) => ctx.attachmentConversationId
        ? undefined
        : 'No attachment fixture conversation available',
      args: (ctx) => ({ conversationId: ctx.attachmentConversationId ?? '1', limit: 10 }),
      validate: (data) => {
        requireArray(data, ['threads'], 'threads');
      },
      after: async (data, _result, ctx, session) => {
        const threads = getArray(data, ['threads']) as JsonObject[];
        if (!ctx.attachmentId) {
          for (const thread of threads) {
            const attachment = getThreadAttachments(thread).find((item) => item.id);
            if (attachment?.id) {
              ctx.attachmentId = String(attachment.id);
              break;
            }
          }
        }
        await probeOriginalSourceFixture(session, ctx, ctx.attachmentConversationId, threads);
      },
    },
    {
      tool: 'getOriginalSource',
      name: 'discovered thread original source',
      skipIf: (ctx) => ctx.originalSourceConversationId && ctx.originalSourceThreadId
        ? undefined
        : 'No original-source fixture available',
      args: (ctx) => ({
        conversationId: ctx.originalSourceConversationId ?? '1',
        threadId: ctx.originalSourceThreadId ?? '1',
      }),
      validate: (data) => {
        const originalSource = getObject(data, 'originalSource');
        requireCondition(originalSource && 'original' in originalSource, 'Missing original source payload');
      },
    },
    {
      tool: 'getAttachment',
      name: 'discovered attachment data',
      skipIf: (ctx) => ctx.attachmentConversationId && ctx.attachmentId
        ? undefined
        : 'No attachment fixture available from getThreads',
      args: (ctx) => ({
        conversationId: ctx.attachmentConversationId ?? '1',
        attachmentId: ctx.attachmentId ?? '1',
      }),
      validate: (data) => {
        const attachment = getObject(data, 'attachment');
        requireCondition(typeof attachment?.data === 'string', 'Missing base64 attachment data');
      },
    },
    {
      tool: 'getCustomer',
      name: 'golden customer profile',
      args: (ctx) => ({ customerId: ctx.customerId }),
      validate: (data) => {
        const customer = getObject(data, 'customer');
        requireCondition(customer?.id, 'Missing customer');
      },
    },
    {
      tool: 'getCustomer',
      name: 'invalid customer ID validation',
      args: { customerId: 'abc' },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    ...(['createdAt', 'firstName', 'lastName', 'modifiedAt'] as const).flatMap((sortField): Scenario[] =>
      (['asc', 'desc'] as const).map((sortOrder): Scenario => ({
        tool: 'listCustomers',
        name: `sort ${sortField} ${sortOrder}`,
        args: { sortField, sortOrder, page: 1 },
        validate: (data) => {
          requireArray(data, ['results', 'customers'], 'customers');
        },
      })),
    ),
    {
      tool: 'listCustomers',
      name: 'first and last name filters',
      args: { firstName: GOLDEN.customerFirstName, page: 1 },
      validate: (data) => {
        requireArray(data, ['results', 'customers'], 'customers');
      },
    },
    {
      tool: 'listCustomers',
      name: 'query syntax filter',
      args: { query: `(email:"${GOLDEN.customerEmail}")`, page: 1 },
      validate: (data) => {
        requireArray(data, ['results', 'customers'], 'customers');
      },
    },
    {
      tool: 'listCustomers',
      name: 'mailbox and modifiedSince filters',
      args: (ctx) => ({ mailbox: Number(ctx.inboxId), modifiedSince: dateDaysAgo(365), page: 1 }),
      validate: (data) => {
        requireArray(data, ['results', 'customers'], 'customers');
      },
    },
    {
      tool: 'listCustomers',
      name: 'page 2 pagination',
      args: { page: 2 },
      validate: (data) => {
        requireArray(data, ['results', 'customers'], 'customers');
      },
    },
    {
      tool: 'searchCustomersByEmail',
      name: 'email exact match',
      args: (ctx) => ({ email: ctx.customerEmail }),
      validate: (data) => {
        const customers = requireArray(data, ['results', 'customers'], 'customers') as JsonObject[];
        requireCondition(customers.some((customer) => String(customer.id) === GOLDEN.customerId), 'Golden customer not found');
      },
      after: (data, _result, ctx) => {
        const obj = data as JsonObject;
        const customers = getArray(data, ['results', 'customers']) as JsonObject[];
        if (customers[0]?.id) ctx.customerId = String(customers[0].id);
        if (typeof obj.nextCursor === 'string') ctx.nextCustomerCursor = obj.nextCursor;
      },
    },
    {
      tool: 'searchCustomersByEmail',
      name: 'email plus name filters',
      args: (ctx) => ({ email: ctx.customerEmail, firstName: GOLDEN.customerFirstName }),
      validate: (data) => {
        requireArray(data, ['results', 'customers'], 'customers');
      },
    },
    {
      tool: 'searchCustomersByEmail',
      name: 'query and date filters',
      args: (ctx) => ({ email: ctx.customerEmail, query: `(email:"${ctx.customerEmail}")`, createdSince: dateDaysAgo(365), modifiedSince: dateDaysAgo(365) }),
      validate: (data) => {
        requireArray(data, ['results', 'customers'], 'customers');
      },
    },
    {
      tool: 'searchCustomersByEmail',
      name: 'invalid cursor fails predictably',
      args: (ctx) => ({ email: ctx.customerEmail, cursor: 'not-a-real-cursor' }),
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected cursor response');
      },
    },
    {
      tool: 'searchCustomersByEmail',
      name: 'nonexistent email returns empty structure',
      args: { email: 'nobody-has-this-address@example.invalid' },
      validate: (data) => {
        requireArray(data, ['results', 'customers'], 'customers');
      },
    },
    {
      tool: 'getCustomerContacts',
      name: 'golden customer contacts',
      args: (ctx) => ({ customerId: ctx.customerId }),
      validate: (data) => {
        requireCondition(data && typeof data === 'object', 'Missing contacts object');
      },
    },
    {
      tool: 'getCustomerContacts',
      name: 'invalid customer ID validation',
      args: { customerId: 'abc' },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    {
      tool: 'getOrganization',
      name: 'include counts true',
      args: (ctx) => ({ organizationId: ctx.organizationId, includeCounts: true }),
      validate: (data) => {
        const organization = getObject(data, 'organization');
        requireCondition(organization?.id, 'Missing organization');
      },
    },
    {
      tool: 'getOrganization',
      name: 'include counts false and properties false',
      args: (ctx) => ({ organizationId: ctx.organizationId, includeCounts: false, includeProperties: false }),
      validate: (data) => {
        const organization = getObject(data, 'organization');
        requireCondition(organization?.id, 'Missing organization');
      },
    },
    {
      tool: 'getOrganization',
      name: 'include properties true',
      args: (ctx) => ({ organizationId: ctx.organizationId, includeProperties: true }),
      validate: (data) => {
        const organization = getObject(data, 'organization');
        requireCondition(organization?.id, 'Missing organization');
      },
    },
    {
      tool: 'getOrganization',
      name: 'invalid organization ID validation',
      args: { organizationId: 'abc' },
      expectError: true,
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected validation response');
      },
    },
    ...(['name', 'customerCount', 'conversationCount', 'lastInteractionAt'] as const).flatMap((sortField): Scenario[] =>
      (['asc', 'desc'] as const).map((sortOrder): Scenario => ({
        tool: 'listOrganizations',
        name: `sort ${sortField} ${sortOrder}`,
        args: { sortField, sortOrder, page: 1 },
        validate: (data) => {
          requireArray(data, ['results', 'organizations'], 'organizations');
        },
      })),
    ),
    {
      tool: 'listOrganizations',
      name: 'page 2 pagination',
      args: { page: 2 },
      validate: (data) => {
        requireArray(data, ['results', 'organizations'], 'organizations');
      },
    },
    {
      tool: 'getOrganizationMembers',
      name: 'page 1 members',
      args: (ctx) => ({ organizationId: ctx.organizationId, page: 1 }),
      validate: (data) => {
        requireArray(data, ['members', 'results', 'customers'], 'members');
      },
    },
    {
      tool: 'getOrganizationMembers',
      name: 'page 2 members',
      args: (ctx) => ({ organizationId: ctx.organizationId, page: 2 }),
      validate: (data) => {
        requireArray(data, ['members', 'results', 'customers'], 'members');
      },
    },
    {
      tool: 'getOrganizationConversations',
      name: 'page 1 conversations',
      args: (ctx) => ({ organizationId: ctx.organizationId, page: 1 }),
      validate: (data) => {
        requireArray(data, ['conversations', 'results'], 'conversations');
      },
    },
    {
      tool: 'getOrganizationConversations',
      name: 'page 2 conversations',
      args: (ctx) => ({ organizationId: ctx.organizationId, page: 2 }),
      validate: (data) => {
        requireArray(data, ['conversations', 'results'], 'conversations');
      },
    },
    {
      tool: 'listDocsSites',
      name: 'Docs sites discovery',
      args: { page: 1 },
      skipIf: () => missingDocsCredentials(),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs sites');
      },
      after: (data, _result, ctx) => {
        ctx.docsSiteId ||= firstItemId(data, ['results']);
      },
    },
    {
      tool: 'getDocsSite',
      name: 'Docs site retrieval',
      args: (ctx) => ({ siteId: ctx.docsSiteId ?? 'missing-site' }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsSiteId ? 'no Docs site fixture discovered or configured' : undefined),
      validate: (data) => {
        const site = getObject(data, 'site');
        requireCondition(site?.id, 'Missing Docs site');
      },
    },
    {
      tool: 'listDocsCollections',
      name: 'Docs collections discovery',
      args: (ctx) => ({ siteId: ctx.docsSiteId, page: 1, visibility: 'all', sort: 'order', order: 'asc' }),
      skipIf: () => missingDocsCredentials(),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs collections');
      },
      after: (data, _result, ctx) => {
        ctx.docsCollectionId ||= firstItemId(data, ['results']);
      },
    },
    {
      tool: 'getDocsCollection',
      name: 'Docs collection retrieval',
      args: (ctx) => ({ collectionId: ctx.docsCollectionId ?? 'missing-collection' }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsCollectionId ? 'no Docs collection fixture discovered or configured' : undefined),
      validate: (data) => {
        const collection = getObject(data, 'collection');
        requireCondition(collection?.id, 'Missing Docs collection');
      },
    },
    {
      tool: 'listDocsCategories',
      name: 'Docs categories discovery',
      args: (ctx) => ({ collectionId: ctx.docsCollectionId ?? 'missing-collection', page: 1, sort: 'order', order: 'asc' }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsCollectionId ? 'no Docs collection fixture for category discovery' : undefined),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs categories');
      },
      after: (data, _result, ctx) => {
        ctx.docsCategoryId ||= firstItemId(data, ['results']);
      },
    },
    {
      tool: 'getDocsCategory',
      name: 'Docs category retrieval',
      args: (ctx) => ({ categoryId: ctx.docsCategoryId ?? 'missing-category' }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsCategoryId ? 'no Docs category fixture discovered or configured' : undefined),
      validate: (data) => {
        const category = getObject(data, 'category');
        requireCondition(category?.id, 'Missing Docs category');
      },
    },
    {
      tool: 'listDocsArticles',
      name: 'Docs articles by collection',
      args: (ctx) => ({ collectionId: ctx.docsCollectionId ?? 'missing-collection', page: 1, status: 'all', sort: 'order', order: 'desc', pageSize: 50 }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsCollectionId ? 'no Docs collection fixture for article listing' : undefined),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs articles');
      },
      after: (data, _result, ctx) => {
        ctx.docsArticleId ||= firstItemId(data, ['results']);
      },
    },
    {
      tool: 'searchDocsArticles',
      name: 'Docs article search',
      args: (ctx) => ({ query: ctx.docsSearchQuery, siteId: ctx.docsSiteId, status: 'all', visibility: 'all', page: 1 }),
      skipIf: () => missingDocsCredentials(),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs article search results');
      },
      after: (data, _result, ctx) => {
        ctx.docsArticleId ||= firstItemId(data, ['results']);
      },
    },
    {
      tool: 'getDocsArticle',
      name: 'Docs article retrieval',
      args: (ctx) => ({ articleId: ctx.docsArticleId ?? 'missing-article', draft: false }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsArticleId ? 'no Docs article fixture discovered or configured' : undefined),
      validate: (data) => {
        const article = getObject(data, 'article');
        requireCondition(article?.id, 'Missing Docs article');
      },
    },
    {
      tool: 'listDocsRelatedArticles',
      name: 'Docs related articles',
      args: (ctx) => ({ articleId: ctx.docsArticleId ?? 'missing-article', page: 1, status: 'all', sort: 'order', order: 'desc' }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsArticleId ? 'no Docs article fixture for related articles' : undefined),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs related articles');
      },
    },
    {
      tool: 'listDocsArticleRevisions',
      name: 'Docs article revisions',
      args: (ctx) => ({ articleId: ctx.docsArticleId ?? 'missing-article', page: 1 }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsArticleId ? 'no Docs article fixture for revisions' : undefined),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs article revisions');
      },
      after: (data, _result, ctx) => {
        ctx.docsRevisionId ||= firstItemId(data, ['results']);
      },
    },
    {
      tool: 'getDocsArticleRevision',
      name: 'Docs article revision retrieval',
      args: (ctx) => ({ revisionId: ctx.docsRevisionId ?? 'missing-revision' }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsRevisionId ? 'no Docs revision fixture discovered or configured' : undefined),
      validate: (data) => {
        const revision = getObject(data, 'revision');
        requireCondition(revision?.id, 'Missing Docs revision');
      },
    },
    {
      tool: 'listDocsRedirects',
      name: 'Docs redirects by site',
      args: (ctx) => ({ siteId: ctx.docsSiteId ?? 'missing-site', page: 1 }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsSiteId ? 'no Docs site fixture for redirects' : undefined),
      validate: (data) => {
        requireArray(data, ['results'], 'Docs redirects');
      },
      after: (data, _result, ctx) => {
        ctx.docsRedirectId ||= firstItemId(data, ['results']);
      },
    },
    {
      tool: 'getDocsRedirect',
      name: 'Docs redirect retrieval',
      args: (ctx) => ({ redirectId: ctx.docsRedirectId ?? 'missing-redirect' }),
      skipIf: (ctx) => missingDocsCredentials() || (!ctx.docsRedirectId ? 'no Docs redirect fixture discovered or configured' : undefined),
      validate: (data) => {
        const redirect = getObject(data, 'redirect');
        requireCondition(redirect?.id, 'Missing Docs redirect');
      },
    },
    {
      tool: 'findDocsRedirect',
      name: 'Docs redirect resolver',
      args: (ctx) => ({ siteId: ctx.docsSiteId ?? 'missing-site', url: ctx.docsRedirectUrl ?? '/missing-docs-redirect' }),
      skipIf: (ctx) =>
        missingDocsCredentials() ||
        (!ctx.docsSiteId ? 'no Docs site fixture for redirect resolver' : undefined) ||
        (!ctx.docsRedirectUrl ? 'no MCP_DOGFOOD_DOCS_REDIRECT_URL configured for redirect resolver' : undefined),
      validate: (data) => {
        requireCondition(data !== undefined, 'Expected Docs redirect resolver response');
      },
    },
  ];
}

async function runMainMatrix(): Promise<DogfoodContext> {
  const session = new McpDogfoodSession(false);
  const ctx = await session.connect();
  const scenarios = buildScenarios();

  process.stderr.write('\n=== MCP Dogfood: Full Tool Matrix ===\n\n');
  process.stderr.write(`Server: ${SERVER_PATH}\n`);
  process.stderr.write(`Discovered tools: ${[...ctx.toolNames].sort().join(', ')}\n`);
  process.stderr.write(`Scenario count: ${scenarios.length}\n\n`);

  try {
    assertToolDiscovery(ctx);
    assertScenarioCoverage(scenarios);
    for (const scenario of scenarios) {
      await runScenario(session, ctx, scenario);
    }
  } finally {
    await session.close();
  }

  return ctx;
}

async function runRedactionMatrix(baseCtx: DogfoodContext): Promise<void> {
  const session = new McpDogfoodSession(true);
  const ctx = await session.connect();
  ctx.conversationId = baseCtx.conversationId;
  ctx.customerId = baseCtx.customerId;
  ctx.customerEmail = baseCtx.customerEmail;
  ctx.organizationId = baseCtx.organizationId;

  process.stderr.write('\n=== MCP Dogfood: Message Content Redaction Matrix ===\n\n');

  const redactionScenarios: Scenario[] = [
    {
      tool: 'getConversationSummary',
      name: 'summary hides message bodies but keeps customer fields',
      args: (scenarioCtx) => ({ conversationId: scenarioCtx.conversationId ?? '1' }),
      validate: (data) => {
        const firstCustomerMessage = getObject(data, 'firstCustomerMessage');
        const latestStaffReply = getObject(data, 'latestStaffReply');
        if (firstCustomerMessage?.body) {
          requireCondition(isRedactedBody(firstCustomerMessage.body), `First customer body not hidden: ${String(firstCustomerMessage.body).slice(0, 80)}`);
        }
        if (latestStaffReply?.body) {
          requireCondition(isRedactedBody(latestStaffReply.body), `Latest staff body not hidden: ${String(latestStaffReply.body).slice(0, 80)}`);
        }
        const conversation = getObject(data, 'conversation');
        const customer = conversation?.customer as JsonObject | undefined;
        const messageCustomer = firstCustomerMessage?.customer as JsonObject | undefined;
        requireCondition(customer?.id || messageCustomer?.id, 'Customer fields should remain visible');
      },
    },
    {
      tool: 'getThreads',
      name: 'thread bodies are hidden',
      args: (scenarioCtx) => ({ conversationId: scenarioCtx.conversationId ?? '1', limit: 5 }),
      validate: (data) => {
        const threads = requireArray(data, ['threads'], 'threads') as JsonObject[];
        for (const thread of threads) {
          if (thread.body) {
            requireCondition(isRedactedBody(thread.body), `Thread body not hidden: ${String(thread.body).slice(0, 80)}`);
          }
        }
      },
    },
    {
      tool: 'getCustomer',
      name: 'customer identity remains visible',
      args: (scenarioCtx) => ({ customerId: scenarioCtx.customerId }),
      validate: (data) => {
        const customer = getObject(data, 'customer');
        requireCondition(customer?.id, 'Customer should still be returned');
        requireCondition(customer?.firstName !== '[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]', 'Customer name should not be message redacted');
      },
    },
  ];

  try {
    for (const scenario of redactionScenarios) {
      await runScenario(session, ctx, scenario);
    }
  } finally {
    await session.close();
  }
}

function printFixtureHints(ctx: DogfoodContext): void {
  const hints: string[] = [];

  if (ctx.attachmentConversationId && ctx.attachmentId) {
    hints.push(`MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID=${ctx.attachmentConversationId}`);
    hints.push(`MCP_DOGFOOD_ATTACHMENT_ID=${ctx.attachmentId}`);
  }

  if (ctx.originalSourceConversationId && ctx.originalSourceThreadId) {
    hints.push(`MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID=${ctx.originalSourceConversationId}`);
    hints.push(`MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID=${ctx.originalSourceThreadId}`);
  }

  if (ctx.satisfactionRatingId) {
    hints.push(`MCP_DOGFOOD_SATISFACTION_RATING_ID=${ctx.satisfactionRatingId}`);
  }

  if (ctx.teamId) {
    hints.push(`MCP_DOGFOOD_TEAM_ID=${ctx.teamId}`);
  }

  if (ctx.docsSiteId) {
    hints.push(`MCP_DOGFOOD_DOCS_SITE_ID=${ctx.docsSiteId}`);
  }
  if (ctx.docsCollectionId) {
    hints.push(`MCP_DOGFOOD_DOCS_COLLECTION_ID=${ctx.docsCollectionId}`);
  }
  if (ctx.docsCategoryId) {
    hints.push(`MCP_DOGFOOD_DOCS_CATEGORY_ID=${ctx.docsCategoryId}`);
  }
  if (ctx.docsArticleId) {
    hints.push(`MCP_DOGFOOD_DOCS_ARTICLE_ID=${ctx.docsArticleId}`);
  }
  if (ctx.docsRevisionId) {
    hints.push(`MCP_DOGFOOD_DOCS_REVISION_ID=${ctx.docsRevisionId}`);
  }
  if (ctx.docsRedirectId) {
    hints.push(`MCP_DOGFOOD_DOCS_REDIRECT_ID=${ctx.docsRedirectId}`);
  }
  if (ctx.docsRedirectUrl) {
    hints.push(`MCP_DOGFOOD_DOCS_REDIRECT_URL=${ctx.docsRedirectUrl}`);
  }

  process.stderr.write('\nFixture hints:\n');
  if (hints.length > 0) {
    for (const hint of hints) process.stderr.write(`  ${hint}\n`);
  } else {
    process.stderr.write('  No optional live fixture IDs were discovered.\n');
  }

  if (!ctx.teamId) {
    process.stderr.write('  Missing team fixture: create a Help Scout team with at least one member.\n');
  }
  if (!ctx.satisfactionRatingId) {
    process.stderr.write('  Missing satisfaction rating fixture: submit a rating and rerun dogfood to discover its ID.\n');
  }
  if (!ctx.originalSourceConversationId || !ctx.originalSourceThreadId) {
    process.stderr.write('  Missing original-source fixture: send/import a real inbound email thread and rerun dogfood.\n');
  }
  if (!process.env.HELPSCOUT_DOCS_API_KEY) {
    process.stderr.write('  Missing Docs fixture: set HELPSCOUT_DOCS_API_KEY and stable Docs records for non-skipping Docs dogfood.\n');
  } else {
    if (!ctx.docsRevisionId) {
      process.stderr.write('  Missing Docs revision fixture: run npm run dogfood:seed:docs or set MCP_DOGFOOD_DOCS_REVISION_ID.\n');
    }
    if (!ctx.docsRedirectId || !ctx.docsRedirectUrl) {
      process.stderr.write('  Missing Docs redirect fixture: run npm run dogfood:seed:docs or set MCP_DOGFOOD_DOCS_REDIRECT_ID and MCP_DOGFOOD_DOCS_REDIRECT_URL.\n');
    }
  }
}

function printSummary(ctx: DogfoodContext): void {
  process.stderr.write('\n=== MCP Dogfood Summary ===\n\n');
  const byStatus = {
    pass: results.filter((result) => result.status === 'PASS'),
    fail: results.filter((result) => result.status === 'FAIL'),
  };
  const byTool = new Map<string, ScenarioResult[]>();
  for (const result of results) {
    const bucket = byTool.get(result.tool) ?? [];
    bucket.push(result);
    byTool.set(result.tool, bucket);
  }

  for (const tool of EXPECTED_TOOLS) {
    const toolResults = byTool.get(tool) ?? [];
    const failures = toolResults.filter((result) => result.status === 'FAIL');
    process.stderr.write(`  ${tool}: ${toolResults.length} scenarios, ${failures.length} failed\n`);
  }

  if (byStatus.fail.length > 0) {
    process.stderr.write('\nFailures:\n');
    for (const failure of byStatus.fail) {
      process.stderr.write(`  [FAIL] ${failure.tool}: ${failure.name}: ${failure.detail}\n`);
    }
  }

  const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  process.stderr.write(`\n${byStatus.pass.length} passed, ${byStatus.fail.length} failed, ${results.length} total`);
  process.stderr.write(` (${(totalMs / 1000).toFixed(1)}s summed tool time)\n\n`);
  printFixtureHints(ctx);

  if (byStatus.fail.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const missingCredentials = [
    ['HELPSCOUT_APP_ID or HELPSCOUT_CLIENT_ID', process.env.HELPSCOUT_APP_ID ?? process.env.HELPSCOUT_CLIENT_ID],
    ['HELPSCOUT_APP_SECRET or HELPSCOUT_CLIENT_SECRET', process.env.HELPSCOUT_APP_SECRET ?? process.env.HELPSCOUT_CLIENT_SECRET],
  ].filter(([, value]) => !value);

  if (missingCredentials.length > 0) {
    throw new Error(`Missing live Help Scout credentials: ${missingCredentials.map(([name]) => name).join(', ')}`);
  }

  const ctx = await runMainMatrix();
  await runRedactionMatrix(ctx);
  printSummary(ctx);
}

main().catch((err) => {
  process.stderr.write(`Fatal dogfood failure: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
