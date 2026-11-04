/* THE GUARD - the three commands that delete what they were not pointed at, refused before they run.

   Built after one overnight run cost 97 test files and a project's whole .cockpit folder.
   The coders' own tools have no per-command control (Pi's tools are all-or-nothing; Codex runs without its sandbox
   because the Windows one cannot start node under a service), so the guard is the engine's, in front of every
   harness: each turn's PATH begins with a folder of ours holding a `git` and an `rm`. They pass every command
   through to the real tool - except:

     git clean            deletes everything git does not track, the width of the folder (the .cockpit loss)
     git checkout .       throws away every uncommitted change in the tree, not only this turn's
     rm -rf <directory>   a whole tree, no prompt, no recycle bin (the 97 test files: dist path, src path, one line)

   A refused command exits 2 and says what to do instead, so the coder reads an ordinary failure and carries on: name
   the files, or ask the owner. Deleting a file by name is untouched; `git checkout -- <file>` is untouched;
   `git clean -n` (which only lists) is untouched.

   The shims live in <engine>\run\guard - a .cmd for cmd.exe and an executable /bin/sh script for a bash-flavoured
   shell, since a turn's shell may be either. Both hand the whole command line to node, which judges it here and then
   runs the real tool itself, so nothing is re-parsed by a shell and a path with a space survives. Nothing is
   installed; nothing outside a turn's environment changes. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'run', 'guard');

/* is removing this folder safe? null = yes (everything in it can be got back), a string = why not */
const THROWAWAY = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.turbo', '.cache', 'coverage', '__pycache__', '.pytest_cache', 'test-results', 'playwright-report', '.nyc_output', 'tmp', 'temp']);
function unsafeDir(target) {
  const cp = require('node:child_process');
  const abs = path.resolve(process.cwd(), target);
  let st; try { st = fs.statSync(abs); } catch (e) { return null; }   // nothing there: rm will say so itself
  if (!st.isDirectory()) return null;
  // the project root as the way UP from here (--show-cdup), not git's own spelling of it - over a share git names it //host/...
  // while the folder is a mapped drive letter, and the two must compare
  let top = null; try { const up = cp.execFileSync('git', ['-c', 'safe.directory=*', 'rev-parse', '--show-cdup'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); top = path.resolve(process.cwd(), up || '.'); } catch (e) { /* not in a repo */ }
  const low = (x) => path.resolve(x).toLowerCase(), A = low(abs);
  const tmp = low(require('node:os').tmpdir());
  if (A === tmp || A.startsWith(tmp + path.sep)) return null;   // the system's temp folder
  if (!top) return 'it is not inside a project checkout, so nothing can be restored - remove files by name, or ask the owner.';
  const T = low(top);
  if (A === T || T.startsWith(A + path.sep)) return 'that is the project itself (or holds it). Ask the owner.';
  if (!A.startsWith(T + path.sep)) return 'it is outside this project. Ask the owner.';
  const rel = path.relative(top, abs), parts = rel.split(/[\\/]/);
  if (parts[0].toLowerCase() === '.git') return '.git is the project\'s whole history. Ask the owner.';
  if (parts[0].toLowerCase() === '.cockpit') { if ((parts[1] || '').toLowerCase() === 'tmp' && parts.length >= 3) return null; return '.cockpit is the project\'s memory (only .cockpit/tmp/<name> may be removed). Ask the owner.'; }
  if (parts.some((p) => THROWAWAY.has(p.toLowerCase()))) return null;   // build output: it is made again
  let out = ''; try { out = cp.execFileSync('git', ['-c', 'safe.directory=*', '-C', top, 'status', '--porcelain=v1', '--ignored=matching', '--untracked-files=all', '--', rel], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return 'git could not say what is in it, so nothing is known to be restorable. Remove files by name, or ask the owner.'; }
  const lost = out.split(/\r?\n/).filter(Boolean).map((l) => ({ code: l.slice(0, 2), file: l.slice(3).replace(/^"|"$/g, '') }))
    .filter((x) => !x.file.split(/[\\/]/).some((p) => THROWAWAY.has(p.toLowerCase())));   // throwaway output inside does not count
  if (!lost.length) return null;   // every file in it is saved, unchanged, in git: git checkout brings it all back
  const say = (x) => (x.code === '??' ? 'new, never saved: ' : x.code === '!!' ? 'not in git (ignored - e.g. a secret or a local setting): ' : 'changed, not saved: ') + x.file;
  return lost.length + ' file' + (lost.length > 1 ? 's' : '') + ' in it could not be got back afterwards - ' + lost.slice(0, 5).map(say).join('; ') + (lost.length > 5 ? '; ...' : '') + '. Commit what should be kept (or delete those files by name first, if they really should go), then remove the folder. Otherwise ask the owner.';
}
/* the judgement, in one place: null = let it through, a string = refuse with that reason */
function refuse(argv) {
  const a = argv.map((x) => String(x));
  const bin = path.basename(String(a[0] || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const rest = a.slice(1).filter((x) => x !== '');
  const isFlag = (x) => /^-/.test(x);
  if (bin === 'git') {
    const sub = rest.find((x, i) => !isFlag(x) && rest[i - 1] !== '-c' && rest[i - 1] !== '--git-dir' && rest[i - 1] !== '-C');
    if (sub === 'clean' && !rest.some((x) => x === '-n' || x === '--dry-run')) {
      return 'git clean is refused: it deletes every file git does not track, across the whole folder - a project\'s .cockpit went that way on 2026-09-22. Delete what you must by name, or ask the owner for a wide clean. `git clean -n`, which only lists, is allowed.';
    }
    /* a working copy is made INSIDE the project, never beside it. `git worktree add <path>` outside the checkout it is run from is refused; inside
       <project>\.cockpit	mp (or the system temp folder) is fine - and it is removed before the turn ends (engine/sweep.js clears what is left). */
    if (sub === 'worktree') {
      const after = rest.slice(rest.indexOf(sub) + 1);
      if (after[0] === 'add') {
        const args = after.slice(1), withValue = ['-b', '-B', '--reason'];
        let target = null; for (let i = 0; i < args.length; i++) { if (withValue.includes(args[i])) { i++; continue; } if (isFlag(args[i])) continue; target = args[i]; break; }
        if (target) {
          const abs = path.resolve(process.cwd(), target).toLowerCase(); let top = process.cwd();
          try { top = require('node:child_process').execFileSync('git', ['-c', 'safe.directory=*', 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { /* not in a repo: the cwd stands */ }
          const inside = (d) => { const r = path.resolve(d).toLowerCase(); return abs === r || abs.startsWith(r + path.sep); };
          if (!inside(top) && !inside(process.cwd()) && !inside(require('node:os').tmpdir())) return 'git worktree add ' + target + ' is refused: a working copy is made inside the project, never beside it (two were left in the apps folder on 2026-09-26). Use <project>/.cockpit/tmp/<name>, and remove it with git worktree remove before you end your turn.';
        }
      }
    }
    if (sub === 'checkout' || sub === 'restore') {
      const after = rest.slice(rest.indexOf(sub) + 1).filter((x) => !isFlag(x));
      if (after.some((x) => x === '.' || x === './' || x === '*')) {
        return 'git ' + sub + ' over the whole tree is refused: it throws away every uncommitted change, including work that is not yours. Name the file you mean: git ' + sub + ' -- path/to/file';
      }
    }
  }
  /* A CODER DOES NOT SIT WAITING. The coders are told to set a pull request to merge itself and end the turn; pi kept looping "sleep 120 && gh pr
     checks" for 45 minutes instead, holding its one slot. In a coder's turn - its own folder (<project>\.coders\<coder>) or the
     engine's COCKPIT_FLEET mark - a wait over 60 seconds and GitHub's watch commands are refused. A conversation may still wait. */
  const coder = process.env.COCKPIT_FLEET === '1' || /[\\/]\.coders[\\/]/.test(process.cwd() + path.sep);
  const HANDOFF = 'set the pull request to merge itself (gh pr merge <number> --auto) and END YOUR TURN - the queue checks back on it and sends it back if a check fails.';
  if (coder && bin === 'sleep') {
    const secs = rest.filter((x) => !isFlag(x)).reduce((t, x) => { const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(x); return m ? t + Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 })[m[2]] : t; }, 0);
    if (secs > 60) return 'sleep ' + rest.join(' ') + ' is refused: a coder does not wait (' + Math.round(secs) + ' s asked, 60 s allowed). Nothing to wait for - ' + HANDOFF;
  }
  if (coder && bin === 'gh') {
    const verb = rest.filter((x) => !isFlag(x));
    if ((verb[0] === 'pr' && verb[1] === 'checks' && rest.some((x) => x === '--watch' || x.startsWith('--watch='))) || (verb[0] === 'run' && verb[1] === 'watch')) return (verb[0] === 'run' ? 'gh run watch' : 'gh pr checks --watch') + ' is refused: a coder does not sit watching CI. ' + HANDOFF;
  }
  if (bin === 'rm') {
    const recursive = rest.some((x) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(x) || x === '--recursive');
    if (recursive) {
      const targets = rest.filter((x) => !isFlag(x));
      const looksLikeDir = (t) => { try { return fs.statSync(t).isDirectory(); } catch (e) { return /[\\/]$/.test(t) || (!/\.[a-zA-Z0-9]{1,6}$/.test(t) && !/[*?]/.test(t)); } };
      const dirs = targets.filter(looksLikeDir);
      /* A FOLDER MAY GO WHEN NOTHING IN IT IS LOST. The blanket refusal
         came from 97 test files deleted by one wrong path - files that existed nowhere else. So the line is recoverability: a folder
         whose every file git has saved unchanged (git restores it), or throwaway build output, or the project's own .cockpit/tmp, may
         be removed; anything holding unsaved work, new files, or ignored-but-real files (a .env) is refused with the list of what
         would be lost. Never the project itself, .git, .cockpit, or anything outside the project. */
      for (const d of dirs) { const why = unsafeDir(d); if (why) return 'rm -r ' + d + ' is refused: ' + why; }
      return null;
    }
  }
  return null;
}

/* the shims, and the shell file that does the same job where PATH cannot reach.

   MEASURED 2026-09-22: a PATH shim alone is not enough. Git Bash puts its own \mingw64\bin and \usr\bin at the FRONT
   of PATH whatever we set (tried plain, MSYS2_PATH_TYPE=inherit and =strict), so `git` and `rm` in a bash-flavoured
   shell resolve to the real ones - and a bash-flavoured shell is what the local coder used the night it deleted the
   97 files. Bash has another door: BASH_ENV (and ENV, for its POSIX mode) names a file sourced before a
   non-interactive command runs, and a shell FUNCTION beats any PATH lookup. So: functions for the shells, .cmd for
   cmd.exe, one judgement behind both. */
function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
  const node = process.execPath;
  const judge = path.join(__dirname, 'guard.js');
  const q = (x) => '"' + x + '"';
  const NL = String.fromCharCode(10), CRNL = String.fromCharCode(13) + String.fromCharCode(10);
  for (const name of ['git', 'rm', 'sleep', 'gh']) {
    fs.writeFileSync(path.join(DIR, name + '.cmd'), '@echo off' + CRNL + q(node) + ' ' + q(judge) + ' --run ' + name + ' %*' + CRNL);
    const sh = path.join(DIR, name);
    fs.writeFileSync(sh, '#!/bin/sh' + NL + 'exec ' + q(node.replace(/\\/g, '/')) + ' ' + q(judge.replace(/\\/g, '/')) + ' --run ' + name + ' "$@"' + NL);
    try { fs.chmodSync(sh, 0o755); } catch (e) { /* a shell that cannot mark it executable falls back to the .cmd */ }
  }
  const N = q(node.replace(/\\/g, '/')), J = q(judge.replace(/\\/g, '/'));
  fs.writeFileSync(path.join(DIR, 'rc.sh'), [
    '# Cockpit: the guard, for bash and sh (sourced through BASH_ENV / ENV). A function beats PATH, which is how this',
    '# reaches a shell that puts its own bin first. Anything not named here runs exactly as before.',
    '__cockpit_guard() { ' + N + ' ' + J + ' --check "$@"; }',
    'git() { __cockpit_guard git "$@" || return 2; command git "$@"; }',
    'rm() { __cockpit_guard rm "$@" || return 2; command rm "$@"; }',
    'sleep() { __cockpit_guard sleep "$@" || return 2; command sleep "$@"; }',
    'gh() { __cockpit_guard gh "$@" || return 2; command gh "$@"; }',
    'export -f git rm sleep gh 2>/dev/null || true',
    ''
  ].join(NL));
  return DIR;
}

/* the real tool, found on the engine's own PATH with our folder taken out, so a shim never calls itself */
function realPath(name) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()) : [''];
  for (const d of String(process.env.PATH || '').split(sep)) {
    if (!d) continue;
    try { if (path.resolve(d).toLowerCase() === path.resolve(DIR).toLowerCase()) continue; } catch (e) { continue; }
    for (const e of exts) {
      const f = path.join(d, name + e);
      try { if (fs.statSync(f).isFile()) return f; } catch (x) { /* next */ }
    }
  }
  return null;
}

/* what a turn's environment gets: our folder first on PATH */
function envFor(env) {
  try {
    const dir = ensure();
    const sep = process.platform === 'win32' ? ';' : ':';
    const cur = String((env && env.PATH) || process.env.PATH || '');
    const rc = path.join(dir, 'rc.sh').replace(/\\/g, '/');
    const already = cur.split(sep).some((d) => { try { return d && path.resolve(d).toLowerCase() === path.resolve(dir).toLowerCase(); } catch (e) { return false; } });
    const shell = { BASH_ENV: rc, ENV: rc, COCKPIT_GUARD: dir };   // the shells' door; PATH is cmd.exe's
    if (already) return { ...(env || {}), ...shell };
    return { ...(env || {}), ...shell, PATH: dir + sep + cur };
  } catch (e) { return env || {}; }
}

/* the shims call this */
if (require.main === module) {
  const NL = String.fromCharCode(10);
  const mode = process.argv[2];
  if (mode === '--run') {
    const name = process.argv[3], args = process.argv.slice(4);
    const why = refuse([name, ...args]);
    if (why) { process.stderr.write(NL + 'COCKPIT REFUSED THIS COMMAND' + NL + why + NL + NL); process.exit(2); }
    const real = realPath(name);
    if (!real) { process.stderr.write(name + ': not found on this machine' + NL); process.exit(127); }
    const r = require('node:child_process').spawnSync(real, args, { stdio: 'inherit', windowsHide: true });
    process.exit(r.status == null ? 1 : r.status);
  }
  if (mode === '--check') { const why = refuse(process.argv.slice(3)); if (why) { process.stderr.write(why + NL); process.exit(2); } process.exit(0); }
  process.stdout.write('guard: --run <name> <args...>' + NL);
}

module.exports = { refuse, ensure, envFor, realPath, DIR };
