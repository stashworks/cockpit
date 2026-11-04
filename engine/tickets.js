/* Tickets - Phase 4 (docs/plan-verification-and-tickets.md). A change enters through a ticket the owner approved with
   its impact in front of him; the work names it; the rescan verifies it; a person passes it before prod; the promote
   records it; the rescan closes it.

   A ticket is a file: .cockpit\tickets\<n>.json (n = the GitHub issue number when the GitHub plugin is on, else a local
   number L1, L2, ...). GitHub is the maintainer when it is on - the issue carries the template, the labels carry the
   state - and this file is Cockpit's record of the impact, the verdicts and the state history. Cockpit reads the map;
   it never fixes a finding or closes a ticket on its own: the owner files (the gate), a person passes, the owner
   promotes. Only 'verified' and 'closed' come from evidence (verify.js, the rescan).

   impact(project, files)      the blast radius of a set of declared files, from the map - the ticket's risk
   draft(project, input)       the template filled: title, feature, files to create / alter, done-when, the analysis
   create(project, input)      the ticket file (+ the GitHub issue when on) and the ticket:#n tag on its scope
   list / get / setState       the states: created → in-work → verified → passed → promoted → closed (rejected aside) */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const STATES = ['draft', 'created', 'in-work', 'verified', 'passed', 'promoted', 'closed', 'rejected'];
/* who may move a ticket where: evidence moves it forward to verified and closed; people move it the rest */
/* SENT BACK MEANS BACK TO THE CODERS. Work the
   owner rejects in UAT is not his to carry: it returns to 'created' - to work, re-queued, with his words as the work
   order - and only reaches him again when it is green again, or when nothing can pick it up. */
const MOVES = { draft: ['created', 'rejected'], created: ['in-work', 'rejected'], 'in-work': ['verified', 'created', 'rejected'], verified: ['created', 'passed', 'in-work', 'rejected'], passed: ['promoted', 'created', 'in-work'], promoted: ['closed', 'created', 'in-work'], closed: [], rejected: ['created'] };
const dir = (p) => path.join(p.cockpit.dir, 'tickets');
const norm = (f) => String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');

function list(p) {
  try { return fs.readdirSync(dir(p)).filter((f) => /\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir(p), f), 'utf8')); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created))); } catch (e) { return []; }
}
function get(p, id) { try { return JSON.parse(fs.readFileSync(path.join(dir(p), String(id).replace(/^#/, '') + '.json'), 'utf8')); } catch (e) { return null; } }
function save(p, t) { fs.mkdirSync(dir(p), { recursive: true }); fs.writeFileSync(path.join(dir(p), String(t.id).replace(/^#/, '') + '.json'), JSON.stringify(t, null, 1) + '\n'); return t; }

/* ---------- the impact analysis: what a set of files touches, from the map ---------- */
function impact(p, files, opts) {
  const db = p.db;
  const rules = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'architecture', 'problems.json'), 'utf8')); } catch (e) { return {}; } })();
  const bandsCfg = rules.risk || { critical: 16, high: 9, medium: 4 };
  const bandOf = (sc) => sc >= bandsCfg.critical ? 'critical' : sc >= bandsCfg.high ? 'high' : sc >= bandsCfg.medium ? 'medium' : 'low';
  const nodes = db.all('SELECT subject, kind, title, file FROM node'); const byS = {}; nodes.forEach((n) => { byS[n.subject] = n; });
  const byFile = {}; nodes.forEach((n) => { if (n.file) byFile[n.file] = n; });
  const tag = {}; db.all("SELECT subject, ns, value FROM tag WHERE ns IN ('impact','churn','tested','layer','domain','problem','reach','sensitivity','auth','ticket')").forEach((t) => { (tag[t.subject] = tag[t.subject] || {})[t.ns] = t.ns === 'problem' || t.ns === 'ticket' ? ((tag[t.subject][t.ns] || []).concat(t.value)) : t.value; });
  const edges = db.all('SELECT src, dst, kind FROM edge');
  const into = {}; edges.forEach((e) => { (into[e.dst] = into[e.dst] || []).push(e); });   // who reaches what
  const from = {}; edges.forEach((e) => { (from[e.src] = from[e.src] || []).push(e); });
  const wanted = [...new Set((files || []).map(norm).filter(Boolean))];
  const scope = [], missing = [];
  for (const f of wanted) { const n = byFile[f]; if (n) scope.push(n); else missing.push(f); }
  const T = (s) => tag[s] || {};
  // per file: how likely a change here breaks something (the plan's ladder), and what it reaches
  const perFile = scope.map((n) => {
    const t = T(n.subject); const churn = t.churn || 'still', tested = t.tested, god = (t.problem || []).includes('god-file');
    let L = 2, why = 'quiet, covered';
    if (churn === 'hot' && tested === 'no' && god) { L = 5; why = 'hot, untested god file'; }
    else if (churn === 'hot' || tested === 'no') { L = 4; why = churn === 'hot' ? 'hot (8+ changes in 90 days)' + (tested === 'no' ? ', untested' : '') : 'untested'; }
    else if (churn === 'busy') { L = 3; why = 'busy (3-7 changes in 90 days)'; }
    else if (churn === 'still' && tested === 'yes') { L = 2; why = 'unchanged in 90 days, a test names it'; }
    else { L = 2; why = churn + (tested ? ', ' + (tested === 'yes' ? 'tested' : 'untested') : ''); }
    return { file: n.file, subject: n.subject, kind: n.kind, layer: t.layer || null, feature: t.domain && t.domain !== 'unsorted' ? t.domain : null, impact: Number(t.impact || 1), likelihood: L, why, churn, tested: tested || null, reach: t.reach || null, sensitive: t.sensitivity || null, problems: (t.problem || []).length, tickets: t.ticket || [] };
  });
  const newFiles = missing.map((f) => ({ file: f, likelihood: 1, why: 'new file - nothing depends on it yet', impact: 1 }));
  // the blast radius: everything that reaches the scope (up to 3 hops), rolled up; the flows the scope is part of
  const seen = new Set(scope.map((n) => n.subject)); let frontier = [...seen]; const reached = new Set();
  const scopeFiles = new Set(scope.map((n) => n.file));
  for (let hop = 0; hop < 3 && frontier.length; hop++) { const next = []; for (const s of frontier) for (const e of into[s] || []) if (!/^(proves|part-of|defines)$/.test(e.kind) && !seen.has(e.src)) { seen.add(e.src); next.push(e.src); if (!(byS[e.src] && scopeFiles.has(byS[e.src].file))) reached.add(e.src); } frontier = next; }   // a door defined in an altered file is the file, not its dependant
  const touchesTables = new Set(); scope.forEach((n) => (from[n.subject] || []).forEach((e) => { if ((e.kind === 'reads' || e.kind === 'writes') && byS[e.dst] && byS[e.dst].kind === 'table') touchesTables.add(e.dst + '|' + e.kind); }));
  const flows = new Set(); [...scope.map((n) => n.subject), ...reached].forEach((s) => (from[s] || []).forEach((e) => { if (e.kind === 'part-of' && byS[e.dst] && byS[e.dst].kind === 'flow') flows.add(e.dst); }));
  const features = {}; [...reached].forEach((s) => { const d = T(s).domain; const k = d && d !== 'unsorted' ? d : '(no feature)'; features[k] = (features[k] || 0) + 1; });
  const scopeFeatures = [...new Set(perFile.map((x) => x.feature).filter(Boolean))];
  const layers = [...new Set(perFile.map((x) => x.layer).filter((l) => l && l !== 'outside'))];
  const crossings = [];
  if (layers.includes('screens') && layers.includes('data')) crossings.push('a screen and data in one ticket - two kinds that never touch; split, or say why');
  if (scopeFeatures.length > 1) crossings.push(scopeFeatures.length + ' features in one ticket (' + scopeFeatures.join(', ') + ') - one slice, one feature');
  const L = Math.max(1, ...perFile.map((x) => x.likelihood), ...newFiles.map((x) => x.likelihood));
  const I = Math.max(1, ...perFile.map((x) => x.impact), ...[...reached].map((s) => Number(T(s).impact || 0)).filter(Boolean).slice(0, 0));   // the impact of what is altered; what reaches it is listed, not scored
  const score = L * I;
  const worst = perFile.slice().sort((a, b) => b.likelihood * b.impact - a.likelihood * a.impact)[0] || null;
  const requiredTests = [...flows].map((s) => ({ flow: s, name: byS[s].title, feature: T(s).domain || null, tested: T(s).tested || null }));
  const alreadyTicketed = perFile.filter((x) => x.tickets.length).map((x) => ({ file: x.file, tickets: x.tickets }));
  const out = { files: perFile, newFiles, missing, likelihood: L, impact: I, score, band: bandOf(score), worst: worst ? { file: worst.file, likelihood: worst.likelihood, impact: worst.impact, why: worst.why } : null,
    reach: { things: reached.size, features, sample: [...reached].slice(0, 12).map((s) => byS[s] ? (byS[s].file || byS[s].title) : s) },
    tables: [...touchesTables].map((x) => { const [s, k] = x.split('|'); return { table: byS[s].title, how: k, sensitive: T(s).sensitivity || null, owner: T(s).domain || null }; }),
    flows: requiredTests, features: scopeFeatures, kinds: layers, crossings, alreadyTicketed,
    split: score >= bandsCfg.critical ? 'critical: split this ticket, or carry a second-model review (the owner\'s rule)' : null };
  out.text = renderImpact(out);
  return out;
}
function renderImpact(a) {
  const L = [];
  L.push('Risk ' + a.band.toUpperCase() + ' - likelihood ' + a.likelihood + ' × impact ' + a.impact + ' = ' + a.score + (a.worst ? ' (worst: ' + a.worst.file + ', ' + a.worst.why + ', impact ' + a.worst.impact + ')' : ''));
  if (a.files.length) L.push('Altered: ' + a.files.map((f) => f.file + ' [' + (f.layer || f.kind) + (f.feature ? ', ' + f.feature : '') + ', L' + f.likelihood + '×I' + f.impact + (f.sensitive ? ', ' + f.sensitive : '') + (f.problems ? ', ' + f.problems + ' finding' + (f.problems === 1 ? '' : 's') : '') + ']').join('; '));
  if (a.newFiles.length) L.push('Created: ' + a.newFiles.map((f) => f.file).join(', '));
  L.push('Reach: ' + a.reach.things + ' thing' + (a.reach.things === 1 ? '' : 's') + ' depend on the altered files within 3 hops' + (Object.keys(a.reach.features).length ? ' - by feature: ' + Object.entries(a.reach.features).sort((x, y) => y[1] - x[1]).map(([k, v]) => k + ' ' + v).join(', ') : '') + (a.reach.sample.length ? ' (e.g. ' + a.reach.sample.slice(0, 6).join(', ') + ')' : ''));
  if (a.tables.length) L.push('Data: ' + a.tables.map((t) => t.table + ' (' + t.how + (t.sensitive ? ', ' + t.sensitive : '') + (t.owner ? ', owned by ' + t.owner : '') + ')').join('; '));
  L.push('Flows touched → tests required: ' + (a.flows.length ? a.flows.map((f) => f.name + (f.tested === 'yes' ? ' (proven)' : ' (UNPROVEN - a test is part of this ticket)')).join('; ') : 'none the map knows - name the flow this change belongs to, and its test'));
  if (a.crossings.length) L.push('Crossings: ' + a.crossings.join('; '));
  if (a.alreadyTicketed.length) L.push('Already in a ticket: ' + a.alreadyTicketed.map((x) => x.file + ' → ' + x.tickets.join(', ')).join('; '));
  if (a.split) L.push('Rule: ' + a.split);
  return L.join('\n');
}

/* ---------- the draft: the template filled ---------- */
function template() { return fs.readFileSync(path.join(__dirname, '..', 'plugins', 'tickets', 'ticket.md'), 'utf8').replace(/\r\n/g, '\n'); }
function draft(p, input) {
  const files = [...(input.alter || []), ...(input.create || []), ...(input.delete || [])].map(norm).filter(Boolean);
  const a = impact(p, files);
  const fill = {
    title: String(input.title || '').trim() || 'untitled',
    feature: input.feature || a.features.join(', ') || '(none)',
    kinds: (a.kinds.length ? a.kinds : ['(unknown)']).join(', '),
    flows: a.flows.length ? a.flows.map((f) => f.name).join(', ') : '(none the map knows)',
    risk: a.band, likelihood: a.likelihood, impact: a.impact,
    why: String(input.why || '').trim() || '(say why - the finding, the ask, the bug)',
    doctrine: String(input.doctrine || '').trim() || '(which rules this change must honour, and how)',
    create: (input.create || []).map(norm).filter(Boolean).map((f) => '- ' + f).join('\n') || '- (none)',
    alter: (input.alter || []).map(norm).filter(Boolean).map((f) => '- ' + f + (a.files.find((x) => x.file === f) ? '' : '  (not on the map)')).join('\n') || '- (none)',
    delete: (input.delete || []).map(norm).filter(Boolean).map((f) => '- ' + f).join('\n') || '- (none)',
    tests: [...a.flows.map((f) => '- flow ' + f.name + (f.tested === 'yes' ? ' - keeps passing' : ' - write its test')), ...String(input.tests || '').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => '- ' + s)].join('\n') || '- (name the test that proves this)',
    done: String(input.done || '').trim() || '(what a person reads back on the step before prod)',
    done_line: String(input.done || '').trim().split('\n')[0] || '(read-back missing)',
    at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    impact_analysis: a.text,
    origin: input.finding ? ' - from the finding "' + input.finding + '"' + (input.scope ? ' (' + input.scope + ')' : '') : '',
    number: input.number || 'n',
  };
  const body = template().replace(/\{\{(\w+)\}\}/g, (m, k) => (fill[k] !== undefined ? String(fill[k]) : m));
  return { title: fill.title, body: body.split('\n').slice(1).join('\n').trim(), impact: a, labels: ['feature:' + (fill.feature.split(',')[0].trim().replace(/[()]/g, '') || 'none'), ...a.kinds.map((k) => 'kind:' + k), 'risk:' + a.band, 'status:created'] };
}

/* ---------- filing ---------- */
function githubOf(p) { try { const g = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'plugins', 'github.json'), 'utf8')); return g.repo ? g : null; } catch (e) { return null; } }
function gh(p, args) {
  const env = { ...process.env, ...require('./ghauth').envFor(p) };
  return cp.execFileSync('gh', args, { encoding: 'utf8', timeout: 60000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function create(p, input, by) {
  const d = draft(p, input);
  const g = githubOf(p);
  let id, url = null, number = null;
  if (g) {
    const COLORS = { feature: '1d76db', kind: '5319e7', risk: 'd93f0b', status: '0e8a16' };
    for (const l of d.labels) { try { gh(p, ['label', 'create', l, '--repo', g.repo, '--color', COLORS[l.split(':')[0]] || 'ededed', '--force']); } catch (e) { /* exists, or an old gh without --force: the issue create says */ } }
    const out = gh(p, ['issue', 'create', '--repo', g.repo, '--title', d.title, '--body', d.body.replace('#n:', '#<n>:'), ...d.labels.flatMap((l) => ['--label', l])]);
    const m = /\/issues\/(\d+)\s*$/.exec(out); if (!m) throw new Error('gh issue create answered without an issue url: ' + out.slice(-200));
    number = Number(m[1]); url = out.split('\n').pop().trim(); id = String(number);
    try { gh(p, ['issue', 'edit', String(number), '--repo', g.repo, '--title', '#' + number + ': ' + d.title, '--body', d.body.replace(/#<n>:/g, '#' + number + ':')]); } catch (e) { /* the title stays plain; the number is in the url */ }   // the number at the front of the title
  } else {
    const n = list(p).filter((t) => /^L\d+$/.test(t.id)).length + 1; id = 'L' + n;
  }
  const t = { id, number, url, title: (number ? '#' + number : id) + ': ' + d.title, state: 'created', feature: input.feature || d.impact.features[0] || null, finding: input.finding || null, flow: String(input.flow || '').trim() || null, scope: input.scope || null,
    create: (input.create || []).map(norm).filter(Boolean), alter: (input.alter || []).map(norm).filter(Boolean), delete: (input.delete || []).map(norm).filter(Boolean), why: input.why || '', doctrine: input.doctrine || '', tests: input.tests || '', done: input.done || '',
    labels: d.labels, impact: { band: d.impact.band, likelihood: d.impact.likelihood, impact: d.impact.impact, score: d.impact.score, text: d.impact.text, flows: d.impact.flows, features: d.impact.features, kinds: d.impact.kinds, crossings: d.impact.crossings },
    body: d.body, created: new Date().toISOString(), by: by || 'owner', thread: input.thread || null, history: [{ state: 'created', at: new Date().toISOString(), by: by || 'owner', why: 'filed' + (g ? ' as ' + g.repo + '#' + number : ' locally') }], verdicts: [], touched: [] };   // thread: the conversation it came out of - the tests setup follows its ticket by this
  save(p, t);
  // the ticket on the map: every file in scope carries ticket:#n (hand-set: the scan never removes it)
  const graph = require('./graph'); const tagVal = number ? '#' + number : id;
  for (const f of [...t.alter, ...(t.delete || [])]) { const n = p.db.get('SELECT subject FROM node WHERE file = ?', f); if (n) graph.tagByHand(p.db, n.subject, 'ticket', tagVal, t.title, 'cockpit'); }
  if (input.subjects) for (const s of input.subjects) graph.tagByHand(p.db, s, 'ticket', tagVal, t.title, 'cockpit');
  try { require('./projects').bump(p.entry.id); } catch (e) { /* */ }
  return { ok: true, ticket: t };
}

/* ---------- drafts: what the AI proposes from the conversation, waiting on the owner ---------- */
/* THE DRAFT IS CHECKED BEFORE THE OWNER SEES IT. What can be known with no work done: a file to alter or delete that is not there; a file to create that already
   is; a flow no README defines (or none, said so); a file already on another ticket in work. Any of these and the draft
   is refused with the list - the AI fixes it and drafts again; the owner never sees a ticket that cannot be worked. */
function lint(p, input) {
  const out = [];
  const L = (v) => (v || []).map(norm).filter(Boolean);
  const alter = L(input.alter), create = L(input.create), del = L(input.delete);
  for (const f of alter) if (!fs.existsSync(path.join(p.dir, f))) out.push('alter ' + f + ': no such file (create it, or the path is wrong)');
  for (const f of del) if (!fs.existsSync(path.join(p.dir, f))) out.push('delete ' + f + ': no such file');
  for (const f of create) if (fs.existsSync(path.join(p.dir, f))) out.push('create ' + f + ': already exists (alter it)');
  const dup = [...alter, ...create, ...del].filter((f, i, a) => a.indexOf(f) !== i); if (dup.length) out.push('listed twice: ' + [...new Set(dup)].join(', '));
  const flows = String(input.flow || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  if (!flows.length) out.push('no --flow: name the README flow(s) this is part of, or --flow none with why in --what');
  else if (!(flows.length === 1 && /^none$/i.test(flows[0]))) for (const fl of flows) { let hit = null; try { hit = p.db.get("SELECT subject FROM node WHERE kind = 'flow' AND (subject = ? OR subject LIKE ? OR LOWER(title) = LOWER(?))", 'flow:' + fl, 'flow:%/' + fl.toLowerCase().replace(/[^a-z0-9]+/g, '-'), fl); } catch (e) { /* no map */ } if (!hit) out.push('flow "' + fl + '": no README defines it - write it under ## Flows first (the flow is the spec), then draft'); }
  const mine = new Set([...alter, ...create, ...del]);
  for (const t of list(p)) { if (t.state !== 'in-work' && t.state !== 'created') continue; const theirs = [...(t.alter || []), ...(t.create || []), ...(t.delete || [])].filter((f) => mine.has(f)); if (theirs.length) out.push(t.id + ' (' + t.state + ') already names ' + theirs.slice(0, 4).join(', ') + ' - two tickets on one file collide; wait for it, or fold the work into it'); }
  return out;
}
function draftFile(p, input, by) {
  const problems = lint(p, input);
  if (problems.length) { const e = new Error('the draft cannot be worked as written - ' + problems.length + ' thing' + (problems.length === 1 ? '' : 's') + ' to fix, then draft again:\n- ' + problems.join('\n- ')); e.lint = problems; throw e; }
  const n = list(p).filter((t) => /^D\d+$/.test(t.id)).length + 1; const id = 'D' + n;
  const d = draft(p, input);
  const t = { id, number: null, url: null, title: d.title, state: 'draft', feature: input.feature || d.impact.features[0] || null, finding: input.finding || null, flow: String(input.flow || '').trim() || null, scope: input.scope || null, adopt: input.adopt ? Number(input.adopt) : null,
    create: (input.create || []).map(norm).filter(Boolean), alter: (input.alter || []).map(norm).filter(Boolean), delete: (input.delete || []).map(norm).filter(Boolean), why: input.why || '', doctrine: input.doctrine || '', tests: input.tests || '', done: input.done || '',
    labels: d.labels, impact: { band: d.impact.band, likelihood: d.impact.likelihood, impact: d.impact.impact, score: d.impact.score, text: d.impact.text, flows: d.impact.flows, features: d.impact.features, kinds: d.impact.kinds, crossings: d.impact.crossings, missing: d.impact.missing },
    body: d.body, created: new Date().toISOString(), by: by || 'ai', thread: input.thread || null, history: [{ state: 'draft', at: new Date().toISOString(), by: by || 'ai', why: 'drafted from the conversation' }], verdicts: [], touched: [] };
  save(p, t);
  try { require('./events').record(p, { kind: 'ticket.draft', level: 'warn', title: id + ' drafted: ' + t.title, text: 'waits for your approve or reject', ref: id, source: 'tickets' }); } catch (e) { /* */ }
  try { require('./projects').bump(p.entry.id); } catch (e) { /* */ }
  return { ok: true, ticket: t, note: 'draft ' + id + ' waits for the owner\'s approval - the Approve button, /approve, or their word to you in the conversation (then `ticket approve ' + id + '`); never approve on your own' };
}
/* the owner's approval: the draft (with his edits) becomes the ticket - a GitHub issue when the plugin is on, or the
   adopted issue gets the body as a comment; the draft file goes */
function approve(p, id, edits, by) {
  const dft = get(p, id); if (!dft || dft.state !== 'draft') return { ok: false, error: 'no draft ' + id };
  const input = { title: dft.title, feature: dft.feature, alter: dft.alter, create: dft.create, delete: dft.delete || [], why: dft.why, doctrine: dft.doctrine, tests: dft.tests, done: dft.done, finding: dft.finding, flow: dft.flow, scope: dft.scope, thread: dft.thread, ...(edits || {}) };
  if (typeof input.alter === 'string') input.alter = input.alter.split('\n'); if (typeof input.create === 'string') input.create = input.create.split('\n'); if (typeof input.delete === 'string') input.delete = input.delete.split('\n');
  let r;
  if (dft.adopt) r = adopt(p, dft.adopt, input, by); else r = create(p, input, by);
  if (r.ok) {
    try { require('./events').resolve(p, { kind: 'ticket.draft', ref: id }); } catch (e) { /* */ }
    try { fs.unlinkSync(path.join(dir(p), id + '.json')); } catch (e) { /* */ }
    r.ticket.history.unshift({ state: 'draft', at: dft.created, by: dft.by, why: 'drafted from the conversation; approved by ' + (by || 'owner') });
    save(p, r.ticket);
    /* a redraft leaves its earlier self behind (D1 beside D2, 2026-09-20): the twins - same title, same files - go with the approved one */
    const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
    const twins = list(p).filter((t) => t.state === 'draft' && t.id !== id && String(t.title).trim().toLowerCase() === String(dft.title).trim().toLowerCase() && same(t.alter, dft.alter) && same(t.create, dft.create) && same(t.delete, dft.delete));
    for (const t of twins) { try { require('./events').resolve(p, { kind: 'ticket.draft', ref: t.id }); } catch (e) { /* */ } try { fs.unlinkSync(path.join(dir(p), t.id + '.json')); } catch (e) { /* */ } }
    if (twins.length) r.dropped = twins.map((t) => t.id);
  }
  return r;
}
function reject(p, id, by, why) {
  const t = get(p, id); if (!t) return { ok: false, error: 'no ticket ' + id };
  if (t.state === 'draft') { try { require('./events').resolve(p, { kind: 'ticket.draft', ref: id }); } catch (e) { /* */ } try { fs.unlinkSync(path.join(dir(p), id + '.json')); } catch (e) { /* */ } try { require('./projects').bump(p.entry.id); } catch (e) { /* */ } return { ok: true, dropped: id }; }
  return setState(p, id, 'rejected', by, why);
}
/* an issue that already exists on GitHub (pulled down to work): the ticket file for it, its impact, the body as a comment */
function adopt(p, number, input, by) {
  const g = githubOf(p); if (!g) return { ok: false, error: 'the GitHub plugin is off - nothing to adopt' };
  if (get(p, String(number))) return { ok: false, error: '#' + number + ' is already a Cockpit ticket' };
  /* ONE TICKET PER ISSUE (2026-09-22): the night the GitHub plugin was misconfigured, tickets were filed as local L-ids
     carrying the issue number in their title only - so adopt, which looked for a ticket FILED AS that number, saw none and
     made a second one. Two tickets for #3027 sat on the board, one claiming to be in UAT. An open ticket that references
     the issue counts, whatever its id; to send its work back to the coders use `ticket send-back`, not a new ticket. */
  /* the title must REFERENCE the issue - "#503" - not merely contain the digits (2026-09-25: D15, adopting #503, was refused
     because #4083 is titled "...checkout does not 503", an HTTP status) */
  { const re = new RegExp('(^|[^0-9A-Za-z&])#' + number + '([^0-9]|$)');
    const twin = list(p).find((x) => !['closed', 'rejected', 'draft'].includes(x.state) && (Number(x.number) === Number(number) || Number(x.adopt) === Number(number) || re.test(String(x.title || ''))));   // a DRAFT of this very issue is the thing being filed, not a twin (2026-09-23: the guard refused every approve)
    if (twin) return { ok: false, error: twin.id + ' already tracks #' + number + ' (' + twin.state + '): ' + String(twin.title).slice(0, 80) + '. Use `ticket send-back ' + twin.id + ' --why "..."` to put its work back on the queue, or `ticket edit ' + twin.id + '` - never a second ticket for one issue.' }; }
  let issue = null; try { issue = JSON.parse(gh(p, ['issue', 'view', String(number), '--repo', g.repo, '--json', 'title,url,state,labels,body'])); } catch (e) { return { ok: false, error: 'gh cannot read #' + number + ': ' + String(e.message).slice(0, 200) }; }
  const d = draft(p, { ...input, title: input.title || issue.title.replace(/^#\d+:\s*/, ''), number });
  for (const l of d.labels) { try { gh(p, ['label', 'create', l, '--repo', g.repo, '--force']); } catch (e) { /* */ } }
  try { gh(p, ['issue', 'edit', String(number), '--repo', g.repo, '--title', '#' + number + ': ' + d.title, ...d.labels.flatMap((l) => ['--add-label', l])]); } catch (e) { /* labels are advice */ }
  try { gh(p, ['issue', 'comment', String(number), '--repo', g.repo, '--body', '**Cockpit ticket** (adopted)\n\n' + d.body.replace(/#<n>:/g, '#' + number + ':')]); } catch (e) { /* */ }
  const t = { id: String(number), number: Number(number), url: issue.url, title: '#' + number + ': ' + d.title, state: 'created', feature: input.feature || d.impact.features[0] || null, finding: input.finding || null, flow: String(input.flow || '').trim() || null, scope: input.scope || null, adopted: true,
    create: (input.create || []).map(norm).filter(Boolean), alter: (input.alter || []).map(norm).filter(Boolean), delete: (input.delete || []).map(norm).filter(Boolean), why: input.why || issue.body || '', doctrine: input.doctrine || '', tests: input.tests || '', done: input.done || '',
    labels: d.labels, impact: { band: d.impact.band, likelihood: d.impact.likelihood, impact: d.impact.impact, score: d.impact.score, text: d.impact.text, flows: d.impact.flows, features: d.impact.features, kinds: d.impact.kinds, crossings: d.impact.crossings },
    body: d.body, created: new Date().toISOString(), by: by || 'owner', history: [{ state: 'created', at: new Date().toISOString(), by: by || 'owner', why: 'adopted from ' + g.repo + '#' + number }], verdicts: [], touched: [] };
  save(p, t);
  const graph = require('./graph');
  for (const f of t.alter) { const n = p.db.get('SELECT subject FROM node WHERE file = ?', f); if (n) graph.tagByHand(p.db, n.subject, 'ticket', '#' + number, t.title, 'cockpit'); }
  try { require('./projects').bump(p.entry.id); } catch (e) { /* */ }
  return { ok: true, ticket: t };
}
/* the features a ticket may name: what the map knows, what earlier tickets used - one list, so names stay one name */
function features(p) {
  const out = {};
  for (const r of p.db.all("SELECT value, COUNT(*) AS n FROM tag WHERE ns = 'domain' AND value NOT IN ('unsorted', 'none', 'shared', '-') GROUP BY value")) out[r.value] = { key: r.value, things: r.n, tickets: 0 };
  for (const t of list(p)) if (t.feature) { out[t.feature] = out[t.feature] || { key: t.feature, things: 0, tickets: 0 }; out[t.feature].tickets++; }
  return Object.values(out).sort((a, b) => b.things - a.things || a.key.localeCompare(b.key));
}

/* ---------- states ---------- */
/* where the checkout stood when the work on a ticket began - the verdict's "touched" reads git from here (verify.js) */
function headSha(p) { try { return cp.execFileSync('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], { cwd: require('./hot').hot(path.join(__dirname, 'verify.js')).repoOf(p).dir, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return null; } }   // the code's git, one folder down where the project keeps it there (verify.js repoOf)
/* THE PROJECT'S OWN WORDS ON GITHUB. Cockpit used to write status:<its own state>, which collided with the
   project's vocabulary: its verdict going green wrote status:verified, and in one project that label MEANS a person confirmed
   it in UAT - so a ticket nobody had tested jumped to "to prod". The map is explicit instead, read from the GitHub
   plugin's stages (its labels block, and the project's override):
     in-work   -> the project's inProgress label    a coder has it
     passed    -> the project's verified label      the owner pressed Push to prod: he tested it in UAT
     promoted  -> the project's live label          it is live for customers
   Cockpit's own verified (the verdict) writes NO label: on a GitHub project the step after the tests is the merge, and
   GitHub proves that itself. Closed closes the issue. */
function ghLabels(p) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const base = read(path.join(__dirname, '..', 'plugins', 'github', 'stages.json')) || {};
  const over = read(path.join(p.cockpit.dir, 'plugins', 'github.stages.json')) || {};
  const L = { ...((base.labels) || {}), ...((over.labels) || {}) };
  const out = {};
  if (L.inProgress) out['in-work'] = L.inProgress;
  if (L.verified) out.passed = L.verified;
  if (L.live) out.promoted = L.live;
  return out;
}
function setState(p, id, state, by, why, extra) {
  const t = get(p, id); if (!t) return { ok: false, error: 'no ticket ' + id };
  if (!STATES.includes(state)) return { ok: false, error: 'no such state: ' + state };
  if (!(MOVES[t.state] || []).includes(state)) return { ok: false, error: t.state + ' → ' + state + ' is not a move; from ' + t.state + ' a ticket goes to ' + ((MOVES[t.state] || []).join(', ') || 'nowhere') };
  const from = t.state;
  if (state === 'in-work' && !t.startSha) t.startSha = headSha(p);   // the first time it goes in work: git from here counts as its touches
  if (state === 'in-work' && !t.baseline) { try { t.baseline = require('./hot').hot(path.join(__dirname, 'verify.js')).snapshot(p, [...(t.alter || []), ...(t.create || []), ...(t.delete || [])]); } catch (e) { /* the verdict falls back to its first before */ } }   // the map's reading of its files before any work: what every later verdict compares against
  t.state = state; t.history.push({ state, at: new Date().toISOString(), by: by || 'owner', why: why || null, ...(extra || {}) });
  save(p, t);
  /* the event: what it means for the owner, not just the move (engine/events.js) */
  try {
    const EV = { verified: ['warn', 'verified - pass it, or send it back'], created: ['info', 'approved, to be worked'], 'in-work': ['info', 'in work'], passed: ['info', 'passed - goes out with the next promote'], promoted: ['info', 'promoted'], closed: ['info', 'closed'], rejected: ['info', 'rejected'] };
    const slip = state === 'created' && from === 'in-work';   // sent back to work
    const e = EV[state] || ['info', state];
    require('./events').resolve(p, { kind: 'ticket.', ref: String(id) });   // what it waited for is over
    require('./events').resolve(p, { kind: 'fleet.', ref: String(id) });
    require('./events').record(p, { kind: 'ticket.' + state, level: slip ? 'alert' : e[0], title: (/^#?\d+$/.test(String(id)) ? '#' : '') + id + ' ' + (slip ? 'back to work' : e[1]) + ': ' + t.title, text: (why || '') + (by ? ' (' + by + ')' : ''), ref: String(id), url: t.url || null, source: 'tickets' });
  } catch (e) { /* */ }
  const g = githubOf(p);
  if (g && t.number) {
    const LAB = ghLabels(p), mine = LAB[state] || null, all = [...new Set(Object.values(LAB))];
    if (mine) { try { gh(p, ['label', 'create', mine, '--repo', g.repo, '--color', '0e8a16', '--force']); } catch (e) { /* it exists */ } }
    try { const args = ['issue', 'edit', String(t.number), '--repo', g.repo, ...all.filter((l) => l !== mine).flatMap((l) => ['--remove-label', l]), ...(mine ? ['--add-label', mine] : [])]; if (mine || all.length) gh(p, args); } catch (e) { t.history[t.history.length - 1].github = 'label not written: ' + String(e.message).split(String.fromCharCode(10))[0].slice(0, 120); }
    if (why) { try { gh(p, ['issue', 'comment', String(t.number), '--repo', g.repo, '--body', '**' + state + '** (' + (by || 'owner') + ', Cockpit): ' + why]); } catch (e) { /* */ } }
    if (state === 'closed') { try { gh(p, ['issue', 'close', String(t.number), '--repo', g.repo]); } catch (e) { /* */ } }
  }
  try { require('./projects').bump(p.entry.id); } catch (e) { /* */ }
  return { ok: true, ticket: t };
}
/* the owner fixes what a ticket declares - the files it alters, creates, deletes - while it is not yet closed; a note
   on the ticket says so. The verdict is asked for again with verify (engine/verify.js) on the files the turns touched. */
/* an AI may change what a filed ticket SAYS - its file lists, done-when, what, flow, title - until it is verified; where it
   stands is evidence and the owner's press. Every edit is a
   line in the history with the old and the new, so the owner sees what changed after his approval. */
function edit(p, id, patch, by) {
  const t = get(p, id); if (!t) return { ok: false, error: 'no ticket ' + id };
  if (t.state === 'draft') return { ok: false, error: 'a draft is redrafted (ticket withdraw, then ticket draft), not edited' };
  if (!(t.state === 'created' || t.state === 'in-work')) return { ok: false, error: 'the ticket is ' + t.state + ' - past editing; from verified on it is the owner\'s (Send back puts it in work again)' };
  const L = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map(norm).filter(Boolean);
  const changes = [];
  for (const k of ['alter', 'create', 'delete']) if (patch[k] !== undefined) { const was = t[k] || [], now = L(patch[k]); const add = now.filter((f) => !was.includes(f)), gone = was.filter((f) => !now.includes(f)); if (add.length || gone.length) { t[k] = now; changes.push(k + (add.length ? ' +' + add.join(' +') : '') + (gone.length ? ' -' + gone.join(' -') : '')); } }
  for (const k of ['done', 'why', 'flow', 'title']) if (patch[k] !== undefined) { const now = String(patch[k]).trim(); if (now && now !== (t[k] || '')) { changes.push(k + ': "' + String(t[k] || '').slice(0, 60) + '" → "' + now.slice(0, 60) + '"'); t[k] = now; } }
  if (!changes.length) return { ok: true, ticket: t, note: 'nothing changed' };
  t.history.push({ note: 'edited by ' + (by || 'ai') + ': ' + changes.join(' · '), at: new Date().toISOString(), by: by || 'ai' });
  try { if (patch.alter !== undefined || patch.create !== undefined || patch.delete !== undefined) { const d = draft(p, { ...t, alter: t.alter, create: t.create, delete: t.delete }); t.impact = { ...(t.impact || {}), band: d.impact.band, score: d.impact.score, text: d.impact.text, flows: d.impact.flows, features: d.impact.features, missing: d.impact.missing }; } } catch (e) { /* the impact keeps its old reading */ }
  save(p, t); try { require('./projects').bump(p.entry.id); } catch (e) { /* */ }
  return { ok: true, ticket: t, changed: changes };
}
function setFiles(p, id, files, by) {
  const t = get(p, id); if (!t) return { ok: false, error: 'no ticket ' + id };
  if (t.state === 'closed' || t.state === 'rejected') return { ok: false, error: 'the ticket is ' + t.state };
  const L = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(norm).filter(Boolean);
  const was = { alter: t.alter, create: t.create, delete: t.delete || [] };
  if (files.alter !== undefined) t.alter = L(files.alter); if (files.create !== undefined) t.create = L(files.create); if (files.delete !== undefined) t.delete = L(files.delete);
  t.history.push({ note: 'declared files changed by ' + (by || 'owner') + ': alter ' + was.alter.length + ' → ' + t.alter.length + ', create ' + was.create.length + ' → ' + t.create.length + ', delete ' + was.delete.length + ' → ' + t.delete.length, at: new Date().toISOString() });
  save(p, t); try { require('./projects').bump(p.entry.id); } catch (e) { /* */ }
  return { ok: true, ticket: t };
}
/* the workflow, on the ticket: who took it, which try, a red sending it round again, the fleet giving up. History only - never a GitHub comment; the verdict text itself is (comment). */
function log(p, id, text, by) { const t = get(p, id); if (!t) return { ok: false, error: 'no ticket ' + id }; t.history.push({ note: text, at: new Date().toISOString(), by: by || 'cockpit' }); save(p, t); return { ok: true }; }

/* THE BRIEFING - what a coder would otherwise spend ten minutes of tool calls finding (the ticket
   turns cost a million tokens of reading; "hand the coder its reading up front"). For every file the ticket names:
   whether it exists, what it is (@kind, @purpose from its header), its feature and layer from the map, and the tests
   that name it. Then the feature README's flows (the ticket's own flow first). Then the one rule that stops the
   re-running: only the named tests run inside the turn; the engine runs the whole plan after. Bounded in size. */
function briefing(p, t) {
  const out = []; const MAX = 7000;
  const files = [...new Set([...(t.alter || []).map((f) => ['alter', f]), ...(t.create || []).map((f) => ['create', f]), ...(t.delete || []).map((f) => ['delete', f])].map((x) => x.join('\t')))].map((x) => x.split('\t'));
  let testSrc = [];
  try { const T = require('./hot').hot(path.join(__dirname, 'tests.js')); testSrc = [...T.testFiles(p), ...T.browserFiles(p)].map((rel) => { let s = ''; try { s = fs.readFileSync(path.join(p.dir, rel), 'utf8'); } catch (e) { /* */ } return { rel, s }; }); } catch (e) { /* no tests */ }
  const namedBy = (rel) => { const base = path.posix.basename(rel).replace(/\.[^.]+$/, ''); if (base.length <= 2) return []; return testSrc.filter((x) => x.rel !== rel && x.s.indexOf(base) >= 0).map((x) => x.rel); };
  const header = (rel) => { let s = ''; try { s = fs.readFileSync(path.join(p.dir, rel), 'utf8'); } catch (e) { return null; } const lines = s.split('\n').length; const h = {}; for (const m of s.slice(0, 1500).matchAll(/@(kind|purpose|feature|flow)\s+([^\n@]+)/g)) h[m[1]] = h[m[1]] || m[2].trim(); return { lines, ...h }; };
  out.push('THE FILES, READ FOR YOU (open only what the work needs):');
  for (const [what, rel] of files.slice(0, 40)) {
    const n = p.db.get('SELECT subject FROM node WHERE file = ?', rel); const tag = {}; if (n) for (const r of p.db.all("SELECT ns, value FROM tag WHERE subject = ? AND ns IN ('domain','layer','kind')", n.subject)) tag[r.ns] = r.value;
    const h = header(rel);
    if (!h) { out.push('- ' + what + ' ' + rel + (what === 'create' ? ' - new file, nothing depends on it yet' : ' - NOT FOUND on disk')); continue; }
    const tests = namedBy(rel);
    out.push('- ' + what + ' ' + rel + ' (' + h.lines + ' lines' + (h.kind || tag.kind ? ', ' + (h.kind || tag.kind) : '') + (tag.domain && tag.domain !== 'unsorted' ? ', feature ' + tag.domain : '') + (tag.layer ? ', ' + tag.layer : '') + ')' + (h.purpose ? ': ' + h.purpose.slice(0, 160) : '') + (tests.length ? ' · tests naming it: ' + tests.slice(0, 4).join(', ') : ' · no test names it'));
  }
  if (files.length > 40) out.push('- … and ' + (files.length - 40) + ' more on the ticket');
  // the feature's README flows: the ticket's own flow first, the rest after
  const feat = String(t.feature || '').split(',')[0].trim().toLowerCase();
  if (feat) {
    let readme = null; try { for (const r of p.db.all("SELECT file FROM node WHERE file LIKE '%README.md'")) { let s = ''; try { s = fs.readFileSync(path.join(p.dir, r.file), 'utf8'); } catch (e) { continue; } if (new RegExp('@feature\\s+' + feat.replace(/[^a-z0-9_-]/g, ''), 'i').test(s.slice(0, 800))) { readme = { rel: r.file, s }; break; } } } catch (e) { /* */ }
    if (readme) {
      const sec = /^##\s+Flows\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(readme.s);
      const lines = sec ? sec[1].split('\n').map((l) => l.trim()).filter((l) => /^[-*]\s/.test(l)) : [];
      const mine = String(t.flow || '').trim().toLowerCase();
      const first = lines.filter((l) => mine && l.toLowerCase().indexOf(mine) >= 0), rest = lines.filter((l) => !first.includes(l));
      out.push('', 'THE FEATURE\'S FLOWS (' + readme.rel + ')' + (mine ? ' - this ticket\'s flow "' + t.flow + '" first' : '') + ':');
      [...first, ...rest].slice(0, 12).forEach((l) => out.push(l.length > 300 ? l.slice(0, 300) + '…' : l));
      if (!lines.length) out.push('(no ## Flows in it yet - write the flow into the README first; it is the spec)');
    }
  }
  out.push('', 'RUN ONLY WHAT IS NAMED: inside this turn run the test files listed above and the ones you create - `node --test <file>` one at a time - never the whole plan (`npm test`, the Tests tab); the engine runs the whole plan after your turn and the verdict reads that. Read a file once; do not grep the project for what is written here.');
  out.push('', 'BEFORE YOU END: commit the work (one commit naming ' + (t.number ? '#' + t.number : t.id) + '), then run `ticket check ' + t.id + '` - it is the verdict Cockpit will give, check by check, with the map re-read. Put every ✗ right (a finding on a file you touched, a declared file untouched, an undeclared file, uncommitted work), check again, and end only on green. A red verdict costs a whole extra turn; the check costs seconds.');
  let text = out.join('\n'); if (text.length > MAX) text = text.slice(0, MAX) + '\n… (the briefing is cut here; the ticket names the rest)';
  return text;
}
function comment(p, id, text) {
  const t = get(p, id), g = githubOf(p); if (!t) return { ok: false, error: 'no ticket ' + id };
  if (g && t.number) { try { gh(p, ['issue', 'comment', String(t.number), '--repo', g.repo, '--body', text]); return { ok: true, where: 'github' }; } catch (e) { return { ok: false, error: e.message }; } }
  t.history.push({ note: text, at: new Date().toISOString() }); save(p, t); return { ok: true, where: 'file' };
}

/* ---------- the moves evidence makes, after a scan lands ----------
   passed → promoted: the last promote (scripts/promote.js writes .cockpit/tests/smoke.json with from → to) carried a
   commit naming the ticket - read from git, never assumed. promoted → closed: the ticket came from a finding and the
   rescan shows that finding gone from its scope (the done-when a machine can read); a ticket from an ask, not a
   finding, is closed by a person. */
function afterScan(p, log) {
  const say = (t) => { if (log) log(t); };
  let smoke = null; try { smoke = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'tests', 'smoke.json'), 'utf8')); } catch (e) { /* never promoted through the script */ }
  let promotedLog = null;
  if (smoke && smoke.ok && smoke.to) { try { promotedLog = cp.execFileSync('git', ['-c', 'safe.directory=*', 'log', '--format=%s%n%b', smoke.prev ? smoke.prev + '..' + smoke.to : (smoke.from && smoke.from !== smoke.to) ? smoke.from + '..' + smoke.to : smoke.to],   /* since the last promote that held; else what this one moved; else everything the target holds */ { cwd: p.dir, encoding: 'utf8', timeout: 20000, windowsHide: true }); } catch (e) { promotedLog = null; } }
  for (const t of list(p)) {
    const id = t.number ? '#' + t.number : t.id;
    /* a passed ticket went out with the promote when a commit names it - or, the promote being dev's whole HEAD, when it
       was passed (its work committed, by the verdict) before the promote ran: everything committed went */
    const passedAt = ((t.history || []).filter((h) => h.state === 'passed').pop() || {}).at || null;
    const named = promotedLog && new RegExp('(^|[^\\w])' + id.replace('#', '#') + '(?![\\d])', 'm').test(promotedLog);
    if (t.state === 'passed' && smoke && smoke.ok && smoke.to && (named || (passedAt && passedAt < smoke.at)) && !(t.history || []).some((h) => h.promote === smoke.at)) {
      const r = setState(p, t.id, 'promoted', 'cockpit', 'the promote of ' + String(smoke.at).slice(0, 16).replace('T', ' ') + ' (' + (smoke.from ? String(smoke.from).slice(0, 9) : 'empty') + ' → ' + String(smoke.to).slice(0, 9) + ') ' + (named ? 'carried a commit naming ' + id : 'took dev\'s whole commit, ' + id + ' passed before it') + ' and the smoke passed', { promote: smoke.at });
      if (r.ok) say('ticket ' + id + ' → promoted');
    }
    /* the prod test: the flows read back on prod after that promote, all green - the ticket is done. No flows yet: Complete is the owner's press. */
    if (t.state === 'promoted' && smoke && smoke.ok && smoke.flows && smoke.flows.ran && !smoke.flows.failed && (t.history || []).some((h) => h.promote === smoke.at)) {
      const r = setState(p, t.id, 'closed', 'cockpit', 'the prod test passed: ' + smoke.flows.passed + ' flow' + (smoke.flows.passed === 1 ? '' : 's') + ' read back on ' + (smoke.env || 'prod') + ' after the promote of ' + String(smoke.at).slice(0, 16).replace('T', ' '), { promote: smoke.at });
      if (r.ok) { say('ticket ' + id + ' → complete (prod test green)'); continue; }
    }
    if (t.state === 'promoted' && t.finding) {
      const files = [...(t.alter || []), ...(t.create || []), ...(t.delete || [])];
      const left = files.filter((f) => { const n = p.db.get('SELECT subject FROM node WHERE file = ?', f); return n && p.db.get("SELECT 1 FROM tag WHERE subject = ? AND ns = 'problem' AND value = ?", n.subject, t.finding); }).length;
      if (!left) { const r = setState(p, t.id, 'closed', 'cockpit', 'the rescan shows ' + t.finding + ' at 0 on the ticket\'s ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' - the done-when holds'); if (r.ok) say('ticket ' + id + ' → closed'); }
    }
  }
}

module.exports = { STATES, MOVES, list, get, save, impact, renderImpact, draft, draftFile, approve, reject, adopt, features, create, setState, setFiles, edit, comment, githubOf, ghLabels, afterScan, log, briefing };
