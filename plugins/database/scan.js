#!/usr/bin/env node
/* Database scan - the project's live MySQL database, into the project's db_ tables.
   Run by the engine as a child process (on demand, and every `every` minutes while the room is open):
     node scan.js <projectDir> <dbPath> <answersJson>
   Prints ONE JSON line: { ok, yields, note }.

   Zero-install: no project has a MySQL driver and nothing is ever installed, so everything goes
   through the mysql command-line client already on the machine (the same fallback the starter's
   setup-db / backup use). Read-only by construction: information_schema for the shape, one
   SELECT ... LIMIT per table for the peek; there is no statement here that is not a SELECT.

   The credentials come from the file the wizard names (default .env): DB_HOST / DB_PORT /
   DB_NAME / DB_USER / DB_PASSWORD, or a PHP file returning ['host','dbname','username','password'].
   The password is read here, handed to the client as MYSQL_PWD in the child's environment (never
   on a command line, where a process list would show it), scrubbed from every message, and
   never written anywhere. DATABASE_URL that is not mysql:// (Postgres) is out of this cut and
   says so rather than half-working.

   The caps are code, not settings (doctrine: caps-in-code-not-prompts): PEEK_ROWS, CELL_MAX,
   COUNT_MAX below. */
'use strict';
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PEEK_ROWS = 50;            // the latest rows kept per table
const CELL_MAX = 300;            // a cell longer than this is cut with an ellipsis
const COUNT_MAX = 2000000;       // COUNT(*) is exact up to this estimate; above it the estimate is kept (a full count would stall)

const [,, projectDir, dbPath, answersJson] = process.argv;
const A = JSON.parse(answersJson || '{}');
const say = (s) => process.stderr.write(scrub(s) + '\n');
const out = (o) => { if (o.note) o.note = scrub(o.note); console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 2); };
let secret = '';
function scrub(s) { s = String(s == null ? '' : s); return secret ? s.split(secret).join('***') : s; }

/* ---------- credentials ---------- */
/* where credentials usually are, looked at in order when the plugin was not told: the project's .env, the usual PHP config files, and the
   config folder beside the apps (<apps parent>\config\<project>\…) where a site keeps what must never be in the repository */
/* the credentials and the client: plugins/database/creds.js - one reader, shared with the engine's backups (engine/backup.js) */
const creds = require('./creds');
function readCredentials() { return creds.read(projectDir, A); }
function findClient() { return creds.client(A, 'mysql'); }

/* mysql --batch prints tab-separated rows, the column names first; a backslash, newline, tab or NUL
   inside a value is escaped as \\ \n \t \0, and NULL is the bare word. Undo exactly that. */
function unescapeCell(s) {
  if (s === 'NULL') return null;
  if (s.indexOf('\\') < 0) return s;
  let o = ''; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch !== '\\' || i === s.length - 1) { o += ch; continue; } const n = s[++i]; o += n === 'n' ? '\n' : n === 't' ? '\t' : n === '0' ? '\0' : n === '\\' ? '\\' : '\\' + n; }
  return o;
}
function makeRunner(client, c) {
  const args = ['--host=' + c.host, '--port=' + c.port, '--user=' + c.user, '--batch', '--column-names', '--binary-as-hex', '--default-character-set=utf8mb4', '--connect-timeout=10'];
  const env = { ...process.env, MYSQL_PWD: c.password };   // the only place the password goes
  return function run(sql, database) {
    const r = cp.spawnSync(client, [...args, ...(database ? ['--database=' + database] : []), '-e', sql], { encoding: 'utf8', windowsHide: true, env, maxBuffer: 1 << 28, timeout: 120000 });
    if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'mysql client not found: ' + client : 'mysql: ' + r.error.message);
    if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || 'mysql failed').trim().split(/\r?\n/).filter((l) => !/^mysql: \[Warning\]/.test(l)).slice(-2).join(' | ').slice(0, 300));
    const lines = String(r.stdout || '').replace(/\r\n/g, '\n').split('\n'); while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return { columns: [], rows: [] };
    const columns = lines[0].split('\t');
    return { columns, rows: lines.slice(1).map((l) => l.split('\t').map(unescapeCell)) };
  };
}
const q = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const lit = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const asObjects = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c.toLowerCase(), r[i]])));

/* ---------- go ---------- */
const c = readCredentials();
if (c.error) out({ ok: false, note: c.error });
secret = c.password;
const client = findClient();
if (!client) out({ ok: false, note: 'no mysql client: not on PATH and no MySQL Server install found - name it in the plugin\'s settings' });

const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const now = new Date().toISOString();
const yields = { tables: 0, views: 0, columns: 0, indexes: 0, keys: 0, rows: 0, peeked: 0 };
const notes = [];
let run, version = '';
try {
  run = makeRunner(client, c);
  version = ((run('SELECT VERSION() AS v').rows[0] || [])[0]) || '';
} catch (e) { out({ ok: false, note: c.name + '@' + c.host + ' as ' + c.user + ': ' + e.message }); }

const S = lit(c.name);
let tables, columns, stats, fks;
try {
  tables = asObjects(run('SELECT table_name, table_type, engine, table_rows, data_length, index_length, create_time, update_time, table_comment FROM information_schema.tables WHERE table_schema = ' + S + ' ORDER BY table_name'));
  columns = asObjects(run('SELECT table_name, ordinal_position, column_name, column_type, is_nullable, column_default, column_key, extra, column_comment FROM information_schema.columns WHERE table_schema = ' + S + ' ORDER BY table_name, ordinal_position'));
  stats = asObjects(run('SELECT table_name, index_name, non_unique, seq_in_index, column_name, index_type FROM information_schema.statistics WHERE table_schema = ' + S + ' ORDER BY table_name, index_name, seq_in_index'));
  fks = asObjects(run('SELECT k.table_name, k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name, k.ordinal_position, r.update_rule, r.delete_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name WHERE k.table_schema = ' + S + ' AND k.referenced_table_name IS NOT NULL ORDER BY k.table_name, k.constraint_name, k.ordinal_position'));
} catch (e) { out({ ok: false, note: c.name + ': ' + e.message }); }
if (!tables.length) notes.push('the database ' + c.name + ' has no tables (or the user cannot see them)');

/* shape per table */
const T = new Map();
for (const t of tables) T.set(t.table_name, { name: t.table_name, type: /view/i.test(t.table_type) ? 'view' : 'table', engine: t.engine, est: Number(t.table_rows) || 0, rows: null, exact: 0, data: Number(t.data_length) || 0, index: Number(t.index_length) || 0, cols: [], pk: [], created: t.create_time, updated: t.update_time, comment: t.table_comment || '' });
for (const col of columns) { const t = T.get(col.table_name); if (!t) continue; t.cols.push(col); if (col.column_key === 'PRI') t.pk.push(col.column_name); }
const IX = new Map();   // table\0index -> { unique, columns, type }
for (const s of stats) { const k = s.table_name + '\0' + s.index_name; const ix = IX.get(k) || IX.set(k, { table: s.table_name, name: s.index_name, unique: String(s.non_unique) === '0' ? 1 : 0, columns: [], type: s.index_type }).get(k); ix.columns.push(s.column_name); }
const FK = new Map();
for (const f of fks) { const k = f.table_name + '\0' + f.constraint_name; const fk = FK.get(k) || FK.set(k, { table: f.table_name, name: f.constraint_name, columns: [], ref: f.referenced_table_name, refColumns: [], onUpdate: f.update_rule, onDelete: f.delete_rule }).get(k); fk.columns.push(f.column_name); fk.refColumns.push(f.referenced_column_name); }

/* exact counts in one round trip - for the tables small enough to count (the cap is code) */
const countable = [...T.values()].filter((t) => t.type === 'table' && t.est <= COUNT_MAX);
if (countable.length) {
  try {
    const rs = run(countable.map((t) => 'SELECT ' + lit(t.name) + ' AS t, COUNT(*) AS n FROM ' + q(t.name)).join(' UNION ALL '), c.name);
    for (const [name, n] of rs.rows) { const t = T.get(name); if (t) { t.rows = Number(n); t.exact = 1; } }
  } catch (e) { notes.push('exact counts: ' + e.message); }
}
for (const t of T.values()) if (t.rows === null) t.rows = t.est;

/* the peek: the latest PEEK_ROWS rows of each table, newest first by the primary key when there is one */
const peeks = [];
for (const t of T.values()) {
  const orderBy = t.pk.length ? t.pk[t.pk.length - 1] : null;
  try {
    const rs = run('SELECT * FROM ' + q(t.name) + (orderBy ? ' ORDER BY ' + q(orderBy) + ' DESC' : '') + ' LIMIT ' + PEEK_ROWS, c.name);
    const rows = rs.rows.map((r) => r.map((v) => v === null ? null : v.length > CELL_MAX ? v.slice(0, CELL_MAX) + '…' : v));
    peeks.push({ table: t.name, columns: rs.columns.length ? rs.columns : t.cols.map((x) => x.column_name), rows, orderBy });
    yields.peeked++;
  } catch (e) { notes.push(t.name + ': ' + e.message); }
}

/* ---------- write ---------- */
db.exec('BEGIN');
for (const tb of ['db_table', 'db_column', 'db_index', 'db_fk', 'db_peek', 'db_meta']) db.exec('DELETE FROM ' + tb);
const insT = db.prepare('INSERT INTO db_table (name, type, engine, rows, exact, data_bytes, index_bytes, columns, pk, created, updated, comment, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insC = db.prepare('INSERT OR REPLACE INTO db_column (table_name, position, name, type, nullable, dflt, key, extra, comment) VALUES (?,?,?,?,?,?,?,?,?)');
const insI = db.prepare('INSERT OR REPLACE INTO db_index (table_name, name, is_unique, columns, type) VALUES (?,?,?,?,?)');
const insF = db.prepare('INSERT OR REPLACE INTO db_fk (table_name, name, columns, ref_table, ref_columns, on_update, on_delete) VALUES (?,?,?,?,?,?,?)');
const insP = db.prepare('INSERT OR REPLACE INTO db_peek (table_name, columns, rows, order_by, at) VALUES (?,?,?,?,?)');
const insM = db.prepare('INSERT OR REPLACE INTO db_meta (key, value) VALUES (?,?)');
for (const t of T.values()) {
  insT.run(t.name, t.type, t.engine, t.rows, t.exact, t.data, t.index, t.cols.length, JSON.stringify(t.pk), t.created, t.updated, t.comment, now);
  if (t.type === 'view') yields.views++; else { yields.tables++; yields.rows += t.rows; }
  for (const col of t.cols) { insC.run(t.name, Number(col.ordinal_position), col.column_name, col.column_type, /yes/i.test(col.is_nullable) ? 1 : 0, col.column_default, col.column_key || '', col.extra || '', col.column_comment || ''); yields.columns++; }
}
for (const ix of IX.values()) { if (!T.has(ix.table)) continue; insI.run(ix.table, ix.name, ix.unique, JSON.stringify(ix.columns), ix.type); yields.indexes++; }
for (const fk of FK.values()) { if (!T.has(fk.table)) continue; insF.run(fk.table, fk.name, JSON.stringify(fk.columns), fk.ref, JSON.stringify(fk.refColumns), fk.onUpdate, fk.onDelete); yields.keys++; }
for (const p of peeks) insP.run(p.table, JSON.stringify(p.columns), JSON.stringify(p.rows), p.orderBy, now);
insM.run('database', c.name); insM.run('host', c.host); insM.run('port', String(c.port)); insM.run('user', c.user); insM.run('credentials', c.file);
insM.run('client', client); insM.run('version', version); insM.run('scannedAt', now); insM.run('peekRows', String(PEEK_ROWS)); insM.run('cellMax', String(CELL_MAX));
insM.run('note', notes.join('; '));
db.exec('COMMIT');

const note = c.name + '@' + c.host + ' (MySQL ' + version + '): ' + yields.tables + ' table' + (yields.tables === 1 ? '' : 's') + (yields.views ? ', ' + yields.views + ' view' + (yields.views === 1 ? '' : 's') : '') + ', ' + yields.rows.toLocaleString('en-US') + ' rows, ' + yields.columns + ' columns' + (notes.length ? ' - ' + notes.join('; ') : '');
say(note);
out({ ok: true, yields, note });
