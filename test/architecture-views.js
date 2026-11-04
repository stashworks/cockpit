/* The Architecture tab's feature-level views, rendered against a live engine's map (COCKPIT_URL, a project id):
   the Features board, the Tables view and the Doctrine checklist must render, and say the true counts. */
'use strict';
const assert = require('node:assert/strict');
const BASE = process.env.COCKPIT_URL || 'http://localhost:4500', PID = process.argv[2] || 'my-app';
const get = (u) => fetch(BASE + u).then((r) => r.json());
(async () => {
  const doctrineLocal = () => require('../engine/doctrine').parse(require('node:path').join(__dirname, '..'));   // the route needs a restart the engine may not have had yet
  const [nodes, edges, domain, doctrine, problem] = await Promise.all([get('/api/p/' + PID + '/graph/nodes'), get('/api/p/' + PID + '/graph/edges'), get('/api/p/' + PID + '/graph?lens=domain'), get('/api/doctrine').catch(doctrineLocal), get('/api/p/' + PID + '/graph?lens=problem')]);
  // a browser-shaped room for the card's script
  global.window = { Pages: { register() {} } }; global.Layout = { state: { api: '/api/p/' + PID, cards: {} }, refresh() {}, fit() {} }; global.fetch = () => new Promise(() => {}); global.document = { getElementById() { return null; } };
  require('../plugins/architecture/cards/architecture.js');
  const X = window.__arch; const A = X.A;
  A.domainLegend = domain.legend || []; A.doctrine = doctrine; A.problemLegend = problem.legend || [];
  const pj = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugins', 'architecture', 'problems.json'), 'utf8')); A.problemRules = {}; Object.keys(pj.rules).forEach((k) => { A.problemRules[k] = { on: pj.rules[k].on !== false, band: pj.rules[k].band || 'info', weight: pj.rules[k].weight || 2, decl: !!pj.rules[k].decl, stage: pj.rules[k].stage || 'quality' }; { const sj = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugins', 'architecture', 'stages.json'), 'utf8')); A.stages = sj.stages; A.stageGroups = sj.groups; } });
  A.problemBands = {}; Object.keys(A.problemRules).forEach((k) => { A.problemBands[k] = A.problemRules[k].band; }); A.problemLegend.forEach((l) => { A.problemBands[l.value] = l.band; });
  const flow = { nodes: (nodes.nodes || []).filter((n) => n.kind === 'file' || n.kind === 'table' || n.kind === 'route' || n.kind === 'flow'), edges: edges.edges || [], layout: null };
  const ix = X.featureIndex(flow);
  console.log(PID + ': ' + ix.list.length + ' features, ' + ix.none.nodes.length + ' things in none, ' + ix.orphanBin.length + ' in the bin');
  ix.list.slice(0, 6).forEach((f) => console.log('  ' + f.title.padEnd(24) + (f.live ? 'live    ' : 'orphaned') + '  ' + f.screens + 's ' + f.actions + 'a ' + f.logic + 'l ' + f.data + 'd  critical ' + f.critical + ' high ' + f.high + ' breaks ' + f.breaks + ' tested ' + f.tested + '/' + f.testable + ' moved ' + f.moved + '/' + f.files));
  const fh = X.featuresHtml(flow); assert.ok(fh.includes('ft-grid') || fh.includes('No features yet'), 'features board renders');
  const th = X.tablesHtml(flow); assert.ok(th.includes('<table class="tb">') || th.includes('No tables'), 'tables view renders');
  const tables = flow.nodes.filter((n) => n.kind === 'table').length; if (tables) assert.ok(th.includes(' of ' + tables + ' tables'), 'the tables view counts every table');
  const dc = X.doctrineChecklist(flow); assert.ok(dc.includes('Process slips') && dc.includes('SAST') && dc.includes('Functional') && ((dc.split('Process slips')[1] || '').match(/dc-row/g) || []).length === doctrine.rules.length + Object.values(A.problemRules || {}).filter((r) => r.on && r.stage === 'doctrine').length, 'every doctrine rule is a row (plus the checks that sit in the process stage); the stages render');
  const found = (dc.match(/dc-row bad/g) || []).length, clean = (dc.match(/dc-row ok/g) || []).length, judged = (dc.match(/dc-row judge/g) || []).length, off = (dc.match(/dc-row quiet/g) || []).length;
  console.log('  groups: ' + (dc.match(/dc-group/g) || []).length + ', stage sections: ' + (dc.match(/dc-stage/g) || []).length + ', check rows before the doctrine: ' + ((dc.split('Process slips')[0] || '').match(/dc-row/g) || []).length);
  console.log('  doctrine rows: ' + found + ' with findings, ' + clean + ' checked clean, ' + off + ' not a rule here, ' + judged + ' judged elsewhere');
  const withThings = ix.list.find((f) => f.screens + f.actions + f.logic + f.data > 0);   /* a feature made only of tests draws nothing of its own */
  A.feature = withThings ? withThings.key : null; A.g = { graded: true, legend: [] }; A.lens = 'problem';
  if (A.feature) { const svg = X.drawFlow(flow, null); assert.ok(svg.includes('<svg') && (svg.match(/class="fn own"/g) || []).length > 0, 'the flow draws for one feature, its own things marked'); console.log('  flow for "' + withThings.title + '": ' + (svg.match(/class="fn( own| near)?"/g) || []).length + ' boxes'); }
  // a finding that exists on this map, and the band it lands in - the map changes; the test follows it
  const firstHit = (() => { for (const n of flow.nodes) for (const t of n.tags || []) if (t.startsWith('problem:')) return { n, value: t.slice(8).replace('*', '') }; return null; })();
  if (!firstHit) { console.log('  no findings on this map - the finding panel has nothing to list; skipped'); return; }
  const VALUE = firstHit.value, BAND = X.riskOf(firstHit.n, VALUE).band;
  const fp = X.findingPanel(flow, VALUE); assert.ok(fp.includes('features by risk') && fp.includes('Create ticket') && fp.includes('table class="rm"'), 'the finding panel renders the matrix'); console.log('  ' + A.findingBrief.split('\n').slice(2, 4).join('\n  '));
  A.cell = 'band:' + BAND; const fp2 = X.findingPanel(flow, VALUE); assert.ok(fp2.includes('fd-cell') && (fp2.match(/class="fd-ex/g) || []).length > 0, 'a band lists its files'); console.log('  ' + VALUE + ' / ' + BAND + ' cell lists ' + (fp2.match(/class="fd-ex/g) || []).length + ' rows');
  { const m = new RegExp('data-cell="(feat:[^"]*:' + BAND + ')"').exec(fp2); if (m) { A.cell = m[1]; const fp3 = X.findingPanel(flow, VALUE); assert.ok((fp3.match(/class="fd-ex/g) || []).length > 0, 'a feature bubble lists its files'); console.log('  ' + m[1] + ' lists ' + (fp3.match(/class="fd-ex/g) || []).length + ' rows'); } }
  assert.ok(A.findingBrief.includes('Scope:') && A.findingTicket.includes('scope:'), 'the brief and the ticket carry the scope'); console.log('  brief scope line: ' + A.findingBrief.split('\n').find((l) => l.startsWith('Scope:')).slice(0, 110));
  A.feature = null; A.grain = 'features'; A.lens = 'problem'; A.g = { graded: true, legend: problem.legend || [] }; { const svg = X.drawFlow(Object.assign({}, flow, { layout: JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugins', 'architecture', 'layouts.json'), 'utf8')).typescript }), null); const boxes = (svg.match(/class="fn feat/g) || []).length, cross = (svg.match(/class="fe cross"/g) || []).length, curves = (svg.match(/class="fe/g) || []).length; assert.ok(boxes > 0 || ix.list.length === 0, 'feature grain draws boxes'); console.log('  feature grain: ' + boxes + ' boxes, ' + curves + ' curves, ' + cross + ' cross-feature writes'); }
  if (withThings) { A.tagsOn = true; A.tf = { feature: [withThings.key], kind: [], flow: [], source: [], q: '' }; A.feature = null; A.lens = 'declared'; A.g = { graded: false, legend: [] }; { const svg = X.drawFlow(Object.assign({}, flow, { layout: JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugins', 'architecture', 'layouts.json'), 'utf8')).typescript }), null); const lit = (svg.match(/class="fn own"/g) || []).length, all = (svg.match(/class="fn/g) || []).length; assert.ok(lit > 0 && lit < all, 'the tag filter narrows the slice and lights it'); console.log('  tag filter (' + withThings.title + '): ' + lit + ' lit of ' + all + ' drawn'); const tfh = X.tagFilterHtml(flow); assert.ok(tfh.includes('@feature') && tfh.includes('tags from'), 'the filter row renders'); } }
  console.log('ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
