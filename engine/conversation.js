/* The conversation is Cockpit's (docs/generic-ide.md §4). Threads and turns live in the
   project's database; every thread is also mirrored as markdown in .cockpit\conversations\
   so it can be read and grepped without Cockpit; every harness event goes to
   .cockpit\logs\turns.jsonl - one shape, harness and model are columns. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function threads(p) {
  return p.db.all('SELECT t.*, (SELECT count(*) FROM chat_turn WHERE thread_id = t.id) n, (SELECT text FROM chat_turn WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) last FROM chat_thread t ORDER BY updated DESC');
}
function thread(p, id) {
  const t = p.db.get('SELECT * FROM chat_thread WHERE id = ?', id);
  if (!t) return null;
  return { ...t, turns: p.db.all('SELECT * FROM chat_turn WHERE thread_id = ? ORDER BY id', id), notes: p.db.all('SELECT * FROM chat_note WHERE thread_id = ? ORDER BY id', id) };
}
function create(p, title) {
  const now = p.db.now();
  const r = p.db.run('INSERT INTO chat_thread (title, subjects, created, updated) VALUES (?,?,?,?)', title || 'New conversation', '', now, now);
  return Number(r.lastInsertRowid);
}
function addTurn(p, threadId, role, text, harness, model, cost, context) {
  const now = p.db.now();
  p.db.run('INSERT INTO chat_turn (thread_id, role, text, harness, model, cost_json, at, context) VALUES (?,?,?,?,?,?,?,?)', threadId, role, text, harness || null, model || null, cost ? JSON.stringify(cost) : null, now, context || null);
  p.db.run('UPDATE chat_thread SET updated = ? WHERE id = ?', now, threadId);
  // A thread named by its first message reads better in the list than "New conversation".
  const t = p.db.get('SELECT title FROM chat_thread WHERE id = ?', threadId);
  if (role === 'user' && t && t.title === 'New conversation') p.db.run('UPDATE chat_thread SET title = ? WHERE id = ?', text.replace(/\s+/g, ' ').slice(0, 60), threadId);
  mirror(p, threadId);
}
function addNote(p, threadId, text, by) {
  p.db.run('INSERT INTO chat_note (thread_id, subject, text, by, at) VALUES (?,?,?,?,?)', threadId, '', text, by || 'owner', p.db.now());
  mirror(p, threadId);
}

/* The markdown mirror: one file per thread, rewritten whole on every change. Small files,
   whole rewrites - no partial-write state to get wrong. */
function mirror(p, threadId) {
  const t = thread(p, threadId);
  if (!t) return;
  const dir = path.join(p.cockpit.dir, 'conversations');
  const safe = String(t.title || 'conversation').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 50);
  const file = path.join(dir, String(t.id).padStart(4, '0') + '-' + (safe || 'conversation') + '.md');
  const lines = ['# ' + t.title, '', '_thread ' + t.id + ' · created ' + t.created + ' · updated ' + t.updated + '_', ''];
  if (t.notes.length) { lines.push('## Standing rulings', ''); t.notes.forEach((n) => lines.push('- ' + n.text + '  _(' + n.by + ', ' + n.at.slice(0, 10) + ')_')); lines.push(''); }
  lines.push('## Turns', '');
  t.turns.forEach((u) => {
    lines.push('### ' + (u.role === 'user' ? 'User' : 'Assistant') + (u.harness ? ' · ' + u.harness + (u.model ? ' / ' + u.model : '') : '') + ' · ' + u.at.slice(0, 16).replace('T', ' '));
    lines.push('', u.text, '');
  });
  // an earlier file for the same thread under an older title is superseded, not left beside it
  try { fs.readdirSync(dir).filter((f) => f.startsWith(String(t.id).padStart(4, '0') + '-') && path.join(dir, f) !== file).forEach((f) => fs.unlinkSync(path.join(dir, f))); } catch (e) { /* nothing */ }
  fs.writeFileSync(file, lines.join('\n'));
}

/* One line per harness event, every harness, one shape. Written as it happens so a killed
   turn still leaves its trail. */
function logEvent(p, turnId, threadId, harness, model, ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), turn: turnId, thread: threadId, harness, model, ...ev });
  fs.appendFileSync(path.join(p.cockpit.dir, 'logs', 'turns.jsonl'), line + '\n');
}

module.exports = { threads, thread, create, addTurn, addNote, mirror, logEvent };
