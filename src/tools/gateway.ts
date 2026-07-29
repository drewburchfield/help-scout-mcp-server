import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { config, WriteFlags } from '../utils/config.js';
import { toolHandler } from './index.js';
import {
  MutationClass,
  WriteOperation,
  WriteTier,
  writeHandler,
} from './writes.js';

/** The two-method seam the gateway actually depends on. */
export interface OperationRegistry {
  listTools(): Promise<Tool[]>;
  callTool(request: CallToolRequest): Promise<CallToolResult>;
}

/** The one-method seam the gateway depends on for writes. */
export interface WriteRegistry {
  listOperations(): WriteOperation[];
}

export interface GatewayOptions {
  writes?: WriteRegistry;
  /** Overrides the environment gates. Tests inject these instead of mutating process.env. */
  writeFlags?: Partial<WriteFlags>;
}

export const SEARCH_TOOL_NAME = 'search_help_scout';
export const DESCRIBE_TOOL_NAME = 'describe_help_scout';
export const READ_TOOL_NAME = 'read_help_scout';
export const WRITE_TOOL_NAME = 'write_help_scout';

/**
 * Every name reserved by the advertised surface. write_help_scout is reserved
 * even while writes are disabled: an operation may not take a name that would
 * become unreachable the moment an operator flips the flag.
 */
export const GATEWAY_TOOL_NAMES = [SEARCH_TOOL_NAME, DESCRIBE_TOOL_NAME, READ_TOOL_NAME] as const;

export const RESERVED_TOOL_NAMES = [...GATEWAY_TOOL_NAMES, WRITE_TOOL_NAME] as const;

const SEARCH_RESULT_LIMIT = 8;
const DESCRIBE_NAME_LIMIT = 10;

// Query terms and operation vocabulary rarely align exactly (users say
// "ticket", the API says "conversation"), so search expands both directions.
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['conversation', 'conversations', 'ticket', 'tickets', 'case', 'cases'],
  ['customer', 'customers', 'contact', 'contacts', 'person', 'people'],
  ['inbox', 'inboxes', 'mailbox', 'mailboxes', 'queue', 'queues'],
  ['thread', 'threads', 'message', 'messages', 'reply', 'replies'],
  ['report', 'reports', 'analytics', 'metrics', 'reporting'],
  ['docs', 'documentation', 'article', 'articles', 'knowledge', 'base'],
  ['attachment', 'attachments', 'file', 'files', 'download'],
  ['user', 'users', 'agent', 'agents', 'teammate', 'teammates'],
  ['organization', 'organizations', 'company', 'companies', 'account', 'accounts'],
];

const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

// Worst case, not best case: one advertised tool covers every mutation class,
// and a host approves the tool rather than the operation chosen inside it.
// destructiveHint stays true because a sent customer reply cannot be recalled.
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/**
 * A read operation, or an enabled write operation, as the registry holds it.
 *
 * A write entry carries the whole WriteOperation rather than copies of its
 * fields. Copying invited entries that mutate but carry no mutation class, and
 * every consumer then needed a fallback for a case that should not exist.
 */
type ReadEntry = { kind: 'read'; tool: Tool };
type WriteEntry = { kind: 'write'; tool: Tool; operation: WriteOperation };
type RegistryEntry = ReadEntry | WriteEntry;

function isWriteEntry(entry: RegistryEntry): entry is WriteEntry {
  return entry.kind === 'write';
}

interface OperationSummary {
  name: string;
  description: string | undefined;
  access?: string;
}

interface OperationSchema {
  name: string;
  description: string | undefined;
  inputSchema: Tool['inputSchema'];
  mutationClass?: MutationClass;
  tier?: WriteTier;
}

function tokenize(value: unknown): string[] {
  // Tokens under 3 characters are dropped: bare substring matching would let
  // "is" match "This" and inflate scores with noise.
  return (String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((term) => term.length >= 3);
}

function expandTerms(terms: string[]): Set<string> {
  const expanded = new Set(terms);
  for (const group of SYNONYM_GROUPS) {
    if (group.some((term) => expanded.has(term))) {
      group.forEach((term) => expanded.add(term));
    }
  }
  return expanded;
}

function scoreOperation(tool: Tool, expanded: ReadonlySet<string>): number {
  const name = tool.name.toLowerCase();
  const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
  let score = 0;
  for (const term of expanded) {
    if (name.includes(term)) score += 5;
    if (text.includes(term)) score += 1;
  }
  return score;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function writeToolDefinition(): Tool {
  return {
    name: WRITE_TOOL_NAME,
    title: 'Write to Help Scout',
    description:
      `Execute one enabled Help Scout write operation using arguments that match the schema loaded with ${DESCRIBE_TOOL_NAME}. ` +
      'Every operation changes Help Scout state. Operations whose mutation class is externallyVisible can email a customer, ' +
      'and each call to one is rejected before any Help Scout request unless it carries all three of: "confirm": true, ' +
      '"confirmOperation" set to the exact operation name, and "targetId" equal to the conversation ID in "arguments". ' +
      'Missing, false, or mismatched confirmation is refused. Operations classed nonDestructive or reversible need no confirmation. ' +
      'Set "dryRun": true to validate arguments and see the request that would be sent without contacting Help Scout.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact Help Scout write operation name.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments matching the selected operation schema.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true for externallyVisible operations. Ignored otherwise.',
        },
        confirmOperation: {
          type: 'string',
          description: 'Must repeat the operation name exactly, for externallyVisible operations.',
        },
        targetId: {
          type: 'string',
          description: 'Must match the conversation ID in "arguments", for externallyVisible operations.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Validate arguments and report the request that would be sent, without contacting Help Scout.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: WRITE_ANNOTATIONS,
  };
}

function gatewayToolDefinitions(readCount: number, writeCount: number): Tool[] {
  const surface = writeCount > 0
    ? `${readCount} Help Scout read operations and ${writeCount} enabled write operations`
    : `${readCount} Help Scout read operations`;

  return [
    {
      name: SEARCH_TOOL_NAME,
      title: 'Search Help Scout capabilities',
      description: `Search ${surface} by user intent (conversations, customers, organizations, inboxes, users, reports, Docs articles, attachments). Returns matching operation names and descriptions. Start here, then load schemas with ${DESCRIBE_TOOL_NAME}.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What Help Scout information or operation is needed.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
    {
      name: DESCRIBE_TOOL_NAME,
      title: 'Describe Help Scout capabilities',
      description: writeCount > 0
        ? `Return the complete input schemas for selected Help Scout operations, plus the mutation class and tier of write operations. Use exact operation names returned by ${SEARCH_TOOL_NAME}.`
        : `Return the complete input schemas for selected Help Scout read operations. Use exact operation names returned by ${SEARCH_TOOL_NAME}.`,
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: DESCRIBE_NAME_LIMIT,
            description: `Exact operation names returned by ${SEARCH_TOOL_NAME}.`,
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
    {
      name: READ_TOOL_NAME,
      title: 'Read from Help Scout',
      description: writeCount > 0
        ? `Execute one Help Scout read operation using arguments that match the schema loaded with ${DESCRIBE_TOOL_NAME}. Read-only: operations that change Help Scout state are refused here and run through ${WRITE_TOOL_NAME}.`
        : `Execute one Help Scout read operation using arguments that match the schema loaded with ${DESCRIBE_TOOL_NAME}. All operations are read-only.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Exact Help Scout operation name.',
          },
          arguments: {
            type: 'object',
            description: 'Arguments matching the selected operation schema. Omit for operations that take none.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
  ];
}

/**
 * Compact default tool surface (NAS-1452): advertises three gateway tools
 * over an internal registry of every read operation the server supports.
 * Operation schemas and handlers stay in ToolHandler; this layer only adds
 * discovery (search), schema retrieval (describe), and dispatch (read).
 */
export class GatewayHandler {
  private registryPromise?: Promise<Map<string, RegistryEntry>>;
  private readonly writes: WriteRegistry;
  private readonly writeFlagOverrides: Partial<WriteFlags>;

  constructor(
    private readonly operations: OperationRegistry = toolHandler,
    options: GatewayOptions = {},
  ) {
    this.writes = options.writes ?? writeHandler;
    this.writeFlagOverrides = options.writeFlags ?? {};
  }

  private get writeFlags(): WriteFlags {
    return { ...config.writes, ...this.writeFlagOverrides };
  }

  /**
   * Write operations the operator has actually turned on. Tier 2 is additive:
   * the customer-visible flag is inert unless writes are enabled at all.
   *
   * The filter reads the mutation class, not the declared tier. The class is
   * what decides how far a write reaches; a registry whose tier disagreed with
   * its class would otherwise admit a customer-visible operation under tier 1.
   */
  private enabledWriteOperations(): WriteOperation[] {
    const flags = this.writeFlags;
    if (!flags.enabled) {
      return [];
    }
    return this.writes
      .listOperations()
      .filter((operation) => this.customerVisibleAllowed(flags, operation.mutationClass));
  }

  /** Whether the current flags permit executing this mutation class at all. */
  private customerVisibleAllowed(flags: WriteFlags, mutationClass: MutationClass): boolean {
    return mutationClass !== 'externallyVisible' || flags.customerVisibleEnabled;
  }

  private getRegistry(): Promise<Map<string, RegistryEntry>> {
    // Operation definitions are static for the life of the process, so the
    // registry is built once and reused for every discovery call. A failed
    // build is not cached: one bad attempt must not poison every later call.
    this.registryPromise ??= this.operations.listTools().then((tools) => {
      const registry = new Map<string, RegistryEntry>();
      const add = (name: string, entry: RegistryEntry): void => {
        if (registry.has(name)) {
          throw new Error(`Duplicate operation name in capability registry: ${name}`);
        }
        if ((RESERVED_TOOL_NAMES as readonly string[]).includes(name)) {
          throw new Error(`Operation name collides with a gateway tool and would be unreachable: ${name}`);
        }
        registry.set(name, entry);
      };

      for (const tool of tools) {
        add(tool.name, { kind: 'read', tool });
      }
      for (const operation of this.enabledWriteOperations()) {
        add(operation.tool.name, { kind: 'write', tool: operation.tool, operation });
      }
      return registry;
    }).catch((error) => {
      this.registryPromise = undefined;
      logger.error('Failed to build capability registry', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    return this.registryPromise;
  }

  /** Names of every operation reachable through the gateway. */
  async listOperationNames(): Promise<string[]> {
    return Array.from((await this.getRegistry()).keys());
  }

  /**
   * The advertised tool surface: the three read gateway tools, plus
   * write_help_scout when the operator has enabled writes.
   */
  async listTools(): Promise<Tool[]> {
    const registry = await this.getRegistry();
    const entries = Array.from(registry.values());
    const writeCount = entries.filter(isWriteEntry).length;
    const tools = gatewayToolDefinitions(entries.length - writeCount, writeCount);
    return writeCount > 0 ? [...tools, writeToolDefinition()] : tools;
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const name = request.params.name;
    const args = isPlainObject(request.params.arguments) ? request.params.arguments : {};
    const userQuery = typeof args.__userQuery === 'string' ? args.__userQuery : undefined;

    switch (name) {
      case SEARCH_TOOL_NAME:
        return this.searchOperations(args.query);
      case DESCRIBE_TOOL_NAME:
        return this.describeOperations(args.names);
      case READ_TOOL_NAME:
        return this.readOperation(args.name, args.arguments, userQuery);
      case WRITE_TOOL_NAME:
        // Not advertised while writes are disabled, so it must behave like any
        // other unknown name rather than announcing a gated tool.
        return this.writeFlags.enabled
          ? this.writeOperation(args)
          : this.callLegacyOperation(request, name);
      default:
        return this.callLegacyOperation(request, name);
    }
  }

  /**
   * Operation names in the current registry remain callable directly,
   * bypassing discovery. Names removed in the v2.0.0 consolidation are not;
   * those calls get the unknown-tool error below.
   */
  private async callLegacyOperation(request: CallToolRequest, name: string): Promise<CallToolResult> {
    const registry = await this.getRegistry();
    const entry = registry.get(name);
    // No pre-2.0 client ever learned a write name, so there is no compatibility
    // debt to honor, and a bare createNote call would slip past the gating,
    // annotations, and confirmation that the write gateway exists to enforce.
    if (entry && entry.kind === 'read') {
      logger.debug('Dispatching legacy direct operation call', { operation: name });
      return this.operations.callTool(request);
    }
    return jsonResult({
      error: `Unknown tool: ${name}`,
      hint: `Use ${SEARCH_TOOL_NAME} to find the right Help Scout operation, then execute it through the tool the search result names.`,
    }, true);
  }

  private async searchOperations(query: unknown): Promise<CallToolResult> {
    if (typeof query !== 'string' || !query.trim()) {
      return jsonResult({ error: 'search_help_scout requires a non-empty string "query".' }, true);
    }

    const registry = await this.getRegistry();
    const results = this.rankOperations(registry, query, SEARCH_RESULT_LIMIT)
      .map((entry): OperationSummary => ({
        name: entry.tool.name,
        description: entry.tool.description,
        ...(isWriteEntry(entry) ? { access: `write (${entry.operation.mutationClass})` } : {}),
      }));

    return jsonResult({
      query,
      totalOperations: registry.size,
      results,
      ...(results.length === 0
        ? { hint: 'No operations matched. Retry with broader terms such as conversations, customers, organizations, inboxes, users, reports, docs, or attachments.' }
        : {}),
    });
  }

  private async describeOperations(names: unknown): Promise<CallToolResult> {
    if (!Array.isArray(names) || names.length === 0 || !names.every((name) => typeof name === 'string')) {
      return jsonResult({ error: 'describe_help_scout requires "names": a non-empty array of operation name strings.' }, true);
    }
    if (names.length > DESCRIBE_NAME_LIMIT) {
      return jsonResult({ error: `describe_help_scout accepts at most ${DESCRIBE_NAME_LIMIT} names per call.` }, true);
    }

    const registry = await this.getRegistry();
    const schemas = names.map((name): OperationSchema | { name: string; unknown: true } => {
      const entry = registry.get(name);
      if (!entry) {
        // A gated-off write operation is reported as unknown, not as gated, so
        // the disabled surface is not a discoverable inventory of what an
        // operator could turn on.
        return { name, unknown: true };
      }
      return {
        name: entry.tool.name,
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema,
        ...(isWriteEntry(entry)
          ? { mutationClass: entry.operation.mutationClass, tier: entry.operation.tier }
          : {}),
      };
    });

    return jsonResult({ schemas });
  }

  private async readOperation(name: unknown, operationArgs: unknown, userQuery?: string): Promise<CallToolResult> {
    if (typeof name !== 'string' || !name.trim()) {
      return jsonResult({ error: 'read_help_scout requires a non-empty string "name".' }, true);
    }
    if (operationArgs !== undefined && !isPlainObject(operationArgs)) {
      return jsonResult({ error: `read_help_scout "arguments" must be an object matching the ${name} schema.` }, true);
    }

    const registry = await this.getRegistry();
    const entry = registry.get(name);
    if (!entry) {
      // With writes disabled this is also the answer for a write operation
      // name: the same unknown-operation error as any other name the server
      // does not expose, so the gated surface stays uninventoried.
      return this.unknownOperationResult(registry, name, READ_TOOL_NAME);
    }
    if (isWriteEntry(entry)) {
      return jsonResult({
        error: `${name} changes Help Scout state and cannot run through ${READ_TOOL_NAME}.`,
        mutationClass: entry.operation.mutationClass,
        hint: `Call ${WRITE_TOOL_NAME} with "name": "${name}" instead.`,
      }, true);
    }

    // Client-supplied __userQuery inside the operation arguments is dropped;
    // only the value carried in the request _meta (injected by the server) is
    // trusted for API-constraint hints.
    const cleanArgs = { ...(operationArgs ?? {}) };
    delete cleanArgs.__userQuery;
    return this.operations.callTool({
      method: 'tools/call',
      params: {
        name,
        arguments: {
          ...cleanArgs,
          ...(userQuery ? { __userQuery: userQuery } : {}),
        },
      },
    });
  }

  /**
   * Execute one enabled write operation. Confirmation and dry-run handling sit
   * here rather than in the operations so that no Help Scout request can be
   * reached without passing them first.
   */
  private async writeOperation(args: Record<string, unknown>): Promise<CallToolResult> {
    const name = args.name;
    const operationArgs = args.arguments;

    if (typeof name !== 'string' || !name.trim()) {
      return jsonResult({ error: `${WRITE_TOOL_NAME} requires a non-empty string "name".` }, true);
    }
    if (operationArgs !== undefined && !isPlainObject(operationArgs)) {
      return jsonResult({ error: `${WRITE_TOOL_NAME} "arguments" must be an object matching the ${name} schema.` }, true);
    }

    const envelopeError = envelopeRefusal(args, operationArgs);
    if (envelopeError) {
      logger.warn('Write envelope refused', { operation: name, reason: String(envelopeError.error) });
      return jsonResult(envelopeError, true);
    }

    const registry = await this.getRegistry();
    const entry = registry.get(name);
    if (!entry) {
      return this.unknownOperationResult(registry, name, WRITE_TOOL_NAME);
    }
    if (!isWriteEntry(entry)) {
      return jsonResult({
        error: `${name} is a read operation and cannot run through ${WRITE_TOOL_NAME}.`,
        hint: `Call ${READ_TOOL_NAME} with "name": "${name}" instead.`,
      }, true);
    }

    const operation = entry.operation;
    const cleanArgs: Record<string, unknown> = { ...(operationArgs ?? {}) };
    delete cleanArgs.__userQuery;

    if (operation.mutationClass === 'externallyVisible') {
      // Checked here, at dispatch, not only when the registry was built. The
      // registry is built once per process, so an operator who revokes the
      // customer-visible flag mid-process would otherwise keep a live path to
      // an operation the flags no longer permit.
      const flags = this.writeFlags;
      if (!flags.enabled || !this.customerVisibleAllowed(flags, operation.mutationClass)) {
        logger.warn('Customer-visible write refused at dispatch', { operation: name });
        return jsonResult({
          error: `${name} is externallyVisible and the customer-visible write gate is off. Nothing was sent to Help Scout.`,
          operation: name,
          mutationClass: operation.mutationClass,
          hint: 'This gate is an operator setting on the server and cannot be changed from a tool call. Use a tier-1 operation, such as createDraftReply, or ask the operator to enable it.',
        }, true);
      }

      const refusal = confirmationRefusal(name, operation, args, cleanArgs);
      if (refusal) {
        logger.warn('Write confirmation refused', { operation: name, reason: refusal.reason });
        return jsonResult(refusal.payload, true);
      }
    }

    if (args.dryRun === true) {
      return dryRunWrite(name, operation, cleanArgs);
    }

    return operation.execute(cleanArgs);
  }

  private unknownOperationResult(
    registry: Map<string, RegistryEntry>,
    name: string,
    tool: string,
  ): CallToolResult {
    const suggestions = this.rankOperations(registry, name, 3).map((entry) => entry.tool.name);
    return jsonResult({
      error: `Unknown Help Scout operation: ${name}`,
      ...(suggestions.length > 0 ? { didYouMean: suggestions } : {}),
      hint: `Use ${SEARCH_TOOL_NAME} to discover valid operation names for ${tool}.`,
    }, true);
  }

  private rankOperations(registry: Map<string, RegistryEntry>, query: string, limit: number): RegistryEntry[] {
    // Expand once per search; the synonym set depends only on the query.
    const expanded = expandTerms(tokenize(query));
    return Array.from(registry.values())
      .map((entry) => ({ entry, score: scoreOperation(entry.tool, expanded) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.tool.name.localeCompare(b.entry.tool.name))
      .slice(0, limit)
      .map(({ entry }) => entry);
  }
}

/** The fields a caller may send on a write_help_scout call. */
const WRITE_ENVELOPE_FIELDS = ['name', 'arguments', 'confirm', 'confirmOperation', 'targetId', 'dryRun'] as const;

// __userQuery is added to the arguments by the server when the host supplies
// one, so it is tolerated here and never forwarded to the operation.
const WRITE_ENVELOPE_KEYS = new Set<string>([...WRITE_ENVELOPE_FIELDS, '__userQuery']);

/**
 * Envelope fields that belong beside `arguments`, never inside it. Silently
 * stripping a misplaced one turned a call the caller believed was a dry run
 * into a live mutation, so a misplaced field is refused instead.
 */
const ENVELOPE_ONLY_KEYS = ['dryRun', 'confirm', 'confirmOperation', 'targetId'] as const;

/**
 * Reject a malformed `write_help_scout` envelope before the operation is even
 * resolved. Every refusal names what to change, so the next attempt can be
 * correct without a schema round trip.
 */
function envelopeRefusal(
  args: Record<string, unknown>,
  operationArgs: unknown,
): Record<string, unknown> | undefined {
  if ('dryRun' in args && typeof args.dryRun !== 'boolean') {
    return {
      error: `${WRITE_TOOL_NAME} "dryRun" must be a boolean. Received: ${JSON.stringify(args.dryRun ?? null)}.`,
      hint: 'Send "dryRun": true to preview the request, or omit the field to execute. A string is not treated as true.',
    };
  }

  const unknownKeys = Object.keys(args).filter((key) => !WRITE_ENVELOPE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      error: `${WRITE_TOOL_NAME} received unknown top-level ${unknownKeys.length === 1 ? 'field' : 'fields'}: ${unknownKeys.join(', ')}.`,
      allowedFields: [...WRITE_ENVELOPE_FIELDS],
      hint: 'Operation arguments belong inside "arguments". Only the fields listed in allowedFields are accepted at the top level.',
    };
  }

  if (isPlainObject(operationArgs)) {
    const misplaced = ENVELOPE_ONLY_KEYS.filter((key) => key in operationArgs);
    if (misplaced.length > 0) {
      return {
        error: `${WRITE_TOOL_NAME} found ${misplaced.join(', ')} inside "arguments". ${misplaced.length === 1 ? 'That field is' : 'Those fields are'} part of the call envelope, not the operation schema.`,
        hint: 'Move these fields out of "arguments" so they sit beside it, then repeat the call. Where they are they have no effect, and a misplaced "dryRun" would execute the write for real, so the call is refused rather than run.',
      };
    }
  }

  return undefined;
}

/**
 * Help Scout offers no preview or validate endpoint for these mutations, so a
 * dry run validates the arguments and reports the request that would be sent.
 * It never contacts Help Scout and never simulates a result.
 */
function dryRunWrite(
  name: string,
  operation: WriteOperation,
  operationArgs: Record<string, unknown>,
): CallToolResult {
  let wouldSend;
  try {
    wouldSend = operation.plan(operationArgs);
  } catch (error) {
    const issues = zodIssues(error);
    return jsonResult({
      error: `Invalid arguments for ${name}.`,
      operation: name,
      dryRun: true,
      // Without issues to point at, the raw message is all the caller has;
      // dropping it would leave "invalid arguments" and nothing else.
      ...(issues ? { validationIssues: issues } : { reason: error instanceof Error ? error.message : String(error) }),
      hint: `Load the schema with ${DESCRIBE_TOOL_NAME} and correct the arguments.`,
    }, true);
  }

  return jsonResult({
    operation: name,
    mutationClass: operation.mutationClass,
    dryRun: true,
    wouldSend,
    note: 'Help Scout state was not checked. No request was sent, so this does not confirm the target exists, is reachable, or would accept the change.',
  });
}

interface ConfirmationRefusal {
  reason: string;
  payload: Record<string, unknown>;
}

/**
 * Reject a customer-visible write whose confirmation metadata is missing,
 * false, or mismatched, before any Help Scout request is made. Each refusal
 * names the exact values the next attempt needs.
 */
function confirmationRefusal(
  name: string,
  operation: WriteOperation,
  args: Record<string, unknown>,
  operationArgs: Record<string, unknown>,
): ConfirmationRefusal | undefined {
  const targetArgument = operation.targetArgument;
  const expectedTarget = operationArgs[targetArgument];
  const required = {
    confirm: true,
    confirmOperation: name,
    targetId: expectedTarget === undefined ? `the ${targetArgument} in "arguments"` : String(expectedTarget),
  };
  const base = {
    operation: name,
    mutationClass: operation.mutationClass,
    required,
    hint: 'This operation is visible to the customer. Repeat the call with all three confirmation fields set exactly as shown in "required".',
  };

  if (args.confirm !== true) {
    return {
      reason: args.confirm === undefined ? 'confirm missing' : 'confirm not true',
      payload: {
        ...base,
        error: `${name} is externallyVisible and requires "confirm": true. Received: ${JSON.stringify(args.confirm ?? null)}.`,
      },
    };
  }

  if (args.confirmOperation !== name) {
    return {
      reason: 'confirmOperation mismatch',
      payload: {
        ...base,
        error: `"confirmOperation" must be exactly "${name}". Received: ${JSON.stringify(args.confirmOperation ?? null)}.`,
      },
    };
  }

  if (expectedTarget === undefined || String(args.targetId) !== String(expectedTarget)) {
    return {
      reason: 'targetId mismatch',
      payload: {
        ...base,
        error: `"targetId" must match "arguments.${targetArgument}" (${JSON.stringify(expectedTarget ?? null)}). Received: ${JSON.stringify(args.targetId ?? null)}.`,
      },
    };
  }

  return undefined;
}

function zodIssues(error: unknown): Array<{ field: string; message: string }> | undefined {
  if (!error || typeof error !== 'object' || !('issues' in error)) {
    return undefined;
  }
  const issues = (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
  return issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
}

export const gatewayHandler = new GatewayHandler();
