/* Pipeline - every open ticket as a row, the process as columns, the segment lit where the ticket is. The board says
   the same thing as chips; this is the shape for scanning many at once, filtering by feature and by text, and
   clicking a column head to see only that stage. The rule that outranks everything: EVERY open ticket appears
  . Rows come from
   the kit (Cockpit's tickets, plus GitHub's issues when that plugin is on). */
(function () {
  'use strict';
  var K = function () { return window.TicketCards; };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* ONE INSTANCE PER DESK CARD (Home step 1): bound to its project through ctx, so this card can sit on another
     project's desk - Home's - and read that project. */
  function Pipeline(ctx0) {
  var X = ctx0;
  var S = { rows: null, feature: '', text: '', col: '', loading: false, err: null };
  function load() {
    if (S.loading) return; S.loading = true;
    K().rows(true, X).then(function (rows) { S.rows = rows; S.err = null; }).catch(function (e) { S.rows = []; S.err = e.message; }).then(function () { S.loading = false; Layout.refresh(); });
  }
    function render(el) {
      if (!K() || !K().on(X)) { if (K()) K().notOn(el, X); return; }
      if (!S.rows) { load(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      if (S.err) { el.innerHTML = '<div class="small dim">' + esc(S.err) + ' - <a href="#" id="tkp-retry">try again</a></div>'; el.querySelector('#tkp-retry').addEventListener('click', function (e) { e.preventDefault(); S.rows = null; load(); }); return; }
      var cols = K().COLS.filter(function (c) { return c.key !== 'closed'; });
      var open = S.rows.filter(function (r) { return r.col !== 'closed'; });
      var feats = {}; open.forEach(function (r) { var f = r.feature || '(no feature)'; feats[f] = (feats[f] || 0) + 1; });
      var counts = {}; open.forEach(function (r) { counts[r.col] = (counts[r.col] || 0) + 1; });
      var rows = open.filter(function (r) { return (!S.col || r.col === S.col) && (!S.feature || (r.feature || '(no feature)') === S.feature) && (!S.text || ((r.number ? '#' + r.number + ' ' : '') + r.id + ' ' + r.title).toLowerCase().indexOf(S.text.toLowerCase()) >= 0); });
      var h = '<div class="cv-bar" style="margin-bottom:6px"><select id="tkp-feat"><option value="">all features · ' + open.length + '</option>' + Object.keys(feats).sort().map(function (f) { return '<option value="' + esc(f) + '"' + (S.feature === f ? ' selected' : '') + '>' + esc(f) + ' · ' + feats[f] + '</option>'; }).join('') + '</select>'
        + '<input id="tkp-text" placeholder="find a ticket" value="' + esc(S.text) + '" style="flex:1;font-size:12px;padding:3px 6px"><span class="dim small">' + rows.length + ' shown' + (S.col ? ' · <a href="#" id="tkp-clear">all stages</a>' : '') + '</span></div>';
      if (!open.length) h += '<div class="muted small">no open tickets' + (K().ghOn(X) ? '' : ' - the AI drafts one out of the conversation when a change is asked for') + '</div>';
      h += '<div class="pipe" style="--n:' + cols.length + '"><div class="hd" style="grid-template-columns:minmax(120px,1.6fr) repeat(' + cols.length + ',1fr)"><div style="text-align:left">ticket</div>' + cols.map(function (c) { return '<div class="ghp-st' + (S.col === c.key ? ' on' : '') + '" data-col="' + c.key + '" title="only this stage">' + esc(c.title) + (counts[c.key] ? ' <span class="dim">' + counts[c.key] + '</span>' : '') + '</div>'; }).join('') + '</div>';
      rows.forEach(function (r) {   // every open ticket, always; the card scrolls
        var at = cols.findIndex(function (c) { return c.key === r.col; });
        h += '<div class="row" data-id="' + esc(r.id) + '" title="' + esc(r.rule || (r.gh ? 'a GitHub issue without a Cockpit ticket' : r.state)) + '" style="grid-template-columns:minmax(120px,1.6fr) repeat(' + cols.length + ',1fr)"><div class="nm"><b>' + esc(r.number ? '#' + r.number : r.id) + '</b> ' + esc(r.title.replace(/^(#\d+|L\d+):\s*/, '')) + '<small>' + esc(r.feature || '') + (r.who ? ' · ' + esc(r.who) : '') + (r.gh ? ' · GitHub' : '') + (r.updated ? ' · ' + K().ago(r.updated) : '') + '</small></div>'
          + cols.map(function (c, i) { return '<div class="seg' + (i < at ? ' done' : i === at ? ' now' : '') + (i === 0 ? ' first' : '') + (i === cols.length - 1 ? ' last' : '') + '"><i></i></div>'; }).join('') + '</div>';
      });
      h += '</div>';
      if (!Layout.paint(el, h)) return;   // unchanged: leave the nodes and their listeners in place, no flicker
      el.querySelector('#tkp-feat').addEventListener('change', function (e) { S.feature = e.target.value; Layout.refresh(); });
      var t = el.querySelector('#tkp-text'); t.addEventListener('input', function () { S.text = t.value; }); t.addEventListener('keydown', function (e) { if (e.key === 'Enter') { t.blur(); Layout.refresh(); } });
      el.querySelectorAll('.ghp-st[data-col]').forEach(function (d) { d.style.cursor = 'pointer'; d.addEventListener('click', function () { S.col = S.col === d.dataset.col ? '' : d.dataset.col; Layout.refresh(); }); });
      var clr = el.querySelector('#tkp-clear'); if (clr) clr.addEventListener('click', function (e) { e.preventDefault(); S.col = ''; Layout.refresh(); });
      el.querySelectorAll('.row[data-id]').forEach(function (x) { x.addEventListener('click', function () { K().openTicket(x.dataset.id, X); }); });
    }
    return { render: render, use: function (c) { X = c; }, poke: function () { if (S.rows) { S.rows = null; load(); } } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('tk-pipeline') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Pipeline(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'tk-pipeline', plugin: 'tickets', icon: '🛤', title: 'Pipeline', purpose: 'every open ticket as a row and the stage it is at - filter by feature, by text, or click a stage', zone: 'stage', pos: 2, size: [12, 18], min: [6, 8], max: [12, 40], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
  setInterval(function () { if (window.ROOM) Object.keys(INST).forEach(function (k) { INST[k].poke(); }); }, 60000);
})();
