#!/usr/bin/env node
/* Import Claude Code session transcripts into a Cockpit project's conversations, so a project
   that moved into Cockpit keeps its history.

   Claude Code keeps each session as <home>\.claude\projects\<folder-slug>\<session>.jsonl - one
   JSON object per line: type user / assistant with message.content blocks (text, tool_use,
   tool_result, thinking) and a timestamp. Only what the two people said survives the import:
   the user's text and the assistant's text, in order, dated. Tool calls are folded into one
   line per run ("[used N tools: Read, Edit ...]") so the shape of the work is visible without
   the noise. Thinking blocks are not carried (they were never part of the conversation).

   Usage:  node import-claude-sessions.js <project-dir> <sessions-dir> [--dry]
   The project's .cockpit\cockpit.db must exist (open the project in Cockpit once). Idempotent:
   a session already imported (by its id in the thread title) is skipped. Safe with the engine
   running - SQLite WAL - but close the project first if you can, so the room re-reads. */
'use strict';
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [,, projectDir, sessionsDir] = process.argv;
const DRY = process.argv.includes('--dry');
if (!projectDir || !sessionsDir) { console.error('usage: node import-claude-sessions.js <project-dir> <sessions-dir> [--dry]'); process.exit(2); }
const dbPath = path.join(projectDir, '.cockpit', 'cockpit.db');
if (!fs.existsSync(dbPath)) { console.error('no .cockpit\\cockpit.db in ' + projectDir + ' - open the project in Cockpit once first'); process.exit(2); }
const db = new DatabaseSync(dbPath);

const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(sessionsDir, f));
if (!files.length) { console.log('no .jsonl sessions in ' + sessionsDir); process.exit(0); }

function parse(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const turns = []; let firstUser = null, sessionId = null;
  for (const r of rows) {
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.isSidechain) continue;   // a subagent's own transcript, not the conversation
    const m = r.message || {}; const content = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
    const at = r.timestamp || null;
    if (r.type === 'user') {
      const texts = content.filter((c) => c.type === 'text').map((c) => c.text).filter((t) => t && !/^<(command-name|local-command|system-reminder)/.test(t.trim()));
      if (!texts.length) continue;   // tool results come back as 'user' rows; they are not the person speaking
      const text = texts.join('\n').trim(); if (!text) continue;
      if (!firstUser) firstUser = text;
      turns.push({ role: 'user', text, at });
    } else {
      const texts = content.filter((c) => c.type === 'text').map((c) => c.text).filter(Boolean);
      const tools = content.filter((c) => c.type === 'tool_use').map((c) => c.name);
      const model = m.model || null;
      let text = texts.join('\n').trim();
      if (tools.length) text = (text ? text + '\n\n' : '') + '[used ' + tools.length + ' tool' + (tools.length === 1 ? '' : 's') + ': ' + [...new Set(tools)].join(', ') + ']';
      if (!text) continue;
      // consecutive assistant rows are one reply (streaming writes several); merge them
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') { last.text += '\n' + text; continue; }
      turns.push({ role: 'assistant', text, at, model });
    }
  }
  return { sessionId: sessionId || path.basename(file, '.jsonl'), turns, firstUser, started: turns.length ? turns[0].at : null, ended: turns.length ? turns[turns.length - 1].at : null };
}

let imported = 0, skipped = 0;
for (const file of files.sort()) {
  const s = parse(file);
  if (!s.turns.length) { console.log('skip (no conversation) ' + path.basename(file)); skipped++; continue; }
  const marker = 'claude-code ' + s.sessionId.slice(0, 8);
  const have = db.prepare("SELECT id FROM chat_thread WHERE title LIKE ?").get('%[' + marker + ']%');
  if (have) { console.log('already imported ' + marker + ' (thread ' + have.id + ')'); skipped++; continue; }
  const day = (s.started || '').slice(0, 10);
  const title = (day ? day + ' · ' : '') + String(s.firstUser || 'conversation').replace(/\s+/g, ' ').slice(0, 70) + ' [' + marker + ']';
  console.log((DRY ? 'would import ' : 'importing ') + marker + ': ' + s.turns.length + ' turns, ' + day + ' → ' + (s.ended || '').slice(0, 10) + ' - "' + title.slice(0, 60) + '"');
  if (DRY) continue;
  db.exec('BEGIN');
  const t = db.prepare('INSERT INTO chat_thread (title, subjects, created, updated) VALUES (?,?,?,?)').run(title, '', s.started || new Date().toISOString(), s.ended || new Date().toISOString());
  const tid = Number(t.lastInsertRowid);
  const ins = db.prepare('INSERT INTO chat_turn (thread_id, role, text, harness, model, cost_json, at) VALUES (?,?,?,?,?,?,?)');
  for (const u of s.turns) ins.run(tid, u.role, u.text, u.role === 'assistant' ? 'claude-code' : null, u.model || null, null, u.at || new Date().toISOString());
  db.exec('COMMIT');
  imported++;
}
console.log((DRY ? 'dry run: ' : '') + imported + ' session' + (imported === 1 ? '' : 's') + ' imported, ' + skipped + ' skipped');
