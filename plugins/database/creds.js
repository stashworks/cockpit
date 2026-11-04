/* Where a project's MySQL database is - one reader, shared by the Database scan and the engine's backups
   (engine/backup.js), so "connected" means the same thing everywhere. Zero-install: the mysql client and
   mysqldump already on the machine. The password is read here and handed to a child as MYSQL_PWD in its
   environment - never on a command line, never written anywhere. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

/* the files a project keeps its credentials in, most likely first; then the config folder beside the apps - the folder
   named EXACTLY like the project first (config\site_dev for site_dev), the stripped name after it (config\site). The
   other way round, a dev project read its prod database's credentials (2026-09-20). */
function candidates(projectDir) {
  const base = path.basename(projectDir), name = base.replace(/[_-](dev|prod|test|uat|staging)$/i, '');
  const beside = path.join(path.dirname(path.dirname(projectDir)), 'config');
  return ['.env', '.env.local', 'config/db.php', 'config/database.php', 'includes/db.php', 'includes/config.php', 'app/config/db.php', 'db.php', 'config.php',
    path.join(beside, base, 'db.php'), path.join(beside, base, '.env'), ...(name !== base ? [path.join(beside, name, 'db.php'), path.join(beside, name, '.env')] : [])];
}

/* { host, port, name, user, password, file } or { error } - A = the Database plugin's answers ({ credentials } may name the file) */
function read(projectDir, A) {
  A = A || {};
  const told = String(A.credentials || '').trim();
  const tried = [];
  let rel = null, file = null, src = null;
  for (const c of told ? [told] : candidates(projectDir)) {
    const f = path.isAbsolute(c) ? c : path.join(projectDir, c);
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { tried.push(c); continue; }
    if (!told && !/DB_NAME|DATABASE_URL|dbname|'database'|"database"/.test(text)) { tried.push(c + ' (no database in it)'); continue; }
    rel = c; file = f; src = text; break;
  }
  if (!src) return { error: told ? 'credentials file not readable: ' + told : 'no credentials file found - looked for ' + tried.slice(0, 6).join(', ') + '…; say where it is in the plugin\'s settings' };
  const c = { host: '127.0.0.1', port: 3306, name: '', user: '', password: '', file: rel };
  if (/\.php$/i.test(file)) {
    const g = (k) => { const m = new RegExp('[\'"]' + k + '[\'"]\\s*=>\\s*[\'"]([^\'"]*)[\'"]').exec(src); return m ? m[1] : ''; };
    c.host = g('host') || c.host; c.port = Number(g('port')) || c.port; c.name = g('dbname') || g('database') || g('name'); c.user = g('username') || g('user'); c.password = g('password') || g('pass');
  } else {
    const env = {};
    for (const line of src.split('\n')) { const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); }
    if (env.DATABASE_URL && !env.DB_NAME) {
      let u; try { u = new URL(env.DATABASE_URL); } catch (e) { return { error: 'DATABASE_URL is not a URL' }; }
      if (!/^mysql2?:$/.test(u.protocol)) return { error: 'DATABASE_URL is ' + u.protocol.replace(':', '') + ' - this plugin reads MySQL only (Postgres is not in this cut)' };
      c.host = u.hostname || c.host; c.port = Number(u.port) || c.port; c.name = u.pathname.replace(/^\//, ''); c.user = decodeURIComponent(u.username); c.password = decodeURIComponent(u.password);
    } else {
      c.host = env.DB_HOST || c.host; c.port = Number(env.DB_PORT) || c.port; c.name = env.DB_NAME || ''; c.user = env.DB_USER || ''; c.password = env.DB_PASSWORD || env.DB_PASS || '';   // DB_PASS too, as the PHP reader takes 'pass' (2026-10-31: a project's backup ran with no password)
    }
  }
  if (!c.name) return { error: 'no database name in ' + rel + ' (DB_NAME, or dbname in a PHP file)' };
  if (!c.user) return { error: 'no database user in ' + rel + ' (DB_USER, or username in a PHP file)' };
  return c;
}

/* the mysql client: the one the answers name, else on PATH, else the newest MySQL Server's bin. `which` = 'mysql' | 'mysqldump' */
function client(A, which) {
  which = which || 'mysql';
  const given = String((A || {}).mysql || '').trim();
  if (given) return which === 'mysql' ? given : path.join(path.dirname(given), path.basename(given).replace(/^mysql/i, 'mysqldump'));
  const bin = process.platform === 'win32' ? which + '.exe' : which;
  const probe = cp.spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (!probe.error) return bin;
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\MySQL', 'C:\\Program Files (x86)\\MySQL']) {
      let dirs = []; try { dirs = fs.readdirSync(base).filter((d) => /^MySQL Server/i.test(d)).sort().reverse(); } catch (e) { continue; }
      for (const d of dirs) { const f = path.join(base, d, 'bin', bin); if (fs.existsSync(f)) return f; }
    }
  }
  return null;
}

module.exports = { candidates, read, client };
