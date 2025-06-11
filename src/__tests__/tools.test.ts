import { ToolHandler } from '../tools/index.js';

describe('ToolHandler', () => {
  let toolHandler: ToolHandler;

  beforeEach(() => {
    toolHandler = new ToolHandler();
  });

  describe('listTools', () => {
    it('should return all available tools', async () => {
      const tools = await toolHandler.listTools();
      
      expect(tools).toHaveLength(5);
      expect(tools.map(t => t.name)).toEqual([
        'searchInboxes',
        'searchConversations', 
        'getConversationSummary',
        'getThreads',
        'getServerTime'
      ]);
    });

    it('should have proper tool schemas', async () => {
      const tools = await toolHandler.listTools();
      
      tools.forEach(tool => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        expect(tool.inputSchema).toHaveProperty('properties');
      });
    });
  });

  describe('getServerTime', () => {
    it('should return server time without Help Scout API call', async () => {
      const result = await toolHandler.callTool({
        params: {
          name: 'getServerTime',
          arguments: {}
        }
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');
      
      const response = JSON.parse(result.content[0].text);
      expect(response).toHaveProperty('isoTime');
      expect(response).toHaveProperty('unixTime');
      expect(typeof response.isoTime).toBe('string');
      expect(typeof response.unixTime).toBe('number');
    });
  });
});