'use strict';
/* DATA VIEWS - read-only queries a project keeps in its own folder, shown by the Data views card. Cards are Cockpit's, so a project's AI could never add one; now it does not need to:
   it writes a query file and the one Data views card, in every project, shows it.

     <project>\.cockpit\views\<name>.sql        one SELECT (or WITH ... SELECT); optional first lines:
                                                -- title: What's due today
                                                -- about: one line saying what it shows
     <project>\.cockpit\views\connection.json   optional: { "credentials": "api/.env", "database": "notes",
                                                "passwordKey": "COCKPIT_DB_PASS" } (a line in that credentials file; or "passwordFile") - otherwise the Database plugin's reader finds them

   Reading only, twice over: the file must be a single SELECT/WITH statement (no writes, no second statement, no SET), and it runs
   inside a READ ONLY transaction. The password goes to mysql as MYSQL_PWD - never on a command line, never in an answer.
   MySQL only in this cut (the Database plugin's reader). Hot-loaded. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const MAX_ROWS = 500;

function dir(p) { return path.join(p.cockpit.dir, 'views'); }
function meta(sql) {
  const m = {}; for (const line of sql.split(/\r?\n/)) { const x = /^\s*--\s*(title|about)\s*:\s*(.+)$/i.exec(line); if (x) m[x[1].toLowerCase()] = x[2].trim(); else if (line.trim() && !/^\s*--/.test(line)) break; }
  return m;
}
function list(p) {
  let files = []; try { files = fs.readdirSync(dir(p)).filter((f) => /^[a-z0-9][a-z0-9_-]*\.sql$/i.test(f)).sort(); } catch (e) { return []; }
  return files.map((f) => { const name = f.replace(/\.sql$/i, ''); let m = {}; try { m = meta(fs.readFileSync(path.join(dir(p), f), 'utf8')); } catch (e) { /* */ } return { name, title: m.title || name.replace(/[-_]/g, ' '), about: m.about || '' }; });
}
/* the one statement, checked: SELECT or WITH only, nothing after it */
function statement(sql) {
  const body = sql.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(body)) return { error: 'a view is one SELECT (or WITH ... SELECT) - nothing that changes data' };
  if (/;/.test(body.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ''))) return { error: 'a view is ONE statement - no second statement after a semicolon' };
  if (/\b(insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|call|load|handler|lock|set|into\s+(out|dump)file)\b/i.test(body.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ''))) return { error: 'a view only reads - it names a word that changes data or settings' };
  return { sql: body };
}
function creds(p) {
  let conn = {}; try { conn = JSON.parse(fs.readFileSync(path.join(dir(p), 'connection.json'), 'utf8')); } catch (e) { /* none: the plugin's reader decides */ }
  const lib = require(path.join(__dirname, '..', 'plugins', 'database', 'creds.js'));
  let A = {}; try { A = require('./plugins').answers(p, 'database') || {}; } catch (e) { /* */ }
  if (conn.credentials) A = { ...A, credentials: conn.credentials };
  const c = lib.read(p.dir, A); if (c.error) return { error: c.error };
  if (conn.database) c.name = conn.database;
  if (!c.password && c.file) { try { const m = /^\s*DB_PASS\s*=\s*(.*?)\s*$/m.exec(fs.readFileSync(path.isAbsolute(c.file) ? c.file : path.join(p.dir, c.file), 'utf8')); if (m) c.password = m[1].replace(/^(["'])(.*)\1$/, '$2'); } catch (e) { /* */ } }
  /* passwordKey (the password "needs to go into env"): a named line in the credentials file, for a view's
     database whose login differs from the app's own DB_PASS - e.g. "passwordKey": "COCKPIT_DB_PASS" */
  if (conn.passwordKey && c.file) { try { const k = String(conn.passwordKey).replace(/[^A-Z0-9_]/gi, ''), m = new RegExp('^\\s*' + k + '\\s*=\\s*(.*?)\\s*$', 'm').exec(fs.readFileSync(path.isAbsolute(c.file) ? c.file : path.join(p.dir, c.file), 'utf8')); if (!m) return { error: conn.passwordKey + ' is not in ' + c.file }; c.password = m[1].replace(/^(["'])(.*)\1$/, '$2'); } catch (e) { return { error: 'credentials file not readable: ' + c.file }; } }
  if (conn.passwordFile) { try { c.password = fs.readFileSync(path.join(p.dir, conn.passwordFile), 'utf8').trim(); } catch (e) { return { error: 'passwordFile not readable: ' + conn.passwordFile }; } }
  return { c, mysql: lib.client(A, 'mysql') };
}
function run(p, name) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(String(name || ''))) return Promise.resolve({ ok: false, error: 'no such view' });
  let sql; try { sql = fs.readFileSync(path.join(dir(p), name + '.sql'), 'utf8'); } catch (e) { return Promise.resolve({ ok: false, error: 'no view named ' + name }); }
  const st = statement(sql); if (st.error) return Promise.resolve({ ok: false, error: st.error });
  const d = creds(p); if (d.error) return Promise.resolve({ ok: false, error: 'database: ' + d.error });
  if (!d.mysql) return Promise.resolve({ ok: false, error: 'the mysql client was not found on this machine' });
  const script = 'SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY; ' + st.sql + ' LIMIT ' + (MAX_ROWS + 1) + '; ROLLBACK;';
  const limited = /\blimit\s+\d+\s*$/i.test(st.sql) ? script.replace(' LIMIT ' + (MAX_ROWS + 1), '') : script;
  const args = ['--host=' + d.c.host, '--port=' + d.c.port, '--user=' + d.c.user, '--batch', '--connect-timeout=10', '--default-character-set=utf8mb4', ...(d.c.name ? [d.c.name] : []), '-e', limited];
  return new Promise((resolve) => cp.execFile(d.mysql, args, { env: { ...process.env, MYSQL_PWD: d.c.password || '' }, timeout: 30000, maxBuffer: 1 << 24, windowsHide: true }, (err, out, errOut) => {
    if (err) return resolve({ ok: false, error: 'mysql: ' + String(errOut || err.message).split(/\r?\n/).filter((l) => l && !/Using a password/.test(l)).slice(-1)[0] });
    const lines = String(out).replace(/\r/g, '').split('\n').filter((l) => l !== '');
    const cols = lines.length ? lines[0].split('\t') : [];
    const un = (v) => v === 'NULL' ? null : v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    const rows = lines.slice(1).map((l) => l.split('\t').map(un));
    resolve({ ok: true, name, ...meta(sql), columns: cols, rows: rows.slice(0, MAX_ROWS), more: rows.length > MAX_ROWS, at: new Date().toISOString() });
  }));
}
module.exports = { list, run, statement };
