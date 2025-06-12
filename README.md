# 🎯 Help Scout MCP Server

[![npm version](https://badge.fury.io/js/helpscout-mcp-server.svg)](https://badge.fury.io/js/helpscout-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://docker.com/)

> An MCP server that enables Claude and other AI assistants to interact with Help Scout data

## 📋 Overview

The Help Scout MCP Server implements the [Model Context Protocol](https://modelcontextprotocol.io) to bridge Help Scout with AI agents. It allows large language models to intelligently search, analyze, and retrieve customer support data from your Help Scout account.

## ✨ Features

- **Rich Help Scout Integration**: Access conversations, customers, users, mailboxes, and workflows
- **Semantic Search**: Find relevant conversations based on natural language queries
- **Data Export**: Export customer data and support history for analysis
- **Conversation Management**: Allow AI to read, reply to, and manage support tickets
- **Multiple Transport Modes**: Supports stdio (local) and SSE (network) transports
- **Enterprise Security**: Configurable PII filtering and secure token handling

## 🚀 Installation

### NPX (Recommended)

```bash
# Option 1: With Personal Access Token (Recommended)
export HELPSCOUT_API_KEY="Bearer your-personal-access-token-here"
export HELPSCOUT_BASE_URL="https://api.helpscout.net/v2/"
npx helpscout-mcp-server

# Option 2: With OAuth2 App Credentials (Legacy)
export HELPSCOUT_API_KEY="your-client-id-here"
export HELPSCOUT_APP_SECRET="your-client-secret-here"
export HELPSCOUT_BASE_URL="https://api.helpscout.net/v2/"
npx helpscout-mcp-server

# You can also pass credentials as command line arguments
npx helpscout-mcp-server --api-key="Bearer your-token-here" --base-url="https://api.helpscout.net/v2/"

# Or create a .env file in your current directory with the required variables
# Then simply run:
npx helpscout-mcp-server
```

### Global Installation

```bash
npm install -g helpscout-mcp-server

# Then run with credentials:
export HELPSCOUT_API_KEY="Bearer your-personal-access-token-here"
helpscout-mcp-server
```

### Local Development

```bash
git clone https://github.com/yourusername/helpscout-mcp-server.git
cd helpscout-mcp-server
npm install
npm run build

# Create a .env file with your credentials, then:
npm start
```

### Docker

```bash
# Option 1: With Personal Access Token (Recommended)
docker pull helpscout-mcp-server
docker run -p 3000:3000 -e HELPSCOUT_API_KEY="Bearer your-token-here" helpscout-mcp-server

# Option 2: With OAuth2 App Credentials (Legacy)
docker run -p 3000:3000 \
  -e HELPSCOUT_API_KEY="your-client-id-here" \
  -e HELPSCOUT_APP_SECRET="your-client-secret-here" \
  helpscout-mcp-server
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
      "args": ["helpscout-mcp-server"],
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
      "args": ["helpscout-mcp-server"],
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

- `mailbox://`: Access mailbox data
- `conversation://`: Access conversation and ticket data
- `customer://`: Access customer profiles
- `user://`: Access Help Scout user data
- `workflow://`: Access Help Scout workflows

### Tools

- `search_conversations`: Find conversations based on query parameters
- `search_customers`: Find customer profiles based on query parameters
- `reply_to_conversation`: Send a reply to a Help Scout conversation
- `create_conversation`: Create a new conversation in Help Scout
- `update_customer`: Update customer information

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