#!/usr/bin/env node
/* cockpit cli - Cockpit's own tools, as commands any harness can run
   (docs/harness-interface.md rule 7; docs/generic-ide.md §3 "rules say run the tool").

   It talks to the running engine over HTTP, so it works from any harness on any machine
   that can reach the engine. The AI in a project's conversation is told the project id and
   this file's path in its prompt, and calls it through its shell tool.

   USAGE   node cli.js <project-id> <command> [args]           (COCKPIT_URL overrides the engine)

     plugins                                   what plugins the project has, selected or not, last scan
     scan <plugin>                             run a plugin's scan; waits for it; prints what it yielded
     lenses                                    the lenses the map has
     graph [--lens ns] [--parent subject]      the map one level down from a node, coloured by a lens
     node <subject>                            one node: its tags, what it reaches, what reaches it
     find <text>                               nodes whose subject or title contains the text
     grade <ns> <value> <band> [label] [why]   grade a lens value by hand: bad | warn | ok | info.
                                               Survives every rescan. Use only for what the owner decided.
     tag <subject> <ns> <value> [why]          put a hand-set tag on a node (source 'owner'); survives rescans
     lens <ns> <title> <purpose> [graded]      describe a lens - A NEW LENS IS A NEW NAMESPACE. Describe it,
                                               then tag subjects with <ns> values; the map draws it at once.
                                               graded = its values get red/amber/green via grade; else colours by value.
     note <thread-id> <text>                   record a standing ruling on a conversation
     files [path]                              one level of the project tree

   Output is TOON (Token-Oriented Object Notation, engine/toon.js) - the same object as
   JSON at ~40% fewer tokens, meant to be read by a model, not a person. `--json` anywhere
   on the line gives JSON instead. */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
// the engine says where it is in run/engine.json (server.js, on listen) - the port may have moved
const BASE = process.env.COCKPIT_URL || (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'run', 'engine.json'), 'utf8')).url; } catch (e) { return null; } })() || 'http://localhost:' + require('./engine/config').DEFAULT_PORT;
const argv = process.argv.slice(2); const JSON_OUT = argv.includes('--json'); if (JSON_OUT) argv.splice(argv.indexOf('--json'), 1);
const [pid, cmd, ...args] = argv;
const toon = require('./engine/toon');
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const out = (o) => { process.stdout.write((JSON_OUT ? JSON.stringify(o) : toon.encode(o)) + '\n'); };
const fail = (m, code) => { out({ ok: false, error: m }); process.exit(code || 1); };
/* The command list, as data, for the AI that runs this: no command, or help, prints it and
   exits 0 (2026-09-16: it was an error, and the model spent turns discovering commands
   by grepping this file). */
const COMMANDS = {
  plugins: 'what plugins the project has, selected or not, and their last scan',
  'scan <plugin>': 'run a plugin\'s scan and wait for it; returns what it yielded',
  lenses: 'the lenses the map has (a lens is a tag namespace)',
  'graph [--lens ns] [--parent subject]': 'one level of the map below a node, coloured by a lens',
  'node <subject>': 'one node: its tags, what it reaches, what reaches it',
  'find <text>': 'nodes whose subject or title contains the text',
  'nodes [kind]': 'EVERY node (optionally one kind: file, folder, table…) with its tags - one call, no loops',
  'edges [kind]': 'EVERY edge (optionally one kind: include, link, form, fetch, script, reads, writes) - one call, no loops',
  'grade <ns> <value> <band> [label] [why]': 'grade a lens VALUE by hand: bad | warn | ok | info. Survives rescans.',
  'tag <subject> <ns> <value> [why]': 'put a hand-set tag on one node; survives rescans; replaces the scanner\'s in that lens',
  'lens <ns> <title> <purpose> [graded]': 'describe a NEW lens (a new namespace); then tag subjects with it',
  'note [thread-id] <text>': 'record a standing ruling on a conversation (the latest one if no id)',
  'files [path]': 'one level of the project tree',
  'starter <kind> --name <slug> --title <Title> --purpose <one line> [--port-dev 5100 --port-prod 5000 --repo <url>]': 'copy one of the engine\'s starters (starters\\<kind>: node-app) into this project folder with the placeholders filled; refuses if the folder already has files',
  'starters': 'the starters available',
  'projects': 'every project this engine knows: id, name, folder - use the id in other commands',
  'ticket draft --title <t> --feature <f> --flow <name|none> --alter "a.js,b.js" --create "c.js" --delete "d.js" --what <why> --done <read-back> [--tests <t>]': 'draft a ticket from the conversation; it waits for the owner\'s approval - the button, /approve, or their word to you',
  'ticket send-back <id> --why <what is wrong>': 'put a ticket back to TO WORK and on the queue, with your words as the work order - the one way to move a ticket backwards. Use it when its work cannot land (a rebase that cannot be cherry-picked, CI red on the pull request, the environment rejected it); never file a second ticket for the same issue.',
  'ticket check <id>': 'BEFORE YOU END A TURN on a ticket: the verdict as Cockpit will give it - the map re-read, every check with its detail, nothing written or moved. Put every ✗ right (commit, the declared files, the findings on your files), check again, and end only on green - or say plainly what you could not make green.',
  'ticket edit <id> [--alter …] [--create …] [--delete …] [--done …] [--what …] [--flow …] [--title …]': 'change what a filed ticket says - its file lists (a list given replaces the whole list), done-when, what, flow, title - until it is verified; every edit is a line in its history the owner reads. Where a ticket stands is never yours to set.',
  'ticket comment <id> --text <t>': 'a note on the ticket - the engineering detail the owner does not read in the chat: files, read-backs, commits, a CHANGE REQUEST for Cockpit',
  'ticket withdraw <D-id> [--why <w>]': 'drop a draft of your own - a redraft or a mistake - so it does not wait on the owner; a filed ticket is never yours to drop',
  'ticket approve <D-id> [--now] [--priority next|P1|P2|P3]': 'file a draft on the owner\'s word in the conversation (only when they told you to, in their own message). It goes on the fleet queue for an agent to work - unless the owner said now, then --now: it goes in work under this turn and you start at once',
  'ticket adopt --number <n> --alter <files> --done <read-back>': 'an issue that already exists on GitHub becomes a Cockpit ticket (its impact, its labels)',
  'ticket [list | features | <id>]': 'the tickets, the feature names in use, or one ticket in full',
  'architecture-doc [--force]': 'regenerate ARCHITECTURE.md from the tagging schema (only when missing or generated on an older schema; --force overwrites)',
  'codeowners': 'write .github/CODEOWNERS from the @owner lines of the feature READMEs',
  'plugin-select <plugin> <answers-json>': 'select a plugin for this project with its wizard answers, e.g. github {"repo":"me/x","you":"me"} - the same as the Plugins page',
  'project-set [--name <name>] [--urls "https://my-app.local, http://host:port"]': 'the project\'s display name and the site links on the Project card',
  'look <url> [--click "text"]... [--login] [--full] [--width 1400]': 'LOOK AT A PAGE in a real browser (the engine\'s Chromium): opens it, clicks each --click (a tab, button, link or exact text) in order, saves a screenshot and returns its path plus the page\'s visible text - open the screenshot to see what the owner sees. --login signs in first with the AI login the owner set up for this project. Use it to check any change a person can see before you say it is done.',
  'remote [on|off|status] [--name <label>]': 'Claude Code Remote Control for this project: a background session in this folder the owner drives from his phone',
  'tests [--run] [--failures]': 'the project\'s tests: --run runs them (each test file on its own with node --test, or the command named under ## Tests in project.md), NODE_ENV=test and the test database; no flag shows the last report; --failures prints the failing files\' output',
  'declare [--draft] [--force]': 'the declarations held outside the code (.cockpit/plugins/architecture.declared.json): --draft writes it from the map (feature, kind, owned tables; purpose and flows empty, for you to fill per feature); no flag reports the counts - declared / mapped / inferred / untagged',
  'lesson <text> [--topic <slug>]': 'a lesson that might generalize: one dated file in the doctrine inbox (prompts/doctrine-inbox), reviewed into prompts/doctrine.md later - the rules are never edited from a project turn',
  'import-claude [folder] [--dry]': 'import Claude Code session transcripts (.jsonl) from a folder INSIDE the project (default .cockpit/import) as conversations here - the history a project had before Cockpit',
  'queue': 'the queue items for THIS project, with status and who holds them (from home: every project\'s)',
  'queue add <priority> <ticket> [--agent <id>] [--project <id>]': 'put an approved ticket (in "to work") on the fleet queue: next | P1 | P2 | P3, then L2 or #123. From a project: only its own ticket, no --agent, no --project. From home: --project names the project; --agent names one coder, else the first available takes it. Only when the owner asks to fill the queue.',
  'queue add <priority> <title> -- <the ask>': 'HOME ONLY - free work on the queue (no ticket): a one-line title, then the ask as you would say it in a conversation here',
  'queue park <id>': 'HOME ONLY - take an item out of the running without deleting it (deleting is for the owner)',
  'queue unpark <id>': 'HOME ONLY - put a parked (or done/failed) item back on the queue',
  'queue agent <id> on|off|pause|resume': 'HOME ONLY - switch an agent on or off, pause it (it finishes what it is on and takes nothing more) or resume it',
  'handoff <project> [--thread <id>] -- <the message>': 'HOME ONLY - send a message straight into another project\'s conversation (its latest one, or --thread), and that project\'s AI answers there. Use it for a project that works only in its own conversation (an assistant project, say) instead of the queue. Only on the owner\'s word; say in the message that it comes from Home.'
};
if (!pid) fail('usage: node cli.js <project-id> <command> [args]', 2);
if (!cmd || cmd === 'help' || cmd === '--help') { out({ ok: true, project: pid, usage: 'node cli.js ' + pid + ' <command> [args]', commands: COMMANDS, format: 'TOON: key: value; list[N]: a,b,c; rows[N]{col,col}: then one row per line in column order; "- " opens a list item. --json for JSON.', note: 'Cockpit is the memory: what you learn goes in through these (note / tag / grade / lens), never into files of your own. For the whole map at once use nodes / edges rather than looping.' }); process.exit(0); }
const P = BASE + '/api/p/' + encodeURIComponent(pid);
// the turn's project key (engine/scope.js): without it the engine refuses any change
const KEYH = process.env.COCKPIT_KEY ? { 'x-cockpit-key': process.env.COCKPIT_KEY } : {};
const get = (u) => fetch(u, { headers: KEYH }).then((r) => r.json());
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...KEYH }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes('--' + name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    switch (cmd) {
      case 'plugins': { const r = await get(P + '/plugins'); return out({ ok: true, plugins: r.available.map((p) => ({ name: p.name, selected: p.selected, answers: p.answers, lastScan: p.lastScan && { finished: p.lastScan.finished, ok: p.lastScan.ok, yields: p.lastScan.yields ? JSON.parse(p.lastScan.yields) : null, note: p.lastScan.note } })) }); }
      case 'scan': {
        const name = args[0]; if (!name) fail('scan <plugin>');
        const s = await post(P + '/plugins/' + name + '/scan');
        if (!s.ok) fail(s.error || 'scan did not start');
        for (let i = 0; i < 400; i++) {   // up to ~10 minutes
          await sleep(1500);
          const r = await get(P + '/plugins'); const me = (r.available || []).find((p) => p.name === name);
          if (me && me.lastScan && me.lastScan.finished && me.lastScan.id >= s.run) return out({ ok: !!me.lastScan.ok, yields: me.lastScan.yields ? JSON.parse(me.lastScan.yields) : null, note: me.lastScan.note });
        }
        return fail('scan still running after 10 minutes');
      }
      case 'lenses': return out(await get(P + '/graph/lenses'));
      case 'graph': { const g = await get(P + '/graph?lens=' + encodeURIComponent(flag('lens') || '') + (flag('parent') ? '&parent=' + encodeURIComponent(flag('parent')) : '')); if (g.ok) g.nodes = g.nodes.map((n) => ({ subject: n.subject, kind: n.kind, title: n.title, size: n.size, band: n.band, dist: n.dist, drill: !!n.drill })); return out(g); }
      case 'node': { if (!args[0]) fail('node <subject>'); return out(await get(P + '/graph/node?subject=' + encodeURIComponent(args[0]))); }
      case 'find': { if (!args[0]) fail('find <text>'); return out(await get(P + '/graph/find?q=' + encodeURIComponent(args.join(' ')))); }
      case 'nodes': { const r = await get(P + '/graph/nodes' + (args[0] ? '?kind=' + encodeURIComponent(args[0]) : '')); if (!JSON_OUT && r.nodes) { r.legend = (r.legend ? r.legend + '; ' : '') + 'tags = ns:value pairs separated by spaces'; r.nodes = r.nodes.map((n) => Object.assign({}, n, { tags: (n.tags || []).join(' ') })); } return out(r); }
      case 'edges': return out(await get(P + '/graph/edges' + (args[0] ? '?kind=' + encodeURIComponent(args[0]) : '')));
      case 'grade': { const [ns, value, band, label, why] = args; if (!ns || !value || !band) fail('grade <ns> <value> <band> [label] [why]'); if (!/^(bad|warn|ok|info)$/.test(band)) fail('band must be bad | warn | ok | info'); return out(await post(P + '/graph/grade', { ns, value, band, label, why })); }
      case 'tag': { const [subject, ns, value, why] = args; if (!subject || !ns || !value) fail('tag <subject> <ns> <value> [why]'); return out(await post(P + '/graph/tag', { subject, ns, value, why, by: process.env.COCKPIT_AGENT || undefined })); }   // signed by the coder whose turn runs this (engine/harness.js COCKPIT_AGENT)
      case 'lens': { const [ns, title, purpose, graded] = args; if (!ns || !title) fail('lens <ns> <title> <purpose> [graded]'); return out(await post(P + '/graph/lens', { ns, title, purpose: purpose || '', graded: graded === 'graded' || graded === 'true' })); }
      case 'note': {
        // note [thread-id] <text> - with no number, the most recent conversation (a model passed a name
        // where a number was wanted and the ruling was lost, 2026-09-16)
        let [thread, ...t] = args;
        if (!/^\d+$/.test(thread || '')) { t = [thread].concat(t).filter(Boolean); const th = await get(P + '/chat/threads'); thread = th.threads && th.threads[0] ? th.threads[0].id : null; if (!thread) fail('no conversation to attach the note to'); }
        if (!t.length) fail('note [thread-id] <text>');
        return out(await post(P + '/chat/note', { thread: Number(thread), text: t.join(' ') }));
      }
      case 'files': return out(await get(P + '/files?path=' + encodeURIComponent(args[0] || '')));
      case 'starters': { const d = path.join(__dirname, 'starters'); return out({ ok: true, starters: fs.existsSync(d) ? fs.readdirSync(d).filter((x) => fs.statSync(path.join(d, x)).isDirectory()) : [] }); }
      case 'starter': {
        const kind = args[0]; if (!kind || kind.startsWith('--')) fail('starter <kind> --name <slug> --title <Title> --purpose <one line>');
        const src = path.join(__dirname, 'starters', kind); if (!fs.existsSync(src)) fail('no such starter: ' + kind + ' (see: starters)');
        const room = await get(P + '/room'); if (!room || room.missing) fail('project folder not reachable');
        const dest = room.path;
        const present = fs.readdirSync(dest).filter((x) => x !== '.cockpit' && x !== '.git');
        if (present.length && !args.includes('--force')) fail('the project folder already has files (' + present.slice(0, 5).join(', ') + '); a starter goes into an empty folder (--force to overwrite the starter\'s own files only)');
        const name = flag('name') || room.id.replace(/-dev$/, ''), title = flag('title') || room.name, purpose = flag('purpose') || 'one line about what this is';
        const vals = { NAME: name, UPPER: name.toUpperCase().replace(/[^A-Z0-9]/g, '_'), TITLE: title, PURPOSE: purpose, PORT_DEV: flag('port-dev') || '5100', PORT_PROD: flag('port-prod') || '5000', REPO_URL: flag('repo') || '<repo url>', DEV_DIR: dest, PROD_DIR: dest.replace(/_dev$/i, '') + '_prod', COCKPIT_DIR: path.join(__dirname) };
        const fill = (t) => t.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (vals[k] !== undefined ? vals[k] : m));
        const copied = [];
        const walk = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const e of fs.readdirSync(from, { withFileTypes: true })) { const a = path.join(from, e.name), b = path.join(to, e.name); if (e.isDirectory()) walk(a, b); else { fs.writeFileSync(b, fill(fs.readFileSync(a, 'utf8'))); copied.push(path.relative(dest, b).replace(/\\/g, '/')); } } };
        walk(src, dest);
        return out({ ok: true, starter: kind, into: dest, filled: vals, files: copied, next: 'git init -b main; copy .env.example to .env; npm run check; commit' });
      }
      case 'plugin-select': { const [name, jsonText] = args; if (!name) fail('plugin-select <plugin> <answers-json>'); let answers = {}; if (jsonText) { try { answers = JSON.parse(jsonText); } catch (e) { fail('answers must be JSON: ' + e.message); } } return out(await post(P + '/plugins/' + encodeURIComponent(name) + '/select', { answers })); }
      case 'project-set': { const b = {}; if (flag('name')) b.name = flag('name'); if (flag('urls') !== null) b.urls = flag('urls'); if (!Object.keys(b).length) fail('project-set --name <name> and/or --urls "a, b"'); return out(await fetch(BASE + '/api/projects/' + encodeURIComponent(pid), { method: 'PATCH', headers: { 'content-type': 'application/json', ...KEYH }, body: JSON.stringify(b) }).then((r) => r.json())); }
      case 'ticket': {
        /* the AI's end of the ticket process: draft one from the conversation (the owner approves it on the Tickets
           card - never file it yourself), adopt an issue pulled from GitHub, list, show */
        const sub = args[0];
        const lines = (v) => String(v || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
        if (sub === 'draft' || sub === 'adopt') {
          const b = { title: flag('title'), feature: flag('feature'), alter: lines(flag('alter')), create: lines(flag('create')), delete: lines(flag('delete')), why: flag('what') || flag('why') || '', done: flag('done') || '', tests: flag('tests') || '', doctrine: flag('doctrine') || '', finding: flag('finding'), flow: flag('flow'), scope: flag('scope'), by: 'ai', thread: Number(process.env.COCKPIT_THREAD) || null };   // thread: the conversation this turn runs in (engine/harness.js sets it) - the ticket remembers where it came from
          if (sub === 'adopt') { b.adopt = flag('number') || args[1]; if (!b.adopt) fail('ticket adopt --number <n> --alter <files> --done <read-back>'); }
          if (!b.title && sub === 'draft') fail('ticket draft --title "…" --feature <name> --alter "a.js,b.js" --create "c.js" --what "…" --done "…" [--tests "…"] [--finding <value> --scope "…"]');
          if (!b.done) fail('--done is needed: what a person reads back on the step before prod');
          if (sub === 'draft' && !b.flow) fail('--flow is needed: the README flow this change is part of (its browser test is written first and goes red, the code makes it green) - or --flow none when no person can see the change, with why in --what');
          return out(await post(P + '/tickets/draft', b));
        }
        if (sub === 'features') return out(await get(P + '/tickets/features'));
        if (sub === 'withdraw') { const id = String(args[1] || flag('id') || '').replace(/^#/, ''); if (!/^D\d+$/.test(id)) fail('ticket withdraw <D-id> - a draft only'); return out(await post(P + '/tickets/' + encodeURIComponent(id) + '/reject', { by: 'ai', why: flag('why') || 'withdrawn by the AI' })); }
        if (sub === 'send-back') {
          /* the ticket goes BACK TO THE CODERS, not onto the owner's list. The only legal way for an AI to move a ticket backwards, and the reason must be written. */
          const id = String(args[1] || flag('id') || '').replace(/^#/, ''), why = flag('why') || flag('text') || '';
          if (!id || !why) fail('ticket send-back <id> --why "what is wrong, in the words the coder will work from"');
          const r = await post(P + '/tickets/' + encodeURIComponent(id) + '/state', { state: 'created', by: 'ai', why });
          if (!r.ok) return out(r);
          const q = await post(BASE + '/api/fleet/items', { project: pid, ticket: id, priority: 'P1', source: 'sent back', text: 'Sent back: ' + why + String.fromCharCode(10) + String.fromCharCode(10) + 'Put exactly that right. The ticket is ' + id + '; touch only the files it names, commit, run the tests it names, then `ticket check ' + id + '` before you end.' });
          return out({ ok: true, ticket: id, state: 'created', queued: !!q.ok, why });
        }
        if (sub === 'check') {   // the coder's own look at the verdict before it ends the turn: the map re-read, the checks, nothing moved
          const id = String(args[1] || flag('id') || '').replace(/^#/, ''); if (!id) fail('ticket check <id>');
          return out(await post(P + '/tickets/' + encodeURIComponent(id) + '/verify', { dry: true }));
        }
        if (sub === 'edit') {
          const id = String(args[1] || flag('id') || '').replace(/^#/, ''); const b = {};
          for (const k of ['alter', 'create', 'delete', 'done', 'what', 'flow', 'title']) { const v = flag(k); if (v !== null && v !== undefined) b[k === 'what' ? 'why' : k] = ['alter', 'create', 'delete'].includes(k) ? lines(v) : v; }
          if (!id || !Object.keys(b).length) fail('ticket edit <id> [--alter "a.js,b.js"] [--create "c.js"] [--delete "d.js"] [--done <read-back>] [--what <why>] [--flow <name>] [--title <t>] - a list given replaces the list');
          return out(await post(P + '/tickets/' + encodeURIComponent(id) + '/edit', b));
        }
        if (sub === 'comment') { const id = String(args[1] || flag('id') || '').replace(/^#/, ''); const text = flag('text') || ''; if (!id || !text) fail('ticket comment <id> --text "…"'); return out(await post(P + '/tickets/' + encodeURIComponent(id) + '/comment', { text })); }
        // the owner's word in the conversation: the draft is filed and attached to this turn (engine/harness.js attachTicket), so the work that follows is judged as the ticket's
        if (sub === 'approve') { const id = String(args[1] || flag('id') || '').replace(/^#/, ''); if (!id) fail('ticket approve <D-id> [--now] - only when the owner told you to, in their own message'); return out(await post(P + '/tickets/' + encodeURIComponent(id) + '/approve', { by: 'owner, in the conversation', mode: has('now') ? 'now' : 'queue', priority: flag('priority') || 'next', turn: Number(process.env.COCKPIT_TURN) || null })); }
        if (sub && sub !== 'list') return out(await get(P + '/tickets/' + encodeURIComponent(sub.replace(/^#/, ''))));
        return out(await get(P + '/tickets'));
      }
      case 'projects': { const r = await get(BASE + '/api/projects'); return out({ ok: true, projects: (r.projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path })) }); }
      case 'architecture-doc': { const room = await get(P + '/room'); if (!room || room.missing) fail('project folder not reachable'); const a = require('./engine/archdoc'); const r = a.write(room.path, args.includes('--force')); console.log(r.written ? 'ARCHITECTURE.md ' + r.why + ' (schema v' + r.version + ')' : 'not written: ' + r.why + ' (schema v' + r.version + (r.have ? ', file v' + r.have : '') + ')'); return; }
      case 'codeowners': {
        /* ownership is declared once, in each feature README (an "@owner @login" line under the title); this writes
           .github\CODEOWNERS from those lines so GitHub asks the owner to review. Nothing else edits that file. */
        const room = await get(P + '/room'); if (!room || room.missing) fail('project folder not reachable'); const dir = room.path;
        const rows = [];
        const walkR = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { if (!/^(node_modules|\.git|\.cockpit|vendor|dist|build)$/.test(e.name) && depth < 6) walkR(path.join(d, e.name), depth + 1); } else if (/^readme\.md$/i.test(e.name)) { const md = fs.readFileSync(path.join(d, e.name), 'utf8'); const own = [...md.matchAll(/^\s*@owner\s+(@[\w-]+(?:\s+@[\w-]+)*)/gim)].map((m) => m[1]); if (own.length) rows.push({ folder: path.relative(dir, d).replace(/\\/g, '/'), owners: own.join(' ') }); } } };
        walkR(dir, 0);
        if (!rows.length) { console.log('no README declares an @owner line - nothing to write'); return; }
        const text = '# Generated by Cockpit (cli codeowners) from the @owner line of each feature README - edit those, not this.\n' + rows.map((r) => '/' + (r.folder ? r.folder + '/' : '') + ' ' + r.owners).join('\n') + '\n';
        fs.mkdirSync(path.join(dir, '.github'), { recursive: true }); fs.writeFileSync(path.join(dir, '.github', 'CODEOWNERS'), text);
        console.log('.github/CODEOWNERS: ' + rows.length + ' folder' + (rows.length === 1 ? '' : 's') + '\n' + text); return;
      }
      case 'look': {
        /* LOOK AT A PAGE the way the owner does. The engine's own Chromium (the one the flow tests use)
           opens the page, clicks what --click names, in order, and saves a screenshot the AI then opens with its image reader;
           the page's visible text comes back too, for a harness that cannot read images. Nothing is typed, nothing saved.
           --login signs in first with <secretsDir>\<project>\look-login.json {url, email, password} (engine/config.js) - a login made for the
           AIs, kept outside every repo; the session is kept beside it so the next look does not sign in again. */
        const url = args.find((a, i) => /^https?:\/\//.test(a) && args[i - 1] !== '--click');
        if (!url) fail('look <url> [--click "text"]... [--login] [--full] [--width 1400] [--wait ms]');
        const clicks = args.map((a, i) => (a === '--click' ? args[i + 1] : null)).filter(Boolean);
        const room = await get(P + '/room'); if (!room || room.missing) fail('project folder not reachable');
        const shotDir = path.join(room.path, '.cockpit', 'tmp', 'look'); fs.mkdirSync(shotDir, { recursive: true });
        const cfgDir = path.join(require('./engine/config').secretsDir(__dirname), pid), loginFile = path.join(cfgDir, 'look-login.json'), stateFile = path.join(cfgDir, 'look-session.json');
        process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'browsers');   // the portable Chromium (engine/tests.js does the same)
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: true });
        const steps = [];
        try {
          const ctx = await browser.newContext({ viewport: { width: Number(flag('width')) || 1400, height: 900 }, ignoreHTTPSErrors: true, storageState: has('login') && fs.existsSync(stateFile) ? stateFile : undefined });
          const page = await ctx.newPage();
          const settle = async () => { await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(Number(flag('wait')) || 800); };
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle();
          // no session yet, or it expired: the app sends the browser to its sign-in page - often a moment AFTER the page loads
          // (a site may redirect from the client), so wait for a password box before deciding there is none
          const onSignIn = async () => /login|sign-?in/i.test(new URL(page.url()).pathname) || (await page.locator('input[type="password"]').first().waitFor({ timeout: 5000 }).then(() => true, () => false));
          if (has('login') && await onSignIn()) {
            if (!fs.existsSync(loginFile)) fail('--login: no ' + loginFile + ' - the owner makes that login; ask for it, never use theirs');
            const L = JSON.parse(fs.readFileSync(loginFile, 'utf8'));
            if (L.url && !page.url().startsWith(L.url)) { await page.goto(L.url, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(); }
            await page.locator('input[type="email"]:visible').first().fill(L.email);
            await page.locator('input[type="password"]:visible').first().fill(L.password);
            await page.locator('input[type="password"]:visible').first().press('Enter');
            await page.waitForURL((u) => !/login|sign-?in/i.test(u.pathname), { timeout: 60000 }).catch(() => {});
            if (/login|sign-?in/i.test(new URL(page.url()).pathname)) fail('--login: still on the sign-in page after signing in - the login in ' + loginFile + ' was refused');
            steps.push('signed in as ' + L.email);
            await ctx.storageState({ path: stateFile });
            if (page.url() !== url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }); await settle(); }
          }
          for (const c of clicks) {
            const el = page.getByRole('tab', { name: c }).or(page.getByRole('button', { name: c })).or(page.getByRole('link', { name: c })).or(page.getByText(c, { exact: true })).first();
            if (!(await el.count())) { steps.push('NOT FOUND: ' + c); continue; }
            await el.click({ timeout: 10000 }).then(() => steps.push('clicked: ' + c), (e) => steps.push('could not click ' + c + ': ' + e.message.split('\n')[0]));
            await settle();
          }
          const file = path.join(shotDir, new Date().toISOString().replace(/[:.]/g, '-') + '.png');
          await page.screenshot({ path: file, fullPage: has('full') });
          for (const f of fs.readdirSync(shotDir).filter((x) => x.endsWith('.png')).sort().slice(0, -20)) fs.unlinkSync(path.join(shotDir, f));   // the newest 20 kept
          const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n{3,}/g, '\n\n').slice(0, 3000);
          return out({ ok: true, screenshot: file, open: 'read the screenshot file with your image/file reader to see the page', url: page.url(), title: await page.title(), steps, text });
        } finally { await browser.close().catch(() => {}); }
      }
      case 'remote': return out(await post(P + '/remote', { action: args[0] || 'status', name: flag('name') || undefined }));
      case 'tests': return out(args.includes('--run') ? await post(P + '/tests/run') : args.includes('--failures') ? await get(P + '/tests/failures') : await get(P + '/tests'));
      case 'declare': return out(args.includes('--draft') ? await post(P + '/declared/draft', { force: args.includes('--force') }) : await get(P + '/declared'));
      case 'lesson': { const t = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--topic').join(' '); if (!t) fail('lesson <text> [--topic <slug>]'); return out(await post(P + '/lesson', { text: t, topic: flag('topic') })); }
      case 'import-claude': { const dir = args.find((a) => !a.startsWith('--')) || '.cockpit/import'; return out(await post(P + '/import/claude', { dir, dry: args.includes('--dry') })); }
      /* THE QUEUE, from inside a conversation (docs/generic-ide.md §14: the COO in the Conversation
         card must be able to act, not only advise). Items carry this project's id; the queue
         manager runs them in any project's room with that project's own prompt tiers. */
      case 'queue': {
        const sub = args[0];
        /* the queue is run from Home by the COO AI; a project's AI only reads its own items (a project running the queue "will be chaos") */
        /* a project may ADD its own approved ticket to the queue - nothing else: no free-text items, no agent choice, no order, no park,
           no agents */
        const ownTicketAdd = sub === 'add' && pid !== 'home' && /^(next|P1|P2|P3)$/.test(args[1] || '') && /^(#?\d+|L\d+)$/.test(args[2] || '') && !args.includes('--') && !args.includes('--agent') && !args.includes('--project');
        if (sub && pid !== 'home' && !ownTicketAdd) fail('the queue is run from Home, not from a project - from here you may only add one of your own approved tickets: `queue add <next|P1|P2|P3> <ticket>`; `ticket approve D<n>` on the owner\'s word files and queues a draft; `queue` alone lists your items', 3);
        if (sub === 'agent') { const id = args[1], what = args[2]; if (!id || !/^(on|off|pause|resume)$/.test(what || '')) fail('queue agent <id> on|off|pause|resume'); return out(await post(BASE + '/api/fleet/agent/' + encodeURIComponent(id), what === 'on' ? { on: true, paused: false } : what === 'off' ? { on: false } : { paused: what === 'pause' })); }
        if (!sub) { const s = await get(BASE + '/api/fleet'); return out({ ok: true, agents: (s.agents || []).map((a) => ({ id: a.id, on: !!a.on, paused: !!a.paused })), items: (s.items || []).filter((i) => pid === 'home' || i.project === pid).map((i) => ({ id: i.id, project: i.project, priority: i.priority, status: i.status, title: i.title, claimedBy: i.claimedBy, turns: i.turns, outcome: i.outcome && { reason: i.outcome.reason, producedNothing: i.outcome.producedNothing } })), agents: (s.agents || []).map((a) => ({ id: a.id, on: a.on, paused: a.paused, running: !!a.running })) }); }
        if (sub === 'add') {
          const forProject = flag('project') || pid; if (pid === 'home' && forProject === 'home') fail('queue add needs --project <id> from home - which project\'s ticket?');
          if (/^(next|P1|P2|P3)$/.test(args[1] || '') && /^(#?\d+|L\d+)$/.test(args[2] || '') && !args.includes('--')) return out(await post(BASE + '/api/fleet/items', { project: forProject, ticket: args[2].replace(/^#/, ''), priority: args[1], agent: flag('agent') || null, source: 'conversation' }));
          /* a free-text item goes to the project --project names, and the flags never become words of the title (Home's
             "queue add P2 --project notes <title>" once landed on Home with "--project notes" in its title) */
          const dd = args.indexOf('--'), priority = args[1];
          const words = (dd > 0 ? args.slice(2, dd) : args.slice(2)).filter((a, i, all) => !/^--(project|agent)$/.test(a) && !/^--(project|agent)$/.test(all[i - 1] || ''));
          const title = words.join(' '), text = dd > 0 ? args.slice(dd + 1).join(' ') : '';
          if (!/^(next|P1|P2|P3)$/.test(priority || '') || !title) fail('queue add <next|P1|P2|P3> <ticket> [--agent <id>]   or   queue add <next|P1|P2|P3> <title> [--project <id>] -- <the ask>');
          return out(await post(BASE + '/api/fleet/items', { project: forProject, title, text: text || title, priority, agent: flag('agent') || null, source: 'conversation' }));
        }
        if (sub === 'park' || sub === 'unpark') { if (!/^\d+$/.test(args[1] || '')) fail('queue ' + sub + ' <id>'); return out(await post(BASE + '/api/fleet/items/' + args[1], { status: sub === 'park' ? 'parked' : 'queued' })); }
        fail('queue [add|park|unpark]');
      }
      /* HANDOFF - Home sends a message straight into another project's conversation. The queue
         cannot carry work to a project that works only in its own conversation (such a project refused Home's approved
         plan as a queue item); this posts it there, and that project's AI answers in its own room. Home only. */
      case 'handoff': {
        if (pid !== 'home') fail('handoff is run from Home only', 3);
        const to = args[0], dd = args.indexOf('--'), text = dd >= 0 ? args.slice(dd + 1).join(' ').trim() : '';
        if (!to || to.startsWith('--') || !text) fail('handoff <project> [--thread <id>] -- <the message>');
        if (to === 'home') fail('handoff is for another project - you are Home');
        const TP = BASE + '/api/p/' + encodeURIComponent(to);
        let thread = flag('thread') ? Number(flag('thread')) : null;
        if (!thread) { const t = await get(TP + '/chat/threads'); if (t.ok === false) fail('no project ' + to + ': ' + (t.error || '')); thread = (t.threads || [])[0] ? t.threads[0].id : null; }
        const r = await post(TP + '/chat/send', { thread, text: 'From Home (handoff):\n\n' + text });
        return out(r.ok ? { ok: true, project: to, thread: r.thread, turn: r.turn, note: 'sent - ' + to + '\'s AI answers in its own conversation' } : r);
      }
      default: fail('unknown command ' + cmd, 2);
    }
  } catch (e) { fail('engine unreachable at ' + BASE + ': ' + e.message); }
})();
