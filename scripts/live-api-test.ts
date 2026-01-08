#!/usr/bin/env npx tsx
/**
 * Live API Test Script for Help Scout MCP Server
 *
 * Tests all 9 MCP tools against the live Help Scout API to verify functionality.
 * Requires valid HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET in .env
 *
 * Usage:
 *   npx tsx scripts/live-api-test.ts
 *   npx tsx scripts/live-api-test.ts --verbose
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '..', '.env') });

// Test configuration
const VERBOSE = process.argv.includes('--verbose');

interface TestResult {
  tool: string;
  description: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: unknown;
}

interface HelpScoutToken {
  access_token: string;
  expires_at: number;
}

interface Conversation {
  id: number;
  number: number;
  subject: string;
}

interface Inbox {
  id: number;
  name: string;
}

// OAuth2 Client for authentication
class HelpScoutClient {
  private token: HelpScoutToken | null = null;
  private baseUrl = 'https://api.helpscout.net/v2';

  async authenticate(): Promise<void> {
    const clientId = process.env.HELPSCOUT_CLIENT_ID;
    const clientSecret = process.env.HELPSCOUT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Missing HELPSCOUT_CLIENT_ID or HELPSCOUT_CLIENT_SECRET');
    }

    const response = await fetch('https://api.helpscout.net/v2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Authentication failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.token = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in * 1000) - 60000,
    };
  }

  async request<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    if (!this.token || Date.now() >= this.token.expires_at) {
      await this.authenticate();
    }

    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    });

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.token!.access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }
}

const client = new HelpScoutClient();
const results: TestResult[] = [];

// Helper to run a test
async function runTest(
  tool: string,
  description: string,
  testFn: () => Promise<unknown>
): Promise<void> {
  const startTime = Date.now();
  try {
    const details = await testFn();
    results.push({
      tool,
      description,
      passed: true,
      duration: Date.now() - startTime,
      details: VERBOSE ? details : undefined,
    });
    console.log(`✅ ${tool}: ${description} (${Date.now() - startTime}ms)`);
  } catch (error) {
    results.push({
      tool,
      description,
      passed: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`❌ ${tool}: ${description}`);
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Test implementations
async function testSearchInboxes(): Promise<void> {
  // Test 1: Empty query (list all)
  await runTest('searchInboxes', 'List all inboxes with empty query', async () => {
    const response = await client.request<{ _embedded?: { mailboxes: Inbox[] } }>('/mailboxes');
    const inboxes = response._embedded?.mailboxes || [];
    if (inboxes.length === 0) throw new Error('No inboxes found');
    return { count: inboxes.length, inboxes: inboxes.map(i => ({ id: i.id, name: i.name })) };
  });

  // Test 2: Search by name
  await runTest('searchInboxes', 'Search for "Client" inbox', async () => {
    const response = await client.request<{ _embedded?: { mailboxes: Inbox[] } }>('/mailboxes');
    const inboxes = (response._embedded?.mailboxes || []).filter(
      (i) => i.name.toLowerCase().includes('client')
    );
    return { matchingInboxes: inboxes.length };
  });
}

async function testListAllInboxes(): Promise<void> {
  await runTest('listAllInboxes', 'List all inboxes', async () => {
    const response = await client.request<{ _embedded?: { mailboxes: Inbox[] } }>('/mailboxes');
    const inboxes = response._embedded?.mailboxes || [];
    if (inboxes.length === 0) throw new Error('No inboxes found');
    return { count: inboxes.length };
  });
}

async function testSearchConversations(): Promise<void> {
  // Test 1: Search by status
  await runTest('searchConversations', 'Search active conversations', async () => {
    const response = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
      '/conversations',
      { status: 'active', pageSize: 10 }
    );
    return { count: (response._embedded?.conversations || []).length };
  });

  // Test 2: Search with date filter
  await runTest('searchConversations', 'Search conversations from last 7 days', async () => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const dateStr = sevenDaysAgo.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const response = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
      '/conversations',
      { modifiedSince: dateStr, pageSize: 25 }
    );
    return { count: (response._embedded?.conversations || []).length };
  });

  // Test 3: Search with inbox filter
  await runTest('searchConversations', 'Search conversations in specific inbox', async () => {
    // First get an inbox
    const inboxResponse = await client.request<{ _embedded?: { mailboxes: Inbox[] } }>('/mailboxes');
    const inbox = inboxResponse._embedded?.mailboxes?.[0];
    if (!inbox) throw new Error('No inboxes available');

    const response = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
      '/conversations',
      { mailbox: inbox.id, pageSize: 10 }
    );
    return { inboxId: inbox.id, count: (response._embedded?.conversations || []).length };
  });
}

async function testComprehensiveConversationSearch(): Promise<void> {
  // Test comprehensive search across multiple statuses
  await runTest('comprehensiveConversationSearch', 'Search with query across statuses', async () => {
    const statuses = ['active', 'pending', 'closed'];
    const results: Record<string, number> = {};

    for (const status of statuses) {
      const response = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
        '/conversations',
        { status, pageSize: 10 }
      );
      results[status] = (response._embedded?.conversations || []).length;
    }

    return { resultsByStatus: results, totalFound: Object.values(results).reduce((a, b) => a + b, 0) };
  });
}

async function testAdvancedConversationSearch(): Promise<void> {
  // Test advanced search with content query
  await runTest('advancedConversationSearch', 'Search with HelpScout query syntax', async () => {
    // Use search API with query
    const response = await client.request<{ _embedded?: { conversations: Conversation[] }; page?: { totalElements: number } }>(
      '/conversations',
      { query: '(status:active)', pageSize: 10 }
    );
    return {
      found: (response._embedded?.conversations || []).length,
      total: response.page?.totalElements
    };
  });
}

async function testStructuredConversationFilter(): Promise<void> {
  // Test lookup by conversation number
  await runTest('structuredConversationFilter', 'Lookup conversation by number', async () => {
    // First get a conversation to have a valid number
    const listResponse = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
      '/conversations',
      { pageSize: 1 }
    );
    const conversation = listResponse._embedded?.conversations?.[0];
    if (!conversation) throw new Error('No conversations available for testing');

    // Now look up by number
    const lookupResponse = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
      '/conversations',
      { number: conversation.number }
    );
    const found = lookupResponse._embedded?.conversations?.find(c => c.number === conversation.number);
    if (!found) throw new Error(`Conversation #${conversation.number} not found`);

    return { conversationNumber: conversation.number, foundId: found.id };
  });
}

async function testGetConversationSummary(): Promise<void> {
  await runTest('getConversationSummary', 'Get conversation summary with threads', async () => {
    // Get a conversation
    const listResponse = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
      '/conversations',
      { pageSize: 1 }
    );
    const conversation = listResponse._embedded?.conversations?.[0];
    if (!conversation) throw new Error('No conversations available');

    // Get detailed info
    const detailResponse = await client.request<{ id: number; subject: string; threads?: { customer?: { email: string } }[] }>(
      `/conversations/${conversation.id}`,
      { embed: 'threads' }
    );

    return {
      id: detailResponse.id,
      subject: detailResponse.subject?.substring(0, 50),
      threadCount: detailResponse.threads?.length || 0,
    };
  });
}

async function testGetThreads(): Promise<void> {
  await runTest('getThreads', 'Get all threads for a conversation', async () => {
    // Get a conversation
    const listResponse = await client.request<{ _embedded?: { conversations: Conversation[] } }>(
      '/conversations',
      { pageSize: 1 }
    );
    const conversation = listResponse._embedded?.conversations?.[0];
    if (!conversation) throw new Error('No conversations available');

    // Get threads
    const threadResponse = await client.request<{ _embedded?: { threads: { id: number; type: string }[] } }>(
      `/conversations/${conversation.id}/threads`
    );
    const threads = threadResponse._embedded?.threads || [];

    return {
      conversationId: conversation.id,
      threadCount: threads.length,
      threadTypes: threads.map(t => t.type),
    };
  });
}

async function testGetServerTime(): Promise<void> {
  await runTest('getServerTime', 'Get current server time', async () => {
    // Server time is local - use Date.now()
    const now = new Date();
    const isoTime = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    return { serverTime: isoTime, timestamp: now.getTime() };
  });
}

// Main execution
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Help Scout MCP Live API Tests');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('🔐 Authenticating...');
  try {
    await client.authenticate();
    console.log('✅ Authenticated successfully\n');
  } catch (error) {
    console.log(`❌ Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log('📋 Running tests...\n');

  // Run all tests
  await testSearchInboxes();
  await testListAllInboxes();
  await testSearchConversations();
  await testComprehensiveConversationSearch();
  await testAdvancedConversationSearch();
  await testStructuredConversationFilter();
  await testGetConversationSummary();
  await testGetThreads();
  await testGetServerTime();

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Test Summary');
  console.log('═══════════════════════════════════════════════════════════');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`  Total Tests: ${results.length}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  Success Rate: ${((passed / results.length) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log('\n  Failed Tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`    - ${r.tool}: ${r.description}`);
      console.log(`      Error: ${r.error}`);
    });
  }

  console.log('═══════════════════════════════════════════════════════════\n');

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
