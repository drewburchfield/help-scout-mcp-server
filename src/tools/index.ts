import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { helpScoutClient, PaginatedResponse } from '../utils/helpscout-client.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import {
  Inbox,
  Conversation,
  Thread,
  ServerTime,
  SearchInboxesInputSchema,
  SearchConversationsInputSchema,
  GetThreadsInputSchema,
  GetConversationSummaryInputSchema,
} from '../schema/types.js';

export class ToolHandler {
  async listTools(): Promise<Tool[]> {
    return [
      {
        name: 'searchInboxes',
        description: 'Search inboxes by name substring',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to match inbox names',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 50,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'searchConversations',
        description: 'Search conversations with various filters',
        inputSchema: {
          type: 'object',
          properties: {
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name',
            },
            status: {
              type: 'string',
              enum: ['active', 'pending', 'closed', 'spam'],
              description: 'Filter by conversation status',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 50,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'updatedAt', 'number'],
              default: 'createdAt',
              description: 'Sort field',
            },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: 'desc',
              description: 'Sort order',
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific fields to return (for partial responses)',
            },
          },
        },
      },
      {
        name: 'getConversationSummary',
        description: 'Get conversation summary with first customer message and latest staff reply',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get summary for',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getThreads',
        description: 'Get all thread messages for a conversation',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get threads for',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of threads (1-200)',
              minimum: 1,
              maximum: 200,
              default: 200,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getServerTime',
        description: 'Get current server time for time-relative searches',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    logger.info('Tool call started', {
      requestId,
      toolName: request.params.name,
      arguments: request.params.arguments,
    });

    try {
      let result: CallToolResult;

      switch (request.params.name) {
        case 'searchInboxes':
          result = await this.searchInboxes(request.params.arguments || {});
          break;
        case 'searchConversations':
          result = await this.searchConversations(request.params.arguments || {});
          break;
        case 'getConversationSummary':
          result = await this.getConversationSummary(request.params.arguments || {});
          break;
        case 'getThreads':
          result = await this.getThreads(request.params.arguments || {});
          break;
        case 'getServerTime':
          result = await this.getServerTime();
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const duration = Date.now() - startTime;
      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Tool call failed', {
        requestId,
        toolName: request.params.name,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });
      
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async searchInboxes(args: unknown): Promise<CallToolResult> {
    const input = SearchInboxesInputSchema.parse(args);
    
    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: input.limit,
    });

    const inboxes = response._embedded?.mailboxes || [];
    const filteredInboxes = inboxes.filter(inbox => 
      inbox.name.toLowerCase().includes(input.query.toLowerCase())
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: filteredInboxes,
            query: input.query,
            totalFound: filteredInboxes.length,
          }, null, 2),
        },
      ],
    };
  }

  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);
    
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sort,
      sortOrder: input.order,
    };

    if (input.inboxId) queryParams.mailbox = input.inboxId;
    if (input.status) queryParams.status = input.status;
    if (input.tag) queryParams.tag = input.tag;
    if (input.createdAfter) queryParams.modifiedSince = input.createdAfter;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    
    let conversations = response._embedded?.conversations || [];

    // Apply additional filtering
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    }

    // Apply field selection if specified
    if (input.fields && input.fields.length > 0) {
      conversations = conversations.map(conv => {
        const filtered: Partial<Conversation> = {};
        input.fields!.forEach(field => {
          if (field in conv) {
            (filtered as any)[field] = (conv as any)[field];
          }
        });
        return filtered as Conversation;
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: conversations,
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  private async getConversationSummary(args: unknown): Promise<CallToolResult> {
    const input = GetConversationSummaryInputSchema.parse(args);
    
    // Get conversation details
    const conversation = await helpScoutClient.get<Conversation>(`/conversations/${input.conversationId}`);
    
    // Get threads to find first customer message and latest staff reply
    const threadsResponse = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      { page: 1, size: 50 }
    );
    
    const threads = threadsResponse._embedded?.threads || [];
    const customerThreads = threads.filter(t => t.type === 'customer');
    const staffThreads = threads.filter(t => t.type === 'message' && t.createdBy);
    
    const firstCustomerMessage = customerThreads.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0];
    
    const latestStaffReply = staffThreads.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    const summary = {
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        customer: conversation.customer,
        assignee: conversation.assignee,
        tags: conversation.tags,
      },
      firstCustomerMessage: firstCustomerMessage ? {
        id: firstCustomerMessage.id,
        body: config.security.allowPii ? firstCustomerMessage.body : '[REDACTED]',
        createdAt: firstCustomerMessage.createdAt,
        customer: firstCustomerMessage.customer,
      } : null,
      latestStaffReply: latestStaffReply ? {
        id: latestStaffReply.id,
        body: config.security.allowPii ? latestStaffReply.body : '[REDACTED]',
        createdAt: latestStaffReply.createdAt,
        createdBy: latestStaffReply.createdBy,
      } : null,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async getThreads(args: unknown): Promise<CallToolResult> {
    const input = GetThreadsInputSchema.parse(args);
    
    const response = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      {
        page: 1,
        size: input.limit,
      }
    );

    const threads = response._embedded?.threads || [];
    
    // Redact PII if configured
    const processedThreads = threads.map(thread => ({
      ...thread,
      body: config.security.allowPii ? thread.body : '[REDACTED]',
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threads: processedThreads,
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  private async getServerTime(): Promise<CallToolResult> {
    const now = new Date();
    const serverTime: ServerTime = {
      isoTime: now.toISOString(),
      unixTime: Math.floor(now.getTime() / 1000),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(serverTime, null, 2),
        },
      ],
    };
  }
}

export const toolHandler = new ToolHandler();