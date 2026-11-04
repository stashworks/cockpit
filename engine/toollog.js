/* Every command a coder runs, kept. Each harness reports its tool calls to the engine as they start and end; without a
   record, a command that does damage (ending every process, deleting a folder) leaves no trace of which coder ran it.
   Each adapter hands its tool events here as they arrive: one JSON line per tool start and per tool end, appended at once
   (sync) so the line is on disk before the command can do anything. logs\tool-calls-<UTC date>.jsonl.
   The full command is kept (up to 4000 characters), not the 160-character label the interface shows.
   Stateless: the adapters reach it through hot(), so a change here needs no restart. Never fails a turn. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'logs');

function write(turn, harness, ev) {
  try {
    const e = (turn && turn.env) || {};
    const at = new Date().toISOString();
    const line = {
      at, project: e.COCKPIT_PROJECT || null, thread: e.COCKPIT_THREAD || null, turn: e.COCKPIT_TURN || null,
      agent: e.COCKPIT_AGENT || harness, harness, id: ev.id || null,
      tool: ev.name || null,                                                  // null on a tool's end
      command: ev.full != null ? String(ev.full).slice(0, 4000) : (ev.input != null ? String(ev.input) : null),
      ok: ev.ok == null ? null : ev.ok,
      output: ev.output != null ? String(ev.output).slice(0, 400) : null,
    };
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'tool-calls-' + at.slice(0, 10) + '.jsonl'), JSON.stringify(line) + '\n');
  } catch (err) { /* logging never fails a turn */ }
}

/* log(turn, harness, ev) for the adapters: re-reads this file when it changes, swallows everything */
function log(turn, harness, ev) { try { require('./hot').hot(__filename).write(turn, harness, ev); } catch (err) { /* never fails a turn */ } }

module.exports = { write, log };
