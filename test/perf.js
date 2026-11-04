/* Verify the verifier: the performance stage (engine/tests.js perfStage) against a throwaway app with a fast door, a
   slow door, and a door that is fast alone but serialises under load. node --test test/perf.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { perfStage } = require('../engine/tests');

test('perf stage: flags the slow door, the door that folds under ten, and the regression against last run', async () => {
  let busy = Promise.resolve();
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.end('{"ok":true}'); return; }
    if (req.url === '/api/slow') { setTimeout(() => res.end('{}'), 700); return; }
    if (req.url === '/api/fold') { busy = busy.then(() => new Promise((r) => setTimeout(() => { res.end('{}'); r(); }, 250))); return; }   // 250 ms each, one at a time: ten queue to 2.5 s
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-perf-'));
  fs.mkdirSync(path.join(dir, '.cockpit', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cockpit', 'project.md'), '## Tests\n- budget: 500ms\n');
  // a previous run where /api/fast took 10 ms - this run will "take" 300
  fs.writeFileSync(path.join(dir, '.cockpit', 'tests', 'latest.json'), JSON.stringify({ perf: { routes: [{ route: 'route:GET /api/fast', ms: 10 }] } }));
  const project = { dir, cockpit: { dir: path.join(dir, '.cockpit') }, entry: { id: 'x' } };
  const timings = [
    { route: 'route:GET /api/health', path: '/api/health', ms: 5, status: 200 },
    { route: 'route:GET /api/slow', path: '/api/slow', ms: 720, status: 200 },
    { route: 'route:GET /api/fold', path: '/api/fold', ms: 260, status: 200 },
    { route: 'route:GET /api/fast', path: '/api/fast', ms: 300, status: 200 },
  ];
  const report = {}; const said = [];
  try { await perfStage(project, url, timings, report, (t) => said.push(t)); } finally { srv.close(); }
  const pf = report.perf;
  assert.equal(pf.budget, 500, 'budget read from ## Tests');
  assert.deepEqual(pf.slow.map((s) => s.path), ['/api/slow'], 'the slow door is over budget');
  assert.ok(pf.burstSlow.some((b) => b.path === '/api/fold'), 'the serialising door folds under ten: ' + JSON.stringify(pf.bursts));
  assert.ok(!pf.burstSlow.some((b) => b.path === '/api/health'), 'the health door does not fold');
  assert.deepEqual(pf.regressed.map((r) => r.path), ['/api/fast'], 'fast got 30x slower than last run');
  assert.ok(/p50 \d+ ms, p95 \d+ ms, 1 over the 500 ms budget/.test(said[0]), said[0]);
});
