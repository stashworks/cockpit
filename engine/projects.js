/* A project is a folder with a .cockpit\ inside it (docs/generic-ide.md §1, §6).
   This module opens one on demand, keeps it loaded while it is being looked at, and lets
   it go quiet when nobody is (§13). Nothing here knows what KIND of project it is; that
   is the plugins' business, and milestone 1 has none.

   .cockpit\ layout (only what milestone 1 needs; the rest arrives with its feature):
     cockpit.json      engine version stamp, plugins selected, project type, created
     project.md        tier-2 rules for any AI (created empty with a heading, never overwritten)
     plugins\          each plugin's wizard answers and optional .md
     cockpit.db        one database
     layouts\          reserved (layouts live in the db for now; the folder marks intent)
     conversations\    the conversation as markdown, readable and greppable (milestone 2)
     decisions\        hand-set grades and rulings a rescan never overwrites
     logs\             turns.jsonl - one shape, every harness
     cache\            rebuildable; everything above it is the owner's */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const registry = require('./registry');

const loaded = new Map();   // id -> { entry, dir, cockpit, db, touched, since }
let CONFIG = null;

function init(config) {
  CONFIG = config;
  // Start-on-demand, the other half: a project nobody has touched for idleUnloadMinutes is
  // closed. Its database is released and its feeds (later) stop. Opening it again is cheap.
  setInterval(sweep, 60 * 1000).unref();
}

const COCKPIT_DIRS = ['plugins', 'layouts', 'conversations', 'decisions', 'logs', 'cache', 'docs'];
/* docs: THE OWNER'S DOCUMENTS FOR THIS PROJECT - plans, specs, anything handed to the team - in the same
   place in every project. Inside .cockpit, so never in the project's git and never a stray file a coder "cleans up" (a
   coder once deleted two such documents from a project's docs folder); in the vault, so kept hourly for a day and daily for
   two weeks. Every AI turn is told it may read them and never change them (prompt.js tier 0). */
const DOCS_README = 'The owner\'s documents for this project - plans, specs, reference material.\r\n\r\nKept here by Cockpit: never part of the project\'s git, backed up with the rest of .cockpit (every hour for a day, then daily for two weeks).\r\nAI coders and conversations may READ these files. They never change, move or delete them.\r\n';

/* Make a folder a project: create .cockpit\ if it is not one yet, stamp it with the engine
   version, upgrade it if an older engine wrote it. Idempotent - opening an existing project
   changes nothing but the stamp. */
function ensureCockpit(dir) {
  const cp = path.join(dir, '.cockpit');
  fs.mkdirSync(cp, { recursive: true });
  for (const d of COCKPIT_DIRS) fs.mkdirSync(path.join(cp, d), { recursive: true });
  try { const rd = path.join(cp, 'docs', 'README.txt'); if (!fs.existsSync(rd)) fs.writeFileSync(rd, DOCS_README); } catch (e) { /* the folder is enough */ }
  const jsonFile = path.join(cp, 'cockpit.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (e) { j = null; }
  const now = new Date().toISOString();
  if (!j) {
    j = { engine: CONFIG.version, created: now, name: path.basename(dir), type: null, plugins: [] };
  } else if (j.engine !== CONFIG.version) {
    // Upgrade in place, like Obsidian opening an older vault. Nothing to migrate yet;
    // the stamp records that this engine has touched it, and when a real migration is
    // needed it goes here, keyed on the version it upgrades FROM.
    j.upgradedFrom = j.engine; j.engine = CONFIG.version; j.upgraded = now;
  }
  fs.writeFileSync(jsonFile, JSON.stringify(j, null, 2) + '\n');
  const md = path.join(cp, 'project.md');
  if (!fs.existsSync(md)) {
    /* The scaffold tells the AI WHAT IT IS before it is told anything else.
       An AI that starts every thread cold re-derives the basics from the tree; saying them once,
       here, is cheaper than it finding out. The identity is a PREAMBLE, above the headings, on
       purpose: stub() reads the file as still-new while `_(nothing yet)_` is present and no
       `## Section` has content, and that is what makes the bootstrap playbook fire on first
       contact. Content in a section would silently switch that off. */
    fs.writeFileSync(md, '# ' + j.name + ' — rules for any AI working here\n\n' +
      'Tier 2. Read after the engine\'s global rules and before each plugin\'s rules; the more\n' +
      'specific file wins.\n\n' +
      '**You are the AI for ' + j.name + '.** This folder is the whole of your job. You are not a\n' +
      'general assistant who happens to be here: you are the one who knows this project, and the\n' +
      'owner is not a developer, so you are also the only one reading its code.\n\n' +
      '- **You keep nothing in your head between turns.** Every thread starts cold. What you learn\n' +
      '  goes into Cockpit — `note` for a standing decision, `tag` for a fact about a thing on the\n' +
      '  map, `grade` for what a value means — or it is lost and the next turn pays to find it again.\n' +
      '- **This file is how you stop starting from nothing.** When you work something out that the\n' +
      '  next turn would otherwise re-derive — how it is built, what the tests need, which command\n' +
      '  runs it — it belongs in the sections below. Keeping it current is part of the job.\n' +
      '- **Look before you answer, and look narrowly.** The map (`nodes`, `edges`), the tickets and\n' +
      '  the tree are all one command away. Fetch what answers the question and no more.\n' +
      '- **Say what you actually found.** An honest "I do not know yet" costs the owner far less\n' +
      '  than a confident answer he has to discover was wrong.\n\n' +
      'Fill the sections below as you learn them. Each one is here because an AI without it guesses.\n\n' +
      '## What this is\n\n' +
      '## Never touched without the owner\'s word\n\n' +
      '## How it is built and checked\n\n' +
      '## Tests\n\n' +
      '## Evidence\n\n' +
      '_(nothing yet)_\n');
  }
  const gi = path.join(cp, '.gitignore');
  /* NOTHING OF .cockpit GOES IN THE REPO (reversing the 2026-09-18 split that put project.md and the plugin answers in it). Ignored also
     means a plain `git clean -fd` cannot reach it: only -fdx sees ignored files. The older seeds are replaced;
     anything a person wrote by hand is left alone. */
  const seed = '# Cockpit keeps this folder; none of it belongs to the codebase\n*\n';
  const OLD_SEEDS = [/^# Cockpit state is not part of the codebase[^\n]*\n\*\n?$/, /^# Cockpit: the contract goes in the repo[\s\S]*plugins\/architecture\.history\.json\n?$/];
  let cur = ''; try { cur = fs.readFileSync(gi, 'utf8'); } catch (e) { /* none yet */ }
  if (!cur || OLD_SEEDS.some((re) => re.test(cur))) fs.writeFileSync(gi, seed);
  return { dir: cp, json: j };
}

function open(id) {
  const have = loaded.get(id);
  if (have) { have.touched = Date.now(); return have; }
  const entry = registry.get(id);
  if (!entry) return null;
  if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) {
    return { entry, missing: true };   // the folder moved or the drive is off; say so, do not invent
  }
  /* THE FOLDER IS GONE: put it back, never write an empty one over the hole (a coder's `git clean` in
     a project deleted .cockpit, untracked and not ignored; the engine opened the project a minute later, created a
     fresh empty one, and 66 tickets, their verdicts, the rules and the conversations went with it). The vault keeps a
     week of hourly copies (engine/backup.js); the newest goes back first, and it is said out loud. */
  let restored = null;
  if (!fs.existsSync(path.join(entry.path, '.cockpit'))) {
    try {
      const r = require('./hot').hot(path.join(__dirname, 'backup.js')).restoreVault(path.join(__dirname, '..'), id, entry.path);
      if (r.ok) { restored = r; console.log('project → ' + id + ': .cockpit was MISSING - put back from the vault copy of ' + String(r.at).slice(0, 16).replace('T', ' ')); }
      else if (r.why && !/no copy kept/.test(r.why)) console.log('project → ' + id + ': .cockpit is missing and the vault copy could not be put back: ' + r.why);
    } catch (e) { console.log('vault restore: ' + e.message); }
  }
  const cockpit = ensureCockpit(entry.path);
  const db = openDb(path.join(cockpit.dir, 'cockpit.db'), path.join(__dirname, 'schema.sql'));
  db.run('INSERT OR REPLACE INTO meta (key, value, at) VALUES (?,?,?)', 'engine', CONFIG.version, db.now());
  const p = { entry, dir: entry.path, cockpit, db, touched: Date.now(), since: new Date().toISOString() };
  loaded.set(id, p);
  try { require('./plugins').ensureSchemas(p); } catch (e) { console.log('plugin schemas: ' + e.message); }
  registry.touch(id);
  console.log('project → opened ' + id + ' (' + entry.path + ')');
  if (restored) { try { require('./hot').hot(path.join(__dirname, 'events.js')).record(p, { kind: 'cockpit.restored', level: 'alert', title: 'the .cockpit folder of this project was missing and has been put back', text: 'from the vault copy of ' + String(restored.at).slice(0, 16).replace('T', ' ') + ' (' + restored.from + '). Anything written to it after that time is not in the copy - a coder deleting the folder (git clean, rm) is how this happens.', source: 'engine' }); } catch (e) { /* */ } }
  return p;
}

function close(id, why) {
  const p = loaded.get(id);
  if (!p) return false;
  try { p.db.close(); } catch (e) { /* already closed */ }
  loaded.delete(id);
  console.log('project → closed ' + id + (why ? ' (' + why + ')' : ''));
  return true;
}

function sweep() {
  const limit = (CONFIG.idleUnloadMinutes || 10) * 60 * 1000;
  for (const [id, p] of loaded) if (Date.now() - p.touched > limit) close(id, 'idle ' + CONFIG.idleUnloadMinutes + ' min');
}

/* A change counter per loaded project. Anything that writes - a scan finishing, a grade, a
   tag, a plugin selected, a turn ending - bumps it, and the shell polls it cheaply so the
   room redraws when the AI changes the map through the cli, not a minute later (owner,
   2026-09-16: "it ran but no map was created" - the map was there, the card had not looked). */
function bump(id) { const p = loaded.get(id); if (p) p.version = (p.version || 0) + 1; }
/* A browser with this project's room open polls /version every 5 s; that is the only signal
   that someone is looking. Timed plugin reads run only while someone is. */
function viewed(id) { const p = loaded.get(id); if (p) p.lastViewed = Date.now(); }
function watched(id, withinMs) { const p = loaded.get(id); return !!(p && p.lastViewed && Date.now() - p.lastViewed < (withinMs || 30000)); }
function version(id) { const p = loaded.get(id); return p ? (p.version || 0) : 0; }
function isLoaded(id) { return loaded.has(id); }
function loadedIds() { return [...loaded.keys()]; }

/* What the shell shows for a project on its room: the .cockpit facts, what is loaded, and
   what is there. No plugins in milestone 1, so no cards beyond the engine's own. */
function describe(id) {
  const p = open(id);
  if (!p) return null;
  const live = registry.get(id) || p.entry; p.entry = live;   // the registry re-reads into new objects after a save (a rename) - follow the live one, not the one held at open (2026-09-20: the room kept saying Home after the rename)
  if (p.missing) return { id, name: live.name, path: live.path, missing: true };
  const cp = p.cockpit.dir;
  const count = (d) => { try { return fs.readdirSync(path.join(cp, d)).length; } catch (e) { return 0; } };
  const size = (f) => { try { return fs.statSync(path.join(cp, f)).size; } catch (e) { return 0; } };
  return {
    id, name: live.name || p.cockpit.json.name, path: p.dir, missing: false,
    // where the folder REALLY is (links and junctions resolved) and on which machine the engine reads it
    realPath: (() => { try { return fs.realpathSync(p.dir); } catch (e) { return p.dir; } })(), host: require('node:os').hostname(),
    cockpit: p.cockpit.json,
    loadedSince: p.since,
    engine: { version: CONFIG.version, idleUnloadMinutes: CONFIG.idleUnloadMinutes },
    contents: {
      'cockpit.json': size('cockpit.json'), 'project.md': size('project.md'), 'cockpit.db': size('cockpit.db'),
      plugins: count('plugins'), conversations: count('conversations'), decisions: count('decisions'),
      logs: count('logs'), cache: count('cache')
    },
    threads: p.db.get('SELECT count(*) n FROM chat_thread').n,
    // the standing prompt each turn carries, by tier, and the rulings conversations have recorded
    prompt: (() => { try { return require('./prompt').sizes(path.join(__dirname, '..'), p); } catch (e) { return null; } })(),
    rulings: (() => { try { return p.db.all('SELECT n.id, n.text, n.by, n.at, n.thread_id, t.title FROM chat_note n LEFT JOIN chat_thread t ON t.id = n.thread_id ORDER BY n.id DESC LIMIT 50'); } catch (e) { return []; } })(),
    plugins: require('./plugins').forRoom(p),
    version: p.version || 0,
    generated: new Date().toISOString()
  };
}

module.exports = { init, open, close, describe, isLoaded, loadedIds, ensureCockpit, sweep, bump, version, viewed, watched };
