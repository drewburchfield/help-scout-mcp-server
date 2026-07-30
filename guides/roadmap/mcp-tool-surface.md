# MCP Tool Surface

This document defines the tool-surface boundary through v2.1: what the server
advertises, what it can actually do, and what is deliberately left for later. It
is a surface map, not a release plan.

## The 2.0 Surface

The server advertises exactly three MCP tools:

- `search_help_scout` finds operations by user intent and returns matching
  operation names and descriptions.
- `describe_help_scout` returns full input schemas for named operations.
- `read_help_scout` executes one named operation.

Behind those three sits an internal registry of 55 read Help Scout operations
covering conversations, customers, organizations, inboxes, tags, users, teams,
saved replies, attachments, workflows, webhooks, satisfaction ratings, reports,
and the Docs API. The gateway lives in `src/tools/gateway.ts`; the operation
definitions and handlers stay in `src/tools/index.ts`.

The registry is not a second advertised surface. Hosts discover operations
through `search_help_scout`, load schemas through `describe_help_scout`, then
execute through `read_help_scout`.

v2.1 adds a fourth advertised tool, `write_help_scout`, and it appears only when
an operator enables writes. The 55 is the read-operation count and does not
change. See [In Progress: v2.1 Write Surface](#in-progress-v21-write-surface).

## Compatibility

Read operation names currently in the registry still dispatch directly, so a
client that calls `getConversation` by name keeps working. Names removed in the
2.0.0 consolidation do not dispatch; they return an unknown-tool error pointing
at `search_help_scout`. Write operation names never dispatch directly, and
`read_help_scout` refuses to execute them. The full rule lives in
[`guides/architecture/mcp-tool-contract.md`](../architecture/mcp-tool-contract.md).

## What Was Consolidated

Capabilities were folded into parent operations, not dropped.

| Removed name | Now reachable through |
| --- | --- |
| `searchInboxes` | `listAllInboxes` with `nameContains` |
| `advancedConversationSearch`, `comprehensiveConversationSearch`, `structuredConversationFilter` | `searchConversations` convenience filters |
| `getConversationV3` | `getConversation` with `includeSystemActors` |
| `getThreadsV3` | `getThreads` with `includeSystemActors` |
| `getOriginalSourceRfc822` | `getOriginalSource` with `format: "rfc822"` |
| `listCustomersV3` | `listCustomers` with `useV3` or a `cursor` |
| `getCustomerAddress`, `listCustomerEmails`, `listCustomerPhones`, `listCustomerChats`, `listCustomerSocialProfiles`, `listCustomerWebsites` | `getCustomerContacts` |
| `listSystemUsers` | `listUsers` with `includeSystemActors` |
| `getSystemUser` | `getUser` with `includeSystemActors` |
| `listUserStatuses` | `listUsers` with `includeStatuses` |
| `getUserStatus` | `getUser` with `includeStatus` |
| `listInboxCustomFields`, `listInboxFolders`, `getInboxRouting` | `getInbox` with `include: ["fields", "folders", "routing"]` |
| `getDocsSiteRestrictions` | `getDocsSite` with `includeRestrictions` |
| 32 individual report tools | 7 category operations: `getCompanyReport`, `getConversationsReport`, `getProductivityReport`, `getUserReport`, `getHappinessReport`, `getChannelReport`, `getDocsReport`, each selecting a sub-report through `report` or `channel` |

Collection operations use page-number pagination. The one exception is the v3
Customers path (`listCustomers` with `useV3` or a cursor, and
`searchCustomersByEmail`), where cursor pagination is upstream Help Scout
behavior rather than a server choice.

## Dogfood Fixture Rule

Each API-surface PR must include or reuse idempotent dogfood seed data that
exercises the core path and meaningful parameter permutations for that
operation. If a live dogfood failure is caused by missing account data, fix the
fixture setup instead of weakening coverage.

Use `npm run dogfood:seed` before authenticated dogfood runs. When a new API
family needs data the shared seed set cannot create, add the family-specific seed
step and wire it into that command. Optional credential-gated seeders, such as
Docs API fixtures, should no-op when their credentials are missing. Keep the
per-operation fixture map current in
[`guides/testing/dogfood-fixture-matrix.md`](../testing/dogfood-fixture-matrix.md).

## In Progress: v2.1 Write Surface

Writes are the one interaction mode that justifies a fourth advertised tool.
`write_help_scout` executes mutating operations registered alongside the reads,
discovered through `search_help_scout` and schema-loaded through
`describe_help_scout` like everything else, but never executable through
`read_help_scout`, which rejects mutating operations with an error that
redirects to the write tool. The Mailbox API has no granular scopes, so the
server is the permission boundary. `HELPSCOUT_ENABLE_WRITES=true` turns on tier
1, the `nonDestructive` and `reversible` operations;
`HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true` adds tier 2, the
`externallyVisible` operations that can reach a customer, each of which still
requires per-call confirmation metadata naming the operation and the target.
Both default off, and with them off `tools/list` returns the same three tools as
2.0 while write operations are absent from search, describe, and dispatch. The
advertised surface is built once per process, so a flag changed after the first
gateway call does not change what the server advertises until it restarts, while
customer-visible execution is rechecked live at dispatch and stops immediately.
`destructive` operations are not exposed in 2.1 at all. Where an externally
visible action has a non-visible variant, the non-visible one is the default:
`createDraftReply` pins `draft: true`, while `sendReply` and `publishDraft` are
separate tier-2 operations. `write_help_scout` carries `readOnlyHint: false` and
`destructiveHint: true`, and states its confirmation contract in its own
description so a host sees the requirements without a describe call. The four
conditions this document set on mixing writes into the gateway still hold:
explicit naming, metadata, confirmation guidance, and coverage for denied or
partial actions. How each is met is recorded in
[`guides/architecture/mcp-tool-contract.md`](../architecture/mcp-tool-contract.md).

Phase 1 is the conversation family: `createNote`, `createDraftReply`,
`sendReply`, `publishDraft`, `updateConversationStatus`, `assignConversation`,
`unassignConversation`, `addConversationTags`, `removeConversationTags`,
`updateConversationFields`, `snoozeConversation`, `unsnoozeConversation`, and
`moveConversation`.

Later families stay candidates rather than commitments: customer and
organization records, Docs content, and workflow execution.

## Future Work

### Output Schemas

Registry operations return `structuredContent` alongside serialized JSON text.
Adding `outputSchema` per operation is still open work, sequenced in the rollout
order at the end of the tool contract.

### Remote MCP And OAuth

Remote MCP, OAuth, and Cloudflare deployment are platform work. They should not
reshape the stdio gateway contract unless the stable MCP spec requires it. Open
items: remote MCP OAuth research, Workers deployment design, and a clear
separation between stdio environment credentials and HTTP authorization.

### Interactive Views

Interactive views are parked. If they are revisited, they should compose existing
operation output rather than introduce a second data path, and they should reuse
stable envelopes and dogfood fixtures without special-casing the test account.
