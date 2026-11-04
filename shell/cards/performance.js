/* Lane performance - GLOBAL: is each agent worth running?. Reads the engine's turn ledger -
   every finished turn, every harness, every project, fleet or conversation - for a window.
   Two halves, kept apart because they are different questions: RELIABILITY (of the turns
   started, how many produced anything at all) and COST (tokens, time). A number is never
   invented: a harness that reports no cost shows "not reported". */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function k(n) { return n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
  var api = function (u) { return fetch(u).then(function (r) { return r.json(); }); };
  var P = { d: null, window: '7d', loading: false };
  var LABEL = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI', pi: 'Pi (local)', 'codex-local': 'Local (Codex on Ollama, old lane)' };
  function load() { if (P.loading) return; P.loading = true; api('/api/fleet/performance?window=' + P.window).then(function (d) { var was = P.last; P.last = JSON.stringify(d); P.d = d; P.loading = false; if (P.last !== was) Layout.refresh(); }).catch(function () { P.loading = false; }); }

  Layout.register({ id: 'performance', coding: true, homeDock: ['left', 1], icon: '📈', title: 'Lane performance', global: true, purpose: 'is each agent worth running - turns, produced, nothing, failed, tokens, across every project', zone: 'right', pos: 3, size: [7, 11], min: [5, 7], max: [12, 24],
    render: function (el) {
      if (!P.d) { load(); el.innerHTML = '<div class="muted small">reading the ledger…</div>'; return; }
      var d = P.d, h = '<div class="pf">';
      h += '<div class="pf-bar">' + ['today', '7d', '30d', 'all'].map(function (w) { return '<button class="lensbtn' + (P.window === w ? ' on' : '') + '" data-w="' + w + '">' + w + '</button>'; }).join('') + '<span class="dim small" style="margin-left:auto">' + d.rows + ' turn' + (d.rows === 1 ? '' : 's') + ' in the window</span></div>';
      if (!d.agents.length) { h += '<div class="small dim" style="padding:8px 0">no turns recorded yet - every finished turn, from any project or the fleet, lands here</div></div>'; if (!Layout.paint(el, h)) return; wire(el); return; }
      h += '<table class="pf-t"><thead><tr><th>agent</th><th title="turns started">turns</th><th title="finished with something to show: text, a tool run, or a file touched">produced</th><th title="ended cleanly having done nothing - a plan, then exit">nothing</th><th title="stopped, killed for silence, hit the ceiling, or crashed">failed</th><th title="of the turns, how many were fleet items rather than your conversations">fleet</th><th>in / out</th><th>avg</th></tr></thead><tbody>';
      d.agents.sort(function (a, b) { return b.turns - a.turns; }).forEach(function (a) {
        var rate = a.turns ? Math.round(100 * a.produced / a.turns) : 0;
        h += '<tr><td><b>' + esc(LABEL[a.harness] || a.harness) + '</b><div class="small dim">' + esc(Object.keys(a.models).join(', ')) + ' · ' + esc(Object.keys(a.projects).join(', ')) + '</div></td>'
          + '<td>' + a.turns + '</td><td><b>' + a.produced + '</b> <span class="dim small">' + rate + '%</span></td><td>' + a.nothing + '</td><td>' + a.failed + '</td><td>' + a.fleet + '</td>'
          + '<td>' + (a.costRows ? k(a.inTokens) + ' / ' + k(a.outTokens) + (a.cacheRead ? '<div class="small dim">' + k(a.cacheRead) + ' cached</div>' : '') : '<span class="dim">not reported</span>') + '</td>'
          + '<td>' + (a.turns ? Math.round(a.seconds / a.turns) + 's' : '') + '</td></tr>';
      });
      h += '</tbody></table><div class="small dim" style="margin-top:6px">produced = the turn showed something for itself; nothing = it ended cleanly having done nothing. The question is: is this agent worth running? A high "nothing" is the answer.</div></div>';
      if (!Layout.paint(el, h)) return; wire(el);
    } });
  function wire(el) { el.querySelectorAll('[data-w]').forEach(function (b) { b.addEventListener('click', function () { P.window = b.dataset.w; P.d = null; Layout.refresh(); }); }); }
  setInterval(function () { if (P.d && window.ROOM) { P.d = null; load(); } }, 60000);
})();
