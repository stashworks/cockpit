#!/usr/bin/env node
/* {{TITLE}} - {{PURPOSE}}
   One Node process, no dependencies, one MySQL database, one module per part (modules\<name>\).

   The shape (Cockpit's node-app starter, 2026-09-17):
     server.js        this file: http, static files from public\, and the module registry
     modules\<name>\  a module = { name, routes(app) } in index.js, its own tables in
                      schema.sql, its own page in public\<name>\ - nothing reaches into
                      another module's tables; modules talk through the API
     public\          the shell: plain HTML + JS, no framework, no build step
     db\              schema.sql (every module's tables, prefixed), migrations\
     test\            node --test; a module ships with a test that proves its value path
     scripts\         promote-prod.cmd (git + pm2), db dump/restore
   Environments are two checkouts on the server: {{NAME}}_dev (:{{PORT_DEV}}, where code is written)
   and {{NAME}}_prod (:{{PORT_PROD}}, tracks main - promoted by scripts\promote-prod.cmd); each with its own
   database ({{NAME}}_dev / {{NAME}}) - see .env.example. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const env = loadEnv(path.join(ROOT, '.env'));
/* the process environment wins over .env, so the test can run beside the PM2 instance on another port */
const PORT = Number(process.env.PORT || env.PORT || {{PORT_DEV}});
const ENV_NAME = process.env.{{UPPER}}_ENV || env.{{UPPER}}_ENV || 'dev';
const STARTED = Date.now();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/* .env: KEY=value lines, never committed (see .gitignore); .env.example documents the keys */
function loadEnv(file) {
  const out = {};
  try { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { /* no .env: defaults */ }
  return out;
}

/* ---- the module registry: every folder under modules\ with an index.js ---- */
const modules = [];
const modDir = path.join(ROOT, 'modules');
if (fs.existsSync(modDir)) {
  for (const d of fs.readdirSync(modDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const entry = path.join(modDir, d.name, 'index.js');
    if (!fs.existsSync(entry)) continue;
    try { const m = require(entry); modules.push({ name: m.name || d.name, label: m.label || d.name, routes: m.routes || (() => []) }); }
    catch (e) { console.error('module ' + d.name + ' failed to load: ' + e.message); }
  }
}

/* ---- routing: a tiny table of [method, path-pattern, handler]; modules add theirs ---- */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:([a-z]+)/g, '(?<$1>[^/]+)') + '$'), handler });
route('GET', '/api/health', () => ({ ok: true, env: ENV_NAME, version: require('./package.json').version, uptimeSec: Math.round((Date.now() - STARTED) / 1000), modules: modules.map((m) => m.name) }));
route('GET', '/api/modules', () => ({ ok: true, modules: modules.map((m) => ({ name: m.name, label: m.label })) }));
for (const m of modules) for (const r of m.routes(route, env)) if (Array.isArray(r)) route(...r);

const readBody = (req) => new Promise((resolve, reject) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 5e6) req.destroy(); }); req.on('end', () => resolve(s)); req.on('error', reject); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  try {
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) { const body = req.method === 'GET' ? null : JSON.parse(await readBody(req) || '{}'); const out = await r.handler({ params: m.groups || {}, query: Object.fromEntries(url.searchParams), body, req }); return json(out, out && out.ok === false ? (out.status || 400) : 200); }
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'no such route' }, 404);
    // static: public\, index.html for a folder
    let rel = decodeURIComponent(url.pathname).replace(/\.\./g, ''); if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, 'public', rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res); return; }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  } catch (e) { json({ ok: false, error: e.message }, 500); }
});
server.listen(PORT, '0.0.0.0', () => console.log('{{NAME}} (' + ENV_NAME + ') → http://localhost:' + PORT + '  modules: ' + (modules.map((m) => m.name).join(', ') || 'none yet')));
