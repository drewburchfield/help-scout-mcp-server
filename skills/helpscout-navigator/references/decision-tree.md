# Help Scout Tool Decision Tree

Expanded decision logic for complex search scenarios. Every operation below is executed through the gateway: `search_help_scout` to find it, `describe_help_scout` for its schema, `read_help_scout` to run it. Examples show the `read_help_scout` call.

---

## Scenario 1: Multi-Inbox Search

**User:** "Search all inboxes for tickets about API issues"

**Approach:**
```javascript
// Option A: Search without inbox filter (searches all)
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["API", "api error", "integration"] }
})

// Option B: Search each inbox (IDs are in the server instructions)
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["API"], inboxId: "<each inbox ID>" }
})
```

**When to use Option B:**
- Need results grouped by inbox
- Different search terms per inbox
- Reporting on inbox-specific metrics

---

## Scenario 2: List Recent Tickets (All Statuses)

**User:** "Show me recent tickets" (no specific status mentioned)

**Key insight:** `searchConversations` searches active + pending + closed by default. No special incantation needed.

**Approach:**
```javascript
read_help_scout({
  name: "searchConversations",
  arguments: {
    sort: "createdAt",
    order: "desc",
    limit: 50,
    createdAfter: "2026-06-28T00:00:00Z"  // Optional: date filter
  }
})

// To include spam too, pass status: "all"
```

---

## Scenario 3: Date-Range Filtering

**User:** "Find tickets from Q4 2025"

**Approach:**
```javascript
// Listing by date range (all statuses by default)
read_help_scout({
  name: "searchConversations",
  arguments: {
    createdAfter: "2025-10-01T00:00:00Z",
    createdBefore: "2026-01-01T00:00:00Z"
  }
})

// Keyword search within a date range
read_help_scout({
  name: "searchConversations",
  arguments: {
    contentTerms: ["billing", "refund"],
    createdAfter: "2025-10-01T00:00:00Z",
    createdBefore: "2026-01-01T00:00:00Z"
  }
})
```

**For time-relative queries ("last 7 days"):**
```javascript
// Step 1: Get the authoritative clock
read_help_scout({ name: "getServerTime", arguments: {} })

// Step 2: Compute createdAfter from the response
read_help_scout({
  name: "searchConversations",
  arguments: { createdAfter: "<serverTime minus 7 days, ISO8601>" }
})
```

**Note:** HelpScout search does not support wildcards. Use `contentTerms` variations instead.

---

## Scenario 4: Customer History

**User:** "Show all tickets from customer@example.com"

**Approach:**
```javascript
// Direct: filter conversations by email
read_help_scout({
  name: "searchConversations",
  arguments: { email: "customer@example.com", sort: "createdAt", order: "desc" }
})

// Or resolve the customer first for a richer profile
read_help_scout({ name: "searchCustomersByEmail", arguments: { email: "customer@example.com" } })
read_help_scout({ name: "searchConversations", arguments: { customerIds: [12345] } })
```

**For domain-wide search:**
```javascript
read_help_scout({ name: "searchConversations", arguments: { emailDomain: "example.com" } })
```

---

## Scenario 5: Assignee-Based Filtering

**User:** "Show John's open tickets"

**Approach:**
```javascript
// Step 1: Get John's user ID
read_help_scout({ name: "listUsers", arguments: {} })

// Step 2: Filter by assignee
read_help_scout({
  name: "searchConversations",
  arguments: { assignedTo: 12345, status: "active", sort: "waitingSince", order: "asc" }
})
```

**For unassigned tickets:**
```javascript
read_help_scout({
  name: "searchConversations",
  arguments: { assignedTo: -1, status: "active" }
})
```

---

## Scenario 6: Tag-Based Search

**User:** "Find all tickets tagged 'urgent' or 'escalated'"

**Approach:**
```javascript
// Comma-separated tags
read_help_scout({
  name: "searchConversations",
  arguments: { tag: "urgent,escalated" }
})

// Tag + content search
read_help_scout({
  name: "searchConversations",
  arguments: { tag: "urgent", contentTerms: ["billing", "payment"] }
})

// Browse available tags first if unsure of exact names
read_help_scout({ name: "listTags", arguments: {} })
```

---

## Scenario 7: Folder-Based Queries

**User:** "Show tickets in the 'Needs Follow-up' folder"

**Approach:**
```javascript
// Step 1: Get folder IDs for the inbox
read_help_scout({
  name: "getInbox",
  arguments: { inboxId: "359402", include: ["folders"] }
})

// Step 2: Filter by folder
read_help_scout({
  name: "searchConversations",
  arguments: { folderId: 67890, sort: "modifiedAt", order: "desc" }
})
```

---

## Scenario 8: Conversation Deep Dive

**User:** "Tell me everything about ticket #42839"

**Approach:**
```javascript
// Step 1: Get conversation by number
read_help_scout({ name: "searchConversations", arguments: { conversationNumber: 42839 } })

// Step 2: Get summary (first + latest messages)
read_help_scout({ name: "getConversationSummary", arguments: { conversationId: "<id>" } })

// Step 3: Full thread if needed
read_help_scout({ name: "getThreads", arguments: { conversationId: "<id>", limit: 200 } })

// Step 4 (optional): raw email source or attachments
read_help_scout({ name: "getOriginalSource", arguments: { conversationId: "<id>", threadId: "<threadId>" } })
```

---

## Scenario 9: Status Transitions

**User:** "Find recently closed tickets that were open for more than a week"

**Approach:**
```javascript
// Step 1: Get recently closed tickets
read_help_scout({
  name: "searchConversations",
  arguments: { status: "closed", sort: "modifiedAt", order: "desc", limit: 100 }
})

// Step 2: Filter by duration (in your code)
// Check createdAt vs closedAt difference
```

---

## Scenario 10: Customer Lookup by Email

**User:** "Find the customer with email jane@acme.com"

**Approach:**
```javascript
// Step 1: Search by email (exact match)
read_help_scout({ name: "searchCustomersByEmail", arguments: { email: "jane@acme.com" } })
// Returns: [{ id: 12345, firstName: "Jane", lastName: "Doe", organizationId: 456 }]

// Step 2: Get full profile
read_help_scout({ name: "getCustomer", arguments: { customerId: "12345" } })

// Step 3 (optional): All contact channels
read_help_scout({ name: "getCustomerContacts", arguments: { customerId: "12345" } })
// Returns: emails, phones, chats, socialProfiles, websites, address
```

**When to use `searchCustomersByEmail` vs `listCustomers`:**
- `searchCustomersByEmail`: exact email match
- `listCustomers`: name search and query syntax; pass `useV3` (or a `cursor`) for cursor pagination plus `email`/`createdSince` filters

**When NOT to use conversation search for customer lookup:**
- `searchConversations({ email: "..." })` finds conversations, not the customer directory record.

---

## Scenario 11: Organization Account Review

**User:** "Show me the Acme Corp account and all their support history"

**Approach:**
```javascript
// Step 1: Find the organization
read_help_scout({ name: "listOrganizations", arguments: { sortField: "name", sortOrder: "asc" } })

// Step 2: Details with counts
read_help_scout({ name: "getOrganization", arguments: { organizationId: "456", includeCounts: true } })

// Step 3: Who is in the org (50 per page)
read_help_scout({ name: "getOrganizationMembers", arguments: { organizationId: "456" } })

// Step 4: Support history (50 per page)
read_help_scout({ name: "getOrganizationConversations", arguments: { organizationId: "456" } })

// Step 5 (optional): Deep dive into a conversation
read_help_scout({ name: "getConversationSummary", arguments: { conversationId: "<id>" } })
```

**Full traversal pattern:**
Organization -> Members -> Pick a member -> getCustomer -> Their conversations -> Thread details

---

## Scenario 12: Customer History from Conversation

**User:** "Who is the customer on ticket #42839 and what's their full history?"

**Approach:**
```javascript
// Step 1: Look up the ticket
read_help_scout({ name: "searchConversations", arguments: { conversationNumber: 42839 } })

// Step 2: Full customer profile
read_help_scout({ name: "getCustomer", arguments: { customerId: "<customer.id from step 1>" } })

// Step 3: All their conversations
read_help_scout({
  name: "searchConversations",
  arguments: { customerIds: [12345], sort: "createdAt", order: "desc" }
})

// Step 4 (optional): Org context
read_help_scout({ name: "getOrganization", arguments: { organizationId: "<from step 2>" } })
```

---

## Scenario 13: Metrics and Knowledge Base

**User:** "How was support volume last month?" or "What do our docs say about X?"

**Approach:**
```javascript
// Reports: getCompanyReport, getConversationsReport, getProductivityReport,
// getUserReport, getHappinessReport, getChannelReport, getDocsReport
read_help_scout({
  name: "getConversationsReport",
  arguments: { start: "2026-06-01T00:00:00Z", end: "2026-07-01T00:00:00Z" }
})

// Docs: searchDocsArticles for content, then getDocsArticle for the full text.
// Browse with listDocsSites -> listDocsCollections -> listDocsArticles.
read_help_scout({ name: "searchDocsArticles", arguments: { query: "SSO setup" } })
```

Unsure of names or arguments? `search_help_scout("happiness report")` then `describe_help_scout` on the match.

---

## Decision Tree Summary

```
START
  │
  ├─ Unsure which operation exists?
  │   └─ YES → search_help_scout(query: "<intent>"), then describe_help_scout()
  │
  ├─ Do you know the exact ticket number?
  │   └─ YES → searchConversations({ conversationNumber: X })
  │
  ├─ Is the user asking about a specific inbox?
  │   └─ YES → Use the inbox ID from server instructions (no lookup call)
  │
  ├─ Searching or listing conversations? (keywords, email, domain, tag,
  │  status, dates, assignee, folder, customer)
  │   └─ YES → searchConversations() with convenience filters
  │            (defaults to active + pending + closed)
  │
  ├─ Need full conversation details?
  │   ├─ Quick overview → getConversationSummary()
  │   ├─ Full thread → getThreads()
  │   └─ Raw object / source / files → getConversation(), getOriginalSource(),
  │        getAttachment(), downloadAttachmentFile()
  │
  ├─ Looking up a customer by email?
  │   └─ YES → searchCustomersByEmail()
  │
  ├─ Need customer profile or contact details?
  │   └─ YES → getCustomer() or getCustomerContacts() (need customer ID)
  │
  ├─ Investigating an organization/account?
  │   └─ YES → listOrganizations() → getOrganization() → getOrganizationMembers()
  │
  ├─ People, tags, or workspace metadata?
  │   └─ YES → listUsers(), getUser(), listTeams(), getTeamMembers(), listTags(),
  │            listSavedReplies(), getSavedReply(), listWorkflows(), listWebhooks()
  │
  ├─ Metrics or ratings?
  │   └─ YES → get*Report operations, getSatisfactionRating()
  │
  ├─ Knowledge base?
  │   └─ YES → searchDocsArticles(), getDocsArticle(), listDocsSites(), ...
  │
  └─ (end; every operation runs via read_help_scout, all read-only)
```

---

## Performance Tips

1. **Start narrow, expand if needed**
   - Begin with specific inbox/timeframe
   - Widen search only if results are insufficient

2. **Use pagination for large results**
   - Walk `page` with a higher `limit` (max 200)
   - Process in batches for memory efficiency

3. **Batch your describes**
   - `describe_help_scout` accepts up to 10 names per call
   - Describe the whole workflow's operations at once

4. **Trust the defaults**
   - `searchConversations` already covers active + pending + closed
   - Inbox IDs are already in the server instructions
