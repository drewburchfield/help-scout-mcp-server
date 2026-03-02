#!/usr/bin/env npx tsx
/**
 * Seed golden test data for v1.7.0 manual testing.
 *
 * Creates one customer and one organization with every redactable field
 * populated, so PII redaction can be verified end-to-end.
 *
 * Usage:
 *   npx tsx tests/seed-test-data.ts           # Create/update golden records
 *   npx tsx tests/seed-test-data.ts --cleanup  # Delete golden records
 */

import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';

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
  console.error('Missing HELPSCOUT_CLIENT_ID / HELPSCOUT_CLIENT_SECRET in .env');
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
// Golden record definitions
// ---------------------------------------------------------------------------

const GOLDEN_EMAIL = 'testuser@meridian-testing.com';

const GOLDEN_CUSTOMER = {
  firstName: 'Meridian',
  lastName: 'TestUser',
  jobTitle: 'QA Engineer',
  location: 'Nashville, TN',
  age: '32',
  background: 'Golden test customer for v1.7.0 PII redaction testing',
  photoUrl: 'https://i.pravatar.cc/150?u=meridian-test',
};

const GOLDEN_ORG = {
  name: 'Meridian Testing Corp',
  website: 'https://meridian-testing.com',
  domains: ['meridian-testing.com'],
  phones: ['+1-615-555-0100'],
  location: 'US',
  note: 'Internal test organization for MCP server v1.7.0 validation',
  description: 'Fictional company used to verify PII redaction across all Help Scout API fields',
  brandColor: '#7C3AED',
};

const GOLDEN_ADDRESS = {
  city: 'Nashville',
  state: 'TN',
  postalCode: '37201',
  country: 'US',
  lines: ['100 Broadway', 'Suite 400'],
};

// ---------------------------------------------------------------------------
// Organization CRUD
// ---------------------------------------------------------------------------

async function findOrganization(): Promise<number | null> {
  const client = await api();
  // Paginate through all orgs since Help Scout doesn't support name search
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const res = await client.get('/organizations', { params: { page } });
    if (res.status !== 200) return null;

    totalPages = res.data?.page?.totalPages || 1;
    const orgs = res.data?._embedded?.organizations || [];
    const match = orgs.find((o: any) => o.name === GOLDEN_ORG.name);
    if (match) return match.id;
    page++;
  }
  return null;
}

async function createOrganization(): Promise<number> {
  const client = await api();
  const res = await client.post('/organizations', GOLDEN_ORG);

  if (res.status === 201) {
    const id = extractIdFromHeaders(res.headers);
    if (id) return id;
  }

  // 409 Conflict means it already exists; fall back to search
  if (res.status === 409) {
    log('Org creation returned 409 (already exists), searching...');
    const refetchId = await findOrganization();
    if (refetchId) return refetchId;
  }

  throw new Error(`Failed to create organization: ${res.status} ${JSON.stringify(res.data)}`);
}

async function updateOrganization(orgId: number): Promise<void> {
  const client = await api();
  const res = await client.put(`/organizations/${orgId}`, GOLDEN_ORG);

  if (res.status !== 204 && res.status !== 200) {
    log(`  Warning: org update returned ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

async function deleteOrganization(orgId: number): Promise<void> {
  const client = await api();
  const res = await client.delete(`/organizations/${orgId}`);
  if (res.status === 204 || res.status === 200) {
    log(`Deleted organization ${orgId}`);
  } else {
    log(`Warning: org delete returned ${res.status}`);
  }
}

async function findOrCreateOrganization(): Promise<number> {
  const existing = await findOrganization();
  if (existing) {
    log(`Found existing org "${GOLDEN_ORG.name}" (ID: ${existing}), updating...`);
    await updateOrganization(existing);
    return existing;
  }

  log(`Creating org "${GOLDEN_ORG.name}"...`);
  const id = await createOrganization();
  log(`Created org (ID: ${id})`);
  return id;
}

// ---------------------------------------------------------------------------
// Customer CRUD
// ---------------------------------------------------------------------------

async function findCustomerByEmail(): Promise<number | null> {
  const token = await authenticate();
  // v3 endpoint supports direct email filter (v2 query search is unreliable for new records)
  const res = await axios.get('https://api.helpscout.net/v3/customers', {
    headers: { Authorization: `Bearer ${token}` },
    params: { email: GOLDEN_EMAIL },
    validateStatus: () => true,
  });
  if (res.status !== 200) return null;

  const customers = res.data?._embedded?.customers || [];
  return customers.length > 0 ? customers[0].id : null;
}

async function createCustomer(orgId: number): Promise<number> {
  const client = await api();
  const body = {
    ...GOLDEN_CUSTOMER,
    organizationId: orgId,
    emails: [{ type: 'work', value: GOLDEN_EMAIL }],
  };
  const res = await client.post('/customers', body);

  if (res.status === 201) {
    const id = extractIdFromHeaders(res.headers);
    if (id) return id;
  }

  // 409 Conflict means customer with this email already exists
  if (res.status === 409) {
    log('Customer creation returned 409 (already exists), searching...');
    const refetchId = await findCustomerByEmail();
    if (refetchId) return refetchId;
  }

  throw new Error(`Failed to create customer: ${res.status} ${JSON.stringify(res.data)}`);
}

async function updateCustomer(customerId: number, orgId: number): Promise<void> {
  const client = await api();
  const patches = [
    { op: 'replace', path: '/firstName', value: GOLDEN_CUSTOMER.firstName },
    { op: 'replace', path: '/lastName', value: GOLDEN_CUSTOMER.lastName },
    { op: 'replace', path: '/jobTitle', value: GOLDEN_CUSTOMER.jobTitle },
    { op: 'replace', path: '/location', value: GOLDEN_CUSTOMER.location },
    { op: 'replace', path: '/age', value: GOLDEN_CUSTOMER.age },
    { op: 'replace', path: '/background', value: GOLDEN_CUSTOMER.background },
    { op: 'replace', path: '/photoUrl', value: GOLDEN_CUSTOMER.photoUrl },
  ];
  // Note: organizationId is set at creation time; the PATCH /organization path
  // uses the deprecated string field and doesn't accept numeric IDs.
  const res = await client.patch(`/customers/${customerId}`, patches);

  if (res.status !== 204 && res.status !== 200) {
    log(`  Warning: customer update returned ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

async function deleteCustomer(customerId: number): Promise<void> {
  const client = await api();
  const res = await client.delete(`/customers/${customerId}`);
  if (res.status === 204 || res.status === 200) {
    log(`Deleted customer ${customerId}`);
  } else {
    log(`Warning: customer delete returned ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

async function findOrCreateCustomer(orgId: number): Promise<number> {
  const existing = await findCustomerByEmail();
  if (existing) {
    log(`Found existing customer "${GOLDEN_EMAIL}" (ID: ${existing}), updating...`);
    await updateCustomer(existing, orgId);
    return existing;
  }

  log(`Creating customer "${GOLDEN_EMAIL}"...`);
  const id = await createCustomer(orgId);
  log(`Created customer (ID: ${id})`);
  return id;
}

// ---------------------------------------------------------------------------
// Sub-resources
// ---------------------------------------------------------------------------

async function getSubResource(customerId: number, type: string): Promise<any[]> {
  const client = await api();
  const res = await client.get(`/customers/${customerId}/${type}`);
  if (res.status !== 200) return [];
  return res.data?._embedded?.[type] || [];
}

async function populateSubResources(customerId: number): Promise<void> {
  const client = await api();

  // Phones
  const phones = await getSubResource(customerId, 'phones');
  if (phones.length === 0) {
    const res = await client.post(`/customers/${customerId}/phones`, {
      type: 'work',
      value: '+1-615-555-0170',
    });
    log(`Phone: ${res.status === 201 ? 'created' : `status ${res.status}`}`);
  } else {
    log(`Phone: already exists (${phones.length})`);
  }

  // Chats
  const chats = await getSubResource(customerId, 'chats');
  if (chats.length === 0) {
    const res = await client.post(`/customers/${customerId}/chats`, {
      type: 'other',
      value: 'meridian.testuser',
    });
    log(`Chat: ${res.status === 201 ? 'created' : `status ${res.status}`}`);
  } else {
    log(`Chat: already exists (${chats.length})`);
  }

  // Social profiles
  const socials = await getSubResource(customerId, 'social-profiles');
  if (socials.length === 0) {
    const res = await client.post(`/customers/${customerId}/social-profiles`, {
      type: 'twitter',
      value: '@meridian_test',
    });
    log(`Social: ${res.status === 201 ? 'created' : `status ${res.status}`}`);
  } else {
    log(`Social: already exists (${socials.length})`);
  }

  // Websites
  const websites = await getSubResource(customerId, 'websites');
  if (websites.length === 0) {
    const res = await client.post(`/customers/${customerId}/websites`, {
      value: 'https://meridian-testing.com',
    });
    log(`Website: ${res.status === 201 ? 'created' : `status ${res.status}`}`);
  } else {
    log(`Website: already exists (${websites.length})`);
  }

  // Address (single resource, not a collection)
  const addrRes = await client.get(`/customers/${customerId}/address`);
  if (addrRes.status === 404 || !addrRes.data?.city) {
    const createRes = await client.post(`/customers/${customerId}/address`, GOLDEN_ADDRESS);
    if (createRes.status === 201 || createRes.status === 200) {
      log('Address: created');
    } else {
      // Maybe it exists but GET returned weirdly; try PUT
      const putRes = await client.put(`/customers/${customerId}/address`, GOLDEN_ADDRESS);
      log(`Address: PUT ${putRes.status === 204 ? 'updated' : `status ${putRes.status}`}`);
    }
  } else {
    // Update existing
    const putRes = await client.put(`/customers/${customerId}/address`, GOLDEN_ADDRESS);
    log(`Address: ${putRes.status === 204 || putRes.status === 200 ? 'updated' : `status ${putRes.status}`}`);
  }
}

// ---------------------------------------------------------------------------
// Customer properties
// ---------------------------------------------------------------------------

async function populateProperties(customerId: number): Promise<void> {
  const client = await api();

  // Check existing property definitions
  const defsRes = await client.get('/customer-properties');
  const definitions = defsRes.status === 200
    ? (defsRes.data?._embedded?.['customer-properties'] || [])
    : [];

  let testNotesSlug = 'test-notes';
  const existingDef = definitions.find((d: any) => d.slug === testNotesSlug);

  if (!existingDef) {
    log('Creating "Test Notes" property definition...');
    const createRes = await client.post('/customer-properties', {
      name: 'Test Notes',
      type: 'text',
      slug: testNotesSlug,
    });
    if (createRes.status === 201) {
      log('Property definition: created');
    } else {
      log(`Property definition: status ${createRes.status} ${JSON.stringify(createRes.data)}`);
      // If slug auto-generated, try to find it
      if (createRes.status === 409 || createRes.status === 422) {
        log('Property may already exist under a different slug, skipping property value set');
        return;
      }
    }
  } else {
    log(`Property definition "${testNotesSlug}" already exists`);
  }

  // Set property value on customer
  const patchRes = await client.patch(`/customers/${customerId}/properties`, [
    { op: 'replace', path: `/${testNotesSlug}`, value: 'Meridian seed data' },
  ]);
  log(`Property value: ${patchRes.status === 204 || patchRes.status === 200 ? 'set' : `status ${patchRes.status}`}`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  heading('Cleanup: Removing Golden Test Data');

  const customerId = await findCustomerByEmail();
  if (customerId) {
    await deleteCustomer(customerId);
  } else {
    log('No golden customer found');
  }

  const orgId = await findOrganization();
  if (orgId) {
    await deleteOrganization(orgId);
  } else {
    log('No golden organization found');
  }

  // Optionally remove the property definition
  const client = await api();
  const delPropRes = await client.delete('/customer-properties/test-notes');
  if (delPropRes.status === 204 || delPropRes.status === 200) {
    log('Deleted "test-notes" property definition');
  } else if (delPropRes.status === 404) {
    log('No "test-notes" property definition found');
  } else {
    log(`Property definition delete: status ${delPropRes.status}`);
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

  heading('Seeding Golden Test Data for v1.7.0');

  // 1. Organization
  log('--- Organization ---');
  const orgId = await findOrCreateOrganization();

  // 2. Customer
  log('\n--- Customer ---');
  const customerId = await findOrCreateCustomer(orgId);

  // 3. Sub-resources
  log('\n--- Sub-resources ---');
  await populateSubResources(customerId);

  // 4. Properties
  log('\n--- Properties ---');
  await populateProperties(customerId);

  // Summary
  heading('Seed Complete');
  log(`Organization: "${GOLDEN_ORG.name}" (ID: ${orgId})`);
  log(`Customer:     "${GOLDEN_CUSTOMER.firstName} ${GOLDEN_CUSTOMER.lastName}" (ID: ${customerId})`);
  log(`Email:        ${GOLDEN_EMAIL}`);
  log('');
  log('Verify with:');
  log('  npx tsx tests/test-customer-org-live.ts');
  log('');
  log('Clean up with:');
  log('  npx tsx tests/seed-test-data.ts --cleanup');
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  if (e.response?.data) {
    console.error('Response:', JSON.stringify(e.response.data, null, 2));
  }
  process.exit(1);
});
