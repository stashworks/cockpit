/* Launch a CLI harness WITHOUT a shell in the middle (2026-09-16, both ways it bit):
     · through cmd.exe, a multi-line prompt passed as an argument is torn apart - Pi ran its
       tools but never saw the question;
     · without cmd.exe, an npm-installed tool is a .cmd shim, and spawn cannot run a .cmd -
       Claude Code on one machine failed with ENOENT while the same call worked on
       another, where Claude is a native .exe.
   So: find what the name really is. A .exe is spawned directly. An npm .cmd shim is read
   and the JavaScript entry it points at is run with this engine's own node. Arguments then
   reach the child exactly as given, newlines and all. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

/* on `global`, kept an hour (D6, 2026-09-30: lagwatch saw `where claude` block 0.6-2.3 s on coder starts - the memo was
   lost whenever this file was re-read). A tool that moved is found again within the hour; a failed lookup is not kept. */
const cache = global.__cockpitResolve || (global.__cockpitResolve = {});
function resolve(name) {
  if (cache[name] && cache[name].ok && Date.now() - (cache[name].at || 0) < 3600000) return cache[name];
  let found = '';
  try {
    const out = cp.execSync((process.platform === 'win32' ? 'where ' : 'which ') + name, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const all = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // `where` lists npm's extension-less bash shim first; that is for Git Bash, not for us.
    // A native .exe wins, then the .cmd shim, then whatever else there is.
    found = all.find((f) => /\.exe$/i.test(f)) || all.find((f) => /\.cmd$/i.test(f)) || (process.platform === 'win32' ? '' : all[0] || '');
  } catch (e) { found = ''; }
  let r;
  if (!found) r = { ok: false, why: name + ' is not on PATH' };
  else if (/\.cmd$/i.test(found)) {
    // npm shim, two shapes seen: "%_prog%" "%dp0%\node_modules\...\x.js" %*   (run with node)
    //                            "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*   (native)
    let target = null;
    // a shim also names "%dp0%\node.exe" as a candidate interpreter; the target is the
    // node_modules path, so take that one, not the first quoted %dp0% string
    try { const t = fs.readFileSync(found, 'utf8'); const all = [...t.matchAll(/%dp0%\\([^"]+)"/gi)].map((m) => m[1]); const pick = all.find((p) => /node_modules/i.test(p)) || all[all.length - 1]; if (pick) target = path.join(path.dirname(found), pick); } catch (e) { /* unreadable */ }
    if (!target || !fs.existsSync(target)) r = { ok: false, why: found + ' is a shim whose target could not be read' };
    else if (/\.(?:js|mjs|cjs)$/i.test(target)) r = { ok: true, file: process.execPath, prefix: [target], via: 'node ' + target };
    else r = { ok: true, file: target, prefix: [], via: target };
  } else r = { ok: true, file: found, prefix: [], via: found };
  r.at = Date.now(); cache[name] = r;
  return r;
}

/* A CODER IS ONE OF SEVERAL ON THIS MACHINE. Test runners size themselves for a developer
   who owns the whole box: vitest starts one worker per CPU core (~22 here) for EVERY package turbo runs at once - two
   coders' pre-push runs were 67 processes / 11.8 GB, the box hit 86% CPU and IIS recycled the owner's sites. Every process a
   harness starts (and so every test it runs, hooks included) inherits these caps; a value already in the environment wins,
   so a project or a person can still raise one. COCKPIT_CODER_TEST_WORKERS / COCKPIT_CODER_TASKS tune them engine-wide. */
const CODER_CAPS = () => {
  const workers = String(process.env.COCKPIT_CODER_TEST_WORKERS || 4), tasks = String(process.env.COCKPIT_CODER_TASKS || 2);
  return {
    VITEST_MAX_WORKERS: workers,             // vitest 4
    VITEST_MAX_THREADS: workers, VITEST_MAX_FORKS: workers,   // vitest 1-3
    JEST_WORKERS: workers,                   // read by the projects' own jest configs where they use it
    /* turbo 2.9 reads no env var for --concurrency and, in strict env mode, passes a task only the variables turbo.json
       lists - measured 2026-09-30: with these set, a web+api run still peaked at 50 vitest processes / 9.6 GB. The
       project must pass VITEST_MAX_* through (turbo.json globalPassThroughEnv) and hand this to turbo --concurrency (its
       pre-push hook / test script) */
    CODER_TURBO_CONCURRENCY: tasks,
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '4',
  };
};
function capped(env) { const base = env || process.env, out = { ...base }; for (const [k, v] of Object.entries(CODER_CAPS())) if (base[k] == null || base[k] === '') out[k] = v; return out; }

/* spawn(name, args, opts) - like child_process.spawn, resolved as above, never a shell; the coder caps above go in */
function spawn(name, args, opts) {
  const r = resolve(name);
  if (!r.ok) { const e = new Error(r.why); e.code = 'ENOENT'; throw e; }
  return cp.spawn(r.file, r.prefix.concat(args), { ...opts, env: capped(opts && opts.env), shell: false, windowsHide: true });
}

/* versionOf(name) - "<name> --version" for a harness's available(), WITHOUT freezing the engine (D6, 2026-09-30: lagwatch
   measured claude/codex/pi --version at 2-4 s each, run in a row on every harness list - 20 lists in 25 minutes froze the
   engine about 2 minutes, 10 s at a time). The answer is kept 10 minutes; a stale one is returned at once while a
   background (async) run refreshes it. Only the very first check of a tool in an engine process waits. The memo lives on
   `global`, so it survives this file being re-read. */
const VERSION_TTL_MS = 10 * 60000;
const versions = global.__cockpitVersions || (global.__cockpitVersions = {});
function versionOf(name) {
  const v = versions[name], now = Date.now();
  const from = (err, out) => err ? { ok: false, why: name + ' is not on PATH: ' + String(err.message).split('\n')[0] } : { ok: true, why: String(out).trim() };
  if (v && now - v.at < VERSION_TTL_MS) return v.result;
  if (v) {
    if (!v.refreshing) { v.refreshing = true; cp.exec(name + ' --version', { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, out) => { versions[name] = { at: Date.now(), result: from(err, out) }; }); }
    return v.result;
  }
  let result; try { result = from(null, cp.execSync(name + ' --version', { encoding: 'utf8', timeout: 30000, windowsHide: true })); } catch (e) { result = from(e); }
  if (!result.ok) {   // 2026-10-19: a tool installed BEFORE Cockpit read "not installed" for 10 minutes after one slow or failed first check
    const found = findInstalled(name);
    if (found) { process.env.PATH = (process.env.PATH || '') + ';' + path.dirname(found); delete cache[name]; try { result = from(null, cp.execSync(name + ' --version', { encoding: 'utf8', timeout: 30000, windowsHide: true })); } catch (e) { result = from(e); } }
  }
  if (result.ok) versions[name] = { at: now, result };   // a failure is never remembered: the next check looks again
  return result;
}

/* findInstalled(name) - where Windows installers actually put a tool, for when it isn't on this engine's PATH yet:
   Anthropic's installer (~\.local\bin), npm global, WinGet links, and Claude Code's own npm-local install. */
function findInstalled(name) {
  if (process.platform !== 'win32') return null;
  const home = require('node:os').homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const dirs = [path.join(home, '.local', 'bin'), path.join(roaming, 'npm'), path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(home, '.claude', 'local'), path.join(local, 'Programs', name)];
  for (const d of dirs) for (const ext of ['.exe', '.cmd']) { const f = path.join(d, name + ext); if (fs.existsSync(f)) return f; }
  return null;
}

/* forget(name) - drop what is remembered about a tool, so the next check looks again (the wizard, right after it installs
   one: "not installed" must not be remembered for 10 minutes) */
function forget(name) { delete versions[name]; delete cache[name]; }

module.exports = { resolve, spawn, versionOf, forget, capped, CODER_CAPS };
