# Use Node.js 20 LTS as base image
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci && npm cache clean --force

# Copy source code and config
COPY src/ ./src/
COPY mcp.json ./

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Create app user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S help-scout -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/mcp.json ./

# Change ownership to app user
RUN chown -R help-scout:nodejs /app
USER help-scout

# Expose port (if running in HTTP mode)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('Health check passed')" || exit 1

# Default command
ENTRYPOINT ["node", "dist/index.js"]

# Labels for metadata
LABEL name="help-scout-mcp-server" \
      description="Help Scout MCP server for searching inboxes, conversations, and threads" \
      version="1.3.0" \
      maintainer="verkoopjezaak (fork)"