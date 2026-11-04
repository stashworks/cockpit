#!/usr/bin/env node
/* Test database setup - the project's own (Cockpit's runner runs this first, with the test environment set).
   Drops and recreates the TEST database, applies db\schema.sql, then every module's data\schema.sql and
   data\seed.sql, so every run starts from the same known rows. Refuses any database whose name does not end
   in _test: the dev and prod databases are never touched from here.

   Talks to MySQL with whatever this project has: mysql2 (npm) when installed, else the mysql command-line
   client when it is on PATH, else it says what is missing and exits 2. Environment (from .env, overridden by
   the process environment the runner sets): DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.join(__dirname, '..');

const env = {};
try { for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { /* no .env: the environment must carry it */ }
const get = (k, d) => process.env[k] !== undefined ? process.env[k] : env[k] !== undefined ? env[k] : d;
const DB = { host: get('DB_HOST', '127.0.0.1'), port: Number(get('DB_PORT', 3306)), name: get('DB_NAME', ''), user: get('DB_USER', ''), password: get('DB_PASSWORD', '') };
if (!/_test$/.test(DB.name)) { console.error('setup-db: refusing to reset "' + DB.name + '" - only a database named *_test is ever dropped here (set DB_NAME={{NAME}}_test)'); process.exit(2); }

// the SQL, in order: the base schema, then each module's schema and seed
const files = [path.join(root, 'db', 'schema.sql')];
const mods = path.join(root, 'modules');
if (fs.existsSync(mods)) for (const m of fs.readdirSync(mods).sort()) for (const f of ['schema.sql', 'seed.sql']) { const p = path.join(mods, m, 'data', f); if (fs.existsSync(p)) files.push(p); }
const sql = files.filter(fs.existsSync).map((f) => '-- ' + path.relative(root, f) + '\n' + fs.readFileSync(f, 'utf8')).join('\n');
const split = (text) => text.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n?/gm, '').trim()).filter(Boolean);
const statements = split(sql);
// migrations: db\migrations\NNNN_name.sql with NNNN_name.down.sql beside it. Applied in order after the schema; with
// --cycle, then reversed in reverse order and applied again - a migration that cannot come back is a finding upstream.
const migDir = path.join(root, 'db', 'migrations');
const migrations = fs.existsSync(migDir) ? fs.readdirSync(migDir).filter((f) => /\.sql$/i.test(f) && !/\.down\.sql$/i.test(f)).sort().map((f) => ({ name: f, up: split(fs.readFileSync(path.join(migDir, f), 'utf8')), down: fs.existsSync(path.join(migDir, f.replace(/\.sql$/i, '.down.sql'))) ? split(fs.readFileSync(path.join(migDir, f.replace(/\.sql$/i, '.down.sql')), 'utf8')) : null })) : [];
const CYCLE = process.argv.includes('--cycle');
const plan = [...statements];
for (const m of migrations) plan.push(...m.up);
if (CYCLE) { for (const m of [...migrations].reverse()) { if (!m.down) { console.error('setup-db: ' + m.name + ' has no .down.sql - it cannot be reversed; write one (a migration is a change that can come back)'); process.exit(3); } plan.push(...m.down); } for (const m of migrations) plan.push(...m.up); }

(async () => {
  let mysql = null; try { mysql = require('mysql2/promise'); } catch (e) { /* not installed */ }
  if (mysql) {
    const c = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, multipleStatements: false });
    await c.query('DROP DATABASE IF EXISTS `' + DB.name + '`'); await c.query('CREATE DATABASE `' + DB.name + '` CHARACTER SET utf8mb4');
    await c.query('USE `' + DB.name + '`');
    for (const s of plan) await c.query(s);
    await c.end();
    console.log('setup-db: ' + DB.name + ' reset, ' + statements.length + ' schema statements, ' + migrations.length + ' migration' + (migrations.length === 1 ? '' : 's') + (CYCLE ? ' cycled up-down-up' : ' applied') + ' (mysql2)');
    return;
  }
  const bin = process.platform === 'win32' ? 'mysql.exe' : 'mysql';
  const r = cp.spawnSync(bin, ['--host=' + DB.host, '--port=' + DB.port, '--user=' + DB.user, ...(DB.password ? ['--password=' + DB.password] : []), '--batch'], { input: 'DROP DATABASE IF EXISTS `' + DB.name + '`; CREATE DATABASE `' + DB.name + '` CHARACTER SET utf8mb4; USE `' + DB.name + '`;\n' + plan.join(';\n') + ';\n', encoding: 'utf8', windowsHide: true });
  if (r.error && r.error.code === 'ENOENT') { console.error('setup-db: neither mysql2 (npm install mysql2 - ask the owner) nor the mysql client on PATH - cannot reset ' + DB.name); process.exit(2); }
  if (r.status !== 0) { console.error('setup-db: mysql failed: ' + (r.stderr || r.stdout || '').slice(-600)); process.exit(r.status || 1); }
  console.log('setup-db: ' + DB.name + ' reset, ' + statements.length + ' schema statements, ' + migrations.length + ' migration' + (migrations.length === 1 ? '' : 's') + (CYCLE ? ' cycled up-down-up' : ' applied') + ' (mysql client)');
})().catch((e) => { console.error('setup-db: ' + e.message); process.exit(1); });
