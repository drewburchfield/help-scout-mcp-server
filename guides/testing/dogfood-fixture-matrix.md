# Dogfood Fixture Matrix

This matrix maps each exposed MCP tool family to the Help Scout test-account
data needed to prove real tool-call behavior. The dogfood account should be
composed intentionally. Empty or missing account data is a fixture gap, not a
reason to weaken API-surface coverage.

Run shared fixture setup before authenticated dogfood:

```bash
npm run dogfood:seed
```

Audit live account-only fixtures that cannot be created by the seed scripts.
When it verifies a fixture, the audit prints the matching `MCP_DOGFOOD_*`
environment value so CI or local dogfood can pin the same record:

```bash
npm run dogfood:audit
```

## Fixture Rules

- Every new API-surface PR must add or reuse deterministic seed data for the
  core path and meaningful parameter permutations it introduces.
- MCP tools must tolerate real account variation, but dogfood should assert rich
  paths with known fixtures whenever the API can create or discover them.
- A dogfood skip is acceptable only when the missing fixture is named in this
  matrix and tracked as follow-up work.
- Seed scripts must stay idempotent and cleanup-capable when they create test
  data.
- Fixture IDs belong in dogfood configuration or discovery steps, never in
  production tool behavior.

## Tool-Call Intent Classes

| Intent | What it proves | Example tools |
| --- | --- | --- |
| Discovery | The account has enough metadata to navigate later calls. | `listAllInboxes`, `listUsers`, `listTags` |
| Narrowing | Filters correctly reduce or target data. | `searchConversations`, `listCustomers`, `listUsers` |
| Retrieval | A discovered or seeded ID fetches the expected object. | `getCustomer`, `getThreads`, `getUser` |
| Pagination | Page, size, cursor, or row controls are honored. | `listOrganizations`, `getUserDrilldownReport` |
| Permutation | Sort, status, type, date, and boolean controls serialize correctly. | `searchConversations`, report tools |
| Redaction | Sensitive message bodies hide when redaction is enabled. | `getConversationSummary`, `getThreads` |
| Validation | Bad arguments fail before a Help Scout request or return a model-correctable error. | invalid ID and limit scenarios |
| Report shape | Bounded report calls return current, previous, row, or series structures. | company, happiness, productivity, user reports |

## Current Shared Seed Data

| Seed entrypoint | Data created or refreshed | Covered surfaces |
| --- | --- | --- |
| `tests/seed-test-data.ts` | Golden customer, organization, customer contacts, address, customer property value, deterministic organization property definition/value, saved reply, and webhook. | customer profile, organization profile, contact retrieval, customer and organization property visibility, saved reply retrieval, webhook retrieval |
| `tests/seed-org-customers.ts` | Fifteen organization members under Meridian Testing Corp. | organization member pagination |
| `tests/seed-integration-data.ts` | `MCP-TEST:` conversations in active, pending, and closed states with customer and staff threads plus tags; report-rich closed fixtures are assigned to the test user; one fixture includes an attachment-bearing thread. | conversation search, status filters, tag filters, thread retrieval, workflow-style integration dogfood, user report row assertions, attachment retrieval |
| `tests/audit-dogfood-account.ts` | Read-only audit of team membership, satisfaction rating, original-source, and attachment fixture readiness. It verifies pinned env IDs, discovers fixture IDs when possible, and scans recent live conversations for original-source coverage when seeded records cannot provide it. | names account-only fixture gaps before dogfood runs and prints env values for verified fixtures |

## Capability Coverage

| Surface | Tools | Current fixture coverage | Intent coverage | Fixture gaps |
| --- | --- | --- | --- | --- |
| Inbox discovery | `searchInboxes`, `listAllInboxes` | Uses configured Client Support inbox and live account inbox list. | Discovery, narrowing, invalid limit validation. | None known. |
| Conversation search | `searchConversations`, `advancedConversationSearch`, `comprehensiveConversationSearch`, `structuredConversationFilter` | `MCP-TEST:` conversations cover active, pending, closed, tags, customers, dates, and subjects. | Discovery, narrowing, pagination, permutation, validation. | Add a deterministic spam conversation only if Help Scout supports safe seed/cleanup for spam state. |
| Conversation retrieval | `getConversationSummary`, `getThreads` | Seeded conversations include customer and staff threads, and one conversation fixture includes an attachment-bearing thread. | Retrieval, pagination, redaction, invalid ID validation, attachment discovery under thread `_embedded.attachments`. | Add a known original-source thread. |
| Thread original source and attachments | `getOriginalSource`, `getAttachment` | Harness can use `MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID`, `MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID`, `MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID`, and `MCP_DOGFOOD_ATTACHMENT_ID`; attachment IDs are discovered from the seeded attachment fixture conversation. Dogfood probes discovered thread IDs for readable original source before skipping. | Retrieval when fixture IDs are provided; attachment retrieval through seeded live fixture discovery; original-source retrieval when a readable source is discovered. | Original source still requires an inbound email-source fixture when no live thread exposes source data. |
| Customer context | `getCustomer`, `listCustomers`, `searchCustomersByEmail`, `getCustomerContacts` | Golden customer and Meridian org members cover profile, email, name, mailbox, modified date, pagination, contacts, and invalid IDs. | Discovery, retrieval, narrowing, pagination, permutation, validation. | Add a customer with multiple values per contact type if future tools expose contact editing or richer contact filtering. |
| Organization context | `getOrganization`, `listOrganizations`, `getOrganizationMembers`, `getOrganizationConversations` | Golden organization, fifteen org members, and seeded conversations cover include flags, sort fields, pagination, members, and conversations. | Retrieval, narrowing, pagination, permutation, validation. | Add organization property-heavy fixtures if property output schemas become stricter. |
| Property metadata | `listCustomerProperties`, `listOrganizationProperties`, `getOrganizationProperty` | Customer property and deterministic organization property are seeded. | Discovery and retrieval. | None known. |
| Tags | `listTags`, `getTag` | Seeded conversations use `mcp-test`; dogfood prefers that tag when present. | Discovery, narrowing, retrieval. | None known if tag creation remains stable through conversation seeding. |
| Users and teams | `listUsers`, `getUser`, `listTeams`, `getTeamMembers` | Live users and teams are discovered; `MCP_DOGFOOD_TEAM_ID` can pin a known team; `getUser me` is deterministic for authenticated credentials. | Discovery, retrieval, inbox filter. | Team/member coverage depends on account team setup. Add an account fixture or documented 1Password-backed setup step if API cannot create teams. |
| Inbox metadata | `listInboxCustomFields`, `listInboxFolders`, `listSavedReplies`, `getSavedReply` | Inbox custom fields and folders are discovered from Client Support. A deterministic saved reply is seeded in Client Support. | Discovery, retrieval. | None known for saved replies. |
| Workflows | `listWorkflows` | Discovers live account workflows. | Discovery. | Add a stable workflow fixture or account setup note if workflow APIs cannot create read-only test workflows. |
| Webhooks | `listWebhooks`, `getWebhook` | A deterministic test webhook is seeded with a non-routable callback URL and Client Support mailbox scope. | Discovery and retrieval. | None known. |
| Satisfaction rating | `getSatisfactionRating` | Uses `MCP_DOGFOOD_SATISFACTION_RATING_ID` when provided. | Retrieval when fixture ID is provided. | Shared seed command does not yet create a known rating. Needed for non-skipping rating retrieval and richer happiness report rows. |
| Company and conversation reports | `getCompanyReport`, `getConversationsReport`, `getHappinessReport`, `getHappinessRatingsReport` | Bounded report calls run against the seeded inbox and current reporting window; conversation report asserts seeded conversation activity. | Report shape, date bounds, mailbox filters, rating filter shape, non-empty conversation activity. | Need satisfaction-rating fixture data before happiness rating rows can be asserted non-empty. |
| Productivity reports | `getProductivityReport`, `getProductivityFirstResponseTimeReport`, `getProductivityRepliesSentReport`, `getProductivityResolutionTimeReport`, `getProductivityResolvedReport`, `getProductivityResponseTimeReport` | Bounded productivity calls run against report-rich seeded conversations with `officeHours=false` and `viewBy=day`; overall productivity asserts seeded closed/new activity. | Report shape, series shape, date bounds, mailbox filter, office-hours flag, non-empty activity. | Need non-imported or API-supported reply/rating activity before reply and response-time counters can be asserted non-zero. |
| User and team reports | `getUserReport`, `getUserConversationHistoryReport`, `getUserCustomersHelpedReport`, `getUserDrilldownReport`, `getUserHappinessReport`, `getUserRatingsReport`, `getUserRepliesReport`, `getUserResolutionsReport`, `getUserChatReport` | Uses discovered authenticated user and report-rich seeded inbox data over the reporting window; history and drilldown assert non-empty seeded rows. | Report shape, user/team ID serialization, pagination, rows, ratings, office-hours flag, view granularity, non-empty assigned rows. | Need satisfaction-rating fixture data before user happiness rating rows can be asserted non-empty. |
| Docs API | `listDocsSites`, `getDocsSite`, `listDocsCollections`, `getDocsCollection`, `listDocsCategories`, `getDocsCategory`, `listDocsArticles`, `searchDocsArticles`, `getDocsArticle`, `listDocsRelatedArticles`, `listDocsArticleRevisions`, `getDocsArticleRevision`, `listDocsRedirects`, `getDocsRedirect`, `findDocsRedirect` | Uses `HELPSCOUT_DOCS_API_KEY` and discovers live Docs sites, collections, categories, articles, revisions, and redirects. Optional IDs can be pinned with `MCP_DOGFOOD_DOCS_SITE_ID`, `MCP_DOGFOOD_DOCS_COLLECTION_ID`, `MCP_DOGFOOD_DOCS_CATEGORY_ID`, `MCP_DOGFOOD_DOCS_ARTICLE_ID`, `MCP_DOGFOOD_DOCS_REVISION_ID`, `MCP_DOGFOOD_DOCS_REDIRECT_ID`, and `MCP_DOGFOOD_DOCS_REDIRECT_URL`. | Discovery, retrieval, search, pagination, status/visibility filters, revision freshness checks, redirect resolution. | Shared seed command does not create Docs knowledge base data. Configure a Docs API key plus at least one site, collection, category, article, revision, and redirect for non-skipping live coverage. |
| Server utility | `getServerTime` | No Help Scout fixture required. | Utility shape. | None known. |

## Current Skips To Eliminate

| Skip source | Current reason | Preferred fix |
| --- | --- | --- |
| `getOriginalSource` | No known original-source fixture IDs. | Send or import an inbound email fixture, then use `npm run dogfood:audit` output to set `MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID` and `MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID`. |
| `getSatisfactionRating` | No known satisfaction rating fixture ID. | Submit a known rating, then use `npm run dogfood:audit` output to set `MCP_DOGFOOD_SATISFACTION_RATING_ID`. |
| `getTeamMembers` | No team may exist in the test account. | Configure a team with at least one member, then use `npm run dogfood:audit` output to set `MCP_DOGFOOD_TEAM_ID` if discovery should be pinned. |
| Docs API tools | Docs API requires separate `HELPSCOUT_DOCS_API_KEY`, and the shared seed command cannot create Docs knowledge base fixtures. | Configure a Docs API key and stable Docs records, then set the `MCP_DOGFOOD_DOCS_*` environment IDs when auto-discovery is insufficient. |

## PR Checklist For New API Surfaces

Before opening a PR that adds or changes MCP API tools:

- Add the tool to MCP and MCPB inventories.
- Add unit coverage for schema validation and query serialization.
- Add dogfood coverage for at least one live MCP call through stdio.
- Extend `npm run dogfood:seed` when existing fixtures cannot exercise the core path.
- Update this matrix with the tool-call intents, fixtures, and remaining skips.
- Keep skips narrow and name the missing fixture explicitly.
- Run `npm run dogfood:seed` before authenticated dogfood when the surface depends on seeded records.
