/* Cockpit's test runner (docs/plan-verification-and-tickets.md, Phase 3). Runs a project's tests in its folder,
   one run at a time per project, and keeps the report so the map can say what a passing test proves.

   What runs: every test file the project has - test/**, __tests__/**, *.test.* and *.spec.* - each on its own with
   node --test (JavaScript) so a file's pass/fail is its exit code, reporter-independent. A file another runner
   owns (.ts under vitest/jest) is listed as "needs the project's runner" until the project's rules name a command
   (`## Tests` in project.md: `command: <what to run>` - then that runs instead, once, and only the summary is
   known). Environment: NODE_ENV=test, COCKPIT_TEST=1, and <NAME>_ENV=test / DB_NAME=<name>_test where the
   project's .env.example shows those keys - the test database convention. Never the dev database.

   Report: .cockpit\tests\<stamp>.json and latest.json - { at, ms, files: [{ file, ok, ms, skipped, tail }],
   summary }. The scan reads latest.json: `tested` becomes "a test that PASSED names it", a flow is proven only
   when its test passed, and a failing test file is a finding. Hot module. */
'use strict';
/* The sites the runner and DAST reach are often on the owner's own network under local names (my-app-dev.local), served by a
   local proxy with its own certificate authority. Certificate checks stay ON: name that authority's root in COCKPIT_EXTRA_CA
   (or engine.json "extraCa") and it is trusted in addition (engine/config.js applyTls, once per process). */
require('./config').applyTls(require('node:path').join(__dirname, '..'));
const fs = require('node:fs');
/* the AI's login for a project's site, kept outside every repository: <secretsDir>\<project id>\look-login.json (engine/config.js) */
const lookLogin = (id) => require('node:path').join(require('./config').secretsDir(require('node:path').join(__dirname, '..')), id, 'look-login.json');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const running = new Map();   // project id -> { started }

function dir(project) { return path.join(project.cockpit.dir, 'tests'); }
function latest(project) { try { return JSON.parse(fs.readFileSync(path.join(dir(project), 'latest.json'), 'utf8')); } catch (e) { return null; } }
/* Where a run is, while it runs: the stage now - setup, tests (done of total, the file), app, restore, finishing - and every result the run
   has so far, so the Tests tab can show each line as its stage lands. Written at every step; gone when the report lands. */
const STAGES = ['setup', 'tests', 'sast', 'app', 'restore', 'finishing'];
function progressFile(project) { return path.join(dir(project), 'progress.json'); }
function progress(project) { try { return JSON.parse(fs.readFileSync(progressFile(project), 'utf8')); } catch (e) { return null; } }
function noteProgress(project, report, stage, extra) {
  const files = report.files || [], counts = { total: files.length, passed: files.filter((f) => f.ok === true).length, failed: files.filter((f) => f.ok === false).length, skipped: files.filter((f) => f.skipped).length };
  const snap = { at: report.at, now: new Date().toISOString(), stage, stages: STAGES, ...(extra || {}), files, summary: counts, setup: report.setup, app: report.app, probe: report.probe, contract: report.contract, signedIn: report.signedIn, restore: report.restore, env: report.env, command: report.command };
  try { fs.mkdirSync(dir(project), { recursive: true }); fs.writeFileSync(progressFile(project), JSON.stringify(snap) + '\n'); } catch (e) { /* the run goes on without it */ }
  const rec = running.get(project.entry.id); if (rec) { rec.stage = stage; rec.extra = extra || null; }
}

function walk(root, rel, out, skip) {
  let ents; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (skip.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(root, r, out, skip); else out.push(r);
  }
}
function testFiles(project) {
  const skip = new Set(['.cockpit', '.coders', '.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.turbo']);
  const all = []; walk(project.dir, '', all, skip);
  // a test file: named *.test.* / *.spec.*, or a code file directly under a test / tests / __tests__ folder; helpers, fixtures, mocks and setup are not tests
  return all.filter((r) => /\.[cm]?[jt]sx?$/i.test(r) && (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(r) || /(^|\/)(tests?|__tests__)\/[^/]+\.[cm]?[jt]sx?$/i.test(r)))
    .filter((r) => !/(^|\/)(helpers?|fixtures?|mocks?|__mocks__)\//i.test(r) && !/(^|\/)(setup|helpers?|fixtures?)\.[cm]?[jt]sx?$/i.test(r) && !/\.d\.ts$/.test(r))
    .filter((r) => !/\.browser\.(test|spec)\.[cm]?[jt]sx?$/i.test(r))   // browser tests run in the app stage, once the app is up
    .sort();
}
/* WHICH FLOWS: a project folder once sat on an old coder branch, so the 16 flows merged the day before
   never ran - only the 4 that branch had. When the flows click a site that is DEPLOYED (url: under ## Tests - it runs main,
   not this folder), they come from the same current-main copy the map reads (.cockpit/cache/mainline, kept by the scan).
   A site started from the folder (start: / server.js) is clicked with the folder's own flows. */
function flowDir(project) {
  const ml = path.join(project.dir, '.cockpit', 'cache', 'mainline');
  return testsSection(project).url && fs.existsSync(path.join(ml, '.git')) ? ml : project.dir;
}
function browserFiles(project, from) {
  const skip = new Set(['.cockpit', '.coders', '.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.turbo']);
  const all = []; walk(from || project.dir, '', all, skip);
  return all.filter((r) => /\.browser\.(test|spec)\.[cm]?js$/i.test(r)).sort();
}

/* the project's rules may shape the run: under `## Tests` in .cockpit/project.md -
     command: <runs instead of node --test per file>    setup: <runs first; default test/setup-db.js when it exists>
     scoped: <runs instead of command AFTER A TURN, with {packages} = the packages its files touched>
     start: <starts the app for the probe / contract stages>    url: <where it answers>   (start / url: later stages)
     database: <name>   the database the tests MAY write to - the rule is a *_test one, and this is the only way past it:
                        a project whose dev database is a sandbox says so here, and every report records it */
function testsSection(project) {
  const out = {};
  try {
    const md = fs.readFileSync(path.join(project.cockpit.dir, 'project.md'), 'utf8');
    const sec = /^##\s+Tests\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md); if (!sec) return out;
    for (const k of ['command', 'setup', 'start', 'url', 'public', 'budget', 'login', 'user', 'database', 'scoped', 'gate', 'migrations', 'backup']) { const m = new RegExp('^\\s*(?:-\\s*)?' + k + ':\\s*(.+)$', 'im').exec(sec[1]); if (m) out[k] = m[1].trim(); }
  } catch (e) { /* no rules */ }
  return out;
}
/* WHAT THE RUNNER SAID, READ (for a monorepo whose real answer was 3 tests of 351
   in one package of eight - and the report kept only the last few thousand characters, so two of five failures could
   not be seen at all). One command is still one file line, but its failures are pulled out and kept whole, and the
   runner's own counts are recorded, so the tab, the verdict and the AI read the truth without re-running anything. */
function readRunner(out) {
  const clean = String(out || '').replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/);
  const seen = new Set(), failures = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim();
    const m = /(?:^|\s)(?:FAIL|✕|×|✗)\s+(.+)$/.exec(L) || /^not ok \d+ - (.+)$/.exec(L);
    if (!m) continue;
    const what = m[1].replace(/^\S+:test:\s*/, '').trim().slice(0, 300);
    if (!what || seen.has(what)) continue;
    seen.add(what);
    // the reason: the first assertion or error line under it
    let whyLine = null;
    for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) { const c = lines[k].replace(/^\S+:test:\s*/, '').trim(); if (/(Error|expected|Expected|AssertionError|Cannot find|ENOENT)/.test(c)) { whyLine = c.slice(0, 300); break; } }
    failures.push({ what, why: whyLine });
    if (failures.length >= 60) break;
  }
  const counts = {};
  const n = (re) => { let last = null; for (const L of lines) { const m2 = re.exec(L.replace(/^\S+:test:\s*/, '').trim()); if (m2) last = m2; } return last; };
  const t = n(/^Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*(?:\((\d+)\))?/);
  if (t) counts.tests = { failed: Number(t[1] || 0), passed: Number(t[2] || 0), skipped: Number(t[3] || 0), total: Number(t[4] || 0) || (Number(t[1] || 0) + Number(t[2] || 0)) };
  const f = n(/^Test Files\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*(?:\((\d+)\))?/);
  if (f) counts.files = { failed: Number(f[1] || 0), passed: Number(f[2] || 0), total: Number(f[3] || 0) };
  const k = n(/^Tasks:\s+(\d+)\s+successful,\s+(\d+)\s+total/);
  if (k) counts.packages = { ran: Number(k[1]), total: Number(k[2]), notRun: Number(k[2]) - Number(k[1]) };
  const p2 = n(/^#\s*pass\s+(\d+)/), f2 = n(/^#\s*fail\s+(\d+)/);
  if (!counts.tests && (p2 || f2)) counts.tests = { failed: Number((f2 || [])[1] || 0), passed: Number((p2 || [])[1] || 0), skipped: 0, total: Number((p2 || [])[1] || 0) + Number((f2 || [])[1] || 0) };
  return { failures, counts, text: clean };
}
function projectCommand(project) { return testsSection(project).command || null; }
/* AFTER A TURN, ONLY WHAT THE TURN TOUCHED. Cockpit used to run a whole monorepo's suite on a machine the suite was never
   written for, then call the result red.
   A project may name a scoped command under ## Tests:
       scoped: pnpm turbo test --filter={packages}
   {packages} becomes the workspace packages the turn's files belong to (the nearest package.json above each file),
   each prefixed by --filter= if the template holds one, so a turn that touched one app runs that app's tests in seconds
   instead of the repository's in minutes. No `scoped:` line, or a turn that touched nothing a package owns: the full
   command runs, as before. The whole suite still runs on a full run and before a promote. */
function scopedCommand(project) { return testsSection(project).scoped || null; }
function packagesFor(project, files) {
  const out = new Set();
  for (const f of files || []) {
    let rel = String(f).replace(/\\/g, '/'); if (path.isAbsolute(rel)) rel = path.relative(project.dir, rel).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue;
    let dir2 = path.posix.dirname(rel);
    while (dir2 && dir2 !== '.' && dir2 !== '/') {
      try { const j = JSON.parse(fs.readFileSync(path.join(project.dir, dir2, 'package.json'), 'utf8')); if (j && j.name) { out.add(j.name); break; } } catch (e) { /* not a package here */ }
      dir2 = path.posix.dirname(dir2);
    }
  }
  return [...out];
}
/* the command for this run: the scoped one when a light run knows what was touched and the packages are found */
function commandFor(project, opts) {
  const full = projectCommand(project);
  if (!(opts && opts.light) || !full) return { cmd: full, scope: null };
  const tmpl = scopedCommand(project); if (!tmpl) return { cmd: full, scope: null };
  const pkgs = packagesFor(project, (opts && opts.files) || []);
  if (!pkgs.length) return { cmd: full, scope: null };
  const joined = /--filter=\{packages\}/.test(tmpl) ? pkgs.join(' --filter=') : pkgs.join(' ');
  return { cmd: tmpl.replace('{packages}', joined), scope: pkgs };
}
/* the database the project declared the tests may write to (## Tests database:) - null when it did not */
function disposableDb(project) { const d = String(testsSection(project).database || '').trim(); return d || null; }
/* ## Backup in project.md: backup: / restore: (commands; defaults scripts/backup.js and scripts/restore.js when they exist),
   folder: (where the real backups land - the scan reads the newest file's age), every: (hours between them, default 24) */
function backupSection(project) {
  const out = {};
  try {
    const md = fs.readFileSync(path.join(project.cockpit.dir, 'project.md'), 'utf8');
    const sec = /^##\s+Backup\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md);
    // a trailing <placeholder> ("restore: node scripts/restore.js <named-dump.sql>") is not part of the command: the drill passes the file itself
    // by: who keeps the real backups (a managed database's provider); drill: the JSON a production restore drill writes
    if (sec) for (const k of ['backup', 'restore', 'folder', 'every', 'by', 'drill']) { const m = new RegExp('^\\s*(?:-\\s*)?' + k + ':\\s*(.+)$', 'im').exec(sec[1]); if (m) out[k] = m[1].trim().replace(/\s*<[^<>]*>\s*$/, '').trim(); }
  } catch (e) { /* no rules */ }
  if (!out.backup && fs.existsSync(path.join(project.dir, 'scripts', 'backup.js'))) out.backup = '"' + process.execPath + '" scripts/backup.js';
  if (!out.restore && fs.existsSync(path.join(project.dir, 'scripts', 'restore.js'))) out.restore = '"' + process.execPath + '" scripts/restore.js';
  return out;
}
/* the pre-step: the project's own test database reset - test/setup-db.js by convention, or `setup:` in the rules */
function setupCommand(project) {
  const sec = testsSection(project); if (sec.setup) return sec.setup;
  const hasMigrations = (() => { try { return fs.readdirSync(path.join(project.dir, 'db', 'migrations')).some((f) => /\.sql$/i.test(f) && !/\.down\.sql$/i.test(f)); } catch (e) { return false; } })();
  for (const f of ['test/setup-db.js', 'test/setup-db.mjs', 'test/setup.js']) if (fs.existsSync(path.join(project.dir, f))) return '"' + process.execPath + '" ' + f + (hasMigrations && /setup-db/.test(f) ? ' --cycle' : '');   // migrations are cycled up-down-up on the test database
  return null;
}
function testEnv(project) {
  const env = { ...process.env, NODE_ENV: 'test', COCKPIT_TEST: '1' };
  env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');   // the portable Chromium (tools/fetch.js), never the user's cache
  env.NODE_PATH = path.join(__dirname, '..', 'node_modules') + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');   // a project's browser test requires playwright from the engine
  try {
    const ex = fs.readFileSync(path.join(project.dir, '.env.example'), 'utf8');
    const name = path.basename(project.dir).replace(/[_-](dev|prod|uat|test)$/i, '').toLowerCase();
    for (const line of ex.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line); if (!m) continue; const k = m[1];
      if (/_ENV$/.test(k)) env[k] = 'test';
      if (/^(DB_NAME|DATABASE_NAME|MYSQL_DATABASE|PGDATABASE)$/.test(k)) env[k] = name + '_test';
    }
  } catch (e) { /* no example: NODE_ENV alone */ }
  const declared = disposableDb(project); if (declared) { env.DB_NAME = declared; env.COCKPIT_TEST_DB = declared; }
  /* the browser flows' sign-in (engine/flow.js signIn reads these): the AI login the owner set up for the project - the
     same file `cli look --login` uses, <secretsDir>\<project>\look-login.json. Nothing filled them before (a role flow
     ran signed-out, met the login page and failed its ticket three times). */
  try {
    const L = JSON.parse(fs.readFileSync(lookLogin(project.entry.id), 'utf8'));
    if (L.email && L.password && !env.COCKPIT_TEST_USER) { env.COCKPIT_TEST_USER = L.email; env.COCKPIT_TEST_PASS = L.password; }
  } catch (e) { /* no AI login for this project */ }
  return env;
}

function run(project, log, opts) {
  const id = project.entry.id; const light = !!(opts && opts.light);   // light: the test files only - after a turn; the environment stages wait for a promote
  if (running.has(id)) return { ok: false, error: 'a test run is already going for this project (started ' + new Date(running.get(id).started).toISOString() + ')' };
  const started = Date.now(); running.set(id, { started });
  const env = testEnv(project), chosen = commandFor(project, opts), cmd = chosen.cmd, files = testFiles(project), setup = setupCommand(project);
  if (chosen.scope) console.log('[' + id + '] tests: scoped to ' + chosen.scope.join(', ') + ' - the package' + (chosen.scope.length === 1 ? '' : 's') + ' this turn touched');
  const report = { at: new Date(started).toISOString(), repoVersion: headOf(project.dir), ms: 0, command: cmd, env: { NODE_ENV: env.NODE_ENV, db: Object.keys(env).filter((k) => /^(DB_NAME|DATABASE_NAME|MYSQL_DATABASE|PGDATABASE)$/.test(k)).map((k) => k + '=' + env[k]).join(' ') || null }, files: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0 } };
  const say = (t) => { if (log) log(t); };
  const prevReport = latest(project);   // for "green again"
  const finish = () => {
    report.ms = Date.now() - started; report.summary.total = report.files.length;
    report.files.forEach((f) => { if (f.skipped) report.summary.skipped++; else if (f.ok) report.summary.passed++; else report.summary.failed++; });
    fs.mkdirSync(dir(project), { recursive: true });
    try { fs.unlinkSync(progressFile(project)); } catch (e) { /* none */ }
    const stamp = report.at.replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir(project), stamp + '.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(dir(project), 'latest.json'), JSON.stringify(report, null, 1) + '\n');
    try {
      const ev = require('./events'), prevRed = !!(prevReport && prevReport.summary && prevReport.summary.failed);
      /* gate: github - the tests line is CI's answer, the Windows run is not; its reds are not alerts (they were every night) */
      const ciGate = /^github\s/i.test(String(testsSection(project).gate || '')); const f = ciGate ? 0 : report.summary.failed;
      /* THE ENVIRONMENT, NOT JUST THE FILES: after a full run, every family line that is red - not the grey "not checked" ones - is one alert; all
         holding resolves it. A light run (after a turn) runs no environment stages and says nothing here. */
      if (!light) {
        let fam = []; try { fam = require('./hot').hot(path.join(__dirname, 'verify.js')).family(project, report); } catch (e) { /* no family */ }
        const reds = fam.filter((x) => !x.ok && !x.na);
        if (reds.length) ev.record(project, { kind: 'environment.red', level: 'alert', title: 'tests not green: ' + reds.map((x) => x.id).join(', '), text: reds.map((x) => x.id + ': ' + String(x.detail).slice(0, 160)).join(' · '), source: 'tests' });
        else if (fam.length) ev.resolve(project, { kind: 'environment.red' });
      }
      if (f) ev.record(project, { kind: 'tests.red', level: 'alert', title: 'tests red: ' + f + ' of ' + report.summary.total + ' failed', text: report.files.filter((x) => x.ok === false).map((x) => x.file).slice(0, 6).join(', '), source: 'tests' });
      if (!f) ev.resolve(project, { kind: 'tests.red' });   // green: the red is over
      if (!f && prevRed && !ciGate) ev.record(project, { kind: 'tests.green', level: 'info', title: 'tests green again: ' + report.summary.passed + ' passed', source: 'tests' });
    } catch (e) { /* */ }
    // keep the last 30
    try { const old = fs.readdirSync(dir(project)).filter((f) => f !== 'latest.json' && f.endsWith('.json')).sort(); old.slice(0, Math.max(0, old.length - 30)).forEach((f) => fs.unlinkSync(path.join(dir(project), f))); } catch (e) { /* */ }
    running.delete(id);
    try { require('./projects').bump(id); } catch (e) { /* */ }
    say('tests: ' + report.summary.passed + ' passed, ' + report.summary.failed + ' failed, ' + report.summary.skipped + ' skipped in ' + Math.round(report.ms / 1000) + ' s');
    // a scan after a run: the map reads the report (tested = a passing test names it)
    try { const pl = require('./plugins'); for (const name of pl.scanned(project)) { try { pl.scan(project, name, null); } catch (e) { /* this plugin has no scan */ } } } catch (e) { /* no plugins, no scan */ }
  };
  (async () => {
    noteProgress(project, report, setup ? 'setup' : 'tests', { total: files.length, done: 0 });
    if (setup) {
      say('tests: setup - ' + setup);
      const t0 = Date.now();
      const r = await new Promise((resolve) => cp.exec(setup, { cwd: project.dir, env, timeout: 5 * 60 * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, tail: String((out || '') + (errOut || '')).slice(-2000) })));
      report.setup = { command: setup, ok: r.ok, ms: Date.now() - t0, tail: r.tail };
      say('tests: setup ' + (r.ok ? 'ok' : 'FAILED') + ' (' + report.setup.ms + ' ms)' + (r.ok ? '' : ' - ' + r.tail.split('\n').filter(Boolean).slice(-2).join(' | ')));
      if (!r.ok) { for (const rel of files) report.files.push({ file: rel, ok: null, skipped: true, ms: 0, tail: 'not run: the test database setup failed' }); return finish(); }
    }
    if (cmd) {
      noteProgress(project, report, 'tests', { total: 1, done: 0, current: cmd });
      say('tests: running the project\'s command: ' + cmd);
      const r = await new Promise((resolve) => cp.exec(cmd, { cwd: project.dir, env, timeout: 15 * 60 * 1000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, tail: String((out || '') + (errOut || '')).slice(-20000) })));
      const read = readRunner(r.tail);
      report.command = cmd; report.scope = chosen.scope; report.counts = read.counts; report.failures = read.failures;
      report.files.push({ file: '(project command) ' + cmd, ok: r.ok, ms: Date.now() - started, tail: r.tail, failures: read.failures, counts: read.counts });
      say('tests: ' + (r.ok ? 'the command passed' : 'the command failed') + (read.counts.tests ? ' - ' + read.counts.tests.failed + ' of ' + (read.counts.tests.total || (read.counts.tests.failed + read.counts.tests.passed)) + ' tests failed' : '') + (read.counts.packages && read.counts.packages.notRun ? ', ' + read.counts.packages.notRun + ' of ' + read.counts.packages.total + ' packages never ran (the run stopped at the first failure)' : '') + (read.failures.length ? ': ' + read.failures.slice(0, 3).map((x) => x.what).join('; ') : ''));
      if (!light) { noteProgress(project, report, 'sast', { total: 1, done: 1 }); await sastStage(project, report, say); noteProgress(project, report, 'app', { total: 1, done: 1 }); await appStages(project, env, report, say); report.stagesVersion = report.version || null; await ciLint(project, say); noteProgress(project, report, 'restore', { total: 1, done: 1 }); await restoreDrill(project, env, report, say); }   // the app and the drill do not depend on how the tests run
      /* a light run keeps the last full run's environment answers, as the node --test path below always did: a coder's scoped
         run after its turn overwrote latest.json without them, and the Tests tab's app / sign-in / drill lines fell back to "not
         started" until the next full run */
      else { const prev = latest(project); if (prev) { report.app = prev.app; report.probe = prev.probe; report.contract = prev.contract; report.signedIn = prev.signedIn; report.restore = prev.restore; report.perf = prev.perf; report.fuzz = prev.fuzz; report.browser = prev.browser; if (report.setup === undefined) report.setup = prev.setup; report.stagesFrom = prev.stagesAt || prev.at; report.stagesVersion = prev.stagesVersion || null; } await flowsLight(project, env, report, say); }
      noteProgress(project, report, 'finishing', { total: 1, done: 1 });
      return finish();
    }
    if (!files.length) { say('tests: no test files found (test/**, __tests__/**, *.test.*)' + (light ? '' : ' - the app stages and the drill still run')); if (!light) { await appStages(project, env, report, say); await restoreDrill(project, env, report, say); } return finish(); }
    for (const rel of files) {
      const t0 = Date.now();
      noteProgress(project, report, 'tests', { total: files.length, done: report.files.length, current: rel });
      if (!/\.[cm]?js$/i.test(rel)) { report.files.push({ file: rel, ok: null, skipped: true, ms: 0, tail: 'needs the project\'s runner (TypeScript / jsx): name it under ## Tests in project.md as command: <what to run>' }); continue; }
      const r = await new Promise((resolve) => cp.execFile(process.execPath, ['--test', rel], { cwd: project.dir, env, timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, tail: String((out || '') + (errOut || '')).slice(-2000) })));
      report.files.push({ file: rel, ok: r.ok, ms: Date.now() - t0, tail: r.tail });
      say('tests: ' + (r.ok ? 'ok   ' : 'FAIL ') + rel + ' (' + (Date.now() - t0) + ' ms)');
    }
    if (!light) { noteProgress(project, report, 'sast', { total: files.length, done: files.length }); await sastStage(project, report, say); noteProgress(project, report, 'app', { total: files.length, done: files.length }); await appStages(project, env, report, say); await ciLint(project, say); noteProgress(project, report, 'restore', { total: files.length, done: files.length }); await restoreDrill(project, env, report, say); }
    else { const prev = latest(project); if (prev) { report.app = prev.app; report.probe = prev.probe; report.contract = prev.contract; report.signedIn = prev.signedIn; report.restore = prev.restore; report.perf = prev.perf; report.fuzz = prev.fuzz; report.browser = prev.browser; report.stagesFrom = prev.stagesAt || prev.at; report.stagesVersion = prev.stagesVersion || null; } await flowsLight(project, env, report, say); }   // a light run keeps the last environment stages, dated - but the browser flows run again: they are the functional test of the ticket's work
    if (!light) { report.stagesAt = report.at; report.stagesVersion = report.version || null; }   // the probes (fuzz, contract) tested this code
    noteProgress(project, report, 'finishing', { total: files.length, done: files.length });
    finish();
  })().catch((e) => { say('tests: ' + e.message); running.delete(id); });
  return { ok: true, started: report.at, files: files.length, command: cmd, env: report.env, note: 'running; the report lands in .cockpit/tests/latest.json and the map rescans when it does' };
}

/* ---------- the app-start stages: the auth probe and the API contract ---------- */
function shapeOf(v, depth) {
  if (depth > 4) return '…';
  if (Array.isArray(v)) return [v.length ? shapeOf(v[0], depth + 1) : '?'];
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = shapeOf(v[k], depth + 1); return o; }
  return v === null ? 'null' : typeof v;
}
/* NOT A BREAK (8 "contract breaks" after a UAT data refresh - none was the API): a field that is null in
   one reading and a value in the other is a NULLABLE field meeting different data (priority: string → null), and an
   object whose keys are ids ({ "<user id>": ... }) is a MAP - a key leaving is a record leaving, not a field removed. */
const idKey = (k) => /^[0-9a-f]{16,}$/i.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(k) || /^[A-Za-z0-9_-]{20,}$/.test(k) && /\d/.test(k) && /[a-zA-Z]/.test(k);
function diffShape(a, b, at, out) {   // what b lost or changed against a (the recorded shape)
  if (a === 'null' || b === 'null') return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length && ka.every(idKey) && (!kb.length || kb.every(idKey))) { if (kb.length) diffShape(a[ka[0]], b[kb[0]], at + '{id}', out); return; }
  }
  if (Array.isArray(a) || Array.isArray(b)) { if (!Array.isArray(a) || !Array.isArray(b)) out.push(at + ': ' + (Array.isArray(a) ? 'array' : typeof a) + ' → ' + (Array.isArray(b) ? 'array' : typeof b)); else if (a[0] !== '?' && b[0] !== '?') diffShape(a[0], b[0], at + '[]', out); return; }
  if (a && typeof a === 'object' && b && typeof b === 'object') { for (const k of Object.keys(a)) { if (!(k in b)) out.push(at + '.' + k + ' removed'); else diffShape(a[k], b[k], at + '.' + k, out); } return; }
  if (a !== b && a !== '…' && b !== '…') out.push(at + ': ' + a + ' → ' + b);
}
/* start the app on the test database and wait for it to answer - the app stages and the DAST run share this.
   Resolves { url, stop, start } or { why } when it could not. */
async function startApp(project, env, say) {
  const sec = testsSection(project);
  let start = sec.start, url = sec.url, spawnSpec = start ? { cmd: start, args: [], shell: true } : null;
  // the starter's defaults: server.js at the root, PORT from the environment, health at /api/health
  if (!start && fs.existsSync(path.join(project.dir, 'server.js'))) { const port = 5900 + Math.floor(Math.random() * 90); start = 'node server.js'; spawnSpec = { cmd: process.execPath, args: ['server.js'], shell: false }; url = 'http://127.0.0.1:' + port; env.PORT = String(port); }
  /* no start, but a site that already runs (a PHP site under Caddy): url: under ## Tests, else the project's own site url.
     External: the runner did not start it and it runs on its own database - read-only from here on (GET only), and it
     is never stopped. */
  if (!start) {
    const site = url || ((project.cockpit.json && project.cockpit.json.urls) || []).find((u) => /^https?:\/\//.test(u)) || null;
    if (site) {
      let up = false; try { const r = await fetch(site.replace(/\/$/, '') + '/', { redirect: 'manual', signal: AbortSignal.timeout(15000) }); up = !!r.status; } catch (e) { up = false; }
      if (!up) return { why: site + ' did not answer - the site is not up, or the url is wrong (## Tests url:, or the project\'s site on Settings › Project)' };
      const version = await siteVersion(site.replace(/\/$/, ''));
      say('tests: the site is already running at ' + site + (version ? ' (code ' + version.slice(0, 9) + ')' : ' (it does not say which code it runs)') + (disposableDb(project) ? ' on ' + disposableDb(project) + ', declared disposable - the runner may write' : ' - probing it read-only (its own database, not a test one)'));
      const declared = disposableDb(project);
      return { url: site.replace(/\/$/, ''), stop: () => {}, start: null, external: !declared, declaredDb: declared, version };   // a declared sandbox database: the site may be written to
    }
  }
  if (!start || !url) return { why: 'no start: / url: under ## Tests in project.md, no server.js at the root, and no site url on the project' };
  say('tests: starting the app - ' + start + ' → ' + url);
  const child = cp.spawn(spawnSpec.cmd, spawnSpec.args, { cwd: project.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: spawnSpec.shell });   // the node path has spaces on Windows: never split a command string
  let up = false; const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !up) { try { const r = await fetch(url + '/', { redirect: 'manual' }); if (r.status) up = true; } catch (e) { await new Promise((r) => setTimeout(r, 400)); } }
  const stop = () => { try { if (process.platform === 'win32') cp.execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); else child.kill('SIGTERM'); } catch (e) { try { child.kill(); } catch (e2) { /* gone */ } } };
  if (!up) { stop(); return { why: url + ' did not answer within 20 s', start }; }
  return { url, stop, start, version: headOf(project.dir) };   // started from the folder: it runs the folder's code
}
/* WHICH CODE A RUN TESTED. A finding from a run (a failing flow, a crash on hostile input) says nothing
   about a fix unless the run tested code that holds the fix - the test copy follows main every 2 hours, so a run soon after a
   merge still tests the code before it. A deployed site says its commit on its health answer ({ sha }); the folder's own
   tests ran on its HEAD. engine/findings.js reads these to judge a findings ticket only on a run of the fix. */
async function siteVersion(site) {
  for (const p of ['/api/health', '/health']) {
    try { const r = await fetch(site + p, { signal: AbortSignal.timeout(8000) }); const j = await r.json(); const v = j && (j.sha || j.commit || j.version); if (typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v)) return v.toLowerCase(); } catch (e) { /* not this path */ }
  }
  return null;
}
/* LINT FROM CI. A monorepo that lints per package (e.g. `turbo run lint`, a required
   "Lint" job in its CI workflow) has no root eslint for the map to run, and main's copy has no installed packages for the
   plugins to load - so the map's lint lines sat "not checked". When the project gates on a GitHub workflow (`gate: github
   <workflow>` under ## Tests), the newest finished run of it on main is read, and its lint job's own result written to
   .cockpit/tests/ci-lint.json for the scan: success = no lint errors on main; anything else = a lint-error on the site.
   Asynchronous; a run that cannot read GitHub leaves the previous file alone. */
async function ciLint(project, say) {
  const g = /github\s+(.+)/i.exec(testsSection(project).gate || ''); if (!g) return;
  let repo = null, branch = 'main'; try { const j = JSON.parse(fs.readFileSync(path.join(project.cockpit.dir, 'plugins', 'github.json'), 'utf8')); repo = j.repo; branch = j.branch || 'main'; } catch (e) { return; }
  if (!repo) return;
  const env = { ...process.env, ...require('./ghauth').envFor(project) };
  const gh = (args) => new Promise((res) => cp.execFile('gh', args, { encoding: 'utf8', timeout: 60000, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 }, (e, o) => res(e ? null : o)));
  try {
    const workflow = g[1].trim();
    const runs = JSON.parse(await gh(['run', 'list', '-R', repo, '-w', workflow, '-L', '40', '--json', 'databaseId,event,headBranch,status,conclusion,headSha,createdAt']) || '[]');
    const r = runs.find((x) => x.status === 'completed' && x.conclusion !== 'cancelled' && x.conclusion !== 'skipped' && (x.event === 'merge_group' || (x.event === 'push' && x.headBranch === branch)));
    if (!r) return;
    const jobs = (JSON.parse(await gh(['run', 'view', String(r.databaseId), '-R', repo, '--json', 'jobs']) || '{}').jobs) || [];
    const job = jobs.find((j) => /^lint$/i.test(j.name)) || jobs.find((j) => /\blint\b/i.test(j.name) && !/typecheck/i.test(j.name));
    if (!job) return;
    const out = { at: new Date().toISOString(), workflow, run: r.databaseId, sha: r.headSha, runAt: r.createdAt, job: job.name, conclusion: job.conclusion, ok: job.conclusion === 'success' };
    fs.mkdirSync(dir(project), { recursive: true }); fs.writeFileSync(path.join(dir(project), 'ci-lint.json'), JSON.stringify(out, null, 1) + '\n');
    say('tests: CI ' + job.name + ' on ' + branch + ': ' + job.conclusion + ' · ' + String(r.headSha).slice(0, 7));
  } catch (e) { say('tests: CI lint could not be read - ' + String(e.message).slice(0, 120)); }
}
function headOf(dir) { try { return cp.execFileSync('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim() || null; } catch (e) { return null; } }
async function appStages(project, env, report, say) {
  const sec = testsSection(project);
  let routes = project.db.all("SELECT subject, title FROM node WHERE kind = 'route'").map((r) => { const m = /^([A-Z]+)\s+(.+)$/.exec(r.title); return m ? { subject: r.subject, method: m[1], path: m[2] } : null; }).filter(Boolean);
  // a site of pages (PHP, HTML): each page is a door, GET by its path
  if (!routes.length) routes = project.db.all("SELECT n.subject, n.file FROM node n JOIN tag t ON t.subject = n.subject AND t.ns = 'kind' AND t.value = 'page' WHERE n.file IS NOT NULL").map((r) => ({ subject: r.subject, method: 'GET', path: '/' + String(r.file).replace(/\\/g, '/').replace(/^\.?\//, '') })).filter((r) => !/\.(inc|part)\.php$/i.test(r.path));
  const authTag = {}; project.db.all("SELECT subject, value FROM tag WHERE ns IN ('auth', 'rbac')").forEach((t) => { authTag[t.subject] = authTag[t.subject] || {}; authTag[t.subject][t.value] = 1; });
  const publicList = (sec.public || '').split(',').map((x) => x.trim()).filter(Boolean);
  // exact unless the entry ends in * (a bare prefix made "public: /" declare EVERY door public)
  const isPublic = (r) => publicList.some((p) => r.path === p || (p.endsWith('*') && r.path.startsWith(p.slice(0, -1)))) || (authTag[r.subject] && authTag[r.subject].none) || /^\/(api\/)?(health|status|version|ping)$/.test(r.path);
  const app = await startApp(project, env, say);
  if (!app.url) { report.app = { started: !!app.start && false, skipped: !app.start, why: app.why }; say('tests: app stage' + (app.start ? ' - app did not start - ' : 's skipped - ') + app.why); return; }
  const { url, stop, start } = app; const external = !!app.external;
  report.app = { started: true, url, start, routes: routes.length, external, database: app.declaredDb || null, version: app.version || null };
  report.version = app.version || null;
  if (external) routes = routes.filter((r) => r.method === 'GET' || r.method === 'HEAD');   // read-only against a site on its own database
  // the auth probe: every door, unauthenticated
  const probe = []; let refused = 0, open = 0;
  for (const r of routes.slice(0, 400)) {
    const p = r.path.replace(/\*/g, '1').replace(/:[a-z_]+/gi, '1');
    let status = 0, loc = ''; try { const res = await fetch(url + p, { method: r.method, redirect: 'manual', headers: r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH' ? { 'content-type': 'application/json' } : {}, body: /^(POST|PUT|PATCH)$/.test(r.method) ? '{}' : undefined, signal: AbortSignal.timeout(8000) }); status = res.status; loc = res.headers.get('location') || ''; } catch (e) { status = -1; }
    const refusedNow = status === 401 || status === 403 || toLogin(status, loc);   // a redirect to login counts as refused
    const pub = isPublic(r);
    if (refusedNow) refused++; else if (status >= 200 && status < 300 && !pub) open++;   // a door declared public is not "open without a door"
    probe.push({ route: r.subject, method: r.method, path: r.path, status, public: pub, verdict: status === -1 ? 'error' : refusedNow ? 'refused' : status >= 200 && status < 300 ? (pub ? 'public' : 'open') : status === 404 ? 'not-found' : status >= 300 && status < 400 ? 'redirect' : 'other', ...(loc ? { location: loc.slice(0, 200) } : {}) });
  }
  const noAuthAtAll = refused === 0;
  report.probe = { routes: probe.length, refused, open, noAuthAtAll, results: probe, note: noAuthAtAll ? 'no door refused anything: this project has no authentication yet - the probe has nothing to check until it does (declare public routes under ## Tests when it does)' : open + ' door' + (open === 1 ? '' : 's') + ' answered an unauthenticated request with 2xx and ' + (open === 1 ? 'is' : 'are') + ' not declared public' };
  say('tests: auth probe - ' + probe.length + ' doors, ' + refused + ' refused, ' + open + ' open' + (noAuthAtAll ? ' (no auth yet)' : ''));
  // the API contract: parameterless GETs, recorded once, diffed after
  const cfile = path.join(dir(project), 'contract.json'); let recorded = {}; try { recorded = JSON.parse(fs.readFileSync(cfile, 'utf8')); } catch (e) { /* first run records */ }
  const contract = { checked: 0, recorded: 0, breaks: [], first: !Object.keys(recorded).length }; const timings = [];
  for (const r of routes.filter((x) => x.method === 'GET' && !/[*:]/.test(x.path)).slice(0, 300)) {
    const tq = Date.now();
    let status = 0, shape = null; try { const res = await fetch(url + r.path, { redirect: 'manual', signal: AbortSignal.timeout(8000) }); status = res.status; const ct = res.headers.get('content-type') || ''; if (/json/.test(ct)) { try { shape = shapeOf(await res.json(), 0); } catch (e) { shape = 'unparseable'; } } } catch (e) { continue; }
    timings.push({ route: r.subject, path: r.path, ms: Date.now() - tq, status });
    const now = { status, shape }; contract.checked++;
    const was = recorded[r.subject];
    if (!was) { recorded[r.subject] = now; contract.recorded++; continue; }
    // 404 → anything: the route is NEW, not broken (2026-09-30: two new routes read as breaks)
    // (2026-11-03: this comment used to sit at the end of the next line and swallowed the shape check - no shape change was ever reported)
    const changes = []; if (was.status !== now.status && was.status !== 404) changes.push('status ' + was.status + ' → ' + now.status);
    if (was.shape && now.shape) diffShape(was.shape, now.shape, '', changes);
    if (changes.length) contract.breaks.push({ route: r.subject, path: r.path, changes: changes.slice(0, 8) });
  }
  fs.mkdirSync(dir(project), { recursive: true }); fs.writeFileSync(cfile, JSON.stringify(recorded, null, 1) + '\n');
  report.contract = contract;
  await perfStage(project, url, timings, report, say);
  // the input probe as nobody: it writes junk into the test database, which is what the test database is for
  try { await require('./fuzz').fuzzStage(project, env, url, routes, report, say); } catch (e) { report.fuzz = { error: e.message }; say('tests: input probe stopped - ' + e.message); }
  await signedInStage(project, url, routes, sec, report, say);
  say('tests: contract - ' + contract.checked + ' GET routes checked, ' + contract.recorded + ' newly recorded, ' + contract.breaks.length + ' break' + (contract.breaks.length === 1 ? '' : 's'));
  await browserStage(project, env, url, report, say);
  stop();
}
/* the restore drill: backup the TEST database to a scratch file, restore from it, compare what each side reports.
   The backup command must print a JSON line { tables: { name: rows } } last; the restore command takes the file as its
   last argument and prints the same. The starter's scripts/backup.js and scripts/restore.js do; ## Backup can name others. */
async function restoreDrill(project, env, report, say) {
  const bk = backupSection(project);
  if (!bk.backup || !bk.restore) { report.restore = { skipped: true, why: 'no scripts/backup.js + scripts/restore.js, and no backup: / restore: under ## Backup' }; return; }
  const dbName = Object.keys(env).filter((k) => /^(DB_NAME|DATABASE_NAME|MYSQL_DATABASE|PGDATABASE)$/.test(k)).map((k) => env[k])[0];
  const declared = disposableDb(project);
  if (!dbName || (!/_test$/.test(dbName) && dbName !== declared)) { report.restore = { skipped: true, why: 'the test environment names no *_test database - the drill only ever restores into one (or the one ## Tests declares with database:)' }; return; }
  if (declared && dbName === declared && !/_test$/.test(dbName)) { report.restore = report.restore || {}; report.restore.declared = declared; say('tests: the drill uses ' + declared + ' - the project declares it disposable under ## Tests'); }
  const scratch = path.join(os.tmpdir(), 'cockpit-restore-' + project.entry.id + '-' + Date.now() + '.sql');
  const t0 = Date.now();
  const run = (cmd) => new Promise((resolve) => cp.exec(cmd, { cwd: project.dir, env, timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => { let json = null; for (const line of String(out || '').trim().split('\n').reverse()) { try { json = JSON.parse(line); break; } catch (e) { /* not the summary */ } } resolve({ ok: !err, json, tail: String((out || '') + (errOut || '')).slice(-1200) }); }));
  say('tests: restore drill - backup ' + dbName + ' → scratch file → restore → compare');
  const b = await run(bk.backup + ' --out "' + scratch + '"');
  if (!b.ok || !b.json || !b.json.tables) { report.restore = { ok: false, step: 'backup', why: b.json ? 'no tables in the summary' : b.tail.split('\n').filter(Boolean).slice(-2).join(' | '), ms: Date.now() - t0 }; say('tests: restore drill FAILED at backup - ' + report.restore.why); try { fs.unlinkSync(scratch); } catch (e) { /* */ } return; }
  const bytes = (() => { try { return fs.statSync(scratch).size; } catch (e) { return 0; } })();
  const r = await run(bk.restore + ' "' + scratch + '"');
  try { fs.unlinkSync(scratch); } catch (e) { /* */ }
  if (!r.ok || !r.json || !r.json.tables) { report.restore = { ok: false, step: 'restore', why: r.tail.split('\n').filter(Boolean).slice(-2).join(' | '), ms: Date.now() - t0 }; say('tests: restore drill FAILED at restore - ' + report.restore.why); return; }
  const diffs = []; const names = new Set([...Object.keys(b.json.tables), ...Object.keys(r.json.tables)]);
  for (const t of names) { const a = b.json.tables[t], c = r.json.tables[t]; if (a === undefined) diffs.push(t + ': not in the backup, present after restore'); else if (c === undefined) diffs.push(t + ': in the backup, missing after restore'); else if (a !== c) diffs.push(t + ': ' + a + ' rows backed up, ' + c + ' after restore'); }
  report.restore = { declared: declared && !/_test$/.test(dbName) ? declared : undefined, ok: !diffs.length, tables: names.size, rows: Object.values(b.json.tables).reduce((x, y) => x + y, 0), bytes, diffs, ms: Date.now() - t0 };
  say('tests: restore drill ' + (diffs.length ? 'FAILED - ' + diffs.slice(0, 3).join('; ') : 'ok - ' + names.size + ' tables, ' + report.restore.rows + ' rows, ' + Math.round(bytes / 1024) + ' KB round-tripped') + ' (' + Math.round(report.restore.ms / 1000) + ' s)');
}
/* sign in as the test user: 'login: POST /api/login' and 'user: {"email":"…","password":"…"}' under ## Tests (the seed
   creates that user on the test database). What comes back - cookies, or a token in the JSON - is what the signed-in
   pass sends on every request. Resolves { headers } or { why }. */
async function signIn(url, sec, project) {
  const m = /^([A-Z]+)\s+(\S+)$/.exec(sec.login || ''); if (!m) return { why: 'login: is not "METHOD /path"' };
  /* no user: under ## Tests (or "user: look-login"): the project's AI login, <secretsDir>\<project>\look-login.json - project.md
     goes into every AI's prompt, so a password never belongs there */
  let user = null;
  if (!sec.user || /^look-login$/i.test(String(sec.user).trim())) {
    try { const L = JSON.parse(fs.readFileSync(lookLogin(project.entry.id), 'utf8')); if (L.email && L.password) user = { email: L.email, password: L.password }; } catch (e) { /* none */ }
    if (!user) return { why: 'no user: under ## Tests and no config/' + project.entry.id + '/look-login.json with email and password' };
  } else { try { user = JSON.parse(sec.user); } catch (e) { return { why: 'user: is not JSON' }; } }
  try {
    /* a 429 is the site's sign-in rate limit (better-auth's default: 3 sign-ins per 10 s) - wait out the window and try
       again, up to three times, before calling the sign-in broken (2026-09-28: the browser flows had just signed in) */
    let res;
    for (let tryN = 0; tryN < 4; tryN++) {
      res = await fetch(url + m[2], { method: m[1], redirect: 'manual', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(user), signal: AbortSignal.timeout(10000) });   // origin: sign-in libraries refuse a POST without one (better-auth's CSRF check)
      if (res.status !== 429 || tryN === 3) break;
      await new Promise((r) => setTimeout(r, 11000));
    }
    const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(';')[0]).filter(Boolean);
    let token = null; try { const j = JSON.parse(await res.text()); token = j.token || j.access_token || j.jwt || (j.data && j.data.token) || null; } catch (e) { /* not JSON */ }
    /* say what the answer means (2026-09-28: a 429 read "the test user is not in the seed" - it was the site's sign-in rate limit) */
    const meaning = res.status === 429 ? 'the site\'s sign-in rate limit (too many sign-ins in a short time - the browser flows sign in too); it clears by itself'
      : res.status === 401 || res.status === 403 ? 'the test user or its password was refused - check config/<project>/look-login.json and that the user exists on this site'
      : res.status < 400 ? 'no cookie and no token came back' : 'the door wants other fields, or the site failed';
    if (!(res.status < 400) || (!cookies.length && !token)) return { why: sec.login + ' answered ' + res.status + ' - ' + meaning };
    const headers = {}; if (cookies.length) headers.cookie = cookies.join('; '); if (token) headers.authorization = 'Bearer ' + token;
    return { headers, cookie: !!cookies.length, token: !!token };
  } catch (e) { return { why: sec.login + ': ' + e.message }; }
}
/* A REDIRECT IS A REFUSAL ONLY WHEN IT GOES TO A SIGN-IN (2026-09-29): every 3xx counted as refused, so a site's OAuth
   callbacks - which, called with no code/state, correctly send the browser back into the app - read "refuses the
   test user". No Location, or one naming a login / sign-in / auth page, is a refusal; any other redirect is a redirect. */
function toLogin(status, loc) { return status >= 300 && status < 400 && (!loc || /(^|\/|[?&=])(login|log-in|signin|sign-in|sign_in|auth(?!or)|sso|oauth\/authorize)(?![a-z])/i.test(loc)); }
/* the signed-in pass: every door again as the test user - which refuse even a signed-in user (role-bound, or broken),
   the GET contract as the user (recorded under "<route> (user)"), and the input probe behind the login. */
async function signedInStage(project, url, routes, sec, report, say) {
  if (!sec.login) { report.signedIn = { skipped: true, why: 'no login: under ## Tests - doors behind a login are probed as nobody only' }; return; }
  const session = await signIn(url, sec, project);
  if (!session.headers) { report.signedIn = { login: sec.login, ok: false, why: session.why }; say('tests: sign-in FAILED - ' + session.why); return; }
  const H = session.headers;
  const probe = []; let ok = 0, refused = 0;
  for (const r of routes.slice(0, 400)) {
    const p = r.path.replace(/\*/g, '1').replace(/:[a-z_]+/gi, '1');
    let status = 0, loc = ''; try { const res = await fetch(url + p, { method: r.method, redirect: 'manual', headers: { ...H, ...(/^(POST|PUT|PATCH)$/.test(r.method) ? { 'content-type': 'application/json' } : {}) }, body: /^(POST|PUT|PATCH)$/.test(r.method) ? '{}' : undefined, signal: AbortSignal.timeout(8000) }); status = res.status; loc = res.headers.get('location') || ''; } catch (e) { status = -1; }
    const refusedNow = status === 401 || status === 403 || toLogin(status, loc);
    if (refusedNow) refused++; else if (status >= 200 && status < 300) ok++;
    probe.push({ route: r.subject, method: r.method, path: r.path, status, verdict: refusedNow ? 'refused' : status >= 200 && status < 300 ? 'ok' : status === 404 ? 'not-found' : status === -1 ? 'error' : status >= 300 && status < 400 ? 'redirect' : 'other', ...(loc ? { location: loc.slice(0, 200) } : {}) });
  }
  // the contract as the user
  const cfile = path.join(dir(project), 'contract.json'); let recorded = {}; try { recorded = JSON.parse(fs.readFileSync(cfile, 'utf8')); } catch (e) { /* first */ }
  const contract = { checked: 0, recorded: 0, breaks: [] };
  for (const r of routes.filter((x) => x.method === 'GET' && !/[*:]/.test(x.path)).slice(0, 300)) {
    let status = 0, shape = null; try { const res = await fetch(url + r.path, { redirect: 'manual', headers: H, signal: AbortSignal.timeout(8000) }); status = res.status; if (/json/.test(res.headers.get('content-type') || '')) { try { shape = shapeOf(await res.json(), 0); } catch (e) { /* not json after all */ } } } catch (e) { status = -1; }
    const key = r.subject + ' (user)', now = { status, shape }; contract.checked++;
    const was = recorded[key]; if (!was) { recorded[key] = now; contract.recorded++; continue; }
    // 404 → anything: the route is NEW, not broken (2026-09-30: two new routes read as breaks)
    const changes = []; if (was.status !== now.status && was.status !== 404) changes.push('status ' + was.status + ' → ' + now.status);
    if (was.shape && now.shape) diffShape(was.shape, now.shape, '', changes);
    if (changes.length) contract.breaks.push({ route: r.subject, path: r.path, changes: changes.slice(0, 8), as: 'user' });
  }
  fs.mkdirSync(dir(project), { recursive: true }); fs.writeFileSync(cfile, JSON.stringify(recorded, null, 1) + '\n');
  if (report.contract) report.contract.breaks.push(...contract.breaks);
  report.signedIn = { login: sec.login, ok: true, cookie: session.cookie, token: session.token, probe: { routes: probe.length, ok, refused, results: probe }, contract };
  say('tests: signed in as the test user (' + (session.cookie ? 'cookie' : 'token') + ') - ' + ok + ' doors answer, ' + refused + ' still refuse; contract ' + contract.checked + ' checked, ' + contract.breaks.length + ' break' + (contract.breaks.length === 1 ? '' : 's'));
  // the input probe behind the login
  try { const fz = require('./fuzz'); const sub = {}; await fz.fuzzStage(project, {}, url, routes, sub, say, H); if (sub.fuzz) { report.fuzzSignedIn = sub.fuzz; if (report.fuzz && report.fuzz.findings) { for (const f of sub.fuzz.findings) if (!report.fuzz.findings.some((g) => g.route === f.route && g.kind === f.kind)) report.fuzz.findings.push({ ...f, as: 'user' }); } } } catch (e) { say('tests: signed-in input probe stopped - ' + e.message); }
}
/* the performance stage: how long each GET door takes alone (from the contract pass), then a burst of 10 at once on the
   health door and the five slowest - a door that is fine alone and folds under ten is the one that folds on launch day.
   Budget: 'budget: 800ms' under ## Tests, default 1000 ms for one request and 3000 ms for the p95 of the burst. The
   previous run's numbers are kept beside the new ones so the map can say "slower than last time". */
async function perfStage(project, url, timings, report, say) {
  const sec = testsSection(project);
  const budget = Number(String(sec.budget || '').replace(/[^0-9]/g, '')) || 1000;
  const prev = latest(project); const prevMs = {}; if (prev && prev.perf) for (const t of prev.perf.routes || []) prevMs[t.route] = t.ms;
  const ok = timings.filter((t) => t.status >= 200 && t.status < 400);
  const sorted = ok.slice().sort((a, b) => b.ms - a.ms);
  const burstOn = [...new Set([...timings.filter((t) => /\/(api\/)?(health|status|ping)$/.test(t.path)), ...sorted.slice(0, 5)].map((t) => t.path))].slice(0, 6);
  const bursts = [];
  for (const p of burstOn) {
    const t0 = Date.now(); const each = await Promise.all(Array.from({ length: 10 }, async () => { const t1 = Date.now(); try { await (await fetch(url + p, { redirect: 'manual', signal: AbortSignal.timeout(15000) })).arrayBuffer(); } catch (e) { /* counted by time */ } return Date.now() - t1; }));
    const ms = each.slice().sort((a, b) => a - b); bursts.push({ path: p, n: 10, wall: Date.now() - t0, p50: ms[4], p95: ms[9], max: ms[9] });
  }
  const p = (arr, q) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
  report.perf = { budget, routes: timings.map((t) => ({ route: t.route, path: t.path, ms: t.ms, status: t.status, prev: prevMs[t.route] })), p50: p(ok.map((t) => t.ms), 0.5), p95: p(ok.map((t) => t.ms), 0.95), slow: sorted.filter((t) => t.ms > budget).map((t) => ({ route: t.route, path: t.path, ms: t.ms })), bursts, burstSlow: bursts.filter((b) => b.p95 > budget * 3).map((b) => ({ path: b.path, p95: b.p95 })), regressed: timings.filter((t) => prevMs[t.route] && t.ms > 200 && t.ms > prevMs[t.route] * 2).map((t) => ({ route: t.route, path: t.path, ms: t.ms, prev: prevMs[t.route] })) };
  say('tests: performance - ' + ok.length + ' GET doors, p50 ' + report.perf.p50 + ' ms, p95 ' + report.perf.p95 + ' ms, ' + report.perf.slow.length + ' over the ' + budget + ' ms budget; burst of 10 on ' + bursts.length + ' door' + (bursts.length === 1 ? '' : 's') + ', ' + report.perf.burstSlow.length + ' fold' + (report.perf.regressed.length ? '; ' + report.perf.regressed.length + ' slower than last run' : ''));
}
/* the functional stage: the project's *.browser.test.js files drive the running app through Chromium. Playwright and
   the browser come from this engine folder (tools/fetch.js keeps both platforms' archives; unpacked here on first use). */
/* the functional stage: the README flows clicked through in a real browser (engine/flow.js is the helper the files
   require). On dev: look, then the steps that write - the dev database is the sandbox. In LOOK mode (the promoter,
   on prod): only the reading half of every flow - the screens opened and read, nothing pressed that writes; the
   customer's data is never written by a test. */
function chromiumReady(say) {
  const fetchTools = require('../tools/fetch');
  let st = fetchTools.ready();
  if (!st.browsers) {
    if (st.missingArchives.some((f) => /chrome|ffmpeg|winldd/.test(f))) return 'Chromium is not in this engine folder - run: node tools\\fetch.js --unpack (downloads it once; it then travels with the folder)';
    say('tests: unpacking Chromium from tools\\dl (first use on this machine)');
    try { for (const p of fetchTools.PIECES) if (p.playwright && p.platform === process.platform) fetchTools.unpack(p); } catch (e) { return 'could not unpack Chromium: ' + e.message; }
    st = fetchTools.ready(); if (!st.browsers) return 'Chromium unpacked but not found where Playwright looks - the pins in tools/fetch.js may not match the playwright package (node tools\\fetch.js --check)';
  }
  return null;
}
/* THE RUN'S ONE SIGN-IN, before any flow: the shared session used to exist only if the first
   flow happened to carry a signIn of its own - a flow without one ran signed out. The runner signs in ONCE through the
   site's own login FORM, as a person would (a cookie from the API alone is not enough: some sites keep signed-in state in
   the browser too, and force-log-out a session without it), and saves that browser session for
   every flow (engine/flow.js reuses it). The login: config/<project>/look-login.json {url, email, password}, or user: under
   ## Tests. No login declared, or no form found = the flows start signed out, and the log says why. */
async function bootstrapSession(project, url, session, say) {
  const sec = testsSection(project); if (!sec.login) return;
  let user = null, loginUrl = url.replace(/\/$/, '') + '/login';
  try { const L = JSON.parse(fs.readFileSync(lookLogin(project.entry.id), 'utf8')); if (L.email && L.password) user = { email: L.email, password: L.password }; if (L.url && new URL(L.url).host === new URL(url).host) loginUrl = L.url; } catch (e) { /* none */ }
  if (!user && sec.user) { try { user = JSON.parse(sec.user); } catch (e) { /* not json */ } }
  if (!user) { say('tests: flows start signed out - no login for the runner (config/' + project.entry.id + '/look-login.json)'); return; }
  let chromium; try { ({ chromium } = require('playwright')); } catch (e) { say('tests: no playwright for the shared sign-in: ' + e.message); return; }
  const b = await chromium.launch({ headless: true });
  try {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true }); const pg = await ctx.newPage();
    await pg.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const email = pg.locator('input[type=email], input[name=email], input[autocomplete=username], input[placeholder*="mail" i]').first(), pass = pg.locator('input[type=password]').first();
    await email.waitFor({ timeout: 20000 });
    // a late-hydrating form wipes what was typed before it took over: type until it sticks
    for (let i = 0; i < 20; i++) { await email.fill(user.email); await pass.fill(user.password); await pg.waitForTimeout(400); if ((await email.inputValue()) === user.email && (await pass.inputValue()) === user.password) break; }
    await pg.locator('button[type=submit], button:has-text("Sign in"), button:has-text("Log in")').first().click();
    await pg.waitForURL((u) => !/\/(login|sign-?in)\b/i.test(String(u)), { timeout: 30000 });
    await pg.waitForTimeout(3000);   // the app settles its own signed-in state
    await ctx.storageState({ path: session }); say('tests: signed in once through the login form, for every flow');
  } catch (e) { say('tests: flows start signed out - the runner\'s sign-in failed: ' + String(e.message).split('\n')[0]); try { fs.rmSync(session, { force: true }); } catch (x) { /* */ } }
  finally { await b.close().catch(() => {}); }
}
async function runFlows(project, env, url, look, say) {
  const from = flowDir(project), files = browserFiles(project, from);
  const out = { mode: look ? 'look' : 'write', url, from: from === project.dir ? 'the folder' : 'current main (.cockpit/cache/mainline)', files: [], passed: 0, failed: 0 };
  if (!files.length) { out.skipped = true; out.why = 'no *.browser.test.js files - no flow is clicked through yet'; return out; }
  const why = chromiumReady(say); if (why) { out.skipped = true; out.why = why; say('tests: browser stage skipped - ' + why); return out; }
  const shots = path.join(dir(project), 'shots' + (look ? '-' + (env.COCKPIT_ENV || 'prod') : ''));
  try { fs.rmSync(shots, { recursive: true, force: true }); } catch (e) { /* */ }
  /* ONE SIGN-IN PER RUN: every flow signed in on its own and the site's rate limit answered 429 - the
     first flow that signs in saves the browser session here, the rest reuse it (engine/flow.js). Fresh for every run. */
  const session = path.join(dir(project), 'flow-session' + (look ? '-look' : '') + '.json');
  try { fs.rmSync(session, { force: true }); } catch (e) { /* */ }
  if (!look) await bootstrapSession(project, url, session, say);   // never against prod: look mode runs there after a promote
  const benv = { ...env, APP_URL: url, COCKPIT_FLOW: path.join(__dirname, 'flow.js'), COCKPIT_SHOTS: shots, COCKPIT_SESSION: session }; if (look) benv.COCKPIT_LOOK = '1'; else delete benv.COCKPIT_LOOK;
  for (const rel of files) {
    const t0 = Date.now();
    const r = await new Promise((resolve) => cp.execFile(process.execPath, ['--test', rel], { cwd: from, env: benv, timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, o, errOut) => resolve({ ok: !err, tail: String((o || '') + (errOut || '')).slice(-2500) })));
    const shot = (/screenshot (\S+\.png)/.exec(r.tail) || [])[1] || null;
    /* SKIPPED IS NOT PROVEN (a skipped flow shows grey with its reason, never green). node --test
       passes a file whose part was skipped; its "﹣ <name> (<ms>) # <reason>" lines say what was not run and why */
    const skippedParts = [...String(r.tail).matchAll(/^\s*[﹣-]\s+(.+?)\s+\([\d.]+m?s\)\s*#\s*(?:SKIP\s*)?(.*)$/gim)].map((m) => m[1].trim() + (m[2] ? ': ' + m[2].trim() : ''));
    out.files.push({ file: rel, ok: r.ok, ms: Date.now() - t0, tail: r.tail, shot, skippedParts: skippedParts.length ? skippedParts : undefined });
    if (r.ok) out.passed++; else out.failed++;
    say('tests: ' + (r.ok ? 'ok   ' : 'FAIL ') + rel + ' (browser' + (look ? ', look only' : '') + ', ' + (Date.now() - t0) + ' ms)');
  }
  return out;
}
/* a light run (after a turn) still clicks the flows through: the ticket's verdict reads them. The app is started (or
   found running) for that alone; the other environment stages wait for the full run. */
async function flowsLight(project, env, report, say) {
  if (!browserFiles(project, flowDir(project)).length) return;
  noteProgress(project, report, 'app', { total: 1, done: 1, current: 'the browser flows' });
  const app = await startApp(project, env, say);
  if (!app.url) { report.browser = { skipped: true, why: 'the app is not up for the browser flows: ' + app.why }; say('tests: browser flows skipped - ' + app.why); return; }
  report.version = app.version || null;   // the flows below clicked this code
  try { await browserStage(project, env, app.url, report, say); } finally { app.stop(); }
}
async function browserStage(project, env, url, report, say) {
  const b = await runFlows(project, env, url, false, say);
  report.browser = b;
  for (const f of b.files) report.files.push({ file: f.file, ok: f.ok, ms: f.ms, tail: f.tail, browser: true, shot: f.shot, skippedParts: f.skippedParts });   // counted with the rest: a failing flow fails the run
}
/* for the promoter: every flow's reading half against the environment it just deployed - the prod test */
function lookFlows(project, url, envName, say) { return runFlows(project, { ...testEnv(project), COCKPIT_ENV: envName || 'prod' }, url, true, say || (() => {})); }
/* run and wait: for the promoter - resolves with the report when the run has landed (or null when it could not start) */
/* the SAST stage: semgrep over the source (engine/sast.js), its report read by the map's scan into the SAST stage's bubbles */
async function sastStage(project, report, say) {
  try { const r = await require('./hot').hot(path.join(__dirname, 'sast.js')).run(project, say); report.sast = { ok: r.ok, why: r.why, findings: r.findings.length, summary: r.summary, files: r.files, ms: r.ms }; }
  catch (e) { report.sast = { ok: false, why: e.message }; say('sast: ' + e.message); }
}
function runAndWait(project, log, opts) {
  const r = run(project, log, opts); if (!r.ok) return Promise.resolve(null);
  const id = project.entry.id, t0 = Date.now();
  return new Promise((resolve) => { const tick = () => { if (!running.has(id)) return resolve(latest(project)); if (Date.now() - t0 > 20 * 60 * 1000) return resolve(latest(project)); setTimeout(tick, 1500); }; tick(); });
}
function status(project) {
  const l = latest(project);
  return { ok: true, running: running.has(project.entry.id), progress: running.has(project.entry.id) ? progress(project) : null, setup: setupCommand(project), latest: l ? { at: l.at, ms: l.ms, command: l.command, setup: l.setup ? { ok: l.setup.ok, ms: l.setup.ms, command: l.setup.command } : null, env: l.env, summary: l.summary, files: l.files.map((f) => ({ file: f.file, ok: f.ok, skipped: !!f.skipped, ms: f.ms })) } : null, testFiles: testFiles(project).length, command: projectCommand(project) };
}
function failures(project) { const l = latest(project); return l ? l.files.filter((f) => f.ok === false).map((f) => ({ file: f.file, tail: f.tail })) : []; }

module.exports = { run, runAndWait, status, latest, failures, readRunner, packagesFor, commandFor, testFiles, browserFiles, lookFlows, startApp, testEnv, setupCommand, disposableDb, testsSection, perfStage, signIn, signedInStage, restoreDrill, backupSection, progress, STAGES };
