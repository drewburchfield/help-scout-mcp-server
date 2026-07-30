---
name: helpscout-navigator
description: Use when searching HelpScout tickets, customers, or organizations. Provides correct tool selection, required sequencing, and prevents common mistakes. Triggers on "search helpscout", "find tickets", "check support inbox", "helpscout conversations", "look up customer", "find organization", "customer history".
---

# HelpScout Navigation

Guide for correctly using the Help Scout MCP gateway. Prevents common mistakes and ensures complete search results.

## First Step: Check the Tools Are There

Look for these three tools among your available tools (clients usually prefix them with the server name, e.g. `mcp__helpscout__search_help_scout`):

- `search_help_scout`
- `describe_help_scout`
- `read_help_scout`

**If they are available:** ✅ Skip to "Critical Rules". You're ready to go.

**If they are NOT available**, the Help Scout MCP server is not connected in this client. Tell the user, and point them at the setup for their client (see the [server README](https://github.com/drewburchfield/help-scout-mcp-server#quick-start)):

- **Claude Desktop / claude.ai (including Cowork):** install the Desktop Extension (`.mcpb` from releases), enter the App ID and App Secret in its settings, restart the app.
- **Claude Code and other CLI clients:** register the server (for example `claude mcp add helpscout --env HELPSCOUT_APP_ID=... --env HELPSCOUT_APP_SECRET=... -- npx -y help-scout-mcp-server`). Credentials come from the client's process environment, so after setting them, fully restart the client from a fresh shell; a client started before the variables existed never sees them.
- **Credentials** come from Help Scout: profile icon > **My Apps** > **Create Private App**, then copy the App ID and App Secret.

**Do not proceed with HelpScout operations until the tools are available.** If the tools are present but every call fails with an authentication error, the credentials are wrong; re-check them in the client's server config.

---

## Overview

The Help Scout MCP server advertises three tools. Behind them sits a registry of 55 read operations covering conversations, customers, organizations, reports, metadata, and Docs:

| Tool | Purpose |
|------|---------|
| `search_help_scout` | Find operations by intent. Returns up to 8 name + description summaries. |
| `describe_help_scout` | Get full input schemas for up to 10 named operations. |
| `read_help_scout` | Execute one operation: `{"name": "<operation>", "arguments": {...}}` |

**The flow is always:** search for operations → describe the one(s) you picked → execute with `read_help_scout`.

A fourth tool, `write_help_scout`, appears only when the operator enabled writes. If you do not see it, this install is read-only. See [Write Operations](#write-operations-only-when-enabled).

**Core problems this skill solves:**
1. Users guess argument shapes instead of calling `describe_help_scout` first
2. Users look up inbox IDs when they are already in the server instructions
3. Users don't know which operation fits their query type
4. Users reach for conversation search when a customer, org, report, metadata, or Docs operation fits better

---

## Critical Rules (MUST READ FIRST)

### Rule 1: Route Through the Gateway

1. `search_help_scout(query: "<user's intent>")` to find candidate operations
2. `describe_help_scout(names: ["<operation>"])` to get the exact input schema
3. `read_help_scout(name: "<operation>", arguments: {...})` to execute

Operation names in the registry also dispatch directly as legacy compatibility, but always route through the gateway: `search_help_scout` surfaces the right operation and `describe_help_scout` gives you the real schema instead of a guess.

### Rule 2: Inbox IDs Come From Server Instructions

Inboxes are auto-discovered at connect time and listed in the server instructions with their IDs. **No lookup call is needed.** Use the numeric ID from there. Only call `listAllInboxes` (optionally with `nameContains`) if you need to re-check mid-session.

### Rule 3: searchConversations is THE Conversation Search

`searchConversations` is the only conversation search and list operation. It searches **active + pending + closed by default** (spam excluded), so keyword searches do not silently miss closed tickets. Convenience filters: `contentTerms`, `subjectTerms`, `email`, `emailDomain`, `customerIds`, `hasAttachments`, `inboxId`, `folderId`, `tag`, `status`, `createdAfter`/`createdBefore`, `conversationNumber`, `assignedTo`.

### Migration Note (older guidance)

If you have seen older docs for this server, these operations are gone:

| Removed | Use instead |
|---------|-------------|
| `searchInboxes` | `listAllInboxes` (optionally `nameContains`), or just the server instructions |
| `comprehensiveConversationSearch`, `advancedConversationSearch`, `structuredConversationFilter` | `searchConversations` with convenience filters |
| `listCustomersV3` | `listCustomers` with `useV3` / `cursor` |
| `getCustomerAddress` and other customer contact sub-resources | `getCustomerContacts` |

---

## Decision Tree: Which Operation to Use

```dot
digraph decision {
    rankdir=TB;
    node [shape=box, style=rounded];

    start [label="Start", shape=ellipse];
    know_op [label="Know which\noperation?", shape=diamond];
    search_gw [label="search_help_scout\n(intent query)", style="bold,filled", fillcolor="#ffcccc"];
    describe [label="describe_help_scout\n(get schema)", style="bold,filled", fillcolor="#ccffcc"];
    execute [label="read_help_scout\n(name + arguments)"];
    conv_q [label="Conversation\nsearch/list?", shape=diamond];
    searchConv [label="searchConversations"];
    detail_q [label="Need thread\nor summary?", shape=diamond];
    getThreads [label="getThreads /\ngetConversationSummary"];

    start -> know_op;
    know_op -> search_gw [label="no"];
    know_op -> describe [label="yes"];
    search_gw -> describe;
    describe -> execute;
    execute -> conv_q;
    conv_q -> searchConv [label="yes"];
    conv_q -> detail_q [label="no"];
    detail_q -> getThreads [label="yes"];
}
```

### Quick Decision Matrix

All operations below run through `read_help_scout`. Call `describe_help_scout` first when unsure of arguments.

| I want to... | Operation | Notes |
|--------------|-----------|-------|
| Search or list conversations (keywords, email, domain, tag, status, dates, ticket #) | `searchConversations` | The only conversation search; all statuses by default |
| Read full conversation | `getThreads` | Need conversation ID |
| Get raw conversation object | `getConversation` | Need conversation ID |
| Get quick overview | `getConversationSummary` | Need conversation ID |
| Get current server time | `getServerTime` | Use for date-relative queries |
| List inboxes | `listAllInboxes` | Usually unnecessary; IDs in server instructions |
| Inbox custom fields, folders, routing | `getInbox` | `include: ["fields","folders","routing"]` |
| Look up customer by email | `searchCustomersByEmail` | Exact match |
| Browse customers | `listCustomers` | `useV3`/`cursor` for the v3 path |
| Full customer profile | `getCustomer` | Need customer ID |
| Customer contact channels (emails, phones, address, ...) | `getCustomerContacts` | Need customer ID |
| Browse organizations | `listOrganizations` | Sortable by activity, size, name |
| Organization details / members / history | `getOrganization`, `getOrganizationMembers`, `getOrganizationConversations` | Need organization ID |
| Tags, users, teams | `listTags`, `listUsers`, `getUser`, `listTeams`, `getTeamMembers` | |
| Saved replies | `listSavedReplies`, `getSavedReply` | |
| Attachments and raw email source | `getAttachment`, `downloadAttachmentFile`, `getOriginalSource` | |
| Workflows, webhooks, ratings | `listWorkflows`, `listWebhooks`, `getWebhook`, `getSatisfactionRating` | |
| Reports | `getCompanyReport`, `getConversationsReport`, `getProductivityReport`, `getUserReport`, `getHappinessReport`, `getChannelReport`, `getDocsReport` | Plan-gated |
| Docs knowledge base | `listDocsSites`, `searchDocsArticles`, `getDocsArticle`, and 12 more Docs operations | Use `search_help_scout("docs ...")` |

See [references/tool-reference.md](references/tool-reference.md) for complete parameter documentation.

---

## Common Workflows

### Workflow 1: Search Inbox X for Keyword Y

**User:** "Search the support inbox for billing issues"

**Steps:**
1. Get the Support inbox ID from the server instructions (no lookup call needed).
2. Confirm the schema, then execute:
   ```
   describe_help_scout(names: ["searchConversations"])
   read_help_scout(
     name: "searchConversations",
     arguments: { contentTerms: ["billing"], inboxId: "359402" }
   )
   ```
   Searches active + pending + closed by default.

### Workflow 2: Show Recent Tickets in Inbox X

**User:** "Show me recent tickets in the sales inbox"

```
read_help_scout(
  name: "searchConversations",
  arguments: { inboxId: "359402", sort: "createdAt", order: "desc", limit: 20 }
)
```

### Workflow 3: Find Ticket #12345

```
read_help_scout(name: "searchConversations", arguments: { conversationNumber: 12345 })
read_help_scout(name: "getConversationSummary", arguments: { conversationId: "<id from step 1>" })
```

### Workflow 4: Find All Tickets from Domain

**User:** "Find tickets from @acme.com"

```
read_help_scout(name: "searchConversations", arguments: { emailDomain: "acme.com" })
```

### Workflow 5: Recent Tickets in a Date Window

**User:** "Show me tickets from the last 30 days"

```
read_help_scout(name: "getServerTime", arguments: {})
read_help_scout(
  name: "searchConversations",
  arguments: { createdAfter: "<serverTime minus 30 days, ISO8601>", sort: "createdAt", order: "desc", limit: 50 }
)
```

### Workflow 6: Get Full Conversation Thread

```
read_help_scout(name: "getThreads", arguments: { conversationId: "12345678", limit: 200 })
```

### Workflow 7: Customer Investigation by Email

**User:** "Look up jane@acme.com and show their history"

```
read_help_scout(name: "searchCustomersByEmail", arguments: { email: "jane@acme.com" })
read_help_scout(name: "getCustomer", arguments: { customerId: "12345" })
read_help_scout(name: "searchConversations", arguments: { customerIds: [12345], sort: "createdAt", order: "desc" })
```

### Workflow 8: Organization Account Review

**User:** "Show me everything about the Acme Corp account"

```
read_help_scout(name: "listOrganizations", arguments: { sortField: "name" })
read_help_scout(name: "getOrganization", arguments: { organizationId: "456", includeCounts: true })
read_help_scout(name: "getOrganizationMembers", arguments: { organizationId: "456" })
read_help_scout(name: "getOrganizationConversations", arguments: { organizationId: "456" })
```

---

## Write Operations (only when enabled)

Writes are off unless the operator set `HELPSCOUT_ENABLE_WRITES=true`. When they are on, `write_help_scout` is advertised alongside the three read tools and the same gateway flow applies:

1. `search_help_scout(query: "<intent>")`. Write operations come back labeled with their access and mutation class, for example `write (reversible)`.
2. `describe_help_scout(names: ["<operation>"])` for the schema, which also reports `mutationClass` and `tier`.
3. `write_help_scout(name: "<operation>", arguments: {...})` to execute.

**Draft first.** `createDraftReply` saves an unsent draft and has no parameter that could send it. `createNote` is internal to your team. Neither notifies the customer. Compose in a draft, show it to the user, and stop there.

**Never send on your own initiative.** `sendReply` and `publishDraft` email the customer and cannot be recalled. Call them only when the user has explicitly asked to send. They need a second gate (`HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true`) plus all three confirmation fields on every call, as siblings of `arguments`:

```javascript
write_help_scout({
  name: "sendReply",
  arguments: { conversationId: "12345", text: "Thanks for your patience..." },
  confirm: true,
  confirmOperation: "sendReply",
  targetId: "12345"
})
```

Missing, false, or mismatched confirmation is refused before anything reaches Help Scout.

**Preview anything.** Add `dryRun: true` beside `arguments` to see the exact request that would be sent without contacting Help Scout.

| Tier | Gate | Operations |
|------|------|------------|
| 1 | `HELPSCOUT_ENABLE_WRITES` | `createNote`, `createDraftReply`, `updateConversationStatus`, `assignConversation`, `unassignConversation`, `addConversationTags`, `removeConversationTags`, `updateConversationFields`, `snoozeConversation`, `unsnoozeConversation`, `moveConversation` |
| 2 | plus `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES` | `sendReply`, `publishDraft` |

Deletes and admin configuration writes are not exposed under any flag. See [references/tool-reference.md](references/tool-reference.md) for the full operation list.

---

## Anti-Patterns (What NOT to Do)

| Mistake | Why It Fails | Correct Approach |
|---------|--------------|------------------|
| Calling `mcp__helpscout__searchConversations` as an MCP tool | Only three tools are advertised | `read_help_scout(name: "searchConversations", ...)` |
| Guessing arguments for `read_help_scout` | Schemas vary per operation | `describe_help_scout` first |
| Calling `listAllInboxes` before every search | Inbox IDs are already in server instructions | Read the server instructions |
| Passing an inbox name as `inboxId` | IDs are numeric strings, not names | Use the ID from server instructions |
| Adding `status: "active"` to keyword searches "to be safe" | Default already covers active + pending + closed | Omit `status` unless narrowing on purpose |
| Hardcoding "today" in date filters | Server clock may differ | `getServerTime` first |
| Calling `read_help_scout` for a write operation | `read_help_scout` refuses anything that changes state | `write_help_scout`, when writes are enabled |
| Putting `confirm` or `dryRun` inside `arguments` | They are envelope fields; the call is refused, not silently corrected | Put them beside `arguments` |
| Sending a customer reply the user did not ask for | `sendReply` emails immediately and cannot be recalled | `createDraftReply`, then let the user decide |

See [references/common-mistakes.md](references/common-mistakes.md) for more anti-patterns.

---

## Quick Reference Card

```bash
# STEP 1: Find operations by intent
search_help_scout(query: "find tickets about billing")

# STEP 2: Get exact schemas (up to 10 names)
describe_help_scout(names: ["searchConversations", "getThreads"])

# STEP 3: Execute (all searches default to active+pending+closed)
read_help_scout(name: "searchConversations", arguments: {
  contentTerms: ["billing", "refund"],
  inboxId: "359402"           # from server instructions
})

# Direct ticket lookup
read_help_scout(name: "searchConversations", arguments: { conversationNumber: 12345 })

# Email domain search
read_help_scout(name: "searchConversations", arguments: { emailDomain: "acme.com" })

# Full thread / quick summary
read_help_scout(name: "getThreads", arguments: { conversationId: "12345678" })
read_help_scout(name: "getConversationSummary", arguments: { conversationId: "12345678" })

# Customer lookup
read_help_scout(name: "searchCustomersByEmail", arguments: { email: "jane@acme.com" })
read_help_scout(name: "getCustomer", arguments: { customerId: "12345" })
read_help_scout(name: "getCustomerContacts", arguments: { customerId: "12345" })

# Organization traversal
read_help_scout(name: "listOrganizations", arguments: { sortField: "conversationCount", sortOrder: "desc" })
read_help_scout(name: "getOrganization", arguments: { organizationId: "456", includeCounts: true })
read_help_scout(name: "getOrganizationMembers", arguments: { organizationId: "456" })
read_help_scout(name: "getOrganizationConversations", arguments: { organizationId: "456" })
```

---

## Common Mistakes Checklist

Before executing a HelpScout operation, verify:

- [ ] Unsure which operation? → Called `search_help_scout` with the user's intent?
- [ ] Know the operation? → Called `describe_help_scout` before building arguments?
- [ ] Executing? → Using `read_help_scout(name, arguments)`, not the operation name as a tool?
- [ ] Inbox mentioned? → Using the numeric ID from server instructions (no lookup call)?
- [ ] Conversation search? → Using `searchConversations` (all statuses by default)?
- [ ] Date-relative query ("last week", "today")? → Called `getServerTime` first?
- [ ] Looking up a customer? → `searchCustomersByEmail`, not conversation search?
- [ ] Investigating an account? → `listOrganizations` → `getOrganization` → `getOrganizationMembers`?
