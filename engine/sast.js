/* SAST - semgrep over the project's source, from Cockpit's own folder (yes: tools\semgrep is the embeddable Python with semgrep in it and the rule
   packs beside it, unpacked from tools\dl\semgrep-win64.zip on Settings > Engine; nothing else on the machine knows it).

   Runs as a stage of every full test run (engine/tests.js) and writes .cockpit/tests/sast.json; the map's scan reads that
   into problem tags - one line per kind of flaw the rule looks for (sast-xss, sast-sql-injection, sast-secrets, ...; sast-failed
   on the site when it could not run), the way the tab's own checks are lines - so the findings sit on
   the SAST stage of the Tests tab as bubbles beside Cockpit's own checks - the same place, the same click, the same
   conversation. Offline: the rules are the copies in tools\semgrep\rules. Stateless - hot-loaded. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(ROOT, 'tools', 'semgrep');
/* python itself, `-m semgrep` - never Scripts\semgrep.exe: that launcher has the ABSOLUTE path of the python that built it
   baked in (2026-09-21: the folder was built on the desk PC and copied; on the engine's machine the launcher died in 14 ms,
   exit 1, nothing printed - SAST had never run). The folder travels; python.exe beside its Lib does not care where it is. */
const EXE = process.platform === 'win32' ? path.join(HOME, 'python', 'python.exe') : path.join(HOME, 'python', 'bin', 'python3');
const MOD = ['-c', 'import sys; from semgrep.console_scripts.entrypoint import main; sys.exit(main())'];   // the launcher's own entry point (`-m semgrep` is refused as deprecated)
const RULES = path.join(HOME, 'rules');
const SKIP = ['.cockpit', '.coders', '.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.turbo', 'coverage', 'browsers', 'tools/dl', 'tools/zap', 'tools/semgrep', 'backups', 'accounts'];
const TIMEOUT_MS = 45 * 60 * 1000;   // a large monorepo ran past 10 min on a busy machine and took 26.5 min at 30 - it was working, not stuck

/* SEMGREP IN DOCKER. Windows Code Integrity blocks the unsigned semgrep-core.exe
   on and off (event 3077 at 2026-10-01 13:01 / 15:01 and 2026-10-03 13:01 / 13:26 local, every scan in those runs read 0 files),
   and folder exclusions are ruled out. Inside a Linux container Windows' program blocking does not apply. The official image,
   pinned to the version the folder carries, with the same rule packs mounted read-only; the code is mounted read-only too.
   The folder copy stays as the fallback when Docker is not running. */
const IMAGE = 'semgrep/semgrep:1.177.0';
/* every docker call is asynchronous: a synchronous wait here (a 15-minute first pull) would freeze the whole engine (D6, 2026-09-30) */
const execP = (cmd, args, opts) => new Promise((res) => cp.execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (e, o, se) => res({ e, o: String(o || ''), se: String(se || '') })));
let dockerSeen = null, dockerAt = 0;
async function dockerUp() {
  if (dockerSeen !== null && Date.now() - dockerAt < 10 * 60000) return dockerSeen;
  const r = await execP('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 20000 });
  dockerSeen = !r.e && !!r.o.trim(); dockerAt = Date.now(); return dockerSeen;
}
const dir = (p) => path.join(p.cockpit.dir, 'tests');
const file = (p) => path.join(dir(p), 'sast.json');
function available() { return fs.existsSync(EXE) && fs.existsSync(RULES); }
function latest(p) { try { return JSON.parse(fs.readFileSync(file(p), 'utf8')); } catch (e) { return null; } }
/* The pip launchers in python\Scripts (semgrep.exe, pysemgrep.exe - the engine binary hands `scan` to pysemgrep by name)
   carry the ABSOLUTE path of the python that built them, as a `#!` line between the launcher and its zip. Built on one
   machine and carried to another they die: "executing pysemgrep failed ... No such file or directory" (2026-09-21, six
   runs to find). The folder travels; so before every run the line is re-stamped with THIS engine's python when it differs. */
function stampLaunchers(say) {
  if (process.platform !== 'win32') return;
  const want = Buffer.from('#!' + EXE + '\n', 'utf8'); const scripts = path.join(HOME, 'python', 'Scripts');
  for (const name of ['pysemgrep.exe', 'semgrep.exe']) {
    const f = path.join(scripts, name); let d; try { d = fs.readFileSync(f); } catch (e) { continue; }
    const i = d.lastIndexOf('#!'); if (i < 0) continue; const j = d.indexOf(0x0a, i); if (j < 0 || !d.subarray(j + 1, j + 3).equals(Buffer.from('PK'))) continue;
    if (d.subarray(i, j + 1).equals(want)) continue;
    try { fs.writeFileSync(f, Buffer.concat([d.subarray(0, i), want, d.subarray(j + 1)])); say('re-stamped ' + name + ' for this machine'); } catch (e) { say('could not re-stamp ' + name + ': ' + e.message); }
  }
}

/* run it; the report always lands (ok:false says why) */
async function run(p, log) {
  const say = (t) => { if (log) log('sast: ' + t); };
  const started = Date.now();
  const report = { at: new Date(started).toISOString(), ms: 0, ok: false, why: null, version: null, rules: 0, files: 0, findings: [], summary: { error: 0, warning: 0, info: 0 } };
  const land = () => { report.ms = Date.now() - started; fs.mkdirSync(dir(p), { recursive: true }); fs.writeFileSync(file(p), JSON.stringify(report, null, 1) + '\n'); return report; };
  const docker = fs.existsSync(RULES) && await dockerUp();
  if (!docker && !available()) { report.why = 'semgrep is not unpacked on this engine - Settings › Engine (tools\\dl\\semgrep-win64.zip) - and Docker is not running'; say(report.why); return land(); }
  report.engine = docker ? 'docker ' + IMAGE : 'folder (tools\\semgrep)';
  if (!docker) stampLaunchers(say);
  /* WHAT IS SCANNED (2026-09-30): the same current-main copy the map and the flows read (.cockpit/cache/mainline), when the
     project has one - a project folder sat on an old coder branch, so semgrep described code main no longer had. The copy
     lives under .cockpit, so the '.cockpit' exclude is dropped for it (it holds no .cockpit of its own). */
  const ml = path.join(p.dir, '.cockpit', 'cache', 'mainline'), root = fs.existsSync(path.join(ml, '.git')) ? ml : p.dir;
  report.scanned = root === p.dir ? 'the folder' : 'current main (.cockpit/cache/mainline)';
  /* which commit (2026-10-03): a findings ticket's check judges a semgrep finding only on a scan of code that holds its fix */
  { const g = await execP('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], { cwd: root, timeout: 5000 }); report.commit = g.e ? null : g.o.trim() || null; }
  const args = [...MOD, 'scan', '--config', RULES, '--json', '--metrics', 'off', '--disable-version-check', '--timeout', '30', '--max-target-bytes', '2000000', ...SKIP.filter((s) => root === p.dir || s !== '.cockpit').flatMap((s) => ['--exclude', s]), root];
  /* semgrep's engine (semgrep-core) hands `scan` to "pysemgrep" BY NAME - it must be on PATH. It only worked before because the
     engine's own PATH happened to carry it; after the engine folder moved and PM2 restarted it from a fresh shell, every run died
     "executing pysemgrep failed: No such file or directory" (2026-09-28). Put python\Scripts first, always. */
  const scriptsDir = path.join(HOME, 'python', 'Scripts');
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env, PYTHONUTF8: '1', SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', [pathKey]: scriptsDir + path.delimiter + (process.env[pathKey] || '') };
  say('running (' + (root === p.dir ? path.basename(p.dir) : 'current main') + ', ' + report.engine + ')');
  /* in the container the code is /src and the rules /rules. --no-git-ignore: the current-main copy is a git worktree whose
     .git points at the host's repo, which the container cannot see - targets are chosen by the excludes instead */
  const excl = SKIP.filter((s) => root === p.dir || s !== '.cockpit').flatMap((s) => ['--exclude', s]);
  const cmd = docker ? 'docker' : EXE;
  const cmdArgs = docker
    ? ['run', '--rm', '-v', root + ':/src:ro', '-v', RULES + ':/rules:ro', '-w', '/src', '-e', 'SEMGREP_SEND_METRICS=off', '-e', 'SEMGREP_ENABLE_VERSION_CHECK=0', IMAGE,
      'semgrep', 'scan', '--config', '/rules', '--json', '--metrics', 'off', '--disable-version-check', '--no-git-ignore', '--timeout', '30', '--max-target-bytes', '2000000', ...excl, '/src']
    : args;
  const relOf = (p0) => docker ? String(p0).replace(/^\/src\/?/, '') : path.relative(root, path.isAbsolute(p0) ? p0 : path.join(root, p0)).replace(/\\/g, '/');
  if (docker && (await execP('docker', ['image', 'inspect', IMAGE], { timeout: 30000 })).e) {
    say('pulling ' + IMAGE + ' (first run)');
    const pl = await execP('docker', ['pull', IMAGE], { timeout: 15 * 60000 });
    if (pl.e) { report.why = 'could not pull ' + IMAGE + ': ' + (pl.se.trim().split(/\r?\n/).pop() || String(pl.e.message)).slice(0, 300); say(report.why); return land(); }
  }
  return new Promise((resolve) => {
    cp.execFile(cmd, cmdArgs, { cwd: HOME, env, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = null; try { out = JSON.parse(String(stdout || '')); } catch (e) { /* no json = it did not run */ }
      if (!out) {
        report.why = (err && err.killed) ? 'stopped after ' + Math.round(TIMEOUT_MS / 60000) + ' min' : 'did not run (exit ' + (err && err.code != null ? err.code : '?') + '): ' + (String(stderr || '').trim() || String(stdout || '').trim() || (err && err.message) || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
        // silent: nothing printed - ask python itself what it can see, so the line says which piece is missing on THIS machine
        if (!docker && !String(stderr || '').trim() && !String(stdout || '').trim()) {
          try {
            const core = path.join(HOME, 'python', 'Lib', 'site-packages', 'semgrep', 'bin', 'semgrep-core.exe');
            const pr = cp.spawnSync(EXE, ['-c', 'import os, sys, subprocess, tempfile, json; print(sys.version.split()[0], "user", os.environ.get("USERNAME"), "temp", os.environ.get("TEMP"), "tmp", os.environ.get("TMP")); ' +
              'f = tempfile.NamedTemporaryFile(delete=True); print("temp writable", os.path.exists(f.name)); f.close(); core = sys.argv[1]; args = json.loads(sys.argv[2]); ' +
              'r = subprocess.run(["osemgrep"] + args, executable=core, capture_output=True, text=True, cwd=os.getcwd()); print("osemgrep exit", r.returncode, "stdout", len(r.stdout), r.stdout.strip()[:200].replace(chr(10), " | "), "stderr", r.stderr.strip()[-700:].replace(chr(10), " | "))', core, JSON.stringify(args.slice(MOD.length))], { cwd: HOME, env, windowsHide: true, timeout: 120000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            report.probe = { code: pr.status, error: pr.error ? String(pr.error.message) : null, out: String(pr.stdout || '').trim().slice(0, 1600), err: String(pr.stderr || '').trim().slice(-400) };
            report.why += ' · probe: exit ' + pr.status + (pr.error ? ' ' + pr.error.message : '') + ' ' + (report.probe.err || report.probe.out);
          } catch (e) { report.probe = { error: e.message }; }
        }
        say(report.why); return resolve(land());
      }
      report.version = out.version || null;
      const seen = new Set();
      for (const r of out.results || []) {
        const rel = relOf(r.path); const line = (r.start || {}).line || 0;
        const rule = String(r.check_id || '').split('.').slice(-1)[0], sev = String((r.extra || {}).severity || 'INFO').toLowerCase();
        const key = rule + '|' + rel + '|' + line; if (seen.has(key)) continue; seen.add(key);
        const md = (r.extra || {}).metadata || {};
        const f = { rule, id: r.check_id, severity: sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'info', file: rel, line, message: String((r.extra || {}).message || '').replace(/\s+/g, ' ').trim().slice(0, 300), cwe: (md.cwe || [])[0] || null, classes: [].concat(md.vulnerability_class || []) };
        report.findings.push(f); report.summary[f.severity]++;
      }
      report.files = ((out.paths || {}).scanned || []).length;
      report.rules = new Set(report.findings.map((f) => f.id)).size;
      report.errors = (out.errors || []).length;
      // what went wrong, not only how often (2026-09-30: "1 error", 0 files scanned, reported ok - nobody could say why)
      report.errorText = (out.errors || []).slice(0, 5).map((e) => String(e.type || e.level || '') + ': ' + String(e.message || e.long_msg || e.short_msg || '').replace(/\s+/g, ' ').slice(0, 300));
      /* A SCAN THAT READ NOTHING DID NOT PASS (once: ok, 0 files, 1 error, 0 findings after 15 min - the
         security line read clean while nothing was checked) */
      report.ok = report.files > 0;
      if (!report.ok) report.why = 'semgrep scanned no files' + (report.errorText.length ? ' - ' + report.errorText.join(' | ') : '');
      say(report.findings.length + ' finding' + (report.findings.length === 1 ? '' : 's') + ' on ' + report.files + ' files in ' + Math.round((Date.now() - started) / 1000) + ' s');
      resolve(land());
    });
  });
}

module.exports = { run, latest, available, EXE, RULES, HOME };
