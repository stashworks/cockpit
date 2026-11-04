// Milestone 1 acceptance: every claim tested against a case where the answer is known.
const fs = require('node:fs'), path = require('node:path');
const BASE = process.env.COCKPIT_URL || 'http://localhost:4500';
// Runs against a live engine on :4500 with a scratch folder: node test/m1-project-model.js <folder>
const DEMO = path.resolve(process.argv[2] || path.join(require('node:os').tmpdir(), 'cockpit-demo-project'));
fs.mkdirSync(DEMO, { recursive: true });
const j = (r) => r.json();
const get = (u) => fetch(BASE + u).then(j);
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j);
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };

(async () => {
  // 1. open a folder -> registered, .cockpit created with the right pieces
  const r = await post('/api/projects', { path: DEMO });
  ok('open folder registers a project', r.ok && r.project && r.project.id === path.basename(DEMO).toLowerCase().replace(/[^a-z0-9]+/g, '-'), JSON.stringify(r.project && r.project.id));
  const ID = r.project && r.project.id;
  const cp = path.join(DEMO, '.cockpit');
  for (const f of ['cockpit.json', 'project.md', 'cockpit.db', '.gitignore', 'plugins', 'layouts', 'conversations', 'decisions', 'logs', 'cache'])
    ok('.cockpit has ' + f, fs.existsSync(path.join(cp, f)));
  const cj = JSON.parse(fs.readFileSync(path.join(cp, 'cockpit.json'), 'utf8'));
  ok('cockpit.json stamped with engine version', cj.engine === '0.1.0', cj.engine);
  ok('cockpit.json has no absolute path inside it', !JSON.stringify(cj).match(/[A-Z]:\\|\/\//), JSON.stringify(cj));

  // 2. the room describes it, and it is loaded
  const room = await get('/api/p/' + ID + '/room');
  ok('room names the folder', room.path && room.path.toLowerCase() === DEMO.toLowerCase(), room.path);
  ok('room reports 0 conversations', room.threads === 0);
  const eng = await get('/api/engine');
  ok('engine lists it as loaded', eng.loaded.includes(ID), JSON.stringify(eng.loaded));

  // 3. layout round-trips per project
  const lay = { v: 1, order: { left: ['project'], stage: ['conversation'], right: [] }, sizes: { project: { cols: 5, rows: 9 } } };
  await fetch(BASE + '/api/p/' + ID + '/layout?person=tester', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lay) });
  const back = await get('/api/p/' + ID + '/layout?person=tester');
  ok('layout saved and read back', back && back.sizes && back.sizes.project.rows === 9);

  // 4. idempotent: opening again changes nothing but keeps the stamp
  const before = fs.readFileSync(path.join(cp, 'project.md'), 'utf8');
  fs.writeFileSync(path.join(cp, 'project.md'), before + '\nowner edit\n');
  const r2 = await post('/api/projects', { path: DEMO });
  ok('re-open returns the same id', r2.project.id === ID);
  ok('re-open never overwrites project.md', fs.readFileSync(path.join(cp, 'project.md'), 'utf8').includes('owner edit'));

  // 5. close on demand -> not loaded; room call reloads it
  await post('/api/p/' + ID + '/close', {});
  ok('close unloads it', !(await get('/api/engine')).loaded.includes(ID));
  await get('/api/p/' + ID + '/room');
  ok('a room call loads it again on demand', (await get('/api/engine')).loaded.includes(ID));

  // 6. a missing folder is reported, not invented
  const r3 = await post('/api/projects', { path: 'C:\\does\\not\\exist' });
  ok('a non-folder is refused', r3.ok === false && /not a folder/.test(r3.error));

  // 7. forget -> gone from the list, folder untouched
  const del = await fetch(BASE + '/api/projects/' + ID, { method: 'DELETE' }).then(j);
  ok('forget removes it from the list', del.ok && !(await get('/api/projects')).projects.some((p) => p.id === ID));
  ok('forget leaves .cockpit on disk', fs.existsSync(path.join(cp, 'cockpit.json')));

  // 8. the shell serves for / and /<id>, and never outside shell\
  ok('/ serves the shell', /Open a folder as a project/.test(await fetch(BASE + '/').then((r) => r.text())));
  ok('/some-id serves the shell', /Open a folder as a project/.test(await fetch(BASE + '/some-id').then((r) => r.text())));
  ok('path traversal is refused', (await fetch(BASE + '/../package.json')).status !== 200 || !/cockpit-engine/.test(await fetch(BASE + '/../package.json').then((r) => r.text())));

  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
