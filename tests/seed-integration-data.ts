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

// ---------------------------------------------------------------------------
// Exports (importable by integration tests)
// ---------------------------------------------------------------------------

export const INTEGRATION_CONVERSATIONS = [
  {
    customerEmail: 'aria.chen@meridian-testing.com',
    subject: 'MCP-TEST: Login credentials not working',
    tags: ['mcp-test'],
    status: 'closed',
    hasStaffReply: true,
  },
  {
    customerEmail: 'marcus.j@meridian-testing.com',
    subject: 'MCP-TEST: Billing question about annual plan',
    tags: ['mcp-test', 'billing'],
    status: 'active',
    hasStaffReply: false,
  },
  {
    customerEmail: 'kenji@meridian-testing.com',
    subject: 'MCP-TEST: API rate limiting errors',
    tags: ['mcp-test'],
    status: 'pending',
    hasStaffReply: true,
  },
  {
    customerEmail: 'priya@meridian-testing.com',
    subject: 'MCP-TEST: Feature request dark mode',
    tags: ['mcp-test', 'feature-request'],
    status: 'closed',
    hasStaffReply: false,
  },
  {
    customerEmail: 'tomas.r@meridian-testing.com',
    subject: 'MCP-TEST: Data export CSV failure',
    tags: ['mcp-test'],
    status: 'active',
    hasStaffReply: true,
  },
];

export const INTEGRATION_CONSTANTS = {
  orgId: '33911683',
  orgName: 'Meridian Testing Corp',
  inboxId: '359402',
  userId: 887476,
  searchPrefix: 'MCP-TEST:',
  tag: 'mcp-test',
};

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

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing HELPSCOUT_APP_ID / HELPSCOUT_APP_SECRET in .env');
  console.error('HELPSCOUT_CLIENT_ID / HELPSCOUT_CLIENT_SECRET are also supported.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth + HTTP client
// ---------------------------------------------------------------------------

let accessToken: string | null = null;

async function authenticate(): Promise<string> {
  if (accessToken) return accessToken;

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

// ---------------------------------------------------------------------------
// Conversation definitions
// ---------------------------------------------------------------------------

interface ThreadDef {
  type: 'customer' | 'reply' | 'customer-follow-up';
  text: string;
}

interface ConversationDef {
  customerEmail: string;
  customerId: number;
  subject: string;
  status: string;
  tags: string[];
  threads: ThreadDef[];
}

const CONVERSATIONS: ConversationDef[] = [
  {
    customerEmail: 'aria.chen@meridian-testing.com',
    customerId: 860612497,
    subject: 'MCP-TEST: Login credentials not working',
    status: 'closed',
    tags: ['mcp-test'],
    threads: [
      {
        type: 'customer',
        text: "Hi support, I've been unable to log into the client dashboard since yesterday morning. I've tried resetting my password three times but keep getting an 'invalid credentials' error. My username is aria.chen@meridian-testing.com. Can you help?",
      },
      {
        type: 'reply',
        text: "Hi Aria, I've reset your credentials and confirmed your account is active. Please try logging in again at dashboard.meridian-testing.com. If you're still having issues, let me know and I'll set up a screen share.",
      },
    ],
  },
  {
    customerEmail: 'marcus.j@meridian-testing.com',
    customerId: 860612501,
    subject: 'MCP-TEST: Billing question about annual plan',
    status: 'active',
    tags: ['mcp-test', 'billing'],
    threads: [
      {
        type: 'customer',
        text: "Hey there, our team has been on the monthly plan for about six months now. We'd like to switch to annual billing to get the discount. Can you walk me through what that process looks like? Also wondering if we get prorated credit for the current month.",
      },
    ],
  },
  {
    customerEmail: 'kenji@meridian-testing.com',
    customerId: 860612517,
    subject: 'MCP-TEST: API rate limiting errors',
    status: 'pending',
    tags: ['mcp-test'],
    threads: [
      {
        type: 'customer',
        text: "We're hitting 429 rate limit errors on the search endpoint during peak hours. Our integration makes about 200 requests per minute. Is there a way to increase our rate limit, or should we implement request queuing on our side?",
      },
      {
        type: 'reply',
        text: "Hi Kenji, I've checked your API usage and you're hitting the 400 req/min limit. I can bump your account to the higher tier which allows 800 req/min. In the meantime, implementing exponential backoff would help smooth out the peaks.",
      },
    ],
  },
  {
    customerEmail: 'priya@meridian-testing.com',
    customerId: 860612506,
    subject: 'MCP-TEST: Feature request dark mode',
    status: 'closed',
    tags: ['mcp-test', 'feature-request'],
    threads: [
      {
        type: 'customer',
        text: "Our design team has been requesting a dark mode option for the dashboard. Several of our engineers work late hours and the bright interface causes eye strain. Would this be something on your roadmap?",
      },
    ],
  },
  {
    customerEmail: 'tomas.r@meridian-testing.com',
    customerId: 860612508,
    subject: 'MCP-TEST: Data export CSV failure',
    status: 'active',
    tags: ['mcp-test'],
    threads: [
      {
        type: 'customer',
        text: "The CSV export feature fails when trying to export datasets larger than 10,000 rows. We get a timeout error after about 30 seconds. This is blocking our quarterly reporting workflow.",
      },
      {
        type: 'reply',
        text: "Hi Tomás, thanks for reporting this. I can reproduce the timeout on large exports. I've filed this as a bug with our engineering team. As a workaround, you can use the API endpoint /v2/export with pagination to pull data in chunks.",
      },
      {
        type: 'customer-follow-up',
        text: "Thanks for the workaround. Quick follow-up: we're also seeing the same timeout when exporting from the analytics dashboard, even with smaller datasets around 5,000 rows. Might be related?",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/** Search for existing MCP-TEST conversations in the target inbox. */
async function findExistingConversations(): Promise<number[]> {
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
  return conversations.map((c: any) => c.id);
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

async function addReplyThread(conversationId: number, text: string, finalStatus: string, customerEmail: string): Promise<void> {
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
  }
}

async function addCustomerThread(
  conversationId: number,
  customerEmail: string,
  text: string
): Promise<void> {
  const client = await api();
  const res = await client.post(`/conversations/${conversationId}/threads`, {
    type: 'customer',
    text,
    customer: { email: customerEmail },
    imported: true,
  });

  if (res.status !== 201 && res.status !== 200) {
    log(
      `  Warning: customer-thread on conversation ${conversationId} returned ${res.status}: ${JSON.stringify(res.data)}`
    );
  }
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
      await addReplyThread(convId, thread.text, threadStatus, def.customerEmail);
      log(`  Added staff reply (thread ${i + 1})`);
    } else if (thread.type === 'customer-follow-up') {
      await addCustomerThread(convId, def.customerEmail, thread.text);
      log(`  Added customer follow-up (thread ${i + 1})`);
    }
  }

  return convId;
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
  for (const id of ids) {
    await deleteConversation(id);
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
    log(`Found ${existing.length} existing conversation(s): ${existing.join(', ')}`);
    log('Conversations already seeded. Run with --cleanup to remove them first.');

    heading('Seed Already Complete');
    log(`Org:   ${INTEGRATION_CONSTANTS.orgName} (ID: ${INTEGRATION_CONSTANTS.orgId})`);
    log(`Inbox: Client Support (ID: ${INTEGRATION_CONSTANTS.inboxId})`);
    log(`Existing conversation IDs: ${existing.join(', ')}`);
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
