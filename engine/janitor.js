/* JANITOR (coders made side copies of the whole repo and never
   removed them; over a million files piled up in one coder folder, and pnpm's hard links kept some of them "in use").

   Once a night (after 03:30 local), for EVERY registered project that has coder folders (<project>\.coders\<coder>), and for
   every project's own .cockpit\tmp:
     - a coder folder's TOP-LEVEL leftovers older than a day: side copies (.wt-*, wt-*, issue-<n>, issue-<n>-local, *-local,
       .tmp*, tmp-*) - unregistered from git first (git worktree remove --force), then deleted; and junk files with mangled
       names (nul, "-", flattened Windows paths like "C:Usersname...").
     - <project>\.cockpit\tmp entries older than 7 days.
     - then `git worktree prune` in the project's repo.
   NEVER: the coder folder itself, anything git tracks, node_modules, .env files, .cockpit\cache, Cockpit's data.
   A file the OS refuses (in use - pnpm hard-links package files across every install, so a running dev site holds the same
   file under another name) is left and counted; the next night tries again. Every run appends a summary to
   logs/janitor.log and records one event per project (what was removed, MB freed, what was left and why).
   Installed from engine/ghqueue.js (re-read without a restart), the same way as engine/lagwatch.js. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const LOG = path.join(__dirname, '..', 'logs', 'janitor.log');
const STATE = path.join(__dirname, '..', 'logs', 'janitor.state.json');
const RUN_AFTER_HOUR = 3, RUN_AFTER_MIN = 30;
const DAY = 864e5;
const LEFTOVER_DIR = /^(\.wt-.*|wt-.*|issue-\d+(-local)?|.*-local|\.tmp.*|tmp-.*)$/i;
// reserved device names, a lone dash, and a Windows path flattened into ONE name (drive letter + the private-use colon U+F03A
// that MSYS/WSL write for ':' - "C<U+F03A>Users...Temp...json" sat in Pi's folder, 2026-10-02)
const JUNK_FILE = /^(nul|con|prn|aux|-|[A-Za-z].*)$/i;
const put = (l) => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, new Date().toISOString() + '  ' + l + '\n'); } catch (e) { /* */ } };

function sizeAndCount(p) {
  let bytes = 0, files = 0; const stack = [p];
  while (stack.length) {
    const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) { const f = path.join(d, e.name); if (e.isDirectory()) stack.push(f); else { files++; try { bytes += fs.statSync(f).size; } catch (x) { /* */ } } }
  }
  return { bytes, files };
}
function remove(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }); } catch (e) { /* counted below */ }
  return !fs.existsSync(p);
}
function git(cwd, args) { try { return cp.execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return ''; } }

function cleanProject(p) {
  const out = { removed: [], left: [], bytes: 0, files: 0 };
  const now = Date.now();
  const repoDir = (() => { try { return require('./hot').hot(path.join(__dirname, 'verify.js')).repoOf(p).dir; } catch (e) { return p.dir; } })();
  // 1. coder folders' top-level leftovers
  const coders = path.join(p.dir, '.coders');
  if (fs.existsSync(coders)) {
    for (const c of fs.readdirSync(coders, { withFileTypes: true })) {
      if (!c.isDirectory()) continue;
      const cdir = path.join(coders, c.name);
      for (const e of fs.readdirSync(cdir, { withFileTypes: true })) {
        const f = path.join(cdir, e.name);
        const isLeftDir = e.isDirectory() && LEFTOVER_DIR.test(e.name) && !/^(node_modules|apps|packages|\.git|\.cockpit)$/i.test(e.name);
        const isJunk = !e.isDirectory() && JUNK_FILE.test(e.name);
        if (!isLeftDir && !isJunk) continue;
        let age = 0; try { age = now - fs.statSync(f).mtimeMs; } catch (x) { /* */ }
        if (age < DAY) continue;   // a copy in use today is left alone
        const tracked = git(cdir, ['ls-files', '--', e.name]).trim(); if (tracked) continue;   // never anything git tracks
        const sz = e.isDirectory() ? sizeAndCount(f) : { bytes: 0, files: 1 };
        if (e.isDirectory() && fs.existsSync(path.join(f, '.git'))) { git(repoDir, ['worktree', 'remove', '--force', f]); git(cdir, ['worktree', 'remove', '--force', f]); }
        const rel = path.relative(p.dir, f);
        if (remove(f)) { out.removed.push(rel); out.bytes += sz.bytes; out.files += sz.files; }
        else { const rest = fs.existsSync(f) && e.isDirectory() ? sizeAndCount(f).files : 1; out.left.push(rel + ' (' + rest + ' file(s) in use)'); out.bytes += Math.max(0, sz.bytes - (fs.existsSync(f) ? sizeAndCount(f).bytes : 0)); }
      }
    }
  }
  // 2. the project's .cockpit\tmp, older than 7 days
  const tmp = path.join(p.dir, '.cockpit', 'tmp');
  if (fs.existsSync(tmp)) {
    for (const e of fs.readdirSync(tmp, { withFileTypes: true })) {
      const f = path.join(tmp, e.name); let age = 0; try { age = now - fs.statSync(f).mtimeMs; } catch (x) { continue; }
      if (age < 7 * DAY) continue;
      const sz = e.isDirectory() ? sizeAndCount(f) : (() => { try { return { bytes: fs.statSync(f).size, files: 1 }; } catch (x) { return { bytes: 0, files: 1 }; } })();
      if (e.isDirectory() && fs.existsSync(path.join(f, '.git'))) git(repoDir, ['worktree', 'remove', '--force', f]);
      const rel = path.relative(p.dir, f);
      if (remove(f)) { out.removed.push(rel); out.bytes += sz.bytes; out.files += sz.files; } else out.left.push(rel + ' (in use)');
    }
  }
  // 3. git's records of copies that are gone
  if (fs.existsSync(path.join(repoDir, '.git'))) git(repoDir, ['worktree', 'prune']);
  return out;
}

function runAll(force) {
  const projects = require('./projects'), registry = require('./registry');
  const summary = [];
  for (const e of registry.all()) {
    let p; try { p = projects.open(e.id); } catch (x) { continue; } if (!p || p.missing) continue;
    let r; try { r = cleanProject(p); } catch (x) { put(e.id + ': FAILED ' + x.message); continue; }
    const mb = Math.round(r.bytes / 1048576);
    const line = e.id + ': removed ' + r.removed.length + ' item(s), ' + r.files + ' file(s), ~' + mb + ' MB' + (r.left.length ? '; left ' + r.left.length + ': ' + r.left.slice(0, 5).join(', ') : '');
    put(line); summary.push(line);
    if (r.removed.length || r.left.length) { try { require('./events').record(p, { kind: 'janitor', level: r.left.length ? 'warn' : 'info', title: 'nightly clean-up: removed ' + r.removed.length + ' leftover(s), ~' + mb + ' MB freed' + (r.left.length ? ', ' + r.left.length + ' left (in use)' : ''), text: r.removed.slice(0, 20).join('\n') + (r.left.length ? '\nleft: ' + r.left.join('\n') : ''), source: 'janitor' }); } catch (x) { /* */ } }
  }
  try { fs.writeFileSync(STATE, JSON.stringify({ lastRun: new Date().toISOString(), forced: !!force, summary }, null, 1)); } catch (x) { /* */ }
  return summary;
}

function install() {
  if (global.__cockpitJanitor) return false;
  global.__cockpitJanitor = true;
  setInterval(() => {
    const now = new Date();
    if (now.getHours() < RUN_AFTER_HOUR || (now.getHours() === RUN_AFTER_HOUR && now.getMinutes() < RUN_AFTER_MIN)) return;
    let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (x) { /* never ran */ }
    const today = now.toLocaleDateString('en-CA');
    if (st.lastRun && new Date(st.lastRun).toLocaleDateString('en-CA') === today) return;
    try { runAll(false); } catch (x) { put('run FAILED ' + x.message); }
  }, 10 * 60000).unref();
  put('janitor installed in engine pid ' + process.pid + ' (nightly after ' + RUN_AFTER_HOUR + ':' + String(RUN_AFTER_MIN).padStart(2, '0') + ')');
  return true;
}
module.exports = { install, runAll, cleanProject, LOG };
