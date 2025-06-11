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

## Repository Management Strategy

This repository follows a dual-branch strategy for managing development vs public release:

### Branch Structure

- **`dev` branch**: Complete development version
  - Contains CLAUDE.md (this file)
  - Contains original PRD documentation (helpscout_mcp_prd.md)
  - Contains development notes and internal files
  - Contains claude-desktop-config.json example
  - May reference development tools and processes

- **`main` branch**: Clean public release version
  - Excludes CLAUDE.md and internal development files
  - Excludes PRD and development documentation
  - Clean commit history without development references
  - Ready for open source publication

### Workflow

1. **All development work happens on `dev` branch**
2. **When ready to publish/update public version:**
   - Create clean `main` branch from `dev`
   - Remove internal files: CLAUDE.md, helpscout_mcp_prd.md, claude-desktop-config.json
   - Clean up any development references in commit messages
   - Push `main` branch for public consumption

### Files to Exclude from Public Release

- `CLAUDE.md` (this file)
- `helpscout_mcp_prd.md` (original PRD)
- `claude-desktop-config.json` (development example)
- Any files with internal development notes
- References to development tools in commit messages

### Syncing Changes

When making updates:
1. Work on `dev` branch with full context
2. Test and validate changes
3. Cherry-pick or recreate clean commits for `main` branch
4. Ensure `main` branch maintains clean public presentation

This approach allows us to maintain full development context while presenting a polished public repository.