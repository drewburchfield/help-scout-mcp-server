[![Help Scout MCP Server](https://ghrb.waren.build/banner?header=Help+Scout+MCP+Server+%21%5Bhelpscout%5D&subheader=Connect+AI+assistants+to+your+Help+Scout+data&bg=1A1A1A-4A4A4A&color=FFFFFF&headerfont=Inter&subheaderfont=Inter&support=false)](https://github.com/drewburchfield/help-scout-mcp-server)

[![npm version](https://badge.fury.io/js/help-scout-mcp-server.svg)](https://badge.fury.io/js/help-scout-mcp-server) [![Docker](https://img.shields.io/docker/v/drewburchfield/help-scout-mcp-server?logo=docker&label=docker)](https://hub.docker.com/r/drewburchfield/help-scout-mcp-server) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/drewburchfield/help-scout-mcp-server) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [MCP server](https://modelcontextprotocol.io) that gives AI assistants direct access to your Help Scout inboxes, conversations, customers, organizations, threads, and Docs knowledge base. Search tickets, pull customer and account context, inspect articles, spot patterns, and get answers without leaving your editor or chat window.

Built by a Help Scout customer who wanted to give his support team superpowers. If you handle customer conversations in Help Scout and want AI to help you work faster, this is for you.

## What You Can Do

- **Search conversations** by keyword, date range, status, tag, email domain, or ticket number
- **Look up customers** by name, advanced query syntax, or exact email address
- **Explore organizations** with direct customer and conversation traversal
- **Inspect conversation detail** with raw ticket metadata, summaries, full threads, attachments, and original source
- **Pull full thread history** into context before drafting a reply
- **Get conversation summaries** with the original customer message and latest staff response
- **Search and retrieve Docs articles** from the separate Help Scout Docs API
- **Pull Help Scout reports and metadata** for company, conversations, Docs, channels, productivity, happiness, users, teams, system users, statuses, routing, and webhooks
- **Monitor inbox activity** across multiple inboxes with a single query
- **Take action with opt-in writes**: draft replies, internal notes, tags, status, assignment, snooze, and more, all off by default
- **Reduce message payloads** with optional message content redaction and scoped inbox access

## Quick Start

### Claude Desktop & Claude Cowork (Recommended)

**One-click install** using [Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions). One install covers both Chat and Cowork sessions in the Claude desktop app.

1. Download the latest [`.mcpb` file from releases](https://github.com/drewburchfield/help-scout-mcp-server/releases)
2. Double-click to install (or drag into Claude Desktop)
3. Enter your Help Scout App ID and App Secret in the extension settings; the settings also carry toggles for message redaction and the opt-in write surface
4. Restart Claude Desktop

If the tools don't show up in a Cowork session, update the desktop app to the latest version and start a fresh session. ([Cowork walkthrough](guides/cowork-setup.md))

Optional: add the **helpscout-navigator** skill so Claude picks the right operation faster. Go to **Customize**, click **+** > **Add marketplace from GitHub**, enter `drewburchfield/help-scout-mcp-server`, and install **helpscout-navigator**.

### Claude Code

Register the server, then optionally add the **helpscout-navigator** skill, which teaches Claude to pick the right operation for each query.

```bash
claude mcp add helpscout \
  --env HELPSCOUT_APP_ID=your-app-id \
  --env HELPSCOUT_APP_SECRET=your-app-secret \
  -- npx -y help-scout-mcp-server
```

Then, for the navigation skill:

1. Run `/plugin marketplace add drewburchfield/help-scout-mcp-server`
2. Run `/plugin install helpscout-navigator`

> The server alone gives you the tools; the skill also teaches the AI how to use them well.

### For Cursor, VS Code, and Other MCP Clients

Add to your MCP client's config file (e.g., `claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "npx",
      "args": ["help-scout-mcp-server@2.1.0"],
      "env": {
        "HELPSCOUT_APP_ID": "your-app-id",
        "HELPSCOUT_APP_SECRET": "your-app-secret",
        "HELPSCOUT_DOCS_API_KEY": "optional-docs-api-key"
      }
    }
  }
}
```

### Docker

```bash
docker run -e HELPSCOUT_APP_ID="your-app-id" \
  -e HELPSCOUT_APP_SECRET="your-app-secret" \
  -e HELPSCOUT_DOCS_API_KEY="optional-docs-api-key" \
  drewburchfield/help-scout-mcp-server:2.1.0
```

## Getting Your API Credentials

1. Go to **Help Scout** > **My Apps** > **Create Private App**
2. Copy your **App ID** and **App Secret**

> Help Scout uses OAuth2 Client Credentials flow exclusively. Personal Access Tokens are not supported. The app authenticates as the user who created it, with that user's permissions; there is no separate scope selection, which is why the server's own write gating defaults to off.

| Help Scout UI | Environment Variable |
|---------------|---------------------|
| **App ID** | `HELPSCOUT_APP_ID` |
| **App Secret** | `HELPSCOUT_APP_SECRET` |

Alternative names `HELPSCOUT_CLIENT_ID` / `HELPSCOUT_CLIENT_SECRET` are also supported.

Docs knowledge base tools use Help Scout Docs API v1, which is separate from the Mailbox API. Set `HELPSCOUT_DOCS_API_KEY` only if you want to use `listDocs*`, `searchDocsArticles`, `getDocsArticle`, or redirect tools.

## Tools

The server advertises three tools that together reach every supported read operation (55 across the Mailbox and Docs APIs):

| Tool | Purpose |
|------|---------|
| `search_help_scout` | Find operations by intent ("customer conversation history", "happiness report") |
| `describe_help_scout` | Load the full input schemas for the operations you selected |
| `read_help_scout` | Execute one operation: `{ "name": "getThreads", "arguments": { ... } }` |

This keeps the advertised surface small enough that AI clients don't drown in schemas, while every read capability stays one search away. Operations in the current registry also remain callable by name directly. Tool names removed in the v2.0.0 consolidation (for example `comprehensiveConversationSearch`, `structuredConversationFilter`, and `searchInboxes`) are not; their capabilities live in `searchConversations` and `listAllInboxes`.

An optional fourth tool, `write_help_scout`, appears only when an operator turns writes on. See [Write operations (opt-in)](#write-operations-opt-in).

For the MCP compatibility contract and roadmap, see:

- [MCP tool contract](guides/architecture/mcp-tool-contract.md)
- [MCP vs CLI boundary](guides/architecture/mcp-vs-cli.md)
- [MCP tool surface roadmap](guides/roadmap/mcp-tool-surface.md)

### Which operation should I use?

Run any of these via `read_help_scout`:

| Task | Operation | Example |
|------|-----------|---------|
| List recent tickets | `searchConversations` | "Show me active tickets from this week" |
| Find by keyword | `searchConversations` (`contentTerms`) | "Find conversations about billing errors" |
| Look up a ticket number | `searchConversations` (`conversationNumber`) | "Show me ticket #42839" |
| Complex filters | `searchConversations` (`emailDomain`, `tag`) | "All @acme.com conversations tagged urgent" |
| Browse customers | `listCustomers` | "Show customers named Jane" |
| Find a customer by email | `searchCustomersByEmail` | "Find customer jane@acme.com" |
| Inspect a customer profile | `getCustomer` | "Open customer 12345" |
| Pull customer contact channels | `getCustomerContacts` | "Show contact details for customer 12345" |
| Browse organizations | `listOrganizations` | "Show the busiest organizations" |
| Inspect an organization | `getOrganization` | "Open organization 456" |
| List customers in an organization | `getOrganizationMembers` | "Who belongs to organization 456?" |
| List organization conversations | `getOrganizationConversations` | "Show support history for organization 456" |
| Raw conversation detail | `getConversation` | "Open conversation 12345 with full metadata" |
| Quick conversation overview | `getConversationSummary` | "Summarize this conversation" |
| Full message history | `getThreads` | "Show me the complete thread" |
| Inspect inbox fields, folders, or routing | `getInbox` (`include`) | "Show routing for inbox 359402" (`include: ["routing"]`) |
| Search Docs articles | `searchDocsArticles` | "Find knowledge base articles about refunds" |
| Retrieve a Docs article | `getDocsArticle` | "Open Docs article 123" |
| Current MCP host time | `getServerTime` | Used for time-relative searches |

Inboxes are auto-discovered when the server connects. AI agents get inbox IDs in their instructions automatically, so no lookup step is needed.

## Write operations (opt-in)

A default install is read-only. It advertises the three tools above and nothing else, unchanged from 2.0. Writes exist only after an operator sets a flag.

| Flag | What it adds |
|------|--------------|
| `HELPSCOUT_ENABLE_WRITES=true` | A fourth tool, `write_help_scout`, carrying 11 tier-1 conversation operations |
| `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true` | Two more operations on that same tool: `sendReply` and `publishDraft` |

Tier 1 covers draft replies, internal notes, status changes, assign and unassign, adding and removing tags, custom field values, snooze and unsnooze, and moving a conversation to another inbox. None of it emails anyone: a draft is saved unsent, and a note is visible to teammates only.

Tier 2 is the only path that reaches a customer, and it needs both flags. Every call to `sendReply` or `publishDraft` must also carry confirmation naming the operation and the target:

```json
{
  "name": "sendReply",
  "arguments": { "conversationId": "12345", "text": "..." },
  "confirm": true,
  "confirmOperation": "sendReply",
  "targetId": "12345"
}
```

Missing, false, or mismatched confirmation is refused before anything reaches Help Scout. Deletes and admin configuration writes are deliberately not exposed, under any flag.

Set `"dryRun": true` on any write to validate the arguments and see the exact request that would be sent, without contacting Help Scout.

Full rules: [write tool contract](guides/architecture/mcp-tool-contract.md#write-tool-contract).

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `HELPSCOUT_APP_ID` | App ID from Help Scout My Apps | Required |
| `HELPSCOUT_APP_SECRET` | App Secret from Help Scout My Apps | Required |
| `HELPSCOUT_DEFAULT_INBOX_ID` | Scope searches to a specific inbox | None (all inboxes) |
| `HELPSCOUT_BASE_URL` | Help Scout API endpoint | `https://api.helpscout.net/v2/` |
| `HELPSCOUT_DOCS_API_KEY` | Optional Docs API key for knowledge base tools | None |
| `HELPSCOUT_DOCS_BASE_URL` | Help Scout Docs API endpoint | `https://docsapi.helpscout.net/v1/` |
| `REDACT_MESSAGE_CONTENT` | Replace message bodies with placeholders | `false` |
| `HELPSCOUT_ENABLE_WRITES` | Advertise `write_help_scout` with the tier-1 conversation writes | Unset (`false`) |
| `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES` | Also enable `sendReply` and `publishDraft`, which email the customer | Unset (`false`) |
| `CACHE_TTL_SECONDS` | Cache duration for API responses | `300` |
| `LOG_LEVEL` | Logging verbosity (`error`, `warn`, `info`, `debug`) | `info` |

## Compatibility

Works with any [MCP-compatible](https://modelcontextprotocol.io) client:

| Category | Clients |
|----------|---------|
| **AI Assistants** | Claude Desktop (Chat and Cowork), Goose, and other MCP-enabled assistants |
| **Code Editors** | Cursor, VS Code, Windsurf, Continue.dev |
| **Command Line** | Claude Code, Codex, Gemini CLI, OpenCode |
| **Custom** | Any application implementing the MCP standard |

## Security and Privacy

Built with security-minded teams in mind:

- **Optional message content redaction.** Message bodies are included by default. Set `REDACT_MESSAGE_CONTENT=true` to replace conversation and thread bodies with placeholders for lower-context analysis. This is not a compliance boundary and does not remove all customer identifiers.
- **Secure authentication.** OAuth2 Client Credentials with automatic token refresh.
- **Rate limit handling.** Automatic retry with exponential backoff on 429 responses.
- **Scoped access.** Optional default inbox configuration limits what the AI can search.

## Troubleshooting

**Authentication failed?** Verify your credentials work with Help Scout directly:

```bash
curl -X POST https://api.helpscout.net/v2/oauth2/token \
  -d "grant_type=client_credentials&client_id=$HELPSCOUT_APP_ID&client_secret=$HELPSCOUT_APP_SECRET"
```

**Empty search results?** Common causes:
- Forgetting that `searchConversations` is the single search tool: use `contentTerms`/`subjectTerms` for keyword search, plain filters for listing
- Inbox ID mismatch. Check the IDs from server instructions, not guessed values.
- Search terms too narrow. Try broader terms or a longer time range.

**Need more detail?** Enable debug logging:

```bash
LOG_LEVEL=debug npx help-scout-mcp-server@2.1.0
```

## Development

```bash
git clone https://github.com/drewburchfield/help-scout-mcp-server.git
cd help-scout-mcp-server
npm install && npm run build
npm start
```

```bash
npm test           # Run tests
npm run type-check # TypeScript validation
npm run lint       # Linting
npm run dev        # Development server with auto-reload
```

Contributions welcome. Please ensure tests, type checking, and linting pass before submitting a PR.

## Support

- [GitHub Issues](https://github.com/drewburchfield/help-scout-mcp-server/issues)
- [GitHub Discussions](https://github.com/drewburchfield/help-scout-mcp-server/discussions)
- [NPM Package](https://www.npmjs.com/package/help-scout-mcp-server)
- [Changelog](https://github.com/drewburchfield/help-scout-mcp-server/releases)

## License

MIT License - see [LICENSE](LICENSE) for details.
