#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Seed integration test conversations for Help Scout MCP workflow testing.
 *
 * Creates 5 realistic support conversations under Meridian Testing Corp
 * (org: 33911683, inbox: 359402) so integration tests have stable data to
 * search, retrieve, and thread-read against.
 *
 * Usage:
 *   node --loader ts-node/esm tests/seed-integration-data.ts           # Create conversations (idempotent)
 *   node --loader ts-node/esm tests/seed-integration-data.ts --cleanup  # Delete seeded conversations
 */

import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';
import {
  ConversationDef,
  INTEGRATION_CONSTANTS,
  INTEGRATION_CONVERSATIONS,
  INTEGRATION_SEED_CONVERSATIONS,
} from './dogfood-fixtures.js';

export { INTEGRATION_CONSTANTS, INTEGRATION_CONVERSATIONS, INTEGRATION_SEED_CONVERSATIONS };

interface ExistingConversation {
  id: number;
  subject: string;
  status?: string;
  assigneeId?: number;
}

// ---------------------------------------------------------------------------
// Config (mirrors src/utils/config.ts without importing the full module tree)
// ---------------------------------------------------------------------------

const CLIENT_ID =
  process.env.HELPSCOUT_APP_ID ||
  process.env.HELPSCOUT_CLIENT_ID ||
  process.env.HELPSCOUT_API_KEY ||
  '';
const CLIENT_SECRET =
  process.env.HELPSCOUT_APP_SECRET ||
  process.env.HELPSCOUT_CLIENT_SECRET ||
  '';
const BASE_URL = process.env.HELPSCOUT_BASE_URL || 'https://api.helpscout.net/v2/';

// ---------------------------------------------------------------------------
// Auth + HTTP client
// ---------------------------------------------------------------------------

let accessToken: string | null = null;

async function authenticate(): Promise<string> {
  if (accessToken) return accessToken;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'Missing HELPSCOUT_APP_ID / HELPSCOUT_APP_SECRET in .env; HELPSCOUT_CLIENT_ID / HELPSCOUT_CLIENT_SECRET are also supported.'
    );
  }

  const res = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  accessToken = res.data.access_token;
  return accessToken!;
}

async function api(): Promise<AxiosInstance> {
  const token = await authenticate();
  return axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true, // We handle status codes ourselves
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stderr.write(`  ${msg}\n`);
}

function heading(msg: string) {
  process.stderr.write(`\n=== ${msg} ===\n\n`);
}

/** Extract resource ID from Help Scout 201 response headers. */
function extractIdFromHeaders(headers: Record<string, string>): number | null {
  // resource-id header is the most reliable
  const resourceId = headers['resource-id'];
  if (resourceId && /^\d+$/.test(resourceId)) return Number(resourceId);

  // Fallback: parse the Location URL (may have query params)
  const location = headers['location'];
  if (location) {
    const match = location.match(/\/(\d+)(?:\?|$)/);
    if (match) return Number(match[1]);
  }

  return null;
}

const CONVERSATIONS = INTEGRATION_SEED_CONVERSATIONS;

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(15, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/** Search for existing MCP-TEST conversations in the target inbox. */
async function findExistingConversations(): Promise<ExistingConversation[]> {
  const client = await api();
  const res = await client.get('/conversations', {
    params: {
      query: '(subject:"MCP-TEST:")',
      mailbox: INTEGRATION_CONSTANTS.inboxId,
      status: 'all',
    },
  });

  if (res.status !== 200) {
    log(`Warning: idempotency search returned ${res.status}, assuming no existing conversations`);
    return [];
  }

  const conversations = res.data?._embedded?.conversations || [];
  return conversations.map((conversation: any) => ({
    id: conversation.id,
    subject: conversation.subject,
    status: conversation.status,
    assigneeId: conversation.assignee?.id,
  }));
}

// ---------------------------------------------------------------------------
// Conversation creation
// ---------------------------------------------------------------------------

async function createConversation(def: ConversationDef): Promise<number> {
  const client = await api();

  // The first thread in our definition is always the opening customer message.
  // Help Scout requires at least one thread in the create payload.
  const openingThread = def.threads[0];

  const body = {
    subject: def.subject,
    type: 'email',
    mailboxId: Number(INTEGRATION_CONSTANTS.inboxId),
    status: def.status,
    ...(def.assigneeId ? { assignTo: def.assigneeId } : {}),
    ...(def.createdAtDaysAgo ? { createdAt: isoDaysAgo(def.createdAtDaysAgo) } : {}),
    ...(def.closedAtDaysAgo ? { closedAt: isoDaysAgo(def.closedAtDaysAgo) } : {}),
    customer: { email: def.customerEmail },
    threads: [
      {
        type: 'customer',
        customer: { email: def.customerEmail },
        text: openingThread.text,
      },
    ],
    tags: def.tags,
    imported: true,
  };

  const res = await client.post('/conversations', body);

  if (res.status === 201) {
    const id = extractIdFromHeaders(res.headers as Record<string, string>);
    if (id) return id;
    throw new Error(`Created conversation but could not extract ID from headers`);
  }

  throw new Error(
    `Failed to create conversation "${def.subject}": ${res.status} ${JSON.stringify(res.data)}`
  );
}

async function addReplyThread(conversationId: number, text: string, finalStatus: string, customerEmail: string): Promise<boolean> {
  const client = await api();
  const res = await client.post(`/conversations/${conversationId}/reply`, {
    text,
    user: INTEGRATION_CONSTANTS.userId,
    customer: { email: customerEmail },
    status: finalStatus,
    imported: true,
  });

  if (res.status !== 201 && res.status !== 200) {
    log(
      `  Warning: reply thread on conversation ${conversationId} returned ${res.status}: ${JSON.stringify(res.data)}`
    );
    return false;
  }
  return true;
}

async function addCustomerThread(
  conversationId: number,
  customerEmail: string,
  text: string
): Promise<boolean> {
  const client = await api();
  const res = await client.post(`/conversations/${conversationId}/customer`, {
    text,
    customer: { email: customerEmail },
    imported: true,
  });

  if (res.status !== 201 && res.status !== 200) {
    log(
      `  Warning: customer-thread on conversation ${conversationId} returned ${res.status}: ${JSON.stringify(res.data)}`
    );
    return false;
  }
  return true;
}

async function seedConversation(def: ConversationDef): Promise<number> {
  log(`Creating "${def.subject}"...`);
  const convId = await createConversation(def);
  log(`  Created conversation ${convId}`);

  // Add subsequent threads (skip index 0 which was included in create payload)
  for (let i = 1; i < def.threads.length; i++) {
    const thread = def.threads[i];

    if (thread.type === 'reply') {
      // Use the conversation's final status for the last reply; keep active for intermediate ones
      const isLast = i === def.threads.length - 1;
      const threadStatus = isLast ? def.status : 'active';
      if (await addReplyThread(convId, thread.text, threadStatus, def.customerEmail)) {
        log(`  Added staff reply (thread ${i + 1})`);
      }
    } else if (thread.type === 'customer-follow-up') {
      if (await addCustomerThread(convId, def.customerEmail, thread.text)) {
        log(`  Added customer follow-up (thread ${i + 1})`);
      }
    }
  }

  return convId;
}

async function getThreadTexts(conversationId: number): Promise<string[]> {
  const client = await api();
  const res = await client.get(`/conversations/${conversationId}/threads`);
  if (res.status !== 200) {
    log(`  Warning: list threads on conversation ${conversationId} returned ${res.status}: ${JSON.stringify(res.data)}`);
    return [];
  }
  const threads = res.data?._embedded?.threads || [];
  return threads.map((thread: any) => String(thread.body ?? thread.text ?? ''));
}

async function patchExistingConversation(existing: ExistingConversation, def: ConversationDef): Promise<void> {
  const client = await api();
  const patches = [];

  if (def.reportFixture && def.assigneeId && existing.assigneeId !== def.assigneeId) {
    patches.push({ op: 'replace', path: '/assignTo', value: def.assigneeId });
  }
  if (def.reportFixture && existing.status !== def.status) {
    patches.push({ op: 'replace', path: '/status', value: def.status });
  }

  for (const patch of patches) {
    const res = await client.patch(`/conversations/${existing.id}`, patch);
    if (res.status !== 204 && res.status !== 200) {
      log(`  Warning: patch ${patch.path} on conversation ${existing.id} returned ${res.status}: ${JSON.stringify(res.data)}`);
    }
  }
}

async function backfillMissingThreads(existing: ExistingConversation, def: ConversationDef): Promise<void> {
  if (!def.reportFixture) return;
  const existingTexts = await getThreadTexts(existing.id);
  for (let i = 1; i < def.threads.length; i++) {
    const thread = def.threads[i];
    if (existingTexts.some((text) => text.includes(thread.text.slice(0, 80)))) continue;

    if (thread.type === 'reply') {
      const isLast = i === def.threads.length - 1;
      const threadStatus = isLast ? def.status : 'active';
      if (await addReplyThread(existing.id, thread.text, threadStatus, def.customerEmail)) {
        log(`  Backfilled staff reply on conversation ${existing.id}`);
      }
    } else if (thread.type === 'customer-follow-up') {
      if (await addCustomerThread(existing.id, def.customerEmail, thread.text)) {
        log(`  Backfilled customer follow-up on conversation ${existing.id}`);
      }
    }
  }
}

async function ensureExistingConversationFixtures(existing: ExistingConversation[]): Promise<void> {
  const bySubject = new Map(existing.map((conversation) => [conversation.subject, conversation]));
  for (const def of CONVERSATIONS) {
    const match = bySubject.get(def.subject);
    if (match) {
      await patchExistingConversation(match, def);
      await backfillMissingThreads(match, def);
      continue;
    }

    log(`  Missing "${def.subject}", creating...`);
    await seedConversation(def);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function deleteConversation(id: number): Promise<void> {
  const client = await api();
  const res = await client.delete(`/conversations/${id}`);
  if (res.status === 204 || res.status === 200) {
    log(`Deleted conversation ${id}`);
  } else {
    log(`Warning: delete conversation ${id} returned ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

async function cleanup(): Promise<void> {
  heading('Cleanup: Removing MCP-TEST Conversations');

  const ids = await findExistingConversations();
  if (ids.length === 0) {
    log('No MCP-TEST conversations found.');
    return;
  }

  log(`Found ${ids.length} conversation(s) to delete...`);
  for (const conversation of ids) {
    await deleteConversation(conversation.id);
  }

  log('\nCleanup complete.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const isCleanup = process.argv.includes('--cleanup');

  if (isCleanup) {
    await cleanup();
    return;
  }

  heading('Seeding Integration Test Conversations');

  // Idempotency: check if conversations already exist
  log('Checking for existing MCP-TEST conversations...');
  const existing = await findExistingConversations();
  if (existing.length > 0) {
    log(`Found ${existing.length} existing conversation(s): ${existing.map((conversation) => conversation.id).join(', ')}`);
    log('Backfilling assignment, status, and missing report-fixture threads where needed...');
    await ensureExistingConversationFixtures(existing);

    heading('Seed Already Complete');
    log(`Org:   ${INTEGRATION_CONSTANTS.orgName} (ID: ${INTEGRATION_CONSTANTS.orgId})`);
    log(`Inbox: Client Support (ID: ${INTEGRATION_CONSTANTS.inboxId})`);
    log(`Existing conversation IDs: ${existing.map((conversation) => conversation.id).join(', ')}`);
    return;
  }

  log('No existing conversations found. Creating...\n');

  const createdIds: { subject: string; id: number }[] = [];

  for (const def of CONVERSATIONS) {
    try {
      const id = await seedConversation(def);
      createdIds.push({ subject: def.subject, id });
    } catch (err: any) {
      log(`  ERROR: ${err.message}`);
      if (err.response?.data) {
        log(`  Response: ${JSON.stringify(err.response.data)}`);
      }
    }
  }

  // Summary
  heading('Seed Complete');
  log(`Org:   ${INTEGRATION_CONSTANTS.orgName} (ID: ${INTEGRATION_CONSTANTS.orgId})`);
  log(`Inbox: Client Support (ID: ${INTEGRATION_CONSTANTS.inboxId})`);
  log('');
  log(`Created ${createdIds.length} of ${CONVERSATIONS.length} conversation(s):`);
  for (const { subject, id } of createdIds) {
    log(`  [${id}] ${subject}`);
  }
  log('');
  log('Clean up with:');
  log('  node --loader ts-node/esm tests/seed-integration-data.ts --cleanup');
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  if (e.response?.data) {
    console.error('Response:', JSON.stringify(e.response.data, null, 2));
  }
  process.exit(1);
});
