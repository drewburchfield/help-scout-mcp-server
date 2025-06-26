# 🚀 Production Release Workflow

## 📋 Complete Checklist of Version-Sensitive Files

When releasing a new version, the following files MUST be updated to maintain consistency:

### Core Version Files
- [ ] `package.json` - Main package version
- [ ] `src/index.ts` - MCP Server version (line ~27)
- [ ] `Dockerfile` - Docker image version label (line ~58)
- [ ] `src/__tests__/index.test.ts` - Test expectation for server version

### Documentation Files  
- [ ] `README.md` - Verify examples and features are current
- [ ] `CHANGELOG.md` - Add release notes (if exists)
- [ ] `mcp.json` - MCP configuration version (usually stays stable)

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
# 4. Update ALL version references (manual verification required)
# Edit these files to new version (e.g., 1.1.2):
- package.json (version field)
- src/index.ts (version field in Server constructor)
- Dockerfile (version label)
- src/__tests__/index.test.ts (test expectation)

# 5. Commit version updates
git add package.json src/index.ts Dockerfile src/__tests__/index.test.ts
git commit -m "bump: version 1.1.2"
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

### Phase 5: Package Publication
```bash
# 10. Build and test locally
npm run build
npm run test

# 11. Publish to NPM registry
npm publish
# Enter OTP when prompted for 2FA

# 12. Verify package is live
npm view help-scout-mcp-server@latest
```

### Phase 6: Version Tagging & Release
```bash
# 13. Create and push version tag
git tag v1.1.2
git push origin v1.1.2

# 14. Verify tag triggers CI/CD
# Check GitHub releases, Docker builds, etc.
```

### Phase 7: Final Verification
```bash
# 15. Test the complete deployment
npx help-scout-mcp-server@latest --version
docker pull drewburchfield/help-scout-mcp-server:latest

# 16. Update dev branch with any final fixes
git checkout dev
git merge main  # or cherry-pick specific fixes
```

## ⚠️ Critical Checkpoints

### Before NPM Publish
- [ ] All version numbers match across files
- [ ] Tests pass completely (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] No TypeScript errors (`npm run type-check`)
- [ ] Linting passes (`npm run lint`)

### Before Git Tag
- [ ] NPM package published successfully
- [ ] Remote main branch is up to date
- [ ] Docker build context is ready

### After Release
- [ ] NPM package accessible: `npx help-scout-mcp-server@latest`
- [ ] Docker image builds successfully
- [ ] GitHub release created (if automated)
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
// - Any other version references
```

### CI/CD Pipeline Verification
Ensure `.github/workflows/ci.yml` includes:
- Version consistency checks
- Automatic Docker builds on tag push
- NPM package validation
- Documentation updates

## 🚨 Common Pitfalls to Avoid

1. **Version Mismatch**: Always verify ALL files have matching versions
2. **Test Failures**: Don't publish if tests fail (13 failing tests found in last run)
3. **Missing Remote Push**: NPM publish without git push breaks Docker builds
4. **Force Push**: Avoid force pushing to main after NPM publish
5. **Tag Conflicts**: Ensure tag doesn't already exist before creating

## 📊 Quick Version Audit Command

```bash
# Run this to verify version consistency:
echo "package.json: $(grep '"version"' package.json | head -1)"
echo "src/index.ts: $(grep "version:" src/index.ts)"
echo "Dockerfile: $(grep 'version=' Dockerfile)"
echo "Test file: $(grep 'version:' src/__tests__/index.test.ts)"
```

---

**Last Updated**: Version 1.1.1 workflow
**Next Version Target**: 1.1.2 (or 1.2.0 for minor features)