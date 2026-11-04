/* LAND IN DEV - the inner loop's merge.

   A project whose .cockpit\coders.json says "land": "dev" has its coders work in their own folders (engine/workspaces.js),
   - never in the folder the dev site runs from, so the owner never sees half-built work. When a coder's
   turn on a ticket ends, this takes its work into dev:

     1. committed    - the coder's folder is clean (Cockpit's own files aside); uncommitted work is not landed
     2. caught up    - rebased onto what dev has now (another coder may have landed meanwhile); a conflict is the coder's to fix
     3. checked      - the recipe's "check" commands run IN THE CODER'S FOLDER ({base} = dev's commit before the work), e.g.
                       the typecheck and the tests of the packages the change touches; any failure and nothing lands
     4. landed       - dev's checkout moves to the coder's commits by fast-forward only: dev's own history is never rewritten,
                       and dev's local, never-committed settings are left alone (a commit that would overwrite one is refused)

   Then the caller runs the usual after-turn tests and the ticket's verdict on the DEV folder - the browser flows click
   through the running dev site with the work in it. One landing at a time per project. Nothing here pushes: the outer
   loop (the owner's "batch it") takes the finished work to GitHub. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const busy = new Set();

function gitIn(dir, args, timeout) { return cp.execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args], { cwd: dir, encoding: 'utf8', timeout: timeout || 5 * 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function errText(e) { return String((e.stderr && e.stderr.toString()) || e.message || e).trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400); }

function sh(cmd, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, { cwd, env, shell: true, windowsHide: true });
    let out = ''; const put = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', put); child.stderr.on('data', put);
    const t = setTimeout(() => { try { process.platform === 'win32' ? cp.execSync('taskkill /pid ' + child.pid + ' /T /F', { windowsHide: true, stdio: 'ignore' }) : child.kill('SIGKILL'); } catch (e) { /* */ } out += '\n(stopped: over ' + Math.round(timeoutMs / 60000) + ' minutes)'; }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + '\n' + e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/* Resolves { ok, step, why, landed, commits, from, to, files } - never throws. `say` is a log line. */
async function land(p, coder, say) {
  say = say || (() => {});
  const ws = require('./workspaces');
  if (!ws.landsInDev(p)) return { ok: false, step: 'setup', why: 'this project does not land in dev' };
  const key = p.entry.id;
  if (busy.has(key)) { for (let i = 0; i < 360 && busy.has(key); i++) await new Promise((r) => setTimeout(r, 5000)); if (busy.has(key)) return { ok: false, step: 'queue', why: 'another landing held dev for 30 minutes' }; }
  busy.add(key);
  try {
    const R = ws.repo(p), folder = ws.dirFor(p, coder), recipe = ws.recipe(p);
    const at = (step, why, extra) => Object.assign({ ok: false, step, why }, extra || {});
    // 1. committed
    const dirty = gitIn(folder, ['status', '--porcelain']).split(/\r?\n/).filter((l) => l.trim() && !/\.coder-ready\.json|(^|\/)\.cockpit\//.test(l));
    if (dirty.length) return at('committed', 'not committed in the coder\'s folder: ' + dirty.slice(0, 8).map((l) => l.slice(3)).join(', ') + ' - commit the work; only committed work lands in dev');
    const from = gitIn(R.dir, ['rev-parse', 'HEAD']);
    const own = Number(gitIn(folder, ['rev-list', '--count', from + '..HEAD']));
    if (!own) return { ok: true, landed: false, why: 'nothing new to land - the folder has no commits dev does not already have', from, to: from, commits: 0, files: [] };
    // 2. caught up with dev
    const isAncestor = (() => { try { gitIn(folder, ['merge-base', '--is-ancestor', from, 'HEAD']); return true; } catch (e) { return false; } })();
    if (!isAncestor) {
      say('land: catching ' + coder + '\'s work up with dev (' + from.slice(0, 9) + ')');
      try { gitIn(folder, ['rebase', from], 10 * 60000); }
      catch (e) { try { gitIn(folder, ['rebase', '--abort']); } catch (x) { /* */ } return at('caught-up', 'the work does not rebase cleanly onto dev (' + from.slice(0, 9) + '): ' + errText(e) + ' - bring it up to date with dev in your folder (git rebase ' + from.slice(0, 9) + '), resolve, commit'); }
    }
    const base = gitIn(folder, ['merge-base', from, 'HEAD']);
    const to = gitIn(folder, ['rev-parse', 'HEAD']);
    const files = gitIn(folder, ['diff', '--name-only', base, to]).split(/\r?\n/).filter(Boolean);
    const commits = Number(gitIn(folder, ['rev-list', '--count', base + '..' + to]));
    // 3. checked, in the coder's folder
    for (const c of (recipe.check || [])) {
      const cmd = String(c.run || c).replace(/\{base\}/g, base).replace(/\{coder\}/g, coder);
      say('land: check in ' + coder + '\'s folder - ' + cmd);
      const t0 = Date.now();
      const r = await sh(cmd, folder, { ...process.env, COCKPIT_CODER: coder, CI: '1' }, (c.timeoutMinutes || 30) * 60000);
      if (r.code !== 0) return at('check', '`' + cmd + '` failed (exit ' + r.code + ', ' + Math.round((Date.now() - t0) / 1000) + ' s): ' + r.out.trim().split(/\r?\n/).filter((l) => /error|fail|✗|×|FAIL/i.test(l)).slice(-12).join(' | ').slice(0, 1500), { files });
      say('land: check passed (' + Math.round((Date.now() - t0) / 1000) + ' s)');
    }
    // 4. landed - dev moves forward to the coder's commits, fast-forward only
    const now = gitIn(R.dir, ['rev-parse', 'HEAD']);
    if (now !== from) return at('caught-up', 'dev moved while the checks ran (' + from.slice(0, 9) + ' → ' + now.slice(0, 9) + ') - the next try catches up and checks again');
    try { gitIn(R.dir, ['merge', '--ff-only', to], 5 * 60000); }
    catch (e) { return at('land', 'dev would not take the work by fast-forward: ' + errText(e) + (/overwritten/i.test(errText(e)) ? ' - dev has uncommitted edits to the same files (the dev conversation, or the owner); they are left alone' : ''), { files }); }
    say('land: ' + commits + ' commit(s) from ' + coder + ' landed in dev, ' + from.slice(0, 9) + ' → ' + to.slice(0, 9) + ' (' + files.length + ' file' + (files.length === 1 ? '' : 's') + ')');
    return { ok: true, landed: true, from, to, commits, files: files.map((f) => R.prefix + f) };
  } catch (e) {
    return { ok: false, step: 'land', why: 'could not land: ' + errText(e) };
  } finally { busy.delete(key); }
}

module.exports = { land };
