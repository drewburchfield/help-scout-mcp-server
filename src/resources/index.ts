import { Resource } from '@modelcontextprotocol/sdk/types.js';
import { helpScoutClient, PaginatedResponse } from '../utils/helpscout-client.js';
import { Inbox, Conversation, Thread, ServerTime } from '../schema/types.js';
import { logger } from '../utils/logger.js';

export class ResourceHandler {
  async handleResource(uri: string): Promise<Resource> {
    const url = new URL(uri);
    const protocol = url.protocol.slice(0, -1); // Remove trailing colon
    
    if (protocol !== 'helpscout') {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    const path = url.hostname; // For custom protocols like helpscout://, the resource name is in hostname
    const searchParams = Object.fromEntries(url.searchParams.entries());

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

  private async getInboxesResource(params: Record<string, string>): Promise<Resource> {
    try {
      const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
        page: parseInt(params.page || '1', 10),
        size: parseInt(params.size || '50', 10),
      });

      const inboxes = response._embedded?.mailboxes || [];

      return {
        uri: 'helpscout://inboxes',
        name: 'Help Scout Inboxes',
        description: 'All inboxes the user has access to',
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

  private async getConversationsResource(params: Record<string, string>): Promise<Resource> {
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
        name: 'Help Scout Conversations',
        description: 'Conversations matching the specified filters',
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

  private async getThreadsResource(params: Record<string, string>): Promise<Resource> {
    const conversationId = params.conversationId;
    if (!conversationId) {
      throw new Error('conversationId parameter is required for threads resource');
    }

    try {
      const response = await helpScoutClient.get<PaginatedResponse<Thread>>(`/conversations/${conversationId}/threads`, {
        page: parseInt(params.page || '1', 10),
        size: parseInt(params.size || '50', 10),
      });

      const threads = response._embedded?.threads || [];

      return {
        uri: `helpscout://threads?conversationId=${conversationId}`,
        name: 'Help Scout Thread Messages',
        description: `All messages in conversation ${conversationId}`,
        mimeType: 'application/json',
        text: JSON.stringify({
          conversationId,
          threads,
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

  private getClockResource(): Resource {
    const now = new Date();
    const serverTime: ServerTime = {
      isoTime: now.toISOString(),
      unixTime: Math.floor(now.getTime() / 1000),
    };

    return {
      uri: 'helpscout://clock',
      name: 'Server Time',
      description: 'Current server timestamp for time-relative queries',
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