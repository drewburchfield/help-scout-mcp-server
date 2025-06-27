import { Prompt, GetPromptRequest, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';

export class PromptHandler {
  async listPrompts(): Promise<Prompt[]> {
    return [
      {
        name: 'helpscout-best-practices',
        description: 'Essential workflow guide for using Help Scout MCP effectively - START HERE for correct search patterns',
        arguments: [],
      },
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
        case 'helpscout-best-practices':
          result = await this.helpScoutBestPractices();
          break;
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

  private async helpScoutBestPractices(): Promise<GetPromptResult> {
    const prompt = `# Help Scout MCP Best Practices Guide

## 🚨 CRITICAL WORKFLOW - Always Follow This Pattern

### The Golden Rule: Inbox Name → Inbox ID → Search

When a user mentions ANY inbox by name (e.g., "support inbox", "sales mailbox", "customer service"), you MUST:

1. **FIRST**: Call \`searchInboxes\` to find the inbox ID
   - Even if the name seems obvious, always look it up
   - Use empty string "" to list all inboxes if unsure
   - Example: \`searchInboxes(query: "support")\` or \`searchInboxes(query: "")\`

2. **THEN**: Use the inbox ID in your conversation search
   - Never skip the inbox lookup step
   - Always use the exact ID returned from searchInboxes

### Example Correct Workflow

**User**: "Show me urgent conversations in the support inbox"

**CORRECT Approach**:
\`\`\`
1. searchInboxes(query: "support")
   → Returns: [{id: "12345", name: "Support Inbox"}, ...]
   
2. comprehensiveConversationSearch({
     searchTerms: ["urgent"],
     inboxId: "12345"
   })
\`\`\`

**INCORRECT Approach** (DO NOT DO THIS):
\`\`\`
❌ comprehensiveConversationSearch({
     searchTerms: ["urgent"]
   })
   // Missing inbox filter - will search ALL inboxes!
\`\`\`

## 📋 Common Scenarios and Solutions

### Scenario 1: User Mentions Multiple Inboxes
**User**: "Check support and sales inboxes for refund requests"

**Workflow**:
1. Call searchInboxes(query: "") to list ALL inboxes
2. Identify the support and sales inbox IDs
3. Run separate searches for each inbox:
   - comprehensiveConversationSearch with support inbox ID
   - comprehensiveConversationSearch with sales inbox ID
4. Combine and present results clearly

### Scenario 2: No Results Found
If a search returns no results:
1. Verify the inbox ID is correct (re-run searchInboxes if needed)
2. Try broader search terms
3. Extend the timeframe (default is 60 days)
4. Check different statuses (active, pending, closed)
5. Consider that the inbox might be empty or have different naming

### Scenario 3: General Search Without Inbox Mention
**User**: "Find all conversations about billing issues"

**Workflow**:
1. Use comprehensiveConversationSearch WITHOUT inboxId
2. This searches across ALL accessible inboxes
3. Results will show which inbox each conversation belongs to

## 🛠️ Tool Selection Guide

### Use \`comprehensiveConversationSearch\` when:
- You need results across multiple statuses (recommended default)
- User wants a broad search
- You're not sure which status to use
- Initial searches return no results

### Use \`searchConversations\` when:
- You need very specific status filtering
- You're using advanced HelpScout query syntax
- You need custom sorting or field selection

### Use \`advancedConversationSearch\` when:
- You need complex boolean logic
- Searching by email domain
- Combining multiple search criteria

## ⚠️ Common Pitfalls to Avoid

1. **Never skip the inbox lookup** - Always use searchInboxes first when inbox names are mentioned
2. **Don't assume inbox IDs** - They're not guessable; you must look them up
3. **Remember status matters** - Help Scout often returns empty results without status filters
4. **Use the right tool** - comprehensiveConversationSearch is usually best for general searches
5. **Check your timeframes** - Default is 60 days; user might need longer

## 📊 Multi-Inbox Reporting Pattern

When analyzing across multiple inboxes:
\`\`\`
1. searchInboxes(query: "") → Get all inboxes
2. For each inbox:
   - Note the ID and name
   - Run comprehensiveConversationSearch with that inboxId
   - Collect results
3. Present organized summary:
   - Group by inbox
   - Show totals and breakdowns
   - Highlight important patterns
\`\`\`

## 🔍 Search Tips

- **Empty searches are valid**: searchInboxes(query: "") lists ALL inboxes
- **Case doesn't matter**: Searches are case-insensitive
- **Partial matches work**: "sup" will match "Support"
- **Be specific with timeframes**: Use createdAfter/createdBefore for precision
- **Combine search terms**: Use arrays in comprehensiveConversationSearch

Remember: When in doubt, start with searchInboxes(query: "") to see all available inboxes!`;

    return {
      description: 'Essential workflow guide for using Help Scout MCP effectively',
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

3. ${inboxId ? '' : 'IMPORTANT: If the user mentioned a specific inbox by name, you MUST first use "searchInboxes" to get the inbox ID.\n\n4. '}Search for conversations using the "searchConversations" tool with these parameters:
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

2. ${inboxId ? '' : 'CRITICAL: If the user mentioned a specific inbox by name (e.g., "support inbox"), you MUST first use "searchInboxes" to get the inbox ID.\n\n3. '}Search for conversations with urgent-related tags using the "searchConversations" tool.${timeFilter}

${inboxId ? '3' : '4'}. Perform multiple searches for different urgent tag variations:
   
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