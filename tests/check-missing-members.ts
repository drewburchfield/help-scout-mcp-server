#!/usr/bin/env npx tsx
import 'dotenv/config';
import axios from 'axios';

const CLIENT_ID = process.env.HELPSCOUT_APP_ID || process.env.HELPSCOUT_CLIENT_ID || process.env.HELPSCOUT_API_KEY || '';
const CLIENT_SECRET = process.env.HELPSCOUT_APP_SECRET || process.env.HELPSCOUT_CLIENT_SECRET || '';

async function main() {
  const auth = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
    grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  });
  const token = auth.data.access_token;
  const headers = { Authorization: `Bearer ${token}` };

  // Check a few of the "missing" customers
  const missingEmails = [
    'aria.chen@meridian-testing.com',
    'priya@meridian-testing.com',
    'kenji@meridian-testing.com',
    'noah.f@meridian-testing.com',
  ];

  for (const email of missingEmails) {
    const res = await axios.get('https://api.helpscout.net/v3/customers', {
      headers, params: { email }, validateStatus: () => true,
    });
    const cust = res.data?._embedded?.customers?.[0];
    if (cust) {
      console.log(`${email}: id=${cust.id}, orgId=${cust.organizationId || 'NONE'}, org=${cust.organization || 'NONE'}`);
    } else {
      console.log(`${email}: NOT FOUND`);
    }
  }

  // Also check the raw org members endpoint directly
  console.log('\nRaw org members API response:');
  const membersRes = await axios.get('https://api.helpscout.net/v2/organizations/33911683/customers', {
    headers, validateStatus: () => true,
  });
  const members = membersRes.data?._embedded?.customers || [];
  console.log(`Total from API: ${membersRes.data?.page?.totalElements}`);
  console.log(`Returned: ${members.length}`);
  console.log('IDs:', members.map((m: any) => `${m.id} (${m.firstName})`).join(', '));
}

main().catch(e => { console.error(e.message); process.exit(1); });
