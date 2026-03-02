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

  // Raw response from org members endpoint
  const res = await axios.get('https://api.helpscout.net/v2/organizations/33911683/customers', {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  console.log('Status:', res.status);
  console.log('Top-level keys:', Object.keys(res.data));
  console.log('_embedded keys:', res.data._embedded ? Object.keys(res.data._embedded) : 'NO _embedded');
  console.log('page:', JSON.stringify(res.data.page));

  // Check if customers are under a different key
  for (const [key, val] of Object.entries(res.data._embedded || {})) {
    console.log(`_embedded.${key}: ${Array.isArray(val) ? `array[${(val as any[]).length}]` : typeof val}`);
    if (Array.isArray(val) && (val as any[]).length > 0) {
      console.log(`  First entry keys: ${Object.keys((val as any[])[0]).join(', ')}`);
      console.log(`  First entry name: ${(val as any[])[0].firstName} ${(val as any[])[0].lastName}`);
    }
  }

  // Also try Kahn Media for comparison
  console.log('\n--- Kahn Media (31981744) for comparison ---');
  const res2 = await axios.get('https://api.helpscout.net/v2/organizations/31981744/customers', {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  console.log('Status:', res2.status);
  console.log('Top-level keys:', Object.keys(res2.data));
  console.log('_embedded keys:', res2.data._embedded ? Object.keys(res2.data._embedded) : 'NO _embedded');
  console.log('page:', JSON.stringify(res2.data.page));
  for (const [key, val] of Object.entries(res2.data._embedded || {})) {
    console.log(`_embedded.${key}: ${Array.isArray(val) ? `array[${(val as any[]).length}]` : typeof val}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
