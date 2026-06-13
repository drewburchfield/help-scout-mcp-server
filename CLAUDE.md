# Help Scout MCP Server Working Notes

## Operating Model

- Collect feature work into `main` through pull requests, then plan releases from the accumulated state on `main`.
- Keep branches, commits, PR titles, PR bodies, and review comments human-authored in tone and attribution. Do not include assistant, agent, or tool attributions.
- Avoid branch names that imply assistant ownership, including `codex/...` or `claude/...`.
- Prefer Linear-derived branch names when there is a ticket: `feature/nas-123-short-title`, `fix/nas-123-short-title`, or `chore/nas-123-short-title`.
- Without a ticket, use a short human branch name such as `chore/repo-operating-instructions`.
- Treat PRs not authored by `drewburchfield` as potential inspiration only. Do not copy their branch names, wording, or implementation without review.

## Required Flow

- Open focused PRs into `main`; do not batch unrelated features.
- Before opening a PR, run the full local quality gate and dogfood checks that match the change.
- After a PR merges, update local `main`, rerun the quality gate, and repeat dogfood checks before considering the work release-ready.
- If a change is user-visible, update release notes or changelog material where present.
- Keep PR descriptions concise: summary, testing, and any known follow-up. Do not include hidden comments or tool-specific metadata.

## Commands

Install dependencies:

```bash
npm ci
```

Core quality gate:

```bash
npm run type-check
npm run lint
npm run build
npm run mcpb:build
npm test
```

Important: `npm test` includes `src/__tests__/mcpb-validation.test.ts`, which expects `helpscout-mcp-extension/build` to exist. Run `npm run mcpb:build` before `npm test` in a fresh checkout.

## Dogfood And Live Testing

- The connected Help Scout account is approved for complete dogfood testing.
- Use real Help Scout credentials only from local environment or approved secret stores. Never commit `.env`, tokens, exported API responses with sensitive customer data, or generated state files.
- Verify credentials before live testing:

```bash
npx tsx scripts/verify-credentials.ts
```

- Run live API dogfood when the tool surface, auth, search behavior, packaging, or MCP runtime changes:

```bash
npx tsx scripts/live-api-test.ts
```

- For conversation-data changes, also run targeted checks such as:

```bash
npx tsx scripts/check-conversations.ts
```

- Document any live dogfood limits in the PR body, including missing test data, rate limits, or Help Scout API behavior that could not be exercised.

## Secrets

- GitHub Actions secrets cannot be read back after they are set; only names and update timestamps are visible.
- As of 2026-06-13, repository Actions secrets visible via `gh secret list --app actions` are `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`; Help Scout credentials are not present as repository Actions secrets.
- If CI or automated dogfood needs Help Scout credentials, add dedicated repository or environment secrets with names like `HELPSCOUT_CLIENT_ID` and `HELPSCOUT_CLIENT_SECRET`, then reference them from workflows without printing values.

## Repository Notes

- Main server source lives in `src/`; tool dispatch is in `src/tools/index.ts`.
- MCPB packaging is built by `scripts/build-mcpb.js` into `helpscout-mcp-extension/build`.
- CI currently runs type-check, lint, and build on PRs to `main`; local expectations are stricter and include MCPB build plus Jest.
