# MCP Tool Surface Roadmap

This roadmap sorts direct Help Scout API-parity MCP work by likely support-team
usage. It is a product map, not a release plan; deferred ideas are called out
separately so they are not mistaken for current build scope.

## Dogfood Fixture Rule

Each direct API-surface PR must include or reuse idempotent dogfood seed data
that exercises the core path and meaningful parameter permutations for that
surface. If a live dogfood failure is caused by missing account data, fix the
fixture setup instead of weakening coverage.

Use `npm run dogfood:seed` before authenticated dogfood runs. When a new API
family needs data that the shared seed set cannot create, add the family-specific
seed step and wire it into that command. Keep the detailed per-tool fixture map
current in [`guides/testing/dogfood-fixture-matrix.md`](../testing/dogfood-fixture-matrix.md).

## 1. Core Support Loop

These are the highest-usage tools because they map directly to daily support
questions.

Current:

- `searchConversations`
- `advancedConversationSearch`
- `comprehensiveConversationSearch`
- `structuredConversationFilter`
- `getConversation`
- `getConversationSummary`
- `getThreads`
- `getOriginalSource`
- `getAttachment`
- `searchInboxes`
- `listAllInboxes`

Next:

- Add narrower thread/attachment fixture coverage as the dogfood account gets
  richer test data.
- Seed thread original-source and attachment fixtures so core support-loop
  dogfood does not depend on optional account history.

## 2. Customer And Account Context

These tools answer who the customer is, what account they belong to, and what
history matters before a reply.

Current:

- `listCustomers`
- `getCustomer`
- `searchCustomersByEmail`
- `getCustomerContacts`
- `listOrganizations`
- `getOrganization`
- `getOrganizationMembers`
- `getOrganizationConversations`
- `listCustomerProperties`
- `listOrganizationProperties`
- `getOrganizationProperty`

Next:

- Normalize structured output envelopes for customer and organization tools.
- Add output schemas for stable profile, contact, property, and organization
  response shapes.
- Expand dogfood coverage for property-heavy accounts.

## 3. Operator Metadata

Metadata tools help AI hosts interpret how a Help Scout account is configured.
They also reduce hallucinated IDs in later feature work.

Current:

- `listTags`
- `getTag`
- `listUsers`
- `getUser`
- `listSystemUsers`
- `getSystemUser`
- `listUserStatuses`
- `getUserStatus`
- `listTeams`
- `getTeamMembers`
- `listInboxCustomFields`
- `listInboxFolders`
- `getInboxRouting`
- `listSavedReplies`
- `getSavedReply`
- `listWorkflows`

Next:

- Add stronger metadata result schemas.
- Keep metadata tools read-only and browseable.

## 4. Support Quality And Reporting

These tools are less frequent than the core support loop, but important for
managers and recurring analysis.

Current:

- `getSatisfactionRating`
- `getCompanyReport`
- `getCompanyCustomersHelpedReport`
- `getCompanyDrilldownReport`
- `getConversationsReport`
- `getConversationVolumeByChannelReport`
- `getConversationBusyTimesReport`
- `getConversationDrilldownReport`
- `getConversationFieldDrilldownReport`
- `getConversationNewReport`
- `getConversationNewDrilldownReport`
- `getConversationReceivedMessagesReport`
- `getDocsReport`
- `getHappinessReport`
- `getHappinessRatingsReport`
- `getProductivityReport`
- `getProductivityFirstResponseTimeReport`
- `getProductivityRepliesSentReport`
- `getProductivityResolutionTimeReport`
- `getProductivityResolvedReport`
- `getProductivityResponseTimeReport`
- `getUserReport`
- `getUserConversationHistoryReport`
- `getUserCustomersHelpedReport`
- `getUserDrilldownReport`
- `getUserHappinessReport`
- `getUserRatingsReport`
- `getUserRepliesReport`
- `getUserResolutionsReport`
- `getUserChatReport`
- `getChatReport`
- `getEmailReport`
- `getPhoneReport`

Next:

- Rating fixture coverage when the dogfood account has known rating data.
- Seed reporting fixtures with assigned users, closed conversations, replies,
  resolution history, and satisfaction ratings so report dogfood can assert
  non-empty rows across company, conversation, productivity, happiness, and user
  report families.
- Guardrails to avoid large, slow account-wide report pulls by default.

## 5. Docs API

Docs API support should be its own namespace or clearly named tool family. It
may require different Help Scout permissions and different user expectations
than mailbox tools.

Current:

- `listDocsSites`
- `getDocsSite`
- `listDocsCollections`
- `getDocsCollection`
- `listDocsCategories`
- `getDocsCategory`
- `listDocsArticles`
- `searchDocsArticles`
- `getDocsArticle`
- `listDocsRelatedArticles`
- `listDocsArticleRevisions`
- `getDocsArticleRevision`
- `listDocsRedirects`
- `getDocsRedirect`
- `findDocsRedirect`

Next:

- Add structured output schemas for Docs article, collection, category, and
  redirect envelopes after the repository-wide MCP response-envelope work lands.
- Add Docs fixture setup notes for accounts where the API key cannot create
  read-only knowledge base fixtures.

## 6. Admin And Integration Metadata

Admin and integration tools are useful but lower-frequency. They should remain
read-only until a separate write boundary exists.

Current:

- `listWebhooks`
- `getWebhook`

Next:

- Integration health metadata if available through supported APIs.

## 7. Deferred MCP Apps Views

MCP Apps views are future ideas, not current plan. Do not schedule these until
the direct API-parity tool surface is complete. When they are revisited,
interactive views should compose existing tool data rather than introduce a
second data path.

Candidate views:

- Inbox command center.
- Customer health dashboard.
- Conversation review workspace.
- Account context panel.

The first MCP Apps work should prove that a view can reuse stable tool envelopes
and dogfood fixtures without special casing the test account.

## 8. Remote MCP And OAuth

Remote MCP, OAuth, and Cloudflare deployment are platform work. They should not
reshape the core stdio tool contract unless the stable MCP spec requires it.

Next:

- Remote MCP OAuth research.
- Cloudflare Workers MCP deployment design.
- Clear separation between stdio environment credentials and HTTP authorization.

## 9. Write And Automation Tools

Write tools are intentionally deferred. They require a stricter permission and
confirmation model than read tools.

Possible future families:

- Draft reply creation.
- Tagging or assignment.
- Workflow execution.
- Conversation status updates.

Do not mix write tools into the read-only surface without explicit naming,
metadata, user confirmation guidance, and test coverage for denied or partial
actions.
