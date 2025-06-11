# 🎯 Help Scout MCP Server

[![npm version](https://badge.fury.io/js/helpscout-mcp-server.svg)](https://badge.fury.io/js/helpscout-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://docker.com/)

> **The first and only MCP server for Help Scout integration** 🏆

A powerful [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that bridges Help Scout with AI agents. Enable LLMs to intelligently search, analyze, and retrieve customer support data from your Help Scout account with enterprise-grade security and performance.

## ✨ Features

- **🔍 Advanced Search**: Search inboxes, conversations, and threads with rich filtering
- **⏰ Time-Relative Queries**: Built-in server time anchor for accurate date filtering  
- **🚀 High Performance**: LRU caching with configurable TTL for sub-second responses
- **🔒 Enterprise Security**: PII redaction, read-only access, and OAuth2 authentication
- **📋 MCP Compliant**: Full Model Context Protocol implementation with resources, tools & prompts
- **🐳 Production Ready**: Docker support with health checks and observability
- **🎯 Pre-built Prompts**: Ready-to-use workflows for common support scenarios
- **📊 Smart Pagination**: Cursor-based navigation with field selection for optimal performance

## 🚀 Quick Start

### 📦 NPM Installation (Recommended)

```bash
# Install globally
npm install -g helpscout-mcp-server

# Or install locally in your project
npm install helpscout-mcp-server
```

### ⚡ Get Started in 2 Minutes

1. **Get Help Scout API credentials** from your Help Scout account
2. **Configure Claude Desktop** with your credentials:

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "npx",
      "args": ["helpscout-mcp-server"],
      "env": {
        "HELPSCOUT_API_KEY": "Bearer your-personal-access-token-here"
      }
    }
  }
}
```

3. **Start chatting** with Claude about your Help Scout data! 🎉

### 💡 Example Conversations

Once connected, you can ask Claude questions like:

- *"Show me all urgent conversations from the last 24 hours"*
- *"Find conversations tagged with 'billing' that are still open"*  
- *"What's the latest activity in our support inbox?"*
- *"Get me the conversation thread for ticket #12345"*
- *"Search for conversations mentioning 'refund' this week"*

### 🛠️ Development Installation

```bash
# Clone the repository
git clone https://github.com/drewburchfield/helpscout-mcp-server.git
cd helpscout-mcp-server

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Help Scout credentials

# Build and test
npm run build
npm start
```

### 🐳 Docker Deployment

```bash
# Quick start with Docker Compose
docker-compose up -d

# Or build and run manually
docker build -t helpscout-mcp-server .
docker run --env-file .env -i helpscout-mcp-server
```

## Configuration

Create a `.env` file with the following variables:

```env
# Required
HELPSCOUT_API_KEY=your-api-key-here
HELPSCOUT_APP_SECRET=your-app-secret-here
HELPSCOUT_BASE_URL=https://api.helpscout.net/v2/

# Optional
ALLOW_PII=false                 # Enable to include message bodies
CACHE_TTL_SECONDS=300          # Cache TTL in seconds
MAX_CACHE_SIZE=10000           # Maximum cache entries
LOG_LEVEL=info                 # Logging level (error, warn, info, debug)
```

### Help Scout API Setup

1. Go to Help Scout → Manage → API & Webhooks
2. Create a new OAuth2 application
3. Note your Client ID and Client Secret
4. Use Client Credentials grant type for server-to-server access

## MCP Resources

| URI | Description |
|-----|-------------|
| `helpscout://inboxes` | All inboxes user has access to |
| `helpscout://conversations` | Conversations matching filters |
| `helpscout://threads` | Thread messages for a conversation |
| `helpscout://clock` | Current server timestamp (UTC) |

## MCP Tools

### `searchInboxes`
Search inboxes by name substring.

**Parameters:**
- `query` (string): Search term for inbox names
- `limit` (number, optional): Max results (1-100, default: 50)
- `cursor` (string, optional): Pagination cursor

### `searchConversations`
Search conversations with filters.

**Parameters:**
- `inboxId` (string, optional): Filter by inbox ID
- `tag` (string, optional): Filter by tag name  
- `status` (string, optional): Filter by status (active, pending, closed, spam)
- `createdAfter` (string, optional): ISO8601 timestamp
- `createdBefore` (string, optional): ISO8601 timestamp
- `limit` (number, optional): Max results (1-100, default: 50)
- `sort` (string, optional): Sort field (createdAt, updatedAt, number)
- `order` (string, optional): Sort order (asc, desc)
- `fields` (array, optional): Specific fields to return

### `getConversationSummary`
Get conversation overview with first customer message and latest staff reply.

**Parameters:**
- `conversationId` (string): Conversation ID

### `getThreads`
Get all thread messages for a conversation.

**Parameters:**
- `conversationId` (string): Conversation ID
- `limit` (number, optional): Max threads (1-200, default: 200)

### `getServerTime`
Get current server time for time-relative queries.

**Returns:**
```json
{
  "isoTime": "2025-06-11T15:04:00Z",
  "unixTime": 1718127840
}
```

## MCP Prompts

### `search-last-7-days`
Pre-built prompt for searching recent conversations across all inboxes.

### `find-urgent-tags`
Find conversations with urgent, priority, or high-priority tags.

### `list-inbox-activity`
Monitor activity in a specific inbox over a time period.

## Usage Examples

### With Claude Desktop (Local Installation)

**Important:** Claude Desktop requires local installation, not Docker containers, due to stdio communication requirements.

1. **Install and build locally:**
```bash
npm install
npm run build
```

2. **Add to your Claude Desktop MCP configuration:**
```json
{
  "mcpServers": {
    "helpscout": {
      "command": "node",
      "args": ["/absolute/path/to/helpscout-mcp-server/dist/index.js"],
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

**Note:** Use the absolute path to your project directory. You can also find this configuration in the included `claude-desktop-config.json` file.

### Docker Usage (Development & Production)

**Docker is ideal for:**
- Development testing and validation
- Production deployments  
- CI/CD pipelines
- **Not suitable for Claude Desktop integration**

```bash
# Build and run with Docker
docker build -t helpscout-mcp-server .
docker run --env-file .env -i helpscout-mcp-server

# Or use Docker Compose
docker-compose up

# Test server functionality (not Claude Desktop integration)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | docker run --env-file .env -i helpscout-mcp-server
```

### Direct Usage (Local Development)

```bash
# Start the server locally
npm run build
node dist/index.js

# The server communicates via stdio MCP protocol
# Connect with any MCP-compatible client
```

## API Rate Limits

The server implements automatic retry with exponential backoff for Help Scout rate limits (429 responses). Rate limit information is included in error responses when applicable.

## Security & Privacy

- **Read-Only Access**: Server only performs read operations
- **PII Redaction**: Message bodies are redacted by default (set `ALLOW_PII=true` to include)
- **Authentication**: Uses OAuth2 Client Credentials flow
- **Caching**: In-memory LRU cache with configurable TTL

## Development

```bash
# Development mode with auto-reload
npm run dev

# Type checking
npm run type-check

# Linting
npm run lint

# Build
npm run build

# Clean build files
npm run clean
```

## 🔧 Development

### Adding Tests

Before publishing to npm, we recommend adding comprehensive tests:

```bash
# Run tests
npm test

# Run type checking
npm run type-check

# Run linting
npm run lint
```

### Publishing to NPM

To publish this server to npm for easy installation:

1. **Update package.json** with your details:
```json
{
  "name": "helpscout-mcp-server",
  "repository": "https://github.com/yourusername/helpscout-mcp-server",
  "homepage": "https://github.com/yourusername/helpscout-mcp-server#readme"
}
```

2. **Build and publish**:
```bash
npm run build
npm publish
```

3. **Users can then install globally**:
```bash
npm install -g helpscout-mcp-server
```

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. 🍴 Fork the repository
2. 🌟 Create a feature branch (`git checkout -b feature/amazing-feature`)
3. 💻 Make your changes
4. ✅ Add tests for new functionality
5. 🧪 Ensure all tests pass (`npm test`)
6. 📝 Update documentation as needed
7. 🚀 Submit a pull request

### 🐛 Bug Reports

Found a bug? Please [open an issue](../../issues) with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, OS, etc.)

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io) - The protocol specification
- [Claude Desktop](https://claude.ai/desktop) - Official Claude desktop application
- [Help Scout API](https://developer.helpscout.com/) - Official Help Scout API documentation

## 🙏 Acknowledgments

- [Anthropic](https://anthropic.com) for the Model Context Protocol
- [Help Scout](https://helpscout.com) for their excellent API
- The MCP community for inspiration and feedback

---

**⭐ If this project helped you, please consider giving it a star!**