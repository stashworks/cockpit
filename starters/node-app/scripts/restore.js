#!/usr/bin/env node
/* {{TITLE}} - restore the database from a backup.js file, then read back what is there.

     node scripts\restore.js <file.sql>            into DB_NAME - refused unless the name ends in _test or _dev
     node scripts\restore.js <file.sql> --prod     into a production-named database: the owner's gate, by hand only

   Drops every table in the target, applies the file, prints the row count per table as JSON (the same shape backup.js
   prints, so the two can be compared - that comparison IS the restore drill). Environment as backup.js. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.join(__dirname, '..');

const env = {};
try { for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { /* environment only */ }
const get = (k, d) => process.env[k] !== undefined ? process.env[k] : env[k] !== undefined ? env[k] : d;
const DB = { host: get('DB_HOST', '127.0.0.1'), port: Number(get('DB_PORT', 3306)), name: get('DB_NAME', ''), user: get('DB_USER', ''), password: get('DB_PASSWORD', '') };
const args = process.argv.slice(2), file = args.find((a) => !a.startsWith('--'));
if (!file || !fs.existsSync(file)) { console.error('restore: give the backup file'); process.exit(2); }
if (!/_(test|dev)$/i.test(DB.name) && !args.includes('--prod')) { console.error('restore: refusing to restore into "' + DB.name + '" - only *_test / *_dev without --prod (prod is the owner\'s gate)'); process.exit(2); }
const q = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const split = (text) => text.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n?/gm, '').trim()).filter(Boolean);

(async () => {
  let mysql = null; try { mysql = require('mysql2/promise'); } catch (e) { /* not installed */ }
  const sql = fs.readFileSync(file, 'utf8');
  if (mysql) {
    const c = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, multipleStatements: false });
    await c.query('CREATE DATABASE IF NOT EXISTS ' + q(DB.name) + ' CHARACTER SET utf8mb4'); await c.query('USE ' + q(DB.name));
    await c.query('SET FOREIGN_KEY_CHECKS=0');
    for (const r of (await c.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"'))[0]) await c.query('DROP TABLE IF EXISTS ' + q(Object.values(r)[0]));
    for (const s of split(sql)) await c.query(s);
    await c.query('SET FOREIGN_KEY_CHECKS=1');
    const tables = {}; for (const r of (await c.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"'))[0]) { const t = Object.values(r)[0]; tables[t] = (await c.query('SELECT COUNT(*) AS n FROM ' + q(t)))[0][0].n; }
    await c.end();
    console.log(JSON.stringify({ file, tables })); return;
  }
  const base = ['--host=' + DB.host, '--port=' + DB.port, '--user=' + DB.user, ...(DB.password ? ['--password=' + DB.password] : [])];
  const bin = process.platform === 'win32' ? 'mysql.exe' : 'mysql';
  const r = cp.spawnSync(bin, [...base, DB.name], { input: 'SET FOREIGN_KEY_CHECKS=0;\n' + sql + '\nSET FOREIGN_KEY_CHECKS=1;\n', encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (r.error && r.error.code === 'ENOENT') { console.error('restore: neither mysql2 nor the mysql client on PATH'); process.exit(2); }
  if (r.status !== 0) { console.error('restore: mysql failed: ' + (r.stderr || '').slice(-600)); process.exit(r.status || 1); }
  const counts = cp.spawnSync(bin, [...base, '--batch', '--skip-column-names', '-e', "SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema='" + DB.name + "' AND table_type='BASE TABLE'"], { encoding: 'utf8', windowsHide: true });
  const tables = {}; for (const line of String(counts.stdout || '').split('\n')) { const [t, n] = line.trim().split('\t'); if (t) tables[t] = Number(n) || 0; }
  console.log(JSON.stringify({ file, tables }));
})().catch((e) => { console.error('restore: ' + e.message); process.exit(1); });
