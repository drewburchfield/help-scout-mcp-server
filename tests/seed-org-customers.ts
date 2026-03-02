#!/usr/bin/env npx tsx
/**
 * Seed 15 additional customers into the Meridian Testing Corp org.
 * This populates the org members endpoint and tests pagination.
 *
 * Usage:
 *   npx tsx tests/seed-org-customers.ts           # Create customers
 *   npx tsx tests/seed-org-customers.ts --cleanup  # Delete seeded customers
 */

import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';

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
  console.error('Missing HELPSCOUT_CLIENT_ID / HELPSCOUT_CLIENT_SECRET in .env');
  process.exit(1);
}

const GOLDEN_ORG_ID = 33911683;

// 15 fictional employees at Meridian Testing Corp
const TEAM_MEMBERS = [
  { firstName: 'Aria', lastName: 'Chen', jobTitle: 'Engineering Manager', email: 'aria.chen@meridian-testing.com' },
  { firstName: 'Marcus', lastName: 'Johnson', jobTitle: 'Senior Developer', email: 'marcus.j@meridian-testing.com' },
  { firstName: 'Priya', lastName: 'Patel', jobTitle: 'Product Designer', email: 'priya@meridian-testing.com' },
  { firstName: 'Tomás', lastName: 'Rivera', jobTitle: 'DevOps Lead', email: 'tomas.r@meridian-testing.com' },
  { firstName: 'Sofia', lastName: 'Bergström', jobTitle: 'QA Analyst', email: 'sofia.b@meridian-testing.com' },
  { firstName: 'Kenji', lastName: 'Watanabe', jobTitle: 'Backend Engineer', email: 'kenji@meridian-testing.com' },
  { firstName: 'Fatima', lastName: 'Al-Hassan', jobTitle: 'Frontend Engineer', email: 'fatima.h@meridian-testing.com' },
  { firstName: 'Liam', lastName: "O'Brien", jobTitle: 'Data Analyst', email: 'liam.ob@meridian-testing.com' },
  { firstName: 'Yuki', lastName: 'Tanaka', jobTitle: 'Security Engineer', email: 'yuki.t@meridian-testing.com' },
  { firstName: 'Elena', lastName: 'Kowalski', jobTitle: 'Technical Writer', email: 'elena.k@meridian-testing.com' },
  { firstName: 'Dante', lastName: 'Moretti', jobTitle: 'Mobile Developer', email: 'dante.m@meridian-testing.com' },
  { firstName: 'Amara', lastName: 'Okafor', jobTitle: 'Platform Engineer', email: 'amara.o@meridian-testing.com' },
  { firstName: 'Raj', lastName: 'Krishnamurthy', jobTitle: 'Architect', email: 'raj.k@meridian-testing.com' },
  { firstName: 'Ingrid', lastName: 'Svensson', jobTitle: 'Release Manager', email: 'ingrid.s@meridian-testing.com' },
  { firstName: 'Noah', lastName: 'Fischer', jobTitle: 'Support Engineer', email: 'noah.f@meridian-testing.com' },
];

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
    validateStatus: () => true,
  });
}

function extractIdFromHeaders(headers: Record<string, string>): number | null {
  const resourceId = headers['resource-id'];
  if (resourceId && /^\d+$/.test(resourceId)) return Number(resourceId);
  const location = headers['location'];
  if (location) {
    const match = location.match(/\/(\d+)(?:\?|$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

async function findCustomerByEmail(email: string): Promise<number | null> {
  const token = await authenticate();
  const res = await axios.get('https://api.helpscout.net/v3/customers', {
    headers: { Authorization: `Bearer ${token}` },
    params: { email },
    validateStatus: () => true,
  });
  if (res.status !== 200) return null;
  const customers = res.data?._embedded?.customers || [];
  return customers.length > 0 ? customers[0].id : null;
}

async function createCustomer(member: typeof TEAM_MEMBERS[0]): Promise<{ id: number; action: string }> {
  const existing = await findCustomerByEmail(member.email);
  if (existing) {
    return { id: existing, action: 'exists' };
  }

  const client = await api();
  const res = await client.post('/customers', {
    firstName: member.firstName,
    lastName: member.lastName,
    jobTitle: member.jobTitle,
    organizationId: GOLDEN_ORG_ID,
    location: 'Nashville, TN',
    background: `Meridian Testing Corp team member (seeded for v1.7.0 testing)`,
    emails: [{ type: 'work', value: member.email }],
  });

  if (res.status === 201) {
    const id = extractIdFromHeaders(res.headers);
    if (id) return { id, action: 'created' };
  }

  if (res.status === 409) {
    const refetch = await findCustomerByEmail(member.email);
    if (refetch) return { id: refetch, action: 'exists (409)' };
  }

  return { id: 0, action: `failed (${res.status}: ${JSON.stringify(res.data).slice(0, 100)})` };
}

async function deleteCustomer(email: string): Promise<string> {
  const id = await findCustomerByEmail(email);
  if (!id) return 'not found';
  const client = await api();
  const res = await client.delete(`/customers/${id}`);
  return res.status === 204 ? `deleted (${id})` : `status ${res.status}`;
}

async function main(): Promise<void> {
  const isCleanup = process.argv.includes('--cleanup');

  if (isCleanup) {
    console.log('\n=== Cleaning up seeded org customers ===\n');
    for (const member of TEAM_MEMBERS) {
      const result = await deleteCustomer(member.email);
      console.log(`  ${member.firstName} ${member.lastName} (${member.email}): ${result}`);
    }
    console.log('\nCleanup complete.');
    return;
  }

  console.log('\n=== Seeding 15 customers into Meridian Testing Corp (org: 33911683) ===\n');

  const results: { name: string; id: number; action: string }[] = [];

  for (const member of TEAM_MEMBERS) {
    const result = await createCustomer(member);
    results.push({ name: `${member.firstName} ${member.lastName}`, ...result });
    const icon = result.action === 'created' ? '+' : '=';
    console.log(`  [${icon}] ${member.firstName} ${member.lastName} <${member.email}> -> ID: ${result.id} (${result.action})`);
  }

  const created = results.filter(r => r.action === 'created').length;
  const existing = results.filter(r => r.action.startsWith('exists')).length;
  const failed = results.filter(r => r.action.startsWith('failed')).length;

  console.log(`\n=== Summary: ${created} created, ${existing} existing, ${failed} failed ===`);
  console.log(`\nVerify with: npx tsx tests/verify-stale-build-fixes.ts`);
  console.log(`Clean up with: npx tsx tests/seed-org-customers.ts --cleanup\n`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
