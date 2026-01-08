#!/usr/bin/env npx tsx
/**
 * Help Scout Conversation Import Script
 * Imports conversations from JSONL format into Help Scout
 *
 * Usage: npx tsx scripts/import-conversations.ts <source-file.jsonl> [--dry-run] [--limit N] [--resume]
 *
 * Example: npx tsx scripts/import-conversations.ts ./data/conversations.jsonl --dry-run --limit 10
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration - sourceFile and mailboxId loaded in main()
const CONFIG = {
  sourceFile: '', // Set from command-line argument in main()
  targetMailboxId: 0, // Set from HELPSCOUT_DEFAULT_INBOX_ID in main()
  progressFile: path.join(__dirname, '.import-progress.json'),
  rateLimit: 5, // requests per second (conservative)
  rateLimitDelay: 200, // ms between requests
  maxRetries: 3,
  retryDelay: 1000, // ms
};

// Types
interface SourceThread {
  id: number;
  type: string;
  status?: string;
  body?: string;
  text?: string;
  customer?: {
    id?: number;
    first?: string;
    last?: string;
    email?: string;
  };
  createdBy?: {
    id?: number;
    type?: string;
    first?: string;
    last?: string;
    email?: string;
  };
  createdAt: string;
  to?: Array<{ email: string }>;
  cc?: Array<{ email: string }>;
  bcc?: Array<{ email: string }>;
}

interface SourceConversation {
  source_id: string;
  title: string;
  content: string;
  metadata: {
    conversation_id: string;
    status: string;
    created_at: string;
    modified_at: string;
    customer: Record<string, unknown>;
    threads: SourceThread[];
  };
}

interface HelpScoutThread {
  type: 'customer' | 'reply' | 'note' | 'phone';
  customer?: { email: string; firstName?: string; lastName?: string };
  user?: number;
  text: string;
  createdAt?: string;
}

interface HelpScoutConversation {
  subject: string;
  type: 'email' | 'phone' | 'chat';
  mailboxId: number;
  status: 'active' | 'closed' | 'pending';
  customer: { email: string; firstName?: string; lastName?: string };
  threads: HelpScoutThread[];
  imported: true;
  createdAt?: string;
  closedAt?: string;
  tags?: string[];
}

interface ImportProgress {
  lastProcessedLine: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: Array<{ line: number; sourceId: string; error: string }>;
  startedAt: string;
  lastUpdatedAt: string;
}

// Utility functions
function loadEnv(): Record<string, string> {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env file not found');
  }
  const content = fs.readFileSync(envPath, 'utf8');
  const env: Record<string, string> = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
  return env;
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const response = await axios.post(
    'https://api.helpscout.net/v2/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

function createApiClient(accessToken: string): AxiosInstance {
  return axios.create({
    baseURL: 'https://api.helpscout.net/v2',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ensure date is in proper ISO 8601 format with Z suffix
function normalizeDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString();
  // If it doesn't end with Z, add it
  if (!dateStr.endsWith('Z')) {
    return dateStr + 'Z';
  }
  return dateStr;
}

// Thread type mapping
function mapThreadType(sourceType: string): 'customer' | 'reply' | 'note' | 'phone' | null {
  switch (sourceType) {
    case 'customer':
      return 'customer';
    case 'message':
      return 'reply';
    case 'note':
      return 'note';
    case 'phone':
      return 'phone';
    case 'lineitem':
    case 'forwardchild':
    case 'forwardparent':
      return null; // Skip these
    default:
      console.warn(`Unknown thread type: ${sourceType}, treating as note`);
      return 'note';
  }
}

// Sanitize customer name - Help Scout requires firstName/lastName to be 1-40 chars (not empty)
function sanitizeCustomerName(name: string | undefined, defaultName: string): string {
  if (!name || name.trim() === '') {
    return defaultName;
  }
  return name.substring(0, 40); // Truncate to max 40 chars
}

// Sanitize customer object to ensure valid firstName/lastName
function sanitizeCustomer(customer: { email: string; firstName?: string; lastName?: string }): { email: string; firstName: string; lastName: string } {
  // Extract name from email if needed (e.g., john.doe@example.com -> John Doe)
  const emailName = customer.email.split('@')[0].replace(/[._]/g, ' ');
  const nameParts = emailName.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1));

  return {
    email: customer.email,
    firstName: sanitizeCustomerName(customer.firstName, nameParts[0] || 'Customer'),
    lastName: sanitizeCustomerName(customer.lastName, nameParts[1] || 'User'),
  };
}

// Extract customer info from thread
function extractCustomerFromThread(thread: SourceThread): { email: string; firstName?: string; lastName?: string } | null {
  // Try customer field first
  if (thread.customer?.email) {
    return {
      email: thread.customer.email,
      firstName: thread.customer.first,
      lastName: thread.customer.last,
    };
  }

  // Try createdBy field if it's a customer
  if (thread.createdBy?.type === 'customer' && thread.createdBy?.email) {
    return {
      email: thread.createdBy.email,
      firstName: thread.createdBy.first,
      lastName: thread.createdBy.last,
    };
  }

  // Try to field
  if (thread.to && thread.to.length > 0 && thread.to[0].email) {
    return { email: thread.to[0].email };
  }

  return null;
}

// Transform source conversation to Help Scout format
function transformConversation(source: SourceConversation): HelpScoutConversation | null {
  // Find the primary customer
  let customer: { email: string; firstName?: string; lastName?: string } | null = null;

  // Look through threads to find customer info
  for (const thread of source.metadata.threads) {
    if (thread.type === 'customer') {
      customer = extractCustomerFromThread(thread);
      if (customer) break;
    }
  }

  // If no customer found in customer threads, check other threads
  if (!customer) {
    for (const thread of source.metadata.threads) {
      customer = extractCustomerFromThread(thread);
      if (customer) break;
    }
  }

  // If still no customer, create a placeholder
  if (!customer) {
    customer = {
      email: `unknown-${source.source_id}@imported.local`,
      firstName: 'Unknown',
      lastName: 'Customer',
    };
  }

  // Sanitize primary customer (ensure firstName/lastName are valid 1-40 chars)
  const sanitizedCustomer = sanitizeCustomer(customer);

  // Transform threads
  const threads: HelpScoutThread[] = [];

  for (const thread of source.metadata.threads) {
    const mappedType = mapThreadType(thread.type);
    if (!mappedType) continue; // Skip lineitem, etc.

    const text = thread.body || thread.text || '(no content)';

    // ALL thread types require customer info in Help Scout API
    const threadCustomer = extractCustomerFromThread(thread);
    // Sanitize thread customer (or use sanitized primary customer as fallback)
    const sanitizedThreadCustomer = threadCustomer ? sanitizeCustomer(threadCustomer) : sanitizedCustomer;

    const hsThread: HelpScoutThread = {
      type: mappedType,
      text: text,
      createdAt: normalizeDate(thread.createdAt),
      customer: sanitizedThreadCustomer,
    };

    threads.push(hsThread);
  }

  // Need at least one thread
  if (threads.length === 0) {
    return null;
  }

  // Sort threads by createdAt (oldest first)
  threads.sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateA - dateB;
  });

  // Map status
  let status: 'active' | 'closed' | 'pending' = 'closed';
  if (source.metadata.status === 'active') status = 'active';
  else if (source.metadata.status === 'pending') status = 'pending';

  const conversation: HelpScoutConversation = {
    subject: source.title || '(no subject)',
    type: 'email',
    mailboxId: CONFIG.targetMailboxId,
    status: status,
    customer: sanitizedCustomer,
    threads: threads,
    imported: true,
    createdAt: normalizeDate(source.metadata.created_at),
  };

  if (status === 'closed') {
    conversation.closedAt = normalizeDate(source.metadata.modified_at);
  }

  return conversation;
}

// Import a single conversation with retry logic
async function importConversation(
  api: AxiosInstance,
  conversation: HelpScoutConversation,
  dryRun: boolean
): Promise<{ success: boolean; id?: number; error?: string }> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would create: "${conversation.subject}" (${conversation.threads.length} threads)`);
    return { success: true };
  }

  // Debug: Show what we're sending (first time only)
  const debugMode = process.argv.includes('--debug');
  if (debugMode) {
    console.log('\n📤 Sending to API:');
    console.log(JSON.stringify(conversation, null, 2).substring(0, 2000));
    console.log('...\n');
  }

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await api.post('/conversations', conversation);
      const locationHeader = response.headers['location'];
      const id = locationHeader ? parseInt(locationHeader.split('/').pop() || '0') : undefined;
      return { success: true, id };
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = parseInt(error.response.headers['retry-after'] || '60');
        console.log(`  Rate limited, waiting ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (attempt === CONFIG.maxRetries) {
        const errorData = error.response?.data;
        const errorMsg = errorData
          ? JSON.stringify(errorData, null, 2)
          : error.message;
        return { success: false, error: errorMsg };
      }

      // Retry for other errors
      await sleep(CONFIG.retryDelay * attempt);
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

// Load or create progress file
function loadProgress(): ImportProgress {
  if (fs.existsSync(CONFIG.progressFile)) {
    return JSON.parse(fs.readFileSync(CONFIG.progressFile, 'utf8'));
  }
  return {
    lastProcessedLine: 0,
    importedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(progress: ImportProgress): void {
  progress.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(CONFIG.progressFile, JSON.stringify(progress, null, 2));
}

// Main import function
async function main() {
  const args = process.argv.slice(2);

  // First positional arg is the source file
  const sourceFile = args.find(a => !a.startsWith('--'));
  if (!sourceFile) {
    console.error('❌ Usage: npx tsx scripts/import-conversations.ts <source-file.jsonl> [--dry-run] [--limit=N] [--resume]');
    console.error('   Example: npx tsx scripts/import-conversations.ts ./data/conversations.jsonl --dry-run');
    process.exit(1);
  }

  if (!fs.existsSync(sourceFile)) {
    console.error(`❌ Source file not found: ${sourceFile}`);
    process.exit(1);
  }

  CONFIG.sourceFile = sourceFile;

  const dryRun = args.includes('--dry-run');
  const resume = args.includes('--resume');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : undefined;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Help Scout Conversation Import');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Source: ${CONFIG.sourceFile}`);
  console.log(`  Target Mailbox: ${CONFIG.targetMailboxId}`);
  console.log(`  Dry Run: ${dryRun}`);
  console.log(`  Resume: ${resume}`);
  console.log(`  Limit: ${limit || 'none'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Load credentials
  const env = loadEnv();
  const clientId = env.HELPSCOUT_CLIENT_ID;
  const clientSecret = env.HELPSCOUT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ Missing credentials in .env');
    process.exit(1);
  }

  // Get mailbox ID from env (required for import)
  const mailboxId = env.HELPSCOUT_DEFAULT_INBOX_ID;
  if (!mailboxId) {
    console.error('❌ HELPSCOUT_DEFAULT_INBOX_ID not set in .env');
    process.exit(1);
  }
  CONFIG.targetMailboxId = parseInt(mailboxId, 10);

  // Get access token
  console.log('🔐 Authenticating...');
  const accessToken = await getAccessToken(clientId, clientSecret);
  const api = createApiClient(accessToken);
  console.log('✅ Authenticated\n');

  // Load progress
  let progress = resume ? loadProgress() : {
    lastProcessedLine: 0,
    importedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };

  if (resume && progress.lastProcessedLine > 0) {
    console.log(`📂 Resuming from line ${progress.lastProcessedLine}`);
    console.log(`   Already imported: ${progress.importedCount}, Skipped: ${progress.skippedCount}, Errors: ${progress.errorCount}\n`);
  }

  // Open file for streaming
  const fileStream = fs.createReadStream(CONFIG.sourceFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let processedThisRun = 0;

  console.log('📥 Starting import...\n');

  for await (const line of rl) {
    lineNumber++;

    // Skip already processed lines
    if (lineNumber <= progress.lastProcessedLine) {
      continue;
    }

    // Check limit
    if (limit && processedThisRun >= limit) {
      console.log(`\n⏸️  Limit of ${limit} reached`);
      break;
    }

    try {
      const source: SourceConversation = JSON.parse(line);
      const conversation = transformConversation(source);

      if (!conversation) {
        console.log(`⏭️  [${lineNumber}] Skipped: No valid threads in ${source.source_id}`);
        progress.skippedCount++;
        progress.lastProcessedLine = lineNumber;
        continue;
      }

      const result = await importConversation(api, conversation, dryRun);

      if (result.success) {
        progress.importedCount++;
        console.log(`✅ [${lineNumber}] Imported: "${conversation.subject.substring(0, 50)}..." (${conversation.threads.length} threads)`);
      } else {
        progress.errorCount++;
        progress.errors.push({
          line: lineNumber,
          sourceId: source.source_id,
          error: result.error || 'Unknown error',
        });
        console.log(`❌ [${lineNumber}] Error: ${result.error}`);
      }

      progress.lastProcessedLine = lineNumber;
      processedThisRun++;

      // Save progress every 10 conversations
      if (processedThisRun % 10 === 0) {
        saveProgress(progress);
      }

      // Rate limiting
      await sleep(CONFIG.rateLimitDelay);

    } catch (error: any) {
      progress.errorCount++;
      progress.errors.push({
        line: lineNumber,
        sourceId: 'parse-error',
        error: error.message,
      });
      console.log(`❌ [${lineNumber}] Parse error: ${error.message}`);
      progress.lastProcessedLine = lineNumber;
    }
  }

  // Final save
  saveProgress(progress);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Import Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Processed this run: ${processedThisRun}`);
  console.log(`  Total imported: ${progress.importedCount}`);
  console.log(`  Total skipped: ${progress.skippedCount}`);
  console.log(`  Total errors: ${progress.errorCount}`);
  console.log(`  Progress saved to: ${CONFIG.progressFile}`);
  console.log('═══════════════════════════════════════════════════════════');

  if (progress.errors.length > 0) {
    console.log('\n⚠️  Recent errors:');
    progress.errors.slice(-5).forEach(e => {
      console.log(`   Line ${e.line}: ${e.error}`);
    });
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
