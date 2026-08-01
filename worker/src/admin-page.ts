/**
 * The self-contained admin console page (NAS-1503).
 *
 * One server-rendered HTML document with nonce'd inline CSS and a single nonce'd
 * inline vanilla-JS app. No SPA framework, no third-party frontend dependency,
 * nothing loaded from another origin, so the page satisfies the strict CSP the
 * handler sets (default-src 'none'; script/style limited to the per-response
 * nonce; connect-src 'self'). All Help Scout-supplied text (emails, names,
 * updatedBy) is rendered with textContent, never innerHTML, so profile fields an
 * account admin can edit cannot inject markup.
 *
 * The CSRF token is a per-session synchronizer token: embedded here in the app
 * and sent back in the X-Admin-CSRF header on every mutating request, where the
 * handler compares it to the token bound in the signed session cookie. It is not
 * a secret to hide from the page; it is meant to live in the page.
 */

/** Shared page chrome: doctype, head with nonce'd style, and the shell markup. */
function shell(nonce: string, title: string, bodyHtml: string, scriptHtml = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f6f3ee;--card:#fffdfa;--ink:#1f2528;--muted:#667174;--line:#d8d1c7;--accent:#3f6fd6;--danger:#c1442e;--ok:#2f7d48;--warn:#9a6a12}
@media (prefers-color-scheme:dark){:root{--bg:#181a1c;--card:#212528;--ink:#e9eaeb;--muted:#9aa3a7;--line:#333a3e;--accent:#6d9bff;--danger:#e77a68;--ok:#5fbf82;--warn:#d0a24a}}
*{box-sizing:border-box}
body{font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);margin:0;line-height:1.5}
main{max-width:1080px;margin:0 auto;padding:24px 20px 64px}
header.top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:20px}
h1{font-size:20px;margin:0}
h2{font-size:15px;margin:0 0 12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 20px}
.kv .k{font-size:12px;color:var(--muted)}
.kv .v{font-size:14px;word-break:break-all}
label.toggle{display:inline-flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}
input[type=search]{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:14px;margin-bottom:12px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px}
td.user{white-space:normal;min-width:180px}
.email{font-size:12px;color:var(--muted)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.badge.danger{color:var(--danger);border-color:var(--danger)}
.badge.muted{color:var(--muted)}
select,button{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);padding:5px 8px}
button{cursor:pointer}
button.link{background:none;border:0;color:var(--accent);padding:0;font:inherit;cursor:pointer;text-decoration:underline}
button.primary{background:var(--accent);color:#fff;border-color:transparent}
button.danger{color:var(--danger)}
button:disabled,select:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:6px}
.exports{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.exports a{display:inline-block;padding:6px 10px;border:1px solid var(--line);border-radius:7px;text-decoration:none;font-size:13px}
.flash{min-height:20px;font-size:13px;margin:0 0 12px;padding:0}
.flash.ok{color:var(--ok)}
.flash.err{color:var(--danger)}
.muted{color:var(--muted)}
.note{font-size:12px;color:var(--muted);margin-top:8px}
</style></head><body><main>${bodyHtml}</main>${scriptHtml}</body></html>`;
}

/** A minimal notice page for login prompts, refusals, and errors. */
export function renderAdminNotice(nonce: string, title: string, heading: string, message: string): string {
  // heading/message are all server-controlled constants (never user input), so a
  // static template is safe here.
  const body = `<header class="top"><h1>Help Scout MCP Admin</h1></header>
<div class="card"><h2>${heading}</h2><p>${message}</p><p><a href="/admin">Return to the admin console</a></p></div>`;
  return shell(nonce, title, body);
}

/** The full admin console. `csrf` is the per-session synchronizer token. */
export function renderAdminPage(nonce: string, csrf: string): string {
  const body = `<header class="top">
  <h1>Help Scout MCP Admin</h1>
  <button type="button" id="signout" class="link">Sign out</button>
</header>
<p class="flash" id="flash"></p>

<section class="card">
  <h2>Deployment</h2>
  <div class="grid">
    <div class="kv"><div class="k">Access mode</div><div class="v">
      <label class="toggle"><input type="checkbox" id="allowlist-toggle" disabled> Allowlist mode</label>
      <div class="note">On: only explicitly-allowed users may connect. Off: any full Help Scout User seat may connect unless explicitly blocked.</div>
    </div></div>
    <div class="kv"><div class="k">Write ceiling (deploy-time, read-only)</div><div class="v" id="dep-ceiling">-</div></div>
    <div class="kv"><div class="k">Admin role</div><div class="v" id="dep-admin-role">-</div></div>
    <div class="kv"><div class="k">Worker version</div><div class="v" id="dep-worker">-</div></div>
    <div class="kv"><div class="k">Deployment id</div><div class="v" id="dep-id">-</div></div>
    <div class="kv"><div class="k">Roster snapshot</div><div class="v" id="dep-fetched">-</div></div>
  </div>
</section>

<section class="card">
  <h2>Users</h2>
  <input type="search" id="roster-search" placeholder="Filter by name, email, or role" autocomplete="off">
  <p class="note" id="conn-note"></p>
  <div class="scroll"><table>
    <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Admission</th><th>Write tier</th><th>Actions</th></tr></thead>
    <tbody id="roster-body"><tr><td colspan="6" class="muted">Loading roster…</td></tr></tbody>
  </table></div>
</section>

<section class="card">
  <h2>Audit &amp; evidence</h2>
  <div class="exports">
    <a href="/admin/api/export/audit.json">Audit log (JSON)</a>
    <a href="/admin/api/export/audit.csv">Audit log (CSV)</a>
    <a href="/admin/api/export/access-list.json">Access list (JSON)</a>
    <a href="/admin/api/export/access-list.csv">Access list (CSV)</a>
  </div>
  <p class="note" id="access-scope"></p>
  <div class="scroll"><table>
    <thead><tr><th>Seq</th><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead>
    <tbody id="audit-body"><tr><td colspan="6" class="muted">Loading audit…</td></tr></tbody>
  </table></div>
  <p><button id="audit-more" disabled>Load older</button></p>
</section>`;

  const script = `<script nonce="${nonce}">
(function(){
"use strict";
var CSRF = ${JSON.stringify(csrf)};
var deployment = null;
var flashEl = document.getElementById('flash');

function flash(text, kind){
  flashEl.textContent = text || '';
  flashEl.className = 'flash ' + (kind || '');
}
function toLogin(){ window.location = '/admin'; }

function req(method, url, body){
  var opts = { method: method, headers: { 'Accept': 'application/json' } };
  if(method === 'POST'){ opts.headers['Content-Type'] = 'application/json'; opts.headers['X-Admin-CSRF'] = CSRF; opts.body = JSON.stringify(body || {}); }
  return fetch(url, opts).then(function(r){
    if(r.status === 401){ toLogin(); throw new Error('unauthenticated'); }
    return r.json().then(function(b){ return { status: r.status, body: b }; }, function(){ return { status: r.status, body: {} }; });
  });
}
function setText(id, val){ var e = document.getElementById(id); if(e) e.textContent = String(val); }
function cell(text, cls){ var td = document.createElement('td'); if(cls) td.className = cls; td.textContent = text; return td; }
function badge(text, cls){ var s = document.createElement('span'); s.className = 'badge ' + (cls || 'muted'); s.textContent = text; return s; }
function tierRank(t){ return t === 'writes+customerVisible' ? 2 : (t === 'writes' ? 1 : 0); }
function tierText(t){ return t === 'writes+customerVisible' ? 'Writes + customer-visible' : (t === 'writes' ? 'Writes' : 'None'); }
function ceilingText(c){ return c.enabled ? (c.customerVisibleEnabled ? 'Writes + customer-visible' : 'Writes') : 'Read-only'; }

function renderDeployment(dep){
  deployment = dep;
  setText('dep-worker', dep.workerVersion);
  setText('dep-id', dep.deploymentId);
  setText('dep-admin-role', dep.adminRole === 'administrator' ? 'Owners and Administrators' : 'Owners only');
  setText('dep-ceiling', ceilingText(dep.ceiling));
  setText('dep-fetched', dep.directoryFetchedAt || 'unknown');
  var cb = document.getElementById('allowlist-toggle');
  cb.checked = !!dep.allowlistMode;
  cb.disabled = false;
  var connNote = document.getElementById('conn-note');
  if(dep.connectionStatus === 'partial'){
    connNote.textContent = 'Connection status shown for the first ' + dep.connectionProbedCount + ' users.';
  } else {
    connNote.textContent = '';
  }
}

function onAllowlist(){
  var cb = document.getElementById('allowlist-toggle');
  cb.disabled = true;
  req('POST', '/admin/api/config', { allowlistMode: cb.checked, expectedVersion: deployment.configVersion }).then(function(res){
    if(res.status === 200){ flash('Access mode updated.', 'ok'); reload(); }
    else if(res.status === 409){ flash('Configuration changed since load, reloading.', 'err'); reload(); }
    else { flash((res.body && res.body.error) || 'Update failed.', 'err'); cb.checked = !!deployment.allowlistMode; cb.disabled = false; }
  });
}

var rosterRows = [];
function loadRoster(){
  return req('GET', '/admin/api/roster').then(function(res){
    if(res.status !== 200){ flash((res.body && res.body.error) || 'Could not load roster.', 'err'); return; }
    renderDeployment(res.body.deployment);
    rosterRows = res.body.rows || [];
    renderRoster();
  });
}
// After any mutation (including a rejected one, which records a denied audit
// row) refresh both the roster and the audit table so the ledger the admin sees
// stays live without a page reload.
function reload(){ loadRoster(); loadAudit(true); }

function makeTierSelect(row, allowedNow){
  var sel = document.createElement('select');
  var cap = tierRank(deployment.ceilingCap);
  ['none','writes','writes+customerVisible'].forEach(function(t){
    var o = document.createElement('option');
    o.value = t; o.textContent = tierText(t);
    if(tierRank(t) > cap) o.disabled = true;
    if(t === row.writeTier) o.selected = true;
    sel.appendChild(o);
  });
  if(!row.eligible) sel.disabled = true;
  sel.addEventListener('change', function(){
    var tier = sel.value;
    sel.disabled = true;
    req('POST', '/admin/api/user-policy', { hsUserId: row.hsUserId, allowed: allowedNow, writeTier: tier, expectedVersion: row.version }).then(function(res){
      if(res.status === 200){ flash('Write tier updated for ' + row.email + '.', 'ok'); reload(); }
      else if(res.status === 409){ flash('This user changed since load, reloading.', 'err'); reload(); }
      else { flash((res.body && res.body.error) || 'Update failed.', 'err'); reload(); }
    });
  });
  return sel;
}

function admissionBadge(row){
  if(row.policyState === 'blocked') return badge('Blocked', 'danger');
  if(!row.effectiveAllowed) return badge('Not admitted (allowlist)', 'warn');
  if(row.policyState === 'explicitly-allowed') return badge('Allowed', 'ok');
  return badge('Open default', 'muted');
}

function renderRoster(){
  var q = (document.getElementById('roster-search').value || '').toLowerCase();
  var body = document.getElementById('roster-body');
  body.textContent = '';
  var shown = 0;
  rosterRows.forEach(function(row){
    var hay = (row.email + ' ' + row.name + ' ' + row.role).toLowerCase();
    if(q && hay.indexOf(q) === -1) return;
    shown++;
    var allowedNow = row.policyState !== 'blocked';
    var tr = document.createElement('tr');

    var user = document.createElement('td');
    user.className = 'user';
    var nm = document.createElement('div'); nm.textContent = row.name; user.appendChild(nm);
    var em = document.createElement('div'); em.className = 'email'; em.textContent = row.email; user.appendChild(em);
    tr.appendChild(user);

    tr.appendChild(cell(row.role));

    var status = document.createElement('td');
    if(!row.eligible){ status.appendChild(badge('Light (ineligible)', 'muted')); }
    else if(row.connected === null){ status.appendChild(badge('Not probed', 'muted')); }
    else { status.appendChild(badge(row.connected ? 'Connected' : 'Not connected', row.connected ? 'ok' : 'muted')); }
    tr.appendChild(status);

    var adm = document.createElement('td'); adm.appendChild(admissionBadge(row)); tr.appendChild(adm);

    var tier = document.createElement('td'); tier.appendChild(makeTierSelect(row, allowedNow)); tr.appendChild(tier);

    var act = document.createElement('td');
    var actions = document.createElement('div'); actions.className = 'actions';
    var block = document.createElement('button');
    block.textContent = allowedNow ? 'Block' : 'Unblock';
    block.disabled = !row.eligible;
    block.addEventListener('click', function(){
      block.disabled = true;
      req('POST', '/admin/api/user-policy', { hsUserId: row.hsUserId, allowed: !allowedNow, writeTier: row.writeTier, expectedVersion: row.version }).then(function(res){
        if(res.status === 200){ flash((allowedNow ? 'Blocked ' : 'Unblocked ') + row.email + '.', 'ok'); reload(); }
        else if(res.status === 409){ flash('This user changed since load, reloading.', 'err'); reload(); }
        else { flash((res.body && res.body.error) || 'Update failed.', 'err'); reload(); }
      });
    });
    actions.appendChild(block);

    var revoke = document.createElement('button');
    revoke.className = 'danger'; revoke.textContent = 'Revoke';
    revoke.addEventListener('click', function(){
      if(!window.confirm('Revoke all access for ' + row.email + '? This tears down their live sessions and blocks reconnection.')) return;
      revoke.disabled = true;
      req('POST', '/admin/api/revoke', { hsUserId: row.hsUserId }).then(function(res){
        if(res.status === 200){ flash('Revoked ' + row.email + ' (' + ((res.body.result && res.body.result.grantsRevoked) || 0) + ' grant(s)).', 'ok'); reload(); }
        else { flash((res.body && res.body.error) || 'Revoke failed.', 'err'); reload(); }
      });
    });
    actions.appendChild(revoke);
    act.appendChild(actions);
    tr.appendChild(act);

    body.appendChild(tr);
  });
  if(shown === 0){
    var tr = document.createElement('tr');
    var td = document.createElement('td'); td.colSpan = 6; td.className = 'muted'; td.textContent = 'No users match.';
    tr.appendChild(td); body.appendChild(tr);
  }
}

var auditCursor = null;
function loadAudit(reset){
  var url = '/admin/api/audit?limit=25' + (auditCursor ? ('&cursor=' + encodeURIComponent(auditCursor)) : '');
  return req('GET', url).then(function(res){
    var body = document.getElementById('audit-body');
    if(reset) body.textContent = '';
    if(res.status !== 200){ flash((res.body && res.body.error) || 'Could not load audit.', 'err'); return; }
    var page = res.body.page || {};
    (page.entries || []).forEach(function(e){
      var tr = document.createElement('tr');
      tr.appendChild(cell(String(e.seq)));
      tr.appendChild(cell(e.ts));
      tr.appendChild(cell(e.actorEmail || e.actorId));
      tr.appendChild(cell(e.action));
      tr.appendChild(cell(e.targetId));
      var out = document.createElement('td'); out.appendChild(badge(e.outcome, e.outcome === 'denied' ? 'warn' : 'ok')); tr.appendChild(out);
      body.appendChild(tr);
    });
    if(reset && (page.entries || []).length === 0){
      var tr = document.createElement('tr'); var td = document.createElement('td'); td.colSpan = 6; td.className = 'muted'; td.textContent = 'No audit entries yet.'; tr.appendChild(td); body.appendChild(tr);
    }
    auditCursor = page.nextCursor || null;
    var more = document.getElementById('audit-more');
    more.disabled = !auditCursor;
  });
}

// Surface the authoritative access-list scope note from the export payload, so a
// reader does not mistake the roster for the full set of people with access.
function loadScope(){
  return req('GET', '/admin/api/export/access-list.json').then(function(res){
    if(res.status === 200 && res.body && res.body.config && res.body.config.scope){
      document.getElementById('access-scope').textContent = res.body.config.scope.note;
    }
  });
}

// Logout is a CSRF-protected POST (a cross-site GET must not sign the admin out).
// req() attaches the X-Admin-CSRF header on POST; navigate to /admin either way.
document.getElementById('signout').addEventListener('click', function(){
  req('POST', '/admin/logout').then(toLogin, toLogin);
});
document.getElementById('allowlist-toggle').addEventListener('change', onAllowlist);
document.getElementById('roster-search').addEventListener('input', renderRoster);
document.getElementById('audit-more').addEventListener('click', function(){ loadAudit(false); });

loadRoster();
loadAudit(true);
loadScope();
})();
</script>`;

  return shell(nonce, 'Help Scout MCP Admin', body, script);
}
