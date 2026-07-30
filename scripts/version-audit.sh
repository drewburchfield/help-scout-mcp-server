#!/bin/bash

# 🔍 Version Consistency Audit Script
# Run this before any release to ensure all version references match

echo "🔍 Version Consistency Audit"
echo "=========================="

# Extract versions from every file the bump script writes, plus the
# hand-maintained doc pins that must move at publish time. The navigator
# skill is versioned independently and bundles no server, so it has no pin.
PKG_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
SRC_VERSION=$(grep 'version:' src/index.ts | sed "s/.*version: *['\"]\\([^'\"]*\\)['\"].*/\\1/")
DOCKER_VERSION=$(grep 'version=' Dockerfile | sed 's/.*version="\([^"]*\)".*/\1/')
TEST_VERSION=$(grep 'version:' src/__tests__/index.test.ts | sed "s/.*version: *['\"]\\([^'\"]*\\)['\"].*/\\1/")
MCP_VERSION=$(grep '"version"' mcp.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
SERVER_VERSION=$(grep '"version"' server.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
MANIFEST_VERSION=$(grep '"version"' helpscout-mcp-extension/manifest.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
# README and the Cowork guide pin the npm version (npx examples) and the
# Docker tag; every occurrence must agree before we treat it as one value.
README_PIN_COUNT=$(grep -oh 'help-scout-mcp-server[@:][0-9][0-9.]*' README.md guides/cowork-setup.md claude-desktop-config.json | sed 's/.*[@:]//' | sort -u | wc -l | tr -d ' ')
README_PIN=$(grep -oh 'help-scout-mcp-server[@:][0-9][0-9.]*' README.md guides/cowork-setup.md claude-desktop-config.json | sed 's/.*[@:]//' | sort -u | head -1)
if [ "$README_PIN_COUNT" != "1" ]; then
  README_PIN=""
fi

require_version() {
  local source="$1"
  local version="$2"

  if [ -z "$version" ]; then
    echo "❌ Could not parse version from $source"
    return 1
  fi
}

echo "📦 package.json:     $PKG_VERSION"
echo "🔧 src/index.ts:     $SRC_VERSION"
echo "🐳 Dockerfile:       $DOCKER_VERSION"
echo "🧪 Test file:        $TEST_VERSION"
echo "🔌 mcp.json:         $MCP_VERSION"
echo "🗂  server.json:      $SERVER_VERSION"
echo "📦 MCPB manifest:    $MANIFEST_VERSION"
echo "📖 README pins:      ${README_PIN:-INCONSISTENT}"

PARSE_OK=true
require_version "package.json" "$PKG_VERSION" || PARSE_OK=false
require_version "src/index.ts" "$SRC_VERSION" || PARSE_OK=false
require_version "Dockerfile" "$DOCKER_VERSION" || PARSE_OK=false
require_version "src/__tests__/index.test.ts" "$TEST_VERSION" || PARSE_OK=false
require_version "mcp.json" "$MCP_VERSION" || PARSE_OK=false
require_version "server.json" "$SERVER_VERSION" || PARSE_OK=false
require_version "helpscout-mcp-extension/manifest.json" "$MANIFEST_VERSION" || PARSE_OK=false
require_version "README/config pins (all occurrences must match)" "$README_PIN" || PARSE_OK=false

if [ "$PARSE_OK" = false ]; then
  echo ""
  echo "📋 Fix version extraction before comparing versions."
  exit 1
fi

# Check for consistency. Comparison and diagnostics iterate the same list so
# a source can never fail the audit without being named in the output.
SOURCES=(
  "src/index.ts|$SRC_VERSION"
  "Dockerfile|$DOCKER_VERSION"
  "src/__tests__/index.test.ts|$TEST_VERSION"
  "mcp.json|$MCP_VERSION"
  "server.json|$SERVER_VERSION"
  "helpscout-mcp-extension/manifest.json|$MANIFEST_VERSION"
  "README.md + guides/cowork-setup.md + claude-desktop-config.json install pins|$README_PIN"
)
CONSISTENT=true

for entry in "${SOURCES[@]}"; do
  if [ "${entry#*|}" != "$PKG_VERSION" ]; then
    CONSISTENT=false
    break
  fi
done

echo ""
if [ "$CONSISTENT" = true ]; then
  echo "✅ All versions are consistent: $PKG_VERSION"
  echo ""
  echo "🚀 Ready for release!"
  exit 0
else
  echo "❌ Version mismatch detected!"
  echo ""
  echo "🔧 Files that need updating:"

  for entry in "${SOURCES[@]}"; do
    label=${entry%%|*}
    version=${entry#*|}
    if [ "$version" != "$PKG_VERSION" ]; then
      echo "  - $label (currently: ${version:-inconsistent}, should be: $PKG_VERSION)"
    fi
  done

  echo ""
  echo "📋 Update these files manually, then run this script again."
  exit 1
fi
