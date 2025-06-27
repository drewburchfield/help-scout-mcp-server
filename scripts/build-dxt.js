#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cross-platform directory copy function
function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function buildDXT() {
  console.log('🏗️  Building DXT extension...');
  
  // Read version from package.json
  const packageJsonPath = path.join(__dirname, '../package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = packageJson.version;
  
  // Update manifest version
  const manifestPath = path.join(__dirname, '../helpscout-mcp-extension/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  
  console.log(`📌 Updated manifest version to ${version}`);
  
  // Build TypeScript
  console.log('📦 Building TypeScript...');
  execSync('npm run build', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  
  // Create build directory structure
  const buildDir = path.join(__dirname, '../helpscout-mcp-extension/build');
  const serverDir = path.join(buildDir, 'server');
  
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true });
  }
  
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  
  // Copy compiled JavaScript files
  console.log('📂 Copying server files...');
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory not found. Please run npm run build first.');
  }
  
  // Copy all files from dist to server directory (cross-platform)
  copyDirectory(distDir, serverDir);
  
  // Create a minimal package.json for production dependencies
  console.log('📦 Creating production package.json...');
  const prodPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    type: "module",
    dependencies: {
      "@modelcontextprotocol/sdk": packageJson.dependencies["@modelcontextprotocol/sdk"],
      "axios": packageJson.dependencies["axios"],
      "lru-cache": packageJson.dependencies["lru-cache"],
      "zod": packageJson.dependencies["zod"],
      "dotenv": packageJson.dependencies["dotenv"]
    }
  };
  
  fs.writeFileSync(
    path.join(buildDir, 'package.json'),
    JSON.stringify(prodPackageJson, null, 2)
  );
  
  // Install production dependencies in build directory
  console.log('📦 Installing production dependencies...');
  execSync('npm install --production --no-optional', { 
    stdio: 'inherit', 
    cwd: buildDir 
  });
  
  // Copy manifest and assets
  console.log('📄 Copying manifest and assets...');
  fs.copyFileSync(manifestPath, path.join(buildDir, 'manifest.json'));
  
  // Check if icon exists
  const iconPath = path.join(__dirname, '../helpscout-mcp-extension/icon.png');
  if (fs.existsSync(iconPath)) {
    fs.copyFileSync(iconPath, path.join(buildDir, 'icon.png'));
  } else {
    console.warn('⚠️  Warning: icon.png not found. DXT will use a default icon.');
  }
  
  // Create .gitignore in build directory
  fs.writeFileSync(
    path.join(buildDir, '.gitignore'),
    'node_modules/\n*.log\n'
  );
  
  console.log('✅ DXT build completed successfully!');
  console.log(`📍 Build directory: ${buildDir}`);
  console.log('\n🎯 Next steps:');
  console.log('1. cd helpscout-mcp-extension');
  console.log('2. npx @anthropic-ai/dxt pack');
  console.log('3. The .dxt file will be created in the current directory');
}

buildDXT().catch(error => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});