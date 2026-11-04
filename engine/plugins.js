/* Plugins (docs/generic-ide.md §3). A plugin is one folder under <engine>\plugins\<name>\:

     plugin.json   { name, label, purpose, questions: [...], cards: [...], scan: 'scan.js' }
     rules.md      tier-3 prompt rules (read by prompt.js)
     cards\*.js    shell cards, served at /plugins/<name>/cards/<file>, loaded only when selected
     scan.js       populates the project's tables; run as a child process so a slow walk of a
                   network share can never block the engine
     schema.sql    the plugin's own tables, prefixed

   Selecting a plugin for a project = the wizard's answers written to
   <project>\.cockpit\plugins\<name>.json and the name added to cockpit.json. Deselecting
   removes the name; the answers file stays so re-selecting remembers them. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

let DIR = null;
const manifests = {};

/* Manifests are re-read whenever plugin.json changes on disk (a renamed wizard option sat
   unseen until a restart, 2026-09-16) - and a new plugin folder appears without one too. */
const mtimes = {};
function reread() {
  if (!DIR || !fs.existsSync(DIR)) return;
  for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = path.join(DIR, d.name, 'plugin.json');
    let mt; try { mt = fs.statSync(file).mtimeMs; } catch (e) { continue; }
    if (mtimes[file] === mt) continue;
    try { const m = JSON.parse(fs.readFileSync(file, 'utf8')); m.name = m.name || d.name; m.dir = path.join(DIR, d.name); manifests[m.name] = m; mtimes[file] = mt; }
    catch (e) { console.error('plugin ' + d.name + ': bad plugin.json - ' + e.message); mtimes[file] = mt; }
  }
}
function load(engineRoot) {
  DIR = path.join(engineRoot, 'plugins');
  reread();
  return Object.keys(manifests);
}
/* group: "coding" puts a plugin behind the engine-wide Coding switch (engine/config.js codingOn) - off, the shell shows
   neither the plugin nor its cards and tabs */
function all() { reread(); return Object.values(manifests).map((m) => ({ name: m.name, label: m.label, purpose: m.purpose, group: m.group || null, questions: m.questions || [], cards: m.cards || [], libs: m.libs || [], hasScan: !!m.scan, always: !!m.always, core: !!m.core })); }   // libs: another plugin's scripts this one's pages are built on (the Tests tab on Architecture's page kit) - loaded whether that plugin is on or not
function get(name) { reread(); return manifests[name] || null; }

function answersFile(p, name) { return path.join(p.cockpit.dir, 'plugins', name + '.json'); }
/* configured = its answers are in: a file with every required question answered, or nothing required to begin with. A required
   answer left blank (the four Tickets places saved empty, 2026-09-20) leaves the plugin asking, not silently running on blanks. */
function complete(m, ans) { const qs = m.questions || []; if (ans) return !qs.some((q) => q.required && !String(ans[q.key] == null ? '' : ans[q.key]).trim()); return !qs.some((q) => !q.optional); }
function answers(p, name) { try { return JSON.parse(fs.readFileSync(answersFile(p, name), 'utf8')); } catch (e) { return null; } }
/* a plugin with "always": true is on for every project and cannot be switched off - the ticket process is one
   (the process is the engine's, GitHub is only a connection) */
/* The map is the engine's, not a plugin's: a manifest marked `core`
   has its scan run for EVERY project - on add, after a turn, after a test run, on the Tests tab's ↻ - whether or not the
   plugin is selected. Selecting it only shows its cards and tab. scanned(p) is the list the scan loops walk. */
/* With the Coding switch off (engine/config.js codingOn) the map is not read behind the person's back: nobody sees it, and a
   folder of documents need not be walked every few minutes. A plugin the project switched on itself still scans. */
function scanned(p) { const on = selected(p); if (!require('./config').codingOn(path.dirname(DIR))) return on; for (const n of Object.keys(manifests)) if (manifests[n].core && manifests[n].scan && !on.includes(n)) on.push(n); return on; }
/* what kind of project a folder is, read from what is in it - the Architecture wizard's answer wins when there is one */
function detectType(dir) {
  const has = (f) => { try { return fs.existsSync(path.join(dir, f)); } catch (e) { return false; } };
  if (has('package.json') || has('tsconfig.json') || has('pnpm-workspace.yaml')) return 'typescript';
  if (has('composer.json') || has('index.php')) return 'website-php';
  let names = []; try { names = fs.readdirSync(dir); } catch (e) { /* */ }
  if (names.some((n) => /\.php$/i.test(n))) return 'website-php';
  if (has('.obsidian') || (names.filter((n) => /\.md$/i.test(n)).length >= 5 && !names.some((n) => /\.(js|ts|php|py)$/i.test(n)))) return 'markdown';
  return 'website-php';
}
function selected(p) {
  // 2026-09-20: the Tests tab moved from Tickets to Coding; a project that had the process on keeps its tab (once, saved)
  if ((p.cockpit.json.plugins || []).includes('tickets') && !(p.cockpit.json.plugins || []).includes('coding') && manifests.coding) { p.cockpit.json.plugins.push('coding'); try { saveCockpitJson(p); } catch (e) { /* */ } }
  const on = (p.cockpit.json.plugins || []).filter((n) => manifests[n]); for (const n of Object.keys(manifests)) if (manifests[n].always && !on.includes(n)) on.push(n); return on; }

function saveCockpitJson(p) { fs.writeFileSync(path.join(p.cockpit.dir, 'cockpit.json'), JSON.stringify(p.cockpit.json, null, 2) + '\n'); }

function select(p, name, ans) {
  const m = manifests[name];
  if (!m) throw new Error('no such plugin: ' + name);
  // Turning a never-configured plugin on with no answers does not make it "configured":
  // its card asks for them. Answers are written only when there are some, or some already were.
  const existing = answers(p, name);
  if (existing || (ans && Object.keys(ans).length)) fs.writeFileSync(answersFile(p, name), JSON.stringify({ ...(existing || {}), ...(ans || {}), selectedAt: new Date().toISOString() }, null, 2) + '\n');
  if (!p.cockpit.json.plugins.includes(name)) p.cockpit.json.plugins.push(name);
  if (m.setsType && ans && ans.type) p.cockpit.json.type = ans.type;
  saveCockpitJson(p);
  const schema = path.join(m.dir, 'schema.sql');
  if (fs.existsSync(schema)) p.db.exec(fs.readFileSync(schema, 'utf8'));
  return answers(p, name);
}
function deselect(p, name) {
  p.cockpit.json.plugins = (p.cockpit.json.plugins || []).filter((n) => n !== name);
  saveCockpitJson(p);
}

/* For the room: what this project selected, with answers, plus the card scripts to load. */
function forRoom(p) {
  const sel = selected(p);
  return {
    available: all().map((m) => { const ans = answers(p, m.name); return { ...m, questions: m.questions.map((q) => prefill(p, q)), selected: sel.includes(m.name), configured: complete(m, ans), answers: ans, lastScan: lastScan(p, m.name) }; }),   // no questions, or only optional ones = nothing to configure
    cards: sel.flatMap((n) => (manifests[n].cards || []).map((c) => '/plugins/' + n + '/' + c))
  };
}
/* a question's default that is the project's own fact, filled in per project: the folder it is in, the site url it declared */
function prefill(p, q) {
  if (q.key === 'devPath') return { ...q, default: p.dir };
  if (q.key === 'devUrl') return { ...q, default: (((p.cockpit && p.cockpit.json) || {}).urls || [])[0] || '' };
  return q;
}
function lastScan(p, name) { try { return p.db.get('SELECT * FROM scan_run WHERE plugin = ? ORDER BY id DESC LIMIT 1', name) || null; } catch (e) { return null; } }

/* Run a plugin's scan in a child process. The child gets the project folder, the database
   path and the answers; it writes to the database itself (WAL lets the engine keep reading)
   and prints one JSON line at the end with what it yielded. The engine records the run. */
const runs = new Map();   // key project:plugin -> child
function scan(p, name, log) {
  const m = manifests[name];
  if (!m || !m.scan) throw new Error('plugin ' + name + ' has no scan');
  const key = p.entry.id + ':' + name;
  if (runs.has(key)) return { ok: false, error: 'already running' };
  const started = p.db.now();
  const r = p.db.run('INSERT INTO scan_run (plugin, started) VALUES (?,?)', name, started);
  const runId = Number(r.lastInsertRowid);
  // a core scan with no wizard answers runs on the detected project type (recorded once on cockpit.json, where the wizard would put it)
  let ans = answers(p, name) || {};
  if (m.core && m.setsType && !ans.type) { if (!p.cockpit.json.type) { p.cockpit.json.type = detectType(p.dir); try { saveCockpitJson(p); } catch (e) { /* */ } } ans = { ...ans, type: p.cockpit.json.type }; }
  const child = cp.fork(path.join(m.dir, m.scan), [p.dir, path.join(p.cockpit.dir, 'cockpit.db'), JSON.stringify(ans)], { cwd: m.dir, silent: true, execArgv: ['--no-warnings'], env: { ...process.env, ...require('./ghauth').envFor(p) } });   // the project's GitHub account (engine/ghauth.js)
  runs.set(key, child);
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; if (log) log('[' + name + '] ' + String(d).trim()); });
  child.on('close', (code) => {
    runs.delete(key);
    try { require('./projects').bump(p.entry.id); } catch (e) { /* project may have closed */ }
    let yields = null, note = '';
    const last = out.trim().split('\n').pop();
    try { const j = JSON.parse(last); yields = j.yields || j; note = j.note || ''; } catch (e) { note = (err || out).trim().slice(-400); }
    try { p.db.run('UPDATE scan_run SET finished = ?, ok = ?, note = ?, yields = ? WHERE id = ?', p.db.now(), code === 0 ? 1 : 0, note, yields ? JSON.stringify(yields) : null, runId); } catch (e) { /* project may have closed */ }
    // the moves evidence makes on the tickets (Phase 4): promoted when the promote's commits name one, closed when its finding is gone
    if (code === 0) { try { require('./hot').hot(path.join(__dirname, 'tickets.js')).afterScan(p, (t) => console.log('[' + p.entry.id + '] ' + t)); } catch (e) { console.error('tickets after scan: ' + e.message); } }
    if (code === 0 && name === 'tickets') { try { require('./hot').hot(path.join(__dirname, 'promote.js')).observe(p, (t) => console.log('[' + p.entry.id + '] ' + t)); } catch (e) { console.error('promote observe: ' + e.message); } }   // an observed environment reported a version
    if (log) log('[' + name + '] scan ' + (code === 0 ? 'done' : 'FAILED (' + code + ')') + (yields ? ' ' + JSON.stringify(yields) : '') + (note ? ' - ' + note.slice(0, 200) : ''));
  });
  return { ok: true, run: runId };
}
function scanning(p, name) { return runs.has(p.entry.id + ':' + name); }

/* NAMED QUERIES: how a plugin's cards read the plugin's own tables. <plugin>\queries.json is
   { "<name>": { "sql": "SELECT ... WHERE (? IS NULL OR who = ?)", "params": ["who", "who"] } }
   - read-only SQL the plugin author wrote, parameters by name from the query string, in the
   order `params` lists them. No SQL travels from the browser. Read on every call: edit the
   file, no restart. */
function query(p, name, q, params) {
  const m = manifests[name]; if (!m) throw new Error('no such plugin: ' + name);
  let defs; try { defs = JSON.parse(fs.readFileSync(path.join(m.dir, 'queries.json'), 'utf8')); } catch (e) { throw new Error(name + ' has no queries.json (' + e.message + ')'); }
  const d = defs[q]; if (!d || !d.sql) throw new Error(name + ' has no query "' + q + '"');
  if (!/^\s*(SELECT|WITH)\b/i.test(d.sql)) throw new Error('query "' + q + '" is not a read');
  const args = (d.params || []).map((k) => (params[k] === undefined || params[k] === '' ? null : params[k]));
  return p.db.all(d.sql, ...args);
}

/* TIMED SCANS: a plugin whose manifest says `"every": <minutes>` is rescanned on that cadence
   for every loaded project that selected it - but ONLY while a browser has that project's
   room open: current when someone is looking, silent otherwise. The
   first look after a quiet spell reads at once if the last read is older than `every`.
   One engine-level timer; a scan already running is never doubled. */
function startTimers(projects) {
  setInterval(() => {
    for (const id of projects.loadedIds()) {
      if (!projects.watched(id, 30000)) continue;   // nobody has this room open right now
      let p; try { p = projects.open(id); } catch (e) { continue; }
      for (const name of scanned(p)) {
        const m = manifests[name]; if (!m || !m.scan || scanning(p, name)) continue;
        const last = lastScan(p, name);
        // a core scan that has never run happens the first time the project is looked at; a timed one when its `every` is up
        const due = m.core && (!last || !last.finished) ? true : m.every ? (!last || !last.finished || (Date.now() - Date.parse(last.finished)) > m.every * 60000) : false;
        if (due) { try { scan(p, name, console.log); } catch (e) { console.log('[' + name + '] timed scan: ' + e.message); } }
      }
    }
  }, 15 * 1000).unref();   // checked often so the first look after a quiet spell reads within seconds
}

/* Every selected plugin's tables exist from the moment a project opens - CREATE IF NOT EXISTS, cheap and
   idempotent - so a card never reads before the schema is there. Before this, the schema was applied only when the plugin was selected and
   when its scan ran. */
function ensureSchemas(p) {
  for (const name of selected(p)) { const f = path.join(manifests[name].dir, 'schema.sql'); if (fs.existsSync(f)) { try { p.db.exec(fs.readFileSync(f, 'utf8')); } catch (e) { console.log('[' + name + '] schema: ' + e.message); } } }
}
module.exports = { load, all, get, selected, scanned, detectType, answers, complete, select, deselect, forRoom, scan, scanning, lastScan, query, startTimers, ensureSchemas };
