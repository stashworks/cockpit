/* Usage left, from the harness itself (2026-09-16) - ONE mechanism: adapter.usage() answers
   with the plan's own windows, the engine asks and puts the answer on the agent. Proves:
   (1) the merge: the tightest window becomes the number, a harness reading replaces a hand
   one, a failed probe leaves the last reading alone; (2) every harness with usage() is
   probed and none throws; (3) on a machine with a Claude Code login, the real endpoint
   answers with percentages. Throwaway engine state dir; no server needed. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-usage-'));
const harness = require(path.join(ROOT, 'engine/harness')); harness.load(path.join(ROOT, 'engine'));
const fleet = require(path.join(ROOT, 'engine/fleet')); fleet.load(tmp);
const agent = (id) => fleet.state().agents.find((a) => a.id === id);
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); process.exit(1); } console.log('ok   ' + m); };

// (1) the merge, without any harness
fleet.setAgent('claude-code', { usage: { leftPct: 70, resets: 'Sat' } });
ok(agent('claude-code').usage.leftPct === 70 && agent('claude-code').usage.source === 'manual', 'a hand-entered 70% is stored as manual');
fleet.usageFromHarness('claude-code', { windows: [] });
ok(agent('claude-code').usage.leftPct === 70, 'an empty answer leaves the last reading alone');
fleet.usageFromHarness('claude-code', { windows: [{ name: '5h', usedPct: 6, resetsAt: Date.now() + 3600e3 }, { name: 'weekly', usedPct: 16, resetsAt: Date.now() + 86400e3 }] });
const cu = agent('claude-code').usage;
ok(cu.leftPct === 84 && cu.source === 'harness' && cu.window === 'weekly' && cu.windows.length === 2, 'the harness reading replaces it: tightest window wins (weekly 16% used -> 84% left)');
fleet.usageFromHarness('codex-cli', { plan: 'prolite', windows: [{ name: 'weekly', usedPct: 0, resetsAt: Date.now() + 1e8 }] });
ok(agent('codex-cli').usage.leftPct === 100 && agent('codex-cli').usage.plan === 'prolite', 'codex: 0% used -> 100% left, plan carried');
ok(agent('codex-cli').canProbeUsage === true && agent('claude-code').canProbeUsage === true, 'both plan harnesses can be asked');

// (2) + (3) the real probes on this machine
harness.probeUsage().then((r) => {
  ok(r && typeof r === 'object', 'probeUsage answered: ' + JSON.stringify(r).slice(0, 300));
  const c = r['claude-code'];
  if (c && c.ok) {
    ok(c.windows.length >= 2 && c.windows.every((w) => typeof w.usedPct === 'number' && w.usedPct >= 0 && w.usedPct <= 100), 'claude: real endpoint gave ' + c.windows.map((w) => w.name + ' ' + w.usedPct + '%').join(', '));
    ok(agent('claude-code').usage.source === 'harness', 'and it landed on the agent');
  } else console.log('skip claude endpoint (' + (c ? c.why : 'no adapter') + ')');
  process.exit(0);
}).catch((e) => { console.error('FAIL probe threw ' + e.message); process.exit(1); });
