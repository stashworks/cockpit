// The queue on a GitHub project (engine/ghqueue.js): the rules only, no gh call and no turn. node test/gh-queue.js
// The process: merged → In UAT, blocked label → Blocked, closed → Done, anything else → Not completed.
const q = require('../engine/ghqueue');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const cfg = { holdLabels: q.DEFAULTS.holdLabels, skipAssignees: ['other-dev'] };
const I = (number, o) => ({ number, state: 'open', labels: [], assignees: [], ...o });
const P = (number, tickets, o) => ({ number, state: 'open', merged: null, checks: 'pending', tickets, ...o });
const T0 = '2026-09-24T20:00:00.000Z', LATER = '2026-09-24T21:00:00.000Z', EARLIER = '2026-09-20T00:00:00.000Z';

// where a turn left its ticket
ok('closed ticket → closed', q.classify(I(1, { state: 'closed' }), [], T0, cfg).status === 'closed');
ok('PR merged during the try → merged (In UAT)', q.classify(I(2), [P(90, [2], { state: 'merged', merged: LATER })], T0, cfg).status === 'merged');
ok('PR merged BEFORE the try is not this try\'s', q.classify(I(3), [P(91, [3], { state: 'merged', merged: EARLIER })], T0, cfg).status === 'notdone');
ok('a coder\'s blocked label → blocked', q.classify(I(4, { labels: ['blocked:environment'] }), [], T0, cfg).why === 'blocked:environment');
ok('needs:decision → blocked', q.classify(I(5, { labels: ['needs:decision'] }), [], T0, cfg).status === 'blocked');
const nd = q.classify(I(6), [P(92, [6], { checks: 'fail' })], T0, cfg);
ok('open PR with failing checks → not completed, says so', nd.status === 'notdone' && /PR #92 is open, its checks fail/.test(nd.why), nd.why);
ok('a PR for another ticket does not count', q.classify(I(7), [P(93, [8], { state: 'merged', merged: LATER })], T0, cfg).status === 'notdone');

// the queue against the scan
const items = [
  { id: 1, gh: 10, status: 'queued', added: T0 },                     // ticket closed → closed
  { id: 2, gh: 11, status: 'queued', added: T0 },                     // merged after it was added → merged
  { id: 3, gh: 12, status: 'queued', added: T0 },                     // merged before it was added → stays
  { id: 4, gh: 13, status: 'queued', added: T0 },                     // someone else's now → handed off
  { id: 5, gh: 14, status: 'blocked', added: T0 },                    // label lifted → queued, tries reset
  { id: 6, gh: 15, status: 'blocked', added: T0 },                    // still labelled → stays
  { id: 7, title: '#16: old item with its number in the title', status: 'queued', added: T0 },
  { id: 8, gh: 17, status: 'done', added: T0 },                       // an old "done" is not the ticket's place
  { id: 9, gh: 19, status: 'queued', added: T0 },                     // a person passed it in UAT → past coding, not blocked
];
const issues = [I(10, { state: 'closed' }), I(11), I(12), I(13, { assignees: ['other-dev'] }), I(14), I(15, { labels: ['blocked:waiting-on-owner'] }), I(16), I(17), I(18), I(19, { labels: ['status:verified'] }), I(20)];
const prs = [P(94, [11], { state: 'merged', merged: LATER }), P(95, [12], { state: 'merged', merged: EARLIER }), P(96, [20], { state: 'merged', merged: EARLIER })];
const r = q.plan(items, issues, prs, cfg);
const to = (id) => (r.moves.find((m) => m.it.id === id) || {}).to || 'stays';
ok('closed ticket leaves the queue', to(1) === 'closed');
ok('merged since added → merged', to(2) === 'merged');
ok('an earlier partial merge does not pull a queued item', to(3) === 'stays');
ok('assigned to a skipped person → handed off, not blocked', to(4) === 'handed');
ok('hold lifted → back in the queue, tries reset', to(5) === 'queued' && r.moves.find((m) => m.it.id === 5).reset);
ok('still held → stays blocked', to(6) === 'stays');
ok('status:verified on a queued item → merged (past coding), not blocked', to(9) === 'merged');
ok('status:verified after a turn → merged, not blocked', q.classify(I(21, { labels: ['status:verified'] }), [], T0, cfg).status === 'merged');
const added = r.add.map((i) => i.number).sort((a, b) => a - b);
ok('missing workable tickets are added (17 had only a "done" item, 18 had none)', added.join(',') === '17,18', added.join(','));
ok('not added: an item\'s number read from its title (16), held (19), already merged once (20)', !added.includes(16) && !added.includes(19) && !added.includes(20));
const stale = q.plan([{ id: 20, gh: 30, status: 'blocked', added: T0, outcome: { at: LATER } }], [I(30)], [], cfg, T0);
ok('a scan older than the block does not unblock it', !stale.moves.length);
const fresh2 = q.plan([{ id: 21, gh: 31, status: 'blocked', added: T0, outcome: { at: T0 } }], [I(31)], [], cfg, LATER);
ok('a scan newer than the block, label gone → back in the queue', fresh2.moves.length === 1 && fresh2.moves[0].to === 'queued');
// the merge queue (2026-09-25: three green PRs were blocked while GitHub's queue held them)
ok('open PR in the merge queue → merging, even with a coder\'s blocked label', q.classify(I(40, { labels: ['blocked:waiting-on-owner'] }), [P(97, [40], { inQueue: true, checks: 'pass' })], T0, cfg).status === 'merging');
ok('open PR NOT in the queue → not completed as before', q.classify(I(41), [P(98, [41], { checks: 'pass' })], T0, cfg).status === 'notdone');
const mq = q.plan([
  { id: 30, gh: 50, status: 'blocked', added: T0, outcome: { at: LATER } },
  { id: 31, gh: 51, status: 'merging', added: T0, mergingSince: new Date().toISOString() },
  { id: 32, gh: 52, status: 'merging', added: T0, mergingSince: new Date().toISOString() },
  { id: 33, gh: 53, status: 'merging', added: T0, mergingSince: EARLIER },
], [I(50, { labels: ['blocked:retries-exhausted', 'P2'] }), I(51), I(52), I(53)], [P(99, [50], { state: 'merged', merged: LATER }), P(100, [51], { state: 'merged', merged: LATER }), P(101, [52]), P(102, [53])], cfg, T0);
const mv = (id) => mq.moves.find((m) => m.it.id === id) || {};
ok('blocked, then its PR merged → merged, blocked: label taken off (even from an older scan)', mv(30).to === 'merged' && mv(30).unlabel.join() === 'blocked:retries-exhausted');
ok('merging, PR merged → merged', mv(31).to === 'merged');
ok('merging, PR still open and recent → stays', !mv(32).to);
ok('merging for too long → back in the queue', mv(33).to === 'queued');
ok('numOf reads gh, ticket, then the title', q.numOf({ gh: 5 }) === 5 && q.numOf({ ticket: '6' }) === 6 && q.numOf({ title: '#7: x' }) === 7 && q.numOf({ ticket: 'D3', title: 'D3: x' }) === null);
// put back by hand after a block: the scan still holding the old label must not block it again (#3882, 2026-09-25)
const back = { id: 40, gh: 40, status: 'queued', added: T0, outcome: { reason: 'blocked:retries-exhausted', at: T0 } };
const lbl = [I(40, { labels: ['blocked:retries-exhausted'] })];
ok('requeued by hand, scan older than the requeue → stays queued', !q.plan([back], lbl, [], cfg, LATER).moves.length && !!back.outcome.backAt);
const newer = new Date(Date.parse(back.outcome.backAt) + 60000).toISOString();
ok('a scan after the requeue that still has the label → blocked again', (q.plan([back], lbl, [], cfg, newer).moves[0] || {}).to === 'blocked');
ok('a normal queued item with a label is still blocked', (q.plan([{ id: 41, gh: 41, status: 'queued', added: T0 }], [I(41, { labels: ['blocked:environment'] })], [], cfg, LATER).moves[0] || {}).to === 'blocked');
// merging on auto-merge: a red check sends it back at once, but only on a scan taken after the turn ended (2026-09-25)
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const am = () => ({ id: 50, gh: 50, status: 'merging', added: ago(30), outcome: { at: ago(10) } });
const amPlan = (checks, scan) => q.plan([am()], [I(50)], [P(97, [50], { checks })], cfg, scan).moves;
ok('merging, a check went red (fresh scan) → back in the queue', (amPlan('fail', ago(2))[0] || {}).to === 'queued');
ok('merging, checks still running → stays', !amPlan('pending', ago(2)).length);
ok('merging, red only on a scan older than the turn → stays', !amPlan('fail', ago(20)).length);
// PART OF IT: a merge whose PR says "Remaining: ..." sends the ticket back to To work, not In UAT
const part = q.classify(I(60), [P(98, [60], { state: 'merged', merged: LATER, rest: { 60: 'steps 2 and 4' } })], T0, cfg);
ok('merged with work remaining → part, says what is left', part.status === 'part' && /remaining: steps 2 and 4/.test(part.why), part.why);
ok('merged with nothing remaining → merged (In UAT)', q.classify(I(61), [P(99, [61], { state: 'merged', merged: LATER, rest: {} })], T0, cfg).status === 'merged');
ok('a queued item whose only merge was a part stays queued', !q.plan([{ id: 62, gh: 62, status: 'queued', added: T0 }], [I(62)], [P(100, [62], { state: 'merged', merged: LATER, rest: { 62: 'the rest' } })], cfg, LATER).moves.length);
const mp = q.plan([{ id: 63, gh: 63, status: 'merging', added: ago(30), outcome: { at: ago(10) } }], [I(63)], [P(101, [63], { state: 'merged', merged: ago(5), rest: { 63: 'the AI filter' } })], cfg, ago(2)).moves[0] || {};
ok('merging, the PR merged as a part → back in the queue for the rest', mp.to === 'queued' && mp.part === true, mp.why);
ok('an open ticket whose only merged PR was a part joins the queue', q.plan([], [I(64)], [P(102, [64], { state: 'merged', merged: LATER, rest: { 64: 'x' } })], cfg, LATER).add.some((i) => i.number === 64));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
