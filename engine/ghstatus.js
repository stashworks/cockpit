/* THE TICKET'S STAGE, WRITTEN ON THE TICKET, so anyone reading GitHub sees where it stands.

   Before this, a ticket's column was never stored anywhere: the board worked it out in the browser from six sources and the
   queue worked it out again in ghqueue.js, and every disagreement was a bug (a stuck "merging", merged-means-done, wrong
   counts). Now there is ONE rule - column() below - and its answer is written onto the GitHub ticket as exactly one
   stage:* label, with a one-line comment saying what moved it. The board reads the label (plugins/tickets/cards/board.js).

     column(t)            the pure rule: which column a ticket is in, from GitHub, the queue item and what UAT/prod run
     reconcile(p, items)  every sync (2 min): compute each open ticket's column, and where its stage:* label differs, swap
                          the label and comment - at most WRITES_PER_PASS a pass, so the first run labels the backlog over a
                          few passes without flooding GitHub. It is also the truth check: the label is always re-derived from
                          reality, so a wrong one is corrected and logged, never trusted.
     checkMerging(p, it)  a "merging" item really set to merge? (2026-09-26: #4468 sat in "merging" for hours with auto-merge
                          never set) - read fresh; if nothing is queued to merge, back to the queue.

   The person's steps stay the person's: status:verified (passed UAT) and status:live (on prod, checking) are read, never
   written. A closed ticket has no stage label. Tested in test/gh-status.js. Hot-loaded (ghqueue.sync calls it). */
'use strict';
const path = require('node:path');

const STAGE = {
  open: 'stage:open', towork: 'stage:to-work', coding: 'stage:being-coded', tests: 'stage:running-tests', uat: 'stage:in-uat',
  prodmerge: 'stage:waiting-for-prod-merge', prodtest: 'stage:prod-test', notdone: 'stage:not-completed', blocked: 'stage:blocked',
  waiting: 'stage:waiting-on-a-ticket', others: 'stage:assigned-to-others'
};
const TITLE = {
  open: 'Open', towork: 'To work', coding: 'Being coded', tests: 'Running tests', uat: 'In UAT', prodmerge: 'Waiting for prod merge',
  prodtest: 'Prod test', notdone: 'Not completed', blocked: 'Blocked', waiting: 'Waiting on a ticket', others: 'Assigned to others'
};
const WHAT = {
  open: 'on GitHub, not in the coders\' queue', towork: 'in the coders\' queue', coding: 'a coder is working it', tests: 'its pull request is open and its checks are running',
  uat: 'merged and on UAT - ready to test there', prodmerge: 'passed in UAT, waiting to be promoted', prodtest: 'on production - check it there',
  notdone: 'a try ended without a merge; it goes again', blocked: 'cannot move until the reason is cleared',
  waiting: 'yours, held until the ticket it needs is done', others: 'on someone else\'s plate'
};
const COL_OF = Object.fromEntries(Object.entries(STAGE).map(([k, v]) => [v, k]));
const WRITES_PER_PASS = 40;
const DRY = false;   // true = compute and log the moves to cache/stage-dryrun.json without writing labels (used to check the rule against a live board first)
/* waiting on another person (not the owner): the ticket shows under Assigned to others. Configurable per project
   (.cockpit/plugins/github.queue.json blockedLabels.other, read in snapshot) */
const OTHER_LABEL = 'blocked:waiting-on-someone-else';

/* ---------- the rule (pure) ----------
   t = { issue: {number, state, labels, assignees}, item (the ticket's latest queue item or null), prs (its PRs:
   {number, state, merged, updated, checks, rest}), uatMissing (merged but UAT's version does not hold it), prodKnown,
   prodMissing, you (the owner's login) }. The same order of rules the board used (board.js ghCol, 2026-09-26), now in one place. */
function column(t) {
  const { issue, item: it, prs = [], you = '' } = t;
  if (issue.state !== 'open') return null;
  const labels = issue.labels || [];
  const blocks = labels.filter((l) => /^blocked:/.test(l) || l === 'needs:decision'), blockedBy = blocks[0];
  const n = issue.number, whole = (x) => x.state === 'merged' && !(x.rest && x.rest[n]);
  const mergedWhole = prs.some(whole);
  const others = (issue.assignees || []).filter((a) => a && a !== you);
  if (it && it.status === 'merging') return 'tests';
  if (it && it.status === 'running') { const open = prs.find((x) => x.state === 'open'); return open && open.updated && it.claimedAt && open.updated > it.claimedAt ? 'tests' : 'coding'; }
  const uatOnly = blockedBy === 'blocked:uat-deploy-failed' && blocks.length === 1;
  if (uatOnly && !(it && it.status === 'queued')) return 'tests';
  const past = labels.includes('status:live') || labels.includes('status:verified') || ((mergedWhole || (it && it.status === 'merged')) && !t.uatMissing);
  /* WAITING ON A TICKET IS NOT SOMEONE ELSE'S (2026-10-31): blocked:by-ticket used to land in Assigned to others, so the
     owner's own held tickets read as another person's and nobody worked them. A ticket of yours held on another ticket has its
     own column; Assigned to others is only another person's ticket or one labelled as waiting on someone else. */
  if (!others.length && labels.includes('blocked:by-ticket') && !labels.includes(t.otherLabel || OTHER_LABEL) && !past) return 'waiting';
  if ((others.length || labels.includes(t.otherLabel || OTHER_LABEL) || labels.includes('blocked:by-ticket')) && !past) return 'others';
  if (blockedBy && !uatOnly) return 'blocked';
  if (labels.includes('status:live')) return 'prodtest';
  if (labels.includes('status:verified')) return mergedWhole && t.prodKnown && !t.prodMissing ? 'prodtest' : 'prodmerge';
  if (it && it.status === 'queued') return it.turns > 0 && !it.agent ? 'notdone' : 'towork';
  if (mergedWhole || (it && it.status === 'merged')) return t.uatMissing ? 'tests' : 'uat';
  if (it && (it.status === 'blocked' || it.status === 'parked')) return 'blocked';
  if (others.length) return 'others';
  return 'open';
}
/* the one line that goes on the ticket when it moves - what moved it, in plain words */
function note(col, t) {
  const it = t.item, prs = t.prs || [], n = t.issue.number, labels = t.issue.labels || [];
  const open = prs.find((x) => x.state === 'open'), merged = prs.filter((x) => x.state === 'merged').sort((a, b) => String(b.merged).localeCompare(String(a.merged)))[0];
  const why = it && it.outcome && it.outcome.reason ? String(it.outcome.reason).slice(0, 240) : '';
  switch (col) {
    case 'coding': return 'Being coded by ' + (it && it.claimedBy || 'a coder') + (it && it.turns ? ' · try ' + it.turns + ' of 3' : '') + '.';
    case 'tests': return it && it.status === 'merging' ? 'PR #' + (open ? open.number : '?') + ' is green and set to merge itself.' : t.uatMissing && merged ? 'PR #' + merged.number + ' merged; waiting for UAT to update.' : open ? 'PR #' + open.number + ' open; checks ' + (open.checks || 'running') + '.' : 'Waiting on the UAT update.';
    case 'uat': return (merged ? 'PR #' + merged.number + ' merged' : 'Merged') + ' and on UAT - ready to test there.';
    case 'towork': return 'In the coders\' queue' + (it && it.agent ? ' for ' + it.agent : '') + (merged && merged.rest && merged.rest[n] ? ' - PR #' + merged.number + ' did part of it; remaining: ' + merged.rest[n] : why && /PART of it/.test(why) ? ' - ' + why : '') + '.';
    case 'notdone': return 'Not completed' + (why ? ': ' + why : '') + ' - it goes again.';
    case 'blocked': return 'Blocked: ' + (labels.find((l) => /^blocked:/.test(l) || l === 'needs:decision') || why || 'see the last comment') + '.';
    case 'prodmerge': return 'Passed in UAT; waiting to be promoted to production.';
    case 'prodtest': return 'On production - check it there.';
    case 'waiting': return 'Waiting on another ticket - the last comment names which.';
    case 'others': return 'Assigned to ' + ((t.issue.assignees || []).filter((a) => a !== t.you).join(', ') || 'someone else') + '.';
    default: return WHAT[col] ? WHAT[col][0].toUpperCase() + WHAT[col].slice(1) + '.' : '';
  }
}

/* ---------- reading the project (the scan's tables and the queue) ---------- */
function envSha(p, env, landings) {
  const q = require('./ghqueue'); if (typeof q.envSha === 'function') return q.envSha(p, env, landings);   // the newest of the deployed parts (ghqueue.js, 2026-10-04)
  let row; try { row = p.db.get("SELECT version FROM gh_env WHERE env = ? AND ok = 1 ORDER BY at DESC LIMIT 1", env); } catch (e) { return null; }
  if (!row) return null; let s = ''; try { s = String(JSON.parse(row.version).sha || ''); } catch (e) { s = String(row.version || ''); }
  return s.trim().slice(0, 7) || null;
}
/* tickets merged after the version an environment reports (landings newest first; above its own commit = not there yet) */
function undeployed(p, env, landings) {
  const sha = envSha(p, env, landings), out = new Set(); if (!sha || !landings.length) return { known: !!sha, set: out };
  for (const l of landings) { if (String(l.merge_commit || '').startsWith(sha)) break; for (const t of JSON.parse(l.tickets || '[]')) out.add(t.number); }
  return { known: true, set: out };
}
function snapshot(p, items) {
  const issues = p.db.all("SELECT number, state, labels, assignees FROM gh_issue WHERE state = 'open'").map((r) => ({ number: r.number, state: r.state, labels: JSON.parse(r.labels || '[]'), assignees: JSON.parse(r.assignees || '[]') }));
  const prs = p.db.all('SELECT number, state, merged, updated, checks, tickets FROM gh_pr').map((r) => { const tk = JSON.parse(r.tickets || '[]'); const rest = {}; tk.forEach((x) => { if (x.remaining) rest[x.number] = x.remaining; }); return { number: r.number, state: r.state, merged: r.merged, updated: r.updated, checks: r.checks, tickets: tk.map((x) => x.number), rest }; });
  const landings = p.db.all("SELECT number, merged, merge_commit, tickets FROM gh_pr WHERE state = 'merged' AND merged IS NOT NULL ORDER BY merged DESC LIMIT 400");
  const uat = undeployed(p, 'uat', landings), prod = undeployed(p, 'prod', landings);
  let you = ''; try { const m = p.db.get("SELECT value FROM gh_meta WHERE key = 'you'"); you = m ? m.value : ''; } catch (e) { /* */ }
  const numOf = require('./ghqueue').numOf;
  let otherLabel; try { otherLabel = require('./ghqueue').config(p).blockedLabels.other; } catch (e) { /* the default */ }
  const latest = new Map(); for (const it of items) { if (it.project !== p.entry.id) continue; const n = numOf(it); if (!n) continue; const cur = latest.get(n); if (!cur || it.id > cur.id) latest.set(n, it); }
  const byTicket = new Map(); for (const x of prs) for (const n of x.tickets) (byTicket.get(n) || byTicket.set(n, []).get(n)).push(x);
  return issues.map((issue) => ({ issue, item: latest.get(issue.number) || null, prs: byTicket.get(issue.number) || [], uatMissing: uat.set.has(issue.number), prodKnown: prod.known, prodMissing: prod.set.has(issue.number), you, otherLabel }));
}

/* ---------- writing it ---------- */
const made = new Set();
let busy = false;
async function reconcile(p, items, g, gh) {
  if (busy) return { skipped: 'the last pass is still writing' };
  const rows = snapshot(p, items), out = { checked: rows.length, moved: [], labelled: 0, left: 0 };
  const todo = [];
  for (const t of rows) {
    const col = column(t); if (!col) continue;
    const want = STAGE[col], have = t.issue.labels.filter((l) => /^stage:/.test(l));
    if (have.length === 1 && have[0] === want) continue;
    todo.push({ t, col, want, have });
  }
  out.left = Math.max(0, todo.length - WRITES_PER_PASS);
  /* DRY RUN until the owner's desk has checked the plan against the board: write what it WOULD do, touch nothing */
  if (DRY) {
    const counts = {}; rows.forEach((t) => { const c = column(t); if (c) counts[c] = (counts[c] || 0) + 1; });
    try { require('node:fs').writeFileSync(path.join(p.cockpit.dir, 'cache', 'stage-dryrun.json'), JSON.stringify({ at: new Date().toISOString(), counts, todo: todo.map((w) => ({ n: w.t.issue.number, col: w.col, have: w.have, item: w.t.item ? { id: w.t.item.id, status: w.t.item.status, agent: w.t.item.agent, turns: w.t.item.turns } : null, note: note(w.col, w.t) })) }, null, 1)); } catch (e) { console.log('ghstatus dry run not written: ' + e.message); }
    return { ...out, dry: true };
  }
  if (!todo.length) return out;
  busy = true;
  try {
    for (const w of todo.slice(0, WRITES_PER_PASS)) {
      const n = w.t.issue.number;
      try {
        if (!made.has(g.repo + w.want)) { try { await gh(p, ['label', 'create', w.want, '-R', g.repo, '--color', '5319E7', '--description', 'Cockpit stage: ' + TITLE[w.col] + ' - ' + WHAT[w.col], '--force']); } catch (e) { /* exists */ } made.add(g.repo + w.want); }
        const args = ['issue', 'edit', String(n), '-R', g.repo, '--add-label', w.want]; for (const l of w.have) if (l !== w.want) args.push('--remove-label', l);
        await gh(p, args);
        const labels = w.t.issue.labels.filter((l) => !/^stage:/.test(l)).concat([w.want]);
        try { p.db.run('UPDATE gh_issue SET labels = ? WHERE number = ?', JSON.stringify(labels), n); } catch (e) { /* the next scan has it */ }
        /* a first label on a ticket (the backlog, the day this started) is not a move - no comment; every later change is */
        if (w.have.length) {
          const from = w.have.map((l) => TITLE[COL_OF[l]] || l).join(', ');
          await gh(p, ['issue', 'comment', String(n), '-R', g.repo, '--body', '**' + TITLE[w.col] + '** (was ' + from + ') - ' + note(w.col, w.t)]);
          out.moved.push({ n, from, to: TITLE[w.col] });
        } else out.labelled++;
      } catch (e) { console.log('ghstatus → #' + n + ' not written: ' + e.message); }
    }
  } finally { busy = false; }
  return out;
}
/* the truth check for "merging": an item that says it is merging must have a PR GitHub will actually merge */
const MERGING_CHECK_MIN = 15;
async function checkMerging(p, items, fresh) {
  const numOf = require('./ghqueue').numOf, moved = [];
  const stale = items.filter((it) => it.project === p.entry.id && it.status === 'merging' && Date.now() - Date.parse(it.mergingSince || (it.outcome && it.outcome.at) || 0) > MERGING_CHECK_MIN * 60000 && (!it.mergeCheckedAt || Date.now() - Date.parse(it.mergeCheckedAt) > MERGING_CHECK_MIN * 60000)).slice(0, 3);
  for (const it of stale) {
    it.mergeCheckedAt = new Date().toISOString();
    try {
      const { prs } = await fresh(numOf(it));
      if (prs.some((x) => x.state === 'merged')) continue;   // the sync moves it
      if (prs.some((x) => x.state === 'open' && x.inQueue)) continue;   // really queued to merge
      it.status = 'queued'; it.claimedBy = null; it.claimedAt = null;
      it.outcome = { ...(it.outcome || {}), reason: 'it said "merging" but no pull request is set to merge - back in the queue to finish it', at: new Date().toISOString() };
      moved.push(numOf(it));
    } catch (e) { /* GitHub unreadable: try again next time */ }
  }
  return moved;
}

module.exports = { STAGE, TITLE, COL_OF, column, note, snapshot, reconcile, checkMerging, WRITES_PER_PASS };
