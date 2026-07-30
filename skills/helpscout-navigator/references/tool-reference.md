# Help Scout MCP Tool Reference

Core workflow reference for the most common Help Scout MCP tools.

As of v2.0.0 the server advertises three tools (`search_help_scout`, `describe_help_scout`, `read_help_scout`) over a registry of 55 read operations. Discover operations with `search_help_scout`, load schemas with `describe_help_scout`, and execute with `read_help_scout`. Operation names in the current registry still dispatch directly for compatibility; names consolidated away in v2.0.0 (searchInboxes, comprehensiveConversationSearch, structuredConversationFilter, advancedConversationSearch) do not, and their capabilities live in `listAllInboxes` and `searchConversations`. New work should go through the gateway.

v2.1.0 adds an optional fourth tool, `write_help_scout`, advertised only when the operator enabled writes. See [Write Operations](#write-operations). Write operation names never dispatch directly.

---

## 1. searchConversations

**Purpose:** The single conversation search and list operation. Handles keyword search, listing, ticket-number lookup, and every filter combination.

**Default:** Searches active + pending + closed (spam excluded). No status parameter needed for complete results.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `contentTerms` | string[] | no | - | Match terms in message body (OR combined) |
| `subjectTerms` | string[] | no | - | Match terms in subject (OR combined) |
| `email` | string | no | - | Conversations involving this email (to/cc/bcc or customer) |
| `emailDomain` | string | no | - | Conversations involving any email at this domain |
| `customerIds` | number[] | no | - | Conversations belonging to these customer IDs |
| `hasAttachments` | boolean | no | - | Only conversations with attachments |
| `conversationNumber` | number | no | - | Direct ticket # lookup |
| `assignedTo` | number | no | - | Assignee user ID (-1 for unassigned) |
| `inboxId` | string | no | - | Inbox ID from server instructions |
| `folderId` | number | no | - | Filter by folder ID |
| `tag` | string | no | - | Tag name (comma-separated for multiple) |
| `status` | string | no | * | active, pending, closed, open, spam, all |
| `createdAfter` | string | no | - | ISO8601 date |
| `createdBefore` | string | no | - | ISO8601 date |
| `modifiedSince` | string | no | - | ISO8601 date |
| `sort` | string | no | "createdAt" | createdAt, modifiedAt, number, waitingSince, customerName, customerEmail, mailboxid, status, subject, score |
| `order` | string | no | "desc" | asc, desc |
| `limit` | number | no | 50 | Max results (1-200) |
| `page` | number | no | 1 | Page number |
| `query` | string | no | - | Raw HelpScout query syntax (power users); convenience filters compile into this |
| `fields` | array | no | - | Specific fields to return (partial response) |

*Status default: active + pending + closed. Pass `status: "all"` to include spam, or a single status to narrow.

**Examples:**
```javascript
// Keyword search (all working statuses by default)
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["billing", "refund"], inboxId: "359402" }
})

// List recent tickets
read_help_scout({
  name: "searchConversations",
  arguments: { inboxId: "359402", sort: "createdAt", order: "desc", limit: 20 }
})

// Direct ticket lookup
read_help_scout({ name: "searchConversations", arguments: { conversationNumber: 42839 } })

// Customer history
read_help_scout({
  name: "searchConversations",
  arguments: { customerIds: [12345], sort: "createdAt", order: "desc" }
})

// Domain + tag filter
read_help_scout({
  name: "searchConversations",
  arguments: { emailDomain: "acme.com", tag: "urgent", status: "active" }
})
```

---

## 2. getConversation

**Purpose:** Get the raw Help Scout conversation object by ID. Use `getThreads` instead when you need paginated full message history.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `conversationId` | string | yes | - | The conversation ID |
| `embed` | string | no | - | "threads" to embed threads in the same call |
| `includeSystemActors` | boolean | no | false | Route via v3 to distinguish user, team, and system_user person types |

**Example:**
```javascript
read_help_scout({ name: "getConversation", arguments: { conversationId: "12345678", embed: "threads" } })
```

---

## 3. getConversationSummary

**Purpose:** Quick overview with first customer message + latest staff reply.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `conversationId` | string | yes | - | Numeric conversation ID from search results |

**Returns:** Conversation metadata, first customer message, latest staff reply.

**Note:** Content is visible by default. Set `REDACT_MESSAGE_CONTENT=true` to replace message bodies with placeholders.

**Example:**
```javascript
read_help_scout({ name: "getConversationSummary", arguments: { conversationId: "12345678" } })
```

---

## 4. getThreads

**Purpose:** Full message history for a conversation.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `conversationId` | string | yes | - | Numeric conversation ID from search results |
| `limit` | number | no | 200 | Max threads (1-200) |
| `page` | number | no | 1 | Page number |
| `includeSystemActors` | boolean | no | false | Route via v3 to distinguish user, team, and system_user person types |

**Returns:** All threads with metadata, source info, creator/customer details.

**Note:** Content is visible by default. Set `REDACT_MESSAGE_CONTENT=true` to replace message bodies with placeholders.

**Example:**
```javascript
read_help_scout({ name: "getThreads", arguments: { conversationId: "12345678", limit: 200 } })
```

---

## 5. getServerTime

**Purpose:** Get current server timestamp. Call before date-relative searches ("last week", "past 30 days") to calculate time ranges.

**Parameters:** None

**Returns:**
```javascript
{
  isoTime: "2026-07-28T10:30:00Z",
  unixTime: 1785321000
}
```

**Example:**
```javascript
read_help_scout({ name: "getServerTime", arguments: {} })
```

---

## 6. listAllInboxes

**Purpose:** List inboxes with IDs, optionally filtered by name. Usually unnecessary: inboxes are auto-discovered at connect and listed with their IDs in the server instructions. Only call this if inboxes changed mid-session.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `nameContains` | string | no | - | Case-insensitive name substring filter |
| `limit` | number | no | 100 | Max results (1-100) |

**Returns:** Array of inbox objects with `id` (numeric), `name`, `email`, timestamps

**Example:**
```javascript
read_help_scout({ name: "listAllInboxes", arguments: { nameContains: "support" } })
// Returns: [{ id: 359402, name: "Support", email: "support@company.com" }]
```

---

## 7. getInbox

**Purpose:** Get one inbox with optional sub-resources fanned out in a single call.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inboxId` | string | yes | - | Inbox ID from server instructions |
| `include` | string[] | no | - | Any of "fields" (custom fields), "folders" (folder IDs and counts), "routing" |

**Example:**
```javascript
read_help_scout({ name: "getInbox", arguments: { inboxId: "359402", include: ["fields", "folders", "routing"] } })
```

---

## 8. listCustomers

**Purpose:** Browse and search customers by name, query syntax, or dates. Defaults to v2 page-based pagination; set `useV3` (or pass a `cursor`) for the v3 API with cursor pagination, which also enables the `email` and `createdSince` filters.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `firstName` | string | no | - | Filter by first name |
| `lastName` | string | no | - | Filter by last name |
| `query` | string | no | - | Advanced query syntax |
| `mailbox` | number | no | - | Filter by inbox ID (v2 path only) |
| `modifiedSince` | string | no | - | ISO 8601 date |
| `sortField` | enum | no | createdAt | createdAt, firstName, lastName, modifiedAt (v2 path only) |
| `sortOrder` | enum | no | desc | asc, desc (v2 path only) |
| `page` | number | no | 1 | Page number (v2 path, 50 per page) |
| `useV3` | boolean | no | false | Route to the v3 endpoint (cursor pagination) |
| `cursor` | string | no | - | v3 pagination cursor; supplying it forces the v3 path |
| `email` | string | no | - | Filter by email (v3 path only) |
| `createdSince` | string | no | - | ISO 8601 date (v3 path only) |

**Example:**
```javascript
read_help_scout({ name: "listCustomers", arguments: { firstName: "Jane", sortField: "createdAt", sortOrder: "desc" } })
```

---

## 9. searchCustomersByEmail

**Purpose:** Find a customer by exact email address using the v3 API with cursor pagination.

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
read_help_scout({ name: "searchCustomersByEmail", arguments: { email: "jane@acme.com" } })
```

---

## 10. getCustomer

**Purpose:** Get a full customer profile by ID. Returns profile with embedded contact details (emails, phones, chats, social profiles, websites) plus address from a separate lookup.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `customerId` | string | yes | - | Numeric customer ID |

**Example:**
```javascript
read_help_scout({ name: "getCustomer", arguments: { customerId: "12345" } })
```

---

## 11. getCustomerContacts

**Purpose:** Get all contact channels for a customer: emails, phones, chats, social profiles, websites, and address. Calls the sub-resource endpoints in parallel; this single operation covers every contact sub-resource.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `customerId` | string | yes | - | Numeric customer ID |

**Returns:** Object with emails, phones, chats, socialProfiles, websites, address arrays

**Example:**
```javascript
read_help_scout({ name: "getCustomerContacts", arguments: { customerId: "12345" } })
```

---

## 12. listOrganizations

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
read_help_scout({ name: "listOrganizations", arguments: { sortField: "conversationCount", sortOrder: "desc" } })
```

---

## 13. getOrganization

**Purpose:** Get an organization by ID with optional customer/conversation counts.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `organizationId` | string | yes | - | Numeric organization ID |
| `includeCounts` | boolean | no | true | Include customer/conversation counts |
| `includeProperties` | boolean | no | false | Include custom properties |

**Example:**
```javascript
read_help_scout({ name: "getOrganization", arguments: { organizationId: "456", includeCounts: true } })
```

---

## 14. getOrganizationMembers

**Purpose:** Get all customers belonging to an organization. 50 per page.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `organizationId` | string | yes | - | Numeric organization ID |
| `page` | number | no | 1 | Page number |

**Example:**
```javascript
read_help_scout({ name: "getOrganizationMembers", arguments: { organizationId: "456" } })
```

---

## 15. getOrganizationConversations

**Purpose:** Get all conversations associated with an organization. 50 per page.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `organizationId` | string | yes | - | Numeric organization ID |
| `page` | number | no | 1 | Page number |

**Returns:** Array of conversation summary objects (id, number, subject, status, dates, tags)

**Example:**
```javascript
read_help_scout({ name: "getOrganizationConversations", arguments: { organizationId: "456" } })
```

---

## Write Operations

Present only when the operator set `HELPSCOUT_ENABLE_WRITES=true`. On a read-only install these names come back as unknown operations, exactly like a name that does not exist. Discover them with `search_help_scout` (results are labeled `write (<mutationClass>)`), load schemas with `describe_help_scout` (which also reports `mutationClass` and `tier`), and execute with `write_help_scout`.

Every operation targets one conversation and takes `conversationId` as a numeric string.

### Tier 1: `HELPSCOUT_ENABLE_WRITES`

No tier-1 operation notifies a customer, and none accepts a parameter that would make it do so.

| Operation | Class | Arguments beyond `conversationId` | Notes |
|-----------|-------|-----------------------------------|-------|
| `createNote` | nonDestructive | `text` | Internal note, teammates only. No delete endpoint exists. |
| `createDraftReply` | nonDestructive | `text`, optional `customerId`/`customerEmail`, `assignTo`, `cc`, `bcc` | Saved unsent. Cannot send. The primary customer is resolved when none is named. |
| `updateConversationStatus` | reversible | `status` (active, closed, pending) | Reverse by setting the previous status. |
| `assignConversation` | reversible | `userId` | User IDs come from `listUsers`. |
| `unassignConversation` | reversible | none | Reverse with `assignConversation`. |
| `addConversationTags` | reversible | `tags` | Reads current tags and sends the merged list. |
| `removeConversationTags` | reversible | `tags` | Case-insensitive match; keeps the rest. |
| `updateConversationFields` | reversible | `fields` (`[{ id, value }]`) | Field IDs come from `getInbox` `include: ["fields"]`. Unlisted fields are preserved. |
| `snoozeConversation` | reversible | `snoozedUntil` (future ISO 8601), optional `unsnoozeOnCustomerReply` | Each call replaces any previous snooze. |
| `unsnoozeConversation` | reversible | none | Wakes the conversation immediately. |
| `moveConversation` | reversible | `mailboxId` | Inbox IDs come from `listAllInboxes`. |

### Tier 2: also `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES`

Both email the customer and cannot be recalled. Both require `confirm`, `confirmOperation`, and `targetId` on every call.

| Operation | Class | Arguments beyond `conversationId` | Notes |
|-----------|-------|-----------------------------------|-------|
| `sendReply` | externallyVisible | `text`, optional `customerId`/`customerEmail`, `assignTo`, `status`, `cc`, `bcc` | Emails immediately. |
| `publishDraft` | externallyVisible | none | Clears the draft flag, sending the pending reply. |

### Envelope fields

`confirm`, `confirmOperation`, `targetId`, and `dryRun` are siblings of `arguments`, never inside it. A misplaced one is refused rather than ignored.

```javascript
// Tier 1: no confirmation needed
write_help_scout({
  name: "addConversationTags",
  arguments: { conversationId: "12345678", tags: ["escalated"] }
})

// Preview without contacting Help Scout
write_help_scout({
  name: "updateConversationStatus",
  arguments: { conversationId: "12345678", status: "closed" },
  dryRun: true
})

// Tier 2: confirmation required on every call
write_help_scout({
  name: "sendReply",
  arguments: { conversationId: "12345678", text: "Thanks for your patience..." },
  confirm: true,
  confirmOperation: "sendReply",
  targetId: "12345678"
})
```

Results carry `operation`, `mutationClass`, `target`, `status`, `result`, and a `cleanup` block naming how to undo the change. Most Help Scout mutation endpoints answer with no body, so the result names the read that confirms the new state.

---

## Beyond This Reference

The registry also covers tags, users, teams, saved replies, attachments, original email source, workflows, webhooks, satisfaction ratings, 7 report operations, and 15 Docs operations. Discover them with `search_help_scout` and load their schemas with `describe_help_scout` (up to 10 names per call).
