<div align="center">

<img src="https://ghrb.waren.build/banner?header=helpscout-navigator%20![helpscout]&subheader=Navigation%20skill%20for%20the%20Help%20Scout%20MCP%20server&bg=0a1628&secondaryBg=1e3a5f&color=e8f0fe&subheaderColor=7eb8da&headerFont=Inter&subheaderFont=Inter&support=false" alt="helpscout-navigator" width="100%">

An [Agent Skill](https://code.claude.com/docs/en/skills) for the [Help Scout MCP server](https://github.com/drewburchfield/help-scout-mcp-server). Works in any harness that supports skills and connects to the server.

![License](https://img.shields.io/badge/license-MIT-blue)

</div>

## What it does

Guides the model to the right Help Scout MCP operation for each support investigation task: a decision tree for tool selection, correct sequencing when inbox names need IDs, prevention of the active-only search trap, and references for the read and write surface behind the gateway tools.

This is a skill only. It does not start the MCP server; connect the server in your client first.

## Install

**Claude Code** (via the plugin marketplace):

```
/plugin marketplace add drewburchfield/help-scout-mcp-server
/plugin install helpscout-navigator
```

**claude.ai and Claude Desktop** (including Cowork sessions): go to **Customize**, click **+** > **Add marketplace from GitHub**, enter `drewburchfield/help-scout-mcp-server`, and install **helpscout-navigator**.

**Any other harness**: copy `skills/helpscout-navigator/` from the repo into wherever your client loads skills from.

## Requirements

- The [Help Scout MCP server](https://github.com/drewburchfield/help-scout-mcp-server) connected in your client (Desktop Extension, `npx`, Docker, or any MCP config)
- `HELPSCOUT_APP_ID` and `HELPSCOUT_APP_SECRET` on that server
- Optional: `HELPSCOUT_DOCS_API_KEY` for Help Scout Docs operations
- Optional: `HELPSCOUT_ENABLE_WRITES=true` for the conversation write surface, and `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES=true` to allow replies that email the customer

## License

MIT
