/* Needs attention - what is waiting and on whom, decisions first, because a list that leads with what the AI is
   chewing on buries the things only a person can move. Derived here from Cockpit's own tickets:
     decide   a draft waits for your approve / reject; a verified ticket waits for your pass / send back
     start    approved and nobody has started it - Work it, on the board
     stuck    in work for days with no move
     deploy   passed - goes out with the next promote
   With the GitHub plugin on, what its scan found stuck there (failing PRs, blocked issues, local-model PRs waiting for
   a frontier) joins the list in its own groups. The summary line doubles as the filter by who.
   ONE INSTANCE PER DESK CARD (Home step 1, 2026-09-19): bound to its project(s) through ctx. A card for SEVERAL
   projects (key tk-attention@a+b) shows them all, each item wearing its project; a control on it splits it into one
   card per project, and the per-project cards offer to merge back (one control combines them into one card, and
   splits them back up). */
(function () {
  'use strict';
  var K = function () { return window.TicketCards; };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var GROUPS = [
    { kind: 'decide', title: 'Decisions - yours', help: 'only you can move these: approve or reject a draft, pass or send back what Cockpit verified' },
    { kind: 'start', title: 'To be worked', help: 'approved, not started - open one on the board and press Work it' },
    { kind: 'stuck', title: 'In work, quiet', help: 'no move in days - look at the conversation on it' },
    { kind: 'deploy', title: 'Waiting for the promote', help: 'passed on the step before prod; the promote records them' }
  ];
  var QUIET_DAYS = 3;
  /* one project's items, read through the kit with that project's ctx */
  function readOne(pctx) {
    var k = K();
    return Promise.all([k.rows(true, pctx), k.ghOn(pctx) ? Promise.all([k.ghq('attention', null, pctx), k.ghq('meta', null, pctx)]).catch(function () { return [[], []]; }) : Promise.resolve([[], []])]).then(function (x) {
      var items = [];
      x[0].forEach(function (r) {
        if (r.gh) return;
        if (r.state === 'draft') items.push({ kind: 'decide', who: 'you', id: r.id, title: r.title, text: 'drafted' + (r.by ? ' by ' + r.by : '') + ' ' + k.ago(r.created) + ' - approve or reject it' });
        else if (r.state === 'verified') items.push({ kind: 'decide', who: 'you', id: r.id, title: r.title, text: 'verified by Cockpit ' + k.ago(r.updated) + ' - pass it, or send it back' });
        else if (r.state === 'created') items.push({ kind: 'start', who: 'you', id: r.id, title: r.title, text: 'approved ' + k.ago(r.created) + ', not started' });
        else if (r.state === 'in-work' && k.days(r.updated) >= QUIET_DAYS) items.push({ kind: 'stuck', who: r.by || 'you', id: r.id, title: r.title, text: 'in work ' + k.days(r.updated) + ' days with no move' });
        else if (r.state === 'passed') items.push({ kind: 'deploy', who: 'you', id: r.id, title: r.title, text: 'passed ' + k.ago(r.updated) });
      });
      var ghGroups = []; var meta = {}; (x[1][1] || []).forEach(function (m) { meta[m.key] = m.value; });
      try { ghGroups = JSON.parse(meta.groups || '[]'); } catch (e) { ghGroups = []; }
      (x[1][0] || []).forEach(function (i) { items.push({ kind: 'gh:' + i.kind, who: i.who, id: i.what === 'ticket' && i.number ? (x[0].some(function (r) { return r.number === i.number && !r.gh; }) ? String(i.number) : 'gh:' + i.number) : null, url: i.url, title: i.title, text: i.text }); });
      items.forEach(function (i) { i.project = pctx.project; });
      return { items: items, ghGroups: ghGroups };
    });
  }
  function Attention(ctx0) {
    var X = ctx0;
    var S = { items: null, groups: [], who: null, open: { decide: true, start: true }, loading: false, err: null, at: 0 };
    // the ctx for one of this card's projects (the own project keeps the desk's ctx; another gets its own api/room)
    function pctx(p) { return p === X.project ? X : { key: X.key, project: p, projects: [p], api: '/api/p/' + p, room: (X.rooms || {})[p] || null, rooms: X.rooms, own: false }; }
    function projName(p) { var r = p === X.project && X.own ? window.ROOM : (X.rooms || {})[p]; return (r && r.name) || p; }
    function load() {
      if (S.loading) return; S.loading = true;
      Promise.all(X.projects.map(function (p) { return readOne(pctx(p)).catch(function (e) { return { items: [], ghGroups: [], err: p + ': ' + e.message }; }); })).then(function (parts) {
        var items = [], gh = {}, errs = [];
        parts.forEach(function (r) { items = items.concat(r.items); r.ghGroups.forEach(function (g) { gh[g.kind] = g; }); if (r.err) errs.push(r.err); });
        S.groups = GROUPS.concat(Object.keys(gh).map(function (k) { var g = gh[k]; return { kind: 'gh:' + g.kind, title: g.title + ' (GitHub)', help: g.help }; }));
        S.items = items; S.err = errs.length && !items.length ? errs.join(' · ') : null; S.at = Date.now();
      }).then(function () { S.loading = false; Layout.refresh(); });
    }
    /* the control on a several-projects card: one card ← → per project; on a single foreign card: merge with the
       other Needs attention cards on this desk (Home is where these live; the desk's own card stays its own) */
    function splitMerge() {
      var many = X.projects.length > 1;
      var siblings = window.Layout && Layout.instances ? Layout.instances().filter(function (k) { return k !== X.key && k.indexOf('tk-attention@') === 0; }) : [];
      if (many) return '<div class="att-sm"><span class="lensbtn on" title="all of them in this one card">one card</span><button class="lensbtn" data-att="split" title="one Needs attention card per project, dealt beside this one">per project</button></div>';
      if (!X.own && siblings.length) return '<div class="att-sm"><button class="lensbtn" data-att="merge" title="one card for all the Needs attention cards on this desk">one card</button><span class="lensbtn on">per project</span></div>';
      return '';
    }
    function render(el) {
      var k = K(); if (!k) return;
      var offs = X.projects.filter(function (p) { return !k.on(pctx(p)); });
      if (offs.length === X.projects.length) { k.notOn(el, X); return; }
      if (!S.items) { load(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      if (S.err) { el.innerHTML = '<div class="small dim">' + esc(S.err) + ' - <a href="#" class="tka-retry">try again</a></div>'; el.querySelector('.tka-retry').addEventListener('click', function (e) { e.preventDefault(); S.items = null; load(); }); return; }
      var items = S.items, many = X.projects.length > 1;
      var h = splitMerge();
      if (!items.length) { el.innerHTML = h + '<div class="muted small">nothing is waiting on anyone' + (many ? ' across ' + X.projects.length + ' projects' : '') + '</div>'; wire(el); return; }
      var byWho = {}; items.forEach(function (i) { byWho[i.who] = (byWho[i.who] || 0) + 1; });
      var whos = Object.keys(byWho).sort(function (a, b) { return a === 'you' ? -1 : b === 'you' ? 1 : byWho[b] - byWho[a]; });
      var shown = S.who ? items.filter(function (i) { return i.who === S.who; }) : items;
      h += '<div class="attsum"><span class="who all' + (S.who ? '' : ' on') + '" data-who="">everyone <b>' + items.length + '</b></span>'
        + whos.map(function (w) { return '<span class="who' + (w === 'you' ? ' me' : '') + (S.who === w ? ' on' : '') + '" data-who="' + esc(w) + '">' + esc(w === 'nobody' ? 'unowned' : w) + ' <b>' + byWho[w] + '</b></span>'; }).join('') + '</div>';
      if (S.who) h += '<div class="atthint">showing only what <b>' + esc(S.who) + '</b> has to move - click <b>everyone</b> to clear</div>';
      S.groups.forEach(function (g) {
        var rows = shown.filter(function (i) { return i.kind === g.kind; }); if (!rows.length) return;
        var open = S.who ? true : !!S.open[g.kind];
        h += '<div class="attg' + (open ? ' open' : '') + '" data-g="' + esc(g.kind) + '"><span class="car">' + (open ? '▾' : '▸') + '</span><b>' + esc(g.title) + '</b><span class="n">' + rows.length + '</span></div>';
        if (!open) return;
        if (g.help) h += '<div class="atthint">' + esc(g.help) + '</div>';
        h += rows.map(function (i) { return '<div class="att" data-id="' + esc(i.id || '') + '" data-p="' + esc(i.project) + '" data-url="' + esc(i.url || '') + '"><div>' + (many ? '<span class="att-proj">' + esc(projName(i.project)) + '</span>' : '') + '<b>' + esc(i.title) + '</b><span class="muted">' + esc(i.text) + '</span></div></div>'; }).join('');
      });
      if (S.who && !shown.length) h += '<div class="muted small">nothing is waiting on ' + esc(S.who) + '</div>';
      if (offs.length) h += '<div class="small dim" style="margin-top:6px">no Tickets plugin on ' + offs.map(projName).map(esc).join(', ') + '</div>';
      h += '<div class="small dim" style="margin-top:6px">read ' + new Date(S.at).toLocaleTimeString('en-US') + '</div>';
      if (!Layout.paint(el, h)) return;
      setTimeout(function () { Layout.snug(X.key); }, 0);   // as tall as its list
      wire(el);
    }
    function wire(el) {
      el.querySelectorAll('.attsum .who').forEach(function (c) { c.addEventListener('click', function () { S.who = c.dataset.who || null; Layout.refresh(); }); });
      el.querySelectorAll('.attg[data-g]').forEach(function (x) { x.addEventListener('click', function () { S.open[x.dataset.g] = !S.open[x.dataset.g]; Layout.refresh(); }); });
      el.querySelectorAll('.att').forEach(function (x) { x.addEventListener('click', function () { if (x.dataset.id) K().openTicket(x.dataset.id, pctx(x.dataset.p)); else if (x.dataset.url) window.open(x.dataset.url, '_blank'); }); });
      var sp = el.querySelector('[data-att="split"]'); if (sp) sp.addEventListener('click', function () {
        var ps = X.projects.slice(), key = X.key;
        Promise.all(ps.map(function (p) { return Layout.add('tk-attention', [p]); })).then(function () { Layout.remove(key); });
      });
      var mg = el.querySelector('[data-att="merge"]'); if (mg) mg.addEventListener('click', function () {
        var keys = Layout.instances().filter(function (k) { return k.indexOf('tk-attention@') === 0; }), ps = [];
        keys.forEach(function (k) { k.slice('tk-attention@'.length).split('+').forEach(function (p) { if (ps.indexOf(p) < 0) ps.push(p); }); });
        Layout.add('tk-attention', ps).then(function () { keys.forEach(function (k) { Layout.remove(k); }); });
      });
    }
    return { render: render, use: function (c) { X = c; }, poke: function () { if (S.items) { S.items = null; load(); } } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('tk-attention') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Attention(ctx); I.use(ctx); return I; }
  /* RETIRED as a desk card. It answered "where is
     everything" while reading like a to-do list, and its four groups mixed what only the owner could move
     in with what the coders already had - 51 rows against 8 that were actually the owner's. The board's
     "waiting on you" column is the one list of his work, and it is the one to trust.
     The card is not registered, so it cannot be added to a desk. Nothing is deleted: the component
     below still builds, and re-registering is one line if it is ever wanted back. */
  void inst;
})();
