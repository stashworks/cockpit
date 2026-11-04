/* The File card - one file's contents, in the centre column, opened by a click in the
   Files tree. Hidden until a file is opened; the x hides it again and
   the column closes up (the layout engine gives a hidden card no space). Read-only: this
   is a viewer, and editing is the AI's job through the conversation, not a text box here. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function kb(n) { return n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  window.FILE = null;   // { path, size, at, text, binary, truncated, error }

  window.openFile = function (rel) {
    window.FILE = { path: rel, loading: true };
    Layout.show('file', true);
    Layout.refresh();
    fetch(Layout.state.api + '/file?path=' + encodeURIComponent(rel)).then(function (r) { return r.json(); })
      .then(function (r) { window.FILE = r.ok ? r : { path: rel, error: r.error || 'could not read' }; Layout.refresh(); })
      .catch(function (e) { window.FILE = { path: rel, error: String(e) }; Layout.refresh(); });
  };

  Layout.register({ id: 'file', icon: '📄', title: 'File', purpose: 'one file in full, opened from the Folder tree or the map', zone: 'stage', pos: -1, size: [12, 18], min: [6, 6], max: [12, 40], hiddenByDefault: true,
    render: function (el) {
      var f = window.FILE;
      var hd = el.parentElement && el.parentElement.querySelector('.ch .more');
      if (hd) hd.innerHTML = '<span class="tkx" title="close">✕</span>';
      var x = hd && hd.querySelector('.tkx'); if (x) x.onclick = function () { Layout.show('file', false); };
      if (!f) { el.innerHTML = '<div class="muted small">click a file in the Folder tree to open it here</div>'; return; }
      var head = '<div class="fhead"><code>' + esc(f.path) + '</code>' + (f.size != null ? '<span class="dim small">' + kb(f.size) + (f.at ? ' · ' + esc(String(f.at).slice(0, 16).replace('T', ' ')) : '') + '</span>' : '') + '</div>';
      if (f.loading) { el.innerHTML = head + '<div class="dim small">reading…</div>'; return; }
      if (f.error) { el.innerHTML = head + '<div class="small" style="color:var(--red,#e5484d)">' + esc(f.error) + '</div>'; return; }
      if (f.binary) { el.innerHTML = head + '<div class="dim small">binary file - not shown as text</div>'; return; }
      var tk = (f.inTicket && f.inTicket.length ? '<span class="lg ok sm" title="in a ticket now">' + f.inTicket.map(function (t) { return esc(t.ticket); }).join(' ') + '</span> ' : '') + (f.ticketsTouched && f.ticketsTouched.length ? '<span class="dim small" title="commits naming a ticket that touched this file">touched by ' + f.ticketsTouched.map(function (t) { return '<b>' + esc(t.ticket) + '</b> (' + t.commits + ', ' + esc(t.last) + ')'; }).join(', ') + '</span>' : '<span class="dim small">no ticket has touched this file (commits naming #n)</span>');
      head += '<div class="small" style="margin:2px 0 6px">' + tk + '</div>';
      var lines = f.text.split('\n');
      var body = lines.map(function (l, i) { return '<span class="ln">' + (i + 1) + '</span>' + esc(l); }).join('\n');
      el.innerHTML = head + '<pre class="fbody">' + body + '</pre>' + (f.truncated ? '<div class="dim small">showing the first 2 MB of ' + kb(f.size) + '</div>' : '');
    } });
})();
