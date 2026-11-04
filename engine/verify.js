/* Verify (Phase 4, task 3): when a turn that carried a ticket ends and the rescan has landed, compare the map before and
   after on the ticket's scope, and the files touched against the files declared. Evidence moves the ticket:
   green → verified; red → back to in-work with the failure attached. A person still passes it before prod.

     before(project, ticketId)         snapshot of the scope taken when the turn starts (findings, red curves, tests)
     after(project, ticketId, before, touched, testReport)  the verdict, written to the ticket and (GitHub on) the issue

   What is judged, in the plan's words: findings down on the scope (not up), no new shape breaks, coverage not down, no new
   AI slop anywhere in the touched files, tests green, and the touched files against the declared list - an undeclared
   change and a declared-but-untouched file are findings on the ticket, not silent. */
'use strict';
const path = require('node:path');
const tickets = require('./tickets');

/* the checks as data: plugins/tickets/verdict.json - wording, on/off, blocks/warns, and the owner's own checks */
const VERDICT_FILE = path.join(__dirname, '..', 'plugins', 'tickets', 'verdict.json');
function checkDefs(p) {
  let defs = []; try { defs = (JSON.parse(require('node:fs').readFileSync(VERDICT_FILE, 'utf8')).checks || []).filter((c) => c.id); } catch (e) { return []; }
  if (!p) return defs;
  /* the project's overrides: blocks / on per check - a project being brought in warns where it is not ready yet */
  const ov = overrides(p);
  return defs.map((d) => (ov[d.id] ? { ...d, ...(ov[d.id].blocks !== undefined ? { blocks: !!ov[d.id].blocks } : {}), ...(ov[d.id].on !== undefined ? { on: !!ov[d.id].on } : {}), overridden: true } : d));
}
function overridesFile(p) { return path.join(p.cockpit.dir, 'plugins', 'tickets.verdict.json'); }
function overrides(p) { try { return JSON.parse(require('node:fs').readFileSync(overridesFile(p), 'utf8')) || {}; } catch (e) { return {}; } }
function setOverride(p, id, patch) {
  const fsx = require('node:fs'); const ov = overrides(p); ov[id] = { ...(ov[id] || {}), ...patch };
  const base = checkDefs().find((d) => d.id === id); if (base && (ov[id].blocks === undefined || ov[id].blocks === (base.blocks !== false)) && (ov[id].on === undefined || ov[id].on === (base.on !== false))) delete ov[id];   // back to the engine's: no override
  fsx.mkdirSync(path.dirname(overridesFile(p)), { recursive: true }); fsx.writeFileSync(overridesFile(p), JSON.stringify(ov, null, 2) + '\n');
  return ov;
}
const SLOP = new Set(['empty-catch', 'fake-success', 'todo-stub', 'debug-logging', 'commented-out-code', 'unbounded-query', 'uncapped-retry', 'type-escape', 'dead-route', 'duplicate-function', 'sql-string-built', 'raw-html-from-data', 'shell-with-input', 'path-from-input', 'open-redirect', 'eval-use', 'secret-in-code', 'input-reflected', 'format-drift']);
const SHAPE = new Set(['screen-touches-data', 'sql-in-action', 'data-reaches-up', 'cross-feature-write', 'action-calls-action', 'logic-serves-screen', 'skips-logic']);

function snapshot(p, files) {
  const db = p.db;
  const subjects = files.map((f) => db.get('SELECT subject FROM node WHERE file = ?', f)).filter(Boolean).map((r) => r.subject);
  const set = new Set(subjects);
  const problems = {}; let shape = 0, total = 0;
  for (const s of subjects) for (const t of db.all("SELECT value FROM tag WHERE subject = ? AND ns = 'problem'", s)) { problems[t.value] = (problems[t.value] || 0) + 1; total++; if (SHAPE.has(t.value)) shape++; }
  const tested = subjects.filter((s) => (db.get("SELECT value FROM tag WHERE subject = ? AND ns = 'tested'", s) || {}).value === 'yes').length;
  // red curves that start in the scope: edges from scope files flagged by a shape rule are counted through the problems above; the map's edge count is the structure
  const edges = subjects.reduce((n, s) => n + (db.get('SELECT COUNT(*) AS n FROM edge WHERE src = ?', s) || { n: 0 }).n, 0);
  return { at: new Date().toISOString(), files, subjects, problems, total, shape, tested, edges };
}
function before(p, ticketId) {
  const t = tickets.get(p, ticketId); if (!t) return null;
  return snapshot(p, [...(t.alter || []), ...(t.create || [])]);
}
/* THE TEST FAMILY - project-wide, the same list on every project: the project's tests, the flows,
   the app answering, the contract, DAST, the migration cycle, the sign-in, backup and restore. Each is measured from
   the latest test run (engine/tests.js), the latest DAST run (engine/dast.js) and the Problems tags the scan left;
   when nothing ran, the line says what is missing - a to-do, not a mystery. Also the Tests tab. */
/* the promote gate: every promote-gate check in verdict.json, measured now; [] when all hold */
function promoteGate(p) {
  let report = null; try { report = require('./hot').hot(path.join(__dirname, 'tests.js')).latest(p); } catch (e) { /* */ }
  const fam = family(p, report); const out = [];
  for (const d of checkDefs(p)) {
    if (d.gate !== 'promote' || d.on === false) continue;
    let ok = true, detail = '';
    if (d.kind === 'family') { const f = fam.find((x) => x.id === d.id); if (f) { ok = f.ok || !!f.na; detail = f.detail; } }   // not checked does not block; it is grey on the tab, never "holds"
    else if (d.kind === 'problem') { const rows = p.db.all("SELECT subject FROM tag WHERE ns = 'problem' AND value = ?", d.rule); ok = rows.length === 0; detail = ok ? d.rule + ' fires nowhere' : d.rule + ' on ' + rows.slice(0, 6).map((r) => String(r.subject).replace(/^(file|site|flow):/, '')).join(', '); }
    else if (d.kind === 'command') { try { require('node:child_process').execSync(d.command, { cwd: p.dir, encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); ok = true; detail = 'exit 0'; } catch (e) { ok = false; detail = 'exit ' + (e.status == null ? '?' : e.status) + ' - ' + String(e.stderr || e.stdout || e.message).trim().split(String.fromCharCode(10)).slice(-2).join(' | ').slice(0, 200); } }
    else if (d.kind === 'pattern') { ok = true; detail = 'a pattern check reads the files a turn touched - it belongs on the ticket, not at promote'; }
    if (!ok && d.blocks !== false) out.push({ id: d.id, name: d.name || d.id, detail });
  }
  return out;
}
/* The check each stage decides: a check whose stage is behind the run's is done and reads the run so far; the stage now is running; the rest wait. */
const STAGE_OF = { migrations: 'setup', tests: 'tests', app: 'app', contract: 'app', login: 'app', backup: 'restore', flows: 'finishing' };
function familyLive(p, report, prog) {
  if (!prog) return family(p, report);
  const stages = prog.stages || ['setup', 'tests', 'app', 'restore', 'finishing'];
  const at = stages.indexOf(prog.stage);
  // the run so far, laid over the last report: the stages it has passed are its own; the rest are still yesterday's
  const done = (st) => stages.indexOf(st) < at;
  const so = { ...(report || {}), at: prog.at, env: prog.env || (report || {}).env, command: prog.command };
  if (done('setup') && prog.setup !== undefined) so.setup = prog.setup;
  if (done('tests')) { so.files = prog.files; so.summary = prog.summary; }
  if (done('app')) { so.app = prog.app; so.probe = prog.probe; so.contract = prog.contract; so.signedIn = prog.signedIn; }
  if (done('restore')) so.restore = prog.restore;
  return family(p, so).map((f) => { const st = STAGE_OF[f.id]; if (!st) return f; const i = stages.indexOf(st); return { ...f, live: i < at ? 'done' : i === at ? 'running' : 'waiting', ...(f.id === 'tests' && i === at ? { done: prog.done, total: prog.total, current: prog.current } : {}) }; });
}
/* NOT CHECKED IS NOT GREEN (a project's Tests tab showed migrations, sign-in and backup as "holds" because
   each found nothing to look at - "no db/migrations folder" on a repo whose migrations live in packages/db/migrations).
   A line that measured nothing is na: grey "not checked" on the tab, never counted as holding, and it does not block. */
const MIGRATION_DIRS = ['db/migrations', 'migrations', 'database/migrations', 'prisma/migrations', 'supabase/migrations'];
function migrationsDir(p, sec) {
  const fsx = require('node:fs');
  if (sec && sec.migrations) return fsx.existsSync(path.join(p.dir, sec.migrations)) ? sec.migrations : null;
  for (const d of MIGRATION_DIRS) if (fsx.existsSync(path.join(p.dir, d))) return d;
  // a monorepo's: <workspace>/<package>/migrations or <package>/db/migrations, one or two folders down (e.g. packages/db/migrations)
  for (const top of ['packages', 'apps', 'services']) {
    let subs = []; try { subs = fsx.readdirSync(path.join(p.dir, top), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { continue; }
    for (const s of subs) for (const d of ['migrations', 'db/migrations']) if (fsx.existsSync(path.join(p.dir, top, s.name, d))) return top + '/' + s.name + '/' + d;
  }
  return null;
}
/* THE TESTS LINE FROM GITHUB: a project whose suite is written for CI - Linux with Docker - reads red
   forever on the Windows runner. `gate: github <workflow>` under ## Tests makes the line CI's answer for main: the newest
   finished run of that workflow that landed on main (a merge-queue run, or a push to main). Read at most every 5 minutes. */
const ciCache = new Map();
function ciOnMain(p, workflow) {
  const hit = ciCache.get(p.id + '|' + workflow); if (hit && Date.now() - hit.t < 5 * 60000) return hit.v;
  let v;
  try {
    const g = tickets.githubOf(p); if (!g) throw new Error('the GitHub plugin has no repo for this project');
    const gh = (args) => require('node:child_process').execFileSync('gh', args, { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, ...require('./ghauth').envFor(p) }, stdio: ['ignore', 'pipe', 'pipe'] });   // as tickets.js files with: the project's GitHub login
    const runs = JSON.parse(gh(['run', 'list', '-R', g.repo, '-w', workflow, '-L', '40', '--json', 'event,headBranch,status,conclusion,headSha,createdAt,url']));
    const main = g.branch || 'main';
    const r = runs.find((x) => x.status === 'completed' && x.conclusion !== 'cancelled' && x.conclusion !== 'skipped' && (x.event === 'merge_group' || (x.event === 'push' && x.headBranch === main)));
    v = r ? { ok: r.conclusion === 'success', detail: 'GitHub ' + workflow + ' on ' + main + ': ' + r.conclusion + ' · ' + String(r.headSha).slice(0, 7) + ' · ' + String(r.createdAt).slice(0, 16).replace('T', ' ') + ' (the gate for this suite; the Windows run is not the answer)', url: r.url } : { ok: false, detail: 'no finished ' + workflow + ' run on ' + main + ' in the last 40 runs' };
  } catch (e) { v = { ok: false, detail: 'GitHub ' + workflow + ' could not be read: ' + String(e.message).split('\n')[0].slice(0, 160) }; }
  ciCache.set(p.id + '|' + workflow, { t: Date.now(), v }); return v;
}
/* the name of a step in the project's workflow <name> (its .github/workflows file whose `name:` it is) matching re, or null */
function ciStep(p, workflow, re) {
  const fsx = require('node:fs'), wd = path.join(p.dir, '.github', 'workflows');
  let files = []; try { files = fsx.readdirSync(wd).filter((f) => /\.ya?ml$/i.test(f)); } catch (e) { return null; }
  for (const f of files) {
    let s = ''; try { s = fsx.readFileSync(path.join(wd, f), 'utf8'); } catch (e) { continue; }
    const nm = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(s); if (!nm || nm[1].trim() !== workflow) continue;
    for (const m of s.matchAll(/^\s*-\s*name:\s*["']?([^"'\r\n]+)/gm)) if (re.test(m[1])) return m[1].trim();
  }
  return null;
}
function family(p, report) {
  const fsx = require('node:fs'); const out = [];
  const add = (id, ok, detail, na) => out.push(na ? { id, ok: false, na: true, detail: 'not checked - ' + detail } : { id, ok: !!ok, detail });
  const probs = (rules) => { try { return p.db.all("SELECT subject, value, why FROM tag WHERE ns = 'problem' AND value IN (" + rules.map(() => '?').join(',') + ")", ...rules); } catch (e) { return []; } };
  const named = (rows) => rows.slice(0, 5).map((r) => r.value + ' on ' + String(r.subject).replace(/^(file|site|flow):/, '')).join('; ') + (rows.length > 5 ? ' …' : '');
  let sec = {}; try { sec = require('./hot').hot(path.join(__dirname, 'tests.js')).testsSection ? require('./hot').hot(path.join(__dirname, 'tests.js')).testsSection(p) : {}; } catch (e) { /* */ }
  const migDir = migrationsDir(p, sec);
  const hasDb = !!(report && report.env && report.env.db) || !!migDir || ((p.cockpit.json && p.cockpit.json.plugins) || []).includes('database');   // the Database plugin on = there is one
  // tests
  const gate = /^github\s+(.+)$/i.exec(String(sec.gate || '').trim());
  if (gate) { const ci = ciOnMain(p, gate[1].trim()); add('tests', ci.ok, ci.detail); }
  else if (!report) add('tests', false, 'no test run yet - the runner has not been through this project; Run tests on the Tests tab');
  else if (report.setup && report.setup.ok === false) add('tests', false, 'the test database setup failed: ' + String(report.setup.tail || '').trim().split('\n').slice(-1)[0].slice(0, 160));
  else if (!report.summary || !report.summary.total) add('tests', false, 'the project has no tests - none under test/ (*.test.js) and no command: under ## Tests in project.md. The first ticket is to write them.');
  else add('tests', report.summary.failed === 0, report.summary.passed + ' passed, ' + report.summary.failed + ' failed' + (report.summary.failed ? ': ' + report.files.filter((f) => f.ok === false).slice(0, 4).map((f) => f.file).join(', ') : '') + ' · ' + String(report.at).slice(0, 16).replace('T', ' '));
  // flows
  let flows = 0; try { flows = (p.db.get("SELECT COUNT(*) AS n FROM node WHERE subject LIKE 'flow:%'") || { n: 0 }).n; } catch (e) { /* */ }
  const fp = probs(['flow-without-test', 'flow-not-clicked', 'flow-failing', 'test-names-unknown-flow']);   // clicked through in a browser, too
  if (!flows) add('flows', false, 'no flows declared - under ## Flows in a feature README, one per line, and a test that names each; the map proves nothing it cannot name');
  else {
    /* skipped flows are said, never counted as proven: the line holds only when nothing failed or is
       missing; the skipped ones are named after it, grey on the map, with the test's own reason */
    const sk = probs(['flow-skipped']);
    const skNote = sk.length ? ' · ' + sk.length + ' skipped, NOT proven: ' + sk.slice(0, 3).map((x) => String(x.subject || x.s || '').replace(/^flow:/, '')).filter(Boolean).join(', ') + (sk.length > 3 ? ' +' + (sk.length - 3) : '') : '';
    add('flows', fp.length === 0, (fp.length ? named(fp) : (flows - sk.length) + ' of ' + flows + ' flow' + (flows === 1 ? '' : 's') + ' clicked through by a passing browser test') + skNote);
  }
  // the app answers
  if (!report || !report.app) add('app', false, 'the app was not started under the runner - add start: and url: under ## Tests in project.md, then Run tests');
  else if (report.app.skipped || !report.app.started) add('app', false, 'the app did not start: ' + (report.app.why || 'no start: under ## Tests'));
  else add('app', (report.probe || {}).routes > 0, report.probe ? report.probe.routes + ' routes probed' + (report.app.external ? ' (read-only: the site runs on its own database)' : report.app.database ? ' on ' + report.app.database + ' (declared disposable)' : '') + (report.probe.open ? ', ' + report.probe.open + ' open without a door' : '') : 'started, no routes probed');
  // contract
  const cb = probs(['contract-break']);
  if (!report || !report.contract) add('contract', false, 'no contract recorded - it is written from the routes the first time the app runs under the runner');
  else if (!(report.contract.breaks || []).length && !cb.length && !(report.contract.routes || report.contract.checked)) add('contract', false, 'the run compared no routes (' + (report.contract.first ? 'first run: the shapes were recorded, the next run compares them' : 'none of its GET doors answered with a shape') + ')', true);   // "0 routes match" read as holds (2026-09-28)
  else add('contract', !(report.contract.breaks || []).length && !cb.length, (report.contract.breaks || []).length ? (report.contract.breaks.length + ' break' + (report.contract.breaks.length === 1 ? '' : 's') + ': ' + report.contract.breaks.slice(0, 4).map((b) => b.route + ' ' + (b.what || '')).join('; ')) : (report.contract.routes || report.contract.checked || 0) + ' routes match the recorded shape');   // the runner counts them as `checked` (2026-09-29: 166 compared read as "none")
  // dast
  let dl = null; try { dl = require('./hot').hot(path.join(__dirname, 'dast.js')).latest(p); } catch (e) { /* */ }
  const dp = probs(['dast-high', 'dast-failed']);
  if (!dl) add('dast', false, 'no DAST run - Run DAST on the Tests tab (ZAP from Settings › Engine, and the app must answer at its url)');
  else if (!dl.ok) add('dast', false, 'the last DAST run did not finish: ' + (dl.why || '?'));
  else { const age = (Date.now() - Date.parse(dl.at)) / 864e5; const high = Number((dl.summary || {}).High || 0) || (dl.alerts || []).filter((a) => /high/i.test(a.risk || '')).length; add('dast', !high && age <= 7, high ? high + ' high-risk alert' + (high === 1 ? '' : 's') + (dp.length ? ': ' + named(dp) : '') : age > 7 ? 'last run ' + Math.round(age) + ' days ago - run it again' : 'clean, ' + String(dl.at).slice(0, 10)); }
  // migrations
  if (!migDir) add('migrations', false, 'no migrations folder found (looked in ' + MIGRATION_DIRS.join(', ') + ' and packages/apps/services/*/[db/]migrations; name another with migrations: under ## Tests)', true);
  /* THE CYCLE FROM GITHUB: a project's CI may already roll every migration back and re-apply it in a throwaway
     database (a step named like "Migration rollback round trip"), and require a .down.sql for each. When the gated workflow has
     such a step, the migrations line is CI's answer on main - the same run the tests line reads. */
  else if (gate && (!report || !report.setup) && ciStep(p, gate[1].trim(), /rollback[^\n]*(round|cycle)|round[ -]?trip[^\n]*migrat|migrat[^\n]*(round[ -]?trip|down and up|up.{0,5}down)/i)) { const ci = ciOnMain(p, gate[1].trim()); add('migrations', ci.ok, 'up, down and up again in GitHub CI (step "' + ciStep(p, gate[1].trim(), /rollback[^\n]*(round|cycle)|round[ -]?trip[^\n]*migrat|migrat[^\n]*(round[ -]?trip|down and up|up.{0,5}down)/i) + '"): ' + ci.detail.replace(/^GitHub [^:]+: /, '').replace(/ \(the gate for this suite.*$/, '')); }
  else if (!report || !report.setup) add('migrations', false, migDir + ' is not cycled - the runner cycles the migrations up and down on the test database (setup: under ## Tests, default test/setup-db.js)');
  else add('migrations', report.setup.ok !== false && !probs(['migration-cycle-failed']).length, report.setup.ok === false ? 'the cycle failed: ' + String(report.setup.tail || '').trim().split('\n').slice(-1)[0].slice(0, 160) : 'up and down clean');
  // sign-in
  const lp = probs(['login-failed', 'door-refuses-user']);
  const doors = report && report.probe ? report.probe.routes : 0, noAuth = !!(report && report.probe && report.probe.noAuthAtAll);   // nothing refused anyone: the site has no login to prove
  if (!doors && !noAuth) add('login', false, 'the app has not been probed under the runner, so no door and no sign-in were tried (start: and url: under ## Tests)', true);
  else if (!report || !report.signedIn) add('login', noAuth, noAuth ? 'no door refuses anyone - the site has no login' : 'no sign-in declared - login: and user: under ## Tests, so doors behind a login are proven');
  else if (report.signedIn.skipped) add('login', noAuth, noAuth ? 'no door refuses anyone - the site has no login' : report.signedIn.why);
  else add('login', report.signedIn.ok !== false && !lp.length, report.signedIn.ok === false ? 'the sign-in failed: ' + (report.signedIn.why || '') : lp.length ? named(lp) : 'signed in, doors answer as declared');
  // backup and restore
  const bp = probs(['backup-none', 'backup-stale', 'backup-folder-missing', 'backup-undeclared', 'restore-failed', 'restore-unproven']);
  /* A PRODUCTION DRILL: ## Backup `by:` names who keeps the real
     backups (a managed database), `drill:` the JSON a scheduled drill writes after restoring a full copy of production
     into a scratch database and comparing every table's rows ({ at, ok, tables, rows, missing, drift, why }). Green while
     the newest drill passed and is at most 35 days old. */
  let bkx = {}; try { bkx = require('./hot').hot(path.join(__dirname, 'tests.js')).backupSection(p); } catch (e) { /* */ }
  if (bkx.drill) {
    let d = null; try { d = JSON.parse(fsx.readFileSync(bkx.drill, 'utf8').replace(/^﻿/, '')); } catch (e) { /* none yet */ }
    const age = d && d.at ? (Date.now() - Date.parse(d.at)) / 864e5 : null, by = bkx.by ? bkx.by + '; ' : '';
    if (!d) add('backup', false, by + 'no production restore drill has run yet (' + bkx.drill + ')');
    else if (!d.ok) {
      const off = [].concat(d.drift || []).filter((x) => x && !x.moving).map((x) => x.table + ' ' + x.restored + ' of ' + x.production + ' rows');
      add('backup', false, by + 'the restore drill of ' + String(d.at).slice(0, 10) + ' FAILED: ' + (d.why || [(d.restore_errors ? d.restore_errors + ' restore error(s)' : ''), ((d.missing || []).length ? [].concat(d.missing).length + ' table(s) missing after restore' : ''), (off.length ? 'rows differ in ' + off.slice(0, 3).join('; ') + (off.length > 3 ? ' +' + (off.length - 3) : '') : '')].filter(Boolean).join(', ') || 'see drill.log'));
    }
    else if (age > 35) add('backup', false, by + 'the last restore drill was ' + Math.round(age) + ' days ago (' + String(d.at).slice(0, 10) + ') - it runs monthly');
    else add('backup', true, by + 'restore drill ' + String(d.at).slice(0, 10) + ': a full copy of production restored, ' + d.tables + ' tables / ' + d.rows + ' rows matched' + ((d.drift || []).length ? ' (' + d.drift.length + ' table(s) moving on production during the drill)' : ''));
  }
  else if (!hasDb) add('backup', false, 'no database found (no migrations folder, no test database, Database plugin off)', true);
  else if (sec.backup) add('backup', false, 'backed up outside the runner, by the project\'s word: ' + sec.backup + ' - no restore drill here', true);
  else if (!report || !report.restore) { const has = fsx.existsSync(path.join(p.dir, 'scripts', 'backup.js')) && fsx.existsSync(path.join(p.dir, 'scripts', 'restore.js')); add('backup', false, has ? 'no restore drill yet - Run tests; it drills on the *_test database' : 'no scripts/backup.js and scripts/restore.js - the drill backs up and restores the *_test database with them and diffs the two'); }
  else if (!report || !report.restore) add('backup', false, 'no restore drill - scripts/backup.js and scripts/restore.js, and a *_test database to drill on');
  else if (report.restore.skipped) add('backup', false, report.restore.why);
  else add('backup', report.restore.ok !== false && !bp.length, report.restore.ok === false ? 'the drill failed at ' + report.restore.step + ': ' + (report.restore.why || '') : bp.length ? named(bp) : 'backup and restore proven on ' + report.restore.tables + ' tables' + (report.restore.declared ? ' (on ' + report.restore.declared + ', declared disposable)' : ''));
  return out;
}

/* WHERE THE CODE'S GIT IS. Most projects are their repo; some hold it one folder down - a workshop folder (scripts, notes)
   with the repo in my-app\ - and a ticket names its files from the project folder (my-app/apps/...).
   Git run in the project folder there answered "not a git repository", so every turn read red on committed and untouched
   whatever the work. One subfolder holding .git is the code; its name is the prefix
   between the ticket's paths and git's. */
function repoOf(p) {
  const fsx = require('node:fs');
  if (fsx.existsSync(path.join(p.dir, '.git'))) return { dir: p.dir, prefix: '' };
  try {
    const subs = fsx.readdirSync(p.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && fsx.existsSync(path.join(p.dir, e.name, '.git')));
    if (subs.length === 1) return { dir: path.join(p.dir, subs[0].name), prefix: subs[0].name + '/' };
  } catch (e) { /* unreadable: the project folder */ }
  return { dir: p.dir, prefix: '' };
}
function after(p, ticketId, prior, touched, testReport, turn, opts) {
  const dry = !!(opts && opts.dry);   // the coder's own look before it ends the turn (ticket check): the checks, nothing written, nothing moved
  const t = tickets.get(p, ticketId); if (!t) return null;
  const files = [...(t.alter || []), ...(t.create || []), ...(t.delete || [])];
  const now = snapshot(p, files);
  /* the "before": this turn's snapshot when there is one, else the ticket's baseline from when its work began, else (an older
     ticket) the first verdict's totals. Without a before, shape demanded ZERO breaks and slop counted every finding on the files
     - problems older than the ticket read as the ticket's (2026-09-21 morning: L4, L5, L6, L39 red on 'shape: 1' at re-verify). */
  if (!prior) prior = t.baseline || null;
  if (!prior) { const v0 = (t.verdicts || []).find((v) => v.before); if (v0) prior = { total: v0.before.total, shape: v0.before.shape, tested: v0.before.tested, problems: {} }; }
  const norm = (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '');
  const touchedRel = [...new Set((touched || []).map((f) => norm(path.isAbsolute(f) ? path.relative(p.dir, f) : f)))].filter((f) => !f.startsWith('..') && !f.startsWith('.cockpit/'));
  const declared = new Set(files.map(norm));
  const undeclared = touchedRel.filter((f) => !declared.has(f));
  /* Cockpit's own folder is not judged: a touch there is never recorded (above) and its files are not required committed -
     a .cockpit/project.md declared on a ticket read "untouched" and "not committed" forever. */
  const judged = files.map(norm).filter((f) => !f.startsWith('.cockpit/'));
  /* "touched" for the untouched check is every touch the ticket has had, not this turn's alone: earlier turns' (t.touched), and what
     git shows changed since the work began (a file moved by a shell command, a commit from a previous try). 2026-09-20 night: 36 of
     60 red checks were "untouched" on tickets whose work was done a turn earlier - the fleet gave up on six of them for nothing. */
  const R = repoOf(p);
  const gitTouched = (() => {
    const out = new Set();
    try {
      const run = (args) => require('node:child_process').execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args], { cwd: R.dir, encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      if (t.startSha) run(['diff', '--name-only', t.startSha, 'HEAD']).split(/\r?\n/).forEach((f) => { if (f.trim()) out.add(norm(R.prefix + f.trim())); });
      else if (t.created) run(['log', '--since=' + t.created, '--name-only', '--pretty=format:']).split(/\r?\n/).forEach((f) => { if (f.trim()) out.add(norm(R.prefix + f.trim())); });   // a ticket from before startSha was recorded: every commit since it was filed
      run(['status', '--porcelain']).split(/\r?\n/).forEach((l) => { const f = l.slice(3).trim().replace(/^"|"$/g, ''); if (f) out.add(norm(R.prefix + f.split(' -> ').pop())); });
    } catch (e) { /* not a git repo, or no start recorded: this turn's touches alone */ }
    return out;
  })();
  const everTouched = new Set([...touchedRel, ...((t.touched || []).map(norm)), ...gitTouched]);
  (t.delete || []).map(norm).forEach((f) => { if (!require('node:fs').existsSync(path.join(p.dir, f))) everTouched.add(f); });   // a declared delete that is gone was done (an untracked file leaves git no trace)
  const untouched = judged.filter((f) => !everTouched.has(f) && !(f.endsWith('/') && [...everTouched].some((x) => x.startsWith(f))));
  /* A FILE GONE THAT THE TICKET DID NOT NAME (doctrine: delete-only-what-you-declared). git says what is deleted since the
     work began - staged, unstaged or committed; a delete the ticket declared is the work, anything else is an accident with
     a whole directory behind it (2026-09-22: `rm -rf` took 97 test files no ticket asked for, on a ticket about something
     else). The turn's own files are not the measure here: a deletion leaves nothing to touch. */
  const deletedNotDeclared = (() => {
    const out = new Set(); const declaredDel = new Set((t.delete || []).map(norm));
    try {
      const run = (args) => require('node:child_process').execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args], { cwd: R.dir, encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const CR = String.fromCharCode(13), NL = String.fromCharCode(10);
      const lines = (s) => String(s).split(NL).map((x) => x.replace(CR, ''));
      if (t.startSha) lines(run(['diff', '--name-only', '--diff-filter=D', t.startSha, 'HEAD'])).forEach((f) => { if (f.trim()) out.add(norm(R.prefix + f.trim())); });
      lines(run(['status', '--porcelain'])).forEach((l) => { if (/^( D|D |AD|MD)/.test(l)) { const f = l.slice(3).trim().replace(/^"|"$/g, ''); if (f) out.add(norm(R.prefix + f)); } });
    } catch (e) { /* not a git repo: nothing to read */ }
    return [...out].filter((f) => !declaredDel.has(f) && !f.startsWith('.cockpit/'));
  })();
  /* each check by its id, measured here; the wording, the switch and blocks/warns come from verdict.json */
  const defs = checkDefs(p); const checks = [];
  const risen = prior ? Object.keys(now.problems).filter((k) => (now.problems[k] || 0) > (prior.problems[k] || 0)) : [];
  const measure = {
    findings: () => [prior ? now.total <= prior.total : true, (prior ? prior.total + ' → ' : '') + now.total + (prior && now.total > prior.total ? ' - up: ' + risen.slice(0, 6).join(', ') : '')],
    shape: () => [prior ? now.shape <= prior.shape : now.shape === 0, (prior ? prior.shape + ' → ' : '') + now.shape + (risen.filter((k) => SHAPE.has(k)).length ? ' - ' + risen.filter((k) => SHAPE.has(k)).join(', ') : '')],
    coverage: () => [prior ? now.tested >= prior.tested : true, (prior ? prior.tested + ' → ' : '') + now.tested + ' of ' + now.subjects.length + ' files named by a passing test'],
    slop: () => { const slopNow = []; for (const f of touchedRel) { const n = p.db.get('SELECT subject FROM node WHERE file = ?', f); if (!n) continue; for (const g of p.db.all("SELECT value, why FROM tag WHERE subject = ? AND ns = 'problem'", n.subject)) if (SLOP.has(g.value) && !(prior && prior.problems[g.value] && declared.has(f))) slopNow.push(f + ': ' + g.value); } return [slopNow.length === 0, slopNow.length ? slopNow.slice(0, 8).join('; ') : 'clean']; },
    tests: () => testReport ? [(testReport.summary || {}).failed === 0 && !(testReport.setup && testReport.setup.ok === false), (testReport.summary ? testReport.summary.passed + ' passed, ' + testReport.summary.failed + ' failed' : 'no summary') + (testReport.setup && testReport.setup.ok === false ? ' - setup failed' : '') + (testReport.failed && testReport.failed.length ? ': ' + testReport.failed.slice(0, 5).map((x) => x.name || x).join(', ') : '')] : [false, 'no test run landed after the turn'],
    committed: () => { try {
      /* only the ticket's files and the turn's touched files are judged - never the whole repository: with an empty list git
         status would read everything, and L47 went red three times on junk nobody's (a reserved-name `nul`, tmp_check.ps1) */
      // in the repo's own terms: the prefix off (a file outside the code folder - the workshop's own scripts - is not git's to judge)
      const paths = [...new Set([...judged, ...touchedRel])].filter((f) => !/^\.cockpit\//.test(f) && !/^(nul|con|prn|aux|com\d|lpt\d)$/i.test(f) && f.startsWith(R.prefix)).map((f) => f.slice(R.prefix.length));
      if (!paths.length) return [true, 'nothing to judge - the ticket names no files and the turn touched none'];
      const st = require('node:child_process').execSync('git -c safe.directory=* -c core.quotepath=off status --porcelain -- ' + paths.map((f) => '"' + f + '"').join(' '), { cwd: R.dir, encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '');   // trimEnd only: a leading space is the porcelain status column (a whole-trim ate it and the detail said 'est/site.smoke.test.js')
      const dirty = st ? st.split('\n').map((l) => R.prefix + l.slice(3).trim().replace(/^"|"$/g, '')).filter((f) => f !== R.prefix && !/^\.cockpit\//.test(f)) : [];
      return [dirty.length === 0, dirty.length ? 'not committed: ' + dirty.slice(0, 8).join(', ') : 'all committed']; } catch (e) { return [/not a git repository/i.test(e.message + (e.stderr || '')) ? false : true, /not a git repository/i.test(e.message + (e.stderr || '')) ? 'not a git repository - the promote is git; git init and commit' : 'git could not be read: ' + String(e.message).split('\n')[0].slice(0, 120)]; } },
    declared: () => [undeclared.length === 0, undeclared.length ? 'undeclared: ' + undeclared.slice(0, 10).join(', ') : touchedRel.length + ' touched, all declared'],
    deleted: () => [deletedNotDeclared.length === 0, deletedNotDeclared.length ? deletedNotDeclared.length + ' file' + (deletedNotDeclared.length === 1 ? '' : 's') + ' gone that the ticket does not name: ' + deletedNotDeclared.slice(0, 8).join(', ') + ' - put them back (git checkout -- <path>) or declare them under --delete' : 'nothing deleted that the ticket did not name'],
    untouched: () => [untouched.length === 0, untouched.length ? 'declared but untouched: ' + untouched.slice(0, 10).join(', ') : 'all ' + judged.length],
    /* the ticket's flow, clicked through: a *.browser.test.js naming that flow (@flow, the map's 'proves' edge) passed in the
       latest run. --flow none (with the reason on the ticket) is the one way past it: a change no person can see. */
    flow: () => {
      if (t.flow === undefined) return [true, 'filed before the flow rule (2026-09-21) - not judged; the next ticket on this feature names its flow'];
      const names = String(t.flow || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);   // a ticket per feature names SEVERAL flows (L53, L55 were red for that)
      if (!names.length) return [false, 'the ticket names no flow - draft with --flow <name[,name…]> (README flows), or --flow none and say why on the ticket'];
      if (names.length === 1 && /^none$/i.test(names[0])) return [true, 'no flow, by the ticket\'s own word'];
      const rep = testReport || require('./hot').hot(path.join(__dirname, 'tests.js')).latest(p);
      const isBrowser = (f) => /\.browser\.(test|spec)\.[cm]?js$/i.test(f || '');
      const bad = [], good = [];
      for (const fl of names) {
        const subj = (p.db.get("SELECT subject FROM node WHERE kind = 'flow' AND (subject = ? OR subject LIKE ? OR LOWER(title) = LOWER(?))", 'flow:' + fl, 'flow:%/' + fl.toLowerCase().replace(/[^a-z0-9]+/g, '-'), fl) || {}).subject;
        if (!subj) { bad.push(fl + ': no README defines it - add it under ## Flows first'); continue; }
        const provers = p.db.all("SELECT n.file FROM edge e JOIN node n ON n.subject = e.src WHERE e.dst = ? AND e.kind = 'proves'", subj).map((r) => r.file).filter(isBrowser);
        if (!provers.length) { bad.push(fl + ': no browser test names it (test/<feature>.' + fl + '.browser.test.js)'); continue; }
        const ran = (rep && rep.files || []).filter((f) => provers.includes(f.file));
        if (!ran.length) { bad.push(fl + ': ' + provers.join(', ') + ' has not run yet'); continue; }
        const red = ran.filter((f) => f.ok === false);
        if (red.length) bad.push(fl + ': red - ' + red.map((f) => f.file + (f.shot ? ' (screenshot ' + f.shot + ')' : '')).join(', ')); else good.push(fl);
      }
      return [bad.length === 0, bad.length ? bad.slice(0, 6).join(' · ') : names.length + ' flow' + (names.length === 1 ? '' : 's') + ' clicked through, green (' + good.join(', ') + ')'];
    }
  };
  /* the owner's own checks: a Problems rule that must not fire on the ticket's files, a command that must exit 0, a
     pattern that must not appear in the touched files */
  const custom = (d) => {
    if (d.kind === 'problem') { const hits = []; for (const f of [...new Set([...files.map(norm), ...touchedRel])]) { const n = p.db.get('SELECT subject FROM node WHERE file = ?', f); if (n && p.db.get("SELECT 1 FROM tag WHERE subject = ? AND ns = 'problem' AND value = ?", n.subject, d.rule)) hits.push(f); } return [hits.length === 0, hits.length ? d.rule + ' on ' + hits.slice(0, 8).join(', ') : d.rule + ' fires nowhere on the ticket\'s files']; }
    if (d.kind === 'command') { try { const out = require('node:child_process').execSync(d.command, { cwd: p.dir, encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); return [true, 'exit 0' + (out.trim() ? ' - ' + out.trim().split('\n').pop().slice(0, 160) : '')]; } catch (e) { return [false, 'exit ' + (e.status == null ? '?' : e.status) + ' - ' + String((e.stderr || e.stdout || e.message)).trim().split('\n').slice(-3).join(' | ').slice(0, 300)]; } }
    if (d.kind === 'pattern') { let re; try { re = new RegExp(d.pattern, 'm'); } catch (e) { return [false, 'the pattern is not a valid regular expression: ' + e.message]; } const hits = []; for (const f of touchedRel) { try { if (re.test(require('node:fs').readFileSync(path.join(p.dir, f), 'utf8'))) hits.push(f); } catch (e) { /* deleted */ } } return [hits.length === 0, hits.length ? 'found in ' + hits.slice(0, 8).join(', ') : 'not in any touched file']; }
    return [true, 'unknown kind ' + d.kind + ' - not checked'];
  };
  let fam = null;
  for (const d of defs) {
    if (d.on === false || d.gate === 'promote') continue;   // the environment gates the promote, not the turn
    let r; try {
      if (d.kind === 'family') { if (!fam) fam = family(p, testReport); const f = fam.find((x) => x.id === d.id); r = f ? [f.ok || !!f.na, f.detail] : [true, 'no such family check']; }
      else r = d.kind === 'builtin' ? (measure[d.id] ? measure[d.id]() : [true, 'no such built-in check']) : custom(d);
    } catch (e) { r = [false, 'the check itself failed: ' + e.message]; }
    checks.push({ id: d.id, name: d.name || d.id, ok: !!r[0], detail: r[1], blocks: d.blocks !== false, asks: d.asks || '', fix: d.fix || '' });
  }
  if (!defs.length) checks.push({ id: 'none', name: 'no checks defined', ok: false, detail: 'plugins/tickets/verdict.json is missing or empty', blocks: true });
  const green = checks.every((c) => c.ok || !c.blocks);
  const verdict = { at: new Date().toISOString(), turn: turn || null, green, checks, touched: touchedRel, undeclared, untouched, before: prior ? { total: prior.total, shape: prior.shape, tested: prior.tested } : null, after: { total: now.total, shape: now.shape, tested: now.tested } };
  if (dry) return { verdict, text: (green ? 'green - end the turn' : 'RED - not yet') + '\n' + checks.map((c) => '- ' + (c.ok ? '✓' : c.blocks ? '✗' : '⚠') + ' ' + c.name + ': ' + c.detail).join('\n'), red: checks.filter((c) => !c.ok && c.blocks).map((c) => c.id), moved: null };
  t.verdicts = (t.verdicts || []).concat(verdict); t.touched = [...new Set((t.touched || []).concat(touchedRel))];
  tickets.save(p, t);
  const text = (green ? '✅ **verified** by Cockpit' : '❌ **not verified** - back to in-work') + '\n' + checks.map((c) => '- ' + (c.ok ? '✓' : c.blocks ? '✗' : '⚠') + ' ' + c.name + ': ' + c.detail).join('\n');
  let moved = null;
  const red = checks.filter((c) => !c.ok && c.blocks).map((c) => c.id);
  const ref = t.number ? '#' + t.number : t.id;
  /* ONLY A PERSON VERIFIES: on a GitHub project Cockpit's green is a note in the ticket's history, not
     a move - it had marked #4101 "verified" while GitHub still had it open and untested */
  if (green && t.state === 'in-work' && tickets.githubOf(p)) tickets.log(p, t.id, 'Cockpit checks green - ' + checks.length + ' checks');
  else if (green && t.state === 'in-work') moved = tickets.setState(p, t.id, 'verified', 'cockpit', text);
  else if (!green && t.state === 'in-work') {
    tickets.comment(p, t.id, text);
    /* said, not silent (2026-09-20: L5 and L6 came back red after queued turns and nobody was told - the queue said "done") */
    try { require('./events').record(p, { kind: 'ticket.red', level: 'warn', title: ref + ' came back red: ' + red.join(', ') + ' - ' + t.title.replace(/^(#\d+|L\d+):\s*/, ''), text: checks.filter((c) => !c.ok && c.blocks).map((c) => c.name + ': ' + c.detail).join(' · ').slice(0, 400), ref: String(t.id), source: 'verify' }); } catch (e) { /* */ }
  }
  else if (!green && t.state === 'verified') moved = tickets.setState(p, t.id, 'in-work', 'cockpit', text);
  return { verdict, text, red, moved: moved && moved.ok ? moved.ticket.state : null };
}

module.exports = { familyLive, snapshot, before, after, repoOf, family, promoteGate, checkDefs, overrides, setOverride, VERDICT_FILE, SLOP, SHAPE };
