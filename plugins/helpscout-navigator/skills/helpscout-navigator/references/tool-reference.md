# HelpScout MCP Tool Reference

Complete parameter documentation for all 17 HelpScout MCP tools.

---

## 1. searchInboxes

**Purpose:** Get inbox ID from name. ALWAYS call this first when user mentions an inbox.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | - | Inbox name to search for (case-insensitive) |
| `limit` | number | no | 50 | Max results (1-100) |
| `cursor` | string | no | - | Pagination cursor |

**Returns:** Array of inbox objects with `id` (numeric), `name`, `email`, timestamps

**Example:**
```javascript
searchInboxes({ query: "support" })
// Returns: [{ id: 359402, name: "Support", email: "support@company.com" }]
```

---

## 2. listAllInboxes

**Purpose:** List all available inboxes. Quick helper for discovery.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | no | 100 | Max results (1-100) |

**Returns:** Array of all inbox objects

**Example:**
```javascript
listAllInboxes({ limit: 50 })
```

---

## 3. searchConversations

**Purpose:** List tickets by time/status. Simple listing without keywords.

**WARNING:** When `query` or `tag` is provided without explicit `status`, defaults to "active" only! Use `comprehensiveConversationSearch` for keyword searches across all statuses.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | no | - | HelpScout query syntax (body, subject, email) |
| `status` | string | no | * | active, pending, closed, spam (**NOT** "all" - use `structuredConversationFilter` for all statuses) |
| `inboxId` | string | no | - | Scope to specific inbox (numeric ID as string) |
| `tag` | string | no | - | Filter by tag name |
| `createdAfter` | string | no | - | ISO8601 date |
| `createdBefore` | string | no | - | ISO8601 date** |
| `sort` | string | no | "createdAt" | createdAt, updatedAt, number |
| `order` | string | no | "desc" | asc, desc |
| `limit` | number | no | 50 | Max results (1-100) |
| `cursor` | string | no | - | Pagination cursor |
| `fields` | array | no | - | Specific fields to return (partial response) |

*Status default: "active" when query/tag provided; all statuses otherwise

**createdBefore is filtered client-side (HelpScout API limitation) - pagination totals may not reflect filtered results

**When to use:**
- Listing recent tickets (no keyword search)
- Filtering by explicit status
- Time-based queries

**When NOT to use:**
- Keyword searches (use `comprehensiveConversationSearch`)
- Finding tickets across all statuses (use `structuredConversationFilter` with `sortBy: "waitingSince"` and `status: "all"`)
- **NEVER** use `status: "all"` with this tool - it only accepts active/pending/closed/spam

**Example:**
```javascript
searchConversations({
  inboxId: "359402",
  status: "active",
  sort: "createdAt",
  order: "desc",
  limit: 20
})
```

---

## 4. comprehensiveConversationSearch

**Purpose:** Keyword search across all statuses. PREFERRED for content searches.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `searchTerms` | string[] | yes | - | Keywords to search (OR combined) |
| `inboxId` | string | no | - | Scope to specific inbox |
| `statuses` | string[] | no | ["active","pending","closed"] | Statuses to search |
| `searchIn` | string[] | no | ["both"] | body, subject, or both |
| `timeframeDays` | number | no | 60 | Days back to search (1-365) |
| `createdAfter` | string | no | - | Override timeframeDays |
| `createdBefore` | string | no | - | End date |
| `limitPerStatus` | number | no | 25 | Results per status (1-100) |
| `includeVariations` | boolean | no | true | Include term variations |

**Why this is preferred:**
- Searches all statuses by default
- Returns organized results grouped by status
- Executes parallel searches for performance

**Note:** `createdBefore` is filtered client-side (API limitation) - pagination totals may not reflect filtered results.

**Example:**
```javascript
comprehensiveConversationSearch({
  searchTerms: ["billing", "refund"],
  inboxId: "359402",
  timeframeDays: 30
})
```

---

## 5. advancedConversationSearch

**Purpose:** Complex filters with email domains, tags, and boolean logic.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `emailDomain` | string | no | - | Filter by domain (e.g., "company.com") |
| `customerEmail` | string | no | - | Exact email match |
| `contentTerms` | string[] | no | - | Search in body (OR combined) |
| `subjectTerms` | string[] | no | - | Search in subject (OR combined) |
| `tags` | string[] | no | - | Tag names (OR combined) |
| `inboxId` | string | no | - | Scope to inbox |
| `status` | string | no | - | active, pending, closed, spam |
| `createdAfter` | string | no | - | ISO8601 date |
| `createdBefore` | string | no | - | ISO8601 date |
| `limit` | number | no | 50 | Max results (1-100) |

**Use cases:**
- "Find all tickets from @acme.com"
- "Tickets with urgent AND billing tags"
- "Separate content and subject searches"

**Note:** `createdBefore` is filtered client-side (API limitation).

**Example:**
```javascript
advancedConversationSearch({
  emailDomain: "acme.com",
  tags: ["urgent"],
  status: "active"
})
```

---

## 6. structuredConversationFilter

**Purpose:** ID-based lookups and ticket number queries. Use AFTER discovery.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `conversationNumber` | number | no | - | Direct ticket # lookup |
| `assignedTo` | number | no | - | User ID (-1 for unassigned) |
| `customerIds` | number[] | no | - | Customer IDs (max 100) |
| `folderId` | number | no | - | Folder ID |
| `inboxId` | string | no | - | Inbox ID |
| `tag` | string | no | - | Tag name |
| `status` | string | no | "all" | active, pending, closed, spam, all |
| `sortBy` | string | no | "createdAt" | See options below |
| `sortOrder` | string | no | "desc" | asc, desc |
| `createdAfter` | string | no | - | ISO8601 date |
| `createdBefore` | string | no | - | ISO8601 date |
| `modifiedSince` | string | no | - | ISO8601 date |
| `limit` | number | no | 50 | Max results (1-100) |
| `cursor` | string | no | - | Pagination |

**Sort options:** createdAt, modifiedAt, number, waitingSince, customerName, customerEmail, mailboxId, status, subject

**REQUIREMENT:** Must provide at least ONE of these unique fields:
- `conversationNumber` (direct ticket lookup)
- `assignedTo` (user ID or -1 for unassigned)
- `folderId`
- `customerIds`
- `sortBy` with unique value: `waitingSince`, `customerName`, or `customerEmail`

**Without a unique field, this tool will fail.** Use `comprehensiveConversationSearch` for content-based searches.

**Note:** `createdBefore` is filtered client-side (API limitation) - pagination totals may not reflect filtered results.

**Example:**
```javascript
// Direct ticket lookup
structuredConversationFilter({ conversationNumber: 42839 })

// Customer history
structuredConversationFilter({
  customerIds: [12345],
  sortBy: "createdAt",
  sortOrder: "desc"
})

// List ALL recent tickets (all statuses)
// This is how you get status: "all" - requires unique sortBy
structuredConversationFilter({
  sortBy: "waitingSince",  // Required: unique sortBy enables status: "all"
  status: "all",
  sortOrder: "desc",
  limit: 50
})
```

---

## 7. getConversationSummary

**Purpose:** Quick overview with first customer message + latest staff reply.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `conversationId` | string | yes | - | Numeric conversation ID from search results |

**Returns:**
- Conversation metadata
- First customer message
- Latest staff reply

**Note:** Content is visible by default. Set `REDACT_MESSAGE_CONTENT=true` to redact message bodies for privacy.

**Example:**
```javascript
getConversationSummary({ conversationId: "12345678" })
```

---

## 8. getThreads

**Purpose:** Full message history for a conversation.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `conversationId` | string | yes | - | Numeric conversation ID from search results |
| `limit` | number | no | 200 | Max threads (1-200) |
| `cursor` | string | no | - | Pagination |

**Returns:** All threads with metadata, source info, creator/customer details

**Note:** Content is visible by default. Set `REDACT_MESSAGE_CONTENT=true` for privacy.

**Example:**
```javascript
getThreads({ conversationId: "12345678", limit: 200 })
```

---

## 9. getServerTime

**Purpose:** Get current server timestamp for time-relative calculations.

**Parameters:** None

**Returns:**
```javascript
{
  isoTime: "2024-01-15T10:30:00Z",
  unixTime: 1705315800
}
```

**Use case:** Reference for time-relative searches, debugging timestamp issues.

---

## 10. listCustomers

**Purpose:** Browse and search customers by name, query syntax, or modification date. Page-based pagination (v2 API).

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `firstName` | string | no | - | Filter by first name |
| `lastName` | string | no | - | Filter by last name |
| `query` | string | no | - | Advanced query syntax |
| `mailbox` | number | no | - | Filter by mailbox ID |
| `modifiedSince` | string | no | - | ISO 8601 date |
| `page` | number | no | 1 | Page number |
| `sortField` | enum | no | createdAt | createdAt, firstName, lastName, modifiedAt |
| `sortOrder` | enum | no | desc | asc, desc |

**Returns:** Array of customer objects with id, name, org, email, conversationCount

**Example:**
```javascript
listCustomers({ firstName: "Jane", sortField: "createdAt", sortOrder: "desc" })
```

---

## 11. searchCustomersByEmail

**Purpose:** Find a customer by exact email address using v3 API with cursor pagination.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `email` | string | yes | - | Exact email address to search |
| `firstName` | string | no | - | Filter by first name |
| `lastName` | string | no | - | Filter by last name |
| `query` | string | no | - | Advanced query syntax |
| `createdSince` | string | no | - | ISO 8601 date |
| `modifiedSince` | string | no | - | ISO 8601 date |
| `cursor` | string | no | - | Pagination cursor |

**Returns:** Array of customer objects matching the email

**Example:**
```javascript
searchCustomersByEmail({ email: "jane@acme.com" })
```

---

## 12. getCustomer

**Purpose:** Get a full customer profile by ID. Returns profile with embedded contact details (emails, phones, chats, social profiles, websites) plus address from a separate lookup.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `customerId` | string | yes | - | Numeric customer ID |

**Returns:** Customer object with full profile, embedded contacts, address

**Example:**
```javascript
getCustomer({ customerId: "12345" })
```

---

## 13. getCustomerContacts

**Purpose:** Get all contact channels for a customer: emails, phones, chats, social profiles, websites, and address. Calls 6 sub-resource endpoints in parallel.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `customerId` | string | yes | - | Numeric customer ID |

**Returns:** Object with emails, phones, chats, socialProfiles, websites, address arrays

**Example:**
```javascript
getCustomerContacts({ customerId: "12345" })
```

---

## 14. listOrganizations

**Purpose:** Browse all organizations with sorting options. Returns 50 per page.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | no | 1 | Page number |
| `sortField` | enum | no | lastInteractionAt | name, customerCount, conversationCount, lastInteractionAt |
| `sortOrder` | enum | no | desc | asc, desc |

**Returns:** Array of organization objects with id, name, domains, counts

**Example:**
```javascript
listOrganizations({ sortField: "conversationCount", sortOrder: "desc" })
```

---

## 15. getOrganization

**Purpose:** Get an organization by ID with optional customer/conversation counts.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `organizationId` | string | yes | - | Numeric organization ID |
| `includeCounts` | boolean | no | true | Include customer/conversation counts |
| `includeProperties` | boolean | no | false | Include custom properties |

**Returns:** Organization object with full profile and optional counts

**Example:**
```javascript
getOrganization({ organizationId: "456", includeCounts: true })
```

---

## 16. getOrganizationMembers

**Purpose:** Get all customers belonging to an organization. 50 per page.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `organizationId` | string | yes | - | Numeric organization ID |
| `page` | number | no | 1 | Page number |

**Returns:** Array of customer objects in the organization

**Example:**
```javascript
getOrganizationMembers({ organizationId: "456" })
```

---

## 17. getOrganizationConversations

**Purpose:** Get all conversations associated with an organization. 50 per page.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `organizationId` | string | yes | - | Numeric organization ID |
| `page` | number | no | 1 | Page number |

**Returns:** Array of conversation summary objects (id, number, subject, status, dates, tags)

**Example:**
```javascript
getOrganizationConversations({ organizationId: "456" })
```
