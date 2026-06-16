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
import { helpScoutClient, type PaginatedResponse } from './utils/helpscout-client.js';
import { resourceHandler } from './resources/index.js';
import { toolHandler } from './tools/index.js';
import { promptHandler } from './prompts/index.js';
import type { Inbox } from './schema/types.js';
import { createMcpResourceError } from './utils/mcp-errors.js';

function getArgumentKeys(args: unknown): string[] {
  return args && typeof args === 'object' ? Object.keys(args as Record<string, unknown>) : [];
}

function formatInstructionValue(value: unknown): string {
  return JSON.stringify(value == null ? '' : String(value));
}

export class HelpScoutMCPServer {
  private server: Server;
  private discoveredInboxes: Inbox[] = [];

  /**
   * Private constructor - use static `create()` factory method instead.
   * This enables async inbox discovery before server instantiation.
   */
  private constructor(instructions: string) {
    this.server = new Server(
      {
        name: 'helpscout-search',
        version: '1.9.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
        },
        instructions,
      }
    );

    this.setupHandlers();
  }

  /**
   * Async factory method for creating the MCP server.
   * Discovers available inboxes and builds dynamic instructions before server creation.
   */
  static async create(): Promise<HelpScoutMCPServer> {
    const { instructions, inboxes } = await HelpScoutMCPServer.discoverAndBuildInstructions();
    const server = new HelpScoutMCPServer(instructions);
    server.discoveredInboxes = inboxes;
    logger.info('MCP server created with auto-discovered inboxes', { inboxCount: inboxes.length });
    return server;
  }

  /**
   * Discovers available inboxes and builds server instructions.
   * Called once during server creation to populate instructions sent to MCP clients.
   */
  private static async discoverAndBuildInstructions(): Promise<{ instructions: string; inboxes: Inbox[] }> {
    try {
      // Validate config before attempting API calls
      validateConfig();

      const inboxes: Inbox[] = [];
      let page = 1;
      let totalPages = 1;

      do {
        const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
          page,
          size: 100,
        });

        inboxes.push(...(response._embedded?.mailboxes || []));
        totalPages = response.page?.totalPages ?? page;
        page++;
      } while (page <= totalPages);

      const inboxList = inboxes.map(inbox =>
        `  - ${formatInstructionValue(inbox.name)} (ID: ${formatInstructionValue(inbox.id)})`
      ).join('\n');

      const instructions = `Help Scout MCP Server - Search and retrieve Help Scout inbox, conversation, customer, and organization data.

## Available Inboxes (${inboxes.length} total)
${inboxes.length > 0 ? inboxList : '  No inboxes found - check API credentials'}

## Tool Selection Guide
| Task | Tool |
|------|------|
| Find tickets by keyword (billing, refund, bug) | comprehensiveConversationSearch |
| List recent/filtered tickets | searchConversations |
| Complex filters (email domain, multiple tags) | advancedConversationSearch |
| Lookup by ticket number (#12345) | structuredConversationFilter |
| Browse customers by name or query | listCustomers |
| Browse customers with v3 cursor filters | listCustomersV3 |
| Find a customer by email | searchCustomersByEmail |
| Get a full customer profile | getCustomer |
| Get customer contact channels | getCustomerContacts |
| Get one customer contact sub-resource | getCustomerAddress/listCustomerEmails/listCustomerPhones/listCustomerChats/listCustomerSocialProfiles/listCustomerWebsites |
| Browse organizations | listOrganizations |
| Get an organization profile | getOrganization |
| See everyone in an organization | getOrganizationMembers |
| See all conversations for an organization | getOrganizationConversations |
| Get raw conversation metadata | getConversation |
| Get full conversation thread | getThreads |
| Quick conversation preview | getConversationSummary |
| Get inbox metadata | getInbox |
| Inspect inbox routing state | getInboxRouting |

## Workflow Patterns
- **Ticket investigation**: searchConversations → getConversation/getConversationSummary → getThreads
- **Keyword research**: comprehensiveConversationSearch → getThreads for details
- **Customer history**: listCustomersV3/searchCustomersByEmail → getCustomer → structuredConversationFilter/getThreads
- **Account review**: listOrganizations/getOrganization → getOrganizationMembers → getOrganizationConversations

## Notes
- Always use inbox IDs from the list above (not names)
- All search tools default to active+pending+closed statuses
- Use getServerTime for date-relative queries`;

      logger.info('Inbox discovery successful', { inboxCount: inboxes.length });
      return { instructions, inboxes };
    } catch (error) {
      // Fallback if discovery fails - server still starts but without inbox context
      const rawError = error instanceof Error ? error.message : String(error);
      // Sanitize error message to avoid exposing sensitive info (tokens, keys, paths)
      const safeError = rawError
        .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]') // Redact long alphanumeric strings (tokens/keys)
        .replace(/\/[^\s]+/g, '[PATH]'); // Redact file paths
      logger.warn('Inbox auto-discovery failed, using fallback instructions', { error: safeError });

      return {
        instructions: `Help Scout MCP Server - Read-only access to conversations.

Note: Inbox auto-discovery failed (${safeError}). Use listAllInboxes tool to see available inboxes.`,
        inboxes: [],
      };
    }
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
      try {
        const resource = await resourceHandler.handleResource(request.params.uri);
        return {
          contents: [resource],
        };
      } catch (error) {
        return {
          contents: [
            createMcpResourceError(error, {
              resourceUri: request.params.uri,
              requestId: Math.random().toString(36).substring(7),
            }),
          ],
        };
      }
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
        argumentKeys: getArgumentKeys(request.params.arguments),
      });
      const meta = request.params._meta as { userQuery?: unknown } | undefined;
      const userQuery = typeof meta?.userQuery === 'string' && meta.userQuery.trim()
        ? meta.userQuery
        : undefined;
      const requestForTool = userQuery
        ? {
          ...request,
          params: {
            ...request.params,
            arguments: {
              ...(request.params.arguments || {}),
              __userQuery: userQuery,
            },
          },
        }
        : request;
      return await toolHandler.callTool(requestForTool);
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
        argumentKeys: getArgumentKeys(request.params.arguments),
      });
      return await promptHandler.getPrompt(request);
    });
  }

  async start(): Promise<void> {
    try {
      // Validate configuration
      validateConfig();
      logger.info('Configuration validated');

      // Test Help Scout connection only if inbox discovery failed
      // (successful inbox discovery already proves connection works)
      if (this.discoveredInboxes.length === 0) {
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
      } else {
        logger.info('Help Scout API connection established (verified during inbox discovery)');
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
      throw error;
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
export async function main(): Promise<void> {
  const server = await HelpScoutMCPServer.create();
  
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
