/* The Agent fleet card - GLOBAL, the same on every project's room, top of the left column,
   locked. One block per agent: avatar · name · on/off · pause on ONE line; under it why it is in that
   state and since when; then NOW: with a caret that opens the agent's queue. Every line that
   names work reads "project - title". Below the agents, the one queue across projects with
   add / reorder / priority / park / filter. Pause = finish what it is on, then take nothing;
   the engine and every conversation carry on. Every agent ships OFF. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
  var post = function (u, b) { return api(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); };
  var F = { s: null, open: {}, qopen: false, filter: 'all', filterBy: {}, adding: false, showDone: false, usePop: null };
  var TIERS = ['next', 'P1', 'P2', 'P3'];
  var GONE = ['done', 'failed', 'merged', 'closed', 'handed'];   // handed: now someone else's ticket (engine/ghqueue.js)   // off the queue: finished, given up, in UAT, or the ticket closed (shown with "done" ticked)
  var AVATAR = { 'claude-code': 'C', 'codex-cli': 'X', pi: 'L' };
  var NO_PLAN = { pi: true };   // runs on the owner's hardware: nothing to run out of

  /* USAGE LEFT, next to the agent. One pill per agent: the plan's own
     reading, its reset, and how old the reading is - a number without its age would be a
     lie by tomorrow. Click the pill for the detail popup. */
  /* when a reading resets: the harness gives a time, a hand-entered one gives words */
  function resetsText(u) {
    if (u.resets) return u.resets;
    if (!u.resetsAt) return '';
    var d = new Date(u.resetsAt), ms = u.resetsAt - Date.now();
    if (ms < 0) return 'reset due';
    return ms < 20 * 3600e3 ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
  function usePill(a) {
    if (NO_PLAN[a.id]) return '<span class="fa-use free" title="local model - no plan to run out of">no cap</span>';
    var u = a.usage;
    if (!u) return '<span class="fa-use none" data-use="' + esc(a.id) + '" title="no reading yet' + (a.canProbeUsage ? ' - the harness is asked at start and every 10 min; click to ask now' : '') + '">usage?</span>';
    var src = u.source === 'harness' ? 'from the harness' : 'entered by hand';
    var lvl = u.leftPct <= 10 ? 'crit' : u.leftPct <= 30 ? 'low' : 'ok';
    if (u.locked) lvl = 'crit';
    var age = ago(u.readAt), stale = u.source !== 'harness' && (Date.now() - Date.parse(u.readAt)) > 12 * 3600e3;
    var rs = resetsText(u), wins = (u.windows || []).map(function (w) { return w.name + ' ' + (100 - w.usedPct) + '% left' + (w.resetsAt ? ', resets ' + resetsText({ resetsAt: w.resetsAt }) : ''); }).join('; ');
    return '<span class="fa-use ' + lvl + (stale ? ' stale' : '') + '" data-use="' + esc(a.id) + '" title="' + u.leftPct + '% of the plan left' + (u.window ? ' (' + esc(u.window) + ' window)' : '') + (rs ? ', resets ' + esc(rs) : '') + ' - ' + src + ' ' + age + ' ago.' + (wins ? ' ' + esc(wins) + '.' : '') + (u.plan ? ' Plan: ' + esc(u.plan) + '.' : '') + (u.locked ? ' LOCKED: ' + esc(u.locked) + '.' : '') + ' Click for detail.">'
      + '<i style="width:' + u.leftPct + '%"></i><b>' + u.leftPct + '%</b>' + (rs ? ' <span class="dim">· ' + esc(rs) + '</span>' : '') + '</span>';
  }
  /* THE POPUP. Click the pill: every window the plan reports, its reset,
     the plan, where the reading came from and how old it is, and a refresh. No typing. */
  function usePop(a) {
    var u = a.usage || {}, wins = u.windows || [];
    var h = '<div class="fa-pop" data-pop="' + esc(a.id) + '"><div class="fa-pop-hd"><b>' + esc(a.label) + '</b><span class="dim small" style="margin-left:auto">' + (u.readAt ? 'read ' + ago(u.readAt) + ' ago' : 'no reading') + '</span></div>';
    if (wins.length) {
      wins.forEach(function (w) {
        var left = 100 - w.usedPct, lvl = left <= 10 ? 'crit' : left <= 30 ? 'low' : 'ok';
        h += '<div class="fa-pop-w"><span class="fa-pop-n">' + esc(w.name) + '</span><span class="fa-pop-bar ' + lvl + '"><i style="width:' + w.usedPct + '%"></i></span><b>' + left + '%</b><span class="dim small">left' + (w.resetsAt ? ' · resets ' + esc(resetsText({ resetsAt: w.resetsAt })) : '') + (w.locked ? ' · LOCKED ' + esc(w.locked) : '') + '</span></div>';
      });
    } else if (u.leftPct != null) h += '<div class="fa-pop-w"><span class="fa-pop-n">plan</span><b>' + u.leftPct + '%</b><span class="dim small">left' + (u.resets ? ' · resets ' + esc(u.resets) : '') + '</span></div>';
    else h += '<div class="small dim">nothing reported yet</div>';
    h += '<div class="fa-pop-ft small dim">' + (u.plan ? 'plan ' + esc(u.plan) + ' · ' : '') + (u.source === 'harness' ? 'reported by the harness' : u.source ? 'entered by hand' : '') + '<span style="flex:1"></span>' + (a.canProbeUsage ? '<a href="#" class="fa-useask">refresh</a>' : '') + '</div></div>';
    return h;
  }

  /* the 15 s re-read redraws ONLY when the fleet changed: a refresh redraws every card, and it threw the reader of a
     conversation back to the bottom every 15 s */
  /* LIGHT POLL (2026-09-29, the tab that ran out of memory): the full fleet is ~1.35 MB (659 items; ~1 MB of it the work
     orders and outcome texts) and this polled it every 15 s - ~320 MB an hour. The poll is ?brief=1 now; the full items are
     read only while the QUEUE list is open (the only place that shows a work order or an outcome text), and only again when
     something in the queue moved. The brief fields win; the full one only adds text / outcome details. */
  function load() {
    return api('/api/fleet?brief=1').then(function (b) {
      var sig = JSON.stringify((b.items || []).map(function (i) { return [i.id, i.status, i.claimedBy, i.turns, i.priority, i.agent, i.title, i.outcome && i.outcome.reason]; }));
      var fetchFull = F.qopen && (sig !== F.sig || !F.full);
      return (fetchFull ? api('/api/fleet') : Promise.resolve(null)).then(function (full) {
        if (full) { F.full = full; F.sig = sig; }
        var byId = {}; ((F.qopen && F.full && F.full.items) || []).forEach(function (i) { byId[i.id] = i; });
        var s = Object.assign({}, b, { items: (b.items || []).map(function (i) { var f = byId[i.id]; return f ? Object.assign({}, f, i, { outcome: f.outcome || i.outcome }) : i; }) });
        var was = F.s ? JSON.stringify(F.s) : null; F.s = s; if (JSON.stringify(s) !== was) Layout.refresh();
      });
    });
  }
  function hhmm(iso) { try { return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function ago(iso) { var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min' : Math.round(m / 60) + ' h'; }
  function tier(i) { return TIERS.indexOf(i.priority) < 0 ? 3 : TIERS.indexOf(i.priority); }
  /* the items this agent would take, in the order it would take them */
  function queueFor(a, items) { return items.filter(function (i) { return i.status === 'queued' && (!a.projects || a.projects.indexOf(i.project) >= 0); }); }
  function line(i) { return '<span class="fa-proj">' + esc(i.project) + '</span> - ' + (i.ticket ? '<a href="#" class="fl-tk" data-tk="' + esc(i.ticket) + '" data-tkp="' + esc(i.project) + '" title="the ticket in full">' + esc(i.title) + '</a>' : esc(i.title)) ; }

  /* THE TICKET POPUP: one ticket in full, over the page, from any queue line. Reads the ticket from ITS project - the fleet is global, the
     item may be another project's. Closes on ✕, Esc, or a click outside. */
  function tkPopup(project, id) {
    var old = document.getElementById('tk-modal'); if (old) old.remove();
    var m = document.createElement('div'); m.id = 'tk-modal'; m.className = 'tk-modal';
    m.innerHTML = '<div class="tk-modal-card"><div class="tk-modal-hd"><b>' + esc(id) + '</b> <span class="dim small">' + esc(project) + '</span><span style="flex:1"></span><span class="tkx" data-close title="close">✕</span></div><div class="tk-modal-body"><div class="muted small">reading…</div></div></div>';
    document.body.appendChild(m);
    var close = function () { m.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    m.querySelector('[data-close]').addEventListener('click', close);
    var ago2 = function (iso) { if (!iso) return ''; var d = Math.round((Date.now() - Date.parse(iso)) / 864e5); return d < 1 ? 'today' : d === 1 ? 'yesterday' : d + ' d ago'; };
    var md = function (x) { return esc(x).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>'); };
    fetch('/api/p/' + encodeURIComponent(project) + '/tickets/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (r) {
      var body = m.querySelector('.tk-modal-body'); if (!r.ok) { body.innerHTML = '<div class="small bad">' + esc(r.error || 'not found') + '</div>'; return; }
      var t = r.ticket, here = window.ROOM && window.ROOM.id === project;
      var h = '<div class="tkhead">' + esc(String(t.title).replace(/^(#\d+|L\d+):\s*/, '')) + '<span class="ev">' + esc(t.state) + '</span></div>';
      h += '<div class="tkmeta">' + (t.feature ? 'feature <b>' + esc(t.feature) + '</b> · ' : '') + 'filed by ' + esc(t.by || 'owner') + ' ' + ago2(t.created) + (t.impact && t.impact.band ? ' · impact <span class="lg rm-' + esc(t.impact.band) + '">' + esc(t.impact.band) + '</span>' : '') + (t.finding ? ' · from finding <code>' + esc(t.finding) + '</code>' : '') + (t.url ? ' · <a href="' + esc(t.url) + '" target="_blank">on GitHub ↗</a>' : '') + '</div>';
      if (t.why) h += '<div class="cv-notes"><b>What</b>' + md(t.why) + '</div>';
      if (t.done) h += '<div class="cv-notes"><b>Done when</b>' + md(t.done) + '</div>';
      var files = (t.alter || []).map(function (f) { return '<div><span class="dim">alter</span> <code>' + esc(f) + '</code></div>'; }).concat((t.create || []).map(function (f) { return '<div><span class="dim">create</span> <code>' + esc(f) + '</code></div>'; })).concat((t.delete || []).map(function (f) { return '<div><span class="dim">delete</span> <code>' + esc(f) + '</code></div>'; }));
      if (files.length) h += '<div class="small" style="margin:6px 0"><b>Files</b>' + files.join('') + '</div>';
      if (t.impact && t.impact.text) h += '<pre class="tkf-pre small">' + esc(t.impact.text) + '</pre>';
      h += '<div class="small" style="margin:8px 0 2px"><b>History</b></div>' + (t.history || []).map(function (x) { return '<div class="small">' + (x.state ? '<span class="lg quiet">' + esc(x.state) + '</span> ' : '') + esc(x.by || '') + ' <span class="dim">' + ago2(x.at) + '</span>' + (x.why ? ' - ' + esc(x.why) : '') + (x.note ? ' - ' + esc(x.note) : '') + '</div>'; }).join('');
      if ((t.verdicts || []).length) h += '<div class="small" style="margin:8px 0 2px"><b>Verdicts</b></div>' + t.verdicts.map(function (v) { return '<div class="small"><span class="lg ' + (v.green ? 'ok' : 'bad') + '">' + (v.green ? 'green' : 'red') + '</span> <span class="dim">' + ago2(v.at) + '</span> ' + esc(v.text || '') + '</div>'; }).join('');
      h += '<div class="plw-bar" style="margin-top:12px">' + (here ? '<span class="btn ghost sm" data-board>Open on the board</span>' : '<a class="btn ghost sm" href="/' + esc(project) + '">Open ' + esc(project) + '</a>') + '</div>';
      body.innerHTML = h;
      var ob = body.querySelector('[data-board]'); if (ob) ob.addEventListener('click', function () { close(); if (window.TicketCards) window.TicketCards.openTicket(t.id); else if (window.__tickets) window.__tickets.open(t.id); });
    }).catch(function (e) { m.querySelector('.tk-modal-body').innerHTML = '<div class="small bad">' + esc(e.message) + '</div>'; });
  }

  /* "＋ Add coder" in the card's title bar, right of "Agent fleet", and its form just under the title bar.
     Both live OUTSIDE the card's body, which the card redraws: a press on the card brings it to the front and saves the desk,
     that redraws the body, and a name box inside it was swapped out under the pointer - the click never reached it (measured
     2026-09-26: "INPUT REMOVED" on pointerdown). Built once per card; nothing the body does can touch them. */
  function headButton(el) {
    var card = el.closest && el.closest('.card'), h3 = card && card.querySelector('header.ch h3'); if (!h3 || h3.querySelector('.fa-hadd')) return;
    var head = card.querySelector('header.ch');
    var b = document.createElement('span'); b.className = 'btn ghost sm fa-hadd'; b.textContent = '＋ Add coder'; b.title = 'add a coder - another account of a kind you already use';
    var f = document.createElement('div'); f.className = 'fa-add fa-add-box'; f.hidden = true;
    var kinds = ((window.AI && window.AI.harnesses) || []).filter(function (x) { return x.name === 'claude-code'; });
    f.innerHTML = '<select class="fa-kind">' + (kinds.length ? kinds : [{ name: 'claude-code', label: 'Claude Code' }]).map(function (k) { return '<option value="' + esc(k.name) + '">' + esc(k.label || k.name) + '</option>'; }).join('') + '</select> '
      + '<input class="fa-name" placeholder="name, e.g. Claude Code AR3"> <span class="btn sm fa-go">Add</span> <span class="btn ghost sm fa-x">Cancel</span><div class="small fa-add-err"></div>';
    head.parentNode.insertBefore(f, head.nextSibling);
    var name = f.querySelector('.fa-name'), kind = f.querySelector('.fa-kind'), err = f.querySelector('.fa-add-err');
    var stop = function (e) { e.stopPropagation(); };
    [b, f].forEach(function (x) { x.addEventListener('pointerdown', stop); });   // not a drag, not a bring-to-front of the card
    var open = function (on) { f.hidden = !on; err.textContent = ''; if (on) setTimeout(function () { name.focus(); }, 0); };
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(f.hidden); });
    f.querySelector('.fa-x').addEventListener('click', function () { open(false); });
    var add = function () {
      var typed = name.value.trim();
      var id = typed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 31);   // the name as typed is the label; the id is made from it
      if (!id) { err.textContent = 'type a name for the coder'; return; }
      post('/api/fleet/agents', { id: id, harness: kind.value, label: typed }).then(function (r) { if (!r.ok) { err.textContent = r.error || 'not added'; return; } name.value = ''; open(false); load(); });
    };
    f.querySelector('.fa-go').addEventListener('click', add);
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') open(false); });
    h3.appendChild(b);
  }
  Layout.register({ id: 'fleet', coding: true, homeDock: ['left', 0], icon: '🤖', title: 'Agent fleet', global: true, purpose: 'your agents and the one queue across every project', zone: 'left', pos: -1, size: [5, 16], min: [4, 8], max: [12, 40], lockedByDefault: true,
    render: function (el) {
      headButton(el);
      if (!F.s) { load(); el.innerHTML = '<div class="muted small">reading the fleet…</div>'; return; }
      var s = F.s, here = window.ROOM && window.ROOM.id, h = '<div class="fa">';
      s.agents.forEach(function (a) {
        var st = !a.on ? 'off' : a.running ? 'working' : a.paused ? 'paused' : 'idle';
        var q = queueFor(a, s.items), now = a.running ? s.items.find(function (i) { return i.status === 'running' && i.claimedBy === a.id; }) : null;
        var why = !a.on ? 'off' : a.paused ? (a.running ? 'paused - finishing what it is on' : 'paused') : a.running ? 'working' + ((a.runnings || []).length > 1 ? ' on ' + a.runnings.length : '') : a.prepNote ? 'setting up its own folder in ' + a.prepNote + ' (packages and its test database) - takes work there when ready' : 'idle - checks the queue every ' + (a.every || 5) + ' min';   // engine/workspaces.js
        var par = a.exclusive ? '<span class="dim small" title="one GPU: one at a time">· 1 at a time</span>' : '<select class="fa-par" data-agent="' + esc(a.id) + '" title="how many items it works at once, each in a different project - 1 to watch one thing move, more when you trust what comes back">' + [1, 2, 3, 4].map(function (n) { return '<option value="' + n + '"' + ((a.parallel || 1) === n ? ' selected' : '') + '>' + n + ' at a time</option>'; }).join('') + '</select>';
        var since = a.running ? hhmm(a.running.since) : (a.changedAt ? hhmm(a.changedAt) : '');
        var modelPick = function (ag) {
          /* the model this agent runs as: click to change, from what its harness reports (window.AI.harnesses is the engine's list) */
          var hs = (window.AI && window.AI.harnesses) || [], hz = hs.find(function (x) { return x.name === ag.harness; });
          var models = (hz && hz.models) || [];
          if (!models.length) return '<span title="the harness reports no models">' + esc(ag.model || '?') + '</span>';
          return '<select class="fa-model" data-agent="' + esc(ag.id) + '" title="the model this agent runs as - change it here">' + models.map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === ag.model ? ' selected' : '') + '>' + esc(m.label || m.id) + '</option>'; }).join('') + (models.some(function (m) { return m.id === ag.model; }) ? '' : '<option value="' + esc(ag.model) + '" selected>' + esc(ag.model) + ' (not offered by the harness now)</option>') + '</select>';
        };
        h += '<div class="fa-agent ' + st + '" data-agent="' + esc(a.id) + '">'
          + '<div class="fa-row"><span class="fa-av ' + esc(a.id) + '">' + (AVATAR[a.id] || a.label.charAt(0)) + '</span><b class="fa-name">' + esc(a.label) + '</b>' + usePill(a)
          + '<label class="sw sm" title="' + (a.on ? 'switch off' : 'switch on') + '"><input type="checkbox" data-agent="' + esc(a.id) + '" data-k="on"' + (a.on ? ' checked' : '') + '><span class="swk"></span></label>'
          + (a.on ? '<span class="btn ghost fa-pause" data-agent="' + esc(a.id) + '" data-k="paused" data-v="' + (a.paused ? 'false' : 'true') + '">' + (a.paused ? 'Resume' : 'Pause') + '</span>' : '')
          + '<span class="fa-st ' + st + '">' + st.toUpperCase() + '</span></div>'
          + (F.usePop === a.id ? usePop(a) : '')
          + '<div class="fa-why small dim">' + esc(why) + (since ? ' · ' + esc(since) : '') + ' · ' + modelPick(a) + ' ' + par + '</div>'
          + '<div class="fa-now" data-agent="' + esc(a.id) + '"><span class="car">' + (F.open[a.id] ? '▾' : '▸') + '</span><span class="dim">NOW:</span> ' + (now ? '<b>' + line(now) + '</b> <span class="dim small">· ' + ago(a.running.since) + '</span>' : a.heldAt && a.usage ? '<b class="warn">holding</b> <span class="small dim">· ' + a.usage.leftPct + '% of the plan left, the floor is ' + (typeof a.floor === 'number' ? a.floor : 25) + '% - takes nothing more until it resets' + (a.usage.resets ? ' (' + esc(a.usage.resets) + ')' : '') + '</span>' : '<b class="muted">nothing assigned</b>') + '</div>';
        /* a Claude coder on its own account shows its login, and until it is logged in, the one command that does it
           (engine/fleet.js addAgent). An added coder can be removed here; a built-in one is switched off. */
        if (a.login && !a.login.ok && a.login.dir && a.login.dir.charAt(0) !== '(') h += '<div class="fa-login small" style="margin:4px 0;color:var(--amber)">Not logged in yet. Once, on the machine the engine runs on, in PowerShell, as the user the engine runs as:<pre class="tkf-pre small" style="margin:4px 0;user-select:all">$env:CLAUDE_CONFIG_DIR = \'' + esc(a.login.dir) + '\'; claude</pre>sign in with the account for this coder, then type /exit. The card turns green on its next reading.</div>';
        else if (a.login && a.login.ok && a.login.dir && a.login.dir.charAt(0) !== '(') h += '<div class="fa-login small dim">own login' + (a.login.plan ? ' (' + esc(a.login.plan) + ')' : '') + (a.login.expired ? ' - token lapsed, renews on its next turn' : '') + '</div>';
        if (a.id !== a.harness) h += '<div class="small"><a href="#" class="dim" data-remove-agent="' + esc(a.id) + '" title="remove this coder - its login folder stays on disk">remove ' + esc(a.label) + '</a></div>';
        if (F.open[a.id]) {
          h += '<ol class="fa-q">' + (q.length ? q.slice(0, 8).map(function (i) { return '<li>' + line(i) + '</li>'; }).join('') + (q.length > 8 ? '<li class="dim">+' + (q.length - 8) + ' more</li>' : '') : '<li class="dim">carries no items of its own</li>') + '</ol>';
        }
        h += '</div>';
      });
      /* ADD A CODER: a kind and a name; it arrives switched off, with its own folder and database in each project on first
         use (engine/workspaces.js) and - for Claude - its own login folder to sign in once */
      var kinds = ((window.AI && window.AI.harnesses) || []).filter(function (x) { return x.name === 'claude-code'; });
      h += '<div class="fa-all"><span class="btn ghost" id="fl-pause-all">' + (s.pausedAll ? 'Resume all' : 'Pause all') + '</span></div>';

      // the one queue
      /* inside a project the queue shows that project's work; Home shows every project. The choice is remembered per desk. */
      F.filter = F.filterBy[here || ''] !== undefined ? F.filterBy[here || ''] : (here && here !== 'home' ? here : 'all');
      var mine = s.items.filter(function (i) { return F.filter === 'all' || i.project === F.filter; });
      var items = mine.filter(function (i) { return F.showDone || GONE.indexOf(i.status) < 0; });
      var projects = {}; s.items.forEach(function (i) { projects[i.project] = 1; }); if (here) projects[here] = 1;
      h += '<div class="fa-qh" id="fl-qtoggle"><span class="car">' + (F.qopen ? '▾' : '▸') + '</span><b>QUEUE</b> <span class="dim small">' + (F.filter === 'all' ? '' : esc(F.filter) + ': ') + mine.filter(function (i) { return i.status === 'queued'; }).length + ' queued · ' + mine.filter(function (i) { return i.status === 'running'; }).length + ' running' + (function (n) { return n ? ' · <b class="warn">' + n + ' blocked</b>' : ''; })(mine.filter(function (i) { return i.status === 'blocked'; }).length) + '</span></div>';
      if (F.qopen) {
        h += '<div class="fa-qbar"><select id="fl-filter"><option value="all">all projects</option>' + Object.keys(projects).sort().map(function (p) { return '<option value="' + esc(p) + '"' + (F.filter === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select>'
          + '<label class="small dim"><input type="checkbox" id="fl-done"' + (F.showDone ? ' checked' : '') + '> done</label><span style="flex:1"></span><span class="btn ghost" id="fl-add">＋ Add</span></div>';
        if (F.adding) h += '<div class="fl-addf"><input id="fl-title" placeholder="what needs doing (one line)"><textarea id="fl-text" placeholder="the ask, as you would say it to the AI in that project"></textarea><div class="fl-addb"><select id="fl-proj">' + Object.keys(projects).sort(function (x, y) { return x === here ? -1 : y === here ? 1 : x.localeCompare(y); }).map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + (p === here ? ' (this project)' : '') + '</option>'; }).join('') + '</select><select id="fl-pri">' + TIERS.map(function (t) { return '<option' + (t === 'P2' ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select><span class="btn" id="fl-save">Queue it</span><span class="btn ghost" id="fl-cancel">Cancel</span></div></div>';
        h += '<div class="fl-q">';
        TIERS.forEach(function (t) {
          var rows = items.filter(function (i) { return i.priority === t; }); if (!rows.length) return;
          h += '<div class="fl-tier">' + t + ' <span class="dim">' + rows.length + '</span></div>';
          rows.forEach(function (i) {
            h += '<div class="fl-item ' + esc(i.status) + '" data-id="' + i.id + '"><span class="fl-mv"><a href="#" data-move="up" data-id="' + i.id + '">▲</a><a href="#" data-move="down" data-id="' + i.id + '">▼</a></span>'
              + '<span class="fl-title" title="' + esc(i.text) + '">' + line(i) + '</span>'
              + '<span class="fl-status">' + esc(i.status) + (i.claimedBy ? ' · ' + esc(i.claimedBy) : '') + (i.turns ? ' · ' + i.turns + 't' : '') + '</span>'
              + '<select class="fl-pri" data-id="' + i.id + '" title="priority">' + TIERS.map(function (x) { return '<option' + (x === i.priority ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>'
              + (i.status === 'queued' ? '<select class="fl-pri fl-who" data-id="' + i.id + '" title="coder: first available, or one"><option value="">any</option>' + s.agents.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === i.agent ? ' selected' : '') + '>' + esc(a.label) + '</option>'; }).join('') + '</select>' : '')
              + (i.status === 'parked' ? '<a href="#" data-act="queued" data-id="' + i.id + '" class="small">unpark</a>' : i.status === 'queued' ? '<a href="#" data-act="parked" data-id="' + i.id + '" class="small dim">park</a>' : (i.status === 'done' || i.status === 'failed') ? '<a href="#" data-act="queued" data-id="' + i.id + '" class="small dim">requeue</a>' : '')
              + '<a href="#" data-del="' + i.id + '" class="small dim" title="remove">✕</a></div>'
              + (i.outcome ? '<div class="fl-out small dim">' + esc(i.outcome.agent || '') + ' · ' + esc(i.outcome.reason || '') + (i.outcome.producedNothing ? ' · produced nothing' : '') + (i.outcome.files && i.outcome.files.length ? ' · touched ' + i.outcome.files.length + ' file' + (i.outcome.files.length === 1 ? '' : 's') : '') + (i.outcome.text ? '<div class="fl-otext">' + esc(i.outcome.text.slice(0, 240)) + '</div>' : '') + '</div>' : '');
          });
        });
        if (!items.length) h += '<div class="small dim" style="padding:6px 2px">nothing queued' + (F.filter !== 'all' ? ' for ' + esc(F.filter) : '') + '</div>';
        h += '</div>';
      }
      h += '</div>';
      if (!Layout.paint(el, h)) return;

      if (!F.usePop) setTimeout(function () { Layout.snug('fleet'); }, 0);   // as tall as its content, no more (not while the usage popup floats over it)
      el.querySelectorAll('.fa-now').forEach(function (n) { n.addEventListener('click', function () { F.open[n.dataset.agent] = !F.open[n.dataset.agent]; Layout.refresh(); }); });
      var qt = el.querySelector('#fl-qtoggle'); if (qt) qt.addEventListener('click', function () { F.qopen = !F.qopen; Layout.refresh(); if (F.qopen) load(); });   // opened: bring the work orders in now
      el.querySelectorAll('select.fa-par').forEach(function (sel) { sel.addEventListener('change', function () { post('/api/fleet/agent/' + sel.dataset.agent, { parallel: Number(sel.value) }).then(load); }); });
      el.querySelectorAll('select.fa-model').forEach(function (sel) { sel.addEventListener('change', function () { post('/api/fleet/agent/' + sel.dataset.agent, { model: sel.value }).then(load); }); });
      el.querySelectorAll('input[data-agent][data-k="on"]').forEach(function (i) { i.addEventListener('change', function () { post('/api/fleet/agent/' + i.dataset.agent, { on: i.checked, paused: false })   /* on/off clears a pause: switched on means working */.then(load); }); });
      el.querySelectorAll('[data-agent][data-k="paused"]').forEach(function (b) { b.addEventListener('click', function () { post('/api/fleet/agent/' + b.dataset.agent, { paused: b.dataset.v === 'true' }).then(load); }); });
      el.querySelectorAll('[data-use]').forEach(function (p) { p.addEventListener('click', function (e) { e.stopPropagation(); F.usePop = F.usePop === p.dataset.use ? null : p.dataset.use; Layout.refresh(); }); });
      el.querySelectorAll('[data-pop]').forEach(function (pop) {
        pop.addEventListener('click', function (e) { e.stopPropagation(); });
        var ask = pop.querySelector('.fa-useask'); if (ask) ask.addEventListener('click', function (e) { e.preventDefault(); ask.textContent = 'asking…'; post('/api/fleet/usage/refresh', { agent: pop.dataset.pop }).then(function (r) { var res = r.results && r.results[pop.dataset.pop]; if (res && !res.ok) { ask.textContent = 'no answer: ' + (res.why || ''); return; } load(); }); });
      });
      var ac = el.querySelector('#fl-add-coder'); if (ac) ac.addEventListener('click', function () { F.addCoder = true; F.addErr = null; Layout.refresh(); });
      var ax = el.querySelector('#fl-add-coder-x'); if (ax) ax.addEventListener('click', function () { F.addCoder = false; F.addErr = null; Layout.refresh(); });
      /* THE NAME IS KEPT AS IT IS TYPED, and Add fires on the press, not the click. Pressing Add took the focus off the name box, which let the refresh held back while he typed
         redraw the card between press and release - the button under the pointer was replaced, so no click, and the redraw
         wiped the name. Now the name lives in F, and the press keeps the focus where it is and adds at once. Enter adds too. */
      var nm = el.querySelector('#fl-coder'); if (nm) { nm.addEventListener('input', function () { F.coderName = nm.value; }); nm.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCoder(); } }); }
      var kd = el.querySelector('#fl-kind'); if (kd) kd.addEventListener('change', function () { F.coderKind = kd.value; });
      var ag = el.querySelector('#fl-add-coder-go'); if (ag) ag.addEventListener('mousedown', function (e) { e.preventDefault(); addCoder(); });
      function addCoder() {
        var typed = (F.coderName || ((el.querySelector('#fl-coder') || {}).value) || '').trim(), kind = F.coderKind || (el.querySelector('#fl-kind') || {}).value || 'claude-code';
        /* the name as typed is the label; the id is made from it (owner typed "Claude Code AR1" and got nothing, 2026-09-25) */
        var id = typed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 31);
        /* the card is not redrawn while the name box holds the focus, so let go of it first or the answer never shows */
        if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
        if (!id) { F.addErr = 'type a name for the coder'; Layout.refresh(); return; }
        post('/api/fleet/agents', { id: id, harness: kind, label: typed }).then(function (r) { if (!r.ok) { F.addErr = r.error; Layout.refresh(); return; } F.addCoder = false; F.addErr = null; F.coderName = ''; load(); });
      }
      el.querySelectorAll('[data-remove-agent]').forEach(function (x) { x.addEventListener('click', function (e) { e.preventDefault(); if (!confirm('Remove ' + x.dataset.removeAgent + '? Its login folder stays on disk.')) return; api('/api/fleet/agent/' + x.dataset.removeAgent, { method: 'DELETE' }).then(function (r) { if (r && !r.ok) alert(r.error); load(); }); }); });
      var pa = el.querySelector('#fl-pause-all'); if (pa) pa.addEventListener('click', function () { post('/api/fleet/pause-all', { paused: !s.pausedAll }).then(load); });
      el.querySelectorAll('a.fl-tk').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); tkPopup(a.dataset.tkp, a.dataset.tk); }); });
      var ff = el.querySelector('#fl-filter'); if (ff) ff.addEventListener('change', function (e) { F.filter = e.target.value; F.filterBy[(window.ROOM && window.ROOM.id) || ''] = e.target.value; Layout.refresh(); });
      var fd = el.querySelector('#fl-done'); if (fd) fd.addEventListener('change', function (e) { F.showDone = e.target.checked; Layout.refresh(); });
      var ad = el.querySelector('#fl-add'); if (ad) ad.addEventListener('click', function () { F.adding = !F.adding; Layout.refresh(); });
      var sv = el.querySelector('#fl-save'); if (sv) sv.addEventListener('click', function () {
        var b = { project: el.querySelector('#fl-proj').value, title: el.querySelector('#fl-title').value.trim(), text: el.querySelector('#fl-text').value.trim(), priority: el.querySelector('#fl-pri').value };
        if (!b.title && !b.text) return;
        post('/api/fleet/items', b).then(function () { F.adding = false; load(); });
      });
      var cv = el.querySelector('#fl-cancel'); if (cv) cv.addEventListener('click', function () { F.adding = false; Layout.refresh(); });
      el.querySelectorAll('select.fl-pri:not(.fl-who)').forEach(function (sel) { sel.addEventListener('change', function () { post('/api/fleet/items/' + sel.dataset.id, { priority: sel.value }).then(load); }); });
      el.querySelectorAll('select.fl-who').forEach(function (sel) { sel.addEventListener('change', function () { post('/api/fleet/items/' + sel.dataset.id, { agent: sel.value || null }).then(load); }); });
      el.querySelectorAll('[data-act]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); post('/api/fleet/items/' + a.dataset.id, { status: a.dataset.act }).then(load); }); });
      el.querySelectorAll('[data-del]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); if (!confirm('Remove this item from the queue?')) return; api('/api/fleet/items/' + a.dataset.del, { method: 'DELETE' }).then(load); }); });
      el.querySelectorAll('[data-move]').forEach(function (a) { a.addEventListener('click', function (e) {
        e.preventDefault();
        var id = Number(a.dataset.id), it = s.items.find(function (x) { return x.id === id; }); if (!it) return;
        var ids = s.items.filter(function (x) { return x.priority === it.priority && (F.showDone || GONE.indexOf(x.status) < 0); }).map(function (x) { return x.id; });
        var i = ids.indexOf(id), j = a.dataset.move === 'up' ? i - 1 : i + 1; if (j < 0 || j >= ids.length) return;
        ids.splice(i, 1); ids.splice(j, 0, id);
        post('/api/fleet/reorder', { ids: ids }).then(load);
      }); });
    } });

  document.addEventListener('click', function () { if (F.usePop) { F.usePop = null; Layout.refresh(); } });
  setInterval(function () { if (F.s && window.ROOM) load(); }, 15000);
})();
