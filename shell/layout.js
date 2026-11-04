/* Cockpit layout engine — zero dependencies.
   v3 (no columns; every card dynamic): the room is a
   DESK. Every card is a window - anywhere, any size, they overlap, a click brings one to the
   front. Move by the header; resize from any edge or corner. Each card carries its own settings
   under ⚙: placement (free · drawer left · drawer right), size (fixed, the
   content scrolls · grows with the content, the height is the content's) and the lock.
   Double-click a header to fill the room, again to put it back. Free pixels, no snapping.
   A layout saved by the column engine (v1/v2: zones + order + cols×rows) converts ONCE into the
   same picture in pixels, so the first load after this change looks like the last one before it.
   Cards still DECLARE themselves in the old units (zone, pos, size/min/max in cols×rows; 24
   columns, 40 px rows) - that is only the recipe for a card's first placement and its limits.
   Layout persists per project (server) with a localStorage fallback.
   Step 3 from the same conversation - arrange mode with lit edges and rotation - builds on this file: rot is
   stored per card already, always 0 for now. Drawers: see L.dock below. */
(function () {
  'use strict';
  var ROW = 40, GAP = 12, COLS = 24;
  var ZONES = { full: { cols: 24, x: 0 }, left: { cols: 5, x: 0 }, stage: { cols: 12, x: 5 }, right: { cols: 7, x: 17 } };   // the recipe for a first placement; 'full' = a banner across the top
  var LAYOUT_V = 3;
  /* the cards whose height follows their content unless the person says otherwise: the ones that
     call Layout.snug today (the fleet with its queue open or closed, lists that vary by project) */
  var GROWS = { fleet: 1, project: 1, 'tk-attention': 1, 'tk-deploys': 1 };
  var L = { cards: {}, pos: {}, locked: {}, hidden: {}, promoted: null, before: null, person: 'default', root: null, colW: 60, zTop: 1, legacy: null,
    /* DRAWERS (step 2): a card whose mode is left/right is off the desk - a tab on that edge of the screen, in the
       dock's order (draggable). Click the tab and it slides open over the desk; one open per side; a click
       outside, the tab again or Esc closes it. Its x/y/h are kept for when it comes back to the desk; its w is
       the drawer's width, dragged at the inner edge. */
    dock: { left: [], right: [], top: [] }, open: { left: null, right: null, top: null }, rooms: {},
    /* lifted = the one card selected - in front of the rest. (An earlier tilted desk was removed; the desk is flat
       everywhere.) */
    lifted: null };
  var SIDES = ['left', 'right', 'top'];
  /* STACKS.
     One stack per card type, one switch in each member's header. On the desk: the members share ONE place and size; the
     front is drawn with a row of file tabs above it, one per project; click a tab and that card takes the space. In a
     drawer: the members' shelf tabs merge into one group, dragged along the shelf as one. Off = loose cards. Saved with
     the layout. */
  L.stacks = {};
  function stackOf(key) { var s = L.stacks[typeOf(key)]; return s && s.on ? s : null; }
  /* the stack's members on THIS desk: on the desk proper (deskMembers) or in a drawer (dockMembers); the switch shows when the
     type has two or more cards here in any mode */
  function typeMembers(t) { return instances().filter(function (k) { return typeOf(k) === t && !L.hidden[k] && L.pos[k] && !isWindow(k) && L.promoted !== k; }); }
  function deskMembers(t) { return typeMembers(t).filter(function (k) { return !side(k); }); }
  function stackable(key) { var m = T(key) && T(key).multi ? typeMembers(typeOf(key)) : []; return m.length >= 2 && m.indexOf(key) >= 0; }
  function stackHidden(key) { var s = stackOf(key); return !!(s && !side(key) && deskMembers(typeOf(key)).length >= 2 && s.front !== key); }   // a desk member behind the front is not drawn
  function applyStacks() {
    Object.keys(L.stacks).forEach(function (t) {
      var s = L.stacks[t]; if (!s || !s.on) return;
      var m = deskMembers(t); if (m.length < 2) return;
      if (!s.front || m.indexOf(s.front) < 0) s.front = m[0];
      var f = L.pos[s.front];
      /* the stack has ONE place and ONE size: the front moved or grew - the stack did; a new front takes the stack's place, the
         card does not change size when you switch (the columns inside it may) */
      if (s.anchor && s.frontWas === s.front) s.anchor = { x: f.x, y: f.y, w: f.w, h: f.h };
      else if (s.anchor) { f.x = s.anchor.x; f.y = s.anchor.y; f.w = s.anchor.w; f.h = s.anchor.h; }
      else s.anchor = { x: f.x, y: f.y, w: f.w, h: f.h };
      s.frontWas = s.front;
      m.forEach(function (k) { if (k === s.front) return; var p = L.pos[k]; p.x = f.x; p.y = f.y; p.w = f.w; p.h = f.h; p.rot = 0; });
    });
  }
  /* the file tabs above the front card: one per member, the front lit; click one and that card takes the space */
  function stackTabsHtml(key) {
    var s = stackOf(key); if (!s || side(key)) return '';
    var m = deskMembers(typeOf(key)); if (m.length < 2 || s.front !== key) return '';
    return '<div class="stack-tabs">' + m.map(function (k) { var c = T(k); return '<span class="stab' + (k === key ? ' on' : '') + '" data-stab="' + k.replace(/"/g, '&quot;') + '" title="' + (c.title + ' · ' + projName(k)).replace(/"/g, '&quot;') + '">' + (window.Icons ? '<span class="stab-ico">' + Icons.of(c, 12) + '</span>' : '') + projName(k) + '</span>'; }).join('') + '</div>';
  }
  function setStack(key, on) {
    var t = typeOf(key); L.stacks[t] = { on: !!on, front: side(key) ? null : key };
    if (on && !side(key)) { var f = L.pos[key]; if (f) f.z = ++L.zTop; }
    if (on) SIDES.forEach(function (sd) { groupAdjacent(sd); });
    place(false); save();
  }
  function bringForward(key) { var s = stackOf(key); if (!s || s.front === key) return; s.front = key; var f = L.pos[key]; if (f) f.z = ++L.zTop; place(false); save(); }
  /* in a dock, a stack's members sit together as one group; the group is dragged along the shelf as one thing */
  function groupAdjacent(sd) {
    var order = L.dock[sd] || [], seen = {}, out = [];
    order.forEach(function (id) { if (seen[id]) return; var t = typeOf(id), st = L.stacks[t]; if (st && st.on && T(id) && T(id).multi) { order.forEach(function (o) { if (typeOf(o) === t && !seen[o]) { out.push(o); seen[o] = true; } }); } else { out.push(id); seen[id] = true; } });
    L.dock[sd] = out;
  }
  function side(id) { var p = L.pos[id]; return p && SIDES.indexOf(p.mode) >= 0 ? p.mode : null; }
  /* INSTANCES (step 1 of Home, 2026-09-19): what sits on a desk is an instance of a card type. Its key is the type's
     id for the desk's own project ("conversation" - so every saved layout still matches), or "type@project" for
     another project's card pulled onto this desk (a list "type@a+b" for a card that shows several projects at
     once). Each render gets a ctx saying which project(s) it is for; a type that reads its project from ctx (not
     from window.ROOM / Layout.state.api) says `multi: true` and may live on any desk. L.rooms caches the other
     projects' room facts (the shell fills it before build and in ensureCards). */
  function typeOf(key) { var i = key.indexOf('@'); return i < 0 ? key : key.slice(0, i); }
  function projOf(key) { var i = key.indexOf('@'); return i < 0 ? L.project : key.slice(i + 1).split('+')[0]; }
  function projectsOf(key) { var i = key.indexOf('@'); return i < 0 ? [L.project] : key.slice(i + 1).split('+'); }
  function T(key) { return L.cards[typeOf(key)]; }
  function isForeign(key) { return key.indexOf('@') > 0; }
  function ctx(key) { var pr = projOf(key), own = !isForeign(key), rs = Object.assign({}, L.rooms); if (L.project && window.ROOM) rs[L.project] = window.ROOM; return { key: key, type: typeOf(key), project: pr, projects: projectsOf(key), api: '/api/p/' + pr, room: rs[pr] || null, rooms: rs, own: own }; }
  function instances() {
    var ks = Object.keys(L.cards);
    Object.keys(L.pos).forEach(function (k) { if (isForeign(k) && T(k) && T(k).multi) ks.push(k); });
    return ks;
  }

  /* HOW A CARD PAINTS ITSELF - the house rule, for every card and every new one
    .

       if (!Layout.paint(el, html)) return;      <- then bind your handlers
       el.querySelectorAll('[data-x]').forEach(...)

     NEVER `el.innerHTML = html` in a card's render. refresh() runs on every poll and on every
     state change, and a card that rebuilds its DOM unconditionally throws away its nodes, its
     listeners and the reader's scroll position each time - that is the flicker.

     paint() writes only when the html differs from what is already there, and returns whether it
     wrote. The early return is the point: if it did not write, the old nodes are still in place
     WITH their listeners, so rebinding would stack another copy on every tick - one click firing
     five times. Bind only after a write.

     Two things are fine as they are: a one-shot placeholder ("reading...") that is followed by
     `return`, and insertAdjacentHTML layered on top of an already painted card. */
  /* THE CODING GATE (owner, 2026-10-25): every coding/DevOps card sits behind the engine-wide Coding plugin, off by default.
     A card is a coding card when it says `coding: true` (the fleet, lane performance, alerts, the event log, backups, data
     views) or belongs to a plugin whose plugin.json says "group": "coding" (the board, pipeline, deploys, needs-attention,
     the database, ...). With Coding off such a card is not registered at all - so it is nowhere: not on a desk, not in a
     drawer, not in ＋ Card or Settings, not in the icon list. Its place in a saved layout is kept (an unknown own key keeps
     its spot - restore), so switching Coding on again brings it back exactly where it was. L.all holds every card that
     registered; L.cards only those the gate lets through. The shell sets the gate (setCoding) before it lays a desk out. */
  L.all = {}; L.coding = false; L.groups = {};
  function isCoding(c) { return !!(c.coding || (c.plugin && L.groups[c.plugin] === 'coding')); }
  function gateOpen(c) { return L.coding || !isCoding(c); }
  function register(card) { L.all[card.id] = card; if (gateOpen(card)) L.cards[card.id] = card; else delete L.cards[card.id]; }
  function setCoding(on, groups) {
    L.coding = !!on; if (groups) L.groups = groups;
    Object.keys(L.all).forEach(function (id) { if (gateOpen(L.all[id])) L.cards[id] = L.all[id]; else delete L.cards[id]; });
  }
  function sizeMode(id) { var p = L.pos[id]; return p && p.size ? p.size : ((T(id) && T(id).grows) || GROWS[typeOf(id)] ? 'grow' : 'fixed'); }
  function newPos(id, x, y, w, h) { return { x: x, y: y, w: w, h: h, z: ++L.zTop, mode: 'free', size: sizeMode(id), rot: 0 }; }
  /* the column recipe → pixels: the three columns, each card under the one before it (this is
     exactly what the column engine drew, so a converted layout is the same picture) */
  function flow(order, sizes) {
    L.pos = {}; L.zTop = 1;
    var top = 0;   // the full-width cards first; the three columns start under them
    ['full', 'left', 'stage', 'right'].forEach(function (z) {
      var zc = ZONES[z].cols, zx = ZONES[z].x, y = z === 'full' ? 0 : top;
      (order[z] || []).forEach(function (id) {
        var c = T(id); if (!c) return;
        if (L.hidden[id]) { L.pos[id] = newPos(id, zx * L.colW + GAP / 2, y, Math.min(c.size[0], zc) * L.colW - GAP, c.size[1] * ROW - GAP); return; }   // a hidden card takes no space (it gets a place for when it is shown)
        var s = (sizes && sizes[id]) || { cols: c.size[0], rows: c.size[1] }, cols = Math.min(s.cols, zc);
        L.pos[id] = newPos(id, zx * L.colW + GAP / 2, y, cols * L.colW - GAP, s.rows * ROW - GAP);
        y += s.rows * ROW;
      });
      if (z === 'full') top = y;
    });
  }
  /* THE NEW-PROJECT TEMPLATE: the scene "Default Project Layout" on Home, read live by the shell
     into L.template. A project with no layout of its own starts from it: its own cards where the scene put them (a
     plugin card keeps its spot and appears when the plugin comes on), the drawers; Home-only cards and other
     projects' cards in the scene are left out. Reset layout uses it too when the project saved no default. */
  function fromTemplate(t) {
    if (!t || !t.pos) return null;
    var pos = {}, dock = { left: [], right: [], top: [] }, hidden = {}, locked = {};
    var lift = 0;   // the window (the greeting) is Home's: the cards under it move up by its height, a project has no banner
    Object.keys(t.pos).forEach(function (k) { if (isForeign(k)) return; var c = L.cards[k]; if (c && c.home) { if (c.window) lift = Math.max(lift, (t.pos[k].y || 0) + (t.pos[k].h || 0) + GAP); return; } pos[k] = Object.assign({}, t.pos[k]); });
    if (lift) Object.keys(pos).forEach(function (k) { pos[k].y = Math.max(0, pos[k].y - lift); });
    SIDES.forEach(function (sd) { ((t.dock || {})[sd] || []).forEach(function (k) { if (pos[k]) dock[sd].push(k); }); });
    // only a NON-plugin card's closedness carries over; a plugin card (known here or not yet loaded) is shown by its plugin's switch alone, the first time it comes on
    Object.keys(t.hidden || {}).forEach(function (k) { var c = L.cards[k]; if (pos[k] && t.hidden[k] === 1 && c && !c.plugin && !c.home) hidden[k] = 1; });
    Object.keys(t.locked || {}).forEach(function (k) { if (pos[k]) locked[k] = 1; });
    return { v: LAYOUT_V, pos: pos, dock: dock, hidden: hidden, locked: locked };
  }
  /* in a project, Home's cards stay off and a plugin card whose plugin is off stays off - the same marks the shell sets at
     load, so a Reset layout (which builds from the template) does not put the greeting on a project's desk */
  function markKinds() {
    /* a card that belongs to ONE project (projectOnly, e.g. a boxed card) is off on every other desk - on Home it
       sits only as that project's card (type@project), never as Home's own */
    Object.values(L.cards).forEach(function (c) { if (c.projectOnly && L.project !== c.projectOnly && !L.hidden[c.id]) L.hidden[c.id] = 'project'; });
    if (L.project === 'home') return;
    Object.values(L.cards).forEach(function (c) { if (c.home) { if (!L.hidden[c.id]) L.hidden[c.id] = 'home'; } else if (c.plugin && !pluginOn(c.plugin)) { if (!L.hidden[c.id]) L.hidden[c.id] = 'plugin'; } });
  }
  /* A NEW DESK STARTS QUIET (owner, 2026-10-25): on a first install, and for every project created after it, only the
     Conversation and Notes are on - and on Home the greeting, which is Home's face. Every other card starts off and is
     one switch away in Settings › Plugins and cards (or ＋ Card). A card says it starts on with `onByDefault: true`; a
     plugin's cards follow their plugin's switch instead, and a boxed card its project. This is only the FIRST layout:
     a desk that already has a saved layout is never touched (restore). A "Default Project Layout" scene saved on Home,
     where there is one, is still what a new project starts from. */
  function offByDefault(c) { return !c.onByDefault && !c.plugin && !c.projectOnly; }
  function defaults() {
    if (L.project !== 'home' && L.template) { var tl = fromTemplate(L.template); if (tl && restore(tl)) { L.legacy = null; markKinds(); return; } }
    L.locked = {}; L.hidden = {}; L.stacks = {}; L.promoted = null; L.before = null; L.dock = { left: [], right: [], top: [] }; L.open = { left: null, right: null, top: null }; L.lifted = null;
    var order = { full: [], left: [], stage: [], right: [] };
    Object.values(L.cards).forEach(function (c) { (order[c.zone] || order.stage).push(c.id); if (c.hiddenByDefault || offByDefault(c) || (c.notHome && L.project === 'home')) L.hidden[c.id] = 1; if (c.lockedByDefault) L.locked[c.id] = 1; });
    Object.keys(order).forEach(function (z) { order[z].sort(function (a, b) { return (L.cards[a].pos || 0) - (L.cards[b].pos || 0); }); });
    L.legacy = { order: order, sizes: null };   // laid out in pixels once the room's width is known (build)
    /* HOME STARTS WITH ITS CARDS IN THE DRAWERS (owner, 2026-10-08: "All cards need to be defaulted to one of the drawers.
       Convo on top. Right top to bottom, notes, projects. Left: agent fleet, lane performance, alerts"). A card says where
       with homeDock: [side, order]; the picture stays clear, the greeting and the clock stay on it. Docked after flow()
       gives each card its size, so a card taken out of its drawer lands somewhere sensible. */
    L.pendingDock = L.project === 'home' ? Object.values(L.cards).filter(function (c) { return c.homeDock && !L.hidden[c.id]; })
      .sort(function (a, b) { return a.homeDock[1] - b.homeDock[1]; }).map(function (c) { return [c.id, c.homeDock[0]]; }) : null;
    markKinds();
  }
  function dockDefaults(fresh) {
    var list = L.pendingDock; L.pendingDock = null; if (!list) return;
    list.forEach(function (d) { var p = L.pos[d[0]]; if (!p || SIDES.indexOf(d[1]) < 0) return; p.mode = d[1]; if (L.dock[d[1]].indexOf(d[0]) < 0) L.dock[d[1]].push(d[0]); });
    if (!fresh) return;   // cards joining a desk that is already arranged: into their drawers, and nothing else moves
    /* what stays on the desk (the greeting, the clock) keeps clear of the side shelves' tabs, which start at the top */
    var EDGE = 60, RW = roomW();
    Object.keys(L.pos).forEach(function (id) { var p = L.pos[id]; if (p.mode !== 'free' || L.hidden[id]) return;
      if (p.x < EDGE) p.x = EDGE;
      if (p.x + p.w > RW - EDGE) p.x = Math.max(EDGE, RW - EDGE - p.w); });
  }
  function snapshotObj() { return JSON.parse(snapshot(false)); }
  function snapshot(forDefault) {
    return JSON.stringify({ v: LAYOUT_V, pos: L.pos, dock: L.dock, open: forDefault ? undefined : L.open, locked: L.locked, hidden: L.hidden, stacks: L.stacks, promoted: forDefault ? null : L.promoted, before: forDefault ? null : L.before });   // open: the drawer you left open stays open across a reload, a project switch, a tab coming back
  }
  function save() {
    /* ONLY THE TAB YOU ARE LOOKING AT WRITES (2026-09-20: a second tab kept saving its stale copy every time one of its
       cards resized itself, and the desk "came back different"). A hidden tab saves nothing; when it is seen again it
       re-reads the layout (below) before it may write. */
    if (document.hidden) { L.dirtyWhileHidden = true; return; }
    var s = snapshot(false);
    /* Per PROJECT (2026-09-16): the layout is that project's, saved in its .cockpit\. The
       shell sets L.api to the project's API base before build(); the localStorage key
       carries the project id so two projects never share a fallback. */
    try { localStorage.setItem('cockpit.layout.' + (L.project || 'none'), s); } catch (e) {}
    if (L.api) fetch(L.api + '/layout?person=' + encodeURIComponent(L.person), { method: 'POST', headers: { 'content-type': 'application/json' }, body: s }).catch(function () {});
    if (L.onSave) { try { L.onSave(); } catch (e) { /* the scenes hook */ } }
  }
  function restore(saved) {
    if (!saved || (!saved.order && !saved.pos)) return false;
    L.locked = saved.locked || {}; L.hidden = saved.hidden || {}; L.stacks = saved.stacks || {}; L.promoted = null; L.before = null;
    L.pendingDock = null;
    Object.keys(L.cards).forEach(function (id) {
      // a card the saved layout never saw keeps its own default visibility (the File card starts hidden)
      var seen = saved.pos ? id in saved.pos : Object.values(saved.order).some(function (a) { return a.indexOf(id) >= 0; });
      if (seen) return;
      var c = T(id);
      if (c.hiddenByDefault && !(id in L.hidden)) L.hidden[id] = 1;
      if (c.lockedByDefault && !(id in L.locked)) L.locked[id] = 1;
      /* a coding card this desk has never seen (Coding was off when the desk was laid out, and is on now): it arrives the
         way a first install used to have it - Home's into its drawer, a project's off but one switch away - instead of
         landing on top of the desk */
      if (isCoding(c) && !c.plugin && !(id in L.hidden)) {
        if (L.project === 'home' && c.homeDock && !c.notHome) (L.pendingDock = L.pendingDock || []).push([id, c.homeDock[0]]);
        else L.hidden[id] = 1;
      }
    });
    L.lifted = null;
    if (saved.pos) {   // v3: pixels
      L.pos = {}; L.zTop = 1; L.legacy = null;
      Object.keys(saved.pos).forEach(function (id) { var p = saved.pos[id];   /* an own key whose type is not loaded yet (a plugin card before its plugin is on) keeps its spot for later */ L.pos[id] = { x: p.x, y: p.y, w: p.w, h: p.h, z: p.z || 1, mode: p.mode || 'free', size: p.size || sizeMode(id), rot: p.rot || 0 }; if (p.z > L.zTop) L.zTop = p.z; });
      /* the stack renumbered 1..n: z climbs by one on every raise and is saved, so left alone it would reach the drawers' layer */
      L.zTop = 0; Object.keys(L.pos).sort(function (a, b) { return L.pos[a].z - L.pos[b].z; }).forEach(function (id) { L.pos[id].z = ++L.zTop; });
      if (saved.promoted && T(saved.promoted) && saved.before) { L.promoted = saved.promoted; L.before = saved.before; }
      // the docks: the saved order, minus what is gone, plus any docked card the order missed
      L.dock = { left: [], right: [], top: [] }; L.open = { left: null, right: null, top: null };
      SIDES.forEach(function (s) { ((saved.dock || {})[s] || []).forEach(function (id) { if (side(id) === s && L.dock[s].indexOf(id) < 0) L.dock[s].push(id); }); });
      Object.keys(L.pos).forEach(function (id) { var s = side(id); if (s && L.dock[s].indexOf(id) < 0) L.dock[s].push(id); });
      SIDES.forEach(function (s) { var o = (saved.open || {})[s]; if (o && L.dock[s].indexOf(o) >= 0) L.open[s] = o; });   // the drawer that was open, if it is still on that side
      return true;
    }
    /* v1/v2 (columns): the order and the cols×rows sizes, converted in build() when the width is known.
       The promoted card comes back at its ordinary place. */
    var order = { full: [], left: [], stage: [], right: [] };
    Object.keys(saved.order).forEach(function (z) { (saved.order[z] || []).forEach(function (id) { if (L.cards[id] && order[z]) order[z].push(id); }); });
    var sizes = {}; Object.keys(L.cards).forEach(function (id) { var was = saved.sizes && saved.sizes[id]; sizes[id] = was || { cols: L.cards[id].size[0], rows: L.cards[id].size[1] }; });
    if (saved.before && saved.promoted && saved.before.sizes && saved.before.sizes[saved.promoted]) sizes[saved.promoted] = saved.before.sizes[saved.promoted];
    L.legacy = { order: order, sizes: sizes };
    return true;
  }
  /* a card the layout has no place for (new since it was saved): its declared column, under whatever is there */
  function placeNew(id) {
    var c = T(id), zn = ZONES[c.zone] || ZONES.stage, x = zn.x * L.colW + GAP / 2, w = Math.min(c.size[0], zn.cols) * L.colW - GAP, y = 0;
    Object.keys(L.pos).forEach(function (o) { var p = L.pos[o]; if (o === id || L.hidden[o] || side(o)) return; if (p.x < x + w && p.x + p.w > x) y = Math.max(y, p.y + p.h + GAP); });
    L.pos[id] = newPos(id, x, y, w, c.size[1] * ROW - GAP);
  }

  /* ---------- rendering ---------- */
  function build(root) {
    L.root = root; root.innerHTML = ''; L.arrange = null; L.lifted = null; L.settled = false; closeMenu(); root.dataset.project = L.project;   // whose desk the room holds - the project id flips before the room is rebuilt, and nothing may snapshot the old desk as the new project's
    measure();
    if (L.legacy) { flow(L.legacy.order, L.legacy.sizes); L.legacy = null; dockDefaults(true); }
    // a foreign key whose type never loaded (its plugin is gone, or off on that project) is dropped here, not kept forever
    Object.keys(L.pos).forEach(function (k) { if (isForeign(k) && !(T(k) && T(k).multi)) { delete L.pos[k]; SIDES.forEach(function (s) { L.dock[s] = L.dock[s].filter(function (x) { return x !== k; }); }); } });
    /* ONE ⚙ menu for the room, a sibling of the cards (a card clips its overflow, and its transform
       traps anything position:fixed inside it), placed under whichever ⚙ opened it */
    L.menu = document.createElement('div'); L.menu.className = 'cmenu'; L.menu.hidden = true; root.appendChild(L.menu); wireMenu(L.menu);
    instances().forEach(mount);
    // coding cards new to this desk (restore), each now with a place: into their drawers - and saved, so from now on that IS their place
    if (L.pendingDock) { dockDefaults(false); setTimeout(save, 0); }
    /* the docks: left and right fixed to the screen's edges beside the room (so they go with the Control room view);
       the top one a strip IN the room under the window */
    L.docks = {};
    SIDES.forEach(function (s) {
      var old = root.parentElement.querySelector('.dock-' + s); if (old) old.remove();
      var d = document.createElement('div'); d.className = 'dock dock-' + s; d.dataset.side = s; (s === 'top' ? root : root.parentElement).appendChild(d); L.docks[s] = d; wireDock(d, s);
    });
    place(false);
  }
  function projName(key) { return projectsOf(key).map(function (pr) { var r = pr === L.project ? window.ROOM : L.rooms[pr]; return (r && r.name) || pr; }).join(' + '); }
  /* one instance's element */
  function mount(key) {
    var c = T(key); if (!c || document.getElementById('card-' + key)) return;
    if (!L.pos[key]) newPlace(key);
    var el = document.createElement('section'); el.className = 'card' + (isForeign(key) ? ' foreign' : ''); el.dataset.id = key; el.dataset.type = c.id; el.dataset.project = projOf(key); el.id = 'card-' + key;
    el.innerHTML = '<header class="ch"><span class="grip" title="drag">⠿</span><h3>' + (window.Icons ? '<span class="h-ico">' + Icons.of(c, 14) + '</span>' : '') + c.title + (isForeign(key) ? ' <span class="ch-proj" title="another project - its card, on this desk">' + projName(key) + '</span>' : '') + '</h3><span class="ch-r"><span class="more">' + (c.more || '') + '</span>' + (c.multi ? '<label class="sw sw-sm stk" title="stack: every ' + c.title + ' card on this desk in one place, fanned - click a header to bring that one forward; drag the front and they all come. Off: loose cards"><input type="checkbox"><span class="swk"></span></label>' : '') + '<span class="lock" title="lock size and position">🔓</span><span class="arr-btn" title="arrange: the edges light up - drag anywhere to move, an edge to resize, the knob above to rotate. Again, Esc or a click elsewhere ends it">✥</span><span class="cog" title="this card: placement, size, lock">⚙</span><span class="close" title="close - a drawer goes back into its drawer; a card comes back with ＋ Card">✕</span></span></header><div class="cb"></div>'
        + ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(function (d) { return '<span class="rzh rz-' + d + '" data-dir="' + d + '"></span>'; }).join('') + '<span class="rz" title="resize"></span><span class="arr"></span><span class="rot" title="drag to rotate · double-click for straight"><span class="rot-deg"></span></span>';
    L.root.insertBefore(el, L.menu);
    wire(el, key, c);
  }
  function topH() { var t = document.querySelector('.top'); return t ? t.offsetHeight : 0; }
  function drawerH() { return Math.max(300, window.innerHeight - topH()); }
  /* an open drawer: fixed to its edge, the top bar's height down, the viewport's height, its own width */
  var TOPSTRIP = 34;   // the top dock's strip height
  var DRAWER_Z = 700;   // an open drawer covers every desk card; the dim (800) and a lifted card (900) are above it
  function topDockY() { var y = 0; instances().forEach(function (id) { var p = L.pos[id]; if (p && isWindow(id) && !L.hidden[id] && !side(id)) y = Math.max(y, p.y + p.h + GAP); }); return y; }
  function applyDrawer(el, id, s) {
    var p = L.pos[id], W = Math.max(limits(id).minW, Math.min(p.w, window.innerWidth * 0.9));
    el.classList.add('drawer'); el.classList.toggle('dl', s === 'left'); el.classList.toggle('dr', s === 'right'); el.classList.toggle('dt', s === 'top');
    if (s === 'top') {   // a panel under the strip, the card's own size as it would be on the desk, hung under its tab; it scrolls with the room
      var tw = Math.min(W, roomW()), tab = L.docks && L.docks.top && (L.docks.top.querySelector('.dtab[data-id="' + id + '"]') || (L.docks.top.querySelector('.dsub[data-id="' + id + '"]') || {}).parentElement), tx = tab ? tab.offsetLeft + tab.offsetWidth / 2 - tw / 2 : (roomW() - tw) / 2;
      el.style.position = 'absolute'; el.style.top = (topDockY() + TOPSTRIP) + 'px'; el.style.left = Math.max(0, Math.min(roomW() - tw, tx)) + 'px'; el.style.right = 'auto'; el.style.width = tw + 'px'; el.style.height = Math.min(p.h, drawerH()) + 'px'; el.style.zIndex = DRAWER_Z; el.style.transform = '';
      el.classList.remove('promoted'); el.classList.toggle('locked', !!L.locked[id]); el.dataset.size = sizeMode(id); el.querySelector('.lock').textContent = L.locked[id] ? '🔒' : '🔓'; el.dataset.density = 'full'; return;
    }
    el.style.position = '';
    el.style.top = topH() + 'px'; el.style.height = Math.min(p.h, drawerH()) + 'px'; el.style.width = W + 'px';   // the card's own height (not the whole vertical), never past the viewport
    var pad = ((L.docks && L.docks[s] && L.docks[s].offsetWidth) || 0) + 8;   // in from the edge past its tabs, so they sit beside the card, not on it
    el.style.left = s === 'left' ? pad + 'px' : 'auto'; el.style.right = s === 'right' ? pad + 'px' : 'auto'; el.style.zIndex = DRAWER_Z; el.style.transform = '';
    el.classList.remove('promoted'); el.classList.toggle('locked', !!L.locked[id]); el.dataset.size = sizeMode(id);
    el.querySelector('.lock').textContent = L.locked[id] ? '🔒' : '🔓';
    el.dataset.density = 'full';
  }
  function renderDocks() {
    if (L.docks && L.docks.top) { L.docks.top.style.top = topDockY() + 'px'; L.docks.top.style.width = roomW() + 'px'; }
    SIDES.forEach(function (s) {
      var d = L.docks && L.docks[s]; if (!d) return;
      /* a tab is the card's icon; its name shows on mouse-over */
      groupAdjacent(s);
      var done = {};
      var one = function (id) { var nm = T(id).title + (isForeign(id) ? ' · ' + projName(id) : ''); return '<span class="dtab' + (L.open[s] === id ? ' on' : '') + '" data-id="' + id + '" data-name="' + nm.replace(/"/g, '&quot;') + '"><span class="dtab-ico">' + (window.Icons ? Icons.of(T(id), 20) : (T(id).icon || '▢')) + '</span></span>'; };
      d.innerHTML = L.dock[s].filter(function (id) { return T(id) && !L.hidden[id]; }).map(function (id) {
        if (done[id]) return '';
        var st = L.stacks[typeOf(id)];
        if (!(st && st.on && T(id).multi)) { done[id] = true; return one(id); }
        /* a stack's members in this dock: one group on the shelf, a small tab each inside it; the group carries the first member's id for the drag */
        var mem = L.dock[s].filter(function (o) { return typeOf(o) === typeOf(id) && T(o) && !L.hidden[o]; }); mem.forEach(function (o) { done[o] = true; });
        if (mem.length < 2) return one(id);
        return '<span class="dtab dtab-group' + (mem.some(function (o) { return L.open[s] === o; }) ? ' on' : '') + '" data-id="' + id + '" data-group="' + typeOf(id) + '" data-name="' + (T(id).title + ' · ' + mem.length + ' projects').replace(/"/g, '&quot;') + '">' + mem.map(function (o) { return '<span class="dsub' + (L.open[s] === o ? ' on' : '') + '" data-id="' + o + '" data-name="' + (T(o).title + ' · ' + projName(o)).replace(/"/g, '&quot;') + '" title="' + (T(o).title + ' · ' + projName(o)).replace(/"/g, '&quot;') + '">' + (window.Icons ? Icons.of(T(o), 14) : (T(o).icon || '')) + '</span>'; }).join('') + '</span>';
      }).join('');
      d.classList.toggle('empty', !d.children.length);
    });
    placeDocks();
  }
  /* the side shelves start under the window (the greeting), not over it, and follow the page as it scrolls */
  function placeDocks() {
    if (!L.docks || !L.root) return;
    var rr = L.root.getBoundingClientRect(), y = Math.max(topH() + 10, rr.top + topDockY() + 10);
    ['left', 'right'].forEach(function (s) { if (L.docks[s]) L.docks[s].style.top = y + 'px'; });
  }
  function measure() { L.colW = Math.max(20, (L.root.clientWidth - GAP * 2) / COLS); }
  function roomW() { return L.root.clientWidth - GAP; }
  /* a card's declared min was for the columns; on the desk every card goes down to one small floor - a header and a
     line */
  var MINW = 180, MINH = 80;
  function limits(id) { var c = T(id); return { minW: MINW, minH: MINH, maxW: Math.max(c.max[0] * L.colW - GAP, roomW()), maxH: Math.max(c.max[1] * ROW - GAP, window.innerHeight) }; }
  function gridSize(id) { var p = L.pos[id]; return { cols: Math.max(1, Math.round((p.w + GAP) / L.colW)), rows: Math.max(1, Math.round((p.h + GAP) / ROW)) }; }
  function cardSize(id) { return cardSizeOf(id); }
  function density(id) { var s = cardSizeOf(id); var c = T(id); return (side(id) || s.cols >= (c.fullAt ? c.fullAt[0] : 99) || s.rows >= (c.fullAt ? c.fullAt[1] : 99) || L.promoted === id) ? 'full' : 'summary'; }
  /* keep every card reachable: never past the right edge, never above the top */
  /* the box a rotated card actually covers (its axis-aligned bounds) */
  function bounds(id) {
    var p = L.pos[id], r = (p.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r)), hw = (p.w * c + p.h * s) / 2, hh = (p.w * s + p.h * c) / 2, cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
  }
  function clamp(id) {
    var p = L.pos[id], lim = limits(id), W = roomW();
    p.w = Math.max(Math.min(lim.minW, W), Math.min(p.w, W)); p.h = Math.max(lim.minH, p.h);
    var b = bounds(id);
    if (b.right > W) { p.x -= b.right - W; b = bounds(id); }
    if (b.left < 0) p.x -= b.left;
    if (b.top < 0) p.y -= b.top;
  }
  function isWindow(id) { var c = T(id); return !!(c && c.window); }
  function apply(el, id) {
    var p = L.pos[id], win = false;
    if (isWindow(id) && T(id).windowH) p.h = T(id).windowH;   // the band's height is the window's own (owner: 'too wide')
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.width = p.w + 'px'; el.style.height = p.h + 'px'; el.style.zIndex = L.lifted === id ? 900 : p.z;
    if (L.promoted === id || win) el.style.transform = '';
    else if (L.lifted === id) el.style.transform = '';
    else el.style.transform = p.rot ? 'rotate(' + p.rot + 'deg)' : '';
    el.classList.toggle('lifted', L.lifted === id); el.classList.toggle('window', win);
    el.classList.toggle('promoted', L.promoted === id); el.classList.toggle('locked', !!L.locked[id]);
    el.dataset.size = sizeMode(id);
    el.querySelector('.lock').textContent = L.locked[id] ? '🔒' : '🔓';
    var stk = el.querySelector('.stk'); if (stk) { var s = stackOf(id); stk.hidden = !stackable(id); stk.querySelector('input').checked = !!s; el.classList.toggle('stacked', !!s); }
    var tabs = el.querySelector('.stack-tabs'), want = stackTabsHtml(id);
    if (want) { if (!tabs) { tabs = document.createElement('div'); el.insertBefore(tabs, el.firstChild); } if (tabs.outerHTML !== want) { tabs.outerHTML = want; tabs = el.querySelector('.stack-tabs'); tabs.querySelectorAll('[data-stab]').forEach(function (b) { b.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); b.addEventListener('click', function (e) { e.stopPropagation(); bringForward(b.dataset.stab); }); }); } }
    else if (tabs) tabs.remove();
    el.dataset.density = density(id);
  }
  /* a card just shown (a drawer opened, a stack member brought forward): anything in it that wanted to be read from its end
     was laid out at no height while hidden - scroll it now that it has one */
  function shown(el) { requestAnimationFrame(function () { el.querySelectorAll('[data-want-end]').forEach(function (l) { l.scrollTop = l.scrollHeight; }); }); }
  /* place every card; animate = the moves ease (a card put back, a fit) */
  function place(animate) {
    /* A ROOM THAT IS NOT ON SCREEN MEASURES NOTHING (turning a plugin on from Settings rebuilt the
       room while hidden and every card was clamped into a zero width - "moved everything to the left"). Positions
       are never touched against a width that is not real; the view's show() places again when it is. */
    if (!L.root || L.root.clientWidth < 200) return;
    measure();
    var bottom = 0;
    if (L.promoted) maximizeRect(L.promoted);
    renderDocks();   // the tabs first: an open top drawer hangs under its own tab
    applyStacks();
    instances().forEach(function (id) {
      var el = document.getElementById('card-' + id); if (!el) return;
      /* A HIDDEN CARD TAKES NO SPACE (2026-09-01: the owner clicked close and the window stayed). */
      if (L.hidden[id] || stackHidden(id)) { el.style.display = 'none'; var st0 = el.querySelector('.stack-tabs'); if (st0) st0.remove(); return; }
      if (!L.pos[id]) newPlace(id);
      var s = side(id);
      var wasHidden = el.style.display === 'none';
      if (s) {   // a drawer: on screen only while open; its tab is in the dock
        if (L.open[s] !== id) { el.style.display = 'none'; return; }
        el.style.display = ''; el.style.transition = 'none'; applyDrawer(el, id, s); if (wasHidden) shown(el); return;
      }
      el.classList.remove('drawer', 'dl', 'dr', 'dt'); el.style.right = 'auto'; el.style.display = ''; if (wasHidden) shown(el);
      if (L.promoted !== id) clamp(id);
      if (!animate) el.style.transition = 'none';
      apply(el, id);
      if (!animate) { void el.offsetWidth; el.style.transition = ''; }
      bottom = Math.max(bottom, bounds(id).bottom);
    });
    L.root.style.height = (bottom + 40) + 'px';
    L.settled = true;   // from here on, a card that turns up lands in view (newPlace)
    instances().forEach(function (k) { var c = T(k); if (!c.render || L.hidden[k]) return; var s = side(k); if (s && L.open[s] !== k) return; var el = document.getElementById('card-' + k); if (!el) return; var pn = el.querySelector('.ch-proj'); if (pn) pn.textContent = projName(k); if (placeholder(k, el)) return; c.render(el.querySelector('.cb'), density(k), cardSize(k), ctx(k)); });
  }
  /* Home is the workbench: a plugin card placed there with no plugin behind it is a PLACEHOLDER - the shape and the
     spot, for laying out; a project's live one comes with ＋ Card from that project */
  function pluginOn(name) { var r = window.ROOM; return !!(r && r.plugins && (r.plugins.available || []).some(function (p) { return p.name === name && p.selected; })); }
  function placeholder(k, el) {
    var c = T(k); if (!c || !c.plugin || isForeign(k) || L.project !== 'home' || pluginOn(c.plugin)) return false;
    el.classList.add('placeholder');
    if (sizeMode(k) === 'grow') setTimeout(function () { snug(k); }, 0);   // as tall as the note, not the recipe's 20 rows
    el.querySelector('.cb').innerHTML = '<div class="cph-note"><div class="small dim">' + (c.purpose || '') + '</div><div class="small dim" style="margin-top:8px">a placeholder here on the workbench - it comes alive in a project with the <b>' + c.plugin + '</b> plugin; a project\'s live one comes with ＋ Card</div></div>';
    return true;
  }
  function cardSizeOf(id) { var s = side(id); if (!s) return gridSize(id); var p = L.pos[id]; return { cols: Math.max(1, Math.round((p.w + GAP) / L.colW)), rows: Math.max(1, Math.round(Math.min(p.h, drawerH()) / ROW)) }; }
  function front(id) { var p = L.pos[id]; if (!p || p.z === L.zTop) return; if (L.zTop >= DRAWER_Z - 50) { L.zTop = 0; Object.keys(L.pos).sort(function (a, b) { return L.pos[a].z - L.pos[b].z; }).forEach(function (o) { L.pos[o].z = ++L.zTop; var oe = document.getElementById('card-' + o); if (oe && !side(o)) oe.style.zIndex = L.pos[o].z; }); } p.z = ++L.zTop; var el = document.getElementById('card-' + id); if (el) el.style.zIndex = p.z; save(); }

  /* ---------- move, resize, the menu ---------- */
  function wire(el, key, c) {
    var grip = el.querySelector('.grip'), head = el.querySelector('.ch'), lock = el.querySelector('.lock'), cog = el.querySelector('.cog'), arrBtn = el.querySelector('.arr-btn'), shield = el.querySelector('.arr'), knob = el.querySelector('.rot');
    el.addEventListener('pointerdown', function () { if (!side(key)) front(key); }, true);
    var stk = el.querySelector('.stk input'); if (stk) stk.addEventListener('change', function () { setStack(key, stk.checked); });
    lock.addEventListener('click', function () { L.locked[key] = !L.locked[key]; if (side(key)) applyDrawer(el, key, side(key)); else apply(el, key); if (L.locked[key]) arrange(null); save(); });
    /* move: by the grip or the title (the header's buttons keep their own jobs), or anywhere on the card in
       arrange mode. A drawer does not move. */
    function startMove(e, src) {
      if (L.locked[key] || L.promoted === key || side(key)) return; e.preventDefault();
      src = src || e.currentTarget; var start = { x: e.clientX, y: e.clientY }, p0 = { x: L.pos[key].x, y: L.pos[key].y };
      if (L.lifted === key) unlift(false);
      el.classList.add('dragging'); el.style.transition = 'none'; src.setPointerCapture(e.pointerId);
      function move(ev) {
        var p = L.pos[key];
        p.x = p0.x + ev.clientX - start.x; p.y = p0.y + ev.clientY - start.y; clamp(key); el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      }
      function up() { src.removeEventListener('pointermove', move); src.removeEventListener('pointerup', up); el.classList.remove('dragging'); el.style.transition = ''; place(false); save(); }
      src.addEventListener('pointermove', move); src.addEventListener('pointerup', up);
    }
    head.addEventListener('pointerdown', function (e) { if (e.target === grip || e.target === head.querySelector('h3') || e.target === head) startMove(e); });
    shield.addEventListener('pointerdown', startMove);
    head.addEventListener('dblclick', function (e) { if (e.target.closest('.ch-r') || side(key)) return; if (L.promoted === key) demote(key, true); else promote(key, true); save(); });
    /* resize: any edge, any corner, in the CARD'S OWN AXES (a rotated card's east edge is still its east edge).
       The box is x/y/w/h before rotation, turned about its centre; so an edge moving by Δ moves the centre by
       Δ/2 along that local axis, and the box is re-derived from the new centre - which at 0° is exactly
       "the far edge stays put". A card that grows with its content owns its height - only the width moves. */
    el.querySelectorAll('.rzh').forEach(function (hd) {
      hd.addEventListener('pointerdown', function (e) {
        if (L.locked[key] || L.promoted === key) return; e.preventDefault(); e.stopPropagation(); hd.setPointerCapture(e.pointerId);
        var d = hd.dataset.dir, p0 = Object.assign({}, L.pos[key]), start = { x: e.clientX, y: e.clientY }, lim = limits(key), grows = sizeMode(key) === 'grow', ds = side(key);
        if (grows && /n|s/.test(d)) { L.pos[key].size = 'fixed'; grows = false; el.dataset.size = 'fixed'; }   // pulling a growing card's top or bottom edge: the height is yours now (fixed, scrolls inside); ⚙ puts it back to growing
        var r = (p0.rot || 0) * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r), c0 = { x: p0.x + p0.w / 2, y: p0.y + p0.h / 2 };
        el.style.transition = 'none'; el.classList.add('resizing');
        function move(ev) {
          var dx = ev.clientX - start.x, dy = ev.clientY - start.y, p = L.pos[key];
          // a drawer: only its inner edge, only the width
          if (ds) {
            if (/e|w/.test(d)) p.w = Math.max(lim.minW, Math.min(window.innerWidth * 0.9, ds === 'left' || (ds === 'top' && /e/.test(d)) ? p0.w + dx : p0.w - dx));
            if (!grows && /s/.test(d)) p.h = Math.max(lim.minH, Math.min(drawerH(), p0.h + dy));   // a fixed drawer: its bottom edge too
            if (ds === 'top') { applyDrawer(el, key, ds); return; }   // re-hung under its tab at the new width
            el.style.width = p.w + 'px'; el.style.height = Math.min(p.h, drawerH()) + 'px'; return;
          }
          var ldx = dx * cos + dy * sin, ldy = -dx * sin + dy * cos;   // the pointer's travel in the card's axes
          var w = p0.w, h = p0.h, sx = 0, sy = 0;   // sx/sy: how far the centre moves, in the card's axes
          if (/e/.test(d)) { w = Math.max(lim.minW, Math.min(lim.maxW, p0.w + ldx)); sx = (w - p0.w) / 2; }
          if (/w/.test(d)) { w = Math.max(lim.minW, Math.min(lim.maxW, p0.w - ldx)); sx = -(w - p0.w) / 2; }
          if (!grows && /s/.test(d)) { h = Math.max(lim.minH, Math.min(lim.maxH, p0.h + ldy)); sy = (h - p0.h) / 2; }
          if (!grows && /n/.test(d)) { h = Math.max(lim.minH, Math.min(lim.maxH, p0.h - ldy)); sy = -(h - p0.h) / 2; }
          var cx = c0.x + sx * cos - sy * sin, cy = c0.y + sx * sin + sy * cos;
          p.w = w; p.h = h; p.x = cx - w / 2; p.y = cy - h / 2;
          if (!p.rot && p.x < 0) { p.w += p.x; p.x = 0; }
          if (!p.rot && p.y < 0) { p.h += p.y; p.y = 0; }
          el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.width = p.w + 'px'; el.style.height = p.h + 'px';
        }
        function up() { hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); el.style.transition = ''; el.classList.remove('resizing'); place(false); save(); }
        hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up);
      });
    });
    /* rotate: the knob above the card, dragged around the card's centre. Within 3° of straight it is straight
       (so a card comes back square without fighting for it); double-click the knob for straight. */
    knob.addEventListener('pointerdown', function (e) {
      if (L.locked[key] || L.promoted === key || side(key)) return; e.preventDefault(); e.stopPropagation(); knob.setPointerCapture(e.pointerId);
      var b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2, deg = el.querySelector('.rot-deg');
      el.style.transition = 'none'; el.classList.add('rotating');
      function move(ev) {
        var a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90; if (a > 180) a -= 360; if (a <= -180) a += 360;
        if (Math.abs(a) < 3) a = 0;
        L.pos[key].rot = Math.round(a); el.style.transform = a ? 'rotate(' + Math.round(a) + 'deg)' : ''; deg.textContent = Math.round(a) + '°';
      }
      function up() { knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); el.style.transition = ''; el.classList.remove('rotating'); place(false); save(); }
      knob.addEventListener('pointermove', move); knob.addEventListener('pointerup', up);
    });
    knob.addEventListener('dblclick', function (e) { e.stopPropagation(); L.pos[key].rot = 0; el.querySelector('.rot-deg').textContent = '0°'; place(false); save(); });
    // ✥ - arrange this card: the edges light up, drag anywhere to move, the knob to rotate; again, Esc or a click elsewhere ends it
    arrBtn.addEventListener('click', function (e) { e.stopPropagation(); if (L.locked[key] || L.promoted === key || side(key)) return; arrange(L.arrange === key ? null : key); });
    // ⚙ - this card's settings
    cog.addEventListener('click', function (e) { e.stopPropagation(); if (L.menu.hidden || L.menuFor !== key) openMenu(key, el, cog); else closeMenu(); });
    // ✕ - close: a drawer folds back into its drawer; another project's card leaves this desk; the desk's own card
    // hides, and ＋ Card brings it back
    el.querySelector('.close').addEventListener('click', function (e) { e.stopPropagation(); closeCard(key); });
  }
  /* LIFTED: the one card you selected comes up off the desk - flat, full size, over its own spot - and the desk dims.
     A click anywhere else, Esc, or picking it up puts it back where it lay. */
  function lift(id) {
    if (!L.pos[id] || side(id) || L.promoted === id) return;   // a locked card lifts too - reading is not moving
    if (L.lifted && L.lifted !== id) unlift(false);
    L.lifted = id; front(id);
    var el = document.getElementById('card-' + id); if (el) { el.style.transition = ''; apply(el, id); }
  }
  function unlift(redraw) {
    var id = L.lifted; if (!id) return; L.lifted = null;
    var el = document.getElementById('card-' + id); if (el) apply(el, id);
    if (redraw) place(false);
  }
  document.addEventListener('pointerdown', function (e) { if (!L.lifted) return; var el = document.getElementById('card-' + L.lifted); if ((el && el.contains(e.target)) || e.target.closest('.cmenu, .dock, .top, .nav, #addcard, #scnmenu, #deskmenu')) return; unlift(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && L.lifted) unlift(false); });
  function closeCard(key) {
    var s = side(key);
    if (s) { if (L.open[s] === key) L.open[s] = null; place(false); save(); return; }
    if (L.lifted === key) unlift(false);
    if (isForeign(key)) remove(key); else show(key, false);
  }
  /* one card in arrange mode at a time */
  function arrange(id) {
    if (L.arrange && L.arrange !== id) { var was = document.getElementById('card-' + L.arrange); if (was) was.classList.remove('arrange'); }
    L.arrange = id || null;
    if (id) { var el = document.getElementById('card-' + id); if (el) { el.classList.add('arrange'); el.querySelector('.rot-deg').textContent = (L.pos[id].rot || 0) + '°'; front(id); } }
  }
  document.addEventListener('pointerdown', function (e) { if (L.arrange) { var el = document.getElementById('card-' + L.arrange); if (!(el && el.contains(e.target)) && !e.target.closest('.cmenu')) arrange(null); } });
  function openMenu(key, el, cog) {
    var c = T(key);
    var m = L.menu, p = L.pos[key], r = function (name, v, label, on, off) { return '<label' + (off ? ' class="dim" title="' + off + '"' : '') + '><input type="radio" name="' + name + '" value="' + v + '"' + (on ? ' checked' : '') + (off ? ' disabled' : '') + '> ' + label + '</label>'; };
    L.menuFor = key;
    m.innerHTML = '<div class="cm-hd"><b>' + c.title + (isForeign(key) ? ' · ' + projName(key) : '') + '</b><span class="small dim">' + (c.purpose || '') + '</span></div>'
      + '<div class="cm-g"><span class="cm-k">placement</span>' + r('mode', 'free', 'free - anywhere on the desk', p.mode === 'free') + r('mode', 'left', 'left drawer - a tab on the left edge you click to open', p.mode === 'left') + r('mode', 'right', 'right drawer - a tab on the right edge you click to open', p.mode === 'right') + r('mode', 'top', 'top drawer - a tab under the banner you click to open', p.mode === 'top') + '</div>'
      + '<div class="cm-g"><span class="cm-k">size</span>' + r('size', 'fixed', 'fixed - the content scrolls inside', sizeMode(key) === 'fixed') + r('size', 'grow', 'grows with the content - the height is whatever it holds', sizeMode(key) === 'grow') + '</div>'
      + '<div class="cm-g"><label><input type="checkbox" name="lock"' + (L.locked[key] ? ' checked' : '') + '> locked - it cannot be moved or resized</label></div>'
      + '<div class="cm-acts"><a href="#" data-act="max">' + (L.promoted === key ? 'put it back' : 'fill the room') + '</a> · <a href="#" data-act="fit">fit its content once</a>' + (p.rot ? ' · <a href="#" data-act="straight">straighten (now ' + p.rot + '°)</a>' : '') + (isForeign(key) ? ' · <a href="#" data-act="remove" title="takes it off this desk; its own project keeps it">remove from this desk</a>' : ' · <a href="#" data-act="hide" title="Settings › Plugins and cards brings it back">hide this card</a>') + '</div>';
    m.hidden = false; m.style.zIndex = 950;   /* above an open drawer (45), the dim (800) and a lifted card (900) */
    // under the ⚙, right-aligned to it, inside the room
    var rb = L.root.getBoundingClientRect(), cb = cog.getBoundingClientRect();
    var left = Math.max(0, Math.min(cb.right - rb.left - m.offsetWidth, L.root.clientWidth - m.offsetWidth)), top = cb.bottom - rb.top + 6;
    m.style.left = left + 'px'; m.style.top = top + 'px';
  }
  function closeMenu() { if (L.menu) L.menu.hidden = true; L.menuFor = null; }
  function wireMenu(m) {
    m.addEventListener('click', function (e) { e.stopPropagation(); });
    m.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    m.addEventListener('change', function (e) {
      var id = L.menuFor, t = e.target, p = id && L.pos[id], el = id && document.getElementById('card-' + id); if (!p || !el) return;
      if (t.name === 'size') { p.size = t.value; apply(el, id); save(); if (t.value === 'grow') snug(id); }
      if (t.name === 'mode') { setMode(id, t.value); closeMenu(); }
      if (t.name === 'lock') { L.locked[id] = t.checked; apply(el, id); save(); }
    });
    m.addEventListener('click', function (e) {
      var id = L.menuFor, a = e.target.closest('[data-act]'); if (!a || !id) return; e.preventDefault(); closeMenu();
      if (a.dataset.act === 'hide') show(id, false);
      if (a.dataset.act === 'fit') fitOnce(id);
      if (a.dataset.act === 'remove') remove(id);
      if (a.dataset.act === 'straight') { L.pos[id].rot = 0; place(true); save(); }
      if (a.dataset.act === 'max') { if (L.promoted === id) demote(id, true); else promote(id, true); save(); }
    });
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); arrange(null); if (L.open.left || L.open.right || L.open.top) { L.open = { left: null, right: null, top: null }; place(false); save(); } } });

  /* ---------- drawers ---------- */
  /* placement: free ↔ a drawer. Into a drawer: it leaves the desk (its place is remembered), joins the end of that
     dock as a closed tab. Back to free: it closes and returns to where it was, on top. */
  function setMode(id, mode) {
    var p = L.pos[id]; if (!p || p.mode === mode) return;
    if (L.promoted === id) demote(id, false); if (L.arrange === id) arrange(null);
    SIDES.forEach(function (s) { L.dock[s] = L.dock[s].filter(function (x) { return x !== id; }); if (L.open[s] === id) L.open[s] = null; });
    p.mode = mode;
    if (SIDES.indexOf(mode) >= 0) L.dock[mode].push(id);   // closed: just the tab
    else front(id);
    place(true); save();
  }
  function openDrawer(s, id) { L.open[s] = L.open[s] === id ? null : id; place(false); save(); }
  /* the card on screen, wherever it lives: shown if closed, its drawer opened, its stack switched to it, brought to the front
     (an alert clicked leads here, so the owner lands on what needed the alert) */
  function reveal(id) {
    if (!T(id)) return false;
    if (L.hidden[id]) { delete L.hidden[id]; }
    var s = side(id); if (s) L.open[s] = id;
    var st = stackOf(id); if (st) st.front = id;
    if (L.pos[id] && !s) front(id);
    place(false); save();
    var el = document.getElementById('card-' + id); if (el && !s) { try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* */ } }
    return true;
  }
  function wireDock(d, s) {
    d.addEventListener('pointerdown', function (e) {
      var tab = e.target.closest('.dtab'); if (!tab) return; e.preventDefault(); e.stopPropagation();
      var sub = e.target.closest('.dsub'), id = tab.dataset.id, startY = e.clientY, startX = e.clientX, moved = false; tab.setPointerCapture(e.pointerId);
      var openId = sub ? sub.dataset.id : id;   // a sub-tab opens its own drawer; the group drags by any of them
      function move(ev) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < 4 && !moved) return;
        moved = true; tab.classList.add('dragging');
        // the tab's slot follows the pointer: past a neighbour's middle, they swap
        var tabs = Array.prototype.slice.call(d.querySelectorAll('.dtab')), at = tabs.indexOf(tab), to = at;
        var horiz = s === 'top', cur = horiz ? ev.clientX : ev.clientY;
        tabs.forEach(function (t, i) { if (t === tab) return; var b = t.getBoundingClientRect(), mid = horiz ? b.left + b.width / 2 : b.top + b.height / 2; if (i < at && cur < mid) to = Math.min(to, i); if (i > at && cur > mid) to = Math.max(to, i); });
        if (to !== at) {
          var o = L.dock[s], grp = tab.dataset.group ? o.filter(function (x) { return typeOf(x) === tab.dataset.group; }) : [id];
          grp.forEach(function (g) { o.splice(o.indexOf(g), 1); });
          var anchorTab = tabs[to], anchorId = anchorTab.dataset.id, ai = o.indexOf(anchorId); var pos = to > at ? ai + (anchorTab.dataset.group ? o.filter(function (x) { return typeOf(x) === anchorTab.dataset.group; }).length : 1) : ai;
          grp.forEach(function (g, gi) { o.splice(pos + gi, 0, g); });
          if (to > at) d.insertBefore(tab, tabs[to].nextSibling); else d.insertBefore(tab, tabs[to]);
        }
      }
      /* ON THE WINDOW, not the tab: the
         swap above MOVES the tab in the page, and a moved element loses its pointer capture - so its own listeners heard
         nothing after the first swap and every drag stopped one place along */
      function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); tab.classList.remove('dragging'); if (moved) save(); else openDrawer(s, openId); }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    d.addEventListener('click', function (e) { e.stopPropagation(); });
  }
  /* an open drawer stays open until the person reaches for something it is covering: a click on a card that overlaps the drawer
     closes it (the card was behind it); a click on a card elsewhere, or on the desk, leaves it open.
     The tab, the close button and the ⚙ menu keep their own jobs. */
  document.addEventListener('pointerdown', function (e) {
    SIDES.forEach(function (s) {
      var id = L.open[s]; if (!id) return;
      var el = document.getElementById('card-' + id);
      if ((el && el.contains(e.target)) || e.target.closest('.dock') || e.target.closest('.cmenu')) return;
      var card = e.target.closest('.card'); if (!card || !el) return;   // the desk itself, the header bar, a page: the drawer stays
      var a = el.getBoundingClientRect(), b = card.getBoundingClientRect();
      var overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      if (!overlaps) return;
      L.open[s] = null; place(false); save();
    });
  });

  /* fill the room (was: promote to the stage). The card's own place is kept and comes back on demote. */
  function maximizeRect(id) { var p = L.pos[id]; if (!p) return; var top = L.root.getBoundingClientRect().top + window.scrollY; p.x = 0; p.y = 0; p.w = roomW(); p.h = Math.max(400, window.innerHeight - top - 24); }
  function promote(id, animate) {
    if (!L.pos[id]) return;
    if (L.promoted && L.promoted !== id) demote(L.promoted, false);
    L.before = { id: id, pos: Object.assign({}, L.pos[id]) };
    L.promoted = id; front(id); if (L.arrange === id) arrange(null);
    if (animate) place(true);
  }
  function demote(id, animate) {
    if (L.promoted !== id) return;
    L.promoted = null;
    if (L.before && L.before.id === id) { var z = L.pos[id].z; L.pos[id] = Object.assign({}, L.before.pos, { z: z }); }
    L.before = null;
    if (animate) place(true);
  }
  /* THE PROJECT'S OWN DEFAULT. Save as default stores the arrangement under person '__default' in the
     project; Reset returns to that when one exists, else to the engine's defaults. */
  function saveDefault() {
    if (!L.api) return Promise.resolve();
    return fetch(L.api + '/layout?person=__default', { method: 'POST', headers: { 'content-type': 'application/json' }, body: snapshot(true) }).then(function () { return true; }).catch(function () { return false; });
  }
  /* Reset keeps the drawers as they were: every card pinned to a drawer stays pinned on that side, and the drawer that was
     open stays open. The desk itself - positions, sizes, what shows - goes back to the default. */
  function reset() {
    var pinned = {}, wasOpen = Object.assign({}, L.open);
    SIDES.forEach(function (s) { (L.dock[s] || []).forEach(function (id) { if (L.pos[id]) pinned[id] = { s: s, pos: Object.assign({}, L.pos[id]) }; }); });
    var keepDrawers = function () {
      Object.keys(pinned).forEach(function (id) {
        if (!T(id)) return;
        var k = pinned[id];
        SIDES.forEach(function (s) { L.dock[s] = L.dock[s].filter(function (x) { return x !== id; }); });
        L.dock[k.s].push(id);
        L.pos[id] = Object.assign({}, L.pos[id] || {}, k.pos, { mode: k.s });
        delete L.hidden[id];
      });
      SIDES.forEach(function (s) { if (wasOpen[s] && L.dock[s].indexOf(wasOpen[s]) >= 0) L.open[s] = wasOpen[s]; });
    };
    var toDefaults = function () { defaults(); if (L.legacy) { flow(L.legacy.order, null); L.legacy = null; dockDefaults(true); } keepDrawers(); place(true); save(); };
    if (!L.api) return toDefaults();
    fetch(L.api + '/layout?person=__default').then(function (r) { return r.json(); }).then(function (saved) { if (!saved || !restore(saved)) toDefaults(); else { if (L.legacy) { flow(L.legacy.order, L.legacy.sizes); L.legacy = null; } keepDrawers(); place(true); save(); } }).catch(toDefaults);
  }
  /* what the content needs, in pixels of card height */
  function needPx(id) {
    var el = document.getElementById('card-' + id); if (!el || el.style.display === 'none') return null;
    var cb = el.querySelector('.cb'), head = el.querySelector('.ch');
    /* .cb stretches to fill the card, so its scrollHeight is the box, not the content. Measure the
       content itself: from the top of its first child to the bottom of its last. */
    /* offsets, not client rects: a card mid-animation (a scene's deal, a drag) is transformed, and a rotated box
       measures taller than its content - which grew the card and pushed its neighbours on every scene switch */
    var kids = cb.children, last = kids[kids.length - 1], content = kids.length ? (last.offsetTop + last.offsetHeight - kids[0].offsetTop) : cb.scrollHeight;
    return content + head.offsetHeight + 12 + 14 + GAP;
  }
  function toRows(px) { return Math.ceil(px / ROW) * ROW - GAP; }
  /* A card whose height follows its content PUSHES what sits under it (the fleet must expand
     with its queue "and not scroll" - and not cover the card below either, which is what the columns gave him).
     Every visible card in its footprint that started at or below its old bottom edge shifts by the change,
     and shifts whatever is under IT in turn; a shrink pulls them back the same way. A drag or an edge resize
     pushes nothing - those are the person's own placement. */
  function setHeight(id, h) {
    var p = L.pos[id]; if (h === p.h) return false;
    var d = h - p.h, bottom0 = p.y + p.h; p.h = h;
    pushBelow(id, bottom0, d, {});
    return true;
  }
  function pushBelow(id, bottom0, d, seen) {
    var p = L.pos[id]; seen[id] = 1;
    Object.keys(L.pos).forEach(function (o) {
      if (seen[o] || L.hidden[o] || o === L.promoted || !T(o) || side(o)) return;
      var q = L.pos[o];
      if (q.x < p.x + p.w && q.x + q.w > p.x && q.y >= bottom0 - 1) { var b = q.y + q.h; q.y = Math.max(0, q.y + d); pushBelow(o, b, d, seen); }
    });
  }
  /* the menu's "fit its content once": whatever the size mode, the height becomes the content's now */
  function fitOnce(id) {
    var need = needPx(id); if (need == null || L.promoted === id || side(id)) return;
    var lim = limits(id); if (setHeight(id, Math.min(lim.maxH, Math.max(lim.minH, toRows(need))))) { place(true); save(); }
  }
  /* grow a card to fit its content (e.g. a queue opened), or restore the size it had before */
  var fitMemo = {};
  function fit(id, restore, contentPx) {
    var c = T(id); if (!c || !L.pos[id] || L.promoted === id || side(id)) return;
    var p = L.pos[id];
    if (restore) { if (fitMemo[id]) { setHeight(id, fitMemo[id]); delete fitMemo[id]; place(true); save(); } return; }
    var el = document.getElementById('card-' + id); if (!el) return;
    var need = contentPx ? contentPx + el.querySelector('.ch').offsetHeight + 12 + 14 + GAP : needPx(id); if (need == null) return;
    var lim = limits(id), h = Math.min(lim.maxH, Math.max(lim.minH, toRows(need)));
    if (!fitMemo[id]) fitMemo[id] = p.h;
    if (h > p.h) { setHeight(id, h); place(true); save(); }
  }
  /* snug: the card's height becomes exactly what its content needs, growing OR shrinking, within
     its min/max. Only for a card set to "grows with the content" (⚙) - a fixed card is the
     person's size and scrolls inside (a card can keep its size or expand - the person's choice). The `full` argument (as wide as its column) is gone with the
     columns; the width is whatever the person made it. */
  function snug(id) {
    var c = T(id); if (!c || !L.pos[id] || L.promoted === id || sizeMode(id) !== 'grow') return;
    var need = needPx(id); if (need == null) return;
    var lim = limits(id), p = L.pos[id], h = Math.min(lim.maxH, Math.max(lim.minH, toRows(need)));
    // an open drawer that grows: its own height follows the content too (no pushing - nothing is under it)
    if (side(id)) { h = Math.min(h, drawerH()); if (h < p.h && p.h - h < ROW * 2) return; if (h !== p.h) { p.h = h; applyDrawer(document.getElementById('card-' + id), id, side(id)); save(); } return; }
    /* No ping-pong: place() re-renders every card, each snug-ing card
       measures again mid-transition and asks for a row more or less, forever. A one-row shrink is left alone, and a
       card that just resized waits a moment before it may again. */
    if (h < p.h && p.h - h < ROW * 2) return;
    var now = Date.now(); if (snugAt[id] && now - snugAt[id] < 1500) return;
    if (setHeight(id, h)) { snugAt[id] = now; place(true); save(); }
  }
  var snugAt = {};
  /* A CARD IS NEVER REBUILT WHILE THE PERSON IS TYPING IN IT. A refresh that lands while a card holds the
     focus in a text field is deferred; the card redraws when the field loses focus. Cards
     that need to update while typing (the conversation log during a reply) update the part
     that is not the field themselves - see c.renderLive. */
  var deferred = {};
  function typingIn(el) { var a = document.activeElement; return !!(a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); }
  /* paint(el, html) - write the card only when its content actually changed. A card that rebuilds
     its innerHTML on every poll repaints whether or not anything moved, and a poll every few
     seconds reads as a flicker. Returns TRUE when it wrote - the caller rebinds its handlers only
     then, because skipping the write leaves the old nodes, and their listeners, in place. */
  function paint(el, html) {
    if (!el) return false;
    /* Compare against what is ACTUALLY in the element, never a remembered string. A cache here is
       wrong the moment anything else writes to the card - and cards do, for their placeholders
       ("reading..."), which go in with a plain innerHTML. Measured 2026-09-23: the board polled,
       wrote its placeholder directly, loaded, rebuilt the same html as before, and paint compared it
       to a cache that still held the board - so it declined to write and the card sat on "reading
       tickets..." for good. The DOM cannot go stale against itself. */
    /* ...but the DOM is NOT the string that went in (2026-09-29, the tab that ran out of memory): the browser serialises
       `selected` as `selected=""`, `&quot;` in text as `"`, and a style set after the write joins the markup - so the compare
       above failed for EVERY card on EVERY refresh (measured: 7 of 7 cards, ~700 KB of markup and ~15,000 elements rebuilt
       every 5-15 s; one refresh 116 ms; the tab died "Out of Memory"). So: the same html as this paint last wrote, AND the
       nodes it wrote are still the ones there (a placeholder or any other innerHTML write replaces them), means unchanged. */
    if (el.__painted === html && el.firstChild === el.__first && el.lastChild === el.__last) return false;
    if (el.innerHTML === html) { el.__painted = html; el.__first = el.firstChild; el.__last = el.lastChild; return false; }
    /* Keep the reader where they were. Replacing a tall card's contents sends its scroller back to
       the top and reflows everything, which is most of what reads as a "flash" - and these cards
       rewrite on every poll for no better reason than a relative time ticking from 3 to 4 minutes
      . Restoring in the same frame means the new content appears in place. */
    const sc = el.closest ? (el.closest('.cb') || el) : el;
    const top = sc.scrollTop, left = sc.scrollLeft;
    /* NEVER WRITE A CARD WHILE IT IS BEING WRITTEN. Replacing the contents removes a focused
       box; the browser fires blur during that removal; the blur handler repainted the same card - a write inside a write, which
       the browser refuses. A paint that arrives while one runs waits for it. */
    // the waiting write is always the NEWEST html - a queued older one landing after a newer write made a card flip back
    if (el.__painting) { var first = el.__pending === undefined; el.__pending = html; if (first) setTimeout(function () { var h = el.__pending; el.__pending = undefined; paint(el, h); }, 0); return false; }
    el.__painting = true;
    try { el.innerHTML = html; el.__painted = html; el.__first = el.firstChild; el.__last = el.lastChild; } finally { el.__painting = false; }
    if (top || left) { sc.scrollTop = top; sc.scrollLeft = left; }
    return true;
  }
  function refresh() {
    if (window.Pages) window.Pages.refresh();
    instances().forEach(function (k) {
      var c = T(k); if (!c || !c.render) return;
      var host = document.getElementById('card-' + k); if (!host || L.hidden[k]) return;
      var cb = host.querySelector('.cb'), cx = ctx(k);
      if (typingIn(cb)) {
        if (c.renderLive) c.renderLive(cb, cx);
        // after the blur, not inside it: blur also fires while the box is being removed by a repaint (see paint)
        if (!deferred[k]) { deferred[k] = true; document.activeElement.addEventListener('blur', function () { setTimeout(function () { delete deferred[k]; c.render(cb, density(k), cardSize(k), ctx(k)); }, 0); }, { once: true }); }
        return;
      }
      if (placeholder(k, host)) return;
      try { c.render(cb, density(k), cardSize(k), cx); } catch (err) { cb.innerHTML = '<div class="small" style="color:var(--red,#e5484d)">' + String(err.message).replace(/</g, '&lt;') + '</div>'; }
    });
  }
  /* show(id, false) removes a card from the desk entirely, and show(id, true) brings it back where
     it was (or where its declared column says, if it never had a place). Persisted. */
  /* a card just switched on lands where the person is looking, not at its old spot or under the whole column (owner,
     2026-09-27: "the cards, when checked, go way too low on the screen when they appear"). A drawer card stays in its drawer. */
  function toView(id) {
    if (side(id) || !L.root) return;
    if (!L.pos[id]) placeNew(id);
    var p = L.pos[id], rr = L.root.getBoundingClientRect(), W = roomW();
    p.w = Math.min(p.w, W);
    var now = Date.now(); L.cascade = now - (L.cascadeAt || 0) < 1500 ? (L.cascade || 0) + 1 : 0; L.cascadeAt = now;
    p.y = Math.max(0, topH() - rr.top) + GAP * 2 + L.cascade * 36;   // the top of what is on screen, in the room's own coordinates
    p.x = Math.max(0, Math.min(W - p.w, Math.round((W - p.w) / 2) + L.cascade * 36));
  }
  /* A CARD WITH NO PLACE YET: while the desk is
     first drawn it goes to its declared column (placeNew); once the desk is on screen, anything that turns up - a plugin
     switched on, a card added for you - lands where you are looking (toView), never under the whole column. */
  function newPlace(id) { if (L.settled && !side(id)) toView(id); else placeNew(id); }
  function show(id, on, keepPlace) {
    if (!T(id)) return;
    if (on) { if (!keepPlace && (L.hidden[id] || !L.pos[id])) toView(id); delete L.hidden[id]; if (L.pos[id]) front(id); } else { L.hidden[id] = 1; if (L.arrange === id) arrange(null); if (L.promoted === id) demote(id, false); SIDES.forEach(function (s) { if (L.open[s] === id) L.open[s] = null; }); }
    place(true); save();
  }
  function isHidden(id) { return !!L.hidden[id]; }
  /* ANOTHER PROJECT'S CARD ON THIS DESK. add(type, projects): the projects' card scripts and room facts come from
     the shell (window.ensureCards), then the instance is mounted where its declared column says. For the desk's own
     project it is simply the card shown. remove(key) takes a foreign instance off; its project keeps its own. */
  function add(type, projects, opts) {
    var list = [].concat(projects || []).filter(Boolean);
    if (!list.length || (list.length === 1 && list[0] === L.project)) { show(type, true, !(opts && opts.view)); return Promise.resolve(type); }
    var key = type + '@' + list.join('+');
    var ready = window.ensureCards ? window.ensureCards(list) : Promise.resolve();
    return Promise.resolve(ready).then(function () {
      var c = L.cards[type]; if (!c) throw new Error('no card ' + type + ' - its plugin is not loaded');
      if (!c.multi) throw new Error(c.title + ' cannot sit on another desk yet');
      if (!document.getElementById('card-' + key) && (opts && opts.view || L.settled)) toView(key); else if (!L.pos[key]) placeNew(key);   // the owner's pick lands in view; a card added for him (PA's seeding) keeps its column
      mount(key); place(true); front(key); save();
      return key;
    });
  }
  function remove(key) {
    if (!isForeign(key)) return;
    if (L.arrange === key) arrange(null); if (L.promoted === key) demote(key, false);
    SIDES.forEach(function (s) { L.dock[s] = L.dock[s].filter(function (x) { return x !== key; }); if (L.open[s] === key) L.open[s] = null; });
    delete L.pos[key]; delete L.hidden[key]; delete L.locked[key];
    var el = document.getElementById('card-' + key); if (el) el.remove();
    place(true); save();
  }

  window.addEventListener('resize', function () { if (L.root) place(false); });
  window.addEventListener('scroll', function () { placeDocks(); }, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !L.api || !L.root) return;
    // seen again: take the layout as the engine has it now (another tab may have changed it), then carry on
    fetch(L.api + '/layout?person=' + encodeURIComponent(L.person)).then(function (r) { return r.json(); }).then(function (saved) {
      if (!saved || !saved.pos) return;
      var mine = snapshot(false), theirs = JSON.stringify(Object.assign(JSON.parse(mine), { pos: saved.pos, dock: saved.dock || L.dock, hidden: saved.hidden || L.hidden, locked: saved.locked || L.locked }));
      if (theirs !== mine) { restore(saved); build(L.root); refresh(); }
      L.dirtyWhileHidden = false;
    }).catch(function () {});
  });
  window.Layout = { setCoding: setCoding, isCoding: isCoding, paint: paint, reveal: reveal, place: function () { if (L.root) place(false); }, register: register, build: build, defaults: defaults, restore: restore, save: save, reset: reset, refresh: refresh, fit: fit, snug: snug, saveDefault: saveDefault, show: show, isHidden: isHidden, front: front, add: add, remove: remove, close: closeCard, ctx: ctx, instances: instances, snapshotObj: snapshotObj, lift: lift, unlift: function () { unlift(false); }, load: function (saved) { if (!restore(saved)) return false; if (L.root) build(L.root); return true; }, promote: function (id) { promote(id, true); save(); }, demote: function (id) { demote(id, true); save(); }, state: L };
})();
