Here is a **fully MCP-compliant PRD** formatted and annotated for implementation inside **Cursor** or use with **Claude Code**, with attention to:

* **MCP spec fidelity** (resources, tools, prompts)
* **Time-relative search grounding** (via exposed server time)
* **Agent usability** (host model context awareness)
* **Local dev and Docker readiness**

---

## 🧩 Help Scout MCP Server — PRD (Search-Only v1)

### 1. 📌 Objective

Create an open-source **Model Context Protocol (MCP)** server that connects to the Help Scout API and exposes **read-only access** to inboxes, conversations, and threads.

This allows LLM agents to:

* Discover Help Scout inbox structure
* Search for conversations using metadata filters or full-text queries
* View thread content (messages) within a conversation
* Perform **time-relative searches** reliably by referencing a definitive current time source

---

### 2. 🧱 Project Structure (Recommended)

```
helpscout-mcp/
├── main.py (or index.js)
├── mcp.json          # MCP handshake manifest
├── tools/            # Python or Node functions
├── resources/        # Context-fetching logic
├── prompts/          # AI prompt bundles
├── schema/           # JSONSchema or TypeScript types
├── .env.example
├── Dockerfile
└── README.md
```

---

### 3. 🌐 Transport & Execution

* Interface: `stdio` + optional HTTP (for streaming use)
* Command:

  * Python: `python main.py`
  * Node: `node index.js`
* Docker:

  * Image name: `mcp-helpscout`
  * Entrypoint: `node dist/index.js` or `python main.py`

---

### 4. ⚙️ MCP Server Metadata (mcp.json)

```json
{
  "name": "helpscout-search",
  "description": "Search-capable MCP server for Help Scout inboxes, conversations, and threads.",
  "version": "0.1.0",
  "mcpVersion": "0.0.1",
  "resources": ["helpscout://inboxes", "helpscout://conversations", "helpscout://threads", "helpscout://clock"],
  "tools": ["searchInboxes", "searchConversations", "getThreads", "getServerTime"],
  "prompts": ["search-last-7-days", "find-urgent-tags", "list-inbox-activity"]
}
```

---

### 5. 🧩 Resources

| URI                         | Description                                   |
| --------------------------- | --------------------------------------------- |
| `helpscout://inboxes`       | All inboxes user has access to                |
| `helpscout://conversations` | Conversations matching filters                |
| `helpscout://threads`       | Full threads (messages) for a conversation ID |
| `helpscout://clock`         | Current server timestamp in ISO8601 (UTC)     |

**💡 Why `helpscout://clock` matters:**
This resource provides an anchor timestamp for agents. Example return:

```json
{
  "isoTime": "2025-06-11T15:04:00Z",
  "unixTime": 1718127840
}
```

---

### 6. 🛠️ Tools

#### `searchInboxes(query: string, limit?: number = 50, cursor?: string): Inbox[]`

Search inboxes by name substring.

#### `searchConversations(filters: object, limit?: number = 50, cursor?: string, sort?: string = "createdAt", order?: "asc" | "desc" = "desc", fields?: string[]): Conversation[]

Filters:

```json
{
  "inboxId": "123",
  "tag": "urgent",
  "status": "open",
  "createdAfter": "2025-06-04T00:00:00Z",
  "createdBefore": "2025-06-11T00:00:00Z",
  "limit": 50,
  "cursor": "abc123",
  "sort": "lastUpdated",
  "order": "desc",
  "fields": ["subject", "conversationId", "lastUpdated"]
}
```

#### `getConversationSummary(conversationId: string): ConversationSummary`

Returns the first customer message and latest staff reply without full thread bodies.

#### `getThreads(conversationId: string, limit?: number = 200, cursor?: string): Thread[]`

Returns:

```json
[
  {
    "sender": "user@example.com",
    "body": "<p>Hello</p>",
    "createdAt": "2025-06-10T14:03:00Z",
    "type": "customer"
  }
]
```

#### `getServerTime(): { isoTime, unixTime }`

Returns server time used for grounding relative searches.

---

### 7. 📦 Prompts

#### `search-last-7-days`

```yaml
id: search-last-7-days
description: "Search recent conversations across all inboxes."
prompt: |
  Call `getServerTime()` and subtract 7 days to construct a filter.
  Use `searchConversations` with `createdAfter` set to 7 days ago.
```

#### `list-inbox-activity`

```yaml
id: list-inbox-activity
description: "Show activity in a given inbox over the last N hours"
prompt: |
  1. Get current server time from `getServerTime()`
  2. Subtract N hours
  3. Use `searchConversations` with:
     {
       "inboxId": "{targetInboxId}",
       "createdAfter": "{computedTime}"
     }
```

---

### 8. 🔐 Auth & Configuration

* API: Help Scout v2
* Auth: Personal Access Token via `.env`:

```env
HELPSCOUT_API_KEY=your-key-here
HELPSCOUT_BASE_URL=https://api.helpscout.net/v2/
```

* Rate limiting: Retry w/ exponential backoff
* Error handling: Structured JSON error responses

---

### 9. 📉 Non-functional Requirements

| Metric        | Target                                    |
| ------------- | ----------------------------------------- |
| Latency       | < 250ms for cached, < 2s uncached         |
| PII Redaction | Configurable via `.env`                   |
| Logging       | JSON logs with request ID and duration    |
| Caching       | LRU or TTL cache for conversation results |
| Retry Logic   | For Help Scout rate limits (HTTP 429)     |

---

### 10. 🧪 Example Tool Invocation

#### Input (MCP Call):

```json
{
  "tool": "searchConversations",
  "input": {
    "inboxId": "556677",
    "createdAfter": "2025-06-04T00:00:00Z",
    "status": "open",
    "tag": "billing"
  }
}
```

#### Output:

```json
{
  "results": [
    {
      "subject": "Issue with invoice #984",
      "conversationId": "112233",
      "lastUpdated": "2025-06-10T12:20:00Z"
    }
  ]
}
```

---

### 11. 📦 Pagination, Sorting & Field Selection

* **Pagination:** All list tools support `limit` (1–100) and opaque `cursor`. Responses include `nextCursor` when more items are available.
* **Sorting:** Default sort is `createdAt desc`; agents may override with `sort` + `order` (e.g., `lastUpdated asc`).
* **Partial responses:** A `fields` array lets callers request only specific properties to minimize payload size.

---

### 12. 🛡️ Error Model

Structured envelope for all non-2xx results:

```json
{
  "error": {
    "code": "RATE_LIMIT",
    "message": "Request exceeded 60 calls/minute",
    "retryAfter": 30,
    "details": {}
  }
}
```

`code` enum: `INVALID_INPUT`, `NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMIT`, `UPSTREAM_ERROR`.  For 429 responses, `retryAfter` is seconds until safe retry.

---

### 13. ⛑️ Health, Metrics & Observability

* **HTTP mode endpoints:** `/healthz` (liveness) returns `200 OK`, `/readyz` (readiness) checks Help Scout token validity.
* **Metrics:** Optional Prometheus `/metrics` exposing `mcp_request_total`, `helpscout_duration_seconds`, `rate_limit_retries_total`.
* **Tracing:** OpenTelemetry spans around each Help Scout call (optional but recommended).

---

### 14. 🔐 Security & Compliance

* **Token scope:** Use read-only PAT restricted to required inboxes.
* **Rotation:** Tokens loaded via env; rotate every 90 days.
* **Logs:** JSON logs exclude message bodies by default; redact emails with regex unless `ALLOW_PII=true`.
* **Data at rest:** Local caches stored in RAM; if persisted to disk/Redis, enable AES-256 encryption and TTL ≤ 24 h.
* **GDPR:** Provide `/gdpr-delete-cache` admin command to flush cached conversation data.

---

### 15. 🗄️ Cache Strategy

* **Store:** In-memory LRU (default 10 k keys) with optional Redis backend.
* **Key:** SHA-256 of normalized request payload (tool name + filters + fields).
* **TTL:** 60 s for `getServerTime`, 300 s for `search*`, 24 h for `inboxes`.
* **Pre-warm:** Optional cron refreshes `inboxes` every 5 min.

---

### 16. 🔄 Rate-Limit Backoff Hints

When Help Scout returns 429, the MCP tool responds with the error envelope above **and** `retryAfterSeconds` so agents can self-throttle instead of blind retries.

---

### 17. 🏗️ CI/CD & Release Management

* GitHub Actions pipeline:
  * Lint & type-check (`ruff`, `mypy` or `eslint` + `tsc`).
  * Unit tests with Help Scout sandbox mocks.
  * Build & publish `mcp-helpscout` Docker image on `main`.
  * Semver tagging + autogenerated CHANGELOG.

---

### 18. 📄 License & Contribution Guidelines

* **License:** MIT (placeholder — confirm before OSS release).
* **Docs:** Add `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` for community standards.

---

### 19. 🧪 Example Agent Workflows

| Scenario | Steps |
| -------- | ----- |
| "Open urgent last 24 h" | 1. `getServerTime` → compute `now-24h`; 2. `searchConversations` with `status=open`, `tag=urgent`, `createdAfter`; 3. For each result, call `getConversationSummary`. |
| "Fetch full thread for a billing question" | 1. `searchConversations` with `tag=billing` & keyword; 2. `getThreads` for chosen `conversationId`. |

---

### ✅ Summary

| Feature                              | Included |
| ------------------------------------ | -------- |
| MCP handshake + metadata             | ✅        |
| Stdio + HTTP transport               | ✅        |
| Time-relative queries                | ✅        |
| Pagination & sorting                 | ✅        |
| Error envelope                       | ✅        |
| Partial response fields              | ✅        |
| Health & metrics endpoints           | ✅        |
| Security & compliance notes          | ✅        |
| Cache strategy                       | ✅        |
| Rate-limit backoff hints             | ✅        |
| CI/CD pipeline                       | ✅        |
| License / contributing docs          | ✅        |
| Claude/Cursor support                | ✅        |
| Dockerized CLI agent                 | ✅        |
| Open source ready                    | ✅        |


