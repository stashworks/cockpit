/* Backups - every project's code and database, kept safe without anyone remembering to.

   Cockpit is meant to be run by people who are not technical, and a lot of people do not back up their work and lose
   it. So: an easy backup of the database, if one is connected and changed, and of the code, if code was changed, to a
   folder inside the engine, broken down by project, keeping the last 14 copies.

   On a timer (engine/server.js, every CHECK_MINUTES, every registered project, open or not) and on "Back up now",
   each project is looked at twice -
     code      the project folder, machinery left out (SKIP below: .git, node_modules, vendor, build output). A
               fingerprint of every file's path, size and time; changed since the last copy → one .zip of the lot.
     database  found the way the Database plugin finds it (plugins/database/creds.js: the project's .env or db.php,
               or the config folder beside the apps). A fingerprint of information_schema (rows, sizes, update
               times); changed → mysqldump, gzipped. No database found is not an error; it is said.
   Copies land in <engine>\backups\<project id>\code\<stamp>.zip and \db\<stamp>.sql.gz; the newest KEEP of each
   kind stay. state.json beside them remembers the fingerprints and the last result. Every copy written is an
   event on the project, so Home says "backed up" in plain words.

   Zero-install: Windows' own tar.exe writes the zip (bsdtar, in every Windows 10+), node's zlib gzips the dump,
   mysqldump is the one already beside the mysql client. Nothing here reads the password onto a command line: it
   rides as MYSQL_PWD in the child's environment, as the Database scan does. Stateless module - hot-loaded. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const KEEP = 14;                       // copies kept per kind, per project
const SKIP = new Set(['.coders', '.git', 'node_modules', 'vendor', 'cache', '.cache', 'dist', '.next', '.turbo', 'coverage', 'build', '__pycache__', 'browsers', 'logs', 'log', 'tmp', 'temp']);   // machinery and noise, not the work
const SKIP_REL = new Set(['tools/dl', 'tools/zap', 'tools/semgrep', 'tools/browsers', 'accounts']);   // accounts: the coders' Claude logins (engine/fleet.js) - tokens never go into a backup zip   // the engine's own unpacked tools and archives (a gigabyte that is not the work)
const SKIP_FILE = (name) => /\.log$/i.test(name) || /^cockpit\.db(-wal|-shm)?$/.test(name);   // logs churn; the project's live cockpit.db changes on every scan and event (its tickets and conversations are files beside it)
const MAX_BYTES = 2 * 1024 * 1024 * 1024;   // a code copy above this is refused with the size, not attempted (2 GB)
const running = new Map();                 // project id -> true while a run is on; a hot reload forgets it, which is fine

const dir = (root, p) => path.join(root, 'backups', p.entry.id);
const stateFile = (root, p) => path.join(dir(root, p), 'state.json');
function readState(root, p) { try { return JSON.parse(fs.readFileSync(stateFile(root, p), 'utf8')); } catch (e) { return {}; } }
function writeState(root, p, st) { fs.mkdirSync(dir(root, p), { recursive: true }); fs.writeFileSync(stateFile(root, p), JSON.stringify(st, null, 2) + '\n'); }
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
const settings = (p) => (p.cockpit && p.cockpit.json && p.cockpit.json.backup) || {};

/* ---------- code ---------- */
/* every file under the project, machinery skipped; the engine's own backups folder skipped when the project IS the engine */
function walk(root, p) {
  const out = [], base = p.dir; let bytes = 0;
  const own = path.resolve(base) === path.resolve(root) ? 'backups' : null;
  (function rec(rel) {
    let ents; try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (SKIP.has(e.name) || (own && !rel && e.name === own) || (!e.isDirectory() && SKIP_FILE(e.name))) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (SKIP_REL.has(r)) continue; rec(r); }
      else if (e.isFile()) { let st; try { st = fs.statSync(path.join(base, r)); } catch (e2) { continue; } out.push({ rel: r, size: st.size, mtime: Math.round(st.mtimeMs) }); bytes += st.size; }
    }
  })('');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = crypto.createHash('sha1'); for (const f of out) h.update(f.rel + '\t' + f.size + '\t' + f.mtime + '\n');
  return { files: out, bytes, hash: h.digest('hex') };
}
function tarBin() {
  if (process.platform === 'win32') { const t = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); if (fs.existsSync(t)) return t; }
  return 'tar';
}
function run(bin, args, opts) {
  return new Promise((resolve) => {
    cp.execFile(bin, args, { windowsHide: true, maxBuffer: 1 << 24, ...(opts || {}) }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}
async function zipCode(root, p, files) {
  const out = path.join(dir(root, p), 'code'); fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, stamp() + '.zip'), list = path.join(out, '.list.tmp');
  fs.writeFileSync(list, files.map((f) => f.rel).join('\n') + '\n');
  const r = await run(tarBin(), ['--format', 'zip', '-c', '-f', file, '-C', p.dir, '-T', list]);
  try { fs.unlinkSync(list); } catch (e) { /* */ }
  /* tar exits 1 with "Error exit delayed from previous errors" when a few files could not be read (locked, no permission) but
     the archive was written all the same: that is a backup with a note, not a failure. No archive = a failure. */
  const lines = String(r.stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/Error exit delayed/.test(l));
  let size = 0; try { size = fs.statSync(file).size; } catch (e) { /* */ }
  if (r.err && size < 100) { try { fs.unlinkSync(file); } catch (e) { /* */ } throw new Error('zip failed: ' + (lines.slice(-1)[0] || r.err.message).slice(0, 200)); }
  return { file, skipped: r.err ? lines.map((l) => l.replace(/^tar(\.exe)?:\s*/i, '').slice(0, 160)).slice(0, 12) : [] };
}

/* ---------- database ---------- */
function creds(p) {
  const plugins = require('./plugins');
  let A = null; try { A = plugins.answers(p, 'database'); } catch (e) { /* */ }
  const credsFile = path.join(__dirname, '..', 'plugins', 'database', 'creds.js');
  delete require.cache[require.resolve(credsFile)];   // read fresh, like this module: a fix there needs no restart (2026-10-31)
  const lib = require(credsFile);
  const c = lib.read(p.dir, A || {});
  if (c.error) return { none: c.error };
  return { c, mysql: lib.client(A || {}, 'mysql'), dump: lib.client(A || {}, 'mysqldump') };
}
const baseArgs = (c) => ['--host=' + c.host, '--port=' + c.port, '--user=' + c.user];
async function dbFingerprint(d) {
  if (!d.mysql) return { error: 'mysql client not found on this machine' };
  // MySQL 8 caches these columns for a day (information_schema_stats_expiry); the session asks for them fresh, or a change could go unseen until tomorrow
  const sql = "SET SESSION information_schema_stats_expiry=0; SELECT table_name, table_type, table_rows, data_length, index_length, auto_increment, update_time, create_time FROM information_schema.tables WHERE table_schema='" + d.c.name.replace(/'/g, "''") + "' ORDER BY table_name";
  const r = await run(d.mysql, [...baseArgs(d.c), '--batch', '--connect-timeout=10', '-e', sql], { env: { ...process.env, MYSQL_PWD: d.c.password } });
  if (r.err) return { error: 'mysql: ' + (r.stderr || r.err.message).trim().split(/\r?\n/).filter((l) => !/^mysql: \[Warning\]/.test(l)).slice(-1)[0].slice(0, 200) };
  const rows = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { hash: crypto.createHash('sha1').update(r.stdout).digest('hex'), tables: Math.max(0, rows.length - 1) };
}
function dumpDb(root, p, d) {
  return new Promise((resolve, reject) => {
    if (!d.dump) return reject(new Error('mysqldump not found on this machine'));
    const out = path.join(dir(root, p), 'db'); fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, stamp() + '.sql.gz');
    const child = cp.spawn(d.dump, [...baseArgs(d.c), '--single-transaction', '--routines', '--events', '--triggers', '--skip-dump-date', d.c.name], { windowsHide: true, env: { ...process.env, MYSQL_PWD: d.c.password } });
    const gz = zlib.createGzip(), ws = fs.createWriteStream(file); let err = '', code = null, finished = false, done = false;
    child.stderr.on('data', (b) => { err += String(b); });
    child.stdout.pipe(gz).pipe(ws);
    const bad = (msg) => { if (done) return; done = true; try { fs.unlinkSync(file); } catch (e2) { /* */ } reject(new Error('mysqldump: ' + msg)); };
    // judged only once the dump has exited AND the file is closed - an early failure closes the pipe before the exit code is known
    const settle = () => { if (done || code === null || !finished) return; if (code !== 0) return bad(err.trim().split(/\r?\n/).filter((l) => !/\[Warning\]/.test(l)).slice(-1)[0].slice(0, 200) || 'exit ' + code); done = true; resolve(file); };
    child.on('error', (e) => bad(e.message));
    child.on('close', (c) => { code = c == null ? 1 : c; settle(); });
    ws.on('finish', () => { finished = true; settle(); });
    ws.on('error', (e) => bad('write: ' + e.message));
  });
}

/* ---------- copies ---------- */
function copies(root, p, kind) {
  const d = path.join(dir(root, p), kind);
  let names = []; try { names = fs.readdirSync(d).filter((f) => /\.(zip|sql\.gz)$/.test(f)); } catch (e) { return []; }
  return names.sort().reverse().map((f) => { let st = null; try { st = fs.statSync(path.join(d, f)); } catch (e) { /* */ } return { file: f, path: path.join(d, f), bytes: st ? st.size : 0, at: st ? st.mtime.toISOString() : null }; });
}
function prune(root, p, kind, keep) { for (const c of copies(root, p, kind).slice(typeof keep === 'number' ? keep : KEEP)) { try { fs.unlinkSync(c.path); } catch (e) { /* */ } } }

/* ---------- THE VAULT: the project's own .cockpit folder, kept apart and kept longer ----------
   The project's memory - its tickets, verdicts, conversations, rules, layouts - lives in `.cockpit` INSIDE the project,
   which makes it something a coder can delete by accident: once a `git clean` in a project took the whole
   folder (untracked, not ignored) with 66 tickets and their verdicts, and the code copies - 14 of them, seven hours -
   had already rolled past it. So the vault: `.cockpit` alone, zipped at most hourly, and put BACK automatically when
   the engine finds the folder gone.

   KEPT SMALL ON PURPOSE (a busy project's .cockpit can be 36 MB raw, so a
   week of hourly copies would have been near a gigabyte for one project). Three things hold it down:
     changed only   a fingerprint of the folder; an hour in which nothing changed writes nothing at all
     thinned        every copy for the last 24 hours, then ONE per day for 14 days - the rest go
     trimmed        the cache, the logs, the write-ahead files and the stamped test reports (regenerated every run)
                    stay out; the tickets, verdicts, rules, plugin answers, conversations and the database go in
   Worst case per project is 24 + 14 copies, and only in an hour where something actually changed. */
const VAULT_HOURLY_H = 24;             // every copy from the last day
const VAULT_DAILY_D = 14;              // then one a day for a fortnight
const VAULT_EVERY_MS = 60 * 60 * 1000;
const vaultDir = (root, id) => path.join(root, 'backups', id, 'cockpit');
function vaultCopies(root, id) {
  let names = []; try { names = fs.readdirSync(vaultDir(root, id)).filter((f) => /\.zip$/.test(f)); } catch (e) { return []; }
  return names.sort().reverse().map((f) => { const full = path.join(vaultDir(root, id), f); let st = null; try { st = fs.statSync(full); } catch (e) { /* */ } return { file: f, path: full, bytes: st ? st.size : 0, at: st ? st.mtime.toISOString() : null }; });
}
/* what the copy holds, and the fingerprint that says whether it changed */
function vaultWalk(p) {
  const base = path.join(p.dir, '.cockpit'); const out = []; let bytes = 0;
  const skipDir = new Set(['cache', 'logs']);
  const skipFile = (rel, name) => /\.db-(wal|shm)$/.test(name) || (rel.startsWith('tests/') && /^\d{4}-\d{2}-\d{2}T/.test(name));   // the stamped test reports: every run writes one, latest.json is the one that matters
  (function rec(rel) {
    let ents; try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!rel && skipDir.has(e.name)) continue; rec(r); }
      else if (e.isFile() && !skipFile(rel ? rel + '/' : '', e.name)) { let st; try { st = fs.statSync(path.join(base, r)); } catch (e2) { continue; } out.push({ rel, name: e.name, full: '.cockpit/' + r, size: st.size, mtime: Math.round(st.mtimeMs) }); bytes += st.size; }
    }
  })('');
  out.sort((a, b) => (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
  const h = crypto.createHash('sha1'); for (const f of out) h.update(f.full + '\t' + f.size + '\t' + f.mtime + '\n');
  return { files: out, bytes, hash: h.digest('hex') };
}
/* the thinning: everything from the last day, then the newest of each older day, for a fortnight */
function vaultThin(root, id) {
  const all = vaultCopies(root, id); const now = Date.now(); const keptDay = new Set(); const gone = [];
  for (const c of all) {
    const t = c.at ? Date.parse(c.at) : 0; const ageH = (now - t) / 3600000;
    if (ageH <= VAULT_HOURLY_H) continue;                                   // the last day: all of it
    const day = String(c.at || '').slice(0, 10);
    if (ageH <= VAULT_DAILY_D * 24 && !keptDay.has(day)) { keptDay.add(day); continue; }   // one a day after that
    gone.push(c);
  }
  for (const c of gone) { try { fs.unlinkSync(c.path); } catch (e) { /* */ } }
  return gone.length;
}
async function vault(root, p, opts) {
  const st = readState(root, p);
  if (!(opts && opts.force) && st.vaultAt && Date.now() - Date.parse(st.vaultAt) < VAULT_EVERY_MS) return { skipped: 'hourly' };
  const src = path.join(p.dir, '.cockpit');
  if (!fs.existsSync(src)) return { error: 'no .cockpit to copy' };
  const w = vaultWalk(p);
  if (!(opts && opts.force) && st.vault && st.vault.fingerprint === w.hash) { writeState(root, p, { ...st, vaultAt: new Date().toISOString() }); return { unchanged: true, files: w.files.length, bytes: w.bytes }; }
  const out = vaultDir(root, p.entry.id); fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, stamp() + '.zip'), list = path.join(out, '.list.tmp');
  fs.writeFileSync(list, w.files.map((f) => f.full).join('\n') + '\n');
  const r = await run(tarBin(), ['--format', 'zip', '-c', '-f', file, '-C', p.dir, '-T', list]);
  try { fs.unlinkSync(list); } catch (e) { /* */ }
  let size = 0; try { size = fs.statSync(file).size; } catch (e) { /* */ }
  if (size < 100) { try { fs.unlinkSync(file); } catch (e) { /* */ } return { error: 'zip failed: ' + String(r.stderr || (r.err && r.err.message) || '').trim().split(/\r?\n/).slice(-1)[0] }; }
  const dropped = vaultThin(root, p.entry.id);
  writeState(root, p, { ...st, vaultAt: new Date().toISOString(), vault: { fingerprint: w.hash, file: path.basename(file), files: w.files.length, bytes: size, at: new Date().toISOString() } });
  return { file: path.basename(file), files: w.files.length, bytes: size, thinned: dropped };
}
/* the folder is gone: put the newest copy back before the engine writes an empty one over the hole */
function restoreVault(root, id, projectDir) {
  const c = vaultCopies(root, id)[0];
  if (!c) return { ok: false, why: 'no copy kept for ' + id };
  try {
    cp.execFileSync(tarBin(), ['-x', '-f', c.path, '-C', projectDir], { timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: fs.existsSync(path.join(projectDir, '.cockpit')), from: c.file, at: c.at };
  } catch (e) { return { ok: false, why: e.message.split('\n')[0].slice(0, 200) }; }
}

/* ---------- the run ---------- */
/* look at both, copy what changed (or everything, with force); the result is what the card shows */
async function backup(root, p, opts) {
  opts = opts || {};
  if (running.get(p.entry.id)) return { ok: false, error: 'a backup is already running for this project' };
  running.set(p.entry.id, true);
  const st = readState(root, p), at = new Date().toISOString(), res = { at, code: {}, db: {} };
  try {
    // code
    try {
      const w = walk(root, p);
      if (w.bytes > MAX_BYTES) res.code = { error: 'the folder is ' + (w.bytes / 1073741824).toFixed(1) + ' GB - too big to copy whole; say which folders to leave out', files: w.files.length, bytes: w.bytes };
      else if (!opts.force && st.code && st.code.fingerprint === w.hash) res.code = { unchanged: true, files: w.files.length, bytes: w.bytes };
      else { const z = await zipCode(root, p, w.files); prune(root, p, 'code'); res.code = { file: path.basename(z.file), files: w.files.length, bytes: w.bytes, zipBytes: fs.statSync(z.file).size, skipped: z.skipped }; st.code = { fingerprint: w.hash, at, file: path.basename(z.file), files: w.files.length, bytes: w.bytes, skipped: z.skipped }; }
    } catch (e) { res.code = { error: e.message }; }
    // database
    try {
      const d = creds(p);
      if (d.none) res.db = { none: d.none };
      else {
        const fp = await dbFingerprint(d);
        if (fp.error) res.db = { name: d.c.name, error: fp.error };
        else if (!opts.force && st.db && st.db.fingerprint === fp.hash) res.db = { name: d.c.name, unchanged: true, tables: fp.tables };
        else { const file = await dumpDb(root, p, d); prune(root, p, 'db'); res.db = { name: d.c.name, file: path.basename(file), tables: fp.tables, bytes: fs.statSync(file).size }; st.db = { name: d.c.name, fingerprint: fp.hash, at, file: path.basename(file), tables: fp.tables }; }
      }
    } catch (e) { res.db = { error: e.message }; }
    // the vault: .cockpit on its own, hourly, a week of copies - the project's memory outlives a coder's `git clean`
    try { res.vault = await vault(root, p, opts); } catch (e) { res.vault = { error: e.message }; }
    st.last = res; st.checked = at;
    writeState(root, p, { ...readState(root, p), ...st });   // vault() wrote vaultAt into the state; keep it
    // the record, in plain words, only when a copy was written or something failed
    try {
      const ev = require('./hot').hot(path.join(__dirname, 'events.js'));
      const wrote = [res.code.file ? 'the code (' + res.code.files + ' files' + (res.code.skipped && res.code.skipped.length ? ', ' + res.code.skipped.length + ' could not be read' : '') + ')' : null, res.db.file ? 'the database ' + res.db.name + ' (' + res.db.tables + ' tables)' : null].filter(Boolean);
      if (wrote.length) ev.record(p, { kind: 'backup', level: 'info', title: 'backed up ' + wrote.join(' and '), text: 'a change was found; the newest ' + KEEP + ' copies are kept in the engine\'s backups folder' + (res.code.skipped && res.code.skipped.length ? ' · not in the copy: ' + res.code.skipped.slice(0, 4).join('; ') : ''), ref: 'backup:' + at, source: 'backup' });
      const failed = [res.code.error ? 'code: ' + res.code.error : null, res.db.error ? 'database: ' + res.db.error : null].filter(Boolean).join(' · ');
      const said = st.lastFailure || {};
      if (failed && (said.text !== failed || Date.now() - Date.parse(said.at || 0) > 864e5)) { ev.record(p, { kind: 'backup', level: 'warn', title: 'a backup did not happen', text: failed + ' - said once; again if the reason changes or a day passes', ref: 'backup-failed', source: 'backup' }); st.lastFailure = { text: failed, at }; writeState(root, p, st); }
      if (!failed && st.lastFailure) { delete st.lastFailure; writeState(root, p, st); }
      if (!failed) ev.resolve(p, { kind: 'backup', ref: 'backup-failed' });   // the copy landed: the failure is over, nobody ticks it
    } catch (e) { /* the event is a courtesy */ }
    return { ok: true, ...res };
  } finally { running.delete(p.entry.id); }
}

/* what the card shows: the last result, the copies on disk, the folder, the switch */
function status(root, p) {
  const st = readState(root, p);
  return { ok: true, folder: dir(root, p), off: !!settings(p).off, keep: KEEP, running: !!running.get(p.entry.id), checked: st.checked || null, last: st.last || null,
    code: { ...(st.code || {}), copies: copies(root, p, 'code') }, db: { ...(st.db || {}), copies: copies(root, p, 'db') },
    vault: (() => { const cs = vaultCopies(root, p.entry.id); return { at: st.vaultAt || null, keeps: 'every copy for ' + VAULT_HOURLY_H + ' h, then one a day for ' + VAULT_DAILY_D + ' days', copies: cs.slice(0, 3), count: cs.length, bytes: cs.reduce((n, c) => n + c.bytes, 0) }; })() };
}

/* HOW OFTEN. The timer still wakes every 30 minutes; a project is looked at only when its own interval
   has passed since it was last looked at. A project may set its own in cockpit.json: { "backup": { "everyMinutes": n } }.
   One big project alone had been writing a 364 MB zip every half hour while the coders worked - 5.2 GB for copies GitHub holds. */
const EVERY_PROJECT_MIN = 24 * 60, EVERY_ENGINE_MIN = 30;
function everyMinutes(root, p) { const n = Number(settings(p).everyMinutes); if (n > 0) return n; return path.resolve(p.dir) === path.resolve(root) ? EVERY_ENGINE_MIN : EVERY_PROJECT_MIN; }
/* the timer's pass: every registered project, open or not, unless it is switched off; one at a time */
/* AN EXTERNAL NIGHTLY BACKUP, WATCHED (optional). A backup job outside Cockpit (another PC's nightly copy to an external
   drive, say) can write its result as JSON - { "at": "<ISO time>", "ok": true|false, "failed": ["step", ...] } - to a file
   this machine can read. Name that file in engine.json "externalBackupStatus" (or COCKPIT_EXTERNAL_BACKUP_STATUS) and Home
   gets an alert when the last run failed a step, or when the last good run is more than 26 hours old - which also catches
   a run that never happened (drive unplugged, the PC off, the task broken). It clears itself when a good run lands. Checked
   with every backup pass (half-hourly). Not named = not watched. */
function externalStatusFile() {
  if (process.env.COCKPIT_EXTERNAL_BACKUP_STATUS) return path.resolve(process.env.COCKPIT_EXTERNAL_BACKUP_STATUS);
  try { const c = require('./config').loadEngineConfig(path.join(__dirname, '..')); if (typeof c.externalBackupStatus === 'string' && c.externalBackupStatus) return path.resolve(path.join(__dirname, '..'), c.externalBackupStatus); } catch (e) { /* none */ }
  return null;
}
const DESK_LATE_H = 26;
function deskBackupCheck(projects) {
  const file = externalStatusFile(); if (!file) return;
  let home; try { home = projects.open('home'); } catch (e) { return; } if (!home || home.missing) return;
  const ev = require('./hot').hot(path.join(__dirname, 'events.js'));
  let s = null; try { s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { /* none yet */ }
  const ageH = s && s.at ? (Date.now() - Date.parse(s.at)) / 3600000 : Infinity;
  let why = null;
  if (!s) why = 'the external backup has never reported (' + file + ')';
  else if (!s.ok) why = 'the last backup had failures: ' + (s.failed || []).join('; ');
  else if (ageH > DESK_LATE_H) why = 'no backup has run for ' + Math.round(ageH) + ' hours (the last good one was ' + String(s.at).slice(0, 16).replace('T', ' ') + ') - is the backup drive plugged in and the machine on?';
  /* ONCE PER BACKUP RUN (2026-10-31: every half-hourly check re-recorded the same failed run, so ticking it seen brought it
     straight back). The same run's result, or the same lateness, alerts once; the next run that fails, or a run that goes
     missing, alerts again. */
  const key = !s ? 'never' : !s.ok ? 'failed|' + s.at : ageH > DESK_LATE_H ? 'late|' + s.at : '';
  const SAID = path.join(path.dirname(file), 'external-backup-alerted.json');
  let said = ''; try { said = JSON.parse(fs.readFileSync(SAID, 'utf8')).key || ''; } catch (e) { /* first time */ }
  if (why && key !== said) {
    ev.record(home, { kind: 'backup', level: 'alert', title: 'External backup failing', text: why, ref: 'desk-backup', source: 'external nightly backup' });
    try { fs.writeFileSync(SAID, JSON.stringify({ key, at: new Date().toISOString() }) + '\n'); } catch (e) { /* says it again next pass */ }
  } else if (!why) ev.resolve(home, { kind: 'backup', ref: 'desk-backup' });
}
async function tick(root, projects, registry, log) {
  try { deskBackupCheck(projects); } catch (e) { if (log) log('[backup] desk check: ' + e.message); }
  for (const entry of registry.all()) {
    let p; try { p = projects.open(entry.id); } catch (e) { continue; }
    if (!p || p.missing || settings(p).off) continue;
    const last = Date.parse(readState(root, p).checked || 0);
    if (last && Date.now() - last < everyMinutes(root, p) * 60000 - 60000) continue;   // a minute's slack, so a 30-minute project is not skipped by a timer that fires a hair early
    try { const r = await backup(root, p, {}); if (log && (r.code.file || r.db.file || r.code.error || r.db.error)) log('[backup] ' + entry.id + ': ' + JSON.stringify({ code: r.code.file || r.code.error || 'unchanged', db: r.db.file || r.db.error || r.db.none || 'unchanged' })); }
    catch (e) { if (log) log('[backup] ' + entry.id + ': ' + e.message); }
  }
}

/* THE TARGET'S DATABASE BEFORE A PROMOTE.
   The promote's target folder is not a Cockpit project - prod's database was never backed up by the engine. This dumps the
   database the target folder's own config names (found as the Database plugin finds it, e.g. <apps parent>\config\<folder>\db.php)
   into backups\<project>-<env>\db\, the newest KEEP kept, and returns the file - so a migration that goes wrong on prod
   is a restore, not a loss. No database found is said, not thrown: the promote goes on and the record carries the why. */
async function backupTarget(root, p, folder, envName) {
  const fake = { dir: folder, entry: { id: p.entry.id + '-' + (envName || 'prod') }, cockpit: p.cockpit };
  // the target folder's OWN config, never the dev project's Database answers (those name dev's database)
  const lib = require(path.join(__dirname, '..', 'plugins', 'database', 'creds.js'));
  const c = lib.read(folder, {});
  if (c.error) return { ok: false, why: 'no database found for ' + folder + ': ' + c.error };
  const d = { c, mysql: lib.client({}, 'mysql'), dump: lib.client({}, 'mysqldump') };
  try { const file = await dumpDb(root, fake, d); prune(root, fake, 'db'); return { ok: true, file, database: d.c.name, size: (() => { try { return fs.statSync(file).size; } catch (e) { return 0; } })() }; }
  catch (e) { return { ok: false, why: e.message, database: d.c.name }; }
}

module.exports = { backup, backupTarget, vault, vaultCopies, vaultThin, restoreVault, status, tick, KEEP, SKIP };
