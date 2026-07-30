import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// zod/v4 is used here, and only here, for `z.toJSONSchema`. Deriving the
// advertised inputSchema from the validating schema removes the drift between
// the two that hand-written JSON Schema invites. The read registry predates
// that helper and keeps its hand-written schemas.
import { z } from 'zod/v4';
import {
  HelpScoutWriteError,
  WriteMethod,
  WriteResponse,
  helpScoutClient,
} from '../utils/helpscout-client.js';
import { createMcpToolError } from '../utils/mcp-errors.js';
import { cache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

/** How far a write reaches, per the write tool contract. */
export type MutationClass = 'nonDestructive' | 'reversible' | 'externallyVisible';

/** Tier 1 needs HELPSCOUT_ENABLE_WRITES; tier 2 also needs the customer-visible flag. */
export type WriteTier = 1 | 2;

/**
 * The request a write would send, as reported by `dryRun`. Help Scout has no
 * preview or validate endpoint for these mutations, so a dry run reports the
 * planned request and says plainly that Help Scout state was not checked.
 */
export interface PlannedRequest {
  method: WriteMethod;
  path: string;
  /** The exact body that will be sent. Absent when a read decides it. */
  body?: unknown;
  /** A read the operation performs first, for read-modify-write operations. */
  precededBy?: { method: 'GET'; path: string };
  /**
   * The requested part of the body for a read-modify-write operation, before it
   * is merged with what that read returns. It is not the body that gets sent.
   */
  bodyBeforeMerge?: unknown;
  /** How the sent body differs from the planned one after that read. */
  bodyNote?: string;
}

export interface CleanupPlan {
  required: boolean;
  performed: boolean;
  instructions: string | null;
}

/** One enabled write operation, as the gateway registry sees it. */
export interface WriteOperation {
  tool: Tool;
  mutationClass: MutationClass;
  tier: WriteTier;
  /** What `targetId` in the confirmation metadata refers to. */
  targetType: 'conversation';
  /** The argument holding the primary target ID. */
  targetArgument: string;
  /** Validate arguments and report the request that would be sent. Throws on invalid input. */
  plan(args: unknown): PlannedRequest;
  /** Validate arguments and perform the mutation. */
  execute(args: unknown): Promise<CallToolResult>;
}

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const conversationIdSchema = z
  .string()
  .regex(/^\d+$/, 'Conversation ID must be numeric')
  .describe('Help Scout conversation ID from searchConversations or getConversationSummary.');

const numericIdSchema = (label: string) =>
  z.string().regex(/^\d+$/, `${label} must be numeric`);

const emailListSchema = z.array(z.string().min(1)).max(10);

/** Conversation fields the write operations read back before merging. */
interface ConversationReadModel {
  tags?: Array<{ tag?: string }>;
  customFields?: Array<{ id?: number; value?: unknown }>;
  primaryCustomer?: { id?: number };
}

interface PerformOutcome {
  result: Record<string, unknown>;
  cleanup: CleanupPlan;
}

/**
 * One write operation, typed against its own schema so `plan` and `perform`
 * receive parsed input rather than `unknown`.
 */
interface WriteDefinition<Schema extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  mutationClass: MutationClass;
  plan(input: z.infer<Schema>): PlannedRequest;
  perform(input: z.infer<Schema>): Promise<PerformOutcome>;
}

/** A write definition with its schema type erased, as the handler list holds it. */
interface AnyWriteDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  mutationClass: MutationClass;
  plan(input: Record<string, unknown>): PlannedRequest;
  perform(input: Record<string, unknown>): Promise<PerformOutcome>;
}

/**
 * Keep each definition's `plan` and `perform` typed against the schema declared
 * beside them, while the handler holds a list of one erased type. Without this
 * the callbacks would take `unknown` and every field access would need a cast.
 */
function defineWrite<Schema extends z.ZodObject>(definition: WriteDefinition<Schema>): AnyWriteDefinition {
  return definition as AnyWriteDefinition;
}

function tierFor(mutationClass: MutationClass): WriteTier {
  return mutationClass === 'externallyVisible' ? 2 : 1;
}

function inputSchemaFor(schema: z.ZodObject): Tool['inputSchema'] {
  // `io: 'input'` keeps defaulted fields optional in the advertised schema:
  // callers supply the input side, not the parsed output side.
  const jsonSchema = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  // The gateway tools advertise no $schema; JSON Schema 2020-12 is the default.
  delete jsonSchema.$schema;
  return jsonSchema as Tool['inputSchema'];
}

function jsonResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Most Mailbox v2 mutations answer with `204 No Content`, so success carries no
 * payload to inspect. Say so, and name the read that confirms the change.
 */
function noContentResult(response: WriteResponse, verifies: string): Record<string, unknown> {
  return {
    httpStatus: response.status,
    body: null,
    note: 'Help Scout returns no response body for this endpoint, so the response cannot confirm the new state.',
    verifyWith: `Call getConversation to confirm ${verifies}.`,
  };
}

/** The cleanup block for an operation that leaves nothing to undo automatically. */
function noCleanupNeeded(instructions: string): CleanupPlan {
  return { required: false, performed: false, instructions };
}

function conversationPath(conversationId: string): string {
  return `/conversations/${conversationId}`;
}

/** Send the request a `plan` already described, for operations whose plan is exact. */
async function sendPlanned(request: PlannedRequest): Promise<WriteResponse> {
  switch (request.method) {
    case 'POST':
      return helpScoutClient.post(request.path, request.body);
    case 'PUT':
      return helpScoutClient.put(request.path, request.body);
    case 'PATCH':
      return helpScoutClient.patch(request.path, request.body);
    case 'DELETE':
      return helpScoutClient.delete(request.path);
  }
}

/**
 * A failure that happened before any mutation was sent: the read a
 * read-modify-write operation performs first, or something missing from what
 * that read returned. Reported as a write failure envelope stating plainly that
 * nothing was attempted, rather than as a bare read error.
 */
class PreWriteError extends Error {
  constructor(
    message: string,
    readonly guidance: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'PreWriteError';
  }
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown; statusCode?: unknown })?.status
    ?? (error as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Read the conversation fresh: a merge computed from a cached copy would drop concurrent edits. */
async function readConversation(conversationId: string): Promise<ConversationReadModel> {
  try {
    return await helpScoutClient.get<ConversationReadModel>(
      conversationPath(conversationId),
      undefined,
      { ttl: 0 },
    );
  } catch (error) {
    throw new PreWriteError(
      `The read this operation performs before writing failed: ${error instanceof Error ? error.message : String(error)}`,
      'No mutation was attempted. This operation reads the conversation before writing, and that read failed, so nothing was sent that could change Help Scout state. Resolve the read failure, then call the operation again.',
      statusOf(error),
    );
  }
}

function currentTags(conversation: ConversationReadModel): string[] {
  return (conversation.tags ?? [])
    .map((entry) => entry.tag)
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

/**
 * Current custom field values, kept exactly as Help Scout returned them.
 *
 * Values for fields the caller did not name are echoed back verbatim: coercing
 * them to strings, or turning a null into an empty string, would rewrite fields
 * the caller never asked to touch.
 */
function currentFields(conversation: ConversationReadModel): Array<{ id: number; value: unknown }> {
  return (conversation.customFields ?? [])
    .filter((field): field is { id: number; value?: unknown } => typeof field.id === 'number')
    // An entry Help Scout returns without a value key has nothing to preserve:
    // echoing it back value-less would send `{ id }` in a full-replace PUT with
    // undefined semantics, and omitting it leaves an unset field unset. A null
    // value is a real value and is kept verbatim.
    .filter((field) => field.value !== undefined)
    .map((field) => ({ id: field.id, value: field.value }));
}

function guidanceForStatus(status: number | undefined): string {
  switch (status) {
    case 401:
      return 'Help Scout rejected the credentials, so the request was refused before it was processed and nothing was applied. Nothing is wrong with the arguments. The cached token is discarded and the next call re-authenticates, so retry once; if it fails again the app credentials need attention.';
    case 403:
      return 'The Help Scout app lacks permission for this mailbox or conversation. Confirm the app has access to the inbox before retrying.';
    case 404:
      return 'The conversation does not exist, or it was merged into another conversation and the old ID no longer resolves. Call getConversation to re-resolve the target ID, then retry against the new one.';
    case 412:
      return 'Help Scout rejected the change as a precondition failure. A conversation holds at most 100 threads, and company policy can block updates to old conversations. Neither is fixable by retrying.';
    case 422:
      return 'Help Scout rejected the request body. Check the reported validation errors against the operation schema and correct the arguments.';
    case 423:
      return 'The conversation is locked and cannot be changed right now. Retry later or resolve the lock in Help Scout.';
    case 429:
      return 'Help Scout rate-limited the request. Writes are never retried automatically, so this write may not have been applied. Read the conversation back with getConversation before retrying.';
    default:
      if (status !== undefined && status >= 500) {
        return 'Help Scout returned a server error. A 5xx does not prove the write failed, and writes are never retried automatically. Read the conversation back with getConversation before retrying.';
      }
      return 'Check the upstream status and response body, correct the arguments, and retry only after confirming the current state with getConversation.';
  }
}

/** True when the failure leaves it genuinely unknown whether the write landed. */
function outcomeIsUncertain(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

function failureEnvelope(
  definition: AnyWriteDefinition,
  targetId: string,
  error: HelpScoutWriteError,
): Record<string, unknown> {
  const uncertain = outcomeIsUncertain(error.status);
  return {
    operation: definition.name,
    mutationClass: definition.mutationClass,
    target: { type: 'conversation', id: targetId },
    status: 'failed',
    result: null,
    error: {
      upstreamStatus: error.status ?? null,
      message: error.message,
      upstreamBody: error.body ?? null,
      guidance: guidanceForStatus(error.status),
    },
    cleanup: {
      required: uncertain,
      performed: false,
      instructions: uncertain
        ? 'It is not known whether Help Scout applied this change. Read the conversation back with getConversation before retrying, so a retry does not duplicate the mutation.'
        : null,
    },
  };
}

/** Failure envelope for an operation that never reached its mutation. */
function preWriteFailureEnvelope(
  definition: AnyWriteDefinition,
  targetId: string,
  error: PreWriteError,
): Record<string, unknown> {
  return {
    operation: definition.name,
    mutationClass: definition.mutationClass,
    target: { type: 'conversation', id: targetId },
    status: 'failed',
    result: null,
    error: {
      phase: 'preWriteRead',
      upstreamStatus: error.upstreamStatus ?? null,
      message: error.message,
      guidance: error.guidance,
    },
    cleanup: {
      required: false,
      performed: false,
      instructions: null,
    },
  };
}

/**
 * Phase-1 Help Scout write operations (NAS-1480).
 *
 * Every operation here maps to one Help Scout mutation endpoint. Handlers stay
 * out of ToolHandler: reads are cached GET wrappers annotated readOnlyHint,
 * and mixing single-attempt mutations into that class would blur both claims.
 */
export class WriteHandler {
  private readonly definitions: AnyWriteDefinition[] = [
    this.createNoteDefinition(),
    this.createDraftReplyDefinition(),
    this.updateConversationStatusDefinition(),
    this.assignConversationDefinition(),
    this.unassignConversationDefinition(),
    this.addConversationTagsDefinition(),
    this.removeConversationTagsDefinition(),
    this.updateConversationFieldsDefinition(),
    this.snoozeConversationDefinition(),
    this.unsnoozeConversationDefinition(),
    this.moveConversationDefinition(),
    this.sendReplyDefinition(),
    this.publishDraftDefinition(),
  ];

  /** Every write operation the server knows about, gated or not. */
  listOperations(): WriteOperation[] {
    return this.definitions.map((definition) => this.toOperation(definition));
  }

  private toOperation(definition: AnyWriteDefinition): WriteOperation {
    return {
      tool: {
        name: definition.name,
        title: definition.title,
        description: definition.description,
        inputSchema: inputSchemaFor(definition.schema),
        annotations: WRITE_ANNOTATIONS,
      },
      mutationClass: definition.mutationClass,
      tier: tierFor(definition.mutationClass),
      targetType: 'conversation',
      targetArgument: 'conversationId',
      plan: (args: unknown) => definition.plan(definition.schema.parse(args) as Record<string, unknown>),
      execute: (args: unknown) => this.run(definition, args),
    };
  }

  private async run(definition: AnyWriteDefinition, args: unknown): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    let input: Record<string, unknown>;

    try {
      input = definition.schema.parse(args) as Record<string, unknown>;
    } catch (error) {
      return createMcpToolError(error, { toolName: definition.name, requestId });
    }

    const targetId = String(input.conversationId);
    logger.info('Write operation started', {
      requestId,
      operation: definition.name,
      mutationClass: definition.mutationClass,
      conversationId: targetId,
    });

    // Only the Help Scout request is wrapped. Everything after it runs outside
    // the catch, so a failure while building the success envelope cannot be
    // reported as a failed write after the mutation already landed.
    let outcome: PerformOutcome;
    try {
      outcome = await definition.perform(input);
    } catch (error) {
      if (error instanceof PreWriteError) {
        logger.info('Write operation stopped before mutating', {
          requestId,
          operation: definition.name,
          reason: error.message,
        });
        return jsonResult(preWriteFailureEnvelope(definition, targetId, error), true);
      }
      if (error instanceof HelpScoutWriteError) {
        // An uncertain failure tells the caller to read the target back and see
        // whether the write landed. A cached pre-write copy would answer that
        // question with the old state and invite a duplicate mutation.
        if (outcomeIsUncertain(error.status)) {
          cache.clear();
        }
        return jsonResult(failureEnvelope(definition, targetId, error), true);
      }
      return createMcpToolError(error, { toolName: definition.name, requestId });
    }

    // Reads are cached, and the contract tells callers to verify a write by
    // reading the target back. Serving that read-back from a pre-write cache
    // entry would report the old state as confirmation. Writes are rare and
    // operator-gated, so dropping the whole cache costs little next to that.
    cache.clear();

    logger.info('Write operation succeeded', { requestId, operation: definition.name });

    return jsonResult({
      operation: definition.name,
      mutationClass: definition.mutationClass,
      target: { type: 'conversation', id: targetId },
      status: 'succeeded',
      result: outcome.result,
      cleanup: outcome.cleanup,
    });
  }

  // --- Tier 1: nonDestructive -------------------------------------------

  private createNoteDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      text: z.string().min(1).describe('Note body. Visible to teammates in Help Scout, never to the customer.'),
    });

    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'POST',
      path: `${conversationPath(input.conversationId)}/notes`,
      body: { text: input.text },
    });

    return defineWrite({
      name: 'createNote',
      title: 'Add an internal note to a conversation',
      description: 'Add an internal note to a Help Scout conversation. Notes are visible to teammates only and never notify the customer. The Mailbox API has no endpoint to delete a note.',
      schema,
      mutationClass: 'nonDestructive',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: {
            httpStatus: response.status,
            threadId: response.headers['resource-id'] ?? null,
            note: 'Help Scout returns the new thread ID in the Resource-Id response header, not in a body.',
            verifyWith: 'Call getThreads to see the note in the conversation.',
          },
          cleanup: noCleanupNeeded('The Mailbox API has no delete-note endpoint. Remove the note from the Help Scout web app if it was added by mistake.'),
        };
      },
    });
  }

  private createDraftReplyDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      text: z.string().min(1).describe('Reply body saved as a draft.'),
      customerId: numericIdSchema('Customer ID').optional().describe('Customer the reply addresses. When omitted, the conversation primary customer is resolved and used.'),
      customerEmail: z.string().min(1).optional().describe('Customer email, as an alternative to customerId.'),
      assignTo: numericIdSchema('User ID').optional().describe('Help Scout user ID to assign the conversation to.'),
      cc: emailListSchema.optional().describe('Email addresses to CC when the draft is later sent.'),
      bcc: emailListSchema.optional().describe('Email addresses to BCC when the draft is later sent.'),
    });

    return defineWrite({
      name: 'createDraftReply',
      title: 'Draft a customer reply without sending it',
      description: 'Compose a customer reply and save it as an unsent draft on a Help Scout conversation. The draft flag is pinned on: this operation cannot send. Use sendReply or publishDraft, both of which require the customer-visible write flag and per-call confirmation, to actually email the customer.',
      schema,
      mutationClass: 'nonDestructive',
      plan: (input) => {
        const customer = explicitReplyCustomer(input);
        const path = `${conversationPath(input.conversationId)}/reply`;
        if (customer) {
          return { method: 'POST', path, body: buildReplyBody(input, true, customer) };
        }
        // Without an explicit customer the recipient is decided by a read, so
        // presenting a customer-less body as "the exact body" would let a
        // preview be approved without showing who the reply addresses.
        return {
          method: 'POST',
          path,
          bodyBeforeMerge: buildReplyBody(input, true, undefined),
          precededBy: { method: 'GET', path: conversationPath(input.conversationId) },
          bodyNote: 'The reply endpoint requires a customer. The recipient will be the conversation primary customer, resolved by that read and added to the sent body.',
        };
      },
      perform: async (input) => {
        const customer = await resolveReplyCustomer(input);
        const response = await helpScoutClient.post(
          `${conversationPath(input.conversationId)}/reply`,
          buildReplyBody(input, true, customer),
        );
        return {
          result: {
            httpStatus: response.status,
            threadId: response.headers['resource-id'] ?? null,
            draft: true,
            note: 'The reply was stored as a draft. No email was sent and the customer was not notified.',
            verifyWith: 'Call getThreads to see the draft thread.',
          },
          cleanup: noCleanupNeeded('The Mailbox API has no delete-thread endpoint. Discard the draft from the Help Scout web app if it was created by mistake.'),
        };
      },
    });
  }

  // --- Tier 1: reversible -----------------------------------------------

  private updateConversationStatusDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      status: z.enum(['active', 'closed', 'pending']).describe('New conversation status.'),
    });

    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'PATCH',
      path: conversationPath(input.conversationId),
      body: { op: 'replace', path: '/status', value: input.status },
    });

    return defineWrite({
      name: 'updateConversationStatus',
      title: 'Change a conversation status',
      description: 'Set a Help Scout conversation to active, closed, or pending. Reversible by setting the previous status again.',
      schema,
      mutationClass: 'reversible',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: {
            ...noContentResult(response, `the status is now ${input.status}`),
            status: input.status,
          },
          cleanup: noCleanupNeeded('Call updateConversationStatus again with the previous status to restore it.'),
        };
      },
    });
  }

  private assignConversationDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      userId: numericIdSchema('User ID').describe('Help Scout user ID to assign the conversation to, from listUsers.'),
    });

    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'PATCH',
      path: conversationPath(input.conversationId),
      body: { op: 'replace', path: '/assignTo', value: Number(input.userId) },
    });

    return defineWrite({
      name: 'assignConversation',
      title: 'Assign a conversation to a user',
      description: 'Assign a Help Scout conversation to a user. Reversible with assignConversation or unassignConversation.',
      schema,
      mutationClass: 'reversible',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: {
            ...noContentResult(response, `the conversation is assigned to user ${input.userId}`),
            assignedTo: Number(input.userId),
          },
          cleanup: noCleanupNeeded('Call assignConversation with the previous assignee, or unassignConversation, to restore the earlier state.'),
        };
      },
    });
  }

  private unassignConversationDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({ conversationId: conversationIdSchema });

    // JSON Patch `remove` carries no value, so none is sent even though the
    // Help Scout table lists a value type for this row.
    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'PATCH',
      path: conversationPath(input.conversationId),
      body: { op: 'remove', path: '/assignTo' },
    });

    return defineWrite({
      name: 'unassignConversation',
      title: 'Remove the assignee from a conversation',
      description: 'Clear the assignee on a Help Scout conversation, returning it to the unassigned queue. Reversible with assignConversation.',
      schema,
      mutationClass: 'reversible',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: noContentResult(response, 'the conversation has no assignee'),
          cleanup: noCleanupNeeded('Call assignConversation with the previous assignee to restore it.'),
        };
      },
    });
  }

  private addConversationTagsDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      tags: z.array(z.string().min(1)).min(1).max(50).describe('Tags to add. Tags that do not exist yet are created by Help Scout.'),
    });

    return defineWrite({
      name: 'addConversationTags',
      title: 'Add tags to a conversation',
      description: 'Add tags to a Help Scout conversation, keeping the tags already on it. Help Scout replaces the whole tag list on every update, so this operation reads the current tags first and sends the merged list; a tag added by someone else between that read and the write is lost. Reversible with removeConversationTags.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PUT',
        path: `${conversationPath(input.conversationId)}/tags`,
        precededBy: { method: 'GET', path: conversationPath(input.conversationId) },
        bodyBeforeMerge: { tags: input.tags },
        bodyNote: 'The tags sent are the conversation current tags merged with these; the list shown here is only the requested addition, not the body that gets sent.',
      }),
      perform: async (input) => {
        const conversationId = input.conversationId;
        const requested = input.tags;
        const existing = currentTags(await readConversation(conversationId));
        const existingLower = new Set(existing.map((tag) => tag.toLowerCase()));
        // Seeded from the existing tags and grown as tags are accepted, so a
        // list that names the same tag twice in different cases sends one entry.
        const seen = new Set(existingLower);
        const added = requested.filter((tag) => {
          const key = tag.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const merged = [...existing, ...added];

        const response = await helpScoutClient.put(
          `${conversationPath(conversationId)}/tags`,
          { tags: merged },
        );
        return {
          result: {
            ...noContentResult(response, 'the tag list matches the one below'),
            previousTags: existing,
            tags: merged,
            added,
            alreadyPresent: requested.filter((tag) => existingLower.has(tag.toLowerCase())),
          },
          cleanup: noCleanupNeeded('Call removeConversationTags with the added tags to restore the previous list.'),
        };
      },
    });
  }

  private removeConversationTagsDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      tags: z.array(z.string().min(1)).min(1).max(50).describe('Tags to remove. Matching ignores case.'),
    });

    return defineWrite({
      name: 'removeConversationTags',
      title: 'Remove tags from a conversation',
      description: 'Remove tags from a Help Scout conversation, keeping the rest. Help Scout replaces the whole tag list on every update, so this operation reads the current tags first and sends the remaining list; a tag added by someone else between that read and the write is lost. Reversible with addConversationTags.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PUT',
        path: `${conversationPath(input.conversationId)}/tags`,
        precededBy: { method: 'GET', path: conversationPath(input.conversationId) },
        bodyNote: 'The tags sent are the conversation current tags minus the requested removals, which cannot be known before that read.',
      }),
      perform: async (input) => {
        const conversationId = input.conversationId;
        const requested = input.tags;
        const existing = currentTags(await readConversation(conversationId));
        const removeLower = new Set(requested.map((tag) => tag.toLowerCase()));
        const remaining = existing.filter((tag) => !removeLower.has(tag.toLowerCase()));
        const removed = existing.filter((tag) => removeLower.has(tag.toLowerCase()));

        const response = await helpScoutClient.put(
          `${conversationPath(conversationId)}/tags`,
          { tags: remaining },
        );
        return {
          result: {
            ...noContentResult(response, 'the tag list matches the one below'),
            previousTags: existing,
            tags: remaining,
            removed,
            notPresent: requested.filter(
              (tag) => !existing.some((current) => current.toLowerCase() === tag.toLowerCase()),
            ),
          },
          cleanup: noCleanupNeeded('Call addConversationTags with the removed tags to restore the previous list.'),
        };
      },
    });
  }

  private updateConversationFieldsDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      fields: z
        .array(
          z.strictObject({
            id: numericIdSchema('Custom field ID').describe('Custom field ID from getInbox.'),
            value: z.string().describe('Field value. Dates use YYYY-MM-DD and dropdowns use the option ID.'),
          }),
        )
        .min(1)
        .max(50)
        .describe('Custom fields to set. Fields not listed keep their current values.'),
    });

    const requestedFields = (input: z.infer<typeof schema>) =>
      input.fields.map((field) => ({ id: Number(field.id), value: field.value }));

    return defineWrite({
      name: 'updateConversationFields',
      title: 'Set custom field values on a conversation',
      description: 'Set custom field values on a Help Scout conversation. Help Scout replaces the whole custom field list on every update, so this operation reads the current values first and sends them merged with the new ones; a value changed by someone else between that read and the write is lost. Reversible by sending the previous values.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PUT',
        path: `${conversationPath(input.conversationId)}/fields`,
        precededBy: { method: 'GET', path: conversationPath(input.conversationId) },
        bodyBeforeMerge: { fields: requestedFields(input) },
        bodyNote: 'The fields sent are the conversation current custom fields merged with these; fields already set but not listed here are preserved with the values the read returns.',
      }),
      perform: async (input) => {
        const conversationId = input.conversationId;
        const requested = requestedFields(input);
        const existing = currentFields(await readConversation(conversationId));

        // Existing entries keep the value Help Scout returned; only the fields
        // the caller named are replaced with the requested string values.
        const merged = new Map<number, { id: number; value: unknown }>(
          existing.map((field) => [field.id, field]),
        );
        for (const field of requested) {
          merged.set(field.id, field);
        }
        const fields = Array.from(merged.values());

        const response = await helpScoutClient.put(
          `${conversationPath(conversationId)}/fields`,
          { fields },
        );
        return {
          result: {
            ...noContentResult(response, 'the custom field values match the ones below'),
            previousFields: existing,
            fields,
            updated: requested,
          },
          cleanup: noCleanupNeeded('Call updateConversationFields with the values listed in previousFields to restore them.'),
        };
      },
    });
  }

  private snoozeConversationDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      snoozedUntil: z
        .string()
        .refine(isIsoDateShape, 'snoozedUntil must be an ISO 8601 date, for example 2026-08-01T12:00:00Z')
        .refine(isFutureIsoDate, 'snoozedUntil must be an ISO 8601 date in the future and before the year 2100')
        .describe('ISO 8601 date in the future, for example 2026-08-01T12:00:00Z.'),
      unsnoozeOnCustomerReply: z
        .boolean()
        .default(true)
        .describe('Whether a new customer reply wakes the conversation early.'),
    });

    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'PUT',
      path: `${conversationPath(input.conversationId)}/snooze`,
      body: {
        snoozedUntil: input.snoozedUntil,
        unsnoozeOnCustomerReply: input.unsnoozeOnCustomerReply,
      },
    });

    return defineWrite({
      name: 'snoozeConversation',
      title: 'Snooze a conversation until a future time',
      description: 'Snooze a Help Scout conversation until a future time. Each call replaces any previous snooze. Reversible with unsnoozeConversation.',
      schema,
      mutationClass: 'reversible',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: {
            ...noContentResult(response, `the conversation is snoozed until ${input.snoozedUntil}`),
            snoozedUntil: input.snoozedUntil,
            unsnoozeOnCustomerReply: input.unsnoozeOnCustomerReply,
          },
          cleanup: noCleanupNeeded('Call unsnoozeConversation to wake the conversation immediately.'),
        };
      },
    });
  }

  private unsnoozeConversationDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({ conversationId: conversationIdSchema });

    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'DELETE',
      path: `${conversationPath(input.conversationId)}/snooze`,
    });

    return defineWrite({
      name: 'unsnoozeConversation',
      title: 'Wake a snoozed conversation',
      description: 'Remove the snooze from a Help Scout conversation, returning it to its home folder and reactivating it if needed. Reversible with snoozeConversation.',
      schema,
      mutationClass: 'reversible',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: noContentResult(response, 'the conversation is no longer snoozed'),
          cleanup: noCleanupNeeded('Call snoozeConversation with the previous snooze time to restore it.'),
        };
      },
    });
  }

  private moveConversationDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      mailboxId: numericIdSchema('Inbox ID').describe('Destination inbox ID from listAllInboxes.'),
    });

    // Help Scout uses `move` with a value here, which RFC 6902 does not define:
    // its `move` takes a `from` pointer, not a value. The body is built by hand
    // for that reason; a JSON Patch library would reject or rewrite it.
    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'PATCH',
      path: conversationPath(input.conversationId),
      body: { op: 'move', path: '/mailboxId', value: Number(input.mailboxId) },
    });

    return defineWrite({
      name: 'moveConversation',
      title: 'Move a conversation to another inbox',
      description: 'Move a Help Scout conversation to a different inbox. Reversible by moving it back to the original inbox.',
      schema,
      mutationClass: 'reversible',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: {
            ...noContentResult(response, `the conversation is in inbox ${input.mailboxId}`),
            mailboxId: Number(input.mailboxId),
          },
          cleanup: noCleanupNeeded('Call moveConversation with the original inbox ID to move it back.'),
        };
      },
    });
  }

  // --- Tier 2: externallyVisible ----------------------------------------

  private sendReplyDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({
      conversationId: conversationIdSchema,
      text: z.string().min(1).describe('Reply body. This text is emailed to the customer.'),
      customerId: numericIdSchema('Customer ID').optional().describe('Customer receiving the reply. When omitted, the conversation primary customer is resolved and used.'),
      customerEmail: z.string().min(1).optional().describe('Customer email, as an alternative to customerId.'),
      assignTo: numericIdSchema('User ID').optional().describe('Help Scout user ID to assign the conversation to as part of the reply.'),
      status: z.enum(['active', 'closed', 'pending']).optional().describe('Conversation status to set as part of the reply.'),
      cc: emailListSchema.optional().describe('Email addresses to CC.'),
      bcc: emailListSchema.optional().describe('Email addresses to BCC.'),
    });

    return defineWrite({
      name: 'sendReply',
      title: 'Send a reply to the customer',
      description: 'Send a reply to the customer on a Help Scout conversation. This emails the customer immediately and cannot be recalled. Requires HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES and per-call confirmation. Use createDraftReply to compose without sending.',
      schema,
      mutationClass: 'externallyVisible',
      plan: (input) => {
        const customer = explicitReplyCustomer(input);
        const path = `${conversationPath(input.conversationId)}/reply`;
        if (customer) {
          return { method: 'POST', path, body: buildReplyBody(input, false, customer) };
        }
        // Same recipient rule as createDraftReply, and it matters more here:
        // this operation emails the customer, so the preview must say who.
        return {
          method: 'POST',
          path,
          bodyBeforeMerge: buildReplyBody(input, false, undefined),
          precededBy: { method: 'GET', path: conversationPath(input.conversationId) },
          bodyNote: 'The reply endpoint requires a customer. The recipient will be the conversation primary customer, resolved by that read and added to the sent body.',
        };
      },
      perform: async (input) => {
        const customer = await resolveReplyCustomer(input);
        const response = await helpScoutClient.post(
          `${conversationPath(input.conversationId)}/reply`,
          buildReplyBody(input, false, customer),
        );
        return {
          result: {
            httpStatus: response.status,
            threadId: response.headers['resource-id'] ?? null,
            draft: false,
            ...(input.status ? { status: input.status } : {}),
            ...(input.assignTo ? { assignedTo: Number(input.assignTo) } : {}),
            note: 'The reply was sent. Help Scout has emailed the customer.',
            verifyWith: 'Call getThreads to see the sent reply.',
          },
          cleanup: noCleanupNeeded('A sent reply cannot be recalled or deleted through the Mailbox API.'),
        };
      },
    });
  }

  private publishDraftDefinition(): AnyWriteDefinition {
    const schema = z.strictObject({ conversationId: conversationIdSchema });

    // Update Conversation lists exactly one draft operation:
    //   Publish draft | path /draft | op replace | value Boolean
    // Publishing means clearing the draft flag, so the value sent is false.
    // https://developer.helpscout.com/mailbox-api/endpoints/conversations/update/
    const plan = (input: z.infer<typeof schema>): PlannedRequest => ({
      method: 'PATCH',
      path: conversationPath(input.conversationId),
      body: { op: 'replace', path: '/draft', value: false },
    });

    return defineWrite({
      name: 'publishDraft',
      title: 'Publish a draft conversation',
      description: 'Publish a Help Scout draft by clearing its draft flag, which sends the pending reply to the customer. This cannot be undone. Requires HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES and per-call confirmation.',
      schema,
      mutationClass: 'externallyVisible',
      plan,
      perform: async (input) => {
        const response = await sendPlanned(plan(input));
        return {
          result: {
            ...noContentResult(response, 'the conversation is no longer a draft'),
            draft: false,
          },
          cleanup: noCleanupNeeded('A published draft cannot be returned to draft state, and the reply it sent cannot be recalled.'),
        };
      },
    });
  }
}

/** The customer the caller named, if any. */
function explicitReplyCustomer(input: ReplyInput): Record<string, unknown> | undefined {
  if (input.customerId) return { id: Number(input.customerId) };
  if (input.customerEmail) return { email: input.customerEmail };
  return undefined;
}

/** The arguments the two reply operations share. */
interface ReplyInput {
  conversationId: string;
  text: string;
  customerId?: string;
  customerEmail?: string;
  assignTo?: string;
  status?: string;
  cc?: string[];
  bcc?: string[];
}

/**
 * The reply endpoint requires a customer object. When the caller names none,
 * resolve the conversation's primary customer with a fresh read so the reply
 * addresses the person already on the conversation.
 */
async function resolveReplyCustomer(input: ReplyInput): Promise<Record<string, unknown>> {
  const explicit = explicitReplyCustomer(input);
  if (explicit) return explicit;

  const conversation = await readConversation(input.conversationId);
  const primaryId = conversation.primaryCustomer?.id;
  if (!primaryId) {
    throw new PreWriteError(
      'This conversation has no primary customer to address, so the reply had no recipient. Pass customerId or customerEmail explicitly.',
      'No mutation was attempted. The reply endpoint requires a customer, and the conversation read returned no primary customer to fall back on. Call the operation again with customerId or customerEmail set.',
    );
  }
  return { id: primaryId };
}

/**
 * Shared body builder for the two reply operations.
 *
 * `draft` is set by the caller of this function, never by an operation
 * argument: the draft-first rule forbids a tier-1 operation from exposing a
 * parameter that would make it externally visible.
 */
function buildReplyBody(
  input: ReplyInput,
  draft: boolean,
  customer: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    text: input.text,
    draft,
    ...(customer ? { customer } : {}),
    ...(input.assignTo ? { assignTo: Number(input.assignTo) } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(Array.isArray(input.cc) && input.cc.length > 0 ? { cc: input.cc } : {}),
    ...(Array.isArray(input.bcc) && input.bcc.length > 0 ? { bcc: input.bcc } : {}),
  };
}

const MAX_SNOOZE_YEAR = 2100;

// Same shape the read tools accept for date filters: a calendar date, with an
// optional time and an optional offset or Z. Date.parse alone accepts loose
// input such as "August 1 2026" that Help Scout then rejects.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:.]+([+-]\d{2}:\d{2}|Z)?)?$/;

function isIsoDateShape(value: string): boolean {
  return ISO_DATE_PATTERN.test(value);
}

function isFutureIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) {
    return false;
  }
  return new Date(parsed).getUTCFullYear() < MAX_SNOOZE_YEAR;
}

export const writeHandler = new WriteHandler();
