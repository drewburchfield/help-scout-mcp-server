# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Help Scout MCP (Model Context Protocol) server that provides read-only access to Help Scout inboxes, conversations, and threads for LLM agents. The server follows the MCP specification and exposes resources, tools, and prompts for searching and retrieving Help Scout data.

## Development Commands

- `npm run dev`: Start development server with auto-reload
- `npm run build`: Build TypeScript to JavaScript
- `npm run start`: Start the production server
- `npm run lint`: Run ESLint
- `npm run type-check`: Run TypeScript type checking
- `npm run clean`: Clean build artifacts

## Architecture

The project implements an MCP-compliant server with:

- **Resources**: URI-based access to inboxes, conversations, threads, and server time
- **Tools**: API functions for searching and retrieving Help Scout data
- **Prompts**: Pre-built search templates for common use cases
- **Transport**: Stdio interface with optional HTTP support

Key architectural components:
- `src/tools/`: MCP tool implementations for Help Scout operations
- `src/resources/`: MCP resource handlers for data retrieval
- `src/prompts/`: MCP prompt handlers for common workflows
- `src/schema/`: TypeScript types and Zod schemas
- `src/utils/`: Shared utilities (config, logging, caching, API client)

## Environment Configuration

The project supports two authentication methods:

**Personal Access Token (recommended):**
```env
HELPSCOUT_API_KEY=Bearer your-personal-access-token
```

**OAuth2 App Credentials (legacy):**
```env
HELPSCOUT_API_KEY=your-client-id
HELPSCOUT_APP_SECRET=your-client-secret
```

Other configuration:
- `HELPSCOUT_BASE_URL`: API base URL (default: https://api.helpscout.net/v2/)
- `ALLOW_PII`: Enable message body content (default: false)
- `CACHE_TTL_SECONDS`: Cache TTL in seconds (default: 300)
- `MAX_CACHE_SIZE`: Maximum cache entries (default: 10000)
- `LOG_LEVEL`: Logging level (default: info)

## API Integration

- **API Version**: Help Scout v2 API
- **Authentication**: Personal Access Token or OAuth2 Client Credentials
- **Rate Limiting**: Implements exponential backoff for 429 responses with retry hints
- **Caching**: LRU cache with configurable TTL (300s for searches, 24h for inboxes, 60s for server time)
- **Error Handling**: Structured error responses with specific error codes

## MCP Implementation Details

**Resources:**
- `helpscout://inboxes`: List all accessible inboxes
- `helpscout://conversations`: Search conversations with filters
- `helpscout://threads`: Get thread messages for a conversation
- `helpscout://clock`: Current server timestamp for time-relative queries

**Tools:**
- `searchInboxes`: Search inboxes by name
- `searchConversations`: Advanced conversation search with filters
- `getConversationSummary`: Quick conversation overview
- `getThreads`: Full thread message history
- `getServerTime`: Current server time

**Prompts:**
- `search-last-7-days`: Find recent conversations
- `find-urgent-tags`: Locate urgent/priority conversations  
- `list-inbox-activity`: Monitor inbox activity over time

## Security Features

- **PII Protection**: Message bodies redacted by default unless `ALLOW_PII=true`
- **Read-Only Access**: Server only performs GET operations
- **Rate Limit Handling**: Automatic retry with exponential backoff
- **Input Validation**: All inputs validated with Zod schemas
- **Error Sanitization**: Structured error responses without sensitive data

## Testing the Server

To test the implementation:

1. Set up Help Scout API credentials in `.env`
2. Build the project: `npm run build`
3. Start the server: `npm start`
4. The server communicates via stdio using the MCP protocol

For Claude Desktop integration, see `claude-desktop-config.json` example.