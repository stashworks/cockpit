/* Database - a view on the Architecture tab (2026-09-19; it was a Control-room card): the project's live database as the last scan read it: one row per table (rows,
   size, columns, last change, what code touches it); click a table for its latest rows (seeing
   the data itself), columns, indexes, keys and the files that read
   or write it. Everything comes from the plugin's own db_ tables through queries.json; the
   view never talks to MySQL. Setup lives on the Plugins page; here only ↻ - read the database
   now. The drift the Problems view carries (named in code but not in the database; in the
   database but touched by nothing) is repeated here in one line so it is seen where it is
   about. */
(function () {
  'use strict';
  /* THE OWNER'S CLOCK, NOT UTC's.
     Every time Cockpit shows comes off an ISO string, which is UTC; sliced raw it reads as tomorrow all evening. */
  function whenLocal(s) { if (!s) return ''; var t = new Date(s); return isNaN(t) ? String(s).slice(0, 16).replace('T', ' ') : t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function q(name, params) { var qs = params ? '?' + Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&') : ''; return fetch(Layout.state.api + '/plugins/database/q/' + name + qs).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'query failed'); return j.rows; }); }
  function ago(iso) { if (!iso) return ''; var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
  function bytes(n) { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB'; }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function json(s, d) { try { return JSON.parse(s); } catch (e) { return d; } }
  function when(s) { return s ? whenLocal(s) : ''; }

  var S = { list: null, meta: null, touched: {}, drift: { missing: [], untouched: {} }, q: '', sel: null, tab: 'rows', detail: null, detailFor: null, loading: false, err: null, scanning: false, stampSeen: null };
  function load() {
    if (S.loading) return; S.loading = true;
    Promise.all([q('tables'), q('meta'), q('touched').catch(function () { return []; }), q('drift').catch(function () { return []; })]).then(function (r) {
      S.list = r[0]; S.meta = {}; r[1].forEach(function (m) { S.meta[m.key] = m.value; });
      S.touched = {}; r[2].forEach(function (t) { (S.touched[t.name] = S.touched[t.name] || {})[t.kind] = t.n; });
      S.drift = { missing: [], untouched: {} }; r[3].forEach(function (d) { if (d.value === 'table-not-in-db') S.drift.missing.push(d.name); else S.drift.untouched[d.name] = d.why; });
      S.loading = false; S.err = null; Layout.refresh();
    }).catch(function (e) { S.list = []; S.meta = {}; S.err = e.message; S.loading = false; Layout.refresh(); });
  }
  function loadDetail(name) {
    if (S.loading) return; S.loading = true; S.detailFor = name;
    var p = { table: name };
    Promise.all([q('columns', p), q('indexes', p), q('keys', p), q('keys-in', p), q('peek', p), q('touched-by', p).catch(function () { return []; })]).then(function (r) {
      S.detail = { columns: r[0], indexes: r[1], keys: r[2], keysIn: r[3], peek: r[4][0] || null, files: r[5] };
      S.loading = false; Layout.refresh();
    }).catch(function (e) { S.detail = null; S.err = e.message; S.loading = false; Layout.refresh(); });
  }

  function codeCell(name) {
    var t = S.touched[name];
    if (S.drift.untouched[name]) return '<td class="many" title="' + esc(S.drift.untouched[name]) + '">nothing touches it</td>';
    if (!t) return '<td class="dim" title="not on the map - the Architecture plugin has not seen it, or is off">-</td>';
    var parts = []; if (t.reads) parts.push(t.reads + ' read'); if (t.writes) parts.push(t.writes + ' write'); if (t.defines) parts.push('defined');
    return '<td>' + esc(parts.join(' · ')) + '</td>';
  }
  function listHtml() {
    var m = S.meta, rows = S.list.filter(function (t) { return !S.q || t.name.toLowerCase().indexOf(S.q.toLowerCase()) >= 0; });
    var total = 0; S.list.forEach(function (t) { if (t.type === 'table') total += Number(t.rows) || 0; });
    var h = '<div class="tkhead"><b>' + esc(m.database) + '</b><span class="dim small">@ ' + esc(m.host) + (m.version ? ' · MySQL ' + esc(m.version) : '') + ' · ' + S.list.length + ' table' + (S.list.length === 1 ? '' : 's') + ' · ' + num(total) + ' rows</span><span class="ev">read ' + ago(m.scannedAt) + ' <span class="tkx" title="read the database now" data-h="rescan">↻</span></span></div>';
    if (S.drift.missing.length) h += '<div class="fnd warn small" style="margin:0 0 6px">The code names ' + S.drift.missing.length + ' table' + (S.drift.missing.length === 1 ? '' : 's') + ' the database does not hold: ' + S.drift.missing.map(esc).join(', ') + ' <span class="dim">- on Problems as table-not-in-db</span></div>';
    if (m.note) h += '<div class="small dim" style="margin:0 0 6px">' + esc(m.note) + '</div>';
    h += '<div class="cv-bar" style="margin-bottom:6px"><input id="dbq" placeholder="find a table" value="' + esc(S.q) + '" style="flex:1;font-size:12px;padding:3px 6px"><span class="dim small">' + rows.length + ' shown</span></div>';
    h += '<table class="tb"><thead><tr><th>table</th><th style="text-align:right">rows</th><th style="text-align:right">size</th><th style="text-align:right">columns</th><th>changed</th><th>code</th></tr></thead><tbody>';
    rows.forEach(function (t) {
      h += '<tr class="dbrow' + (S.drift.untouched[t.name] ? ' warn' : '') + '" data-t="' + esc(t.name) + '" style="cursor:pointer" title="open ' + esc(t.name) + '"><td><b>' + esc(t.name) + '</b>' + (t.type === 'view' ? ' <span class="lab">view</span>' : '') + (t.comment ? ' <span class="dim small">' + esc(t.comment) + '</span>' : '') + '</td>'
        + '<td style="text-align:right" title="' + (t.exact ? 'counted' : 'estimated - the table is too big to count every read') + '">' + num(t.rows) + (t.exact ? '' : ' <span class="dim">~</span>') + '</td><td style="text-align:right">' + bytes(Number(t.data_bytes) + Number(t.index_bytes)) + '</td><td style="text-align:right">' + t.columns + '</td><td class="dim">' + esc(when(t.updated || t.created)) + '</td>' + codeCell(t.name) + '</tr>';
    });
    h += '</tbody></table>';
    if (!rows.length) h += '<div class="muted small" style="margin-top:6px">' + (S.list.length ? 'no table matches' : 'the database has no tables') + '</div>';
    return h;
  }
  function detailHtml() {
    var t = S.list.find(function (x) { return x.name === S.sel; }) || { name: S.sel }, d = S.detail, pk = json(t.pk, []);
    var h = '<div class="tkhead"><a href="#" id="dbback" class="small">‹ all tables</a><b>' + esc(t.name) + '</b><span class="dim small">' + num(t.rows) + (t.exact ? '' : ' ~') + ' rows · ' + bytes(Number(t.data_bytes) + Number(t.index_bytes)) + (t.engine ? ' · ' + esc(t.engine) : '') + (pk.length ? ' · key ' + esc(pk.join(', ')) : ' · no primary key') + '</span><span class="ev">read ' + ago(S.meta.scannedAt) + '</span></div>';
    if (S.drift.untouched[t.name]) h += '<div class="fnd warn small" style="margin:0 0 6px">' + esc(S.drift.untouched[t.name]) + '</div>';
    if (!d) return h + '<div class="muted small">reading ' + esc(t.name) + '…</div>';
    var tabs = [['rows', 'Rows', d.peek ? json(d.peek.rows, []).length : 0], ['columns', 'Columns', d.columns.length], ['indexes', 'Indexes', d.indexes.length], ['keys', 'Keys', d.keys.length + d.keysIn.length], ['code', 'Code', d.files.length]];
    h += '<div class="cv-bar" style="margin-bottom:8px">' + tabs.map(function (x) { return '<button class="lensbtn' + (S.tab === x[0] ? ' on' : '') + '" data-tab="' + x[0] + '">' + x[1] + ' <span class="dim">' + x[2] + '</span></button>'; }).join('') + '</div>';
    if (S.tab === 'rows') {
      if (!d.peek) return h + '<div class="muted small">no rows were read for this table (the scan\'s note says why)</div>';
      var cols = json(d.peek.columns, []), rows = json(d.peek.rows, []);
      h += '<div class="small dim" style="margin-bottom:4px">' + (rows.length ? 'the ' + rows.length + (d.peek.order_by ? ' newest rows, by ' + esc(d.peek.order_by) + ' descending' : ' first rows') + ', as of ' + esc(when(d.peek.at)) + ' - press ↻ for now' : 'empty table') + '</div>';
      if (rows.length) {
        h += '<div style="overflow:auto;max-height:60vh"><table class="tb" style="width:max-content;min-width:100%"><thead><tr>' + cols.map(function (c) { return '<th style="white-space:nowrap">' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (r) { h += '<tr>' + r.map(function (v) { return v === null ? '<td class="dim">null</td>' : '<td style="white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis" title="' + esc(v) + '">' + esc(v) + '</td>'; }).join('') + '</tr>'; });
        h += '</tbody></table></div>';
      }
    } else if (S.tab === 'columns') {
      h += '<table class="tb"><thead><tr><th>#</th><th>column</th><th>type</th><th>null</th><th>default</th><th>key</th><th>extra</th><th>comment</th></tr></thead><tbody>';
      d.columns.forEach(function (c) { h += '<tr><td class="dim">' + c.position + '</td><td><b>' + esc(c.name) + '</b></td><td><code>' + esc(c.type) + '</code></td><td class="dim">' + (c.nullable ? 'yes' : '') + '</td><td>' + (c.dflt === null ? '<span class="dim">null</span>' : esc(c.dflt)) + '</td><td>' + esc(c.key) + '</td><td class="dim">' + esc(c.extra) + '</td><td class="dim">' + esc(c.comment) + '</td></tr>'; });
      h += '</tbody></table>';
    } else if (S.tab === 'indexes') {
      if (!d.indexes.length) h += '<div class="muted small">no indexes</div>';
      else { h += '<table class="tb"><thead><tr><th>index</th><th>columns</th><th>unique</th><th>type</th></tr></thead><tbody>'; d.indexes.forEach(function (i) { h += '<tr><td><b>' + esc(i.name) + '</b></td><td>' + esc(json(i.columns, []).join(', ')) + '</td><td class="dim">' + (i.is_unique ? 'yes' : '') + '</td><td class="dim">' + esc(i.type) + '</td></tr>'; }); h += '</tbody></table>'; }
    } else if (S.tab === 'keys') {
      if (!d.keys.length && !d.keysIn.length) h += '<div class="muted small">no foreign keys either way</div>';
      if (d.keys.length) { h += '<div class="small" style="margin:4px 0"><b>points at</b></div><table class="tb"><thead><tr><th>key</th><th>columns</th><th>to</th><th>on delete</th><th>on update</th></tr></thead><tbody>'; d.keys.forEach(function (k) { h += '<tr><td class="dim">' + esc(k.name) + '</td><td>' + esc(json(k.columns, []).join(', ')) + '</td><td><a href="#" class="dbgo" data-t="' + esc(k.ref_table) + '">' + esc(k.ref_table) + '</a> (' + esc(json(k.ref_columns, []).join(', ')) + ')</td><td class="dim">' + esc(k.on_delete) + '</td><td class="dim">' + esc(k.on_update) + '</td></tr>'; }); h += '</tbody></table>'; }
      if (d.keysIn.length) { h += '<div class="small" style="margin:8px 0 4px"><b>pointed at by</b></div><table class="tb"><thead><tr><th>table</th><th>columns</th><th>to</th><th>on delete</th></tr></thead><tbody>'; d.keysIn.forEach(function (k) { h += '<tr><td><a href="#" class="dbgo" data-t="' + esc(k.table_name) + '">' + esc(k.table_name) + '</a></td><td>' + esc(json(k.columns, []).join(', ')) + '</td><td class="dim">' + esc(json(k.ref_columns, []).join(', ')) + '</td><td class="dim">' + esc(k.on_delete) + '</td></tr>'; }); h += '</tbody></table>'; }
    } else if (S.tab === 'code') {
      if (!d.files.length) h += '<div class="muted small">' + (S.touched[t.name] ? 'nothing on the map names it' : 'nothing on the map reads, writes or defines this table' + (S.drift.untouched[t.name] ? '' : ' - or the Architecture plugin has not scanned yet')) + '</div>';
      else { h += '<table class="tb"><thead><tr><th>file</th><th>does</th></tr></thead><tbody>'; d.files.forEach(function (f) { h += '<tr><td>' + (window.openFile ? '<a href="#" class="dbfile" data-f="' + esc(f.file) + '">' + esc(f.file) + '</a>' : esc(f.file)) + '</td><td class="dim">' + esc(f.kind) + '</td></tr>'; }); h += '</tbody></table>'; }
    }
    return h;
  }

  /* A view on the Architecture tab, not a card of its own. In the bar while the Database plugin is on for the project. */
  window.ArchViews = window.ArchViews || {};
  window.ArchViews.database = { title: 'Database', hint: 'the live database: every table, its shape, what touches it, and its latest rows',
    on: function () { var pl = window.PluginUI && window.PluginUI.info('database'); return !!(pl && pl.selected); },
    render: function (el) {
      var pl = window.PluginUI && window.PluginUI.info('database');
      if (pl && !pl.configured) { el.innerHTML = '<div class="muted small">not set up yet - say where the database credentials are on the Plugins page (a .env with DB_*, or a PHP config file). MySQL only in this cut; a DATABASE_URL that is Postgres is reported, not read.</div>'; return; }
      var stamp = ((pl && pl.lastScan) || {}).finished || ''; if (S.stampSeen !== stamp) { S.stampSeen = stamp; S.list = null; S.detail = null; S.err = null; }   // a read finished: show it
      if (S.scanning) { el.innerHTML = '<div class="muted small">reading the database…</div>'; return; }
      if (!S.list) { load(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      if (S.err) { el.innerHTML = '<div class="small dim">' + esc(S.err) + ' - <a href="#" id="db-retry">try again</a></div>'; el.querySelector('#db-retry').addEventListener('click', function (e) { e.preventDefault(); S.list = null; S.err = null; load(); }); return; }
      if (!S.meta || !S.meta.scannedAt) { el.innerHTML = '<div class="muted small">the database has not been read yet' + (pl && pl.lastScan && !pl.lastScan.ok ? ' - the last read failed: ' + esc(pl.lastScan.note || '') :' - it will be within a minute, or press ↻') + '</div>'; return; }
      if (S.sel && S.detailFor !== S.sel && !S.loading) loadDetail(S.sel);
      if (!Layout.paint(el, S.sel ? detailHtml() : listHtml())) return;
      if (pl && pl.lastScan && !pl.lastScan.ok) el.insertAdjacentHTML('afterbegin', '<div class="fnd warn small" style="margin-bottom:6px">the last read failed: ' + esc(pl.lastScan.note || '') + ' - showing the read before it</div>');
      var rb = el.querySelector('[data-h="rescan"]'); if (rb) rb.onclick = function () { S.scanning = true; Layout.refresh(); window.PluginUI.scan('database', function () { S.scanning = false; S.list = null; S.detail = null; S.err = null; Layout.refresh(); }); };
      var fq = el.querySelector('#dbq'); if (fq) { fq.addEventListener('input', function () { S.q = fq.value; }); fq.addEventListener('keydown', function (e) { if (e.key === 'Enter') { fq.blur(); Layout.refresh(); } }); }
      el.querySelectorAll('.dbrow[data-t]').forEach(function (r) { r.addEventListener('click', function () { S.sel = r.dataset.t; S.tab = 'rows'; S.detail = null; S.detailFor = null; Layout.refresh(); }); });
      var back = el.querySelector('#dbback'); if (back) back.addEventListener('click', function (e) { e.preventDefault(); S.sel = null; S.detail = null; S.detailFor = null; Layout.refresh(); });
      el.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { S.tab = b.dataset.tab; Layout.refresh(); }); });
      el.querySelectorAll('.dbgo[data-t]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); S.sel = a.dataset.t; S.tab = 'rows'; S.detail = null; S.detailFor = null; Layout.refresh(); }); });
      el.querySelectorAll('.dbfile[data-f]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); window.openFile(a.dataset.f); }); });
    } };
  /* the timed re-read: only when a scan has finished since (the stamp), so the reader's place is never thrown */
  setInterval(function () { if (S.list && window.ROOM) { var pl = window.PluginUI && window.PluginUI.info('database'); var stamp = ((pl && pl.lastScan) || {}).finished || ''; if (stamp !== S.stampSeen) Layout.refresh(); } }, 60000);
})();
