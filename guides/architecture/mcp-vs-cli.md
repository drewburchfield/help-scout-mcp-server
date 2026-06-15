# MCP vs CLI Boundary

The MCP server and local CLI scripts serve different audiences. Keeping that
boundary clear prevents duplicate product surfaces and makes tests easier to
trust.

## MCP Surface

MCP tools are for AI hosts and support workflows. They should be typed,
discoverable, read-only by default, and safe for model-controlled invocation.

Use MCP tools for:

- Searching conversations, customers, organizations, inboxes, and metadata.
- Fetching full support context for a known Help Scout object.
- Returning structured result data that hosts can validate and compose.
- Exposing support workflows through prompts.
- Supplying interactive MCP Apps views from existing tool data.

MCP tools should not:

- Depend on local repo files.
- Run package, build, Docker, or deployment commands.
- Mutate Help Scout data without a separate write-tool permission model.
- Expose secrets, credential diagnostics, or CI implementation details.
- Replace operator scripts that are meant for repository maintenance.

## CLI And Script Surface

CLI commands and package scripts are for operators maintaining this package.
They can assume a local checkout and are allowed to inspect build artifacts,
environment configuration, and packaging state.

Use CLI scripts for:

- Build, lint, type-check, unit tests, and package validation.
- Full dogfood runs against the configured Help Scout test account.
- MCP client contract tests that spawn the built stdio server.
- Docker smoke tests and local package assembly.
- Seeding or verifying test data.
- Environment diagnostics that confirm required variables are present without
  printing secret values.
- Release packaging steps, when release work is explicitly requested.

CLI scripts should not become the product API. If a workflow is useful to an AI
host during support work, expose it as an MCP tool and make the CLI test it
through MCP.

## Shared Quality Gates

Every feature PR should prove both surfaces at the right level:

- Unit tests for local business logic and API transformations.
- MCP dogfood for real host behavior over stdio.
- Edge-case tests for authenticated Help Scout API behavior.
- MCPB build and validation when tool metadata or packaging changes.
- Docker smoke tests when packaging, entrypoint, or runtime assumptions change.

Before merge, CI should run the authenticated dogfood lane with repository
secrets. After merge, the main branch CI run should be checked before starting a
dependent PR.

## Testing Account Policy

The connected Help Scout account is the complete test lane for dogfood. Test
fixtures must be deterministic enough for broad tool coverage, but the server
must tolerate normal Help Scout account variation:

- Optional fields may be absent.
- Empty collections are valid for some accounts.
- Pagination may return fewer objects than requested.
- Deleted or inaccessible IDs should return model-correctable tool errors.

Every API-surface PR is responsible for loading or extending fixture data that
exercises the core path and meaningful permutations for that surface before the
PR is reviewed. Missing account data should drive fixture work, not weaker
dogfood assertions.

Use `npm run dogfood:seed` to load the shared customer, organization,
conversation, and organization-member fixtures before authenticated dogfood
runs. New API families should add their own idempotent seed data and wire it
into that script when existing fixtures cannot produce non-empty coverage.
Track per-tool fixture expectations and known gaps in
[`guides/testing/dogfood-fixture-matrix.md`](../testing/dogfood-fixture-matrix.md).

Test scripts may require known fixture IDs through environment variables after
seeding. MCP tools should not assume those fixture IDs in production behavior.

## No Docker Publishing In Feature PRs

Feature PR quality gates may build and smoke-test Docker images locally or in
CI. They should not push Docker images or create release tags. Docker publishing
belongs to explicit release work.
