// The three queue rules of 2026-10-03, no gh call and no turn. node test/findings.js
//   (a) a merged "Part of" PR with no Remaining line is unfinished (plugins/github/link.js)
//   (b) a findings ticket is done when its findings are gone from the map (engine/findings.js, ghqueue.findingsCheck)
//   (c) security and findings tickets go to the strong coders only (ghqueue.harnessFor, fleet.takeable)
const link = require('../plugins/github/link');
const fx = require('../engine/findings');
const q = require('../engine/ghqueue');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };

// (a)
const NEW = '2026-10-03T15:00:00Z', OLD = '2026-10-02T15:00:00Z';
const pr = (title, body, mergedAt) => ({ title, body, mergedAt, closingIssuesReferences: [] });
const rest = (x) => (link.ticketsOf(x)[0] || {}).remaining || null;
ok('(a) merged "Part of" with no Remaining line → unfinished', /^not said/.test(rest(pr('fix: x (Part of #7)', 'Does a thing.', NEW)) || ''));
ok('(a) "Part of" in the body counts too', /^not said/.test(rest(pr('fix: x', 'Part of #7\n\nDoes a thing.', NEW)) || ''));
ok('(a) "Remaining: none" → finished', rest(pr('fix: x (Part of #7)', 'Part of #7\nRemaining: none', NEW)) === null);
ok('(a) "Remaining: step 2" → that text', rest(pr('fix: x (Part of #7)', 'Remaining: step 2', NEW)) === 'step 2');
ok('(a) "Implements" with no line → finished', rest(pr('fix: x', 'Implements #7', NEW)) === null);
ok('(a) merged before the rule → old reading (finished)', rest(pr('fix: x (Part of #7)', 'Does a thing.', OLD)) === null);
ok('(a) not merged yet → nothing said', rest(pr('fix: x (Part of #7)', 'Does a thing.', null)) === null);
const cfg = q.config({ cockpit: { dir: __dirname + '/no-such-dir' } });
const nd = q.classify({ number: 7, state: 'open', labels: [], assignees: [] }, [{ number: 1, state: 'merged', merged: NEW, tickets: [7], rest: { 7: rest(pr('x (Part of #7)', 'y', NEW)) } }], OLD, cfg);
ok('(a) the queue reads it as a part merge, back to To work', nd.status === 'part', nd.status + ' ' + nd.why);

// (b) the pure rules
const body = 'Fix these.\n' + fx.marker('cross-feature-write', ['file:a.ts', 'file:b.ts', 'file:c.ts']);
const f = fx.parse(body);
ok('(b) the marker reads back', f && f.rule === 'cross-feature-write' && f.subjects.length === 3);
ok('(b) no marker → not a findings ticket', fx.parse('just a ticket') === null);
ok('(b) a broken marker → not a findings ticket', fx.parse('<!-- cockpit:findings {nope} -->') === null);
const v1 = fx.verdict(f, fx.leftOf(f, new Set(['file:b.ts', 'file:z.ts'])));
ok('(b) one left → not done, names it', !v1.done && /1 of 3/.test(v1.note) && /file:b\.ts/.test(v1.note) && !/file:a\.ts/.test(v1.note), v1.note);
ok('(b) none left → done', fx.verdict(f, fx.leftOf(f, new Set(['file:z.ts']))).done);

// (b) the check in the queue, on a fake project
const fakeDb = (tagged, scans) => ({
  all: (sql, rule) => /FROM tag/.test(sql) ? tagged.map((s) => ({ subject: s })) : [],
  get: (sql, a, b) => /FROM scan_run/.test(sql) ? (scans.filter((s) => s.started > b).pop() || null) : /FROM gh_issue/.test(sql) ? { labels: '["status:in-uat"]' } : null,
});
const calls = []; const gh = (p, args) => { calls.push(args.slice(0, 2).join(' ')); return Promise.resolve(null); };
const G = { repo: 'o/r' }, MERGED = '2026-10-03T16:00:00Z', AT = '2026-10-03T18:00:00Z';
const rows = new Map([[7, { number: 7, body }]]);
const prs7 = [{ number: 1, state: 'merged', merged: MERGED, tickets: [7] }];
let it = { id: 1, gh: 7, status: 'merged', added: '2026-10-03T10:00:00Z', turns: 1 };
q.findingsCheck({ db: fakeDb(['file:b.ts'], [{ id: 5, started: '2026-10-03T15:00:00Z' }]) }, G, [it], prs7, rows, AT, gh);
ok('(b) no scan since the merge → not judged yet', it.status === 'merged' && !calls.length);
q.findingsCheck({ db: fakeDb(['file:b.ts'], [{ id: 6, started: '2026-10-03T17:00:00Z' }]) }, G, [it], prs7, rows, AT, gh);
ok('(b) findings left after a scan of the merge → back to To work, tries reset', it.status === 'queued' && it.turns === 0 && it.redoAt === AT && /1 of 3/.test(it.lastTry), it.status + ' ' + it.lastTry);
ok('(b) ...says so on the ticket and takes the in-UAT label off', calls.includes('issue comment') && calls.includes('issue edit'), calls.join(', '));
ok('(b) the merge it judged no longer counts for the item', q.startOf(it) === AT);
const plan = q.plan([it], [{ number: 7, state: 'open', labels: [], assignees: [] }], prs7, cfg, AT);
ok('(b) the queue does not pull it back to UAT on the old merge', !plan.moves.some((m) => m.it === it), JSON.stringify(plan.moves.map((m) => m.to)));
const planOld = q.plan([it], [{ number: 7, state: 'open', labels: ['status:in-uat'], assignees: [] }], prs7, cfg, '2026-10-03T17:59:00Z');
ok('(b) ...nor on a scan that still had the in-UAT label', !planOld.moves.some((m) => m.it === it));
calls.length = 0;
let it2 = { id: 2, gh: 7, status: 'merged', added: '2026-10-03T10:00:00Z', turns: 1 };
q.findingsCheck({ db: fakeDb([], [{ id: 6, started: '2026-10-03T17:00:00Z' }]) }, G, [it2], prs7, rows, AT, gh);
ok('(b) none left → stays In UAT, said once', it2.status === 'merged' && it2.findingsOk && calls.length === 1);
q.findingsCheck({ db: fakeDb([], [{ id: 6, started: '2026-10-03T17:00:00Z' }]) }, G, [it2], prs7, rows, AT, gh);
ok('(b) ...and not said again for the same scan', calls.length === 1);
let it3 = { id: 3, gh: 7, status: 'queued', added: '2026-10-03T10:00:00Z', turns: 1, outcome: { at: '2026-10-03T16:30:00Z' } };
q.findingsCheck({ db: fakeDb([], [{ id: 6, started: '2026-10-03T17:00:00Z' }]) }, G, [it3], [], rows, AT, gh);
ok('(b) a try that accepted them all, no PR → done', it3.status === 'merged');
let it4 = { id: 4, gh: 7, status: 'queued', added: '2026-10-03T10:00:00Z', turns: 0 };
q.findingsCheck({ db: fakeDb([], [{ id: 6, started: '2026-10-03T17:00:00Z' }]) }, G, [it4], [], rows, AT, gh);
ok('(b) never tried → not judged', it4.status === 'queued');

// (b) a finding from a test run is judged only on a run of code that holds the merge
const holdsIf = (good) => (m, v) => good.includes(v);
const flowF = { rule: 'flow-failing', subjects: ['flow:settings/invite-member'] };
ok('(b) a code rule needs no run', fx.evidence(f, 'abc', null, holdsIf([])).at === null);
ok('(b) a flow rule with no run waits', !!fx.evidence(flowF, 'abc', null, holdsIf([])).wait);
ok('(b) a run that does not say its code waits', /does not say/.test(fx.evidence(flowF, 'abc', { at: AT }, holdsIf([])).wait || ''));
ok('(b) a run of code before the merge waits', /does not hold/.test(fx.evidence(flowF, 'abc', { at: AT, version: 'old1234' }, holdsIf([])).wait || ''));
ok('(b) a run of code that holds the merge → judged from that run', fx.evidence(flowF, 'abc', { at: AT, version: 'new1234' }, holdsIf(['new1234'])).at === AT);
ok('(b) a unit-test finding needs the folder\'s code too', !!fx.evidence({ rule: 'test-failing', subjects: ['x'] }, 'abc', { at: AT, version: 'new1234', repoVersion: 'old1234' }, holdsIf(['new1234'])).wait);
ok('(b) a crash finding reads the probes\' code', fx.evidence({ rule: 'input-crash', subjects: ['x'] }, 'abc', { at: AT, stagesVersion: 'new1234' }, holdsIf(['new1234'])).at === AT);
ok('(b) a semgrep finding waits for a security scan of the fix', /does not hold/.test(fx.evidence({ rule: 'sast-sensitive-info', subjects: ['x'] }, 'abc', { at: AT, sast: { at: AT, commit: 'old1234' } }, holdsIf(['new1234'])).wait || ''));
ok('(b) ...and is judged from that scan once it holds it', fx.evidence({ rule: 'sast-sensitive-info', subjects: ['x'] }, 'abc', { at: 'x', sast: { at: AT, commit: 'new1234' } }, holdsIf(['new1234'])).at === AT);
ok('(b) a security scan that did not run is never a clean one', /did not run/.test(fx.evidence({ rule: 'sast-sensitive-info', subjects: ['x'] }, 'abc', { at: AT, sast: { at: AT, commit: 'new1234', ran: false, why: 'exit 1' } }, holdsIf(['new1234'])).wait || ''));
ok('(b) dast findings are never judged (no version recorded)', !!fx.evidence({ rule: 'dast-medium', subjects: ['x'] }, 'abc', { at: AT, version: 'new1234', stagesVersion: 'new1234' }, holdsIf(['new1234'])).wait);
const flowBody = 'x\n' + fx.marker('flow-failing', ['flow:settings/invite-member']);
const rowsF = new Map([[8, { number: 8, body: flowBody }]]);
const prs8 = [{ number: 2, state: 'merged', merged: MERGED, tickets: [8], mergeCommit: 'm8' }];
const scansF = [{ id: 9, started: '2026-10-03T17:30:00Z' }];
calls.length = 0;
let it5 = { id: 5, gh: 8, status: 'merged', added: '2026-10-03T10:00:00Z', turns: 1 };
q.findingsCheck({ db: fakeDb(['flow:settings/invite-member'], scansF) }, G, [it5], prs8, rowsF, AT, gh, { run: () => ({ at: '2026-10-03T17:00:00Z', version: 'old' }), holds: (p, m, v) => v === 'new' });
ok('(b) a flow still red on a run of the OLD code → not sent back, waits', it5.status === 'merged' && !calls.length && /does not hold/.test(it5.findingsWait || ''), it5.findingsWait);
q.findingsCheck({ db: fakeDb(['flow:settings/invite-member'], scansF) }, G, [it5], prs8, rowsF, AT, gh, { run: () => ({ at: '2026-10-03T17:00:00Z', version: 'new' }), holds: (p, m, v) => v === 'new' });
ok('(b) still red on a run of the fix, scanned after → back to To work', it5.status === 'queued', it5.status);
let it6 = { id: 6, gh: 8, status: 'merged', added: '2026-10-03T10:00:00Z', turns: 1 };
q.findingsCheck({ db: fakeDb(['flow:settings/invite-member'], scansF) }, G, [it6], prs8, rowsF, AT, gh, { run: () => ({ at: '2026-10-03T17:45:00Z', version: 'new' }), holds: (p, m, v) => v === 'new' });
ok('(b) a run of the fix that no scan has read yet → waits for the scan', it6.status === 'merged');

// (c)
ok('(c) security label → claude-code only', q.harnessFor(['bug', 'security'], '', cfg) === 'claude-code');
ok('(c) findings label → claude-code only', q.harnessFor(['findings'], '', cfg) === 'claude-code');
ok('(c) findings marker in the body → claude-code only', q.harnessFor([], body, cfg) === 'claude-code');
ok('(c) an ordinary ticket → any coder', q.harnessFor(['bug', 'P2'], 'text', cfg) === null);

console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
