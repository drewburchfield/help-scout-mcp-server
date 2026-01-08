#!/usr/bin/env npx tsx
/**
 * Help Scout Credential Verification Script
 * Tests OAuth2 authentication and lists available inboxes
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface Inbox {
  id: number;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

interface MailboxesResponse {
  _embedded: {
    mailboxes: Inbox[];
  };
  page: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

// Load environment variables from .env
function loadEnv(): Record<string, string> {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found');
    process.exit(1);
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
  console.log('🔐 Authenticating with Help Scout API...');

  const response = await axios.post<TokenResponse>(
    'https://api.helpscout.net/v2/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  console.log(`✅ Authentication successful! Token expires in ${response.data.expires_in} seconds`);
  return response.data.access_token;
}

async function listMailboxes(accessToken: string): Promise<Inbox[]> {
  console.log('\n📬 Fetching mailboxes (inboxes)...');

  const response = await axios.get<MailboxesResponse>(
    'https://api.helpscout.net/v2/mailboxes',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return response.data._embedded?.mailboxes || [];
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Help Scout MCP Server - Credential Verification');
  console.log('═══════════════════════════════════════════════════════════\n');

  const env = loadEnv();

  const clientId = env.HELPSCOUT_CLIENT_ID;
  const clientSecret = env.HELPSCOUT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ Missing credentials in .env file');
    console.error('   Required: HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET');
    process.exit(1);
  }

  console.log(`📋 Client ID: ${clientId.substring(0, 8)}...${clientId.substring(clientId.length - 4)}`);

  try {
    // Test OAuth2 authentication
    const accessToken = await getAccessToken(clientId, clientSecret);

    // List mailboxes
    const mailboxes = await listMailboxes(accessToken);

    console.log(`\n📊 Found ${mailboxes.length} inbox(es):\n`);

    if (mailboxes.length === 0) {
      console.log('   ⚠️  No inboxes found. You need to create at least one inbox in Help Scout.');
      console.log('   📝 Go to Help Scout → Mailboxes → Create Mailbox');
    } else {
      mailboxes.forEach((inbox, index) => {
        console.log(`   ${index + 1}. ${inbox.name}`);
        console.log(`      ID: ${inbox.id}`);
        console.log(`      Email: ${inbox.email}`);
        console.log(`      Created: ${inbox.createdAt}`);
        console.log('');
      });

      // Suggest default inbox configuration
      console.log('═══════════════════════════════════════════════════════════');
      console.log('  📝 Next Steps:');
      console.log('═══════════════════════════════════════════════════════════');

      if (mailboxes.length >= 2) {
        console.log('\n  ✅ You have 2+ inboxes - ready for multi-inbox testing!\n');
      } else {
        console.log('\n  ⚠️  You only have 1 inbox. For multi-inbox testing, create another:');
        console.log('     Go to Help Scout → Mailboxes → Create Mailbox\n');
      }

      console.log('  To set a default inbox, add to .env:');
      console.log(`  HELPSCOUT_DEFAULT_INBOX_ID=${mailboxes[0].id}\n`);
    }

    // Output JSON for programmatic use
    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      inboxCount: mailboxes.length,
      inboxes: mailboxes.map(m => ({
        id: m.id,
        name: m.name,
        email: m.email,
      })),
    };

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  JSON Output (for programmatic use):');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('\n❌ API Error:', error.response?.status, error.response?.statusText);

      if (error.response?.status === 401) {
        console.error('\n   Authentication failed. Check your credentials:');
        console.error('   - Verify HELPSCOUT_CLIENT_ID is correct (App ID from Help Scout)');
        console.error('   - Verify HELPSCOUT_CLIENT_SECRET is correct (App Secret from Help Scout)');
        console.error('   - Ensure the OAuth app is associated with an active user');
      } else if (error.response?.status === 429) {
        console.error('\n   Rate limited. Wait a moment and try again.');
      } else {
        console.error('\n   Response:', JSON.stringify(error.response?.data, null, 2));
      }
    } else {
      console.error('\n❌ Error:', error);
    }
    process.exit(1);
  }
}

main();
