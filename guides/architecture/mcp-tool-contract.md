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

Avoid exposing raw Help Scout endpoint names when a workflow name is clearer.
Avoid adding write verbs until write/automation tools have a separate permission
and consent model.

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
