/* HTTP: the shell (static) and the JSON API. Node built-ins only.

   Routes
     GET  /                         the shell; no project selected
     GET  /:project                 the shell, opened on that project (§13: the URL carries it)
     GET  /api/engine               version, loaded projects, uptime
     GET  /api/projects             every registered project, with loaded=true/false
     POST /api/projects {path,name} register a folder (creates its .cockpit\) and open it
     DELETE /api/projects/:id       forget a folder (never touches it)
     GET  /api/fs?path=             directory listing, for the open-folder dialog
     GET  /api/p/:id/room           what the control room shows for that project
     GET  /api/p/:id/events         what happened in it (engine/events.js); POST events/seen {ids|all}
     GET  /api/home/events          the same across every project, for Home; POST /api/home/events/seen
     GET  /api/p/:id/layout?person= that person's card layout for that project
     POST /api/p/:id/layout?person= save it
     POST /api/p/:id/close          let it go quiet now rather than at the idle limit
     GET  /api/harnesses            the harnesses this engine can run, and their models
     GET  /api/p/:id/chat/threads   the project's conversations
     POST /api/p/:id/chat/threads   start one {title}
     GET  /api/p/:id/chat/thread?id= one conversation with its turns and rulings
     POST /api/p/:id/chat/send      {thread, text, harness, model} -> {turn}; the turn runs
     GET  /api/p/:id/chat/events?turn= server-sent events for that turn, replayed then live
     POST /api/p/:id/chat/stop      {turn}
     POST /api/p/:id/chat/note      {thread, text} record a standing ruling
     GET  /api/p/:id/plugins        available plugins, which are selected, their answers, last scan
     POST /api/p/:id/plugins/:name/select   {answers}   the wizard's answers; selects it
     POST /api/p/:id/plugins/:name/deselect
     POST /api/p/:id/plugins/:name/scan     run its scan (child process)
     GET  /api/p/:id/graph?lens=&parent=    the lens engine: children of a node, coloured
     GET  /api/p/:id/graph/lenses
     GET  /api/p/:id/graph/node?subject=    one node and everything that touches it
     POST /api/p/:id/graph/grade    {ns, value, band, label, why}  a human grades a value
     GET  /plugins/<name>/cards/*.js  a selected plugin's cards

   Every /api/p/:id/* call opens the project if it is not loaded and touches its idle clock.
   That is what "start on demand" means in practice: the shell polling a room keeps a
   project warm; closing the tab lets it cool. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('./registry');
const projects = require('./projects');
const harness = require('./harness');
const plugins = require('./plugins');
/* stateless modules are read from disk on every use, so a fix lands without a restart
   (engine/hot.js); the proxy forwards each property to the current module */
const live = (file) => new Proxy({}, { get: (_, k) => require('./hot').hot(path.join(__dirname, file))[k] });
/* every save of a project's cockpit.json starts from the file, not only the copy held in memory since the project was opened:
   a line set by hand meanwhile ("talk": "open") must survive the next save of the name, the AI or the backup switch */
function freshCockpitJson(p) { try { Object.assign(p.cockpit.json, JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'cockpit.json'), 'utf8'))); } catch (e) { /* the memory copy stands */ } }
const conv = live('conversation.js');
const graphMod = live('graph.js');
const remote = live('remote.js');
const declared = live('declared.js');
const tests = live('tests.js');
const dast = live('dast.js');
const tickets = live('tickets.js');
const promote = live('promote.js');   // the one promoter: passed → the next environment (git, or observed)   // Phase 4: the ticket file, the impact analysis, GitHub when on
const backup = live('backup.js');   // every project's code and database, copied when they change, the newest 14 kept (engine/backup.js)
const ext = live('ext.js');   // a project's own data program, called by its cards (engine/ext.js) - the one doorway, so new commands need no restart
let toolsFetch = null;   // the running tools/fetch.js, when one is   // ZAP from this folder, against the app on the test database - only when asked   // Cockpit's test runner (Phase 3): run a project's tests, keep the report   // the mapping file: declarations held outside the code (Phase 2)   // Remote Control (Claude Code's) for a project - hot, so the first tries need no restart

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const STARTED = Date.now();
/* The engine runs on another machine and is restarted by hand; a change to a module that is not hot-loaded sits on
   disk doing nothing until then (2026-09-20: a ten-minute gap cost an afternoon of "why is the tab blank"). The shell
   asks and says so in the footer. Hot modules (engine/hot.js, live() above) land on their own and are not counted. */
const HOT = ['conversation.js', 'dast.js', 'declared.js', 'doctrine.js', 'events.js', 'graph.js', 'promote.js', 'prompt.js', 'remote.js', 'tests.js', 'tickets.js', 'verify.js', 'backup.js', 'wake.js', 'flow.js'];   // flow.js: the test's own process requires it fresh each run - never loaded by the engine, never stale
function staleFiles() { try { return fs.readdirSync(__dirname).filter((f) => /\.js$/.test(f) && !HOT.includes(f) && fs.statSync(path.join(__dirname, f)).mtimeMs > STARTED); } catch (e) { return []; } }

function readBody(req, max) {
  if (req._body) return req._body;   // read once: the scope check (engine/scope.js) may need the body before the route does
  return (req._body = new Promise((resolve, reject) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > (max || 1e6)) req.destroy(); }); req.on('end', () => resolve(s)); req.on('error', reject); }));
}

/* A directory listing for the open-folder dialog. A browser page cannot browse the server's
   disk on its own, so the engine lists one level at a time: drives when no path is given
   (Windows), otherwise the subfolders of that path. Files are not listed - the dialog picks
   folders. Never follows into what it cannot read; it says so instead. */
function listDir(p) {
  if (!p) {
    if (process.platform === 'win32') {
      const drives = [];
      for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const d = L + ':\\'; try { fs.readdirSync(d); drives.push({ name: d, path: d, dir: true }); } catch (e) { /* not present */ } }
      return { path: '', parent: null, entries: drives };
    }
    p = '/';
  }
  const abs = path.resolve(p);
  let names;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return { path: abs, parent: path.dirname(abs), entries: [], error: e.code || e.message }; }
  /* Links and junctions are listed too, marked, with where they really go - a folder that is
     secretly somewhere else is exactly the thing an owner needs to see (2026-09-16). */
  const entries = names.filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('$') && d.name !== 'System Volume Information')
    .map((d) => { const full = path.join(abs, d.name); let real = null; if (d.isSymbolicLink()) { try { real = fs.realpathSync(full); } catch (e) { real = '(broken link)'; } } return { name: d.name, path: full, dir: true, link: d.isSymbolicLink() ? real : undefined, cockpit: fs.existsSync(path.join(full, '.cockpit')) }; })
    .filter((e) => e.link === undefined || (e.link !== '(broken link)' && fs.existsSync(e.link) && fs.statSync(e.link).isDirectory()) || e.link === '(broken link)')
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(abs) === abs ? '' : path.dirname(abs);
  let realPath = abs; try { realPath = fs.realpathSync(abs); } catch (e) { /* as given */ }
  return { path: abs, realPath, host: require('node:os').hostname(), parent, entries, isCockpit: fs.existsSync(path.join(abs, '.cockpit')) };
}

/* engine.json beside index.js: the few engine-wide things the browser switches (the wizard's answers, the Getting started
   checklist, the Coding plugin) - read fresh each time, so a switch needs no restart */
function readEngineJson(root) { try { return JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8').replace(/^﻿/, '')); } catch (e) { return {}; } }
function writeEngineJson(root, patch) { const f = Object.assign(readEngineJson(root), patch); fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify(f, null, 2) + '\n'); return f; }

function serve(config, root) {
  const shellDir = path.join(root, 'shell');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    try {
      /* WHO MAY CHANGE WHAT (engine/scope.js): every request that changes something names the project it touches, and the
         caller must be the owner's browser, Home's AI, or that project's own AI. */
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        const scope = require('./scope'), who = scope.caller(req), fl = require('./fleet');
        const targets = [];
        const pp = url.pathname.match(/^\/api\/p\/([^/]+)(?:\/(.*))?$/);
        const fi = url.pathname.match(/^\/api\/fleet\/items\/(\d+)$/);
        const itemProject = (id) => { const it = (fl.state().items || []).find((x) => x.id === Number(id)); return it ? it.project : null; };
        let removal = false;
        if (pp) {
          targets.push(decodeURIComponent(pp[1]));
          if (/^tickets\/[A-Za-z0-9]+\/(state|reject)$/.test(pp[2] || '')) { const raw = await readBody(req); removal = /closed|reject|delet|cancel|drop/i.test(raw); }
        } else if (/^\/api\/projects\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
          targets.push(decodeURIComponent(url.pathname.split('/').pop()));   // a project renaming itself (cli project-set)
        } else if (url.pathname === '/api/fleet/usage/refresh') {
          // a reading, not a change
        } else if (url.pathname === '/api/fleet/items') {
          const b = JSON.parse(await readBody(req) || '{}'); targets.push(String(b.project || '*'));
        } else if (fi) {
          const pr = itemProject(fi[1]); if (pr) targets.push(pr);
          if (req.method === 'DELETE') removal = true;
          else { const b = JSON.parse(await readBody(req) || '{}'); if (b.project) targets.push(String(b.project)); if (/closed|failed/.test(String(b.status || ''))) removal = true; }
        } else if (url.pathname === '/api/fleet/reorder') {
          const b = JSON.parse(await readBody(req) || '{}'); (b.ids || []).forEach((id) => { const pr = itemProject(id); if (pr) targets.push(pr); });
        } else targets.push('*');
        /* NO TICKETS AND NO CODERS where the Tickets plugin is off - an AI may not draft, file or approve a ticket there, nor put work on
           the coders' queue for it. The owner on screen still can. engine/prompt.js tells the AI the same. */
        if (who.who === 'ai') {
          const ticketWrite = pp && req.method === 'POST' && /^tickets(\/draft|\/adopt)?$|^tickets\/[A-Za-z0-9]+\/approve$/.test(pp[2] || '');
          const queueAdd = url.pathname === '/api/fleet/items' && req.method === 'POST';
          const tp = pp ? decodeURIComponent(pp[1]) : queueAdd ? String((JSON.parse(await readBody(req) || '{}')).project || '') : '';
          if ((ticketWrite || queueAdd) && tp) { const pr = projects.open(tp); if (pr && !pr.missing && require('./prompt').ticketsOff(pr)) { console.log('scope → refused ' + url.pathname + ' for ' + tp + ': Tickets plugin off'); return json({ ok: false, error: 'refused: project ' + tp + ' does not use tickets or the coders (its Tickets plugin is off). Make the change directly in this conversation.' }, 403); } }
        }
        const bad = targets.find((t) => !scope.allows(who, t));
        if (bad !== undefined) { console.log('scope → refused ' + req.method + ' ' + url.pathname + ' from ' + (who.project || who.who) + ' (touches ' + bad + ')'); return json({ ok: false, error: scope.refusal(who, bad) }, 403); }
        if (removal && !scope.bulkOk(who)) {
          const msg = (who.project || 'an AI') + ' tried to remove more than ' + scope.BULK_MAX + ' things in ' + scope.BULK_WINDOW_MIN + ' minutes - refused; a mass removal is for the owner to do on screen';
          console.log('scope → ' + msg);
          try { const tp = projects.open(targets[0]); if (tp && !tp.missing) require('./events').record(tp, { kind: 'scope.bulk', level: 'alert', title: msg, text: req.method + ' ' + url.pathname, source: 'engine' }); } catch (e) { /* the refusal stands */ }
          return json({ ok: false, error: 'refused: ' + msg + '. Tell the owner what you were asked to remove; he can do it himself.' }, 429);
        }
      }
      /* THE FIRST-RUN WIZARD (engine/wizard.js; shell/wizard.js). Reading is open to the page; every change is the owner's
         browser only - never an AI's key, even Home's: installing software, moving the port and stopping the engine are
         not things an AI turn does. */
      if (url.pathname.startsWith('/api/wizard') || url.pathname === '/api/engine/stop') {
        const wz = require('./wizard'); wz.init(root, config);
        if (url.pathname === '/api/wizard' && req.method === 'GET') return json(wz.state());
        if (req.method !== 'POST') return json({ ok: false, error: 'POST' }, 405);
        if (require('./scope').caller(req).who !== 'owner') return json({ ok: false, error: 'only you, in the browser, can do this' }, 403);
        const b = JSON.parse(await readBody(req) || '{}');
        if (url.pathname === '/api/engine/stop') return json(wz.stop());
        if (url.pathname === '/api/wizard/install') return json(wz.install(String(b.what || '')));
        if (url.pathname === '/api/wizard/signin') return json(wz.signin());
        if (url.pathname === '/api/wizard/startup') return json(await wz.startup(!!b.on));
        if (url.pathname === '/api/wizard/done') return json(wz.done(b.done !== false));
        if (url.pathname === '/api/wizard/port') { const r = await wz.setPort(b.port); json(r); if (r.ok && r.restart) wz.restart(); return; }
        return json({ ok: false, error: 'no such call' }, 404);
      }
      /* the engine-wide Coding plugin (engine/config.js codingOn): every coding/DevOps card, tab and plugin behind one switch */
      if (url.pathname === '/api/engine/coding' && req.method === 'POST') {
        if (require('./scope').caller(req).who !== 'owner') return json({ ok: false, error: 'only you, in the browser, can do this' }, 403);
        const b = JSON.parse(await readBody(req) || '{}');
        writeEngineJson(root, { coding: b.on === true });
        console.log('coding → ' + (b.on === true ? 'on' : 'off'));
        return json({ ok: true, coding: require('./config').codingOn(root) });
      }
      if (url.pathname === '/api/engine') return json({ ok: true, closeSafe: true, coding: require('./config').codingOn(root), version: config.version, host: config.host, port: config.port, person: config.person, missionSource: (process.env.COCKPIT_MISSION_SOURCE || config.missionSource || null), boxedCards: (() => { try { return require('./ext').boxed(); } catch (e) { return []; } })(), uptimeSec: Math.round((Date.now() - STARTED) / 1000), loaded: projects.loadedIds(), stale: staleFiles(), at: new Date().toISOString() });
      /* GETTING STARTED - what this machine still needs, in the order to do it (the conversation card shows it the first time,
         and whenever something required is missing). Each line is checked live; tool versions come from the same 10-minute
         cache the harnesses use, so asking is cheap. */
      if (url.pathname === '/api/setup') {
        const v = require('./spawn-cli').versionOf, os = require('node:os');
        const nodeMajor = Number(process.versions.node.split('.')[0]);
        const git = v('git'), claude = v('claude');
        const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
        const signedIn = !!process.env.ANTHROPIC_API_KEY || fs.existsSync(credFile);
        let playwright = false; try { require.resolve('playwright', { paths: [path.join(__dirname, '..')] }); playwright = true; } catch (e) { /* not installed */ }
        const browsers = fs.existsSync(path.join(__dirname, '..', 'browsers')) && fs.readdirSync(path.join(__dirname, '..', 'browsers')).some((d) => /^chromium/.test(d));
        const gh = v('gh'), codex = v('codex'), ollama = v('ollama');
        const required = [
          { id: 'node', title: 'Node.js 24 or newer', ok: nodeMajor >= 24, have: process.version, how: 'Install from nodejs.org (LTS 24+), then restart Cockpit.' },
          { id: 'git', title: 'Git', ok: git.ok, have: git.ok ? git.why : null, how: 'Install from git-scm.com, then restart Cockpit. Every project is a git folder.' },
          { id: 'claude', title: 'Claude Code installed', ok: claude.ok, have: claude.ok ? claude.why : null, how: 'Install Claude Code (docs.anthropic.com/en/docs/claude-code), so `claude` runs in a terminal. Cockpit checks again within 10 minutes, or restart it.' },
          { id: 'claude-login', title: 'Claude Code signed in', ok: claude.ok && signedIn, have: signedIn ? (process.env.ANTHROPIC_API_KEY ? 'API key (billed separately)' : 'signed in') : null, how: 'In a terminal, run `claude` once and sign in (your Claude plan), or set ANTHROPIC_API_KEY. Each reply here says which one it used.' },
          // Home (made at first start, index.js) is not "your first project" - count the folders you connected
          (() => { const n = registry.all().filter((p) => p.id !== 'home').length; return { id: 'project', title: 'Connect your first folder', ok: n > 0, have: n ? n + ' project(s)' : null, how: 'On Home, the Projects card: "Connect a folder…" (or the project switcher, top left). Cockpit creates its .cockpit folder inside it, then the AI asks what you want to use it for.' }; })()
        ];
        const optional = [
          { id: 'gh', title: 'GitHub CLI (gh), signed in', ok: gh.ok, have: gh.ok ? gh.why : null, how: 'Only for the GitHub plugin: install from cli.github.com, then run `gh auth login`.' },
          { id: 'playwright', title: 'Browser checks: npm install', ok: playwright, how: 'Only for browser flows, `look` screenshots and security scans: run `npm install` in the Cockpit folder.' },
          { id: 'browsers', title: 'Browser checks: Chromium and ZAP', ok: browsers, how: 'After npm install: `node tools/fetch.js --unpack` (downloads into this folder, nothing system-wide).' },
          { id: 'codex', title: 'Codex CLI (a second AI)', ok: codex.ok, have: codex.ok ? codex.why : null, how: 'Optional: install Codex and sign in; it appears as another AI and coder.' },
          { id: 'ollama', title: 'Ollama (local models)', ok: ollama.ok, have: ollama.ok ? ollama.why : null, how: 'Optional: install Ollama and pull a model; the Pi harness runs it.' }
        ];
        const firstLine = (r) => ({ ...r, have: r.have ? String(r.have).split(/\r?\n/)[0].trim() : null });
        /* ONCE DONE, GONE (2026-10-25): everything required in place, or "Don't show this again" pressed, is remembered in
           engine.json "setupHidden" - for this engine, so no browser, project or new conversation shows it again. */
        const ready = required.every((r) => r.ok);
        const ej = readEngineJson(root); let hidden = ej.setupHidden === true;
        if (ready && !hidden && ej.setupHidden !== false) { writeEngineJson(root, { setupHidden: true }); hidden = true; }
        return json({ ok: true, ready, hidden, required: required.map(firstLine), optional: optional.map(firstLine) });
      }
      // hide it for good, or bring it back (Settings › Engine) - the owner's browser only
      if (url.pathname === '/api/setup/hidden' && req.method === 'POST') {
        if (require('./scope').caller(req).who !== 'owner') return json({ ok: false, error: 'only you, in the browser, can do this' }, 403);
        const b = JSON.parse(await readBody(req) || '{}');
        writeEngineJson(root, { setupHidden: b.hidden !== false });   // false = shown again until hidden by hand
        return json({ ok: true, hidden: b.hidden !== false });
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') return json({ projects: registry.all().map((p) => ({ ...p, loaded: projects.isLoaded(p.id), exists: fs.existsSync(p.path) })) });
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        if (!b.path || !fs.existsSync(b.path) || !fs.statSync(b.path).isDirectory()) return json({ ok: false, error: 'not a folder: ' + (b.path || '') }, 400);
        const entry = registry.add(b.path, b.name);
        const desc = projects.describe(entry.id);
        // the map is read the moment a folder is added (the core scan; engine/plugins.js) - nobody has to turn anything on
        try { const p = projects.open(entry.id); if (p && !p.missing) for (const name of plugins.scanned(p)) { const mf = plugins.get(name); if (mf && mf.core) try { plugins.scan(p, name, console.log); } catch (e) { /* already running */ } } } catch (e) { console.log('first scan: ' + e.message); }
        return json({ ok: true, project: entry, room: desc });
      }
      let m = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
      if (m && req.method === 'PATCH') {   // rename
        const b = JSON.parse(await readBody(req) || '{}'); const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 80) : null;
        if (b.name !== undefined && !name) return json({ ok: false, error: 'a name is needed' }, 400);
        const entry = name ? registry.update(m[1], { name }) : registry.get(m[1]); if (!entry) return json({ ok: false, error: 'no such project' }, 404);
        try {
          const p = projects.open(m[1]);
          if (p && !p.missing) {
            freshCockpitJson(p);
            if (name) p.cockpit.json.name = name;
            // how the AI talks: "open" or "coding" pins it; empty = automatic - full answers until a coding plugin is on (engine/prompt.js talkMode)
            if (b.talk !== undefined) { if (b.talk === 'open' || b.talk === 'coding') p.cockpit.json.talk = b.talk; else delete p.cockpit.json.talk; }
            // the project's URLs
            // tickets off for a project that does not use them - engine/prompt.js drops the ticket rules
            if (b.tickets !== undefined) { if (b.tickets === false) p.cockpit.json.tickets = false; else delete p.cockpit.json.tickets; }
            if (b.urls !== undefined) p.cockpit.json.urls = String(b.urls || '').split(/[\s,]+/).map((u) => u.trim()).filter(Boolean).map((u) => (/^https?:\/\//i.test(u) ? u : 'http://' + u)).slice(0, 8);
            fs.writeFileSync(path.join(p.cockpit.dir, 'cockpit.json'), JSON.stringify(p.cockpit.json, null, 2) + '\n'); projects.bump(m[1]);
          }
        } catch (e) { /* the registry name is enough */ }
        return json({ ok: true, project: entry });
      }
      if (m && req.method === 'DELETE') { projects.close(m[1], 'forgotten'); return json({ ok: registry.remove(m[1]) }); }
      if (url.pathname === '/api/fs') return json(listDir(url.searchParams.get('path') || ''));
      /* the portable test tooling (tools/fetch.js): what is here, and a download+unpack run ON THIS HOST - the engine's
         machine is where the tests run, so that is where the archives belong; the log is tools/dl-fetch.log */
      if (url.pathname === '/api/tools') {
        const ft = require('../tools/fetch'); const st = ft.ready();
        const logFile = path.join(root, 'tools', 'dl-fetch.log'); let tail = ''; try { tail = fs.readFileSync(logFile, 'utf8').replace(/\r/g, '\n').split('\n').filter(Boolean).slice(-6).join('\n'); } catch (e) { /* never run */ }
        if (req.method === 'POST') {
          if (toolsFetch && toolsFetch.exitCode === null) return json({ ok: false, error: 'a download is already running (see tools/dl-fetch.log)' });
          const out = fs.openSync(logFile, 'w');
          toolsFetch = require('node:child_process').spawn(process.execPath, [path.join(root, 'tools', 'fetch.js'), '--unpack'], { cwd: root, stdio: ['ignore', out, out], windowsHide: true });
          toolsFetch.on('exit', () => { try { fs.closeSync(out); } catch (e) { /* */ } });
          return json({ ok: true, note: 'downloading the archives this folder is missing, then unpacking for this machine - about 1 GB the first time; tools/dl-fetch.log shows progress' });
        }
        return json({ ok: true, platform: process.platform, browsers: st.browsers, zap: st.zap, semgrep: !!st.semgrep, missingArchives: st.missingArchives, allArchives: ft.PIECES.map((p) => ({ file: p.file, platform: p.platform, have: fs.existsSync(path.join(root, 'tools', 'dl', p.file)) })), running: !!(toolsFetch && toolsFetch.exitCode === null), log: tail });
      }
      if (url.pathname === '/api/harnesses') return json({ harnesses: harness.list(url.searchParams.get('all') === '1').map((h) => ({ ...h, exclusive: !!harness.EXCLUSIVE[h.name] })), busy: harness.busy(),
        // the added coders, each on its own account, for the header's AI choice
        coders: require('./fleet').state().agents.filter((a) => a.env).map((a) => ({ id: a.id, label: a.label || a.id, harness: a.harness, ok: !!(a.login && a.login.ok) })) });
      /* the tools Cockpit drives, as the owner configures them on Settings › AI: the built-in three cannot be removed,
         only switched off; a custom tool (engine/harnesses/custom.js) is an entry the owner adds and edits here */
      if (url.pathname === '/api/harnesses/tools') {
        const custom = require('./harnesses/custom.js');
        if (req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}'); const j = custom.read(); j.off = j.off || []; j.tools = j.tools || [];
          if (b.op === 'off') { if (!j.off.includes(b.name)) j.off.push(b.name); }
          else if (b.op === 'on') j.off = j.off.filter((n) => n !== b.name);
          else if (b.op === 'remove') j.tools = j.tools.filter((t) => t.name !== b.name);
          else if (b.op === 'save') {
            const t = b.tool || {}; const name = String(t.name || t.label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (!name) return json({ ok: false, error: 'a name is needed' }, 400);
            if (['claude-code', 'codex-cli', 'pi'].includes(name)) return json({ ok: false, error: name + ' is built in' }, 400);
            if (!String(t.command || '').trim()) return json({ ok: false, error: 'the command is needed - what you type in a terminal to run it' }, 400);
            const args = Array.isArray(t.args) ? t.args : String(t.args || '').match(/"[^"]*"|\S+/g) || [];
            const entry = { name, label: String(t.label || name).trim(), command: String(t.command).trim(), args: args.map((a) => a.replace(/^"|"$/g, '')), models: (t.models || []).map((m) => ({ id: String(m.id || '').trim(), label: String(m.label || m.id || '').trim(), contextTokens: Number(m.contextTokens) || 128000 })).filter((m) => m.id), site: String(t.site || '').trim(), signin: String(t.signin || '').trim() };
            if (!entry.models.length) entry.models = [{ id: 'default', label: 'default', contextTokens: 128000 }];
            const i = j.tools.findIndex((x) => x.name === (b.was || name)); if (i >= 0) j.tools[i] = entry; else j.tools.push(entry);
          } else return json({ ok: false, error: 'op?' }, 400);
          custom.write(j); return json({ ok: true, ...custom.read() });
        }
        return json({ ok: true, ...custom.read() });
      }
      if (url.pathname === '/api/harnesses/probe') return json(harness.probe(url.searchParams.get('name'), url.searchParams.get('what') || 'help'));
      /* the models a harness may be asked for: a file per harness beside its adapter, edited from the Settings page
        . Pi's list is Ollama's own and is not edited here. */
      if (url.pathname === '/api/harnesses/models') {
        const name = url.searchParams.get('name'); if (!harness.list(true).some((h) => h.name === name)) return json({ ok: false, error: 'no harness ' + name }, 404);
        const file = path.join(root, 'engine', 'harnesses', name + '.models.json');
        const custom = require('./harnesses/custom.js'); const cj = custom.read(); const ct = (cj.tools || []).find((t) => t.name === name);
        if (ct) {
          if (req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); ct.models = (Array.isArray(b.models) ? b.models : []).map((m) => ({ id: String(m.id || '').trim(), label: String(m.label || m.id || '').trim(), contextTokens: Number(m.contextTokens) || 128000 })).filter((m) => m.id); if (!ct.models.length) return json({ ok: false, error: 'at least one model is needed' }, 400); custom.write(cj); return json({ ok: true, models: ct.models }); }
          return json({ ok: true, editable: true, models: ct.models || [] });
        }
        if (req.method === 'POST') {
          if (!fs.existsSync(file)) return json({ ok: false, error: 'this harness lists its own models; nothing to edit' }, 400);
          const b = JSON.parse(await readBody(req) || '{}'); const models = Array.isArray(b.models) ? b.models : [];
          const clean = models.map((m) => ({ id: String(m.id || '').trim(), label: String(m.label || m.id || '').trim(), contextTokens: Number(m.contextTokens) || 200000 })).filter((m) => m.id);
          if (!clean.length) return json({ ok: false, error: 'at least one model is needed' }, 400);
          const cur = JSON.parse(fs.readFileSync(file, 'utf8')); cur.models = clean; fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
          return json({ ok: true, models: clean });
        }
        if (!fs.existsSync(file)) return json({ ok: true, editable: false, models: (harness.list(true).find((h) => h.name === name).models || []).map((m) => ({ id: m.id, label: m.label })) });
        const cur = JSON.parse(fs.readFileSync(file, 'utf8')); return json({ ok: true, editable: true, note: cur._note || '', models: cur.models });
      }
      // the doctrine as data - every rule, with what the map can check (engine/doctrine.js, hot; the file is the source)
      if (url.pathname === '/api/doctrine/inbox') { const dir = path.join(root, 'prompts', 'doctrine-inbox'); let notes = []; try { notes = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f)).sort().map((f) => ({ file: f, at: fs.statSync(path.join(dir, f)).mtime.toISOString(), text: fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000) })); } catch (e) { /* none */ } return json({ ok: true, notes }); }
      /* the verdict's checks (plugins/tickets/verdict.json): the list; save one (add or edit by id); remove one; the built-in
         seven can be switched off or made warnings, never removed */
      if (url.pathname === '/api/verdict') {
        const vf = require('./hot').hot(path.join(__dirname, 'verify.js')); const fsx = require('node:fs');
        const read = () => { try { return JSON.parse(fsx.readFileSync(vf.VERDICT_FILE, 'utf8')); } catch (e) { return { checks: [] }; } };
        if (req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}'); const j = read(); j.checks = j.checks || [];
          if (b.op === 'remove') { const d = j.checks.find((c) => c.id === b.id); if (!d) return json({ ok: false, error: 'no check ' + b.id }, 404); if (d.kind === 'builtin') return json({ ok: false, error: 'a built-in check is switched off, not removed' }, 400); j.checks = j.checks.filter((c) => c.id !== b.id); }
          else if (b.op === 'save') {
            const c = b.check || {}; const i = j.checks.findIndex((x) => x.id === (b.was || c.id));
            if (i >= 0 && j.checks[i].kind === 'builtin') { const d = j.checks[i]; ['name', 'asks', 'why', 'measures', 'fix'].forEach((k) => { if (c[k] !== undefined) d[k] = String(c[k]); }); if (c.on !== undefined) d.on = !!c.on; if (c.blocks !== undefined) d.blocks = !!c.blocks; }
            else {
              const id = String(c.id || c.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); if (!id) return json({ ok: false, error: 'a name is needed' }, 400);
              if (!['problem', 'command', 'pattern'].includes(c.kind)) return json({ ok: false, error: 'kind must be problem, command or pattern' }, 400);
              if (c.kind === 'problem' && !String(c.rule || '').trim()) return json({ ok: false, error: 'which Problems rule?' }, 400);
              if (c.kind === 'command' && !String(c.command || '').trim()) return json({ ok: false, error: 'the command is needed' }, 400);
              if (c.kind === 'pattern') { try { new RegExp(String(c.pattern || '')); } catch (e) { return json({ ok: false, error: 'not a valid regular expression: ' + e.message }, 400); } if (!String(c.pattern || '').trim()) return json({ ok: false, error: 'the pattern is needed' }, 400); }
              if (i < 0 && j.checks.some((x) => x.id === id)) return json({ ok: false, error: 'there is already a check ' + id }, 400);
              const entry = { id, kind: c.kind, gate: c.gate === 'promote' ? 'promote' : 'ticket', on: c.on !== false, blocks: c.blocks !== false, name: String(c.name || id).trim(), asks: String(c.asks || '').trim(), why: String(c.why || '').trim(), measures: String(c.measures || '').trim(), fix: String(c.fix || '').trim() };
              if (c.kind === 'problem') entry.rule = String(c.rule).trim(); if (c.kind === 'command') entry.command = String(c.command).trim(); if (c.kind === 'pattern') entry.pattern = String(c.pattern);
              if (i >= 0) j.checks[i] = entry; else j.checks.push(entry);
            }
          } else return json({ ok: false, error: 'op?' }, 400);
          fsx.writeFileSync(vf.VERDICT_FILE, JSON.stringify(j, null, 2) + '\n'); return json({ ok: true, ...read() });
        }
        return json({ ok: true, ...read() });
      }
      if (url.pathname === '/api/doctrine') return json(require('./hot').hot(path.join(__dirname, 'doctrine.js')).parse(root));
      /* ---- events across every project (engine/events.js): Home's alerts, notifications, recent activity ---- */
      const events = live('events.js');
      if (url.pathname === '/api/home/events' && req.method === 'GET') return json({ ok: true, ...events.across(null, { limit: url.searchParams.get('limit'), unseen: url.searchParams.get('unseen') === '1', level: url.searchParams.get('level'), since: url.searchParams.get('since'), notKind: url.searchParams.get('notKind'), onlyKind: url.searchParams.get('onlyKind') }) });
      if (url.pathname === '/api/home/events/seen' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); let n = 0; (b.items || []).forEach((x) => { try { const p = projects.open(x.project); if (p && !p.missing) n += events.seen(p, x.ids || 'all'); } catch (e) { /* */ } }); if (b.all) registry.all().forEach((e) => { try { const p = projects.open(e.id); if (p && !p.missing) n += events.seen(p, 'all'); } catch (er) { /* */ } }); return json({ ok: true, seen: n }); }
      /* ---- the fleet: global, one queue across projects (§14) ---- */
      const fleet = require('./fleet');
      /* ?brief=1 - the queue WITHOUT the work orders. Measured 2026-09-23: 415 items, 573 KB, of
         which 232 KB was each item's instruction text and 200 KB its outcome text. The board polls
         this every 15 seconds and uses none of it - it needs status, priority, who holds it and the
         title. A card asking four times a minute must not drag half a megabyte with it. */
      if (url.pathname === '/api/fleet') {
        const s = fleet.state();
        if (url.searchParams.get('brief') !== '1') return json(s);
        return json({ ...s, items: (s.items || []).map((i) => ({ id: i.id, project: i.project, ticket: i.ticket, title: i.title, priority: i.priority, status: i.status, claimedBy: i.claimedBy, agent: i.agent, turns: i.turns, added: i.added, outcome: i.outcome ? { reason: i.outcome.reason, producedNothing: i.outcome.producedNothing } : null })) });
      }
      if (url.pathname === '/api/fleet/performance') {
        const w = url.searchParams.get('window') || '7d';
        const midnight = new Date(); midnight.setHours(0, 0, 0, 0);   // today = since midnight local, not the last 24 h
        const ms = w === 'today' ? Date.now() - midnight.getTime() : w === '7d' ? 7 * 24 * 3600e3 : w === '30d' ? 30 * 24 * 3600e3 : 0;
        return json({ window: w, ...harness.performance(root, ms) });
      }
      let fm = url.pathname.match(/^\/api\/fleet\/agent\/([a-z0-9-]+)$/);
      if (fm && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const a = fleet.setAgent(fm[1], b); return a ? json({ ok: true, agent: a }) : json({ ok: false, error: 'no such agent' }, 404); }
      // adding and removing coders (engine/fleet.js addAgent / removeAgent): {id, harness, label}
      if (fm && req.method === 'DELETE') { const r = fleet.removeAgent(fm[1]); return json(r, r.ok ? 200 : 400); }
      if (url.pathname === '/api/fleet/agents' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const r = fleet.addAgent(b); return json(r, r.ok ? 200 : 400); }
      if (url.pathname === '/api/fleet/pause-all' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); fleet.pauseAll(b.paused !== false); return json({ ok: true }); }
      // ask the harnesses that can answer on demand for the plan's own usage reading (Codex's app-server)
      if (url.pathname === '/api/fleet/usage/refresh' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const r = await fleet.probeUsage(b.agent || null); return json({ ok: true, results: r || {}, busy: r === null }); }
      if (url.pathname === '/api/fleet/items' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}'); if (!b.project) return json({ ok: false, error: 'project is required' }, 400);
        if (b.ticket) {   // a ticket goes on the queue by id: it must be approved and not already there
          const p = projects.open(b.project); if (!p || p.missing) return json({ ok: false, error: 'no project ' + b.project }, 404);
          const tk = tickets.get(p, String(b.ticket).replace(/^#/, '')); if (!tk) return json({ ok: false, error: 'no ticket ' + b.ticket }, 404);
          const q = fleet.enqueueTicket(b.project, tk, { agent: b.agent || null, priority: b.priority || 'next', source: b.source || 'board' }); if (!q.ok) return json({ ok: false, error: q.error }, 400);
          return json({ ok: true, item: q.item, agentsOn: q.agentsOn });
        }
        if (!(b.title || b.text)) return json({ ok: false, error: 'a title or a ticket is required' }, 400);
        return json({ ok: true, item: fleet.add(b) });
      }
      if (url.pathname === '/api/fleet/reorder' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); fleet.reorder(b.ids || []); return json({ ok: true }); }
      fm = url.pathname.match(/^\/api\/fleet\/items\/(\d+)$/);
      if (fm && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const it = fleet.update(fm[1], b); return it ? json({ ok: true, item: it }) : json({ ok: false, error: 'no such item' }, 404); }
      if (fm && req.method === 'DELETE') return json({ ok: fleet.remove(fm[1]) });

      m = url.pathname.match(/^\/api\/p\/([a-z0-9-]+)\/(.+)$/);
      if (m) {
        const id = m[1], rest = m[2];
        if (!registry.get(id)) return json({ ok: false, error: 'unknown project ' + id }, 404);
        if (rest === 'room') return json(projects.describe(id));
        if (rest === 'events' && req.method === 'GET') { const p = projects.open(id); if (!p || p.missing) return json({ ok: false, error: 'folder missing' }, 404); return json({ ok: true, events: events.list(p, { limit: url.searchParams.get('limit'), unseen: url.searchParams.get('unseen') === '1', level: url.searchParams.get('level'), notKind: url.searchParams.get('notKind'), onlyKind: url.searchParams.get('onlyKind') }), unseen: events.counts(p) }); }
        if (rest === 'events/seen' && req.method === 'POST') { const p = projects.open(id); if (!p || p.missing) return json({ ok: false, error: 'folder missing' }, 404); const b = JSON.parse(await readBody(req) || '{}'); return json({ ok: true, seen: events.seen(p, b.all ? 'all' : b.ids || []) }); }
        /* closing the browser tab closes the project (the engine held a project open and its folder could not be moved). Never under running work: a turn, a test run
           or a scan still holds its database, so a busy project stays open and goes at the idle limit as before. */
        if (rest === 'close' && req.method === 'POST') {
          if (!projects.isLoaded(id)) return json({ ok: true, already: true });
          const lp = projects.open(id); const why = [];
          if (harness.runningIn(id).length) why.push('an AI turn is running');
          try { if (tests.status(lp).running) why.push('a test run is going'); } catch (e) { /* */ }
          try { if (plugins.scanned(lp).some((n) => plugins.scanning(lp, n))) why.push('a scan is running'); } catch (e) { /* */ }
          if (why.length) return json({ ok: false, busy: true, why: why.join(', ') + ' - it closes at the idle limit instead' });
          return json({ ok: projects.close(id, 'asked') });
        }
        // cheap: the shell polls this every few seconds and reloads the room when it moves
        if (rest === 'version') { const pv = projects.open(id); projects.viewed(id); return json({ version: projects.version(id), loaded: !!(pv && !pv.missing) }); }   // the poll is the 'someone is looking' signal   // open() touches the idle clock: a tab on the room keeps it warm
        const p = projects.open(id);
        if (!p || p.missing) return json({ ok: false, error: 'folder missing: ' + (p ? p.entry.path : id) }, 404);
        // every write to a project through the API bumps its version (the layout excepted -
        // the shell wrote that itself and must not reload for it)
        if (req.method === 'POST' && rest !== 'layout') projects.bump(id);
        /* The Files card: one level of the project tree at a time, relative paths only, and
           never a step outside the project folder. Files carry their size; folders are
           expanded by the card on click, so a big tree costs nothing until it is opened. */
        /* Import Claude Code session transcripts (.jsonl) into this project's conversations. The
           folder is INSIDE the project (e.g. .cockpit/import) so the engine reads it locally; the
           tool is tools/import-claude-sessions.js, run as a child so a big transcript cannot block. */
        /* A lesson for the doctrine: one dated file in the engine's inbox, reviewed later into
           prompts/doctrine.md - never edited from a project turn (doctrine.md, "How this file stays alive"). */
        /* Remote Control: a background Claude Code session in this folder, driven from the owner's phone. */
        if (rest === 'remote' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}');
          if (b.action === 'on') return json(await remote.start(root, p, b.name));
          if (b.action === 'off') return json(await remote.stop(root, p));
          return json(await remote.status(root, p));
        }
        /* the mapping file (docs/plan-verification-and-tickets.md, Phase 2): draft it from the map; read its counts */
        /* the test runner: run (one at a time per project), the last report, the failures' output */
        /* backups (engine/backup.js): where they stand; Back up now (force = copy even if unchanged); the project's switch */
        if (rest === 'backup' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); return json(await backup.backup(root, p, { force: !!b.force })); }
        if (rest === 'backup/settings' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); freshCockpitJson(p); p.cockpit.json.backup = { ...(p.cockpit.json.backup || {}), off: !!b.off }; fs.writeFileSync(path.join(p.cockpit.dir, 'cockpit.json'), JSON.stringify(p.cockpit.json, null, 2) + '\n'); return json({ ok: true, off: !!b.off }); }
        if (rest === 'backup') return json(backup.status(root, p));
        if (rest === 'tests') return json(tests.status(p));
        if (rest === 'tests/family') { let report = null, prog = null; try { report = tests.latest(p); prog = tests.status(p).running ? tests.progress(p) : null; } catch (e) { /* */ } const vf = require('./hot').hot(path.join(__dirname, 'verify.js')); return json({ ok: true, running: !!prog, stage: prog ? prog.stage : null, family: vf.familyLive(p, report, prog), checks: vf.checkDefs(p).filter((c) => c.gate === 'promote'), report: report ? { at: report.at, ms: report.ms, summary: report.summary } : null }); }
        if (rest === 'tests/override' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); if (!b.id) return json({ ok: false, error: 'which check?' }, 400); const vf = require('./hot').hot(path.join(__dirname, 'verify.js')); const patch = {}; if (b.blocks !== undefined) patch.blocks = !!b.blocks; if (b.on !== undefined) patch.on = !!b.on; return json({ ok: true, overrides: vf.setOverride(p, b.id, patch) }); }
        if (rest === 'promote') { if (req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const r = promote.run(p, b.by || 'owner', (line) => console.log('[' + id + '] ' + line), { force: !!b.force }); return json(await r); } return json(promote.status(p)); }
        if (rest === 'tests/failures') return json({ ok: true, failures: tests.failures(p) });
        if (rest === 'tests/run' && req.method === 'POST') return json(tests.run(p, (line) => console.log('[' + id + '] ' + line)));
        if (rest === 'tests/dast') { if (req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); return json(dast.run(p, b, (line) => console.log('[' + id + '] ' + line))); } return json(dast.status(p)); }
        /* tickets (Phase 4): the impact of a set of files, a draft, the list, one ticket, its state */
        if (rest === 'impact' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); try { return json({ ok: true, impact: tickets.impact(p, b.files || []) }); } catch (e) { return json({ ok: false, error: e.message }, 400); } }
        if (rest === 'tickets/draft' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); if (!b.title) return json({ ok: false, error: 'a title is needed' }, 400); try { return json(tickets.draftFile(p, b, b.by || 'ai')); } catch (e) { return json({ ok: false, error: e.message }, 400); } }
        if (rest === 'tickets/features') return json({ ok: true, features: tickets.features(p) });
        if (rest === 'tickets/adopt' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); try { return json(tickets.adopt(p, b.number, b, b.by || 'owner')); } catch (e) { return json({ ok: false, error: e.message }, 400); } }
        if (rest === 'tickets' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); if (!b.title) return json({ ok: false, error: 'a title is needed' }, 400); try { return json(tickets.create(p, b, b.by || 'owner')); } catch (e) { return json({ ok: false, error: e.message }, 400); } }
        if (rest === 'tickets') return json({ ok: true, github: !!tickets.githubOf(p), tickets: tickets.list(p).map((t) => ({ id: t.id, number: t.number, url: t.url, title: t.title, state: t.state, feature: t.feature, finding: t.finding, band: t.impact && t.impact.band, created: t.created, delete: t.delete || [], by: t.by || null, updated: ((t.history || [])[(t.history || []).length - 1] || {}).at || t.created, alter: t.alter, create: t.create, verdicts: (t.verdicts || []).length })) });
        let tk = rest.match(/^tickets\/([A-Za-z0-9]+)(?:\/(state|comment|edit|approve|reject|files|verify))?$/);
        if (tk) {
          if (!tk[2]) { const t = tickets.get(p, tk[1]); return t ? json({ ok: true, ticket: t }) : json({ ok: false, error: 'no ticket ' + tk[1] }, 404); }
          const b = JSON.parse(await readBody(req) || '{}');
          if (tk[2] === 'state') { const r = tickets.setState(p, tk[1], b.state, b.by || 'owner', b.why || null); if (r.ok && b.state === 'passed') r.promote = promote.onPassed(p, tk[1], (line) => console.log('[' + id + '] ' + line)); return json(r); }
          if (tk[2] === 'comment') return json(tickets.comment(p, tk[1], String(b.text || '')));
          if (tk[2] === 'edit') return json(tickets.edit(p, tk[1], b, b.by || 'ai'));
          if (tk[2] === 'approve') {
            /* mode:
               queue = filed and put on the fleet's queue (the default from the conversation; an agent that is on takes it); now = worked in this
               turn (the CLI, with the turn) or by the shell's next message; nothing = filed only (the board's Approve - Work it / Work it now follow) */
            try {
              const r = tickets.approve(p, tk[1], b.edits || {}, b.by || 'owner'); if (!r.ok) return json(r);
              const ref = r.ticket.number ? '#' + r.ticket.number : r.ticket.id;
              if (b.mode === 'queue') { const fleet = require('./fleet'); const q = fleet.enqueueTicket(id, r.ticket, { priority: b.priority || 'next', source: 'approve' }); r.queued = q.ok ? q.item : null; r.agentsOn = q.agentsOn || 0; r.note = q.ok ? 'filed as ' + ref + ' and on the queue (' + (b.priority || 'next') + ')' + (q.agentsOn ? ' - an agent takes it' : ' - no agent is on: Settings › AI turns one on; it waits there until then') : 'filed as ' + ref + '; not queued: ' + q.error; }
              else if (b.mode === 'now' && b.turn) { r.attached = harness.attachTicket(Number(b.turn), p, r.ticket.id); r.note = r.attached ? 'filed as ' + ref + ' and in work under this turn - do the work it declares now, name it in every commit' : 'filed as ' + ref + '; this turn already carries a ticket, so work it in a new turn'; }
              else r.note = 'filed as ' + ref;
              return json(r);
            } catch (e) { return json({ ok: false, error: e.message }, 400); }
          }
          if (tk[2] === 'reject') { const t0 = tickets.get(p, tk[1]); if (b.by === 'ai' && t0 && t0.state !== 'draft') return json({ ok: false, error: 'a filed ticket is the owner\'s to reject' }, 403); return json(tickets.reject(p, tk[1], b.by || 'owner', b.why || null)); }
          if (tk[2] === 'files') return json(tickets.setFiles(p, tk[1], b, b.by || 'owner'));
          if (tk[2] === 'verify') {   // the verdict again, on everything the turns touched so far (the owner fixed the declaration, or wants a fresh read)
            const t = tickets.get(p, tk[1]); if (!t) return json({ ok: false, error: 'no ticket ' + tk[1] }, 404);
            if (t.state !== 'in-work' && t.state !== 'verified') return json({ ok: false, error: 'the ticket is ' + t.state + ' - a verdict is for a ticket in work' }, 400);
            let touched = t.touched || []; if (!touched.length) { try { const it = require('./fleet').state().items.filter((i) => i.project === p.entry.id && i.ticket === t.id && i.outcome && i.outcome.files).pop(); if (it) touched = it.outcome.files; } catch (e) { /* */ } }
            let report = null; try { report = require('./hot').hot(path.join(__dirname, 'tests.js')).latest(p); } catch (e) { /* no tests */ }
            /* DRY (ticket check, the coder's own look before it ends the turn - 43 of 55 first verdicts were red without it):
               the map is re-read first so the checks see what the turn wrote; the files git shows changed since the ticket
               started count as touched; nothing is written to the ticket, nothing moves. A browser flow not yet run is a
               warning here, not a red - the engine runs it after the turn. */
            if (b.dry) {
              try { for (const name of plugins.scanned(p)) { const mf = plugins.get(name); if (mf && mf.core) try { plugins.scan(p, name, null); } catch (e) { /* */ } } } catch (e) { /* no scan */ }
              try { const cpx = require('node:child_process'); const since = t.startSha ? cpx.execFileSync('git', ['-c', 'safe.directory=*', 'diff', '--name-only', t.startSha, 'HEAD'], { cwd: p.dir, encoding: 'utf8', timeout: 20000, windowsHide: true }) : ''; const dirty = cpx.execFileSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain'], { cwd: p.dir, encoding: 'utf8', timeout: 20000, windowsHide: true }); touched = [...new Set([...touched, ...since.split(/\r?\n/), ...dirty.split(/\r?\n/).map((l) => l.slice(3).trim())].map((f) => f.trim().replace(/^"|"$/g, '')).filter((f) => f && !/^\.cockpit\//.test(f)))]; } catch (e) { /* not git */ }
              try {
                const r = require('./hot').hot(path.join(__dirname, 'verify.js')).after(p, t.id, null, touched, report, null, { dry: true });
                const checks = (r.verdict.checks || []).map((c) => c.id === 'flow' && !c.ok && /has not run yet/.test(c.detail) ? { ...c, ok: true, blocks: false, detail: c.detail + ' - the engine runs it after your turn' } : c);
                const green = checks.every((c) => c.ok || !c.blocks);
                return json({ ok: true, green, checks: checks.map((c) => ({ check: c.id, ok: c.ok, detail: c.detail })), red: checks.filter((c) => !c.ok && c.blocks).map((c) => c.id), touched, note: green ? 'green - commit if you have not, then end the turn' : 'red - put the ✗ lines right, then check again' });
              } catch (e) { return json({ ok: false, error: e.message }, 500); }
            }
            try { const r = require('./hot').hot(path.join(__dirname, 'verify.js')).after(p, t.id, null, touched, report, null); return json({ ok: true, verdict: r && r.verdict, moved: r && r.moved, text: r && r.text }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
          }
        }
        if (rest === 'declared') return json(declared.status(p));
        if (rest === 'declared/draft' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const r = declared.draft(p, { force: !!b.force }); if (r.ok) projects.bump(id); return json(r); }
        if (rest === 'lesson' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}'); const text = String(b.text || '').trim();
          if (!text) return json({ ok: false, error: 'a lesson needs text' }, 400);
          const dir = path.join(root, 'prompts', 'doctrine-inbox'); fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().slice(0, 10), slug = (b.topic || text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lesson';
          let file = path.join(dir, id + '-' + stamp + '-' + slug + '.md'), n = 2; while (fs.existsSync(file)) file = path.join(dir, id + '-' + stamp + '-' + slug + '-' + n++ + '.md');
          fs.writeFileSync(file, '# ' + (b.topic || slug) + '\n\nProject: ' + id + ' · ' + new Date().toISOString() + '\n\n' + text + '\n');
          return json({ ok: true, file: path.basename(file), inbox: fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').length });
        }
        if (rest === 'import/claude' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}');
          const dir = path.resolve(p.dir, String(b.dir || '.cockpit/import').replace(/^[\\/]+/, ''));
          if (!dir.startsWith(p.dir + path.sep) || !fs.existsSync(dir)) return json({ ok: false, error: 'no such folder inside the project: ' + (b.dir || '.cockpit/import') }, 400);
          const { execFile } = require('node:child_process');
          projects.close(id, 'import');   // release the database; the room reopens it on the next call
          return new Promise((resolve) => execFile(process.execPath, [path.join(root, 'tools', 'import-claude-sessions.js'), p.dir, dir].concat(b.dry ? ['--dry'] : []), { timeout: 120000, windowsHide: true }, (err, out, errOut) => {
            const log = (out || '').split('\n').filter((l) => l && !/ExperimentalWarning|trace-warnings/.test(l));
            resolve(json({ ok: !err, log, error: err ? String(errOut || err.message).slice(0, 400) : null }));
          }));
        }
        if (rest === 'files') {
          const rel = (url.searchParams.get('path') || '').replace(/^[\\/]+/, '');
          const abs = path.resolve(p.dir, rel);
          if (abs !== p.dir && !abs.startsWith(p.dir + path.sep)) return json({ ok: false, error: 'outside the project' }, 403);
          let ents;
          try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return json({ ok: false, path: rel, error: e.code || e.message }); }
          const entries = ents.map((d) => {
            const st = d.isDirectory() ? null : (() => { try { return fs.statSync(path.join(abs, d.name)); } catch (e) { return null; } })();
            return { name: d.name, dir: d.isDirectory(), size: st ? st.size : null, at: st ? st.mtime.toISOString() : null };
          }).sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
          return json({ ok: true, path: rel, entries });
        }
        /* One file, as text, for the File card. Bounded (2 MB) and refused if it is binary,
           because a viewer that renders a 300 MB log or a PNG as text is a hang, not a view. */
        /* the Notes card: a project's scratchpad, plain text in its own .cockpit
otes.md */
        /* data views: a project's read-only queries in .cockpit/views, shown by the Data views card (engine/views.js, 2026-09-26) */
        if (rest === 'views') return json({ ok: true, views: require('./hot').hot(path.join(__dirname, 'views.js')).list(p) });
        const vw = rest.match(/^views\/([A-Za-z0-9_-]+)$/);
        if (vw && req.method === 'GET') return json(await require('./hot').hot(path.join(__dirname, 'views.js')).run(p, vw[1]));
        if (rest === 'notes') {
          const f = path.join(p.cockpit.dir, 'notes.md');
          if (req.method === 'POST') { const b = JSON.parse(await readBody(req, 2e6) || '{}'); const text = String(b.text == null ? '' : b.text); if (text.length > 1e6) return json({ ok: false, error: 'the notes are over 1 MB' }, 400); fs.writeFileSync(f, text); return json({ ok: true, at: new Date().toISOString(), bytes: Buffer.byteLength(text) }); }
          let text = '', at = null; try { text = fs.readFileSync(f, 'utf8'); at = fs.statSync(f).mtime.toISOString(); } catch (e) { /* no notes yet */ }
          return json({ ok: true, text, at });
        }
        if (rest === 'file') {
          const rel = (url.searchParams.get('path') || '').replace(/^[\\/]+/, '');
          const abs = path.resolve(p.dir, rel);
          if (!abs.startsWith(p.dir + path.sep)) return json({ ok: false, error: 'outside the project' }, 403);
          let st; try { st = fs.statSync(abs); } catch (e) { return json({ ok: false, path: rel, error: e.code || e.message }); }
          if (st.isDirectory()) return json({ ok: false, path: rel, error: 'is a folder' });
          const LIMIT = 2 * 1024 * 1024;
          let buf, hydrated = false;
          try { const fd = fs.openSync(abs, 'r'); buf = Buffer.alloc(Math.min(st.size, LIMIT)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); }
          catch (e) {
            /* OneDrive "online-only" files list with a size but hold no bytes on disk; a plain
               read fails with UNKNOWN. Reading through the
               shell makes Windows fetch the file first. If that fails too, say what it is. */
            if (process.platform === 'win32' && /^(UNKNOWN|EIO|EBUSY)$/.test(e.code || '')) {
              try { buf = require('node:child_process').execFileSync('cmd.exe', ['/d', '/c', 'type', abs], { maxBuffer: LIMIT + 1024, windowsHide: true, timeout: 60000 }); hydrated = true; }
              catch (e2) { return json({ ok: false, path: rel, error: 'the file is listed but its contents are not on this disk - a OneDrive "online-only" file. Open the folder in Explorer and choose "Always keep on this device", then try again. (' + (e.code || e.message) + ')' }); }
            } else return json({ ok: false, path: rel, error: e.code || e.message });
          }
          // a listed size with no bytes behind it is a cloud placeholder ON THIS MACHINE - the
          // folder may be downloaded on another PC while the engine reads on this one
          if (st.size > 0 && buf.length === 0) return json({ ok: false, path: rel, error: 'listed as ' + st.size + ' bytes but no contents on ' + require('node:os').hostname() + ' - a OneDrive "online-only" file on the machine the engine runs on. In Explorer ON ' + require('node:os').hostname().toUpperCase() + ', right-click the folder → "Always keep on this device", then try again.' });
          const binary = buf.subarray(0, 8192).includes(0);
          /* the tickets that touched this file: commits naming #n (or Ln) in git log - computable because commits name the
             ticket (the gate); never a list kept in a header */
          let ticketsTouched = [];
          try { const log = require('node:child_process').execFileSync('git', ['-c', 'safe.directory=*', 'log', '--format=%h%x09%as%x09%s', '-n', '400', '--', rel], { cwd: p.dir, encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); const seen = {}; for (const line of log.split('\n')) { const m = /^(\w+)\t(\S+)\t(.*)$/.exec(line); if (!m) continue; for (const t of m[3].match(/(^|[\s(])#(\d{1,6})\b|\bL\d+\b/g) || []) { const id = t.trim().replace(/^[(\s]*/, ''); if (!seen[id]) { seen[id] = { ticket: id, first: m[2], last: m[2], commits: 0, subject: m[3].slice(0, 90) }; } seen[id].commits++; seen[id].first = m[2]; } } ticketsTouched = Object.values(seen).slice(0, 20); } catch (e) { /* not a git repo, or git missing */ }
          const inTicket = p.db.all("SELECT value, why FROM tag WHERE ns = 'ticket' AND subject = ?", 'file:' + rel.replace(/\\/g, '/')).map((t) => ({ ticket: t.value, title: t.why }));
          return json({ ok: true, path: rel, size: st.size, at: st.mtime.toISOString(), binary, hydrated, ticketsTouched, inTicket,
            truncated: st.size > LIMIT, text: binary ? null : buf.subarray(0, LIMIT).toString('utf8') });
        }
        /* ---- the conversation (milestone 2) ---- */
        if (rest === 'chat/threads' && req.method === 'GET') return json({ threads: conv.threads(p) });
        // turns still running in THIS project - so a page that comes back re-attaches instead of losing them
        if (rest === 'chat/running') return json({ running: harness.runningIn(id), verifying: harness.verifyingIn ? harness.verifyingIn(id) : [] });
        if (rest === 'chat/threads' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); return json({ ok: true, id: conv.create(p, b.title) }); }
        if (rest === 'chat/thread') { const t = conv.thread(p, Number(url.searchParams.get('id'))); return t ? json(t) : json({ ok: false, error: 'no such thread' }, 404); }
        if (rest === 'chat/note' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); conv.addNote(p, Number(b.thread), String(b.text || '').trim(), 'owner'); return json({ ok: true }); }
        /* The project's AI - one choice, in the header, used by everything that starts AI work
          . Stored in cockpit.json.ai. */
        if (rest === 'ai' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}');
          freshCockpitJson(p);
          p.cockpit.json.ai = { harness: String(b.harness || ''), model: String(b.model || ''), agent: String(b.agent || '') };
          fs.writeFileSync(path.join(p.cockpit.dir, 'cockpit.json'), JSON.stringify(p.cockpit.json, null, 2) + '\n');
          return json({ ok: true, ai: p.cockpit.json.ai });
        }
        if (rest === 'chat/send' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req, 30e6) || '{}');   // pasted pictures ride the message (up to 5, ~5 MB each)
          const images = (Array.isArray(b.images) ? b.images : []).slice(0, 5).filter((x) => x && /^image\/(png|jpeg|gif|webp)$/.test(String(x.type)) && typeof x.data === 'string' && x.data.length < 7e6).map((x) => ({ type: String(x.type), data: x.data }));
          let threadId = Number(b.thread) || conv.create(p, null);
          const ai = p.cockpit.json.ai || {};
          /* a conversation may run as one of the added coders - its harness, on that coder's own login */
          const hName = b.harness || ai.harness || 'claude-code', agentId = b.agent !== undefined ? b.agent : ai.agent;
          const coder = agentId ? fleet.state().agents.find((x) => x.id === agentId && x.env && x.harness === hName) : null;
          try { const turn = harness.run(root, p, threadId, hName, b.model || ai.model || 'opus', String(b.text || '').trim(), { context: b.context || null, images, ...(coder ? { env: coder.env, agentId: coder.id } : {}) }); return json({ ok: true, turn, thread: threadId }); }
          catch (e) { return json({ ok: false, error: e.message }, 400); }
        }
        if (rest === 'chat/stop' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); return json({ ok: harness.stop(Number(b.turn)) }); }
        if (rest === 'chat/events') {
          /* Server-sent events: everything so far is replayed, then live until 'end'. */
          const turn = Number(url.searchParams.get('turn'));
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const send = (ev) => { res.write('data: ' + JSON.stringify(ev) + '\n\n'); if (ev.type === 'end') res.end(); };
          const off = harness.subscribe(turn, send);
          if (!off) { send({ type: 'end', reason: 'unknown-turn' }); return; }
          req.on('close', off);
          return;
        }
        /* ---- a project's own data program (engine/ext.js; <project>\.cockpit\ext.json lists what may run) ---- */
        if (rest.startsWith('ext/')) {
          const b = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : undefined;
          const r = await ext.handle(p, rest.slice(4), Object.fromEntries(url.searchParams), b, req.method);
          return json(r, r.ok ? 200 : 400);
        }
        /* ---- plugins and the lens engine (milestone 3) ---- */
        if (rest === 'plugins') return json(plugins.forRoom(p));
        // a plugin card reading the plugin's own tables through a query named in its queries.json
        const pq = rest.match(/^plugins\/([a-z0-9-]+)\/q\/([a-z0-9-]+)$/);
        if (pq) { try { return json({ ok: true, rows: plugins.query(p, pq[1], pq[2], Object.fromEntries(url.searchParams)) }); } catch (e) { return json({ ok: false, error: e.message }, 400); } }
        let pm = rest.match(/^plugins\/([a-z0-9-]+)\/(select|deselect|scan)$/);
        if (pm && req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}');
          try {
            if (pm[2] === 'select') {
              const answers = plugins.select(p, pm[1], b.answers || {});
              /* Coding on: it starts running against whatever is there - the map is re-read and the runner goes; the Tests tab
                 fills with the results. No AI is started; the owner works the results in the conversation beside them. */
              let started = null;
              if (pm[1] === 'coding') { try { for (const name of plugins.scanned(p)) { const mf = plugins.get(name); if (mf && mf.core) try { plugins.scan(p, name, console.log); } catch (e) { /* running */ } } } catch (e) { /* */ } try { started = tests.run(p, (line) => console.log('[' + id + '] ' + line)); } catch (e) { started = { ok: false, error: e.message }; } }
              return json({ ok: true, answers, started });
            }
            if (pm[2] === 'deselect') { plugins.deselect(p, pm[1]); return json({ ok: true }); }
            return json(plugins.scan(p, pm[1], console.log));
          } catch (e) { return json({ ok: false, error: e.message }, 400); }
        }
        if (rest === 'graph') return json(graphMod.graph(p.db, { lens: url.searchParams.get('lens'), parent: url.searchParams.get('parent') }));
        if (rest === 'graph/lenses') return json({ lenses: graphMod.lenses(p.db), scanning: plugins.scanned(p).some((n) => plugins.scanning(p, n)) });
        if (rest === 'graph/node') { const d = graphMod.detail(p.db, url.searchParams.get('subject')); return d ? json(d) : json({ ok: false, error: 'no such node' }, 404); }
        if (rest === 'graph/find') return json({ ok: true, nodes: graphMod.find(p.db, url.searchParams.get('q')) });
        if (rest === 'graph/untag' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); return json(graphMod.untagByHand(p.db, b.subject, b.ns, b.value)); }   // take a hand-set tag back (2026-10-03)
        if (rest === 'graph/tag' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); return json(graphMod.tagByHand(p.db, b.subject, b.ns, b.value, b.why, (typeof b.by === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/i.test(b.by)) ? b.by : 'owner')); }   // a coder's cli signs its own tags (COCKPIT_AGENT, 2026-10-02); a person's tag stays "owner"
        if (rest === 'graph/nodes') return json(graphMod.allNodes(p.db, url.searchParams.get('kind')));
        if (rest === 'graph/edges') return json(graphMod.allEdges(p.db, url.searchParams.get('kind')));
        if (rest === 'graph/lens' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); return json(graphMod.describeLens(p.db, b.ns, b.title, b.purpose, !!b.graded, 'owner')); }
        if (rest === 'graph/grade' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); graphMod.grade(p.db, b.ns, b.value, b.band, b.label, b.why, 'owner'); return json({ ok: true }); }
        if (rest === 'layout') {
          const person = url.searchParams.get('person') || config.person;
          if (req.method === 'POST') { p.db.run('INSERT OR REPLACE INTO layout (person, json, at) VALUES (?,?,?)', person, await readBody(req), p.db.now()); return json({ ok: true }); }
          const row = p.db.get('SELECT json FROM layout WHERE person = ?', person);
          return json(row ? JSON.parse(row.json) : null);
        }
        return json({ ok: false, error: 'no such call: ' + rest }, 404);
      }

      // A plugin's cards (cards\*.js|css) and its readable data and rules at its root
      // (*.json, *.md - problems.json, rules.md) so the owner can open them from a link.
      let cm = url.pathname.match(/^\/plugins\/([a-z0-9-]+)\/(cards\/[a-z0-9._-]+\.(?:js|css)|[a-z0-9._-]+\.(?:json|md))$/);
      if (cm) {
        const pl = plugins.get(cm[1]);
        const f = pl && path.join(pl.dir, cm[2]);
        if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(f)], 'cache-control': 'no-cache' }); return fs.createReadStream(f).pipe(res);
      }
      // the engine's prompt files, readable from a link (the doctrine, the global rules, the playbook)
      let pm = url.pathname.match(/^\/prompts\/([a-z0-9._-]+\.md)$/);
      if (pm) { const f = path.join(root, 'prompts', pm[1]); if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return fs.createReadStream(f).pipe(res); }
      // The shell. "/" and "/<project-id>" both serve index.html; the page reads the id
      // from its own URL. Static files come from shell\ by exact name.
      const file = url.pathname === '/' || /^\/[a-z0-9-]+$/.test(url.pathname) && !fs.existsSync(path.join(shellDir, url.pathname.slice(1)))
        ? path.join(shellDir, 'index.html')
        : path.join(shellDir, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
      if (!file.startsWith(shellDir)) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });   // the shell is edited live: a refresh must re-read it
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error(req.method + ' ' + req.url + ' → ' + (e.stack || e));
      json({ ok: false, error: String(e.message || e) }, 500);
    }
  });
  /* THE PORT MAY BE TAKEN (2026-10-08): another program on it - move up to the next free one (20 tries) rather than not
     start at all; the wizard shows where it landed and can make it stick. Where the engine is goes in run/engine.json, for
     start.ps1 (to open the browser at the right place) and cli.js. */
  let tries = 0;
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && tries++ < 20) { console.log('port ' + config.port + ' is in use by another program - trying ' + (config.port + 1)); config.port += 1; setTimeout(() => server.listen(config.port, config.host), 50); return; }
    console.error('the engine could not start listening: ' + (e && e.message)); process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const url = 'http://localhost:' + config.port;
    process.env.COCKPIT_URL = url;   // every child (AI turns, the cli) finds the engine where it really is
    try { fs.mkdirSync(path.join(root, 'run'), { recursive: true }); fs.writeFileSync(path.join(root, 'run', 'engine.json'), JSON.stringify({ url, port: config.port, pid: process.pid, at: new Date().toISOString() }) + '\n'); } catch (e) { /* only a convenience */ }
    console.log('Cockpit engine ' + config.version + ' → http://localhost:' + config.port + '  (host ' + config.host + ', projects: ' + registry.all().length + ' registered, none loaded)');
    // "Start Cockpit automatically when I sign in" is on unless the person turned it off (engine/wizard.js autoDefault)
    try { const wz = require('./wizard'); wz.init(root, config); wz.autoDefault(); } catch (e) { console.log('autostart: ' + e.message); }
  });
  /* the backups' clock: every registered project looked at, open or not, a few minutes after start and every half hour after -
     a copy only when something changed (engine/backup.js). Nobody has to remember. */
  const BACKUP_CHECK_MINUTES = 30;
  const backupPass = () => backup.tick(root, projects, registry, console.log).catch((e) => console.log('[backup] ' + e.message));
  setTimeout(backupPass, 3 * 60000).unref();
  setInterval(backupPass, BACKUP_CHECK_MINUTES * 60000).unref();
  return server;
}

module.exports = { serve };
