/**
 * Help Scout API Constraints and Validation Rules
 * 
 * This module implements reverse logic validation based on Help Scout API requirements.
 * By understanding what the API expects, we can guide AI agents to make correct calls.
 */

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  suggestions: string[];
  requiredPrerequisites?: string[];
}

export interface ToolCallContext {
  toolName: string;
  arguments: Record<string, unknown>;
  userQuery?: string;
  previousCalls?: string[];
}

/**
 * Help Scout API Constraints derived from actual API behavior
 */
export class HelpScoutAPIConstraints {
  
  /**
   * Validate a tool call based on Help Scout API constraints
   */
  static validateToolCall(context: ToolCallContext): ValidationResult {
    const { toolName, arguments: args, userQuery = '', previousCalls = [] } = context;
    
    switch (toolName) {
      case 'searchConversations':
        return this.validateSearchConversations(args, userQuery, previousCalls);
      case 'comprehensiveConversationSearch':
        return this.validateComprehensiveSearch(args, userQuery, previousCalls);
      case 'getConversationSummary':
        return this.validateConversationSummary(args);
      case 'getThreads':
        return this.validateGetThreads(args);
      default:
        return { isValid: true, errors: [], suggestions: [] };
    }
  }
  
  /**
   * CRITICAL: searchConversations has specific API requirements
   */
  private static validateSearchConversations(
    args: Record<string, unknown>, 
    userQuery: string, 
    previousCalls: string[]
  ): ValidationResult {
    const errors: string[] = [];
    const suggestions: string[] = [];
    const requiredPrerequisites: string[] = [];
    
    // CONSTRAINT 1: Inbox name mentioned but no inboxId provided
    const inboxMentioned = this.detectInboxMention(userQuery);
    const hasInboxId = args.inboxId && typeof args.inboxId === 'string';
    const hasSearchedInboxes = previousCalls.includes('searchInboxes');
    
    if (inboxMentioned && !hasInboxId) {
      errors.push('User mentioned an inbox by name but no inboxId provided');
      if (!hasSearchedInboxes) {
        requiredPrerequisites.push('searchInboxes');
        suggestions.push('REQUIRED: Call searchInboxes first to find the inbox ID when user mentions inbox names like "support", "sales", "billing", etc.');
      } else {
        suggestions.push('Use the inbox ID from your previous searchInboxes call');
      }
    }
    
    // CONSTRAINT 2: Status parameter optimization
    const hasStatus = args.status && typeof args.status === 'string';
    const hasQuery = args.query && typeof args.query === 'string';
    const hasTag = args.tag && typeof args.tag === 'string';
    
    if ((hasQuery || hasTag) && !hasStatus) {
      suggestions.push('PERFORMANCE WARNING: Searching without status defaults to "active" only. Consider using comprehensiveConversationSearch for better results.');
    }
    
    // CONSTRAINT 3: API parameter mapping validation
    if (args.inboxId && typeof args.inboxId === 'string') {
      // Validate inbox ID format (Help Scout inbox IDs are typically numeric)
      if (!/^\d+$/.test(args.inboxId)) {
        errors.push('Invalid inbox ID format - should be numeric');
        suggestions.push('Inbox IDs from Help Scout are numeric strings. Use searchInboxes to get the correct ID.');
      }
    }
    
    // CONSTRAINT 4: Date format validation
    if (args.createdAfter) {
      try {
        new Date(args.createdAfter as string);
      } catch {
        errors.push('Invalid createdAfter date format');
        suggestions.push('Use ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ) for dates');
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      suggestions,
      requiredPrerequisites: requiredPrerequisites.length > 0 ? requiredPrerequisites : undefined
    };
  }
  
  /**
   * Validate comprehensive search based on API constraints
   */
  private static validateComprehensiveSearch(
    args: Record<string, unknown>, 
    userQuery: string, 
    previousCalls: string[]
  ): ValidationResult {
    const errors: string[] = [];
    const suggestions: string[] = [];
    const requiredPrerequisites: string[] = [];
    
    // Same inbox validation as regular search
    const inboxMentioned = this.detectInboxMention(userQuery);
    const hasInboxId = args.inboxId && typeof args.inboxId === 'string';
    const hasSearchedInboxes = previousCalls.includes('searchInboxes');
    
    if (inboxMentioned && !hasInboxId) {
      if (!hasSearchedInboxes) {
        requiredPrerequisites.push('searchInboxes');
        suggestions.push('REQUIRED: Call searchInboxes first when user mentions specific inbox names');
      }
    }
    
    // Validate search terms
    const searchTerms = args.searchTerms as string[] | undefined;
    if (!searchTerms || !Array.isArray(searchTerms) || searchTerms.length === 0) {
      errors.push('searchTerms is required and must be a non-empty array');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      suggestions,
      requiredPrerequisites: requiredPrerequisites.length > 0 ? requiredPrerequisites : undefined
    };
  }
  
  /**
   * Validate conversation summary calls
   */
  private static validateConversationSummary(args: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];
    const suggestions: string[] = [];
    
    if (!args.conversationId || typeof args.conversationId !== 'string') {
      errors.push('conversationId is required');
      suggestions.push('Get conversation ID from searchConversations or comprehensiveConversationSearch results');
    } else if (!/^\d+$/.test(args.conversationId)) {
      errors.push('Invalid conversation ID format');
      suggestions.push('Conversation IDs should be numeric strings');
    }
    
    return { isValid: errors.length === 0, errors, suggestions };
  }
  
  /**
   * Validate getThreads calls
   */
  private static validateGetThreads(args: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];
    const suggestions: string[] = [];
    
    if (!args.conversationId || typeof args.conversationId !== 'string') {
      errors.push('conversationId is required');
      suggestions.push('Get conversation ID from searchConversations results first');
    }
    
    return { isValid: errors.length === 0, errors, suggestions };
  }
  
  /**
   * Detect if user query mentions an inbox by name
   */
  private static detectInboxMention(userQuery: string): boolean {
    const inboxKeywords = [
      'inbox', 'mailbox', 'support', 'sales', 'billing', 'technical', 'general',
      'customer service', 'help desk', 'contact', 'feedback', 'info', 'admin'
    ];
    
    const lowerQuery = userQuery.toLowerCase();
    
    // Look for patterns like "support inbox", "in the sales mailbox", "billing queue"
    const patterns = [
      /\b(?:in the|from the|from|in)\s+([\w\s]+)\s+(?:inbox|mailbox|queue)/,
      /\b([\w\s]+)\s+(?:inbox|mailbox|queue)/,
      /\b(?:inbox|mailbox)\s+([\w\s]+)/
    ];
    
    // Check for explicit inbox keywords
    const hasInboxKeyword = inboxKeywords.some(keyword => lowerQuery.includes(keyword));
    
    // Check for inbox mention patterns
    const hasInboxPattern = patterns.some(pattern => pattern.test(lowerQuery));
    
    return hasInboxKeyword || hasInboxPattern;
  }
  
  /**
   * Generate validation guidance for tool responses
   */
  static generateToolGuidance(toolName: string, result: any, _context: ToolCallContext): string[] {
    const guidance: string[] = [];
    
    if (toolName === 'searchInboxes') {
      const results = result?.results || [];
      if (results.length > 0) {
        guidance.push('✅ NEXT STEP: Use the inbox ID from these results in your conversation search');
        guidance.push(`Example: searchConversations({ "inboxId": "${results[0]?.id}", "status": "active" })`);
      } else {
        guidance.push('❌ No inboxes found. Try a broader search term or use empty string "" to list all inboxes');
      }
    }
    
    if (toolName === 'searchConversations' || toolName === 'comprehensiveConversationSearch') {
      const conversations = result?.results || result?.resultsByStatus || [];
      const totalFound = Array.isArray(conversations) ? conversations.length : 
        (result?.totalConversationsFound || 0);
      
      if (totalFound === 0) {
        guidance.push('❌ No conversations found. Try:');
        guidance.push('  1. Different status (active/pending/closed/spam)');
        guidance.push('  2. Broader search terms');
        guidance.push('  3. Extended time range');
        guidance.push('  4. Verify inbox ID is correct');
      } else {
        guidance.push(`✅ Found ${totalFound} conversations`);
        guidance.push('💡 NEXT STEPS: Use getConversationSummary or getThreads for detailed analysis');
      }
    }
    
    return guidance;
  }
}

/**
 * Common Help Scout API error patterns and solutions
 */
export const API_ERROR_SOLUTIONS = {
  'Invalid mailbox ID': 'Use searchInboxes to get valid inbox IDs',
  'No conversations found': 'Try different status values or broader search terms',
  'Invalid date format': 'Use ISO 8601 format: YYYY-MM-DDTHH:mm:ssZ',
  'Missing conversation ID': 'Get conversation ID from search results first',
  'Rate limit exceeded': 'Wait and retry - the system handles this automatically'
} as const;
