/* The Project card - what this project IS to the engine: the folder, the .cockpit\ stamp,
   what plugins it has (none in milestone 1), and what its .cockpit\ holds. It is the
   card that proves the project model works before any plugin exists. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }   // always KB, so the rows compare at a glance

  /* ONE INSTANCE PER DESK CARD (Home step 1): bound to its project through ctx, so this card can sit on another
     project's desk - Home's - and read that project. */
  function Project(ctx0) {
  var X = ctx0;
    function render(el) {
      var r = X.room;
      if (!r) { el.innerHTML = '<div class="muted small">no project open</div>'; return; }
      if (r.missing) { el.innerHTML = '<div class="small" style="color:var(--red,#e5484d)">The folder is not there: <code>' + esc(r.path) + '</code><br>Moved, renamed, or the drive is off. Nothing was changed.</div>'; return; }
      var c = r.cockpit, k = r.contents;
      if (!Layout.paint(el, '<div class="kv">'
        + '<b>name</b><span>' + esc(r.name) + '</span>'
        + '<b>site</b><span>' + ((c.urls && c.urls.length) ? c.urls.map(function (u) { return '<a href="' + esc(u) + '" target="_blank">' + esc(u.replace(/^https?:\/\//, '')) + '</a>'; }).join(' <span class="dim">·</span> ') : '<span class="dim">none - set on the Plugins page</span>') + '</span>'
        + '<b>folder</b><code title="' + esc(r.path) + '">' + esc(r.path) + '</code>'
        + (r.realPath && r.realPath.toLowerCase() !== String(r.path).toLowerCase() ? '<b>really</b><code title="the folder above is a link; this is where the files are">' + esc(r.realPath) + '</code>' : '')
        + (r.host ? '<b>read on</b><span>' + esc(r.host) + ' <span class="dim">- the machine the engine runs on</span></span>' : '')
        + '<b>engine</b><span>' + esc(c.engine) + (c.upgradedFrom ? ' <span class="dim small">(upgraded from ' + esc(c.upgradedFrom) + ')</span>' : '') + '</span>'
        + '<b>created</b><span>' + esc(String(c.created).slice(0, 16).replace('T', ' ')) + '</span>'
        + '<b>type</b><span>' + (c.type ? esc(c.type) : '<span class="dim">not set - the Architecture wizard sets it</span>') + '</span>'
        + '<b>plugins</b><span>' + (c.plugins && c.plugins.length ? esc(c.plugins.join(', ')) : '<span class="dim">none selected</span>') + '</span>'
        + '<b>loaded</b><span>since ' + esc(String(r.loadedSince).slice(11, 19)) + ' · goes quiet after ' + r.engine.idleUnloadMinutes + ' min unlooked-at</span>'
        + '</div>'
        /* What .cockpit\ holds that the owner reads or edits (2026-09-16: the folder rows that
           meant nothing to him - conversations, decisions, logs, cache - are gone from here). */
        + '<div class="small dim" style="margin-top:10px">.cockpit\\ holds</div>'
        + '<div class="kv small">'
        + '<b>project.md</b><span><a href="#" data-open=".cockpit/project.md">open</a> · ' + kb(k['project.md']) + ' <span class="dim">- the project\'s rules and memory; every AI reads it every turn</span></span>'
        + '<b>cockpit.db</b><span>' + kb(k['cockpit.db']) + ' · ' + r.threads + ' conversation' + (r.threads === 1 ? '' : 's') + ' <span class="dim">- conversations, rulings, the map, plugin tables</span></span>'
        + '<b>plugins\\</b><span>' + k.plugins + ' file' + (k.plugins === 1 ? '' : 's') + ' <span class="dim">- each plugin\'s answers and this project\'s overrides</span></span>'
        + '</div>'
        /* The standing prompt: what every turn carries before the transcript, by tier. */
        + (r.prompt ? '<div class="small dim" style="margin-top:10px">every turn starts with</div><div class="kv small">'
            + r.prompt.parts.map(function (p) { return '<b>' + esc(p.tier) + '</b><span>' + kb(p.chars) + ' <span class="dim">' + esc(p.file) + '</span></span>'; }).join('')
            + '<b>total</b><span>' + kb(r.prompt.chars) + ' ≈ ' + (r.prompt.tokens >= 1000 ? (r.prompt.tokens / 1000).toFixed(1) + 'k' : r.prompt.tokens) + ' tokens <span class="dim">- then the conversation so far</span></span></div>' : '')
        /* Standing rulings: what conversations have recorded with `note`; carried into every later turn. */
        + '<div class="small dim" style="margin-top:10px">standing rulings <span class="dim">· ' + (r.rulings || []).length + '</span></div>'
        + ((r.rulings || []).length ? '<div class="small" style="max-height:140px;overflow:auto">' + r.rulings.map(function (n) { return '<div style="padding:2px 0;border-bottom:1px solid var(--line)">' + esc(n.text) + ' <span class="dim">- ' + esc(n.by || '') + ', ' + esc(isNaN(new Date(n.at)) ? String(n.at).slice(0, 10) : new Date(n.at).toLocaleDateString('en-US')) + (n.title ? ', in "' + esc(n.title) + '"' : '') + '</span></div>'; }).join('') + '</div>'
            : '<div class="small dim">none yet - a conversation records one with the note command; it is then in every later turn</div>')
        + '<div class="small" style="margin-top:10px"><a href="#" id="forgetlink" class="dim">Forget this project</a> <span class="dim">- stops listing it; the folder is untouched</span></div>')) return;
      setTimeout(function () { Layout.snug(X.key); }, 0);   // as wide as its column, as tall as its content (which varies by project)
      var fl = el.querySelector('#forgetlink'); if (fl) fl.addEventListener('click', function (e) { e.preventDefault(); if (X.own) window.forgetProject(); else if (window.openProject) window.openProject(X.project); });
      el.querySelectorAll('a[data-open]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); if (!X.own) { if (window.openProject) window.openProject(X.project); return; } if (window.openFile) window.openFile(a.dataset.open); }); });
    }
    return { render: render, use: function (c) { X = c; }, poke: function () {  } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('project') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Project(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'project', notHome: true, icon: '🗂', title: 'Project stats', purpose: 'the facts of this project: folder, site, plugins, what every AI turn starts with, standing rulings', zone: 'right', pos: 0, size: [5, 11], min: [4, 6], max: [12, 20], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
})();
