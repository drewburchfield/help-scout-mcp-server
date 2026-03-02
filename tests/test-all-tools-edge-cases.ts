#!/usr/bin/env npx tsx
/**
 * Comprehensive authenticated edge-case test for all 16 MCP tools.
 * Designed by Claude + Gemini + Codex braintrust.
 *
 * Run: npx tsx tests/test-all-tools-edge-cases.ts
 *
 * Golden data required: run `npx tsx tests/seed-test-data.ts` first.
 */

import 'dotenv/config';
import { ToolHandler } from '../src/tools/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const toolHandler = new ToolHandler();

// Golden test data IDs
const GOLDEN = {
  customerId: '860587086',
  orgId: '33911683',
  email: 'testuser@meridian-testing.com',
  inboxId: '359402',
  inboxId2: '359403',
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail?: string;
}

const results: TestResult[] = [];

function makeRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } } as CallToolRequest;
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text as string);
}

async function test(
  category: string,
  label: string,
  toolName: string,
  args: Record<string, unknown>,
  check: (data: any) => { ok: boolean; detail?: string },
): Promise<any> {
  process.stderr.write(`  [${category}] ${label}...`);
  try {
    const result = await toolHandler.callTool(makeRequest(toolName, args));
    const data = parseResult(result);
    const { ok, detail } = check(data);
    if (ok) {
      process.stderr.write(` PASS\n`);
      results.push({ name: label, category, status: 'PASS', detail });
    } else {
      process.stderr.write(` FAIL\n`);
      results.push({ name: label, category, status: 'FAIL', detail });
    }
    return data;
  } catch (e: any) {
    // Some tests expect schema validation errors thrown before tool execution
    const msg = e.message?.slice(0, 200) || String(e);
    const { ok, detail } = check({ _thrown: true, message: msg });
    if (ok) {
      process.stderr.write(` PASS (thrown)\n`);
      results.push({ name: label, category, status: 'PASS', detail: detail || msg });
    } else {
      process.stderr.write(` FAIL (thrown)\n`);
      results.push({ name: label, category, status: 'FAIL', detail: msg });
    }
    return null;
  }
}

// Check helpers
const expectSuccess = (data: any) => ({ ok: !data?.error && !data?._thrown, detail: data?.error?.message });
const expectError = (data: any) => ({ ok: !!data?.error || !!data?._thrown, detail: data?.error?.code || 'thrown' });
const expectGraceful = (data: any) => ({
  ok: !data?._thrown, // Must not throw; errors in response body are fine
  detail: data?.error ? `error: ${data.error.code}` : 'ok',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.error('\n=== Comprehensive Edge-Case Test Suite (16 Tools) ===\n');
  console.error('  Golden data: Customer ' + GOLDEN.customerId + ', Org ' + GOLDEN.orgId + '\n');

  // =========================================================================
  // CATEGORY 1: Happy Path (all 16 tools with golden data)
  // =========================================================================

  await test('happy', 'getServerTime', 'getServerTime', {}, (d) => ({
    ok: !!d?.isoTime && !d?.error,
    detail: d?.isoTime,
  }));

  await test('happy', 'listAllInboxes', 'listAllInboxes', {}, (d) => ({
    ok: Array.isArray(d?.inboxes) && d.inboxes.length > 0,
    detail: `${d?.inboxes?.length} inboxes`,
  }));

  await test('happy', 'searchInboxes (empty query)', 'searchInboxes', { query: '' }, (d) => ({
    ok: Array.isArray(d?.results),
    detail: `${d?.results?.length} results`,
  }));

  await test('happy', 'searchInboxes (name match)', 'searchInboxes', { query: 'Client' }, (d) => ({
    ok: d?.results?.some((r: any) => r.name?.includes('Client')),
    detail: d?.results?.[0]?.name,
  }));

  let conversationId: string | null = null;
  const convResult = await test('happy', 'searchConversations (default)', 'searchConversations', {}, (d) => ({
    ok: Array.isArray(d?.results) && d.results.length > 0,
    detail: `${d?.results?.length} conversations`,
  }));
  if (convResult?.results?.[0]) {
    conversationId = String(convResult.results[0].id);
  }

  await test('happy', 'searchConversations (inbox filter)', 'searchConversations',
    { inboxId: GOLDEN.inboxId, limit: 5 }, (d) => ({
      ok: Array.isArray(d?.results),
      detail: `${d?.results?.length} results`,
    }));

  await test('happy', 'advancedConversationSearch', 'advancedConversationSearch',
    { contentTerms: ['test'], inboxId: GOLDEN.inboxId }, (d) => ({
      ok: !d?.error,
      detail: `${d?.conversations?.length || 0} conversations`,
    }));

  await test('happy', 'comprehensiveConversationSearch', 'comprehensiveConversationSearch',
    { searchTerms: ['support'] }, (d) => ({
      ok: !d?.error,
      detail: `results returned`,
    }));

  await test('happy', 'structuredConversationFilter (by customerIds)', 'structuredConversationFilter',
    { customerIds: [Number(GOLDEN.customerId)], inboxId: GOLDEN.inboxId }, (d) => ({
      ok: !d?.error, // Golden customer may have 0 conversations; success = no error
      detail: `${d?.conversations?.length || 0} conversations`,
    }));

  if (conversationId) {
    await test('happy', `getConversationSummary (ID: ${conversationId})`, 'getConversationSummary',
      { conversationId }, (d) => ({
        ok: !!d?.conversation?.subject,
        detail: d?.conversation?.subject,
      }));

    await test('happy', `getThreads (ID: ${conversationId})`, 'getThreads',
      { conversationId }, (d) => ({
        ok: Array.isArray(d?.threads),
        detail: `${d?.threads?.length} threads`,
      }));
  }

  await test('happy', 'getCustomer (golden)', 'getCustomer',
    { customerId: GOLDEN.customerId }, (d) => ({
      ok: d?.customer?.firstName === 'Meridian' && d?.customer?.lastName === 'TestUser',
      detail: `${d?.customer?.firstName} ${d?.customer?.lastName}`,
    }));

  await test('happy', 'listCustomers (page 1)', 'listCustomers', { page: 1 }, (d) => ({
    ok: Array.isArray(d?.results) && d.results.length > 0,
    detail: `${d?.results?.length} customers`,
  }));

  await test('happy', 'searchCustomersByEmail (golden)', 'searchCustomersByEmail',
    { email: GOLDEN.email }, (d) => ({
      ok: d?.results?.some((r: any) => String(r.id) === GOLDEN.customerId),
      detail: `found ${d?.results?.length} match(es)`,
    }));

  await test('happy', 'getOrganization (golden)', 'getOrganization',
    { organizationId: GOLDEN.orgId }, (d) => ({
      ok: d?.organization?.name === 'Meridian Testing Corp',
      detail: d?.organization?.name,
    }));

  await test('happy', 'listOrganizations (page 1)', 'listOrganizations', { page: 1 }, (d) => ({
    ok: Array.isArray(d?.results) && d.results.length > 0,
    detail: `${d?.results?.length} orgs`,
  }));

  await test('happy', 'getOrganizationMembers (golden)', 'getOrganizationMembers',
    { organizationId: GOLDEN.orgId }, (d) => ({
      ok: !d?.error,
      detail: `${d?.members?.length || 0} members`,
    }));

  await test('happy', 'getOrganizationConversations (golden)', 'getOrganizationConversations',
    { organizationId: GOLDEN.orgId }, (d) => ({
      ok: !d?.error,
      detail: `${d?.conversations?.length || 0} conversations`,
    }));

  // =========================================================================
  // CATEGORY 2: Boundary Values
  // =========================================================================

  await test('boundary', 'listCustomers page=0 (below min)', 'listCustomers',
    { page: 0 }, expectError);

  await test('boundary', 'listCustomers page=-5 (negative)', 'listCustomers',
    { page: -5 }, expectError);

  await test('boundary', 'listCustomers page=999999 (beyond last)', 'listCustomers',
    { page: 999999 }, expectGraceful);

  await test('boundary', 'searchConversations limit=-1', 'searchConversations',
    { limit: -1 }, expectError);

  await test('boundary', 'searchConversations limit=0', 'searchConversations',
    { limit: 0 }, expectError);

  await test('boundary', 'searchConversations limit=25.7 (float)', 'searchConversations',
    { limit: 25.7 }, expectGraceful);

  await test('boundary', 'getThreads limit=201 (above max 200)', 'getThreads',
    { conversationId: conversationId || '1', limit: 201 }, expectError);

  await test('boundary', 'listOrganizations page=999999', 'listOrganizations',
    { page: 999999 }, expectGraceful);

  // =========================================================================
  // CATEGORY 3: Invalid / Malformed IDs
  // =========================================================================

  await test('invalid-id', 'getCustomer id="abc" (non-numeric)', 'getCustomer',
    { customerId: 'abc' }, expectError);

  await test('invalid-id', 'getCustomer id="860587086.5" (float)', 'getCustomer',
    { customerId: '860587086.5' }, expectError);

  await test('invalid-id', 'getCustomer id="-1" (negative)', 'getCustomer',
    { customerId: '-1' }, expectError);

  await test('invalid-id', 'getCustomer id="0" (zero)', 'getCustomer',
    { customerId: '0' }, expectError);

  await test('invalid-id', 'getCustomer id="99999999999999999999" (huge)', 'getCustomer',
    { customerId: '99999999999999999999' }, expectError);

  await test('invalid-id', 'getConversationSummary id="abc"', 'getConversationSummary',
    { conversationId: 'abc' }, expectError);

  await test('invalid-id', 'getOrganization id="-1"', 'getOrganization',
    { organizationId: '-1' }, expectError);

  await test('invalid-id', 'getOrganization id="0"', 'getOrganization',
    { organizationId: '0' }, expectError);

  await test('invalid-id', 'getOrganizationMembers id="0"', 'getOrganizationMembers',
    { organizationId: '0' }, expectGraceful);

  // SQL/path injection attempts
  await test('invalid-id', 'getCustomer SQL injection', 'getCustomer',
    { customerId: '1; DROP TABLE customers;--' }, expectError);

  await test('invalid-id', 'getThreads inbox ID as conversation ID', 'getThreads',
    { conversationId: GOLDEN.inboxId }, expectGraceful);

  // =========================================================================
  // CATEGORY 4: Special Characters in Search
  // =========================================================================

  await test('special-chars', 'searchInboxes single backslash', 'searchInboxes',
    { query: '\\' }, expectGraceful);

  await test('special-chars', 'searchConversations HTML tags', 'searchConversations',
    { query: '<script>alert("xss")</script>' }, expectGraceful);

  await test('special-chars', 'advancedConversationSearch emoji', 'advancedConversationSearch',
    { contentTerms: ['🔥 urgent'] }, expectGraceful);

  await test('special-chars', 'advancedConversationSearch Lucene operators', 'advancedConversationSearch',
    { contentTerms: ['+ - && || ! ( ) { } [ ] ^ ~ * ? :'] }, expectGraceful);

  await test('special-chars', 'comprehensiveConversationSearch unicode', 'comprehensiveConversationSearch',
    { searchTerms: ['tëštüšér'] }, expectGraceful);

  await test('special-chars', 'searchInboxes quote injection', 'searchInboxes',
    { query: '" OR name:* OR "' }, expectGraceful);

  await test('special-chars', 'comprehensiveConversationSearch very long term', 'comprehensiveConversationSearch',
    { searchTerms: ['a'.repeat(500)] }, expectGraceful);

  // =========================================================================
  // CATEGORY 5: Email Format Edge Cases
  // =========================================================================

  await test('email', 'searchCustomersByEmail UPPERCASE', 'searchCustomersByEmail',
    { email: 'TESTUSER@MERIDIAN-TESTING.COM' }, (d) => ({
      ok: !d?._thrown,
      detail: `${d?.results?.length || 0} results (case sensitivity test)`,
    }));

  await test('email', 'searchCustomersByEmail whitespace padded', 'searchCustomersByEmail',
    { email: ' testuser@meridian-testing.com ' }, expectGraceful);

  await test('email', 'searchCustomersByEmail plus addressing', 'searchCustomersByEmail',
    { email: 'testuser+qa@meridian-testing.com' }, expectGraceful);

  await test('email', 'searchCustomersByEmail no TLD', 'searchCustomersByEmail',
    { email: 'user@localhost' }, expectGraceful);

  await test('email', 'searchCustomersByEmail double @', 'searchCustomersByEmail',
    { email: 'testuser@@meridian-testing.com' }, expectGraceful);

  await test('email', 'searchCustomersByEmail space in local', 'searchCustomersByEmail',
    { email: 'test user@meridian-testing.com' }, expectGraceful);

  await test('email', 'searchCustomersByEmail empty string', 'searchCustomersByEmail',
    { email: '' }, (d) => {
      // Empty email should be rejected somehow: error in body, thrown exception, or empty results
      const rejected = !!d?.error || !!d?._thrown || (d?.results?.length === 0);
      return { ok: rejected, detail: d?.error?.code || d?.message || 'rejected' };
    });

  // =========================================================================
  // CATEGORY 6: Type Coercion
  // =========================================================================

  await test('coercion', 'searchConversations status=true (boolean)', 'searchConversations',
    { status: true as any }, expectError);

  await test('coercion', 'searchConversations inboxId=359402 (number)', 'searchConversations',
    { inboxId: 359402 as any }, expectGraceful);

  await test('coercion', 'listAllInboxes extra param (ignored?)', 'listAllInboxes',
    { fake_parameter: 'should_be_ignored' } as any, expectGraceful);

  // =========================================================================
  // CATEGORY 7: Cross-Tool Consistency
  // =========================================================================

  // getCustomer vs searchCustomersByEmail: same customer data?
  const custDirect = await test('consistency', 'getCustomer golden (for comparison)', 'getCustomer',
    { customerId: GOLDEN.customerId }, expectSuccess);
  const custSearch = await test('consistency', 'searchCustomersByEmail golden (for comparison)', 'searchCustomersByEmail',
    { email: GOLDEN.email }, expectSuccess);

  if (custDirect?.customer && custSearch?.results?.[0]) {
    const directId = String(custDirect.customer.id);
    const searchId = String(custSearch.results[0].id);
    const match = directId === searchId;
    process.stderr.write(`  [consistency] ID match: ${match ? 'PASS' : 'FAIL'} (${directId} vs ${searchId})\n`);
    results.push({
      name: 'Customer ID consistent across getCustomer/searchCustomersByEmail',
      category: 'consistency',
      status: match ? 'PASS' : 'FAIL',
      detail: `${directId} vs ${searchId}`,
    });
  }

  // getCustomer.organizationId matches golden org?
  if (custDirect?.customer?.organizationId) {
    const orgMatch = String(custDirect.customer.organizationId) === GOLDEN.orgId;
    process.stderr.write(`  [consistency] Org link: ${orgMatch ? 'PASS' : 'FAIL'}\n`);
    results.push({
      name: 'Customer organizationId matches golden org',
      category: 'consistency',
      status: orgMatch ? 'PASS' : 'FAIL',
      detail: `${custDirect.customer.organizationId} vs ${GOLDEN.orgId}`,
    });
  }

  // =========================================================================
  // CATEGORY 8: Concurrency
  // =========================================================================

  process.stderr.write('  [concurrency] 5x parallel getServerTime...');
  const times = await Promise.all(
    Array.from({ length: 5 }, () =>
      toolHandler.callTool(makeRequest('getServerTime', {})).then(parseResult)
    ),
  );
  const allOk = times.every((t) => t?.isoTime && !t?.error);
  process.stderr.write(` ${allOk ? 'PASS' : 'FAIL'}\n`);
  results.push({
    name: '5x concurrent getServerTime',
    category: 'concurrency',
    status: allOk ? 'PASS' : 'FAIL',
    detail: `${times.filter((t) => t?.isoTime).length}/5 succeeded`,
  });

  // =========================================================================
  // CATEGORY 9: structuredConversationFilter edge cases
  // =========================================================================

  await test('structured', 'no unique fields (should reject)', 'structuredConversationFilter',
    { status: 'active', inboxId: GOLDEN.inboxId }, expectError);

  await test('structured', 'customerIds array with 1 element', 'structuredConversationFilter',
    { customerIds: [GOLDEN.customerId] }, expectGraceful);

  // =========================================================================
  // CATEGORY 10: Missing required params
  // =========================================================================

  await test('missing-params', 'getConversationSummary no args', 'getConversationSummary',
    {}, expectError);

  await test('missing-params', 'getThreads no args', 'getThreads',
    {}, expectError);

  await test('missing-params', 'getCustomer no args', 'getCustomer',
    {}, expectError);

  await test('missing-params', 'getOrganization no args', 'getOrganization',
    {}, expectError);

  await test('missing-params', 'searchCustomersByEmail no args', 'searchCustomersByEmail',
    {}, expectError);

  await test('missing-params', 'searchInboxes no args (query required)', 'searchInboxes',
    {}, expectError);

  // =========================================================================
  // Summary
  // =========================================================================

  console.error('\n=== Results ===\n');

  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const passed = catResults.filter((r) => r.status === 'PASS').length;
    const failed = catResults.filter((r) => r.status === 'FAIL').length;
    console.error(`\n  --- ${cat} (${passed}/${catResults.length}) ---`);
    for (const r of catResults) {
      const icon = r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'WARN';
      console.error(`    [${icon}] ${r.name}${r.detail ? ` -- ${r.detail.slice(0, 120)}` : ''}`);
    }
  }

  const totalPassed = results.filter((r) => r.status === 'PASS').length;
  const totalFailed = results.filter((r) => r.status === 'FAIL').length;
  const totalWarn = results.filter((r) => r.status === 'WARN').length;
  console.error(`\n  TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalWarn} warnings out of ${results.length} tests\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
