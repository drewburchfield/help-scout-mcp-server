/**
 * @jest-environment node
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Type-safe mocks
const mockValidateConfig = jest.fn<() => void>();
const mockLogger = {
  debug: jest.fn<(...args: any[]) => void>(),
  info: jest.fn<(...args: any[]) => void>(),
  error: jest.fn<(...args: any[]) => void>(),
  warn: jest.fn<(...args: any[]) => void>(),
};

const mockHelpScoutClient = {
  testConnection: jest.fn<() => Promise<boolean>>(),
};

const mockResourceHandler = {
  listResources: jest.fn<() => Promise<any[]>>(),
  handleResource: jest.fn<(uri: string) => Promise<any>>(),
};

const mockToolHandler = {
  listTools: jest.fn<() => Promise<any[]>>(),
  callTool: jest.fn<(request: any) => Promise<any>>(),
};

const mockPromptHandler = {
  listPrompts: jest.fn<() => Promise<any[]>>(),
  getPrompt: jest.fn<(request: any) => Promise<any>>(),
};

const mockServer = {
  setRequestHandler: jest.fn<(schema: any, handler: any) => void>(),
  connect: jest.fn<(transport: any) => Promise<void>>(),
  close: jest.fn<() => Promise<void>>(),
};

const mockTransport = {
  start: jest.fn<() => Promise<void>>(),
  close: jest.fn<() => Promise<void>>(),
};

// Mock all dependencies
jest.unstable_mockModule('../utils/config.js', () => ({
  validateConfig: mockValidateConfig,
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: mockLogger,
}));

jest.unstable_mockModule('../utils/helpscout-client.js', () => ({
  helpScoutClient: mockHelpScoutClient,
}));

jest.unstable_mockModule('../resources/index.js', () => ({
  resourceHandler: mockResourceHandler,
}));

jest.unstable_mockModule('../tools/index.js', () => ({
  toolHandler: mockToolHandler,
}));

jest.unstable_mockModule('../prompts/index.js', () => ({
  promptHandler: mockPromptHandler,
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn(() => mockServer),
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn(() => mockTransport),
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: { type: 'tools/call' },
  ListToolsRequestSchema: { type: 'tools/list' },
  ListResourcesRequestSchema: { type: 'resources/list' },
  ReadResourceRequestSchema: { type: 'resources/read' },
  ListPromptsRequestSchema: { type: 'prompts/list' },
  GetPromptRequestSchema: { type: 'prompts/get' },
}));

describe('HelpScoutMCPServer', () => {
  let HelpScoutMCPServer: any;
  let originalProcessExit: typeof process.exit;
  let originalProcessStdin: typeof process.stdin;
  let originalConsoleError: typeof console.error;

  beforeEach(async () => {
    // Clear all mocks
    jest.clearAllMocks();

    // Setup default mock behaviors
    mockValidateConfig.mockImplementation(() => {});
    mockHelpScoutClient.testConnection.mockResolvedValue(true);
    mockResourceHandler.listResources.mockResolvedValue([]);
    mockResourceHandler.handleResource.mockResolvedValue({});
    mockToolHandler.listTools.mockResolvedValue([]);
    mockToolHandler.callTool.mockResolvedValue({});
    mockPromptHandler.listPrompts.mockResolvedValue([]);
    mockPromptHandler.getPrompt.mockResolvedValue({});
    mockServer.setRequestHandler.mockImplementation(() => {});
    mockServer.connect.mockResolvedValue(undefined);
    mockServer.close.mockResolvedValue(undefined);

    // Mock process methods
    originalProcessExit = process.exit;
    originalProcessStdin = process.stdin;
    originalConsoleError = console.error;
    
    process.exit = jest.fn() as any;
    Object.defineProperty(process, 'stdin', {
      value: { resume: jest.fn() },
      writable: true,
      configurable: true
    });
    console.error = jest.fn();

    // Import the module after mocks are set up
    const module = await import('../index.js');
    HelpScoutMCPServer = module.HelpScoutMCPServer;
  });

  afterEach(() => {
    // Restore original functions
    process.exit = originalProcessExit;
    Object.defineProperty(process, 'stdin', {
      value: originalProcessStdin,
      writable: true,
      configurable: true
    });
    console.error = originalConsoleError;
  });

  describe('constructor', () => {
    it('should create server with correct configuration', () => {
      const server = new HelpScoutMCPServer();
      expect(server).toBeDefined();
    });

    it('should setup all request handlers', () => {
      new HelpScoutMCPServer();
      
      // Should register 6 handlers: ListResources, ReadResource, ListTools, CallTool, ListPrompts, GetPrompt
      expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(6);
    });
  });

  describe('request handlers', () => {
    let server: any;

    beforeEach(() => {
      server = new HelpScoutMCPServer();
    });

    it('should handle ListResources requests', async () => {
      const mockResources = [{ uri: 'test://resource', name: 'Test Resource' }];
      mockResourceHandler.listResources.mockResolvedValue(mockResources);

      // Get the handler function from the mock call
      const listResourcesCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) => call[0].type === 'resources/list'
      );
      expect(listResourcesCall).toBeDefined();

      const handler = listResourcesCall![1];
      const result = await handler();

      expect(mockResourceHandler.listResources).toHaveBeenCalled();
      expect(result).toEqual({ resources: mockResources });
      expect(mockLogger.debug).toHaveBeenCalledWith('Listing resources');
    });

    it('should handle ReadResource requests', async () => {
      const mockResource = { uri: 'test://resource', name: 'Test', text: 'content' };
      mockResourceHandler.handleResource.mockResolvedValue(mockResource);

      const readResourceCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) => call[0].type === 'resources/read'
      );
      expect(readResourceCall).toBeDefined();

      const handler = readResourceCall![1];
      const request = { params: { uri: 'test://resource' } };
      const result = await handler(request);

      expect(mockResourceHandler.handleResource).toHaveBeenCalledWith('test://resource');
      expect(result).toEqual({ contents: [mockResource] });
      expect(mockLogger.debug).toHaveBeenCalledWith('Reading resource', { uri: 'test://resource' });
    });

    it('should handle ListTools requests', async () => {
      const mockTools = [{ name: 'searchInboxes', description: 'Search inboxes' }];
      mockToolHandler.listTools.mockResolvedValue(mockTools);

      const listToolsCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) => call[0].type === 'tools/list'
      );
      expect(listToolsCall).toBeDefined();

      const handler = listToolsCall![1];
      const result = await handler();

      expect(mockToolHandler.listTools).toHaveBeenCalled();
      expect(result).toEqual({ tools: mockTools });
      expect(mockLogger.debug).toHaveBeenCalledWith('Listing tools');
    });

    it('should handle CallTool requests', async () => {
      const mockResult = { content: [{ type: 'text', text: 'result' }] };
      mockToolHandler.callTool.mockResolvedValue(mockResult);

      const callToolCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) => call[0].type === 'tools/call'
      );
      expect(callToolCall).toBeDefined();

      const handler = callToolCall![1];
      const request = {
        params: {
          name: 'searchInboxes',
          arguments: { query: 'test' }
        }
      };
      const result = await handler(request);

      expect(mockToolHandler.callTool).toHaveBeenCalledWith(request);
      expect(result).toEqual(mockResult);
      expect(mockLogger.debug).toHaveBeenCalledWith('Calling tool', {
        name: 'searchInboxes',
        arguments: { query: 'test' }
      });
    });

    it('should handle ListPrompts requests', async () => {
      const mockPrompts = [{ name: 'helpdesk-summary', description: 'Summarize tickets' }];
      mockPromptHandler.listPrompts.mockResolvedValue(mockPrompts);

      const listPromptsCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) => call[0].type === 'prompts/list'
      );
      expect(listPromptsCall).toBeDefined();

      const handler = listPromptsCall![1];
      const result = await handler();

      expect(mockPromptHandler.listPrompts).toHaveBeenCalled();
      expect(result).toEqual({ prompts: mockPrompts });
      expect(mockLogger.debug).toHaveBeenCalledWith('Listing prompts');
    });

    it('should handle GetPrompt requests', async () => {
      const mockPrompt = { messages: [{ role: 'user', content: { type: 'text', text: 'prompt' } }] };
      mockPromptHandler.getPrompt.mockResolvedValue(mockPrompt);

      const getPromptCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) => call[0].type === 'prompts/get'
      );
      expect(getPromptCall).toBeDefined();

      const handler = getPromptCall![1];
      const request = {
        params: {
          name: 'helpdesk-summary',
          arguments: { tickets: ['1', '2'] }
        }
      };
      const result = await handler(request);

      expect(mockPromptHandler.getPrompt).toHaveBeenCalledWith(request);
      expect(result).toEqual(mockPrompt);
      expect(mockLogger.debug).toHaveBeenCalledWith('Getting prompt', {
        name: 'helpdesk-summary',
        arguments: { tickets: ['1', '2'] }
      });
    });
  });

  describe('start method', () => {
    let server: any;

    beforeEach(() => {
      server = new HelpScoutMCPServer();
    });

    it('should start successfully with valid configuration', async () => {
      await server.start();

      expect(mockValidateConfig).toHaveBeenCalled();
      expect(mockHelpScoutClient.testConnection).toHaveBeenCalled();
      expect(mockServer.connect).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Configuration validated');
      expect(mockLogger.info).toHaveBeenCalledWith('Help Scout API connection established');
      expect(mockLogger.info).toHaveBeenCalledWith('Help Scout MCP Server started successfully');
    });

    it('should exit with error if configuration validation fails', async () => {
      const configError = new Error('Missing API key');
      mockValidateConfig.mockImplementation(() => {
        throw configError;
      });

      await server.start();

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to start server', {
        error: 'Missing API key'
      });
    });

    it('should exit with error if Help Scout connection fails', async () => {
      mockHelpScoutClient.testConnection.mockResolvedValue(false);

      await server.start();

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to start server', {
        error: 'Failed to connect to Help Scout API'
      });
    });

    it('should handle server connection errors', async () => {
      const connectionError = new Error('Connection failed');
      mockServer.connect.mockRejectedValue(connectionError);

      await server.start();

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to start server', {
        error: 'Connection failed'
      });
    });
  });

  describe('stop method', () => {
    let server: any;

    beforeEach(() => {
      server = new HelpScoutMCPServer();
    });

    it('should close server connection gracefully', async () => {
      await server.stop();

      expect(mockServer.close).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Help Scout MCP Server stopped');
    });

    it('should handle server close errors', async () => {
      const closeError = new Error('Close failed');
      mockServer.close.mockRejectedValue(closeError);

      await server.stop();

      expect(mockLogger.error).toHaveBeenCalledWith('Error stopping server', {
        error: 'Close failed'
      });
    });
  });

  describe('signal handling', () => {
    let server: any;

    beforeEach(() => {
      server = new HelpScoutMCPServer();
    });

    it('should handle SIGINT signal', async () => {
      const stopSpy = jest.spyOn(server, 'stop').mockResolvedValue(undefined);
      
      // Trigger SIGINT handler
      process.emit('SIGINT' as any);
      
      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(stopSpy).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should handle SIGTERM signal', async () => {
      const stopSpy = jest.spyOn(server, 'stop').mockResolvedValue(undefined);
      
      // Trigger SIGTERM handler
      process.emit('SIGTERM' as any);
      
      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(stopSpy).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('error handling', () => {
    it('should handle uncaught exceptions', () => {
      const error = new Error('Test uncaught exception');
      
      // Trigger uncaughtException handler
      process.emit('uncaughtException', error);
      
      expect(mockLogger.error).toHaveBeenCalledWith('Uncaught exception', {
        error: 'Test uncaught exception',
        stack: error.stack
      });
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should handle unhandled rejections', () => {
      const reason = 'Test unhandled rejection';
      
      // Trigger unhandledRejection handler
      (process as any).emit('unhandledRejection', reason);
      
      expect(mockLogger.error).toHaveBeenCalledWith('Unhandled rejection', {
        reason: 'Test unhandled rejection'
      });
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});