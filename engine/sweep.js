'use strict';
/* LEFTOVER WORKING COPIES ARE CLEARED.
   An AI made two git worktrees for a revert beside the project (C:\projects\my-app-revert-1, -2) and left them. The rule
   now has three layers: the prompt tells every AI to make a temporary copy inside <project>\.cockpit\tmp and remove it before
   ending its turn; the guard refuses `git worktree add` outside the project folder; and this sweep, at engine start and after
   every turn, removes a project's worktrees that sit OUTSIDE its folder - but only when they are safe to remove: nothing
   uncommitted, and every commit already on the remote. One it cannot remove safely is reported as an alert, never deleted.
   The coders' own folders (<project>\.coders\<coder>) are inside the project and never touched here. Hot-loaded. */
const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function git(cwd, args) {
  try { return { ok: true, out: cp.execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || e.message)) }; }
}
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();

/* returns { removed: [paths], kept: [{ path, why }] } */
function sweep(project, busyDirs) {
  const out = { removed: [], kept: [] };
  const dir = project && project.dir; if (!dir || !fs.existsSync(path.join(dir, '.git'))) return out;
  const list = git(dir, ['worktree', 'list', '--porcelain']); if (!list.ok) return out;
  const root = norm(dir), busy = (busyDirs || []).map(norm);
  const trees = list.out.split(/\r?\n\r?\n/).map((blk) => { const m = /^worktree (.+)$/m.exec(blk); const b = /^branch (.+)$/m.exec(blk); return m ? { path: m[1].trim(), branch: b ? b[1].replace(/^refs\/heads\//, '') : null, locked: /^locked\b/m.test(blk) } : null; }).filter(Boolean);
  for (const t of trees) {
    const p = norm(t.path);
    if (p === root || p.startsWith(root + path.sep)) continue;   // the project itself, and anything inside it (the coders' folders)
    /* A LOCKED working copy is there on purpose - a live environment slot such as a site's A and B copies (C:\projects\my-app\a and \b, locked when they were made). Never removed, never reported. */
    if (t.locked) continue;
    if (busy.some((b) => b === p || b.startsWith(p + path.sep))) { out.kept.push({ path: t.path, why: 'a turn is running in it' }); continue; }
    if (!fs.existsSync(t.path)) { git(dir, ['worktree', 'prune']); continue; }   // the folder is already gone: only the record is left
    // untouched for 30 minutes at least: a copy an AI made a moment ago may still be in use
    try { if (Date.now() - fs.statSync(t.path).mtimeMs < 30 * 60000) { out.kept.push({ path: t.path, why: 'recently used - checked again later', quiet: true }); continue; } } catch (e) { /* */ }
    const dirty = git(t.path, ['status', '--porcelain']);
    if (!dirty.ok) { out.kept.push({ path: t.path, why: 'git could not read it: ' + dirty.out.trim().split(/\r?\n/).pop().slice(0, 120) }); continue; }
    if (dirty.out.trim()) { out.kept.push({ path: t.path, why: 'it has uncommitted changes' }); continue; }
    const unpushed = git(t.path, ['log', '--oneline', '-1', 'HEAD', '--not', '--remotes']);
    if (!unpushed.ok || unpushed.out.trim()) { out.kept.push({ path: t.path, why: 'it has commits that are on no remote' + (t.branch ? ' (branch ' + t.branch + ')' : '') }); continue; }
    const rm = git(dir, ['worktree', 'remove', '--force', t.path]);
    if (rm.ok) out.removed.push(t.path); else out.kept.push({ path: t.path, why: 'git refused to remove it: ' + rm.out.trim().split(/\r?\n/).pop().slice(0, 120) });
  }
  return out;
}

/* sweep one project and say what happened in its event log; an unsafe leftover is an alert, reported once per folder per run */
const said = new Set();
function run(project, busyDirs) {
  let r; try { r = sweep(project, busyDirs); } catch (e) { return null; }
  try {
    const ev = require('./events');
    for (const f of r.removed) { console.log('sweep → ' + project.entry.id + ': removed the leftover working copy ' + f); ev.record(project, { kind: 'sweep.removed', level: 'info', title: 'removed a leftover working copy: ' + f, text: 'outside the project folder, nothing unsaved or unpushed in it', source: 'engine' }); }
    for (const k of r.kept) { if (k.quiet || said.has(k.path + k.why)) continue; said.add(k.path + k.why); ev.record(project, { kind: 'sweep.kept', level: 'alert', title: 'a leftover working copy was NOT removed: ' + k.path, text: k.why + ' - look before deleting it', source: 'engine' }); }
  } catch (e) { /* the sweep result stands */ }
  return r;
}
module.exports = { sweep, run };
