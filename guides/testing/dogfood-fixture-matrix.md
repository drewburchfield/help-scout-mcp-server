# Dogfood Fixture Matrix

This matrix maps each registry operation family to the Help Scout test-account
data needed to prove real call behavior. The dogfood account should be composed
intentionally. Empty or missing account data is a fixture gap, not a reason to
weaken API-surface coverage.

The server advertises three gateway tools (`search_help_scout`,
`describe_help_scout`, `read_help_scout`) over 55 read-only operations, plus
`write_help_scout` when an operator has enabled writes. This matrix tracks the
55 read operations and the gated write operations. Dogfood drives them through
the gateway, so a run also exercises discovery and dispatch.

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
- Operations must tolerate real account variation, but dogfood should assert rich
  paths with known fixtures whenever the API can create or discover them.
- A dogfood skip is acceptable only when the missing fixture is named in this
  matrix and tracked as follow-up work.
- Seed scripts must stay idempotent and cleanup-capable when they create test
  data.
- Fixture IDs belong in dogfood configuration or discovery steps, never in
  production operation behavior.

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

## Operation-Call Intent Classes

| Intent | What it proves | Example operations |
| --- | --- | --- |
| Discovery | The account has enough metadata to navigate later calls. | `listAllInboxes`, `listUsers`, `listTags` |
| Narrowing | Filters correctly reduce or target data. | `searchConversations`, `listCustomers`, `listAllInboxes` with `nameContains` |
| Retrieval | A discovered or seeded ID fetches the expected object. | `getCustomer`, `getThreads`, `getUser` |
| Pagination | Page, size, row, or cursor controls are honored. Page-number is the norm; cursor applies to the v3 customer path. | `listOrganizations`, `listCustomers` (page and `useV3` cursor), `getUserReport` with `report: "drilldown"` |
| Permutation | Sort, status, type, date, and boolean controls serialize correctly. | `searchConversations`, report operations |
| Fan-out flags | `include`-style parameters attach sub-resources and report per-sub-resource failures without failing the call. | `getInbox` with `include`, `getUser` with `includeStatus`, `getDocsSite` with `includeRestrictions` |
| Version routing | Flags route to the v3 endpoint and preserve richer person types. | `getConversation`, `getThreads`, `listUsers`, `getUser` with `includeSystemActors` |
| Redaction | Message bodies hide when `REDACT_MESSAGE_CONTENT` is enabled. This is a context-saver, not a compliance boundary. | `getConversationSummary`, `getThreads` |
| Validation | Bad arguments fail before a Help Scout request or return a model-correctable error. | invalid ID and limit scenarios |
| Report shape | Bounded report calls return current, previous, row, or series structures. | `getCompanyReport`, `getHappinessReport`, `getProductivityReport`, `getUserReport` |
| Gateway | Discovery finds the right operation, schemas load, and dispatch reaches it. | `search_help_scout`, `describe_help_scout`, `read_help_scout` |

## Current Shared Seed Data

| Seed entrypoint | Data created or refreshed | Covered surfaces |
| --- | --- | --- |
| `tests/seed-test-data.ts` | Golden customer, organization, customer contacts, address, customer property value, deterministic organization property definition/value, saved reply, and webhook. | customer profile, organization profile, contact retrieval, customer and organization property visibility, saved reply retrieval, webhook retrieval |
| `tests/seed-org-customers.ts` | Fifteen organization members under Meridian Testing Corp. | organization member pagination |
| `tests/seed-integration-data.ts` | `MCP-TEST:` conversations in active, pending, and closed states with customer and staff threads plus tags; report-rich closed fixtures are assigned to the test user; one fixture includes an attachment-bearing thread. | conversation search, status filters, tag filters, thread retrieval, workflow-style integration dogfood, user report row assertions, attachment data and file retrieval |
| `tests/seed-docs-data.ts` | Optional Docs API knowledge-base fixtures. Uses a configured Docs site, then creates or updates a private collection, category, rich HTML articles derived from local source notes, a related article relationship, a revision, and a redirect. | Docs API list/get/search, site restrictions, related articles, article revision detail, redirect detail, and redirect resolution |
| `tests/audit-dogfood-account.ts` | Read-only audit of team membership, satisfaction rating, original-source, and attachment fixture readiness. It verifies pinned env IDs, discovers fixture IDs when possible, scans recent live conversations for original-source coverage when seeded records cannot provide it, and confirms attachments are readable through both data and file endpoints. | names account-only fixture gaps before dogfood runs and prints env values for verified fixtures |

## Capability Coverage

Fifty-five operations, grouped by surface.

| Surface | Operations | Current fixture coverage | Intent coverage | Fixture gaps |
| --- | --- | --- | --- | --- |
| Gateway | `search_help_scout`, `describe_help_scout`, `read_help_scout` | No Help Scout fixture required. The registry is built from the operation definitions at startup. | Gateway: intent queries return relevant operation names, schemas load for named operations, dispatch reaches the operation, unknown names return a model-correctable error. | None known. |
| Inbox discovery and metadata | `listAllInboxes`, `getInbox` | Uses configured Client Support inbox and live account inbox list. Custom fields, folders, and routing are discovered from Client Support through `getInbox` `include`. | Discovery, narrowing via `nameContains`, retrieval, fan-out flags, invalid limit validation. | None known. |
| Saved replies | `listSavedReplies`, `getSavedReply` | A deterministic saved reply is seeded in Client Support. | Discovery, retrieval. | None known in the current dogfood account. |
| Conversation search | `searchConversations` | `MCP-TEST:` conversations cover active, pending, closed, tags, customers, dates, and subjects. | Discovery, narrowing, pagination, permutation, validation. Covers the convenience filters folded in from the removed advanced, comprehensive, and structured search names. | Add a deterministic spam conversation only if Help Scout supports safe seed/cleanup for spam state. |
| Conversation retrieval | `getConversation`, `getConversationSummary`, `getThreads` | Seeded conversations include raw conversation metadata, optional embedded threads, customer and staff threads, and one attachment-bearing thread fixture. | Retrieval, pagination, permutation, redaction, version routing through `includeSystemActors`, invalid ID validation, attachment discovery under thread `_embedded.attachments`. | None known. |
| Thread original source and attachments | `getOriginalSource`, `getAttachment`, `downloadAttachmentFile` | Harness can use `MCP_DOGFOOD_ORIGINAL_SOURCE_CONVERSATION_ID`, `MCP_DOGFOOD_ORIGINAL_SOURCE_THREAD_ID`, `MCP_DOGFOOD_ATTACHMENT_CONVERSATION_ID`, and `MCP_DOGFOOD_ATTACHMENT_ID`; attachment IDs are discovered from the seeded attachment fixture conversation and verified through data plus file endpoints. A real inbound email-source fixture exists in the test account and is discoverable through audit/dogfood. | Retrieval when fixture IDs are provided; attachment data/file retrieval through seeded live fixture discovery; both `format: "json"` and `format: "rfc822"` original-source retrieval when a readable source is discovered. | None known while the inbound email-source fixture remains available; pin the discovered conversation/thread IDs outside the repo when dogfood should avoid rediscovery. |
| Customer context | `getCustomer`, `listCustomers`, `searchCustomersByEmail`, `getCustomerContacts` | Golden customer and Meridian org members cover profile, email, name, mailbox, modified date, v2 page pagination, v3 cursor pagination through `listCustomers` `useV3`/`cursor` when available, and aggregate contacts covering emails, phones, chat handles, social profiles, websites, and address. | Discovery, retrieval, narrowing, pagination (page-number and v3 cursor), permutation, validation. | Add a customer with multiple values per contact type if future operations expose contact editing or richer contact filtering. |
| Organization context | `getOrganization`, `listOrganizations`, `getOrganizationMembers`, `getOrganizationConversations` | Golden organization, fifteen org members, and seeded conversations cover include flags, sort fields, pagination, members, and conversations. | Retrieval, narrowing, pagination, permutation, validation. | Add organization property-heavy fixtures if property output schemas become stricter. |
| Property metadata | `listCustomerProperties`, `listOrganizationProperties`, `getOrganizationProperty` | Customer property and deterministic organization property are seeded. | Discovery and retrieval. | None known. |
| Tags | `listTags`, `getTag` | Seeded conversations use `mcp-test`; dogfood prefers that tag when present. | Discovery, narrowing, retrieval. | None known if tag creation remains stable through conversation seeding. |
| Users and teams | `listUsers`, `getUser`, `listTeams`, `getTeamMembers` | Live users and teams are discovered; `MCP_DOGFOOD_TEAM_ID` can pin a known team; `getUser me` is deterministic for authenticated credentials. Availability statuses come from `listUsers` `includeStatuses` and `getUser` `includeStatus`; v3 system actors come from `includeSystemActors`. | Discovery, retrieval, pagination, inbox filter, fan-out flags, version routing. | Team/member coverage depends on Help Scout account setup; public API discovery is read-only for teams. |
| Workflows | `listWorkflows` | Discovers live account workflows. | Discovery. | Add a stable workflow fixture or account setup note if workflow APIs cannot create read-only test workflows. |
| Webhooks | `listWebhooks`, `getWebhook` | A deterministic test webhook is seeded with a non-routable callback URL and Client Support mailbox scope. | Discovery and retrieval. | None known. |
| Satisfaction rating | `getSatisfactionRating` | Uses `MCP_DOGFOOD_SATISFACTION_RATING_ID` when provided; audit can discover a rating from the 30-day happiness ratings report. | Retrieval when fixture ID is provided. | Requires a real customer satisfaction response; public API exposes read/report endpoints, not rating creation. Needed for non-skipping rating retrieval and richer happiness report rows. |
| Company reports | `getCompanyReport` (`report`: overall, customers-helped, drilldown) | Bounded report calls run against the seeded inbox and current reporting window. | Report shape, date bounds, mailbox filters, drilldown pagination and range parameters. | None known beyond general account activity volume. |
| Conversation reports | `getConversationsReport` (`report`: overall, volume-by-channel, busy-times, drilldown, fields-drilldown, new, new-drilldown, received-messages) | Bounded report calls run against seeded conversation activity; fields-drilldown uses the discovered test tag when available. | Report shape, date bounds, mailbox filters, view granularity, drilldown and field-drilldown parameters, non-empty conversation activity. | None known. |
| Productivity reports | `getProductivityReport` (`report`: overall, first-response-time, replies-sent, resolved, response-time, resolution-time) | Bounded productivity calls run against report-rich seeded conversations with `officeHours=false` and `viewBy=day`; overall productivity asserts seeded closed/new activity. | Report shape, series shape, date bounds, mailbox filter, office-hours flag, non-empty activity. | Need non-imported or API-supported reply/rating activity before reply and response-time counters can be asserted non-zero. |
| User and team reports | `getUserReport` (`report`: overall, conversation-history, customers-helped, drilldown, happiness, ratings, replies, resolutions, chat) | Uses discovered authenticated user and report-rich seeded inbox data over the reporting window; history and drilldown assert non-empty seeded rows. | Report shape, user/team ID serialization, pagination, rows, ratings, office-hours flag, view granularity, non-empty assigned rows. | Need satisfaction-rating fixture data before user happiness rating rows can be asserted non-empty. |
| Happiness reports | `getHappinessReport` (`report`: overall, ratings) | Bounded happiness calls run against the current reporting window; ratings supports sort and rating filters. | Report shape, date bounds, rating filter shape, pagination. | Need satisfaction-rating fixture data before happiness rating rows can be asserted non-empty. |
| Channel reports | `getChannelReport` (`channel`: chat, email, phone) | Bounded account-level report calls run against the reporting window. | Report shape, date bounds, mailbox filters, office-hours flag. | Need Beacon chat, email, and phone activity in the test account before non-empty channel metrics can be asserted. |
| Docs reports | `getDocsReport` | Bounded account-level report calls; can optionally use `MCP_DOGFOOD_DOCS_SITE_ID` through the `sites` filter. | Report shape, date bounds, site filter. | Need Docs traffic in the test account before non-empty Docs metrics can be asserted. |
| Docs API | `listDocsSites`, `getDocsSite`, `listDocsCollections`, `getDocsCollection`, `listDocsCategories`, `getDocsCategory`, `listDocsArticles`, `searchDocsArticles`, `getDocsArticle`, `listDocsRelatedArticles`, `listDocsArticleRevisions`, `getDocsArticleRevision`, `listDocsRedirects`, `getDocsRedirect`, `findDocsRedirect` | Uses `HELPSCOUT_DOCS_API_KEY` and `tests/seed-docs-data.ts` to create private Docs records from explicit source-note-to-article-HTML fixtures and read configured site restrictions through `getDocsSite` `includeRestrictions`. Optional IDs can be pinned with `MCP_DOGFOOD_DOCS_SITE_ID`, `MCP_DOGFOOD_DOCS_COLLECTION_ID`, `MCP_DOGFOOD_DOCS_CATEGORY_ID`, `MCP_DOGFOOD_DOCS_ARTICLE_ID`, `MCP_DOGFOOD_DOCS_REVISION_ID`, `MCP_DOGFOOD_DOCS_REDIRECT_ID`, and `MCP_DOGFOOD_DOCS_REDIRECT_URL`. | Discovery, retrieval, search, pagination, status/visibility filters, site restriction read with secret redaction, related articles, revision freshness checks, redirect resolution. | Requires a Docs API key with permission to read/create/edit Docs content and at least one existing Docs site. Local Markdown/notes are not assumed to render 1:1; fixtures keep Help Scout article HTML explicit. |
| Server utility | `getServerTime` | No Help Scout fixture required. | Utility shape. | None known. |

## Write Operation Coverage

Write dogfood is opt-in and tiered, per the
[write tool contract](../architecture/mcp-tool-contract.md#gating-and-permission-model).
The harness starts its own server process for the write matrix and sets the
gates explicitly, so the read matrices keep asserting a three-tool surface even
when the shell has writes enabled.

| Gate | Effect on dogfood |
| --- | --- |
| unset | Every write scenario reports `SKIP`. No Help Scout write is attempted. |
| `HELPSCOUT_ENABLE_WRITES=true` | Tier-1 lifecycle runs live. CI sets this on the 20.x dogfood step. |
| `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true` plus `MCP_DOGFOOD_ALLOW_CUSTOMER_VISIBLE=true` | Adds the tier-2 scenarios. Both are required: the first is the server gate, the second keeps a run that merely inherited a write-enabled environment from emailing anyone. |

All write scenarios operate on one disposable conversation whose subject is
`MCP-TEST: write lifecycle fixture`, addressed to the dogfood test customer. The
harness reuses it when it exists and seeds it through the Help Scout API when it
does not, because the registry exposes no create-conversation operation and the
contract forbids adding one for a test. Every mutation under test runs through
`write_help_scout` over stdio and is verified by reading the conversation or its
threads back.

Each run leaves a note and a draft on the fixture that no endpoint can delete,
and Help Scout rejects updates once a conversation holds 100 threads. Setup
fails with instructions once the fixture passes 80 threads: delete it in Help
Scout and the next run seeds a fresh one.

| Operation | Mutation class | Fixture | Cleanup | Skip conditions |
| --- | --- | --- | --- | --- |
| `createNote` | `nonDestructive` | Fixture conversation. | None available. The Mailbox API has no delete-note endpoint, so the note is reported as a write artifact every run. | Writes disabled. |
| `createDraftReply` | `nonDestructive` | Fixture conversation. | None available. The Mailbox API has no delete-thread endpoint, so the draft is reported as a write artifact. | Writes disabled. |
| `updateConversationStatus` | `reversible` | Fixture conversation; the pre-run status is captured before any mutation. | Restores the captured status and re-reads to confirm. | Writes disabled. |
| `assignConversation` | `reversible` | User resolved from `listUsers`, or pinned with `MCP_DOGFOOD_WRITE_USER_ID`. | The paired `unassignConversation` scenario clears it. | Writes disabled, or no user resolved. |
| `unassignConversation` | `reversible` | The assignee left by the previous scenario. An unassigned Help Scout conversation carries no `assignee` field, which is what the read-back checks. | Restores the pre-run assignee when the fixture had one. | Writes disabled, or nothing is assigned and no user could be resolved. |
| `addConversationTags` | `reversible` | Fixture conversation plus the `mcp-test-write-lifecycle` tag (`MCP_DOGFOOD_WRITE_TAG` overrides). Asserts the pre-existing tags survived the merge. | The paired `removeConversationTags` scenario removes it. | Writes disabled. |
| `removeConversationTags` | `reversible` | The test tag added by the previous scenario. | Confirms the test tag is gone and the pre-existing tags survived. | Writes disabled. |
| `snoozeConversation` | `reversible` | Fixture conversation, snoozed 24 hours out. Verified through `snooze.snoozedUntil` on the conversation read-back. | The paired `unsnoozeConversation` scenario wakes it. | Writes disabled. |
| `unsnoozeConversation` | `reversible` | The snooze left by the previous scenario. | Confirms the conversation reports no snooze. | Writes disabled. |
| `updateConversationFields` | `reversible` | A free-text custom field on the fixture inbox, discovered through `getInbox` `include: ["fields"]` or pinned with `MCP_DOGFOOD_WRITE_CUSTOM_FIELD_ID`. Dropdown and date fields are not used blind. | Writes the previous value back, or clears the field when it had none. | Writes disabled, or the inbox has no free-text custom field. |
| `moveConversation` | `reversible` | A second inbox from `listAllInboxes`, or `MCP_DOGFOOD_WRITE_SECOND_INBOX_ID`. | Moves the conversation back to its original inbox and confirms. | Writes disabled, or the account has only one inbox. |
| `sendReply` | `externallyVisible` | Fixture conversation, whose customer is the dogfood test customer. The scenario first proves the call is refused without the confirmation triple, then repeats it with confirmation. | None possible. A sent reply cannot be recalled, so it is reported as a write artifact. | Either customer-visible gate unset, or no resolvable test customer email. |
| `publishDraft` | `externallyVisible` | A conversation already in `draft` state, named by `MCP_DOGFOOD_PUBLISH_DRAFT_CONVERSATION_ID`. The harness does not create one, because publishing sends the pending reply and cannot be undone. | None possible. Reported as a write artifact. | Either customer-visible gate unset, or no draft conversation pinned. |
| Gateway surface (`write_help_scout`, `describe_help_scout`, `read_help_scout`) | n/a | No Help Scout fixture. Asserts exactly four advertised tools, the write tool's `readOnlyHint: false` and `destructiveHint: true`, mutation class and tier on every enabled write operation, tier-2 operations reported as unknown while their gate is off, and `read_help_scout` refusing a write operation with a redirect. | n/a | Writes disabled. |

A final scenario re-reads the fixture and restores any drift in status, tags,
snooze, inbox, assignee, and the custom field the field scenario touched. A
restore step that throws does not abandon the ones after it: every failure is
collected, and the run fails naming all of them. Cleanup failure is never
reported as a pass, and anything left behind is listed in the dogfood summary,
including drift the restore pass could not undo.

Read-backs poll: the first attempt goes through the MCP read tool, and later
attempts go straight to the Help Scout API, which the contract allows as a
direct API contract check. The server caches conversation and thread reads for
five minutes, so a retry through the same tool call would re-read the copy the
first attempt cached and the polling would prove nothing.

## Current Skips To Eliminate

| Skip source | Current reason | Preferred fix |
| --- | --- | --- |
| `getSatisfactionRating` | No known satisfaction rating fixture ID. | Submit a known rating through the Help Scout satisfaction flow, then use `npm run dogfood:audit` output to set `MCP_DOGFOOD_SATISFACTION_RATING_ID`. |
| `getTeamMembers` | No team may exist in the test account. | Configure a team with at least one member in Help Scout account settings, then use `npm run dogfood:audit` output to set `MCP_DOGFOOD_TEAM_ID` if discovery should be pinned. |
| Docs API operations | Docs API requires separate `HELPSCOUT_DOCS_API_KEY`; seeding requires a key with Docs create/edit permissions and an existing Docs site. | Run `HELPSCOUT_DOCS_API_KEY=... npm run dogfood:seed:docs`, then use the printed `MCP_DOGFOOD_DOCS_*` values when auto-discovery should be pinned. |
| `updateConversationFields` | The dogfood inbox may expose no free-text custom field. | Add a single-line text custom field to the Client Support inbox, or set `MCP_DOGFOOD_WRITE_CUSTOM_FIELD_ID` to an existing text field. |
| `moveConversation` | The account may expose only one inbox. | Add a second inbox the app can access, or set `MCP_DOGFOOD_WRITE_SECOND_INBOX_ID`. |
| `sendReply`, `publishDraft` | Customer-visible writes are off by default, and `publishDraft` also needs a draft-state conversation. | Run locally with `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true MCP_DOGFOOD_ALLOW_CUSTOMER_VISIBLE=true`, and set `MCP_DOGFOOD_PUBLISH_DRAFT_CONVERSATION_ID` to a conversation created in draft state. These stay skipped in CI on purpose. |

## PR Checklist For New API Surfaces

Before opening a PR that adds or changes registry operations:

- Prefer a parameter on an existing operation over a new near-duplicate
  operation, per the naming rules in the tool contract.
- Add the operation to MCP and MCPB inventories.
- Confirm `search_help_scout` surfaces it for the intent phrasing a user would
  actually type, and that its description carries enough signal to rank.
- Add unit coverage for schema validation and query serialization.
- Add dogfood coverage for at least one live call through stdio, driven through
  the gateway.
- Extend `npm run dogfood:seed` when existing fixtures cannot exercise the core path.
- Update this matrix with the operation-call intents, fixtures, and remaining skips.
- Keep skips narrow and name the missing fixture explicitly.
- Run `npm run dogfood:seed` before authenticated dogfood when the surface depends on seeded records.

For write-capable API parity operations, also follow the write-tool contract in
[`guides/architecture/mcp-tool-contract.md`](../architecture/mcp-tool-contract.md):
classify the mutation, require confirmation metadata for destructive or
externally visible operations, verify the mutation through MCP, and confirm
fixture cleanup.
