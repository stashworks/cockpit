/* Verify the verifier: the restore drill (engine/tests.js restoreDrill) with stand-in backup/restore commands under
   ## Backup - one pair that round-trips, one that loses rows, one whose backup fails. node --test test/restore.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { restoreDrill } = require('../engine/tests');

function project(backupCmd, restoreCmd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-restore-'));
  fs.mkdirSync(path.join(dir, '.cockpit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cockpit', 'project.md'), '## Backup\n- backup: ' + backupCmd + '\n- restore: ' + restoreCmd + '\n');
  // the stand-ins: backup writes the file named after --out and prints the summary; restore reads it and prints what it "restored"
  fs.writeFileSync(path.join(dir, 'bk.js'), "const fs=require('fs');const o=process.argv[process.argv.indexOf('--out')+1];fs.writeFileSync(o,'-- dump');console.log(JSON.stringify({file:o,tables:{users:3,orders:10}}));");
  fs.writeFileSync(path.join(dir, 'rs-ok.js'), "console.log('restoring');console.log(JSON.stringify({tables:{users:3,orders:10}}));");
  fs.writeFileSync(path.join(dir, 'rs-lossy.js'), "console.log(JSON.stringify({tables:{users:3,orders:7}}));");
  fs.writeFileSync(path.join(dir, 'bk-bad.js'), "console.error('backup: Access denied');process.exit(1);");
  return { dir, cockpit: { dir: path.join(dir, '.cockpit') }, entry: { id: 'x' } };
}
const node = '"' + process.execPath + '"';
const env = { DB_NAME: 'fixture_test' };

test('restore drill: equal counts pass', async () => {
  const p = project(node + ' bk.js', node + ' rs-ok.js'); const report = {}; const said = [];
  await restoreDrill(p, env, report, (t) => said.push(t));
  assert.equal(report.restore.ok, true); assert.equal(report.restore.tables, 2); assert.equal(report.restore.rows, 13);
  assert.ok(said[1].includes('restore drill ok - 2 tables, 13 rows'), said[1]);
});
test('restore drill: lost rows fail, named', async () => {
  const p = project(node + ' bk.js', node + ' rs-lossy.js'); const report = {};
  await restoreDrill(p, env, report, () => {});
  assert.equal(report.restore.ok, false); assert.deepEqual(report.restore.diffs, ['orders: 10 rows backed up, 7 after restore']);
});
test('restore drill: a failing backup is reported at that step', async () => {
  const p = project(node + ' bk-bad.js', node + ' rs-ok.js'); const report = {};
  await restoreDrill(p, env, report, () => {});
  assert.equal(report.restore.ok, false); assert.equal(report.restore.step, 'backup'); assert.ok(/Access denied/.test(report.restore.why));
});
test('restore drill: never into a database not named *_test', async () => {
  const p = project(node + ' bk.js', node + ' rs-ok.js'); const report = {};
  await restoreDrill(p, { DB_NAME: 'fixture_dev' }, report, () => {});
  assert.equal(report.restore.skipped, true); assert.ok(/\*_test/.test(report.restore.why));
});
