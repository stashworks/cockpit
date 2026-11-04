#!/usr/bin/env node
/* Cockpit engine entry. `node .` serves the shell; no project is loaded until one is opened.
   The engine keeps ONE file of its own state, projects.json (the folders it has been shown).
   Everything else lives in each project's .cockpit\ (docs/generic-ide.md §1). */
'use strict';
process.removeAllListeners('warning'); // node:sqlite's experimental warning is noise for the operator
const path = require('node:path');
const { loadEngineConfig } = require('./engine/config');
const registry = require('./engine/registry');
const projects = require('./engine/projects');
const { serve } = require('./engine/server');
const harness = require('./engine/harness');
const plugins = require('./engine/plugins');

const root = __dirname;
/* STARTED HIDDEN (start.ps1, 2026-10-08) there is no window to print to: COCKPIT_LOG_FILE names a file, and everything the
   engine says goes there instead. Over 5 MB at start, the old one is kept as .1 and a new one begun. */
if (process.env.COCKPIT_LOG_FILE) {
  const fs = require('node:fs'), util = require('node:util'), file = process.env.COCKPIT_LOG_FILE;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); if (fs.existsSync(file) && fs.statSync(file).size > 5e6) fs.renameSync(file, file + '.1'); } catch (e) { /* keep going */ }
  const out = fs.createWriteStream(file, { flags: 'a' });
  const write = (...a) => { try { out.write(new Date().toISOString().slice(0, 19).replace('T', ' ') + '  ' + util.format(...a) + '\n'); } catch (e) { /* nowhere else to say it */ } };
  console.log = write; console.error = write; console.warn = write; console.info = write;
}
/* THE TOOLS MUST BE FINDABLE HOWEVER THE ENGINE IS STARTED. Under a Windows service (PM2's
   "Node server", 2026-09-17) the PATH is the machine's, not the owner's - and gh (WinGet),
   codex (npm global) and claude (~\.local\bin) all live in per-user folders. The GitHub read
   came back "0 open tickets" with every gh call failing. So the folders those installers use
   are appended here once; every child (scans, harness turns) inherits them (engine/pathfix.js; the wizard
   runs it again after an install). */
require('./engine/pathfix').widen(console.log);
/* THE ENGINE'S LAST WORDS ARE KEPT. It died at 14:33 on 2026-09-21 as a bare `node .` in a window - PM2 had not been
   running it since the 17th - and nothing recorded why. Now an uncaught error or an unhandled promise is written to
   logs\crash.log (with the stack and the time) before the process ends, and the same file gets one line at every
   start and every clean stop, so the gap between them is always readable. Node ends the process on these regardless;
   this only makes sure the reason is on disk. */
(function keepLastWords() {
  const fs = require('node:fs'); const dir = path.join(root, 'logs'); const file = path.join(dir, 'crash.log');
  const line = (kind, e) => { try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, new Date().toISOString() + ' ' + kind + (e ? ': ' + (e && e.stack || String(e)) : '') + '\n'); } catch (x) { /* nothing left to do */ } };
  line('start pid ' + process.pid + ' node ' + process.version);
  process.on('uncaughtException', (e) => { line('UNCAUGHT EXCEPTION', e); console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => { line('UNHANDLED REJECTION', e); console.error(e); process.exit(1); });
  process.on('exit', (code) => line('exit code ' + code));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { try { process.on(sig, () => { line('signal ' + sig); process.exit(0); }); } catch (x) { /* not on this platform */ } }
})();
const config = loadEngineConfig(root);
/* the cli every AI turn runs (cli.js) finds the engine through COCKPIT_URL; children inherit it, so an engine on another
   port is the one its own turns talk to */
if (!process.env.COCKPIT_URL) process.env.COCKPIT_URL = 'http://localhost:' + config.port;
registry.load(root);
/* HOME ON A FRESH MACHINE (2026-10-08): the front door is the project with the id "home". A new install had none, so it
   opened on an empty "No project" screen. Make one in the Cockpit folder (home\, never committed) the first time; its
   Welcome card connects your folders and asks your name. A Home already registered is left alone. */
if (!registry.get('home')) {
  try {
    const dir = path.join(root, 'home'); require('node:fs').mkdirSync(dir, { recursive: true });
    const e = registry.add(dir, 'Home');
    console.log(e.id === 'home' ? 'home → created at ' + dir : 'home → could not take the id "home" (got ' + e.id + ')');
  } catch (err) { console.log('home → not created: ' + err.message); }
}
projects.init(config);
console.log('harnesses → ' + harness.load(path.join(root, 'engine')).join(', '));
console.log('plugins → ' + (plugins.load(root).join(', ') || 'none'));
harness.importOldTurns(root);           // once per project: turns logged before the ledger existed
require('./engine/fleet').load(root);   // the owner's agents and the one queue; every agent starts OFF
console.log('fleet → loaded (agents off until switched on)');
serve(config, root);
plugins.startTimers(projects);
// leftover working copies beside each project, cleared at start (engine/sweep.js) - after a minute, off the start path
setTimeout(() => { for (const e of registry.all()) { try { const p = projects.open(e.id); if (p && !p.missing) require('./engine/sweep').run(p); } catch (err) { /* */ } } }, 60000);          // plugins with `every` minutes (a GitHub feed) rescan on their own
