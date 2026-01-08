#!/usr/bin/env npx tsx
/**
 * Quick check for conversations in Help Scout
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnv(): Record<string, string> {
  const envPath = path.join(__dirname, '..', '.env');
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

async function main() {
  const env = loadEnv();

  // Get token
  const tokenRes = await axios.post(
    'https://api.helpscout.net/v2/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.HELPSCOUT_CLIENT_ID,
      client_secret: env.HELPSCOUT_CLIENT_SECRET,
    })
  );

  const token = tokenRes.data.access_token;
  console.log('✅ Authenticated\n');

  // Get mailbox ID from env
  const mailboxId = env.HELPSCOUT_DEFAULT_INBOX_ID;
  if (!mailboxId) {
    console.error('❌ HELPSCOUT_DEFAULT_INBOX_ID not set in .env');
    process.exit(1);
  }

  // List conversations in mailbox
  const convRes = await axios.get('https://api.helpscout.net/v2/conversations', {
    headers: { Authorization: `Bearer ${token}` },
    params: { mailbox: parseInt(mailboxId, 10), status: 'all' }
  });

  console.log('📊 Conversation Stats:');
  console.log(`   Total: ${convRes.data.page?.totalElements || 0}`);
  console.log(`   Page size: ${convRes.data.page?.size || 0}`);

  const conversations = convRes.data._embedded?.conversations || [];
  console.log(`   Returned: ${conversations.length}\n`);

  if (conversations.length > 0) {
    console.log('📝 Recent Conversations:');
    conversations.slice(0, 5).forEach((c: any, i: number) => {
      console.log(`   ${i + 1}. [${c.status}] ${c.subject?.substring(0, 50)}...`);
      console.log(`      ID: ${c.id}, Created: ${c.createdAt}`);
    });
  } else {
    console.log(`❌ No conversations found in mailbox ${mailboxId}`);
  }
}

main().catch(e => {
  console.error('Error:', e.response?.data || e.message);
  process.exit(1);
});
