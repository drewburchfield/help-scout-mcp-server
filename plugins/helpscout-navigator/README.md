<div align="center">

<img src="https://ghrb.waren.build/banner?header=helpscout-navigator%20![helpscout]&subheader=HelpScout%20ticket%20search%20with%20bundled%20MCP%20server&bg=0a1628&secondaryBg=1e3a5f&color=e8f0fe&subheaderColor=7eb8da&headerFont=Inter&subheaderFont=Inter&support=false" alt="helpscout-navigator" width="100%">

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin from the [not-my-job](https://github.com/drewburchfield/not-my-job) marketplace.

![License](https://img.shields.io/badge/license-MIT-blue)

</div>

## What it does

Guides you to the right HelpScout MCP tool for each search task. Includes a decision tree for tool selection, correct sequencing (always lookup inbox IDs first), prevention of the "active-only" search trap, and a complete parameter reference for all 9 tools. The MCP server auto-starts when the plugin is enabled.

## Features

- Decision tree for choosing the right search tool
- Correct sequencing (always lookup inbox IDs first)
- Prevents the "active-only" search trap
- Complete parameter reference for all 9 tools
- Bundled MCP server with auto-start

## Requirements

- `HELPSCOUT_APP_ID` environment variable
- `HELPSCOUT_APP_SECRET` environment variable

## Install

```
claude plugins install helpscout-navigator@not-my-job
```

## License

MIT
