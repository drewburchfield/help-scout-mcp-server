# Help Scout MCP Server - DXT Extension

This directory contains the DXT (Desktop Extensions) packaging for the Help Scout MCP Server, enabling one-click installation in Claude Desktop.

## What is DXT?

DXT is Anthropic's packaging format for MCP servers that provides:
- ✅ One-click installation in Claude Desktop
- ✅ Bundled dependencies (no Node.js setup required)
- ✅ Secure credential storage in OS keychain
- ✅ User-friendly configuration UI
- ✅ Cross-platform support (macOS, Windows, Linux)

## Building the DXT

From the project root directory:

```bash
# Build the DXT extension
npm run dxt:build

# Build and pack the DXT file
npm run dxt:pack
```

This will:
1. Build the TypeScript source
2. Create a production bundle in `build/`
3. Install only production dependencies
4. Generate the `.dxt` file

## Files

- `manifest.json` - DXT configuration and metadata
- `icon.svg` - Extension icon (source)
- `build/` - Generated build directory (gitignored)
- `*.dxt` - Generated extension files (gitignored)

## Installation for Users

1. Download the `.dxt` file from GitHub releases
2. Double-click to open with Claude Desktop
3. Click "Install"
4. Enter your Help Scout OAuth2 Client ID and Client Secret
5. Done!

## Development Notes

The build process:
1. Syncs version from `package.json` to `manifest.json`
2. Compiles TypeScript to JavaScript
3. Creates production-only `package.json`
4. Installs dependencies without dev packages
5. Copies manifest and assets
6. Ready for DXT packaging

To test locally before publishing:
```bash
npm run dxt:pack
# Install the generated .dxt file in Claude Desktop
```