# 🚀 Production Release Workflow

## 📋 Complete Checklist of Version-Sensitive Files

When releasing a new version, the following files MUST be updated to maintain consistency:

### Core Version Files
- [ ] `package.json` - Main package version
- [ ] `src/index.ts` - MCP Server version (line ~27)
- [ ] `Dockerfile` - Docker image version label (line ~58)
- [ ] `src/__tests__/index.test.ts` - Test expectation for server version
- [ ] `mcp.json` - MCP configuration version and mcpVersion
- [ ] `helpscout-mcp-extension/manifest.json` - DXT extension version

### Documentation Files  
- [ ] `README.md` - Update "What's New" section and verify examples
- [ ] `CHANGELOG.md` - Add release notes (if exists)

### CI/CD & Build Files
- [ ] `.github/workflows/ci.yml` - Docker build configurations
- [ ] `docker-compose.yml` - Image tags and references
- [ ] Version bump scripts in `scripts/` directory

## 🔄 Step-by-Step Production Workflow

### Phase 1: Development & Feature Integration
```bash
# 1. Work on feature branch off dev
git checkout dev
git checkout -b feature/your-feature-name

# 2. Develop features, add tests, update docs
# ... development work ...

# 3. Merge back to dev when ready
git checkout dev
git merge feature/your-feature-name
```

### Phase 2: Version Preparation & Synchronization
```bash
# 4. Automated version bump (recommended)
npm run version:patch   # For bug fixes (1.2.1 → 1.2.2) 
# npm run version:minor   # For new features (1.2.1 → 1.3.0)
# npm run version:major   # For breaking changes (1.2.1 → 2.0.0)

# OR manual version updates (if automated script fails):
# Edit these files to new version (e.g., 1.2.2):
# - package.json, src/index.ts, Dockerfile, mcp.json, helpscout-mcp-extension/manifest.json

# 5. Verify all versions match (use the audit command from bottom of this file)
```

### Phase 3: Main Branch Integration
```bash
# 6. Merge dev to main (or cherry-pick specific commits)
git checkout main
git merge dev
# OR for specific commits:
# git cherry-pick <commit-hash-range>

# 7. Verify all files are correctly versioned on main
git log --oneline -3
```

### Phase 4: Remote Synchronization
```bash
# 8. Push main to remote repository
git push origin main

# 9. Verify remote is updated and builds pass
# Check GitHub Actions, CI/CD pipelines
```

### Phase 5: Build All Artifacts
```bash
# 10. Build and test all components
npm run build
npm run test

# 11. Build DXT extension package
npm run mcpb:build
npm run mcpb:pack

# 12. Verify DXT package is created
ls -la helpscout-mcp-extension/helpscout-mcp-extension.dxt

# 13. Test DXT package (optional)
npm test src/__tests__/dxt-validation.test.ts
```

### Phase 6: Package Publication
```bash
# 14. Publish to NPM registry
npm publish
# Enter OTP when prompted for 2FA

# 15. Verify package is live
npm view help-scout-mcp-server@latest
```

### Phase 7: Version Tagging & GitHub Release
```bash
# 16. Create and push version tag
git tag v1.2.1
git push origin v1.2.1

# 17. Create GitHub release with DXT attachment
gh release create v1.2.1 \
  --title "v1.2.1 - MCP SDK Upgrade & DXT Format Compliance" \
  --notes "## Changes
- Upgrade MCP SDK to v1.17.4
- Fix DXT manifest format compliance
- Improve search tool guidance
- Enhanced test stability

## Assets
- NPM package: help-scout-mcp-server@1.2.1
- Docker image: verkoopjezaak/help-scout-mcp-server:1.2.1
- DXT extension: helpscout-mcp-extension.dxt" \
  helpscout-mcp-extension/helpscout-mcp-extension.dxt

# 18. Verify release and Docker build trigger
# Check GitHub releases page and Actions tab
```

### Phase 8: Final Verification
```bash
# 19. Test all deployment artifacts
npx help-scout-mcp-server@latest --version
docker pull verkoopjezaak/help-scout-mcp-server:latest

# 20. Verify DXT extension in release
# Download from GitHub releases and test installation

# 21. Update dev branch with any final fixes
git checkout dev
git merge main  # or cherry-pick specific fixes
```

## ⚠️ Critical Checkpoints

### Before NPM Publish
- [ ] All version numbers match across files (use version audit command below)
- [ ] Tests pass completely (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] No TypeScript errors (`npm run type-check`)
- [ ] Linting passes (`npm run lint`)
- [ ] DXT package builds successfully (`npm run mcpb:build && npm run mcpb:pack`)

### Before Git Tag
- [ ] NPM package published successfully
- [ ] DXT extension (.dxt file) generated and tested
- [ ] Remote main branch is up to date
- [ ] Docker build context is ready

### After Release
- [ ] NPM package accessible: `npx help-scout-mcp-server@latest`
- [ ] Docker image builds successfully
- [ ] GitHub release created with DXT attachment
- [ ] DXT extension downloadable from GitHub releases
- [ ] Documentation reflects new features

## 🔧 Automation Opportunities

### Version Bump Script Enhancement
Consider enhancing `scripts/bump-version.cjs` to update ALL files:
```javascript
// Should update:
// - package.json
// - src/index.ts  
// - Dockerfile
// - src/__tests__/index.test.ts
// - mcp.json (both version and mcpVersion)
// - helpscout-mcp-extension/manifest.json
// - Any other version references
```

### DXT Build Automation
Consider adding to CI/CD pipeline:
```yaml
# GitHub Actions workflow for releases
- name: Build DXT Extension
  run: |
    npm run mcpb:build
    npm run mcpb:pack
- name: Attach DXT to Release
  uses: actions/upload-release-asset@v1
  with:
    upload_url: ${{ steps.create_release.outputs.upload_url }}
    asset_path: ./helpscout-mcp-extension/helpscout-mcp-extension.dxt
```

### CI/CD Pipeline Verification
Ensure `.github/workflows/ci.yml` includes:
- Version consistency checks
- Automatic Docker builds on tag push
- NPM package validation
- Documentation updates

## 🚨 Common Pitfalls to Avoid

1. **Version Mismatch**: Always verify ALL files have matching versions
2. **DXT CLI Limitation**: Current @anthropic-ai/dxt CLI v0.2.6 expects `dxt_version` but official spec uses `manifest_version`. We use official format.
3. **Test Failures**: Don't publish if tests fail 
4. **Missing Remote Push**: NPM publish without git push breaks Docker builds
5. **Force Push**: Avoid force pushing to main after NPM publish
6. **Tag Conflicts**: Ensure tag doesn't already exist before creating

## 📊 Quick Version Audit Command

```bash
# Run this to verify version consistency across ALL files:
echo "=== VERSION AUDIT ==="
echo "package.json: $(grep '"version"' package.json | head -1)"
echo "src/index.ts: $(grep "version:" src/index.ts)"
echo "Dockerfile: $(grep 'version=' Dockerfile)"
echo "Test file: $(grep 'version:' src/__tests__/index.test.ts)"
echo "mcp.json: $(grep '"version"' mcp.json)"
echo "DXT manifest: $(grep '"version"' helpscout-mcp-extension/manifest.json)"
echo "DXT mcpVersion: $(grep 'mcpVersion' mcp.json)"
echo "===================="
```

---

**Last Updated**: Version 1.2.1 workflow (includes DXT building and GitHub releases)
**Current Version**: 1.2.1 (MCP SDK v1.17.4, DXT format compliant)