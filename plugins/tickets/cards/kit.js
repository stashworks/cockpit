/* The small kit the Tickets cards share. Facts are Cockpit's own:
   the ticket files through /tickets, the tk_ tables through the plugin's named queries. GitHub is a hook, reached
   only when its plugin is on and set up: the issues there that Cockpit has no ticket for join the rows, placed by
   the stage the GitHub plugin derived from their PRs; the PRs that name a ticket show on the ticket.

   Every row, from either source, has ONE shape:
     { id, number, title, state, col, feature, who, updated, url, gh, rule }
   id is the ticket id ("L2", "123") or "gh:123" for a GitHub-only issue; col is the board column.

   Reached lazily (inside render, never at load): the shell loads a plugin's card files in parallel. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u) { return fetch(u).then(function (r) { return r.json(); }); };
  var qs = function (params) { return params ? '?' + Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&') : ''; };
  /* a GitHub-only issue lands in the column its PR evidence puts it (the github plugin's stages.json) */
  var GH_STAGE = { 'not started': 'created', 'in progress': 'in-work', 'in review': 'in-work', 'in uat': 'verified', 'verified': 'passed', 'live': 'promoted', 'done': 'closed' };
  var COLS = [
    { key: 'draft', title: 'waiting on you' }, { key: 'created', title: 'to work' }, { key: 'in-work', title: 'in work' },
    { key: 'verified', title: 'verified' }, { key: 'passed', title: 'passed' }, { key: 'promoted', title: 'promoted' }, { key: 'closed', title: 'closed' }
  ];
  /* Every reader takes an optional ctx (Home step 1, 2026-09-19): the desk hands a card the project it is for -
     {api, room, project} - so a card on another project's desk reads THAT project. No ctx = the open project. */
  var caches = {};   // per project api base: { at, rows, pending, github }
  function apiOf(ctx) { return (ctx && ctx.api) || Layout.state.api; }
  function roomOf(ctx) { return (ctx && ctx.room) || window.ROOM; }
  function plug(ctx, name) { return ((((roomOf(ctx) || {}).plugins || {}).available) || []).find(function (p) { return p.name === name; }) || null; }
  window.TicketCards = window.TicketCards || {
    esc: esc, COLS: COLS, GH_STAGE: GH_STAGE,
    q: function (name, params, ctx) { return api(apiOf(ctx) + '/plugins/tickets/q/' + name + qs(params)).then(function (r) { if (!r.ok) throw new Error(r.error || 'read failed'); return r.rows; }); },
    ghq: function (name, params, ctx) { return api(apiOf(ctx) + '/plugins/github/q/' + name + qs(params)).then(function (r) { if (!r.ok) throw new Error(r.error || 'read failed'); return r.rows; }); },
    on: function (ctx) { var pl = plug(ctx, 'tickets'); return !!(pl && pl.selected); },
    ghOn: function (ctx) { var pl = plug(ctx, 'github'); return !!(pl && pl.selected && pl.configured); },
    /* every ticket as a row, both sources, cached half a minute per project */
    rows: function (force, ctx) {
      var K = window.TicketCards, pid = apiOf(ctx), cache = caches[pid] || (caches[pid] = { at: 0, rows: null, pending: null, github: false });
      if (!force && cache.rows && Date.now() - cache.at < 30000) return Promise.resolve(cache.rows);
      if (cache.pending) return cache.pending;
      cache.pending = Promise.all([
        api(pid + '/tickets').then(function (r) { cache.github = !!r.github; return r.ok ? r.tickets : []; }),
        K.ghOn(ctx) ? K.ghq('pipeline', null, ctx).catch(function () { return []; }) : Promise.resolve([])
      ]).then(function (x) {
        var mine = x[0], nums = {}; mine.forEach(function (t) { if (t.number) nums[t.number] = 1; });
        var rows = mine.map(function (t) { return { id: t.id, number: t.number || null, title: t.title, state: t.state, col: t.state === 'rejected' ? 'closed' : t.state, feature: t.feature || null, who: t.state === 'draft' || t.state === 'verified' || t.state === 'passed' ? 'you' : (t.by || 'you'), by: t.by || null, updated: t.updated || t.created, created: t.created, url: t.url || null, gh: false, rule: null, band: t.band || null, finding: t.finding || null }; });
        x[1].forEach(function (g) { if (nums[g.number]) return; var who = []; try { who = JSON.parse(g.assignees || '[]'); } catch (e) { /* */ }
          rows.push({ id: 'gh:' + g.number, number: g.number, title: g.title, state: g.stage || 'open', col: GH_STAGE[g.stage] || 'created', feature: g.module || null, who: who[0] || 'nobody', by: null, updated: g.updated, created: null, url: g.url, gh: true, rule: g.stage_rule || null }); });
        cache.rows = rows; cache.at = Date.now(); cache.pending = null; return rows;
      }).catch(function (e) { cache.pending = null; throw e; });
      return cache.pending;
    },
    github: function (ctx) { var c = caches[apiOf(ctx)]; return !!(c && c.github); },
    forget: function (ctx) { var c = caches[apiOf(ctx)]; if (c) { c.rows = null; c.at = 0; } },
    ticket: null,   // the one the Ticket card shows
    /* open a ticket: on the board, in full, where its moves are; the Ticket card follows if it is showing */
    openTicket: function (id, ctx) {
      window.TicketCards.ticket = String(id);
      // another project's ticket (its card on this desk): go into that project; its board opens the ticket on arrival
      if (ctx && !ctx.own && ctx.project && window.openProject) { window.openProject(ctx.project); return; }
      if (window.__tickets) { if (Layout.isHidden && Layout.isHidden('tickets')) Layout.show('tickets', true); window.__tickets.open(String(id)); }   // the board's ticket page is the one place a ticket opens (the Ticket card went 2026-09-20)
      Layout.refresh();
    },
    ago: function (iso) { if (!iso) return ''; var d = Math.round((Date.now() - Date.parse(iso)) / 864e5); return d < 1 ? 'today' : d === 1 ? 'yesterday' : d + ' d'; },
    days: function (iso) { return iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : 0; },
    notOn: function (el, ctx) { el.innerHTML = '<div class="muted small">the Tickets plugin is off for ' + (ctx && !ctx.own ? 'that project' : 'this project') + ' - Settings › Plugins and cards</div>'; }
  };
})();
