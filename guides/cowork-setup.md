# Setting Up Help Scout in Claude Cowork

This guide walks you through installing the Help Scout plugin in Claude Cowork and connecting it to your Help Scout account.

## Step 1: Install the Plugin

1. Open the Claude desktop app and switch to **Cowork**
2. Click **Customize** in the left sidebar
3. Click **Browse plugins** and go to the **Personal** tab
4. Click the **+** button and choose **Add marketplace from GitHub**
5. Enter: `drewburchfield/help-scout-mcp-server`
6. Find **helpscout-navigator** in the list and click **Install**
7. When prompted about local MCP servers, click **Continue**

## Step 2: Get Your Help Scout Credentials

You'll need two values from Help Scout: an **App ID** and an **App Secret**.

1. Log in to [Help Scout](https://secure.helpscout.net)
2. Go to **My Apps** (click your profile icon in the lower left, then **My Apps**)
3. Click **Create Private App**
4. Give it a name (e.g., "Claude AI")
5. Under scopes, check **Read** access for **Mailboxes**, **Conversations**, **Customers**, and **Organizations**
6. Click **Create** and copy the **App ID** and **App Secret**

Keep these values handy for the next step.

## Step 3: Add Your Credentials

The plugin needs your App ID and App Secret to connect to Help Scout. There are two ways to do this:

### Option A: Edit the Config File (Simplest)

1. In Cowork, go to **Customize** > **Connectors**
2. Click on the **helpscout** connector
3. Click **Edit** > **Show in folder**
4. Open the `.mcp.json` file in any text editor (TextEdit, Notepad, etc.)
5. Replace the placeholder values with your actual credentials:

**Before:**
```json
{
  "helpscout": {
    "command": "npx",
    "args": ["-y", "help-scout-mcp-server"],
    "env": {
      "HELPSCOUT_APP_ID": "${HELPSCOUT_APP_ID}",
      "HELPSCOUT_APP_SECRET": "${HELPSCOUT_APP_SECRET}",
      "REDACT_MESSAGE_CONTENT": "${REDACT_MESSAGE_CONTENT:-false}"
    }
  }
}
```

**After:**
```json
{
  "helpscout": {
    "command": "npx",
    "args": ["-y", "help-scout-mcp-server"],
    "env": {
      "HELPSCOUT_APP_ID": "your-actual-app-id",
      "HELPSCOUT_APP_SECRET": "your-actual-app-secret",
      "REDACT_MESSAGE_CONTENT": "false"
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

## Troubleshooting

**"Authentication failed" error:**
Your credentials may be incorrect. Go back to Help Scout > My Apps and verify the App ID and App Secret match exactly.

**Plugin installed but no Help Scout tools available:**
Restart Claude after adding your credentials. The MCP server only starts on launch.

**"Command not found: npx" error:**
You need Node.js installed. Download it from [nodejs.org](https://nodejs.org) (choose the LTS version) and restart Claude.
