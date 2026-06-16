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

## Tool Metadata

Each MCP tool should have:

- A stable machine name using the existing camelCase naming style.
- A human-readable `title` for MCP hosts that render display names.
- A direct, user-intent description, not an internal endpoint description.
- A valid `inputSchema`. Tools with no arguments should explicitly accept an
  empty object.
- `annotations.readOnlyHint: true` for read-only Help Scout tools where the SDK
  supports it.
- `outputSchema` once the returned structure is intentionally stable.

Icons are optional display metadata. Add them only when supported by the server
SDK and packaged clients can consume them consistently.

## Result Shape

All read tools should converge on a predictable result envelope:

```json
{
  "data": {},
  "meta": {
    "source": "helpscout",
    "fetchedAt": "2026-06-13T00:00:00.000Z"
  }
}
```

List and search tools should use a collection envelope:

```json
{
  "items": [],
  "page": {
    "cursor": null,
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

The envelope should not hide useful Help Scout fields. Preserve raw identifiers,
links, timestamps, and relevant embedded objects unless redaction is enabled.

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

## Tool Naming

Use names that match support workflows:

- `listX` for browseable metadata and collections.
- `getX` for direct ID or slug lookups.
- `searchX` for user-entered query or filter workflows.
- `summarizeX` only when the server creates a derived support summary.
- Write-capable tools must use explicit verbs that name the mutation:
  `createX`, `updateX`, `deleteX`, `setX`, `removeX`, `uploadX`, `runX`, or
  another Help Scout-aligned verb when those are more precise.

Avoid exposing raw Help Scout endpoint names when a workflow name is clearer.
Avoid adding write verbs until the write-tool contract below is satisfied.

## Write Tool Contract

Write tools are direct Help Scout API parity tools. They are not operator
workflow products, MCP Apps views, or hidden multi-step automations. Each write
tool should map to one Help Scout mutation endpoint or one tightly scoped API
operation family.

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

### Confirmation Metadata

For destructive or externally visible operations, the input schema must include
confirmation fields that are hard to satisfy accidentally:

```json
{
  "confirm": true,
  "confirmOperation": "deleteCustomer",
  "targetId": "12345"
}
```

The exact confirmation string should name the operation and target. The tool
must reject calls with missing, false, or mismatched confirmation before making a
Help Scout request. Confirmation requirements belong in the tool description and
validation tests.

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

## Boundaries

Tools are model-controlled and should stay focused on Help Scout data access.
Use the other MCP feature surfaces deliberately:

- Resources: stable, fetchable context objects such as documentation pages or
  cached large attachments.
- Prompts: repeatable support workflows that combine multiple tools.
- MCP Apps: interactive views layered on top of existing tool data.
- Sampling and elicitation: out of scope until there is a concrete workflow that
  requires host-mediated model calls or user input.

## Rollout Order

1. Add `title`, read-only annotations, and explicit empty input schemas across
   existing tools.
2. Add `structuredContent` while keeping serialized JSON text.
3. Add `outputSchema` for the highest-value stable tools first:
   `getServerTime`, inbox metadata tools, property metadata tools, tag/user/team
   metadata tools, customer and organization lookups.
4. Add broader output schemas for conversation search and thread tools after the
   response envelope is stable.
5. Extend the dogfood harness to validate tool metadata, structured content, and
   schema conformance.
