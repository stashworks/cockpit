#!/usr/bin/env node
/* Remove a secret that was typed into a conversation.

   The secret is typed HERE, hidden, never in a chat - so it does not land in a transcript again.
   Every place a conversation is kept is scrubbed, the secret replaced by ********:
     <project>\.cockpit\cockpit.db          chat_turn.text and chat_turn.context
     <project>\.cockpit\conversations\*.md  the readable export of every thread
     <project>\.cockpit\logs\turns.jsonl    the harness event stream (tool calls can echo it)
     <engine>\turns.jsonl                   the global ledger (no text, scrubbed anyway)
     <users>\*\.claude\projects\*\*.jsonl   Claude Code's own session files for the project folder
     <users>\*\.codex\sessions\**\*.jsonl   Codex's session files
   The last two live on the machine the harness ran on - run this once on the machine the engine runs on
   as well as on any other machine that reaches the project over a share.

   Usage:  node tools\scrub-secret.js <project-id> [<project-id> ...]
           node tools\scrub-secret.js --all
           node tools\scrub-secret.js --from-turn <project-id>:<turn-id> --all
             the secret is the WHOLE text of that turn (a message that was nothing but the password) -
             nothing typed at all. Run it on the machine the engine runs on: the paths in projects.json
             are that machine's.
   Safe with the engine running (SQLite WAL). Idempotent. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const engineRoot = path.join(__dirname, '..');
const registry = JSON.parse(fs.readFileSync(path.join(engineRoot, 'projects.json'), 'utf8'));
const all = Array.isArray(registry) ? registry : registry.projects || [];
const argv = process.argv.slice(2);
const ftIdx = argv.indexOf('--from-turn'); const fromTurn = ftIdx >= 0 ? argv[ftIdx + 1] : null;
const ids = argv.filter((a, i) => a !== '--from-turn' && i !== ftIdx + 1);
if (!ids.length) { console.error('usage: node tools\\scrub-secret.js <project-id> [...] | --all'); process.exit(2); }
const picked = ids.includes('--all') ? all : all.filter((p) => ids.includes(p.id));
const missing = ids.filter((i) => i !== '--all' && !all.some((p) => p.id === i));
if (missing.length) { console.error('unknown project: ' + missing.join(', ') + ' (known: ' + all.map((p) => p.id).join(', ') + ')'); process.exit(2); }

function hidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput;
    rl.question(prompt, (a) => { rl._writeToOutput = write; rl.close(); process.stdout.write('\n'); resolve(a); });
    rl._writeToOutput = () => {};
  });
}

const MASK = '********';
function scrubText(s, secret) { return s.split(secret).join(MASK); }
function scrubFile(file, secret) {
  let s; try { s = fs.readFileSync(file, 'utf8'); } catch (e) { return 0; }
  if (!s.includes(secret)) return 0;
  const n = s.split(secret).length - 1;
  fs.writeFileSync(file, scrubText(s, secret));
  return n;
}
function walk(dir, ext, out = []) {
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of list) { const f = path.join(dir, d.name); if (d.isDirectory()) walk(f, ext, out); else if (d.name.endsWith(ext)) out.push(f); }
  return out;
}

(async () => {
  const here = picked.filter((p) => fs.existsSync(p.path));
  if (!here.length) { console.error('none of these project folders exist on this machine (' + picked.map((p) => p.path).join(', ') + ') - run this on the machine the engine runs on'); process.exit(2); }
  let secret;
  if (fromTurn) {
    const m = fromTurn.match(/^([^:]+):(\d+)$/); if (!m) { console.error('--from-turn <project-id>:<turn-id>'); process.exit(2); }
    const src = all.find((p) => p.id === m[1]); if (!src) { console.error('unknown project ' + m[1]); process.exit(2); }
    const db = new DatabaseSync(path.join(src.path, '.cockpit', 'cockpit.db'), { readOnly: true });
    const row = db.prepare('SELECT text FROM chat_turn WHERE id = ?').get(Number(m[2])); db.close();
    secret = row && row.text ? row.text.trim() : '';
    if (!secret || secret.length < 4 || secret === MASK || /\s/.test(secret)) { console.error('turn ' + fromTurn + ' is not a lone secret (empty, already scrubbed, or has spaces) - nothing changed'); process.exit(2); }
    console.log('secret taken from turn ' + fromTurn + ' (' + secret.length + ' characters, not shown)');
  } else {
    secret = await hidden('the secret to remove (typed hidden): ');
    if (!secret || secret.length < 4) { console.error('nothing to do - too short to be a secret'); process.exit(2); }
    const again = await hidden('once more to be sure: ');
    if (again !== secret) { console.error('the two do not match - nothing changed'); process.exit(2); }
  }

  let total = 0;
  const say = (n, what) => { if (n) { total += n; console.log('  ' + n + ' x in ' + what); } };
  for (const p of here) {
    console.log(p.id + '  (' + p.path + ')');
    const cockpit = path.join(p.path, '.cockpit');
    // 1. the database
    const dbFile = path.join(cockpit, 'cockpit.db');
    if (fs.existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile);
      let n = 0;
      for (const col of ['text', 'context']) {
        const rows = db.prepare('SELECT id, ' + col + ' AS v FROM chat_turn WHERE ' + col + ' IS NOT NULL').all();
        const upd = db.prepare('UPDATE chat_turn SET ' + col + ' = ? WHERE id = ?');
        for (const r of rows) { if (r.v && r.v.includes(secret)) { upd.run(scrubText(r.v, secret), r.id); n++; } }
      }
      db.close();
      say(n, 'cockpit.db turns');
    }
    // 2. the readable exports, 3. the event log
    for (const f of walk(path.join(cockpit, 'conversations'), '.md')) say(scrubFile(f, secret), path.relative(p.path, f));
    say(scrubFile(path.join(cockpit, 'logs', 'turns.jsonl'), secret), '.cockpit\\logs\\turns.jsonl');
    // 5/6. the harnesses' own session files on THIS machine, for this project folder
    const slug = p.path.replace(/[:\\/]+/g, '-');
    // every user's home on this machine: the folder that holds this user's home (the users folder on Windows and macOS)
    const usersDir = path.dirname(require('node:os').homedir());
    let users = []; try { users = fs.readdirSync(usersDir).map((u) => path.join(usersDir, u)); } catch (e) { /* unreadable */ }
    for (const home of users) {
      for (const f of walk(path.join(home, '.claude', 'projects'), '.jsonl')) if (f.includes(slug)) say(scrubFile(f, secret), f);
      for (const f of walk(path.join(home, '.codex', 'sessions'), '.jsonl')) say(scrubFile(f, secret), f);
    }
  }
  say(scrubFile(path.join(engineRoot, 'turns.jsonl'), secret), 'engine turns.jsonl');
  console.log(total ? 'done - ' + total + ' occurrence(s) replaced with ' + MASK : 'nothing found on this machine - if the harness ran elsewhere, run this there too');
})();
