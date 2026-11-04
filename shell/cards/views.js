/* The Data views card - a project's read-only queries (<project>\.cockpit\views\*.sql, engine/views.js) as tables you can look at
  . A project's AI adds a view by writing a query file in
   its own folder; this one card, in every project, shows it. Pick a view, read its rows; it refreshes every two minutes.
   No inline styles and no redraw unless something changed (the Agent fleet lesson, 2026-09-26). */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u) { return fetch(u).then(function (r) { return r.json(); }); };
  function hm(iso) { try { return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  function Views(ctx0) {
    var X = ctx0, S = { project: null, list: null, pick: null, data: null, err: null, loading: false, at: 0 };
    function base() { return (X && X.api) || Layout.state.api; }
    function loadList() {
      api(base() + '/views').then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'no answer');
        S.list = r.views || []; if (!S.pick && S.list.length) S.pick = S.list[0].name; Layout.refresh(); if (S.pick) loadView();
      }).catch(function (e) { S.err = /Unexpected token|JSON/.test(e.message) ? 'the engine needs a restart before it can show data views' : e.message; S.list = []; Layout.refresh(); });
    }
    function loadView() {
      if (!S.pick || S.loading) return; S.loading = true;
      api(base() + '/views/' + encodeURIComponent(S.pick)).then(function (r) { S.loading = false; S.data = r; S.at = Date.now(); Layout.refresh(); })
        .catch(function (e) { S.loading = false; S.data = { ok: false, error: e.message }; Layout.refresh(); });
    }
    function table(d) {
      if (!d) return '<div class="muted small">reading…</div>';
      if (!d.ok) return '<div class="small bad">' + esc(d.error) + '</div>';
      if (!d.rows.length) return '<div class="muted small">nothing to show right now</div>';
      return '<div class="dv-wrap"><table class="dv-t"><thead><tr>' + d.columns.map(function (c) { return '<th>' + esc(c.replace(/_/g, ' ')) + '</th>'; }).join('') + '</tr></thead><tbody>'
        + d.rows.map(function (row) { return '<tr>' + row.map(function (v) { return '<td' + (v == null ? ' class="dim"' : '') + '>' + esc(v == null ? '-' : v) + '</td>'; }).join('') + '</tr>'; }).join('')
        + '</tbody></table></div>' + (d.more ? '<div class="small dim">the first 500 rows</div>' : '');
    }
    function render(el) {
      var r = X && X.room; if (!r || r.missing) { el.innerHTML = '<div class="muted small">open a project</div>'; return; }
      if (S.project !== r.id) { S.project = r.id; S.list = null; S.pick = null; S.data = null; S.err = null; }
      if (S.list === null) { loadList(); Layout.paint(el, '<div class="muted small">reading views…</div>'); return; }
      var h = '<div class="dv">';
      if (S.err) h += '<div class="small bad">' + esc(S.err) + '</div>';
      else if (!S.list.length) h += '<div class="muted small">No views yet. A view is a read-only query saved as <code>.cockpit/views/&lt;name&gt;.sql</code> in this project - ask this project\'s AI to write one.</div>';
      else {
        var cur = S.list.find(function (v) { return v.name === S.pick; }) || S.list[0];
        h += '<div class="dv-bar"><select class="dv-pick">' + S.list.map(function (v) { return '<option value="' + esc(v.name) + '"' + (v.name === S.pick ? ' selected' : '') + '>' + esc(v.title) + '</option>'; }).join('') + '</select>'
          + ' <span class="btn ghost sm dv-refresh" title="read it again">↻</span>'
          + (S.data && S.data.ok ? ' <span class="small dim">' + S.data.rows.length + ' row' + (S.data.rows.length === 1 ? '' : 's') + ' · ' + esc(hm(S.data.at)) + '</span>' : '') + '</div>'
          + (cur && cur.about ? '<div class="small dim dv-about">' + esc(cur.about) + '</div>' : '')
          + table(S.data && S.data.name === S.pick ? S.data : null);
      }
      h += '</div>';
      if (!Layout.paint(el, h)) return;
      var sel = el.querySelector('.dv-pick'); if (sel) sel.addEventListener('change', function () { S.pick = sel.value; S.data = null; Layout.refresh(); loadView(); });
      var rf = el.querySelector('.dv-refresh'); if (rf) rf.addEventListener('click', function () { loadView(); });
    }
    return { render: render, use: function (c) { X = c; }, tick: function () { if (S.pick && Date.now() - S.at > 120000) loadView(); } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('views') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Views(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'views', coding: true, hiddenByDefault: true, icon: '📊', title: 'Data views', purpose: 'this project\'s data, read-only - the views its AI keeps in .cockpit/views', zone: 'right', pos: 3, size: [7, 12], min: [4, 5], max: [16, 40], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
  setInterval(function () { Object.keys(INST).forEach(function (k) { INST[k].tick(); }); }, 30000);
})();
