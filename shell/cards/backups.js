/* The Backups card - is this project's work safe, in one look. The engine copies the code and the database whenever they change and keeps the newest 14 of
   each (engine/backup.js); this card says when it last did, how many copies there are, where they are, and offers
   Back up now and the switch. Bound to its project through ctx, so it can sit on Home for any project. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mb(n) { return n == null ? '' : n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function ago(iso) { if (!iso) return 'never'; var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };

  function Backups(ctx0) {
    var X = ctx0, S = { d: null, loading: false, busy: false, msg: null, at: 0 };
    function base() { return (X && X.api) || Layout.state.api; }
    function load(quiet) {
      if (S.loading) return; S.loading = true;
      api(base() + '/backup').then(function (d) { var was = JSON.stringify(S.d); S.d = d; S.at = Date.now(); S.loading = false; if (!quiet || JSON.stringify(d) !== was) Layout.refresh(); })
        .catch(function (e) { S.loading = false; S.d = { ok: false, error: e.message }; Layout.refresh(); });
    }
    /* one kind's line: last copy, how many kept, the newest few */
    function kindHtml(label, k, what) {
      var last = k.at, n = (k.copies || []).length, lastRes = S.d.last && S.d.last[what] || {};
      var h = '<div class="bk-kind"><b>' + esc(label) + '</b>';
      if (what === 'db') h += k.name ? ' <span class="small dim">' + esc(k.name) + '</span>' : '';
      if (what === 'db' && lastRes.none && !k.at) { h += '<div class="small dim">no database found - ' + esc(lastRes.none.split(' - ')[0]) + '. If there is one, say where its credentials are: Settings › Plugins › Database.</div></div>'; return h; }
      h += '<div class="small">' + (last ? 'last copy <b>' + esc(ago(last)) + '</b> · ' + n + ' kept' + (n >= S.d.keep ? ' <span class="dim">(the newest ' + S.d.keep + ')</span>' : '') : '<span class="dim">no copy yet</span>') + '</div>';
      if (lastRes.error) h += '<div class="small bad">' + esc(lastRes.error) + '</div>';
      else if (lastRes.unchanged && S.d.checked) h += '<div class="small dim">unchanged since - checked ' + esc(ago(S.d.checked)) + '</div>';
      if (n) h += '<div class="small dim bk-list">' + k.copies.slice(0, 3).map(function (c) { return '<div><code>' + esc(c.file) + '</code> ' + mb(c.bytes) + '</div>'; }).join('') + '</div>';
      return h + '</div>';
    }
    function render(el) {
      var r = X.room;
      if (!r || r.missing) { el.innerHTML = '<div class="muted small">no project open</div>'; return; }
      if (S.project !== r.id) { S.project = r.id; S.d = null; S.msg = null; S.busy = false; }   // another project: start over
      if (!S.d) { load(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      var d = S.d;
      if (!d.ok) { el.innerHTML = '<div class="small bad">' + esc(d.error || 'the engine needs a restart before this card can read') + '</div>'; return; }
      var h = '<div class="bk">';
      h += '<div class="small ' + (d.off ? 'warn' : 'dim') + '">' + (d.off ? 'switched off for this project - nothing is copied' : 'the code and the database are copied whenever they change; the newest ' + d.keep + ' copies of each are kept') + '</div>';
      h += kindHtml('Code', d.code, 'code') + kindHtml('Database', d.db, 'db');
      h += '<div class="small dim" style="margin-top:6px">kept in <code title="' + esc(d.folder) + '">' + esc(d.folder) + '</code></div>';
      h += '<div class="bk-acts"><span class="btn sm' + (S.busy || d.running ? ' dim' : '') + '" data-bk="now">' + (S.busy || d.running ? 'backing up…' : 'Back up now') + '</span> '
        + '<label class="small dim"><input type="checkbox" data-bk="on"' + (d.off ? '' : ' checked') + '> on</label>'
        + (S.msg ? ' <span class="small dim">' + esc(S.msg) + '</span>' : '') + '</div></div>';
      if (!Layout.paint(el, h)) return; wire(el);
      setTimeout(function () { Layout.snug(X.key); }, 0);
    }
    function wire(el) {
      var b = el.querySelector('[data-bk="now"]'); if (b) b.addEventListener('click', function () {
        if (S.busy) return; S.busy = true; S.msg = null; Layout.refresh();
        api(base() + '/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) }).then(function (r) {
          S.busy = false; S.msg = r.ok ? ('copied' + (r.code.file ? ' the code' : '') + (r.db.file ? (r.code.file ? ' and' : '') + ' the database' : '') + (!r.code.file && !r.db.file ? ' nothing - see above' : '')) : r.error; S.d = null; load();
        }).catch(function (e) { S.busy = false; S.msg = e.message; Layout.refresh(); });
      });
      var sw = el.querySelector('[data-bk="on"]'); if (sw) sw.addEventListener('change', function () {
        api(base() + '/backup/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ off: !sw.checked }) }).then(function () { S.d = null; load(); });
      });
    }
    return { render: render, use: function (c) { X = c; }, tick: function () { if (S.d && Date.now() - S.at > 60000) load(true); } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('backups') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Backups(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'backups', coding: true, hiddenByDefault: true, icon: '🗄', title: 'Backups', purpose: 'the code and the database, copied whenever they change, the newest 14 kept - so nothing is lost', zone: 'right', pos: 1, size: [5, 12], min: [4, 6], max: [12, 20], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
  setInterval(function () { Object.keys(INST).forEach(function (k) { INST[k].tick(); }); }, 30000);
})();
