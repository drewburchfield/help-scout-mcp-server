# Setting Up Help Scout in Claude Cowork

This guide walks you through installing the Help Scout plugin in Claude Cowork and connecting it to your Help Scout account.

## Step 1: Install the Plugin

1. Open the Claude desktop app and switch to **Cowork**
2. Click **Customize** in the left sidebar
3. Click **Browse plugins** and go to the **Personal** tab
4. Click the **+** button and choose **Add marketplace from GitHub**
5. Enter: `drewburchfield/help-scout-mcp-server` (the plugin ships from this repo, not from a separate marketplace repo)
6. Find **helpscout-navigator** in the list and click **Install**
7. When prompted about local MCP servers, click **Continue**

## Step 2: Get Your Help Scout Credentials

You'll need two values from Help Scout: an **App ID** and an **App Secret**.

1. Log in to [Help Scout](https://secure.helpscout.net)
2. Go to **My Apps** (click your profile icon in the lower left, then **My Apps**)
3. Click **Create Private App**
4. Give it a name (e.g., "Claude AI")
5. Under scopes, check **Read** access for **Mailboxes** and **Conversations**
6. Click **Create** and copy the **App ID** and **App Secret**

Keep these values handy for the next step.

**About scopes:** Mailboxes and Conversations are the minimum and cover everyday
support work. Full read coverage needs **Read** access beyond those two: reports,
users, and tags each require their own scope, and requests will fail with a
permission error until they are granted. The Docs operations are separate again:
they use a Docs API key (`HELPSCOUT_DOCS_API_KEY`), not the App ID and Secret, so
leave them out unless you need knowledge-base access.

## Step 3: Add Your Credentials

The plugin needs your App ID and App Secret to connect to Help Scout. There are two ways to do this:

### Option A: Edit the Config File (Simplest)

1. In Cowork, go to **Customize** > **Connectors**
2. Click on the **helpscout** connector
3. Click **Edit** > **Show in folder**
4. Open the `.mcp.json` file in any text editor (TextEdit, Notepad, etc.)
5. Replace the two credential placeholders with your actual values. The file contains more settings than shown here (Docs API key, redaction, write flags); leave the others alone for now.

**Before:**
```json
{
  "helpscout": {
    "command": "npx",
    "args": ["-y", "help-scout-mcp-server@2.1.0"],
    "env": {
      "HELPSCOUT_APP_ID": "${HELPSCOUT_APP_ID}",
      "HELPSCOUT_APP_SECRET": "${HELPSCOUT_APP_SECRET}",
      ...
    }
  }
}
```

**After:**
```json
{
  "helpscout": {
    "command": "npx",
    "args": ["-y", "help-scout-mcp-server@2.1.0"],
    "env": {
      "HELPSCOUT_APP_ID": "your-actual-app-id",
      "HELPSCOUT_APP_SECRET": "your-actual-app-secret",
      ...
    }
  }
}
```

6. Save the file and restart Claude

### Option B: Set Environment Variables

If you prefer not to put credentials in a file, you can set them as environment variables on your computer. This keeps them out of any config files.

**Mac:**

Open Terminal and run:
```bash
echo 'export HELPSCOUT_APP_ID="your-actual-app-id"' >> ~/.zshrc
echo 'export HELPSCOUT_APP_SECRET="your-actual-app-secret"' >> ~/.zshrc
```
Then restart Claude.

**Windows:**

1. Search for "Environment Variables" in the Start menu
2. Click **Edit the system environment variables**
3. Click **Environment Variables**
4. Under **User variables**, click **New** and add:
   - Variable: `HELPSCOUT_APP_ID`, Value: your App ID
   - Variable: `HELPSCOUT_APP_SECRET`, Value: your App Secret
5. Click OK and restart Claude

## Step 4: Verify It Works

Start a new Cowork session and try asking Claude:

> "Show me my Help Scout inboxes"

If everything is connected, Claude will list your inboxes. If you see an authentication error, double-check your App ID and App Secret.

If you check the connector's tool list, you will see exactly three tools: `search_help_scout`, `describe_help_scout`, and `read_help_scout`. That is expected. They are a gateway over 55 read-only Help Scout operations, which Claude finds and runs as needed. (If you enabled writes, a fourth tool named `write_help_scout` appears as well.)

## Enabling Writes (Optional)

A fresh install is read-only. If you want Claude to be able to act on conversations (draft replies, internal notes, tags, status changes, assignment, snooze, moving between inboxes), turn on the write surface:

1. Open the connector's `.mcp.json` the same way as in Step 3, Option A
2. Change `"HELPSCOUT_ENABLE_WRITES": "${HELPSCOUT_ENABLE_WRITES:-false}"` to `"HELPSCOUT_ENABLE_WRITES": "true"`
3. Save and restart Claude

(Option B works too: set `HELPSCOUT_ENABLE_WRITES=true` as an environment variable instead.)

None of those operations email anyone: a reply is saved as an unsent draft for a human to review in Help Scout, and notes are visible to teammates only.

There is a second, separate flag, `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES`. Turning it on additionally allows `sendReply` and `publishDraft`, both of which email the customer immediately and cannot be recalled. Leave it off unless you specifically intend Claude to be able to email customers, and note that every such call also requires explicit confirmation naming the operation and target conversation before the server will accept it.

Your existing App ID and Secret already carry write access; Help Scout does not offer a separate write-only scope, which is exactly why the server keeps writes off unless you opt in here. Full rules live in the [write tool contract](architecture/mcp-tool-contract.md#write-tool-contract).

## Troubleshooting

**"Authentication failed" error:**
Your credentials may be incorrect. Go back to Help Scout > My Apps and verify the App ID and App Secret match exactly.

**Plugin installed but no Help Scout tools available:**
Restart Claude after adding your credentials. The MCP server only starts on launch.

**"Permission denied" on reports, users, or tags:**
Your private app is missing that scope. Go back to Help Scout > My Apps, edit the app, add **Read** access for the resource, and restart Claude.

**"Command not found: npx" error:**
You need Node.js installed. Download it from [nodejs.org](https://nodejs.org) (choose the LTS version) and restart Claude.
