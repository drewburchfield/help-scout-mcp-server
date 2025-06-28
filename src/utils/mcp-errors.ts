import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError } from '../schema/types.js';
import { logger } from './logger.js';

/**
 * Creates a standardized MCP error response for tool calls
 */
export function createMcpToolError(
  error: unknown,
  context: {
    toolName: string;
    requestId: string;
    duration?: number;
  }
): CallToolResult {
  const { toolName, requestId, duration } = context;

  // Handle our structured API errors
  if (isApiError(error)) {
    logger.error('MCP tool API error', {
      requestId,
      toolName,
      errorCode: error.code,
      message: error.message,
      duration,
      details: error.details,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: error.code,
                message: error.message,
                type: 'api_error',
                details: error.details,
                requestId,
              },
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // Handle validation errors (Zod)
  if (error && typeof error === 'object' && 'issues' in error) {
    const zodError = error as { issues: Array<{ path: Array<string | number>; message: string; code: string }> };
    
    logger.error('MCP tool validation error', {
      requestId,
      toolName,
      validationIssues: zodError.issues,
      duration,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: 'INVALID_INPUT',
                message: 'Invalid input parameters provided',
                type: 'validation_error',
                validationIssues: zodError.issues.map(issue => ({
                  field: issue.path.join('.'),
                  message: issue.message,
                  code: issue.code,
                })),
                requestId,
              },
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // Handle generic errors
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  logger.error('MCP tool generic error', {
    requestId,
    toolName,
    error: errorMessage,
    stack: errorStack,
    duration,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: {
              code: 'TOOL_ERROR',
              message: `Tool execution failed: ${errorMessage}`,
              type: 'generic_error',
              requestId,
            },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Creates a standardized MCP error response for resource handlers
 */
export function createMcpResourceError(
  error: unknown,
  context: {
    resourceUri: string;
    requestId?: string;
  }
): {
  type: 'text';
  text: string;
} {
  const { resourceUri, requestId } = context;

  // Handle our structured API errors
  if (isApiError(error)) {
    logger.error('MCP resource API error', {
      requestId,
      resourceUri,
      errorCode: error.code,
      message: error.message,
      details: error.details,
    });

    return {
      type: 'text',
      text: JSON.stringify(
        {
          error: {
            code: error.code,
            message: error.message,
            type: 'api_error',
            resourceUri,
            details: error.details,
            requestId,
          },
        },
        null,
        2
      ),
    };
  }

  // Handle generic errors
  const errorMessage = error instanceof Error ? error.message : String(error);

  logger.error('MCP resource generic error', {
    requestId,
    resourceUri,
    error: errorMessage,
  });

  return {
    type: 'text',
    text: JSON.stringify(
      {
        error: {
          code: 'RESOURCE_ERROR',
          message: `Resource access failed: ${errorMessage}`,
          type: 'generic_error',
          resourceUri,
          requestId,
        },
      },
      null,
      2
    ),
  };
}

/**
 * Type guard to check if an error is our structured ApiError
 */
function isApiError(error: unknown): error is ApiError {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error &&
    typeof (error as any).code === 'string' &&
    typeof (error as any).message === 'string'
  );
}

/**
 * Extracts actionable suggestions from API errors for LLM agents
 */
export function getErrorSuggestion(error: ApiError): string {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 'Please check your Help Scout API credentials and ensure they have the necessary permissions.';
    case 'NOT_FOUND':
      return 'Verify that the resource ID is correct and the resource exists in Help Scout.';
    case 'RATE_LIMIT':
      return `Rate limit exceeded. Wait ${error.retryAfter || 60} seconds before retrying, or reduce request frequency.`;
    case 'INVALID_INPUT':
      return 'Check the input parameters against the Help Scout API documentation and ensure all required fields are provided.';
    case 'UPSTREAM_ERROR':
      return 'Help Scout service may be temporarily unavailable. The request will be automatically retried.';
    default:
      return 'Please check the error details and consult the Help Scout API documentation.';
  }
}