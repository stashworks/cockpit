'use strict';
/* PROJECT EXTENSIONS - a project's own data program, called by its cards (for example a personal assistant project's
   Today / tracked-items drawer / capture cards). Cards are Cockpit's; the data and
   the rules are the project's. So a project names, in <project>\.cockpit\ext.json, the program Cockpit may run for it and
   exactly which of its commands are reads and which are writes:

     { "assistant": { "run": ["node", "prototype/assistant/cli.cjs"],
                      "read": ["dashboard", "now", "list", "get", "history"], "write": ["write"] } }

   GET  /api/p/:id/ext/<name>/<read command>?args=["2026-09-27","active","0"]    -> the program's JSON
   POST /api/p/:id/ext/<name>/<write command>   body = the JSON the program reads on stdin
   Nothing else runs: the command must be on the project's list, a write only by POST, each argument a short plain word
   (no spaces, no quotes, no paths), the program run with an argument array (never a shell) in the project's own folder,
   30 seconds at most. A program that fails is an error, never an empty answer (the card must not say "nothing tracked").
   Hot-loaded: server.js hands every /ext/ request here. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

function config(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'ext.json'), 'utf8')); } catch (e) { return {}; }
}
function run(p, spec, cmd, args, stdin) {
  return new Promise((resolve) => {
    const bin = spec.run[0] === 'node' ? process.execPath : spec.run[0];
    const child = cp.spawn(bin, spec.run.slice(1).concat([cmd], args), { cwd: p.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { child.kill(); } catch (e) { /* */ } finish({ ok: false, error: cmd + ' took longer than 30 seconds' }); }, 30000);
    child.stdout.on('data', (d) => { out += d; if (out.length > 8e6) { try { child.kill(); } catch (e) { /* */ } } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: 'could not start: ' + e.message }));
    child.on('close', (code) => {
      if (code !== 0) { let why = err.trim().split(/\r?\n/).pop() || ('exit ' + code); try { const j = JSON.parse(why); why = j.error || why; } catch (e) { /* plain text */ } return finish({ ok: false, error: String(why).slice(0, 300) }); }
      try { finish({ ok: true, data: JSON.parse(out) }); } catch (e) { finish({ ok: false, error: 'the program did not answer in JSON' }); }
    });
    if (stdin !== undefined) child.stdin.end(JSON.stringify(stdin)); else child.stdin.end();
  });
}
/* BOXED CARDS - the ONE exception. A project the owner trusts may write its own cards in <project>\.cockpit\cards\ (cards.json
   + one .html each); the shell (shell/boxcards.js) shows each in a sealed iframe - no network, no Cockpit - talking to the page
   through a messenger that can do exactly three things for that project: read its data, save through its program, send to its
   conversation. Only the project ids listed in the engine setting "boxedCards" (engine.json, or COCKPIT_BOXED_CARDS as a
   comma-separated list; empty by default) may have boxed cards; every other project is refused here, whatever its files say.

   TWO STAGES:
     working     .cockpit\cards\        what the project's AI last built - shown on its own desk, at once
     published   .cockpit\cards\home\   the copy HOME shows - changed only by the owner's "Publish to Home"
   A publish copies the working cards.json and its html files over; it is recorded on Home as an alert. */
function boxed() {
  let list = [];
  try { const c = require('./config').loadEngineConfig(path.join(__dirname, '..')); if (Array.isArray(c.boxedCards)) list = c.boxedCards; } catch (e) { /* none */ }
  if (process.env.COCKPIT_BOXED_CARDS) list = process.env.COCKPIT_BOXED_CARDS.split(',');
  return list.map((s) => String(s).trim()).filter(Boolean);
}
const BOX = { includes: (id) => boxed().includes(id) };
const BOX_MAX = 300 * 1024;
const ID_OK = (c) => c && /^[a-z0-9-]{1,30}$/.test(String(c.id || '')) && /^[a-z0-9-]{1,40}\.html$/.test(String(c.file || ''));
function readStage(dir) {
  const crypto = require('node:crypto'), cards = [];
  let list = []; try { list = JSON.parse(fs.readFileSync(path.join(dir, 'cards.json'), 'utf8')); } catch (e) { return { cards: [] }; }
  if (!Array.isArray(list)) return { error: 'cards.json must be a list' };
  for (const c of list.slice(0, 12)) {
    if (!ID_OK(c)) continue;
    let html = ''; try { const f = path.join(dir, c.file); if (fs.statSync(f).size > BOX_MAX) { cards.push({ id: c.id, title: String(c.title || c.id), error: c.file + ' is larger than 300 KB' }); continue; } html = fs.readFileSync(f, 'utf8'); } catch (e) { cards.push({ id: c.id, title: String(c.title || c.id), error: 'cannot read ' + c.file }); continue; }
    const hash = crypto.createHash('sha1').update(html + JSON.stringify([c.title, c.zone, c.size])).digest('hex').slice(0, 12);
    cards.push({ id: c.id, file: c.file, title: String(c.title || c.id).slice(0, 40), zone: ['left', 'right', 'stage'].includes(c.zone) ? c.zone : 'stage', size: Array.isArray(c.size) ? c.size.slice(0, 2).map(Number) : [6, 10], purpose: String(c.purpose || '').slice(0, 200), hash, html });
  }
  return { cards };
}
function boxCards(p, stage) {
  if (!BOX.includes(p.entry.id)) return { ok: false, error: 'only a project listed in the engine\'s boxedCards setting may bring its own cards' };
  const work = path.join(p.cockpit.dir, 'cards'), pub = path.join(work, 'home');
  const r = readStage(stage === 'home' ? pub : work); if (r.error) return { ok: false, error: r.error };
  if (stage !== 'home') {   // the working list says, per card, whether Home has it and whether it is the same
    const h = {}; (readStage(pub).cards || []).forEach((c) => { h[c.id] = c.hash; });
    r.cards.forEach((c) => { c.published = h[c.id] ? (h[c.id] === c.hash ? 'same' : 'changed') : 'not yet'; });
  }
  return { ok: true, stage: stage === 'home' ? 'published' : 'working', cards: r.cards };
}
function publish(p) {
  if (!BOX.includes(p.entry.id)) return { ok: false, error: 'only a project listed in the engine\'s boxedCards setting may bring its own cards' };
  const work = path.join(p.cockpit.dir, 'cards'), pub = path.join(work, 'home');
  const r = readStage(work); if (r.error) return { ok: false, error: r.error };
  const good = r.cards.filter((c) => !c.error);
  if (!good.length) return { ok: false, error: 'there are no working cards to publish' };
  const before = {}; (readStage(pub).cards || []).forEach((c) => { before[c.id] = c.hash; });
  fs.mkdirSync(pub, { recursive: true });
  for (const f of fs.readdirSync(pub)) if (/\.(html|json)$/.test(f)) fs.unlinkSync(path.join(pub, f));   // only the published copies themselves
  const list = JSON.parse(fs.readFileSync(path.join(work, 'cards.json'), 'utf8')).filter((c) => ID_OK(c) && good.some((g) => g.id === c.id));
  for (const c of list) fs.copyFileSync(path.join(work, c.file), path.join(pub, c.file));
  fs.writeFileSync(path.join(pub, 'cards.json'), JSON.stringify(list, null, 2));
  const changed = good.filter((c) => before[c.id] !== c.hash).map((c) => c.title), gone = Object.keys(before).filter((id) => !good.some((c) => c.id === id));
  try {
    const home = require('./projects').open('home');
    require('./hot').hot(path.join(__dirname, 'events.js')).record(home, { kind: 'boxcards', level: 'info', title: 'Published to Home: ' + (changed.length ? changed.join(', ') : 'no changes') + (gone.length ? ' (removed: ' + gone.join(', ') + ')' : ''), text: 'The project\'s own cards, tested on its desk, now on Home (' + p.entry.id + '\.cockpit\cards\home).', ref: 'boxcards', source: p.entry.id });
  } catch (e) { /* the record is a courtesy */ }
  return { ok: true, published: list.map((c) => c.id), changed, removed: gone };
}
async function handle(p, rest, query, body, method) {
  if (rest === 'cards/list') return boxCards(p, 'working');
  if (rest === 'cards/home') return boxCards(p, 'home');
  if (rest === 'cards/publish') return method === 'POST' ? publish(p) : { ok: false, error: 'publishing is a POST' };
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(rest); if (!m) return { ok: false, error: 'not an extension address' };
  const spec = config(p)[m[1]];
  if (!spec || !Array.isArray(spec.run) || !spec.run.length) return { ok: false, error: 'this project has no extension named ' + m[1] };
  const isWrite = (spec.write || []).includes(m[2]), isRead = (spec.read || []).includes(m[2]);
  if (!isWrite && !isRead) return { ok: false, error: m[2] + ' is not one of ' + m[1] + '\'s commands' };
  if (isWrite && method !== 'POST') return { ok: false, error: m[2] + ' changes data - only by POST' };
  let args = []; try { args = query.args ? JSON.parse(query.args) : []; } catch (e) { return { ok: false, error: 'args must be a JSON list' }; }
  if (!Array.isArray(args) || args.length > 6 || !args.every((a) => /^[A-Za-z0-9_.:-]{0,64}$/.test(String(a)))) return { ok: false, error: 'each argument must be a short plain word' };
  return run(p, spec, m[2], args.map(String), isWrite ? (body || {}) : undefined);
}
module.exports = { handle, config, BOX, boxed };
