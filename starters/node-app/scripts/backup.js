#!/usr/bin/env node
/* {{TITLE}} - dump the database to a file, and prove the file with a summary (the project's own; Cockpit's restore
   drill runs this against the TEST database, and the nightly job runs it against prod).

     node scripts\backup.js                     -> <folder>\{{NAME}}_<db>-<stamp>.sql, folder from BACKUP_DIR or .env
     node scripts\backup.js --out <file>        -> that file
     node scripts\backup.js --summary           -> print the row count per table as JSON, dump nothing

   Environment (from .env, overridden by the process environment): DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD, BACKUP_DIR.
   Talks to MySQL with mysql2 (npm) when installed, else mysqldump / mysql on PATH. The dump is plain SQL: every table's
   CREATE, then its rows as INSERTs, in one transaction - restore.js applies it. The last line of stdout is a JSON summary
   { file, bytes, tables: { name: rows } } so a caller can read back what was written, not assume it. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.join(__dirname, '..');

const env = {};
try { for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { /* environment only */ }
const get = (k, d) => process.env[k] !== undefined ? process.env[k] : env[k] !== undefined ? env[k] : d;
const DB = { host: get('DB_HOST', '127.0.0.1'), port: Number(get('DB_PORT', 3306)), name: get('DB_NAME', ''), user: get('DB_USER', ''), password: get('DB_PASSWORD', '') };
const args = process.argv.slice(2), arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const SUMMARY_ONLY = args.includes('--summary');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const folder = get('BACKUP_DIR', path.join(root, '..', 'backups'));
const out = arg('--out') || path.join(folder, '{{NAME}}_' + DB.name + '-' + stamp + '.sql');
if (!DB.name) { console.error('backup: no DB_NAME'); process.exit(2); }
const q = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const lit = (v) => v === null || v === undefined ? 'NULL' : Buffer.isBuffer(v) ? "X'" + v.toString('hex') + "'" : v instanceof Date ? "'" + v.toISOString().slice(0, 19).replace('T', ' ') + "'" : typeof v === 'number' ? String(v) : "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + "'";

(async () => {
  let mysql = null; try { mysql = require('mysql2/promise'); } catch (e) { /* not installed */ }
  if (mysql) {
    const c = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: DB.name, dateStrings: false });
    const tables = (await c.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"'))[0].map((r) => Object.values(r)[0]).sort();
    const summary = { file: SUMMARY_ONLY ? null : out, bytes: 0, tables: {} };
    let sql = '-- {{TITLE}} backup of ' + DB.name + ' at ' + new Date().toISOString() + '\nSET FOREIGN_KEY_CHECKS=0;\nSTART TRANSACTION;\n';
    for (const t of tables) {
      const rows = (await c.query('SELECT * FROM ' + q(t)))[0]; summary.tables[t] = rows.length;
      if (SUMMARY_ONLY) continue;
      const create = (await c.query('SHOW CREATE TABLE ' + q(t)))[0][0]['Create Table'];
      sql += '\nDROP TABLE IF EXISTS ' + q(t) + ';\n' + create + ';\n';
      for (let i = 0; i < rows.length; i += 200) { const chunk = rows.slice(i, i + 200); const cols = Object.keys(chunk[0]); sql += 'INSERT INTO ' + q(t) + ' (' + cols.map(q).join(',') + ') VALUES\n' + chunk.map((r) => '(' + cols.map((k) => lit(r[k])).join(',') + ')').join(',\n') + ';\n'; }
    }
    sql += '\nCOMMIT;\nSET FOREIGN_KEY_CHECKS=1;\n';
    await c.end();
    if (!SUMMARY_ONLY) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, sql); summary.bytes = fs.statSync(out).size; }
    console.log(JSON.stringify(summary)); return;
  }
  // no mysql2: mysqldump for the file, mysql for the counts
  const base = ['--host=' + DB.host, '--port=' + DB.port, '--user=' + DB.user, ...(DB.password ? ['--password=' + DB.password] : [])];
  const summary = { file: SUMMARY_ONLY ? null : out, bytes: 0, tables: {} };
  const counts = cp.spawnSync(process.platform === 'win32' ? 'mysql.exe' : 'mysql', [...base, '--batch', '--skip-column-names', '-e', "SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema='" + DB.name + "' AND table_type='BASE TABLE'"], { encoding: 'utf8', windowsHide: true });
  if (counts.error && counts.error.code === 'ENOENT') { console.error('backup: neither mysql2 (npm install mysql2 - ask the owner) nor mysqldump/mysql on PATH'); process.exit(2); }
  for (const line of String(counts.stdout || '').split('\n')) { const [t, n] = line.trim().split('\t'); if (t) summary.tables[t] = Number(n) || 0; }
  if (!SUMMARY_ONLY) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = cp.spawnSync(process.platform === 'win32' ? 'mysqldump.exe' : 'mysqldump', [...base, '--single-transaction', '--routines', DB.name], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0) { console.error('backup: mysqldump failed: ' + (r.stderr || '').slice(-600)); process.exit(r.status || 1); }
    fs.writeFileSync(out, r.stdout); summary.bytes = fs.statSync(out).size;
  }
  console.log(JSON.stringify(summary));
})().catch((e) => { console.error('backup: ' + e.message); process.exit(1); });
