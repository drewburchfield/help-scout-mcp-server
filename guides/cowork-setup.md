# Setting Up Help Scout in Claude Cowork

This guide walks you through connecting Help Scout to the Claude desktop app so it works in both Chat and Cowork sessions. Cowork uses the same Desktop Extension as Chat; there is nothing separate to install.

## Step 1: Get Your Help Scout Credentials

You'll need two values from Help Scout: an **App ID** and an **App Secret**.

1. Log in to [Help Scout](https://secure.helpscout.net)
2. Go to **My Apps** (click your profile icon in the lower left, then **My Apps**)
3. Click **Create Private App**
4. Give it a name (e.g., "Claude AI")
5. Click **Create** and copy the **App ID** and **App Secret**

**About permissions:** the app authenticates as you, with your Help Scout user's
permissions; there is no separate scope selection. Reports additionally require a
Help Scout plan that includes them. The Docs operations are separate again: they
use a Docs API key, not the App ID and Secret, so leave that out unless you need
knowledge-base access.

## Step 2: Install the Desktop Extension

1. Download the latest [`.mcpb` file from releases](https://github.com/drewburchfield/help-scout-mcp-server/releases)
2. Double-click it, or drag it into the Claude Desktop window
3. In the configuration dialog, enter your **App ID** and **App Secret** (and the Docs API key if you have one)
4. Click **Save**
5. Fully quit Claude Desktop (Cmd-Q on Mac) and relaunch it

The extension's settings are available any time under **Settings** > **Extensions** > **Help Scout MCP Server** > **Configure**.

## Step 3: Verify It Works

Start a new Cowork session and try asking Claude:

> "Show me my Help Scout inboxes"

If everything is connected, Claude will list your inboxes. You should see three tools: `search_help_scout`, `describe_help_scout`, and `read_help_scout`. That is expected. They are a gateway over 55 read-only Help Scout operations, which Claude finds and runs as needed. (If you enabled writes, a fourth tool named `write_help_scout` appears as well.)

The same install works in Chat, so you can sanity-check there too.

**Optional: add the navigator skill.** It teaches Claude which operation fits each support question. In **Customize**, click **+** > **Add marketplace from GitHub**, enter `drewburchfield/help-scout-mcp-server`, and install **helpscout-navigator**.

## Enabling Writes (Optional)

A fresh install is read-only. If you want Claude to be able to act on conversations (draft replies, internal notes, tags, status changes, assignment, snooze, moving between inboxes), open the extension's settings and turn on **Enable Write Operations**, then restart Claude Desktop. None of those operations email anyone: a reply is saved as an unsent draft for a human to review in Help Scout, and notes are visible to teammates only.

There is a second, separate toggle, **Enable Customer-Visible Writes (Sends Email)**. Turning it on additionally allows `sendReply` and `publishDraft`, both of which email the customer immediately and cannot be recalled. Leave it off unless you specifically intend Claude to be able to email customers, and note that every such call also requires explicit confirmation naming the operation and target conversation before the server will accept it.

Writes run with the same user permissions as reads; a credential whose user cannot write to a mailbox gets a structured permission error. Because the API offers no read-only credential tier, these toggles are the real boundary, so leave them off unless you mean it. Full rules live in the [write tool contract](architecture/mcp-tool-contract.md#write-tool-contract).

## Troubleshooting

**"Authentication failed" error:**
Your credentials may be incorrect. Go back to Help Scout > My Apps and verify the App ID and App Secret match exactly.

**Extension installed but no Help Scout tools in a Cowork session:**
1. Fully quit and relaunch Claude Desktop; the server only starts on launch
2. Start a fresh Cowork session; tools registered mid-session sometimes only appear in the next one
3. Update the desktop app; older builds did not forward extensions into Cowork sessions

**"Permission denied" on reports:**
Reports require a Help Scout plan that includes them, and the app acts with your user's permissions. Check your plan and role in Help Scout.
