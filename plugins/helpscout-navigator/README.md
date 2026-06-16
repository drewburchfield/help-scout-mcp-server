<div align="center">

<img src="https://ghrb.waren.build/banner?header=helpscout-navigator%20![helpscout]&subheader=HelpScout%20ticket%20search%20with%20bundled%20MCP%20server&bg=0a1628&secondaryBg=1e3a5f&color=e8f0fe&subheaderColor=7eb8da&headerFont=Inter&subheaderFont=Inter&support=false" alt="helpscout-navigator" width="100%">

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin from the [not-my-job](https://github.com/drewburchfield/not-my-job) marketplace.

![License](https://img.shields.io/badge/license-MIT-blue)

</div>

## What it does

Guides you to the right Help Scout MCP tool for each support investigation task. Includes a decision tree for tool selection, correct sequencing when inbox names need IDs, prevention of the active-only search trap, and references for the 102-tool read-only API parity surface. The MCP server auto-starts when the plugin is enabled.

## Features

- Decision tree for choosing the right search tool
- Correct sequencing when inbox names need IDs
- Prevents the "active-only" search trap
- Parameter references for the read-only Help Scout tool surface
- Bundled MCP server pinned to `help-scout-mcp-server@1.9.0`

## Requirements

- `HELPSCOUT_APP_ID` environment variable
- `HELPSCOUT_APP_SECRET` environment variable
- Optional: `HELPSCOUT_DOCS_API_KEY` for Help Scout Docs tools

## Install

```
claude plugins install helpscout-navigator@not-my-job
```

## License

MIT
