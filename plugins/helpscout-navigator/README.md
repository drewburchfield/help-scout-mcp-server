<div align="center">

<img src="https://ghrb.waren.build/banner?header=helpscout-navigator%20![helpscout]&subheader=HelpScout%20ticket%20search%20with%20bundled%20MCP%20server&bg=0a1628&secondaryBg=1e3a5f&color=e8f0fe&subheaderColor=7eb8da&headerFont=Inter&subheaderFont=Inter&support=false" alt="helpscout-navigator" width="100%">

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin, installable from the [help-scout-mcp-server](https://github.com/drewburchfield/help-scout-mcp-server) marketplace. Using the Claude desktop app (Chat or Cowork)? Install the [Desktop Extension](https://github.com/drewburchfield/help-scout-mcp-server/releases) instead.

![License](https://img.shields.io/badge/license-MIT-blue)

</div>

## What it does

Guides you to the right Help Scout MCP tool for each support investigation task. Includes a decision tree for tool selection, correct sequencing when inbox names need IDs, prevention of the active-only search trap, and references for the 55 read operations behind the three-tool gateway. The MCP server auto-starts when the plugin is enabled, read-only unless you enable writes.

## Features

- Decision tree for choosing the right search tool
- Correct sequencing when inbox names need IDs
- Prevents the "active-only" search trap
- Parameter references for the Help Scout read and write tool surface
- Draft-first guidance for the opt-in write surface, off unless `HELPSCOUT_ENABLE_WRITES=true`
- Bundled MCP server pinned to `help-scout-mcp-server@2.1.0`

## Requirements

- `HELPSCOUT_APP_ID` environment variable
- `HELPSCOUT_APP_SECRET` environment variable
- Optional: `HELPSCOUT_DOCS_API_KEY` for Help Scout Docs tools
- Optional: `HELPSCOUT_ENABLE_WRITES=true` to add the conversation write surface, and `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true` to allow replies that email the customer

## Install

```
claude plugins install helpscout-navigator@not-my-job
```

## License

MIT
