# Help Scout MCP Server

[![npm version](https://badge.fury.io/js/help-scout-mcp-server.svg)](https://badge.fury.io/js/help-scout-mcp-server)
[![Docker](https://img.shields.io/docker/v/drewburchfield/help-scout-mcp-server?logo=docker&label=docker)](https://hub.docker.com/r/drewburchfield/help-scout-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org/)

> **Help Scout MCP Server** - Connect Claude and other AI assistants to your Help Scout data with enterprise-grade security and advanced search capabilities.

## Table of Contents

- [What's New](#whats-new-in-v150)
- [Quick Start](#quick-start)
- [API Credentials](#getting-your-api-credentials)
- [Tools & Capabilities](#tools--capabilities)
- [Configuration](#configuration-options)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## What's New in v1.5.0

- **MCP SDK v1.25.2**: Latest Model Context Protocol SDK with enhanced compatibility
- **New Tool**: `structuredConversationFilter` for ID-based refinement and ticket number lookup
- **Security Improvements**: Enhanced input validation and error handling from code review
- **Tool Discovery**: Clearer descriptions and decision tree for better LLM tool selection
- **Auth Alignment**: Standardized environment variable naming (`APP_ID`/`APP_SECRET`)
- **Content Redaction**: Renamed to `REDACT_MESSAGE_CONTENT` for clarity

## Prerequisites

- **Node.js 18+** (for command line usage)
- **Help Scout Account** with API access
- **OAuth2 App** from Help Scout (App ID and App Secret)
- **Claude Desktop** (for DXT installation) or any MCP-compatible client

> **Note**: The DXT extension includes Node.js, so no local installation needed for Claude Desktop users.

## Quick Start

### Option 1: Claude Desktop (DXT One-Click Install)

Easiest setup using [DXT (Desktop Extensions)](https://docs.anthropic.com/en/docs/build-with-claude/computer-use#desktop-extensions) - no configuration needed:

1. Download the latest [`.dxt` file from releases](https://github.com/drewburchfield/help-scout-mcp-server/releases)
2. Double-click to install in Claude Desktop
3. Enter your Help Scout App ID and App Secret when prompted
4. Start using immediately

### Option 2: JSON Config (Claude Desktop, Cursor, etc.)

Add to your MCP client's config file (e.g., `claude_desktop_config.json`):

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

### Option 3: Docker

```bash
docker run -e HELPSCOUT_APP_ID="your-app-id" \
  -e HELPSCOUT_APP_SECRET="your-app-secret" \
  drewburchfield/help-scout-mcp-server
```

### Option 4: Command Line (Claude Code, Codex, etc.)

```bash
HELPSCOUT_APP_ID="your-app-id" \
HELPSCOUT_APP_SECRET="your-app-secret" \
npx help-scout-mcp-server
```

## Getting Your API Credentials

### OAuth2 Client Credentials (Only Supported Method)

1. Go to **Help Scout** → **My Apps** → **Create Private App**
2. Fill in app details and select required scopes:
   - At minimum: **Read** access to Mailboxes and Conversations
3. Copy your credentials from the Help Scout UI
4. Use in configuration as shown below

> **Note**: Help Scout API uses OAuth2 Client Credentials flow exclusively. Personal Access Tokens are not supported.

### Credential Terminology

Environment variables match Help Scout's UI exactly:

| Help Scout UI | Environment Variable | Description |
|---------------|---------------------|-------------|
| **App ID** | `HELPSCOUT_APP_ID` | Your OAuth2 client identifier |
| **App Secret** | `HELPSCOUT_APP_SECRET` | Your OAuth2 client secret |

**Alternative variable names** (also supported):
- `HELPSCOUT_CLIENT_ID` / `HELPSCOUT_CLIENT_SECRET` (OAuth2 standard naming)
- `HELPSCOUT_API_KEY` (legacy)

## Features

- **Advanced Search**: Multi-status conversation search, content filtering, boolean queries
- **Smart Analysis**: Conversation summaries, thread retrieval, inbox monitoring
- **Enterprise Security**: PII redaction, secure token handling, comprehensive audit logs
- **High Performance**: Built-in caching, rate limiting, automatic retry logic
- **Easy Integration**: Works with Claude Desktop, Cursor, Continue.dev, and more

## Tools & Capabilities

### Quick Guide: Which tool should I use?

- **Listing tickets:** `searchConversations` - No keywords needed, great for "show recent/closed/active tickets"
- **Finding by keyword:** `comprehensiveConversationSearch` - Searches content for specific words
- **Lookup ticket #:** `structuredConversationFilter` - Direct ticket number lookup
- **Complex filters:** `advancedConversationSearch` - Email domains, tag combinations

### Core Search Tools

| Tool | Description | Best For |
|------|-------------|----------|
| `searchConversations` | Time/status filtering - List conversations by date, status, inbox | "Recent tickets", "closed last week", "active conversations" |
| `comprehensiveConversationSearch` | Keyword search - Find conversations containing specific words | "Find billing issues", "tickets about bug XYZ" |
| `structuredConversationFilter` | ID/number lookup - Filter by discovered IDs or ticket number | "Show ticket #42839", "Rep John's queue" (after finding John's ID) |
| `advancedConversationSearch` | Complex boolean - Email domains, tag combos, separated content/subject | "All @acme.com conversations", "urgent AND billing tags" |
| `searchInboxes` | Find inboxes by name | Discovering available inboxes |
| `listAllInboxes` | List all inboxes with IDs | Quick inbox discovery |

### Analysis & Retrieval Tools

| Tool | Description | Use Case |
|------|-------------|----------|
| `getConversationSummary` | Customer message + latest staff reply summary | Quick conversation overview |
| `getThreads` | Complete conversation message history | Full context analysis |
| `getServerTime` | Current server timestamp | Time-relative searches |

### Resources (Dynamic Discovery)

- `helpscout://inboxes` - List all accessible inboxes
- `helpscout://conversations` - Search conversations with filters
- `helpscout://threads` - Get thread messages for a conversation
- `helpscout://clock` - Current server timestamp

> **Note**: Resources are discovered dynamically at runtime through MCP protocol, not declared in the DXT manifest.

## Search Examples

> **Key Distinction**: Use `searchConversations` (without query) for **listing** conversations, use `comprehensiveConversationSearch` (with search terms) for **finding** specific content.

### Listing Recent Conversations
```javascript
// Best for "show me recent tickets" - omit query parameter
searchConversations({
  status: "active",
  limit: 25,
  sort: "createdAt",
  order: "desc"
})
```

### Content-Based Search
```javascript
// Best for "find tickets about X" - requires search terms
comprehensiveConversationSearch({
  searchTerms: ["urgent", "billing"],
  timeframeDays: 60,
  inboxId: "256809"
})
```

### Content-Specific Searches
```javascript
// Search in message bodies and subjects
comprehensiveConversationSearch({
  searchTerms: ["refund", "cancellation"],
  searchIn: ["both"],
  timeframeDays: 30
})

// Customer organization search
advancedConversationSearch({
  emailDomain: "company.com",
  contentTerms: ["integration", "API"],
  status: "active"
})
```

### Help Scout Query Syntax
```javascript
// Advanced query syntax support
searchConversations({
  query: "(body:\"urgent\" OR subject:\"emergency\") AND tag:\"escalated\"",
  status: "active"
})
```

## Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `HELPSCOUT_APP_ID` | App ID from Help Scout My Apps | Required |
| `HELPSCOUT_APP_SECRET` | App Secret from Help Scout My Apps | Required |
| `HELPSCOUT_DEFAULT_INBOX_ID` | Default inbox ID for scoped searches (improves LLM context) | None (searches all inboxes) |
| `HELPSCOUT_BASE_URL` | Help Scout API endpoint | `https://api.helpscout.net/v2/` |
| `REDACT_MESSAGE_CONTENT` | Hide message bodies in responses | `false` |
| `CACHE_TTL_SECONDS` | Cache duration for API responses | `300` |
| `LOG_LEVEL` | Logging verbosity (`error`, `warn`, `info`, `debug`) | `info` |

*Legacy variables `HELPSCOUT_CLIENT_ID`, `HELPSCOUT_CLIENT_SECRET`, and `ALLOW_PII` still supported for backwards compatibility.*


## Compatibility

Works with any [Model Context Protocol (MCP)](https://modelcontextprotocol.io) compatible client:

- **AI Assistants**: Claude Desktop, Goose, and other MCP-enabled assistants
- **Code Editors**: Cursor, VS Code (via extensions), Windsurf, and other editors with MCP support
- **Command Line**: Claude Code, Codex, Gemini CLI, OpenCode, and other CLI-based MCP clients
- **Custom Integrations**: Any application implementing the MCP standard

**Quickest Setup**: [Claude Desktop](https://claude.ai/desktop) with one-click DXT installation - no configuration needed.

*Since this server follows the MCP standard, it automatically works with any current or future MCP-compatible client.*

## Security & Privacy

- **Content Redaction**: Optional message body hiding (set `REDACT_MESSAGE_CONTENT=true`)
- **Secure Authentication**: OAuth2 Client Credentials with automatic token refresh
- **Audit Logging**: Comprehensive request tracking and error logging
- **Rate Limiting**: Built-in retry logic with exponential backoff
- **Smart Inbox Scoping**: Optional default inbox configuration for improved LLM context
- **Enterprise Ready**: SOC2 compliant deployment options

## Development

```bash
# Quick start
git clone https://github.com/drewburchfield/help-scout-mcp-server.git
cd help-scout-mcp-server
npm install && npm run build

# Create .env file with your credentials (from Help Scout My Apps)
echo "HELPSCOUT_APP_ID=your-app-id" > .env
echo "HELPSCOUT_APP_SECRET=your-app-secret" >> .env

# Start the server
npm start
```

## Troubleshooting

### Common Issues

**Authentication Failed**
```bash
# Verify your credentials
echo $HELPSCOUT_APP_ID
echo $HELPSCOUT_APP_SECRET

# Test with curl
curl -X POST https://api.helpscout.net/v2/oauth2/token \
  -d "grant_type=client_credentials&client_id=$HELPSCOUT_APP_ID&client_secret=$HELPSCOUT_APP_SECRET"
```

**Connection Timeouts**
- Check your network connection to `api.helpscout.net`
- Verify no firewall blocking HTTPS traffic
- Consider increasing `HTTP_SOCKET_TIMEOUT` environment variable

**Rate Limiting**
- The server automatically handles rate limits with exponential backoff
- Reduce concurrent requests if you see frequent 429 errors
- Monitor logs for retry patterns

**Empty Search Results**
- **Wrong tool choice**: Use `searchConversations` (no query) for listing, `comprehensiveConversationSearch` for content search
- **Empty search terms**: Don't use empty strings `[""]` with comprehensiveConversationSearch
- Verify inbox permissions with your API credentials
- Check conversation exists and you have access
- Try broader search terms or different time ranges

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
LOG_LEVEL=debug npx help-scout-mcp-server
```

### Getting Help

If you're still having issues:
1. Check [existing issues](https://github.com/drewburchfield/help-scout-mcp-server/issues)
2. Enable debug logging and share relevant logs
3. Include your configuration (without credentials!)

## Contributing

Contributions welcome! Here's how to get started:

### Development Setup

```bash
git clone https://github.com/drewburchfield/help-scout-mcp-server.git
cd help-scout-mcp-server
npm install
```

### Development Workflow

```bash
# Run tests
npm test

# Type checking
npm run type-check

# Linting
npm run lint

# Build for development
npm run build

# Start development server
npm run dev
```

### Before Submitting

- All tests pass (`npm test`)
- Type checking passes (`npm run type-check`)
- Linting passes (`npm run lint`)
- Add tests for new features
- Update documentation if needed

### Bug Reports

When reporting bugs, please include:
- Help Scout MCP Server version
- Node.js version
- App ID (not the secret!)
- Error messages and logs
- Steps to reproduce

### Feature Requests

We'd love to hear your ideas! Please open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternative approaches you've considered

## Support

- **Issues**: [GitHub Issues](https://github.com/drewburchfield/help-scout-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/drewburchfield/help-scout-mcp-server/discussions)
- **NPM Package**: [help-scout-mcp-server](https://www.npmjs.com/package/help-scout-mcp-server)

---

## About This Project

Built with care by a Help Scout customer who wanted to give his support team superpowers. If you're using Help Scout and want your AI assistants to help you find conversations, spot patterns, and get context faster, this is for you.

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Need help?** [Open an issue](https://github.com/drewburchfield/help-scout-mcp-server/issues) or check our [documentation](https://github.com/drewburchfield/help-scout-mcp-server/wiki).
