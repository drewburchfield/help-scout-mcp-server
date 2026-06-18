/**
 * Unified content-aware response guidance layer (NAS-1308).
 *
 * Replaces the two prior half-mechanisms — static `_meta.suggestedTools`
 * (successor hints keyed only on tool *name*) and the 2-tool
 * `generateToolGuidance` next-step text — with ONE content-aware producer.
 *
 * `buildResponseGuidance(toolName, result, deps)` reads what actually happened
 * (was the response empty or populated? what real id can anchor an example?)
 * and emits both:
 *   - `apiGuidance`: next-step text with a real id interpolated into the example
 *     (Anthropic: tool-use examples lifted complex-param accuracy 72%→90%).
 *   - `suggestedTools`: the typed, sanitized schemas to act on that next step,
 *     core/meta-filtered and capped at 3.
 *
 * Everything is defensive and total: malformed/empty results degrade to generic
 * text or no guidance; nothing here ever throws (the caller also wraps in
 * try/catch so a guidance failure never turns a success into a failure).
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type ResultShape = 'empty' | 'populated';

export interface ToolHint {
  name: string;
  description?: string;
  inputSchema: Tool['inputSchema'];
}

export interface AnchorId {
  kind: string;
  id: string;
}

/** Dependencies injected from ToolHandler so the builder stays decoupled/testable. */
export interface GuidanceDeps {
  /** Sanitized tool definitions, keyed lookup built internally. */
  toolDefs: Tool[];
  /** Names already in the always-on core surface (filtered out of hints). */
  coreTools: readonly string[];
  /** Discovery meta-tool names (never suggested). */
  metaTools: readonly string[];
  /** Static fallback successor map for tools without a GUIDANCE_MAP entry. */
  successorMap: Record<string, readonly string[]>;
}

interface GuidanceEntry {
  populated?: (anchor?: AnchorId) => string[];
  empty?: () => string[];
  successorsPopulated?: readonly string[];
  successorsEmpty?: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Standard envelope array keys we treat as "the result list". */
const ENVELOPE_ARRAY_KEYS = [
  'results',
  'conversations',
  'inboxes',
  'customers',
  'organizations',
  'items',
  'threads',
  'articles',
  'tags',
  'users',
  'teams',
] as const;

function firstArrayInEnvelope(result: Record<string, unknown>): unknown[] | undefined {
  for (const key of ENVELOPE_ARRAY_KEYS) {
    const value = result[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  // _embedded.* arrays (Help Scout HAL envelopes).
  const embedded = result._embedded;
  if (isPlainObject(embedded)) {
    for (const value of Object.values(embedded)) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Classify a parsed tool result as `empty` or `populated`.
 *
 * - If the result carries a standard envelope array (`results`, `conversations`,
 *   `inboxes`, `customers`, `items`, `threads`, `_embedded.*`, …) → populated iff
 *   that array has length > 0.
 * - Otherwise (single-object gets like getCustomer/getOrganization/getInbox) →
 *   populated by default (a successful get returned an object).
 * Defensive: non-objects default to `populated` (we never suppress guidance on
 * an unexpected shape).
 */
export function classifyResultShape(result: unknown): ResultShape {
  if (!isPlainObject(result)) {
    return 'populated';
  }
  const arr = firstArrayInEnvelope(result);
  if (arr !== undefined) {
    return arr.length > 0 ? 'populated' : 'empty';
  }
  return 'populated';
}

function asId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** Pull a wrapped single-object payload (getCustomer → {customer:{...}}). */
function nestedObjectId(result: Record<string, unknown>, key: string): string | undefined {
  const nested = result[key];
  if (isPlainObject(nested)) {
    return asId(nested.id);
  }
  return undefined;
}

/**
 * Extract a real anchor id from a result for concrete examples. Order favors the
 * most specific/explicit id the tool echoes, then falls back to the first id in
 * the result envelope. Returns undefined when nothing usable is present.
 */
export function extractAnchorId(_toolName: string, result: unknown): AnchorId | undefined {
  if (!isPlainObject(result)) {
    return undefined;
  }

  // Explicit echoed ids (tools echo the id they were called with).
  const explicit: Array<[string, unknown]> = [
    ['conversation', result.conversationId],
    ['customer', result.customerId],
    ['inbox', result.inboxId],
    ['organization', result.organizationId],
    ['article', result.articleId],
  ];
  for (const [kind, raw] of explicit) {
    const id = asId(raw);
    if (id) {
      return { kind, id };
    }
  }

  // Wrapped single-object gets.
  const wrapped: Array<[string, string]> = [
    ['conversation', 'conversation'],
    ['customer', 'customer'],
    ['inbox', 'inbox'],
    ['organization', 'organization'],
  ];
  for (const [kind, key] of wrapped) {
    const id = nestedObjectId(result, key);
    if (id) {
      return { kind, id };
    }
  }

  // First id in the result envelope array.
  const arr = firstArrayInEnvelope(result);
  if (arr && arr.length > 0 && isPlainObject(arr[0])) {
    const id = asId((arr[0] as Record<string, unknown>).id);
    if (id) {
      return { kind: 'result', id };
    }
  }

  // Top-level id (some single-object gets are unwrapped).
  const topId = asId(result.id);
  if (topId) {
    return { kind: 'result', id: topId };
  }

  return undefined;
}

/**
 * Shape-conditional next-step guidance for the discovery hubs + high-traffic
 * tools. `populated`/`empty` produce the text (with a real anchor id when one is
 * available — the example helper falls back to a generic form otherwise).
 * `successorsPopulated`/`successorsEmpty` name the drill-in tools to surface as
 * typed schemas; absence falls back to the static SUCCESSOR_MAP.
 */
export const GUIDANCE_MAP: Record<string, GuidanceEntry> = {
  searchConversations: {
    populated: (a) => {
      const cid = a?.id ?? '<conversationId>';
      return [
        `✅ NEXT: getThreads({conversationId:'${cid}'}) for the messages; getCustomer({customerId:'...'}) for the requester.`,
      ];
    },
    empty: () => [
      '❌ No matches. Broaden: drop filters / widen the date range, or searchCustomersByEmail to find the person first, then searchConversations({customerIds:[id]}).',
    ],
    successorsPopulated: ['getOriginalSource', 'getAttachment'],
    successorsEmpty: ['searchCustomersByEmail'],
  },

  getConversation: {
    populated: (a) => {
      const cid = a?.id ?? '<conversationId>';
      return [
        `✅ NEXT: getThreads({conversationId:'${cid}'}) for full message history; getOriginalSource for the raw thread source; getAttachment for attachment data.`,
      ];
    },
    successorsPopulated: ['getThreads', 'getOriginalSource', 'getCustomer'],
  },

  getThreads: {
    populated: (a) => {
      const cid = a?.id ?? '<conversationId>';
      return [
        `✅ NEXT: getOriginalSource({conversationId:'${cid}', threadId:'...'}) for the raw source of a thread; getAttachment for attachment data.`,
      ];
    },
    empty: () => [
      '❌ No threads returned. Verify the conversationId, or call getConversation for the conversation envelope.',
    ],
    successorsPopulated: ['getOriginalSource', 'getAttachment'],
  },

  getCustomer: {
    populated: (a) => {
      const id = a?.id ?? '<customerId>';
      return [
        `✅ NEXT: getCustomerContacts({customerId:'${id}'}) for emails/phones; searchConversations({customerIds:[${id}]}) for their tickets.`,
      ];
    },
    successorsPopulated: ['getCustomerContacts', 'getOrganization'],
  },

  getOrganization: {
    populated: (a) => {
      const id = a?.id ?? '<organizationId>';
      return [
        `✅ NEXT: getOrganizationMembers({organizationId:'${id}'}) for its customers; getOrganizationConversations({organizationId:'${id}'}) for its tickets; listOrganizationProperties({organizationId:'${id}'}) for custom fields.`,
      ];
    },
    successorsPopulated: [
      'getOrganizationMembers',
      'getOrganizationConversations',
      'listOrganizationProperties',
    ],
  },

  listAllInboxes: {
    populated: (a) => {
      const id = a?.id ?? '<inboxId>';
      return [
        '✅ NEXT STEP: Use the inbox ID from these results in your conversation search',
        `Example: searchConversations({ "inboxId": "${id}", "status": "active" })`,
      ];
    },
    empty: () => [
      '❌ No inboxes found. Pass a broader nameContains filter, or omit nameContains to list all inboxes',
    ],
    successorsPopulated: ['getInbox', 'listSavedReplies'],
  },

  getInbox: {
    populated: (a) => {
      const id = a?.id ?? '<inboxId>';
      return [
        `✅ NEXT: searchConversations({inboxId:'${id}'}) for this inbox's tickets; listSavedReplies for its canned replies. Re-call getInbox with include:["fields","folders","routing"] to attach inbox sub-resources.`,
      ];
    },
    successorsPopulated: ['listSavedReplies'],
  },

  searchDocsArticles: {
    populated: (a) => {
      const id = a?.id ?? '<articleId>';
      return [
        `✅ NEXT: getDocsArticle({articleId:'${id}'}) for the full article; listDocsRelatedArticles({articleId:'${id}'}) for related content.`,
      ];
    },
    empty: () => [
      '❌ No articles matched. Broaden the query (fewer/shorter keywords), or drop the siteId/collectionId filter.',
    ],
    successorsPopulated: ['getDocsArticle', 'listDocsRelatedArticles'],
  },

  getCompanyReport: {
    populated: () => [
      '✅ NEXT: cross-report drilldowns — getConversationsReport for volume, getProductivityReport for response/resolution time, getHappinessReport for satisfaction over the same interval.',
    ],
    successorsPopulated: ['getConversationsReport', 'getProductivityReport', 'getHappinessReport'],
  },
};

/**
 * Map a list of successor tool names to sanitized {name, description, inputSchema}
 * hints, filtering out core/meta tools and capping at 3. Mirrors the prior
 * `successorHintsFor` behavior but takes an explicit name list (so it can serve
 * both content-aware and static-fallback paths).
 */
export function hintsForNames(
  names: readonly string[] | undefined,
  deps: GuidanceDeps,
): ToolHint[] | undefined {
  if (!names || names.length === 0) {
    return undefined;
  }
  const excluded = new Set<string>([...deps.coreTools, ...deps.metaTools]);
  const wanted = names.filter((name) => !excluded.has(name)).slice(0, 3);
  if (wanted.length === 0) {
    return undefined;
  }
  const byName = new Map(deps.toolDefs.map((tool) => [tool.name, tool]));
  const hints = wanted
    .map((name) => byName.get(name))
    .filter((tool): tool is Tool => tool !== undefined)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  return hints.length > 0 ? hints : undefined;
}

/**
 * The single content-aware producer of both next-step text and typed successor
 * hints. Total: never throws; returns undefined fields when there is nothing to
 * say.
 */
export function buildResponseGuidance(
  toolName: string,
  result: unknown,
  deps: GuidanceDeps,
): { apiGuidance?: string[]; suggestedTools?: ToolHint[] } {
  try {
    const shape = classifyResultShape(result);
    const anchor = extractAnchorId(toolName, result);
    const entry = GUIDANCE_MAP[toolName];

    let apiGuidance: string[] | undefined;
    if (entry) {
      const text = shape === 'populated' ? entry.populated?.(anchor) : entry.empty?.();
      if (text && text.length > 0) {
        apiGuidance = text;
      }
    }

    // Content-aware successors from the shape branch; fall back to the static map.
    const successorNames =
      (shape === 'populated' ? entry?.successorsPopulated : entry?.successorsEmpty) ??
      deps.successorMap[toolName];
    const suggestedTools = hintsForNames(successorNames, deps);

    return {
      apiGuidance,
      suggestedTools,
    };
  } catch {
    return {};
  }
}
