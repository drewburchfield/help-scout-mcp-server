# MCP Tool Contract

This server targets the latest stable Model Context Protocol specification:
`2025-11-25`.

The official MCP documentation labels `2025-11-25` as the latest stable
specification. Draft documentation may describe proposed newer protocol shapes,
including the `2026-07-28` draft stream, but those draft behaviors are not a
required compatibility target until they are published as stable.

Source references:

- https://modelcontextprotocol.io/specification/2025-11-25
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

## Compatibility Baseline

- The stdio server remains the primary transport.
- Help Scout credentials are read from environment variables for stdio clients.
- HTTP transport and OAuth authorization are separate future work.
- Existing clients that parse `content[].text` must keep working.
- Tool results that expose structured JSON should return both:
  - `structuredContent` with the JSON object
  - a serialized JSON `TextContent` block for backward compatibility
- `outputSchema` should be added only when the result shape is stable enough to
  validate without breaking normal Help Scout API variation.
- Tool input and output schemas default to JSON Schema 2020-12 unless an
  explicit `$schema` is required.

## Advertised Tools And Registry Operations

The server presents two layers, and the rules below distinguish them.

- **Advertised gateway tools** are the tools returned by `tools/list`, defined in
  `src/tools/gateway.ts`. `search_help_scout`, `describe_help_scout`, and
  `read_help_scout` are always advertised. `write_help_scout` is advertised only
  when write support is enabled, per
  [Gating And Permission Model](#gating-and-permission-model).
- **Registry operations** are the Help Scout operations defined in
  `src/tools/index.ts`: 55 read operations, plus the write operations added in
  2.1, which stay gated behind environment flags. Read operations are discovered
  through `search_help_scout`, schema-loaded through `describe_help_scout`, and
  executed through `read_help_scout`. Enabled write operations are discovered
  and schema-loaded the same way, and executed through `write_help_scout`.

"Tool" in the sections below means an advertised gateway tool. "Operation" means
a registry entry. Both share the result, error, and envelope rules.

## Tool Metadata

Each advertised gateway tool and each registry operation should have:

- A stable machine name. Advertised gateway tools use snake_case
  (`search_help_scout`, `describe_help_scout`, `read_help_scout`,
  `write_help_scout`). Registry operations use the existing camelCase style
  (`getConversation`, `listUsers`, `createNote`).
- A human-readable `title` for MCP hosts that render display names.
- A direct, user-intent description, not an internal endpoint description. For
  registry operations the description is also the ranking text for
  `search_help_scout`, so it should carry the words a user would actually type.
- A valid `inputSchema`. Entries with no arguments should explicitly accept an
  empty object.
- Annotations that state the worst case, per [Annotations](#annotations).
- `outputSchema` once the returned structure is intentionally stable.

Icons are optional display metadata. Add them only when supported by the server
SDK and packaged clients can consume them consistently.

### Annotations

Annotations describe the worst case for the tool a host is about to approve, not
the best case for a particular call.

- `search_help_scout`, `describe_help_scout`, and `read_help_scout` carry
  `annotations.readOnlyHint: true`, and so does every read registry operation.
  That is the full extent of the read-only claim. It is not a property of the
  advertised surface as a whole.
- `write_help_scout` carries `readOnlyHint: false` and `destructiveHint: true`.
  Per-tool hints are worst-case by necessity: one advertised tool covers a range
  of mutation classes, and hosts gate approval on the tool rather than on the
  operation chosen inside it. Annotating the safest case would understate what
  an approval permits. `destructiveHint` stays true even though the
  `destructive` mutation class is not exposed in 2.1, because a sent customer
  reply cannot be recalled.
- Write operations never carry `readOnlyHint: true`, whatever their mutation
  class.
- Per-operation risk travels in the operation's mutation class and its
  confirmation requirements, not in the advertised tool's annotations. A host
  that wants finer granularity than `destructiveHint` reads the mutation class
  through `describe_help_scout`.

## Result Shape

All read operations should converge on a predictable result envelope:

```json
{
  "data": {},
  "meta": {
    "source": "helpscout",
    "fetchedAt": "2026-06-13T00:00:00.000Z"
  }
}
```

List and search operations should use a collection envelope:

```json
{
  "items": [],
  "page": {
    "page": 1,
    "size": 50,
    "hasMore": false
  },
  "filters": {},
  "meta": {
    "source": "helpscout",
    "fetchedAt": "2026-06-13T00:00:00.000Z"
  }
}
```

Pagination is page-number based. The v3 Customers path is the exception:
`listCustomers` with `useV3` or a `cursor`, and `searchCustomersByEmail`, return
a `nextCursor` because cursor pagination is upstream Help Scout behavior on those
endpoints, not a server choice.

The envelope should not hide useful Help Scout fields. Preserve raw identifiers,
links, timestamps, and relevant embedded objects unless redaction is enabled.
`REDACT_MESSAGE_CONTENT=true` hides message bodies to save host context. It is a
context-saver, not a PII or compliance guarantee.

## Error Policy

Use MCP tool results for errors the model can act on:

- Validation errors
- Missing required arguments
- Unknown Help Scout IDs
- Help Scout API errors that return a useful status or message
- Partial failures where some requested subresources failed

Use protocol-level errors for server or transport failures:

- Invalid MCP messages
- Startup failure
- Broken transport
- Unexpected process errors before the tool handler can respond

Tool errors should be structured and readable, with `isError` set when the MCP
SDK supports it. Error payloads should include the failing Help Scout status,
operation, and model-correctable guidance when available.

## Naming

### Advertised Gateway Tools

The advertised tools use snake_case verb-first names that read as capabilities
rather than Help Scout resources: `search_help_scout`, `describe_help_scout`,
`read_help_scout`, and `write_help_scout`. This set is intentionally closed. Do
not add a fifth advertised tool to expose a Help Scout resource; add a registry
operation instead.

A new advertised tool is justified only by a new interaction mode.
`write_help_scout` is the one addition that clears that bar, and it is the write
path the 2.0 contract named as the first candidate. Mutation is a different
interaction mode from discovery, schema loading, and reading: it needs different
annotations, an operator-controlled gate, per-call confirmation, and a separate
host approval decision. Nothing about a Help Scout resource justifies another
tool.

`write_help_scout` is advertised only when writes are enabled. With the flags
off, `tools/list` returns three tools and the advertised set is the 2.0 set.

An operation name may never collide with a gateway tool name. The registry is
built on the first gateway call and rejects the collision there, because a
colliding operation would be unreachable. `write_help_scout` is reserved even
while writes are disabled: an operation may not take a name that would become
unreachable the moment an operator flips the flag.

### Registry Operations

Registry operations keep the camelCase style and names that match support
workflows:

- `listX` for browseable metadata and collections.
- `getX` for direct ID or slug lookups.
- `searchX` for user-entered query or filter workflows.
- `summarizeX` only when the server creates a derived support summary.
- Write-capable operations must use explicit verbs that name the mutation:
  `createX`, `updateX`, `deleteX`, `setX`, `removeX`, `uploadX`, `runX`, or
  another Help Scout-aligned verb when those are more precise.

Avoid exposing raw Help Scout endpoint names when a workflow name is clearer.
Prefer a parameter on an existing operation over a near-duplicate operation:
API-version variants belong behind a flag, sub-resources behind an `include`
list, and report families behind a `report` or `channel` selector.

A write verb is allowed only for an operation that satisfies the write tool
contract below: a declared mutation class, a tier, confirmation metadata where
the class requires it, and dispatch through `write_help_scout` alone.

## Name Compatibility Rule

This is the canonical statement of what names a client may call.

1. The advertised gateway tool names always dispatch, except that
   `write_help_scout` is absent, and therefore unknown, while writes are
   disabled.
2. Any read operation name currently in the registry also dispatches directly,
   as a compatibility path for clients that learned the pre-2.0 names. Direct
   calls bypass discovery and behave identically to the same operation invoked
   through `read_help_scout`.
3. Names removed in the 2.0.0 consolidation do not dispatch. They return a tool
   error naming the unknown tool and pointing at `search_help_scout`.
4. Write operation names never dispatch through the legacy direct path in rule
   2. No pre-2.0 client ever learned a write name, so there is no compatibility
   debt to honor, and a bare `createNote` call would slip past the gating,
   annotations, and confirmation that the write gateway exists to enforce. A
   write operation name called as a tool returns the same unknown-tool error as
   a removed name, pointing at `search_help_scout`.
5. `read_help_scout` never executes an operation marked as mutating. With writes
   enabled it rejects the call with an error that names the operation, states
   that the operation changes Help Scout state, and redirects the caller to
   `write_help_scout`. With writes disabled it returns the same
   unknown-operation error as any other name the server does not expose, which
   matches what `describe_help_scout` reports and keeps the disabled surface
   uninventoried. Neither path falls through and executes.

Rule 2 is compatibility, not a supported second surface. New clients should
discover through `search_help_scout` and execute through `read_help_scout` or
`write_help_scout`; direct-dispatch support may be withdrawn in a later major
release.

Confirmation requirements are declared in the `write_help_scout` tool
description itself. The confirmation fields are siblings of `arguments` on the
`write_help_scout` call, and they are absent from every per-operation schema by
design: an operation schema describes the Help Scout request, and confirmation
is a property of the call that authorizes it. A client reading `tools/list`
learns which mutation classes require `confirm`, `confirmOperation`, and
`targetId`, and that missing, false, or mismatched values are rejected before
any Help Scout request, without first calling `describe_help_scout`. A host that
renders only tool descriptions still shows the user what approving this tool
permits. A confirmation field sent inside `arguments` is refused rather than
ignored, because a caller who misplaces one believes it took effect.

Removing or renaming a registry operation is a breaking change. Fold its
capability into a parent operation, record the mapping in
[`guides/roadmap/mcp-tool-surface.md`](../roadmap/mcp-tool-surface.md), and
release the change under a major version.

## Write Tool Contract

Write tools are direct Help Scout API parity tools. They are not operator
workflow products, MCP Apps views, or hidden multi-step automations. Each write
tool should map to one Help Scout mutation endpoint or one tightly scoped API
operation family.

Writes execute through the `write_help_scout` gateway tool. The rules below
apply to every write operation in the registry.

### Gating And Permission Model

The Mailbox API has no granular OAuth scopes. A token that can read a
conversation can also reply to it, and Help Scout offers no way to say "this
integration may read conversations but may not email customers." So the server
is the permission boundary. Gating is configuration an operator sets
deliberately, never a claim about what the credential itself restricts.

Two environment variables, both default off:

| Flag | Enables |
| --- | --- |
| `HELPSCOUT_ENABLE_WRITES=true` | Tier 1: the `nonDestructive` and `reversible` operations. |
| `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true` | Tier 2: adds the `externallyVisible` operations. |

Tier 2 is additive and inert on its own. `HELPSCOUT_ENABLE_WRITES` must also be
true for any write path to exist.

With both unset, the server behaves exactly as 2.0 did:

- `write_help_scout` is not returned by `tools/list`.
- Write operations do not appear in `search_help_scout` results.
- `describe_help_scout` reports a write operation name as unknown rather than as
  gated, so the disabled surface is not a discoverable inventory of what an
  operator could turn on.
- No dispatch path reaches a write handler.

Enabling tier 2 is a gate, not a bypass. Every `externallyVisible` operation
still requires per-call confirmation metadata on every call, exactly as
specified below. The flag decides whether the operation exists; the confirmation
decides whether a given call proceeds.

Execution gating is live; advertisement is not. The registry is built once per
process, so flags read after the first gateway call do not change what
`tools/list`, `search_help_scout`, and `describe_help_scout` report until the
process restarts. Every `externallyVisible` operation rechecks the flags at
dispatch, so revoking `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES` refuses the
next customer-visible write immediately, even while the stale advertisement
still lists it.

`destructive` operations are not exposed in 2.1 under any flag. No environment
variable turns them on. Exposing them is a later decision that needs its own
contract work, not a third flag added by analogy.

### Draft-First Rule

When an externally visible action has a non-visible variant, the non-visible
variant is the default operation and the visible one is a separate operation in
the customer-visible tier. The safe path is the one a caller reaches without
asking; making a customer see something takes a deliberate second step under a
second flag.

- `createDraftReply` pins `draft: true`. It exposes no parameter that flips it
  into a send. Composing reply text stays in tier 1 and never notifies anyone.
- `sendReply` and `publishDraft` are separate `externallyVisible` operations,
  reachable only under `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES`, and each
  requires confirmation metadata.

The rule generalizes. No tier-1 operation may accept a parameter that makes it
externally visible. Where one Help Scout endpoint offers both behaviors through
a request field, split it into two registry operations and put the visible one
in tier 2, rather than exposing the field and relying on the caller to leave it
alone.

### Mutation Classes

Classify each write tool in its implementation notes, tests, and dogfood plan:

- `nonDestructive`: creates disposable data or updates a reversible test
  record without external customer visibility.
- `reversible`: changes Help Scout state but can be restored by a documented
  API call in the same dogfood lifecycle.
- `externallyVisible`: can notify customers, publish Docs content, expose a
  redirect, trigger a webhook, run a workflow, or otherwise affect people
  outside the test process.
- `destructive`: deletes records, removes contact paths, disables workflows,
  removes redirects, deletes Docs content, or makes recovery impossible through
  the same tool family.

Externally visible and destructive tools require explicit confirmation metadata.

The class also decides the tier: `nonDestructive` and `reversible` are tier 1,
`externallyVisible` is tier 2, and `destructive` has no tier in 2.1.

### Confirmation Metadata

Destructive and externally visible operations require confirmation fields that
are hard to satisfy accidentally. They travel on the `write_help_scout` call, as
siblings of `arguments`:

```json
{
  "name": "sendReply",
  "arguments": { "conversationId": "12345", "text": "..." },
  "confirm": true,
  "confirmOperation": "sendReply",
  "targetId": "12345"
}
```

The exact confirmation string should name the operation and target. The tool
must reject calls with missing, false, or mismatched confirmation before making
a Help Scout request. These fields do not appear in any per-operation input
schema, by design: the schema describes the Help Scout request, and confirmation
authorizes the call that carries it. Confirmation requirements belong in the
`write_help_scout` tool description, so a client sees them without a
`describe_help_scout` call, and in validation tests.

### Dry Run And Preview

Use dry-run behavior only when it can be honest:

- If the Help Scout API supports previewing or validating without mutation, call
  the supported API path.
- If no preview API exists, a `dryRun` mode may validate inputs and report the
  request that would be sent, but it must clearly say that Help Scout state was
  not checked.
- Do not fake success by simulating Help Scout side effects locally.

### Result Envelopes

Write results should use a predictable envelope:

```json
{
  "operation": "updateConversation",
  "mutationClass": "reversible",
  "target": { "type": "conversation", "id": "12345" },
  "status": "succeeded",
  "result": {},
  "cleanup": {
    "required": false,
    "performed": false,
    "instructions": null
  }
}
```

Validation failures should return model-correctable tool errors without sending
an upstream request. Partial failures should name which sub-operation succeeded,
which failed, and what cleanup remains. Never hide a cleanup failure.

### Live Dogfood Lifecycle

Every write-tool PR must prove live behavior against disposable fixtures:

1. Create or discover a test-owned target with an `MCP-TEST:` marker or another
   deterministic test marker.
2. Perform the mutation through MCP over stdio, not by calling helper code
   directly.
3. Read the target back through an existing read tool or direct API contract
   check to verify the Help Scout state.
4. Restore or delete the fixture when the operation is reversible or disposable.
5. Fail loudly if cleanup cannot be confirmed.

Fixture setup belongs in idempotent seed scripts when it is reusable. PRs must
update the dogfood fixture matrix with the records they create, reuse, skip, or
cannot safely clean up.

### Deny And Permission Behavior

Permission errors, plan-limit errors, invalid IDs, and Help Scout validation
errors are expected API outcomes. Return them as tool errors with the upstream
status/code and model-correctable guidance. Do not retry non-idempotent writes
unless the endpoint and request body are explicitly safe to repeat.

Implementation note: the retry behavior in the shared HTTP client must exempt
non-idempotent write requests. Reads keep retrying on 429 and 5xx as they do
today. Every `POST`, and any `PATCH` whose result depends on the record's
current state, must surface the 429 or 5xx to the caller instead of retrying. A
retried reply is a second customer email and a retried note is a duplicate note,
and a 5xx does not prove the first request failed. Backoff is the caller's
decision, because only the caller can read the target back and check whether the
first attempt landed.

### Gate Conditions From The Roadmap

[`guides/roadmap/mcp-tool-surface.md`](../roadmap/mcp-tool-surface.md) set four
conditions on mixing a write surface into the read gateway: explicit naming,
metadata, confirmation guidance, and coverage for denied or partial actions.
Each is met as follows.

| Condition | How it is met |
| --- | --- |
| Explicit naming | Writes execute through `write_help_scout`, a separate advertised tool, never through `read_help_scout`. Write operations use verbs that name the mutation, and they never dispatch through the legacy direct path. |
| Metadata | `write_help_scout` carries `readOnlyHint: false` and `destructiveHint: true`. Every write operation declares its mutation class and tier, readable through `describe_help_scout`. |
| Confirmation guidance | The confirmation contract is stated in the `write_help_scout` tool description, so it is visible from `tools/list` without a describe call, and enforced per call by schema validation that rejects missing, false, or mismatched values before any Help Scout request. |
| Denied and partial action coverage | Permission, plan-limit, and validation failures return structured tool errors carrying the upstream status. Partial failures name what succeeded, what failed, and what cleanup remains. The dogfood lifecycle exercises the refused and gated-off paths live, and unit tests cover the upstream denials (401, 403, 412, 422, 423, 429, 5xx, and network failure) that cannot be provoked on demand against a real account. |

## Boundaries

Tools and operations are model-controlled and should stay focused on Help Scout
data access. Use the other MCP feature surfaces deliberately:

- Resources: stable, fetchable context objects such as documentation pages or
  cached large attachments.
- Prompts: repeatable support workflows that combine multiple operations.
- Sampling and elicitation: out of scope until there is a concrete workflow that
  requires host-mediated model calls or user input.
- Interactive views: parked. If revisited, they must compose existing operation
  output rather than open a second data path.

## Output Schema Rollout

`title`, read-only annotations, explicit empty input schemas, and
`structuredContent` alongside serialized JSON text are in place across the read
registry. Remaining work is `outputSchema` per operation, sequenced by envelope
stability:

1. Utility and metadata operations first, where the shape barely varies:
   `getServerTime`, `getInbox`, `listCustomerProperties`,
   `listOrganizationProperties`, `getOrganizationProperty`, `listTags`, `getTag`,
   `listUsers`, `getUser`, `listTeams`, `getTeamMembers`.
2. Customer and organization lookups: `getCustomer`, `getCustomerContacts`,
   `getOrganization`, `listOrganizations`.
3. Conversation search and thread operations after the collection envelope is
   stable: `searchConversations`, `getConversation`, `getThreads`,
   `getConversationSummary`.
4. Report category operations, whose payloads vary by the selected `report` or
   `channel` and need per-sub-report shapes before validation is honest.
5. Docs operations, after the shared envelope work lands.

Then extend the dogfood harness to validate gateway tool metadata, operation
metadata, structured content, and schema conformance.
