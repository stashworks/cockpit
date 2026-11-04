/* The Tickets BOARD - the ticket process as columns. Every ticket is a chip in the column it
   is in; open one and the ticket page shows what it is, the files it may touch, its history and verdicts, and the ONE
   move it is waiting for:
     waiting on you   draft            Approve · Reject · Discuss
     to work          created          Work it  (puts it on the AI in the conversation - no typing "work L2")
     in work          in-work          what is happening: the turn on it, tests, then the verdict as it lands
     verified         verified         Passed · Send back
     passed           passed           Promoted (or the promote script records it)
     promoted         promoted         Close (or the rescan closes it when the finding is gone)
     closed           closed/rejected  hidden unless asked for
   Facts are the engine's (engine/tickets.js, engine/verify.js). With the GitHub plugin on, the issues already on GitHub
   that Cockpit has no ticket for appear too, in the column their PR evidence puts them (the github plugin's pipeline
   stage), and open on the Ticket card. One of the Tickets plugin's cards (with Pipeline, Needs attention, Ticket,
   Recent deploys - plugins/tickets/cards); the plugin is on for a project whose work is code. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
  var post = function (u, b) { return api(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); };
  /* ONE INSTANCE PER DESK CARD (Home step 1): bound to its project through ctx, so this card can sit on another
     project's desk - Home's - and read that project. */
  function Board(ctx0) {
  var X = ctx0;
  var T = { project: null, version: null, list: null, gh: null, github: false, open: null, full: null, loading: false, err: null, showClosed: false, features: null, edit: null, busy: false, working: {}, fleet: null, queueing: null, car: {}, fixing: null, asking: null, promote: null };
  /* the fleet's view of this project's tickets: item per ticket id (queued or running), and the agents to assign */
  /* an item is this ticket's when it names it: by Cockpit ticket id, by GitHub number (engine/ghqueue.js), or - items added
     straight from GitHub before that field existed - by the "#N:" its title starts with (2026-09-24: the board could not see
     most of the queue, because those items carried the number only in the title) */
  function itemNum(i) { if (i.gh) return String(i.gh); if (i.ticket) return String(i.ticket); var m = /^\s*#(\d+)\b/.exec(i.title || ''); return m ? m[1] : null; }
  function fleetItem(id) { var f = T.fleet; if (!f) return null; id = String(id).replace(/^(gh:|#)/, ''); return (f.items || []).find(function (i) { return i.project === X.room.id && itemNum(i) === id && (i.status === 'queued' || i.status === 'running'); }) || null; }
  function queuePlace(it) { var f = T.fleet, TIER = { next: 0, P1: 1, P2: 2, P3: 3 }; if (!f || it.status !== 'queued') return 0; return (f.items || []).filter(function (x) { return x.status === 'queued' && ((TIER[x.priority] || 3) < (TIER[it.priority] || 3) || ((TIER[x.priority] || 3) === (TIER[it.priority] || 3) && ((x.order || 0) < (it.order || 0) || ((x.order || 0) === (it.order || 0) && String(x.added) < String(it.added))))); }).length + 1; }
  function ordinal(n) { return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'); }
  function queueState(id) { var it = fleetItem(id); if (!it) return ''; var f = T.fleet, ag = (f.agents || []).find(function (a) { return a.id === it.claimedBy; }); return it.status === 'running' ? 'on ' + (ag ? ag.label : it.claimedBy) + (it.claimedAt ? ' since ' + new Date(it.claimedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '') : 'queued · ' + it.priority + ' · ' + ordinal(queuePlace(it)) + (it.agent ? ' · for ' + it.agent : ''); }

  /* the columns say where a ticket IS in the workflow, not only its state: to work = approved, in the backlog or on the queue; in work = being coded right now (a turn on it); testing
     = the coding ended, the tests and the rescan run, the verdict is coming; needs review = not going through any process - a red
     verdict, the fleet gave up, stopped mid-work with nothing on it. The ticket's state underneath is unchanged. */
  /* the version an environment reports, and the tickets in landings newer than it: merged, not deployed there yet */
  /* an environment deployed in parts ("uat" and "uat:web"): the newest of the parts' commits - a part whose files did not
     change is not redeployed and keeps reporting an older one (2026-10-04, same rule as engine/ghqueue.js envSha) */
  function envSha(env) {
    var rows = T.landings || [];
    var shas = (T.envs || []).filter(function (e) { return (e.env === env || e.env.indexOf(env + ':') === 0) && e.ok !== 0; }).map(function (row) {
      try { var v = JSON.parse(row.version); return String(v.sha || '').slice(0, 7); } catch (e) { return String(row.version || '').slice(0, 7); }
    }).filter(function (s) { return /^[0-9a-f]{7}$/i.test(s); });
    if (!shas.length) return null;
    var idx = function (s) { for (var i = 0; i < rows.length; i++) if (String(rows[i].short || rows[i].sha || '').slice(0, 7) === s) return i; return Infinity; };
    return shas.sort(function (a, b) { return idx(a) - idx(b); })[0];
  }
  function undeployed(env) {
    var sha = envSha(env), rows = T.landings || [], out = {};
    if (!sha || !rows.length) return out;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (String(r.short || r.sha || '').slice(0, 7) === sha) break;   // rows are newest first: everything above the environment's own commit is not there yet
      String(r.tickets || '').split(/[^0-9]+/).forEach(function (n) { if (n) out[Number(n)] = 1; });
    }
    return out;
  }
  function gated() { var k = window.TicketCards; return !!(k && k.on && k.on(X)); }   // Tickets on = Passed is the promote gate; off = verified is the end of the line
  /* THE COLUMNS ARE THE PROCESS, ONE STEP EACH:

       waiting on you   anything STOPPED that only a person can move: a draft to approve, the fleet gave up, the gate is
                        red, a promote rolled back, nothing picked it up. The chip says why in a few words and carries
                        the one button that clears it. Nothing that is actually running ever appears here.
       to work          approved: the backlog and the fleet queue
       in work          the coders have it - coding, then its tests and the verdict; the chip says which
       In UAT           the code is ON the environment you test, because its tests went green and it was put there: on a project Cockpit deploys, that is the environment it was
                        put on; on one where the work is already where you test (dev), it is there. THE ONLY green thing
                        that normally waits on you. The button is Push to prod.
       to prod          the push is happening: the full run, the gate, the deploy, the smoke
       prod test        the flows read back on prod; green closes the ticket, red sends it to waiting on you (rolled back)
       complete         48 hours here, then Recent deploys */
  /* `what` is the column's tooltip. It says what the column MEANS and who it is waiting on - the
     same words as the process note above, so the board and the doctrine cannot drift apart. */
  var COLS = [
    { key: 'waiting', title: 'waiting on you', states: ['draft'], what: 'Stopped, and only you can move it: a draft to approve, the fleet gave up, the gate went red, a promote rolled back, or nothing picked it up. Each chip says why and carries the one button that clears it. Nothing that is actually running ever appears here.' },
    { key: 'created', title: 'to work', states: ['created'], what: 'Approved and waiting for a coder - the backlog and the fleet queue. Nobody is working these yet.' },
    { key: 'in-work', title: 'in work', states: ['in-work'], what: 'A coder has it right now: writing the code, then running its tests and the verdict. The chip says which of those it is doing.' },
    { key: 'uat', title: 'In UAT', states: ['verified'], what: 'The code is ON the environment you test, because its tests went green and it was put there. THIS IS THE ONE GREEN THING THAT NORMALLY WAITS ON YOU - go and look at it. The button is Push to prod.' },
    { key: 'toprod', title: 'to prod', states: ['passed'], gated: true, what: 'The push to production is happening now: the full test run, the gate, the deploy, then the smoke tests. Nothing for you to do while it runs.' },
    { key: 'prodtest', title: 'prod test', states: ['promoted'], gated: true, what: 'The flows are being read back on production. Green closes the ticket; red rolls it back and sends it to waiting on you.' },
    { key: 'complete', title: 'complete', states: ['closed'], gated: true, what: 'Done and live. Tickets sit here for 48 hours so you can see what just landed, then move to Recent deploys.' },
    { key: 'closed', title: 'rejected', states: ['rejected'], what: 'Dropped - you rejected the draft or the ticket. Kept so nothing vanishes from the board without a trace.' }
  ];
  var PROMOTED_SHOWN_MS = 48 * 3600 * 1000;
  /* THE SAME PROCESS, MOVED BY GITHUB. With the plugin on, the issue IS the ticket and the step comes
     from what GitHub can prove - the plugin's own stage ids (plugins/github/stages.json):
       not-started  nothing yet                        to work
       in-progress  a coder has claimed it (label)     in work
       in-review    a PR is open                       in work       <- the coder merges its own green PR, so an
                                                                        open PR is a coder still finishing, not a
                                                                        wait on the owner.
                                                                        It reaches him only when the fleet gives
                                                                        up on it, which stoppedWhy already catches.
       in-uat       the PR is merged, it is on main    UAT testing   <- yours to test, put there by CI
       verified     a person confirmed it in UAT       to prod       <- your Push to prod wrote that label
       live         confirmed live for customers       prod test
     MEASURED 2026-09-22: the keys here were spaced ("in uat") and the plugin's ids are hyphenated, so 53 issues waiting
     for the owner's test sat in "to work" and nothing ever reached UAT testing - the board disagreeing with reality. */
  var GH_STAGE = { 'not-started': 'created', 'in-progress': 'in-work', 'in-review': 'in-work', 'in-uat': 'uat', 'verified': 'toprod', 'live': 'prodtest', done: 'complete',
    'not started': 'created', 'in progress': 'in-work', 'in review': 'in-work', 'in uat': 'uat' };
  var NEXT = { verified: ['passed', 'Push to prod', 'you tested it and it holds: it goes to prod now - the full run first, then the gate, then the push and the smoke; the record lands on Recent deploys'], passed: ['promoted', 'Promoted', 'it went to prod (the push records this on its own when it runs; press only if it did and the record is missing)'], promoted: ['closed', 'Complete', 'you looked at it on prod and it is good - the ticket is done; 48 hours here, then Recent deploys'] };
  var BACK = { verified: 'created', passed: 'created', promoted: 'created' };   // sent back = to work, re-queued, with the owner's words (2026-09-22)

  function load() {
    if (T.loading) return; T.loading = true;
    var ghOn = !!(window.TicketCards && window.TicketCards.ghOn(X));   // this project's GitHub plugin, whichever desk the board is on
    Promise.all([
      api(X.api + '/tickets').then(function (r) { T.list = r.ok ? r.tickets : []; T.github = !!r.github; T.err = r.ok ? null : r.error; }).catch(function (e) { T.err = e.message; T.list = []; }),
      api('/api/fleet?brief=1').then(function (r) { T.fleet = r; }).catch(function () { T.fleet = null; }),   // without the work orders: 573 KB -> a fraction, four times a minute
      api(X.api + '/chat/running').then(function (r) { T.running = r.running || []; T.verifying = r.verifying || []; }).catch(function () { T.running = []; T.verifying = []; }),
      api(X.api + '/promote').then(function (r) { T.promote = r.ok ? r : null; }).catch(function () { T.promote = null; }),
      ghOn ? api(X.api + '/plugins/github/q/meta').then(function (r) { var m = {}; ((r && r.rows) || []).forEach(function (x) { m[x.key] = x.value; }); T.ghYou = m.you || ''; try { T.ghPeople = JSON.parse(m.people || '{}'); } catch (e) { T.ghPeople = {}; } }).catch(function () { /* */ }) : null,
      ghOn ? api(X.api + '/plugins/github/q/pipeline').then(function (r) { T.gh = r.ok ? r.rows : []; }).catch(function () { T.gh = []; }) : Promise.resolve(T.gh = []),
      /* MERGED IS NOT DEPLOYED (15 landings read as "went to prod" while prod had not moved since the 17th).
         The landings on main and what each environment says it is actually running, so a ticket whose code has not left main
         says so instead of claiming to be testable. */
      api(X.api + '/plugins/tickets/q/deploys').then(function (r) { T.landings = r.ok ? r.rows : []; }).catch(function () { T.landings = []; }),
      api(X.api + '/plugins/tickets/q/envs').then(function (r) { T.envs = r.ok ? r.rows : []; }).catch(function () { T.envs = []; })
    ]).then(function () { T.loading = false; if (T.open && !/^gh:/.test(T.open)) return api(X.api + '/tickets/' + encodeURIComponent(T.open)).then(function (r) { T.full = r.ok ? r.ticket : null; }); })
      .then(function () { Layout.refresh(); });
  }
  /* Acting on a ticket puts you back in the columns. Leaving the detail open made a
     press that had worked look like a press that had done nothing. */
  function closeDetail() { T.open = null; T.full = null; if (window.TicketCards) window.TicketCards.ticket = null; }
  function move(id, to, why) {
    if ((to === 'created' || to === 'in-work' || to === 'rejected') && why === undefined) { T.asking = { id: id, to: to, why: '' }; Layout.refresh(); return; }   // backwards: the words are the work order
    T.asking = null;
    post(X.api + '/tickets/' + encodeURIComponent(id) + '/state', { state: to, why: why || null }).then(function (r) {
      if (!r.ok) { alert(r.error); load(); return; }
      /* one press: Promote on a verified ticket records the pass AND starts the promote - the owner's press is the manual
         trigger. On auto the engine started
         it on the pass already (r.promote.started) and this is skipped. */
      /* sent back: it goes to the coders, not onto a list of the owner's - to work AND on the queue, carrying his words */
      if (to === 'created' && why) return post('/api/fleet/items', { project: X.room.id, ticket: id, priority: 'P1', source: 'sent back', text: 'Sent back by the owner after testing it: ' + why + String.fromCharCode(10) + String.fromCharCode(10) + 'Put exactly that right. The ticket is ' + id + '; touch only the files it names, commit, run the tests it names, then `ticket check ' + id + '` before you end.' }).then(function () { closeDetail(); load(); });
      var P = T.promote || {}, ps = P.settings || {};
      if (to === 'passed' && ps.mode !== 'observed' && !P.running && !(r.promote && r.promote.started)) return post(X.api + '/promote', { by: 'owner' }).then(function (x) { if (!x.ok && x.error && !/already/i.test(x.error)) alert(x.error); closeDetail(); load(); });
      closeDetail(); load();
    });
  }
  function askHtml(t) {
    var a = T.asking; if (!a || a.id !== t.id) return '';
    var back = a.to === 'created' || a.to === 'in-work';
    return '<div class="tk-ask"><div class="small" style="margin-bottom:6px"><b>' + (back ? 'Send it back' : 'Drop it') + '</b> <span class="dim">- ' + (back ? 'what is wrong, in your words: it goes back to the coders with these words as the work order, on the queue at P1' : 'why, for the record; it goes to closed as rejected') + '</span></div>'
      + '<textarea data-ask-why rows="3" placeholder="' + (back ? 'e.g. the page still shows the old menu on mobile' : 'e.g. not needed after all') + '">' + esc(a.why) + '</textarea>'
      + (a.err ? '<div class="small" style="color:var(--amber);margin:4px 0">' + esc(a.err) + '</div>' : '')
      + '<div class="plw-bar"><span class="btn sm" data-ask-go>' + (back ? 'Send back' : 'Drop') + '</span><span class="btn ghost sm" data-ask-cancel>Cancel</span></div></div>';
  }
  /* Work it: the ticket goes on the fleet queue with a priority and an assignment - first available, or one coder - and
     an agent that is on takes it in its turn. Work it now is the hands-on path: the conversation, the AI in the header, in front of you. */
  function queueHtml(t) {
    var q = T.queueing && T.queueing.id === t.id ? T.queueing : null; if (!q) return '';
    var agents = ((T.fleet && T.fleet.agents) || []);
    return '<div class="tk-queue"><label class="small">priority <select data-q="priority">' + ['next', 'P1', 'P2', 'P3'].map(function (x) { return '<option' + (x === q.priority ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label> '
      + '<label class="small">coder <select data-q="agent"><option value="">first available</option>' + agents.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === q.agent ? ' selected' : '') + '>' + esc(a.label) + (a.on ? '' : ' (off)') + '</option>'; }).join('') + '</select></label> '
      + '<span class="btn sm" data-tk-queue="' + esc(t.id) + '">Queue it</span> <span class="btn ghost sm" data-tk-queue-cancel>Cancel</span>'
      + (agents.some(function (a) { return a.on; }) ? '' : '<div class="small dim" style="margin-top:4px">every agent is off - the queue waits until one is switched on, on the Agent fleet card</div>') + '</div>';
  }
  /* the ticket on the queue, as a table with labels: what each column means is in the header's title */
  function queueTable(t) {
    var it = fleetItem(t.id); if (!it) return '';
    var f = T.fleet, agents = (f && f.agents) || [], ag = agents.find(function (a) { return a.id === it.claimedBy; });
    var queued = (f.items || []).filter(function (x) { return x.status === 'queued'; }).length;
    var hhmm = function (iso) { return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''; };
    var on = agents.filter(function (a) { return a.on && !a.paused; });
    var status = it.status === 'running' ? '<span class="lg ok">working</span> on <b>' + esc(ag ? ag.label : it.claimedBy) + '</b> since ' + hhmm(it.claimedAt) : '<span class="lg quiet">waiting</span>' + (on.length ? '' : ' <span class="dim">- every agent is off</span>');
    var h = '<div class="tk-qtab"><div class="st-lab" style="margin:0 0 6px">On the fleet queue <span class="dim">· item #' + it.id + '</span></div><table class="tk-qt"><thead><tr>'
      + '<th title="waiting: nobody has taken it yet; working: an agent is on it">status</th>'
      + '<th title="next goes before everything; then P1, P2, P3. Within a tier, the order on the fleet card (▲▼)">priority</th>'
      + '<th title="its place in the one queue across every project - the agents take from the top">place in line</th>'
      + '<th title="first available: the first agent that is on and free takes it; a named coder: it waits for that one">coder</th>'
      + '<th title="when it was put on the queue, and from where">queued</th><th></th></tr></thead><tbody><tr>'
      + '<td>' + status + '</td>'
      + '<td>' + (it.status === 'queued' ? '<select data-qi="priority" data-item="' + it.id + '">' + ['next', 'P1', 'P2', 'P3'].map(function (x) { return '<option' + (x === it.priority ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' : esc(it.priority)) + '</td>'
      + '<td>' + (it.status === 'queued' ? '<b>' + ordinal(queuePlace(it)) + '</b> <span class="dim">of ' + queued + '</span>' : '—') + '</td>'
      + '<td>' + (it.status === 'queued' ? '<select data-qi="agent" data-item="' + it.id + '"><option value="">first available</option>' + agents.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === it.agent ? ' selected' : '') + '>' + esc(a.label) + (a.on ? '' : ' (off)') + '</option>'; }).join('') + '</select>' : esc(ag ? ag.label : it.claimedBy || '')) + '</td>'
      + '<td>' + hhmm(it.added) + ' <span class="dim">from the ' + esc(it.source || 'board') + '</span>' + (it.turns ? ' · try ' + it.turns : '') + '</td>'
      + '<td>' + (it.status === 'queued' ? '<span class="btn ghost sm" data-tk-unqueue="' + esc(t.id) + '" title="take it off the queue - it stays in to work">Take off the queue</span>' : '') + '</td>'
      + '</tr></tbody></table>'
      + (it.outcome && it.outcome.reason ? '<div class="small dim" style="margin-top:4px">last try: ' + esc(it.outcome.reason) + (it.outcome.producedNothing ? ' - produced nothing' : '') + (it.outcome.text ? ' - ' + esc(String(it.outcome.text).slice(0, 200)) : '') + '</div>' : '')
      + '</div>';
    return h;
  }
  function queueIt(t) {
    var q = T.queueing; if (!q) return;
    post('/api/fleet/items', { project: X.room.id, ticket: t.id, priority: q.priority, agent: q.agent || null, source: 'board' }).then(function (r) { if (!r.ok) { alert(r.error); return; } T.queueing = null; load(); });
  }
  function unqueue(t) { var it = fleetItem(t.id); if (!it) return; fetch('/api/fleet/items/' + it.id, { method: 'DELETE' }).then(function () { load(); }); }
  function work(t) {
    var id = t.number ? '#' + t.number : t.id;
    if (!X.own) { if (window.openProject) window.openProject(X.project); return; }   // another project's board: Work it from inside that project, where its conversation is
    if (!window.sendToConversation) { alert('open the Control room - the conversation card sends it'); return; }
    T.working[t.id] = Date.now();
    window.sendToConversation('Work ' + id + ': ' + t.title + '. The ticket body is in your prompt; do exactly what it says, touch only the files it names, and read back what you did.', {});
    Layout.refresh();
  }
  function ago(iso) { var s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; }

  /* ---------- the ticket page ---------- */
  /* a draft, for the owner's approval: the number it will get at the front of the title, the feature as a dropdown (the
     map's features and earlier tickets' - one list, so names stay one name - plus "new"), the files and the done-when
     editable, the impact beside; Approve files it, Reject drops it, Discuss takes it back to the chat */
  function approvalHtml(t) {
    var e = T.edit && T.edit.id === t.id ? T.edit : (T.edit = { id: t.id, title: t.title, feature: t.feature || '', newFeature: '', alter: t.alter.join('\n'), create: t.create.join('\n'), delete: (t.delete || []).join('\n'), done: t.done || '', why: t.why || '' });
    var feats = T.features || [];
    var known = feats.some(function (f) { return f.key === e.feature; });
    var h = '<div class="tk-full tk-draft"><div class="fd-hd"><b>New ticket</b> <span class="small dim">drafted by ' + esc(t.by) + ' ' + ago(t.created) + (t.adopt ? ' · adopts GitHub #' + t.adopt : '') + ' · waits for you</span><span class="tkx" data-tk-close title="close">✕</span></div>';
    h += '<label class="tkf-f"><span class="tkf-l">Title <span class="dim">- the number goes in front when it is filed (' + (t.adopt ? '#' + t.adopt : 'next') + ': …)</span></span><input data-e="title" value="' + esc(e.title) + '"></label>';
    h += '<div class="tk-cols"><div>'
      + '<label class="tkf-f"><span class="tkf-l">Feature</span><select data-e="feature"><option value="">(none)</option>' + feats.map(function (f) { return '<option value="' + esc(f.key) + '"' + (f.key === e.feature ? ' selected' : '') + '>' + esc(f.key) + (f.tickets ? ' (' + f.tickets + ' tickets)' : '') + '</option>'; }).join('') + (e.feature && !known && e.feature !== '__new' ? '<option value="' + esc(e.feature) + '" selected>' + esc(e.feature) + ' (new)</option>' : '') + '<option value="__new"' + (e.feature === '__new' ? ' selected' : '') + '>+ a new feature…</option></select>' + (e.feature === '__new' ? '<input data-e="newFeature" placeholder="the new feature\'s name" value="' + esc(e.newFeature) + '">' : '') + '</label>'
      + '<label class="tkf-f"><span class="tkf-l">What</span><textarea data-e="why" rows="3">' + esc(e.why) + '</textarea></label>'
      + '<label class="tkf-f"><span class="tkf-l">Done when <span class="dim">- what you read back on dev before it goes further</span></span><textarea data-e="done" rows="2">' + esc(e.done) + '</textarea></label>'
      + '</div><div>'
      + '<label class="tkf-f"><span class="tkf-l">Files to alter</span><textarea data-e="alter" rows="5">' + esc(e.alter) + '</textarea></label>'
      + '<label class="tkf-f"><span class="tkf-l">Files to create</span><textarea data-e="create" rows="2">' + esc(e.create) + '</textarea></label>'
      + '<label class="tkf-f"><span class="tkf-l">Files to delete</span><textarea data-e="delete" rows="2">' + esc(e.delete) + '</textarea></label>'
      + (!(e.alter || '').trim() && !(e.create || '').trim() && !(e.delete || '').trim() ? '<div class="small" style="color:var(--amber);margin:4px 0">No files declared. These lists are the fence the verdict checks the work against - with them empty, every file the AI touches comes back as undeclared. Put every file the work will touch in one of the three, then approve.</div>' : '')
      + '</div></div>';
    h += '<div class="ar-sec">impact <span class="dim">from the map, for the files as drafted</span></div><div class="tkf-band"><span class="lg rm-' + esc(t.impact.band) + '">' + esc(t.impact.band) + '</span> <span class="small dim">' + esc(t.impact.summary || '') + '</span></div><pre class="tkf-pre small">' + esc(t.impact.text || '') + '</pre>';
    h += '<div class="fd-acts"><span class="btn' + (T.busy ? ' dim' : '') + '" data-tk-approve="' + esc(t.id) + '" title="your gate: files it' + (T.github ? ' as a GitHub issue' : ' as a local ticket') + ' with the number in front of the title">Approve and file</span> <span class="btn ghost" data-tk-reject="' + esc(t.id) + '">Reject</span> <span class="btn ghost" data-tk-discuss title="take it back to the conversation">Discuss</span>' + '</div></div>';
    /* a refusal is said where the eye is, as a box above the buttons, not small text beside them (D15's approval had been refused, in a line he never saw) */
    if (T.err) h = h.replace('<div class="fd-acts"><span class="btn', '<div class="tk-refused" style="border:1px solid var(--amber);border-radius:8px;padding:8px 10px;margin:8px 0;color:var(--amber)"><b>Not filed:</b> ' + esc(T.err) + '</div><div class="fd-acts"><span class="btn');
    return h;
  }
  /* the last fleet item for a ticket, any status - the work's record (who, when, how long, what it said) */
  function fleetLast(id) { var f = T.fleet; if (!f) return null; var mine = (f.items || []).filter(function (i) { return i.project === X.room.id && i.ticket === id; }); return mine.length ? mine[mine.length - 1] : null; }
  function hhmm(iso) { return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''; }
  function mins(a, b) { var m = Math.round((Date.parse(b) - Date.parse(a)) / 60000); return m < 1 ? 'under a minute' : m + ' min'; }
  function agentLabel(id) { var f = T.fleet, ag = f && (f.agents || []).find(function (x) { return x.id === id; }); return ag ? ag.label : id; }
  /* where the ticket is, in one sentence, and what it waits for */
  function whereHtml(t) {
    var v = (t.verdicts || [])[t.verdicts.length - 1], it = fleetLast(t.id), qi = fleetItem(t.id), st = t.state;
    var who = it && it.claimedBy ? agentLabel(it.claimedBy) : null;
    var s = '';
    if (st === 'created') s = qi ? (qi.status === 'running' ? '<b>' + esc(agentLabel(qi.claimedBy)) + '</b> is starting on it.' : 'Approved and <b>on the queue</b> - an agent that is on takes it in its turn.') : 'Approved, <b>waiting to be worked</b>. <i>Work it</i> puts it on the queue for an agent; <i>Work it now</i> hands it to the AI in the header, here in the conversation.';
    else if (st === 'in-work') s = (who ? '<b>' + esc(who) + '</b> worked it' + (it.claimedAt ? ' at ' + hhmm(it.claimedAt) : '') + (it.outcome && it.outcome.at ? ' for ' + mins(it.claimedAt, it.outcome.at) : ' - still on it') + '. ' : 'In work in the conversation. ')
      + (v ? (v.green ? 'The verdict is green - it moves to verified on the next read.' : 'The verdict came back <b class="bad">red</b> - ' + v.checks.filter(function (c) { return !c.ok; }).length + ' of ' + v.checks.length + ' checks failed (below). It stays in work until a turn makes them pass' + (qi ? '' : '; <i>Work it</i> sends it round again') + '.') : 'The verdict lands when the turn ends and the rescan settles.');
    else if (st === 'verified') s = '<b>Verified by Cockpit</b>' + (v ? ' at ' + hhmm(v.at) + ' - all ' + v.checks.length + ' checks green' : '') + (gated() ? '. Waiting on <b>you</b>: read the done-when back on dev, then <i>Passed</i> - it goes to prod - or <i>Send back</i> with what is wrong.' : '. <b>Done.</b> Read it back on dev when you like; <i>Send back</i> if it is wrong.');
    else if (st === 'passed') {
      var P = T.promote || {}, ps = P.settings || {}, env = ps.env || 'prod', L = P.last;
      var passedAt = (t.history.filter(function (x) { return x.state === 'passed'; }).pop() || {}).at;
      if (P.running) s = '<b>Passed by you</b>. ' + (P.running.stage ? '<b>Running the environment</b> first - the tests, the app, the drill, DAST if it is a day old - then the gate, then ' + esc(env) + '…' : '<b>Promoting to ' + esc(env) + '</b> now - ' + esc(ps.mode === 'git' ? 'the ' + env + ' folder is being brought to dev\'s commit, then smoked' : 'watching') + '…');
      else if (ps.mode === 'observed') s = '<b>Passed by you</b>. This project\'s own pipeline takes it to <b>' + esc(env) + '</b>; Cockpit records it as promoted when the ' + esc(env) + ' endpoint reports a version carrying this ticket\'s commit.';
      else if (L && Date.parse(L.at) >= Date.parse(passedAt || 0) - 2000 && !L.ok && L.gate) s = '<b>Passed by you</b>, but nothing is promoted while the <a href="#" data-view-tests>Tests tab</a> is red: ' + esc(String(L.note || '').replace(/^the Tests tab is red - /, '')) + '. When it holds, <i>Promote again</i>.';
      else if (L && Date.parse(L.at) >= Date.parse(passedAt || 0) - 2000 && !L.ok) s = '<b>Passed by you</b>, but the promote to <b>' + esc(env) + '</b> at ' + hhmm(L.at) + ' <b class="bad">failed</b>: ' + esc(L.note || '') + (L.rolledBack ? ' - ' + esc(env) + ' was put back where it was.' : '.') + ' Fix that, then <i>Promote again</i>.';
      else if (L && Date.parse(L.at) >= Date.parse(passedAt || 0) - 2000 && L.ok) s = '<b>Passed by you</b>. The promote to <b>' + esc(env) + '</b> at ' + hhmm(L.at) + ' held (' + esc(String(L.to || '').slice(0, 9)) + '), but no commit in it names this ticket - the work is not committed, or the commit does not say ' + esc(t.number ? '#' + t.number : t.id) + '. Commit it naming the ticket, then <i>Promote again</i>.';
      else if (ps.trigger === 'manual') s = '<b>Passed by you</b>. Waiting for your <i>Promote</i> - this project promotes by hand (Tickets plugin settings).';
      else s = '<b>Passed by you</b>. It goes to <b>' + esc(env) + '</b> on its own' + (ps.to ? ' - the ' + esc(env) + ' folder <code>' + esc(ps.to) + '</code> is brought to dev\'s commit and smoked at ' + esc(ps.url || 'no url') : '') + '.';
    }
    else if (st === 'promoted') { var pe = (T.promote && T.promote.settings && T.promote.settings.env) || 'prod'; s = '<b>In ' + esc(pe) + '.</b> ' + (t.finding ? 'Closes on its own when the rescan shows the finding gone from its files.' : 'It came from an ask, not a finding - <i>Close</i> it when the problem is gone.'); }
    else if (st === 'closed') s = 'Closed.'; else if (st === 'rejected') s = 'Dropped.';
    return s ? '<div class="tk-where">' + s + '</div>' : '';
  }
  /* the verdict: green or red, the failed checks named with their detail; the rest behind a caret */
  function verdictHtml(t) {
    var vs = t.verdicts || []; if (!vs.length) return '';
    var v = vs[vs.length - 1], bad = v.checks.filter(function (c) { return !c.ok; }), good = v.checks.filter(function (c) { return c.ok; }), warns = bad.filter(function (c) { return c.blocks === false; });
    var h = '<div class="ar-sec">verdict <span class="dim">' + (vs.length > 1 ? vs.length + ' so far · last ' : '') + hhmm(v.at) + '</span></div>'
      // the rounds: every verdict so far, one line each - a ticket that went red, red, green reads as that, not as "green"
      + (vs.length > 1 ? '<div class="tk-rounds small">' + vs.map(function (x, i) { var reds = x.checks.filter(function (c) { return !c.ok && c.blocks; }).map(function (c) { return c.id; }); return '<div><span class="dim">' + (i + 1) + ' · ' + hhmm(x.at) + '</span> <span class="lg ' + (x.green ? 'ok' : 'bad') + '">' + (x.green ? 'green' : 'red') + '</span> ' + (reds.length ? '<span class="dim">' + esc(reds.join(', ')) + '</span>' : '') + '</div>'; }).join('') + '</div>' : '')
      + '<div class="tk-verdict ' + (v.green ? 'ok' : 'bad') + '"><span class="lg ' + (v.green ? 'ok' : 'bad') + '">' + (v.green ? 'green' : 'red') + '</span> ' + good.length + ' of ' + v.checks.length + ' checks passed' + (warns.length ? ', ' + warns.length + ' warning' + (warns.length === 1 ? '' : 's') : '') + ' <a href="#" class="small dim" data-view="plugins" title="what each check asks, and the switches - Settings › Plugins and cards › Tickets › Settings">the checks</a></div>';
    if (bad.length) h += '<div class="tk-checks">' + bad.map(function (c) { var warn = c.blocks === false; return '<div class="tk-check ' + (warn ? 'warn' : 'bad') + '" title="' + esc(c.asks || '') + '"><span class="tk-x">' + (warn ? '⚠' : '✗') + '</span><div><b>' + esc(c.name) + '</b>' + (warn ? ' <span class="dim small">warns only</span>' : '') + '<div class="small">' + esc(c.detail || '') + '</div>' + (c.fix ? '<div class="small dim" style="margin-top:3px">→ ' + esc(c.fix) + '</div>' : '') + '</div></div>'; }).join('') + '</div>';
    h += '<div class="tk-car small" data-car="checks-' + esc(t.id) + '"><span class="car">' + (T.car['checks-' + t.id] ? '▾' : '▸') + '</span> ' + (bad.length ? 'the ' + good.length + ' that passed' : 'the checks') + '</div>';
    if (T.car['checks-' + t.id]) h += '<div class="tk-checks">' + good.map(function (c) { return '<div class="tk-check ok" title="' + esc(c.asks || '') + '"><span class="tk-x">✓</span><div>' + esc(c.name) + ' <span class="dim small">' + esc(c.detail || '') + '</span></div></div>'; }).join('') + '</div>';
    return h;
  }
  /* the work: the last turn on it - who, when, how long, what it touched, what it said */
  function workHtml(t) {
    var it = fleetLast(t.id); var v = (t.verdicts || [])[t.verdicts.length - 1];
    var touched = (v && v.touched) || (it && it.outcome && it.outcome.files) || (t.touched || []);
    if (!it && !touched.length) return '';
    var h = '<div class="ar-sec">the work</div><div class="small">';
    if (it) h += (it.claimedBy ? '<b>' + esc(agentLabel(it.claimedBy)) + '</b>' : 'nobody yet') + (it.claimedAt ? ' took it at ' + hhmm(it.claimedAt) : '') + (it.outcome && it.outcome.at ? ', ended ' + hhmm(it.outcome.at) + ' (' + mins(it.claimedAt, it.outcome.at) + ')' : it.status === 'running' ? ', still on it' : '') + (it.turns > 1 ? ' · try ' + it.turns : '') + (it.outcome && it.outcome.cost && it.outcome.cost.usd ? ' · $' + Number(it.outcome.cost.usd).toFixed(2) : '') + (it.status === 'failed' ? ' · <b class="bad">gave up</b>' : '') + '<br>';
    if (touched.length) h += 'touched ' + touched.length + ' file' + (touched.length === 1 ? '' : 's') + ': ' + touched.slice(0, 12).map(esc).join(', ') + (touched.length > 12 ? ' …' : '');
    h += '</div>';
    if (it && it.outcome && it.outcome.text) { h += '<div class="tk-car small" data-car="said-' + esc(t.id) + '"><span class="car">' + (T.car['said-' + t.id] ? '▾' : '▸') + '</span> what it said</div>' + (T.car['said-' + t.id] ? '<pre class="tkf-pre small">' + esc(it.outcome.text) + '</pre>' : ''); }
    return h;
  }
  function historyHtml(t) {
    var open = T.car['hist-' + t.id];
    var h = '<div class="tk-car small" data-car="hist-' + esc(t.id) + '"><span class="car">' + (open ? '▾' : '▸') + '</span> history <span class="dim">· ' + t.history.length + '</span></div>';
    if (open) h += t.history.map(function (x) { return '<div class="small">' + (x.state ? '<b>' + esc(x.state) + '</b>' : 'note') + ' <span class="dim">' + ago(x.at) + (x.by ? ' · ' + esc(x.by) : '') + '</span>' + (x.why ? '<div class="dim">' + esc(x.why) + '</div>' : '') + (x.note ? '<pre class="tkf-pre small dim">' + esc(x.note) + '</pre>' : '') + '</div>'; }).join('');
    return h;
  }
  /* the declared files: alter, create, delete - and, while the ticket is not closed, the owner may fix them (the fence was
     wrong, as on L3) and ask for the verdict again on what the turns touched */
  function filesHtml(t) {
    var del = t.delete || [], canFix = t.state === 'created' || t.state === 'in-work' || t.state === 'verified';
    if (T.fixing === t.id) return '<div class="tk-fix"><label class="tkf-f"><span class="tkf-l">alter</span><textarea data-fx="alter" rows="3">' + esc(t.alter.join('\n')) + '</textarea></label><label class="tkf-f"><span class="tkf-l">create</span><textarea data-fx="create" rows="2">' + esc(t.create.join('\n')) + '</textarea></label><label class="tkf-f"><span class="tkf-l">delete</span><textarea data-fx="delete" rows="2">' + esc(del.join('\n')) + '</textarea></label><div class="plw-bar"><span class="btn sm" data-fx-save="' + esc(t.id) + '">Save files</span><span class="btn ghost sm" data-fx-cancel>Cancel</span></div></div>';
    return '<div class="small">' + (t.alter.length ? 'alter: ' + t.alter.map(esc).join(', ') : '') + (t.create.length ? '<br>create: ' + t.create.map(esc).join(', ') : '') + (del.length ? '<br>delete: ' + del.map(esc).join(', ') : '') + (!t.alter.length && !t.create.length && !del.length ? '— <span class="dim">none declared</span>' : '') + (canFix ? ' <span class="btn ghost sm" data-fx-open="' + esc(t.id) + '" title="fix what the ticket declares - then Verify again">Edit files</span>' : '') + '</div>';
  }
  function full(t) {
    var id = t.number ? '#' + t.number : t.id, nx = NEXT[t.state];
    var acts = '<div class="fd-acts fd-acts-top">'
      + (t.state === 'created' ? (fleetItem(t.id) ? '' : (T.queueing && T.queueing.id === t.id ? '' : '<span class="btn" data-tk-queue-open="' + esc(t.id) + '" title="puts it on the fleet queue with a priority; an agent that is on takes it in its turn, away from the keyboard">Work it</span> <span class="btn ghost" data-tk-work="' + esc(t.id) + '" title="hands-on: tells the AI in the header, in the conversation, right now">Work it now</span> ')) : '')
      + (t.state === 'in-work' && (t.touched || []).length ? '<span class="btn ghost sm" data-tk-verify="' + esc(t.id) + '" title="the verdict again, on the files the turns touched - after fixing what the ticket declares, or for a fresh read">Verify again</span> ' : '')
      + (t.state === 'passed' ? (function () { var P = T.promote || {}, ps = P.settings || {}; if (ps.mode === 'observed') return ''; if (P.running) return '<span class="btn dim">promoting…</span> '; var L = P.last, again = L && !L.ok; return (ps.trigger === 'manual' || again) ? '<span class="btn" data-tk-promote="' + esc(t.id) + '" title="the ' + esc(ps.env || 'prod') + ' folder is brought to dev\'s commit, the after-commands run, the url is smoked; the tickets the commits name are promoted">' + (again ? 'Promote again' : 'Promote') + '</span> ' : ''; })() : '')
      + (nx && t.state !== 'passed' && (gated() || t.state !== 'verified') ? '<span class="btn" data-tk-move="' + esc(t.id) + '" data-to="' + nx[0] + '" title="' + esc(nx[2]) + '">' + nx[1] + '</span> ' : '')
      + (BACK[t.state] ? '<span class="btn ghost" data-tk-move="' + esc(t.id) + '" data-to="' + BACK[t.state] + '" title="not right - back to in-work with a note">Send back</span> ' : '')
      + (t.state === 'created' ? '<span class="btn ghost" data-tk-move="' + esc(t.id) + '" data-to="rejected" title="drop it - it goes to closed as rejected">Drop</span>' : '')
      + '</div>';
    var h = '<div class="tk-full"><div class="fd-hd"><b>' + esc(id) + '</b> ' + esc(t.title.replace(/^#?\w+:\s*/, '')) + ' <span class="lg ' + (/verified|passed|promoted|closed/.test(t.state) ? 'ok' : 'quiet') + '">' + esc(t.state) + '</span>' + (t.url ? ' <a class="small" href="' + esc(t.url) + '" target="_blank">on GitHub ↗</a>' : '') + '<span class="tkx" data-tk-close title="close">✕</span></div>';
    h += '<div class="small dim">filed ' + ago(t.created) + ' by ' + esc(t.by) + (t.finding ? ' from the finding <b>' + esc(t.finding) + '</b>' : '') + (t.scope ? ' (' + esc(t.scope) + ')' : '') + (t.feature ? ' · feature <b>' + esc(t.feature) + '</b>' : '') + '</div>';
    h += acts;   // what you can do with it, where you look first - not at the foot of a long page
    /* ...and so does whatever a button OPENS. The ask box and the queue chooser used to render at the
       very bottom, under the verdict, the work log and the history. Pressing Work it or Drop made the
       button disappear and put the panel below the fold, so the card looked like it had closed and
       done nothing. They belong directly under the buttons that summon them. */
    h += askHtml(t) + (t.state === 'created' ? queueHtml(t) : '');
    h += whereHtml(t);
    h += '<div class="tk-cols"><div>' + (t.why ? '<div class="ar-sec">what</div><div class="small">' + esc(t.why) + '</div>' : '')
      + '<div class="ar-sec" style="margin-top:8px">done when</div><div class="small">' + esc(t.done || '—') + '</div>'
      + '<div class="ar-sec" style="margin-top:8px">files <span class="dim" style="text-transform:none;letter-spacing:0">- the fence the verdict checks the work against</span></div>' + filesHtml(t)
      + '<div class="ar-sec" style="margin-top:8px">impact</div><pre class="tkf-pre small">' + esc(t.impact.text || '') + '</pre></div>';
    /* One semicolon too early here meant askHtml / queueHtml / queueTable were computed and THROWN
       AWAY - a valid expression statement, so it passed every syntax check. Drop and Send back set the ask state, the
       card re-rendered, and the panel that asks for a reason was never in the page. Nothing was
       broken on the server; the question was simply never put. The Work it queue chooser and the
       queue table were missing for the same reason. */
    h += '<div>' + verdictHtml(t) + workHtml(t) + '<div style="margin-top:8px">' + historyHtml(t) + '</div></div></div>'
      + queueTable(t) + '</div>';
    return h;
  }

  /* ---------- the board ---------- */
  function chip(t) {
    var id = t.number ? '#' + t.number : t.id, working = T.working[t.id] && Date.now() - T.working[t.id] < 120000, qs = t.gh ? '' : queueState(t.id);
    /* a GitHub issue says what GITHUB can prove, in GitHub's words - never Cockpit's, which never touched it
       (the board was telling him "green - yours to test" about issues Cockpit had never seen) */
    if (t.gh) {
      var GHW = { 'not-started': 'on GitHub - not started', 'in-progress': 'a coder has it (label)', 'in-review': 'a pull request is open - its coder merges it once the checks are green', 'in-uat': 'on UAT - yours to test', verified: 'you marked it verified - waiting for prod', live: 'marked live', done: 'closed - done' };
      var late = undeployed(t.stage === 'verified' || t.stage === 'live' ? 'prod' : 'uat');
      if (late[t.number]) GHW[t.stage] = (t.stage === 'in-uat' ? 'merged - the UAT deploy has not run' : 'merged - not on prod yet');
      return '<a href="#" class="tkb-chip gh' + (T.open === t.id ? ' on' : '') + '" data-tk-open="' + esc(t.id) + '" title="' + esc(t.title) + (t.stageRule ? ' — ' + t.stageRule : '') + '"><b>' + esc(id) + '</b> <span class="tkb-t">' + esc(t.title) + '</span> <span class="lg quiet">' + esc(GHW[t.stage] || t.stage || 'on GitHub') + '</span></a>';
    }
    if (t.state === 'in-work') { var wn = workNow(t); if (wn) qs = wn; }   // in work: coding (who), testing, or stopped and why
    if (t.state === 'passed' && promoting()) qs = 'pushing - ' + (T.promote.running.stage || 'deploying');
    if (t.state === 'promoted' && !stoppedWhy(t)) qs = 'on prod - the flows are reading it back';
    if (t.state === 'verified') qs = 'on UAT - yours to test';
    var stop = stoppedWhy(t); if (stop) qs = stop;   // waiting on you: why, and the step it stopped at - this wins over everything
    return '<a href="#" class="tkb-chip' + (T.open === t.id ? ' on' : '') + (t.gh ? ' gh' : '') + '" data-tk-open="' + esc(t.id) + '" data-n="' + esc(t.number || '') + '" data-t="' + esc(t.title || '') + '" title="' + esc(t.title) + '"><b>' + esc(id) + '</b> <span class="tkb-t">' + esc(t.title.replace(/^#?\w+:\s*/, '')) + '</span>' + (t.band && t.band !== 'low' ? ' <span class="lg rm-' + esc(t.band) + '">' + esc(t.band) + '</span>' : '') + (qs ? ' <span class="lg ' + (/^on /.test(qs) ? 'ok' : 'quiet') + '">' + esc(qs) + '</span>' : '') + (working ? ' <span class="lg ok">sent</span>' : '') + (t.verdicts ? ' <span class="small dim">' + t.verdicts + '✓</span>' : '') + '</a>';
  }
  /* WHERE A TICKET IS: its state, read against the live facts - a turn on it, a verdict coming, a queue item, a promote
     running - and, before all of that, whether it is STOPPED. A stopped ticket moves to waiting on you and nowhere else,
     so that column is the whole of what the owner has to do. */
  function colOf(t) {
    if (stoppedWhy(t)) return 'waiting';
    if (t.state === 'passed') return promoting() ? 'toprod' : 'waiting';   // passed but nothing pushing: stoppedWhy says why
    return t.state;
  }
  function promoting() { return !!(T.promote && T.promote.running); }
  function gaveUp(t) { var last = fleetLast(t.id); return !!(last && last.status === 'failed'); }
  /* EVERYTHING THAT STOPS A TICKET AND NEEDS A PERSON - the words that go on its chip, and the step it stopped at.
     null means it is moving on its own: coding, tests, a verdict coming, a push running, or green and waiting for the
     owner's own test (UAT testing), which is the one normal green wait and has its own column. */
  function stoppedWhy(t) {
    if (t.gh) return null;                                                   // a GitHub-only issue has no Cockpit process to stop
    if (t.state === 'draft') return 'approve or reject · a draft';
    if (t.state === 'created' && gaveUp(t)) return 'the fleet gave up · to work';
    if (t.state === 'in-work') {
      if (gaveUp(t)) return 'the fleet gave up · in work';
      var live = (T.running || []).some(function (r) { return r.ticket === t.id; }) || (T.verifying || []).some(function (v) { return v.ticket === t.id; });
      var queued = !!fleetItem(t.id);
      if (!live && !queued) return 'stopped · nothing is working it';
    }
    if (t.state === 'passed' && !promoting()) {
      var L = T.promote && T.promote.last;
      if (L && !L.ok) return L.gate ? 'the gate is red · to prod' : (L.rolledBack ? 'the push failed, prod rolled back · to prod' : 'the push failed · to prod');
      return 'the push has not run · to prod';
    }
    if (t.state === 'promoted') {
      var P = T.promote && T.promote.last;
      if (P && P.flows && P.flows.failed) return 'the prod test failed · prod test';
      if (P && !P.ok) return 'the push failed · prod test';
    }
    return null;
  }
  /* what the coders are doing with it, on the chip: coding, its tests and verdict, or nothing - which is worth a look */
  function workNow(t) {
    var run = (T.running || []).some(function (r) { return r.ticket === t.id; }), it = fleetItem(t.id);
    if (run || (it && it.status === 'running')) return null;   // queueState says who
    if ((T.verifying || []).some(function (v) { return v.ticket === t.id; })) return 'tests and verdict running';
    return reviewWhy(t);
  }
  /* why a ticket needs review, in a few words - on its chip */
  function reviewWhy(t) {
    var last = fleetLast(t.id), v = t.verdicts && typeof t.verdicts === 'object' ? t.verdicts : null;
    if (last && last.status === 'failed') return 'the fleet gave up' + (last.outcome && last.outcome.verdict ? ' - ' + last.outcome.verdict : '') + ' - yours: send back with words, or queue it again';
    if (last && last.status === 'queued' && last.outcome && /^red/.test(last.outcome.verdict || '')) return last.outcome.verdict + ' · try ' + ((last.turns || 0) + 1) + ' of 3 queued';
    if (last && last.outcome && /^red/.test(last.outcome.verdict || '')) return 'came back ' + last.outcome.verdict;
    if (last && last.status === 'queued') return 'waiting for its next try';
    return 'stopped - nothing working it';
  }
  /* ---------- THE BOARD ON A GITHUB PROJECT ----------
     GitHub holds the ticket and the fleet holds its place in line, so a column is read from those two and nothing else -
     Cockpit's own ticket state is not consulted (it had #4101 "verified" while GitHub had it open and untested). One chip
     per issue. The queue feed arrives in queue order, so To work IS the order the coders take it in; ▲▼ move it. */
  var GH_COLS = [
    { key: 'open', title: 'Open tickets', what: 'On GitHub, not in the coders\' queue: nothing has put it there yet.' },
    { key: 'towork', title: 'To work', what: 'The queue, in the order the coders take it - top first. ▲▼ move a ticket within its priority.' },
    { key: 'coding', title: 'Being coded', what: 'A coder has it right now and no pull request is open yet.' },
    { key: 'tests', title: 'Running tests', what: 'A coder has it and its pull request is open: GitHub\'s tests are running on it. Green, and the coder merges.' },
    { key: 'uat', title: 'In UAT', what: 'Merged: the code is on UAT for you to test. The chip says if the UAT deploy has not run yet.' },
    { key: 'prodmerge', title: 'Waiting for prod merge', what: 'You passed it in UAT; it waits to be promoted to production.' },
    { key: 'prodtest', title: 'Prod test', what: 'On production - check it there. Passed, and the ticket closes.' },
    { key: 'complete', title: 'Complete', what: 'Shipped and closed, in the last 48 hours.' },
    { key: 'notdone', title: 'Not completed', what: 'A try ended without a merge. It is back in the queue with what went wrong, and goes again automatically - three tries, then Blocked.' },
    { key: 'blocked', title: 'Blocked', what: 'Cannot move until the named reason is cleared: waiting on you, the environment, a failed UAT deploy, or retries exhausted. Remove the blocked: label on GitHub and it goes back in the queue.' },
    { key: 'waiting', title: 'Waiting on a ticket', what: 'Yours, held until another ticket it needs is done (blocked:by-ticket). The last comment names which; it goes back in the queue when that ticket merges. Not someone else\'s work.' },
    { key: 'others', title: 'Assigned to others', what: 'On someone else\'s plate - assigned to anyone but you, or labelled as waiting on someone else. The coders leave these alone. Not blocked on you: Blocked is what needs you.' },
    { key: 'done', title: 'Done', what: 'Closed without shipping - a duplicate, not needed, or closed before it was worked. Shown for 48 hours after it closed.' }
  ];
  /* on prod: its PR merged, prod reports a version, and no landing newer than that version names it */
  function onProd(g) { return !!(g.merged && envSha('prod') && (T.landings || []).length && !undeployed('prod')[g.number]); }
  /* place in line: the queue feed arrives in the order the coders take it, across every project */
  function placeOf(it) { var n = 0, items = (T.fleet && T.fleet.items) || []; for (var k = 0; k < items.length; k++) { if (items[k].status !== 'queued') continue; n++; if (items[k].id === it.id) return n; } return 0; }
  function turnSince(it) { var r = (T.running || []).find(function (x) { return x.harness === it.claimedBy || x.agent === it.claimedBy; }); return r ? r.since : null; }
  function lastItem(n) { var f = T.fleet, out = null; ((f && f.items) || []).forEach(function (i) { if (i.project === X.room.id && itemNum(i) === String(n) && (!out || i.id > out.id)) out = i; }); return out; }
  var STAGE_COL = { 'stage:open': 'open', 'stage:to-work': 'towork', 'stage:being-coded': 'coding', 'stage:running-tests': 'tests', 'stage:in-uat': 'uat', 'stage:waiting-for-prod-merge': 'prodmerge', 'stage:prod-test': 'prodtest', 'stage:not-completed': 'notdone', 'stage:blocked': 'blocked', 'stage:waiting-on-a-ticket': 'waiting', 'stage:assigned-to-others': 'others' };
  function ghCol(g) {
    var it = lastItem(g.number), labels = g.labelList, blockedBy = labels.filter(function (l) { return /^blocked:/.test(l) || l === 'needs:decision'; })[0];
    if (g.stage === 'done') return g.merged || (it && it.status === 'merged') ? 'complete' : 'done';
    /* THE LABEL ON THE TICKET IS THE COLUMN. The engine's one rule (engine/ghstatus.js) writes it every two minutes; the rules below are its fallback only for
       a ticket not labelled yet (the first minutes after it is filed), and they are the same rules. */
    var stage = labels.filter(function (l) { return /^stage:/.test(l); });
    if (stage.length === 1 && STAGE_COL[stage[0]]) return STAGE_COL[stage[0]];
    /* Running tests only once THIS turn has pushed to the PR (#3006 showed Running tests while pi was
       coding - its PR was from the try before, still testing an older push). The turn's start is the running-turn feed's. */
    if (it && it.status === 'merging') return 'tests';   // green and in GitHub's merge queue: still on its way to UAT (engine/ghqueue.js)
    if (it && it.status === 'running') { var since = turnSince(it); return g.pr_open && g.pr_updated && since && g.pr_updated > since ? 'tests' : 'coding'; }
    /* WAITING ON THE UAT UPDATE IS NOT BLOCKED. A ticket whose only block is blocked:uat-deploy-failed has nothing wrong with it - it waits on one shared failed
       update. It shows in Running tests with a note saying so; its own queue item, if it has one, still wins. */
    var uatOnly = blockedBy === 'blocked:uat-deploy-failed' && labels.filter(function (l) { return /^blocked:/.test(l) || l === 'needs:decision'; }).length === 1;
    if (uatOnly && !(it && it.status === 'queued')) return 'tests';
    /* ASSIGNED TO OTHERS. A ticket on someone else's plate - assigned to anyone but the owner's account, or labelled waiting on someone else -
       is not blocked on the owner. Once it is past coding (on UAT, passed, live) it is the owner's to test and stays in those columns. */
    var past = labels.indexOf('status:live') >= 0 || labels.indexOf('status:verified') >= 0 || ((g.stage === 'in-uat' || (it && it.status === 'merged')) && !undeployed('uat')[g.number]);
    if (!g.others.length && labels.indexOf('blocked:by-ticket') >= 0 && labels.indexOf(T.otherLabel || 'blocked:waiting-on-someone-else') < 0 && !past) return 'waiting';   // yours, held on a ticket (engine/ghstatus.js, 2026-10-31)
    if ((g.others.length || labels.indexOf(T.otherLabel || 'blocked:waiting-on-someone-else') >= 0 || labels.indexOf('blocked:by-ticket') >= 0) && !past) return 'others';   // waiting on another ticket is not waiting on the owner (2026-09-26)
    if (blockedBy && !uatOnly) return 'blocked';
    if (labels.indexOf('status:live') >= 0) return 'prodtest';
    if (labels.indexOf('status:verified') >= 0) return onProd(g) ? 'prodtest' : 'prodmerge';
    /* a retry someone has handed to a coder is work waiting, not "not completed" (#4153 was assigned to a
       Claude coder and still sat in Not completed - "it shouldn't be in not completed then") */
    if (it && it.status === 'queued') return it.turns > 0 && !it.agent ? 'notdone' : 'towork';   // in the queue wins: an older merge was a part, and it was queued for the rest
    /* IN UAT MEANS ON UAT (27 merged tickets sat in In UAT for five hours while every UAT deploy failed).
       Merged but not in the version UAT reports: still on its way - Running tests - until the engine's 45-minute check calls
       the deploy failed and labels it blocked:uat-deploy-failed (engine/ghqueue.js), which puts it in Blocked above. */
    if (g.stage === 'in-uat' || (it && it.status === 'merged')) return undeployed('uat')[g.number] ? 'tests' : 'uat';
    if (it && (it.status === 'blocked' || it.status === 'parked')) return 'blocked';
    if (g.others.length) return 'others';   // somebody else's ticket
    return 'open';
  }
  /* the engine's words for how a turn ended, in the owner's (2026-09-24: a chip that said only "ceiling") */
  function said(r) { r = String(r || ''); if (/^done$/.test(r)) return 'ended without a merge'; return r.replace(/ceiling/g, 'ran out of time').replace(/crashed/g, 'the coder crashed').replace(/nothing merged/g, 'nothing was merged'); }
  /* the note on a merged ticket that is not on UAT yet: when it merged, and whether UAT is just updating or its updates are
     failing (45 minutes behind, as engine/ghqueue.js labels it) */
  function uatWait(n) {
    var rows = T.landings || [], sha = envSha('uat'), mine = null, uatAt = null;
    for (var i = 0; i < rows.length; i++) { var r = rows[i]; if (String(r.short || r.sha || '').slice(0, 7) === sha) { uatAt = r.at; break; } if (!mine && String(r.tickets || '').split(/[^0-9]+/).indexOf(String(n)) >= 0) mine = r; }
    var hm = function (t) { try { return new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
    if (!mine) return 'merged - not on UAT yet';
    if (Date.now() - Date.parse(mine.at) < 45 * 60000) return 'merged ' + hm(mine.at) + ' - on its way to UAT';
    // worded so the failure reads as UAT's, not the ticket's
    return 'this ticket is fine - merged ' + hm(mine.at) + ', waiting for the test site to update (the test site has been stuck on its ' + (uatAt ? hm(uatAt) : sha) + ' version). It moves to In UAT by itself.';
  }
  function ghTag(g) {
    var it = lastItem(g.number), labels = g.labelList, why = it && it.outcome && it.outcome.reason ? said(it.outcome.reason) : '';
    switch (g.col) {
      case 'towork': return ordinal(placeOf(it)) + ' in line · ' + it.priority;
      case 'coding': return 'on ' + agentLabel(it.claimedBy);
      case 'tests': if (undeployed('uat')[g.number]) return uatWait(g.number);
        if (it.status === 'merging') return 'in the merge queue' + (g.pr_open ? ' · PR #' + g.pr_open : '');
        return 'on ' + agentLabel(it.claimedBy) + ' · PR #' + g.pr_open + ' · checks ' + (g.pr_checks || 'unknown');
      case 'uat': return undeployed('uat')[g.number] ? 'merged - the UAT deploy has not run yet' : 'on UAT - yours to test';
      case 'prodmerge': return 'passed UAT - waiting for prod';
      case 'prodtest': return 'on prod - check it there';
      case 'notdone': return 'try ' + (it.turns + 1) + ' of 3 next · ' + ordinal(placeOf(it)) + ' in line' + (why ? ' · ' + why.replace(/^not completed \(try \d+ of \d+\):\s*/, '') : '');
      case 'waiting': return 'waiting on another ticket - see its last comment';
      case 'others': { if (labels.indexOf('blocked:by-ticket') >= 0 && !g.others.length) return 'waiting on another ticket';
        var who2 = g.others.map(function (o) { return (T.ghPeople || {})[o] || o; }).join(', ') || 'someone else'; var jb = labels.filter(function (l) { return /^blocked:|^needs:decision$/.test(l); })[0]; return 'with ' + who2 + (jb ? ' · ' + jb.replace(/^blocked:/, '').replace(/-/g, ' ') : ''); }
      case 'blocked': { var b = labels.filter(function (l) { return /^blocked:/.test(l) || l === 'needs:decision'; })[0]; return b ? b.replace(/^blocked:/, '').replace(/-/g, ' ') : g.others.length && !(it && it.status === 'blocked') ? 'waiting on ' + g.others.map(function (o) { return (T.ghPeople || {})[o] || o; }).join(', ') : (why || 'blocked'); }
      case 'complete': return 'shipped and closed';
      case 'done': return 'closed without shipping';
      default: return g.pr_open ? 'PR #' + g.pr_open + ' open · not in the queue' : 'not in the queue';
    }
  }
  /* the find box (see render): a number matches the start of a ticket's number; words match its title */
  function found(r) {
    var q = String(T.q || '').trim(); if (!q) return true;
    var num = /^#?(\d+)$/.exec(q);
    if (num) return String(r.number || '').indexOf(num[1]) === 0;
    var ql = q.toLowerCase(), id = String(r.cid || r.id || '').replace(/^gh:/, '').toLowerCase();
    return String(r.title || '').toLowerCase().indexOf(ql) >= 0 || id === ql;
  }
  /* while the owner types, the layout does not repaint a card that holds the focused field (shell/layout.js typingIn), so
     the find box filters the chips already on the page: hide what does not match, recount each column. The next full
     render filters the same way from T.q. */
  function filterInPlace(el) {
    el.querySelectorAll('.tkb-col').forEach(function (col) {
      var n = 0;
      col.querySelectorAll('.tkb-chip').forEach(function (ch) { var hit = found({ number: ch.dataset.n, title: ch.dataset.t, cid: ch.dataset.tkOpen }); (ch.closest('.tkb-row') || ch).style.display = hit ? '' : 'none'; if (hit) n++; });
      var c = col.querySelector('.tkb-hd .dim'); if (c) c.textContent = n;
    });
  }
  function ghRow(g, byNum) {
    var labels = []; try { labels = JSON.parse(g.labels || '[]'); } catch (e) { /* */ }
    var who = []; try { who = JSON.parse(g.assignees || '[]'); } catch (e) { /* */ }
    var x = Object.assign({}, g, { labelList: labels, others: who.filter(function (w) { return w && w !== (T.ghYou || ''); }) });
    x.col = ghCol(x); x.tag = ghTag(x); x.tk = (byNum && byNum[g.number]) || null;
    return x;
  }
  /* SEND BACK FROM UAT on a GitHub ticket: his words become the work order, at the top of the queue, and
     a comment on the issue (engine/ghqueue.js writes it on its next pass) */
  function sendBackGh(g, why) {
    var n = g.number, text = 'SENT BACK by the owner after testing it in UAT: "' + why + '"\n\n'
      + 'GitHub issue #' + n + '. Read it first: gh issue view ' + n + '\n\nPut exactly what the owner says right. Cut your own branch from origin/main (git checkout -b issue-' + n + '-fix origin/main), fix it, run the tests for what you touched, '
      + 'open a pull request whose body says "Part of #' + n + '" (never a closing keyword), and merge it yourself when CI is green - never --admin, never force.';
    return post('/api/fleet/items', { project: X.room.id, gh: n, title: '#' + n + ': ' + String(g.title).replace(/^#\d+:\s*/, ''), text: text, priority: 'next', source: 'sent back' });
  }
  function ghBoard() {
    var byNum = {}; (T.list || []).forEach(function (t) { if (t.number) byNum[t.number] = t; });   // a Cockpit ticket for the issue: its page opens on click
    var rows = (T.gh || []).map(function (g) { return ghRow(g, byNum); });
    /* tickets that live only in Cockpit (drafts and local tickets that were never filed on GitHub): placed by their own state */
    var CK = { draft: 'open', created: 'towork', 'in-work': 'coding', verified: 'uat', passed: 'prodmerge', promoted: 'prodtest', closed: 'complete', rejected: 'done' };
    /* GITHUB IS THE RECORD HERE (the In UAT column said 100 while 92 were GitHub tickets - the other 8 were
       Cockpit-only copies from before 09-24, 'verified' by Cockpit's own checks, D1 the same work as the closed #3026). Only a
       DRAFT still shows: it is a proposal waiting for the owner's word, and becomes a GitHub issue when approved. The old
       records stay in Cockpit; they are not on this board. */
    (T.list || []).filter(function (t) { return !t.number && t.state === 'draft'; }).forEach(function (t) { var q = fleetItem(t.id); rows.push({ number: null, cid: t.id, title: t.title.replace(/^#?\w+:\s*/, ''), col: t.state === 'created' && !q ? 'open' : CK[t.state] || 'open', tag: 'Cockpit only · ' + t.state, tk: t, labelList: [], others: [] }); });
    var place = {}; ((T.fleet && T.fleet.items) || []).forEach(function (i, k) { if (i.project === X.room.id && i.status === 'queued') { var n = itemNum(i); if (n && place[n] === undefined) place[n] = k; } });
    var order = function (a, b) { var pa = place[String(a.number)], pb = place[String(b.number)]; return (pa === undefined ? 1e9 : pa) - (pb === undefined ? 1e9 : pb); };
    return '<div class="tkb">' + GH_COLS.filter(function (c) { return !c.closedOnly || T.showClosed; }).map(function (c) {
      var items = rows.filter(function (r) { return r.col === c.key && found(r); });
      if (c.key === 'towork' || c.key === 'notdone') items.sort(order);
      return '<div class="tkb-col' + (c.key === 'blocked' && items.length ? ' hot' : '') + '"><div class="tkb-hd" title="' + esc(c.what) + '">' + esc(c.title) + ' <span class="dim">' + items.length + '</span></div>'
        + (items.length ? items.map(function (r) { return ghChip(r, c.key === 'towork'); }).join('') : '<div class="tkb-empty">–</div>') + '</div>';
    }).join('') + '</div>';
  }
  function ghChip(r, movable) {
    var id = r.number ? 'gh:' + r.number : r.cid, open = r.tk ? r.tk.id : id, it = r.number ? lastItem(r.number) : null;
    var failing = r.col === 'tests' && r.pr_checks === 'fail', ok = !failing && (r.col === 'coding' || r.col === 'tests' || r.col === 'complete'), bad = failing || r.col === 'blocked' || r.col === 'notdone';
    return '<div class="tkb-row">' + (movable && it ? '<span class="tkb-mv"><a href="#" data-tkmv="up" data-item="' + it.id + '" title="up one">▲</a><a href="#" data-tkmv="down" data-item="' + it.id + '" title="down one">▼</a></span>' : '')
      + '<a href="#" class="tkb-chip gh' + (T.open === open ? ' on' : '') + '" data-tk-open="' + esc(open) + '" data-n="' + esc(r.number || '') + '" data-t="' + esc(r.title || '') + '" title="' + esc(r.title) + '"><b>' + esc(r.number ? '#' + r.number : r.cid) + '</b> <span class="tkb-t">' + esc(String(r.title || '').replace(/^#\d+:\s*/, '')) + '</span> <span class="lg ' + (ok ? 'ok' : bad ? 'bad' : 'quiet') + '">' + esc(r.tag) + '</span></a></div>';
  }
  /* ▲▼ in To work: one step within the ticket's priority, the same reorder the Agent fleet card makes */
  function moveItem(itemId, dir) {
    var items = (T.fleet && T.fleet.items) || [], it = items.find(function (x) { return x.id === itemId; }); if (!it) return;
    var ids = items.filter(function (x) { return x.priority === it.priority && x.status === 'queued'; }).map(function (x) { return x.id; });
    var i = ids.indexOf(itemId), j = dir === 'up' ? i - 1 : i + 1; if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(i, 1); ids.splice(j, 0, itemId);
    post('/api/fleet/reorder', { ids: ids }).then(function () { T.loading = false; load(); });
  }
  /* THE BOARD FITS ITS CARD: the card's body was 436 px tall and the
     board 825, so the sideways scrollbar sat below the card's edge. The board takes the height left in the card under
     whatever sits above it, and fits again when the card is resized; a card too short for that keeps the screen-based cap. */
  function fitBoard(el) {
    var cb = el.closest('.cb'), tk = el.querySelector('.tkb'); if (!cb || !tk) return;
    var room = cb.clientHeight - (tk.getBoundingClientRect().top - cb.getBoundingClientRect().top) - 6;
    tk.style.maxHeight = room >= 220 ? room + 'px' : '';
    if (!el.__fitWatch && window.ResizeObserver) { el.__fitWatch = new ResizeObserver(function () { fitBoard(el); }); el.__fitWatch.observe(cb); }
  }
  function boardHtml(all) {
    var recent = function (t) { if (t.gh) { return !t.closedAt || Date.now() - Date.parse(t.closedAt) < PROMOTED_SHOWN_MS; } if (t.state !== 'closed') return true; var at = (t.history || []).filter(function (x) { return x.state === 'closed'; }).pop(); return !at || Date.now() - Date.parse(at.at) < PROMOTED_SHOWN_MS; };
    return '<div class="tkb">' + COLS.filter(function (c) {
      if (c.key === 'closed') return T.showClosed;
      if (c.gated) return gated();
      return true;
    }).map(function (c) {
      var items = all.filter(function (t) { return (t.col === c.key || c.states.indexOf(t.col) >= 0) && (c.key !== 'complete' || recent(t)) && found(t); });
      return '<div class="tkb-col' + (c.key === 'waiting' && items.length ? ' hot' : '') + '"><div class="tkb-hd" title="' + esc(c.what || '') + '">' + esc(c.title) + ' <span class="dim">' + items.length + '</span></div>' + (items.length ? items.map(chip).join('') : '<div class="tkb-empty">–</div>') + '</div>';
    }).join('') + '</div>';
  }

  // the conversation's approval strip opens a draft here in full (window.__tickets below reaches the desk's own board)
  function openIt(id) { T.open = id; T.pendingOpen = id; T.full = null; T.edit = null; if (/^gh:/.test(id)) { Layout.refresh(); return; } api(X.api + '/tickets/' + encodeURIComponent(id)).then(function (r) { T.full = r.ok ? r.ticket : null; Layout.refresh(); }); }
    function render(el) {
      var r = X.room; if (!r || r.missing) { el.innerHTML = '<div class="muted small">open a project</div>'; return; }
      // a project that does not use tickets - its retired tickets are not listed
      if (r.cockpit && r.cockpit.tickets === false) { Layout.paint(el, '<div class="muted small">Tickets are off for this project - its AI makes changes directly in the conversation. You can remove this card from the desk.</div>'); return; }
      if (T.project !== r.id) { T.project = r.id; T.list = null; T.gh = null; T.open = T.pendingOpen || null; T.full = null; T.version = r.version; T.working = {}; T.pendingOpen = null; }   // pendingOpen: a ticket asked for before the board had drawn this project (an alert clicked from Home)
      if (r.version !== T.version) { T.version = r.version; load(); }   // re-read, but keep drawing the list we have: blanking it here flashed "reading tickets…" on every turn end and every GitHub scan (2026-09-24)
      if (T.list === null) { load(); el.innerHTML = '<div class="muted small">reading tickets…</div>'; return; }
      var mine = T.list.map(function (t) { return Object.assign({ col: colOf(t) }, t); });
      /* ONE ROW PER ISSUE: a Cockpit ticket claims its GitHub issue by number OR by the number in its title - tickets filed
         while the GitHub plugin was misconfigured carry it there only, and without this the same work showed twice, once as
         L3 in to work and again as #2981 in work */
      var have = {}; mine.forEach(function (t) { if (t.number) have[t.number] = 1; var m = /#(\d{2,6})/.exec(String(t.title || '')); if (m) have[Number(m[1])] = 1; });
      var ghOnly = (T.gh || []).filter(function (g) { return !have[g.number]; }).map(function (g) { return { id: 'gh:' + g.number, number: g.number, title: g.title, state: g.stage, col: GH_STAGE[g.stage] || 'created', band: null, gh: true, url: g.url, closedAt: g.closed, stage: g.stage, stageRule: g.stage_rule, labels: g.labels }; });
      var all = mine.concat(ghOnly);
      var drafts = mine.filter(function (t) { return t.state === 'draft'; });
      if (drafts.length && T.features === null) { T.features = []; api(X.api + '/tickets/features').then(function (x) { T.features = x.ok ? x.features : []; Layout.refresh(); }); }
      /* FIND A TICKET: a number - 4135 or #4135 -
         keeps the tickets whose number starts with it; words keep the ones whose title has them. Enter on an exact number
         opens it. The columns show only what matches, with their counts. */
      var h = '<div class="tk-find" style="margin-bottom:6px"><input data-tk-q type="search" placeholder="Find a ticket - #4135 or words" value="' + esc(T.q || '') + '" style="width:260px">'
        + (T.q ? ' <a href="#" class="small" data-tk-q-clear>clear</a>' + (T.qMiss ? ' <span class="small" style="color:var(--amber)">' + esc(T.qMiss) + (T.qMissUrl ? ' - <a href="' + esc(T.qMissUrl) + '" target="_blank">open it on GitHub ↗</a>' : '') + '</span>' : '') : '') + '</div>'
        + '<div class="small dim" style="margin-bottom:8px">' + (T.github ? 'read from GitHub and the coders\' queue - hover a column name for what it means' : 'local tickets (no GitHub on this project)') + (ghOnly.length && !T.github ? ' · ' + ghOnly.length + ' from GitHub without a Cockpit ticket, placed by their PRs' : '') + ' · <a href="#" data-tk-closed>' + (T.showClosed ? 'hide closed' : 'show closed') + '</a>'
        + (T.err ? ' · <span class="bad">' + esc(T.err) + '</span>' : '') + '</div>';
      /* the open ticket's page comes FIRST, the columns under it (2026-09-20: with 38 tickets the columns ran past the card's
         height and the page opened below them, out of sight - "clicking a ticket doesn't work") */
      var page = '';
      if (T.open && /^gh:/.test(T.open)) { var gn = Number(T.open.slice(3)), g = (T.gh || []).find(function (x) { return x.number === gn; }); if (g) { var gi = lastItem(gn); page += '<div class="tk-full"><div class="fd-hd"><b>#' + g.number + '</b> ' + esc(String(g.title).replace(/^#\d+:\s*/, '')) + ' <span class="lg quiet">' + esc(g.stage) + '</span><span class="tkx" data-tk-close>✕</span></div><div class="small dim"><a href="' + esc(g.url) + '" target="_blank">open on GitHub ↗</a>' + (window.GitHubCards ? ' · <a href="#" data-gh-open="' + g.number + '">open the GitHub ticket card</a>' : '') + (g.pr_open ? ' · PR #' + g.pr_open + ' open, checks ' + esc(g.pr_checks || 'unknown') : '') + '</div>'
          + (gi ? '<div class="small" style="margin-top:6px">queue item #' + gi.id + ' · <b>' + esc(gi.status) + '</b>' + (gi.status === 'queued' ? ' · ' + ordinal(placeOf(gi)) + ' in line · priority <select data-qi="priority" data-item="' + gi.id + '">' + ['next', 'P1', 'P2', 'P3'].map(function (x) { return '<option' + (x === gi.priority ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' : '') + (gi.turns ? ' · ' + gi.turns + ' tr' + (gi.turns === 1 ? 'y' : 'ies') : '') + (gi.outcome && gi.outcome.reason ? '<div class="dim">last: ' + esc(said(gi.outcome.reason)) + '</div>' : '') + '</div>' : '<div class="small dim" style="margin-top:6px">not in the coders\' queue</div>')
          + (function () { var col = ghRow(g).col; if (['uat', 'prodmerge', 'prodtest'].indexOf(col) < 0) return '';
              if (T.sendBack !== gn) return '<div class="fd-acts"><span class="btn ghost" data-gh-back="' + gn + '" title="not right - back to the coders at the top of the queue, with your words as the work order and as a comment on the issue">Send back</span></div>';
              return '<div class="tk-ask"><div class="small" style="margin-bottom:6px"><b>Send it back</b> <span class="dim">- what is wrong, in your words: the coders get these words as the work order, at the top of the queue, and they go on the GitHub issue</span></div><textarea data-gh-why rows="3" placeholder="e.g. the page still shows the old menu on mobile">' + esc(T.sendWhy || '') + '</textarea>' + (T.sendErr ? '<div class="small" style="color:var(--amber);margin:4px 0">' + esc(T.sendErr) + '</div>' : '') + '<div class="plw-bar"><span class="btn sm" data-gh-back-go="' + gn + '">Send back</span><span class="btn ghost sm" data-gh-back-cancel>Cancel</span></div></div>'; })()
          + '</div>'; } }
      else if (T.open && T.full) page += T.full.state === 'draft' ? approvalHtml(T.full) : full(T.full);
      h += page + (T.github ? ghBoard() : boardHtml(all));
      /* Only repaint when something actually changed, or the 15-second poll flickers the whole board
         on every tick for nothing. Unchanged means the old nodes stay, listeners
         and scroll position with them, so there is nothing to rebind and nothing to re-scroll. */
      /* the board scrolls inside itself, so a repaint put it back at the top-left every refresh - where it was is read before the paint and put back after */
      var was = el.querySelector('.tkb'), sx = was ? was.scrollLeft : 0, sy = was ? was.scrollTop : 0;
      if (!Layout.paint(el, h)) { fitBoard(el); return; }
      fitBoard(el);
      var now = el.querySelector('.tkb'); if (now && now !== was) { now.scrollLeft = sx; now.scrollTop = sy; }
      if (page && T.scrollTo !== T.open) { T.scrollTo = T.open; var cb = el.closest('.cb') || el; cb.scrollTop = 0; }   // a page just opened: the card reads from its top
      el.querySelectorAll('[data-tk-open]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); T.open = T.open === a.dataset.tkOpen ? null : a.dataset.tkOpen; T.full = null; if (T.open && !/^gh:/.test(T.open)) api(X.api + '/tickets/' + encodeURIComponent(T.open)).then(function (x) { T.full = x.ok ? x.ticket : null; Layout.refresh(); }); else Layout.refresh(); }); });
      var gb = el.querySelector('[data-gh-back]'); if (gb) gb.addEventListener('click', function () { T.sendBack = Number(gb.dataset.ghBack); T.sendWhy = ''; T.sendErr = null; Layout.refresh(); });
      var gw = el.querySelector('[data-gh-why]'); if (gw) { gw.addEventListener('input', function () { T.sendWhy = gw.value; }); setTimeout(function () { gw.focus(); }, 0); }
      var gc = el.querySelector('[data-gh-back-cancel]'); if (gc) gc.addEventListener('click', function () { T.sendBack = null; Layout.refresh(); });
      var gg = el.querySelector('[data-gh-back-go]'); if (gg) gg.addEventListener('click', function () {
        var why = String(T.sendWhy || '').trim(); if (!why) { T.sendErr = 'Say what is wrong - the coders get these words as the work order.'; Layout.refresh(); return; }
        var g0 = (T.gh || []).find(function (x) { return x.number === Number(gg.dataset.ghBackGo); }); if (!g0) return;
        gg.textContent = 'sending…';
        sendBackGh(g0, why).then(function (r) { if (!r.ok) { T.sendErr = r.error || 'not queued'; Layout.refresh(); return; } T.sendBack = null; T.sendWhy = ''; T.sendErr = null; closeDetail(); T.loading = false; load(); });
      });
      var qi = el.querySelector('[data-tk-q]');
      if (qi) {
        if (T.qFocus && document.activeElement !== qi) { qi.focus(); try { qi.setSelectionRange(T.qPos, T.qPos); } catch (e) { /* */ } }   // the repaint replaced the box; keep typing where you were
        qi.addEventListener('input', function () { T.q = qi.value; T.qPos = qi.selectionStart; T.qFocus = true; T.qMiss = null; filterInPlace(el); });
        qi.addEventListener('focus', function () { T.qFocus = true; T.qPos = qi.selectionStart || (qi.value || '').length; });   // clicking the card repaints it: the box must come back focused
        qi.addEventListener('blur', function () { setTimeout(function () { if (!document.body.contains(qi)) return; if (document.activeElement !== qi) T.qFocus = false; }, 0); });   // a box removed by a repaint is not the owner leaving it
        qi.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { qi.value = ''; T.q = ''; T.qMiss = null; filterInPlace(el); return; }
          if (e.key !== 'Enter') return;
          var m = /^#?(\d+)$/.exec(String(T.q || '').trim()); if (!m) return;
          var n = Number(m[1]), tk = (T.list || []).find(function (t) { return Number(t.number) === n; }), onBoard = (T.gh || []).some(function (g) { return g.number === n; });
          T.qFocus = false; qi.blur();   // leaving the box lets the card repaint (the page, or the note below)
          if (!tk && !onBoard) { var any = (T.gh || []).find(function (g) { return g.url; }); T.qMiss = '#' + n + ' is not on the board - closed more than two days ago, or not a ticket in this project'; T.qMissUrl = any ? String(any.url).replace(/\/issues\/\d+$/, '/issues/' + n) : null; Layout.refresh(); return; }
          T.qFocus = false; openIt(tk ? tk.id : 'gh:' + n);
        });
      }
      var qc = el.querySelector('[data-tk-q-clear]'); if (qc) qc.addEventListener('click', function (e) { e.preventDefault(); T.q = ''; T.qMiss = null; Layout.refresh(); });
      el.querySelectorAll('[data-tkmv]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); moveItem(Number(a.dataset.item), a.dataset.tkmv); }); });
      el.querySelectorAll('[data-tk-move]').forEach(function (b) { b.addEventListener('click', function () { move(b.dataset.tkMove, b.dataset.to); }); });
      var vt = el.querySelector('[data-view-tests]'); if (vt) vt.addEventListener('click', function (e) { e.preventDefault(); var n = document.querySelector('.nav a[data-page="tests"]'); if (n) n.click(); });
      var pb = el.querySelector('[data-tk-promote]'); if (pb) pb.addEventListener('click', function () { pb.textContent = 'promoting…'; post(X.api + '/promote', { by: 'owner' }).then(function (r) { if (!r.ok && r.error) alert(r.error); T.list = null; T.full = null; load(); __tickets.open(pb.dataset.tkPromote); }); });
      var aw = el.querySelector('[data-ask-why]'); if (aw) { aw.addEventListener('input', function () { T.asking.why = aw.value; }); setTimeout(function () { aw.focus(); }, 0); }
      /* No reason typed used to refocus the box and return - the press did nothing and said nothing,
         which reads as a broken button (trying to drop #2994). Say why it stopped. */
      var ag = el.querySelector('[data-ask-go]'); if (ag) ag.addEventListener('click', function () {
        var a = T.asking;
        if (!a.why.trim()) { a.err = (a.to === 'created' || a.to === 'in-work') ? 'Say what is wrong - the coders get these words as the work order.' : 'Say why it is being dropped - it goes on the record.'; Layout.refresh(); return; }
        a.err = null; move(a.id, a.to, a.why.trim());
      });
      var ac = el.querySelector('[data-ask-cancel]'); if (ac) ac.addEventListener('click', function () { T.asking = null; Layout.refresh(); });
      el.querySelectorAll('[data-tk-work]').forEach(function (b) { b.addEventListener('click', function () { var t = T.full; if (t) work(t); }); });
      el.querySelectorAll('[data-tk-queue-open]').forEach(function (b) { b.addEventListener('click', function () { T.queueing = { id: b.dataset.tkQueueOpen, priority: 'P2', agent: '' }; Layout.refresh(); }); });
      el.querySelectorAll('[data-q]').forEach(function (sel) { sel.addEventListener('change', function () { if (T.queueing) T.queueing[sel.dataset.q] = sel.value; }); });
      el.querySelectorAll('[data-tk-queue]').forEach(function (b) { b.addEventListener('click', function () { var t = T.full; if (t) queueIt(t); }); });
      var qc = el.querySelector('[data-tk-queue-cancel]'); if (qc) qc.addEventListener('click', function () { T.queueing = null; Layout.refresh(); });
      el.querySelectorAll('[data-tk-unqueue]').forEach(function (b) { b.addEventListener('click', function () { var t = T.full; if (t) unqueue(t); }); });
      var tv = el.querySelector('a[data-view="plugins"]'); if (tv) tv.addEventListener('click', function (e) { e.preventDefault(); var n = document.querySelector('.nav a[data-view="plugins"]'); if (n) n.click(); });
      var fo = el.querySelector('[data-fx-open]'); if (fo) fo.addEventListener('click', function (e) { T.fixing = fo.dataset.fxOpen; Layout.refresh(); });
      var fc = el.querySelector('[data-fx-cancel]'); if (fc) fc.addEventListener('click', function () { T.fixing = null; Layout.refresh(); });
      var fsv = el.querySelector('[data-fx-save]'); if (fsv) fsv.addEventListener('click', function () { var g = function (k) { return el.querySelector('[data-fx="' + k + '"]').value; }; post(X.api + '/tickets/' + encodeURIComponent(fsv.dataset.fxSave) + '/files', { alter: g('alter'), create: g('create'), delete: g('delete') }).then(function (r) { if (!r.ok) { alert(r.error); return; } T.fixing = null; T.full = r.ticket; load(); }); });
      var vb = el.querySelector('[data-tk-verify]'); if (vb) vb.addEventListener('click', function () { vb.textContent = 'verifying…'; post(X.api + '/tickets/' + encodeURIComponent(vb.dataset.tkVerify) + '/verify', {}).then(function (r) { if (!r.ok) alert(r.error); T.list = null; T.full = null; load(); window.__tickets.open(vb.dataset.tkVerify); }); });
      el.querySelectorAll('[data-car]').forEach(function (c) { c.addEventListener('click', function () { T.car[c.dataset.car] = !T.car[c.dataset.car]; Layout.refresh(); }); });
      el.querySelectorAll('[data-qi]').forEach(function (sel) { sel.addEventListener('change', function () { var body = {}; body[sel.dataset.qi] = sel.value || null; post('/api/fleet/items/' + sel.dataset.item, body).then(function (r) { if (!r.ok) alert(r.error); load(); }); }); });
      var c = el.querySelector('[data-tk-close]'); if (c) c.addEventListener('click', function () { T.open = null; T.full = null; T.edit = null; Layout.refresh(); });
      var go = el.querySelector('[data-gh-open]'); if (go) go.addEventListener('click', function (e) { e.preventDefault(); if (window.TicketCards) { window.TicketCards.ticket = 'gh:' + go.dataset.ghOpen; openIt('gh:' + go.dataset.ghOpen); } });
      el.querySelectorAll('[data-e]').forEach(function (i) { i.addEventListener(i.tagName === 'SELECT' ? 'change' : 'input', function () { T.edit[i.dataset.e] = i.value; if (i.tagName === 'SELECT') Layout.refresh(); }); });
      var ap = el.querySelector('[data-tk-approve]'); if (ap) ap.addEventListener('click', function () {
        if (T.busy) return; var e = T.edit; var feature = e.feature === '__new' ? e.newFeature.trim() : e.feature;
        if (!e.title.trim()) { T.err = 'a title is needed'; Layout.refresh(); return; } if (e.feature === '__new' && !feature) { T.err = 'name the new feature'; Layout.refresh(); return; }
        T.busy = true; T.err = null; Layout.refresh();
        post(X.api + '/tickets/' + encodeURIComponent(ap.dataset.tkApprove) + '/approve', { edits: { title: e.title.replace(/^#?\w+:\s*/, ''), feature: feature, alter: e.alter, create: e.create, delete: e.delete, done: e.done, why: e.why } })
          /* Filing it CLOSES the card and puts you back in the columns. Re-opening
             the detail on the ticket it just filed looked like the button had done nothing: same panel,
             same place, and the row still sitting in a column. */
          .then(function (x) { T.busy = false; if (!x.ok) { T.err = x.error; Layout.refresh(); return; } T.edit = null; T.features = null; T.list = null; T.open = null; T.full = null; if (window.TicketCards) window.TicketCards.ticket = null; load(); })
          /* A rejected post used to leave busy stuck on, and busy short-circuits every later click -
             one network blip and no button on the card worked again until a reload, with nothing said. */
          .catch(function (err) { T.busy = false; T.err = 'could not file it: ' + ((err && err.message) || err); Layout.refresh(); });
      });
      var rj = el.querySelector('[data-tk-reject]'); if (rj) rj.addEventListener('click', function () { if (!confirm('Drop this draft?')) return; post(X.api + '/tickets/' + encodeURIComponent(rj.dataset.tkReject) + '/reject', {}).then(function () { T.open = null; T.full = null; T.edit = null; T.list = null; if (window.TicketCards) window.TicketCards.ticket = null; load(); }).catch(function (err) { T.err = 'could not drop it: ' + ((err && err.message) || err); Layout.refresh(); }); });
      var ds = el.querySelector('[data-tk-discuss]'); if (ds) ds.addEventListener('click', function () { var t = T.full, ta = document.querySelector('#cv-in'); if (!ta) return; ta.value = 'About the draft ticket ' + t.id + ' "' + t.title + '" (files: ' + t.alter.concat(t.create).join(', ') + '; done when: ' + t.done + '): '; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); });
      var sc = el.querySelector('[data-tk-closed]'); if (sc) sc.addEventListener('click', function (e) { e.preventDefault(); T.showClosed = !T.showClosed; Layout.refresh(); });
    }
    /* The refresh NEVER runs while you are typing into the card: the ask box (drop / send back), a
       draft being edited, a queue choice open, or a post in flight. Re-rendering under you wipes the
       caret and re-focuses the textarea mid-sentence, which is worse than a slightly stale board.
       Acting on the card reloads it anyway, so nothing goes stale for long. */
    /* Only hold the refresh for something STILL ON SCREEN. T.edit is set the moment a draft renders
       and is only cleared when it is filed, so counting it alone would stop the board refreshing for
       the rest of the session once a draft had been looked at and closed. */
    function midEdit() { return !!(T.busy || T.asking || T.fixing || (T.queueing && T.open === T.queueing.id) || (T.edit && T.open === T.edit.id)); }
    /* A REFRESH DOES NOT BLANK THE CARD. Clearing T.list first made the next render fall into the
       "reading tickets..." branch - a direct innerHTML write that bypasses paint - so every poll
       showed the board, then 0.7s of placeholder, then the board again. Measured 2026-09-23:
       126,818 chars -> 47 -> 126,818. That is the flash. load() replaces the list when the data
       arrives, so there is nothing to clear; the old board simply stays up until the new one is
       ready, and paint then finds it identical and writes nothing at all. */
    return { openIt: openIt, render: render, use: function (c) { X = c; }, poke: function () { if (T.list !== null && !midEdit()) load(); } };
  }
  var INST = {};
  /* The board refreshes itself (every 15s). It has always had poke() and nothing
     ever called it, so the card showed the fleet as of the last time it was opened or clicked. A
     ticket the fleet gave up on kept sitting in "in work" looking like a coder had it - gaveUp()
     reads the fleet item's status, and that status was stale. Waiting on you is the column that is
     meant to be trusted, so it is the one that must not go quietly out of date. */
  setInterval(function () { if (window.ROOM) Object.keys(INST).forEach(function (k) { INST[k].poke(); }); }, 15000);
  window.__tickets = { open: function (id) { inst().openIt(id); } };
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('tickets') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Board(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'tickets', plugin: 'tickets', icon: '🎫', title: 'Tickets', purpose: 'the board: every ticket in the column it is in, and the one move each is waiting for', zone: 'stage', pos: 1, size: [12, 14], min: [6, 8], max: [12, 40], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
})();
