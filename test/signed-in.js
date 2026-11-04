/* Verify the verifier: the signed-in pass (engine/tests.js signIn + signedInStage) against a throwaway app with a login
   door that sets a cookie, a door behind it, a public door, and an admin door the test user may not use.
   node --test test/signed-in.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { signIn, signedInStage } = require('../engine/tests');

function app() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const signed = /sid=abc/.test(req.headers.cookie || '');
      if (u.pathname === '/api/login' && req.method === 'POST') { let j = {}; try { j = JSON.parse(body); } catch (e) { /* */ } if (j.email === 'test@example.com' && j.password === 'test') { res.writeHead(200, { 'set-cookie': 'sid=abc; HttpOnly; Path=/', 'content-type': 'application/json' }); res.end('{"ok":true}'); } else { res.writeHead(401); res.end(); } return; }
      if (u.pathname === '/api/public') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      if (u.pathname === '/api/mine') { if (!signed) { res.writeHead(401); res.end(); return; } res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"items":[{"id":1}]}'); return; }
      if (u.pathname === '/api/admin') { res.writeHead(403); res.end(); return; }
      res.writeHead(404); res.end();
    });
  });
}

test('signed-in pass: logs in with the cookie, doors behind the login answer, the admin door still refuses, the user contract records then breaks', async () => {
  const srv = app(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-signed-'));
  fs.mkdirSync(path.join(dir, '.cockpit', 'tests'), { recursive: true });
  const project = { dir, cockpit: { dir: path.join(dir, '.cockpit') }, entry: { id: 'x' }, db: { all: () => [{ file: 'none.js' }] } };
  const sec = { login: 'POST /api/login', user: '{"email":"test@example.com","password":"test"}' };
  const routes = [
    { subject: 'route:GET /api/public', method: 'GET', path: '/api/public' },
    { subject: 'route:GET /api/mine', method: 'GET', path: '/api/mine' },
    { subject: 'route:GET /api/admin', method: 'GET', path: '/api/admin' },
  ];
  try {
    const bad = await signIn(url, { login: 'POST /api/login', user: '{"email":"nobody","password":"x"}' });
    assert.ok(bad.why && /401/.test(bad.why), 'a wrong user is a clear failure: ' + bad.why);
    const report = { contract: { breaks: [] } }; const said = [];
    await signedInStage(project, url, routes, sec, report, (t) => said.push(t));
    assert.equal(report.signedIn.ok, true); assert.equal(report.signedIn.cookie, true);
    const v = {}; report.signedIn.probe.results.forEach((r) => { v[r.path] = r.verdict; });
    assert.deepEqual(v, { '/api/public': 'ok', '/api/mine': 'ok', '/api/admin': 'refused' });
    assert.equal(report.signedIn.contract.recorded, 3, 'first pass records the three GETs as the user');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, '.cockpit', 'tests', 'contract.json'), 'utf8'));
    assert.deepEqual(rec['route:GET /api/mine (user)'].shape, { items: [{ id: 'number' }] });
    // second pass: the recorded shape says items[].id is a number; make it disagree
    rec['route:GET /api/mine (user)'].shape = { items: [{ id: 'number', name: 'string' }] };
    fs.writeFileSync(path.join(dir, '.cockpit', 'tests', 'contract.json'), JSON.stringify(rec));
    const report2 = { contract: { breaks: [] } };
    await signedInStage(project, url, routes, sec, report2, () => {});
    assert.equal(report2.signedIn.contract.breaks.length, 1, 'the changed shape is a break');
    assert.ok(/name removed/.test(report2.signedIn.contract.breaks[0].changes.join(' ')), JSON.stringify(report2.signedIn.contract.breaks));
    assert.ok(report2.fuzzSignedIn && report2.fuzzSignedIn.routes === 2, 'the input probe ran behind the login on the two doors that answer: ' + JSON.stringify(report2.fuzzSignedIn));
    assert.ok(said[0].includes('signed in as the test user (cookie) - 2 doors answer, 1 still refuse'), said[0]);
  } finally { srv.close(); }
});
