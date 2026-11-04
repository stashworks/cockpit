/* Verify the verifier: tickets (engine/tickets.js) and the verdict (engine/verify.js) on a hand-built map - impact from
   churn / tests / reach, the draft, a local ticket, the state moves, and a green then a red verdict.
   node --test test/tickets.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../engine/db');
const T = require('../engine/tickets');
const V = require('../engine/verify');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-tk-'));
  fs.mkdirSync(path.join(dir, '.cockpit'), { recursive: true });
  // the files the map names exist and are committed: a draft refuses a file that is not there, and the verdict's
  // "committed" check reads git
  for (const f of ['modules/orders/logic.js', 'modules/orders/actions.js', 'modules/orders/screens/orders.html']) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), '// fixture\n'); }
  const git = (...a) => require('node:child_process').execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', 'modules'); git('commit', '-q', '-m', 'fixture');
  const db = openDb(path.join(dir, '.cockpit', 'cockpit.db'), path.join(__dirname, '..', 'engine', 'schema.sql'));
  const now = db.now();
  const node = (s, kind, title, file) => db.run('INSERT INTO node (subject, kind, parent, title, file, size, at) VALUES (?,?,?,?,?,?,?)', s, kind, null, title, file, 1, now);
  const tag = (s, ns, v) => db.run('INSERT OR REPLACE INTO tag (subject, ns, value, source, why, by, at) VALUES (?,?,?,?,?,?,?)', s, ns, v, 'derived', null, null, now);
  const edge = (a, b, k) => db.run('INSERT OR REPLACE INTO edge (src, dst, kind, at) VALUES (?,?,?,?)', a, b, k, now);
  node('file:modules/orders/logic.js', 'file', 'logic.js', 'modules/orders/logic.js'); tag('file:modules/orders/logic.js', 'impact', '4'); tag('file:modules/orders/logic.js', 'churn', 'hot'); tag('file:modules/orders/logic.js', 'tested', 'no'); tag('file:modules/orders/logic.js', 'layer', 'logic'); tag('file:modules/orders/logic.js', 'domain', 'orders'); tag('file:modules/orders/logic.js', 'problem', 'empty-catch');
  node('file:modules/orders/actions.js', 'file', 'actions.js', 'modules/orders/actions.js'); tag('file:modules/orders/actions.js', 'impact', '3'); tag('file:modules/orders/actions.js', 'churn', 'still'); tag('file:modules/orders/actions.js', 'tested', 'yes'); tag('file:modules/orders/actions.js', 'layer', 'actions'); tag('file:modules/orders/actions.js', 'domain', 'orders');
  node('file:modules/orders/screens/orders.html', 'file', 'orders.html', 'modules/orders/screens/orders.html'); tag('file:modules/orders/screens/orders.html', 'layer', 'screens'); tag('file:modules/orders/screens/orders.html', 'domain', 'orders'); tag('file:modules/orders/screens/orders.html', 'impact', '2');
  node('table:orders', 'table', 'orders', null); tag('table:orders', 'sensitivity', 'money'); tag('table:orders', 'domain', 'orders');
  node('flow:orders/place-order', 'flow', 'place-order', null); tag('flow:orders/place-order', 'domain', 'orders'); tag('flow:orders/place-order', 'tested', 'no');
  edge('file:modules/orders/actions.js', 'file:modules/orders/logic.js', 'imports'); edge('file:modules/orders/screens/orders.html', 'file:modules/orders/actions.js', 'fetches');
  edge('file:modules/orders/logic.js', 'table:orders', 'writes'); edge('file:modules/orders/screens/orders.html', 'flow:orders/place-order', 'part-of');
  return { entry: { id: 'fixture' }, dir, cockpit: { dir: path.join(dir, '.cockpit'), json: {} }, db };
}

test('impact: a hot untested logic file writing a money table, reached by the door and the screen, is high; the flow becomes the required test', () => {
  const p = project();
  const a = T.impact(p, ['modules/orders/logic.js', 'modules/orders/new.js']);
  assert.equal(a.likelihood, 4); assert.equal(a.impact, 4); assert.equal(a.band, 'critical');   // 4 × 4 = 16
  assert.deepEqual(a.missing, ['modules/orders/new.js']);
  assert.equal(a.reach.things, 2, 'the door and the screen reach it: ' + JSON.stringify(a.reach));
  assert.deepEqual(a.tables.map((t) => t.table + ':' + t.how + ':' + t.sensitive), ['orders:writes:money']);
  assert.deepEqual(a.flows.map((f) => f.name + ':' + f.tested), ['place-order:no']);
  assert.ok(a.split, 'critical asks for a split');
  const b = T.impact(p, ['modules/orders/actions.js']);
  assert.equal(b.band, 'medium'); assert.equal(b.likelihood, 2);   // still, tested: 2 × 3 = 6
  const c = T.impact(p, ['modules/orders/screens/orders.html', 'modules/orders/logic.js']);
  assert.ok(c.crossings.some((x) => /screen and data/.test(x)) === false, 'screen + logic is not the screen-and-data crossing');
});

test('draft fills the template; a local ticket is filed with its tag on the map; the states move as allowed', () => {
  const p = project();
  const d = T.draft(p, { title: 'Guard the empty catch in orders logic', alter: ['modules/orders/logic.js'], why: 'fake success', done: 'empty-catch at 0 on the file' });
  assert.ok(d.body.includes('## Files to alter\n- modules/orders/logic.js'), d.body);
  assert.ok(d.body.includes('Closes when: empty-catch at 0 on the file'));
  assert.ok(d.body.includes('- flow place-order - write its test'), 'the unproven flow is a required test');
  assert.deepEqual(d.labels, ['feature:orders', 'kind:logic', 'risk:critical', 'status:created']);
  const r = T.create(p, { title: 'Guard the empty catch in orders logic', alter: ['modules/orders/logic.js'], why: 'fake success', done: 'empty-catch at 0', finding: 'empty-catch' }, 'owner');
  assert.ok(r.ok); assert.equal(r.ticket.id, 'L1'); assert.equal(r.ticket.state, 'created');
  assert.equal(p.db.get("SELECT value FROM tag WHERE subject = 'file:modules/orders/logic.js' AND ns = 'ticket'").value, 'L1', 'the file carries the ticket');
  assert.equal(T.list(p).length, 1);
  assert.equal(T.setState(p, 'L1', 'passed').ok, false, 'created cannot jump to passed');
  assert.ok(T.setState(p, 'L1', 'in-work', 'harness', 'turn 1').ok);
  assert.ok(T.setState(p, 'L1', 'verified', 'cockpit', 'green').ok);
  assert.ok(T.setState(p, 'L1', 'passed', 'owner', 'UAT on dev ok').ok);
  assert.ok(T.setState(p, 'L1', 'promoted', 'owner', 'promoted').ok);
  assert.ok(T.setState(p, 'L1', 'closed', 'cockpit', 'rescan on prod: done-when holds').ok);
  assert.equal(T.get(p, 'L1').history.length, 6);
});

test('verify: green when the finding is gone, tests pass and the touched files are the declared ones; red names the undeclared file and the new slop', () => {
  const p = project();
  const r = T.create(p, { title: 't', alter: ['modules/orders/logic.js'], done: 'x', flow: 'none' }, 'owner');   // no screen change: the flow rule's "none"
  T.setState(p, 'L1', 'in-work', 'harness', 'turn');
  const before = V.before(p, 'L1'); assert.equal(before.total, 1);
  // the work: the empty-catch is gone, the file is tested now
  p.db.run("DELETE FROM tag WHERE subject = 'file:modules/orders/logic.js' AND ns = 'problem'"); p.db.run("UPDATE tag SET value = 'yes' WHERE subject = 'file:modules/orders/logic.js' AND ns = 'tested'");
  const g = V.after(p, 'L1', before, [path.join(p.dir, 'modules', 'orders', 'logic.js')], { summary: { passed: 3, failed: 0 } }, 7);
  assert.ok(g.verdict.green, JSON.stringify(g.verdict.checks)); assert.equal(g.moved, 'verified');
  // a second turn touches a file the ticket never declared and leaves a debug log in it
  T.setState(p, 'L1', 'in-work', 'owner', 'more work');
  p.db.run("INSERT OR REPLACE INTO tag (subject, ns, value, source, why, by, at) VALUES ('file:modules/orders/actions.js', 'problem', 'debug-logging', 'derived', null, null, ?)", p.db.now());
  const b2 = V.before(p, 'L1');
  const bad = V.after(p, 'L1', b2, ['modules/orders/logic.js', 'modules/orders/actions.js'], { summary: { passed: 2, failed: 1 } }, 8);
  assert.equal(bad.verdict.green, false);
  const failed = bad.verdict.checks.filter((c) => !c.ok).map((c) => c.name);
  // the project's test run gates the promote, not the turn (plugins/tickets/verdict.json "tests": gate promote)
  assert.deepEqual(failed, ['no new AI slop in the touched files', 'every touched file was declared']);
  assert.deepEqual(bad.verdict.undeclared, ['modules/orders/actions.js']);
  assert.equal(T.get(p, 'L1').state, 'in-work'); assert.equal(T.get(p, 'L1').verdicts.length, 2);
});

test('afterScan: a passed ticket named by the promoted commits goes promoted; a promoted ticket whose finding is gone closes', () => {
  const p = project();
  const cp = require('node:child_process');
  const git = (args) => cp.execFileSync('git', args, { cwd: p.dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(p.dir, 'a.txt'), '1'); git(['add', '.']); git(['commit', '-qm', 'start']); const from = git(['rev-parse', '--short', 'HEAD']);
  fs.writeFileSync(path.join(p.dir, 'a.txt'), '2'); git(['add', '.']); git(['commit', '-qm', 'L1: guard the catch']); const to = git(['rev-parse', '--short', 'HEAD']);
  T.create(p, { title: 't', alter: ['modules/orders/logic.js'], done: 'x', finding: 'empty-catch' }, 'owner');
  T.setState(p, 'L1', 'in-work'); T.setState(p, 'L1', 'verified'); T.setState(p, 'L1', 'passed', 'owner', 'uat');
  fs.mkdirSync(path.join(p.cockpit.dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(p.cockpit.dir, 'tests', 'smoke.json'), JSON.stringify({ at: '2026-09-18T20:00:00.000Z', ok: true, from, to }));
  const said = []; T.afterScan(p, (t) => said.push(t));
  assert.equal(T.get(p, 'L1').state, 'promoted', said.join(' | '));
  T.afterScan(p); assert.equal(T.get(p, 'L1').state, 'promoted', 'the finding is still there: not closed');
  p.db.run("DELETE FROM tag WHERE ns = 'problem' AND value = 'empty-catch'");
  T.afterScan(p, (t) => said.push(t)); assert.equal(T.get(p, 'L1').state, 'closed', said.join(' | '));
  assert.ok(/at 0 on the ticket/.test(T.get(p, 'L1').history.pop().why));
});

test('the conversation path: the AI drafts, the owner edits and approves (numbered title) or rejects; features are one list', () => {
  const p = project();
  const d = T.draftFile(p, { title: 'Guard the catch', feature: 'orders', alter: ['modules/orders/logic.js'], why: 'fake success on a money path', done: 'empty-catch at 0', finding: 'empty-catch', flow: 'none' }, 'ai');
  assert.ok(d.ok); assert.equal(d.ticket.id, 'D1'); assert.equal(d.ticket.state, 'draft'); assert.ok(/never approve on your own/.test(d.note), d.note);
  assert.equal(d.ticket.impact.band, 'critical', 'the draft carries its impact');
  const feats = T.features(p); assert.deepEqual(feats.map((f) => f.key), ['orders'], JSON.stringify(feats));
  assert.equal(T.list(p).filter((t) => t.state === 'draft').length, 1);
  // the owner renames the feature to a new one and approves
  const a = T.approve(p, 'D1', { feature: 'billing', done: 'empty-catch at 0 on logic.js, read back on dev' }, 'owner');
  assert.ok(a.ok, a.error); assert.equal(a.ticket.id, 'L1'); assert.equal(a.ticket.title, 'L1: Guard the catch', 'the number at the front'); assert.equal(a.ticket.feature, 'billing'); assert.equal(a.ticket.state, 'created');
  assert.equal(a.ticket.history[0].state, 'draft'); assert.ok(/approved by owner/.test(a.ticket.history[0].why));
  assert.equal(T.get(p, 'D1'), null, 'the draft file is gone'); assert.equal(T.list(p).length, 1);
  assert.deepEqual(T.features(p).map((f) => f.key + ':' + f.tickets), ['orders:0', 'billing:1'], 'the new feature joins the list');
  // a second draft, rejected
  T.draftFile(p, { title: 'x', alter: ['modules/orders/actions.js'], done: 'y', flow: 'none' }, 'ai');
  assert.equal(T.reject(p, 'D1', 'owner').ok, true); assert.equal(T.get(p, 'D1'), null);
  assert.equal(T.adopt(p, 12, { alter: [] }).ok, false, 'no GitHub here: adopt says so');
});
