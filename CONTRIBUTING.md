# Contributing to Help Scout MCP Server

Thank you for your interest in contributing! This guide will help you get started.

## 🚀 Quick Start for Contributors

1. **Fork and clone the repository**
```bash
git clone https://github.com/drewburchfield/help-scout-mcp-server.git
cd help-scout-mcp-server
```

2. **Install dependencies**
```bash
npm install
```

3. **Set up environment**
```bash
cp .env.example .env
# Add your Help Scout API credentials to .env
```

4. **Run tests and build**
```bash
npm test
npm run build
```

## 🛠️ Development Workflow

### Making Changes

1. **Create a feature branch**
```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes**
   - Write clean, documented code
   - Follow existing code patterns
   - Add tests for new functionality

3. **Test your changes**
```bash
npm run lint        # Check code style
npm run type-check  # Verify TypeScript types
npm test           # Run test suite
npm run build      # Ensure it builds
```

4. **Commit and push**
```bash
git add .
git commit -m "feat: add your feature description"
git push origin feature/your-feature-name
```

5. **Create a Pull Request**

### Code Standards

- **TypeScript**: Use strict type checking
- **ESLint**: Follow the existing linting rules
- **Testing**: Add tests for new features and bug fixes
- **Documentation**: Update README and JSDoc comments as needed

### Commit Messages

We use conventional commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for adding tests
- `refactor:` for code refactoring

## 🧪 Testing

### Running Tests
```bash
npm test           # Run all tests
npm test -- --watch  # Watch mode
npm test -- --coverage  # With coverage
```

### Writing Tests
- Place tests in `src/__tests__/` directory
- Use descriptive test names
- Test both success and error cases
- Mock external dependencies

### Test Structure
```typescript
describe('FeatureName', () => {
  describe('methodName', () => {
    it('should do something specific', () => {
      // Test implementation
    });
  });
});
```

## 📁 Project Structure

```
src/
├── __tests__/          # Test files
├── tools/              # MCP tool implementations
├── resources/          # MCP resource handlers
├── prompts/            # MCP prompt templates
├── schema/             # TypeScript types and Zod schemas
├── utils/              # Shared utilities
│   ├── config.ts       # Configuration management
│   ├── logger.ts       # Logging utilities
│   ├── cache.ts        # Caching layer
│   └── helpscout-client.ts  # Help Scout API client
├── cli.ts              # Process entry point (npm bin and MCPB extension)
└── index.ts            # Server class and MCP wiring
```

## 🐛 Bug Reports

When reporting bugs, please include:

1. **Clear description** of the issue
2. **Steps to reproduce** the bug
3. **Expected behavior** vs actual behavior
4. **Environment details**:
   - Node.js version
   - Operating system
   - Help Scout MCP Server version
5. **Error messages** or logs (if any)

## 💡 Feature Requests

For new features:

1. **Check existing issues** to avoid duplicates
2. **Describe the use case** and problem you're solving
3. **Provide examples** of how the feature would be used
4. **Consider backward compatibility**

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙏 Thank You

Every contribution helps make this project better for the entire community!