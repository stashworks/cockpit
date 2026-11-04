/* THE QUEUE ON A GITHUB PROJECT.
   GitHub holds the ticket and where it stands; a fleet item is only the ticket's place in the owner's order and its
   try count. The night before, the item carried its own "done" and three things went wrong from it: a turn that stopped
   short said done and the ticket left the queue unfinished (#2206, #2999), a ticket closed on GitHub kept its item
   (#3811), and a new ticket never reached the queue at all.

   The owner's process, and where each column comes from:
     Open tickets            filed on GitHub
     To work                 an open ticket nothing holds - every one has an item, new ones at the bottom (sync)
     Being coded / tests     an item a coder is running (a PR open = its tests)
     In UAT                  a PR that names the ticket merged                     item 'merged'
     Not completed           the turn ended with neither - back to To work with what went wrong, TRIES tries
     Blocked                 a blocked:* label (the coder's, or retries exhausted), a hold label, or the
                             ticket is someone else's                              item 'blocked'
     Done                    the ticket closed                                     item 'closed'
   A turn never says where its ticket went: afterTurn reads GitHub fresh when the turn ends.

   sync(p, items, add)       the queue matched to the last scan (plugins/github, every 10 min)
   afterTurn(p, it)          where the turn left the ticket, and what to do with the item
   preamble(p, it)           what every turn on a GitHub ticket is told about blocking and its last try
   Rules are pure (hold, classify, plan) and tested in test/gh-queue.js. */
'use strict';
try { require('./lagwatch').install(); } catch (e) { /* the timing log is optional (D6, 2026-09-30) */ }
try { require('./janitor').install(); } catch (e) { /* the nightly clean-up is optional */ }
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const link = require('../plugins/github/link');

const TRIES = 3;
/* owner = waiting on the project's owner (stays Blocked); other = waiting on another person (shown as Assigned to others).
   A project renames either in .cockpit/plugins/github.queue.json: { "blockedLabels": { "owner": "...", "other": "..." } } */
const BLOCKED = { owner: 'blocked:waiting-on-owner', other: 'blocked:waiting-on-someone-else', environment: 'blocked:environment', uat: 'blocked:uat-deploy-failed', retries: 'blocked:retries-exhausted' };
/* what keeps an open ticket off To work: a person's step (decide, test, confirm live) or somebody else's ticket. A
   project widens it in .cockpit/plugins/github.queue.json: { "holdLabels": [...], "skipAssignees": ["other-dev"] } */
const DEFAULTS = { holdLabels: ['needs:decision', 'status:verified', 'status:live', 'status:in-uat', 'status:uat'], skipAssignees: [], strong: { labels: ['security', 'findings'], harness: 'claude-code' }, blockedLabels: { owner: BLOCKED.owner, other: BLOCKED.other } };
const LIVE = ['queued', 'running', 'blocked', 'merged', 'parked', 'merging', 'handed'];
const MERGING_MAX_MIN = 90;   // a PR still in the merge queue after this long is treated as having left it   // an item in one of these IS the ticket's place

function githubOf(p) { try { const g = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'plugins', 'github.json'), 'utf8')); return g.repo ? g : null; } catch (e) { return null; } }
function config(p) {
  let o = {}; try { o = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'plugins', 'github.queue.json'), 'utf8')); } catch (e) { /* the defaults */ }
  const s = o.strong && typeof o.strong === 'object' ? o.strong : {};
  const bl = o.blockedLabels && typeof o.blockedLabels === 'object' ? o.blockedLabels : {};
  return { holdLabels: Array.isArray(o.holdLabels) ? o.holdLabels : DEFAULTS.holdLabels, skipAssignees: Array.isArray(o.skipAssignees) ? o.skipAssignees : DEFAULTS.skipAssignees,
    strong: { labels: Array.isArray(s.labels) ? s.labels : DEFAULTS.strong.labels, harness: typeof s.harness === 'string' ? s.harness : DEFAULTS.strong.harness },
    blockedLabels: { owner: typeof bl.owner === 'string' ? bl.owner : DEFAULTS.blockedLabels.owner, other: typeof bl.other === 'string' ? bl.other : DEFAULTS.blockedLabels.other } };
}
/* SECURITY AND FINDINGS TICKETS GO TO THE STRONG CODERS ONLY (never Pi). A ticket with one of the strong
   labels, or a findings marker in its body (engine/findings.js), may be taken only by a coder of cfg.strong.harness - any of
   them, on any account. A project changes the labels or the harness in .cockpit/plugins/github.queue.json { "strong": {...} }. */
function harnessFor(labels, body, cfg) {
  const strong = (labels || []).some((l) => cfg.strong.labels.includes(l)) || /<!--\s*cockpit:findings\s/.test(String(body || ''));
  return strong && cfg.strong.harness ? cfg.strong.harness : null;
}
/* where an item's merges are counted from: when it was added, or when the findings check last sent it back - a merge before
   that is the one the check already judged */
const startOf = (it) => it.redoAt || it.added;
/* the GitHub number an item works: set by sync; older items carried it as the Cockpit ticket id or the title's "#N:" */
function numOf(it) {
  if (it.gh) return Number(it.gh);
  if (/^\d+$/.test(String(it.ticket || ''))) return Number(it.ticket);
  const m = /^\s*#(\d+)\b/.exec(it.title || ''); return m ? Number(m[1]) : null;
}
const prio = (labels) => labels.includes('P0') ? 'next' : ['P1', 'P2', 'P3'].find((x) => labels.includes(x)) || 'P3';

/* ---------- the rules (pure) ---------- */
/* issue: { number, state: open|closed, labels: [..], assignees: [..] } · pr: { number, state: open|merged|closed, merged, checks, tickets: [n..] } */
/* a hold that is a LATER step (a person has it in UAT, passed it, or confirmed it live) is past coding, not blocked */
const PAST = /^status:(verified|live|in-uat|uat)$/;
/* a ticket someone else now owns (assigned to a skipped person) is HANDED OFF, not blocked: blocked means stuck and
   waiting on the owner, and another person's work counted there made the owner's queue say "1 blocked" for something
   that was not theirs */
const holdTo = (h) => PAST.test(h) ? 'merged' : /^assigned to /.test(h) ? 'handed' : 'blocked';
function hold(issue, cfg) {
  /* blocked:uat-deploy-failed says where the CODE is (merged, not on UAT) - it is not a reason for a coder to stop; the fix for
     a failed deploy is usually work on that very ticket (2026-09-26: #2523 and #3549 broke the deploy and had to be fixed) */
  const b = issue.labels.find((l) => l.startsWith('blocked:') && l !== BLOCKED.uat); if (b) return b;
  const h = issue.labels.find((l) => cfg.holdLabels.includes(l)); if (h) return h;
  const a = issue.assignees.find((x) => cfg.skipAssignees.includes(x)); if (a) return 'assigned to ' + a;
  return null;
}
/* where a turn left its ticket. since = when the try was claimed: only a merge after it is this try's */
/* PART OF IT (a merged PR that did only part of the ticket sends it back to To work, not to In UAT).
   The coder's PR body says "Remaining: <what is left>" (plugins/github/link.js); x.rest maps a ticket to that text. */
/* A PERSON'S CHECK IS NOT CODE LEFT ("Remaining: the owner's UAT check" read
   as a part merge, so a finished ticket went back to To work every try and was blocked "retries exhausted"). Checking on
   UAT is what In UAT means; only coder work remaining keeps the ticket in the coders' queue. */
const PERSON_WORDS = /\b(owner|person|human|someone|manual|qa|uat)\b/i, CHECK_WORDS = /\b(check|test|testing|verif(y|ication)|review|sign-?off|read-?back|smoke|qa|needs:qa)\b/i;
const CODE_WORDS = /\b(code|implement|write|fix|build|add|wire|migrat\w*|refactor|test file|ticket|decid\w*|decision|plan)\b/i;
/* two more ways a coder says it (2026-09-30, #5044: "Remaining: the Closes-when check on the test copy, which is the owner's
   test on UAT: stop a snapshot job and watch the alert fire ... Code-wise: none." went back three times - "watch the alert
   fire" names no person, and link.js keeps only 300 characters, so the closing "Code-wise: none" was cut off):
   an explicit "code: none" / "no code left" anywhere, or a LEADING clause (up to the first ':' or '.') that is a person's
   check - what follows it is how to do the check, not more work */
// + "none in code" / "nothing (left) in (the) code" / "no code change(s) left" (2026-10-01, #5162: "Remaining: none in code. The ticket's
//   Done when ... is checked by the next test-copy run" went back three times)
const NO_CODE = /\bcode(?:[- ]?wise)?\s*:\s*none\b|\bno code (?:left|remaining|to write|changes? (?:left|remaining))\b|\bnothing (?:left )?to (?:code|write)\b|^\s*(?:none|nothing)(?: left| remaining)? in (?:the )?code\b/i;
/* a check that can only happen AFTER the merge, on the test copy / the next run (2026-10-02, #5201: "Remaining: 10 consecutive
   passes of shell.switch-entity on the test copy, which runs main, so it can only be measured after this merges" went back
   three times - no person named, but no code left either) */
const AFTER_MERGE = /\b(test copy|next (?:full )?run|next refresh|code refresh|after (?:this|it) merges|once (?:this is |it is )?merged|on uat|in uat)\b/i;
const PROOF_WORDS = /\b(pass(?:es|ing)?|green|measur\w*|verif\w*|check\w*|prove\w*|proof|confirm\w*|observ\w*)\b/i;
const personCheck = (s0) => {
  const s = String(s0).replace(/\bcode refresh\b/gi, 'refresh');   // the test copy's "code refresh" is an event, not code to write
  return /needs:qa/i.test(s) || (PERSON_WORDS.test(s) && CHECK_WORDS.test(s) && !CODE_WORDS.test(s)) || (AFTER_MERGE.test(s) && PROOF_WORDS.test(s) && !CODE_WORDS.test(s));
};
const personOnly = (t) => {
  if (!t) return false; const s = String(t);
  if (NO_CODE.test(s)) return true;
  if (personCheck(s.split(/[:.]\s/)[0])) return true;
  return s.split(/[;\n]|\s+and\s+/).map((x) => x.trim()).filter(Boolean).every(personCheck);
};
const restOf = (x, n) => { const r = (x.rest && x.rest[n]) || null; return r && !personOnly(r) ? r : null; };
const restMap = (tickets) => { const o = {}; for (const t of tickets || []) if (t && t.remaining) o[t.number] = t.remaining; return o; };
const wholeMerge = (x, n, since) => x.state === 'merged' && x.merged && x.merged >= since && !restOf(x, n);
const partMerge = (x, n, since) => x.state === 'merged' && x.merged && x.merged >= since && !!restOf(x, n);
function classify(issue, prs, since, cfg) {
  if (issue.state !== 'open') return { status: 'closed', why: 'the ticket is closed on GitHub' };
  const mine = prs.filter((x) => x.tickets.includes(issue.number));
  const merged = mine.find((x) => wholeMerge(x, issue.number, since));
  if (merged) return { status: 'merged', why: 'PR #' + merged.number + ' merged - in UAT', pr: merged.number };
  const part = mine.find((x) => partMerge(x, issue.number, since));
  if (part) return { status: 'part', why: 'PR #' + part.number + ' merged PART of it - remaining: ' + restOf(part, issue.number), pr: part.number };
  /* IN THE MERGE QUEUE = MERGING, not a failed try (2026-09-25: #2989, #3019 and #2656 were blocked while GitHub's merge
     queue held their green PRs - all three merged minutes after the turn ended). It wins over a hold the coder added
     while waiting on the queue. */
  const queued = mine.find((x) => x.state === 'open' && x.inQueue);
  if (queued) return { status: 'merging', why: 'PR #' + queued.number + ' is in the merge queue', pr: queued.number };
  const h = hold(issue, cfg); if (h) return { status: holdTo(h), why: h };
  const open = mine.find((x) => x.state === 'open');
  return { status: 'notdone', why: open ? 'PR #' + open.number + ' is open, its checks ' + (open.checks || 'unknown') : 'nothing merged', pr: open ? open.number : null };
}
/* the queue against the scan: which queued items leave (closed / merged since they were added / held), which blocked
   items come back (the hold lifted), which open tickets are missing an item. Returns moves; the caller applies them. */
function plan(items, issues, prs, cfg, scannedAt) {
  const byN = new Map(issues.map((i) => [i.number, i]));
  const prsOf = (n) => prs.filter((x) => x.tickets.includes(n));
  const moves = [];
  for (const it of items) {
    const n = numOf(it); if (!n) continue;
    const i = byN.get(n); if (!i) continue;   // not in the scan (closed before the lookback): the turn's fresh read decides
    if (it.status === 'queued') {
      if (i.state !== 'open') { moves.push({ it, to: 'closed', why: 'the ticket was closed on GitHub' }); continue; }
      const m = prsOf(n).find((x) => wholeMerge(x, n, startOf(it)));
      if (m) { moves.push({ it, to: 'merged', why: 'PR #' + m.number + ' merged - in UAT' }); continue; }
      /* PUT BACK BY HAND AFTER A BLOCK (#3882 bounced back to Blocked three times after its label came off,
         because the scan still held the label for up to 10 minutes). An item that is queued while its last outcome is still a
         block was sent back by a person - nothing in the engine requeues without rewriting the outcome. The first sync that sees
         it notes the time; a hold is obeyed again only from a scan taken after that. */
      const o = it.outcome || {};
      if (o.held || /^blocked:/.test(o.reason || '')) { if (!o.backAt) o.backAt = new Date().toISOString(); if (!scannedAt || scannedAt < o.backAt) continue; }
      const h = hold(i, cfg);
      if (h && PAST.test(h) && it.redoAt && (!scannedAt || scannedAt < it.redoAt)) continue;   // the findings check sent it back; that scan's in-UAT label is the one it overrode
      if (h) moves.push({ it, to: holdTo(h), why: holdTo(h) === 'merged' ? h + ' - past coding' : h, held: true });
    } else if (it.status === 'blocked' || it.status === 'merging' || it.status === 'handed') {
      /* a PR that merged after the ticket was queued: it is in UAT, whatever label or wait it was held on. A blocked:* label
         left from the wait is taken off (unlabel), so the board stops calling it blocked */
      const m = prsOf(n).find((x) => wholeMerge(x, n, startOf(it)));
      if (m) { moves.push({ it, to: 'merged', why: 'PR #' + m.number + ' merged - in UAT', unlabel: i.labels.filter((l) => l.startsWith('blocked:')) }); continue; }
      if (it.status === 'merging') {
        const pm = prsOf(n).find((x) => partMerge(x, n, it.partAt || startOf(it)) && x.merged > (it.partAt || ''));   // a part already sent back once is not sent back again
        if (pm && i.state === 'open') { moves.push({ it, to: 'queued', why: 'PR #' + pm.number + ' merged PART of it - remaining: ' + restOf(pm, n), part: true }); continue; }
        if (i.state !== 'open') { moves.push({ it, to: 'closed', why: 'the ticket was closed on GitHub' }); continue; }
        const since = Date.parse(it.mergingSince || (it.outcome && it.outcome.at) || 0);
        const stillOpen = prsOf(n).some((x) => x.state === 'open');
        /* set to merge itself, but a check went red: it will never merge on its own - back to a coder now, not after the wait
           (2026-09-25: coders stopped sitting on CI and hand the wait to GitHub's auto-merge) */
        const red = prsOf(n).find((x) => x.state === 'open' && x.checks === 'fail');
        if (red && scannedAt && it.outcome && it.outcome.at && scannedAt > it.outcome.at) { moves.push({ it, to: 'queued', why: 'PR #' + red.number + ' checks failed - back in the queue to fix them' }); continue; }
        if (!stillOpen || Date.now() - since > MERGING_MAX_MIN * 60000) moves.push({ it, to: 'queued', why: 'left the merge queue without merging - back in the queue' });
        continue;
      }
      /* a scan older than the block cannot say the block was lifted (2026-09-25: #2989 was blocked 14 s after a scan, and the
         next sync read that scan's missing label as "lifted" and sent it back with fresh tries) */
      if (scannedAt && it.outcome && it.outcome.at && scannedAt < it.outcome.at) continue;
      const h = i.state === 'open' ? hold(i, cfg) : null;
      if (i.state !== 'open') moves.push({ it, to: 'closed', why: 'the ticket was closed on GitHub' });
      else if (!h) moves.push({ it, to: 'queued', why: 'the hold was lifted on GitHub - back in the queue', reset: true });
      else if (holdTo(h) === 'merged') moves.push({ it, to: 'merged', why: h + ' - past coding' });
      else if (holdTo(h) !== it.status) moves.push({ it, to: holdTo(h), why: h });   // blocked <-> handed off, as the ticket changes hands
    } else if (it.status === 'merged' && i.state !== 'open') moves.push({ it, to: 'closed', why: 'the ticket was closed on GitHub' });
  }
  const have = new Set(items.filter((it) => LIVE.includes(it.status)).map(numOf).filter(Boolean));
  /* PAST CODING BY ITS LABELS (2026-09-30: #4378's item was deleted after its PR merged at 19:37; the 19:54 sync read a scan
     taken before the merge, saw no merged PR, added the ticket fresh, and a coder spent three tries on finished work). The
     merge puts needs:qa on the ticket and the board a post-merge stage label - either one means there is nothing to code */
  const pastCoding = (i) => (i.labels || []).some((l) => l === 'needs:qa' || /^stage:(in-uat|waiting-for-prod-merge|prod-test|complete)$/.test(l));
  const add = issues.filter((i) => i.state === 'open' && !have.has(i.number) && !hold(i, cfg) && !pastCoding(i) && !prsOf(i.number).some((x) => x.state === 'merged' && !restOf(x, i.number)));
  return { moves, add };
}

/* ---------- GitHub ---------- */
function ghJson(p, args) {
  return new Promise((resolve, reject) => cp.execFile('gh', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 1 << 26, windowsHide: true, env: { ...process.env, ...require('./ghauth').envFor(p), GH_PAGER: '', MSYS_NO_PATHCONV: '1' } },
    (e, out, err) => { if (e) return reject(new Error('gh ' + args.slice(0, 2).join(' ') + ': ' + String(err || e.message).trim().split(/\r?\n/).pop().slice(0, 200))); try { resolve(out.trim() ? JSON.parse(out) : null); } catch (x) { resolve(null); } }));
}
const normIssue = (i, n) => ({ number: n, state: String(i.state).toUpperCase() === 'OPEN' ? 'open' : 'closed', labels: (i.labels || []).map((l) => l.name || l), assignees: (i.assignees || []).map((a) => a.login || a) });
async function fresh(p, repo, n) {
  const i = await ghJson(p, ['issue', 'view', String(n), '-R', repo, '--json', 'number,state,labels,assignees']);
  const raw = await ghJson(p, ['pr', 'list', '-R', repo, '--state', 'all', '--limit', '40', '--search', String(n), '--json', 'number,title,body,state,mergedAt,closingIssuesReferences,statusCheckRollup,author']) || [];
  const prs = raw.filter((x) => !link.isBot(x.author && x.author.login)).map((x) => ({ number: x.number, state: x.state === 'MERGED' ? 'merged' : x.state === 'OPEN' ? 'open' : 'closed', merged: x.mergedAt || null, checks: link.checksOf(x), tickets: link.ticketsOf(x).map((t) => t.number), rest: restMap(link.ticketsOf(x)) })).filter((x) => x.tickets.includes(n));
  /* is an open one in GitHub's merge queue, or set to merge itself when green: that is merging, not stopped */
  const [owner, name] = repo.split('/');
  for (const x of prs.filter((y) => y.state === 'open')) {
    try { const q = await ghJson(p, ['api', 'graphql', '-f', 'query=query{repository(owner:"' + owner + '",name:"' + name + '"){pullRequest(number:' + x.number + '){mergeQueueEntry{state} autoMergeRequest{enabledAt}}}}']); const pr = q && q.data && q.data.repository && q.data.repository.pullRequest; x.inQueue = !!(pr && (pr.mergeQueueEntry || pr.autoMergeRequest)); } catch (e) { x.inQueue = false; }
  }
  return { issue: normIssue(i, n), prs };
}
const made = new Set();   // labels this engine run has made sure exist
async function label(p, repo, n, name, comment, desc) {
  if (!made.has(repo + name)) { try { await ghJson(p, ['label', 'create', name, '-R', repo, '--color', desc ? 'FBCA04' : 'B60205', '--description', desc || 'Cockpit: this ticket cannot move until the reason is cleared', '--force']); } catch (e) { /* it exists, or the edit below says why */ } made.add(repo + name); }
  await ghJson(p, ['issue', 'edit', String(n), '-R', repo, '--add-label', name]);
  if (comment) await ghJson(p, ['issue', 'comment', String(n), '-R', repo, '--body', comment]);
}

/* ---------- what the fleet calls ---------- */
function on(p) { return !!githubOf(p); }
function sync(p, items, add) {
  const g = githubOf(p); if (!g) return null;
  let meta; try { meta = p.db.get("SELECT value FROM gh_meta WHERE key = 'scannedAt'"); } catch (e) { return { skipped: 'no GitHub scan yet' }; }
  if (!meta || Date.now() - Date.parse(meta.value) > 30 * 60000) return { skipped: 'the GitHub scan is older than 30 minutes' };
  const issues = p.db.all('SELECT number, state, labels, assignees FROM gh_issue').map((r) => ({ number: r.number, state: r.state, labels: JSON.parse(r.labels || '[]'), assignees: JSON.parse(r.assignees || '[]') }));
  if (!issues.some((i) => i.state === 'open')) return { skipped: 'the scan holds no open tickets - not trusting it' };   // a failed open-issue fetch must not read as "everything closed"
  const prs = p.db.all('SELECT number, state, merged, checks, tickets FROM gh_pr').map((r) => ({ number: r.number, state: r.state, merged: r.merged, checks: r.checks, tickets: JSON.parse(r.tickets || '[]').map((t) => t.number), rest: restMap(JSON.parse(r.tickets || '[]')) }));
  const mine = items.filter((it) => it.project === p.entry.id);
  mine.forEach((it) => { if (!it.gh) { const n = numOf(it); if (n) it.gh = n; } });
  const r = plan(mine, issues, prs, config(p), meta.value);
  const at = new Date().toISOString();
  for (const m of r.moves) {
    m.it.status = m.to; m.it.outcome = { ...(m.it.outcome || {}), reason: m.why, at, held: !!m.held, backAt: null };
    for (const l of m.unlabel || []) ghJson(p, ['issue', 'edit', String(numOf(m.it)), '-R', g.repo, '--remove-label', l]).catch((e) => console.log('ghqueue → #' + numOf(m.it) + ' ' + l + ' not removed: ' + e.message));
    if (m.to === 'queued') { m.it.claimedBy = null; m.it.claimedAt = null; if (m.reset) { m.it.turns = 0; m.it.lastTry = null; } }
    if (m.part) { m.it.partAt = at; m.it.turns = 0; m.it.lastTry = m.why + '. Carry on from there: the merged part is on main.'; }   // progress, not a failed try
  }
  const cfg = config(p);
  const openRows = new Map(p.db.all('SELECT number, title, body FROM gh_issue WHERE state = ?', 'open').map((r) => [r.number, r]));
  const titles = new Map([...openRows].map(([n, r]) => [n, r.title]));
  for (const i of r.add) add({ project: p.entry.id, gh: i.number, title: '#' + i.number + ': ' + String(titles.get(i.number) || '').replace(/^#\d+:\s*/, ''), text: askFor(i.number, g.repo), priority: prio(i.labels), source: 'github', harness: harnessFor(i.labels, (openRows.get(i.number) || {}).body, cfg) });
  /* a ticket labelled strong after it was queued is pinned from the next sync; one unlabelled is free again */
  const byN = new Map(issues.map((i) => [i.number, i]));
  for (const it of mine) { if (it.status !== 'queued') continue; const i = byN.get(numOf(it)); if (!i) continue; const h = harnessFor(i.labels, (openRows.get(i.number) || {}).body, cfg); if ((it.harness || null) !== h) { if (h) it.harness = h; else delete it.harness; } }
  findingsCheck(p, g, mine, prs, openRows, at);
  /* SENT BACK FROM UAT: the owner's words go on the GitHub ticket as well as into the work order, once */
  for (const it of mine) {
    if (it.source !== 'sent back' || !it.gh || it.commented) continue;
    it.commented = true; const w = SENT.exec(it.text || '');
    if (w) ghJson(p, ['issue', 'comment', String(it.gh), '-R', g.repo, '--body', '**Sent back from UAT** by the owner - back in the coders\' queue:\n\n> ' + w[1].replace(/\n/g, '\n> ')]).catch((e) => console.log('ghqueue → #' + it.gh + ' sent-back comment not written: ' + e.message));
  }
  const late = uatLate(p, issues);
  /* THE STAGE ON THE TICKET: every open ticket's column, from the one rule in ghstatus.js, written onto the
     GitHub ticket as its stage:* label with a one-line comment when it moves; and the "merging" truth check. Runs after the
     moves above, in the background - a slow GitHub never holds up the queue. */
  if (p.entry.id !== 'home') {
    const st = require('./hot').hot(path.join(__dirname, 'ghstatus.js'));
    st.checkMerging(p, items, (num) => fresh(p, g.repo, num)).then((back) => { if (back.length) console.log('ghstatus → ' + p.entry.id + ': not really merging, back in the queue: ' + back.map((x) => '#' + x).join(' ')); }).catch((e) => console.log('ghstatus → merging check failed: ' + e.message));
    st.reconcile(p, items, g, ghJson).then((o) => { if (o.moved && (o.moved.length || o.labelled)) console.log('ghstatus → ' + p.entry.id + ': ' + o.moved.length + ' moved' + (o.moved.length ? ' (' + o.moved.map((m) => '#' + m.n + ' ' + m.to).join(', ') + ')' : '') + ', ' + o.labelled + ' first labels' + (o.left ? ', ' + o.left + ' left for the next pass' : '')); }).catch((e) => console.log('ghstatus → ' + p.entry.id + ' failed: ' + e.message));
  }
  return { added: r.add.map((i) => i.number), moved: r.moves.map((m) => ({ n: numOf(m.it), to: m.to, why: m.why })), late };
}
const SENT = /^SENT BACK by the owner after testing it in UAT: "([\s\S]*?)"\n/;
/* THE FINDINGS CHECK (engine/findings.js). A findings ticket In UAT is judged once per map scan that
   started after its merge: findings left = back to To work with them named; none left = it stays, said once. A findings
   ticket back in To work after a try is judged the same way - a try that cleared them all by accepting them is done. */
function findingsCheck(p, g, mine, prs, openRows, at, gh, opts) {
  gh = gh || ghJson; opts = opts || {};   // a test passes its own gh, and opts.run / opts.holds for the test run and git
  const fx = require('./hot').hot(path.join(__dirname, 'findings.js'));
  for (const it of mine) {
    if (it.status !== 'merged' && !(it.status === 'queued' && it.turns > 0)) continue;
    const n = numOf(it); const row = n && openRows.get(n); if (!row) continue;
    const f = fx.parse(row.body); if (!f) continue;
    let since;
    if (it.status === 'merged') {
      const m = prs.filter((x) => x.tickets.includes(n) && x.state === 'merged' && x.merged && x.merged >= startOf(it)).sort((a, b) => String(a.merged).localeCompare(String(b.merged))).pop();
      if (!m) continue;
      /* a finding from a test run waits for a run of code that holds this merge (findings.evidence) */
      let mc = m.mergeCommit; if (mc === undefined) { try { mc = (p.db.get('SELECT merge_commit FROM gh_pr WHERE number = ?', m.number) || {}).merge_commit || null; } catch (e) { mc = null; } }
      const ev = fx.evidence(f, mc, (opts.run || fx.latestRun)(p), (a, b) => (opts.holds || fx.holds)(p, a, b));
      if (ev.wait) { if (it.findingsWait !== ev.wait) { it.findingsWait = ev.wait; console.log('ghqueue → #' + n + ' findings check waits: ' + ev.wait); } continue; }
      it.findingsWait = null;
      since = ev.at && ev.at > m.merged ? ev.at : m.merged;
    } else since = it.outcome && it.outcome.at;
    const scan = fx.scanAfter(p.db, since); if (!scan || scan.id === it.findingsScan) continue;
    it.findingsScan = scan.id;
    const v = fx.verdict(f, fx.leftOf(f, fx.tagged(p.db, f.rule)));
    const say = (text) => gh(p, ['issue', 'comment', String(n), '-R', g.repo, '--body', text]).catch((e) => console.log('ghqueue → #' + n + ' findings comment not written: ' + e.message));
    if (it.status === 'merged' && !v.done) {
      Object.assign(it, { status: 'queued', claimedBy: null, claimedAt: null, turns: 0, redoAt: at, partAt: at, lastTry: 'The findings check after the merge (map scan ' + scan.id + '): ' + v.note });
      it.outcome = { ...(it.outcome || {}), reason: 'findings still on the map - back to To work', at, held: false, backAt: null };
      let labels = []; try { labels = JSON.parse((p.db.get('SELECT labels FROM gh_issue WHERE number = ?', n) || {}).labels || '[]'); } catch (e) { /* none */ }
      for (const l of labels.filter((x) => /^status:(in-uat|uat)$/.test(x))) gh(p, ['issue', 'edit', String(n), '-R', g.repo, '--remove-label', l]).catch(() => {});
      say('**Back to To work - the findings are still there** (Cockpit, map scan ' + scan.id + ' of main after the merge). ' + v.note);
      console.log('ghqueue → #' + n + ' findings check: back to To work (' + v.note.split(':')[0] + ')');
    } else if (it.status === 'queued' && v.done) {
      Object.assign(it, { status: 'merged', claimedBy: null, claimedAt: null });
      it.outcome = { ...(it.outcome || {}), reason: 'findings check: ' + v.note, at, held: false, backAt: null };
      it.findingsOk = true; say('**Findings cleared** (Cockpit, map scan ' + scan.id + '): ' + v.note + '.');
    } else if (it.status === 'merged' && v.done && !it.findingsOk) {
      it.findingsOk = true; say('**Findings cleared** (Cockpit, map scan ' + scan.id + ' of main after the merge): ' + v.note + '.');
    }
  }
}
/* A UAT DEPLOY THAT DID NOT HAPPEN. A ticket whose PR merged more than UAT_LATE_MIN minutes ago while UAT still reports an
   older commit is blocked:uat-deploy-failed, with a comment saying which merge and which commit UAT is on; once UAT reports
   a commit that holds its merge, the label comes off again with a comment saying so.
   2026-09-26: this was "3 days" - the owner's answer was about his dev PC, and I applied it to UAT. UAT's deploys failed from
   07:10 on two migrations, 27 merged tickets read "In UAT" for five hours while UAT stayed on 06:48's 663a79e. Measured the same day: 36 good UAT deploys, median 13 minutes, longest 22 -
   so 45 minutes behind is a failed deploy, not a slow one.
   Only when UAT's commit is one of the merges read here - otherwise there is no telling what it holds, and nothing is said. */
const UAT_LATE_MIN = 45;
const flagged = new Set(), cleared = new Set();
/* the commit an environment is on, when it is deployed in parts (versionUrls "uat=<api>,uat:web=<web>"): the NEWEST
   of the parts' commits. Each part deploys only when its own files change, so a part that did not change keeps
   reporting an older commit (2026-10-04: #5487 changed only apps/web; UAT's web reported b9ca87f and its API 5a0b8a6,
   and reading the API alone blocked #5482 as "the UAT deploy did not happen"). landings: merged PRs, newest first. */
function envSha(p, env, landings) {
  let rows; try { rows = p.db.all("SELECT version FROM gh_env WHERE (env = ? OR env LIKE ?) AND ok = 1", env, env + ':%'); } catch (e) { return null; }
  const shas = rows.map((r) => { let s = ''; try { s = String(JSON.parse(r.version).sha || ''); } catch (e) { s = String(r.version || ''); } return s.trim().slice(0, 7); }).filter((s) => /^[0-9a-f]{7}$/i.test(s));
  if (!shas.length) return null;
  const idx = (s) => { const i = (landings || []).findIndex((l) => String(l.merge_commit || '').startsWith(s)); return i < 0 ? Infinity : i; };
  return shas.sort((a, b) => idx(a) - idx(b))[0];
}
function uatLate(p, issues) {
  const g = githubOf(p); if (!g) return [];
  const landings = p.db.all("SELECT number, merged, merge_commit, tickets FROM gh_pr WHERE state = 'merged' AND merged IS NOT NULL ORDER BY merged DESC LIMIT 400");
  const sha = envSha(p, 'uat', landings); if (!sha) return [];
  const at = landings.findIndex((l) => String(l.merge_commit || '').startsWith(sha)); if (at < 0) return [];
  const cutoff = Date.now() - UAT_LATE_MIN * 60000, open = new Map(issues.filter((i) => i.state === 'open').map((i) => [i.number, i])), out = [];
  const notThere = new Set();
  for (const l of landings.slice(0, at)) for (const t of JSON.parse(l.tickets || '[]')) notThere.add(t.number);
  for (const l of landings.slice(0, at)) {
    if (Date.parse(l.merged) > cutoff) continue;   // still inside a normal deploy's time
    for (const t of JSON.parse(l.tickets || '[]')) {
      const i = open.get(t.number); if (!i || flagged.has(i.number) || i.labels.includes(BLOCKED.uat) || i.labels.some((x) => PAST.test(x))) continue;
      flagged.add(i.number); cleared.delete(i.number); out.push(i.number);
      label(p, g.repo, i.number, BLOCKED.uat, '**Blocked - not on UAT: the UAT deploy did not happen** (Cockpit). PR #' + l.number + ' merged ' + String(l.merged).replace('T', ' ').slice(0, 16) + ' UTC, more than ' + UAT_LATE_MIN + ' minutes ago, and UAT still reports `' + sha + '`, an older commit. Nothing about this ticket can be tested on UAT until a deploy lands. The label comes off by itself when UAT reports a commit that holds this merge.')
        .catch((e) => { flagged.delete(i.number); console.log('ghqueue → #' + i.number + ' uat label not written: ' + e.message); });
    }
  }
  /* back on UAT: the label comes off */
  for (const i of open.values()) {
    if (!i.labels.includes(BLOCKED.uat) || notThere.has(i.number) || cleared.has(i.number)) continue;
    const deployed = landings.slice(at).some((l) => JSON.parse(l.tickets || '[]').some((t) => t.number === i.number)); if (!deployed) continue;
    cleared.add(i.number); flagged.delete(i.number);
    ghJson(p, ['issue', 'edit', String(i.number), '-R', g.repo, '--remove-label', BLOCKED.uat])
      .then(() => ghJson(p, ['issue', 'comment', String(i.number), '-R', g.repo, '--body', '**On UAT now** (Cockpit): UAT reports `' + sha + '`, which holds this ticket\'s merge. Ready to test there.']))
      .catch((e) => { cleared.delete(i.number); console.log('ghqueue → #' + i.number + ' uat label not removed: ' + e.message); });
  }
  return out;
}
/* where the turn left the ticket, read fresh. Resolves { status: queued|merged|blocked|closed, why } - the fleet sets it */
async function afterTurn(p, it, o) {
  const g = githubOf(p); const n = numOf(it);
  const { issue, prs } = await fresh(p, g.repo, n);
  const c = classify(issue, prs, it.claimedAt || it.added, config(p));
  if (c.status === 'merging') { it.turns = Math.max(0, (it.turns || 1) - 1); it.mergingSince = new Date().toISOString(); return { status: 'merging', why: c.why + ' - not counted as a try' }; }
  if (c.status === 'part') { it.turns = 0; it.partAt = new Date().toISOString(); it.lastTry = c.why + '. Carry on from there: the merged part is on main.'; return { status: 'queued', why: c.why + ' - back to To work for the rest' }; }
  if (c.status !== 'notdone') return c;
  /* A WHOLE MERGE FROM AN EARLIER TRY IS STILL A MERGE (the fix merged on try 1, tries 2 and 3
     found nothing to do, and the ticket was blocked as "retries exhausted - nothing merged"). Only a whole merge counts
     from the item's start; a part merge keeps its own clock (it.partAt), or the same part would send it round forever. */
  if (startOf(it) && it.claimedAt && startOf(it) < it.claimedAt) {
    const earlier = prs.filter((x) => x.tickets.includes(n)).find((x) => wholeMerge(x, n, startOf(it)));
    if (earlier) return { status: 'merged', why: 'PR #' + earlier.number + ' merged on an earlier try - in UAT', pr: earlier.number };
  }
  const tail = String((o && o.text) || '').replace(/\s+/g, ' ').trim().slice(-400);
  it.lastTry = 'Try ' + it.turns + ' ended without a merge: ' + c.why + (tail ? '. It ended saying: "' + tail + '"' : '') + '.';
  if (it.turns < TRIES) return { status: 'queued', why: 'not completed (try ' + it.turns + ' of ' + TRIES + '): ' + c.why };
  await label(p, g.repo, n, BLOCKED.retries, '**Blocked - retries exhausted** (Cockpit). ' + TRIES + ' tries and no merge. The last: ' + it.lastTry + '\n\nRemove the `' + BLOCKED.retries + '` label to send it back to the queue with fresh tries.');
  return { status: 'blocked', why: BLOCKED.retries + ' - ' + c.why };
}
function askFor(n, repo) {
  return 'GitHub issue #' + n + ' in ' + repo + '.\n\nRead it first: gh issue view ' + n + ' --repo ' + repo + '\n\n'
    + 'HOW TO WORK IT\n'
    + '1. git fetch origin, then cut your own branch FROM origin/main and name it for the issue:\n   git checkout -b issue-' + n + ' origin/main\n   Do not work on whatever branch you find checked out, and never commit onto main.\n'
    + '2. Do the work the issue asks for. Run the tests for what you touched, and fix them until they pass.\n'
    + '3. Commit, push your branch, and open a pull request whose body says "Part of #' + n + '"\n   - never a GitHub closing keyword, because merge is UAT, not done.\n'
    + '4. Set it to merge itself when green, then END YOUR TURN - do not wait for CI: gh pr merge <n> --auto. Never --admin, never force.';
}
/* COCKPIT'S CHECKS, BEFORE THE PR: a ticket Cockpit filed or adopted carries its declared files - the
   fence the checks measure the work against - so its coder gets the list and runs `ticket check` before opening the pull
   request. Any other ticket has no list: the file checks are skipped, and the issue is labelled FILES_MISSING so the ones
   still without a list can be found and corrected as they come round. */
const FILES_MISSING = 'files:missing';
const tagged = new Set();
function cockpitTicket(p, n) {
  try { const t = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'tickets', n + '.json'), 'utf8')); const f = { alter: t.alter || [], create: t.create || [], delete: t.delete || [] }; return f.alter.length + f.create.length + f.delete.length ? f : null; } catch (e) { return null; }
}
function checksPart(p, g, n, folder) {
  const f = cockpitTicket(p, n);
  /* in a coder's own folder, Cockpit's checks would read the MAIN folder (verify.js does not yet know coder folders) and
     report false reds - the file list still goes in, the ticket check does not, until the checks follow the coder */
  if (f && folder) return '\n\nTHE FILES THIS TICKET MAY TOUCH (Cockpit\'s ticket ' + n + '):' + ['alter', 'create', 'delete'].filter((k) => f[k].length).map((k) => '\n  ' + k + ': ' + f[k].join(', ')).join('') + '\nTouch only these, or say why a file outside them was needed.';
  if (f) return '\n\nTHE FILES THIS TICKET MAY TOUCH (Cockpit\'s ticket ' + n + '):' + ['alter', 'create', 'delete'].filter((k) => f[k].length).map((k) => '\n  ' + k + ': ' + f[k].join(', ')).join('')
    + '\nBEFORE YOU OPEN THE PULL REQUEST run Cockpit\'s checks: `ticket check ' + n + '`. Put every ✗ right and check again; open the PR only on green, or say plainly what you could not make green.';
  if (!tagged.has(n)) { tagged.add(n); label(p, g.repo, n, FILES_MISSING, null, 'Cockpit: no declared file list - its file checks were skipped; add the list to correct').catch((e) => { tagged.delete(n); console.log('ghqueue → #' + n + ' ' + FILES_MISSING + ' not written: ' + e.message); }); }
  return '\n\nThis ticket has no declared file list, so Cockpit\'s file checks are skipped (it is labelled ' + FILES_MISSING + '). Run the tests for what you touch.';
}
function preamble(p, it, opts) {
  const g = githubOf(p); const n = numOf(it); if (!g || !n) return '';
  const folder = opts && opts.folder;
  /* the coder's own folder and database (engine/workspaces.js) - said, so it never wanders into the project's main folder */
  const own = folder ? '\n\nYOUR OWN FOLDER: you are working in ' + folder + ' - a separate git worktree that is yours alone; the other coders each have their own. Stay in it: never cd into the project\'s main folder or another coder\'s, and never delete, move or change a file outside your own folder - files you did not create this turn are not yours to clean up, even when a check lists them; say so instead (2026-09-25: a coder deleted two of the owner\'s documents from the main folder believing they were its own leftovers). ' + (opts.db ? 'Your test database is ' + opts.db + ' (the project\'s folder recipe already points this folder at it) - never point tests at another coder\'s database or at the shared development database.' : '') + 'Start each ticket from the latest main: git fetch origin, then git checkout -b issue-' + n + ' origin/main (if that branch already exists here, git checkout issue-' + n + ' and rebase it on origin/main).' : '';
  /* MIGRATION NUMBERS ARE ONE SEQUENCE ACROSS EVERY TICKET (2026-09-24: 00345 was taken three times - #2206's leftover, PRs
     #4078 and #4066 - and #4105 reused 00344, which main already had). The ticket claim cannot stop it: they are different tickets. */
  return own + checksPart(p, g, n, folder)
    /* PART OF IT: a merge that did only part of the ticket sends it back to To work - the PR says which */
    + '\n\nSAY WHETHER THE PR FINISHES THE TICKET: put one line in the pull request body - "Remaining: none" if, once it merges, the ticket\'s **Closes when** is true; '
    + 'otherwise "Remaining: <what is still to do>". Be honest: a PR that does step 1 of 3 says so. A "Part of" PR with NO Remaining line counts as unfinished and comes back to you. A merge with work remaining sends the ticket back to To work for the rest '
    + '(if the rest waits on the owner or someone else, ALSO add the matching blocked:* label and say what it waits on).'
    + '\n\nIF YOU CREATE A DATABASE MIGRATION: other coders are working other tickets at the same time and number theirs from the same sequence. '
    + 'Number yours ONE ABOVE the highest number on origin/main AND in every open pull request (gh pr list --repo ' + g.repo + ' --state open, then look at each one\'s migration files) - never from main alone. '
    + 'If CI later fails on a duplicate number, renumber yours to the next free one.'
    /* DO NOT WAIT FOR CI: 14 of 20 turns were stopped by the silence watchdog while their coder sat on
       "gh pr checks --watch" - each stop burned a try and the ticket came round again only to wait again. GitHub's auto-merge
       does the waiting; the queue already reads a PR set to merge itself as merging, and sends it back if a check fails.
       This overrides the older "when CI is green, merge it yourself" line still in queued tickets' text. */
    + '\n\nHOW TO FINISH (this replaces any "wait for CI / when CI is green, merge it" instruction above): after you push and open the pull request, '
    + 'run the checks you can locally, then set the PR to merge itself when its checks pass: gh pr merge <PR number> --auto '
    + '(if it asks for a method, add --squash). It answers that the PR will merge automatically, or that it was added to the merge queue (it goes straight into the queue when checks are already green). '
    + 'To read it back: gh pr view <PR number> --json autoMergeRequest (set while waiting on checks), or gh api graphql -f query=\'query{repository(owner:"' + g.repo.split('/')[0] + '",name:"' + g.repo.split('/')[1] + '"){pullRequest(number:<PR number>){mergeQueueEntry{state}}}}\' (set once queued). '
    + 'Then END YOUR TURN. Do NOT run gh pr checks --watch, do not poll, do not sleep waiting for CI: a turn that sits silent is stopped and counts as a failed try. '
    + 'If a check fails later, the ticket comes back to a coder with the PR still open - fix that PR then, do not open another.'
    /* 2026-09-26: five tickets were closed by hand the morning their code merged, while every UAT deploy was failing - closed
       with nothing on UAT. A ticket closes when a person has confirmed it, never when a coder is done. */
    + '\n\nNEVER CLOSE THE GITHUB ISSUE. Merged is not done: the code still has to reach UAT and be tested by a person. The issue is closed by the owner, or by the process after that test - not by you, whatever the ticket says.'
    + '\n\nWHERE THIS TICKET GOES NEXT is read from GitHub when your turn ends - not from what you say. A merged PR that names #' + n + ' moves it to UAT; one set to merge itself waits as merging. '
    + 'Anything else puts it back in the queue (this is try ' + it.turns + ' of ' + TRIES + ').\n'
    + 'IF SOMETHING OUTSIDE THIS TICKET STOPS YOU - a decision only the owner can make, something only another person can do, or the environment (a database, Docker, a service) - '
    + 'add ONE label and a comment saying exactly what is needed, then stop:\n'
    + '   gh issue edit ' + n + ' --repo ' + g.repo + ' --add-label ' + config(p).blockedLabels.owner + '   (or ' + config(p).blockedLabels.other + ', or ' + BLOCKED.environment + ')'
    /* 2026-09-26: #4127 was owned by #4309, and the queue handed it back four times - a coder had no way to say so */
    + '\nIF ANOTHER OPEN TICKET ALREADY OWNS THIS WORK: add the label blocked:by-ticket and a comment "Blocked by #<that ticket>", then stop - the queue will not hand it back, and it waits for that ticket.'
    + (it.lastTry ? '\n\nTHE LAST TRY: ' + it.lastTry + '\nStart from there. If a PR for this ticket is already open, finish that PR - do not open another.' : '');
}

module.exports = { TRIES, BLOCKED, DEFAULTS, on, sync, afterTurn, preamble, askFor, numOf, hold, classify, plan, config, harnessFor, startOf, findingsCheck, envSha };
