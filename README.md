# Help Scout MCP Server

[![npm version](https://badge.fury.io/js/help-scout-mcp-server.svg)](https://badge.fury.io/js/help-scout-mcp-server)
[![Docker](https://img.shields.io/docker/v/drewburchfield/help-scout-mcp-server?logo=docker&label=docker)](https://hub.docker.com/r/drewburchfield/help-scout-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org/)

> **Official Help Scout MCP Server** - Connect Claude and other AI assistants to your Help Scout data with enterprise-grade security and advanced search capabilities.

## Quick Start

### 🎯 Option 1: Claude Desktop (DXT One-Click Install)

**Easiest setup using [DXT (Desktop Extensions)](https://docs.anthropic.com/en/docs/build-with-claude/computer-use#desktop-extensions) - no configuration needed:**

1. Download the latest [`.dxt` file from releases](https://github.com/drewburchfield/help-scout-mcp-server/releases)
2. Double-click to install in Claude Desktop
3. Enter your Help Scout OAuth2 Client ID and Client Secret when prompted
4. Start using immediately!

### 📋 Option 2: Claude Desktop (Manual Config)

Add this to your Claude Desktop config file:

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "npx",
      "args": ["help-scout-mcp-server"],
      "env": {
        "HELPSCOUT_API_KEY": "your-client-id",
        "HELPSCOUT_APP_SECRET": "your-client-secret"
      }
    }
  }
}
```

### 🐳 Option 3: Docker

```bash
docker run -e HELPSCOUT_API_KEY="your-client-id" \
  -e HELPSCOUT_APP_SECRET="your-client-secret" \
  drewburchfield/help-scout-mcp-server
```

### 💻 Option 4: Command Line

```bash
npx help-scout-mcp-server --client-id="your-client-id" --client-secret="your-client-secret"
```

## Getting Your API Credentials

### 🎯 **Recommended: OAuth2 Client Credentials**

1. Go to **Help Scout** → **My Apps** → **Create Private App**
2. Fill in app details and select required scopes
3. Copy your **Client ID** and **Client Secret**
4. Use in configuration:
   - `HELPSCOUT_API_KEY=your-client-id`
   - `HELPSCOUT_APP_SECRET=your-client-secret`

### 🔐 **Alternative: Personal Access Token**

1. Go to **Help Scout** → **Your Profile** → **API Keys**  
2. Create a new **Personal Access Token**
3. Use in configuration: `HELPSCOUT_API_KEY=Bearer your-token-here`

## Features

- **🔍 Advanced Search**: Multi-status conversation search, content filtering, boolean queries
- **📊 Smart Analysis**: Conversation summaries, thread retrieval, inbox monitoring  
- **🔒 Enterprise Security**: PII redaction, secure token handling, comprehensive audit logs
- **⚡ High Performance**: Built-in caching, rate limiting, automatic retry logic
- **🎯 Easy Integration**: Works with Claude Desktop, Cursor, Continue.dev, and more

## Tools & Capabilities

### Core Search Tools

| Tool | Description | Best For |
|------|-------------|----------|
| `comprehensiveConversationSearch` | **⭐ Recommended** - Searches across all conversation statuses automatically | Finding conversations without knowing exact status |
| `searchConversations` | Basic search with Help Scout query syntax | Targeted searches with specific filters |
| `advancedConversationSearch` | Boolean queries with content/subject/email filtering | Complex search requirements |
| `searchInboxes` | Find inboxes by name | Discovering available inboxes |

### Analysis & Retrieval Tools

| Tool | Description | Use Case |
|------|-------------|----------|
| `getConversationSummary` | Customer message + latest staff reply summary | Quick conversation overview |
| `getThreads` | Complete conversation message history | Full context analysis |
| `getServerTime` | Current server timestamp | Time-relative searches |

### Resources

- `helpscout://inboxes` - List all accessible inboxes
- `helpscout://conversations` - Search conversations with filters  
- `helpscout://threads` - Get thread messages for a conversation
- `helpscout://clock` - Current server timestamp

## Search Examples

### Recommended: Multi-Status Search
```javascript
// Best approach - automatically searches active, pending, and closed
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
| `HELPSCOUT_API_KEY` | OAuth2 Client ID or Personal Access Token (format: `Bearer token`) | Required |
| `HELPSCOUT_APP_SECRET` | OAuth2 Client Secret (required for OAuth2) | Optional |
| `HELPSCOUT_BASE_URL` | Help Scout API endpoint | `https://api.helpscout.net/v2/` |
| `ALLOW_PII` | Include message content in responses | `false` |
| `CACHE_TTL_SECONDS` | Cache duration for API responses | `300` |
| `LOG_LEVEL` | Logging verbosity (`error`, `warn`, `info`, `debug`) | `info` |

## Compatibility

**Works with any [Model Context Protocol (MCP)](https://modelcontextprotocol.io) compatible client:**

- **🖥️ Desktop Applications**: Claude Desktop, AI coding assistants, and other MCP-enabled desktop apps
- **📝 Code Editors**: VS Code extensions, Cursor, and other editors with MCP support
- **🔌 Custom Integrations**: Any application implementing the MCP standard
- **🛠️ Development Tools**: Command-line MCP clients and custom automation scripts

**Primary Platform**: [Claude Desktop](https://claude.ai/desktop) with full DXT and manual configuration support

*Since this server follows the MCP standard, it automatically works with any current or future MCP-compatible client.*

## Security & Privacy

- **🔒 PII Protection**: Message content redacted by default
- **🛡️ Secure Authentication**: OAuth2 Client Credentials or Personal Access Token with automatic refresh
- **📝 Audit Logging**: Comprehensive request tracking and error logging
- **⚡ Rate Limiting**: Built-in retry logic with exponential backoff
- **🏢 Enterprise Ready**: SOC2 compliant deployment options

## Development

```bash
# Quick start
git clone https://github.com/drewburchfield/help-scout-mcp-server.git
cd help-scout-mcp-server
npm install && npm run build

# Create .env file with your credentials (OAuth2)
echo "HELPSCOUT_API_KEY=your-client-id" > .env
echo "HELPSCOUT_APP_SECRET=your-client-secret" >> .env

# Start the server
npm start
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Need help?** [Open an issue](https://github.com/drewburchfield/help-scout-mcp-server/issues) or check our [documentation](https://github.com/drewburchfield/help-scout-mcp-server/wiki).