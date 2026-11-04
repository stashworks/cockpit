/* The Files card - the project tree, the way VS Code's explorer shows it.
   Every project has it; it is the engine's, not a plugin's. Folders load when opened, so a
   large tree costs one request per folder you actually look into. Which folders are open
   is remembered per project for the life of the page. Clicking a file opens it in the
   File card on the stage. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function kb(n) { return n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  // Folders that are machinery, not the project: shown, but dimmed and never auto-expanded.
  var DIM = { '.git': 1, node_modules: 1, '.vscode': 1, '__pycache__': 1, dist: 1, build: 1 };   // .cockpit is the project's own Cockpit folder - shown plain and open by default

  /* ONE INSTANCE PER DESK CARD (Home step 1): bound to its project through ctx, so this card can sit on another
     project's desk - Home's - and read that project. */
  function Files(ctx0) {
  var X = ctx0;
  var T = { project: null, open: {}, cache: {} };   // open: relPath -> true; cache: relPath -> entries

  function load(rel) {
    return fetch(X.api + '/files?path=' + encodeURIComponent(rel)).then(function (r) { return r.json(); })
      .then(function (r) { T.cache[rel] = r.ok ? r.entries : { error: r.error || 'unreadable' }; return T.cache[rel]; });
  }

  function row(rel, e, depth) {
    var p = rel ? rel + '/' + e.name : e.name;
    var pad = 'style="padding-left:' + (8 + depth * 14) + 'px"';
    if (e.dir) {
      var isOpen = !!T.open[p];
      return '<div class="fr dir' + (DIM[e.name] ? ' dim' : '') + '" data-p="' + esc(p) + '" ' + pad + '><span class="tw">' + (isOpen ? '▾' : '▸') + '</span><span class="fn">' + esc(e.name) + '</span></div>'
        + (isOpen ? children(p, depth + 1) : '');
    }
    return '<div class="fr file" data-p="' + esc(p) + '" ' + pad + ' title="' + esc(p) + (e.size != null ? ' · ' + kb(e.size) : '') + '"><span class="tw"></span><span class="fn">' + esc(e.name) + '</span><span class="fs">' + kb(e.size) + '</span></div>';
  }
  function children(rel, depth) {
    var c = T.cache[rel];
    if (!c) { load(rel).then(function () { Layout.refresh(); }); return '<div class="fr dim" style="padding-left:' + (8 + depth * 14) + 'px">…</div>'; }
    if (c.error) return '<div class="fr dim" style="padding-left:' + (8 + depth * 14) + 'px">cannot read: ' + esc(c.error) + '</div>';
    if (!c.length) return '<div class="fr dim" style="padding-left:' + (8 + depth * 14) + 'px">empty</div>';
    return c.map(function (e) { return row(rel, e, depth); }).join('');
  }

    function render(el) {
      var r = X.room;
      if (!r || r.missing) { el.innerHTML = '<div class="muted small">no project open</div>'; return; }
      if (T.project !== r.id) { T.project = r.id; T.open = { '.cockpit': true }; T.cache = {}; T.version = r.version; }   // a different project: a different tree, .cockpit open
      if (r.version !== T.version) { T.version = r.version; T.cache = {}; }   // the project moved (a turn touched files, a scan landed): read the folders again, keep them open
      var hd = el.parentElement && el.parentElement.querySelector('.ch .more');
      if (hd && !hd.querySelector('[data-h="files-refresh"]')) { hd.insertAdjacentHTML('beforeend', '<span class="tkx" title="read the folder again" data-h="files-refresh">↻</span>'); hd.querySelector('[data-h="files-refresh"]').addEventListener('click', function () { T.cache = {}; Layout.refresh(); }); }
      var top = T.cache[''];
      var count = top && !top.error ? top.length + ' at the top level' : '';
      el.innerHTML = '<div class="ftree">' + children('', 0) + '</div>' + (count ? '<div class="small dim" style="margin-top:6px">' + count + '</div>' : '');
      el.querySelectorAll('.fr.file').forEach(function (f) {
        f.addEventListener('click', function () { if (!X.own) { if (window.openProject) window.openProject(X.project); return; } if (window.openFile) window.openFile(f.dataset.p); });   // another project's file: go into that project
      });
      el.querySelectorAll('.fr.dir').forEach(function (d) {
        d.addEventListener('click', function () { var p = d.dataset.p; T.open[p] = !T.open[p]; Layout.refresh(); });
      });
    }
    return { render: render, use: function (c) { X = c; }, poke: function () {  } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('files') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Files(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'files', notHome: true, icon: '📁', title: 'Folder tree', purpose: 'the project folder as it is on disk; click a file to read it (the File card) and to put it in front of the AI', zone: 'left', pos: 0, size: [5, 22], min: [4, 6], max: [12, 40], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
})();
