# Dogfood Fixture Matrix

This matrix maps each exposed MCP tool family to the Help Scout test-account
data needed to prove real tool-call behavior. The dogfood account should be
composed intentionally. Empty or missing account data is a fixture gap, not a
reason to weaken API-surface coverage.

Run shared fixture setup before authenticated dogfood:

```bash
npm run dogfood:seed
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
| `tests/seed-test-data.ts` | Golden customer, organization, customer contacts, address, and customer property value. | customer profile, organization profile, contact retrieval, customer property visibility |
| `tests/seed-org-customers.ts` | Fifteen organization members under Meridian Testing Corp. | organization member pagination |
| `tests/seed-integration-data.ts` | Five `MCP-TEST:` conversations in active, pending, and closed states with customer and staff threads plus tags. | conversation search, status filters, tag filters, thread retrieval, workflow-style integration dogfood |

## Capability Coverage

| Surface | Tools | Current fixture coverage | Intent coverage | Fixture gaps |
| --- | --- | --- | --- | --- |
| Inbox discovery | `searchInboxes`, `listAllInboxes` | Uses configured Client Support inbox and live account inbox list. | Discovery, narrowing, invalid limit validation. | None known. |
| Conversation search | `searchConversations`, `advancedConversationSearch`, `comprehensiveConversationSearch`, `structuredConversationFilter` | `MCP-TEST:` conversations cover active, pending, closed, tags, customers, dates, and subjects. | Discovery, narrowing, pagination, permutation, validation. | Add a deterministic spam conversation only if Help Scout supports safe seed/cleanup for spam state. |
| Conversation retrieval | `getConversationSummary`, `getThreads` | Seeded conversations include customer and staff threads. | Retrieval, pagination, redaction, invalid ID validation. | Add a seeded attachment-bearing conversation and known original-source thread. |
| Thread original source and attachments | `getOriginalSource`, `getAttachment` | Harness can use `MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID`, `MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID`, `MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID`, and `MCP_DOGFOOD_ATTACHMENT_ID`. | Retrieval when fixture IDs are provided. | Shared seed command does not yet create or discover these fixtures, so dogfood may skip them. |
| Customer context | `getCustomer`, `listCustomers`, `searchCustomersByEmail`, `getCustomerContacts` | Golden customer and Meridian org members cover profile, email, name, mailbox, modified date, pagination, contacts, and invalid IDs. | Discovery, retrieval, narrowing, pagination, permutation, validation. | Add a customer with multiple values per contact type if future tools expose contact editing or richer contact filtering. |
| Organization context | `getOrganization`, `listOrganizations`, `getOrganizationMembers`, `getOrganizationConversations` | Golden organization, fifteen org members, and seeded conversations cover include flags, sort fields, pagination, members, and conversations. | Retrieval, narrowing, pagination, permutation, validation. | Add organization property-heavy fixtures if property output schemas become stricter. |
| Property metadata | `listCustomerProperties`, `listOrganizationProperties`, `getOrganizationProperty` | Customer property is seeded; organization property is discovered from account data when available. | Discovery and retrieval when account metadata exists. | Shared seed command should create a deterministic organization property if Help Scout API permits it. |
| Tags | `listTags`, `getTag` | Seeded conversations use `mcp-test`; dogfood prefers that tag when present. | Discovery, narrowing, retrieval. | None known if tag creation remains stable through conversation seeding. |
| Users and teams | `listUsers`, `getUser`, `listTeams`, `getTeamMembers` | Live users and teams are discovered; `getUser me` is deterministic for authenticated credentials. | Discovery, retrieval, inbox filter. | Team/member coverage depends on account team setup. Add an account fixture or documented 1Password-backed setup step if API cannot create teams. |
| Inbox metadata | `listInboxCustomFields`, `listInboxFolders`, `listSavedReplies`, `getSavedReply` | Inbox custom fields and folders are discovered from Client Support. Saved replies are discovered if present. | Discovery, retrieval when a saved reply exists. | Seed or configure at least one saved reply in Client Support so `getSavedReply` is non-skipping. |
| Workflows | `listWorkflows` | Discovers live account workflows. | Discovery. | Add a stable workflow fixture or account setup note if workflow APIs cannot create read-only test workflows. |
| Webhooks | `listWebhooks`, `getWebhook` | Discovers live account webhooks if present. | Discovery and retrieval when a webhook exists. | Add a safe test webhook fixture if Help Scout API supports idempotent create/update/delete for webhooks. |
| Satisfaction rating | `getSatisfactionRating` | Uses `MCP_DOGFOOD_SATISFACTION_RATING_ID` when provided. | Retrieval when fixture ID is provided. | Shared seed command does not yet create a known rating. Needed for non-skipping rating retrieval and richer happiness report rows. |
| Company and conversation reports | `getCompanyReport`, `getConversationsReport`, `getHappinessReport`, `getHappinessRatingsReport` | Bounded report calls run against the seeded inbox and current reporting window. | Report shape, date bounds, mailbox filters, rating filter shape. | Need report-rich conversations with known assignment, close, reply, and rating history so dogfood can assert non-empty and cross-filtered rows. |
| Productivity reports | `getProductivityReport`, `getProductivityFirstResponseTimeReport`, `getProductivityRepliesSentReport`, `getProductivityResolutionTimeReport`, `getProductivityResolvedReport`, `getProductivityResponseTimeReport` | Bounded productivity calls run against the seeded inbox with `officeHours=false` and `viewBy=day`. | Report shape, series shape, date bounds, mailbox filter, office-hours flag. | Need seeded conversations with known staff replies, resolution timing, and assignment to assert meaningful non-zero values. |
| User and team reports | `getUserReport`, `getUserConversationHistoryReport`, `getUserCustomersHelpedReport`, `getUserDrilldownReport`, `getUserHappinessReport`, `getUserRatingsReport`, `getUserRepliesReport`, `getUserResolutionsReport`, `getUserChatReport` | Uses discovered authenticated user and seeded inbox over the reporting window. | Report shape, user/team ID serialization, pagination, rows, ratings, office-hours flag, view granularity. | Need report-rich assigned conversations and ratings tied to the discovered user or a configured test user/team. |
| Server utility | `getServerTime` | No Help Scout fixture required. | Utility shape. | None known. |

## Current Skips To Eliminate

| Skip source | Current reason | Preferred fix |
| --- | --- | --- |
| `getOriginalSource` | No known original-source fixture IDs. | Add original-source conversation/thread discovery to seed output or environment setup. |
| `getAttachment` | No known attachment fixture from `getThreads`. | Seed a conversation with an attachment or document the manual fixture and export IDs. |
| `getSatisfactionRating` | No known satisfaction rating fixture ID. | Seed or configure a known rating and expose `MCP_DOGFOOD_SATISFACTION_RATING_ID`. |
| `getSavedReply` | No saved reply may exist in Client Support. | Add a stable saved reply fixture or account setup step. |
| `getWebhook` | No webhook may exist in the test account. | Add a safe webhook fixture with a test URL if API supports it. |
| `getTeamMembers` | No team may exist in the test account. | Configure or seed a team with at least one member. |
| `getOrganizationProperty` | Organization property may be absent. | Seed a deterministic organization property when supported. |

## PR Checklist For New API Surfaces

Before opening a PR that adds or changes MCP API tools:

- Add the tool to MCP and MCPB inventories.
- Add unit coverage for schema validation and query serialization.
- Add dogfood coverage for at least one live MCP call through stdio.
- Extend `npm run dogfood:seed` when existing fixtures cannot exercise the core path.
- Update this matrix with the tool-call intents, fixtures, and remaining skips.
- Keep skips narrow and name the missing fixture explicitly.
- Run `npm run dogfood:seed` before authenticated dogfood when the surface depends on seeded records.
