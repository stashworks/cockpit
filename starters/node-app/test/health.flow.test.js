// @feature app
// @kind test
// @flow health-check
// @purpose Proves the health-check flow end to end: the app starts on the test database, the health door answers, the shell serves.
/* A FLOW test - the convention every feature's flows follow (docs: ARCHITECTURE.md, "Flows"):
     1. start the app against the TEST database (test\setup-db.js has just reset and seeded it);
     2. walk the flow's steps in order, over HTTP, as a person would through the screens;
     3. assert the effect - the rows in the tables the feature owns, the answers the doors gave;
     4. stop the app.
   The flow's name in @flow matches the feature README's ## Flows entry; that is how the map knows this test proves it. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');

async function startApp() {
  const port = 5900 + Math.floor(Math.random() * 90);
  const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), {{UPPER}}_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('server did not start')), 8000); child.stdout.on('data', (d) => { if (String(d).includes('http://localhost:' + port)) { clearTimeout(t); resolve(); } }); child.on('exit', (c) => reject(new Error('exited ' + c))); });
  return { child, url: 'http://127.0.0.1:' + port };
}

test('flow health-check: open / -> GET /api/health -> see ok', async () => {
  const app = await startApp();
  try {
    const page = await (await fetch(app.url + '/')).text();            // open /
    assert.ok(page.includes('<title>{{TITLE}}</title>'), 'the shell serves');
    const h = await (await fetch(app.url + '/api/health')).json();       // GET /api/health
    assert.equal(h.ok, true);                                             // see ok
    assert.equal(h.env, 'test', 'the app is on the test environment');
  } finally { app.child.kill(); }
});
