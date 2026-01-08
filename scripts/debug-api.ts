#!/usr/bin/env npx tsx
/**
 * Debug Help Scout API responses
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
  const mailbox = parseInt(mailboxId, 10);

  // Test 1: modifiedSince with milliseconds (full ISO 8601)
  const dateWithMs = new Date();
  dateWithMs.setDate(dateWithMs.getDate() - 365);
  console.log('📋 Test 1: modifiedSince with milliseconds:', dateWithMs.toISOString());
  try {
    const test1 = await axios.get('https://api.helpscout.net/v2/conversations', {
      headers: { Authorization: `Bearer ${token}` },
      params: { mailbox, status: 'all', modifiedSince: dateWithMs.toISOString() }
    });
    console.log('  Total:', test1.data.page?.totalElements);
  } catch (e: any) {
    console.log('  ❌ Error:', e.response?.data?._embedded?.errors?.[0]?.message || e.message);
  }

  // Test 2: modifiedSince WITHOUT milliseconds
  const dateNoMs = '2025-01-07T00:00:00Z';
  console.log('\n📋 Test 2: modifiedSince without milliseconds:', dateNoMs);
  try {
    const test2 = await axios.get('https://api.helpscout.net/v2/conversations', {
      headers: { Authorization: `Bearer ${token}` },
      params: { mailbox, status: 'all', modifiedSince: dateNoMs }
    });
    console.log('  Total:', test2.data.page?.totalElements);
  } catch (e: any) {
    console.log('  ❌ Error:', e.response?.data?._embedded?.errors?.[0]?.message || e.message);
  }

  // Test 3: modifiedSince with old date (2024)
  const oldDate = '2024-01-01T00:00:00Z';
  console.log('\n📋 Test 3: modifiedSince with 2024 date:', oldDate);
  try {
    const test3 = await axios.get('https://api.helpscout.net/v2/conversations', {
      headers: { Authorization: `Bearer ${token}` },
      params: { mailbox, status: 'all', modifiedSince: oldDate }
    });
    console.log('  Total:', test3.data.page?.totalElements);
  } catch (e: any) {
    console.log('  ❌ Error:', e.response?.data?._embedded?.errors?.[0]?.message || e.message);
  }
}

main().catch(e => {
  console.error('Error:', e.response?.data || e.message);
  process.exit(1);
});
