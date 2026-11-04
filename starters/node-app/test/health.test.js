/* The value path, proven: the server starts, answers /api/health, and serves the shell.
   Every module ships a test like this for its own path (definition of done = value delivered). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');

test('server starts, answers health, serves the shell', async () => {
  const port = 5900 + Math.floor(Math.random() * 90);
  const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), {{UPPER}}_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('server did not start')), 8000); child.stdout.on('data', (d) => { if (String(d).includes('http://localhost:' + port)) { clearTimeout(t); resolve(); } }); child.on('exit', (c) => reject(new Error('exited ' + c))); });
    const h = await (await fetch('http://127.0.0.1:' + port + '/api/health')).json();
    assert.equal(h.ok, true); assert.equal(h.env, 'test'); assert.ok(Array.isArray(h.modules));
    const page = await (await fetch('http://127.0.0.1:' + port + '/')).text();
    assert.ok(page.includes('<title>{{TITLE}}</title>'));
    const missing = await fetch('http://127.0.0.1:' + port + '/api/nothing');
    assert.equal(missing.status, 404);
  } finally { child.kill(); }
});
