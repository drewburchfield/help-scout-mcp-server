#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Read-only audit for live Help Scout dogfood fixture readiness.
 *
 * This does not mutate the account. It identifies account-level gaps that the
 * seed scripts cannot create through documented Help Scout API endpoints.
 */

import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';
import { INTEGRATION_CONSTANTS } from './dogfood-fixtures.js';

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

interface AuditResult {
  name: string;
  status: 'PASS' | 'GAP';
  detail: string;
}

let accessToken: string | null = null;

async function authenticate(): Promise<string> {
  if (accessToken) return accessToken;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing Help Scout credentials.');
  }

  try {
    const res = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    accessToken = res.data.access_token;
    return accessToken!;
  } catch (err) {
    throw new Error(`Help Scout authentication failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function api(): Promise<AxiosInstance> {
  try {
    const token = await authenticate();
    return axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
  } catch {
    throw new Error('Unable to create Help Scout API client.');
  }
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function auditTeams(client: AxiosInstance): Promise<AuditResult> {
  try {
    const res = await client.get('/teams', { params: { page: 1 } });
    const teams = res.status === 200 ? (res.data?._embedded?.teams || []) : [];
    if (teams.length > 0) {
      return { name: 'getTeamMembers', status: 'PASS', detail: `teamId=${teams[0].id}` };
    }

    return {
      name: 'getTeamMembers',
      status: 'GAP',
      detail: 'No teams returned by GET /teams; create a Help Scout Team with at least one member in account settings.',
    };
  } catch (err) {
    return { name: 'getTeamMembers', status: 'GAP', detail: `Team audit failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function auditSatisfactionRating(client: AxiosInstance): Promise<AuditResult> {
  try {
    const envId = process.env.MCP_DOGFOOD_SATISFACTION_RATING_ID;
    if (envId) {
      const res = await client.get(`/ratings/${envId}`);
      if (res.status === 200) {
        return { name: 'getSatisfactionRating', status: 'PASS', detail: `ratingId=${envId}` };
      }
    }

    const res = await client.get('/reports/happiness/ratings', {
      params: {
        start: daysAgoIso(30),
        end: daysAgoIso(0),
        mailboxes: INTEGRATION_CONSTANTS.inboxId,
        page: 1,
        sortField: 'modifiedAt',
        sortOrder: 'DESC',
        rating: 'all',
      },
    });
    const ratings = res.status === 200 ? (res.data?._embedded?.results || res.data?.results || []) : [];
    const rating = ratings.find((item: any) => item.id);
    if (rating?.id) {
      return { name: 'getSatisfactionRating', status: 'PASS', detail: `ratingId=${rating.id}` };
    }

    return {
      name: 'getSatisfactionRating',
      status: 'GAP',
      detail: 'No rating row found in the 30-day happiness ratings report; submit a customer satisfaction rating and set MCP_DOGFOOD_SATISFACTION_RATING_ID if needed.',
    };
  } catch (err) {
    return { name: 'getSatisfactionRating', status: 'GAP', detail: `Satisfaction rating audit failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function listSeededConversations(client: AxiosInstance): Promise<Array<{ id: number; subject?: string }>> {
  try {
    const res = await client.get('/conversations', {
      params: {
        query: '(subject:"MCP-TEST:")',
        mailbox: INTEGRATION_CONSTANTS.inboxId,
        status: 'all',
        page: 1,
      },
    });
    return res.status === 200 ? (res.data?._embedded?.conversations || []) : [];
  } catch {
    return [];
  }
}

async function auditOriginalSource(client: AxiosInstance, conversations: Array<{ id: number }>): Promise<AuditResult> {
  try {
    const envConversationId = process.env.MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID;
    const envThreadId = process.env.MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID;
    if (envConversationId && envThreadId) {
      const res = await client.get(`/conversations/${envConversationId}/threads/${envThreadId}/original-source`);
      if (res.status === 200) {
        return { name: 'getOriginalSource', status: 'PASS', detail: `conversationId=${envConversationId} threadId=${envThreadId}` };
      }
    }

    for (const conversation of conversations.slice(0, 25)) {
      const threadsRes = await client.get(`/conversations/${conversation.id}/threads`, { params: { page: 1, size: 25 } });
      const threads = threadsRes.status === 200 ? (threadsRes.data?._embedded?.threads || []) : [];
      for (const thread of threads) {
        if (!thread.id) continue;
        const sourceRes = await client.get(`/conversations/${conversation.id}/threads/${thread.id}/original-source`);
        if (sourceRes.status === 200) {
          return { name: 'getOriginalSource', status: 'PASS', detail: `conversationId=${conversation.id} threadId=${thread.id}` };
        }
      }
    }

    return {
      name: 'getOriginalSource',
      status: 'GAP',
      detail: 'No seeded MCP-TEST thread exposes original email source; create or import an inbound email fixture and set MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID plus MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID.',
    };
  } catch (err) {
    return { name: 'getOriginalSource', status: 'GAP', detail: `Original-source audit failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function auditAttachment(client: AxiosInstance, conversations: Array<{ id: number }>): Promise<AuditResult> {
  try {
    for (const conversation of conversations) {
      const threadsRes = await client.get(`/conversations/${conversation.id}/threads`, { params: { page: 1, size: 25 } });
      const threads = threadsRes.status === 200 ? (threadsRes.data?._embedded?.threads || []) : [];
      for (const thread of threads) {
        const attachments = [
          ...(thread.attachments || []),
          ...(thread._embedded?.attachments || []),
        ];
        const attachment = attachments.find((item: any) => item.id);
        if (!attachment?.id) continue;

        const dataRes = await client.get(`/conversations/${conversation.id}/attachments/${attachment.id}/data`);
        if (dataRes.status === 200) {
          return { name: 'getAttachment', status: 'PASS', detail: `conversationId=${conversation.id} attachmentId=${attachment.id}` };
        }
      }
    }

    return {
      name: 'getAttachment',
      status: 'GAP',
      detail: 'No seeded MCP-TEST attachment with readable data was found; run npm run dogfood:seed and check the attachment fixture conversation.',
    };
  } catch (err) {
    return { name: 'getAttachment', status: 'GAP', detail: `Attachment audit failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    process.stdout.write('SKIP: Missing live Help Scout credentials for dogfood account audit.\n');
    return;
  }

  let results: AuditResult[];
  try {
    const client = await api();
    const conversations = await listSeededConversations(client);
    results = [
      await auditTeams(client),
      await auditSatisfactionRating(client),
      await auditOriginalSource(client, conversations),
      await auditAttachment(client, conversations),
    ];
  } catch {
    process.stderr.write('Fatal dogfood account audit failure.\n');
    process.exit(1);
  }

  for (const result of results) {
    process.stdout.write(`${result.status}: ${result.name} - ${result.detail}\n`);
  }

  const gaps = results.filter((result) => result.status === 'GAP');
  if (gaps.length > 0) {
    process.stdout.write(`\n${gaps.length} dogfood account fixture gap(s) remain.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal dogfood account audit failure: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
