# Dogfood Fixture Matrix

This matrix maps each exposed MCP tool family to the Help Scout test-account
data needed to prove real tool-call behavior. The dogfood account should be
composed intentionally. Empty or missing account data is a fixture gap, not a
reason to weaken API-surface coverage.

Run shared fixture setup before authenticated dogfood:

```bash
npm run dogfood:seed
```

Docs API fixtures can also be loaded directly when iterating on knowledge-base
coverage:

```bash
HELPSCOUT_DOCS_API_KEY=... npm run dogfood:seed:docs
```

The Docs seeder is optional only when `HELPSCOUT_DOCS_API_KEY` is missing. If a
Docs key is supplied, seed failures are fatal so stale or partial Docs fixtures do
not masquerade as complete dogfood coverage.

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

## Documented Seedability

The public Help Scout Inbox API can seed customers, organizations,
conversations, saved replies, webhooks, organization properties, and Docs API
records used by this suite. The remaining live skips are different: they depend
on account or product state that the documented API does not create.

| Fixture | Seedability | Evidence | Stable env |
| --- | --- | --- | --- |
| Team membership | Help Scout account setup. The public API exposes `GET /v2/teams` and `GET /v2/teams/{teamId}/members`, but no team creation or membership mutation endpoint. | [List Teams](https://developer.helpscout.com/mailbox-api/endpoints/teams/list-teams/), [List Team Members](https://developer.helpscout.com/mailbox-api/endpoints/teams/list-team-members/) | `MCP_DOGFOOD_TEAM_ID` |
| Satisfaction rating | Help Scout satisfaction flow. The public API exposes rating retrieval and happiness reports, but no rating creation endpoint. | [Get Satisfaction Rating](https://developer.helpscout.com/mailbox-api/endpoints/ratings/get/), [Happiness Ratings Report](https://developer.helpscout.com/mailbox-api/endpoints/reports/happiness/reports-happiness-ratings/) | `MCP_DOGFOOD_SATISFACTION_RATING_ID` |
| Original email source | Real inbound email-source fixture in the test account. The API can create/import conversations and replies, but original source endpoints are read-only retrieval endpoints; API-created historical fixtures are not enough unless Help Scout stores source for that thread. | [Create Conversation](https://developer.helpscout.com/mailbox-api/endpoints/conversations/create/), [Get Thread Original Source](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/thread-source-json/), [Get Thread Original Source RFC 822](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/thread-source-rfc822/) | `MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID`, `MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID` |
| Attachment data and file download | API-seeded through `tests/seed-integration-data.ts`. | [Create Conversation](https://developer.helpscout.com/mailbox-api/endpoints/conversations/create/), [Download Attachment File](https://developer.helpscout.com/mailbox-api/endpoints/conversations/attachments/get-attachment-file/) | `MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID`, `MCP_DOGFOOD_ATTACHMENT_ID` |

After account-only fixtures exist, run `npm run dogfood:audit` and store the
printed `MCP_DOGFOOD_*` values in dogfood env or 1Password. Do not commit those
IDs into production tool code.

## Tool-Call Intent Classes

| Intent | What it proves | Example tools |
| --- | --- | --- |
| Discovery | The account has enough metadata to navigate later calls. | `listAllInboxes`, `listUsers`, `listTags` |
| Narrowing | Filters correctly reduce or target data. | `searchConversations`, `listCustomers`, `listUsers` |
| Retrieval | A discovered or seeded ID fetches the expected object. | `getCustomer`, `getThreads`, `getUser` |
| Pagination | Page, size, cursor, or row controls are honored. | `listOrganizations`, `getUserDrilldownReport` |
| Permutation | Sort, status, type, date, and boolean controls serialize correctly. | `searchConversations`, report tools |
| Redaction | Sensitive message bodies hide when redaction is enabled. | `getConversationSummary`, `getThreads`, `getThreadsV3` |
| Validation | Bad arguments fail before a Help Scout request or return a model-correctable error. | invalid ID and limit scenarios |
| Report shape | Bounded report calls return current, previous, row, or series structures. | company, happiness, productivity, user reports |

## Current Shared Seed Data

| Seed entrypoint | Data created or refreshed | Covered surfaces |
| --- | --- | --- |
| `tests/seed-test-data.ts` | Golden customer, organization, customer contacts, address, customer property value, deterministic organization property definition/value, saved reply, and webhook. | customer profile, organization profile, contact retrieval, customer and organization property visibility, saved reply retrieval, webhook retrieval |
| `tests/seed-org-customers.ts` | Fifteen organization members under Meridian Testing Corp. | organization member pagination |
| `tests/seed-integration-data.ts` | `MCP-TEST:` conversations in active, pending, and closed states with customer and staff threads plus tags; report-rich closed fixtures are assigned to the test user; one fixture includes an attachment-bearing thread. | conversation search, status filters, tag filters, thread retrieval, workflow-style integration dogfood, user report row assertions, attachment data and file retrieval |
| `tests/seed-docs-data.ts` | Optional Docs API knowledge-base fixtures. Uses a configured Docs site, then creates or updates a private collection, category, rich HTML articles derived from local source notes, a related article relationship, a revision, and a redirect. | Docs API list/get/search, site restrictions, related articles, article revision detail, redirect detail, and redirect resolution |
| `tests/audit-dogfood-account.ts` | Read-only audit of team membership, satisfaction rating, original-source, and attachment fixture readiness. It verifies pinned env IDs, discovers fixture IDs when possible, scans recent live conversations for original-source coverage when seeded records cannot provide it, and confirms attachments are readable through both data and file endpoints. | names account-only fixture gaps before dogfood runs and prints env values for verified fixtures |

## Capability Coverage

| Surface | Tools | Current fixture coverage | Intent coverage | Fixture gaps |
| --- | --- | --- | --- | --- |
| Inbox discovery | `searchInboxes`, `listAllInboxes`, `getInbox` | Uses configured Client Support inbox and live account inbox list. | Discovery, narrowing, retrieval, invalid limit validation. | None known. |
| Conversation search | `searchConversations`, `advancedConversationSearch`, `comprehensiveConversationSearch`, `structuredConversationFilter` | `MCP-TEST:` conversations cover active, pending, closed, tags, customers, dates, and subjects. | Discovery, narrowing, pagination, permutation, validation. | Add a deterministic spam conversation only if Help Scout supports safe seed/cleanup for spam state. |
| Conversation retrieval | `getConversation`, `getConversationV3`, `getConversationSummary`, `getThreads`, `getThreadsV3` | Seeded conversations include raw conversation metadata, optional embedded threads, customer and staff threads, v3 conversation/thread retrieval, one conversation fixture includes an attachment-bearing thread, and a live inbound email-source fixture covers original-source discovery. | Retrieval, pagination, permutation, redaction, invalid ID validation, attachment discovery under thread `_embedded.attachments`. | None known. |
| Thread original source and attachments | `getOriginalSource`, `getOriginalSourceRfc822`, `getAttachment`, `downloadAttachmentFile` | Harness can use `MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID`, `MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID`, `MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID`, and `MCP_DOGFOOD_ATTACHMENT_ID`; attachment IDs are discovered from the seeded attachment fixture conversation and verified through data plus file endpoints. A real inbound email-source fixture now exists in the test account and is discoverable through audit/dogfood. | Retrieval when fixture IDs are provided; attachment data/file retrieval through seeded live fixture discovery; original-source JSON and RFC 822 retrieval when a readable source is discovered. | None known while the inbound email-source fixture remains available; pin the discovered conversation/thread IDs outside the repo when dogfood should avoid rediscovery. |
| Customer context | `getCustomer`, `listCustomers`, `searchCustomersByEmail`, `getCustomerContacts`, `getCustomerAddress`, `listCustomerEmails`, `listCustomerPhones`, `listCustomerChats`, `listCustomerSocialProfiles`, `listCustomerWebsites` | Golden customer and Meridian org members cover profile, email, name, mailbox, modified date, pagination, aggregate contacts, and each direct contact sub-resource. | Discovery, retrieval, narrowing, pagination, permutation, validation. | Add a customer with multiple values per contact type if future tools expose contact editing or richer contact filtering. |
| Organization context | `getOrganization`, `listOrganizations`, `getOrganizationMembers`, `getOrganizationConversations` | Golden organization, fifteen org members, and seeded conversations cover include flags, sort fields, pagination, members, and conversations. | Retrieval, narrowing, pagination, permutation, validation. | Add organization property-heavy fixtures if property output schemas become stricter. |
| Property metadata | `listCustomerProperties`, `listOrganizationProperties`, `getOrganizationProperty` | Customer property and deterministic organization property are seeded. | Discovery and retrieval. | None known. |
| Tags | `listTags`, `getTag` | Seeded conversations use `mcp-test`; dogfood prefers that tag when present. | Discovery, narrowing, retrieval. | None known if tag creation remains stable through conversation seeding. |
| Users and teams | `listUsers`, `getUser`, `listSystemUsers`, `getSystemUser`, `listUserStatuses`, `getUserStatus`, `listTeams`, `getTeamMembers` | Live users, system users, user statuses, and teams are discovered; `MCP_DOGFOOD_TEAM_ID` can pin a known team; `getUser me` is deterministic for authenticated credentials and supplies the numeric ID used by `getUserStatus`. | Discovery, retrieval, pagination, inbox filter. | Team/member coverage depends on Help Scout account setup; public API discovery is read-only for teams. |
| Inbox metadata | `listInboxCustomFields`, `listInboxFolders`, `getInboxRouting`, `listSavedReplies`, `getSavedReply` | Inbox custom fields, folders, and routing configuration are discovered from Client Support. A deterministic saved reply is seeded in Client Support. | Discovery, retrieval. | None known for saved replies or routing in the current dogfood account. |
| Workflows | `listWorkflows` | Discovers live account workflows. | Discovery. | Add a stable workflow fixture or account setup note if workflow APIs cannot create read-only test workflows. |
| Webhooks | `listWebhooks`, `getWebhook` | A deterministic test webhook is seeded with a non-routable callback URL and Client Support mailbox scope. | Discovery and retrieval. | None known. |
| Satisfaction rating | `getSatisfactionRating` | Uses `MCP_DOGFOOD_SATISFACTION_RATING_ID` when provided; audit can discover a rating from the 30-day happiness ratings report. | Retrieval when fixture ID is provided. | Requires a real customer satisfaction response; public API exposes read/report endpoints, not rating creation. Needed for non-skipping rating retrieval and richer happiness report rows. |
| Company and conversation reports | `getCompanyReport`, `getCompanyCustomersHelpedReport`, `getCompanyDrilldownReport`, `getConversationsReport`, `getConversationVolumeByChannelReport`, `getConversationBusyTimesReport`, `getConversationDrilldownReport`, `getConversationFieldDrilldownReport`, `getConversationNewReport`, `getConversationNewDrilldownReport`, `getConversationReceivedMessagesReport`, `getHappinessReport`, `getHappinessRatingsReport` | Bounded report calls run against the seeded inbox and current reporting window; field drilldown uses the discovered test tag when available. | Report shape, date bounds, mailbox filters, rating filter shape, pagination, field drilldown parameters, non-empty conversation activity. | Need satisfaction-rating fixture data before happiness rating rows can be asserted non-empty. |
| Productivity reports | `getProductivityReport`, `getProductivityFirstResponseTimeReport`, `getProductivityRepliesSentReport`, `getProductivityResolutionTimeReport`, `getProductivityResolvedReport`, `getProductivityResponseTimeReport` | Bounded productivity calls run against report-rich seeded conversations with `officeHours=false` and `viewBy=day`; overall productivity asserts seeded closed/new activity. | Report shape, series shape, date bounds, mailbox filter, office-hours flag, non-empty activity. | Need non-imported or API-supported reply/rating activity before reply and response-time counters can be asserted non-zero. |
| User and team reports | `getUserReport`, `getUserConversationHistoryReport`, `getUserCustomersHelpedReport`, `getUserDrilldownReport`, `getUserHappinessReport`, `getUserRatingsReport`, `getUserRepliesReport`, `getUserResolutionsReport`, `getUserChatReport` | Uses discovered authenticated user and report-rich seeded inbox data over the reporting window; history and drilldown assert non-empty seeded rows. | Report shape, user/team ID serialization, pagination, rows, ratings, office-hours flag, view granularity, non-empty assigned rows. | Need satisfaction-rating fixture data before user happiness rating rows can be asserted non-empty. |
| Docs and channel reports | `getDocsReport`, `getChatReport`, `getEmailReport`, `getPhoneReport` | Bounded account-level report calls run against the reporting window; Docs report can optionally use `MCP_DOGFOOD_DOCS_SITE_ID`. | Report shape, date bounds, mailbox/site filters, office-hours flag. | Need Docs, Beacon chat, email, and phone activity in the test account before non-empty channel metrics can be asserted. |
| Docs API | `listDocsSites`, `getDocsSite`, `getDocsSiteRestrictions`, `listDocsCollections`, `getDocsCollection`, `listDocsCategories`, `getDocsCategory`, `listDocsArticles`, `searchDocsArticles`, `getDocsArticle`, `listDocsRelatedArticles`, `listDocsArticleRevisions`, `getDocsArticleRevision`, `listDocsRedirects`, `getDocsRedirect`, `findDocsRedirect` | Uses `HELPSCOUT_DOCS_API_KEY` and `tests/seed-docs-data.ts` to create private Docs records from explicit source-note-to-article-HTML fixtures and read configured site restrictions. Optional IDs can be pinned with `MCP_DOGFOOD_DOCS_SITE_ID`, `MCP_DOGFOOD_DOCS_COLLECTION_ID`, `MCP_DOGFOOD_DOCS_CATEGORY_ID`, `MCP_DOGFOOD_DOCS_ARTICLE_ID`, `MCP_DOGFOOD_DOCS_REVISION_ID`, `MCP_DOGFOOD_DOCS_REDIRECT_ID`, and `MCP_DOGFOOD_DOCS_REDIRECT_URL`. | Discovery, retrieval, search, pagination, status/visibility filters, site restriction read with secret redaction, related articles, revision freshness checks, redirect resolution. | Requires a Docs API key with permission to read/create/edit Docs content and at least one existing Docs site. Local Markdown/notes are not assumed to render 1:1; fixtures keep Help Scout article HTML explicit. |
| Server utility | `getServerTime` | No Help Scout fixture required. | Utility shape. | None known. |

## Current Skips To Eliminate

| Skip source | Current reason | Preferred fix |
| --- | --- | --- |
| `getSatisfactionRating` | No known satisfaction rating fixture ID. | Submit a known rating through the Help Scout satisfaction flow, then use `npm run dogfood:audit` output to set `MCP_DOGFOOD_SATISFACTION_RATING_ID`. |
| `getTeamMembers` | No team may exist in the test account. | Configure a team with at least one member in Help Scout account settings, then use `npm run dogfood:audit` output to set `MCP_DOGFOOD_TEAM_ID` if discovery should be pinned. |
| Docs API tools | Docs API requires separate `HELPSCOUT_DOCS_API_KEY`; seeding requires a key with Docs create/edit permissions and an existing Docs site. | Run `HELPSCOUT_DOCS_API_KEY=... npm run dogfood:seed:docs`, then use the printed `MCP_DOGFOOD_DOCS_*` values when auto-discovery should be pinned. |

## PR Checklist For New API Surfaces

Before opening a PR that adds or changes MCP API tools:

- Add the tool to MCP and MCPB inventories.
- Add unit coverage for schema validation and query serialization.
- Add dogfood coverage for at least one live MCP call through stdio.
- Extend `npm run dogfood:seed` when existing fixtures cannot exercise the core path.
- Update this matrix with the tool-call intents, fixtures, and remaining skips.
- Keep skips narrow and name the missing fixture explicitly.
- Run `npm run dogfood:seed` before authenticated dogfood when the surface depends on seeded records.
