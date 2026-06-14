# MCP Tool Surface Roadmap

This roadmap sorts future Help Scout MCP work by likely support-team usage. It
is a product map, not a release plan.

## 1. Core Support Loop

These are the highest-usage tools because they map directly to daily support
questions.

Current:

- `searchConversations`
- `advancedConversationSearch`
- `comprehensiveConversationSearch`
- `structuredConversationFilter`
- `getConversationSummary`
- `getThreads`
- `getOriginalSource`
- `getAttachment`
- `searchInboxes`
- `listAllInboxes`

Next:

- Add narrower thread/attachment fixture coverage as the dogfood account gets
  richer test data.

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
- `listTeams`
- `getTeamMembers`
- `listInboxCustomFields`
- `listInboxFolders`
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
- `getConversationsReport`
- `getHappinessReport`
- `getHappinessRatingsReport`

Next:

- Rating fixture coverage when the dogfood account has known rating data.
- Productivity report coverage.
- User and team report coverage.
- Report drilldown coverage with strict pagination and bounded filters.
- Time-windowed trend queries that return compact, chartable data.
- Guardrails to avoid large, slow account-wide report pulls by default.

## 5. Docs API

Docs API support should be its own namespace or clearly named tool family. It
may require different Help Scout permissions and different user expectations
than mailbox tools.

Next:

- Docs collection and article search.
- Article retrieval.
- Lightweight article metadata for citation and freshness checks.

## 6. Admin And Integration Metadata

Admin and integration tools are useful but lower-frequency. They should remain
read-only until a separate write boundary exists.

Current:

- `listWebhooks`
- `getWebhook`

Next:

- Integration health metadata if available through supported APIs.

## 7. MCP Apps Views

Interactive views should compose existing tool data rather than introduce a
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
