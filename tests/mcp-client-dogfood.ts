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
  originalSourceConversationId: process.env.MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID,
  originalSourceThreadId: process.env.MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID,
  attachmentConversationId: process.env.MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID,
  attachmentId: process.env.MCP_DOGFOOD_ATTACHMENT_ID,
  satisfactionRatingId: process.env.MCP_DOGFOOD_SATISFACTION_RATING_ID,
  reportStart: process.env.MCP_DOGFOOD_REPORT_START ?? daysAgoIso(30),
  reportEnd: process.env.MCP_DOGFOOD_REPORT_END ?? daysAgoIso(0),
  skipReports: process.env.MCP_DOGFOOD_SKIP_REPORTS === 'true',
};

const EXPECTED_TOOLS = [
  'searchInboxes',
  'searchConversations',
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
  'listTeams',
  'getTeamMembers',
  'listInboxCustomFields',
  'listInboxFolders',
  'listSavedReplies',
  'getSavedReply',
  'getOriginalSource',
  'getAttachment',
  'listWorkflows',
  'listWebhooks',
  'getWebhook',
  'getSatisfactionRating',
  'getCompanyReport',
  'getConversationsReport',
  'getHappinessReport',
  'getHappinessRatingsReport',
  'getProductivityReport',
  'getProductivityFirstResponseTimeReport',
  'getProductivityRepliesSentReport',
  'getProductivityResolutionTimeReport',
  'getProductivityResolvedReport',
  'getProductivityResponseTimeReport',
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
  attachmentConversationId?: string;
  attachmentId?: string;
  assigneeId?: number;
  tagId?: string;
  userId?: string;
  teamId?: string;
  savedReplyId?: string;
  webhookId?: string;
  satisfactionRatingId?: string;
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
  after?: (data: unknown, result: CallToolResult, ctx: DogfoodContext) => void;
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

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireArray(data: unknown, keys: string[], label: string): unknown[] {
  const arr = getArray(data, keys);
  requireCondition(Array.isArray(arr), `${label} is not an array`);
  return arr;
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
    scenario.after?.(data, result, ctx);
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
        if (properties[0]?.slug) ctx.organizationPropertySlug = String(properties[0].slug);
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
      tool: 'listSavedReplies',
      name: 'saved replies for inbox',
      args: (ctx) => ({ inboxId: ctx.inboxId, includeChatReplies: true }),
      validate: (data) => {
        requireArray(data, ['savedReplies', 'replies', 'results'], 'savedReplies');
      },
      after: (data, _result, ctx) => {
        const replies = getArray(data, ['savedReplies', 'replies', 'results']) as JsonObject[];
        if (replies[0]?.id) ctx.savedReplyId = String(replies[0].id);
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
        if (webhooks[0]?.id) ctx.webhookId = String(webhooks[0].id);
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
      tool: 'getConversationsReport',
      name: 'conversations overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId] }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing conversations report');
        requireCondition(getObject(report, 'current'), 'Missing current conversations report data');
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
    },
    {
      tool: 'getProductivityReport',
      name: 'productivity overall report',
      skipIf: (ctx) => ctx.skipReports ? 'Reporting scenarios disabled by MCP_DOGFOOD_SKIP_REPORTS' : undefined,
      args: (ctx) => ({ start: ctx.reportStart, end: ctx.reportEnd, mailboxes: [ctx.inboxId], officeHours: false }),
      validate: (data) => {
        const report = getObject(data, 'report');
        requireCondition(report, 'Missing productivity report');
        requireCondition(getObject(report, 'current'), 'Missing current productivity report data');
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
      args: (ctx) => ({ inboxId: ctx.inboxId, tag: GOLDEN.tag, limit: 5 }),
      validate: (data) => {
        requireArray(data, ['results', 'conversations'], 'conversations');
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
      after: (data, _result, ctx) => {
        const threads = getArray(data, ['threads']) as JsonObject[];
        if (ctx.attachmentId) return;
        for (const thread of threads) {
          const attachments = Array.isArray(thread.attachments) ? thread.attachments as JsonObject[] : [];
          const attachment = attachments.find((item) => item.id);
          if (attachment?.id) {
            ctx.attachmentConversationId = ctx.conversationId;
            ctx.attachmentId = String(attachment.id);
            break;
          }
        }
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

function printSummary(): void {
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
  printSummary();
}

main().catch((err) => {
  process.stderr.write(`Fatal dogfood failure: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
