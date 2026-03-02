#!/usr/bin/env npx tsx
/**
 * Live integration test for Customer & Organization tools
 * Run: npx tsx tests/test-customer-org-live.ts
 */

import 'dotenv/config';
import { ToolHandler } from '../src/tools/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const toolHandler = new ToolHandler();
const results: Array<{ name: string; status: 'PASS' | 'FAIL'; detail?: string }> = [];

function makeRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } } as CallToolRequest;
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text as string);
}

async function runTest(label: string, toolName: string, args: Record<string, unknown>) {
  process.stderr.write(`  Testing: ${label}...`);
  try {
    const result = await toolHandler.callTool(makeRequest(toolName, args));
    const data = parseResult(result);

    // Check for error responses
    if (data.error) {
      process.stderr.write(` FAIL\n`);
      console.error(`    Error: ${JSON.stringify(data.error).slice(0, 200)}`);
      results.push({ name: label, status: 'FAIL', detail: data.error });
      return null;
    }

    process.stderr.write(` PASS\n`);
    results.push({ name: label, status: 'PASS' });
    return data;
  } catch (e: any) {
    process.stderr.write(` FAIL\n`);
    console.error(`    Error: ${e.message?.slice(0, 200)}`);
    results.push({ name: label, status: 'FAIL', detail: e.message });
    return null;
  }
}

async function main() {
  console.error('\n=== Customer & Organization Tools - Live Integration Test ===\n');

  // 1. listCustomers
  const customerList = await runTest('listCustomers (first 5)', 'listCustomers', { limit: 5 });
  if (customerList?.results?.length) {
    console.error(`    -> Found ${customerList.results.length} customers`);
    console.error(`    -> First: ${customerList.results[0].firstName} ${customerList.results[0].lastName} (ID: ${customerList.results[0].id})`);
    console.error(`    -> Pagination: ${JSON.stringify(customerList.pagination)}`);
  }

  // 2. getCustomer with first customer ID
  let customerId: string | null = null;
  let orgId: string | null = null;

  if (customerList?.results?.[0]?.id) {
    customerId = String(customerList.results[0].id);
    const customer = await runTest(`getCustomer (ID: ${customerId})`, 'getCustomer', { customerId });
    if (customer?.customer) {
      const c = customer.customer;
      console.error(`    -> Name: ${c.firstName} ${c.lastName}`);
      console.error(`    -> Org ID: ${c.organizationId || 'none'}`);
      console.error(`    -> Emails: ${c._embedded?.emails?.length || 0}`);
      console.error(`    -> Phones: ${c._embedded?.phones?.length || 0}`);
      console.error(`    -> Websites: ${c._embedded?.websites?.length || 0}`);
      console.error(`    -> Social profiles: ${c._embedded?.social_profiles?.length || 0}`);
      console.error(`    -> Has address: ${!!c.address}`);
      if (c.address) console.error(`    -> Address: ${JSON.stringify(c.address)}`);
      if (c.organizationId) orgId = String(c.organizationId);
    }
  } else {
    console.error('    -> Skipping getCustomer (no customer IDs found)');
  }

  // 3. searchCustomersByEmail
  // Try to find an email from the customer list
  let testEmail = 'test@example.com';
  if (customerList?.results) {
    for (const c of customerList.results) {
      if (c._embedded?.emails?.[0]?.value) {
        testEmail = c._embedded.emails[0].value;
        break;
      }
    }
  }
  const emailSearch = await runTest(`searchCustomersByEmail (${testEmail})`, 'searchCustomersByEmail', { email: testEmail });
  if (emailSearch) {
    console.error(`    -> Found ${emailSearch.results?.length || 0} customers`);
    console.error(`    -> Has nextCursor: ${!!emailSearch.nextCursor}`);
  }

  // 4. listOrganizations
  const orgList = await runTest('listOrganizations (first 5)', 'listOrganizations', { limit: 5 });
  if (orgList?.results?.length) {
    console.error(`    -> Found ${orgList.results.length} organizations`);
    for (const org of orgList.results.slice(0, 3)) {
      console.error(`    -> ${org.name} (ID: ${org.id})`);
    }
    if (!orgId && orgList.results[0]?.id) {
      orgId = String(orgList.results[0].id);
    }
  }

  // 5. getOrganization
  if (orgId) {
    const org = await runTest(`getOrganization (ID: ${orgId})`, 'getOrganization', { organizationId: orgId });
    if (org?.organization) {
      console.error(`    -> Name: ${org.organization.name}`);
      console.error(`    -> Website: ${org.organization.website || 'none'}`);
      console.error(`    -> Domains: ${org.organization.domains?.join(', ') || 'none'}`);
      console.error(`    -> Customer count: ${org.organization.customerCount ?? 'N/A'}`);
      console.error(`    -> Conversation count: ${org.organization.conversationCount ?? 'N/A'}`);
    }
  } else {
    console.error('    -> Skipping getOrganization (no org IDs found)');
  }

  // 6. getOrganizationMembers
  if (orgId) {
    const members = await runTest(`getOrganizationMembers (org: ${orgId})`, 'getOrganizationMembers', { organizationId: orgId });
    if (members) {
      console.error(`    -> Found ${members.members?.length || 0} members`);
      for (const m of (members.members || []).slice(0, 3)) {
        console.error(`    -> ${m.firstName} ${m.lastName} (ID: ${m.id})`);
      }
    }
  } else {
    console.error('    -> Skipping getOrganizationMembers (no org IDs)');
  }

  // 7. getOrganizationConversations
  if (orgId) {
    const convos = await runTest(`getOrganizationConversations (org: ${orgId})`, 'getOrganizationConversations', { organizationId: orgId });
    if (convos) {
      console.error(`    -> Found ${convos.conversations?.length || 0} conversations`);
      for (const c of (convos.conversations || []).slice(0, 3)) {
        console.error(`    -> #${c.number}: ${c.subject} (${c.status})`);
      }
    }
  } else {
    console.error('    -> Skipping getOrganizationConversations (no org IDs)');
  }

  // Summary
  console.error('\n=== Results ===\n');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  for (const r of results) {
    console.error(`  [${r.status}] ${r.name}${r.detail ? ` - ${r.detail.slice(0, 100)}` : ''}`);
  }
  console.error(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
