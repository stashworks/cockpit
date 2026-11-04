/* Verify the verifier: the input probe (engine/fuzz.js) against a throwaway app with one door of each bad reaction
   and one clean one. If this stops finding them, the probe is broken, not the projects.
     node --test test/fuzz.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { fuzzStage, fieldsOf } = require('../engine/fuzz');

function app() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const q = u.searchParams.get('q') || '';
      if (u.pathname === '/api/crash') { try { JSON.parse(body).name.toUpperCase(); res.writeHead(200); res.end('ok'); } catch (e) { res.writeHead(500); res.end('boom'); } return; }   // null / object payloads throw
      if (u.pathname === '/api/leak') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: "You have an error in your SQL syntax; near '" + q.slice(0, 20) + "'" })); return; }
      if (u.pathname === '/api/reflect') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>results for ' + q + '</h1>'); return; }
      if (u.pathname === '/api/clean') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad input"}'); return; }
      if (u.pathname === '/api/private') { res.writeHead(401); res.end(); return; }
      res.writeHead(404); res.end();
    });
  });
}

test('the input probe finds a crash, a leak, a reflection; passes the clean door; skips the refused one', async () => {
  const srv = app(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-fuzz-'));
  fs.writeFileSync(path.join(dir, 'crash.js'), "app.post('/api/crash', (req, res) => { const { name } = req.body; res.send(name.toUpperCase()); });");
  const project = { dir, db: { all: (sql, subject) => [{ file: /crash/.test(subject) ? 'crash.js' : 'none.js' }] } };
  const routes = [
    { subject: 'route:POST /api/crash', method: 'POST', path: '/api/crash' },
    { subject: 'route:GET /api/leak', method: 'GET', path: '/api/leak' },
    { subject: 'route:GET /api/reflect', method: 'GET', path: '/api/reflect' },
    { subject: 'route:POST /api/clean', method: 'POST', path: '/api/clean' },
    { subject: 'route:GET /api/private', method: 'GET', path: '/api/private' },
  ];
  const report = {}; const said = [];
  try { await fuzzStage(project, {}, url, routes, report, (t) => said.push(t)); } finally { srv.close(); }
  const kinds = {}; report.fuzz.findings.forEach((f) => { kinds[f.route + ' ' + f.kind] = f; });
  assert.ok(kinds['route:POST /api/crash crash'], 'the crashing door is a crash finding: ' + JSON.stringify(Object.keys(kinds)));
  assert.ok(kinds['route:GET /api/leak leak'], 'the SQL error in the answer is a leak');
  assert.ok(kinds['route:GET /api/reflect reflected'], 'the script tag coming back in HTML is a reflection');
  assert.ok(!Object.keys(kinds).some((k) => k.startsWith('route:POST /api/clean')), 'the door that refuses bad input cleanly has no finding');
  assert.equal(report.fuzz.refused, 1, 'the 401 door was counted as refused, not fuzzed');
  assert.equal(report.fuzz.routes, 4);
  assert.deepEqual(fieldsOf(project, 'crash.js'), ['name'], 'fields lifted from the route file');
  assert.deepEqual(fieldsOf(project, 'none.js'), ['q', 'id', 'name', 'email', 'text'], 'generic fields when the file says nothing');
  assert.ok(said[0].includes('4 doors fuzzed (1 refused the probe)'), said[0]);
});
