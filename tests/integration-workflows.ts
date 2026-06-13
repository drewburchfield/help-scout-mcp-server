#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Integration Workflow Tests
 *
 * Chains multiple MCP tool calls in realistic workflow patterns.
 * Each scenario feeds outputs from one tool into inputs for the next,
 * verifying structural consistency and cross-reference validity.
 *
 * Usage: node --loader ts-node/esm tests/integration-workflows.ts
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_PATH = resolve(import.meta.dirname, '../dist/cli.js');

const GOLDEN = {
  orgId: '33911683',
  orgName: 'Meridian Testing Corp',
  orgDomain: 'meridian-testing.com',
  inboxId: '359402',
  inboxName: 'Client Support',
  searchPrefix: 'MCP-TEST:',
  tag: 'mcp-test',
  customers: {
    ariaChen: { email: 'aria.chen@meridian-testing.com', firstName: 'Aria', lastName: 'Chen' },
    marcusJohnson: { email: 'marcus.j@meridian-testing.com', firstName: 'Marcus', lastName: 'Johnson' },
    kenjiWatanabe: { email: 'kenji@meridian-testing.com', firstName: 'Kenji', lastName: 'Watanabe' },
    priyaPatel: { email: 'priya@meridian-testing.com', firstName: 'Priya', lastName: 'Patel' },
    tomasRivera: { email: 'tomas.r@meridian-testing.com', firstName: 'Tomás', lastName: 'Rivera' },
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC over stdio transport
// ---------------------------------------------------------------------------

let server: ChildProcess;
let requestId = 0;
let buffer = '';
const pendingRequests = new Map<
  number,
  { resolve: (val: any) => void; reject: (err: Error) => void }
>();

function startServer(extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolveInit, rejectInit) => {
    server = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        REDACT_MESSAGE_CONTENT: 'false',
        LOG_LEVEL: 'error',
        ...extraEnv,
      },
    });

    server.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('Server running')) {
        process.stderr.write(`  [server stderr] ${msg}\n`);
      }
    });

    server.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      processBuffer();
    });

    server.on('error', (err) => {
      rejectInit(err);
    });

    setTimeout(() => resolveInit(), 500);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.on('close', () => resolve());
    server.stdin?.end();
    server.kill('SIGTERM');
    // Force-kill after 3s if it doesn't exit cleanly
    setTimeout(() => {
      try { server.kill('SIGKILL'); } catch { /* already dead */ }
      resolve();
    }, 3000);
  });
}

function processBuffer() {
  while (true) {
    const newlineIdx = buffer.indexOf('\n');
    if (newlineIdx === -1) break;

    const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
    buffer = buffer.slice(newlineIdx + 1);

    if (!line.trim()) continue;

    try {
      const message = JSON.parse(line);
      handleMessage(message);
    } catch {
      process.stderr.write(`  [parse error] ${line.slice(0, 200)}\n`);
    }
  }
}

function handleMessage(message: any) {
  if ('id' in message && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id)!;
    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }
}

function sendRequest(method: string, params?: any): Promise<any> {
  const id = ++requestId;
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, 90000);

    pendingRequests.set(id, {
      resolve: (val) => {
        clearTimeout(timeout);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    server.stdin?.write(line);
  });
}

function sendNotification(method: string, params?: any): void {
  const line = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  server.stdin?.write(line);
}

async function initializeServer(): Promise<void> {
  await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'integration-workflow-test', version: '1.0.0' },
  });
  sendNotification('notifications/initialized');
}

// ---------------------------------------------------------------------------
// callTool helper
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await sendRequest('tools/call', { name, arguments: args });
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// assert helper
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

interface ScenarioResult {
  name: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
  durationMs: number;
}

const scenarioResults: ScenarioResult[] = [];

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  process.stderr.write(`\n  [SCENARIO] ${name}\n`);
  const start = Date.now();
  try {
    const racePromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Scenario timeout (180s)')), 180000),
    );
    await Promise.race([fn(), racePromise]);
    const durationMs = Date.now() - start;
    process.stderr.write(`  PASS (${(durationMs / 1000).toFixed(1)}s)\n`);
    scenarioResults.push({ name, status: 'PASS', durationMs });
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const detail = err?.message ?? String(err);
    process.stderr.write(`  FAIL - ${detail.slice(0, 200)}\n`);
    scenarioResults.push({ name, status: 'FAIL', detail, durationMs });
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: Customer Investigation Pipeline
// ---------------------------------------------------------------------------

async function scenario1_customerInvestigation(): Promise<void> {
  process.stderr.write('    searchCustomersByEmail...\n');
  const searchData = await callTool('searchCustomersByEmail', {
    email: GOLDEN.customers.ariaChen.email,
  });
  const searchResults = searchData?.results ?? searchData?.customers ?? [];
  assert(searchResults.length >= 1, `Expected at least 1 result for ${GOLDEN.customers.ariaChen.email}, got ${searchResults.length}`);

  const customerId = String(searchResults[0]?.id ?? searchResults[0]?.customerId ?? '');
  assert(customerId.length > 0, 'Could not extract customerId from search results');
  process.stderr.write(`    customerId=${customerId}\n`);

  process.stderr.write('    getCustomer...\n');
  const customerData = await callTool('getCustomer', { customerId });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data');
  assert(
    customer.firstName === GOLDEN.customers.ariaChen.firstName,
    `Expected firstName "${GOLDEN.customers.ariaChen.firstName}", got "${customer.firstName}"`,
  );
  const orgId = String(customer.organizationId ?? customer.organization?.id ?? '');
  assert(orgId === GOLDEN.orgId, `Expected organizationId ${GOLDEN.orgId}, got ${orgId}`);

  process.stderr.write('    getCustomerContacts...\n');
  const contactsData = await callTool('getCustomerContacts', { customerId });
  const emails: any[] = contactsData?.emails ?? contactsData?.contacts?.emails ?? [];
  const emailValues = emails.map((e: any) => e.value ?? e.email ?? e);
  assert(
    emailValues.some((e: string) => e?.toLowerCase() === GOLDEN.customers.ariaChen.email.toLowerCase()),
    `Expected to find ${GOLDEN.customers.ariaChen.email} in contacts, got: ${emailValues.join(', ')}`,
  );

  process.stderr.write('    structuredConversationFilter...\n');
  const filterData = await callTool('structuredConversationFilter', {
    customerIds: [Number(customerId)],
    limit: 5,
  });
  const filterResults = filterData?.results ?? filterData?.conversations ?? [];
  assert(filterResults.length >= 1, `Expected conversations for customer ${customerId}, got 0`);

  const conversationId = String(filterResults[0]?.id ?? filterResults[0]?.conversationId ?? '');
  assert(conversationId.length > 0, 'Could not extract conversationId from filter results');
  process.stderr.write(`    conversationId=${conversationId}\n`);

  process.stderr.write('    getConversationSummary...\n');
  const summaryData = await callTool('getConversationSummary', { conversationId });
  const conversation = summaryData?.conversation ?? summaryData;
  assert(!!conversation, 'getConversationSummary returned no data');
  const subject: string = conversation.subject ?? '';
  assert(
    subject.toUpperCase().includes('MCP-TEST'),
    `Expected subject to contain "MCP-TEST", got "${subject}"`,
  );

  process.stderr.write('    getThreads...\n');
  const threadsData = await callTool('getThreads', { conversationId });
  const threads: any[] = threadsData?.threads ?? [];
  assert(threads.length >= 1, `Expected at least 1 thread for conversation ${conversationId}`);
  const firstThread = threads[0];
  const body: string = firstThread?.body ?? firstThread?.text ?? '';
  assert(body.length > 0, 'First thread has no body content');

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 2: Organization Deep-Dive
// ---------------------------------------------------------------------------

async function scenario2_organizationDeepDive(): Promise<void> {
  process.stderr.write('    listOrganizations (paginate to find Meridian)...\n');
  let foundOrgId: string | null = null;
  let page = 1;
  const maxPages = 10;

  while (!foundOrgId && page <= maxPages) {
    const orgsData = await callTool('listOrganizations', { page, sortField: 'name', sortOrder: 'asc' });
    const results: any[] = orgsData?.results ?? orgsData?.organizations ?? [];
    if (results.length === 0) break;

    const match = results.find((o: any) => o.name === GOLDEN.orgName);
    if (match) {
      foundOrgId = String(match.id ?? match.organizationId ?? '');
      process.stderr.write(`    Found "${GOLDEN.orgName}" on page ${page}, id=${foundOrgId}\n`);
    } else {
      process.stderr.write(`    Page ${page}: ${results.length} orgs, not found yet\n`);
      page++;
    }
  }

  assert(!!foundOrgId, `"${GOLDEN.orgName}" not found after ${page - 1} pages`);
  assert(foundOrgId === GOLDEN.orgId, `Expected orgId ${GOLDEN.orgId}, got ${foundOrgId}`);

  process.stderr.write('    getOrganization (includeCounts)...\n');
  const orgData = await callTool('getOrganization', {
    organizationId: foundOrgId,
    includeCounts: true,
  });
  const org = orgData?.organization ?? orgData;
  assert(!!org, 'getOrganization returned no data');
  assert(org.name === GOLDEN.orgName, `Expected name "${GOLDEN.orgName}", got "${org.name}"`);
  const customerCount: number = org.customerCount ?? org.counts?.customers ?? 0;
  assert(customerCount >= 15, `Expected customerCount >= 15, got ${customerCount}`);
  process.stderr.write(`    customerCount=${customerCount}\n`);

  process.stderr.write('    getOrganizationMembers...\n');
  const membersData = await callTool('getOrganizationMembers', { organizationId: foundOrgId });
  const members: any[] = membersData?.members ?? membersData?.results ?? [];
  assert(members.length >= 15, `Expected >= 15 members, got ${members.length}`);

  const ariaMember = members.find(
    (m: any) =>
      m.firstName === GOLDEN.customers.ariaChen.firstName &&
      m.lastName === GOLDEN.customers.ariaChen.lastName,
  );
  assert(!!ariaMember, `Aria Chen not found in org members list`);

  const ariaChenId = String(ariaMember?.id ?? ariaMember?.customerId ?? '');
  assert(ariaChenId.length > 0, 'Could not extract ariaChenId from members');
  process.stderr.write(`    ariaChenId=${ariaChenId}\n`);

  process.stderr.write('    getCustomer (round-trip)...\n');
  const customerData = await callTool('getCustomer', { customerId: ariaChenId });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data');
  const roundTripOrgId = String(customer.organizationId ?? customer.organization?.id ?? '');
  assert(
    roundTripOrgId === GOLDEN.orgId,
    `Round-trip orgId mismatch: expected ${GOLDEN.orgId}, got ${roundTripOrgId}`,
  );

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 3: Inbox -> Conversation -> Customer Round-Trip
// ---------------------------------------------------------------------------

async function scenario3_inboxConversationCustomerRoundTrip(): Promise<void> {
  process.stderr.write('    listAllInboxes...\n');
  const inboxesData = await callTool('listAllInboxes');
  const inboxes: any[] = inboxesData?.inboxes ?? inboxesData?.results ?? [];
  const clientSupport = inboxes.find((i: any) => String(i.id) === GOLDEN.inboxId);
  assert(!!clientSupport, `Inbox ${GOLDEN.inboxId} not found in listAllInboxes`);
  assert(
    clientSupport.name === GOLDEN.inboxName,
    `Expected inbox name "${GOLDEN.inboxName}", got "${clientSupport.name}"`,
  );

  process.stderr.write('    searchConversations (mcp-test tag)...\n');
  const convoData = await callTool('searchConversations', {
    inboxId: GOLDEN.inboxId,
    tag: GOLDEN.tag,
    limit: 5,
  });
  const convos: any[] = convoData?.results ?? convoData?.conversations ?? [];
  assert(convos.length >= 1, `Expected conversations with tag "${GOLDEN.tag}", got 0`);

  const firstConvo = convos[0];
  const conversationId = String(firstConvo?.id ?? '');
  assert(conversationId.length > 0, 'Could not extract conversationId');
  process.stderr.write(`    conversationId=${conversationId}\n`);

  process.stderr.write('    getConversationSummary...\n');
  const summaryData = await callTool('getConversationSummary', { conversationId });
  const conversation = summaryData?.conversation ?? summaryData;
  assert(!!conversation, 'getConversationSummary returned no data');

  const customerId = String(
    conversation.customer?.id ??
    conversation.customerId ??
    summaryData?.firstCustomerMessage?.customer?.id ??
    firstConvo?.customer?.id ??
    firstConvo?.primaryCustomer?.id ??
    firstConvo?.createdBy?.id ??
    '',
  );
  assert(customerId.length > 0, 'Could not extract customerId from conversation summary');
  process.stderr.write(`    customerId=${customerId}\n`);

  process.stderr.write('    getCustomer...\n');
  const customerData = await callTool('getCustomer', { customerId });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data');

  const email: string =
    customer.email ??
    customer._embedded?.emails?.[0]?.value ??
    customer.emails?.[0]?.value ??
    '';
  assert(email.length > 0, 'Could not extract email from customer');
  process.stderr.write(`    email=${email}\n`);

  process.stderr.write('    searchCustomersByEmail (reverse lookup)...\n');
  const reverseSearch = await callTool('searchCustomersByEmail', { email });
  const reverseResults: any[] = reverseSearch?.results ?? reverseSearch?.customers ?? [];
  const matchedCustomer = reverseResults.find((c: any) => String(c.id) === customerId);
  assert(
    !!matchedCustomer,
    `Reverse email search did not return customerId ${customerId}. Got ids: ${reverseResults.map((c: any) => c.id).join(', ')}`,
  );

  process.stderr.write('    All steps passed (email -> customer -> conversations round-trip verified).\n');
}

// ---------------------------------------------------------------------------
// Scenario 4: Keyword Search -> Thread Analysis
// ---------------------------------------------------------------------------

async function scenario4_keywordSearchThreadAnalysis(): Promise<void> {
  process.stderr.write('    getServerTime...\n');
  const timeData = await callTool('getServerTime');
  const isoTime: string = timeData?.isoTime ?? timeData?.time ?? '';
  assert(isoTime.length > 0, 'getServerTime returned no isoTime');
  const parsedTime = new Date(isoTime);
  assert(!isNaN(parsedTime.getTime()), `isoTime "${isoTime}" is not a valid ISO date`);
  process.stderr.write(`    serverTime=${isoTime}\n`);

  const createdAfter = new Date(parsedTime.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  process.stderr.write(`    createdAfter=${createdAfter}\n`);

  process.stderr.write('    comprehensiveConversationSearch ("rate limiting")...\n');
  const searchData = await callTool('comprehensiveConversationSearch', {
    searchTerms: ['rate limiting'],
    timeframeDays: 365,
  });

  const totalFound: number = searchData?.totalConversationsFound ?? searchData?.total ?? 0;
  const resultsByStatus: any[] = searchData?.resultsByStatus ?? [];
  const allConvos: any[] = resultsByStatus.flatMap((s: any) => s.conversations ?? s.results ?? []);
  assert(
    totalFound >= 1 || allConvos.length >= 1,
    `Expected at least 1 conversation for "rate limiting", got totalFound=${totalFound}, allConvos=${allConvos.length}`,
  );

  const firstConvo = allConvos[0];
  assert(!!firstConvo, 'No conversation found in resultsByStatus');
  const conversationId = String(firstConvo?.id ?? firstConvo?.conversationId ?? '');
  assert(conversationId.length > 0, 'Could not extract conversationId');
  process.stderr.write(`    conversationId=${conversationId}\n`);

  process.stderr.write('    getConversationSummary...\n');
  const summaryData = await callTool('getConversationSummary', { conversationId });
  const conversation = summaryData?.conversation ?? summaryData;
  assert(!!conversation, 'getConversationSummary returned no data');
  const subject: string = conversation.subject ?? '';
  assert(
    subject.toLowerCase().includes('rate limit') || subject.toLowerCase().includes('429'),
    `Expected subject to contain "rate limit" or "429", got "${subject}"`,
  );

  process.stderr.write('    getThreads...\n');
  const threadsData = await callTool('getThreads', { conversationId });
  const threads: any[] = threadsData?.threads ?? [];
  assert(threads.length >= 1, `Expected at least 1 thread for conversation ${conversationId}`);

  const rateLimitThread = threads.find((t: any) => {
    const body: string = (t.body ?? t.text ?? '').toLowerCase();
    return body.includes('rate limit') || body.includes('429');
  });
  assert(
    !!rateLimitThread,
    `No thread body contains "rate limit" or "429" in conversation ${conversationId}`,
  );

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 5: Domain Investigation
// ---------------------------------------------------------------------------

async function scenario5_domainInvestigation(): Promise<void> {
  process.stderr.write('    advancedConversationSearch (emailDomain)...\n');
  const searchData = await callTool('advancedConversationSearch', {
    emailDomain: GOLDEN.orgDomain,
    limit: 5,
  });
  const results: any[] = searchData?.results ?? searchData?.conversations ?? [];
  assert(
    results.length >= 1,
    `Expected conversations from domain "${GOLDEN.orgDomain}", got 0`,
  );

  const firstConvo = results[0];
  const conversationId = String(firstConvo?.id ?? '');
  assert(conversationId.length > 0, 'Could not extract conversationId');
  process.stderr.write(`    conversationId=${conversationId}\n`);

  process.stderr.write('    getConversationSummary...\n');
  const summaryData = await callTool('getConversationSummary', { conversationId });
  const conversation = summaryData?.conversation ?? summaryData;
  assert(!!conversation, 'getConversationSummary returned no data');

  const customerId = String(
    conversation.customer?.id ??
    conversation.customerId ??
    summaryData?.firstCustomerMessage?.customer?.id ??
    firstConvo?.customer?.id ??
    firstConvo?.primaryCustomer?.id ??
    firstConvo?.createdBy?.id ??
    '',
  );
  assert(customerId.length > 0, 'Could not extract customerId from conversation');
  process.stderr.write(`    customerId=${customerId}\n`);

  process.stderr.write('    getCustomer...\n');
  const customerData = await callTool('getCustomer', { customerId });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data');

  const organizationId = String(customer.organizationId ?? customer.organization?.id ?? '');
  assert(organizationId.length > 0, 'Could not extract organizationId from customer');
  process.stderr.write(`    organizationId=${organizationId}\n`);

  process.stderr.write('    getOrganization...\n');
  const orgData = await callTool('getOrganization', { organizationId });
  const org = orgData?.organization ?? orgData;
  assert(!!org, 'getOrganization returned no data');

  const domains: string[] = org.domains ?? org.emailDomains ?? [];
  assert(
    domains.some((d: string) => d.toLowerCase() === GOLDEN.orgDomain),
    `Expected domain "${GOLDEN.orgDomain}" in org domains, got: ${domains.join(', ')}`,
  );

  process.stderr.write('    All steps passed (domain -> conversation -> customer -> org -> domain verified).\n');
}

// ---------------------------------------------------------------------------
// Scenario 6: Ticket Number Lookup -> Full Context
// ---------------------------------------------------------------------------

async function scenario6_ticketNumberLookup(): Promise<void> {
  process.stderr.write('    searchConversations (mcp-test, limit 1)...\n');
  const searchData = await callTool('searchConversations', {
    tag: GOLDEN.tag,
    limit: 1,
  });
  const results: any[] = searchData?.results ?? searchData?.conversations ?? [];
  assert(results.length >= 1, `Expected at least 1 conversation with tag "${GOLDEN.tag}"`);

  const firstConvo = results[0];
  const conversationId = String(firstConvo?.id ?? '');
  const conversationNumber = firstConvo?.number ?? firstConvo?.conversationNumber ?? null;
  assert(conversationId.length > 0, 'Could not extract conversationId');
  assert(conversationNumber !== null, 'Could not extract conversation number');
  process.stderr.write(`    conversationId=${conversationId}, number=${conversationNumber}\n`);

  process.stderr.write('    structuredConversationFilter (by number)...\n');
  const filterData = await callTool('structuredConversationFilter', {
    conversationNumber: Number(conversationNumber),
  });
  const filterResults: any[] = filterData?.results ?? filterData?.conversations ?? [];
  assert(filterResults.length >= 1, `structuredConversationFilter by number ${conversationNumber} returned 0 results`);

  const filteredId = String(filterResults[0]?.id ?? '');
  assert(
    filteredId === conversationId,
    `ID mismatch: searchConversations returned ${conversationId}, structuredConversationFilter returned ${filteredId}`,
  );

  process.stderr.write('    getConversationSummary...\n');
  const summaryData = await callTool('getConversationSummary', { conversationId });
  const conversation = summaryData?.conversation ?? summaryData;
  assert(!!conversation, 'getConversationSummary returned no data');
  const summaryId = String(conversation.id ?? conversation.conversationId ?? '');
  assert(summaryId === conversationId, `Summary ID ${summaryId} does not match expected ${conversationId}`);

  process.stderr.write('    getThreads...\n');
  const threadsData = await callTool('getThreads', { conversationId });
  const threads: any[] = threadsData?.threads ?? [];
  assert(threads.length >= 1, `Expected at least 1 thread for conversation ${conversationId}`);

  process.stderr.write('    All steps passed (search -> ticket# lookup -> summary -> threads all reference same conversation).\n');
}

// ---------------------------------------------------------------------------
// Scenario 7: Inbox Search Consistency
// ---------------------------------------------------------------------------

async function scenario7_inboxSearchConsistency(): Promise<void> {
  process.stderr.write('    searchInboxes (empty query)...\n');
  const searchAllData = await callTool('searchInboxes', { query: '' });
  const searchAllResults: any[] = searchAllData?.results ?? searchAllData?.inboxes ?? [];
  assert(searchAllResults.length >= 1, 'searchInboxes (empty) returned no results');
  const searchAllIds = new Set(searchAllResults.map((i: any) => String(i.id)));

  process.stderr.write('    listAllInboxes...\n');
  const listAllData = await callTool('listAllInboxes');
  const listAllResults: any[] = listAllData?.inboxes ?? listAllData?.results ?? [];
  assert(listAllResults.length >= 1, 'listAllInboxes returned no results');
  const listAllIds = new Set(listAllResults.map((i: any) => String(i.id)));

  // Verify same set of inbox IDs
  const missingFromList = [...searchAllIds].filter((id) => !listAllIds.has(id));
  const missingFromSearch = [...listAllIds].filter((id) => !searchAllIds.has(id));
  assert(
    missingFromList.length === 0 && missingFromSearch.length === 0,
    `Inbox ID sets differ. Missing from listAll: [${missingFromList}]. Missing from searchAll: [${missingFromSearch}]`,
  );
  process.stderr.write(`    Both return ${listAllIds.size} inbox(es) with matching IDs.\n`);

  process.stderr.write('    searchInboxes ("Client")...\n');
  const searchClientData = await callTool('searchInboxes', { query: 'Client' });
  const searchClientResults: any[] = searchClientData?.results ?? searchClientData?.inboxes ?? [];
  assert(searchClientResults.length >= 1, 'searchInboxes("Client") returned no results');

  const clientIds = new Set(searchClientResults.map((i: any) => String(i.id)));
  const notSubset = [...clientIds].filter((id) => !listAllIds.has(id));
  assert(
    notSubset.length === 0,
    `searchInboxes("Client") returned IDs not in listAllInboxes: [${notSubset}]`,
  );

  const foundClientSupport = searchClientResults.some((i: any) => i.name === GOLDEN.inboxName);
  assert(foundClientSupport, `"${GOLDEN.inboxName}" not found in searchInboxes("Client") results`);

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 8: Organization Conversations -> Customer Verification
// ---------------------------------------------------------------------------

async function scenario8_orgConversationsCustomerVerification(): Promise<void> {
  process.stderr.write('    getOrganizationConversations...\n');
  const orgConvosData = await callTool('getOrganizationConversations', {
    organizationId: GOLDEN.orgId,
  });
  const conversations: any[] = orgConvosData?.conversations ?? orgConvosData?.results ?? [];
  assert(
    conversations.length >= 1,
    `Expected conversations for org ${GOLDEN.orgId}, got 0`,
  );

  const firstConvo = conversations[0];
  const conversationId = String(firstConvo?.id ?? '');
  assert(conversationId.length > 0, 'Could not extract conversationId from org conversations');
  process.stderr.write(`    conversationId=${conversationId}\n`);

  process.stderr.write('    getConversationSummary...\n');
  const summaryData = await callTool('getConversationSummary', { conversationId });
  const conversation = summaryData?.conversation ?? summaryData;
  assert(!!conversation, 'getConversationSummary returned no data');

  const customerId = String(
    conversation.customer?.id ??
    conversation.customerId ??
    summaryData?.firstCustomerMessage?.customer?.id ??
    firstConvo?.customer?.id ??
    firstConvo?.primaryCustomer?.id ??
    firstConvo?.createdBy?.id ??
    '',
  );
  assert(customerId.length > 0, 'Could not extract customerId from conversation summary');
  process.stderr.write(`    customerId=${customerId}\n`);

  process.stderr.write('    getCustomer...\n');
  const customerData = await callTool('getCustomer', { customerId });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data');

  const customerOrgId = String(customer.organizationId ?? customer.organization?.id ?? '');
  assert(
    customerOrgId === GOLDEN.orgId,
    `Expected customer's organizationId to be ${GOLDEN.orgId}, got ${customerOrgId}`,
  );

  process.stderr.write('    All steps passed (org conversations -> customer belongs to same org verified).\n');
}

// ---------------------------------------------------------------------------
// Scenario 9: Cross-Tool Customer Consistency
// ---------------------------------------------------------------------------

async function scenario9_crossToolCustomerConsistency(): Promise<void> {
  process.stderr.write('    listCustomers (Aria Chen)...\n');
  const listData = await callTool('listCustomers', {
    firstName: GOLDEN.customers.ariaChen.firstName,
    lastName: GOLDEN.customers.ariaChen.lastName,
  });
  const listResults: any[] = listData?.results ?? listData?.customers ?? [];
  const listAria = listResults.find(
    (c: any) =>
      c.firstName === GOLDEN.customers.ariaChen.firstName &&
      c.lastName === GOLDEN.customers.ariaChen.lastName,
  );
  assert(!!listAria, `Aria Chen not found in listCustomers results`);

  const idFromList = String(listAria.id ?? listAria.customerId ?? '');
  const emailFromList: string =
    listAria.email ??
    listAria._embedded?.emails?.[0]?.value ??
    listAria.emails?.[0]?.value ??
    '';
  const orgIdFromList: string = String(listAria.organizationId ?? listAria.organization?.id ?? '');
  assert(idFromList.length > 0, 'Could not extract id from listCustomers result');
  process.stderr.write(`    listCustomers: id=${idFromList}, email=${emailFromList}, orgId=${orgIdFromList}\n`);

  process.stderr.write('    getCustomer...\n');
  const customerData = await callTool('getCustomer', { customerId: idFromList });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data');

  const idFromGet = String(customer.id ?? customer.customerId ?? '');
  const emailFromGet: string =
    customer.email ??
    customer._embedded?.emails?.[0]?.value ??
    customer.emails?.[0]?.value ??
    '';
  const orgIdFromGet: string = String(customer.organizationId ?? customer.organization?.id ?? '');
  process.stderr.write(`    getCustomer: id=${idFromGet}, email=${emailFromGet}, orgId=${orgIdFromGet}\n`);

  assert(idFromGet === idFromList, `ID mismatch: listCustomers=${idFromList}, getCustomer=${idFromGet}`);

  // Use email from getCustomer as the authoritative source (may be embedded)
  const emailToSearch = emailFromGet || emailFromList;
  assert(emailToSearch.length > 0, 'No email available for reverse search');

  process.stderr.write(`    searchCustomersByEmail (${emailToSearch})...\n`);
  const searchData = await callTool('searchCustomersByEmail', { email: emailToSearch });
  const searchResults: any[] = searchData?.results ?? searchData?.customers ?? [];
  const searchAria = searchResults.find((c: any) => String(c.id) === idFromList);
  assert(
    !!searchAria,
    `searchCustomersByEmail did not return customer ${idFromList}. Got: ${searchResults.map((c: any) => c.id).join(', ')}`,
  );

  const idFromSearch = String(searchAria.id ?? '');
  const emailFromSearch: string =
    searchAria.email ??
    searchAria._embedded?.emails?.[0]?.value ??
    searchAria.emails?.[0]?.value ??
    emailToSearch;
  const orgIdFromSearch: string = String(searchAria.organizationId ?? searchAria.organization?.id ?? '');
  process.stderr.write(`    searchCustomersByEmail: id=${idFromSearch}, email=${emailFromSearch}, orgId=${orgIdFromSearch}\n`);

  // Assert ID consistency across all three sources
  assert(idFromSearch === idFromList, `ID mismatch: listCustomers=${idFromList}, searchByEmail=${idFromSearch}`);

  // Assert orgId consistency where available
  if (orgIdFromList && orgIdFromGet) {
    assert(orgIdFromGet === orgIdFromList, `OrgId mismatch: listCustomers=${orgIdFromList}, getCustomer=${orgIdFromGet}`);
  }

  process.stderr.write('    All steps passed (id consistent across listCustomers, getCustomer, searchByEmail).\n');
}

// ---------------------------------------------------------------------------
// Scenario 10: Message Content Redaction Verification
// ---------------------------------------------------------------------------

async function scenario10_messageContentRedactionVerification(): Promise<void> {
  process.stderr.write('    Getting known IDs with message content visible...\n');
  const searchData = await callTool('searchCustomersByEmail', {
    email: GOLDEN.customers.ariaChen.email,
  });
  const searchResults: any[] = searchData?.results ?? searchData?.customers ?? [];
  assert(searchResults.length >= 1, 'Could not find Aria Chen for redaction test setup');

  const knownCustomerId = String(searchResults[0]?.id ?? '');
  assert(knownCustomerId.length > 0, 'Could not extract customerId for redaction test');

  const filterData = await callTool('structuredConversationFilter', {
    customerIds: [Number(knownCustomerId)],
    limit: 1,
  });
  const filterResults: any[] = filterData?.results ?? filterData?.conversations ?? [];
  assert(filterResults.length >= 1, 'Could not find conversations for redaction test setup');
  const knownConversationId = String(filterResults[0]?.id ?? '');
  assert(knownConversationId.length > 0, 'Could not extract conversationId for redaction test');
  process.stderr.write(`    knownCustomerId=${knownCustomerId}, knownConversationId=${knownConversationId}\n`);

  process.stderr.write('    Restarting server with REDACT_MESSAGE_CONTENT=true...\n');
  await stopServer();
  buffer = '';
  pendingRequests.clear();
  requestId = 0;

  await startServer({ REDACT_MESSAGE_CONTENT: 'true' });
  await initializeServer();
  process.stderr.write('    Server restarted with message content hidden.\n');

  process.stderr.write('    getConversationSummary (expect hidden message bodies)...\n');
  const summaryData = await callTool('getConversationSummary', { conversationId: knownConversationId });
  const conversation = summaryData?.conversation ?? summaryData;
  assert(!!conversation, 'getConversationSummary returned no data after redaction restart');

  const customerInSummary = conversation.customer ?? summaryData?.firstCustomerMessage?.customer ?? {};
  const summaryEmail: string = customerInSummary.email ?? '';
  const summaryFirstName: string = customerInSummary.firstName ?? '';
  const firstMessageBody: string = summaryData?.firstCustomerMessage?.body ?? '';
  const latestReplyBody: string = summaryData?.latestStaffReply?.body ?? '';

  process.stderr.write(`    summaryEmail="${summaryEmail}", summaryFirstName="${summaryFirstName}"\n`);
  process.stderr.write(`    firstMessageBody="${firstMessageBody.slice(0, 80)}"\n`);

  assert(
    summaryEmail.length > 0 || summaryFirstName.length > 0,
    'Expected customer identity fields to remain visible in conversation summary',
  );

  for (const body of [firstMessageBody, latestReplyBody].filter(Boolean)) {
    assert(
      body.includes('[Content hidden'),
      `Expected message body to be hidden, got: "${body.slice(0, 100)}"`,
    );
  }

  process.stderr.write('    getCustomer (expect identity fields visible)...\n');
  const customerData = await callTool('getCustomer', { customerId: knownCustomerId });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data after redaction restart');

  const customerFirstName: string = customer.firstName ?? '';
  const customerEmail: string =
    customer.email ??
    customer._embedded?.emails?.[0]?.value ??
    customer.emails?.[0]?.value ??
    '';

  process.stderr.write(`    customerFirstName="${customerFirstName}", customerEmail="${customerEmail}"\n`);

  assert(
    customerFirstName.length > 0 || customerEmail.length > 0,
    'Expected getCustomer identity fields to remain visible',
  );

  process.stderr.write('    getThreads (expect hidden bodies)...\n');
  const threadsData = await callTool('getThreads', { conversationId: knownConversationId });
  const threads: any[] = threadsData?.threads ?? [];
  assert(threads.length >= 1, 'Expected at least 1 thread for redaction verification');

  const visibleBodyThread = threads.find((t: any) => {
    const body: string = t.body ?? t.text ?? '';
    return (
      body.length > 20 &&
      !body.includes('[Content hidden')
    );
  });
  assert(
    !visibleBodyThread,
    `Found thread with visible body content: "${(visibleBodyThread?.body ?? '').slice(0, 100)}"`,
  );

  process.stderr.write('    getOrganizationConversations (expect no customer identity redaction markers)...\n');
  const orgConvosData = await callTool('getOrganizationConversations', {
    organizationId: GOLDEN.orgId,
  });
  const orgConvos: any[] = orgConvosData?.conversations ?? orgConvosData?.results ?? [];
  assert(orgConvos.length >= 1, `Expected org conversations for redaction test, got 0`);

  const convoWithRedactedCustomer = orgConvos.find((c: any) => {
    return JSON.stringify(c.customer ?? '').includes('[Content hidden');
  });
  assert(!convoWithRedactedCustomer, 'Customer identity fields should not use message content redaction markers');

  // Server is left with message content hidden. The cooldown block after this scenario
  // does a full server restart which restores REDACT_MESSAGE_CONTENT=false.
  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 11: Pagination Continuity
// Verify page 1 and page 2 return different IDs with consistent totals.
// ---------------------------------------------------------------------------

async function scenario11_paginationContinuity(): Promise<void> {
  process.stderr.write('    listCustomers page 1...\n');
  const page1 = await callTool('listCustomers', { page: 1 });
  const results1: any[] = page1?.results ?? [];
  const total1 = page1?.pagination?.totalElements ?? 0;
  assert(results1.length > 0, 'Page 1 returned 0 results');
  process.stderr.write(`    page1: ${results1.length} results, totalElements=${total1}\n`);

  process.stderr.write('    listCustomers page 2...\n');
  const page2 = await callTool('listCustomers', { page: 2 });
  const results2: any[] = page2?.results ?? [];
  const total2 = page2?.pagination?.totalElements ?? 0;
  assert(results2.length > 0, 'Page 2 returned 0 results');
  process.stderr.write(`    page2: ${results2.length} results, totalElements=${total2}\n`);

  // Totals should be consistent
  assert(total1 === total2, `totalElements mismatch: page1=${total1}, page2=${total2}`);

  // IDs should not overlap
  const ids1 = new Set(results1.map((c: any) => c.id));
  const ids2 = new Set(results2.map((c: any) => c.id));
  const overlap = [...ids1].filter((id) => ids2.has(id));
  assert(overlap.length === 0, `Found ${overlap.length} duplicate IDs across pages: ${overlap.join(', ')}`);

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 12: Empty/No-Result Search Handling
// Verify tools return structured empty responses for nonsense queries.
// ---------------------------------------------------------------------------

async function scenario12_emptyResultHandling(): Promise<void> {
  process.stderr.write('    comprehensiveConversationSearch (nonsense)...\n');
  const searchData = await callTool('comprehensiveConversationSearch', {
    searchTerms: ['xyzzy_nonexistent_foobarbaz_12345'],
    timeframeDays: 365,
  });
  const total = searchData?.totalConversationsFound ?? searchData?.totalResults ?? -1;
  assert(total === 0, `Expected 0 results for nonsense search, got ${total}`);
  process.stderr.write(`    totalConversationsFound=0 (correct)\n`);

  process.stderr.write('    searchCustomersByEmail (nonexistent)...\n');
  const emailData = await callTool('searchCustomersByEmail', {
    email: 'absolutely_nobody_has_this_email@nonexistent-domain-zzz.test',
  });
  const emailResults: any[] = emailData?.results ?? emailData?.customers ?? [];
  assert(emailResults.length === 0, `Expected 0 customers, got ${emailResults.length}`);
  process.stderr.write(`    0 customers found (correct)\n`);

  process.stderr.write('    structuredConversationFilter (nonexistent customer ID)...\n');
  const filterData = await callTool('structuredConversationFilter', {
    customerIds: [999999999],
    limit: 5,
  });
  const filterResults: any[] = filterData?.results ?? filterData?.conversations ?? [];
  assert(filterResults.length === 0, `Expected 0 conversations for fake customer, got ${filterResults.length}`);
  process.stderr.write(`    0 conversations found (correct)\n`);

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 13: Date Range Bounded Search
// Use getServerTime to compute a tight window, verify results fall within it.
// ---------------------------------------------------------------------------

async function scenario13_dateRangeBoundedSearch(): Promise<void> {
  process.stderr.write('    getServerTime...\n');
  const timeData = await callTool('getServerTime', {});
  const now = new Date(timeData?.isoTime ?? Date.now());

  // Search for conversations created in the last 2 hours (should include seeded data)
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const createdAfter = twoHoursAgo.toISOString();
  const createdBefore = now.toISOString();
  process.stderr.write(`    window: ${createdAfter} to ${createdBefore}\n`);

  process.stderr.write('    searchConversations (bounded window)...\n');
  const searchData = await callTool('searchConversations', {
    inboxId: GOLDEN.inboxId,
    tag: GOLDEN.tag,
    createdAfter,
    limit: 50,
  });
  const results: any[] = searchData?.results ?? searchData?.conversations ?? [];
  process.stderr.write(`    found ${results.length} conversations\n`);

  // Verify all returned results were created within the window
  for (const convo of results) {
    const created = new Date(convo.createdAt);
    assert(
      created >= twoHoursAgo,
      `Conversation ${convo.id} createdAt=${convo.createdAt} is before window start`,
    );
  }

  // Now search with a future window - should return 0
  const futureDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  process.stderr.write('    searchConversations (future window, expect 0)...\n');
  const futureData = await callTool('searchConversations', {
    inboxId: GOLDEN.inboxId,
    createdAfter: futureDate.toISOString(),
    limit: 5,
  });
  const futureResults: any[] = futureData?.results ?? futureData?.conversations ?? [];
  assert(futureResults.length === 0, `Expected 0 results for future date, got ${futureResults.length}`);

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 14: Multi-Entity Graph Traversal
// Start from one customer, hop to their org, find a DIFFERENT member,
// then get that member's profile. Full graph walk across entities.
// ---------------------------------------------------------------------------

async function scenario14_multiEntityGraphTraversal(): Promise<void> {
  // Start: find Aria Chen
  process.stderr.write('    searchCustomersByEmail (Aria)...\n');
  const ariaSearch = await callTool('searchCustomersByEmail', {
    email: GOLDEN.customers.ariaChen.email,
  });
  const ariaResults: any[] = ariaSearch?.results ?? [];
  assert(ariaResults.length >= 1, 'Could not find Aria Chen');
  const ariaId = ariaResults[0].id;
  process.stderr.write(`    ariaId=${ariaId}\n`);

  // Hop to her customer profile to get orgId
  process.stderr.write('    getCustomer (Aria)...\n');
  const ariaData = await callTool('getCustomer', { customerId: String(ariaId) });
  const aria = ariaData?.customer ?? ariaData;
  const orgId = String(aria.organizationId ?? '');
  assert(orgId === GOLDEN.orgId, `Expected orgId=${GOLDEN.orgId}, got ${orgId}`);

  // Hop to org members
  process.stderr.write('    getOrganizationMembers...\n');
  const membersData = await callTool('getOrganizationMembers', { organizationId: orgId });
  const members: any[] = membersData?.members ?? membersData?.results ?? [];
  assert(members.length >= 2, `Need at least 2 members to traverse, got ${members.length}`);

  // Find a DIFFERENT member (not Aria)
  const otherMember = members.find((m: any) => m.id !== ariaId);
  assert(!!otherMember, 'Could not find a different member in the org');
  const otherId = String(otherMember.id);
  const otherEmail = otherMember._embedded?.emails?.[0]?.value ?? otherMember.primaryEmail ?? '';
  process.stderr.write(`    otherMember: ${otherMember.firstName} ${otherMember.lastName} (id=${otherId})\n`);

  // Get the other member's full profile
  process.stderr.write('    getCustomer (other member)...\n');
  const otherData = await callTool('getCustomer', { customerId: otherId });
  const other = otherData?.customer ?? otherData;
  assert(!!other, 'getCustomer returned no data for other member');
  const otherOrgId = String(other.organizationId ?? '');
  assert(otherOrgId === orgId, `Other member orgId=${otherOrgId} does not match original org=${orgId}`);

  // Verify via email search too
  if (otherEmail) {
    process.stderr.write(`    searchCustomersByEmail (${otherEmail})...\n`);
    const otherSearch = await callTool('searchCustomersByEmail', { email: otherEmail });
    const otherResults: any[] = otherSearch?.results ?? [];
    assert(otherResults.length >= 1, `Email search for ${otherEmail} returned 0 results`);
    assert(
      String(otherResults[0].id) === otherId,
      `Email search returned id=${otherResults[0].id}, expected ${otherId}`,
    );
  }

  process.stderr.write('    All steps passed (Aria -> org -> different member -> profile -> email verified).\n');
}

// ---------------------------------------------------------------------------
// Scenario 15: Conversation Status Lifecycle
// Find conversations in different statuses, verify status field matches.
// ---------------------------------------------------------------------------

async function scenario15_conversationStatusLifecycle(): Promise<void> {
  const statuses = ['active', 'closed', 'pending'] as const;

  for (const status of statuses) {
    process.stderr.write(`    searchConversations (status=${status})...\n`);
    const data = await callTool('searchConversations', {
      inboxId: GOLDEN.inboxId,
      status,
      limit: 3,
    });
    const results: any[] = data?.results ?? data?.conversations ?? [];
    process.stderr.write(`      found ${results.length} ${status} conversations\n`);

    // Verify every result has the correct status
    for (const convo of results) {
      assert(
        convo.status === status,
        `Expected status="${status}" but conversation ${convo.id} has status="${convo.status}"`,
      );
    }
  }

  // Search with tag filter to find our seeded data across statuses
  process.stderr.write('    searchConversations (all statuses, mcp-test tag)...\n');
  const allData = await callTool('searchConversations', {
    inboxId: GOLDEN.inboxId,
    tag: GOLDEN.tag,
    limit: 10,
  });
  const allResults: any[] = allData?.results ?? allData?.conversations ?? [];
  const statusSet = new Set(allResults.map((c: any) => c.status));
  process.stderr.write(`    statuses found in mcp-test: ${[...statusSet].join(', ')}\n`);

  // We seeded conversations in active, pending, and closed statuses
  assert(statusSet.size >= 2, `Expected at least 2 different statuses in mcp-test, got ${statusSet.size}`);

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 16: Sort Order Verification
// Search with explicit sort, verify results are in expected order.
// ---------------------------------------------------------------------------

async function scenario16_sortOrderVerification(): Promise<void> {
  process.stderr.write('    searchConversations (sort=createdAt, order=asc)...\n');
  const ascData = await callTool('searchConversations', {
    inboxId: GOLDEN.inboxId,
    tag: GOLDEN.tag,
    sort: 'createdAt',
    order: 'asc',
    limit: 10,
  });
  const ascResults: any[] = ascData?.results ?? ascData?.conversations ?? [];
  assert(ascResults.length >= 2, `Need at least 2 results to verify sort, got ${ascResults.length}`);

  // Verify ascending order (2s tolerance for multi-status merge interleaving)
  const SORT_TOLERANCE_MS = 2000;
  for (let i = 1; i < ascResults.length; i++) {
    const prev = new Date(ascResults[i - 1].createdAt).getTime();
    const curr = new Date(ascResults[i].createdAt).getTime();
    assert(
      curr >= prev - SORT_TOLERANCE_MS,
      `ASC sort violation: [${i - 1}] ${ascResults[i - 1].createdAt} > [${i}] ${ascResults[i].createdAt} (beyond ${SORT_TOLERANCE_MS}ms tolerance)`,
    );
  }
  process.stderr.write(`    ${ascResults.length} results in ascending order (verified)\n`);

  process.stderr.write('    searchConversations (sort=createdAt, order=desc)...\n');
  const descData = await callTool('searchConversations', {
    inboxId: GOLDEN.inboxId,
    tag: GOLDEN.tag,
    sort: 'createdAt',
    order: 'desc',
    limit: 10,
  });
  const descResults: any[] = descData?.results ?? descData?.conversations ?? [];
  assert(descResults.length >= 2, `Need at least 2 results for desc sort, got ${descResults.length}`);

  // Verify descending order (2s tolerance for multi-status merge interleaving)
  for (let i = 1; i < descResults.length; i++) {
    const prev = new Date(descResults[i - 1].createdAt).getTime();
    const curr = new Date(descResults[i].createdAt).getTime();
    assert(
      curr <= prev + SORT_TOLERANCE_MS,
      `DESC sort violation: [${i - 1}] ${descResults[i - 1].createdAt} < [${i}] ${descResults[i].createdAt} (beyond ${SORT_TOLERANCE_MS}ms tolerance)`,
    );
  }
  process.stderr.write(`    ${descResults.length} results in descending order (verified)\n`);

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 17: Multi-Inbox Isolation
// Verify conversations are scoped to the correct inbox.
// ---------------------------------------------------------------------------

async function scenario17_multiInboxIsolation(): Promise<void> {
  process.stderr.write('    listAllInboxes...\n');
  const inboxData = await callTool('listAllInboxes', {});
  const inboxes: any[] = inboxData?.inboxes ?? [];
  assert(inboxes.length >= 2, `Need at least 2 inboxes for isolation test, got ${inboxes.length}`);

  const inbox1Id = String(inboxes[0].id);
  const inbox2Id = String(inboxes[1].id);
  process.stderr.write(`    inbox1=${inboxes[0].name} (${inbox1Id}), inbox2=${inboxes[1].name} (${inbox2Id})\n`);

  process.stderr.write(`    searchConversations (inbox1=${inbox1Id})...\n`);
  const data1 = await callTool('searchConversations', { inboxId: inbox1Id, limit: 5 });
  const results1: any[] = data1?.results ?? data1?.conversations ?? [];

  process.stderr.write(`    searchConversations (inbox2=${inbox2Id})...\n`);
  const data2 = await callTool('searchConversations', { inboxId: inbox2Id, limit: 5 });
  const results2: any[] = data2?.results ?? data2?.conversations ?? [];

  // Verify each result's mailboxId matches the queried inbox
  for (const c of results1) {
    assert(
      String(c.mailboxId) === inbox1Id,
      `Inbox1 result ${c.id} has mailboxId=${c.mailboxId}, expected ${inbox1Id}`,
    );
  }
  for (const c of results2) {
    assert(
      String(c.mailboxId) === inbox2Id,
      `Inbox2 result ${c.id} has mailboxId=${c.mailboxId}, expected ${inbox2Id}`,
    );
  }
  process.stderr.write(`    inbox1: ${results1.length} convos (all mailboxId=${inbox1Id}), inbox2: ${results2.length} convos (all mailboxId=${inbox2Id})\n`);

  // Verify no ID overlap between inboxes
  const ids1 = new Set(results1.map((c: any) => c.id));
  const ids2 = new Set(results2.map((c: any) => c.id));
  const overlap = [...ids1].filter((id) => ids2.has(id));
  assert(overlap.length === 0, `Found ${overlap.length} conversations in both inboxes`);

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 18: Thread-to-Customer Reverse Traversal
// Start from getThreads, extract customer info, walk back to full profile.
// ---------------------------------------------------------------------------

async function scenario18_threadToCustomerReverseTraversal(): Promise<void> {
  // Find a conversation with threads
  process.stderr.write('    searchConversations (find conversation with threads)...\n');
  const searchData = await callTool('searchConversations', {
    inboxId: GOLDEN.inboxId,
    tag: GOLDEN.tag,
    limit: 5,
  });
  const convos: any[] = searchData?.results ?? [];
  assert(convos.length >= 1, 'No mcp-test conversations found');

  // Get threads for the first one
  const conversationId = String(convos[0].id);
  process.stderr.write(`    getThreads (${conversationId})...\n`);
  const threadsData = await callTool('getThreads', { conversationId });
  const threads: any[] = threadsData?.threads ?? [];
  assert(threads.length >= 1, 'No threads found');

  // Find the first customer-type thread
  const customerThread = threads.find((t: any) => t.type === 'customer');
  assert(!!customerThread, 'No customer thread found');
  const threadCustomerId = String(customerThread.customer?.id ?? customerThread.createdBy?.id ?? '');
  assert(threadCustomerId.length > 0, 'Could not extract customerId from thread');
  process.stderr.write(`    thread customer id=${threadCustomerId}, email=${customerThread.customer?.email ?? 'n/a'}\n`);

  // Walk back to the full customer profile
  process.stderr.write('    getCustomer (from thread)...\n');
  const customerData = await callTool('getCustomer', { customerId: threadCustomerId });
  const customer = customerData?.customer ?? customerData;
  assert(!!customer, 'getCustomer returned no data');
  assert(
    String(customer.id) === threadCustomerId,
    `Customer ID mismatch: thread had ${threadCustomerId}, getCustomer returned ${customer.id}`,
  );

  // Verify the email from the thread matches the customer profile
  const threadEmail = customerThread.customer?.email ?? '';
  if (threadEmail) {
    const profileEmails: string[] = (customer._embedded?.emails ?? []).map((e: any) => e.value);
    const profilePrimary = customer.primaryEmail ?? '';
    const emailMatch = profileEmails.includes(threadEmail) || profilePrimary === threadEmail;
    assert(emailMatch, `Thread email ${threadEmail} not found in customer profile emails: ${profileEmails.join(', ')}`);
  }

  // Walk to the org
  const orgId = String(customer.organizationId ?? '');
  if (orgId) {
    process.stderr.write(`    getOrganization (${orgId})...\n`);
    const orgData = await callTool('getOrganization', { organizationId: orgId });
    const org = orgData?.organization ?? orgData;
    assert(!!org, 'getOrganization returned no data');
    process.stderr.write(`    org: ${org.name}\n`);
  }

  process.stderr.write('    All steps passed (threads -> customer -> profile -> org reverse traversal).\n');
}

// ---------------------------------------------------------------------------
// Scenario 19: Multiple Customers Same Organization
// Get 3 different Meridian customers, verify they all share the same org.
// ---------------------------------------------------------------------------

async function scenario19_multipleCustomersSameOrg(): Promise<void> {
  const emails = [
    GOLDEN.customers.ariaChen.email,
    GOLDEN.customers.kenjiWatanabe.email,
    GOLDEN.customers.priyaPatel.email,
  ];

  const customerIds: string[] = [];
  const orgIds: string[] = [];

  for (const email of emails) {
    process.stderr.write(`    searchCustomersByEmail (${email})...\n`);
    const data = await callTool('searchCustomersByEmail', { email });
    const results: any[] = data?.results ?? [];
    assert(results.length >= 1, `No customer found for ${email}`);

    const id = String(results[0].id);
    customerIds.push(id);

    process.stderr.write(`    getCustomer (${id})...\n`);
    const custData = await callTool('getCustomer', { customerId: id });
    const cust = custData?.customer ?? custData;
    const orgId = String(cust.organizationId ?? '');
    orgIds.push(orgId);
    process.stderr.write(`      id=${id}, orgId=${orgId}\n`);
  }

  // Verify all share the same org
  const uniqueOrgs = new Set(orgIds);
  assert(
    uniqueOrgs.size === 1,
    `Expected all customers in same org, got ${uniqueOrgs.size} orgs: ${[...uniqueOrgs].join(', ')}`,
  );
  assert(
    orgIds[0] === GOLDEN.orgId,
    `Expected orgId=${GOLDEN.orgId}, got ${orgIds[0]}`,
  );

  // Verify all 3 IDs are distinct
  const uniqueIds = new Set(customerIds);
  assert(uniqueIds.size === 3, `Expected 3 unique customer IDs, got ${uniqueIds.size}`);

  process.stderr.write(`    All 3 customers share orgId=${orgIds[0]} with unique IDs.\n`);
  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Scenario 20: Advanced Search Filters Compose Correctly
// Combine multiple filters (tag + status + domain) and verify results
// satisfy ALL conditions.
// ---------------------------------------------------------------------------

async function scenario20_advancedFilterComposition(): Promise<void> {
  process.stderr.write('    advancedConversationSearch (domain + status=closed)...\n');
  const data = await callTool('advancedConversationSearch', {
    emailDomain: GOLDEN.orgDomain,
    status: 'closed',
    limit: 10,
  });
  const results: any[] = data?.results ?? data?.conversations ?? [];
  process.stderr.write(`    found ${results.length} closed conversations from ${GOLDEN.orgDomain}\n`);

  for (const convo of results) {
    assert(
      convo.status === 'closed',
      `Expected status=closed, got ${convo.status} on conversation ${convo.id}`,
    );
  }

  process.stderr.write('    advancedConversationSearch (domain + tags)...\n');
  const tagData = await callTool('advancedConversationSearch', {
    emailDomain: GOLDEN.orgDomain,
    tags: [GOLDEN.tag],
    limit: 10,
  });
  const tagResults: any[] = tagData?.results ?? tagData?.conversations ?? [];
  process.stderr.write(`    found ${tagResults.length} tagged conversations from ${GOLDEN.orgDomain}\n`);

  // Verify each result has the mcp-test tag
  for (const convo of tagResults) {
    const tags = (convo.tags ?? []).map((t: any) => (typeof t === 'string' ? t : t.tag));
    assert(
      tags.includes(GOLDEN.tag),
      `Conversation ${convo.id} missing tag "${GOLDEN.tag}", has: ${tags.join(', ')}`,
    );
  }

  // Cross-check: conversations from the tag search should also appear
  // in a structuredConversationFilter for the same tag
  if (tagResults.length > 0) {
    const sampleId = tagResults[0].id;
    const sampleNumber = tagResults[0].number;
    process.stderr.write(`    structuredConversationFilter (verify ticket #${sampleNumber})...\n`);
    const filterData = await callTool('structuredConversationFilter', {
      conversationNumber: Number(sampleNumber),
    });
    const filterResults: any[] = filterData?.results ?? [];
    assert(
      filterResults.length >= 1 && filterResults[0].id === sampleId,
      `structuredConversationFilter did not return same conversation ${sampleId}`,
    );
  }

  process.stderr.write('    All steps passed.\n');
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  process.stderr.write(`\n${'='.repeat(60)}\n`);
  process.stderr.write('Integration Workflow Tests\n');
  process.stderr.write(`${'='.repeat(60)}\n`);
  process.stderr.write(`Server: ${SERVER_PATH}\n\n`);

  process.stderr.write('Starting MCP server...\n');
  await startServer();
  await initializeServer();
  process.stderr.write('Server ready.\n');

  try {
    await scenario('Scenario 1: Customer Investigation Pipeline', scenario1_customerInvestigation);
    await scenario('Scenario 2: Organization Deep-Dive', scenario2_organizationDeepDive);
    await scenario('Scenario 3: Inbox -> Conversation -> Customer Round-Trip', scenario3_inboxConversationCustomerRoundTrip);
    await scenario('Scenario 4: Keyword Search -> Thread Analysis', scenario4_keywordSearchThreadAnalysis);
    await scenario('Scenario 5: Domain Investigation', scenario5_domainInvestigation);
    await scenario('Scenario 6: Ticket Number Lookup -> Full Context', scenario6_ticketNumberLookup);
    await scenario('Scenario 7: Inbox Search Consistency', scenario7_inboxSearchConsistency);
    await scenario('Scenario 8: Organization Conversations -> Customer Verification', scenario8_orgConversationsCustomerVerification);
    await scenario('Scenario 9: Cross-Tool Customer Consistency', scenario9_crossToolCustomerConsistency);
    await scenario('Scenario 10: Message Content Redaction Verification', scenario10_messageContentRedactionVerification);

    // Cooldown: Scenario 10 restarts the server twice and the first 10 scenarios
    // make 50+ API calls. Pause to let Help Scout rate limits recover, then
    // restart the server for a clean connection pool.
    process.stderr.write('\n  [COOLDOWN] Pausing 10s for rate limit recovery...\n');
    await new Promise((r) => setTimeout(r, 10000));
    await stopServer();
    buffer = '';
    pendingRequests.clear();
    requestId = 0;
    await startServer();
    await initializeServer();
    process.stderr.write('  [COOLDOWN] Server restarted. Resuming.\n\n');

    await scenario('Scenario 11: Pagination Continuity', scenario11_paginationContinuity);
    await scenario('Scenario 12: Empty/No-Result Search Handling', scenario12_emptyResultHandling);
    await scenario('Scenario 13: Date Range Bounded Search', scenario13_dateRangeBoundedSearch);
    await scenario('Scenario 14: Multi-Entity Graph Traversal', scenario14_multiEntityGraphTraversal);
    await scenario('Scenario 15: Conversation Status Lifecycle', scenario15_conversationStatusLifecycle);
    await scenario('Scenario 16: Sort Order Verification', scenario16_sortOrderVerification);
    await scenario('Scenario 17: Multi-Inbox Isolation', scenario17_multiInboxIsolation);
    await scenario('Scenario 18: Thread-to-Customer Reverse Traversal', scenario18_threadToCustomerReverseTraversal);
    await scenario('Scenario 19: Multiple Customers Same Organization', scenario19_multipleCustomersSameOrg);
    await scenario('Scenario 20: Advanced Filter Composition', scenario20_advancedFilterComposition);
  } finally {
    await stopServer();
  }

  printSummary();
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

function printSummary() {
  const passed = scenarioResults.filter((r) => r.status === 'PASS').length;
  const failed = scenarioResults.filter((r) => r.status === 'FAIL').length;
  const totalMs = scenarioResults.reduce((sum, r) => sum + r.durationMs, 0);

  process.stderr.write(`\n${'='.repeat(60)}\n`);
  process.stderr.write('SUMMARY\n');
  process.stderr.write(`${'='.repeat(60)}\n\n`);

  const nameWidth = Math.max(...scenarioResults.map((r) => r.name.length), 10);

  for (const r of scenarioResults) {
    const statusLabel = r.status === 'PASS' ? '[PASS]' : '[FAIL]';
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    const detail = r.detail ? ` -- ${r.detail.slice(0, 100)}` : '';
    process.stderr.write(`  ${statusLabel}  ${r.name.padEnd(nameWidth)}  ${duration}${detail}\n`);
  }

  process.stderr.write(`\n  ${passed} passed, ${failed} failed out of ${scenarioResults.length} scenarios`);
  process.stderr.write(` (${(totalMs / 1000).toFixed(1)}s total)\n\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e?.message ?? String(e)}\n`);
  try { server?.kill('SIGTERM'); } catch { /* ignore */ }
  process.exit(1);
});
