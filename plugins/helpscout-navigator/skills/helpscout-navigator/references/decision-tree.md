# HelpScout Tool Decision Tree

Expanded decision logic for complex search scenarios.

---

## Scenario 1: Multi-Inbox Search

**User:** "Search all inboxes for tickets about API issues"

**Approach:**
```javascript
// Option A: Search without inbox filter (searches all)
comprehensiveConversationSearch({
  searchTerms: ["API", "api error", "integration"]
})

// Option B: Get all inboxes and search each
const inboxes = listAllInboxes();
for (const inbox of inboxes) {
  comprehensiveConversationSearch({
    searchTerms: ["API"],
    inboxId: inbox.id
  });
}
```

**When to use Option B:**
- Need results grouped by inbox
- Different search terms per inbox
- Reporting on inbox-specific metrics

---

## Scenario 2: List All Recent Tickets (All Statuses)

**User:** "Show me recent tickets" (no specific status mentioned)

**Key insight:** `searchConversations` does NOT support `status: "all"`. You must use `structuredConversationFilter`.

**Approach:**
```javascript
// CORRECT: Use structuredConversationFilter with unique sortBy
structuredConversationFilter({
  sortBy: "waitingSince",  // Required: unique sortBy enables status: "all"
  status: "all",
  sortOrder: "desc",
  limit: 50,
  createdAfter: "2024-01-01T00:00:00Z"  // Optional: date filter
})

// WRONG: This will error!
// searchConversations({ status: "all" })
// Error: Invalid enum value. Expected 'active' | 'pending' | 'closed' | 'spam', received 'all'
```

**Why unique sortBy is required:**
The `structuredConversationFilter` tool requires at least one "unique field" to work. Using `sortBy: "waitingSince"` (or `customerName` or `customerEmail`) satisfies this requirement and allows `status: "all"`.

---

## Scenario 3: Date-Range Filtering

**User:** "Find tickets from Q4 2023"

**Approach:**
```javascript
// For listing tickets by date range (single status)
searchConversations({
  createdAfter: "2023-10-01T00:00:00Z",
  createdBefore: "2024-01-01T00:00:00Z",
  status: "closed"  // Must specify: active, pending, closed, or spam (NOT "all")
})

// For listing tickets by date range (ALL statuses)
structuredConversationFilter({
  sortBy: "waitingSince",  // Required for status: "all"
  status: "all",
  createdAfter: "2023-10-01T00:00:00Z",
  createdBefore: "2024-01-01T00:00:00Z"
})

// For finding tickets by keyword within date range
comprehensiveConversationSearch({
  searchTerms: ["billing", "refund"],
  createdAfter: "2023-10-01T00:00:00Z",
  createdBefore: "2024-01-01T00:00:00Z"
})
```

**For time-relative queries:**
```javascript
// "Last 7 days" - listing without keywords
searchConversations({
  createdAfter: getServerTime() - 7 days,  // Calculate ISO date
  status: "active"
})

// "Last 7 days" - searching for keywords
comprehensiveConversationSearch({
  searchTerms: ["urgent"],
  timeframeDays: 7
})
```

**Note:** HelpScout API does not support wildcards. Use `searchConversations` for listing and `comprehensiveConversationSearch` for keyword search.

---

## Scenario 4: Customer History

**User:** "Show all tickets from customer@example.com"

**Approach:**
```javascript
// Step 1: Find customer using advanced search
const results = advancedConversationSearch({
  customerEmail: "customer@example.com"
});

// Step 2: Get customer ID from results
const customerId = results[0].customer.id;

// Step 3: Get full history with structuredConversationFilter
structuredConversationFilter({
  customerIds: [customerId],
  sortBy: "createdAt",
  sortOrder: "desc",
  status: "all"
})
```

**For domain-wide search:**
```javascript
advancedConversationSearch({
  emailDomain: "example.com"
})
```

---

## Scenario 5: Assignee-Based Filtering

**User:** "Show John's open tickets"

**Approach:**
```javascript
// Step 1: Need John's user ID
// This typically comes from user list or prior conversation data

// Step 2: Filter by assignee
structuredConversationFilter({
  assignedTo: 12345,  // John's user ID
  status: "active",
  sortBy: "waitingSince",  // Unique to this tool
  sortOrder: "asc"  // Longest waiting first
})
```

**For unassigned tickets:**
```javascript
structuredConversationFilter({
  assignedTo: -1,  // Special value for unassigned
  status: "active"
})
```

---

## Scenario 6: Tag-Based Search

**User:** "Find all tickets tagged 'urgent' or 'escalated'"

**Approach:**
```javascript
// Option A: Using advancedConversationSearch (OR logic)
advancedConversationSearch({
  tags: ["urgent", "escalated"]  // OR combined
})

// Option B: Multiple searches for AND logic
const urgentResults = advancedConversationSearch({
  tags: ["urgent"]
});
const escalatedResults = advancedConversationSearch({
  tags: ["escalated"]
});
// Combine results
```

**For tag + content search:**
```javascript
advancedConversationSearch({
  tags: ["urgent"],
  contentTerms: ["billing", "payment"]
})
```

---

## Scenario 7: Folder-Based Queries

**User:** "Show tickets in the 'Needs Follow-up' folder"

**Approach:**
```javascript
// Note: Folder IDs are visible in HelpScout UI URL
// e.g., helpscout.net/mailbox/12345/folder/67890
structuredConversationFilter({
  folderId: 67890,
  sortBy: "modifiedAt",
  sortOrder: "desc"
})
```

---

## Scenario 8: Conversation Deep Dive

**User:** "Tell me everything about ticket #42839"

**Approach:**
```javascript
// Step 1: Get conversation by number
const conv = structuredConversationFilter({
  conversationNumber: 42839
});
const conversationId = conv[0].id;

// Step 2: Get summary (first + latest messages)
getConversationSummary({ conversationId });

// Step 3: Get full thread if needed
getThreads({ conversationId, limit: 200 });
```

---

## Scenario 9: Status Transitions

**User:** "Find recently closed tickets that were open for more than a week"

**Approach:**
```javascript
// Step 1: Get recently closed tickets
const closed = searchConversations({
  status: "closed",
  sort: "updatedAt",  // Recently closed = recently updated
  order: "desc",
  limit: 100
});

// Step 2: Filter by duration (in your code)
// Check createdAt vs closedAt difference
```

---

## Scenario 10: Customer Lookup by Email

**User:** "Find the customer with email jane@acme.com"

**Approach:**
```javascript
// Step 1: Search by email (v3 API, exact match)
searchCustomersByEmail({ email: "jane@acme.com" })
// Returns: [{ id: 12345, firstName: "Jane", lastName: "Doe", organizationId: 456 }]

// Step 2: Get full profile with contacts
getCustomer({ customerId: "12345" })
// Returns: full profile with _embedded.emails, phones, chats, etc.

// Step 3 (optional): Get all contact channels
getCustomerContacts({ customerId: "12345" })
// Returns: emails, phones, chats, socialProfiles, websites, address
```

**When to use `searchCustomersByEmail` vs `listCustomers`:**
- `searchCustomersByEmail` - exact email match, v3 API, cursor pagination
- `listCustomers` - name search, advanced query syntax, v2 API, page pagination

**When NOT to use for customer lookup:**
- Don't use `advancedConversationSearch(customerEmail: "...")` to find customers. That searches conversations, not the customer directory.

---

## Scenario 11: Organization Account Review

**User:** "Show me the Acme Corp account and all their support history"

**Approach:**
```javascript
// Step 1: Find the organization
listOrganizations({ sortField: "name", sortOrder: "asc" })
// Paginate if needed until you find "Acme Corp"

// Step 2: Get organization details with counts
getOrganization({ organizationId: "456", includeCounts: true })
// Returns: name, domains, customerCount, conversationCount

// Step 3: See who is in the org
getOrganizationMembers({ organizationId: "456" })
// Returns: all customers belonging to this org (50 per page)

// Step 4: See their support history
getOrganizationConversations({ organizationId: "456" })
// Returns: all conversations for this org (50 per page)

// Step 5 (optional): Deep dive into a specific conversation
getConversationSummary({ conversationId: "<id from step 4>" })
getThreads({ conversationId: "<id from step 4>" })
```

**Full traversal pattern:**
Organization -> Members -> Pick a member -> getCustomer -> Their conversations -> Thread details

---

## Scenario 12: Customer History from Conversation

**User:** "Who is the customer on ticket #42839 and what's their full history?"

**Approach:**
```javascript
// Step 1: Look up the ticket
structuredConversationFilter({ conversationNumber: 42839 })
// Get the customer ID from the result

// Step 2: Get full customer profile
getCustomer({ customerId: "<customer.id from step 1>" })
// Returns: profile with organizationId, contact details

// Step 3: Get all their conversations
structuredConversationFilter({
  customerIds: [<customer.id>],
  status: "all",
  sortBy: "createdAt",
  sortOrder: "desc"
})

// Step 4 (optional): See their org context
getOrganization({ organizationId: "<from step 2>" })
getOrganizationMembers({ organizationId: "<from step 2>" })
```

---

## Decision Tree Summary

```
START
  │
  ├─ Do you know the exact ticket number?
  │   └─ YES → structuredConversationFilter({ conversationNumber: X })
  │
  ├─ Is the user asking about a specific inbox?
  │   └─ YES → searchInboxes() FIRST, then continue
  │
  ├─ Are you searching by keywords/content?
  │   └─ YES → comprehensiveConversationSearch()
  │
  ├─ Are you filtering by email domain or complex tags?
  │   └─ YES → advancedConversationSearch()
  │
  ├─ Are you filtering by assignee, customer ID, or folder?
  │   └─ YES → structuredConversationFilter() (need IDs first)
  │
  ├─ Listing tickets across ALL statuses?
  │   └─ YES → structuredConversationFilter({ sortBy: "waitingSince", status: "all" })
  │            (searchConversations does NOT support status: "all"!)
  │
  ├─ Just listing recent tickets by SINGLE status/time?
  │   └─ YES → searchConversations() (status: active, pending, closed, OR spam)
  │
  ├─ Need full conversation details?
  │   ├─ Quick overview → getConversationSummary()
  │   └─ Full thread → getThreads()
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
  └─ (end)
```

---

## Performance Tips

1. **Start narrow, expand if needed**
   - Begin with specific inbox/timeframe
   - Widen search only if results are insufficient

2. **Use pagination for large results**
   - Always check for `nextCursor` in responses
   - Process in batches for memory efficiency

3. **Leverage includeVariations**
   - Helps catch related terms automatically
   - Reduces need for manual term expansion

4. **Cache inbox IDs**
   - Inbox IDs rarely change
   - Store after first lookup to avoid repeated calls
