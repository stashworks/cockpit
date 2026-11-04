/* The promoter - one in the engine, the same on every project. A ticket the owner PASSED goes to
   the next environment on its own; the only human gate is Passed.

   Every environment hop is three things:
     the gate       the ticket is passed - and passed means verified, which means every check in the verdict was green
     the action     git: the target folder is brought to dev's exact commit (fetch + reset --hard; untracked files such
                    as .env and uploads are never touched; `after` runs what the stack needs: npm ci, a restart)
                    observed: something else deploys (GitHub Actions on merge) and Cockpit only watches the version
                    endpoint - it never pushes or merges (the standing rule)
     the read-back  smoke on the target's url: it answers; the version endpoint reports the new commit when there is
                    one. Fails: the target is put back where it was (reset --hard to the previous commit) and the
                    tickets stay passed with the failure on them.

   The project declares only its exceptions, on the Tickets plugin's settings (.cockpit/plugins/tickets.json):
     deployMode      git | observed            default git
     devPath / devUrl   the current (working) folder and where it answers   blank folder: the project's own
     deployTo        the target folder         typed in - never guessed; blank = no promote
     deployUrl       where the live site answers  blank: no smoke, the checkout is the record
     deployKeep      a note of what is kept    (informational - git never touches untracked files anyway)
     deployAfter     commands run in the target after the checkout, one per line  (npm ci · pm2 restart x)
     deployTrigger   auto | manual             default auto: as soon as a ticket is passed
     envName         what the environment is called   default prod

   The record: .cockpit/tests/smoke.json { at, env, mode, from, to, ok, url, status, ms, rolledBack, note, by } - the same
   file engine/tickets.js afterScan reads to move passed → promoted for every ticket a commit in from..to names. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const running = new Map();   // project id -> { started, env }

function settings(p) {
  let a = {}; try { const pl = require('./plugins'); a = { ...(pl.answers(p, 'tickets') || {}), ...(pl.answers(p, 'coding') || {}) }; } catch (e) { /* none */ }
  /* nothing is guessed: the target is
     the Coding plugin's settings (the older Tickets answers still read); a blank target means no promote, with the reason */
  return {
    mode: String(a.deployMode || 'git').trim() === 'observed' ? 'observed' : 'git',
    src: String(a.devPath || '').trim() || p.dir,
    srcUrl: String(a.devUrl || '').trim(),
    to: String(a.deployTo || '').trim(),
    url: String(a.deployUrl || '').trim(),   // blank = no smoke after the promote (the checkout is the record). Not the project's own site url: that is dev's, and a promote lands on the live site (2026-09-20)
    after: String(a.deployAfter || '').split(/[\n;]/).map((s) => s.trim()).filter(Boolean),
    trigger: String(a.deployTrigger || 'auto').trim() === 'manual' ? 'manual' : 'auto',
    env: String(a.envName || 'prod').trim() || 'prod',
    branch: String(a.branch || '').trim()
  };
}
const git = (cwd, args, opts) => cp.execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8', timeout: (opts && opts.timeout) || 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function smokeFile(p) { return path.join(p.cockpit.dir, 'tests', 'smoke.json'); }
function last(p) { try { return JSON.parse(fs.readFileSync(smokeFile(p), 'utf8')); } catch (e) { return null; } }
function status(p) { const s = settings(p); const r = running.get(p.entry.id); return { ok: true, settings: s, running: r || null, last: last(p) }; }
/* the promoter also owns "is a promote in flight" for the board: the environment run counts */

async function smoke(url) {
  if (!url) return { ok: true, status: null, note: 'no url to smoke - the checkout is the record' };
  const t0 = Date.now();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' }); return { ok: r.status < 500, status: r.status, ms: Date.now() - t0, note: r.status < 500 ? null : 'HTTP ' + r.status }; }
  catch (e) { return { ok: false, status: null, ms: Date.now() - t0, note: e.message }; }
}

/* the git hop: dev's commit into the target folder */
async function run(p, by, log, opts) {
  opts = opts || {};
  const say = (t) => { if (log) log('promote → ' + t); };
  const s = settings(p); const id = p.entry.id;
  if (running.has(id)) return { ok: false, error: 'a promote is already running' };
  if (s.mode === 'observed') return { ok: false, error: 'this project is observed: its own pipeline deploys, Cockpit records what the ' + s.env + ' endpoint reports' };
  if (!s.to) return { ok: false, error: 'no Target folder on the Coding settings - where should a promote land?' };
  if (path.resolve(s.to) === path.resolve(s.src)) return { ok: false, error: 'the Target folder is the Current folder itself' };
  if (!fs.existsSync(s.src)) return { ok: false, error: 'the Current folder does not exist: ' + s.src };
  /* the environment runs now - once per promote: the stages, and DAST when its last run is older than a day; then the gate reads them */
  running.set(id, { started: new Date().toISOString(), env: s.env, stage: 'the environment' });
  try {
    const T = require('./hot').hot(path.join(__dirname, 'tests.js')); say('running the environment before the promote'); await T.runAndWait(p, log);
    const D = require('./hot').hot(path.join(__dirname, 'dast.js')); const dl = D.latest(p);
    if (!dl || (Date.now() - Date.parse(dl.at)) > 864e5 || !dl.ok) { say('DAST: ' + (dl ? (dl.ok ? 'a day old' : 'the last run did not finish') : 'never run') + ' - running it'); await D.runAndWait(p, {}, log); }
  } catch (e) { say('the environment run stopped: ' + e.message); }
  running.delete(id);
  /* the gate: the environment holds (the Tests tab) - or nothing moves, and the passed ticket says why */
  let red = []; try { red = require('./hot').hot(path.join(__dirname, 'verify.js')).promoteGate(p); } catch (e) { red = [{ id: 'gate', name: 'the gate', detail: 'could not be read: ' + e.message }]; }
  if (red.length && opts.force) say('the owner saw ' + red.length + ' red and said promote anyway: ' + red.map((r) => r.id).join(', '));
  if (red.length && !opts.force) {
    const lp0 = last(p);
    const rec0 = { at: new Date().toISOString(), env: s.env, mode: 'git', from: null, to: null, prev: lp0 ? (lp0.ok ? lp0.to : lp0.prev || null) : null, ok: false, gate: true, url: s.url || null, status: null, ms: 0, rolledBack: false, by: by || 'owner', after: [], note: 'the Tests tab is red - ' + red.map((r) => r.name + ' (' + r.detail + ')').join('; ') };
    fs.mkdirSync(path.dirname(smokeFile(p)), { recursive: true }); fs.writeFileSync(smokeFile(p), JSON.stringify(rec0, null, 1) + '\n');
    say('refused - ' + rec0.note); try { require('./projects').bump(id); } catch (e) { /* */ }
    return { ok: false, error: rec0.note, record: rec0 };
  }
  running.set(id, { started: new Date().toISOString(), env: s.env });
  const lp = last(p);   // prev: the last promote that held - the tickets promoted this time are the ones named since it
  const rec = { at: new Date().toISOString(), env: s.env, mode: 'git', from: null, to: null, prev: lp ? (lp.ok ? lp.to : lp.prev || null) : null, ok: false, url: s.url || null, status: null, ms: 0, rolledBack: false, note: null, by: by || 'owner', after: [] };
  const t0 = Date.now();
  try {
    let branch = s.branch; try { if (!branch) branch = git(s.src, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch (e) { throw new Error('the dev folder is not a git repository (' + String(e.message).split('\n')[0] + ')'); }
    rec.to = git(s.src, ['rev-parse', 'HEAD']);
    const dirty = git(s.src, ['status', '--porcelain']); if (dirty) say('dev has uncommitted changes - they do not go (' + dirty.split('\n').length + ' paths)');
    if (!fs.existsSync(s.to)) { fs.mkdirSync(s.to, { recursive: true }); }
    let isRepo = false; try { git(s.to, ['rev-parse', '--is-inside-work-tree']); isRepo = fs.existsSync(path.join(s.to, '.git')); } catch (e) { isRepo = false; }
    if (!isRepo) { git(s.to, ['init', '-q']); say('initialised ' + s.to); }
    try { rec.from = git(s.to, ['rev-parse', 'HEAD']); } catch (e) { rec.from = null; }
    const same = rec.from === rec.to;   // nothing to move: still smoked, so a re-run after a fix is a real read-back
    if (same) rec.note = 'already at ' + rec.to.slice(0, 9) + ' - nothing to move; smoked again';
    else {
      /* the target's database, dumped before anything moves: the after commands run the migrations on
         it, and a migration that goes wrong is then a restore. Said when there is none; never a stop. */
      running.set(id, { ...(running.get(id) || {}), stage: 'backing up the ' + s.env + ' database' });
      try { rec.dbBackup = await require('./hot').hot(path.join(__dirname, 'backup.js')).backupTarget(path.join(__dirname, '..'), p, s.to, s.env); } catch (e) { rec.dbBackup = { ok: false, why: e.message }; }
      say(rec.dbBackup.ok ? 'backed up the ' + s.env + ' database ' + rec.dbBackup.database + ' (' + Math.round(rec.dbBackup.size / 1024) + ' KB) to ' + rec.dbBackup.file : s.env + ' database not backed up: ' + rec.dbBackup.why);
      running.set(id, { ...(running.get(id) || {}), stage: 'moving the code' });
      git(s.to, ['fetch', '-q', s.src, branch], { timeout: 600000 });
      git(s.to, ['reset', '-q', '--hard', 'FETCH_HEAD']);
      say(s.env + ' at ' + rec.to.slice(0, 9) + (rec.from ? ' (was ' + rec.from.slice(0, 9) + ')' : ''));
      for (const cmd of s.after) {
        const a0 = Date.now();
        try { const out = cp.execSync(cmd, { cwd: s.to, encoding: 'utf8', timeout: 600000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); rec.after.push({ cmd, ok: true, ms: Date.now() - a0, tail: String(out).trim().split('\n').slice(-2).join(' | ').slice(0, 200) }); say('after: ' + cmd + ' ok'); }
        catch (e) { rec.after.push({ cmd, ok: false, ms: Date.now() - a0, tail: String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' | ').slice(0, 300) }); throw new Error('after "' + cmd + '" failed: ' + rec.after[rec.after.length - 1].tail); }
      }
    }
    const sm = await smoke(s.url); rec.status = sm.status; rec.ok = sm.ok; if (!same) rec.note = sm.note || null;
    if (!sm.ok) throw new Error('smoke failed on ' + s.url + ': ' + sm.note);
    /* the prod test: every README flow's reading half, in a real browser, on the environment just deployed - the
       screens opened and read, nothing pressed that writes (best practice - no write test on the
       customer's data). A red is a real break in front of a person: the target is rolled back below. */
    if (s.url) {
      running.set(id, { ...(running.get(id) || {}), stage: 'the prod test' });
      const fl = await require('./hot').hot(path.join(__dirname, 'tests.js')).lookFlows(p, s.url, s.env, say);
      rec.flows = { mode: 'look', ran: fl.files.length, passed: fl.passed, failed: fl.failed, skipped: !!fl.skipped, why: fl.why || null, files: fl.files.map((f) => ({ file: f.file, ok: f.ok, ms: f.ms, shot: f.shot || null, tail: f.ok ? null : String(f.tail || '').split('\n').filter((l) => /stopped at|Error/.test(l)).slice(-1)[0] || null })) };
      say('prod test on ' + s.env + ': ' + (fl.skipped ? fl.why : fl.passed + ' of ' + fl.files.length + ' flows read back' + (fl.failed ? ', ' + fl.failed + ' FAILED' : '')));
      if (fl.failed) { rec.ok = false; throw new Error('the prod test failed on ' + s.url + ': ' + fl.files.filter((f) => !f.ok).map((f) => f.file).slice(0, 4).join(', ')); }
    }
  } catch (e) {
    rec.ok = false; rec.note = e.message; say('FAILED - ' + e.message);
    if (rec.from && rec.to && rec.from !== rec.to) { try { git(s.to, ['reset', '-q', '--hard', rec.from]); rec.rolledBack = true; say('rolled ' + s.env + ' back to ' + rec.from.slice(0, 9)); } catch (x) { rec.note += ' - and the rollback failed: ' + x.message; } }
    else if (!rec.from && rec.to) rec.note += ' (a first promote into an empty folder - nothing to roll back to; the folder holds ' + rec.to.slice(0, 9) + ')';
  }
  rec.ms = Date.now() - t0;
  fs.mkdirSync(path.dirname(smokeFile(p)), { recursive: true }); fs.writeFileSync(smokeFile(p), JSON.stringify(rec, null, 1) + '\n');
  running.delete(id);
  try { if (rec.ok) require('./events').resolve(p, { kind: 'promote.fail' }); } catch (e) { /* */ }
  try { require('./events').record(p, rec.ok ? { kind: 'promote.ok', level: 'info', title: 'promoted to ' + s.env + (rec.to ? ' · ' + String(rec.to).slice(0, 9) : ''), text: by || '', source: 'promote' } : { kind: 'promote.fail', level: 'alert', title: 'promote to ' + s.env + ' FAILED' + (rec.rolledBack ? ' - rolled back' : ''), text: rec.note || '', source: 'promote' }); } catch (e) { /* */ }
  try { require('./hot').hot(path.join(__dirname, 'tickets.js')).afterScan(p, (t) => say(t)); } catch (e) { say('tickets after promote: ' + e.message); }
  try { require('./projects').bump(id); } catch (e) { /* */ }
  return { ok: rec.ok, record: rec, error: rec.ok ? null : rec.note };
}

/* auto: a ticket was passed - the next environment, unless the project says manual or is observed */
function onPassed(p, ticketId, log) {
  const s = settings(p);
  if (s.trigger === 'manual' || s.mode === 'observed') return { started: false, why: s.mode === 'observed' ? 'observed' : 'manual' };
  setTimeout(() => { run(p, 'cockpit (auto after ' + ticketId + ' passed)', log).catch((e) => { if (log) log('promote → ' + e.message); }); }, 500);
  return { started: true };
}

/* observed: the environment's endpoint (tk_env, read by the Tickets scan) reports a version; a passed ticket whose last
   commit is an ancestor of it went out */
function observe(p, log) {
  const s = settings(p); if (s.mode !== 'observed') return;
  let row = null; try { row = p.db.get('SELECT version FROM tk_env WHERE env = ? ORDER BY at DESC LIMIT 1', s.env); } catch (e) { return; }
  if (!row || !row.version) return;
  let sha = null; try { const j = JSON.parse(row.version); sha = j.sha || j.commit || j.gitSha || j.version; } catch (e) { sha = String(row.version).trim(); }
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(String(sha))) return;
  const tk = require('./hot').hot(path.join(__dirname, 'tickets.js'));
  for (const t of tk.list(p)) {
    if (t.state !== 'passed') continue;
    const id = t.number ? '#' + t.number : t.id;
    let commit = null; try { commit = git(p.dir, ['log', '-1', '--format=%H', '--all', '--grep=' + id.replace('#', '#')]); } catch (e) { commit = null; }
    if (!commit) continue;
    try { git(p.dir, ['merge-base', '--is-ancestor', commit, sha]); } catch (e) { continue; }
    const r = tk.setState(p, t.id, 'promoted', 'cockpit', s.env + ' reports ' + String(sha).slice(0, 9) + ', which carries ' + commit.slice(0, 9) + ' naming ' + id);
    if (r.ok && log) log('ticket ' + id + ' → promoted (' + s.env + ' observed)');
  }
}

module.exports = { settings, status, run, onPassed, observe, last };
