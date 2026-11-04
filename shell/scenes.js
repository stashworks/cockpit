/* Scenes: named desks with an icon, per project - "ticket mode", "writing" - each with
   its own arrangement of cards. A strip of icons in the top bar; click one and the cards SWEEP off the desk like
   a deck being cleared (a hand with an eraser leads, unless switched off) and the scene's cards DEAL back in,
   landing where that scene keeps them. Saved through the same per-project layout store as the desk itself
   (person "scenes" holds the list and which is current; "scene:<id>" holds each arrangement), so nothing new on
   the engine. The desk you see is always the current scene's; a change to it saves into that scene as you go
   (Layout.save → the shell's hook below), so switching away and back finds it as you left it. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
  var ICONS = ['🏠', '🎫', '💬', '🧪', '🗺', '📚', '⚛', '🌱', '🧾', '📈', '🛠', '🎯', '🧠', '🎲', '✈', '🎸'];
  var S = { project: null, list: [], current: null, loading: false, switching: false };
  function hand() { try { return localStorage.getItem('cockpit.scenes.hand') !== 'off'; } catch (e) { return true; } }
  function base() { return Layout.state.api; }
  function lsKey(k) { return 'cockpit.scenes.' + (Layout.state.project || 'none') + '.' + k; }
  function read(person) {
    return api(base() + '/layout?person=' + encodeURIComponent(person)).then(function (r) { return r && (r.list || r.pos || r.order) ? r : null; }).catch(function () { return null; })
      .then(function (r) { if (r) return r; try { return JSON.parse(localStorage.getItem(lsKey(person))); } catch (e) { return null; } });
  }
  function write(person, obj) {
    var s = JSON.stringify(obj);
    try { localStorage.setItem(lsKey(person), s); } catch (e) { /* */ }
    return fetch(base() + '/layout?person=' + encodeURIComponent(person), { method: 'POST', headers: { 'content-type': 'application/json' }, body: s }).catch(function () {});
  }
  function saveList() { return write('scenes', { list: S.list, current: S.current }); }
  function built() { var L = Layout.state; return !!(L.root && L.root.dataset.project === L.project && Object.keys(L.pos).length && document.querySelector('#room .card')); }   // the desk exists AND is this project's - never a scene from an empty desk, never the last project's desk as the new one's first scene (2026-09-20: a new project's "Desk" came out as Home's)

  /* the list for the open project; the first scene is made from the desk as it stands ("Desk") */
  function load() {
    var pid = Layout.state.project; if (!pid || S.loading || !built()) return; S.loading = true; S.project = pid;
    read('scenes').then(function (r) {
      if (S.project !== pid) return;
      S.list = (r && r.list) || []; S.current = (r && r.current) || (S.list[0] && S.list[0].id) || null;
      if (!S.list.length) { S.list = [{ id: 'desk', name: 'Desk', icon: '🏠' }]; S.current = 'desk'; write('scene:desk', Layout.snapshotObj()); saveList(); }
    }).then(function () { S.loading = false; draw(); });
  }
  function draw() {
    var strip = $('scenes'); if (!strip) return;
    strip.innerHTML = S.list.map(function (sc) { return '<span class="scn' + (sc.id === S.current ? ' on' : '') + '" data-id="' + esc(sc.id) + '" title="' + esc(sc.name) + (sc.id === S.current ? ' - this desk; click for its settings' : ' - click to switch') + '">' + esc(sc.icon) + '</span>'; }).join('')
      + '<span class="scn add" id="scn-add" title="save this desk as a new scene">＋</span>';
    strip.querySelectorAll('.scn[data-id]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); if (b.dataset.id === S.current) menu(b.dataset.id, b); else switchTo(b.dataset.id); }); });
    $('scn-add').addEventListener('click', function (e) { e.stopPropagation(); menu(null, $('scn-add')); });
  }
  /* the panel: a new scene (name, icon) from this desk; or the current one - rename, icon, delete, the hand */
  function menu(id, at) {
    var m = $('scnmenu'); if (!m.hidden && m.dataset.for === (id || 'new')) { m.hidden = true; return; }
    var sc = id ? S.list.find(function (x) { return x.id === id; }) : null;
    m.dataset.for = id || 'new';
    m.innerHTML = '<div class="cm-hd"><b>' + (sc ? esc(sc.name) : 'A new scene from this desk') + '</b><span class="small dim">' + (sc ? 'this desk is saved into it as you change it' : 'the cards as they sit now become a scene you can come back to') + '</span></div>'
      + '<div class="cm-g"><input type="text" id="scn-name" placeholder="name - tickets, review, writing…" value="' + esc(sc ? sc.name : '') + '" maxlength="40"></div>'
      + '<div class="cm-g"><span class="cm-k">icon</span><div class="scn-icons">' + ICONS.map(function (i) { return '<span class="scn-i' + ((sc ? sc.icon : ICONS[1]) === i ? ' on' : '') + '" data-i="' + i + '">' + i + '</span>'; }).join('') + '</div></div>'
      + '<div class="cm-g"><label><input type="checkbox" id="scn-hand"' + (hand() ? ' checked' : '') + '> the hand with the eraser sweeps the desk on a switch</label></div>'
      + '<div class="cm-acts"><button class="btn sm" id="scn-ok">' + (sc ? 'Save' : 'Make the scene') + '</button>' + (sc && S.list.length > 1 ? ' · <a href="#" id="scn-del">delete this scene</a>' : '') + ' <span class="small dim" id="scn-msg"></span></div>';
    m.hidden = false; m.style.zIndex = 80;
    var r = at.getBoundingClientRect(); m.style.left = Math.max(8, Math.min(window.innerWidth - 340, r.left - 20)) + 'px'; m.style.top = (r.bottom + 8) + 'px';
    m.querySelectorAll('.scn-i').forEach(function (i) { i.addEventListener('click', function () { m.querySelectorAll('.scn-i').forEach(function (x) { x.classList.remove('on'); }); i.classList.add('on'); }); });
    $('scn-hand').addEventListener('change', function () { try { localStorage.setItem('cockpit.scenes.hand', $('scn-hand').checked ? 'on' : 'off'); } catch (e) { /* */ } });
    $('scn-ok').addEventListener('click', function () {
      var name = $('scn-name').value.trim(), icon = (m.querySelector('.scn-i.on') || {}).dataset.i || ICONS[1];
      if (!name) { $('scn-msg').textContent = 'a name, please'; return; }
      if (sc) { sc.name = name; sc.icon = icon; saveList().then(draw); m.hidden = true; return; }
      var nid = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene'; while (S.list.some(function (x) { return x.id === nid; })) nid += '2';
      S.list.push({ id: nid, name: name, icon: icon }); S.current = nid;
      write('scene:' + nid, Layout.snapshotObj()); saveList().then(draw); m.hidden = true;
    });
    var del = $('scn-del'); if (del) del.addEventListener('click', function (e) {
      e.preventDefault(); S.list = S.list.filter(function (x) { return x.id !== id; }); m.hidden = true;
      var next = S.list[0].id; saveList(); switchTo(next);
    });
    setTimeout(function () { $('scn-name').focus(); }, 0);
  }
  document.addEventListener('click', function () { var m = $('scnmenu'); if (m) m.hidden = true; });
  if ($('scnmenu')) $('scnmenu').addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var m = $('scnmenu'); if (m) m.hidden = true; } });

  /* the switch: sweep the cards off, load the scene, deal them in */
  function switchTo(id) {
    if (S.switching || id === S.current) return;
    var target = S.list.find(function (x) { return x.id === id; }); if (!target) return;
    /* the outgoing scene is written NOW, not on the 600 ms debounce - a switch inside that window used to drop the
       write, and the scene came back with an older arrangement */
    clearTimeout(saveT); if (S.current && built()) write('scene:' + S.current, Layout.snapshotObj());
    S.switching = true;
    var room = $('room'), cards = Array.prototype.slice.call(room.querySelectorAll('.card')).filter(function (c) { return c.style.display !== 'none'; });
    cards.sort(function (a, b) { return (a.getBoundingClientRect().left - b.getBoundingClientRect().left) || (a.getBoundingClientRect().top - b.getBoundingClientRect().top); });
    var wipe = hand() ? showHand(room) : null;
    cards.forEach(function (c, i) { c.style.transitionDelay = (i * 40) + 'ms'; c.classList.add('sweep'); });
    var wait = 260 + cards.length * 40;
    Promise.all([read('scene:' + id), new Promise(function (res) { setTimeout(res, wait); })]).then(function (rr) {
      var saved = rr[0];
      S.current = id; saveList();
      // the scene's other-project cards need their scripts before the layout can mount them
      var foreign = {}; Object.keys((saved && saved.pos) || {}).forEach(function (k) { var i = k.indexOf('@'); if (i > 0) k.slice(i + 1).split('+').forEach(function (p) { foreign[p] = 1; }); });
      return (window.ensureCards ? window.ensureCards(Object.keys(foreign)).catch(function () {}) : Promise.resolve()).then(function () { return saved; });
    }).then(function (saved) {
      if (!saved || !Layout.load(saved)) { Layout.defaults(); Layout.build(room); }
      Layout.refresh();
      Layout.save();   // the live layout (what a refresh loads) is now this scene; S.switching keeps the scene itself unwritten
      // deal: every card starts off the bottom-left corner, tilted, and flies to its place one after another
      var fresh = Array.prototype.slice.call(room.querySelectorAll('.card')).filter(function (c) { return c.style.display !== 'none'; });
      fresh.sort(function (a, b) { return (parseFloat(a.style.top) - parseFloat(b.style.top)) || (parseFloat(a.style.left) - parseFloat(b.style.left)); });
      fresh.forEach(function (c) { c.classList.add('deal'); c.style.transitionDelay = '0ms'; });
      void room.offsetWidth;
      fresh.forEach(function (c, i) { c.style.transitionDelay = (i * 60) + 'ms'; c.classList.remove('deal'); });
      setTimeout(function () { fresh.forEach(function (c) { c.style.transitionDelay = ''; }); if (wipe) wipe(); S.switching = false; draw(); }, 500 + fresh.length * 60);
    }).catch(function (e) { console.error('scene: ' + e.message); S.switching = false; cards.forEach(function (c) { c.classList.remove('sweep'); c.style.transitionDelay = ''; }); });
  }
  /* the hand: crosses the desk left to right with the eraser while the cards go, then leaves */
  function showHand(room) {
    var h = document.createElement('div'); h.className = 'scn-hand'; h.innerHTML = '<span class="scn-eraser"></span><span class="scn-palm">✋</span>';
    room.appendChild(h); void h.offsetWidth; h.classList.add('go');
    return function () { h.classList.add('bye'); setTimeout(function () { h.remove(); }, 400); };
  }

  /* every save of the desk also lands in the current scene, so a scene is always what you last left it */
  var saveT = null;
  function hookSave() {
    Layout.state.onSave = function () { if (!(S.current && S.project === Layout.state.project && !S.switching && !S.loading)) return; var id = S.current, proj = Layout.state.project; clearTimeout(saveT); saveT = setTimeout(function () { if (S.current === id && S.project === proj && Layout.state.project === proj && built()) write('scene:' + id, Layout.snapshotObj()); }, 600); };   // never another project's desk into this scene
  }
  window.Scenes = { load: load, switchTo: switchTo, state: S };
  hookSave();
  // the strip follows the open project: the shell calls Scenes.load() when a room is built; a project change resets
  setInterval(function () { if (window.ROOM && !window.ROOM.missing && built() && Layout.state.project !== S.project && !S.loading) { S.list = []; S.current = null; draw(); load(); } }, 1000);
})();
