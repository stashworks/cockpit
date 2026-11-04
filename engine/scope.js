'use strict';
/* WHO MAY CHANGE WHAT.

   Checked that night: nothing stopped it. Any AI turn could change or delete any project's queue items and tickets through
   the engine, and "Home runs every project" was a line in its instructions. Now:

   - Every AI turn is handed a key for ITS project (COCKPIT_KEY in its environment; cli.js sends it as x-cockpit-key).
     Keys live in this engine run's memory only - never on disk - so one project's AI cannot read another's.
   - Home's key, and the owner's own browser, may change any project.
   - A request that changes something and carries neither a key nor the browser's same-origin mark is refused. That is what
     turns a raw `curl` from inside a turn into a refusal instead of a silent cross-project change.
   - An AI may remove at most BULK_MAX things (queue items deleted, tickets closed or rejected) in BULK_WINDOW_MIN minutes;
     past that it is refused and the owner is alerted - a mass delete is his to do, on screen.

   What this is and is not: it stops a project's AI changing another project BY MISTAKE, which is the risk the owner named.
   It is not a wall against an AI set on getting round it - the turns run as the owner's Windows user, and the only real wall
   is running them as their own user with locked folders (offered 2026-09-25; the owner chose not to, for now). */
const crypto = require('node:crypto');
const HOME = 'home';
const BULK_MAX = 5, BULK_WINDOW_MIN = 10;
const keys = new Map(), byProject = new Map();
function keyFor(projectId) {
  let k = byProject.get(projectId);
  if (!k) { k = crypto.randomBytes(24).toString('hex'); byProject.set(projectId, k); keys.set(k, projectId); }
  return k;
}
/* who is asking. owner = the owner's browser (a same-origin fetch from Cockpit's own page); ai = a turn, with its project */
function caller(req) {
  const k = req.headers['x-cockpit-key'];
  if (k) { const p = keys.get(String(k)); return p ? { who: 'ai', project: p, all: p === HOME } : { who: 'unknown', why: 'a key this engine did not issue (from before a restart?)' }; }
  if (String(req.headers['sec-fetch-site'] || '') === 'same-origin') return { who: 'owner', all: true };
  return { who: 'unknown', why: 'no project key' };
}
/* may this caller change project `projectId`? '*' = something that is not one project's (coders, the project list, settings) */
function allows(c, projectId) {
  if (!c || c.who === 'unknown') return false;
  if (c.all) return true;
  return projectId !== '*' && c.project === projectId;
}
const removals = new Map();   // caller project -> [times]
function bulkOk(c) {
  if (!c || c.who === 'owner') return true;
  const k = c.project || '?', now = Date.now(), list = (removals.get(k) || []).filter((t) => now - t < BULK_WINDOW_MIN * 60000);
  if (list.length >= BULK_MAX) { removals.set(k, list); return false; }
  list.push(now); removals.set(k, list); return true;
}
function refusal(c, projectId, what) {
  if (!c || c.who === 'unknown') return 'refused: ' + (c && c.why ? c.why : 'no project key') + '. Changes to Cockpit are made by the owner on screen, or by an AI turn with its project key (COCKPIT_KEY, which cli.js sends).';
  return 'refused: this conversation belongs to ' + c.project + ' and may not change ' + (projectId === '*' ? 'anything outside its own project (coders, the project list, engine settings)' : 'project ' + projectId) + (what ? ' (' + what + ')' : '') + '. Only Home and the owner may.';
}
module.exports = { HOME, BULK_MAX, BULK_WINDOW_MIN, keyFor, caller, allows, bulkOk, refusal };
