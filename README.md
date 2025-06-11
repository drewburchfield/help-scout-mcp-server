# Help Scout MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that provides read-only access to Help Scout inboxes, conversations, and threads. This allows LLM agents to search and retrieve Help Scout data for customer support analysis and automation.

## Features

- **Search Capabilities**: Search inboxes, conversations, and threads
- **Time-Relative Queries**: Built-in server time reference for accurate date filtering
- **Caching**: LRU cache with configurable TTL for performance
- **Security**: PII redaction options and read-only API access
- **MCP Compliant**: Full Model Context Protocol implementation
- **Docker Ready**: Containerized deployment with Docker Compose

## Installation

### Prerequisites

- Node.js 18+ 
- Help Scout API credentials
- (Optional) Docker for containerized deployment

### Local Development

1. Clone and install dependencies:
```bash
git clone <repository-url>
cd helpscout-mcp-server
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your Help Scout credentials
```

3. Build and start:
```bash
npm run build
npm start
```

### Docker Deployment

```bash
# Using Docker Compose
docker-compose up -d

# Or build and run manually
docker build -t helpscout-mcp-server .
docker run -d --env-file .env helpscout-mcp-server
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

### With Claude Desktop

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "helpscout": {
      "command": "node",
      "args": ["/path/to/helpscout-mcp-server/dist/index.js"],
      "env": {
        "HELPSCOUT_API_KEY": "your-key-here",
        "HELPSCOUT_APP_SECRET": "your-secret-here"
      }
    }
  }
}
```

### Direct Usage

```bash
# Start the server
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

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

- [Help Scout API Documentation](https://developer.helpscout.com/)
- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [Issues and Bug Reports](issues)