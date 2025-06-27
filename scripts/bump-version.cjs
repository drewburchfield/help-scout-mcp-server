#!/usr/bin/env node

/**
 * Version Bump Script
 * Automatically bumps package version and updates related files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parse command line arguments
const args = process.argv.slice(2);
const bumpType = args[0] || 'patch'; // patch, minor, major

if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node bump-version.js [patch|minor|major]');
  process.exit(1);
}

function log(message, type = 'INFO') {
  const timestamp = new Date().toISOString();
  // Using stderr to avoid interfering with npm output
  console.error(`[${timestamp}] ${type}: ${message}`);
}

function updatePackageJson(newVersion) {
  const packagePath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  
  const oldVersion = packageJson.version;
  packageJson.version = newVersion;
  
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  log(`Updated package.json: ${oldVersion} → ${newVersion}`);
  
  return { oldVersion, newVersion };
}

function updateDockerfile(newVersion) {
  const dockerfilePath = path.join(__dirname, '..', 'Dockerfile');
  let dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  
  // Update version label in Dockerfile
  dockerfile = dockerfile.replace(
    /LABEL name="help-scout-mcp-server" \\\s*description="[^"]*" \\\s*version="[^"]*"/,
    `LABEL name="help-scout-mcp-server" \\
      description="Help Scout MCP server for searching inboxes, conversations, and threads" \\
      version="${newVersion}"`
  );
  
  fs.writeFileSync(dockerfilePath, dockerfile);
  log(`Updated Dockerfile version label: ${newVersion}`);
}

function updateSourceCode(newVersion) {
  const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
  let indexContent = fs.readFileSync(indexPath, 'utf8');
  
  // Update version in MCP server constructor
  indexContent = indexContent.replace(
    /version: '[^']*'/,
    `version: '${newVersion}'`
  );
  
  fs.writeFileSync(indexPath, indexContent);
  log(`Updated src/index.ts version: ${newVersion}`);
}

function createCommit(oldVersion, newVersion, bumpType) {
  try {
    // Stage the changes
    execSync('git add package.json Dockerfile src/index.ts');
    
    // Create commit
    const commitMessage = `chore: bump version ${oldVersion} → ${newVersion} (${bumpType})

- Update package.json version
- Update Dockerfile version label  
- Update MCP server version in source code
- Automated version bump for release`;

    execSync(`git commit -m "${commitMessage}"`);
    log(`Created commit for version ${newVersion}`);
    
    // Create git tag
    execSync(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
    log(`Created git tag v${newVersion}`);
    
  } catch (error) {
    log(`Git operations failed: ${error.message}`, 'ERROR');
    throw error;
  }
}

function main() {
  try {
    log(`Starting ${bumpType} version bump...`);
    
    // Get current version and calculate new version
    const packagePath = path.join(__dirname, '..', 'package.json');
    const currentPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const currentVersion = currentPackage.version;
    
    // Use npm to bump version
    const newVersion = execSync(`npm version ${bumpType} --no-git-tag-version`, { 
      encoding: 'utf8',
      cwd: path.join(__dirname, '..')
    }).trim().replace('v', '');
    
    log(`Version bumped: ${currentVersion} → ${newVersion}`);
    
    // Update other files
    updateDockerfile(newVersion);
    updateSourceCode(newVersion);
    
    // Create commit and tag
    createCommit(currentVersion, newVersion, bumpType);
    
    log(`✅ Version bump complete! New version: ${newVersion}`);
    log(`Next steps:`);
    log(`  1. Review changes: git show`);
    log(`  2. Push to dev: git push origin dev`);
    log(`  3. Merge to main for release: git checkout main && git merge dev && git push origin main --tags`);
    
  } catch (error) {
    log(`Version bump failed: ${error.message}`, 'ERROR');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { updatePackageJson, updateDockerfile, updateSourceCode, createCommit };