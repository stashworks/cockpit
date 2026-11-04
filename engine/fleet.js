/* The fleet - the owner's agents, working ONE queue across every project (docs/generic-ide.md
   §14): any project can use the agents, its work assigned into the one queue and prioritised
   against everything else.

   State is one engine-level file, fleet.json, beside projects.json: agents and items. It is
   global by design - a queue across projects cannot live inside any one project's .cockpit.

   AGENT   { id, harness, model, label, on, paused, projects: null|[ids], every: minutes, parallel: n }
           on=false: takes nothing (the standing order - the fleet ships OFF). paused: finishes
           what it is on, then takes nothing more; the engine stays up, conversations unaffected.
           parallel: how many items it works at once (one knob, default 1; a
           frontier tool can run several, the local one is fixed at 1 - one GPU).
   ITEM    { id, project, ticket, agent, title, text, priority: next|P1|P2|P3, status: queued|running|
             done|failed|parked, source, added, claimedBy, claimedAt, turns, outcome, order }
           ticket: the Cockpit ticket it works (the board's Work it puts it here); agent: null =
           first available, or one agent's id (the owner assigns).
   RULE    two agents may work one project when their tickets touch different files (the declared lists); overlapping
           files, or an item with no ticket, wait - the old one-at-a-time rule (2026-09-20).
   ORDER   priority tier first (next, P1, P2, P3), then `order` within the tier (drag), then age.
   CLAIM   claimedBy + claimedAt; a claim older than CLAIM_MAX_MIN with no running turn is dead
           and the item is free again - the same rule as the coder lanes' expire-claims.
   TICK    every agent, on its own interval: if on and not paused and not mid-turn, take the top
           free item it may take, claim it, run a turn in that item's project with the item as
           the ask (the project's own prompt tiers apply), record the outcome on the item. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let FILE = null, ROOT = null;
let S = { agents: [], items: [], nextId: 1 };
const CLAIM_MAX_MIN = 150;      // longer than a coder's turn, so a live turn's claim is never read as dead
const FLEET_TURN_MIN = 120;     // a coder's turn, before the ceiling stops it
const inTurn = {};   // agentId -> [turnId, …] while turns run (up to the agent's parallel)
const running = (a) => inTurn[a.id] || [];

function load(engineRoot) {
  ROOT = engineRoot; FILE = path.join(engineRoot, 'fleet.json');
  try { S = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { S = { agents: [], items: [], nextId: 1 }; }
  S.agents = S.agents || []; S.items = S.items || []; S.nextId = S.nextId || 1;
  seedAgents();
  /* the engine just started: no turn is running, so an item still marked running was cut off by the restart - back on the
     queue, claim cleared, the try not counted (2026-09-20: L7 sat "running" for a phantom turn and held the whole project's queue) */
  for (const it of S.items) if (it.status === 'running') { it.status = 'queued'; it.claimedBy = null; it.claimedAt = null; it.outcome = { reason: 'cut off by an engine restart - queued again', at: new Date().toISOString() }; }
  save();
  setInterval(tickAll, 30 * 1000).unref();
  // the plan reading for harnesses that answer on demand: once soon after start, then every 10 min
  setTimeout(() => probeUsage().catch(() => {}), 8000).unref();
  setInterval(() => probeUsage().catch(() => {}), 10 * 60 * 1000).unref();
  // a coder installed (or removed) while the engine runs shows up (or goes) within 10 minutes, no restart needed
  setInterval(() => { try { if (seedAgents()) save(); } catch (e) { /* next check */ } }, 10 * 60 * 1000).unref();
}
function save() { fs.writeFileSync(FILE, JSON.stringify(S, null, 2) + '\n'); }

/* One agent per harness INSTALLED on this machine, OFF, named after the harness. The owner turns them on. A harness
   installed later appears on the next check (every 10 min, and at start) without deleting what he set. A built-in
   slot whose harness is not installed is dropped while it is off - a fresh PC with only Claude Code shows only Claude
   Code, not Codex and Pi slots it can never use (2026-10-08). A slot that is on is kept, so its card says what's wrong. */
function seedAgents() {
  const harness = require('./harness');
  const defaults = { 'claude-code': 'opus', 'codex-cli': 'default', pi: null };
  const all = harness.list();
  const installed = new Set(all.filter((h) => h.ok).map((h) => h.name));
  const before = S.agents.length;
  S.agents = S.agents.filter((a) => !(a.id === a.harness && !a.on && !installed.has(a.harness) && !running(a).length));
  let changed = S.agents.length !== before;
  for (const h of all) {
    if (!h.ok || S.agents.some((a) => a.harness === h.name)) continue;
    const model = defaults[h.name] || (h.models[0] && h.models[0].id) || null;
    S.agents.push({ id: h.name, harness: h.name, model, label: h.label, on: false, paused: false, projects: null, every: 5, parallel: 1 });
    changed = true;
  }
  return changed;
}

function state() {
  const harness = require('./harness');
  const busy = harness.busy();
  return {
    agents: S.agents.map((a) => { const t = running(a)[0]; const b = busy.find((x) => x.turn === t); const rs = running(a).map((tid) => busy.find((x) => x.turn === tid)).filter(Boolean).map((x) => ({ turn: x.turn, project: x.project, since: x.since })); return { ...a, canProbeUsage: harness.canProbeUsage ? harness.canProbeUsage(a.harness) : false, login: loginState(a), runnings: rs, exclusive: !!harness.EXCLUSIVE[a.harness], running: b ? { turn: b.turn, project: b.project, since: b.since } : null }; }),
    items: sorted(S.items),
    claimMaxMin: CLAIM_MAX_MIN,
    pausedAll: S.agents.length > 0 && S.agents.every((a) => a.paused || !a.on)
  };
}
const TIER = { next: 0, P1: 1, P2: 2, P3: 3 };
function sorted(items) { return items.slice().sort((a, b) => (TIER[a.priority] ?? 3) - (TIER[b.priority] ?? 3) || (a.order || 0) - (b.order || 0) || String(a.added).localeCompare(String(b.added))); }

/* ---------- agents ---------- */
function setAgent(id, patch) {
  const a = S.agents.find((x) => x.id === id); if (!a) return null;
  ['on', 'paused', 'projects', 'model', 'every', 'label'].forEach((k) => { if (patch[k] !== undefined) a[k] = patch[k]; });
  if (patch.on !== undefined && patch.paused === undefined) a.paused = false;   // switching on or off clears a pause: on means working
  if (patch.parallel !== undefined) { const h = require('./harness'); a.parallel = h.EXCLUSIVE[a.harness] ? 1 : Math.max(1, Math.min(4, Number(patch.parallel) || 1)); }
  if (patch.on !== undefined || patch.paused !== undefined) a.changedAt = new Date().toISOString();   // "since when" on the card
  /* USAGE LEFT is a property of the agent's plan, not of any project, so it lives here (owner,
     2026-09-16: "usage left should be global ... next to the agent"). A reading is what the
     plan's own usage page says, entered by hand until a harness can report it; readAt is
     stamped so the card can show its age - a 60% from this morning is not the current 60%.
     null clears it. A local model has no plan and never carries one. */
  if (patch.floor !== undefined) a.floor = patch.floor === null ? null : Math.max(0, Math.min(100, Number(patch.floor) || 0));   // the usage floor: hold at this much of the plan left (default 25 = the owner's 75%-used rule)
  if (patch.floorShort !== undefined) a.floorShort = patch.floorShort === null ? null : Math.max(0, Math.min(100, Number(patch.floorShort) || 0));   // the floor for the short (5-hour) window; unset = the same as floor
  if (patch.usage !== undefined) {
    const u = patch.usage;
    a.usage = (u && typeof u.leftPct === 'number') ? { leftPct: Math.max(0, Math.min(100, Math.round(u.leftPct))), resets: String(u.resets || '').slice(0, 40), readAt: new Date().toISOString(), source: u.source || 'manual' } : null;
  }
  save(); return a;
}
/* A reading from the harness itself: windows = [{ name, usedPct, resetsAt, locked }]. The
   tightest window becomes the pill's number (100 - used); every window rides along for the
   hover. The plan's own reading replaces a hand-entered one - it is the newer truth. */
function usageFromHarness(id, u) {
  const a = S.agents.find((x) => x.id === id); if (!a) return null;
  const wins = (u.windows || []).filter((w) => w && typeof w.usedPct === 'number');
  if (!wins.length) return a;
  const tight = wins.reduce((m, w) => (w.usedPct > m.usedPct ? w : m));
  a.usage = { leftPct: Math.max(0, Math.min(100, 100 - Math.round(tight.usedPct))), resets: '', resetsAt: tight.resetsAt || null, window: tight.name || null, locked: wins.find((w) => w.locked) ? wins.find((w) => w.locked).locked : null,
    windows: wins, readAt: new Date().toISOString(), source: 'harness', plan: u.plan || null };
  save(); return a;
}
/* ask every harness that can answer on demand (Codex's app-server); Claude's arrives with each turn */
let probing = false;
async function probeUsage(only) {
  if (probing) return null; probing = true;
  try { return await require('./harness').probeUsage(only); } finally { probing = false; }
}
/* ---------- adding coders ----------
   A coder is an agent: an id, a harness, a model. Several may share a harness. A harness that keeps its login in a folder
   (its configEnv - Claude's CLAUDE_CONFIG_DIR) gives each added coder its OWN folder, <engine>\accounts\<id>, so each
   runs on its own account: logged in there once, by the owner, as the user the engine runs as. The folder holds a login
   token: it is kept out of git, Cockpit's backups and scans (.gitignore, backup.js, scan.js, sast.js). The seeded coder
   (id = harness name) keeps the machine's own login. A new coder starts OFF, with the 25% floor like the others. */
const ACCOUNTS = () => path.join(ROOT, 'accounts');
function loginState(a) {
  if (a.harness !== 'claude-code') return null;   // only Claude keeps a login per folder today
  try {
    const dir = a.env && a.env.CLAUDE_CONFIG_DIR;
    const cc = require(path.join(__dirname, 'harnesses', 'claude-code.js'));
    const l = cc.loginOf ? cc.loginOf(dir || null) : null;
    return l ? { dir: dir || "(this machine's own Claude login)", ok: l.ok, plan: l.plan || null, expired: !!l.expired, why: l.why || null } : null;
  } catch (e) { return null; }
}
function addAgent(input) {
  const id = String(input.id || '').trim().toLowerCase(), harnessName = String(input.harness || '').trim();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) return { ok: false, error: "a coder's name is lower-case letters, digits and dashes, 2-31 long (e.g. claude-2)" };
  if (S.agents.some((a) => a.id === id)) return { ok: false, error: 'there is already a coder called ' + id };
  const h = require('./harness'), kinds = h.list();
  const kind = kinds.find((k) => k.name === harnessName); if (!kind) return { ok: false, error: 'no such kind of coder: ' + harnessName + ' (have: ' + kinds.map((k) => k.name).join(', ') + ')' };
  const a = { id, harness: harnessName, model: (S.agents.find((x) => x.harness === harnessName) || {}).model || (kind.models[0] && kind.models[0].id) || null, label: String(input.label || '').trim() || id, on: false, paused: false, projects: null, every: 5, parallel: 1, added: new Date().toISOString() };
  if (harnessName === 'claude-code') { const dir = path.join(ACCOUNTS(), id); fs.mkdirSync(dir, { recursive: true }); a.env = { CLAUDE_CONFIG_DIR: dir }; }
  S.agents.push(a); save();
  return { ok: true, agent: a };
}
/* only a coder that was ADDED (not a seeded one), and only when it is not working; its login folder is left on disk -
   deleting an account's login is the owner's act, not the engine's */
function removeAgent(id) {
  const a = S.agents.find((x) => x.id === id); if (!a) return { ok: false, error: 'no coder ' + id };
  if (a.id === a.harness) return { ok: false, error: id + ' is the built-in ' + a.harness + ' coder - switch it off instead' };
  if (running(a).length) return { ok: false, error: id + ' is working - pause it and let it finish first' };
  S.agents = S.agents.filter((x) => x !== a);
  S.items.forEach((it) => { if (it.agent === id) it.agent = null; });
  save();
  return { ok: true, left: a.env && a.env.CLAUDE_CONFIG_DIR ? 'its login folder stays at ' + a.env.CLAUDE_CONFIG_DIR : null };
}
function pauseAll(paused) { const now = new Date().toISOString(); S.agents.forEach((a) => { a.paused = !!paused; a.changedAt = now; }); save(); }

/* ---------- items ---------- */
/* a ticket onto the queue: filed (in "to work"), not already there; the item's ask is the standing one */
function enqueueTicket(projectId, tk, opts) {
  opts = opts || {};
  if (!tk) return { ok: false, error: 'no ticket' };
  if (tk.state !== 'created') return { ok: false, error: (tk.number ? '#' + tk.number : tk.id) + ' is ' + tk.state + ' - only a ticket in "to work" (approved, not started) goes on the queue' };
  const dup = S.items.find((i) => i.project === projectId && i.ticket === tk.id && (i.status === 'queued' || i.status === 'running')); if (dup) return { ok: false, error: 'already on the queue as item #' + dup.id, item: dup };
  const ref = tk.number ? '#' + tk.number : tk.id;
  const item = add({ project: projectId, ticket: tk.id, agent: opts.agent || null, priority: opts.priority || 'next', source: opts.source || 'board', title: ref + ': ' + tk.title.replace(/^(#\d+|L\d+):\s*/, ''), text: 'Work ' + ref + '. The ticket body is in your prompt; do exactly what it says, touch only the files it names, and read back what you did.' });
  return { ok: true, item, agentsOn: S.agents.filter((a) => a.on && !a.paused && (!a.projects || a.projects.includes(projectId))).length };
}
function add(item) {
  const it = { id: S.nextId++, ticket: item.ticket ? String(item.ticket).replace(/^#/, '') : null, agent: item.agent && S.agents.some((a) => a.id === item.agent) ? item.agent : null, project: item.project, title: String(item.title || item.text || '').slice(0, 120), text: String(item.text || item.title || ''), priority: TIER[item.priority] !== undefined ? item.priority : 'P2',
    status: 'queued', source: item.source || 'hand', added: new Date().toISOString(), claimedBy: null, claimedAt: null, turns: 0, outcome: null, order: 0 };
  if (item.gh) it.gh = Number(item.gh);
  if (item.harness) it.harness = String(item.harness);   // only a coder of this harness may take it (ghqueue.harnessFor)
  if (item.bottom) it.order = 1 + Math.max(0, ...S.items.filter((x) => x.priority === it.priority).map((x) => x.order || 0));   // new work lands at the bottom of its tier
  S.items.push(it); save(); return it;
}
function update(id, patch) {
  const it = S.items.find((x) => x.id === Number(id)); if (!it) return null;
  ['title', 'text', 'priority', 'status', 'order', 'project', 'agent'].forEach((k) => { if (patch[k] !== undefined) it[k] = patch[k]; });
  if (it.agent && !S.agents.some((a) => a.id === it.agent)) it.agent = null;
  if (patch.status === 'queued') { it.claimedBy = null; it.claimedAt = null; }
  save(); return it;
}
function remove(id) { const n = S.items.length; S.items = S.items.filter((x) => x.id !== Number(id)); save(); return S.items.length !== n; }
/* drag within a tier: the caller sends the tier's ids in the new order */
function reorder(ids) { ids.forEach((id, i) => { const it = S.items.find((x) => x.id === Number(id)); if (it) it.order = i; }); save(); }

/* ---------- the tick ---------- */
/* a claim is dead when its agent has no turn running for it any more (a turn that crashed, a few minutes' grace for one that is
   starting), or when it is simply too old */
function claimDead(it) {
  if (!it.claimedAt) return false;
  const age = Date.now() - Date.parse(it.claimedAt);
  if (age > CLAIM_MAX_MIN * 60000 && !Object.values(inTurn).some((l) => l.length)) return true;
  return age > 3 * 60000 && !(inTurn[it.claimedBy] || []).length;
}
/* Two agents in one project: fine when their tickets touch different files; blocked when the files overlap, or when either side
   has no declared files to compare (it does, the ticket's file lists are the control). An item with no ticket keeps the old
   one-at-a-time rule. */
function ticketFiles(projectId, ticketId) {
  try { const p = require('./projects').open(projectId); const t = require('./hot').hot(path.join(__dirname, 'tickets.js')).get(p, ticketId); if (!t) return null; const f = [...(t.alter || []), ...(t.create || []), ...(t.delete || [])].map((x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()); return f.length ? f : null; } catch (e) { return null; }
}
function projectBusy(it) {
  const others = S.items.filter((x) => x !== it && x.status === 'running' && x.project === it.project && !claimDead(x));
  if (!others.length) return false;
  /* a GitHub ticket: every coder at once, each on its own ticket. Two that touch the same code show
     it as a failed merge, and the loser comes back as Not completed on the new main - no file lists needed */
  if (it.gh) return others.some((x) => x.gh === it.gh);
  const mine = it.ticket ? ticketFiles(it.project, it.ticket) : null; if (!mine) return true;
  return others.some((x) => { const theirs = x.ticket ? ticketFiles(x.project, x.ticket) : null; if (!theirs) return true; return theirs.some((f) => mine.includes(f)); });
}
function takeable(a, it) {
  if (it.status !== 'queued' && !(it.status === 'running' && claimDead(it))) return false;
  if (it.claimedBy && it.claimedBy !== a.id && !claimDead(it)) return false;
  if (a.projects && !a.projects.includes(it.project)) return false;
  if (it.agent && it.agent !== a.id) return false;   // assigned to another coder
  if (it.harness && it.harness !== a.harness) return false;   // security / findings: the strong coders only
  if (projectBusy(it)) return false;
  return true;
}
function tickAll() { syncAll(); for (const a of S.agents) tick(a); }
/* every project on GitHub: its queue matched to the last scan (engine/ghqueue.js) - closed tickets leave, new ones join
   at the bottom, a lifted hold comes back. Runs whether or not a coder is on: the queue is always GitHub's. */
const SYNC_MS = 2 * 60000; let lastSync = 0;
const ghq = () => require('./hot').hot(path.join(__dirname, 'ghqueue.js'));
function syncAll() {
  if (Date.now() - lastSync < SYNC_MS) return; lastSync = Date.now();
  const projects = require('./projects');
  for (const e of require('./registry').all()) {
    try {
      if (!fs.existsSync(path.join(e.path || '', '.cockpit', 'plugins', 'github.json'))) continue;
      const p = projects.open(e.id); if (!p || p.missing) continue;
      const r = ghq().sync(p, S.items, (x) => add({ ...x, bottom: true }));
      if (!r) continue;
      if (r.skipped) { if (r.skipped !== S.lastSkip) console.log('fleet → sync ' + e.id + ' skipped: ' + r.skipped); S.lastSkip = r.skipped; continue; }
      S.lastSkip = null;
      if (r.added.length || r.moved.length) console.log('fleet → sync ' + e.id + ': +' + r.added.length + ' (' + r.added.map((n) => '#' + n).join(' ') + ')' + (r.moved.length ? ', moved ' + r.moved.map((m) => '#' + m.n + '→' + m.to).join(' ') : ''));
      save();
    } catch (err) { console.log('fleet → sync ' + e.id + ' failed: ' + err.message); }
  }
}
/* the usage floor (owner's standing rule, written in 2026-09-20: "stop the queue at 75% usage"): an agent whose plan reading says
   less than `floor` percent is left takes nothing more - the last quarter of a plan is the owner's for his own conversations. The
   reading is the harness's own (usageFromHarness) or the one entered by hand; no reading = no floor. Per agent: a.floor, default 25. */
const FLOOR_DEFAULT = 25;
/* A READING OF A WINDOW THAT HAS SINCE RESET HOLDS NOBODY (2026-09-26: three Claude coders sat held from 05:30 to 12:40 on
   5-hour readings whose windows reset at 07:39 and 08:40. A held coder runs no turns, its access token lapses, the usage
   probe can no longer read - so the stale reading was never replaced). Only windows still open count; when every window
   the reading has is past its reset, the coder takes work and its next turn brings a fresh reading. */
/* EACH WINDOW ITS OWN FLOOR: the weekly window holds at a.floor; a short window (the 5-hour one) holds at a.floorShort when set - 0 = use it
   all, the plan itself stops the coder at the end and the window resets within hours. Unset = the same floor as weekly. */
function isShortWindow(w) { return w.name ? !/week/i.test(String(w.name)) : (typeof w.minutes === 'number' && w.minutes < 10080); }
function atFloor(a) {
  const u = a.usage; if (!u || typeof u.leftPct !== 'number') return false;
  const floor = typeof a.floor === 'number' ? a.floor : FLOOR_DEFAULT, now = Date.now();
  const floorShort = typeof a.floorShort === 'number' ? a.floorShort : floor;
  const ws = Array.isArray(u.windows) ? u.windows.filter((w) => typeof w.usedPct === 'number') : [];
  if (ws.length) { const live = ws.filter((w) => !w.resetsAt || w.resetsAt > now); if (!live.length) return false; return live.some((w) => 100 - w.usedPct <= (isShortWindow(w) ? floorShort : floor)); }
  if (u.resetsAt && u.resetsAt < now) return false;
  return u.leftPct <= floor;
}
function tick(a) {
  const max = require('./harness').EXCLUSIVE[a.harness] ? 1 : Math.max(1, Number(a.parallel) || 1);
  if (!a.on || a.paused || running(a).length >= max) return;
  if (atFloor(a)) { if (!a.heldAt) { a.heldAt = new Date().toISOString(); save(); console.log('fleet → ' + a.id + ' holds: ' + a.usage.leftPct + '% of its plan left (floor ' + (typeof a.floor === 'number' ? a.floor : FLOOR_DEFAULT) + '%)'); } return; }
  if (a.heldAt) { a.heldAt = null; save(); }
  if (a.lastTick && Date.now() - a.lastTick < (a.every || 5) * 60000) return;
  a.lastTick = Date.now();
  const it = sorted(S.items).find((x) => takeable(a, x));
  if (!it) return;
  take(a, it);
  if (running(a).length < max) { const more = sorted(S.items).find((x) => takeable(a, x)); if (more) take(a, more); }   // a second, in another project, when allowed
}
/* The verdict on a queued ticket's turn, a few seconds after the turn ends (engine/verify.js after the light test run and the
   rescan): green = the item is truly done and the ticket is verified - the owner's alert says "pass it"; red = the item goes
   back on the queue with the red checks in its ask, for the agent to put right - three tries, then it is the owner's
   (2026-09-20: L5 and L6 said "done" on the queue with red verdicts and sat in work, unnoticed). */
function verdict(p, ticketId, v) {
  const it = S.items.filter((x) => x.project === p.entry.id && x.ticket === ticketId && (x.status === 'done' || x.status === 'running')).sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!it || !v || !v.verdict) return;
  if (it.gh) return;   // a GitHub ticket's item moves on what GitHub says (engine/ghqueue.js), not on Cockpit's verdict
  const wake = (text) => { try { require('./hot').hot(path.join(__dirname, 'wake.js')).after(ROOT, { project: p.entry.id, ticket: ticketId, text }); } catch (e) { /* */ } };   // Home's assistant hears it (engine/wake.js)
  const ref = /^L/.test(ticketId) ? ticketId : '#' + ticketId;
  if (v.verdict.green) { if (it.status === 'done') it.outcome = { ...(it.outcome || {}), verdict: 'green' }; save(); wake(ref + ' on ' + p.entry.id + ' finished and is VERIFIED (' + it.title.slice(0, 80) + ') - waits for the owner\'s Passed'); return; }
  const red = (v.red || []).join(', ');
  it.outcome = { ...(it.outcome || {}), verdict: 'red: ' + red, at: new Date().toISOString() };
  if (it.turns >= 3) {
    it.status = 'failed'; save();
    try { require('./hot').hot(path.join(__dirname, 'tickets.js')).log(p, it.ticket, 'the fleet gave up after ' + it.turns + ' tries - the verdict is still red on ' + red + '; it is the owner\'s now'); } catch (e) { /* */ }
    giveBack(it, 'three turns and the verdict is still red on ' + red);
    try { require('./events').record(p, { kind: 'fleet.failed', level: 'alert', title: 'the fleet gave up on ' + it.title + ' - the verdict stays red on ' + red, text: v.text.slice(0, 400), ref: it.ticket, source: 'fleet' }); } catch (e) { /* */ }
    wake(ref + ' on ' + p.entry.id + ': the fleet GAVE UP after ' + it.turns + ' tries - the verdict stays red on ' + red + ' (' + it.title.slice(0, 80) + ') - it is the owner\'s now');
    return;
  }
  it.status = 'queued'; it.claimedBy = null; it.claimedAt = null;
  try { require('./hot').hot(path.join(__dirname, 'tickets.js')).log(p, it.ticket, 'verdict red on ' + red + ' after try ' + it.turns + ' - queued again (try ' + (it.turns + 1) + ' of 3)'); } catch (e) { /* */ }
  /* A SMALL FIX FOR A SMALL RED: red only on the mechanical checks - committed, untouched, declared -
     is a two-line ask, not the whole ticket again; with the session resumed the coder already knows the work */
  const MECH = { committed: 'commit the work (every touched file, one commit naming the ticket)', untouched: 'do the part of the ticket that touches the declared files it lists as untouched - or, if they were never needed, take them off the ticket with `ticket edit`', declared: 'the turn touched files the ticket does not name: add them to the ticket with `ticket edit` if they were needed, or revert them' };
  const reds = v.red || [];
  const ref2 = /^L/.test(it.ticket) ? it.ticket : '#' + it.ticket;
  if (reds.length && reds.every((r) => MECH[r])) it.text = 'Finish ' + ref2 + ': the verdict is red ONLY on ' + red + '. ' + reds.map((r) => MECH[r]).join('; ') + '. Nothing else - no re-reading, no re-running the plan; the verdict text is on the ticket.';
  /* the retry keeps the WHOLE ticket in view (L1's retries chased the red checks for three tries and
     never built the three asks its body carried) - the reds are what the last try left wrong, not the whole job */
  else it.text = 'Work ' + ref2 + ' again. Cockpit\'s verdict on the last turn came back RED on ' + red + ' - the verdict text is on the ticket (ticket ' + it.ticket + '). Put that right AND make sure everything the ticket body asks for is built: read the body again and build any part that is not there yet. Never make a check pass by taking files off the ticket or by editing a test to agree with a bug. Commit, and read back what you did.';
  save();
  try { require('./events').record(p, { kind: 'fleet.retry', level: 'warn', title: 'try ' + (it.turns + 1) + ' of 3 for ' + it.title + ' - the verdict was red on ' + red, text: 'queued again with the red checks in the ask', ref: it.ticket, source: 'fleet' }); } catch (e) { /* */ }
  wake(ref + ' on ' + p.entry.id + ' came back RED on ' + red + ' after try ' + it.turns + ' - queued again (try ' + (it.turns + 1) + ' of 3)');
}
/* the ticket's side of a failed item: back to "to work" with the reason, so it lands in Needs attention */
function giveBack(it, why) {
  if (!it.ticket) return;
  try { const p = require('./projects').open(it.project); const tk = require('./hot').hot(path.join(__dirname, 'tickets.js')); const t = tk.get(p, it.ticket); if (t && t.state === 'in-work') tk.setState(p, it.ticket, 'created', 'cockpit', why); } catch (e) { /* the ticket keeps its state */ }
}
function take(a, it) {
  const registry = require('./registry'), projects = require('./projects'), harness = require('./harness'), conv = require('./conversation');
  if (!registry.get(it.project)) { it.status = 'failed'; it.outcome = { reason: 'project ' + it.project + ' is not registered' }; save(); return; }
  const p = projects.open(it.project);
  if (!p || p.missing) { it.status = 'failed'; it.outcome = { reason: 'project folder missing' }; save(); return; }
  /* THE CODER'S OWN FOLDER (engine/workspaces.js): a project with the Coding plugin is worked in <project>\.coders\<coder>,
     set up the first time this coder works here - the item waits, unclaimed, until it is ready; a setup that failed is
     said once as an event and the coder leaves this project alone for half an hour */
  const ws = require('./workspaces');
  let cwd = null;
  if (ws.on(p)) {
    const st = ws.ensure(p, a.id);
    if (st === 'preparing') { if (a.prepNote !== p.entry.id) { a.prepNote = p.entry.id; console.log('fleet → ' + a.id + ': setting up its folder in ' + p.entry.id + ' before taking work there'); } return; }
    if (st !== 'ready') return;
    a.prepNote = null; cwd = ws.dirFor(p, a.id);
    try { const s = ws.sync(p, a.id); if (s) console.log('fleet → ' + a.id + '\'s folder in ' + p.entry.id + ': ' + s); } catch (e) { /* its folder as it is */ }   // a dev-landing coder starts from what dev runs now
  }
  /* the dev-landing coder is told how its work reaches dev (engine/land.js) - the folder is its own, dev is not */
  const landNote = cwd && (() => { try { return ws.landsInDev(p); } catch (e) { return false; } })()
    ? '\n\nYOU WORK IN YOUR OWN COPY (' + cwd + '), not in the dev site\'s folder. When your turn ends Cockpit takes your COMMITTED work, runs the checks in your copy, and merges it into dev by fast-forward; then the tests and the ticket check run on dev. So: commit everything (uncommitted work never lands), do not push, do not open a pull request, and do not edit the dev folder (' + ws.repo(p).dir + ') directly. Your test database is ' + (ws.dbFor(p, a.id) || 'the one in your copy\'s settings') + ' - never the dev database. Check a screen with `look <url> --login` only after your work has landed; before that, dev does not have it.'
    : '';
  it.status = 'running'; it.claimedBy = a.id; it.claimedAt = new Date().toISOString(); it.turns++; it.outcome = null; save();
  // each item gets its own conversation in the project, so its record is readable there
  let threadId = it.thread || conv.create(p, 'Fleet #' + it.id + ': ' + it.title);
  it.thread = threadId;
  let gh = null; try { if (ghq().on(p)) { if (!it.gh) { const n = ghq().numOf(it); if (n) it.gh = n; } if (it.gh) gh = ghq(); } } catch (e) { /* not a GitHub project */ }
  const ask = 'Fleet item #' + it.id + ' (' + it.priority + ')' + (it.ticket ? ' - ticket ' + (/^L/.test(it.ticket) ? it.ticket : '#' + it.ticket) : '') + ': ' + it.title + '\n\n' + it.text + (gh ? gh.preamble(p, it, cwd ? { folder: cwd, db: ws.dbFor(p, a.id) } : null) : '') + landNote + '\n\nDo this, in this project. When done, say in one line what changed and what, if anything, needs the owner.';
  let turnId;
  /* RETRIES THAT REMEMBER: the same harness retrying the same item resumes the session its last try
     left (it.session, said by the harness at the end) - it starts with everything it read; a different harness starts cold */
  const resume = it.session && it.session.harness === a.harness && it.turns > 1 ? it.session.id : null;
  /* a coder's turn gets 120 minutes, not the conversation's 45: overnight nearly every ticket was cut off
     once at 45 and finished on its second try; silence still stops a stuck turn at the harness's own limit */
  try { turnId = harness.run(ROOT, p, threadId, a.harness, a.model, ask, { fleet: true, ticket: it.ticket || null, resume, cwd, env: a.env || null, agentId: a.id, limits: { maxMinutes: FLEET_TURN_MIN } }); }   // env: this coder's own login (addAgent)
  catch (e) { it.status = 'queued'; it.claimedBy = null; it.claimedAt = null; it.outcome = { reason: 'could not start: ' + e.message, at: new Date().toISOString() }; save(); return; }
  inTurn[a.id] = running(a).concat([turnId]);
  if (it.ticket) { try { require('./hot').hot(path.join(__dirname, 'tickets.js')).log(p, it.ticket, 'taken from the queue by ' + a.id + ' (try ' + it.turns + ' of 3)', a.id); } catch (e) { /* */ } }
  console.log('fleet → ' + a.id + ' took #' + it.id + ' (' + it.project + ')');
  const off = harness.subscribe(turnId, (ev) => {
    if (ev.type !== 'end') return;
    inTurn[a.id] = running(a).filter((x) => x !== turnId);
    const o = ev.outcome || {};
    if (o.session && o.session.id) it.session = { harness: o.session.harness, id: o.session.id, at: new Date().toISOString() };
    it.outcome = { reason: ev.reason, producedNothing: !!o.producedNothing, files: o.files || [], text: (o.text || '').slice(0, 600), cost: o.cost || null, at: new Date().toISOString(), agent: a.id, resumed: o.resumed || null };
    /* a resumed try that died at once with nothing done is the resume failing (a session gone on the harness's side), not the
       work failing: the try is not counted, the session is dropped, the next take starts cold */
    if (o.resumed && o.producedNothing && (o.durationSec || 0) < 60) { it.turns = Math.max(0, it.turns - 1); it.session = null; it.status = 'queued'; it.claimedBy = null; it.claimedAt = null; save(); console.log('fleet → #' + it.id + ': the resume of ' + String(o.resumed).slice(0, 8) + ' did not take - the try is not counted, the next starts cold'); return; }
    /* A GITHUB TICKET: where it went is GitHub's to say, read fresh now - never the turn's own "done" (#2206 wrote half a migration, said done, and left the queue). Merged → In UAT, a blocked:* label → Blocked, closed →
       Done, anything else → Not completed, back in the queue with what went wrong, three tries, then Blocked. */
    if (gh) {
      save();
      const ev2 = require('./events');
      gh.afterTurn(p, it, o).then((r) => {
        it.status = r.status; it.outcome = { ...it.outcome, reason: r.why };
        if (r.status === 'queued') { it.claimedBy = null; it.claimedAt = null; }
        save();
        try {
          if (r.status === 'merged') ev2.record(p, { kind: 'fleet.done', level: 'info', title: a.id + ' merged #' + it.gh + ' - in UAT: ' + it.title, text: r.why, ref: String(it.gh), source: 'fleet' });
          else if (r.status === 'blocked') ev2.record(p, { kind: 'fleet.failed', level: 'alert', title: '#' + it.gh + ' is blocked: ' + r.why, text: it.title, ref: String(it.gh), source: 'fleet' });
          else if (r.status === 'queued') ev2.record(p, { kind: 'fleet.retry', level: 'warn', title: '#' + it.gh + ' not completed by ' + a.id + ' - back in the queue', text: r.why, ref: String(it.gh), source: 'fleet' });
        } catch (e) { /* */ }
        console.log('fleet → ' + a.id + ' finished #' + it.id + ' (GitHub #' + it.gh + '): ' + it.status + ' - ' + r.why);
      }).catch((e) => {
        /* GitHub could not be read: the item is parked, not guessed at and not retried blind - it stays the ticket's place */
        it.status = 'parked'; it.claimedBy = null; it.claimedAt = null; it.outcome = { ...it.outcome, reason: 'parked: GitHub could not be read when the turn ended - ' + e.message };
        save(); console.log('fleet → #' + it.id + ' parked: ' + e.message);
      });
      if (off) off();
      return;
    }
    it.status = ev.reason === 'done' && !o.producedNothing ? 'done' : (it.turns >= 3 ? 'failed' : 'queued');   // three tries, then it is the owner's; a turn that touched nothing is not a completion
    try { const ev2 = require('./events'); if (it.status === 'failed') ev2.record(p, { kind: 'fleet.failed', level: 'alert', title: a.id + ' gave up on #' + it.id + ' after ' + it.turns + ' tries: ' + it.title, text: ev.reason + (o.text ? ' - ' + String(o.text).slice(0, 200) : ''), ref: it.ticket || null, source: 'fleet' }); else if (it.status === 'queued') ev2.record(p, { kind: 'fleet.retry', level: 'warn', title: a.id + ' produced nothing on #' + it.id + ' (try ' + it.turns + ' of 3): ' + it.title, text: ev.reason, ref: it.ticket || null, source: 'fleet' }); else { if (it.ticket) ev2.resolve(p, { kind: 'fleet.', ref: String(it.ticket) }); ev2.record(p, { kind: 'fleet.done', level: 'info', title: a.id + ' finished #' + it.id + ': ' + it.title, text: (o.files || []).slice(0, 6).join(', '), ref: it.ticket || null, source: 'fleet' }); } } catch (e) { /* */ }
    if (it.status === 'queued') { it.claimedBy = null; it.claimedAt = null; }
    save();
    if (it.status === 'failed') giveBack(it, 'the fleet gave up after ' + it.turns + ' tries on ' + a.id + ': ' + (o.producedNothing ? 'the turns produced nothing' : ev.reason) + (o.text ? ' - ' + String(o.text).slice(0, 200) : ''));
    if (!it.ticket && (it.status === 'done' || it.status === 'failed')) { try { require('./hot').hot(path.join(__dirname, 'wake.js')).after(ROOT, { project: it.project, text: 'queue item #' + it.id + ' on ' + it.project + ' (' + it.title.slice(0, 80) + ') ' + (it.status === 'done' ? 'finished' : 'FAILED after ' + it.turns + ' tries') + ' - ' + a.id }); } catch (e) { /* */ } }
    console.log('fleet → ' + a.id + ' finished #' + it.id + ': ' + it.status);
    if (off) off();
  });
}

module.exports = { load, state, setAgent, addAgent, removeAgent, pauseAll, add, update, remove, reorder, usageFromHarness, probeUsage, enqueueTicket, verdict, takeable };
