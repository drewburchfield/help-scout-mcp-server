# Self-Hosting the Remote Help Scout MCP Server

This guide walks you through deploying the Help Scout MCP server as a Cloudflare
Worker with per-user OAuth. Once it is live, anyone on your Help Scout account can
add one URL to Claude (or any MCP client that speaks the remote transport) and
sign in with their own Help Scout login. No shared API credentials are handed out,
and each person's access mirrors their own Help Scout permissions.

This is different from the [Desktop Extension](cowork-setup.md) and the npx/Docker
installs, where each person runs their own copy with a single shared App ID and
Secret. The remote worker is one deployment your whole team connects to.

It is also the recommended path for teams that would rather not hand out shared API
credentials, and for organizations with role-based access control or compliance-style
requirements (for example teams operating under SOC 2 or ISO 27001 controls).
Per-user attribution, access that revokes with each person's Help Scout account, and
running on your own infrastructure are the point here. This does not make the software
certified or compliant on its own; it is built to support the control requirements
those organizations have to meet.

It is a v1 remote deployment. Read the [seat requirement](#who-can-use-it) and the
[token behavior](#how-tokens-and-sessions-behave) before rolling it out to a team.

## How it works

The worker plays two OAuth roles at once. To your MCP client it *is* an OAuth 2.1
authorization server and MCP resource server: the client registers itself, runs the
authorize flow, and gets a token the worker issued. To Help Scout the worker is an
OAuth *client*: when a user approves the consent screen, the worker sends them to
Help Scout to log in, exchanges the returned code for that user's own Help Scout
token pair, and stores it encrypted, keyed to that user. Nothing is shared between
users. Every `/mcp` call runs as the user who signed in, with their Help Scout
permissions, and a role change in Help Scout applies to their existing token on the
next request without a re-login.

## What you need

- A Cloudflare account. The free tier is enough: this worker uses Durable Objects
  with SQLite storage, which are available on the free plan.
- `wrangler` (the Cloudflare CLI) authenticated to that account. It ships as a dev
  dependency of the worker package, so you do not need a global install; you just
  need to log in once (step 2).
- A Help Scout account with a full **User** seat. Light Users cannot use this at
  all (see [Who can use it](#who-can-use-it)).
- `openssl` (or any way to produce a long random string) for the cookie signing key.

## Deploy it

### 1. Install the worker package

```bash
cd worker
npm install
```

All commands below run from the `worker/` directory.

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser and authorizes `wrangler` against your Cloudflare account.

### 3. Create the KV namespace

The OAuth provider stores hashed client secrets and the AES-GCM-encrypted per-user
grants (which hold each user's Help Scout tokens) in a Workers KV namespace.

The quickest path is the setup wizard, which does this step and the next one for
you. From the `worker/` directory:

```bash
npm run setup
```

It checks that `wrangler` is logged in (and tells you to run `npx wrangler login`
if not), creates the `OAUTH_KV` namespace, and writes `wrangler.deploy.jsonc` with
the namespace id filled in. It prompts for an optional Cloudflare `account_id` and
an optional custom worker name, then prints the remaining steps. It refuses to
overwrite an existing `wrangler.deploy.jsonc` unless you pass `--force`, so it will
not clobber a live deployment's config. If you already created a namespace, pass its
id with `--kv-id <id>` to skip creation. When the wizard finishes, skip to step 5.

To do it by hand instead, run the two steps below.

**Manual alternative.** Create the namespace:

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` it prints. You will paste it into your config in the next step.

### 4. Make a deploy config

The wizard in step 3 writes this file for you. Do this step by hand only if you
skipped the wizard.

`wrangler.jsonc` is a tracked template with placeholders. Rather than edit the
template in place, copy it to `wrangler.deploy.jsonc` (already gitignored) and fill
in your values there:

```bash
cp wrangler.jsonc wrangler.deploy.jsonc
```

In `wrangler.deploy.jsonc`:

- Replace `<REPLACE_WITH_KV_ID>` in `kv_namespaces` with the id from step 3.
- Add your Cloudflare `account_id` at the top level (find it in the Cloudflare
  dashboard, or run `npx wrangler whoami`). You can skip this if your account has
  exactly one account context.
- Optionally rename `name` (this becomes the subdomain of your `workers.dev` URL).
- Leave `compatibility_date` at its shipped value (`2025-05-01` or later). Do not
  lower it below `2025-04-01`: below that, `process.env` stops being populated
  under `nodejs_compat`, and the shared config module and the durable token
  rotation both depend on it.

### 5. First deploy (to learn your URL)

```bash
npx wrangler deploy --config wrangler.deploy.jsonc
```

The first deploy prints your worker URL:

```
https://<name>.<your-subdomain>.workers.dev
```

Write it down. The next step needs it, and it cannot change afterward without
re-registering the Help Scout app.

### 6. Register the Help Scout app (after you know the URL)

Register the app *after* the deploy, because the redirect URL must be your live
worker URL and it is fixed at registration.

1. In Help Scout, click your profile (lower left) and open **My Apps**
   (`secure.helpscout.net/users/apps/<your-user-id>`).
2. Click **Create App**.
3. Set the **Redirection URL** to `https://<worker-url>/callback`, using the URL
   from step 5.
4. Save, then copy the **App ID** and **App Secret**.

> **Critical trap: the redirect must be `https` from the start.** An app created
> with an `http://` redirect URL is permanently broken for the authorize flow.
> Help Scout silently bounces the sign-in with no error, and editing the URL to
> `https` later does not heal it. If you ever see a silent bounce at the Help Scout
> authorize screen, the fix is to delete the app and create a new one with the
> `https` callback. Your worker URL is already `https` (that is all `workers.dev`
> serves), so just make sure you paste the full `https://.../callback`.

### 7. Set the secrets

Three secrets, none of which live in the config file:

```bash
npx wrangler secret put HELPSCOUT_CLIENT_ID     --config wrangler.deploy.jsonc
npx wrangler secret put HELPSCOUT_CLIENT_SECRET  --config wrangler.deploy.jsonc
npx wrangler secret put COOKIE_ENCRYPTION_KEY    --config wrangler.deploy.jsonc
```

- `HELPSCOUT_CLIENT_ID` is the App ID from step 6.
- `HELPSCOUT_CLIENT_SECRET` is the App Secret from step 6.
- `COOKIE_ENCRYPTION_KEY` signs the consent-transaction cookie (the confused-deputy
  defense). Use a long random string, for example the output of
  `openssl rand -hex 32`. The consent flow hard-fails with a clear page if this is
  missing, so it is not optional.

Optionally, to enable the Docs knowledge-base operations:

```bash
npx wrangler secret put HELPSCOUT_DOCS_API_KEY --config wrangler.deploy.jsonc
```

Without it, the Docs operations stay advertised but return a credentials-missing
error at call time.

Re-deploy so the secrets take effect:

```bash
npx wrangler deploy --config wrangler.deploy.jsonc
```

### 8. Connect a client

In claude.ai or Claude Desktop, add a custom connector pointing at:

```
https://<worker-url>/mcp
```

The OAuth flow runs automatically: the client registers itself, you land on the
consent page, click **Continue to Help Scout**, sign in to Help Scout, and you are
connected. Each user who connects does this once.

## Verify it without a client

You can confirm the deployment is healthy from the command line:

```bash
# Discovery metadata should be 200
curl -s -o /dev/null -w '%{http_code}\n' \
  https://<worker-url>/.well-known/oauth-authorization-server

# An unauthenticated MCP call should be 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://<worker-url>/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

The first should print `200`, the second `401`. The `401` also carries a
`WWW-Authenticate` header pointing the client at the metadata.

To exercise the whole OAuth flow (consent, Help Scout leg, token exchange,
`initialize`, `tools/list`) against a local mock without touching Help Scout, run
the smoke suite from `worker/`:

```bash
npm run smoke
```

## Who can use it

A full Help Scout **User** seat is required. Help Scout returns `403` on the entire
Mailbox API for Light User seats, so a Light User who tries to connect completes the
Help Scout login and then lands on a "full Help Scout User seat is required" page,
and no grant is stored. Ask a Help Scout administrator to grant a full User seat,
then reconnect.

Each connected user acts with their own Help Scout permissions, evaluated live. If
an administrator changes someone's role or inbox access in Help Scout, that applies
to their existing connection on the next request; there is no re-authorization step.

## Writes are opt-in per deployment

A fresh deployment is read-only: it advertises `search_help_scout`,
`describe_help_scout`, and `read_help_scout` and nothing else. Two vars in your
config control writes, both default `false`:

| Var | What it adds |
|-----|--------------|
| `HELPSCOUT_ENABLE_WRITES` | A fourth tool, `write_help_scout`, with the tier-1 conversation writes (draft replies, notes, tags, status, assignment, snooze, moving inboxes). None of these email anyone. |
| `HELPSCOUT_ENABLE_CUSTOMER_VISIBLE_WRITES` | Also enables `sendReply` and `publishDraft` on that tool, which email the customer. |

Set these in the `vars` block of `wrangler.deploy.jsonc` and re-deploy. Every write
acts as the authorizing user with their own Help Scout permissions, so a user whose
role cannot write to a mailbox gets a structured permission error. The full rules
(confirmation envelope, dry-run) are in the
[write tool contract](architecture/mcp-tool-contract.md#write-tool-contract).

## How tokens and sessions behave

- Help Scout access tokens last about 48 hours. The token the worker issues to your
  MCP client is aligned to expire about 5 minutes before the Help Scout token, so
  the client's normal token refresh is what drives the durable Help Scout refresh.
- Help Scout refresh tokens rotate: each refresh consumes the old one and returns a
  new pair. The worker persists the rotation through the OAuth provider's token
  exchange, so it survives across sessions and worker restarts.
- The designed failure mode for edge cases (for example a refresh token that was
  already spent by a racing request) is an occasional forced reconnect, never
  silent data loss. When it happens, the client is told to re-run authorization and
  the user signs in again.

## Rotating the app secret and revoking access

**Treat rotating the Help Scout App Secret as forcing re-consent for every
connected user.** Once the worker holds the new secret, stored refresh tokens tied
to the old one stop working on their next refresh. Whatever Help Scout's exact
invalidation timing is, the failure path is the same and it is safe: the refresh
fails with a standard `invalid_grant`, the client re-runs authorization, and the
user signs in again. There is no data loss and nothing to clean up. Plan to rotate
the secret at a low-traffic time so people re-connect on their own schedule rather
than mid-task.

**To revoke a single user**, have them revoke the app from their Help Scout profile
(the same **My Apps** area), or wipe that user's grant from the `OAUTH_KV`
namespace. Either way their next request fails to refresh and they are prompted to
reconnect; other users are unaffected.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Silent bounce at the Help Scout authorize screen, no error, never reaches `/callback` | The Help Scout app was born with an `http://` redirect URL. This cannot be fixed by editing the URL. Delete the app and create a new one with the `https://<worker-url>/callback` redirect. |
| "This server is missing its COOKIE_ENCRYPTION_KEY secret" page | The `COOKIE_ENCRYPTION_KEY` secret is not set. Run `npx wrangler secret put COOKIE_ENCRYPTION_KEY` and re-deploy. |
| "A full Help Scout User seat is required" page after signing in | The Help Scout account is a Light User. Light Users have no Mailbox API access. Ask an administrator for a full User seat. |
| Client re-prompts for sign-in repeatedly, or 401 loops | Check the three secrets are set for this deployment (`HELPSCOUT_CLIENT_ID`, `HELPSCOUT_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`) and that the App ID and Secret match the registered app. Re-deploy after setting secrets. |
| "This server is configured with a non-https Help Scout URL" page | A `HELPSCOUT_*_URL` var was pointed at a non-`https` URL. Restore the defaults in `wrangler.jsonc`. |
| Everyone is suddenly asked to reconnect | Expected after an App Secret rotation, or if the worker's secrets changed. See [Rotating the app secret](#rotating-the-app-secret-and-revoking-access). |
| `wrangler dev` logs a `global_fetch_strictly_public` (CIMD) warning | Benign. Dynamic Client Registration is the supported path for this worker. |

## Operating notes

- **Upgrading a deployment.** Pull the new code and re-deploy with your existing
  config:

  ```bash
  git pull
  npm install   # only if package-lock.json changed
  npx wrangler deploy --config wrangler.deploy.jsonc
  ```

  Your secrets and the `OAUTH_KV` namespace survive a re-deploy, so connected users
  stay connected and no one has to sign in again. `wrangler.deploy.jsonc` is not
  touched by `git pull` (it is gitignored), so your KV id and account id carry over.
  If you want a check before shipping an update, run the smoke suite first (`npm run
  smoke`); it drives the whole OAuth flow against a local mock without touching Help
  Scout or your live deployment.

  **When an upgrade introduces a new Durable Object.** Some upgrades add a new
  Durable Object class. Because your `wrangler.deploy.jsonc` is your own gitignored
  copy, it does NOT pick these up from `git pull`, and the wizard does not reconcile
  them for you: you must add the new binding and a new migration tag by hand before
  deploying, or every request that uses the new object fails. This version added the
  access-policy coordinator (`PolicyCoordinator`), bound as `POLICY_OBJECT`. Compare
  your `wrangler.deploy.jsonc` against the shipped `wrangler.jsonc` template and, if
  it is missing, add the binding:

  ```jsonc
  "durable_objects": {
    "bindings": [
      { "class_name": "HelpScoutMCP", "name": "MCP_OBJECT" },
      // Add this line if your config predates the policy engine:
      { "class_name": "PolicyCoordinator", "name": "POLICY_OBJECT" }
    ]
  },
  ```

  and the matching migration tag:

  ```jsonc
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["HelpScoutMCP"] },
    // Add this entry alongside your existing tags:
    { "tag": "v2", "new_sqlite_classes": ["PolicyCoordinator"] }
  ],
  ```

  Deploying without the `POLICY_OBJECT` binding leaves the worker unable to read or
  write the access policy, and because that check fails closed every callback and
  tool call returns "access could not be verified" until the binding is added.
- Live logs: `npm run tail` (wraps `wrangler tail`) streams request logs from the
  deployed worker.
- The three advertised tools are a gateway over the read operations; Claude finds
  and runs the specific operation it needs. If you enabled writes, a fourth tool
  `write_help_scout` appears. This is the same surface as every other install.
- Keep `wrangler.deploy.jsonc` out of version control (it is already gitignored). It
  holds your KV id and account id, and it is the only file that differs from the
  shipped template.
