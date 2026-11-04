/* The Tests tab - the Coding plugin's page.
   One tab, three parts, the same list on every project with Coding on:
     Environment  eight runs against the live project - the tests pass, every flow proven, the app answers, the
                  contract, DAST, migrations, sign-in, backup/restore (engine/verify.js reads them; the runner makes them)
     Static       the code rules read over the map on every scan - Problems, as stages (lint, SAST, slop, ...)
     Runs         Run tests, Run DAST, Promote
   Nothing here blocks: red is the truth about the project, in words that are a to-do. A red line is a finding - click
   it, the card says what is missing and what would fix it, and the conversation docked beside sees it: that is where it
   is worked. The Tickets plugin, when on, adds the gates (its "blocks" switches appear here) and Passed becomes the
   promote; without it, Promote is a button that shows you the reds and asks. */
(function () {
  'use strict';
  /* THE OWNER'S CLOCK, NOT UTC's.
     Every time Cockpit shows comes off an ISO string, which is UTC; sliced raw it reads as tomorrow all evening. */
  function whenLocal(s) { if (!s) return ''; var t = new Date(s); return isNaN(t) ? String(s).slice(0, 16).replace('T', ' ') : t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
  var S = { fam: null, checks: [], report: null, tests: null, dast: null, promote: null, loading: false, err: null, at: 0, msg: null, confirm: false, running: false, stage: null, endedAt: 0 };
  function ticketsOn() { var pl = window.PluginUI && window.PluginUI.info('tickets'); return !!(pl && pl.selected); }
  function load(quiet) {
    if (S.loading) return; S.loading = true; var was = quiet ? JSON.stringify([S.fam, S.checks, S.report, S.tests && S.tests.latest, S.dast && S.dast.latest, S.promote]) : null;
    var A = Layout.state.api;
    Promise.all([api(A + '/tests/family'), api(A + '/tests'), api(A + '/tests/dast').catch(function () { return null; }), api(A + '/tests/failures').catch(function () { return { failures: [] }; }), api(A + '/promote').catch(function () { return null; })]).then(function (r) {
      if (!r[0].ok) throw new Error((r[0].error || 'no answer') + ' - the engine needs a restart before the Tests tab can read');
      if (S.running && !r[0].running) S.endedAt = Date.now();   // the run just ended: keep looking for a while - the rescan lands a few seconds later
      S.fam = r[0].family || []; S.checks = r[0].checks || []; S.report = r[0].report; S.running = !!r[0].running; S.stage = r[0].stage || null; S.tests = r[1]; if (S.tests) S.tests.failures = (r[3] && r[3].failures) || []; S.dast = r[2]; S.promote = r[4]; S.err = null; S.at = Date.now();
    }).catch(function (e) { S.err = e.message; }).then(function () { S.loading = false; if (!quiet || JSON.stringify([S.fam, S.checks, S.report, S.tests && S.tests.latest, S.dast && S.dast.latest, S.promote]) !== was) window.Pages.refresh(); });
  }
  function ago(iso) { if (!iso) return ''; var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
  /* the run behind a line, on the line: when it ran, how long, what it found; the failures for the tests line */
  function runFacts(id) {
    if (id === 'tests' && S.tests && S.tests.latest) {
      var L = S.tests.latest, sm = L.summary || {};
      var h = '<div class="small dim" style="margin-top:3px">ran ' + esc(whenLocal(L.at)) + ' · ' + Math.round((L.ms || 0) / 1000) + ' s · ' + (L.command ? '<code>' + esc(L.command) + '</code>' : 'node --test per file') + (L.setup ? ' · setup ' + (L.setup.ok ? 'ok' : '<b class="bad">failed</b>') : '') + (L.env && L.env.db ? ' · <code>' + esc(L.env.db) + '</code>' : '') + ' · ' + (sm.total || 0) + ' files, ' + (sm.passed || 0) + ' passed' + (sm.failed ? ', <b class="bad">' + sm.failed + ' failed</b>' : '') + (sm.skipped ? ', ' + sm.skipped + ' skipped' : '') + '</div>';
      if (S.tests.failures && S.tests.failures.length) h += '<div class="small" style="margin-top:3px">' + S.tests.failures.slice(0, 8).map(function (x) { return '<div><code>' + esc(x.file) + '</code> <span class="dim">' + esc(String(x.tail || '').trim().split(String.fromCharCode(10)).slice(-1)[0].slice(0, 160)) + '</span></div>'; }).join('') + '</div>';
      return h;
    }
    if (id === 'dast' && S.dast && S.dast.latest) { var D = S.dast.latest; return '<div class="small dim" style="margin-top:3px">ran ' + esc(whenLocal(D.at)) + ' · ' + (D.ok ? 'finished' : '<b class="bad">stopped</b>') + (D.spider ? ' · ' + D.spider.urls + ' urls' : '') + (D.active && D.active.skipped ? ' · passive only' : '') + (D.summary && Object.keys(D.summary).length ? ' · ' + Object.keys(D.summary).map(function (k) { return D.summary[k] + ' ' + k.toLowerCase(); }).join(', ') : '') + '</div>'; }
    if (id === 'app' && S.report && S.tests && S.tests.latest && S.tests.latest.at) return '<div class="small dim" style="margin-top:3px">ran ' + esc(whenLocal(S.tests.latest.at)) + '</div>';
    return '';
  }
  /* the detail card for one environment check - the same card Problems uses for a finding; the conversation beside sees it */
  function envCard(f) {
    var c = S.checks.find(function (x) { return x.id === f.id; }) || {}, blocks = ticketsOn() && c.blocks !== false;
    return '<div class="fd"><div class="fd-hd"><b>' + esc(c.name || f.id) + '</b> <span class="lg ' + (f.na ? 'quiet' : f.ok ? 'ok' : blocks ? 'bad' : 'warn') + '">' + (f.na ? 'not checked - does not block, never counts as holding' : f.ok ? 'holds' : blocks ? 'red - blocks the promote' : 'red') + '</span> <span class="small dim">' + esc(f.id) + '</span><span style="flex:1"></span><span class="tkx" data-finding-close title="close">✕</span></div>'
      + '<div class="fd-what">' + esc(f.detail) + '</div>' + runFacts(f.id)
      + '<div class="small" style="margin-top:8px"><b>asks</b> ' + esc(c.asks || '') + '</div>'
      + (c.why ? '<div class="small dim" style="margin-top:4px"><b>why</b> ' + esc(c.why) + '</div>' : '')
      + (c.measures ? '<div class="small dim" style="margin-top:4px"><b>measures</b> ' + esc(c.measures) + '</div>' : '')
      + (!f.ok && c.fix ? '<div class="small" style="margin-top:6px">→ ' + esc(c.fix) + '</div>' : '')
      + '<div class="fd-acts" style="margin-top:10px">' + (f.id === 'dast' ? '<span class="btn ghost sm" data-run="dast">Run DAST</span>' : '<span class="btn ghost sm" data-run="tests">Run tests</span>') + ' <span class="small dim">to work it: say so in the conversation beside - it sees this card</span></div></div>';
  }
  function render(pageEl) {
    if (window.ArchPage && window.ArchPage.frame) { window.ArchPage.frame(pageEl, renderBody, 'tests'); return; }
    renderBody(pageEl);
  }
  function counts() {
    var on = ticketsOn(), blocksOf = function (id) { var c = S.checks.find(function (x) { return x.id === id; }); return on && (!c || c.blocks !== false); };
    var fam = S.fam || [];
    // a line that measured nothing (na) is neither red nor holding: counted apart as "not checked"
    var real = fam.filter(function (f) { return !f.na; });
    return { red: real.filter(function (f) { return !f.ok && blocksOf(f.id); }).length, warn: real.filter(function (f) { return !f.ok && !blocksOf(f.id); }).length, bad: real.filter(function (f) { return !f.ok; }).length, na: fam.length - real.length, n: fam.length };
  }
  function topHtml() {
    var k = counts(), on = ticketsOn();
    var h = '<div class="tp-hd"><div><h2>Tests <span class="btn ghost sm" data-run="again" title="read again, and rescan the code">↻</span></h2><div class="st-what">The project as a whole. <b>Environment</b>: ' + k.n + ' runs against the live project. <b>Static</b>: the rules read over the code on every scan. '
      + (on ? 'With Tickets on, a red line that blocks stops the promote; Passed is the promote.' : 'Nothing here blocks: red is what is true about the project, in words that are a to-do. Click a line - its card says what is missing - and work it in the conversation beside.') + '</div></div></div>';
    if (S.err) h += '<div class="small bad">' + esc(S.err) + '</div>';
    return h;
  }
  /* the runs, and Promote: with Tickets off it is a button that shows the reds and asks; with Tickets on, Passed is the promote */
  function envActs(k) {
    var on = ticketsOn(), st = S.promote || {}, set = st.settings || {}, pr = st.running;
    var h = '<span class="btn ' + (S.tests && S.tests.latest ? '' : 'ghost ') + 'sm' + (S.tests && S.tests.running ? ' dim' : '') + '" data-run="tests" title="the runner: the test database setup, every test file (or the command under ## Tests), the app stages, the restore drill">' + (S.tests && S.tests.running ? 'running…' : 'Run tests') + '</span> '
      + '<span class="btn ghost sm' + (S.dast && S.dast.running ? ' dim' : '') + '" data-run="dast" title="ZAP against the running app: spider, active scan, alerts. Needs ZAP unpacked (Settings › Engine) and the app answering">' + (S.dast && S.dast.running ? 'DAST running…' : 'Run DAST') + '</span>';
    if (!on) {
      if (!set.to) h += ' <span class="small dim" title="Settings › Plugins › Coding: the Target folder (and url) a promote lands on">no target set - Promote needs one (Coding settings)</span>';
      else if (pr) h += ' <span class="btn ghost sm dim">promoting…</span>';
      else if (S.confirm) h += ' <span class="btn sm" data-run="promote-go" title="the target folder is brought to this folder\'s commit, the url smoked, rolled back on failure">' + (k.bad ? k.bad + ' red · promote anyway' : 'promote now') + '</span> <span class="btn ghost sm" data-run="promote-no">no</span>';
      else h += ' <span class="btn ghost sm" data-run="promote" title="' + esc(set.to) + (set.url ? ' · ' + set.url : '') + '">Promote</span>';
      if (st.last) h += ' <span class="small dim">last promote ' + esc(ago(st.last.at)) + ' · ' + (st.last.ok ? 'landed' : '<b class="bad">' + esc((st.last.note || 'failed').slice(0, 80)) + '</b>') + '</span>';
    }
    return h + (S.msg ? ' <span class="small dim">' + esc(S.msg) + '</span>' : '');
  }
  /* the environment as a stage group for the checklist */
  function groups() {
    if (!S.fam) return [{ title: 'Environment', what: 'reading…', stages: [] }];
    var k = counts(), on = ticketsOn(), open = window.ArchProblems && window.ArchProblems.finding();
    var STAGE = { setup: 'setting the test database up', tests: 'running the tests', sast: 'semgrep over the source', app: 'starting the app - probing its doors, the contract', restore: 'the backup and restore drill', finishing: 'reading the map again' };
    var pill = S.running ? ['run', 'running · ' + (STAGE[S.stage] || S.stage || '')] : k.red ? ['bad', k.red + ' red'] : k.bad ? [on ? 'warn' : 'bad', k.bad + ' red' + (on ? ', none block' : '')] : k.na ? ['quiet', k.na + ' not checked'] : ['ok', 'holds'];
    var rows = (S.fam || []).map(function (f) {
      var c = S.checks.find(function (x) { return x.id === f.id; }) || {}, blocks = on && c.blocks !== false;
      // a run is on: the line's stage is still to come (waiting), is the one now (running…, with the count for the tests), or has landed (its answer)
      if (f.live === 'waiting' || f.live === 'running') {
        var busy = f.live === 'running', prog = busy && f.id === 'tests' && f.total ? ' ' + (f.done || 0) + ' of ' + f.total : '';
        return { cls: busy ? 'run' : 'waiting', name: c.name || f.id, rule: c.asks || '', title: busy ? ('running now' + (f.current ? ' - ' + f.current : '')) : 'waits for its stage',
          right: '<span class="lg ' + (busy ? 'run' : 'quiet') + '" title="' + esc(busy ? 'running now' + (f.current ? ' - ' + f.current : '') : 'waits for its stage') + '">' + (busy ? 'running…' + esc(prog) : 'waiting') + '</span>' };
      }
      if (f.na) return { cls: 'waiting', name: c.name || f.id, rule: c.asks || '', title: f.detail,
        right: '<span class="lg pick quiet' + (open === 'env:' + f.id ? ' on' : '') + '" data-finding="env:' + esc(f.id) + '" title="' + esc(f.detail) + ' - click for the detail">not checked</span>' };
      return { cls: f.ok ? 'ok' : blocks ? 'bad' : on ? 'warnish' : 'bad', name: c.name || f.id, rule: c.asks || '', title: c.asks || '',
        right: (on ? '<label class="small dim tp-blk" title="on: red here stops every promote on this project. off: it only warns. The engine-wide setting is under Settings › Tickets."><input type="checkbox" data-blocks="' + esc(f.id) + '"' + (c.blocks !== false ? ' checked' : '') + '> blocks</label> ' : '')
          + '<span class="lg pick ' + (f.ok ? 'ok' : blocks ? 'bad' : on ? 'warn' : 'bad') + (open === 'env:' + f.id ? ' on' : '') + '" data-finding="env:' + esc(f.id) + '" title="' + esc(f.detail) + ' - click for the detail">' + (f.ok ? 'holds' : blocks ? 'red' : on ? 'warns' : 'red') + '</span>' };
    });
    return [{ title: 'Environment', what: 'runs against the live project' + (on ? ' - when a ticket is passed, once per promote' : '') + ' · 1 stage' + (S.report ? ' · last ' + ago(S.report.at) : ''),
      stages: [{ title: 'Environment', pill: pill, what: 'the live project · ' + k.n + ' checks: ' + (k.n - k.bad - k.na) + ' hold' + (k.bad ? ', ' + k.bad + ' red' : '') + (k.na ? ', ' + k.na + ' not checked' : ''), acts: envActs(k), rows: rows }] }];
  }
  function panel(id) { var f = (S.fam || []).find(function (x) { return x.id === id; }); return f ? envCard(f) : ''; }
  function wire(el) {
    var A = Layout.state.api;
    el.querySelectorAll('[data-blocks]').forEach(function (i) { i.addEventListener('change', function () { api(A + '/tests/override', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: i.dataset.blocks, blocks: i.checked }) }).then(function (r) { if (!r.ok) alert(r.error); load(true); }); }); });
    el.querySelectorAll('[data-run]').forEach(function (b) { b.addEventListener('click', function () {
      var what = b.dataset.run;
      if (what === 'again') { S.fam = null; if (window.PluginUI && window.PluginUI.scan) window.PluginUI.scan('architecture', function () { window.Pages.refresh(); }); window.Pages.refresh(); return; }
      if (what === 'tests') { S.msg = null; S.running = true; window.Pages.refresh(); api(A + '/tests/run', { method: 'POST' }).then(function (r) { if (!r.ok) S.msg = r.error; setTimeout(function () { load(true); }, 1500); window.Pages.refresh(); }); return; }
      if (what === 'dast') { S.msg = 'starting DAST…'; window.Pages.refresh(); api(A + '/tests/dast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(function (r) { S.msg = r.ok ? 'DAST running - it takes minutes; ↻ to read again' : r.error; window.Pages.refresh(); }); return; }
      if (what === 'promote') { S.confirm = true; window.Pages.refresh(); return; }
      if (what === 'promote-no') { S.confirm = false; window.Pages.refresh(); return; }
      if (what === 'promote-go') {
        S.confirm = false; S.msg = 'promoting - the environment runs first, then the target is brought to this commit…'; window.Pages.refresh();
        api(A + '/promote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'owner', force: true }) }).then(function (r) { S.msg = r.ok ? 'promoted - ' + esc(r.record && r.record.note || 'landed') : r.error; S.promote = null; load(true); window.Pages.refresh(); });
      }
    }); });
  }
  function renderBody(el) {
    // another project now: forget the last one's results before drawing (2026-09-20: a switch showed the previous project's tab until the next poll)
    var pid = window.ROOM && window.ROOM.id; if (pid && S.project !== pid) { S.project = pid; S.fam = null; S.checks = []; S.report = null; S.tests = null; S.dast = null; S.promote = null; S.err = null; S.msg = null; S.confirm = false; S.running = false; S.stage = null; }
    var pl = window.PluginUI && window.PluginUI.info('coding');
    if (!pl || !pl.selected) { el.innerHTML = '<div class="empty">Coding is off for this project - Settings › Plugins and cards.</div>'; return; }
    if (!S.fam && !S.err && !S.loading) load();
    if (window.ArchProblems) { try { window.ArchProblems.render(el, { top: '<div class="tp">' + topHtml() + '</div>', groups: groups(), panel: panel, wire: wire }); return; } catch (e) { el.innerHTML = '<div class="small bad">' + esc(e.message) + '</div>'; return; } }
    el.innerHTML = '<div class="tp">' + topHtml() + '<div class="small dim">the map is being read - the Static stages appear when it lands</div></div>'; wire(el);
  }
  if (window.Pages) window.Pages.register({ id: 'tests', plugin: 'coding', title: 'Tests', render: render,
    renderLive: function (el) { var conv = Layout.state.cards.conversation, host = el.querySelector('.arpage-conv'); if (conv && conv.renderLive && host) conv.renderLive(host, window.conversationCtx ? window.conversationCtx('tests') : null); } });
  setInterval(function () { if (S.fam && window.ROOM && document.querySelector('section[data-page="tests"].on')) load(true); }, 60000);
  setInterval(function () { if (S.fam && window.ROOM && document.querySelector('section[data-page="tests"].on') && (S.running || (S.tests && S.tests.running) || Date.now() - S.endedAt < 30000)) load(true); }, 3000);   // live: every 3 s while it runs
})();
