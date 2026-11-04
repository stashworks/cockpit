/* The Architecture card - the living map, drawn from the engine's graph (docs/generic-ide.md
   §3; drawing rules learned the hard way):
     · a lens is a question, and the lens bar is whatever namespaces the scan produced
     · ≤6 nodes a row, ≤26 a ring with labels radiating outward, more a wrapped grid
     · graded lenses own red/amber/green; slicing lenses use a palette with none of those
     · the legend and the circles take their colour from one place (a --sw custom property)
     · click a node with children to drill; click a leaf to see what touches it, in the rail
   Nothing here knows what a PHP page is. Subjects, kinds and lenses come from the scan. */
(function () {
  'use strict';
  /* THE OWNER'S CLOCK, NOT UTC's.
     Every time Cockpit shows comes off an ISO string, which is UTC; sliced raw it reads as tomorrow all evening. */
  function whenLocal(s) { if (!s) return ''; var t = new Date(s); return isNaN(t) ? String(s).slice(0, 16).replace('T', ' ') : t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  /* views another plugin brings to this page's bar: id → { title, hint, on(): is it shown for this project, render(host) }. Either script may load first. */
  window.ArchViews = window.ArchViews || {};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u) { return fetch(u).then(function (r) { return r.json(); }); };
  var HUES = ['#4f8cff', '#8f7fe0', '#5aa9c9', '#c98ac9', '#7fb3e0', '#6fa8dc', '#9b8cf0', '#7ad0d0', '#b48ee0', '#5fb0e8'];
  var BAND = { bad: '#f0615a', warn: '#e0a63a', ok: '#38c172', info: '#5c6678', quiet: '#3a4456' };
  var OTHER = '#55627a';

  var A = { zoom: 0.42, project: null, lens: null, parent: null, g: null, lenses: [], sel: null, detail: null, loading: false, settings: false, scanning: false, scanStamp: '', view: 'features', flow: null, flowLoading: false, pickValue: null, pickEdge: null, feature: null, doctrine: null, domainLegend: null, tableQ: '', finding: null, tagsOn: false, tf: { family: [], feature: [], kind: [], flow: [], source: [], q: '' } };   // Features open first; Flow / Tables / Levels are the drill-down   // Flow opens first; Levels is for a project too big to see whole

  function load() {
    A.loading = true;
    api(Layout.state.api + '/tests/dast').then(function (r) { A.dast = r; }).catch(function () { A.dast = null; });
    return api(Layout.state.api + '/graph/lenses').then(function (r) {
      A.lenses = r.lenses || [];
      if (!A.lens && A.lenses.length) A.lens = (A.lenses.find(function (l) { return l.graded; }) || A.lenses[0]).ns;
      return api(Layout.state.api + '/graph?lens=' + encodeURIComponent(A.lens || '') + (A.parent ? '&parent=' + encodeURIComponent(A.parent) : ''));
    }).then(function (g) { A.g = g; A.loading = false; Layout.refresh(); });
  }
  function select(subject) { A.sel = subject; A.detail = null; if (/^file:/.test(subject) && A.onPage && window.openFile) { A.codeOpen = true; window.openFile(subject.slice(5)); } api(Layout.state.api + '/graph/node?subject=' + encodeURIComponent(subject)).then(function (d) { A.detail = d; Layout.refresh(); }); }

  function colourFor(legend) {
    var graded = legend.some(function (l) { return l.band && l.band !== 'info'; });
    if (graded) return null;
    var by = {}; legend.slice(0, HUES.length).forEach(function (l, i) { by[l.value] = HUES[i]; }); return by;
  }
  function trunc(t, n) { return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  /* the Levels rings (site > folders > files) were dropped on 2026-09-18: the Files card is the folder tree */
  function legendHtml(legend, cat) {
    if (!legend.length) return '<div class="small dim">nothing carries this lens here</div>';
    var lim = cat ? HUES.length : 12, show = legend.slice(0, lim), rest = legend.length - show.length;
    var what = 'number = files, routes and tables on this map carrying the value';
    return '<div class="maplegend"><span class="lg-what" title="' + esc(what) + ' — click a value to light up everything carrying it">' + esc(what) + '</span>' + show.map(function (l) { var c = cat && cat[l.value]; return '<span class="lg pick ' + (l.band === 'info' ? 'quiet' : l.band) + (A.pickValue === l.value ? ' on' : '') + '" data-value="' + esc(l.value) + '"' + (c ? ' style="--sw:' + c + '"' : '') + ' title="' + esc((l.why || '') + ' — click to light up everything carrying this') + '">' + esc(l.label) + ' <b>' + l.n + '</b></span>'; }).join('')
      + (rest > 0 ? '<span class="lg quiet" style="--sw:' + OTHER + '">everything else <b>' + rest + '</b></span>' : '') + '</div>'
      + (show.some(function (l) { return l.why; }) ? '<div class="lg-explain small dim">' + show.filter(function (l) { return l.why; }).slice(0, 8).map(function (l) { return '<b>' + esc(l.label) + '</b> — ' + esc(String(l.why).replace(/ · doctrine: [a-z0-9-]+$/, '').replace(/^(.{0,120}?)([.;] .*)?$/, '$1')); }).join(' · ') + '</div>' : '');
  }
  function codeHtml(d) {
    var f = window.FILE; if (!d.file || !f || f.path !== d.file) return '';
    if (f.loading) return '<div class="ar-sec">code</div><div class="dim small">reading…</div>';
    if (f.error) return '<div class="ar-sec">code</div><div class="small" style="color:var(--red,#e5484d)">' + esc(f.error) + '</div>';
    if (f.binary) return '<div class="ar-sec">code</div><div class="dim small">binary file</div>';
    var body = f.text.split('\n').map(function (l, i) { return '<span class="ln">' + (i + 1) + '</span>' + esc(l); }).join('\n');
    return '<div class="ar-sec">code <span class="dim">' + esc(f.path) + '</span></div><pre class="fbody ar-code">' + body + '</pre>';
  }
  function railHtml(d, ctx) {
    if (!d) return '<div class="small dim">loading…</div>';
    var edge = function (e, dir) { return '<div class="ar-e"><span class="dim">' + esc(e.kind) + (dir === 'in' ? ' ←' : ' →') + '</span> <a href="#" data-go="' + esc(e.subject) + '">' + esc(e.title || e.subject) + '</a></div>'; };
    return '<div class="ar-hd"><b>' + esc(d.title) + '</b> <span class="dim small">' + esc(d.kind) + (d.file ? ' · ' + esc(d.file) : '') + '</span></div>'
      + (d.tags.length ? '<div class="ar-tags">' + d.tags.map(function (t) { return '<span class="lg ' + (t.band && t.band !== 'info' ? t.band : 'quiet') + '" title="' + esc(t.ns) + '">' + esc(t.label || t.value) + '</span>'; }).join('') + '</div>' : '')
      + (d.out.length ? '<div class="ar-sec">reaches</div>' + d.out.map(function (e) { return edge(e, 'out'); }).join('') : '')
      + (d.in.length ? '<div class="ar-sec">reached by</div>' + d.in.map(function (e) { return edge(e, 'in'); }).join('') : '')
      + (!d.out.length && !d.in.length ? '<div class="small dim" style="margin-top:6px">nothing points here and it points at nothing</div>' : '')
      + (d.file && !/^table:|^folder:|^site:/.test(d.subject) ? (ctx && ctx.page ? '' : '<div style="margin-top:8px"><a href="#" class="small" data-open="' + esc(d.file) + '">open the file</a></div>') : '')
;
  }

  /* ---------- the Flow view: pages → code → data, every edge drawn ----------
     Three columns by what a node IS (kind tags): pages on the left, code (includes, scripts,
     styles, handlers) in the middle, tables on the right. Edges are curves coloured by kind.
     Hover a node: its neighbours and their edges light, the rest fades - the blast radius.
     Nodes are coloured by the current lens like the ring is. Sorted by connections so the
     busiest sit at the top of each column. Capped per column with an honest "+N more". */
  var EDGE = { include: '#8f7fe0', link: '#5aa9c9', form: '#c98ac9', fetch: '#7fb3e0', script: '#7ad0d0', reads: '#38c172', writes: '#e0a63a', import: '#8f7fe0', calls: '#7fb3e0', declares: '#5c6678', defines: '#9b8cf0' };
  var DEFAULT_LAYOUT = { columns: [{ title: 'Pages', match: { kind: ['page'] } }, { title: 'Code', match: { kind: ['include', 'script', 'style', 'file', 'note'] } }, { title: 'Data', match: { nodeKind: ['table'] } }], edges: null };
  function loadFlow() {
    if (A.flowLoading) return; A.flowLoading = true;
    /* The layout is the project's own file (.cockpit\plugins\architecture.layout.json), seeded
       by the scan and editable by the owner or the AI; read with the flow every time so an
       edit shows on the next draw. */
    Promise.all([api(Layout.state.api + '/graph/nodes'), api(Layout.state.api + '/graph/edges'), api(Layout.state.api + '/file?path=.cockpit/plugins/architecture.layout.json'), api(Layout.state.api + '/graph?lens=domain'), A.doctrine ? Promise.resolve(A.doctrine) : api('/api/doctrine').catch(function () { return { rules: [] }; }), api('/plugins/architecture/problems.json').catch(function () { return null; }), api(Layout.state.api + '/file?path=.cockpit/plugins/architecture.problems.json').catch(function () { return null; }), api(Layout.state.api + '/file?path=.cockpit/plugins/architecture.history.json').catch(function () { return null; }), api('/plugins/architecture/stages.json').catch(function () { return null; })]).then(function (r) {
      A.stages = (r[8] && r[8].stages) || []; A.stageGroups = (r[8] && r[8].groups) || [];
      try { A.history = r[7] && r[7].ok && r[7].text ? (JSON.parse(r[7].text).scans || []) : []; } catch (e) { A.history = []; }
      A.problemRisk = (r[5] && r[5].risk) || null;
      var dc = { declared: 0, mapped: 0, inferred: 0, untagged: 0 }; (r[0].nodes || []).forEach(function (n) { if (n.kind !== 'file') return; var v = (n.tags || []).find(function (t) { return t.indexOf('declared:') === 0; }); if (v) dc[v.slice(9).replace('*', '')]++; }); A.declaredCounts = dc;
      A.domainLegend = (r[3] && r[3].legend) || []; A.doctrine = r[4] || { rules: [] };
      var rules = (r[5] && r[5].rules) || {}; try { if (r[6] && r[6].ok && r[6].text) { var o = JSON.parse(r[6].text); Object.keys(o.rules || {}).forEach(function (k) { rules[k] = Object.assign({}, rules[k] || {}, o.rules[k]); }); } } catch (e) { /* an unreadable override changes nothing here */ }
      A.problemRules = {}; Object.keys(rules).forEach(function (k) { A.problemRules[k] = { on: rules[k].on !== false, band: rules[k].band || 'info', weight: rules[k].weight || 2, min: rules[k].min, minWriters: rules[k].minWriters, decl: !!rules[k].decl, stage: rules[k].stage || 'quality' }; });
      var layout = DEFAULT_LAYOUT, layoutError = null;
      if (r[2] && r[2].ok && r[2].text) { try { layout = JSON.parse(r[2].text); if (!layout.columns || !layout.columns.length) throw new Error('no columns'); } catch (e) { layout = DEFAULT_LAYOUT; layoutError = 'architecture.layout.json: ' + e.message; } }
      A.flow = { nodes: (r[0].nodes || []).filter(function (n) { return n.kind === 'file' || n.kind === 'table' || n.kind === 'route' || n.kind === 'flow'; }), edges: r[1].edges || [], layout: layout, layoutError: layoutError, layoutIsFile: !!(r[2] && r[2].ok) };
      /* the whole-project node (site:<name>) is not drawn, but its tags are findings: sast-failed, login-failed, restore-unproven,
         doctrine-review-due, and unchecked:<rule>. The checklist read only the drawn nodes, so every one of those read "checked
         here - nothing found" while it fired (owner's check of the Tests tab, 2026-09-28). */
      A.siteNodes = (r[0].nodes || []).filter(function (n) { return n.kind === 'site' || /^site:/.test(n.subject || ''); });
      A.flowLoading = false; Layout.refresh();
    }).catch(function () { A.flowLoading = false; });
  }
  /* which column a node belongs to: the first whose match it satisfies */
  function columnOf(n, layout, role, kindOf) {
    for (var i = 0; i < layout.columns.length; i++) {
      var m = layout.columns[i].match || {};
      if (m.nodeKind && m.nodeKind.indexOf(n.kind) >= 0) return i;
      if (m.kind && m.kind.indexOf(kindOf(n)) >= 0) return i;
      if (m.role && m.role.indexOf(role) >= 0) return i;
      if (m.tag && m.tag.some(function (t) { return (n.tags || []).some(function (x) { return x.replace('*', '') === t; }); })) return i;
      if (m.folder && m.folder.some(function (f) { return (n.file || '').indexOf(f) === 0; })) return i;
      if (m.any) return i;
    }
    return -1;   // matches no column: not drawn, counted as "unplaced"
  }
  function flowExplain() {
    if (A.view !== 'flow') return '';
    var grain = !A.feature && A.grain !== 'files';
    return '<div class="small dim ar-explain">' + (grain
      ? 'Four columns, the shape every feature keeps: <b>Screens</b> (what a person sees) → <b>Actions</b> (what a screen asks for) → <b>Logic</b> (the code that does it) → <b>Data</b> (the tables). A box is a feature in a column; a curve is every arrow between two features, thick by count. <span style="color:#f0615a">Red, dashed</span> = the shape broken (a screen or a door touching data, data reaching up, a write into another feature\'s table) - each one is a finding on Problems. Hover a box for what it reaches; click it for its files.'
      : 'This feature\'s files in the four columns. Its own things are lit, what they touch is dimmed. <span style="color:#f0615a">Red, dashed</span> = the shape broken. Hover for what a file reaches; click a file for its code; ✕ on the chip goes back up to the features.') + '</div>';
  }
  function flowLegend() {
    var present = {}; ((A.flow && A.flow.edges) || []).forEach(function (e) { present[e.kind] = 1; });
    var kinds = Object.keys(EDGE).filter(function (k) { return present[k]; }).concat(Object.keys(present).filter(function (k) { return !EDGE[k]; }));
    return '<div class="maplegend fl-legend">' + kinds.map(function (k) { return '<span class="lg pick quiet' + (A.pickEdge === k ? ' on' : '') + '" data-edge="' + k + '" style="--sw:' + (EDGE[k] || '#556') + '" title="click to show only these edges">' + esc(k) + '</span>'; }).join('')
      + '<span class="dim small" style="margin-left:8px">click a chip to show only those edges</span>'
      + '<span class="dim small" style="margin-left:8px">· layout: <a href="#" data-open=".cockpit/plugins/architecture.layout.json" title="this project\'s columns and edges - edit the file, the next draw uses it">.cockpit\\plugins\\architecture.layout.json</a>' + (A.flow && A.flow.layoutError ? ' <span style="color:var(--red,#e5484d)">' + esc(A.flow.layoutError) + ' - default used</span>' : '') + '</span></div>';
  }
  /* ---------- the feature level ----------
     A feature = a domain tag (the project's module rules, or the modules\<name>\ folder). The board is computed
     from the same nodes and edges the Flow draws; nothing new is stored. */
  function tagVal(n, ns) { var t = (n.tags || []).filter(function (x) { return x.indexOf(ns + ':') === 0; }); return t.length ? t[t.length - 1].slice(ns.length + 1).replace('*', '') : null; }
  function featureTitle(key) { var l = (A.domainLegend || []).find(function (x) { return x.value === key; }); return l && l.label && l.label !== key ? l.label : key; }
  /* one finding's place on the matrix: likelihood from the check's weight, churn and tests; impact from the impact lens */
  function riskOf(n, value) {
    var rule = (A.problemRules || {})[value] || {}, w = rule.weight || 2, R = A.problemRisk || { critical: 16, high: 9, medium: 4 };
    var I = Number(tagVal(n, 'impact') || 2), ch = tagVal(n, 'churn'), te = tagVal(n, 'tested');
    var L = Math.max(1, Math.min(5, w + (ch === 'busy' || ch === 'hot' ? 1 : 0) + (te === 'no' ? 1 : 0) - (ch === 'still' ? 1 : 0)));
    var sc = L * I; return { L: L, I: I, sc: sc, band: sc >= R.critical ? 'critical' : sc >= R.high ? 'high' : sc >= R.medium ? 'medium' : 'low' };
  }
  /* one figure per feature from the RUNS: flows proven, doors reached by the probe, files a passing test names - each a
     share, averaged over the ones the feature has. What a test run has actually touched, not what could be. */
  function runCoverage(f) {
    var parts = [];
    if (f.flows) parts.push(f.flowsTested / f.flows);
    if (f.doors) parts.push((f.doorsRun || 0) / f.doors);
    if (f.testable) parts.push(f.tested / f.testable);
    return parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length : 0;
  }
  function featureIndex(flow) {
    var by = {}, none = { key: null, title: 'no feature', nodes: [] }, orphanBin = [];
    var get = function (k) { return by[k] || (by[k] = { key: k, title: featureTitle(k), nodes: [], screens: 0, actions: 0, logic: 0, data: 0, files: 0, critical: 0, high: 0, medium: 0, low: 0, findings: 0, breaks: 0, tested: 0, testable: 0, moved: 0, live: false, orphans: 0, decl: {}, flows: 0, flowsTested: 0 }); };
    var domainOf = {}; flow.nodes.forEach(function (n) { var d = tagVal(n, 'domain'); domainOf[n.subject] = d === 'unsorted' ? null : d; });
    var layerOf = {}; flow.nodes.forEach(function (n) { layerOf[n.subject] = tagVal(n, 'layer'); });
    flow.nodes.forEach(function (n) {
      var d = domainOf[n.subject]; var f = d ? get(d) : none; f.nodes.push(n);
      var reach = tagVal(n, 'reach');
      if (!d) { if (reach === 'nothing-points-here') orphanBin.push(n); return; }
      var layer = layerOf[n.subject];
      if (n.kind === 'flow') { /* counted below */ } else if (layer === 'screens') f.screens++; else if (layer === 'actions') f.actions++; else if (layer === 'data') f.data++; else if (layer === 'logic') f.logic++;
      if (n.kind === 'file' && layer !== 'outside') f.files++;
      if (n.kind === 'file') { var dv = tagVal(n, 'declared'); if (dv) f.decl[dv] = (f.decl[dv] || 0) + 1; }
      if (n.kind === 'flow') { f.flows++; if (tagVal(n, 'tested') === 'yes') f.flowsTested++; }
      if (n.kind === 'route') { f.doors = (f.doors || 0) + 1; var pv = tagVal(n, 'probe'), sv = tagVal(n, 'signed-in'); if (pv || sv) f.doorsRun = (f.doorsRun || 0) + 1; if (pv === 'open') f.doorsOpen = (f.doorsOpen || 0) + 1; if ((n.tags || []).some(function (t) { return /^problem:input-(crash|leak|reflected)/.test(t); })) f.doorsHurt = (f.doorsHurt || 0) + 1; }
      (n.tags || []).forEach(function (t) { if (t.indexOf('problem:') === 0) { var r = riskOf(n, t.slice(8).replace('*', '')); f[r.band]++; f.findings++; } });
      if (n.kind === 'file' && (layer === 'actions' || layer === 'logic')) { var te = tagVal(n, 'tested'); if (te) { f.testable++; if (te === 'yes') f.tested++; } }
      var ch = tagVal(n, 'churn'); if (ch && ch !== 'still' && n.kind === 'file' && layer !== 'outside') f.moved++;
      if (reach === 'entry-point' || reach === 'reached' || reach === 'widely-used') f.live = true;
      if (reach === 'nothing-points-here') f.orphans++;
    });
    // shape breaks: the red curves that start in this feature (a screen or a door touching data, data reaching up, a write into another feature's table)
    flow.edges.forEach(function (e) {
      var d = domainOf[e.src]; if (!d || !by[d]) return;
      if (breaksShape(e.kind, layerOf[e.src], layerOf[e.dst], d, domainOf[e.dst])) by[d].breaks++;
    });
    var sortKey = A.featureSort || 'risk';
    var list = Object.values(by).sort(function (x, y) {
      if (sortKey === 'coverage') return (runCoverage(x) - runCoverage(y)) || (y.critical - x.critical);
      if (sortKey === 'breaks') return (y.breaks - x.breaks) || (y.critical - x.critical);
      if (sortKey === 'churn') return ((y.files ? y.moved / y.files : 0) - (x.files ? x.moved / x.files : 0)) || (y.critical - x.critical);
      if (sortKey === 'name') return x.title.localeCompare(y.title);
      return (y.critical - x.critical) || (y.high - x.high) || (y.findings - x.findings);
    });
    return { list: list, none: none, orphanBin: orphanBin };
  }
  function featureNodes(flow, key) {
    var mine = {}; flow.nodes.forEach(function (n) { if ((tagVal(n, 'domain') || (key === 'unsorted' ? 'unsorted' : null)) === key) mine[n.subject] = 1; });
    var near = Object.assign({}, mine); flow.edges.forEach(function (e) { if (mine[e.src]) near[e.dst] = 1; if (mine[e.dst]) near[e.src] = 1; });
    return { nodes: flow.nodes.filter(function (n) { return near[n.subject]; }), edges: flow.edges.filter(function (e) { return near[e.src] && near[e.dst]; }), own: mine };
  }
  function featuresHtml(flow) {
    var ix = featureIndex(flow);
    if (!ix.list.length) return '<div class="ar-empty"><div class="muted">No features yet.</div><div class="small dim" style="margin-top:6px">A feature is a name plus the screens, actions, logic and data that make it. A Node app gets them free from <code>modules\\&lt;name&gt;\\</code> folders; any project can name its areas in <a href="#" data-open=".cockpit/plugins/architecture.typescript.json">.cockpit\\plugins\\architecture.typescript.json</a> (modules: a path pattern per feature). Until then the Flow and Tables views show the whole thing.</div></div>';
    var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
    var card = function (f) {
      var cov = f.testable ? f.tested / f.testable : null, covCls = cov === null ? 'quiet' : cov >= 0.8 ? 'ok' : cov >= 0.5 ? 'warn' : 'bad';
      var churnShare = f.files ? f.moved / f.files : 0;
      return '<div class="ft' + (A.feature === f.key ? ' on' : '') + '" data-feature="' + esc(f.key) + '" title="click: the flow of this feature">'
        + '<div class="ft-hd"><b>' + esc(f.title) + '</b><span class="ft-live ' + (f.live ? 'live' : 'dead') + '" title="' + (f.live ? 'reachable from a screen or action a person can hit' : 'nothing reachable from outside leads into it') + '">' + (f.live ? 'live' : 'orphaned') + '</span></div>'
        + '<div class="ft-counts" title="screens · actions · logic · data">' + f.screens + ' screens · ' + f.actions + ' actions · ' + f.logic + ' logic · ' + f.data + ' data</div>'
        + (function () { var hist = A.history || []; if (hist.length < 2) return ''; var now = (hist[hist.length - 1].features || {})[f.key], was = (hist[hist.length - 2].features || {})[f.key]; if (now === undefined && was === undefined) return ''; var d = (now || 0) - (was || 0); return '<div class="ft-row"><span class="ft-k">trend</span><span class="' + (d > 0 ? 'lg warn' : d < 0 ? 'lg ok' : 'dim small') + '" title="findings in this feature: ' + (was || 0) + ' at the previous scan, ' + (now || 0) + ' now">' + (d > 0 ? '▲ ' + d + ' more' : d < 0 ? '▼ ' + (-d) + ' fewer' : 'unchanged') + ' since last scan</span></div>'; })()
        + '<div class="ft-row"><span class="ft-k">risk</span>' + (f.critical || f.high ? (f.critical ? '<span class="lg rm-critical">' + f.critical + ' critical</span>' : '') + (f.high ? ' <span class="lg rm-high">' + f.high + ' high</span>' : '') : '<span class="lg ok">none critical or high</span>') + (f.medium || f.low ? ' <span class="dim small">' + (f.medium + f.low) + ' lower</span>' : '') + '</div>'
        + '<div class="ft-row"><span class="ft-k">shape</span>' + (f.breaks ? '<span class="lg bad" title="arrows that break the shape: a screen or a door touching data, data reaching up, a write into another feature\'s table">' + f.breaks + ' arrow' + (f.breaks === 1 ? '' : 's') + ' break' + (f.breaks === 1 ? 's' : '') + ' the shape</span>' : '<span class="lg ok">keeps the shape</span>') + '</div>'
        + '<div class="ft-row"><span class="ft-k">tests</span><span class="lg ' + covCls + '" title="tested actions and logic: ' + f.tested + ' of ' + f.testable + '">' + pct(f.tested, f.testable) + ' covered</span>' + (f.testable - f.tested > 0 ? ' <span class="dim small">' + (f.testable - f.tested) + ' untested</span>' : '') + '</div>'
        + '<div class="ft-row"><span class="ft-k">declared</span>' + (function () { var d = f.decl, tot = (d.declared || 0) + (d.mapped || 0) + (d.inferred || 0) + (d.untagged || 0); if (!tot) return '<span class="dim small">—</span>'; return ['declared', 'mapped', 'inferred', 'untagged'].filter(function (k) { return d[k]; }).map(function (k) { return '<span class="lg ' + (k === 'declared' ? 'ok' : k === 'untagged' ? 'warn' : 'quiet') + '" title="' + k + ': ' + d[k] + ' of ' + tot + ' files">' + d[k] + ' ' + k + '</span>'; }).join(' '); })() + '</div>'
        + (f.doors ? '<div class="ft-row"><span class="ft-k">doors</span><span class="lg ' + (f.doorsOpen || f.doorsHurt ? 'bad' : f.doorsRun === f.doors ? 'ok' : f.doorsRun ? 'warn' : 'quiet') + '" title="doors the last test run reached (auth probe, signed-in pass, input probe)">' + (f.doorsRun || 0) + ' of ' + f.doors + ' probed</span>' + (f.doorsOpen ? ' <span class="lg bad" title="answer without a login and are not declared public">' + f.doorsOpen + ' open</span>' : '') + (f.doorsHurt ? ' <span class="lg bad" title="crashed, leaked or reflected on hostile input">' + f.doorsHurt + ' hurt</span>' : '') + '</div>' : '')
        + (f.flows ? '<div class="ft-row"><span class="ft-k">flows</span><span class="lg ' + (f.flowsTested === f.flows ? 'ok' : f.flowsTested ? 'warn' : 'bad') + '" title="flows with a test that names them">' + f.flowsTested + ' of ' + f.flows + ' proven</span></div>' : '')
        + '<div class="ft-row"><span class="ft-k">churn</span><span class="' + (churnShare >= 0.5 ? 'lg warn' : 'dim small') + '" title="files changed in 90 days: ' + f.moved + ' of ' + f.files + '">' + pct(f.moved, f.files) + ' moved</span>' + (f.orphans ? ' <span class="dim small">· ' + f.orphans + ' dead inside</span>' : '') + '</div>'
        + '</div>';
    };
    var sorts = [['risk', 'risk'], ['breaks', 'shape breaks'], ['coverage', 'least proven by runs'], ['churn', 'most churn'], ['name', 'name']];
    var h = '<div class="ft-what small dim">One card per feature - its health: what it is made of, its findings on the risk matrix, the red curves that start in it, how much of its actions and logic a test names, how much of it moved in 90 days. Click a card for its flow. <span style="margin-left:10px">sort by</span> ' + sorts.map(function (x) { return '<span class="lg pick' + ((A.featureSort || 'risk') === x[0] ? ' on' : ' quiet') + '" data-fsort="' + x[0] + '">' + x[1] + '</span>'; }).join('') + '</div>';
    h += '<div class="ft-grid">' + ix.list.map(card).join('') + '</div>';
    if (ix.none.nodes.length) h += '<div class="small dim" style="margin-top:8px">' + ix.none.nodes.length + ' things belong to no feature' + (ix.orphanBin.length ? ' · <b>nothing gets here:</b> ' + ix.orphanBin.slice(0, 12).map(function (n) { return '<a href="#" data-go="' + esc(n.subject) + '">' + esc(n.title) + '</a>'; }).join(', ') + (ix.orphanBin.length > 12 ? ' +' + (ix.orphanBin.length - 12) + ' more' : '') : '') + '</div>';
    return h;
  }
  /* ---------- the tables view: one row per table, who writes it and who reads it, by feature ---------- */
  function tablesHtml(flow) {
    var tables = flow.nodes.filter(function (n) { return n.kind === 'table'; });
    if (!tables.length) return '<div class="ar-empty"><div class="muted">No tables on the map yet.</div><div class="small dim" style="margin-top:6px">Tables come from CREATE TABLE in .sql files and from the SQL / query-builder calls in code.</div></div>';
    var byS = {}; flow.nodes.forEach(function (n) { byS[n.subject] = n; });
    var featOf = function (n) { var d = tagVal(n, 'domain'); return d && d !== 'unsorted' ? d : null; };
    var touch = {}; flow.edges.forEach(function (e) { if (e.kind !== 'reads' && e.kind !== 'writes' && e.kind !== 'defines') return; var n = byS[e.src]; if (!n || tagVal(n, 'layer') === 'outside') return; var t = touch[e.dst] || (touch[e.dst] = { reads: [], writes: [], defines: [] }); t[e.kind].push(n); });
    var q = (A.tableQ || '').toLowerCase(), only = A.tableOnly || '';
    var rows = tables.map(function (t) {
      var x = touch[t.subject] || { reads: [], writes: [], defines: [] }, owner = featOf(t);
      var wf = {}, rf = {}; x.writes.forEach(function (n) { var k = featOf(n) || '—'; wf[k] = (wf[k] || 0) + 1; }); x.reads.forEach(function (n) { var k = featOf(n) || '—'; rf[k] = (rf[k] || 0) + 1; });
      var foreign = Object.keys(wf).filter(function (k) { return k !== (owner || '—'); });
      var tested = x.writes.filter(function (n) { return tagVal(n, 'tested') === 'yes'; }).length;
      return { n: t, x: x, owner: owner, wf: wf, rf: rf, foreign: foreign, tested: tested, sens: tagVal(t, 'sensitivity'), problems: (t.tags || []).filter(function (g) { return g.indexOf('problem:') === 0; }).map(function (g) { return g.slice(8).replace('*', ''); }) };
    }).filter(function (r) { return !q || r.n.title.indexOf(q) >= 0 || (r.owner && featureTitle(r.owner).toLowerCase().indexOf(q) >= 0) || (r.sens || '').indexOf(q) >= 0; })
      .filter(function (r) { return only === 'foreign' ? r.foreign.length : only === 'sensitive' ? !!r.sens : only === 'findings' ? r.problems.length : true; })
      .filter(function (r) { return !A.feature || r.owner === A.feature || r.wf[A.feature] || r.rf[A.feature]; });
    // grouped by owner, the owner with the most tables first; no owner last
    var groups = {}; rows.forEach(function (r) { var k = r.owner || '—'; (groups[k] = groups[k] || []).push(r); });
    var keys = Object.keys(groups).sort(function (x, y) { return (x === '—') - (y === '—') || groups[y].length - groups[x].length; });
    keys.forEach(function (k) { groups[k].sort(function (x, y) { return (y.foreign.length - x.foreign.length) || ((y.sens ? 1 : 0) - (x.sens ? 1 : 0)) || x.n.title.localeCompare(y.n.title); }); });
    var feats = function (m, owner, red) { return Object.keys(m).sort(function (x, y) { return m[y] - m[x]; }).map(function (k) { var isOwner = k === (owner || '—'); return '<span class="tb-f' + (isOwner ? ' own' : red ? ' foreign' : '') + '" title="' + m[k] + ' file' + (m[k] === 1 ? '' : 's') + '">' + esc(k === '—' ? 'no feature' : featureTitle(k)) + ' <span class="dim">' + m[k] + '</span></span>'; }).join(' '); };
    var chip = function (id, label) { return '<span class="lg pick' + (only === id ? ' on' : ' quiet') + '" data-tonly="' + id + '">' + label + '</span>'; };
    var h = '<div class="tb-what small dim">Who owns what data, and where ownership is already broken. Grouped by the feature that owns each table (it defines it or writes it most). <b>written by</b> and <b>read by</b> are features; a writer that is not the owner shows <span class="tb-f foreign">red</span> - one feature owns a table, others ask it through its actions. <b>tests</b> is the write path: how many of the files that write it a test names. Click a table for the files behind it; click a file for its code.</div>';
    h += '<div class="tb-bar"><input id="tb-q" placeholder="find a table, an owner, or a kind of data (money, pii, secrets)…" value="' + esc(A.tableQ || '') + '"><span class="small dim">show</span>' + chip('', 'all') + chip('foreign', 'a foreign writer') + chip('sensitive', 'sensitive') + chip('findings', 'with findings') + '<span class="small dim">' + rows.length + ' of ' + tables.length + ' tables' + (A.feature ? ' touched by ' + esc(featureTitle(A.feature)) : '') + '</span></div>';
    var CAP = 200, shown = 0;
    keys.forEach(function (k) {
      if (shown >= CAP) return;
      var g = groups[k], nForeign = g.filter(function (r) { return r.foreign.length; }).length;
      h += '<div class="tb-grp"><b>' + esc(k === '—' ? 'no owner' : featureTitle(k)) + '</b> <span class="dim small">owns ' + g.length + ' table' + (g.length === 1 ? '' : 's') + (nForeign ? ' · <span class="tb-f foreign">' + nForeign + ' written from outside</span>' : '') + '</span></div>';
      h += '<table class="tb"><thead><tr><th>table</th><th>sensitive</th><th>written by</th><th>read by</th><th>tests</th><th>findings</th></tr></thead><tbody>';
      g.slice(0, CAP - shown).forEach(function (r) {
        var nw = r.x.writes.length;
        h += '<tr class="' + (r.foreign.length ? 'bad' : '') + (A.sel === r.n.subject ? ' on' : '') + '"><td><a href="#" data-go="' + esc(r.n.subject) + '" data-table="' + esc(r.n.subject) + '"><b>' + esc(r.n.title) + '</b></a></td>'
          + '<td>' + (r.sens ? '<span class="lg warn">' + esc(r.sens) + '</span>' : '') + '</td>'
          + '<td>' + (nw ? feats(r.wf, r.owner, true) : '<span class="dim">nothing writes it</span>') + '</td>'
          + '<td>' + (r.x.reads.length ? feats(r.rf, r.owner, false) : '<span class="dim">nothing reads it</span>') + '</td>'
          + '<td>' + (nw ? '<span class="lg ' + (r.tested === nw ? 'ok' : r.tested ? 'warn' : 'bad') + '" title="files that write it and are named by a test">' + r.tested + ' of ' + nw + '</span>' : '<span class="dim">—</span>') + '</td>'
          + '<td>' + r.problems.map(function (p) { return '<span class="lg ' + (A.problemBands && A.problemBands[p] === 'bad' ? 'bad' : 'warn') + '">' + esc(p) + '</span>'; }).join(' ') + '</td></tr>';
        shown++;
      });
      h += '</tbody></table>';
    });
    if (rows.length > CAP) h += '<div class="small dim">+' + (rows.length - CAP) + ' more - search or filter to narrow</div>';
    return h;
  }
  /* ---------- the doctrine checklist: EVERY rule, three states ---------- */
  /* stage groups an embedding page brings (the Tests tab's environment): the same group header, stage block and rows */
  function embedGroupsHtml() {
    return (A.embedGroups || []).map(function (grp) {
      var h = '<div class="dc-group"><b>' + esc(grp.title) + '</b> <span class="small dim">' + esc(grp.what || '') + '</span></div>';
      (grp.stages || []).forEach(function (sg) {
        h += '<div class="dc dc-stage dc-built"><div class="dc-hd' + (sg.acts ? ' dc-hd-acts' : '') + '"><b>' + esc(sg.title) + '</b> <span class="lg ' + esc(sg.pill[0]) + '">' + esc(sg.pill[1]) + '</span> <span class="small dim">' + esc(sg.what || '') + '</span>' + (sg.acts ? '<span class="dc-acts">' + sg.acts + '</span>' : '') + '</div>';   // sg.acts: the stage's own buttons (the Tests tab's Run tests / Run DAST), right of the header
        (sg.rows || []).forEach(function (r) { h += '<div class="dc-row ' + esc(r.cls) + '" title="' + esc(r.title || '') + '"><span class="dc-dot"></span><span class="dc-name">' + esc(r.name) + '</span><span class="dc-rule small">' + esc(r.rule || '') + '</span><span class="dc-right small">' + (r.right || '') + '</span></div>'; });
        h += '</div>';
      });
      return h;
    }).join('');
  }
  function doctrineChecklist(flow) {
    var rules = (A.doctrine && A.doctrine.rules) || []; if (!rules.length) return '';
    var counts = {}, ticketed = {}, notRun = {}; (flow ? flow.nodes : []).concat(A.siteNodes || []).forEach(function (n) { var inTk = (n.tags || []).some(function (t) { return t.indexOf('ticket:') === 0; }); (n.tags || []).forEach(function (t) { if (t.indexOf('problem:') === 0) { var v = t.slice(8).replace('*', ''); counts[v] = (counts[v] || 0) + 1; if (inTk) ticketed[v] = (ticketed[v] || 0) + 1; } else if (t.indexOf('unchecked:') === 0) notRun[t.slice(10).replace('*', '')] = 1; }); });   // unchecked:<rule> - its tool did not run this scan (plugins/architecture/scan.js): grey, never "nothing found"
    // values problems.json ties to a rule (the legend's "doctrine:" suffix) join the doctrine's own Check line
    var byRule = {}; (A.problemLegend || []).forEach(function (l) { var m = /doctrine: ([a-z0-9-]+)/.exec(l.why || ''); if (m) (byRule[m[1]] = byRule[m[1]] || []).push(l.value); });
    var rows = rules.map(function (r) {
      var vals = (r.check.kind === 'map' ? r.check.values : (r.check.partly || [])).concat(byRule[r.id] || []).filter(function (v, i, a) { return a.indexOf(v) === i; });
      var n = vals.reduce(function (t, v) { return t + (counts[v] || 0); }, 0);
      var state = vals.length ? (n ? 'found' : 'clean') : 'judged';
      var known = vals.filter(function (v) { return A.problemRules && A.problemRules[v] && A.problemRules[v].on; });
      if (vals.length && !known.length && A.problemRules) state = 'off';   // its values are not rules on this project (missing, or switched off in the override)
      return { r: r, vals: vals, n: n, state: state };
    });
    var order = { found: 0, clean: 1, off: 2, judged: 3 }; rows.sort(function (a, b) { return order[a.state] - order[b.state] || b.n - a.n; });
    var found = rows.filter(function (x) { return x.state === 'found'; }).length, clean = rows.filter(function (x) { return x.state === 'clean'; }).length, judged = rows.filter(function (x) { return x.state === 'judged'; }).length;
    var checks = Object.keys(A.problemRules || {}).map(function (v) { var l = (A.problemLegend || []).find(function (x) { return x.value === v; }) || {}; return { v: v, on: A.problemRules[v].on, band: A.problemRules[v].band, stage: A.problemRules[v].stage, n: counts[v] || 0, tk: ticketed[v] || 0, label: l.label || v, why: l.why || '' }; })
      .filter(function (c) { return !A.backlogOnly || !c.n || c.tk < c.n; })
      .sort(function (a, b) { return (b.on - a.on) || (b.n - a.n); });
    var checkRow = function (c) { if (c.on && !c.n && notRun[c.v]) return '<div class="dc-row quiet" title="' + esc(c.why) + '"><span class="dc-dot"></span><span class="dc-name">' + esc(c.v) + '</span><span class="dc-rule small">' + esc(c.why.split(' - ')[0].split(' · ')[0]) + '</span><span class="dc-right small"><span class="lg quiet" title="its tool did not run in the last scan - see sast-failed or the scan log">not checked</span></span></div>';
      /* a finding's colour is its band (unbounded-query is info - grey - but showed amber here, because
         anything not 'bad' was drawn as a warning) */
      return '<div class="dc-row ' + (!c.on ? 'quiet' : c.n ? (c.band === 'bad' ? 'bad' : c.band === 'warn' ? 'warnish' : 'infoish') : 'ok') + '" title="' + esc(c.why) + '"><span class="dc-dot"></span><span class="dc-name">' + esc(c.v) + '</span><span class="dc-rule small">' + esc(c.why.split(' - ')[0].split(' · ')[0]) + '</span><span class="dc-right small">' + (!c.on ? 'off on this project' : c.n ? '<span class="lg pick ' + (c.band === 'bad' ? 'bad' : c.band === 'warn' ? 'warn' : 'quiet') + (A.finding === c.v ? ' on' : '') + '" data-finding="' + esc(c.v) + '" title="open this finding: what it means, the risk matrix, features touched">' + esc(c.label) + ' ' + c.n + '</span>' + (c.tk ? ' <span class="small dim" title="findings already in a ticket">' + (c.tk === c.n ? 'all' : c.tk) + ' in tickets</span>' : '') : 'checked here — nothing found') + '</span></div>'; };
    var doctrineRows = rows.map(function (x) {
      var r = x.r, cls = x.state === 'found' ? 'bad' : x.state === 'clean' ? 'ok' : x.state === 'off' ? 'quiet' : 'judge';
      var right = x.state === 'found' ? '<b>' + x.n + '</b> finding' + (x.n === 1 ? '' : 's') + ': ' + x.vals.filter(function (v) { return counts[v]; }).map(function (v) { return '<span class="lg pick bad' + (A.finding === v ? ' on' : '') + '" data-finding="' + esc(v) + '">' + esc(v) + ' ' + counts[v] + '</span>'; }).join('')
        : x.state === 'clean' ? 'checked here — nothing found (' + x.vals.map(esc).join(', ') + ')' : x.state === 'off' ? 'its check (' + x.vals.map(esc).join(', ') + ') is not a rule on this project' : 'judged elsewhere — ' + esc(r.check.where);
      return '<div class="dc-row ' + cls + (x.state === 'found' ? '' : ' dc-quiet') + '" title="' + esc(r.ruleFull) + '"><span class="dc-dot"></span><span class="dc-name">' + esc(r.id) + (r.status !== 'active' ? ' <span class="dim small">' + esc(r.status) + '</span>' : '') + '</span><span class="dc-rule small">' + esc(r.rule) + '</span><span class="dc-right small">' + right + '</span></div>';
    }).join('');
    var flows = flow ? flow.nodes.filter(function (n) { return n.kind === 'flow'; }) : [], proven = flows.filter(function (n) { return tagVal(n, 'tested') === 'yes'; }).length;
    var st = A.declaredCounts || null;
    var STATUS = { built: ['ok', 'built'], partial: ['warn', 'partial'], planned: ['quiet', 'planned - Phase 3'], later: ['quiet', 'later'] };
    var AT = { local: 'in the AI\'s turn', verify: 'after the turn', promote: 'before it promotes', post: 'after promote', functional: 'end to end', process: 'the doctrine' };
    var h = A.embed ? '' : '<div class="small dim" style="padding:0 2px 8px">One section per test stage - where it runs, what it tests, how, and how far along it is. The checks with counts are what runs today; a planned stage says what it will hold. Review these for maturity. <a href="/plugins/architecture/stages.json" target="_blank">the stages ↗</a> · <a href="/plugins/architecture/problems.json" target="_blank">the rules ↗</a> · <a href="/prompts/doctrine.md" target="_blank">the doctrine ↗</a></div>';
    var groups = (A.stageGroups && A.stageGroups.length) ? A.stageGroups : [{ id: 'local', title: 'Static' }, { id: 'verify', title: 'Verify' }, { id: 'promote', title: 'Promote' }, { id: 'post', title: 'Post' }, { id: 'functional', title: 'Functional' }, { id: 'process', title: 'Process' }];
    if (A.embedGroups) h += embedGroupsHtml();
    groups.forEach(function (grp) {
      var inGroup = (A.stages || []).filter(function (sg) { return (sg.runsAt || 'local') === grp.id; }); if (!inGroup.length) return;
      var built = inGroup.filter(function (sg) { return sg.status === 'built'; }).length, partial = inGroup.filter(function (sg) { return sg.status === 'partial'; }).length;
      h += '<div class="dc-group"><b>' + esc(grp.title) + '</b> <span class="small dim">' + esc(grp.what || '') + ' · ' + inGroup.length + ' stage' + (inGroup.length === 1 ? '' : 's') + ': ' + built + ' built, ' + partial + ' partial, ' + (inGroup.length - built - partial) + ' to build</span></div>';
    inGroup.forEach(function (sg) {
      var mine = checks.filter(function (c) { return c.stage === sg.id; });
      var withN = mine.filter(function (c) { return c.on && c.n; }).length, sc = STATUS[sg.status] || STATUS.planned;
      var extra = '';
      if (sg.id === 'flow' || sg.id === 'e2e') {
        /* one line per flow: the feature and
           the flow, then where it stands - clicked through and green, its browser test red, only page-calling tests, or no test */
        var proves = {}; ((flow && flow.edges) || []).forEach(function (e) { if (e.kind === 'proves') (proves[e.dst] = proves[e.dst] || []).push(e.src); });
        var isBrowser = function (s) { return /\.browser\.(test|spec)\.[cm]?js$/i.test(s); };
        var clicked = 0;
        var flowRows = flows.slice().sort(function (a, b) { return (tagVal(a, 'domain') + '/' + a.title).localeCompare(tagVal(b, 'domain') + '/' + b.title); }).map(function (n) {
          var probs = (n.tags || []).filter(function (t) { return t.indexOf('problem:') === 0; }).map(function (t) { return t.slice(8).replace('*', ''); });
          var tests = proves[n.subject] || [], browser = tests.filter(isBrowser), failing = probs.indexOf('flow-failing') >= 0;
          var cls, word;
          if (!tests.length) { cls = 'bad'; word = 'no test'; }
          else if (failing) { cls = 'bad'; word = browser.length ? 'browser test red' : 'test red'; }
          else if (!browser.length) { cls = 'warnish'; word = 'not clicked through - ' + tests.length + ' page-calling test' + (tests.length === 1 ? '' : 's') + ', no browser flow'; }
          else { cls = 'ok'; word = 'clicked through, green'; clicked++; }
          return '<div class="dc-row ' + cls + (cls === 'ok' ? ' dc-quiet' : '') + '" title="' + esc(n.subject) + (tests.length ? ' - proved by ' + tests.map(function (s) { return s.replace(/^file:/, ''); }).join(', ') : '') + '"><span class="dc-dot"></span><span class="dc-name">' + esc(tagVal(n, 'domain') || '') + ' / ' + esc(n.title) + '</span><span class="dc-rule small">' + esc(word) + '</span><span class="dc-right small">' + (browser.length ? esc(browser[0].replace(/^file:/, '').replace(/^test\//, '')) : '—') + '</span></div>';
        }).join('');
        extra = '<div class="dc-row dc-quiet ' + (flows.length ? (clicked === flows.length ? 'ok' : 'warnish') : 'quiet') + '"><span class="dc-dot"></span><span class="dc-name">flows declared</span><span class="dc-rule small">' + (flows.length ? flows.length + ' flows across the features · ' + proven + ' named by a test · ' + clicked + ' clicked through in a browser' : 'none yet - a feature\'s README (or the mapping file) lists them') + '</span><span class="dc-right small">' + (flows.length ? clicked + ' of ' + flows.length : '—') + '</span></div>' + flowRows;
      }
      if (sg.id === 'architecture' && st) extra = '<div class="dc-row dc-quiet ok"><span class="dc-dot"></span><span class="dc-name">tags</span><span class="dc-rule small">where the files\' tags come from</span><span class="dc-right small">' + st.declared + ' in the file · ' + st.mapped + ' mapped · ' + st.inferred + ' guessed · ' + st.untagged + ' untagged</span></div>';
      if (sg.id === 'doctrine') extra = doctrineRows;
      if (sg.id === 'dast') {
        var d = A.dast || {};   // /api/p/:id/tests/dast, loaded with the view
        var last = d.latest ? (d.latest.ok ? 'last run ' + whenLocal(d.latest.at) + ' · ZAP ' + d.latest.zap + ' · ' + Object.keys(d.latest.summary || {}).map(function (k) { return d.latest.summary[k] + ' ' + k.toLowerCase(); }).join(', ') + (d.latest.active && d.latest.active.partial ? ' · stopped at ' + d.latest.active.status + '% (time budget)' : '') : 'last run ' + whenLocal(d.latest.at) + ' did not finish: ' + (d.latest.why || '')) : 'never run on this project';
        extra += '<div class="dc-row dc-quiet ' + (d.latest ? (d.latest.ok ? 'ok' : 'warnish') : 'quiet') + '"><span class="dc-dot"></span><span class="dc-name">run</span><span class="dc-rule small">' + esc(last) + '</span><span class="dc-right small">'
          + (d.running ? 'running…' : d.zapReady || d.archives ? '<span class="btn ghost sm" id="dast-run" title="ZAP against the app on the TEST database - minutes">Run DAST</span>' : '<span class="dim" title="node tools\\fetch.js --unpack on the engine\'s machine, or the download on the Plugins page">ZAP not in the engine folder</span>') + '</span></div>';
      }
      h += '<div class="dc dc-stage dc-' + sg.status + '"><div class="dc-hd"><b>' + esc(sg.title) + '</b> <span class="lg ' + sc[0] + '">' + sc[1] + '</span> <span class="small dim">' + esc(AT[sg.runsAt] || sg.runsAt) + ' · ' + esc(sg.what) + (mine.length ? ' · ' + mine.filter(function (c) { return c.on; }).length + ' checks, <b>' + withN + '</b> with findings' : '') + (sg.id === 'doctrine' ? ' · ' + rules.length + ' rules: <b>' + found + '</b> with findings, ' + clean + ' clean, ' + judged + ' judged' : '') + '</span></div>'
        + '<div class="small dim dc-how">' + esc(sg.how) + '</div>'
        + mine.map(checkRow).join('') + extra
        + (sg.tests || []).map(function (t) { return '<div class="dc-row dc-quiet todo"><span class="dc-dot"></span><span class="dc-name dim">' + (t.status === 'later' ? 'later' : 'to build') + '</span><span class="dc-rule small">' + esc(t.what) + '</span><span class="dc-right small dim">—</span></div>'; }).join('')
        + '</div>';
    });
    });
    var slop = h.split('data-value="').join('data-finding="');
    return slop;
  }
  /* ---------- one finding, as work ---------- */
  function findingPanel(flow, value) {
    var rule = (A.problemRules || {})[value] || {}, leg = (A.problemLegend || []).find(function (l) { return l.value === value; }) || {};
    var label = leg.label || value, why = (leg.why || '').replace(/ · doctrine: [a-z0-9-]+$/, ''), doc = /doctrine: ([a-z0-9-]+)/.exec(leg.why || '');
    var docRule = doc && (A.doctrine.rules || []).find(function (r) { return r.id === doc[1]; });
    var hits = flow.nodes.filter(function (n) { return (n.tags || []).some(function (t) { return t.replace('*', '') === 'problem:' + value; }); });
    var kinds = {}; hits.forEach(function (n) { var k = n.kind === 'table' ? 'table' : n.kind === 'route' ? 'route' : 'file'; kinds[k] = (kinds[k] || 0) + 1; });
    var what = Object.keys(kinds).map(function (k) { return kinds[k] + ' ' + k + (kinds[k] === 1 ? '' : 's'); }).join(', ');
    var meaning = {
      'duplicate-function': 'each of these files defines a function whose name is also defined in another file - copy-paste twins that will drift apart; the number is files, not function names',
      'god-file': 'each of these files reaches an outsized share of the code and data; a change to it can break anything',
      'no-single-writer': 'each of these tables is written from ' + (rule.minWriters || 4) + '+ files; nobody owns its shape',
      'dead-route': 'each of these routes is called by nothing in this code - an external client, a mobile app, or dead; the scan cannot tell which',
      'nothing-points-here': 'each of these files is reached by nothing in this code - an entry point, a scheduled script, or dead'
    }[value] || (why + (rule.min > 1 ? ' - counted where a file has ' + rule.min + ' or more' : ''));
    /* the matrix: likelihood = the check's weight, +1 churned 3+ times in 90 days, +1 untested, -1 unchanged; impact = the impact lens */
    var R = A.problemRisk || { critical: 16, high: 9, medium: 4 }, w = rule.weight || 2;
    var bandOf = function (sc) { return sc >= R.critical ? 'critical' : sc >= R.high ? 'high' : sc >= R.medium ? 'medium' : 'low'; };
    var grid = {}, bands = { critical: 0, high: 0, medium: 0, low: 0 }, bites = { live: 0, sensitive: 0, god: 0, unguarded: 0, writes: 0 }, byF = {}, scored = [];
    hits.forEach(function (n) {
      var I = Number(tagVal(n, 'impact') || 2), ch = tagVal(n, 'churn'), te = tagVal(n, 'tested');
      var L = w + (ch === 'busy' || ch === 'hot' ? 1 : 0) + (te === 'no' ? 1 : 0) - (ch === 'still' ? 1 : 0); L = Math.max(1, Math.min(5, L));
      var sc = L * I, bd = bandOf(sc); bands[bd]++; grid[L + ':' + I] = (grid[L + ':' + I] || 0) + 1; scored.push({ n: n, L: L, I: I, sc: sc, band: bd, cell: L + ':' + I, churn: ch, tested: te });
      var reach = tagVal(n, 'reach'); if (n.kind === 'table' || reach === 'entry-point' || reach === 'reached' || reach === 'widely-used') bites.live++;
      if ((n.tags || []).some(function (t) { return t.indexOf('sensitivity:') === 0 && t !== 'sensitivity:audit'; })) bites.sensitive++;
      if ((n.tags || []).some(function (t) { return t.replace('*', '') === 'problem:god-file'; })) bites.god++;
      if (tagVal(n, 'rbac') === 'no-permission-check') bites.unguarded++;
      if (I >= 4) bites.writes++;
      var d = tagVal(n, 'domain'); if (d === 'unsorted') d = null; var f = byF[d || '—'] || (byF[d || '—'] = { key: d, n: 0, sum: 0, critical: 0, high: 0, medium: 0, low: 0 }); f.n++; f.sum += sc; f[bd]++;
    });
    var worst = bands.critical ? 'critical' : bands.high ? 'high' : bands.medium ? 'medium' : 'low';
    var feats = Object.keys(byF).sort(function (x, y) { return byF[y].sum - byF[x].sum; });
    // the trend: this count against the previous scan's
    var hist = (A.history || []), prev = hist.length > 1 ? (hist[hist.length - 2].counts || {})[value] || 0 : null, cur = hits.length;
    var trend = prev === null ? 'first scan with a history - the trend starts next scan' : cur === prev ? 'unchanged since the last scan (' + prev + ')' : (cur > prev ? '▲ up ' + (cur - prev) : '▼ down ' + (prev - cur)) + ' since the last scan (' + prev + ')';
    var cell = function (L, I) { var n = grid[L + ':' + I] || 0, bd = bandOf(L * I); return '<td class="rm-' + bd + (n ? ' has' : '') + (A.cell === L + ':' + I ? ' on' : '') + '"' + (n ? ' data-cell="' + L + ':' + I + '"' : '') + ' title="likelihood ' + L + ' × impact ' + I + ' = ' + (L * I) + ' → ' + bd + (n ? ': ' + n : '') + '">' + (n || '') + '</td>'; };
    var matrix = '<table class="rm"><tr><th></th>' + [1, 2, 3, 4, 5].map(function (I) { return '<th>' + I + '</th>'; }).join('') + '</tr>' + [5, 4, 3, 2, 1].map(function (L) { return '<tr><th>' + L + '</th>' + [1, 2, 3, 4, 5].map(function (I) { return cell(L, I); }).join('') + '</tr>'; }).join('') + '</table><div class="small dim">rows: likelihood (weight ' + w + ' ± churn, tests) · columns: impact</div>';
    /* the scope: what is picked (a cell, a band, a feature's bubble) or the whole finding */
    var scope = (function () {
      if (!A.cell) return null;
      var m = /^band:(.+)$/.exec(A.cell), fm = /^feat:([^:]*):(all|critical|high|medium|low)$/.exec(A.cell);
      var list = scored.filter(function (x) { if (fm) { var d = tagVal(x.n, 'domain'); if (d === 'unsorted') d = null; return (d || '') === fm[1] && (fm[2] === 'all' || x.band === fm[2]); } return m ? x.band === m[1] : x.cell === A.cell; }).sort(function (x, y) { return y.sc - x.sc; });
      var title = fm ? (fm[1] ? featureTitle(fm[1]) : 'no feature') + (fm[2] === 'all' ? ' (all bands)' : ' · ' + fm[2]) : m ? m[1] + ' band' : 'cell likelihood ' + A.cell.split(':')[0] + ' × impact ' + A.cell.split(':')[1];
      var b2 = { critical: 0, high: 0, medium: 0, low: 0 }; list.forEach(function (x) { b2[x.band]++; });
      return { title: title, list: list, bands: b2 };
    })();
    var scopeLines = scope ? '\nScope: ' + scope.title + ' - ' + scope.list.length + ' of the ' + hits.length + ' (' + scope.bands.critical + ' critical, ' + scope.bands.high + ' high, ' + scope.bands.medium + ' medium, ' + scope.bands.low + ' low):\n'
      + scope.list.slice(0, 30).map(function (x) { var d = tagVal(x.n, 'domain'); return '  - ' + (x.n.file || x.n.subject.replace(/^[a-z]+:/, '')) + '  [' + x.band + ' ' + x.L + '×' + x.I + (d && d !== 'unsorted' ? ', ' + featureTitle(d) : '') + (x.churn === 'hot' || x.churn === 'busy' ? ', ' + x.churn : '') + (x.tested === 'no' ? ', untested' : '') + ']'; }).join('\n')
      + (scope.list.length > 30 ? '\n  ... +' + (scope.list.length - 30) + ' more (cli: nodes, then problem:' + value + ')' : '')
      : '';
    var brief = 'Problem: ' + label + ' (' + value + ') - ' + what + '.\n' + meaning + '.'
      + (docRule ? '\nDoctrine rule: ' + docRule.id + ' - ' + docRule.rule : '')
      + '\nRisk: ' + worst + ' at worst - ' + bands.critical + ' critical, ' + bands.high + ' high, ' + bands.medium + ' medium, ' + bands.low + ' low (likelihood from the check weight ' + w + ', churn and tests; impact from reach, exposure, sensitive data, writes, guards).'
      + '\nWhere it bites: ' + bites.live + ' on live paths, ' + bites.sensitive + ' touching money / personal data / credentials, ' + bites.god + ' in god files, ' + bites.unguarded + ' unguarded routes.'
      + '\nTrend: ' + trend + '.'
      + scopeLines
      + '\nFeatures by risk: ' + feats.slice(0, 8).map(function (f) { var x = byF[f]; return (x.key ? featureTitle(x.key) : 'no feature') + ' (' + x.n + ', ' + x.critical + ' critical, ' + x.high + ' high)'; }).join('; ') + '.'
      + '\n\n' + (scope ? 'Work within the scope above - those ' + scope.list.length + ' things, not the whole finding. ' : '') + 'Challenge and refine this with the code in front of you (the cli lists every finding: nodes, then problem:' + value + '): is the impact really this, what would the first step look like here, what did the numbers miss. Do not write code.';
    var h = '<div class="fd"><div class="fd-hd"><b>' + esc(label) + '</b> <span class="lg rm-' + worst + '">' + worst + ' at worst</span> <span class="small dim">' + esc(value) + ' · ' + esc(what) + '</span><span style="flex:1"></span><span class="fd-note" title="the card, what you pick on it (a band, a cell, a bubble, a file) and the filter ride with your next chat message - ask about it directly">✓ this card is in the chat - just ask</span><span class="tkx" data-finding-close="1" title="close">✕</span></div>'
      + '<div class="fd-what">' + esc(meaning) + '</div>'
      + (docRule ? '<div class="small dim fd-doc">doctrine: <b>' + esc(docRule.id) + '</b> — ' + esc(docRule.rule) + '</div>' : '')
      + '<div class="fd-cols3">'
      + '<div><div class="ar-sec">risk <span class="dim">click a band or a cell for its files</span></div><div class="fd-bands">' + ['critical', 'high', 'medium', 'low'].map(function (bd) { return '<span class="lg rm-' + bd + (bands[bd] ? ' pick' : ' quiet') + (A.cell === 'band:' + bd ? ' on' : '') + '"' + (bands[bd] ? ' data-cell="band:' + bd + '"' : '') + '>' + bd + ' <b>' + bands[bd] + '</b></span>'; }).join('') + '</div>'
      + '<div class="ar-sec" style="margin-top:8px">where it bites</div><div class="fd-bites small">' + bites.live + ' of ' + hits.length + ' on live paths<br>' + bites.sensitive + ' touch money, personal data or credentials<br>' + bites.god + ' in god files<br>' + bites.unguarded + ' on unguarded routes</div>'
      + '<div class="ar-sec" style="margin-top:8px">trend</div><div class="small">' + esc(trend) + '</div></div>'
      + '<div><div class="ar-sec">the matrix <span class="dim">likelihood × impact, count per cell</span></div>' + matrix + '</div>'
      + '<div><div class="ar-sec">features by risk</div>' + feats.slice(0, 12).map(function (f) { var x = byF[f]; return '<div class="fd-feat"><a href="#" data-finding-feature="' + esc(x.key || '') + '"><b>' + esc(x.key ? featureTitle(x.key) : 'no feature') + '</b></a> <span class="lg pick quiet' + (A.cell === 'feat:' + (x.key || '') + ':all' ? ' on' : '') + '" data-cell="feat:' + esc(x.key || '') + ':all" title="all of this feature\'s findings">' + x.n + '</span>' + ['critical', 'high', 'medium', 'low'].filter(function (bd) { return x[bd]; }).map(function (bd) { return ' <span class="lg rm-' + bd + ' pick' + (A.cell === 'feat:' + (x.key || '') + ':' + bd ? ' on' : '') + '"' + (x[bd] ? ' data-cell="feat:' + esc(x.key || '') + ':' + bd + '"' : '') + ' title="this feature\'s ' + bd + ' findings">' + x[bd] + '</span>'; }).join('') + '</div>'; }).join('') + (feats.length > 12 ? '<div class="small dim">+' + (feats.length - 12) + ' more</div>' : '') + '</div>'
      + '<div class="fd-cell">' + (function () {
        if (!A.cell) return '<div class="ar-sec">in the cell</div><div class="small dim">click a cell of the matrix, or a band, and its things list here - each opens its code and what touches it</div>';
        var m = /^band:(.+)$/.exec(A.cell), fm = /^feat:([^:]*):(all|critical|high|medium|low)$/.exec(A.cell);
        var inCell = scored.filter(function (x) { if (fm) { var d = tagVal(x.n, 'domain'); if (d === 'unsorted') d = null; return (d || '') === fm[1] && (fm[2] === 'all' || x.band === fm[2]); } return m ? x.band === m[1] : x.cell === A.cell; }).sort(function (x, y) { return y.sc - x.sc || x.n.title.localeCompare(y.n.title); });
        var title = fm ? (fm[1] ? featureTitle(fm[1]) : 'no feature') + (fm[2] === 'all' ? '' : ' · ' + fm[2]) : m ? m[1] : 'likelihood ' + A.cell.split(':')[0] + ' × impact ' + A.cell.split(':')[1];
        return '<span class="fd-cell-close" data-cell="" title="close this list">✕</span><div class="ar-sec">' + esc(title) + ' <span class="dim">' + inCell.length + '</span></div>'
          + inCell.slice(0, 40).map(function (x) { var d = tagVal(x.n, 'domain'), tk = (x.n.tags || []).filter(function (t) { return t.indexOf('ticket:') === 0; }).map(function (t) { return t.slice(7).replace('*', ''); }); return '<div class="fd-ex' + (A.sel === x.n.subject ? ' on' : '') + '"><a href="#" data-go="' + esc(x.n.subject) + '" title="' + esc(x.n.file || x.n.subject) + '">' + esc(x.n.title) + '</a> ' + (tk.length ? '<span class="lg ok sm" title="in a ticket">' + esc(tk.join(' ')) + '</span> ' : '') + '<span class="dim small">' + esc(d && d !== 'unsorted' ? featureTitle(d) : '') + ' · ' + x.L + '×' + x.I + (x.churn === 'hot' || x.churn === 'busy' ? ' · ' + x.churn : '') + (x.tested === 'no' ? ' · untested' : '') + '</span> <a href="#" class="small dim fd-fine" data-fine="' + esc(x.n.subject) + '" data-fine-rule="' + esc(value) + '" title="checked, it is not a problem here - asks why, keeps the reason, and the next scan stops raising it for this one">it\'s fine</a></div>'; }).join('')
          + (inCell.length > 40 ? '<div class="small dim">+' + (inCell.length - 40) + ' more - the AI lists them with the cli</div>' : '');
      })() + '</div>'
      + '</div>'
      + '<div class="fd-acts"><span class="btn" data-finding-ticket="1" title="asks the AI in the chat to draft a ticket for this scope (the card is already its context); the draft waits for your approval on the Tickets card">Create ticket</span> <span class="btn ghost" data-finding-chat="1" title="the card\'s answers land in the conversation box for the AI to challenge with the code in front of it">Discuss in chat</span> <span class="btn ghost" data-finding-map="1" title="the Flow view, with these lit up">Show on the map</span> <span class="small dim" style="margin-left:6px">carries: ' + (scope ? esc(scope.title) + ' - ' + scope.list.length + ' things, listed with path and L×I' : 'the whole finding (' + hits.length + '); pick a cell, a band or a feature bubble to narrow it') + '</span></div></div>';
    var inTickets = {}; hits.forEach(function (n) { (n.tags || []).forEach(function (t) { if (t.indexOf('ticket:') === 0) { var k = t.slice(7).replace('*', ''); inTickets[k] = (inTickets[k] || 0) + 1; } }); });
    if (Object.keys(inTickets).length) h = h.replace('<div class="fd-acts">', '<div class="fd-tickets small">in ticket ' + Object.keys(inTickets).map(function (k) { return '<a href="#" data-ticket-open="' + esc(k) + '"><b>' + esc(k) + '</b></a> (' + inTickets[k] + ' of ' + hits.length + ')'; }).join(', ') + ' · the rest is the backlog</div><div class="fd-acts">');
    A.findingBrief = brief;
    A.findingTicket = 'Ticket draft - ' + label + ' (' + value + ')' + (scope ? ' - scope: ' + scope.title + ', ' + scope.list.length + ' things' : '') + ': ' + what + ', ' + worst + ' at worst (' + bands.critical + ' critical, ' + bands.high + ' high). ' + meaning + '.' + (scope ? scopeLines : '') + '\n Features by risk: ' + feats.slice(0, 5).map(function (f) { return byF[f].key ? featureTitle(byF[f].key) : 'no feature'; }).join(', ') + '. Draft the ticket: title, why it matters (from the risk above), the first step and what it reads back, done-when (this count falls on the next scan). Do not write code.';
    return h;
  }
  /* the detail card as the chat's context: the brief (finding, risk, trend, the picked scope and its files), the file
     selected from the list, the tag filter when it is on. Cleared when the card closes or the view changes. */
  function publishScreen(findingOpen) {
    if (!window.Screen) return;
    if (!findingOpen || /^env:/.test(A.finding || '')) { window.Screen.set(null); return; }
    var brief = (A.findingBrief || '').replace(/\n\n(Work within the scope above[^]*|Challenge and refine[^]*)$/, '');
    var leg = (A.problemLegend || []).find(function (l) { return l.value === A.finding; }) || {};
    var label = 'Problems · ' + (leg.label || A.finding);
    var m = /^Scope: ([^\n]+?) - /m.exec(brief); if (m) label += ' · ' + m[1];
    var lines = ['Cockpit screen: the Problems tab, detail card "' + (leg.label || A.finding) + '"' + (A.cell ? ', with ' + (m ? m[1] : A.cell) + ' picked (its files are listed under Scope)' : ' (nothing picked yet: the whole finding)') + '.'];
    if (A.sel) { var sn = (A.flow.nodes || []).find(function (n) { return n.subject === A.sel; }); if (sn) { lines.push('Selected file: ' + (sn.file || sn.subject) + ' - "this file" means it.'); label += ' · ' + (sn.title || sn.file); } }
    if (A.tagsOn && A.tf) { var f = A.tf, parts = []; ['feature', 'kind', 'flow', 'source'].forEach(function (k) { if (f[k] && f[k].length) parts.push('@' + k + ' = ' + f[k].join(', ')); }); if (f.q) parts.push('search "' + f.q + '"'); if (parts.length) lines.push('Tag filter on: ' + parts.join('; ') + '.'); }
    /* (the form that used to sit here was removed: tickets come out of the conversation - the AI drafts, the owner approves on the Tickets card) */
    window.Screen.set({ label: label, text: lines.join('\n') + '\n\n' + brief });
  }
  /* the standing backlog: what every scan leaves for people, with the move since the last scan (Phase 5) */
  function backlogStrip() {
    var hist = A.history || []; if (!hist.length) return '';
    var cur = hist[hist.length - 1].backlog, prev = hist.length > 1 ? hist[hist.length - 2].backlog : null; if (!cur) return '';
    var ROWS = [['findings', 'findings'], ['unticketedFindings', 'not in a ticket'], ['untagged', 'files untagged'], ['tagsWithoutReadme', 'features without a README'], ['flowsWithoutTest', 'flows without a test'], ['flowsFailing', 'flows failing']];
    var cell = function (k, label) { var n = cur[k] || 0, d = prev && prev[k] !== undefined ? n - prev[k] : null; return '<span class="bl-c"><b class="' + (n ? (k === 'flowsFailing' ? 'bad' : '') : 'ok') + '">' + n + '</b> ' + label + (d === null ? '' : d === 0 ? ' <span class="dim">=</span>' : d > 0 ? ' <span class="warn">▲' + d + '</span>' : ' <span class="ok">▼' + (-d) + '</span>') + '</span>'; };
    var at = whenLocal(hist[hist.length - 1].at), pat = prev ? whenLocal(hist[hist.length - 2].at) : null;
    return '<div class="bl"><div class="ar-sec">the backlog <span class="dim">what this scan (' + esc(at) + ') leaves for people' + (pat ? ' · arrows against the scan before (' + esc(pat) + ')' : ' · the trend starts next scan') + '</span></div><div class="bl-row">' + ROWS.map(function (r) { return cell(r[0], r[1]); }).join('') + '</div></div>';
  }
  /* the tickets strip at the top of Problems: what is open, where it is, the next move */
  function ticketsStrip() {
    if (A.tickets === undefined || A.tickets === null) { if (!A.ticketsLoading) { A.ticketsLoading = true; fetch(Layout.state.api + '/tickets').then(function (r) { return r.json(); }).then(function (r) { A.tickets = r.ok ? r.tickets : []; A.ticketsGithub = !!r.github; A.ticketsLoading = false; Layout.refresh(); }); } return ''; }
    var open = A.tickets.filter(function (t) { return t.state !== 'closed' && t.state !== 'rejected' && t.state !== 'draft'; });
    var drafts = A.tickets.filter(function (t) { return t.state === 'draft'; });
    if (drafts.length && !open.length) return '<div class="tks small">' + drafts.length + ' draft ticket' + (drafts.length === 1 ? '' : 's') + ' waiting for your approval on the <b>Tickets</b> card</div>';
    if (!open.length) return '';
    var NEXT = { created: null, 'in-work': null, verified: ['passed', 'passed - a person checked it on the step before prod'], passed: ['promoted', 'promoted - the owner promoted it'], promoted: null };
    return '<div class="tks"><div class="ar-sec">tickets <span class="dim">' + open.length + ' open' + (A.ticketsGithub ? ' · on GitHub' : ' · local (GitHub plugin off)') + '</span></div>'
      + '<div class="small dim" style="margin:2px 0 6px"><a href="#" data-backlog="1">' + (A.backlogOnly ? 'show everything' : 'backlog only - hide checks whose findings are all in tickets') + '</a></div>'
      + open.slice(0, 12).map(function (t) { var nx = NEXT[t.state]; return '<div class="tks-row"><b>' + esc(t.number ? '#' + t.number : t.id) + '</b> ' + (t.url ? '<a href="' + esc(t.url) + '" target="_blank">' + esc(t.title) + '</a>' : esc(t.title)) + ' <span class="lg rm-' + esc(t.band || 'low') + '">' + esc(t.band || '') + '</span> <span class="lg ' + (t.state === 'verified' || t.state === 'passed' || t.state === 'promoted' ? 'ok' : 'quiet') + '">' + esc(t.state) + '</span>' + (t.verdicts ? ' <span class="small dim">' + t.verdicts + ' verdict' + (t.verdicts === 1 ? '' : 's') + '</span>' : '') + (nx ? ' <span class="btn ghost sm" data-tk-state="' + esc(t.id) + '" data-to="' + nx[0] + '" title="' + esc(nx[1]) + '">mark ' + nx[0] + '</span>' : '') + (t.state === 'created' ? ' <span class="small dim">waiting for work to name it</span>' : t.state === 'in-work' ? ' <span class="small dim">the rescan verifies it when the turn ends</span>' : '') + '</div>'; }).join('')
      + '</div>';
  }
  function dropText(el, text) {
    var ta = el.querySelector('.arpage-conv #cv-in') || document.querySelector('#cv-in'); if (!ta) return;
    ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + '\n' : '') + text + '\n';
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
  }
  /* one box per (feature, column); one curve per (feature, feature, kind), weighted */
  /* the shape: Screens -> Actions -> Logic -> Data, arrows one way. A hop that skips a column or runs backwards, or a
     write into another feature's table, is a break - and draws red. Structure (imports, script tags) is not judged here. */
  function breaksShape(kind, ls, ld, fs2, fd) {
    if (kind === 'reads' || kind === 'writes') { if (ls === 'screens') return 'a screen touches data'; if (ls === 'actions') return 'SQL in the door'; if (kind === 'writes' && fs2 && fd && fs2 !== fd) return 'writes another feature\'s table'; return null; }
    if (ls === 'data' && ld && ld !== 'data' && kind !== 'defines') return 'data reaches up';
    if (kind === 'calls' && ls === 'data') return 'data reaches up';
    return null;
  }
  /* FAMILIES. The scan tags each node with its
     family and level (shared service < module < dashboard). A line pointing up, a module reading another module's tables, or a
     module calling one it does not declare draws red; a line down into a service, the dashboard reading a module, and a declared
     module-to-module line do not. Mirrors scan.js's family rules; a project with no families file has no level tags, so no change. */
  var LEVEL_RANK = { service: 0, module: 1, dashboard: 2 };
  function hasTag(n, t) { return !!(n && (n.tags || []).some(function (x) { return x.replace('*', '') === t; })); }
  function familyBreak(kind, sn, dn) {
    if (!sn || !dn || !/^(import|calls|fetch|reads|writes)$/.test(kind)) return null;
    var la = tagVal(sn, 'level'), lb = tagVal(dn, 'level'); if (!la || !lb) return null;
    var da = tagVal(sn, 'domain'), db2 = tagVal(dn, 'domain'); if (!da || !db2 || da === db2) return null;
    if (LEVEL_RANK[la] < LEVEL_RANK[lb]) return 'points up: a ' + la + ' depends on a ' + lb;
    if (la === 'service' || lb !== 'module' || kind === 'writes') return null;   // down into a service is fine; a write is breaksShape's
    if (kind === 'reads') return 'reads another module\'s tables';
    if (la === 'dashboard') return null;
    return hasTag(sn, 'problem:undeclared-module-dependency') ? 'undeclared module dependency' : null;
  }
  function featureGrain(flow, layout, kindOf, roleOf) {
    var BAND_RANK = { bad: 3, warn: 2, ok: 1, info: 0, quiet: 0 };
    var isFoundation = function (key) { var l = (A.domainLegend || []).find(function (x) { return x.value === key; }); return !!(l && /foundation/i.test(l.why || '')); };
    var boxOf = {}, boxes = {}, real = {};
    flow.nodes.forEach(function (n) {
      var ci = columnOf(n, layout, roleOf(n), kindOf); if (ci < 0) return;
      var d = tagVal(n, 'domain'); if (d === 'unsorted') d = null; var key = d || '—';
      var id = 'feat:' + key + ':' + ci; boxOf[n.subject] = id; real[n.subject] = n;
      var b = boxes[id] || (boxes[id] = { subject: id, kind: 'feature', key: d, ci: ci, title: '', file: null, n: 0, members: [], vals: {}, foundation: d ? isFoundation(d) : false, family: tagVal(n, 'family') });
      b.n++; b.members.push(n.subject);
      var lv = (n.tags || []).filter(function (x) { return x.indexOf((A.lens || '') + ':') === 0; }); if (lv.length) { var v = lv[lv.length - 1].slice((A.lens || '').length + 1).replace('*', ''); b.vals[v] = (b.vals[v] || 0) + 1; }
    });
    var legendBand = {}; ((A.g && A.g.legend) || []).forEach(function (l) { legendBand[l.value] = l.band; });
    var nodes = Object.values(boxes).map(function (b) {
      // colour: the worst band inside for a graded lens, the commonest value otherwise
      var withVal = Object.values(b.vals).reduce(function (t, n) { return t + n; }, 0), without = b.n - withVal;
      var pick = null, best = A.g && A.g.graded ? -1 : without;   // a slicing lens: 'no reading' competes; a graded one: the worst band wins whatever the count
      Object.keys(b.vals).forEach(function (v) { var r = A.g && A.g.graded ? (BAND_RANK[legendBand[v] || 'info'] || 0) * 100000 + b.vals[v] : b.vals[v]; if (r > best) { best = r; pick = v; } });
      b.title = (b.key ? featureTitle(b.key) : 'no feature') + ' · ' + b.n;
      b.tags = ['layer:' + (layout.columns[b.ci].match.tag || [''])[0].replace('layer:', '')].concat(pick ? [(A.lens || '') + ':' + pick] : []);
      var dist = Object.keys(b.vals).sort(function (x, y) { return b.vals[y] - b.vals[x]; }).map(function (v) { return v + ' ' + b.vals[v]; }).join(' · ') + (without ? (Object.keys(b.vals).length ? ' · ' : '') + without + ' without a reading' : '');
      b.tip = b.title + (b.family ? ' — family: ' + b.family : '') + (dist ? ' — ' + dist : '') + (A.lens === 'tested' && b.vals.no ? ' — ' + b.vals.no + ' untested: the gap' : '') + ' — click for its files';
      return b;
    });
    var agg = {};
    flow.edges.forEach(function (e) {
      // structure, not data flow, is left out at feature grain - except the one import that IS the story: a door handing off to logic
      // ... and an import that crosses families the wrong way: that line IS the red flag, so it is never hidden (2026-10-05)
      if (e.kind === 'import') { var rs = real[e.src], rd = real[e.dst]; if (!(rs && rd && tagVal(rs, 'layer') === 'actions' && tagVal(rd, 'layer') === 'logic') && !familyBreak(e.kind, rs, rd)) return; }
      else if (e.kind === 'declares' || e.kind === 'script' || e.kind === 'link') return;
      var a = boxOf[e.src], b = boxOf[e.dst]; if (!a || !b || a === b) return;
      var k = a + '>' + b + '>' + e.kind; var x = agg[k] || (agg[k] = { src: a, dst: b, kind: e.kind, w: 0, cross: false });
      x.w++; var br = breaksShape(e.kind, tagVal(real[e.src], 'layer'), tagVal(real[e.dst], 'layer'), boxes[a].key, boxes[b].key) || familyBreak(e.kind, real[e.src], real[e.dst]); if (br) { x.cross = true; x.why = br; }
    });
    return { nodes: nodes, edges: Object.values(agg) };
  }
  /* ---------- the Tags lens: a filter over the graph by its tags ---------- */
  var TF_KIND = { screens: 'screen', actions: 'action', logic: 'logic', data: 'data', outside: 'test / tool' };
  function tagFilterActive() { var f = A.tf; return !!((f.family || []).length || f.feature.length || f.kind.length || f.flow.length || f.source.length || f.q); }
  function tagFilterNode(n) {
    var f = A.tf;
    if ((f.family || []).length && f.family.indexOf(tagVal(n, 'family') || '—') < 0) return false;
    if (f.feature.length) { var d = tagVal(n, 'domain'); if (d === 'unsorted') d = null; if (f.feature.indexOf(d || '—') < 0) return false; }
    if (f.kind.length) { var l = n.kind === 'table' ? 'data' : n.kind === 'route' ? 'actions' : tagVal(n, 'layer'); if (f.kind.indexOf(TF_KIND[l] || l) < 0) return false; }
    if (f.flow.length) { var fl = (n.tags || []).filter(function (t) { return t.indexOf('flow:') === 0; }).map(function (t) { return t.slice(5).replace('*', ''); }); if (!fl.some(function (x) { return f.flow.indexOf(x) >= 0; })) return false; }
    if (f.source.length) { var sv = n.kind === 'file' ? (tagVal(n, 'declared') || 'untagged') : null; if (sv && f.source.indexOf(sv) < 0) return false; }
    if (f.q) { var q = f.q.toLowerCase(); if (((n.purpose || '') + ' ' + n.title + ' ' + (n.file || '')).toLowerCase().indexOf(q) < 0) return false; }
    return true;
  }
  function applyTagFilter(flow) {
    if (!tagFilterActive()) return flow;
    var keep = {}; flow.nodes.forEach(function (n) { if (tagFilterNode(n)) keep[n.subject] = 1; });
    // what the kept things touch one hop out stays, dimmed, so the slice keeps its context
    var near = Object.assign({}, keep); flow.edges.forEach(function (e) { if (keep[e.src]) near[e.dst] = 1; if (keep[e.dst]) near[e.src] = 1; });
    return Object.assign({}, flow, { nodes: flow.nodes.filter(function (n) { return near[n.subject]; }), edges: flow.edges.filter(function (e) { return near[e.src] && near[e.dst]; }), own: keep });
  }
  function tagFilterHtml(flow) {
    var vals = { family: {}, feature: {}, kind: {}, flow: {}, source: {} };
    flow.nodes.forEach(function (n) {
      var fam = tagVal(n, 'family'); if (fam) vals.family[fam] = (vals.family[fam] || 0) + 1;
      var d = tagVal(n, 'domain'); if (d === 'unsorted') d = null; vals.feature[d || '—'] = (vals.feature[d || '—'] || 0) + 1;
      var l = n.kind === 'table' ? 'data' : n.kind === 'route' ? 'actions' : tagVal(n, 'layer'); if (l) { var k = TF_KIND[l] || l; vals.kind[k] = (vals.kind[k] || 0) + 1; }
      (n.tags || []).forEach(function (t) { if (t.indexOf('flow:') === 0) { var v = t.slice(5).replace('*', ''); vals.flow[v] = (vals.flow[v] || 0) + 1; } });
      if (n.kind === 'file') { var sv = tagVal(n, 'declared') || 'untagged'; vals.source[sv] = (vals.source[sv] || 0) + 1; }
    });
    var chips = function (ns, label, order) {
      var keys = Object.keys(vals[ns]); if (order) keys.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); }); else keys.sort(function (a, b) { return vals[ns][b] - vals[ns][a] || a.localeCompare(b); });
      if (!keys.length) return '<div class="tf-row"><span class="tf-k">' + label + '</span><span class="dim small">none yet</span></div>';
      return '<div class="tf-row"><span class="tf-k">' + label + '</span>' + keys.slice(0, 40).map(function (k) { return '<span class="lg pick' + (A.tf[ns].indexOf(k) >= 0 ? ' on' : ' quiet') + '" data-tf="' + ns + '" data-tfv="' + esc(k) + '">' + esc(ns === 'feature' && k !== '—' ? featureTitle(k) : k === '—' ? 'no feature' : ns === 'source' ? ({ declared: 'in the file', mapped: 'in the mapping file', inferred: 'guessed', untagged: 'untagged' })[k] || k : k) + ' <b>' + vals[ns][k] + '</b></span>'; }).join('') + (keys.length > 40 ? '<span class="dim small">+' + (keys.length - 40) + ' more</span>' : '') + '</div>';
    };
    return '<div class="tf"><div class="small dim tf-what">Filter the graph by its tags - the columns stay the four kinds; only the slice shows, with what it touches dimmed one hop out. Boxes are coloured by where their tags come from, so the accuracy of the slice is visible: <span class="lg ok">in the file</span> <span class="lg quiet">in the mapping file</span> <span class="lg quiet">guessed</span> <span class="lg warn">untagged</span>. Pick several in a row for OR; rows combine with AND.' + (tagFilterActive() ? ' <span class="lg pick on" data-tf-clear="1">clear ✕</span>' : '') + '</div>'
      + (Object.keys(vals.family).length ? chips('family', 'family') : '') + chips('feature', '@feature') + chips('kind', '@kind', ['screen', 'action', 'logic', 'data', 'test / tool']) + chips('flow', '@flow') + '<div class="tf-row"><span class="tf-k">@purpose</span><input id="tf-q" placeholder="a word in the purpose, the name or the path…" value="' + esc(A.tf.q) + '"></div>' + chips('source', 'tags from', ['declared', 'mapped', 'inferred', 'untagged']) + '</div>';
  }
  function drawFlow(flow, cat) {
    if (A.tagsOn) { var tfd = applyTagFilter(flow); flow = tfd; }
    var own = null; if (A.feature) { var sub = featureNodes(flow, A.feature); flow = Object.assign({}, flow, { nodes: sub.nodes, edges: sub.edges }); own = sub.own; }
    var kindOf = function (n) { var t = (n.tags || []).find(function (x) { return x.indexOf('kind:') === 0; }); return t ? t.slice(5).replace('*', '') : 'file'; };
    var lensVal = function (n) { var t = (n.tags || []).filter(function (x) { return x.indexOf((A.lens || '') + ':') === 0; }); return t.length ? t[t.length - 1].slice((A.lens || '').length + 1).replace('*', '') : null; };
    var layout = flow.layout || DEFAULT_LAYOUT;
    var wantEdges = layout.edges && layout.edges.length ? layout.edges : null;
    var edgesUsed = wantEdges ? flow.edges.filter(function (e) { return wantEdges.indexOf(e.kind) >= 0; }) : flow.edges;
    var outs = {}, ins = {}; edgesUsed.forEach(function (e) { outs[e.src] = (outs[e.src] || 0) + 1; ins[e.dst] = (ins[e.dst] || 0) + 1; });
    var deg = {}; flow.nodes.forEach(function (n) { deg[n.subject] = (outs[n.subject] || 0) + (ins[n.subject] || 0); });
    var roleOf = function (n) { var o = outs[n.subject] || 0, i = ins[n.subject] || 0; return o && i ? 'hub' : o ? 'source' : i ? 'sink' : 'isolated'; };
    if (A.tagsOn && flow.own && !own) own = flow.own;
    var grainFeatures = !A.feature && A.grain !== 'files' && !(A.tagsOn && tagFilterActive() && flow.nodes.length <= 400) && flow.nodes.some(function (n) { var d = tagVal(n, 'domain'); return d && d !== 'unsorted'; });
    if (grainFeatures) {
      var fg = featureGrain(flow, layout, kindOf, roleOf);
      flow = Object.assign({}, flow, { nodes: fg.nodes, edges: fg.edges }); edgesUsed = wantEdges ? fg.edges.filter(function (e) { return wantEdges.indexOf(e.kind) >= 0; }) : fg.edges;
      outs = {}; ins = {}; edgesUsed.forEach(function (e) { outs[e.src] = (outs[e.src] || 0) + e.w; ins[e.dst] = (ins[e.dst] || 0) + e.w; });
      deg = {}; flow.nodes.forEach(function (n) { deg[n.subject] = (outs[n.subject] || 0) + (ins[n.subject] || 0); });
    }
    var cols = layout.columns.map(function () { return []; }), unplaced = 0;
    flow.nodes.forEach(function (n) { var ci = columnOf(n, layout, roleOf(n), kindOf); if (ci < 0) unplaced++; else cols[ci].push(n); });
    var CAP = 60;
    // feature boxes sit together by family, then the busiest first
    cols.forEach(function (c) { c.sort(function (a, b) { return (grainFeatures ? ((a.key === null) - (b.key === null)) || String(a.family || '~').localeCompare(String(b.family || '~')) || ((a.foundation ? 1 : 0) - (b.foundation ? 1 : 0)) : 0) || (deg[b.subject] || 0) - (deg[a.subject] || 0); }); });
    var NC = layout.columns.length, rowH = grainFeatures ? 30 : 22, pad = 30, colW = 300, W = colW * NC + pad * 2;
    var rows = Math.max.apply(null, cols.map(function (c) { return c.length; }).concat([1])); rows = Math.min(rows, CAP + 1);
    var H = rows * rowH + pad * 2 + 30;
    var pos = {};
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="mapsvg flowsvg">';
    if (unplaced) s += '<text x="' + (W - pad) + '" y="' + (pad - 6) + '" text-anchor="end" class="dim">' + unplaced + ' not in any column</text>';
    layout.columns.forEach(function (c, ci) {
      var x = pad + ci * colW + 20, list = cols[ci];
      s += '<text x="' + x + '" y="' + (pad - 6) + '" class="fl-head">' + esc(c.title || ('Column ' + (ci + 1))) + ' <tspan class="dim">' + list.length + '</tspan>' + (c.help ? '<title>' + esc(c.help) + '</title>' : '') + '</text>';
      list.slice(0, CAP).forEach(function (n, i) {
        var y = pad + 14 + i * rowH + (grainFeatures ? 4 : 0); pos[n.subject] = { x: x, y: y, right: x + 240 };
        var lv = lensVal(n), band = A.g.graded ? ((A.g.legend.find(function (l) { return l.value === lv; }) || {}).band || 'quiet') : null;
        var col = cat ? (cat[lv] || OTHER) : (BAND[band] || BAND.quiet);
        s += '<g class="fn' + (own ? (own[n.subject] ? ' own' : ' near') : '') + (n.kind === 'feature' ? ' feat' + (n.foundation ? ' found' : '') : '') + '" data-subject="' + esc(n.subject) + '" data-feature-key="' + esc(n.kind === 'feature' ? (n.key || '') : '') + '" data-lv="' + esc(lv || '') + '" data-lvs="' + esc(n.kind === 'feature' ? '|' + Object.keys(n.vals || {}).join('|') + '|' : '') + '" data-file="' + esc(n.kind === 'file' && n.file ? n.file : '') + '"><title>' + esc(n.tip || (n.title + (lv ? ' — ' + lv : '') + (n.purpose ? ' — ' + n.purpose : '') + (n.kind === 'file' ? ' — click to open the code' : ''))) + '</title>'
          + '<rect x="' + (x - 6) + '" y="' + (y - 13) + '" width="252" height="' + (rowH - 2) + '" rx="' + (grainFeatures ? 8 : 5) + '" style="fill:' + col + (grainFeatures ? '33' : '22') + ';stroke:' + col + ';stroke-width:' + (grainFeatures ? 1.6 : 1) + '"></rect>'
          + '<text x="' + x + '" y="' + (y + (grainFeatures ? 5 : 2)) + '"' + (grainFeatures ? ' style="font-size:13px;font-weight:600"' : '') + '>' + esc(trunc(n.title, 34)) + '</text>'
          + (deg[n.subject] ? '<text x="' + (x + 238) + '" y="' + (y + 2) + '" text-anchor="end" class="dim">' + deg[n.subject] + '</text>' : '') + '</g>';
      });
      if (list.length > CAP) s += '<text x="' + x + '" y="' + (pad + 14 + CAP * rowH + 2) + '" class="dim">+' + (list.length - CAP) + ' more (quietest)</text>';
    });
    // edges: a curve from the right edge of src to the left edge of dst; left-to-right when
    // possible, a loop when both are in the same column
    var lines = '', byS2 = {}; flow.nodes.forEach(function (n) { byS2[n.subject] = n; });
    edgesUsed.forEach(function (e) {
      var a = pos[e.src], b = pos[e.dst]; if (!a || !b) return;
      var x1 = a.right, y1 = a.y - 2, x2 = b.x - 8, y2 = b.y - 2;
      var mx = (x1 + x2) / 2;
      if (b.x <= a.x) {   // same column or backwards: an arc out to the left, so it reads as a link, not a line through the text
        x1 = a.x - 8; x2 = b.x - 8; mx = Math.min(x1, x2) - 24 - Math.min(60, Math.abs(y2 - y1) / 6);
      }
      if (e.cross === undefined && byS2[e.src] && byS2[e.dst]) { var d1 = tagVal(byS2[e.src], 'domain'), d2 = tagVal(byS2[e.dst], 'domain'); var br2 = breaksShape(e.kind, tagVal(byS2[e.src], 'layer'), tagVal(byS2[e.dst], 'layer'), d1 === 'unsorted' ? null : d1, d2 === 'unsorted' ? null : d2) || familyBreak(e.kind, byS2[e.src], byS2[e.dst]); if (br2) { e.cross = true; e.why = br2; } }
      var sw = e.w ? Math.min(7, 1 + Math.log2(e.w)) : 1;
      lines += '<path class="fe' + (e.cross ? ' cross' : '') + '" data-src="' + esc(e.src) + '" data-dst="' + esc(e.dst) + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" style="stroke:' + (e.cross ? '#f0615a' : (EDGE[e.kind] || '#556')) + (e.w ? ';stroke-width:' + sw.toFixed(1) : '') + '"><title>' + esc(e.kind + (e.w ? ' × ' + e.w : '') + (e.cross ? ' — ' + (e.why || 'breaks the shape') : '')) + '</title></path>';
    });
    return s.replace('class="mapsvg flowsvg">', 'class="mapsvg flowsvg">' + lines) + '</svg>';
  }
  function wireFlow(el) {
    /* Legend chips are pickable in both views: a lens value lights every node carrying it;
       an edge kind (flow only) shows only those edges. Hover overrides
       while the pointer is on a node; the pick comes back when it leaves. */
    el.querySelectorAll('.lg[data-value]').forEach(function (c) { c.addEventListener('click', function () { A.pickValue = A.pickValue === c.dataset.value ? null : c.dataset.value; Layout.refresh(); }); });
    el.querySelectorAll('.lg[data-edge]').forEach(function (c) { c.addEventListener('click', function () { A.pickEdge = A.pickEdge === c.dataset.edge ? null : c.dataset.edge; Layout.refresh(); }); });
    // the ring / row / grid: light the picked value
    var svg = el.querySelector('.flowsvg'); if (!svg) return;
    var nodes = svg.querySelectorAll('.fn'), edges = svg.querySelectorAll('.fe');
    /* indexed once: on a map the size of a large monorepo's, a DOM query per edge per hover stalls the page */
    var nodeBy = {}; nodes.forEach(function (o) { nodeBy[o.dataset.subject] = o; });
    var edgesOf = {}; edges.forEach(function (e) { e.kindName = e.querySelector('title').textContent; (edgesOf[e.dataset.src] = edgesOf[e.dataset.src] || []).push(e); if (e.dataset.dst !== e.dataset.src) (edgesOf[e.dataset.dst] = edgesOf[e.dataset.dst] || []).push(e); });
    function applyPick() {
      /* the resting state: a picked value lights its carriers; else, in one feature's flow, the feature's own things are lit and what they touch is dim - and it STAYS that way */
      var carriesOwn = function (o) { return o.dataset.lv === A.pickValue || (o.dataset.lvs && o.dataset.lvs.indexOf('|' + A.pickValue + '|') >= 0); };
      /* a permission's light spreads one hop along the arrows: the screens that call its routes, the logic and data behind them
         */
      var spread = {}; if (A.pickValue && A.lens === 'permission') { nodes.forEach(function (o) { if (carriesOwn(o)) { spread[o.dataset.subject] = 1; (edgesOf[o.dataset.subject] || []).forEach(function (e) { spread[e.dataset.src] = 1; spread[e.dataset.dst] = 1; }); } }); }
      var carries = function (o) { return carriesOwn(o) || !!spread[o.dataset.subject]; };
      nodes.forEach(function (o) { var has = A.pickValue ? carries(o) : A.feature ? o.classList.contains('own') : null; o.classList.toggle('dim2', has === false); o.classList.toggle('lit', has === true); });
      edges.forEach(function (e) {
        var kindOk = !A.pickEdge || e.kindName === A.pickEdge;
        var touches = !A.pickValue || [e.dataset.src, e.dataset.dst].some(function (s) { var n = nodeBy[s]; return n && carries(n); });
        e.classList.toggle('off', !(kindOk && touches)); e.classList.toggle('lit', !!(A.pickValue || A.pickEdge) && kindOk && touches);
      });
    }
    applyPick();
    nodes.forEach(function (n) {
      var dwell = null;
      n.addEventListener('mouseenter', function () { clearTimeout(dwell); dwell = setTimeout(function () {
        var me = n.dataset.subject, near = {}; near[me] = 1;
        var mine = {}; (edgesOf[me] || []).forEach(function (e) { if (!A.pickEdge || e.kindName === A.pickEdge) { mine[e.dataset.src + '>' + e.dataset.dst] = 1; near[e.dataset.src] = 1; near[e.dataset.dst] = 1; } });
        edges.forEach(function (e) { var on = !!mine[e.dataset.src + '>' + e.dataset.dst]; e.classList.toggle('lit', on); e.classList.toggle('dim2', !on); });
        nodes.forEach(function (o) { o.classList.toggle('dim2', !near[o.dataset.subject]); o.classList.toggle('lit', !!near[o.dataset.subject]); });
      }, 350); });
      n.addEventListener('mouseleave', function () { clearTimeout(dwell); edges.forEach(function (e) { e.classList.remove('lit', 'dim2'); }); nodes.forEach(function (o) { o.classList.remove('lit', 'dim2'); }); applyPick(); });
      // a file in the flow opens its code in the File card as well as the rail
      n.addEventListener('click', function () { if (n.dataset.subject.indexOf('feat:') === 0) { A.feature = n.dataset.featureKey || null; A.grain = 'files'; A.pickValue = null; if (!A.feature) A.noFeatureOnly = true; Layout.refresh(); return; } select(n.dataset.subject); if (n.dataset.file && window.openFile) window.openFile(n.dataset.file); });
    });
  }

  /* One renderer, two homes: the card in the room, and the PAGE (a tab of its own, with the
     conversation beside the map, so something can be dragged from the map into the AI window). ctx.page: the
     rescan button rides the toolbar instead of the card header. */
  function renderMap(el, ctx) {
      A.onPage = !!ctx.page;
      /* embedded as Problems (the Tests tab): the doctrine view, fixed; on the Architecture tab itself that view is
         gone - a saved choice lands on the map */
      A.embed = ctx.embed || null; A.embedTop = ctx.top || ''; A.embedWire = ctx.wire || null; A.embedGroups = ctx.groups || null; A.embedPanel = ctx.panel || null;   // the embedding page: its header, its own stage groups (drawn first), the card for its bubbles, its handlers
      if (A.embed === 'problems') A.view = 'doctrine'; else if (A.view === 'doctrine') A.view = 'flow';
      var r = window.ROOM;
      if (!r || r.missing) { el.innerHTML = '<div class="muted small">no project open</div>'; return; }
      if (A.project !== r.id) { A.project = r.id; A.lens = null; A.parent = null; A.g = null; A.sel = null; A.detail = null; A.settings = false; load(); }
      var pl = window.PluginUI && window.PluginUI.info('architecture');
      // a scan finished since the map was read: read it again
      var scanStamp = ((pl && pl.lastScan) || {}).finished || '';
      if (A.scanStamp !== scanStamp) { A.scanStamp = scanStamp; A.flow = null; if (A.g) { A.g = null; load(); } }
      /* Setup lives on the Plugins page; the card keeps ↻ - rescan now. */
      var hd = ctx.card && el.parentElement && el.parentElement.querySelector('.ch .more');
      if (hd) {
        hd.innerHTML = '<span class="tkx" title="rescan" data-h="rescan">↻</span>';
        var rb = hd.querySelector('[data-h="rescan"]'); if (rb) rb.onclick = function () { A.scanning = true; Layout.refresh(); window.PluginUI.scan('architecture', function () { A.scanning = false; A.g = null; load(); }); };
      }
      /* EMBEDDED (the Tests tab) WITHOUT A MAP: Architecture off, not set up, scanning, or nothing mapped yet - the
         Tests tab is still whole (its Environment checks, its runs, its detail card); only Problems wait
         (2026-09-20: with Architecture off the tab was a bare heading) */
      // the map is the engine's (2026-09-20): Problems wait only on the map itself, never on the Architecture switch
      if (A.embed === 'problems' && (A.scanning || !A.g || !A.g.ok)) {
        var why = A.scanning ? 'reading the code…' : A.loading ? 'reading the map…' : 'the map has not been read yet - ↻ reads it now';
        var eo = A.finding && A.finding.indexOf('env:') === 0 && A.embedPanel;
        el.innerHTML = '<div class="ar">' + (eo ? A.embedPanel(A.finding.slice(4)) : '') + (A.embedTop || '') + embedGroupsHtml() + '<div class="small dim" style="margin:10px 0">' + why + '</div></div>';
        if (A.embedWire) { try { A.embedWire(el); } catch (e) { console.error('embed wire: ' + e.message); } }
        el.querySelectorAll('[data-finding]').forEach(function (b) { b.addEventListener('click', function () { A.finding = A.finding === b.dataset.finding ? null : b.dataset.finding; Layout.refresh(); }); });
        var fc0 = el.querySelector('[data-finding-close]'); if (fc0) fc0.addEventListener('click', function () { A.finding = null; Layout.refresh(); });
        return;
      }
      // the map is the engine's (2026-09-20): it is drawn whenever it exists; the wizard's answers only refine the scan
      if (A.scanning) { el.innerHTML = '<div class="ar-empty"><div class="muted">scanning…</div></div>'; return; }
      if (!A.g) { el.innerHTML = '<div class="muted small">' + (A.loading ? 'reading the map…' : 'no map yet') + '</div>'; return; }
      if (!A.g.ok) { el.innerHTML = '<div class="ar-empty"><div class="muted">' + esc(A.g.note) + '</div><div class="small dim" style="margin-top:6px">' + (pl && pl.lastScan ? 'The last scan found nothing to map.' : 'The AI is putting the map together for the first time - follow it in the Conversation card. Or press ↻ to scan without it.') + '</div></div>'; return; }
      var cat = colourFor(A.g.legend);
      var h = '<div class="ar">';
      var mapView = A.view === 'flow';
      if (A.view === 'levels') A.view = 'flow';   // Levels is gone (2026-09-18); a saved choice lands on Flow
      var extViews = Object.keys(window.ArchViews).filter(function (k) { var v = window.ArchViews[k]; return !v.on || v.on(); });   // a plugin's view is only in the bar while that plugin is on here
      if (window.ArchViews[A.view] && extViews.indexOf(A.view) < 0) A.view = 'flow';
      if (A.view === 'doctrine' && A.lens !== 'problem') { A.lens = 'problem'; A.flow = null; A.pickValue = null; load(); }
      if (!A.embed) h += '<div class="ar-top"><div class="ar-lenses">'
        + (A.embed ? '' : '<button class="lensbtn' + (A.view === 'features' ? ' on' : '') + '" data-view="features" title="one card per feature: what it is made of, live or orphaned, what the doctrine finds">Features</button>')
        + (A.embed ? '' : '<button class="lensbtn' + (A.view === 'tables' ? ' on' : '') + '" data-view="tables" title="one row per table: who writes it, who reads it">Tables</button><button class="lensbtn' + (A.view === 'flow' ? ' on' : '') + '" data-view="flow" title="pages → API → code → data, with every edge drawn">Flow</button>')
        + (A.embed ? '' : extViews.map(function (k) { var v = window.ArchViews[k]; return '<button class="lensbtn' + (A.view === k ? ' on' : '') + '" data-view="' + esc(k) + '" title="' + esc(v.hint || '') + '">' + esc(v.title || k) + '</button>'; }).join(''))
        + (A.feature ? '<span class="ar-sep"></span><span class="lg pick on ft-chip" data-feature="" title="showing one feature - click to show all">' + esc(featureTitle(A.feature)) + ' ✕</span>' : '')
        /* the lenses colour the map: only where there is a map to colour */
        /* the bar: What is it is Shape's job now; Reach is on Features (live / orphaned) and Problems; Page URLs only mean something inside one feature */
        + (mapView ? '<span class="ar-sep"></span><span class="small dim" style="margin-right:4px">colour by</span><button class="lensbtn' + (A.tagsOn ? ' on' : '') + '" data-tags="1" title="filter the graph by its tags: feature, kind, flow, purpose, and where the tags come from">Tags</button>' + A.lenses.filter(function (l) { return !(l.ns === 'kind' || l.ns === 'reach' || l.ns === 'declared' || (l.ns === 'page' && !A.feature)); }).map(function (l) { return '<button class="lensbtn' + (l.ns === A.lens && !A.tagsOn ? ' on' : '') + '" data-lens="' + esc(l.ns) + '" title="' + esc(l.purpose) + '">' + esc(l.title) + '</button>'; }).join('') : '')
        + (A.embed ? '<button class="lensbtn" data-h="rescan" title="rescan">↻</button>' : ctx.page ? '<span class="ar-sep"></span><button class="lensbtn" data-h="rescan" title="rescan">↻</button>'
          /* zoom, page only: the drawing scales, the page scrolls */
          + '<span class="ar-sep"></span><button class="lensbtn" data-zoom="out" title="smaller (Ctrl + wheel)">−</button><button class="lensbtn" data-zoom="fit" title="fit the width">' + Math.round((A.zoom || 1) * 100) + '%</button><button class="lensbtn" data-zoom="in" title="bigger (Ctrl + wheel)">+</button>' : '')
        /* Two ways of seeing the same map: the LEVELS (rings, drill down) and the FLOW (pages ->
           code -> data with the edges drawn; hover for what a thing reaches and what reaches it).
           The flow is the "who owns what data" picture. */
        + '</div>'
        + '</div>';
      // the Problems rules are a file the owner reads and edits: link it from the lens
      if (!A.embed) h += '<div class="small dim ar-purpose">' + (mapView ? esc(A.g.purpose || '') : A.view === 'doctrine' ? 'AI slop first: what machine-written code does that a person would not. Then the process slips: doctrine rules that got past the write-time gate. Click a count to open it as work.' : '')
        + (A.lens === 'problem' && (mapView || A.view === 'doctrine') ? ' <a href="/plugins/architecture/problems.json" target="_blank" title="the rules, thresholds and wording - edit the file, then rescan">rules ↗</a> <span class="dim">· a project overrides them in <a href="#" data-open=".cockpit/plugins/architecture.problems.json" title="open (or see it is missing) in the File card">.cockpit\\plugins\\architecture.problems.json</a></span>' : '') + '</div>';
      h += flowExplain();
      if (A.tagsOn && A.view === 'flow' && A.flow) h += tagFilterHtml(A.flow);
      var needFlow = true;
      if (needFlow && !A.flow) loadFlow();
      var wait = '<div class="muted small" style="padding:20px">reading the map…</div>';
      var embedFinding = !!(A.finding && A.embedPanel && /^env:/.test(A.finding));   // one of the embedding page's own (the environment)
      var findingOpen = A.view === 'doctrine' && A.finding && (A.flow || embedFinding);
      var body = A.view === 'doctrine' ? ((findingOpen ? (embedFinding ? A.embedPanel(A.finding.slice(4)) : findingPanel(A.flow, A.finding)) : '') + (A.embedTop || '') + (A.flow ? (A.embed ? '' : backlogStrip() + ticketsStrip()) + doctrineChecklist(A.flow) : (A.embedGroups ? embedGroupsHtml() : '') + wait))
        : A.view === 'flow' ? (A.flow ? drawFlow(A.flow, cat) : wait)
        : A.view === 'features' ? (A.flow ? featuresHtml(A.flow) : wait)
        : A.view === 'tables' ? (A.flow ? tablesHtml(A.flow) : wait)
        : window.ArchViews[A.view] ? '<div class="ar-ext" data-ext="' + esc(A.view) + '"></div>'   // the plugin draws into it below, once it is in the document
        : wait;
      if (A.lens === 'problem') A.problemLegend = A.g.legend;
      A.problemBands = {}; Object.keys(A.problemRules || {}).forEach(function (k) { A.problemBands[k] = A.problemRules[k].band; }); (A.problemLegend || []).forEach(function (l) { A.problemBands[l.value] = l.band; });
      /* The legend's numbers count what is ON SCREEN. In Levels that is circles at this level
         (a folder counts once however many files inside carry the value); in Flow it is the
         files and tables themselves. */
      var legend = A.g.legend;
      if (A.view === 'flow' && A.flow) {
        var counts = {}; (A.feature ? featureNodes(A.flow, A.feature).nodes : A.tagsOn ? applyTagFilter(A.flow).nodes : A.flow.nodes).forEach(function (n) { (n.tags || []).forEach(function (t) { if (t.indexOf((A.lens || '') + ':') === 0) { var v = t.slice((A.lens || '').length + 1).replace('*', ''); counts[v] = (counts[v] || 0) + 1; } }); });
        legend = A.g.legend.map(function (l) { return Object.assign({}, l, { n: counts[l.value] || 0 }); }).concat(Object.keys(counts).filter(function (v) { return !A.g.legend.some(function (l) { return l.value === v; }); }).map(function (v) { return { value: v, label: v, n: counts[v], band: 'info', why: '' }; })).filter(function (l) { return l.n > 0; }).sort(function (a, b) { return b.n - a.n; });
      }
      h += '<div class="ar-body"><div class="ar-map">' + body + (mapView ? legendHtml(legend, cat) : '') + (A.view === 'flow' ? flowLegend() : '') + '</div>'
        + (ctx.page && A.sel && A.codeOpen && window.FILE ? codePaneHtml() : '')
        + (A.sel ? '<div class="ar-rail"><span class="tkx ar-close" title="close">✕</span>' + railHtml(A.detail, ctx) + '</div>' : '') + '</div></div>';
      if (!Layout.paint(el, h)) return;
      var ext = el.querySelector('.ar-ext'); if (ext) { try { window.ArchViews[ext.dataset.ext].render(ext); } catch (e) { ext.innerHTML = '<div class="small bad">' + esc(e.message) + '</div>'; } }
      publishScreen(findingOpen);
      if (A.embedWire) { try { A.embedWire(el); } catch (e) { console.error('embed wire: ' + e.message); } }
      wireCodePane(el);
      var cx = el.querySelector('.ar-close'); if (cx) cx.addEventListener('click', function () { A.sel = null; A.detail = null; A.codeOpen = false; Layout.refresh(); });   // one ✕ closes the connections and the code
      el.querySelectorAll('[data-view]').forEach(function (b) { b.addEventListener('click', function () { A.view = b.dataset.view; if (A.view !== 'flow') Layout.fit('architecture', true); Layout.refresh(); }); });
      el.querySelectorAll('[data-finding]').forEach(function (b) { b.addEventListener('click', function () { A.finding = A.finding === b.dataset.finding ? null : b.dataset.finding; A.pickValue = null; A.cell = null; Layout.refresh(); if (A.finding) requestAnimationFrame(function () { for (var p = document.querySelector('.arpage-map .fd') || el.querySelector('.fd'); p; p = p.parentElement) p.scrollTop = 0; window.scrollTo(0, 0); }); }); });   // the chip is deep in a long list; the card opens at the top - go there
      var fc = el.querySelector('[data-finding-close]'); if (fc) fc.addEventListener('click', function () { A.finding = null; Layout.refresh(); });
      var fch = el.querySelector('[data-finding-chat]'); if (fch) fch.addEventListener('click', function () { dropText(el.closest('.arpage') || el, A.findingBrief); });
      el.querySelectorAll('[data-cell]').forEach(function (b) { b.addEventListener('click', function () { A.cell = A.cell === b.dataset.cell ? null : (b.dataset.cell || null); Layout.refresh(); requestAnimationFrame(function () { var fd = document.querySelector('.arpage-map .fd') || el.querySelector('.fd'); for (var p = fd; p; p = p.parentElement) p.scrollTop = 0; window.scrollTo(0, 0); }); }); });   // the list is long and the card is at the top: after the re-render has painted, every ancestor goes back up
      var ft = el.querySelector('[data-finding-ticket]'); if (ft) ft.addEventListener('click', function () { dropText(el.closest('.arpage') || el, 'Draft a ticket for this finding' + (A.cell ? ' - the picked scope only' : '') + ': one slice, the files it touches, what to change, and a done-when I can read back on dev. Use `ticket draft`; I approve it on the Tickets card.'); });
      var bl = el.querySelector('[data-backlog]'); if (bl) bl.addEventListener('click', function (e) { e.preventDefault(); A.backlogOnly = !A.backlogOnly; Layout.refresh(); });
      el.querySelectorAll('[data-tk-state]').forEach(function (b) { b.addEventListener('click', function () { var why = prompt('Mark ' + b.dataset.to + ' - a word on what you checked (goes on the ticket):'); if (why === null) return; fetch(Layout.state.api + '/tickets/' + encodeURIComponent(b.dataset.tkState) + '/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: b.dataset.to, why: why }) }).then(function (r) { return r.json(); }).then(function (r) { if (!r.ok) alert(r.error); A.tickets = null; Layout.refresh(); }); }); });
      // checked, it's fine: a hand-set 'accepted' tag (value = the rule, why = the reason); the scan stops raising it for this one
      el.querySelectorAll('[data-fine]').forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation();
        var why = prompt('Why is this fine? (kept with the mark - the next scan stops raising "' + b.dataset.fineRule + '" here)'); if (!why || !why.trim()) return;
        fetch(Layout.state.api + '/graph/tag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: b.dataset.fine, ns: 'accepted', value: b.dataset.fineRule, why: why.trim() }) })
          .then(function (r) { return r.json(); }).then(function (r) { if (!r.ok) { alert(r.error || 'not saved'); return; } b.textContent = 'marked fine - gone after the next scan'; b.removeAttribute('href'); b.classList.add('ok'); }); }); });
      var fm = el.querySelector('[data-finding-map]'); if (fm) fm.addEventListener('click', function () { A.pickValue = A.finding; A.view = 'flow'; A.lens = 'problem'; Layout.refresh(); });
      el.querySelectorAll('[data-finding-feature]').forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); A.feature = b.dataset.findingFeature || null; A.pickValue = A.finding; A.view = 'flow'; A.lens = 'problem'; Layout.refresh(); }); });
      el.querySelectorAll('[data-fsort]').forEach(function (b) { b.addEventListener('click', function () { A.featureSort = b.dataset.fsort; Layout.refresh(); }); });
      el.querySelectorAll('[data-feature]').forEach(function (b) { b.addEventListener('click', function () { var k = b.dataset.feature || null; A.feature = k; if (!k) A.grain = 'features'; if (k && A.view === 'features') A.view = 'flow'; A.pickValue = null; Layout.refresh(); }); });
      if (A.view !== 'doctrine' && A.lens === 'problem' && !mapView) { /* leaving Doctrine for Features/Tables keeps the lens; nothing to do */ }
      el.querySelectorAll('[data-tonly]').forEach(function (b) { b.addEventListener('click', function () { A.tableOnly = b.dataset.tonly; Layout.refresh(); }); });
      var tq = el.querySelector('#tb-q'); if (tq) { tq.addEventListener('input', function () { A.tableQ = tq.value; var at = tq.selectionStart; Layout.refresh(); var again = el.querySelector('#tb-q'); if (again) { again.focus(); again.selectionStart = again.selectionEnd = at; } }); }
      /* The flow opens at its full height so the whole thing is on screen;
         the card grows to fit once the drawing is in, and shrinks back when Levels is chosen. */
      if (A.view === 'flow' && A.flow && !A.onPage) setTimeout(function () {
        var svg = el.querySelector('.flowsvg'); if (!svg) return;
        var top = el.querySelector('.ar-top'), purpose = el.querySelector('.ar-purpose'), legends = el.querySelectorAll('.maplegend');
        var px = svg.getBoundingClientRect().height + (top ? top.offsetHeight : 0) + (purpose ? purpose.offsetHeight : 0) + 8;
        legends.forEach(function (l) { px += l.offsetHeight + 6; });
        Layout.fit('architecture', false, px);
      }, 0);
      el.querySelectorAll('.lensbtn[data-lens]').forEach(function (b) { b.addEventListener('click', function () { A.tagsOn = false; A.lens = b.dataset.lens; A.flow = null; A.pickValue = null; load(); }); });
      var tb = el.querySelector('[data-tags]'); if (tb) tb.addEventListener('click', function () { A.tagsOn = !A.tagsOn; A.view = 'flow'; A.lens = 'declared'; A.flow = null; A.pickValue = null; load(); });
      el.querySelectorAll('[data-tf]').forEach(function (c) { c.addEventListener('click', function () { var list = A.tf[c.dataset.tf], v = c.dataset.tfv, i = list.indexOf(v); if (i >= 0) list.splice(i, 1); else list.push(v); Layout.refresh(); }); });
      var tfc = el.querySelector('[data-tf-clear]'); if (tfc) tfc.addEventListener('click', function () { A.tf = { family: [], feature: [], kind: [], flow: [], source: [], q: '' }; Layout.refresh(); });
      var tfq = el.querySelector('#tf-q'); if (tfq) tfq.addEventListener('input', function () { A.tf.q = tfq.value; var at = tfq.selectionStart; Layout.refresh(); var again = el.querySelector('#tf-q'); if (again) { again.focus(); again.selectionStart = again.selectionEnd = at; } });
      wireFlow(el);
      var dr = el.querySelector('#dast-run'); if (dr) dr.addEventListener('click', function () { dr.textContent = 'starting…'; fetch(Layout.state.api + '/tests/dast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(function (r) { return r.json(); }).then(function (r) { A.dast = A.dast || {}; A.dast.running = !!r.ok; if (!r.ok) alert(r.error); Layout.refresh(); }); });
      el.querySelectorAll('[data-go]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); select(a.dataset.go); }); });
      el.querySelectorAll('[data-open]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); if (ctx.page) A.codeOpen = true; if (window.openFile) window.openFile(a.dataset.open); }); });
      if (ctx.page) {
        var applyZoom = function () { el.querySelectorAll('.mapsvg').forEach(function (svg) { svg.style.width = Math.round((A.zoom || 1) * 100) + '%'; svg.style.maxHeight = 'none'; }); var zb = el.querySelector('[data-zoom="fit"]'); if (zb) zb.textContent = Math.round((A.zoom || 1) * 100) + '%'; };
        var setZoom = function (z) { A.zoom = Math.max(0.2, Math.min(3, z)); applyZoom(); };
        applyZoom();
        el.querySelectorAll('[data-zoom]').forEach(function (b) { b.addEventListener('click', function () { setZoom(b.dataset.zoom === 'in' ? (A.zoom || 1) * 1.25 : b.dataset.zoom === 'out' ? (A.zoom || 1) / 1.25 : 0.42); }); });   // the page opens at 42%; the % button returns to it
        if (!el.dataset.wheel) { el.dataset.wheel = '1'; el.addEventListener('wheel', function (e) { if (!e.ctrlKey) return; e.preventDefault(); setZoom((A.zoom || 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false }); }
      }
      var prb = el.querySelector('[data-h="rescan"]'); if (prb && ctx.page) prb.addEventListener('click', function () { A.scanning = true; Layout.refresh(); window.PluginUI.scan('architecture', function () { A.scanning = false; A.g = null; load(); }); });
  }

  /* No card in the room any more: the map lives on its tab. renderMap keeps its card
     branch so a project that wants the small view back can register one. */

  /* ---------- the page ----------
     Map on the left, the project's Conversation on the right - the same conversation as the
     room's card (same threads, same AI), rendered by the conversation card's own renderer.
     Drag a circle (Levels) or a box (Flow) onto the conversation and a line describing it
     lands in the message box: what it is, its tags, what it reaches and what reaches it.
     Type the question, send. The AI has the cli to dig further. */
  var DRAG_PX = 6;
  /* the page frame: the content on the left, the conversation docked on the right (its width dragged, remembered).
     The Architecture tab uses it with the map; the Tests tab uses it with its own content. */
  function frame(el, renderBody, place) {   // place: which conversation the frame docks - the tab's own ('architecture', 'tests')
    if (!el.querySelector('.arpage')) el.innerHTML = '<div class="arpage"><div class="arpage-map"></div><div class="arpage-dock"><div class="arpage-dock-sizer" title="drag to make the conversation wider or narrower"></div><div class="arpage-dock-hd"><b>Conversation</b><span class="small dim">drag a circle or a box here to ask about it</span></div><div class="arpage-conv"></div></div></div>';
    renderBody(el.querySelector('.arpage-map'));
    var dock = el.querySelector('.arpage-dock'), sizer = el.querySelector('.arpage-dock-sizer');
    if (dock && !dock.dataset.sized) {
      dock.dataset.sized = '1';
      var saved = null; try { saved = Number(localStorage.getItem('cockpit.arch.dock')); } catch (e) { /* no storage */ }
      if (saved && saved >= 280) dock.style.flexBasis = saved + 'px';
      sizer.addEventListener('pointerdown', function (e) {
        e.preventDefault(); var startX = e.clientX, startW = dock.getBoundingClientRect().width;
        var move = function (ev) { var w = Math.max(280, Math.min(window.innerWidth - 520, startW + (startX - ev.clientX))); dock.style.flexBasis = w + 'px'; };
        var up = function () { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); try { localStorage.setItem('cockpit.arch.dock', String(Math.round(dock.getBoundingClientRect().width))); } catch (e2) { /* fine */ } };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
    }
    var conv = Layout.state.cards.conversation, host = el.querySelector('.arpage-conv');
    if (conv && host) conv.render(host, null, null, window.conversationCtx ? window.conversationCtx(place || 'architecture') : null);   // the tab's own conversation: its own thread and turn
    wireDrag(el);
  }
  function renderPage(el) { frame(el, function (map) { renderMap(map, { page: true }); }, 'architecture'); }
  window.ArchPage = { frame: frame };
  /* The code pane: between the flow and the connections box, shown while a
     file is open on the page; its width dragged from its LEFT edge, so only the code grows into
     the flow - the connections box and the conversation stay where they are. ✕ closes it. */
  function codePaneHtml() {
    var f = window.FILE;
    var head = '<div class="fhead"><code>' + esc(f.path) + '</code></div>';
    var body = f.loading ? '<div class="dim small">reading…</div>' : f.error ? '<div class="small" style="color:var(--red,#e5484d)">' + esc(f.error) + '</div>' : f.binary ? '<div class="dim small">binary file - not shown as text</div>'
      : '<pre class="fbody">' + f.text.split('\n').map(function (l, i) { return '<span class="ln">' + (i + 1) + '</span>' + esc(l); }).join('\n') + '</pre>';
    return '<div class="ar-code"' + (A.codeWidth ? ' style="width:' + A.codeWidth + 'px"' : '') + '><div class="ar-sizer" title="drag to resize"></div><div class="ar-code-in">' + head + body + '</div></div>';
  }
  function wireCodePane(el) {
    var pane = el.querySelector('.ar-code'); if (!pane) return;
    pane.querySelector('.ar-sizer').addEventListener('pointerdown', function (e) {
      e.preventDefault(); var startX = e.clientX, startW = pane.getBoundingClientRect().width;
      var move = function (ev) { A.codeWidth = Math.max(280, Math.min(window.innerWidth - 900, startW + (startX - ev.clientX))); pane.style.width = A.codeWidth + 'px'; };
      var up = function () { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  }
  function describeForChat(subject, then) {
    api(Layout.state.api + '/graph/node?subject=' + encodeURIComponent(subject)).then(function (d) {
      if (!d || d.error) return then(subject);
      var tags = (d.tags || []).filter(function (t) { return t.ns !== 'kind'; }).map(function (t) { return t.ns + ':' + (t.value || t.label); });
      then('About ' + subject + ' (' + (d.kind || '') + (d.file ? ', ' + d.file : '') + (tags.length ? '; ' + tags.join(', ') : '') + '; reaches ' + (d.out || []).length + ', reached by ' + (d.in || []).length + '):');
    }).catch(function () { then(subject); });
  }
  function dropInto(el, subject) {
    var ta = el.querySelector('.arpage-conv #cv-in'); if (!ta || ta.disabled) return;
    describeForChat(subject, function (line) {
      ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + '\n' : '') + line + '\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));   // the conversation keeps its draft from this
      ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
    });
  }
  function wireDrag(el) {
    var map = el.querySelector('.arpage-map'), dock = el.querySelector('.arpage-dock');
    if (!map || map.dataset.drag) return; map.dataset.drag = '1';
    var st = null, chip = null, dragged = false;
    map.addEventListener('pointerdown', function (e) {
      var n = e.target.closest('.an, .fn'); if (!n || !n.dataset.subject) return;
      st = { x: e.clientX, y: e.clientY, subject: n.dataset.subject, title: (n.querySelector('title') || {}).textContent || n.dataset.subject }; dragged = false;
    });
    window.addEventListener('pointermove', function (e) {
      if (!st) return;
      if (!dragged && Math.hypot(e.clientX - st.x, e.clientY - st.y) < DRAG_PX) return;
      if (!dragged) { dragged = true; chip = document.createElement('div'); chip.className = 'ar-chip'; chip.textContent = st.title.split(' ')[0]; document.body.appendChild(chip); }
      chip.style.left = (e.clientX + 12) + 'px'; chip.style.top = (e.clientY + 12) + 'px';
      var over = dock.getBoundingClientRect(), inside = e.clientX >= over.left && e.clientX <= over.right && e.clientY >= over.top && e.clientY <= over.bottom;
      dock.classList.toggle('drop-here', inside);
    });
    window.addEventListener('pointerup', function (e) {
      if (!st) return;
      var was = st, wasDragged = dragged; st = null;
      if (chip) { chip.remove(); chip = null; }
      dock.classList.remove('drop-here');
      if (!wasDragged) return;   // a click: the node's own handler opens it
      var over = dock.getBoundingClientRect();
      if (e.clientX >= over.left && e.clientX <= over.right && e.clientY >= over.top && e.clientY <= over.bottom) dropInto(el, was.subject);
    });
    // a drag must not also count as a click on the node
    map.addEventListener('click', function (e) { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
  }
  window.__arch = { A: A, featureIndex: featureIndex, featuresHtml: featuresHtml, tablesHtml: tablesHtml, doctrineChecklist: doctrineChecklist, drawFlow: drawFlow, findingPanel: findingPanel, tagFilterHtml: tagFilterHtml, riskOf: riskOf };   // for tests
  /* Problems, for the Tests tab (plugins/tickets/cards/tests-page.js): the same view, the same state, no map bar */
  window.ArchProblems = { render: function (el, opts) { renderMap(el, { page: true, embed: 'problems', top: opts && opts.top, wire: opts && opts.wire, groups: opts && opts.groups, panel: opts && opts.panel }); }, finding: function () { return A.finding; } };
  if (window.Pages) window.Pages.register({ id: 'architecture', plugin: 'architecture', title: 'Architecture', render: renderPage,
    renderLive: function (el) { var conv = Layout.state.cards.conversation, host = el.querySelector('.arpage-conv'); if (conv && conv.renderLive && host) conv.renderLive(host, window.conversationCtx ? window.conversationCtx('architecture') : null); } });
})();
