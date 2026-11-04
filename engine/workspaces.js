/* CODER FOLDERS.

   Every coder works a project in its OWN folder, <project>\.coders\<coder id> - a git worktree of the project: the same
   history, its own files and its own checked-out branch. Before this, every coder shared the project's one checkout, so
   two at once switched branches under each other (the 53 stranded commits of PR #4066 came from that). The project's own
   folder is left alone - it is the owner's and Cockpit's copy.

   Global by construction: any project with the Coding plugin and a git repo gets a coder's folder the first time that
   coder takes one of its tickets - nothing to configure per coder. What a folder needs beyond the code (its packages,
   its own test database) is the PROJECT's recipe, <project>\.cockpit\coders.json:
     { "setup": [ { "run": "pnpm install --frozen-lockfile --prefer-offline" },
                  { "copy": "apps/api/.env", "replace": { "myapp_test": "myapp_{coderdb}_test" } },
                  { "bash": "scripts/local-test-db.sh", "env": { "MYAPP_TEST_DB": "myapp_{coderdb}_test" } } ] }
   {coder} is the coder's id; {coderdb} the same made safe for a database name (codex-cli -> codex_cli). No recipe: the
   folder is just the code. Setup runs once per coder per project (again only when the recipe changes); its log is
   .coders\<coder>.setup.log, and a failure is said once as an event, not retried in a loop.

   `.coders` is kept out of the project's git (its local exclude, never a committed file), and out of Cockpit's backups,
   map and scans. The engine runs this ON the machine that holds the projects: git's worktree records hold that machine's
   paths, so a `git worktree prune` run from another machine over a share would read every folder as missing. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const FOLDER = '.coders';
const RETRY_AFTER_FAIL_MS = 30 * 60000;
const state = new Map();   // "<project>/<coder>" -> { state: preparing | failed, why, at }

function dirFor(p, coder) { return path.join(p.dir, FOLDER, coder); }
/* the code's git: the project folder, or its one subfolder holding .git (e.g. a workshop folder keeping its repo in my-app\) -
   the same rule the ticket checks use (engine/verify.js repoOf) */
function repo(p) { try { return require('./hot').hot(path.join(__dirname, 'verify.js')).repoOf(p); } catch (e) { return { dir: p.dir, prefix: '' }; } }
/* Which projects: Coding on, a git repo, and work that travels by PULL REQUEST (the GitHub plugin), or a project that
   asks for it with its own recipe. A project whose folder IS its running dev site and is edited in place
   must not - unless its recipe says "land": "dev": then the coder works in its own folder and
   Cockpit merges the finished, checked work into the dev folder (engine/land.js). */
function on(p) {
  const plugins = (p.cockpit && p.cockpit.json && p.cockpit.json.plugins) || [];
  if (!plugins.includes('coding') || !fs.existsSync(path.join(repo(p).dir, '.git'))) return false;
  return plugins.includes('github') || fs.existsSync(path.join(p.cockpit.dir, 'coders.json'));
}
/* does this project land its coders' work in its own dev folder (rather than by pull request)? */
function landsInDev(p) { return on(p) && recipe(p).land === 'dev'; }
function recipe(p) { try { return JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'coders.json'), 'utf8')); } catch (e) { return { setup: [] }; } }
const dbName = (coder) => String(coder).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const fill = (s, coder) => String(s).replace(/\{coder\}/g, coder).replace(/\{coderdb\}/g, dbName(coder));
const hashOf = (r) => crypto.createHash('sha1').update(JSON.stringify(r.setup || [])).digest('hex').slice(0, 12);
const marker = (p, coder) => path.join(dirFor(p, coder), '.coder-ready.json');

/* 'ready' | 'preparing' | { failed: why }. Starts the preparation when it has not been done; never blocks. */
function ensure(p, coder) {
  const key = p.entry.id + '/' + coder, s = state.get(key);
  if (s && s.state === 'preparing') return 'preparing';
  const r = recipe(p);
  try { const m = JSON.parse(fs.readFileSync(marker(p, coder), 'utf8')); if (m.recipe === hashOf(r) && fs.existsSync(path.join(dirFor(p, coder), '.git'))) return 'ready'; } catch (e) { /* not prepared yet */ }
  if (s && s.state === 'failed' && Date.now() - s.at < RETRY_AFTER_FAIL_MS) return { failed: s.why };
  state.set(key, { state: 'preparing', at: Date.now() });
  prepare(p, coder, r).then(() => state.delete(key), (e) => {
    state.set(key, { state: 'failed', why: e.message, at: Date.now() });
    try { require('./events').record(p, { kind: 'coder.folder', level: 'alert', title: coder + '\'s folder in ' + p.entry.id + ' could not be set up: ' + e.message.slice(0, 160), text: 'see ' + path.join(p.dir, FOLDER, coder + '.setup.log') + '; tried again in 30 minutes', source: 'fleet' }); } catch (x) { /* */ }
  });
  return 'preparing';
}

function run(cmd, cwd, env, log, timeoutMs) {
  return new Promise((resolve, reject) => {
    fs.appendFileSync(log, '\n$ ' + cmd + '\n');
    const child = cp.spawn(cmd, { cwd, env, shell: true, windowsHide: true });
    const put = (d) => { try { fs.appendFileSync(log, d); } catch (e) { /* */ } };
    child.stdout.on('data', put); child.stderr.on('data', put);
    const t = setTimeout(() => { try { process.platform === 'win32' ? cp.execSync('taskkill /pid ' + child.pid + ' /T /F', { windowsHide: true, stdio: 'ignore' }) : child.kill('SIGKILL'); } catch (e) { /* */ } }, timeoutMs || 20 * 60000);
    child.on('error', (e) => { clearTimeout(t); reject(new Error(cmd + ': ' + e.message)); });
    child.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('`' + cmd + '` exited ' + code + ' - see the setup log')); });
  });
}
/* Git Bash, found from git's own install: on Windows a bare `bash` may be WSL's, which is another machine as far as the
   project's scripts are concerned (a recipe step { "bash": "scripts/x.sh" } runs here) */
function gitBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const exec = cp.execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();   // …\Git\mingw64\libexec\git-core
    const root = path.resolve(exec, '..', '..', '..');
    for (const c of [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]) if (fs.existsSync(c)) return c;
  } catch (e) { /* */ }
  return 'bash';
}
const git = (p, args) => cp.execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd: repo(p).dir, encoding: 'utf8', timeout: 5 * 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitIn = (dir, args) => cp.execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd: dir, encoding: 'utf8', timeout: 5 * 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* keep the folders out of the project's own git: its LOCAL exclude file, never a committed .gitignore */
function excludeLocally(p) {
  try {
    const f = path.join(git(p, ['rev-parse', '--git-common-dir']).replace(/^(?![A-Za-z]:|\/)/, repo(p).dir + path.sep), 'info', 'exclude');
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    /* the folders themselves, and what Cockpit writes inside a coder's folder (the harness's .cockpit cache, this
       module's ready marker) - the exclude file is shared by every worktree, so one entry covers them all (2026-09-25:
       pi's first turn left both untracked in its folder, one `git add -A` away from a PR) */
    const have = cur.split(/\r?\n/);
    const want = ['/' + FOLDER + '/', '/.cockpit/', '/.coder-ready.json'].filter((l) => !have.includes(l));
    if (want.length) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '# coder folders (Cockpit, engine/workspaces.js)\n' + want.join('\n') + '\n'); }
  } catch (e) { /* git will list the folder as untracked; nothing breaks */ }
}

async function prepare(p, coder, r) {
  const dir = dirFor(p, coder);
  fs.mkdirSync(path.join(p.dir, FOLDER), { recursive: true });
  excludeLocally(p);
  const log = path.join(p.dir, FOLDER, coder + '.setup.log');
  fs.writeFileSync(log, 'coder folder for ' + coder + ' in ' + p.entry.id + ', ' + new Date().toISOString() + '\n');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    let base;
    if (r.land === 'dev') base = git(p, ['rev-parse', 'HEAD']);   // a dev-landing project: the coder starts from what dev runs now, not from main
    else {
      try { git(p, ['fetch', 'origin']); } catch (e) { fs.appendFileSync(log, 'fetch failed, using what is here: ' + e.message + '\n'); }
      base = 'origin/main'; try { git(p, ['rev-parse', '--verify', base]); } catch (e) { base = 'HEAD'; }
    }
    git(p, ['worktree', 'add', '--detach', dir, base]);   // detached: the coder names its own branch per ticket, and no branch is held by two folders
    fs.appendFileSync(log, 'worktree added at ' + dir + ' from ' + base + '\n');
  }
  const env = { ...process.env, COCKPIT_CODER: coder };
  for (const step of r.setup || []) {
    if (step.copy) {
      const from = path.join(repo(p).dir, step.copy), to = path.join(dir, step.copy);   // copied from the code's own folder (the project folder, or its repo subfolder)
      if (!fs.existsSync(from)) { fs.appendFileSync(log, 'copy: ' + step.copy + ' is not in the project folder - skipped\n'); continue; }
      let text = fs.readFileSync(from, 'utf8');
      for (const [a, b] of Object.entries(step.replace || {})) text = text.split(a).join(fill(b, coder));
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, text);
      fs.appendFileSync(log, 'copied ' + step.copy + (step.replace ? ' (with ' + Object.keys(step.replace).length + ' replacement(s))' : '') + '\n');
    } else if (step.bash) {
      const stepEnv = { ...env }; for (const [k, v] of Object.entries(step.env || {})) stepEnv[k] = fill(v, coder);
      await run('"' + gitBash() + '" ' + fill(step.bash, coder), dir, stepEnv, log, step.timeoutMinutes ? step.timeoutMinutes * 60000 : undefined);
    } else if (step.run) {
      const stepEnv = { ...env }; for (const [k, v] of Object.entries(step.env || {})) stepEnv[k] = fill(v, coder);
      await run(fill(step.run, coder), dir, stepEnv, log, step.timeoutMinutes ? step.timeoutMinutes * 60000 : undefined);
    }
  }
  fs.writeFileSync(marker(p, coder), JSON.stringify({ coder, project: p.entry.id, recipe: hashOf(r), at: new Date().toISOString(), db: dbName(coder) }, null, 1) + '\n');
  fs.appendFileSync(log, '\nready ' + new Date().toISOString() + '\n');
}

/* what the fleet card and the board can say about a coder's folder in a project */
function status(p, coder) {
  const s = state.get(p.entry.id + '/' + coder);
  if (s) return s.state === 'preparing' ? 'setting up its folder' : 'folder setup failed: ' + s.why;
  try { const m = JSON.parse(fs.readFileSync(marker(p, coder), 'utf8')); return 'folder ready (' + m.at.slice(0, 10) + ')'; } catch (e) { return 'no folder yet'; }
}

/* the coder's own database, when the project's recipe names one ("db": "myapp_{coderdb}_test") - said to the coder */
function dbFor(p, coder) { const r = recipe(p); return r.db ? fill(r.db, coder) : null; }

/* A DEV-LANDING CODER STARTS EACH ITEM FROM WHAT DEV RUNS NOW (other coders' landed work included). Only when its folder
   holds nothing of its own: clean, and nothing committed that dev does not already have - a retry after a failed check keeps
   its work (engine/land.js catches it up with dev when it lands). Returns what it did, for the log. */
function sync(p, coder) {
  if (!landsInDev(p)) return null;
  const dir = dirFor(p, coder); if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    const dirty = gitIn(dir, ['status', '--porcelain']).split(/\r?\n/).filter((l) => l.trim() && !/\.coder-ready\.json|(^|\/)\.cockpit\//.test(l));
    if (dirty.length) return 'kept: ' + dirty.length + ' uncommitted change(s) in its folder';
    const devHead = git(p, ['rev-parse', 'HEAD']);
    const own = gitIn(dir, ['rev-list', '--count', devHead + '..HEAD']);
    if (Number(own) > 0) return 'kept: ' + own + ' commit(s) not in dev yet';
    gitIn(dir, ['checkout', '--detach', devHead]);
    return 'at dev ' + devHead.slice(0, 9);
  } catch (e) { return 'sync failed: ' + String(e.message).split('\n')[0]; }
}

module.exports = { FOLDER, on, ensure, dirFor, dbFor, status, dbName, repo, landsInDev, recipe, sync };
