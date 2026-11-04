#!/usr/bin/env node
/* GitHub scan - the repo's work as GitHub holds it, into the project's gh_ tables.
   Run by the engine as a child process (on demand, and every `every` minutes):
     node scan.js <projectDir> <dbPath> <answersJson>
   Prints ONE JSON line: { ok, yields, note }.

   Sources, all through the gh command line (already logged in on the engine's machine):
     tickets   every OPEN issue, plus issues closed within the lookback
     PRs       every OPEN PR (with checks, review, mergeability), plus PRs updated within the
               lookback (merged / closed, with their merge commit)
     versions  the optional env=url endpoints, fetched as JSON

   PR -> ticket linkage follows the 2026-08-10 audit ruling exactly: a bare `#N` in a body is
   NOT evidence (every audited bare mention was diagnostic). Linkage counts only
   closingIssuesReferences, a `#N` in the TITLE, or a body `#N` after a linking verb
   (Implements / Part of / Closes ...). Bots are excluded - dependabot changelogs carry other
   repos' issue numbers.

   Derived here, by the rules in stages.json and attention.json (project overrides apply):
     stage      per open ticket, from its labels and its PRs
     attention  what is stuck and on whom - one row per blocked ticket, failing PR, and the
                local-model PRs waiting for a frontier
   Rules are data; only the looking is code. */
'use strict';
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const [,, projectDir, dbPath, answersJson] = process.argv;
const A = JSON.parse(answersJson || '{}');
const repo = String(A.repo || '').trim();
const say = (s) => process.stderr.write(s + '\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 2); };
if (!repo) out({ ok: false, note: 'no repository answered' });

const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const now = new Date().toISOString();
const lookback = Math.max(1, Number(A.lookbackDays) || 45);
const since = new Date(Date.now() - lookback * 864e5).toISOString().slice(0, 10);

/* rules: plugin defaults, project overrides on top (same shape, only what it names) */
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const merged = (name) => { const base = readJson(path.join(__dirname, name + '.json')) || {}; const over = readJson(path.join(projectDir, '.cockpit', 'plugins', 'github.' + name + '.json')) || {}; return deepMerge(base, over); };
function deepMerge(a, b) { const o = { ...a }; for (const k of Object.keys(b)) o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') ? deepMerge(a[k], b[k]) : b[k]; return o; }
const ATT = merged('attention'), STG = merged('stages');

/* people: login -> shown name; the wizard's login is "you" */
const people = {};
String(A.people || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((kv) => { const [k, v] = kv.split('=').map((x) => x.trim()); if (k && v) people[k] = v; });
const you = String(A.you || '').trim();
const nameOf = (login) => !login ? 'nobody' : login === you ? 'you' : (people[login] || login);

/* GitHub's API answers 502/504 under load (2026-10-12 morning, for hours): one retry after a pause before giving up */
function gh(args) {
  try { return gh1(args); }
  catch (e) {
    if (!/\b50[234]\b|timeout|timed out/i.test(String(e.message))) throw e;
    cp.execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { windowsHide: true });
    return gh1(args);
  }
}
function gh1(args) {
  try { return JSON.parse(cp.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 180000, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1', GH_PAGER: '' } })); }
  catch (e) {
    // say WHY, not just "failed": under a service start gh may be absent from PATH or unauthenticated for that account (2026-09-17)
    const why = e.code === 'ENOENT' ? 'gh not found on PATH (' + (process.env.PATH || '').split(';').length + ' entries)' : String(e.stderr || e.message).trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300);
    throw new Error('gh ' + args.slice(0, 2).join(' ') + ': ' + why);
  }
}
const { isBot, ticketsOf, checksOf } = require('./link');   // one linkage rule, shared with the fleet (engine/ghqueue.js)

const yields = { issuesOpen: 0, issuesClosed: 0, prsOpen: 0, prsMerged: 0, prsClosed: 0, linked: 0, attention: 0, envs: 0 };
const notes = [];

/* ---------- tickets ---------- */
const IFIELDS = 'number,title,state,author,assignees,labels,createdAt,updatedAt,closedAt,url,body';
let issues = [];
/* Owner, 2026-10-12: a failed read of the open tickets used to wipe the board and save the empty result as if GitHub had
   no tickets (every column 0). Now the scan stops and the last good board stays, with the reason in the scan log. */
try { issues = gh(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '2000', '--json', IFIELDS]); } catch (e) { out({ ok: false, note: 'open issues could not be read; kept the last good board - ' + String(e.message).split('\n')[0] }); }
try { issues = issues.concat(gh(['issue', 'list', '-R', repo, '--state', 'closed', '--limit', '1000', '--search', 'closed:>=' + since + ' sort:updated-desc', '--json', IFIELDS])); } catch (e) { notes.push('closed issues: ' + String(e.message).split('\n')[0]); }
const byNumber = new Map(); for (const i of issues) byNumber.set(i.number, i);   // closed list may repeat an open one after a state flip

/* ---------- PRs ---------- */
const PFIELDS = 'number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,mergedAt,mergeCommit,url,body,closingIssuesReferences';
let prs = [];
try { prs = gh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '500', '--json', PFIELDS + ',statusCheckRollup,reviewDecision,mergeable']); } catch (e) { out({ ok: false, note: 'open PRs could not be read; kept the last good board - ' + String(e.message).split('\n')[0] }); }
try { prs = prs.concat(gh(['pr', 'list', '-R', repo, '--state', 'merged', '--limit', '500', '--search', 'merged:>=' + since + ' sort:updated-desc', '--json', PFIELDS])); } catch (e) { notes.push('merged PRs: ' + String(e.message).split('\n')[0]); }
try { prs = prs.concat(gh(['pr', 'list', '-R', repo, '--state', 'closed', '--limit', '200', '--search', 'is:unmerged closed:>=' + since + ' sort:updated-desc', '--json', PFIELDS])); } catch (e) { notes.push('closed PRs: ' + String(e.message).split('\n')[0]); }
const prByNumber = new Map(); for (const p of prs) prByNumber.set(p.number, p);

/* ---------- versions ---------- */
const envRows = [];
const envSpecs = String(A.versionUrls || '').split(',').map((s) => s.trim()).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return i > 0 ? { env: kv.slice(0, i).trim(), url: kv.slice(i + 1).trim() } : null; }).filter(Boolean);
const fetchAll = envSpecs.length ? Promise.all(envSpecs.map((e) => fetch(e.url, { signal: AbortSignal.timeout(15000) }).then(async (r) => ({ env: e.env, ok: r.ok, version: (await r.text()).slice(0, 4000), note: r.ok ? null : 'HTTP ' + r.status })).catch((err) => ({ env: e.env, ok: false, version: null, note: err.message })))) : Promise.resolve([]);

fetchAll.then((envs) => {
  envs.forEach((e) => { envRows.push(e); if (e.ok) yields.envs++; else notes.push(e.env + ': ' + e.note); });

  /* ---------- derive: PRs per ticket, stage per ticket ---------- */
  const prsOfTicket = new Map();
  for (const p of prs) { if (isBot(p.author && p.author.login)) continue; for (const t of ticketsOf(p)) { (prsOfTicket.get(t.number) || prsOfTicket.set(t.number, []).get(t.number)).push(p); yields.linked++; } }
  const L = STG.labels || {};
  function stageOf(issue) {
    if (issue.state !== 'OPEN' && issue.state !== 'open') return STG.closed || { id: 'done', title: 'Done', rule: 'ticket closed' };
    const labels = new Set((issue.labels || []).map((l) => l.name));
    const mine = prsOfTicket.get(issue.number) || [];
    const test = (t) => {
      if (t === 'always') return true;
      const [kind, arg] = t.split(':');
      if (kind === 'label') return labels.has(L[arg] || arg);
      if (kind === 'pr') return arg === 'open' ? mine.some((p) => p.state === 'OPEN') : arg === 'merged' ? mine.some((p) => p.state === 'MERGED') : false;
      return false;
    };
    let hit = null; for (const s of STG.stages || []) if (test(s.test)) hit = s;
    return hit || { id: 'not-started', title: 'Not started', rule: '' };
  }

  /* ---------- derive: attention ---------- */
  const attention = [];
  const tagWho = (title) => { for (const [tag, login] of Object.entries(ATT.titleTags || {})) if (tag !== '_note' && String(title || '').toUpperCase().includes(tag.toUpperCase())) return nameOf(login); return null; };
  for (const i of byNumber.values()) {
    if (String(i.state).toUpperCase() !== 'OPEN') continue;
    const labels = (i.labels || []).map((l) => l.name);
    const hit = labels.map((l) => (ATT.labels || {})[l] && { label: l, ...ATT.labels[l] }).filter(Boolean).sort((a, b) => a.rank - b.rank)[0];
    if (!hit) continue;
    const assignee = (i.assignees || [])[0] && i.assignees[0].login;
    attention.push({ kind: hit.kind, rank: hit.rank, who: tagWho(i.title) || nameOf(assignee), number: i.number, what: 'ticket', title: i.title, text: hit.verb, url: i.url });
  }
  const S = ATT.summaries || {};
  if (S.failingPr && S.failingPr.on !== false) for (const p of prs) { if (p.state === 'OPEN' && !isBot(p.author && p.author.login) && checksOf(p) === 'fail') attention.push({ kind: S.failingPr.kind || 'failing', rank: S.failingPr.rank || 0, who: nameOf(p.author && p.author.login), number: p.number, what: 'pr', title: p.title, text: S.failingPr.text || 'checks failing', url: p.url }); }
  const localPrefix = String(A.localPrefix || '').trim();
  if (localPrefix && S.localPrsWaiting && S.localPrsWaiting.on !== false) {
    const waiting = prs.filter((p) => p.state === 'OPEN' && String(p.title).startsWith(localPrefix)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (waiting.length) { const n = waiting.length, fill = (s) => String(s).replace('{n}', n).replace('{s}', n === 1 ? '' : 's').replace('{list}', waiting.map((p) => '#' + p.number).join(', '));
      attention.push({ kind: S.localPrsWaiting.kind || 'click', rank: S.localPrsWaiting.rank || 1, who: S.localPrsWaiting.who || 'you', number: null, what: 'summary', title: fill(S.localPrsWaiting.title), text: fill(S.localPrsWaiting.text), url: null }); }
  }
  attention.sort((a, b) => a.rank - b.rank || String(a.who).localeCompare(String(b.who)));
  yields.attention = attention.length;

  /* ---------- write ---------- */
  db.exec('BEGIN');
  db.exec('DELETE FROM gh_issue'); db.exec('DELETE FROM gh_pr'); db.exec('DELETE FROM gh_attention');
  const insI = db.prepare('INSERT OR REPLACE INTO gh_issue (number, title, state, author, assignees, labels, module, created, updated, closed, url, body, stage, stage_rule, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const modulePrefix = L.modulePrefix || 'module:';
  for (const i of byNumber.values()) {
    const labels = (i.labels || []).map((l) => l.name), st = stageOf(i), open = String(i.state).toUpperCase() === 'OPEN';
    if (open) yields.issuesOpen++; else yields.issuesClosed++;
    insI.run(i.number, i.title, open ? 'open' : 'closed', i.author && i.author.login, JSON.stringify((i.assignees || []).map((a) => a.login)), JSON.stringify(labels),
      (labels.find((l) => l.startsWith(modulePrefix)) || '').slice(modulePrefix.length) || null, i.createdAt, i.updatedAt, i.closedAt, i.url, String(i.body || '').slice(0, 4000), st.id, st.rule, now);
  }
  const insP = db.prepare('INSERT OR REPLACE INTO gh_pr (number, title, state, draft, author, head, base, created, updated, merged, merge_commit, checks, review, mergeable, url, tickets, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const p of prByNumber.values()) {
    const state = p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? 'open' : 'closed';
    yields[state === 'merged' ? 'prsMerged' : state === 'open' ? 'prsOpen' : 'prsClosed']++;
    insP.run(p.number, p.title, state, p.isDraft ? 1 : 0, p.author && p.author.login, p.headRefName, p.baseRefName, p.createdAt, p.updatedAt, p.mergedAt, p.mergeCommit && p.mergeCommit.oid, checksOf(p), p.reviewDecision || null, p.mergeable || null, p.url, JSON.stringify(isBot(p.author && p.author.login) ? [] : ticketsOf(p)), now);
  }
  const insA = db.prepare('INSERT INTO gh_attention (kind, rank, who, number, what, title, text, url, at) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const a of attention) insA.run(a.kind, a.rank, a.who, a.number, a.what, a.title, a.text, a.url, now);
  const insE = db.prepare('INSERT OR REPLACE INTO gh_env (env, at, version, ok, note) VALUES (?,?,?,?,?)');
  for (const e of envRows) insE.run(e.env, now, e.version, e.ok ? 1 : 0, e.note);
  const insM = db.prepare('INSERT OR REPLACE INTO gh_meta (key, value) VALUES (?,?)');
  insM.run('repo', repo); insM.run('you', you); insM.run('people', JSON.stringify(people)); insM.run('scannedAt', now); insM.run('lookbackDays', String(lookback));
  insM.run('stages', JSON.stringify((STG.stages || []).map((s) => ({ id: s.id, title: s.title, rule: s.rule })).concat([{ id: (STG.closed || {}).id || 'done', title: (STG.closed || {}).title || 'Done', rule: (STG.closed || {}).rule || 'ticket closed' }])));
  insM.run('groups', JSON.stringify(ATT.groups || []));
  db.exec('COMMIT');

  const note = repo + ': ' + yields.issuesOpen + ' open tickets, ' + yields.prsOpen + ' open PRs, ' + yields.attention + ' need attention' + (notes.length ? ' - ' + notes.join('; ') : '');
  say(note);
  out({ ok: true, yields, note });
}).catch((e) => { try { db.exec('ROLLBACK'); } catch (e2) {} out({ ok: false, note: String(e.message || e) }); });
