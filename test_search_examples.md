# Enhanced Search Capabilities Test Examples

This document demonstrates the new search capabilities added to the HelpScout MCP server.

## New Search Features Added

### 1. Content/Body Search via `searchConversations`
```json
{
  "query": "(body:\"urgent\" OR body:\"priority\" OR body:\"important\")"
}
```

### 2. Subject Line Search
```json
{
  "query": "(subject:\"support\" OR subject:\"help\")"
}
```

### 3. Email Domain Search
```json
{
  "query": "email:\"@company.com\""
}
```

### 4. Complex Boolean Queries
```json
{
  "query": "(body:\"urgent\" OR subject:\"priority\") AND (tag:\"urgent\" OR tag:\"vip\")"
}
```

## Advanced Search Tool Examples

### Organization Search
```json
{
  "contentTerms": ["urgent", "priority", "important"],
  "subjectTerms": ["support", "help"],
  "emailDomain": "company.com",
  "createdAfter": "2025-03-01T00:00:00Z",
  "limit": 100
}
```

### Customer Organization Search
```json
{
  "emailDomain": "company.com",
  "tags": ["member", "vip"],
  "status": "active",
  "limit": 50
}
```

### Content Search with Time Range
```json
{
  "contentTerms": ["bug", "issue", "problem"],
  "createdAfter": "2025-01-01T00:00:00Z",
  "createdBefore": "2025-06-01T00:00:00Z"
}
```

## Key Improvements Made

1. **Added `query` parameter** to `searchConversations` tool
2. **Implemented `advancedConversationSearch`** tool for complex searches
3. **Content/body search** now available via HelpScout query syntax
4. **Organization email domain search** with multiple variations
5. **Complex boolean query support** with AND/OR operators
6. **Enhanced search result context** showing actual query used

## Missing from HelpScout API (Confirmed)

- Wildcard email domain searches (e.g., `*@company.com`)
- Full regex pattern matching
- Bulk conversation content retrieval
- Advanced date range operators

The implementation now leverages HelpScout's full query capabilities that were previously unused.