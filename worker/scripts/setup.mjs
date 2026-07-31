// Setup wizard for the Help Scout remote MCP worker.
//
// Collapses steps 3 and 4 of guides/remote-self-host.md: it confirms wrangler is
// logged in, creates (or reuses) the OAUTH_KV namespace, and writes a
// wrangler.deploy.jsonc with the KV id, an optional account_id, and an optional
// custom worker name filled in. It then prints the remaining guide steps (deploy,
// register the Help Scout app, set the secrets, connect a client) so you can pick
// up where it leaves off.
//
// Idempotent: it refuses to overwrite an existing wrangler.deploy.jsonc unless you
// pass --force, so it never clobbers a live deployment's config.
//
// Usage:
//   npm run setup
//   npm run setup -- --force            overwrite an existing wrangler.deploy.jsonc
//   npm run setup -- --kv-id <id>       reuse an existing OAUTH_KV namespace
//   npm run setup -- --name <name>      set the worker name (subdomain)
//   npm run setup -- --account-id <id>  set the Cloudflare account_id
//   npm run setup -- --yes              non-interactive: accept defaults, skip prompts
//   npm run setup -- --dry-run          print the plan and resulting config, write nothing
//   npm run setup -- --skip-auth-check  skip the `wrangler whoami` preflight
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE_BIN = process.execPath;
const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_BIN = './node_modules/.bin/wrangler';
const TEMPLATE = path.join(WORKER_DIR, 'wrangler.jsonc');
const DEPLOY = path.join(WORKER_DIR, 'wrangler.deploy.jsonc');
const DEFAULT_NAME = 'helpscout-mcp-oauth';

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { force: false, yes: false, dryRun: false, skipAuthCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-auth-check') opts.skipAuthCheck = true;
    else if (a === '--kv-id') opts.kvId = takeValue(argv, ++i, a);
    else if (a === '--account-id') opts.accountId = takeValue(argv, ++i, a);
    else if (a === '--name') opts.name = takeValue(argv, ++i, a);
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// A flag that expects a value must actually get one; swallowing the next flag
// would silently create namespaces or write configs with names like "--force".
function takeValue(argv, i, flag) {
  const value = argv[i];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${flag} expects a value`);
    process.exit(2);
  }
  return value;
}

function printHelp() {
  console.log(`Help Scout remote worker setup wizard

Confirms wrangler auth, creates or reuses the OAUTH_KV namespace, and writes
wrangler.deploy.jsonc. Run from the worker/ directory (npm run setup).

Options:
  --force            overwrite an existing wrangler.deploy.jsonc
  --kv-id <id>       reuse an existing OAUTH_KV namespace instead of creating one
  --name <name>      worker name (becomes the workers.dev subdomain)
  --account-id <id>  Cloudflare account_id (skip if your account has one context)
  --yes, -y          non-interactive: accept defaults, skip optional prompts
  --dry-run          print the plan and resulting config, write nothing
  --skip-auth-check  skip the \`wrangler whoami\` preflight
  --help, -h         show this help
`);
}

// --- wrangler helpers -------------------------------------------------------
function runWrangler(args) {
  return spawnSync(NODE_BIN, [WRANGLER_BIN, ...args], {
    cwd: WORKER_DIR,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
}

function checkAuth() {
  const res = runWrangler(['whoami']);
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  // A signed-in `wrangler whoami` exits zero and says "You are logged in";
  // signed-out runs exit non-zero and/or say "not authenticated". Matching a
  // bare "login" would misread signed-in output that merely mentions logging in.
  const loggedOut =
    res.status !== 0 ||
    /not authenticated|not logged in/i.test(out) ||
    !/logged in/i.test(out);
  return { ok: !loggedOut, output: out.trim() };
}

// Parse the KV namespace id out of `wrangler kv namespace create` output. Wrangler
// prints a config snippet (TOML `id = "..."` or JSON `"id": "..."`); a namespace id
// is a 32-char hex string. Try the structured forms first, then fall back.
function parseKvId(output) {
  const structured =
    output.match(/"id"\s*:\s*"([0-9a-fA-F]{32})"/) || output.match(/\bid\s*=\s*"([0-9a-fA-F]{32})"/);
  if (structured) return structured[1];
  const bare = output.match(/\b([0-9a-fA-F]{32})\b/);
  return bare ? bare[1] : null;
}

function createKvNamespace() {
  console.log('Creating the OAUTH_KV namespace with wrangler...');
  const res = runWrangler(['kv', 'namespace', 'create', 'OAUTH_KV']);
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status !== 0) {
    console.error('wrangler kv namespace create failed:\n' + out.trim());
    process.exit(1);
  }
  const id = parseKvId(out);
  if (!id) {
    console.error(
      'Could not read the namespace id from wrangler output. Create it manually with\n' +
        '  npx wrangler kv namespace create OAUTH_KV\n' +
        'then re-run with --kv-id <id>. Raw output:\n' +
        out.trim(),
    );
    process.exit(1);
  }
  console.log(`  namespace id: ${id}`);
  return id;
}

// --- config rendering -------------------------------------------------------
// Text-level edits on the JSONC template so its comments survive. The default
// values in the template are the anchors we replace, so each match is unique.
function renderDeployConfig(template, { kvId, accountId, name }) {
  let out = template;

  if (!out.includes('<REPLACE_WITH_KV_ID>')) {
    throw new Error('template no longer contains the <REPLACE_WITH_KV_ID> placeholder');
  }
  out = out.replace('<REPLACE_WITH_KV_ID>', kvId);

  if (name && name !== DEFAULT_NAME) {
    if (!out.includes(`"name": "${DEFAULT_NAME}"`)) {
      throw new Error(`template no longer contains the expected default name "${DEFAULT_NAME}"`);
    }
    out = out.replace(`"name": "${DEFAULT_NAME}"`, `"name": "${name}"`);
  }

  if (accountId) {
    const mainLine = '  "main": "src/index.ts",';
    if (!out.includes(mainLine)) {
      throw new Error('template no longer contains the expected "main" line for account_id insertion');
    }
    out = out.replace(mainLine, `  "account_id": "${accountId}",\n${mainLine}`);
  }

  return out;
}

// --- prompts ----------------------------------------------------------------
async function prompt(rl, question, fallback = '') {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(TEMPLATE)) {
    console.error(`Cannot find the template at ${TEMPLATE}. Run this from the worker package (npm run setup).`);
    process.exit(1);
  }

  // Refuse to clobber an existing deploy config unless forced. Checked first so
  // the guard is fast and needs no network.
  if (fs.existsSync(DEPLOY) && !opts.force && !opts.dryRun) {
    console.error(
      `${path.basename(DEPLOY)} already exists. This is your live deployment config.\n` +
        'Refusing to overwrite it. Re-run with --force if you really mean to replace it,\n' +
        'or edit the file directly. Nothing was changed.',
    );
    process.exit(1);
  }

  // Preflight: wrangler must be logged in (skippable, and soft under --dry-run).
  if (!opts.skipAuthCheck) {
    const auth = checkAuth();
    if (!auth.ok) {
      const msg =
        'wrangler is not logged in to Cloudflare. Run\n  npx wrangler login\nthen re-run this wizard.';
      if (opts.dryRun) {
        console.log(`[dry-run] ${msg}`);
      } else {
        console.error(msg);
        process.exit(1);
      }
    } else if (auth.output) {
      console.log('wrangler is logged in.');
    }
  }

  const rl = opts.yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // KV namespace.
    let kvId = opts.kvId;
    if (!kvId) {
      let create = true;
      if (rl) {
        const existing = await prompt(
          rl,
          'Reuse an existing OAUTH_KV namespace id? Paste it, or press enter to create one: ',
        );
        if (existing) {
          kvId = existing;
          create = false;
        }
      }
      if (create) kvId = opts.dryRun ? (opts.kvId || 'DRY_RUN_KV_ID') : createKvNamespace();
    }

    // account_id (optional).
    let accountId = opts.accountId;
    if (accountId === undefined && rl) {
      accountId =
        (await prompt(
          rl,
          'Cloudflare account_id (optional; press enter to skip if your account has one context): ',
        )) || undefined;
    }

    // Worker name (optional).
    let name = opts.name;
    if (name === undefined && rl) {
      name = await prompt(rl, `Worker name [${DEFAULT_NAME}]: `, DEFAULT_NAME);
    }
    if (!name) name = DEFAULT_NAME;

    const template = fs.readFileSync(TEMPLATE, 'utf8');
    const rendered = renderDeployConfig(template, { kvId, accountId, name });

    if (opts.dryRun) {
      console.log('\n[dry-run] would write ' + DEPLOY + ' with:');
      console.log(`  kv id:      ${kvId}`);
      console.log(`  account_id: ${accountId || '(omitted)'}`);
      console.log(`  name:       ${name}`);
      console.log('\n--- wrangler.deploy.jsonc (not written) ---\n');
      console.log(rendered);
      return;
    }

    fs.writeFileSync(DEPLOY, rendered);
    console.log(`\nWrote ${path.relative(WORKER_DIR, DEPLOY)} (gitignored).`);
    console.log(`  kv id:      ${kvId}`);
    console.log(`  account_id: ${accountId || '(omitted; single-account context assumed)'}`);
    console.log(`  name:       ${name}`);

    // Next steps, numbered to match guides/remote-self-host.md.
    const workerRef = name === DEFAULT_NAME ? '<name>' : name;
    console.log(`
Steps 3 and 4 are done. Next, following the runbook:

  5. First deploy (to learn your URL):
       npx wrangler deploy --config wrangler.deploy.jsonc
     It prints https://${workerRef}.<your-subdomain>.workers.dev. Write it down.

  6. Register the Help Scout app AFTER the deploy. In Help Scout, My Apps >
     Create App, set the Redirection URL to https://<worker-url>/callback.
     It MUST be https from the start; an http:// redirect is permanently broken.
     Copy the App ID and App Secret.

  7. Set the three secrets, then re-deploy:
       npx wrangler secret put HELPSCOUT_CLIENT_ID     --config wrangler.deploy.jsonc
       npx wrangler secret put HELPSCOUT_CLIENT_SECRET  --config wrangler.deploy.jsonc
       npx wrangler secret put COOKIE_ENCRYPTION_KEY    --config wrangler.deploy.jsonc
       npx wrangler deploy --config wrangler.deploy.jsonc

  8. Connect a client to https://<worker-url>/mcp and sign in.

Full runbook, including the token behavior and write toggles:
  ../guides/remote-self-host.md
`);
  } finally {
    if (rl) rl.close();
  }
}

main().catch((e) => {
  console.error('\nsetup crashed:', e);
  process.exit(1);
});
