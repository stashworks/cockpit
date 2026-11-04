/* One SQLite database per project, at <project>\.cockpit\cockpit.db. node:sqlite, no driver. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file, schemaFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(fs.readFileSync(schemaFile, 'utf8'));
  // columns added after the first release: a no-op once present
  try { db.exec('ALTER TABLE chat_turn ADD COLUMN context TEXT'); } catch (e) { /* already there */ }
  return wrap(db);
}

/* A thin wrapper so callers write db.all / db.get / db.run and never touch prepare(). */
function wrap(db) {
  return {
    raw: db,
    all: (sql, ...args) => db.prepare(sql).all(...args),
    get: (sql, ...args) => db.prepare(sql).get(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    exec: (sql) => db.exec(sql),
    now: () => new Date().toISOString(),
    close: () => db.close()
  };
}

module.exports = { openDb };
