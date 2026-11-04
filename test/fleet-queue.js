// The fleet's queue, in-process: order across tiers and projects, reorder, park, pause, and
// that an agent that is OFF or PAUSED takes nothing. No turn is run. node test/fleet-queue.js
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.join(os.tmpdir(), 'cockpit-fleet-test'); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
// the fleet asks the harness layer for the agent list; give it the real one from the engine
process.chdir(path.join(__dirname, '..'));
const harness = require('../engine/harness'); harness.load(path.join(__dirname, '..', 'engine'));
const fleet = require('../engine/fleet');
fleet.load(root);
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };

const s0 = fleet.state();
ok('agents seeded, one per harness, all OFF', s0.agents.length >= 1 && s0.agents.every((a) => !a.on), s0.agents.map((a) => a.id + ':' + (a.on ? 'on' : 'off')).join(', '));
const a = fleet.add({ project: 'acme-web', title: 'acme-web P3', priority: 'P3' });
const b = fleet.add({ project: 'website', title: 'website P1', priority: 'P1' });
const c = fleet.add({ project: 'acme-web', title: 'acme-web next', priority: 'next' });
const d = fleet.add({ project: 'notes', title: 'notes P1 later', priority: 'P1' });
const order = () => fleet.state().items.map((i) => i.title);
ok('order is tier first across projects, then age', order().join(' | ') === 'acme-web next | website P1 | notes P1 later | acme-web P3', order().join(' | '));
fleet.reorder([d.id, b.id]);
ok('reorder within a tier', order().join(' | ') === 'acme-web next | notes P1 later | website P1 | acme-web P3', order().join(' | '));
fleet.update(c.id, { status: 'parked' });
ok('park keeps the item, changes status', fleet.state().items.find((i) => i.id === c.id).status === 'parked');
fleet.update(a.id, { priority: 'next' });
ok('changing priority moves it', order()[0] === 'acme-web P3' || order()[0] === 'acme-web next', order()[0]);
fleet.pauseAll(true);
ok('pause all pauses every agent', fleet.state().agents.every((x) => x.paused));
fleet.setAgent(s0.agents[0].id, { on: true, projects: ['website'] });
const ag = fleet.state().agents.find((x) => x.id === s0.agents[0].id);
ok('an agent can be switched on with an allow-list', ag.on && ag.projects.length === 1 && ag.projects[0] === 'website');
ok('queue state persisted to fleet.json', JSON.parse(fs.readFileSync(path.join(root, 'fleet.json'), 'utf8')).items.length === 4);
ok('no turn ran (every agent paused)', fleet.state().agents.every((x) => !x.running));
// security / findings tickets: the strong coders only (never Pi)
const pin = fleet.add({ project: 'pin-test', title: 'a security ticket', priority: 'P3', harness: 'claude-code' });
ok('a pinned item keeps its harness', pin.harness === 'claude-code');
ok('a pi coder may not take it', !fleet.takeable({ id: 'pi', harness: 'pi', projects: null }, pin));
ok('any claude-code coder may, on any account', fleet.takeable({ id: 'claude-code-2', harness: 'claude-code', projects: null }, pin));
const free = fleet.add({ project: 'pin-test-2', title: 'an ordinary ticket', priority: 'P3' });
ok('an unpinned item is anyone\'s', !free.harness && fleet.takeable({ id: 'pi', harness: 'pi', projects: null }, free));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
