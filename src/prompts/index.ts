import { Prompt, GetPromptRequest, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';

export class PromptHandler {
  async listPrompts(): Promise<Prompt[]> {
    return [
      {
        name: 'search-last-7-days',
        description: 'Search recent conversations across all inboxes from the last 7 days',
        arguments: [
          {
            name: 'inboxId',
            description: 'Optional: Specific inbox ID to search within',
            required: false,
          },
          {
            name: 'status',
            description: 'Optional: Filter by conversation status (active, pending, closed, spam)',
            required: false,
          },
          {
            name: 'tag',
            description: 'Optional: Filter by specific tag',
            required: false,
          },
        ],
      },
      {
        name: 'find-urgent-tags',
        description: 'Find conversations with urgent or priority tags',
        arguments: [
          {
            name: 'inboxId',
            description: 'Optional: Specific inbox ID to search within',
            required: false,
          },
          {
            name: 'timeframe',
            description: 'Optional: Time period to search (e.g., "24h", "7d", "30d")',
            required: false,
          },
        ],
      },
      {
        name: 'list-inbox-activity',
        description: 'Show activity in a given inbox over the last N hours',
        arguments: [
          {
            name: 'inboxId',
            description: 'Required: The inbox ID to monitor',
            required: true,
          },
          {
            name: 'hours',
            description: 'Required: Number of hours to look back',
            required: true,
          },
          {
            name: 'includeThreads',
            description: 'Optional: Whether to include thread details (default: false)',
            required: false,
          },
        ],
      },
    ];
  }

  async getPrompt(request: GetPromptRequest): Promise<GetPromptResult> {
    const requestId = Math.random().toString(36).substring(7);
    
    logger.info('Prompt request started', {
      requestId,
      promptName: request.params.name,
      arguments: request.params.arguments,
    });

    try {
      let result: GetPromptResult;

      switch (request.params.name) {
        case 'search-last-7-days':
          result = await this.searchLast7Days(request.params.arguments || {});
          break;
        case 'find-urgent-tags':
          result = await this.findUrgentTags(request.params.arguments || {});
          break;
        case 'list-inbox-activity':
          result = await this.listInboxActivity(request.params.arguments || {});
          break;
        default:
          throw new Error(`Unknown prompt: ${request.params.name}`);
      }

      logger.info('Prompt request completed', {
        requestId,
        promptName: request.params.name,
      });

      return result;
    } catch (error) {
      logger.error('Prompt request failed', {
        requestId,
        promptName: request.params.name,
        error: error instanceof Error ? error.message : String(error),
      });
      
      throw error;
    }
  }

  private async searchLast7Days(args: Record<string, unknown>): Promise<GetPromptResult> {
    const inboxId = args.inboxId as string | undefined;
    const status = args.status as string | undefined;
    const tag = args.tag as string | undefined;

    const prompt = `To search for conversations from the last 7 days, follow these steps:

1. First, get the current server time:
   \`\`\`
   Use the "getServerTime" tool to get the current timestamp
   \`\`\`

2. Calculate the date 7 days ago from the current time.

3. Search for conversations using the "searchConversations" tool with these parameters:
   \`\`\`json
   {
     "createdAfter": "<calculated_date_7_days_ago>",
     "limit": 50,
     "sort": "createdAt",
     "order": "desc"${inboxId ? `,\n     "inboxId": "${inboxId}"` : ''}${status ? `,\n     "status": "${status}"` : ''}${tag ? `,\n     "tag": "${tag}"` : ''}
   }
   \`\`\`

4. For each conversation found, you can optionally get more details using:
   - "getConversationSummary" tool for a quick overview
   - "getThreads" tool for full message history

Example time calculation:
- If current time is "2025-06-11T15:04:00Z"
- Then 7 days ago would be "2025-06-04T15:04:00Z"

This will return conversations created in the last 7 days, sorted by creation date (newest first).`;

    return {
      description: 'Instructions for searching conversations from the last 7 days',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: prompt,
          },
        },
      ],
    };
  }

  private async findUrgentTags(args: Record<string, unknown>): Promise<GetPromptResult> {
    const inboxId = args.inboxId as string | undefined;
    const timeframe = args.timeframe as string | undefined;

    let timeFilter = '';
    if (timeframe) {
      timeFilter = `

3. Calculate the appropriate time filter based on "${timeframe}":
   - For "24h": subtract 24 hours from current time
   - For "7d": subtract 7 days from current time  
   - For "30d": subtract 30 days from current time`;
    }

    const prompt = `To find conversations with urgent or priority tags, follow these steps:

1. Get current server time using the "getServerTime" tool.

2. Search for conversations with urgent-related tags using the "searchConversations" tool.${timeFilter}

3. Perform multiple searches for different urgent tag variations:
   
   a) Search for "urgent" tag:
   \`\`\`json
   {
     "tag": "urgent",
     "limit": 50,
     "sort": "createdAt",
     "order": "desc"${timeframe ? `,\n     "createdAfter": "<calculated_time>"` : ''}${inboxId ? `,\n     "inboxId": "${inboxId}"` : ''}
   }
   \`\`\`

   b) Search for "priority" tag:
   \`\`\`json
   {
     "tag": "priority",
     "limit": 50,
     "sort": "createdAt", 
     "order": "desc"${timeframe ? `,\n     "createdAfter": "<calculated_time>"` : ''}${inboxId ? `,\n     "inboxId": "${inboxId}"` : ''}
   }
   \`\`\`

   c) Search for "high-priority" tag:
   \`\`\`json
   {
     "tag": "high-priority",
     "limit": 50,
     "sort": "createdAt",
     "order": "desc"${timeframe ? `,\n     "createdAfter": "<calculated_time>"` : ''}${inboxId ? `,\n     "inboxId": "${inboxId}"` : ''}
   }
   \`\`\`

4. Combine and deduplicate results from all searches.

5. For urgent conversations, consider using "getConversationSummary" to quickly assess the situation.

Note: The exact tag names may vary by organization. Common urgent tag variations include:
- "urgent", "priority", "high-priority", "escalated", "critical", "emergency"`;

    return {
      description: 'Instructions for finding conversations with urgent or priority tags',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: prompt,
          },
        },
      ],
    };
  }

  private async listInboxActivity(args: Record<string, unknown>): Promise<GetPromptResult> {
    const inboxId = args.inboxId as string;
    const hours = args.hours as number;
    const includeThreads = args.includeThreads as boolean | undefined;

    if (!inboxId) {
      throw new Error('inboxId argument is required for list-inbox-activity prompt');
    }

    if (!hours || typeof hours !== 'number') {
      throw new Error('hours argument is required and must be a number for list-inbox-activity prompt');
    }

    const prompt = `To show activity in inbox "${inboxId}" over the last ${hours} hours, follow these steps:

1. Get current server time using the "getServerTime" tool.

2. Calculate the timestamp ${hours} hours ago from the current time.
   - Subtract ${hours} hours from the current timestamp
   - Example: If current time is "2025-06-11T15:04:00Z" and hours is 24, 
     then ${hours} hours ago would be "${new Date(new Date().getTime() - hours * 60 * 60 * 1000).toISOString()}"

3. Search for conversations in the specified inbox using the "searchConversations" tool:
   \`\`\`json
   {
     "inboxId": "${inboxId}",
     "createdAfter": "<calculated_time_${hours}_hours_ago>",
     "limit": 100,
     "sort": "createdAt",
     "order": "desc"
   }
   \`\`\`

4. Analyze the results to show:
   - Total number of new conversations
   - Conversation statuses breakdown (active, pending, closed)
   - Most recent conversations

5. ${includeThreads ? `Since includeThreads is enabled, for each conversation found:
   - Use "getConversationSummary" to get key details
   - Optionally use "getThreads" for full message history of important conversations` : `For a quick overview, use "getConversationSummary" on the most recent or important conversations.`}

This will provide a comprehensive view of inbox activity over the specified time period.`;

    return {
      description: `Instructions for monitoring activity in inbox ${inboxId} over the last ${hours} hours`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: prompt,
          },
        },
      ],
    };
  }
}

export const promptHandler = new PromptHandler();