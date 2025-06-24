# 🎯 Help Scout MCP Server

[![npm version](https://badge.fury.io/js/help-scout-mcp-server.svg)](https://badge.fury.io/js/help-scout-mcp-server)
[![Docker](https://img.shields.io/docker/v/drewburchfield/help-scout-mcp-server?logo=docker&label=docker)](https://hub.docker.com/r/drewburchfield/help-scout-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org/)

> An MCP server that enables Claude and other AI assistants to interact with Help Scout data

## 📋 Overview

The Help Scout MCP Server implements the [Model Context Protocol](https://modelcontextprotocol.io) to bridge Help Scout with AI agents. It allows large language models to intelligently search, analyze, and retrieve customer support data from your Help Scout account with advanced query capabilities and robust error handling.

## ✨ Features

- **Rich Help Scout Integration**: Access conversations, threads, inboxes, and server time
- **Advanced Search Capabilities**: 
  - Basic conversation search with HelpScout query syntax
  - Advanced conversation search with boolean queries and content filtering
  - Inbox search by name
- **Content Analysis**: Get conversation summaries with first customer message and latest staff reply
- **Full Thread Access**: Retrieve complete message threads for conversations
- **Robust Error Handling**: Comprehensive error handling with retry logic and detailed error messages
- **Enterprise Security**: Configurable PII filtering and secure token handling
- **Caching & Performance**: Built-in LRU caching with configurable TTL
- **Comprehensive Logging**: Structured logging with request tracking

## 🚀 Installation

### NPX (Recommended)

```bash
# Option 1: With Personal Access Token (Recommended)
export HELPSCOUT_API_KEY="Bearer your-personal-access-token-here"
export HELPSCOUT_BASE_URL="https://api.helpscout.net/v2/"
npx help-scout-mcp-server

# Option 2: With OAuth2 App Credentials (Legacy)
export HELPSCOUT_API_KEY="your-client-id-here"
export HELPSCOUT_APP_SECRET="your-client-secret-here"
export HELPSCOUT_BASE_URL="https://api.helpscout.net/v2/"
npx help-scout-mcp-server

# You can also pass credentials as command line arguments
npx help-scout-mcp-server --api-key="Bearer your-token-here" --base-url="https://api.helpscout.net/v2/"

# Or create a .env file in your current directory with the required variables
# Then simply run:
npx help-scout-mcp-server
```

### Global Installation

```bash
npm install -g help-scout-mcp-server

# Then run with credentials:
export HELPSCOUT_API_KEY="Bearer your-personal-access-token-here"
help-scout-mcp-server
```

### Local Development

```bash
git clone https://github.com/yourusername/help-scout-mcp-server.git
cd help-scout-mcp-server
npm install
npm run build

# Create a .env file with your credentials, then:
npm start
```

### Docker

```bash
# Option 1: With Personal Access Token (Recommended)
docker pull help-scout-mcp-server
docker run -p 3000:3000 -e HELPSCOUT_API_KEY="Bearer your-token-here" help-scout-mcp-server

# Option 2: With OAuth2 App Credentials (Legacy)
docker run -p 3000:3000 \
  -e HELPSCOUT_API_KEY="your-client-id-here" \
  -e HELPSCOUT_APP_SECRET="your-client-secret-here" \
  help-scout-mcp-server
```

## ⚙️ Configuration

Set the following environment variables:

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `HELPSCOUT_API_KEY` | For Personal Access Token: "Bearer your-token-here"<br>For OAuth2: Your Client ID | Yes | - |
| `HELPSCOUT_APP_SECRET` | Your Client Secret (only needed for OAuth2 auth) | Only for OAuth2 | - |
| `HELPSCOUT_BASE_URL` | Help Scout API base URL | No | https://api.helpscout.net/v2/ |
| `ALLOW_PII` | Allow personally identifiable information | No | false |
| `CACHE_TTL_SECONDS` | Cache time-to-live in seconds | No | 300 |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | No | info |

### Authentication Options

The server supports two authentication methods:

#### Option 1: Personal Access Token (Recommended)

This is the preferred and simpler method:

1. Go to Help Scout → Your Profile → API Keys
2. Create a new Personal Access Token
3. Use format `Bearer your-token-here` in the `HELPSCOUT_API_KEY` environment variable

#### Option 2: OAuth2 App Credentials

For legacy or more complex scenarios:

1. Go to Help Scout → Manage → API & Webhooks
2. Create a new OAuth2 application
3. Set `HELPSCOUT_API_KEY` to your Client ID
4. Set `HELPSCOUT_APP_SECRET` to your Client Secret

## 🔌 AI Assistant Integration

### Claude Desktop

Add this to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "npx",
      "args": ["help-scout-mcp-server"],
      "env": {
        "HELPSCOUT_API_KEY": "Bearer your-personal-access-token-here",
        "HELPSCOUT_BASE_URL": "https://api.helpscout.net/v2/",
        "ALLOW_PII": "false",
        "CACHE_TTL_SECONDS": "300",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

For OAuth2 authentication (legacy), use:

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "npx",
      "args": ["help-scout-mcp-server"],
      "env": {
        "HELPSCOUT_API_KEY": "your-client-id-here",
        "HELPSCOUT_APP_SECRET": "your-client-secret-here",
        "HELPSCOUT_BASE_URL": "https://api.helpscout.net/v2/",
        "ALLOW_PII": "false",
        "CACHE_TTL_SECONDS": "300",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Compatible Platforms

| Platform | Configuration Location | Notes |
|----------|------------------------|-------|
| [Claude Desktop](https://claude.ai/desktop) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) | Official Claude app |
| [Cursor](https://cursor.sh) | Settings > AI > Claude > MCP | AI-powered code editor |
| [continue.dev](https://continue.dev) | `.continue/config.json` | Open source coding assistant |
| [Claude VSCode](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-vscode) | Settings > Extensions > Claude | Official VSCode extension |

## 🛠️ MCP Components

### Resources

- `helpscout://inboxes`: Access all inboxes the user has access to
- `helpscout://conversations`: Access conversations with optional filtering (mailbox, status, tag, modifiedSince)
- `helpscout://threads`: Access thread messages for a specific conversation (requires conversationId parameter)
- `helpscout://clock`: Get current server timestamp for time-relative queries

### Tools

- `searchInboxes`: Search inboxes by name substring with configurable limits
- `searchConversations`: Search conversations with HelpScout query syntax, filters, and sorting
- `advancedConversationSearch`: Advanced conversation search with boolean queries for content, subject, email domains, and tags
- **`comprehensiveConversationSearch`**: **NEW** - Multi-status conversation search that automatically searches across active, pending, and closed conversations. Solves the common issue where searches return no results without specifying status.
- `getConversationSummary`: Get conversation summary with first customer message and latest staff reply
- `getThreads`: Retrieve all thread messages for a conversation with pagination support
- `getServerTime`: Get current server time for time-relative searches

### Search Examples

The MCP server supports powerful search capabilities using Help Scout's native query syntax:

#### ⭐ Recommended: Comprehensive Multi-Status Search
```javascript
// Best for most use cases - searches across all conversation statuses
comprehensiveConversationSearch({
  searchTerms: ["urgent", "billing"],
  timeframeDays: 60,
  inboxId: "256809"
})

// Event-specific search across all statuses
comprehensiveConversationSearch({
  searchTerms: ["conference", "event"],
  timeframeDays: 90,
  searchIn: ["both"],
  limitPerStatus: 50
})
```

#### Basic Conversation Search (Single Status)
```javascript
// Note: Specify status for better results
searchConversations({
  query: "(body:\"urgent\")",
  status: "active"
})

searchConversations({
  query: "(subject:\"billing\")",
  status: "closed"
})
```

#### Advanced Boolean Queries
```javascript
searchConversations({
  query: "(body:\"urgent\" OR subject:\"emergency\")",
  status: "pending"
})

advancedConversationSearch({
  contentTerms: ["urgent", "help"],
  emailDomain: "company.com",
  status: "active"
})
```

#### Search Patterns for Different Use Cases

**Event/Brand Search Pattern:**
```javascript
comprehensiveConversationSearch({
  searchTerms: ["CMA", "CMAfest", "Country Music Awards"],
  timeframeDays: 120,
  inboxId: "256809",
  statuses: ["active", "pending", "closed"]
})
```

**Customer Issue Tracking:**
```javascript
comprehensiveConversationSearch({
  searchTerms: ["refund", "billing issue"],
  timeframeDays: 30,
  searchIn: ["both"],
  limitPerStatus: 25
})
```

**Support Escalation Search:**
```javascript
comprehensiveConversationSearch({
  searchTerms: ["escalate", "urgent", "emergency"],
  timeframeDays: 7,
  statuses: ["active", "pending"]
})
```

#### ⚠️ Important Search Tips

1. **Status Requirement**: HelpScout often returns no results without specifying conversation status
2. **Use Comprehensive Search**: For best results, use `comprehensiveConversationSearch` which automatically handles multiple statuses
3. **Time Frames**: Default search looks back 60 days, adjust `timeframeDays` as needed
4. **Search Scope**: Use `searchIn` parameter to focus on body, subject, or both
5. **Result Limits**: Each status returns up to `limitPerStatus` results (default: 25)

#### Filtering and Sorting
- Filter by inbox, status (active/pending/closed/spam), tags, and date ranges
- Sort by createdAt, updatedAt, or conversation number
- Pagination support with configurable limits
- Field selection for partial responses

## 🧪 Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Start the server
npm start

# Run in development mode with auto-reload
npm run dev
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.