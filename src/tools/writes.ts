import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// zod/v4 is used here, and only here, for `z.toJSONSchema`. Deriving the
// advertised inputSchema from the validating schema removes the drift between
// the two that hand-written JSON Schema invites. The read registry predates
// that helper and keeps its hand-written schemas.
import { z } from 'zod/v4';
import {
  HelpScoutWriteError,
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

export type WriteHttpMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The request a write would send, as reported by `dryRun`. Help Scout has no
 * preview or validate endpoint for these mutations, so a dry run reports the
 * planned request and says plainly that Help Scout state was not checked.
 */
export interface PlannedRequest {
  method: WriteHttpMethod;
  path: string;
  body?: unknown;
  /** A read the operation performs first, for read-modify-write operations. */
  precededBy?: { method: 'GET'; path: string };
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
}

interface PerformOutcome {
  result: Record<string, unknown>;
  cleanup: CleanupPlan;
}

interface WriteDefinition<Schema extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  mutationClass: MutationClass;
  plan(input: z.infer<Schema>): PlannedRequest;
  perform(input: z.infer<Schema>): Promise<PerformOutcome>;
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

function conversationPath(conversationId: string): string {
  return `/conversations/${conversationId}`;
}

/** Read the conversation fresh: a merge computed from a cached copy would drop concurrent edits. */
async function readConversation(conversationId: string): Promise<ConversationReadModel> {
  return helpScoutClient.get<ConversationReadModel>(
    conversationPath(conversationId),
    undefined,
    { ttl: 0 },
  );
}

function currentTags(conversation: ConversationReadModel): string[] {
  return (conversation.tags ?? [])
    .map((entry) => entry.tag)
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

function currentFields(conversation: ConversationReadModel): Array<{ id: number; value: string }> {
  return (conversation.customFields ?? [])
    .filter((field): field is { id: number; value?: unknown } => typeof field.id === 'number')
    .map((field) => ({ id: field.id, value: field.value === null || field.value === undefined ? '' : String(field.value) }));
}

function guidanceForStatus(status: number | undefined): string {
  switch (status) {
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
  definition: WriteDefinition<z.ZodObject>,
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

/**
 * Phase-1 Help Scout write operations (NAS-1480).
 *
 * Every operation here maps to one Help Scout mutation endpoint. Handlers stay
 * out of ToolHandler: reads are cached GET wrappers annotated readOnlyHint,
 * and mixing single-attempt mutations into that class would blur both claims.
 */
export class WriteHandler {
  private readonly definitions: WriteDefinition<z.ZodObject>[] = [
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

  private toOperation(definition: WriteDefinition<z.ZodObject>): WriteOperation {
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
      plan: (args: unknown) => definition.plan(definition.schema.parse(args)),
      execute: (args: unknown) => this.run(definition, args),
    };
  }

  private async run(definition: WriteDefinition<z.ZodObject>, args: unknown): Promise<CallToolResult> {
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

    try {
      const outcome = await definition.perform(input);

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
    } catch (error) {
      if (error instanceof HelpScoutWriteError) {
        return jsonResult(failureEnvelope(definition, targetId, error), true);
      }
      return createMcpToolError(error, { toolName: definition.name, requestId });
    }
  }

  // --- Tier 1: nonDestructive -------------------------------------------

  private createNoteDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      text: z.string().min(1).describe('Note body. Visible to teammates in Help Scout, never to the customer.'),
    });

    return {
      name: 'createNote',
      title: 'Add an internal note to a conversation',
      description: 'Add an internal note to a Help Scout conversation. Notes are visible to teammates only and never notify the customer. The Mailbox API has no endpoint to delete a note.',
      schema,
      mutationClass: 'nonDestructive',
      plan: (input) => ({
        method: 'POST',
        path: `${conversationPath(input.conversationId as string)}/notes`,
        body: { text: input.text },
      }),
      perform: async (input) => {
        const response = await helpScoutClient.post(
          `${conversationPath(input.conversationId as string)}/notes`,
          { text: input.text },
        );
        return {
          result: {
            httpStatus: response.status,
            threadId: response.headers['resource-id'] ?? null,
            note: 'Help Scout returns the new thread ID in the Resource-Id response header, not in a body.',
            verifyWith: 'Call getThreads to see the note in the conversation.',
          },
          cleanup: {
            required: false,
            performed: false,
            instructions: 'The Mailbox API has no delete-note endpoint. Remove the note from the Help Scout web app if it was added by mistake.',
          },
        };
      },
    };
  }

  private createDraftReplyDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      text: z.string().min(1).describe('Reply body saved as a draft.'),
      customerId: numericIdSchema('Customer ID').optional().describe('Customer the reply addresses. Help Scout uses the primary customer when omitted.'),
      customerEmail: z.string().min(1).optional().describe('Customer email, as an alternative to customerId.'),
      assignTo: numericIdSchema('User ID').optional().describe('Help Scout user ID to assign the conversation to.'),
      cc: emailListSchema.optional().describe('Email addresses to CC when the draft is later sent.'),
      bcc: emailListSchema.optional().describe('Email addresses to BCC when the draft is later sent.'),
    });

    return {
      name: 'createDraftReply',
      title: 'Draft a customer reply without sending it',
      description: 'Compose a customer reply and save it as an unsent draft on a Help Scout conversation. The draft flag is pinned on: this operation cannot send. Use sendReply or publishDraft, both of which require the customer-visible write flag and per-call confirmation, to actually email the customer.',
      schema,
      mutationClass: 'nonDestructive',
      plan: (input) => ({
        method: 'POST',
        path: `${conversationPath(input.conversationId as string)}/reply`,
        body: buildReplyBody(input, true),
      }),
      perform: async (input) => {
        const response = await helpScoutClient.post(
          `${conversationPath(input.conversationId as string)}/reply`,
          buildReplyBody(input, true),
        );
        return {
          result: {
            httpStatus: response.status,
            threadId: response.headers['resource-id'] ?? null,
            draft: true,
            note: 'The reply was stored as a draft. No email was sent and the customer was not notified.',
            verifyWith: 'Call getThreads to see the draft thread.',
          },
          cleanup: {
            required: false,
            performed: false,
            instructions: 'The Mailbox API has no delete-thread endpoint. Discard the draft from the Help Scout web app if it was created by mistake.',
          },
        };
      },
    };
  }

  // --- Tier 1: reversible -----------------------------------------------

  private updateConversationStatusDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      status: z.enum(['active', 'closed', 'pending']).describe('New conversation status.'),
    });

    return {
      name: 'updateConversationStatus',
      title: 'Change a conversation status',
      description: 'Set a Help Scout conversation to active, closed, or pending. Reversible by setting the previous status again.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PATCH',
        path: conversationPath(input.conversationId as string),
        body: { op: 'replace', path: '/status', value: input.status },
      }),
      perform: async (input) => {
        const response = await helpScoutClient.patch(
          conversationPath(input.conversationId as string),
          { op: 'replace', path: '/status', value: input.status },
        );
        return {
          result: {
            ...noContentResult(response, `the status is now ${input.status}`),
            status: input.status,
          },
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call updateConversationStatus again with the previous status to restore it.',
          },
        };
      },
    };
  }

  private assignConversationDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      userId: numericIdSchema('User ID').describe('Help Scout user ID to assign the conversation to, from listUsers.'),
    });

    return {
      name: 'assignConversation',
      title: 'Assign a conversation to a user',
      description: 'Assign a Help Scout conversation to a user. Reversible with assignConversation or unassignConversation.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PATCH',
        path: conversationPath(input.conversationId as string),
        body: { op: 'replace', path: '/assignTo', value: Number(input.userId) },
      }),
      perform: async (input) => {
        const response = await helpScoutClient.patch(
          conversationPath(input.conversationId as string),
          { op: 'replace', path: '/assignTo', value: Number(input.userId) },
        );
        return {
          result: {
            ...noContentResult(response, `the conversation is assigned to user ${input.userId}`),
            assignedTo: Number(input.userId),
          },
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call assignConversation with the previous assignee, or unassignConversation, to restore the earlier state.',
          },
        };
      },
    };
  }

  private unassignConversationDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({ conversationId: conversationIdSchema });

    // JSON Patch `remove` carries no value, so none is sent even though the
    // Help Scout table lists a value type for this row.
    const body = { op: 'remove', path: '/assignTo' };

    return {
      name: 'unassignConversation',
      title: 'Remove the assignee from a conversation',
      description: 'Clear the assignee on a Help Scout conversation, returning it to the unassigned queue. Reversible with assignConversation.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PATCH',
        path: conversationPath(input.conversationId as string),
        body,
      }),
      perform: async (input) => {
        const response = await helpScoutClient.patch(
          conversationPath(input.conversationId as string),
          body,
        );
        return {
          result: noContentResult(response, 'the conversation has no assignee'),
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call assignConversation with the previous assignee to restore it.',
          },
        };
      },
    };
  }

  private addConversationTagsDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      tags: z.array(z.string().min(1)).min(1).max(50).describe('Tags to add. Tags that do not exist yet are created by Help Scout.'),
    });

    return {
      name: 'addConversationTags',
      title: 'Add tags to a conversation',
      description: 'Add tags to a Help Scout conversation, keeping the tags already on it. Help Scout replaces the whole tag list on every update, so this operation reads the current tags first and sends the merged list; a tag added by someone else between that read and the write is lost. Reversible with removeConversationTags.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PUT',
        path: `${conversationPath(input.conversationId as string)}/tags`,
        body: { tags: input.tags },
        precededBy: { method: 'GET', path: conversationPath(input.conversationId as string) },
        bodyNote: 'The tags sent are the conversation current tags merged with these; the list shown here is only the requested addition.',
      }),
      perform: async (input) => {
        const conversationId = input.conversationId as string;
        const requested = input.tags as string[];
        const existing = currentTags(await readConversation(conversationId));
        const existingLower = new Set(existing.map((tag) => tag.toLowerCase()));
        const added = requested.filter((tag) => !existingLower.has(tag.toLowerCase()));
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
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call removeConversationTags with the added tags to restore the previous list.',
          },
        };
      },
    };
  }

  private removeConversationTagsDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      tags: z.array(z.string().min(1)).min(1).max(50).describe('Tags to remove. Matching ignores case.'),
    });

    return {
      name: 'removeConversationTags',
      title: 'Remove tags from a conversation',
      description: 'Remove tags from a Help Scout conversation, keeping the rest. Help Scout replaces the whole tag list on every update, so this operation reads the current tags first and sends the remaining list; a tag added by someone else between that read and the write is lost. Reversible with addConversationTags.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PUT',
        path: `${conversationPath(input.conversationId as string)}/tags`,
        body: { tags: [] },
        precededBy: { method: 'GET', path: conversationPath(input.conversationId as string) },
        bodyNote: 'The tags sent are the conversation current tags minus the requested removals, which cannot be known before that read.',
      }),
      perform: async (input) => {
        const conversationId = input.conversationId as string;
        const requested = input.tags as string[];
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
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call addConversationTags with the removed tags to restore the previous list.',
          },
        };
      },
    };
  }

  private updateConversationFieldsDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      fields: z
        .array(
          z.object({
            id: numericIdSchema('Custom field ID').describe('Custom field ID from getInbox.'),
            value: z.string().describe('Field value. Dates use YYYY-MM-DD and dropdowns use the option ID.'),
          }),
        )
        .min(1)
        .max(50)
        .describe('Custom fields to set. Fields not listed keep their current values.'),
    });

    return {
      name: 'updateConversationFields',
      title: 'Set custom field values on a conversation',
      description: 'Set custom field values on a Help Scout conversation. Help Scout replaces the whole custom field list on every update, so this operation reads the current values first and sends them merged with the new ones; a value changed by someone else between that read and the write is lost. Reversible by sending the previous values.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PUT',
        path: `${conversationPath(input.conversationId as string)}/fields`,
        body: {
          fields: (input.fields as Array<{ id: string; value: string }>).map((field) => ({
            id: Number(field.id),
            value: field.value,
          })),
        },
        precededBy: { method: 'GET', path: conversationPath(input.conversationId as string) },
        bodyNote: 'The fields sent are the conversation current custom fields merged with these; fields already set but not listed here are preserved.',
      }),
      perform: async (input) => {
        const conversationId = input.conversationId as string;
        const requested = (input.fields as Array<{ id: string; value: string }>).map((field) => ({
          id: Number(field.id),
          value: field.value,
        }));
        const existing = currentFields(await readConversation(conversationId));

        const merged = new Map(existing.map((field) => [field.id, field]));
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
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call updateConversationFields with the values listed in previousFields to restore them.',
          },
        };
      },
    };
  }

  private snoozeConversationDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      snoozedUntil: z
        .string()
        .refine(isFutureIsoDate, 'snoozedUntil must be an ISO 8601 date in the future and before the year 2100')
        .describe('ISO 8601 date in the future, for example 2026-08-01T12:00:00Z.'),
      unsnoozeOnCustomerReply: z
        .boolean()
        .default(true)
        .describe('Whether a new customer reply wakes the conversation early.'),
    });

    return {
      name: 'snoozeConversation',
      title: 'Snooze a conversation until a future time',
      description: 'Snooze a Help Scout conversation until a future time. Each call replaces any previous snooze. Reversible with unsnoozeConversation.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PUT',
        path: `${conversationPath(input.conversationId as string)}/snooze`,
        body: {
          snoozedUntil: input.snoozedUntil,
          unsnoozeOnCustomerReply: input.unsnoozeOnCustomerReply,
        },
      }),
      perform: async (input) => {
        const response = await helpScoutClient.put(
          `${conversationPath(input.conversationId as string)}/snooze`,
          {
            snoozedUntil: input.snoozedUntil,
            unsnoozeOnCustomerReply: input.unsnoozeOnCustomerReply,
          },
        );
        return {
          result: {
            ...noContentResult(response, `the conversation is snoozed until ${input.snoozedUntil}`),
            snoozedUntil: input.snoozedUntil,
            unsnoozeOnCustomerReply: input.unsnoozeOnCustomerReply,
          },
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call unsnoozeConversation to wake the conversation immediately.',
          },
        };
      },
    };
  }

  private unsnoozeConversationDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({ conversationId: conversationIdSchema });

    return {
      name: 'unsnoozeConversation',
      title: 'Wake a snoozed conversation',
      description: 'Remove the snooze from a Help Scout conversation, returning it to its home folder and reactivating it if needed. Reversible with snoozeConversation.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'DELETE',
        path: `${conversationPath(input.conversationId as string)}/snooze`,
      }),
      perform: async (input) => {
        const response = await helpScoutClient.delete(
          `${conversationPath(input.conversationId as string)}/snooze`,
        );
        return {
          result: noContentResult(response, 'the conversation is no longer snoozed'),
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call snoozeConversation with the previous snooze time to restore it.',
          },
        };
      },
    };
  }

  private moveConversationDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      mailboxId: numericIdSchema('Inbox ID').describe('Destination inbox ID from listAllInboxes.'),
    });

    // Help Scout uses `move` with a value here, which RFC 6902 does not define:
    // its `move` takes a `from` pointer, not a value. The body is built by hand
    // for that reason; a JSON Patch library would reject or rewrite it.
    const buildBody = (mailboxId: string) => ({
      op: 'move',
      path: '/mailboxId',
      value: Number(mailboxId),
    });

    return {
      name: 'moveConversation',
      title: 'Move a conversation to another inbox',
      description: 'Move a Help Scout conversation to a different inbox. Reversible by moving it back to the original inbox.',
      schema,
      mutationClass: 'reversible',
      plan: (input) => ({
        method: 'PATCH',
        path: conversationPath(input.conversationId as string),
        body: buildBody(input.mailboxId as string),
      }),
      perform: async (input) => {
        const response = await helpScoutClient.patch(
          conversationPath(input.conversationId as string),
          buildBody(input.mailboxId as string),
        );
        return {
          result: {
            ...noContentResult(response, `the conversation is in inbox ${input.mailboxId}`),
            mailboxId: Number(input.mailboxId),
          },
          cleanup: {
            required: false,
            performed: false,
            instructions: 'Call moveConversation with the original inbox ID to move it back.',
          },
        };
      },
    };
  }

  // --- Tier 2: externallyVisible ----------------------------------------

  private sendReplyDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({
      conversationId: conversationIdSchema,
      text: z.string().min(1).describe('Reply body. This text is emailed to the customer.'),
      customerId: numericIdSchema('Customer ID').optional().describe('Customer receiving the reply. Help Scout uses the primary customer when omitted.'),
      customerEmail: z.string().min(1).optional().describe('Customer email, as an alternative to customerId.'),
      assignTo: numericIdSchema('User ID').optional().describe('Help Scout user ID to assign the conversation to as part of the reply.'),
      status: z.enum(['active', 'closed', 'pending']).optional().describe('Conversation status to set as part of the reply.'),
      cc: emailListSchema.optional().describe('Email addresses to CC.'),
      bcc: emailListSchema.optional().describe('Email addresses to BCC.'),
    });

    return {
      name: 'sendReply',
      title: 'Send a reply to the customer',
      description: 'Send a reply to the customer on a Help Scout conversation. This emails the customer immediately and cannot be recalled. Requires HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES and per-call confirmation. Use createDraftReply to compose without sending.',
      schema,
      mutationClass: 'externallyVisible',
      plan: (input) => ({
        method: 'POST',
        path: `${conversationPath(input.conversationId as string)}/reply`,
        body: buildReplyBody(input, false),
      }),
      perform: async (input) => {
        const response = await helpScoutClient.post(
          `${conversationPath(input.conversationId as string)}/reply`,
          buildReplyBody(input, false),
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
          cleanup: {
            required: false,
            performed: false,
            instructions: 'A sent reply cannot be recalled or deleted through the Mailbox API.',
          },
        };
      },
    };
  }

  private publishDraftDefinition(): WriteDefinition<z.ZodObject> {
    const schema = z.object({ conversationId: conversationIdSchema });

    // Update Conversation lists exactly one draft operation:
    //   Publish draft | path /draft | op replace | value Boolean
    // Publishing means clearing the draft flag, so the value sent is false.
    // https://developer.helpscout.com/mailbox-api/endpoints/conversations/update/
    const body = { op: 'replace', path: '/draft', value: false };

    return {
      name: 'publishDraft',
      title: 'Publish a draft conversation',
      description: 'Publish a Help Scout draft by clearing its draft flag, which sends the pending reply to the customer. This cannot be undone. Requires HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES and per-call confirmation.',
      schema,
      mutationClass: 'externallyVisible',
      plan: (input) => ({
        method: 'PATCH',
        path: conversationPath(input.conversationId as string),
        body,
      }),
      perform: async (input) => {
        const response = await helpScoutClient.patch(
          conversationPath(input.conversationId as string),
          body,
        );
        return {
          result: {
            ...noContentResult(response, 'the conversation is no longer a draft'),
            draft: false,
          },
          cleanup: {
            required: false,
            performed: false,
            instructions: 'A published draft cannot be returned to draft state, and the reply it sent cannot be recalled.',
          },
        };
      },
    };
  }
}

/**
 * Shared body builder for the two reply operations.
 *
 * `draft` is set by the caller of this function, never by an operation
 * argument: the draft-first rule forbids a tier-1 operation from exposing a
 * parameter that would make it externally visible.
 */
function buildReplyBody(input: Record<string, unknown>, draft: boolean): Record<string, unknown> {
  const customer = input.customerId
    ? { id: Number(input.customerId) }
    : input.customerEmail
      ? { email: input.customerEmail }
      : undefined;

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

function isFutureIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) {
    return false;
  }
  return new Date(parsed).getUTCFullYear() < MAX_SNOOZE_YEAR;
}

export const writeHandler = new WriteHandler();
