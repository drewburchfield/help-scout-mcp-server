#!/bin/bash

# 🔍 Version Consistency Audit Script
# Run this before any release to ensure all version references match

echo "🔍 Version Consistency Audit"
echo "=========================="

# Extract versions from key files
PKG_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
SRC_VERSION=$(grep 'version:' src/index.ts | sed "s/.*version: *['\"]\\([^'\"]*\\)['\"].*/\\1/")
DOCKER_VERSION=$(grep 'version=' Dockerfile | sed 's/.*version="\([^"]*\)".*/\1/')
TEST_VERSION=$(grep 'version:' src/__tests__/index.test.ts | sed "s/.*version: *['\"]\\([^'\"]*\\)['\"].*/\\1/")

echo "📦 package.json:     $PKG_VERSION"
echo "🔧 src/index.ts:     $SRC_VERSION"  
echo "🐳 Dockerfile:       $DOCKER_VERSION"
echo "🧪 Test file:        $TEST_VERSION"

# Check for consistency
ALL_VERSIONS=("$PKG_VERSION" "$SRC_VERSION" "$DOCKER_VERSION" "$TEST_VERSION")
FIRST_VERSION=${ALL_VERSIONS[0]}
CONSISTENT=true

for version in "${ALL_VERSIONS[@]}"; do
  if [ "$version" != "$FIRST_VERSION" ]; then
    CONSISTENT=false
    break
  fi
done

echo ""
if [ "$CONSISTENT" = true ]; then
  echo "✅ All versions are consistent: $FIRST_VERSION"
  echo ""
  echo "🚀 Ready for release!"
  exit 0
else
  echo "❌ Version mismatch detected!"
  echo ""
  echo "🔧 Files that need updating:"
  
  if [ "$SRC_VERSION" != "$PKG_VERSION" ]; then
    echo "  - src/index.ts (currently: $SRC_VERSION, should be: $PKG_VERSION)"
  fi
  
  if [ "$DOCKER_VERSION" != "$PKG_VERSION" ]; then
    echo "  - Dockerfile (currently: $DOCKER_VERSION, should be: $PKG_VERSION)"
  fi
  
  if [ "$TEST_VERSION" != "$PKG_VERSION" ]; then
    echo "  - src/__tests__/index.test.ts (currently: $TEST_VERSION, should be: $PKG_VERSION)"
  fi
  
  echo ""
  echo "📋 Update these files manually, then run this script again."
  exit 1
fi