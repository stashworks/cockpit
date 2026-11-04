/* The wake-up call. When a queue item's verdict lands - green, red and round again, or the fleet gave up - Home's AI
   (the owner's assistant across every project) gets a turn of its own in a standing conversation there, with what just happened and
   the queue and the agents as they stand now, and manages the queue from Home: what is next, what to reorder or assign,
   what the owner should hear. Its rules (home/.cockpit/project.md) say how.

   Guards (2026-09-21 morning: 31 wake-ups in six hours at ~$0.45 each, on Opus, in one ever-growing conversation - "do we have
   something leaking"): one wake-up per FIVE minutes at most - everything that finished in the window makes one call; none while
   a turn is already running on Home; none at the fleet's usage floor; on the CHEAPEST model of Home's AI (Haiku for Claude Code)
   unless Home's settings name one (cockpit.json wake.model); in a fresh conversation each day, so the context never grows past the
   day's calls; and off altogether with cockpit.json wake.off. Stateless - hot-loaded. */
'use strict';
const path = require('node:path');
const hot = (f) => require('./hot').hot(path.join(__dirname, f));

const HOME = 'home';
const COALESCE_MS = 5 * 60 * 1000;
const CHEAP = { 'claude-code': 'haiku', 'codex-cli': null, pi: null };   // the model a wake-up runs on when Home's settings name none - the cheapest that can read a list and write three lines
let pending = [], timer = null;

/* what just finished, one line each; queued up until the timer fires */
function after(root, note) {
  pending.push({ at: new Date().toISOString(), ...note });
  if (timer) return;
  timer = setTimeout(() => { timer = null; const notes = pending.splice(0); fire(root, notes).catch((e) => console.log('[wake] ' + e.message)); }, COALESCE_MS);
  if (timer.unref) timer.unref();
}

function queueSummary(fleet, projects) {
  const s = fleet.state();
  const name = (id) => { try { const p = projects.open(id); return (p && p.cockpit && p.cockpit.json && p.cockpit.json.name) || id; } catch (e) { return id; } };
  const items = s.items.filter((i) => i.status === 'queued' || i.status === 'running');
  const lines = items.slice(0, 20).map((i) => '- #' + i.id + ' ' + i.status + (i.claimedBy ? ' (' + i.claimedBy + ')' : '') + ' · ' + i.priority + ' · ' + name(i.project) + ' · ' + i.title.slice(0, 90));
  const agents = s.agents.map((a) => '- ' + a.id + ': ' + (a.on ? (a.paused ? 'paused' : a.heldAt ? 'holding at the usage floor' : 'on') : 'off') + (a.usage && typeof a.usage.leftPct === 'number' ? ' · ' + a.usage.leftPct + '% of the plan left' : '') + (a.running ? ' · working #' + (s.items.find((i) => i.status === 'running' && i.claimedBy === a.id) || {}).id : ''));
  return { items: lines.length ? lines.join('\n') + (items.length > 20 ? '\n- … ' + (items.length - 20) + ' more' : '') : '- (empty)', agents: agents.join('\n'), waiting: items.filter((i) => i.status === 'queued').length, running: items.filter((i) => i.status === 'running').length };
}

async function fire(root, notes) {
  const projects = require('./projects'), harness = require('./harness'), fleet = require('./fleet');
  let home; try { home = projects.open(HOME); } catch (e) { return; }
  if (!home || home.missing) return;
  if (harness.runningIn(HOME).length) { console.log('[wake] Home is mid-turn - the ' + notes.length + ' note(s) wait for the next'); pending.unshift(...notes); if (!timer) { timer = setTimeout(() => { timer = null; const n = pending.splice(0); fire(root, n).catch(() => {}); }, COALESCE_MS); if (timer.unref) timer.unref(); } return; }
  const ai = home.cockpit.json.ai || {}, wk = home.cockpit.json.wake || {};
  if (wk.off) { console.log('[wake] wake-ups are off (home cockpit.json wake.off)'); return; }
  const harnessName = wk.harness || ai.harness || 'claude-code';
  const model = wk.model || CHEAP[harnessName] || ai.model || null;
  const agent = fleet.state().agents.find((a) => a.harness === harnessName);
  if (agent && agent.usage && typeof agent.usage.leftPct === 'number' && agent.usage.leftPct <= (typeof agent.floor === 'number' ? agent.floor : 25)) { console.log('[wake] not waking Home: ' + agent.id + ' is at the usage floor (' + agent.usage.leftPct + '% left)'); return; }
  const conv = hot('conversation.js');
  // a fresh conversation each day: the calls of one day are the context, never the whole history
  const day = new Date().toISOString().slice(0, 10), key = 'wakeThread:' + day;
  let thread = home.cockpit.json[key];
  if (!thread || !conv.thread(home, thread)) { thread = conv.create(home, 'The queue - wake-up calls ' + day); Object.keys(home.cockpit.json).forEach((k) => { if (k.indexOf('wakeThread') === 0) delete home.cockpit.json[k]; }); home.cockpit.json[key] = thread; try { require('node:fs').writeFileSync(path.join(home.cockpit.dir, 'cockpit.json'), JSON.stringify(home.cockpit.json, null, 2) + '\n'); } catch (e) { /* */ } }
  const q = queueSummary(fleet, projects);
  const what = notes.map((n) => '- ' + n.text).join('\n');
  const msg = 'WAKE-UP CALL - ' + (notes.length === 1 ? 'a ticket just finished' : notes.length + ' tickets just finished') + ':\n' + what
    + '\n\nThe queue now (' + q.waiting + ' waiting, ' + q.running + ' running):\n' + q.items + '\n\nThe agents:\n' + q.agents
    + '\n\nManage the queue from here, per your rules: what should come next, anything to reorder, park or assign, anything an agent should be switched on or off for. Do what your rules and the owner\'s standing instructions allow with the queue commands; ask for nothing he has not asked for. Then say, in three lines at most, in your own voice: what just happened, what is running or next, and what (if anything) needs him.';
  try { const turn = harness.run(root, home, thread, harnessName, model || 'haiku', msg, { context: null, limits: { maxMinutes: 45 } /* unattended: keeps a ceiling (engine/harness.js) */ }); console.log('[wake] Home woken (turn ' + turn + ', ' + harnessName + '/' + (model || 'haiku') + ') for ' + notes.length + ' note(s)'); }
  catch (e) { console.log('[wake] could not wake Home: ' + e.message); }
}

module.exports = { after };
