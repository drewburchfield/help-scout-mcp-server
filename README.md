[![Help Scout MCP Server](https://ghrb.waren.build/banner?header=Help+Scout+MCP+Server+%21%5Bhelpscout%5D&subheader=Connect+AI+assistants+to+your+Help+Scout+data&bg=1A1A1A-4A4A4A&color=FFFFFF&headerfont=Inter&subheaderfont=Inter&support=false)](https://github.com/drewburchfield/help-scout-mcp-server)

[![npm version](https://badge.fury.io/js/help-scout-mcp-server.svg)](https://badge.fury.io/js/help-scout-mcp-server) [![Docker](https://img.shields.io/docker/v/drewburchfield/help-scout-mcp-server?logo=docker&label=docker)](https://hub.docker.com/r/drewburchfield/help-scout-mcp-server) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/drewburchfield/help-scout-mcp-server) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [MCP server](https://modelcontextprotocol.io) that gives AI assistants direct access to your Help Scout inboxes, conversations, customers, organizations, and threads. Search tickets, pull customer and account context, spot patterns, and get answers without leaving your editor or chat window.

Built by a Help Scout customer who wanted to give his support team superpowers. If you handle customer conversations in Help Scout and want AI to help you work faster, this is for you.

## What You Can Do

- **Search conversations** by keyword, date range, status, tag, email domain, or ticket number
- **Look up customers** by name, advanced query syntax, or exact email address
- **Explore organizations** with direct customer and conversation traversal
- **Pull full thread history** into context before drafting a reply
- **Get conversation summaries** with the original customer message and latest staff response
- **Monitor inbox activity** across multiple inboxes with a single query
- **Stay compliant** with optional PII redaction and scoped inbox access

## Quick Start

### Claude Cowork (Recommended)

Install the **helpscout-navigator** plugin. It auto-starts the MCP server and includes **navigation skills** that help Claude pick the right search tool for your query.

1. Open Cowork and go to **Customize** > **Browse plugins** > **Personal**
2. Click **+** > **Add marketplace from GitHub** and enter `drewburchfield/help-scout-mcp-server`
3. Install **helpscout-navigator** from the marketplace
4. Add your Help Scout credentials ([step-by-step guide](guides/cowork-setup.md))

> The plugin bundles guided skills, session hooks, and tool selection guidance on top of the MCP server. Other install methods give you the tools; this one also teaches the AI how to use them well.

### Claude Desktop

**One-click install** using [Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions):

1. Download the latest [`.mcpb` file from releases](https://github.com/drewburchfield/help-scout-mcp-server/releases)
2. Double-click to install (or drag into Claude Desktop)
3. Enter your Help Scout App ID and App Secret when prompted

### Claude Code

The same **helpscout-navigator** plugin works in Claude Code with the same navigation skills.

1. Run `/plugin` in Claude Code to open the marketplace
2. Search for **helpscout-navigator** and install it
3. Set `HELPSCOUT_APP_ID` and `HELPSCOUT_APP_SECRET` as environment variables
4. Restart Claude Code

### For Cursor, VS Code, and Other MCP Clients

Add to your MCP client's config file (e.g., `claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "npx",
      "args": ["help-scout-mcp-server"],
      "env": {
        "HELPSCOUT_APP_ID": "your-app-id",
        "HELPSCOUT_APP_SECRET": "your-app-secret"
      }
    }
  }
}
```

### Docker

```bash
docker run -e HELPSCOUT_APP_ID="your-app-id" \
  -e HELPSCOUT_APP_SECRET="your-app-secret" \
  drewburchfield/help-scout-mcp-server
```

## Getting Your API Credentials

1. Go to **Help Scout** > **My Apps** > **Create Private App**
2. Select at minimum: **Read** access to Mailboxes, Conversations, Customers, and Organizations
3. Copy your **App ID** and **App Secret**

> Help Scout uses OAuth2 Client Credentials flow exclusively. Personal Access Tokens are not supported.

| Help Scout UI | Environment Variable |
|---------------|---------------------|
| **App ID** | `HELPSCOUT_APP_ID` |
| **App Secret** | `HELPSCOUT_APP_SECRET` |

Alternative names `HELPSCOUT_CLIENT_ID` / `HELPSCOUT_CLIENT_SECRET` and legacy `HELPSCOUT_API_KEY` are also supported.

## Tools

### Which tool should I use?

| Task | Tool | Example |
|------|------|---------|
| List recent tickets | `searchConversations` | "Show me active tickets from this week" |
| Find by keyword | `comprehensiveConversationSearch` | "Find conversations about billing errors" |
| Look up a ticket number | `structuredConversationFilter` | "Show me ticket #42839" |
| Complex filters | `advancedConversationSearch` | "All @acme.com conversations tagged urgent" |
| Browse customers | `listCustomers` | "Show customers named Jane" |
| Find a customer by email | `searchCustomersByEmail` | "Find customer jane@acme.com" |
| Inspect a customer profile | `getCustomer` | "Open customer 12345" |
| Pull customer contact channels | `getCustomerContacts` | "Show contact details for customer 12345" |
| Browse organizations | `listOrganizations` | "Show the busiest organizations" |
| Inspect an organization | `getOrganization` | "Open organization 456" |
| List customers in an organization | `getOrganizationMembers` | "Who belongs to organization 456?" |
| List organization conversations | `getOrganizationConversations` | "Show support history for organization 456" |
| Quick conversation overview | `getConversationSummary` | "Summarize this conversation" |
| Full message history | `getThreads` | "Show me the complete thread" |
| Current server time | `getServerTime` | Used for time-relative searches |

Inboxes are auto-discovered when the server connects. AI agents get inbox IDs in their instructions automatically, so no lookup step is needed.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `HELPSCOUT_APP_ID` | App ID from Help Scout My Apps | Required |
| `HELPSCOUT_APP_SECRET` | App Secret from Help Scout My Apps | Required |
| `HELPSCOUT_DEFAULT_INBOX_ID` | Scope searches to a specific inbox | None (all inboxes) |
| `HELPSCOUT_BASE_URL` | Help Scout API endpoint | `https://api.helpscout.net/v2/` |
| `REDACT_MESSAGE_CONTENT` | Hide message bodies in responses | `false` |
| `CACHE_TTL_SECONDS` | Cache duration for API responses | `300` |
| `LOG_LEVEL` | Logging verbosity (`error`, `warn`, `info`, `debug`) | `info` |

## Compatibility

Works with any [MCP-compatible](https://modelcontextprotocol.io) client:

| Category | Clients |
|----------|---------|
| **AI Assistants** | Claude Desktop, Goose, and other MCP-enabled assistants |
| **Code Editors** | Cursor, VS Code, Windsurf, Continue.dev |
| **Command Line** | Claude Code, Codex, Gemini CLI, OpenCode |
| **Custom** | Any application implementing the MCP standard |

## Security and Privacy

Built with compliance-minded teams in mind:

- **Optional PII redaction.** Message bodies are included by default. Set `REDACT_MESSAGE_CONTENT=true` to hide them for stricter compliance requirements.
- **Customer and organization redaction.** Customer contact fields and organization contact/location fields are also redacted when message-content redaction is enabled.
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
- Using the wrong search tool (use `searchConversations` for listing, `comprehensiveConversationSearch` for keyword search)
- Inbox ID mismatch. Check the IDs from server instructions, not guessed values.
- Search terms too narrow. Try broader terms or a longer time range.

**Need more detail?** Enable debug logging:

```bash
LOG_LEVEL=debug npx help-scout-mcp-server
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
