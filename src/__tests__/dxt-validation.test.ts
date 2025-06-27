import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll } from '@jest/globals';

describe('DXT Extension Validation', () => {
  const dxtDir = path.join(process.cwd(), 'helpscout-mcp-extension');
  const manifestPath = path.join(dxtDir, 'manifest.json');
  const buildDir = path.join(dxtDir, 'build');
  let manifest: any;

  beforeAll(() => {
    // Ensure DXT is built before running tests
    if (!fs.existsSync(buildDir)) {
      throw new Error('DXT build directory not found. Run `npm run dxt:build` first.');
    }
    
    if (!fs.existsSync(manifestPath)) {
      throw new Error('DXT manifest.json not found.');
    }

    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  });

  describe('Manifest Validation', () => {
    it('should have required DXT fields', () => {
      expect(manifest.dxt_version).toBe('0.1');
      expect(manifest.name).toBe('help-scout-mcp-server');
      expect(manifest.display_name).toBe('Help Scout MCP Server');
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.description).toBeTruthy();
      expect(manifest.author).toHaveProperty('name');
      expect(manifest.license).toBe('MIT');
    });

    it('should have proper server configuration', () => {
      expect(manifest.server.type).toBe('node');
      expect(manifest.server.entry_point).toBe('build/server/index.js');
      expect(manifest.server.mcp_config.command).toBe('node');
      expect(manifest.server.mcp_config.args).toContain('${__dirname}/build/server/index.js');
    });

    it('should have OAuth2 authentication configuration', () => {
      const userConfig = manifest.user_config;
      
      // Should have client_id and app_secret (not personal access token)
      expect(userConfig.client_id).toBeDefined();
      expect(userConfig.app_secret).toBeDefined();
      expect(userConfig.client_id.type).toBe('string');
      expect(userConfig.app_secret.type).toBe('string');
      expect(userConfig.client_id.sensitive).toBe(true);
      expect(userConfig.app_secret.sensitive).toBe(true);
      expect(userConfig.client_id.required).toBe(true);
      expect(userConfig.app_secret.required).toBe(true);

      // Should NOT have personal access token fields
      expect(userConfig.api_key).toBeUndefined();
      expect(userConfig.personal_access_token).toBeUndefined();
    });

    it('should have all 7 MCP tools declared', () => {
      expect(manifest.tools).toHaveLength(7);
      
      const expectedTools = [
        'searchInboxes',
        'searchConversations', 
        'getConversationSummary',
        'getThreads',
        'getServerTime',
        'advancedConversationSearch',
        'comprehensiveConversationSearch'
      ];

      const toolNames = manifest.tools.map((tool: any) => tool.name);
      expectedTools.forEach(toolName => {
        expect(toolNames).toContain(toolName);
      });
    });

    it('should have all 4 MCP resources declared', () => {
      expect(manifest.resources).toHaveLength(4);
      
      const expectedResources = [
        'helpscout://inboxes',
        'helpscout://conversations',
        'helpscout://threads',
        'helpscout://clock'
      ];

      const resourceUris = manifest.resources.map((resource: any) => resource.uri);
      expectedResources.forEach(uri => {
        expect(resourceUris).toContain(uri);
      });
    });

    it('should have 3 MCP prompts declared', () => {
      expect(manifest.prompts).toHaveLength(3);
      
      const expectedPrompts = [
        'search-last-7-days',
        'find-urgent-tags', 
        'list-inbox-activity'
      ];

      const promptNames = manifest.prompts.map((prompt: any) => prompt.name);
      expectedPrompts.forEach(promptName => {
        expect(promptNames).toContain(promptName);
      });
    });

    it('should have environment variable mapping', () => {
      const env = manifest.server.mcp_config.env;
      
      expect(env.HELPSCOUT_API_KEY).toBe('${user_config.client_id}');
      expect(env.HELPSCOUT_APP_SECRET).toBe('${user_config.app_secret}');
      expect(env.HELPSCOUT_BASE_URL).toBe('${user_config.base_url}');
      expect(env.ALLOW_PII).toBe('${user_config.allow_pii}');
      expect(env.LOG_LEVEL).toBe('${user_config.log_level}');
      expect(env.CACHE_TTL_SECONDS).toBe('${user_config.cache_ttl}');
      expect(env.MAX_CACHE_SIZE).toBe('${user_config.max_cache_size}');
    });
  });

  describe('Build Structure Validation', () => {
    it('should have correct entry point file', () => {
      const entryPoint = path.join(buildDir, 'server/index.js');
      expect(fs.existsSync(entryPoint)).toBe(true);
      
      // Verify it's a valid JavaScript file
      const content = fs.readFileSync(entryPoint, 'utf8');
      expect(content).toContain('export');
      expect(content.length).toBeGreaterThan(1000); // Should be substantial
    });

    it('should have production package.json with correct dependencies', () => {
      const prodPackageJson = path.join(buildDir, 'package.json');
      expect(fs.existsSync(prodPackageJson)).toBe(true);
      
      const prodPkg = JSON.parse(fs.readFileSync(prodPackageJson, 'utf8'));
      expect(prodPkg.type).toBe('module');
      
      // Check all required dependencies are present
      const requiredDeps = [
        '@modelcontextprotocol/sdk',
        'axios',
        'lru-cache', 
        'zod',
        'dotenv'
      ];
      
      requiredDeps.forEach(dep => {
        expect(prodPkg.dependencies[dep]).toBeDefined();
      });

      // Should not have dev dependencies
      expect(prodPkg.devDependencies).toBeUndefined();
    });

    it('should have all required dependencies installed', () => {
      const nodeModules = path.join(buildDir, 'node_modules');
      expect(fs.existsSync(nodeModules)).toBe(true);
      
      // Check critical dependencies are actually installed
      const criticalDeps = ['axios', 'lru-cache', 'zod', '@modelcontextprotocol'];
      
      criticalDeps.forEach(dep => {
        const depPath = path.join(nodeModules, dep);
        expect(fs.existsSync(depPath)).toBe(true);
      });
    });

    it('should have all server modules built', () => {
      const serverDir = path.join(buildDir, 'server');
      const expectedFiles = [
        'index.js',
        'tools/index.js',
        'resources/index.js', 
        'prompts/index.js',
        'schema/types.js',
        'utils/config.js',
        'utils/helpscout-client.js',
        'utils/logger.js',
        'utils/cache.js',
        'utils/mcp-errors.js'
      ];

      expectedFiles.forEach(file => {
        const filePath = path.join(serverDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    });
  });

  describe('File Content Validation', () => {
    it('should have valid server entry point that imports MCP SDK', () => {
      const entryPoint = path.join(buildDir, 'server/index.js');
      const content = fs.readFileSync(entryPoint, 'utf8');
      
      expect(content).toContain('@modelcontextprotocol/sdk');
      expect(content).toContain('Server');
      expect(content).toContain('StdioServerTransport');
    });

    it('should have helpscout client that imports axios', () => {
      const clientPath = path.join(buildDir, 'server/utils/helpscout-client.js');
      const content = fs.readFileSync(clientPath, 'utf8');
      
      expect(content).toContain('axios');
      expect(content).toContain('cache'); // Uses cache module instead of direct LRUCache import
    });

    it('should have tools that export all expected functions', () => {
      const toolsPath = path.join(buildDir, 'server/tools/index.js');
      const content = fs.readFileSync(toolsPath, 'utf8');
      
      const expectedExports = [
        'searchInboxes',
        'searchConversations',
        'getConversationSummary', 
        'getThreads',
        'getServerTime',
        'advancedConversationSearch',
        'comprehensiveConversationSearch'
      ];

      expectedExports.forEach(exportName => {
        expect(content).toContain(exportName);
      });
    });
  });

  describe('Cross-Platform Compatibility', () => {
    it('should use path.join for all paths', () => {
      const buildScript = path.join(process.cwd(), 'scripts/build-dxt.js');
      const content = fs.readFileSync(buildScript, 'utf8');
      
      // Should use path.join, not hardcoded slashes
      expect(content).toContain('path.join');
      
      // Should not use platform-specific commands
      expect(content).not.toContain('cp -r');
      expect(content).not.toContain('xcopy');
    });

    it('should have cross-platform copyDirectory function', () => {
      const buildScript = path.join(process.cwd(), 'scripts/build-dxt.js');
      const content = fs.readFileSync(buildScript, 'utf8');
      
      expect(content).toContain('copyDirectory');
      expect(content).toContain('fs.readdirSync');
      expect(content).toContain('fs.copyFileSync');
    });
  });
});