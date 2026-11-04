// Adding coders (engine/fleet.js addAgent / removeAgent) and reading usage per coder (engine/harness.js probeUsage):
// in-process, on a scratch engine root, no turn run and no network. node test/fleet-agents.js
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.join(os.tmpdir(), 'cockpit-fleet-agents-test'); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
process.chdir(path.join(__dirname, '..'));
const harness = require('../engine/harness'); harness.load(path.join(__dirname, '..', 'engine'));
const fleet = require('../engine/fleet'); fleet.load(root);
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };

const r = fleet.addAgent({ id: 'claude-2', harness: 'claude-code' });
ok('a second Claude coder can be added', r.ok, r.error);
const a = fleet.state().agents.find((x) => x.id === 'claude-2');
ok('it arrives switched off', a && !a.on);
ok('it has its own login folder under the engine root', a && a.env && a.env.CLAUDE_CONFIG_DIR === path.join(root, 'accounts', 'claude-2') && fs.existsSync(a.env.CLAUDE_CONFIG_DIR), a && a.env && a.env.CLAUDE_CONFIG_DIR);
ok('the card is told it is not logged in yet', a && a.login && a.login.ok === false, JSON.stringify(a && a.login));
ok('the built-in claude-code keeps the machine login (no env)', !fleet.state().agents.find((x) => x.id === 'claude-code').env);
ok('a name clash is refused', !fleet.addAgent({ id: 'claude-2', harness: 'claude-code' }).ok);
ok('a bad name is refused', !fleet.addAgent({ id: 'Claude 2!', harness: 'claude-code' }).ok);
ok('an unknown kind is refused', !fleet.addAgent({ id: 'x-1', harness: 'no-such' }).ok);
ok('a built-in coder cannot be removed', !fleet.removeAgent('claude-code').ok);

// a login appears in the folder: the card reads it
fs.writeFileSync(path.join(a.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', subscriptionType: 'max', expiresAt: Date.now() + 3600e3 } }));
const a2 = fleet.state().agents.find((x) => x.id === 'claude-2');
ok('once logged in, the card shows its own login and plan', a2.login && a2.login.ok && a2.login.plan === 'max', JSON.stringify(a2.login));

// usage is asked per coder, with that coder's folder
const cc = require('../engine/harnesses/claude-code.js'); const asked = [];
const realUsage = cc.usage; cc.usage = (o) => { asked.push(o && o.configDir); return Promise.resolve({ ok: true, windows: [{ name: 'weekly', usedPct: 40 }] }); };
harness.probeUsage('claude-2').then(() => {
  cc.usage = realUsage;
  ok('usage for claude-2 is read from its own folder', asked.length === 1 && asked[0] === a.env.CLAUDE_CONFIG_DIR, JSON.stringify(asked));
  ok('and lands on claude-2 only', (fleet.state().agents.find((x) => x.id === 'claude-2').usage || {}).leftPct === 60);
  ok('removing an added coder works and leaves its login folder', fleet.removeAgent('claude-2').ok && fs.existsSync(a.env.CLAUDE_CONFIG_DIR));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
});
