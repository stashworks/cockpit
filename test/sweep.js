// Leftover working copies (engine/sweep.js): on throwaway repos in the temp folder, no engine. node test/sweep.js
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const sweep = require('../engine/sweep');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-sweep-'));
const g = (cwd, ...a) => cp.execFileSync('git', ['-c', 'safe.directory=*', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const bare = path.join(T, 'remote.git'); g(T, 'init', '--bare', '-b', 'main', bare);
const proj = path.join(T, 'proj'); g(T, 'clone', bare, proj); fs.writeFileSync(path.join(proj, 'a.txt'), 'a'); g(proj, 'add', '.'); g(proj, 'commit', '-m', 'a'); g(proj, 'push', 'origin', 'HEAD:main');
const old = (p) => { const t = new Date(Date.now() - 3600e3); fs.utimesSync(p, t, t); };
// 1 clean, pushed, outside, old -> removed
const clean = path.join(T, 'proj-revert-1'); g(proj, 'worktree', 'add', '-b', 'r1', clean, 'main'); g(clean, 'push', 'origin', 'r1'); old(clean);
// 2 uncommitted changes -> kept
const dirty = path.join(T, 'proj-revert-2'); g(proj, 'worktree', 'add', '-b', 'r2', dirty, 'main'); fs.writeFileSync(path.join(dirty, 'wip.txt'), 'x'); old(dirty);
// 3 a commit on no remote -> kept
const unpushed = path.join(T, 'proj-revert-3'); g(proj, 'worktree', 'add', '-b', 'r3', unpushed, 'main'); fs.writeFileSync(path.join(unpushed, 'b.txt'), 'b'); g(unpushed, 'add', '.'); g(unpushed, 'commit', '-m', 'b'); old(unpushed);
// 4 recent -> kept, quietly
const recent = path.join(T, 'proj-revert-4'); g(proj, 'worktree', 'add', '-b', 'r4', recent, 'main'); g(recent, 'push', 'origin', 'r4');
// 5 inside the project (a coder's folder) -> never touched
const inside = path.join(proj, '.coders', 'pi'); g(proj, 'worktree', 'add', '-b', 'r5', inside, 'main'); old(inside);

const r = sweep.sweep({ dir: proj, entry: { id: 'proj' } });
const kept = (p) => r.kept.find((k) => path.resolve(k.path) === path.resolve(p));
ok('a clean, pushed copy beside the project is removed', r.removed.some((p) => path.resolve(p) === path.resolve(clean)) && !fs.existsSync(clean), JSON.stringify(r.removed));
ok('a copy with uncommitted changes is kept, and says why', !!kept(dirty) && /uncommitted/.test(kept(dirty).why) && fs.existsSync(dirty));
ok('a copy with commits on no remote is kept, and says why', !!kept(unpushed) && /no remote/.test(kept(unpushed).why) && fs.existsSync(unpushed));
ok('a copy used in the last 30 minutes is kept quietly', !!kept(recent) && kept(recent).quiet === true && fs.existsSync(recent));
ok('a coder\'s folder inside the project is never touched', !kept(inside) && fs.existsSync(inside) && !r.removed.some((p) => path.resolve(p) === path.resolve(inside)));
try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
