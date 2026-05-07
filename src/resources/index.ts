import { TextResourceContents, Resource } from '@modelcontextprotocol/sdk/types.js';
import { helpScoutClient, PaginatedResponse } from '../utils/helpscout-client.js';
import { Inbox, Conversation, Thread, ServerTime } from '../schema/types.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { PII_REDACTED_BODY } from '../utils/constants.js';

export class ResourceHandler {
  async handleResource(uri: string): Promise<TextResourceContents> {
    const url = new URL(uri);
    const protocol = url.protocol.slice(0, -1); // Remove trailing colon
    
    if (protocol !== 'helpscout') {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    const path = url.hostname; // For custom protocols like helpscout://, the resource name is in hostname
    const searchParams = Object.fromEntries(url.searchParams.entries());

    // NAS-471: Bounds checking for page/size params
    if (searchParams.page) {
      const page = parseInt(searchParams.page, 10);
      if (isNaN(page) || page < 1 || page > 10000) {
        throw new Error('page must be a number between 1 and 10000');
      }
    }
    if (searchParams.size) {
      const size = parseInt(searchParams.size, 10);
      if (isNaN(size) || size < 1 || size > 50) {
        throw new Error('size must be a number between 1 and 50');
      }
    }

    logger.info('Handling resource request', { uri, path, params: searchParams });

    switch (path) {
      case 'inboxes':
        return this.getInboxesResource(searchParams);
      case 'conversations':
        return this.getConversationsResource(searchParams);
      case 'threads':
        return this.getThreadsResource(searchParams);
      case 'clock':
        return this.getClockResource();
      default:
        throw new Error(`Unknown resource path: ${path}`);
    }
  }

  private async getInboxesResource(params: Record<string, string>): Promise<TextResourceContents> {
    try {
      const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
        page: parseInt(params.page || '1', 10),
        size: parseInt(params.size || '50', 10),
      });

      const inboxes = response._embedded?.mailboxes || [];

      return {
        uri: 'helpscout://inboxes',
        mimeType: 'application/json',
        text: JSON.stringify({
          inboxes,
          pagination: response.page,
          links: response._links,
        }, null, 2),
      };
    } catch (error) {
      logger.error('Failed to fetch inboxes', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async getConversationsResource(params: Record<string, string>): Promise<TextResourceContents> {
    try {
      const queryParams: Record<string, unknown> = {
        page: parseInt(params.page || '1', 10),
        size: parseInt(params.size || '50', 10),
      };

      if (params.mailbox) queryParams.mailbox = params.mailbox;
      if (params.status) queryParams.status = params.status;
      if (params.tag) queryParams.tag = params.tag;
      if (params.modifiedSince) queryParams.modifiedSince = params.modifiedSince;

      const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);

      const conversations = response._embedded?.conversations || [];

      return {
        uri: 'helpscout://conversations',
        mimeType: 'application/json',
        text: JSON.stringify({
          conversations,
          pagination: response.page,
          links: response._links,
        }, null, 2),
      };
    } catch (error) {
      logger.error('Failed to fetch conversations', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async getThreadsResource(params: Record<string, string>): Promise<TextResourceContents> {
    const conversationId = params.conversationId;
    if (!conversationId) {
      throw new Error('conversationId parameter is required for threads resource');
    }
    if (!/^\d+$/.test(conversationId)) {
      throw new Error('conversationId must be a numeric value');
    }

    try {
      const response = await helpScoutClient.get<PaginatedResponse<Thread>>(`/conversations/${conversationId}/threads`, {
        page: parseInt(params.page || '1', 10),
        size: parseInt(params.size || '50', 10),
      });

      const threads = response._embedded?.threads || [];

      const redactedThreads = threads.map(thread => ({
        ...thread,
        body: config.security.allowPii ? thread.body : PII_REDACTED_BODY,
      }));

      return {
        uri: `helpscout://threads?conversationId=${conversationId}`,
        mimeType: 'application/json',
        text: JSON.stringify({
          conversationId,
          threads: redactedThreads,
          pagination: response.page,
          links: response._links,
        }, null, 2),
      };
    } catch (error) {
      logger.error('Failed to fetch threads', { 
        conversationId, 
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  private getClockResource(): TextResourceContents {
    const now = new Date();
    const serverTime: ServerTime = {
      isoTime: now.toISOString(),
      unixTime: Math.floor(now.getTime() / 1000),
    };

    return {
      uri: 'helpscout://clock',
      mimeType: 'application/json',
      text: JSON.stringify(serverTime, null, 2),
    };
  }

  async listResources(): Promise<Resource[]> {
    return [
      {
        uri: 'helpscout://inboxes',
        name: 'Help Scout Inboxes',
        description: 'All inboxes the user has access to',
        mimeType: 'application/json',
      },
      {
        uri: 'helpscout://conversations',
        name: 'Help Scout Conversations',
        description: 'Conversations matching filters (use query parameters to filter)',
        mimeType: 'application/json',
      },
      {
        uri: 'helpscout://threads',
        name: 'Help Scout Thread Messages',
        description: 'Full thread messages for a conversation (requires conversationId parameter)',
        mimeType: 'application/json',
      },
      {
        uri: 'helpscout://clock',
        name: 'Server Time',
        description: 'Current server timestamp for time-relative queries',
        mimeType: 'application/json',
      },
    ];
  }
}

export const resourceHandler = new ResourceHandler();
