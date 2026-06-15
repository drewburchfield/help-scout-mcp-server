#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Seed Help Scout Docs API fixtures for live dogfood.
 *
 * The Docs editor/rendering model is not treated as a 1:1 copy of local notes.
 * Fixtures keep a local source note next to explicit Help Scout article HTML so
 * future changes can validate conversion decisions instead of assuming parity.
 *
 * Usage:
 *   node --loader ts-node/esm tests/seed-docs-data.ts
 *   node --loader ts-node/esm tests/seed-docs-data.ts --cleanup
 */

import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';

const API_KEY = process.env.HELPSCOUT_DOCS_API_KEY || '';
const BASE_URL = process.env.HELPSCOUT_DOCS_BASE_URL || 'https://docsapi.helpscout.net/v1/';

const COLLECTION_NAME = 'MCP Dogfood Fixtures';
const CATEGORY_NAME = 'Rendering and Redirect Fixtures';
const CATEGORY_SLUG = 'mcp-dogfood-fixtures';
const MAIN_ARTICLE_NAME = 'MCP-TEST: Docs Rendering Fixture';
const MAIN_ARTICLE_SLUG = 'mcp-test-docs-rendering-fixture';
const RELATED_ARTICLE_NAME = 'MCP-TEST: Related Docs Fixture';
const RELATED_ARTICLE_SLUG = 'mcp-test-related-docs-fixture';
const REDIRECT_PATH = '/mcp-dogfood-old-rendering-fixture';
const REVISION_MARKER_HTML = '<p><strong>Revision marker:</strong> seeded update for article revision dogfood.</p>';

interface DocsEnvelope<T> {
  page?: number;
  pages?: number;
  count?: number;
  items?: T[];
}

interface DocsRecord {
  id?: string;
  name?: string;
  title?: string;
  slug?: string;
  publicUrl?: string;
  collectionId?: string;
  siteId?: string;
  urlMapping?: string;
  redirect?: string;
}

interface FixtureArticle {
  name: string;
  slug: string;
  keywords: string[];
  sourceNote: string;
  articleHtml: string;
}

const RELATED_ARTICLE: FixtureArticle = {
  name: RELATED_ARTICLE_NAME,
  slug: RELATED_ARTICLE_SLUG,
  keywords: ['mcp-test', 'related-fixture', 'docs-dogfood'],
  sourceNote: [
    '# Related fixture',
    '',
    'This local note verifies related article linking and keyword search.',
    '',
    '- Related record discovery',
    '- Cross-article navigation',
  ].join('\n'),
  articleHtml: [
    '<h1>Related fixture</h1>',
    '<p>This article exists so live dogfood can validate related article discovery.</p>',
    '<ul>',
    '<li>Related record discovery</li>',
    '<li>Cross-article navigation</li>',
    '</ul>',
  ].join('\n'),
};

const MAIN_ARTICLE: FixtureArticle = {
  name: MAIN_ARTICLE_NAME,
  slug: MAIN_ARTICLE_SLUG,
  keywords: ['mcp-test', 'rendering-fixture', 'docs-dogfood', 'runbook'],
  sourceNote: [
    '# Rendering fixture',
    '',
    'Purpose: exercise Help Scout Docs retrieval with rich article content.',
    '',
    '## Steps',
    '',
    '1. Confirm the integration key is present.',
    '2. Run the live MCP dogfood matrix.',
    '3. Verify the redirect resolver path.',
    '',
    '```',
    'curl --user API_KEY:X https://docsapi.helpscout.net/v1/sites',
    '```',
    '',
    '| Field | Expected |',
    '| --- | --- |',
    '| status | published |',
  ].join('\n'),
  articleHtml: [
    '<h1>Rendering fixture</h1>',
    '<p>Purpose: exercise Help Scout Docs retrieval with rich article content.</p>',
    '<h2>Steps</h2>',
    '<ol>',
    '<li>Confirm the integration key is present.</li>',
    '<li>Run the live MCP dogfood matrix.</li>',
    '<li>Verify the redirect resolver path.</li>',
    '</ol>',
    '<pre><code>curl --user API_KEY:X https://docsapi.helpscout.net/v1/sites</code></pre>',
    '<table>',
    '<thead><tr><th>Field</th><th>Expected</th></tr></thead>',
    '<tbody><tr><td>status</td><td>published</td></tr></tbody>',
    '</table>',
    '<p><a href="https://developer.helpscout.com/docs-api/">Help Scout Docs API reference</a></p>',
  ].join('\n'),
};

function log(message: string): void {
  process.stderr.write(`  ${message}\n`);
}

function heading(message: string): void {
  process.stderr.write(`\n=== ${message} ===\n\n`);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function docsApi(): AxiosInstance {
  return axios.create({
    baseURL: normalizeBaseUrl(BASE_URL),
    timeout: 30000,
    auth: {
      username: API_KEY,
      password: 'X',
    },
    validateStatus: () => true,
  });
}

function getEnvelope<T>(data: any, key: string): DocsEnvelope<T> {
  if (Array.isArray(data?.items)) return data as DocsEnvelope<T>;
  if (Array.isArray(data?.[key]?.items)) return data[key] as DocsEnvelope<T>;
  return { items: [] };
}

function extractIdFromLocation(location: unknown): string | undefined {
  if (typeof location !== 'string') return undefined;
  const match = location.match(/\/([^/?#]+)(?:[?#].*)?$/);
  return match?.[1];
}

function requireId(record: DocsRecord | undefined, label: string): string {
  if (!record?.id) throw new Error(`Missing ${label} id`);
  return record.id;
}

function targetArticleHtml(fixture: FixtureArticle): string {
  return fixture.name === MAIN_ARTICLE_NAME
    ? [fixture.articleHtml, REVISION_MARKER_HTML].join('\n')
    : fixture.articleHtml;
}

async function listAll<T>(client: AxiosInstance, endpoint: string, key: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let pages = 1;

  do {
    const res = await client.get(endpoint, { params: { ...params, page } });
    if (res.status !== 200) {
      throw new Error(`GET ${endpoint} failed with ${res.status}: ${JSON.stringify(res.data)}`);
    }
    const envelope = getEnvelope<T>(res.data, key);
    items.push(...(envelope.items || []));
    pages = Number(envelope.pages || page);
    page += 1;
  } while (page <= pages);

  return items;
}

async function getFirstSite(client: AxiosInstance): Promise<DocsRecord> {
  const sites = await listAll<DocsRecord>(client, '/sites', 'sites');
  const site = sites[0];
  if (!site?.id) {
    throw new Error('No Docs site found. Create a Docs site in Help Scout before seeding Docs fixtures.');
  }
  log(`Using Docs site "${site.title || site.name || site.id}" (${site.id})`);
  return site;
}

async function createAndReload(client: AxiosInstance, endpoint: string, body: Record<string, unknown>, responseKey: string): Promise<DocsRecord> {
  const res = await client.post(endpoint, body, { params: { reload: true } });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`POST ${endpoint} failed with ${res.status}: ${JSON.stringify(res.data)}`);
  }

  const reloaded = res.data?.[responseKey] || res.data;
  if (reloaded?.id) return reloaded;

  const id = extractIdFromLocation(res.headers.location);
  if (!id) throw new Error(`POST ${endpoint} did not return a resource id`);

  const getRes = await client.get(`${endpoint}/${id}`);
  if (getRes.status !== 200) {
    throw new Error(`GET ${endpoint}/${id} failed with ${getRes.status}: ${JSON.stringify(getRes.data)}`);
  }
  return getRes.data?.[responseKey] || getRes.data;
}

async function findOrCreateCollection(client: AxiosInstance, siteId: string): Promise<DocsRecord> {
  const collections = await listAll<DocsRecord>(client, '/collections', 'collections', { siteId, visibility: 'all' });
  const existing = collections.find((collection) => collection.name === COLLECTION_NAME);
  if (existing?.id) {
    log(`Collection "${COLLECTION_NAME}" already exists (${existing.id})`);
    return existing;
  }

  const collection = await createAndReload(client, '/collections', {
    siteId,
    name: COLLECTION_NAME,
    visibility: 'private',
    order: 999,
    description: 'MCP dogfood fixtures',
  }, 'collection');
  log(`Collection "${COLLECTION_NAME}" created (${collection.id})`);
  return collection;
}

async function findOrCreateCategory(client: AxiosInstance, collectionId: string): Promise<DocsRecord> {
  const categories = await listAll<DocsRecord>(client, `/collections/${collectionId}/categories`, 'categories');
  const existing = categories.find((category) => category.name === CATEGORY_NAME);
  if (existing?.id) {
    log(`Category "${CATEGORY_NAME}" already exists (${existing.id})`);
    return existing;
  }

  const category = await createAndReload(client, '/categories', {
    collectionId,
    name: CATEGORY_NAME,
    slug: CATEGORY_SLUG,
    visibility: 'private',
    order: 999,
    defaultSort: 'name',
  }, 'category');
  log(`Category "${CATEGORY_NAME}" created (${category.id})`);
  return category;
}

async function findArticle(client: AxiosInstance, collectionId: string, name: string): Promise<DocsRecord | undefined> {
  const articles = await listAll<DocsRecord>(client, `/collections/${collectionId}/articles`, 'articles', {
    status: 'all',
    sort: 'order',
    order: 'desc',
    pageSize: 50,
  });
  return articles.find((article) => article.name === name);
}

async function getArticle(client: AxiosInstance, articleId: string): Promise<DocsRecord> {
  const res = await client.get(`/articles/${articleId}`);
  if (res.status !== 200) {
    throw new Error(`GET /articles/${articleId} failed with ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data?.article || res.data;
}

async function upsertArticle(
  client: AxiosInstance,
  collectionId: string,
  categoryId: string,
  fixture: FixtureArticle,
  relatedIds: string[] = []
): Promise<DocsRecord> {
  const existing = await findArticle(client, collectionId, fixture.name);
  const targetText = targetArticleHtml(fixture);
  const body = {
    collectionId,
    status: 'published',
    slug: fixture.slug,
    name: fixture.name,
    text: targetText,
    categories: [categoryId],
    related: relatedIds,
    keywords: fixture.keywords,
  };

  if (existing?.id) {
    const current = await getArticle(client, existing.id);
    if ((current as any).text === targetText) {
      log(`Article "${fixture.name}" already up to date (${existing.id})`);
      return current;
    }

    const res = await client.put(`/articles/${existing.id}`, body, { params: { reload: true } });
    if (res.status !== 200) {
      throw new Error(`PUT /articles/${existing.id} failed with ${res.status}: ${JSON.stringify(res.data)}`);
    }
    log(`Article "${fixture.name}" updated (${existing.id})`);
    return getArticle(client, existing.id);
  }

  const article = await createAndReload(client, '/articles', {
    ...body,
    text: fixture.articleHtml,
  }, 'article');
  log(`Article "${fixture.name}" created (${article.id})`);
  return article;
}

async function ensureRevisionFixture(client: AxiosInstance, article: DocsRecord): Promise<string | undefined> {
  const articleId = requireId(article, MAIN_ARTICLE_NAME);
  let revisions = await listAll<DocsRecord>(client, `/articles/${articleId}/revisions`, 'revisions');
  if (revisions[0]?.id) return revisions[0].id;

  const res = await client.put(`/articles/${articleId}`, {
    status: 'published',
    text: targetArticleHtml(MAIN_ARTICLE),
  });
  if (res.status !== 200) {
    throw new Error(`PUT /articles/${articleId} revision marker failed with ${res.status}: ${JSON.stringify(res.data)}`);
  }

  revisions = await listAll<DocsRecord>(client, `/articles/${articleId}/revisions`, 'revisions');
  return revisions[0]?.id;
}

async function findOrCreateRedirect(client: AxiosInstance, siteId: string, article: DocsRecord): Promise<DocsRecord> {
  const redirects = await listAll<DocsRecord>(client, `/redirects/site/${siteId}`, 'redirects');
  const existing = redirects.find((redirect) => redirect.urlMapping === REDIRECT_PATH);
  if (existing?.id) {
    log(`Redirect "${REDIRECT_PATH}" already exists (${existing.id})`);
    return existing;
  }

  const redirectTarget = article.publicUrl || 'https://developer.helpscout.com/docs-api/';

  const redirect = await createAndReload(client, '/redirects', {
    siteId,
    urlMapping: REDIRECT_PATH,
    redirect: redirectTarget,
  }, 'redirect');
  log(`Redirect "${REDIRECT_PATH}" created (${redirect.id})`);
  return redirect;
}

async function deleteById(client: AxiosInstance, endpoint: string, id: string | undefined, label: string): Promise<void> {
  if (!id) return;
  const res = await client.delete(`${endpoint}/${id}`);
  if (res.status === 200 || res.status === 204) {
    log(`Deleted ${label} (${id})`);
  } else if (res.status === 404) {
    log(`No ${label} found (${id})`);
  } else {
    log(`Delete ${label} (${id}) returned ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

async function cleanup(): Promise<void> {
  heading('Cleanup: Removing Docs Dogfood Fixtures');
  if (!API_KEY) {
    log('HELPSCOUT_DOCS_API_KEY is not set; skipping Docs fixture cleanup.');
    return;
  }

  const client = docsApi();
  const site = await getFirstSite(client);
  const collection = (await listAll<DocsRecord>(client, '/collections', 'collections', {
    siteId: site.id,
    visibility: 'all',
  })).find((item) => item.name === COLLECTION_NAME);

  if (!collection?.id) {
    log(`No collection "${COLLECTION_NAME}" found`);
    return;
  }

  const mainArticle = await findArticle(client, collection.id, MAIN_ARTICLE_NAME);
  const relatedArticle = await findArticle(client, collection.id, RELATED_ARTICLE_NAME);
  const redirects = await listAll<DocsRecord>(client, `/redirects/site/${site.id}`, 'redirects');
  const redirect = redirects.find((item) => item.urlMapping === REDIRECT_PATH);

  await deleteById(client, '/redirects', redirect?.id, 'redirect');
  await deleteById(client, '/articles', mainArticle?.id, 'main article');
  await deleteById(client, '/articles', relatedArticle?.id, 'related article');

  const category = (await listAll<DocsRecord>(client, `/collections/${collection.id}/categories`, 'categories'))
    .find((item) => item.name === CATEGORY_NAME);
  await deleteById(client, '/categories', category?.id, 'category');
  await deleteById(client, '/collections', collection.id, 'collection');
}

async function main(): Promise<void> {
  if (process.argv.includes('--cleanup')) {
    return cleanup();
  }

  heading('Seeding Docs API Dogfood Fixtures');
  if (!API_KEY) {
    log('HELPSCOUT_DOCS_API_KEY is not set; skipping optional Docs fixture seed.');
    return;
  }

  const client = docsApi();
  const site = await getFirstSite(client);
  const siteId = requireId(site, 'Docs site');
  const collection = await findOrCreateCollection(client, siteId);
  const collectionId = requireId(collection, COLLECTION_NAME);
  const category = await findOrCreateCategory(client, collectionId);
  const categoryId = requireId(category, CATEGORY_NAME);
  const related = await upsertArticle(client, collectionId, categoryId, RELATED_ARTICLE);
  const main = await upsertArticle(client, collectionId, categoryId, MAIN_ARTICLE, [requireId(related, RELATED_ARTICLE_NAME)]);
  const revisionId = await ensureRevisionFixture(client, main);
  const redirect = await findOrCreateRedirect(client, siteId, main);

  heading('Docs Seed Complete');
  log(`MCP_DOGFOOD_DOCS_SITE_ID=${siteId}`);
  log(`MCP_DOGFOOD_DOCS_COLLECTION_ID=${collectionId}`);
  log(`MCP_DOGFOOD_DOCS_CATEGORY_ID=${categoryId}`);
  log(`MCP_DOGFOOD_DOCS_ARTICLE_ID=${requireId(main, MAIN_ARTICLE_NAME)}`);
  if (revisionId) log(`MCP_DOGFOOD_DOCS_REVISION_ID=${revisionId}`);
  log(`MCP_DOGFOOD_DOCS_REDIRECT_ID=${requireId(redirect, 'Docs redirect')}`);
  log(`MCP_DOGFOOD_DOCS_REDIRECT_URL=${REDIRECT_PATH}`);
  log('MCP_DOGFOOD_DOCS_SEARCH_QUERY=mcp-test');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
