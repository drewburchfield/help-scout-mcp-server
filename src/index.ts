#!/usr/bin/env node
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
        version: '1.2.1',
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
      try {
        return {
          resources: await resourceHandler.listResources(),
        };
      } catch (error) {
        logger.error('Error listing resources', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
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
      try {
        return {
          tools: await toolHandler.listTools(),
        };
      } catch (error) {
        logger.error('Error listing tools', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
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
      try {
        return {
          prompts: await promptHandler.listPrompts(),
        };
      } catch (error) {
        logger.error('Error listing prompts', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
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
      try {
        const isConnected = await helpScoutClient.testConnection();
        if (!isConnected) {
          throw new Error('Failed to connect to Help Scout API');
        }
        logger.info('Help Scout API connection established');
      } catch (error) {
        logger.error('Failed to establish Help Scout API connection', { 
          error: error instanceof Error ? error.message : String(error) 
        });
        throw error;
      }

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
      // Close the MCP server
      await this.server.close();
      
      // Close HTTP connection pool
      await helpScoutClient.closePool();
      
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
  try {
    await server.stop();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
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

  try {
    await server.start();
  } catch (error) {
    logger.error('Failed to start server', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server when this module is executed directly (either via `node dist/index.js` or via an npm bin stub such as `npx help-scout-mcp-server`)
// Use a simpler approach that Jest can handle - check if we're in a test environment
const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
const invokedFromCLI = !isTestEnvironment;

if (invokedFromCLI) {
  main().catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start application', { error: errorMessage });
    console.error('Application startup failed:', errorMessage);
    process.exit(1);
  });
}