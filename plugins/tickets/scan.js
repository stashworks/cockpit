#!/usr/bin/env node
/* Tickets scan - what Recent deploys needs, from the project's own git and the optional version endpoints, into the
   project's tk_ tables. Run by the engine as a child process (on demand, and every `every` minutes while the room
   is open):  node scan.js <projectDir> <dbPath> <answersJson>   Prints ONE JSON line: { ok, yields, note }.

   The tickets themselves are files (engine/tickets.js) and need no scan; the board reads them through the API.

   What reached the main branch: every FIRST-PARENT commit on it in the last 90 days - a merge commit is a PR that
   landed, a plain commit is a direct push; a squash merge is a plain commit whose subject carries "(#123)". Each row
   names the tickets its message mentions ("#123", "L2") - the same convention the promote reads (a commit naming the
   ticket moves it to promoted). Nothing here needs GitHub; with the GitHub plugin on, the card links a merge to its PR.

   The branch: the answer, else the repository's default (origin/HEAD), else main, else master. No git, or no
   repository: an honest empty read, not a failure. */
'use strict';
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const [,, projectDir, dbPath, answersJson] = process.argv;
const A = JSON.parse(answersJson || '{}');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 2); };

const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const now = new Date().toISOString();
const yields = { deploys: 0, merges: 0, envs: 0 };
const notes = [];

/* ---------- git: the branch and what reached it ---------- */
const git = (args) => cp.execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd: projectDir, encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();   // a busy repo's 90 days of bodies passed 1 MB (ENOBUFS)
let branch = String(A.branch || '').trim(), rows = [], gitNote = null;
try {
  git(['rev-parse', '--is-inside-work-tree']);
  const has = (b) => { try { git(['rev-parse', '--verify', '--quiet', b]); return true; } catch (e) { return false; } };
  if (!branch) { try { branch = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch (e) { branch = ''; } }
  if (!branch) branch = has('main') ? 'main' : has('master') ? 'master' : '';
  if (!branch) gitNote = 'no main or master branch';
  else {
    /* THE REMOTE BRANCH IS THE RECORD, NOT THE LOCAL ONE (Recent deploys read as "15 tickets went to
       prod" while prod had not moved since the 17th - the list was local first-parent commits, 52 of which had never been
       pushed anywhere). A landing is something the team can see: origin/<branch> when there is one, the local branch only
       when there is no remote at all (a project with no GitHub). */
    const ref = has('origin/' + branch) ? 'origin/' + branch : has(branch) ? branch : null;
    if (!ref) gitNote = 'no branch ' + branch;
    else {
      const SEP = '\x1e', NL = '\x1f';
      const log = git(['log', ref, '--first-parent', '--since=90 days ago', '--format=%H' + NL + '%h' + NL + '%s' + NL + '%an' + NL + '%cI' + NL + '%P' + NL + '%b' + SEP]);
      for (const rec of log.split(SEP)) {
        const f = rec.replace(/^\s+/, '').split(NL); if (f.length < 6 || !f[0]) continue;
        const [sha, short, subject, author, at, parents] = f; const body = f.slice(6).join(NL);
        const merge = parents.trim().split(/\s+/).length > 1 ? 1 : 0;
        const text = subject + '\n' + body;
        const ids = new Set(); for (const m of text.matchAll(/(?:^|[^\w])(#\d+|L\d+)(?![\w])/g)) ids.add(m[1]);
        const pr = (/\(#(\d+)\)\s*$/.exec(subject) || /Merge pull request #(\d+)/.exec(subject) || [])[1];
        if (pr) ids.delete('#' + pr);   // the PR's own number is not a ticket
        rows.push({ sha, short, subject, author, at, merge, tickets: JSON.stringify([...ids]), pr: pr ? Number(pr) : null });
      }
    }
  }
} catch (e) { gitNote = /not a git repository/i.test(e.message + (e.stderr || '')) ? 'not a git repository' : 'git: ' + String(e.message).split('\n')[0].slice(0, 160); }
if (gitNote) notes.push(gitNote);

/* ---------- the version endpoints: the answer here, else the GitHub plugin's older answer (it lived there once) ---------- */
let specs = String(A.versionUrls || '').trim();
if (!specs) { try { specs = String(JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'plugins', 'github.json'), 'utf8')).versionUrls || '').trim(); } catch (e) { /* none */ } }
const envSpecs = specs.split(',').map((s) => s.trim()).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return i > 0 ? { env: kv.slice(0, i).trim(), url: kv.slice(i + 1).trim() } : null; }).filter(Boolean);
const fetchAll = envSpecs.length ? Promise.all(envSpecs.map((e) => fetch(e.url, { signal: AbortSignal.timeout(15000) }).then(async (r) => ({ env: e.env, ok: r.ok, version: (await r.text()).slice(0, 4000), note: r.ok ? null : 'HTTP ' + r.status })).catch((err) => ({ env: e.env, ok: false, version: null, note: err.message })))) : Promise.resolve([]);

fetchAll.then((envs) => {
  db.exec('BEGIN');
  db.exec('DELETE FROM tk_deploy');
  const ins = db.prepare('INSERT OR REPLACE INTO tk_deploy (sha, short, subject, author, at, merge, tickets, pr) VALUES (?,?,?,?,?,?,?,?)');
  for (const r of rows) { ins.run(r.sha, r.short, r.subject, r.author, r.at, r.merge, r.tickets, r.pr); yields.deploys++; if (r.merge) yields.merges++; }
  const insE = db.prepare('INSERT INTO tk_env (env, at, version, ok, note) VALUES (?,?,?,?,?)');
  /* A RELEASE is a CHANGE, not a reading: compare what the environment says now with the last thing it said, and record only
     the moment it moved. That is what "recent deploys" has to mean - prod had not moved since 17 September while the card
     showed a list of landings. */
  const shaOf = (v) => { try { const j = JSON.parse(v); return String(j.sha || j.version || '').slice(0, 12); } catch (e) { return String(v || '').replace(/[^0-9a-f]/gi, '').slice(0, 12); } };
  db.exec("DELETE FROM tk_release WHERE prev IS NULL OR prev = ''");   // baselines wrongly recorded as deploys before the rule above (2026-09-22)
  const insR = db.prepare('INSERT INTO tk_release (env, at, sha, prev) VALUES (?,?,?,?)');
  const lastOf = db.prepare("SELECT version FROM tk_env WHERE env = ? ORDER BY at DESC LIMIT 1");
  const lastRel = db.prepare("SELECT sha FROM tk_release WHERE env = ? ORDER BY at DESC LIMIT 1");
  for (const e of envs) {
    const before = e.ok ? shaOf((lastOf.get(e.env) || {}).version) : null;
    insE.run(e.env, now, e.version, e.ok ? 1 : 0, e.note);
    if (e.ok) yields.envs++; else notes.push(e.env + ': ' + e.note);
    if (!e.ok) continue;
    const nowSha = shaOf(e.version); if (!nowSha) continue;
    const seen = shaOf((lastRel.get(e.env) || {}).sha);
    /* A RELEASE IS A CHANGE WE WATCHED HAPPEN. The FIRST time Cockpit sees an environment it learns a baseline, not a deploy -
       recording one read as "prod deployed today" when prod had not moved since 17 September. So: only
       when we have a previous reading AND it differs. Before that, the top of the card says what each environment serves. */
    if (!before) continue;                    // first sighting: a baseline, nothing shipped
    if (before === nowSha) continue;          // unchanged
    if (seen === nowSha) continue;            // already recorded
    insR.run(e.env, now, nowSha, before);
    yields.releases = (yields.releases || 0) + 1;
  }
  db.exec("DELETE FROM tk_env WHERE at < datetime('now', '-60 days')");
  const insM = db.prepare('INSERT OR REPLACE INTO tk_meta (key, value) VALUES (?,?)');
  insM.run('scannedAt', now); insM.run('branch', branch || ''); insM.run('gitNote', gitNote || '');
  db.exec('COMMIT');
  out({ ok: true, yields, note: notes.join('; ') });
}).catch((e) => { try { db.exec('ROLLBACK'); } catch (x) { /* */ } out({ ok: false, note: e.message }); });
