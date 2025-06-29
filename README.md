# Help Scout MCP Server

[![npm version](https://badge.fury.io/js/help-scout-mcp-server.svg)](https://badge.fury.io/js/help-scout-mcp-server)
[![Docker](https://img.shields.io/docker/v/drewburchfield/help-scout-mcp-server?logo=docker&label=docker)](https://hub.docker.com/r/drewburchfield/help-scout-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org/)

> **Help Scout MCP Server** - Connect Claude and other AI assistants to your Help Scout data with enterprise-grade security and advanced search capabilities.

## 📖 Table of Contents

- [🎉 What's New](#-whats-new-in-v120)
- [⚡ Quick Start](#quick-start) 
- [🔑 API Credentials](#getting-your-api-credentials)
- [🛠️ Tools & Capabilities](#tools--capabilities)
- [⚙️ Configuration](#configuration-options)
- [🔍 Troubleshooting](#troubleshooting)
- [🤝 Contributing](#contributing)

## 🎉 What's New in v1.2.1

- **🎯 DXT Extension**: One-click installation for Claude Desktop
- **🔧 Clear Environment Variables**: `HELPSCOUT_CLIENT_ID` and `HELPSCOUT_CLIENT_SECRET` 
- **⚡ Connection Pooling**: Improved performance with HTTP connection reuse
- **🛡️ Enhanced Security**: Comprehensive input validation and API constraints
- **🔄 Dependency Injection**: Cleaner architecture with ServiceContainer
- **🧪 Comprehensive Testing**: 69%+ branch coverage with reliable tests

## Prerequisites

- **Node.js 18+** (for command line usage)
- **Help Scout Account** with API access
- **OAuth2 App** or **Personal Access Token** from Help Scout
- **Claude Desktop** (for DXT installation) or any MCP-compatible client

> **Note**: The DXT extension includes Node.js, so no local installation needed for Claude Desktop users.

## Quick Start

### 🎯 Option 1: Claude Desktop (DXT One-Click Install)

**Easiest setup using [DXT (Desktop Extensions)](https://docs.anthropic.com/en/docs/build-with-claude/computer-use#desktop-extensions) - no configuration needed:**

1. Download the latest [`.dxt` file from releases](https://github.com/drewburchfield/help-scout-mcp-server/releases)
2. Double-click to install in Claude Desktop
3. Enter your Help Scout OAuth2 Client ID and Client Secret when prompted
4. Start using immediately!

### 📋 Option 2: Claude Desktop (Manual Config)

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "npx",
      "args": ["help-scout-mcp-server"],
      "env": {
        "HELPSCOUT_CLIENT_ID": "your-client-id",
        "HELPSCOUT_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

### 🐳 Option 3: Docker

```bash
docker run -e HELPSCOUT_CLIENT_ID="your-client-id" \
  -e HELPSCOUT_CLIENT_SECRET="your-client-secret" \
  drewburchfield/help-scout-mcp-server
```

### 💻 Option 4: Command Line

```bash
HELPSCOUT_CLIENT_ID="your-client-id" \
HELPSCOUT_CLIENT_SECRET="your-client-secret" \
npx help-scout-mcp-server
```

## Getting Your API Credentials

### 🎯 **Recommended: OAuth2 Client Credentials**

1. Go to **Help Scout** → **My Apps** → **Create Private App**
2. Fill in app details and select required scopes
3. Copy your **Client ID** and **Client Secret**
4. Use in configuration:
   - `HELPSCOUT_CLIENT_ID=your-client-id`
   - `HELPSCOUT_CLIENT_SECRET=your-client-secret`

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
| `HELPSCOUT_CLIENT_ID` | OAuth2 Client ID from Help Scout My Apps | Required |
| `HELPSCOUT_CLIENT_SECRET` | OAuth2 Client Secret from Help Scout My Apps | Required |
| `HELPSCOUT_API_KEY` | Personal Access Token (format: `Bearer token`) | Alternative to OAuth2 |
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
echo "HELPSCOUT_CLIENT_ID=your-client-id" > .env
echo "HELPSCOUT_CLIENT_SECRET=your-client-secret" >> .env

# Start the server
npm start
```

## Troubleshooting

### Common Issues

**Authentication Failed**
```bash
# Verify your credentials
echo $HELPSCOUT_CLIENT_ID
echo $HELPSCOUT_CLIENT_SECRET

# Test with curl
curl -X POST https://api.helpscout.net/v2/oauth2/token \
  -d "grant_type=client_credentials&client_id=$HELPSCOUT_CLIENT_ID&client_secret=$HELPSCOUT_CLIENT_SECRET"
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

We welcome contributions! Here's how to get started:

### 🚀 Quick Development Setup

```bash
git clone https://github.com/drewburchfield/help-scout-mcp-server.git
cd help-scout-mcp-server
npm install
```

### 🔧 Development Workflow

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

### 📋 Before Submitting

- ✅ All tests pass (`npm test`)
- ✅ Type checking passes (`npm run type-check`) 
- ✅ Linting passes (`npm run lint`)
- ✅ Add tests for new features
- ✅ Update documentation if needed

### 🐛 Bug Reports

When reporting bugs, please include:
- Help Scout MCP Server version
- Node.js version
- Authentication method (OAuth2/Personal Access Token)
- Error messages and logs
- Steps to reproduce

### 💡 Feature Requests

We'd love to hear your ideas! Please open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternative approaches you've considered

## Support

- **Issues**: [GitHub Issues](https://github.com/drewburchfield/help-scout-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/drewburchfield/help-scout-mcp-server/discussions)
- **NPM Package**: [help-scout-mcp-server](https://www.npmjs.com/package/help-scout-mcp-server)

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Need help?** [Open an issue](https://github.com/drewburchfield/help-scout-mcp-server/issues) or check our [documentation](https://github.com/drewburchfield/help-scout-mcp-server/wiki).