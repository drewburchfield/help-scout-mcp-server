#!/usr/bin/env node

import { fileURLToPath } from 'url';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { validateConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { helpScoutClient } from './utils/helpscout-client.js';
import { resourceHandler } from './resources/index.js';
import { toolHandler } from './tools/index.js';
import { promptHandler } from './prompts/index.js';

export class HelpScoutMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'helpscout-search',
        version: '1.0.9',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      logger.debug('Listing resources');
      return {
        resources: await resourceHandler.listResources(),
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      logger.debug('Reading resource', { uri: request.params.uri });
      const resource = await resourceHandler.handleResource(request.params.uri);
      return {
        contents: [resource],
      };
    });

    // Tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.debug('Listing tools');
      return {
        tools: await toolHandler.listTools(),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      logger.debug('Calling tool', { 
        name: request.params.name, 
        arguments: request.params.arguments 
      });
      return await toolHandler.callTool(request);
    });

    // Prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      logger.debug('Listing prompts');
      return {
        prompts: await promptHandler.listPrompts(),
      };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      logger.debug('Getting prompt', { 
        name: request.params.name, 
        arguments: request.params.arguments 
      });
      return await promptHandler.getPrompt(request);
    });
  }

  async start(): Promise<void> {
    try {
      // Validate configuration
      validateConfig();
      logger.info('Configuration validated');

      // Test Help Scout connection
      const isConnected = await helpScoutClient.testConnection();
      if (!isConnected) {
        throw new Error('Failed to connect to Help Scout API');
      }
      logger.info('Help Scout API connection established');

      // Start the server
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      logger.info('Help Scout MCP Server started successfully');
      console.error('Help Scout MCP Server started and listening on stdio');
      
      // Keep the process running
      process.stdin.resume();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to start server', { error: errorMessage });
      console.error('MCP Server startup failed:', errorMessage);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.server.close();
      logger.info('Help Scout MCP Server stopped');
    } catch (error) {
      logger.error('Error stopping server', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
}

// Handle graceful shutdown
async function shutdown(server: HelpScoutMCPServer): Promise<void> {
  console.error('Received shutdown signal, stopping server...');
  await server.stop();
  process.exit(0);
}

// Main execution
async function main(): Promise<void> {
  const server = new HelpScoutMCPServer();
  
  // Setup signal handlers for graceful shutdown
  process.on('SIGINT', () => shutdown(server));
  process.on('SIGTERM', () => shutdown(server));
  
  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    console.error('Uncaught exception:', error.message, error.stack);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
    console.error('Unhandled rejection:', String(reason));
    process.exit(1);
  });

  await server.start();
}

// Start the server when this module is executed directly (either via `node dist/index.js` or via an npm bin stub such as `npx help-scout-mcp-server`)
const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

// When the script is launched through an npm-generated bin wrapper, `process.argv[1]` points to the wrapper file,
// not to `dist/index.js`. The wrapper immediately requires (imports) this file, so `main()` should still run.
// We therefore only skip `main()` when the module is imported *programmatically* (e.g., in tests) **and** the caller
// did not invoke it via the CLI. In those cases the wrapper path comparison will not match the source file path.
const invokedFromCLI = executedFile === currentFile || executedFile.endsWith('help-scout-mcp-server');

if (invokedFromCLI) {
  main().catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start application', { error: errorMessage });
    console.error('Application startup failed:', errorMessage);
    process.exit(1);
  });
}