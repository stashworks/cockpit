/* The shell: which project is open, the switcher, the open-folder dialog, and the room.
   The URL carries the project (/my-app, /notes - docs/generic-ide.md §13). Polling the
   room every minute is what keeps a project warm on the engine; closing the tab lets it
   go quiet at the idle limit. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api(url, opts) { return fetch(url, opts).then(function (r) { return r.json(); }); }

  var S = { id: null, projects: [], poll: null };
  /* HOME: the front door is the project in the folder "home" - always there, open when nothing
     else is picked, its desk holding other projects' cards. The folder name is fixed; the label is the project's name. */
  var HOME = 'home';
  function hasHome() { return S.projects.some(function (p) { return p.id === HOME; }); }
  function syncNav() {
    var onRoom = document.querySelector('#view-room.on');
    var nh = $('navhome'); if (nh) nh.classList.toggle('on', !!onRoom && S.id === HOME);
    var cr = document.querySelector('.nav a[data-view="room"]'); if (cr) { cr.hidden = S.id === HOME; cr.classList.toggle('on', !!onRoom && S.id !== HOME); }
    document.documentElement.classList.toggle('home-bg', !!onRoom);   // every project's desk sits in front of the seasonal picture (img/home/bg/), as Home's does
  }

  /* ---------- which project ---------- */
  function idFromUrl() { var m = location.pathname.match(/^\/([a-z0-9-]+)$/); return m ? m[1] : null; }

  /* THE TAB CLOSES THE PROJECT. Closing the
     browser tab, or switching this tab to another project, asks the engine to let the project go now instead of at the
     idle limit - so its folder can be moved or renamed. Only an engine that refuses while work runs (closeSafe) is
     asked; another tab still on the project simply reopens it on its next poll. Home is never closed. */
  var closeSafe = false; api('/api/engine').then(function (e) { closeSafe = !!(e && e.closeSafe); }).catch(function () {});
  function letGo(id) { if (!closeSafe || !id || id === HOME) return; try { navigator.sendBeacon('/api/p/' + encodeURIComponent(id) + '/close'); } catch (e) { /* the idle limit still does it */ } }
  window.addEventListener('pagehide', function () { letGo(S.id); });

  function select(id, push) {
    if (S.poll) { clearInterval(S.poll); S.poll = null; }
    if (S.id && S.id !== id) letGo(S.id);
    S.id = id;
    if (push !== false) history.pushState({}, '', id ? '/' + id : '/');
    window.ROOM = null;
    if (!id) { showNoProject(); $('aipick').hidden = true; return; }
    Layout.state.project = id; Layout.state.api = '/api/p/' + id;
    loadRoom(true);
    /* Every 5 s ask the engine for the project's change counter (one tiny call); reload the
       room only when it moved - a scan the AI ran, a grade it recorded, a turn that ended.
       The minute-long blind reload is gone; it kept the project warm but showed a finished
       scan up to 60 s late. This poll keeps it warm just the same. */
    S.version = null; S.foreignVersion = {};
    S.poll = setInterval(function () {
      api('/api/p/' + S.id + '/version').then(function (v) {
        if (S.version === null) { S.version = v.version; return; }
        if (v.version !== S.version) { S.version = v.version; loadRoom(false); }
        if (window.refreshAIBusy) window.refreshAIBusy();
      }).catch(function () {});
      /* the other projects with a card on this desk (Home: any project's cards) are watched the same way - their cards read a
         copy of that project's room, and the copy is re-read when that project moves (another project's conversation
         on Home kept spinning after its turn ended, and its draft buttons came and went) */
      var foreign = {}; Object.keys(Layout.state.pos).forEach(function (k) { var i = k.indexOf('@'); if (i > 0 && !Layout.state.hidden[k]) k.slice(i + 1).split('+').forEach(function (p) { if (p !== S.id) foreign[p] = 1; }); });
      Object.keys(foreign).forEach(function (pid) {
        api('/api/p/' + pid + '/version').then(function (v) {
          if (S.foreignVersion[pid] === undefined) { S.foreignVersion[pid] = v.version; return; }
          if (v.version === S.foreignVersion[pid]) return;
          S.foreignVersion[pid] = v.version;
          return api('/api/p/' + pid + '/room').then(function (r) { if (r && !r.error) { Layout.state.rooms[pid] = r; Layout.refresh(); } });
        }).catch(function () {});
      });
    }, 5000);
  }

  var loadedScripts = {};
  function loadScripts(urls) {
    return Promise.all(urls.map(function (u) {
      if (loadedScripts[u]) return Promise.resolve();
      return new Promise(function (res) { var s = document.createElement('script'); s.src = u; s.onload = function () { loadedScripts[u] = true; res(); }; s.onerror = function () { console.error('plugin card failed to load: ' + u); res(); }; document.body.appendChild(s); });
    }));
  }
  /* Another project's cards on this desk need that project's room facts (its name, its plugins) and its
     card scripts on the page. Layout.add calls this before mounting; the room build calls it for the
     instances a saved layout already holds. Room facts are cached in Layout.state.rooms. */
  function ensureCards(projects) {
    return Promise.all((projects || []).filter(function (p) { return p && p !== S.id; }).map(function (p) {
      var have = Layout.state.rooms[p];
      return (have ? Promise.resolve(have) : api('/api/p/' + p + '/room').then(function (r) { if (!r || r.error) throw new Error(p + ': ' + ((r && r.error) || 'no room')); Layout.state.rooms[p] = r; return r; }))
        .then(function (r) {
          var groups = {}; ((r.plugins && r.plugins.available) || []).forEach(function (p) { if (p.group) groups[p.name] = p.group; });
          return loadScripts(((r.plugins && r.plugins.cards) || []).filter(function (u) { var m = u.match(/^\/plugins\/([a-z0-9-]+)\//); return Layout.state.coding || !(m && groups[m[1]] === 'coding'); }));   // the Coding gate
        });
    }));
  }
  window.ensureCards = ensureCards;
  window.openProject = function (id) { if (id && id !== S.id) select(id, true); };   // go into a project (a foreign card asked to)
  /* an alert, a row, a link: go to the thing it is about, not just the project. kind is the event's kind
     (ticket.verified, fleet.retry, tests.red, backup, promote.fail, ...), ref the ticket when there is one. */
  window.goTo = function (target) {
    target = target || {};
    var run = function () {
      var k = String(target.kind || ''), ref = target.ref ? String(target.ref) : '';
      if (/^(ticket|fleet)\./.test(k) && ref && !/^backup/.test(ref)) { showView('room'); Layout.reveal('tickets'); if (window.__tickets) { window.__tickets.open(ref); setTimeout(function () { window.__tickets.open(ref); }, 900); } return; }
      if (/^(tests|dast|promote)/.test(k)) { var a = document.querySelector('.nav a[data-view="page-tests"]'); if (a) { a.click(); return; } }
      if (k === 'backup') { showView('room'); Layout.reveal('backups'); return; }
      showView('room'); Layout.reveal('alerts');
    };
    if (target.project && target.project !== S.id) { S.afterLoad = run; select(target.project, true); } else run();
  };
  // Re-read the room and rebuild it - after a plugin is selected or a scan finishes.
  window.reloadRoom = function () { if (S.id) loadRoom(true); };

  function showNoProject() {
    $('noproject').hidden = false; $('room').hidden = true;
    $('swname').textContent = 'No project'; $('swpath').textContent = 'pick a folder to begin';
    document.title = 'Cockpit';
  }

  function loadRoom(first) {
    api('/api/p/' + S.id + '/room').then(function (r) {
      if (r && r.error) { window.ROOM = { missing: true, path: r.error, name: S.id }; }
      else window.ROOM = r;
      $('noproject').hidden = true; $('room').hidden = false;
      var listed = S.projects.find(function (x) { return x.id === S.id; }); if (window.ROOM && listed && listed.name) window.ROOM.name = listed.name;   // the list is fresh after a rename; the room may lag until the engine restarts
      $('swname').textContent = (window.ROOM && window.ROOM.name) || S.id;
      $('swpath').textContent = (window.ROOM && window.ROOM.path) || '';
      document.title = ((window.ROOM && window.ROOM.name) || S.id);
      if (first) loadAI();
      if (first) {
        // A selected plugin's cards are scripts the room does not know until the project is
        // open (§3): load them, then build. A script already on the page is not loaded twice.
        /* Home (the folder "home") is the workbench for cards and layouts: EVERY plugin's card scripts load there,
           whatever is switched on, so any card type can be placed - as a placeholder until a project brings it
           alive. No plugin runs on Home for that. */
        var urls = (window.ROOM && window.ROOM.plugins && window.ROOM.plugins.cards) || [];
        /* a plugin's "libs": scripts of another plugin its pages are built on, loaded whether that plugin is on or not
           (the Tests tab is drawn with the Architecture plugin's page kit - 2026-09-20: with Architecture off it was a
           bare heading). A page or card the other plugin registers still shows only when its plugin is on. */
        var libs = (((window.ROOM || {}).plugins || {}).available || []).filter(function (p) { return p.selected; }).flatMap(function (p) { return p.libs || []; });
        libs.forEach(function (u) { if (urls.indexOf(u) < 0) urls.unshift(u); });
        if (S.id === HOME) urls = urls.concat((((window.ROOM || {}).plugins || {}).available || []).flatMap(function (p) { return (p.cards || []).map(function (c) { return '/plugins/' + p.name + '/' + c; }); }));
        /* THE CODING GATE (shell/layout.js): the engine-wide Coding plugin decides, before anything is laid out, whether the
           coding cards exist on this page at all; off, a coding plugin's scripts are not even loaded */
        api('/api/engine').catch(function () { return null; }).then(function (e) {
          var groups = {}; (((window.ROOM || {}).plugins || {}).available || []).forEach(function (p) { if (p.group) groups[p.name] = p.group; });
          S.coding = !!(e && e.coding); Layout.setCoding(S.coding, groups);
          if (!S.coding) urls = urls.filter(function (u) { var m = u.match(/^\/plugins\/([a-z0-9-]+)\//); return !(m && groups[m[1]] === 'coding'); });
          return loadScripts(urls);
        }).then(function () { return window.Icons ? Icons.load() : null; }).then(function () { return window.BoxCards ? BoxCards.load() : null; })   /* a trusted project's own boxed cards, known before the desk is laid out (shell/boxcards.js) */.then(function () {   // the person's icon theme and picks, before any card is drawn
        // the new-project template: Home's "Default Project Layout" scene, read live
        return api('/api/p/' + HOME + '/layout?person=' + encodeURIComponent('scene:default-project-layout')).then(function (t) { Layout.state.template = t && t.pos ? t : null; }).catch(function () { Layout.state.template = null; }); }).then(function () {
        // The layout is the project's: restore its saved one, else the defaults (the template first).
        // whose layout: the engine's configured person (engine.json "person" / COCKPIT_PERSON)
        return api('/api/engine').catch(function () { return null; }).then(function (e) { Layout.state.person = (e && e.person) || 'default';
          return api('/api/p/' + S.id + '/layout?person=' + encodeURIComponent(Layout.state.person)).catch(function () { return undefined; }); }); }).then(function (saved) {   // undefined = the engine could not be asked (null = it has none)
          /* The engine's copy is the layout. The browser copy (localStorage) is only for when the engine could not be
             asked - never for a project the engine has no layout for: a folder removed and added back keeps its id,
             and the old browser copy came back as its "new" desk instead of the template. */
          if (!Layout.restore(saved)) {
            var local = null; if (saved === undefined) { try { local = JSON.parse(localStorage.getItem('cockpit.layout.' + S.id)); } catch (e) {} }
            if (!Layout.restore(local)) { Layout.defaults(); S.freshLayout = true; }   // a first layout (the template): saved once built, so the project owns it from the start
          }
          /* A card belongs to a plugin (card.plugin); it exists on the room only while that
             plugin is selected. A deselected plugin's script is still on the page, so its
             card is hidden here rather than left standing. */
          var selectedPlugins = ((window.ROOM.plugins || {}).available || []).filter(function (p) { return p.selected; }).map(function (p) { return p.name; });
          Object.values(Layout.state.cards).forEach(function (c) {
            if (!c.plugin) return;
            if (S.id === HOME) { if (Layout.state.hidden[c.id] === 'plugin') Layout.state.hidden[c.id] = 1; else if (!(c.id in Layout.state.hidden) && !Layout.state.pos[c.id]) Layout.state.hidden[c.id] = 1; return; }   // Home: placeable, closed until asked for
            if (selectedPlugins.indexOf(c.plugin) < 0) { if (!Layout.state.hidden[c.id]) Layout.state.hidden[c.id] = 'plugin'; } else if (Layout.state.hidden[c.id] === 'plugin') delete Layout.state.hidden[c.id];
          });   // 'plugin' = hidden because the plugin is off; a 1 is the owner's own choice (Plugins page)
          // Home's own cards (the greeting, the projects) exist on Home only
          Object.values(Layout.state.cards).forEach(function (c) { if (!c.home) return; if (S.id !== HOME) { if (!Layout.state.hidden[c.id]) Layout.state.hidden[c.id] = 'home'; } else if (Layout.state.hidden[c.id] === 'home') delete Layout.state.hidden[c.id]; });
          // a card that belongs to one project (a boxed card) is on that project's desk only; elsewhere it sits as type@project
          Object.values(Layout.state.cards).forEach(function (c) { if (!c.projectOnly) return; if (S.id !== c.projectOnly) { if (!Layout.state.hidden[c.id]) Layout.state.hidden[c.id] = 'project'; } else if (Layout.state.hidden[c.id] === 'project') delete Layout.state.hidden[c.id]; });
          /* Other projects' cards on this desk (instances "type@project"): their card scripts and room facts
             must be on the page before build, or the layout would drop them as unknown. */
          var foreign = {}; Object.keys(Layout.state.pos).forEach(function (k) { var i = k.indexOf('@'); if (i > 0) k.slice(i + 1).split('+').forEach(function (p) { if (p !== S.id) foreign[p] = 1; }); });
          return ensureCards(Object.keys(foreign));
        }).then(function () {
          Layout.build($('room'));
          window.Pages.build();
          Layout.refresh();
          if (S.freshLayout) { S.freshLayout = false; Layout.save(); }
          if (window.Scenes) window.Scenes.load();
          if (S.afterLoad) { var fn = S.afterLoad; S.afterLoad = null; setTimeout(fn, 300); }   // a go-to that waited for the room
        }).catch(function (e) { console.error('room: ' + e.message); Layout.defaults(); Layout.build($('room')); Layout.refresh(); });
      } else Layout.refresh();
      if (window.renderPluginsPage) window.renderPluginsPage();
      refreshProjects().then(function () { var l = S.projects.find(function (x) { return x.id === S.id; }); if (l && window.ROOM && l.name && window.ROOM.name !== l.name) { window.ROOM.name = l.name; $('swname').textContent = l.name; document.title = l.name; if (window.renderPluginsPage) window.renderPluginsPage(); Layout.refresh(); } }); syncNav();
    }).catch(function (e) { window.ROOM = { missing: true, path: String(e), name: S.id }; Layout.refresh(); });
  }

  /* ---------- the switcher ---------- */
  function refreshProjects() {
    return api('/api/projects').then(function (r) { S.projects = r.projects || []; window.PROJECTS = S.projects; drawMenu(); });   // PROJECTS: the list, for cards that offer a project to pick (Home's Alerts filter)
  }
  function drawMenu() {
    var m = $('swmenu');
    var items = S.projects.filter(function (p) { return p.id !== HOME; }).sort(function (a, b) { return (b.lastOpened || '') < (a.lastOpened || '') ? -1 : 1; }); // Home is not in the list - the Home button is the way back
    m.innerHTML = items.map(function (p) {
      var st = !p.exists ? '<span class="st gone">folder missing</span>' : p.loaded ? '<span class="st live">● loaded</span>' : '<span class="st">quiet</span>';
      /* a real link (every pick does):
         any click on another project opens it in a new tab, the ↗ included */
      return '<a class="swi' + (p.id === S.id ? ' on' : '') + '" data-id="' + esc(p.id) + '" href="/' + esc(p.id) + '"><b>' + esc(p.name) + '</b>' + st + '<span class="swnew" title="open in a new tab">↗</span><small>' + esc(p.path) + '</small></a>';
    }).join('') + (items.length ? '<div class="swsep"></div>' : '')
      + '<div class="swact" id="swopen">＋ Open a folder…</div>'
      + (S.id ? '<div class="swact" id="swforget">Forget this project <span class="dim small">(the folder is untouched)</span></div>' : '');
    m.querySelectorAll('.swi').forEach(function (el) { el.addEventListener('click', function (e) {
      if (e.ctrlKey || e.metaKey || e.shiftKey) { m.hidden = true; return; }   // the browser opens the link in a new tab/window
      e.preventDefault(); m.hidden = true;
      /* ANOTHER PROJECT OPENS IN A NEW TAB (picking a project in the switcher should load it in a new
         tab) - this tab stays where it was; picking the project you are in just closes the menu */
      if (el.dataset.id === S.id) return;
      window.open('/' + el.dataset.id, '_blank');
    }); });
    var o = $('swopen'); if (o) o.addEventListener('click', function () { m.hidden = true; openDialog(); });
    var f = $('swforget'); if (f) f.addEventListener('click', function () { m.hidden = true; forget(); });
  }
  /* Forget = stop listing. The folder and its .cockpit are left exactly as they are. Reachable
     from the switcher menu AND the Project card - the owner could not find it in the menu. */
  function forget() {
    if (!S.id) return;
    if (!confirm('Forget "' + S.id + '"? The folder and its .cockpit are left exactly as they are; Cockpit just stops listing it.')) return;
    api('/api/projects/' + S.id, { method: 'DELETE' }).then(function () { refreshProjects().then(function () { select(hasHome() ? HOME : null, true); showView('room'); }); });   // forgotten: back Home, not the empty screen (2026-09-20)
  }
  window.forgetProject = forget;
  $('swbtn').addEventListener('click', function (e) { e.stopPropagation(); refreshProjects().then(function () { $('swmenu').hidden = !$('swmenu').hidden; }); });
  document.addEventListener('click', function () { $('swmenu').hidden = true; });
  $('swmenu').addEventListener('click', function (e) { e.stopPropagation(); });

  /* ---------- open a folder ---------- */
  var D = { path: '' };
  /* onAdded: the setup wizard's way in - the folder is added and handed back, and no tab opens (a new person must not be
     sent off to another tab in the middle of setup) */
  function openDialog(onAdded) { D.onAdded = typeof onAdded === 'function' ? onAdded : null; $('dlg').hidden = false; browse(''); }
  function browse(p) {
    api('/api/fs?path=' + encodeURIComponent(p)).then(function (r) {
      D.path = r.path || ''; $('dlgpathin').value = D.path;
      var h = '';
      if (r.parent !== null && r.parent !== undefined) h += '<div class="fe up" data-p="' + esc(r.parent) + '"><span>↰</span><span>..</span><span></span></div>';
      if (r.error) h += '<div class="err">cannot read: ' + esc(r.error) + '</div>';
      h += (r.entries || []).map(function (e) { return '<div class="fe" data-p="' + esc(e.path) + '"><span>▸</span><span>' + esc(e.name) + '</span>' + (e.cockpit ? '<span class="ck">.cockpit ✓</span>' : '<span></span>') + '</div>'; }).join('');
      $('dlglist').innerHTML = h;
      $('dlglist').querySelectorAll('.fe').forEach(function (el) { el.addEventListener('click', function () { browse(el.dataset.p); }); });
      $('dlghint').textContent = D.path ? (r.isCockpit ? 'This folder is already a project (it has a .cockpit).' : 'Opening creates a .cockpit folder inside it. Nothing else is touched.') : 'Pick a drive.';
      $('dlgopen').style.visibility = D.path ? 'visible' : 'hidden';
    });
  }
  $('dlggo').addEventListener('click', function () { browse($('dlgpathin').value.trim()); });
  $('dlgpathin').addEventListener('keydown', function (e) { if (e.key === 'Enter') browse($('dlgpathin').value.trim()); });
  $('dlgx').addEventListener('click', function () { $('dlg').hidden = true; D.onAdded = null; });
  /* A NEW PROJECT OPENS IN A NEW TAB - this tab stays
     where it was. The tab is opened NOW, inside the click (a tab opened after the engine answers is a pop-up the browser
     blocks), and sent to the project once it is added; on an error it closes and the dialog says why. */
  $('dlgopen').addEventListener('click', function () {
    if (!D.path) return;
    if (D.onAdded) {
      var cb = D.onAdded;
      api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: D.path }) }).then(function (r) {
        if (!r.ok) { $('dlghint').textContent = r.error || 'could not open'; return; }
        $('dlg').hidden = true; D.onAdded = null; refreshProjects(); cb(r.project);
      }).catch(function (e) { $('dlghint').textContent = 'could not open: ' + e.message; });
      return;
    }
    var tab = window.open('', '_blank');
    if (tab) { try { tab.document.title = 'Opening…'; tab.document.body.style.cssText = 'background:#0b0e1f;color:#aab;font:14px system-ui;padding:40px'; tab.document.body.textContent = 'Opening the project…'; } catch (e) { /* */ } }
    api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: D.path }) }).then(function (r) {
      if (!r.ok) { if (tab) tab.close(); $('dlghint').textContent = r.error || 'could not open'; return; }
      $('dlg').hidden = true;
      if (tab && !tab.closed) { tab.location.href = '/' + encodeURIComponent(r.project.id); refreshProjects(); }   // and this tab's switcher lists it
      else select(r.project.id);   // the browser refused the tab: open it here, as before
    }).catch(function (e) { if (tab) tab.close(); $('dlghint').textContent = 'could not open: ' + e.message; });
  });
  $('openfolder').addEventListener('click', openDialog);
  window.openFolderDialog = openDialog;   // Home's Projects card offers it when there are no projects yet

  /* ---------- the project's AI (header) ---------- */
  window.AI = { harness: null, model: null, agent: null, harnesses: [], coders: [], busy: [] };
  /* what the owner is looking at: a card sets { label, text } and clears it; the chat sends it with the next message */
  window.Screen = { context: null, set: function (ctx) { var was = window.Screen.context; window.Screen.context = ctx || null; if ((was && was.label) !== (ctx && ctx.label) && window.Layout && Layout.refresh) setTimeout(function () { Layout.refresh(); }, 0); } };   /* deferred: a card sets it mid-render */
  /* A harness that runs one turn at a time (the local model) is greyed out in the header
     while it is busy anywhere, with where; the engine refuses the turn too. (owner,
     2026-09-16: "have the option greyed out so I don't accidentally trigger 2 local jobs") */
  function busyElsewhere(name) { return window.AI.busy.find(function (b) { return b.harness === name && b.project !== S.id; }) || null; }
  window.harnessBlocked = function (name) { var h = window.AI.harnesses.find(function (x) { return x.name === name; }); if (!h) return null; if (!h.ok) return h.why; if (h.exclusive) { var b = window.AI.busy.find(function (x) { return x.harness === name; }); if (b) return h.label + ' is busy on ' + b.project + ' since ' + b.since.slice(11, 16) + ' - one local turn at a time'; } return null; };
  function loadAI() {
    return api('/api/harnesses').then(function (r) {
      window.AI.harnesses = r.harnesses || []; window.AI.coders = r.coders || []; window.AI.busy = r.busy || [];
      var saved = (window.ROOM && window.ROOM.cockpit && window.ROOM.cockpit.ai) || {};
      var sc = saved.agent ? window.AI.coders.find(function (c) { return c.id === saved.agent && c.ok; }) : null;
      window.AI.agent = sc ? sc.id : null;
      var ok = window.AI.harnesses.find(function (h) { return h.name === saved.harness && h.ok; }) || window.AI.harnesses.find(function (h) { return h.ok; });
      window.AI.harness = ok ? ok.name : null;
      window.AI.model = ok && ok.models.some(function (m) { return m.id === saved.model; }) ? saved.model : (ok && ok.models[0] ? ok.models[0].id : null);
      drawAI();
    });
  }
  function drawAI() {
    var wrap = $('aipick'); wrap.hidden = !S.id;
    var hs = $('ai-harness'), ms = $('ai-model');
    hs.innerHTML = window.AI.harnesses.map(function (h) {
      var b = h.exclusive ? busyElsewhere(h.name) : null;
      return '<option value="' + esc(h.name) + '"' + (!window.AI.agent && h.name === window.AI.harness ? ' selected' : '') + (h.ok && !b ? '' : ' disabled') + '>' + esc(h.label) + (h.ok ? '' : ' - ' + esc(h.why)) + (b ? ' - busy on ' + esc(b.project) : '') + '</option>';
    }).join('')
      /* the added coders, each on its own account */
      + (window.AI.coders.length ? '<optgroup label="Coders (own accounts)">' + window.AI.coders.map(function (c) {
        return '<option value="coder:' + esc(c.id) + '"' + (c.id === window.AI.agent ? ' selected' : '') + (c.ok ? '' : ' disabled') + '>' + esc(c.label) + (c.ok ? '' : ' - not logged in') + '</option>';
      }).join('') + '</optgroup>' : '');
    var cur = window.AI.harnesses.find(function (h) { return h.name === window.AI.harness; });
    ms.innerHTML = ((cur && cur.models) || []).map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === window.AI.model ? ' selected' : '') + '>' + esc(m.label) + (m.free ? ' (free)' : '') + '</option>'; }).join('');
    var blocked = window.AI.harness ? window.harnessBlocked(window.AI.harness) : null;
    wrap.title = blocked || 'the AI this project uses, everywhere';
    wrap.classList.toggle('blocked', !!blocked);
  }
  // busy state changes as turns start and end anywhere: refresh it with the version poll
  window.refreshAIBusy = function () { api('/api/harnesses').then(function (r) { var was = JSON.stringify(window.AI.busy); window.AI.busy = r.busy || []; if (JSON.stringify(window.AI.busy) !== was) { drawAI(); Layout.refresh(); } }); };
  function saveAI() { if (S.id) api('/api/p/' + S.id + '/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: window.AI.harness, model: window.AI.model, agent: window.AI.agent || '' }) }); Layout.refresh(); }
  window.setAI = function (harness, model) { if (harness !== window.AI.harness) window.AI.agent = null; window.AI.harness = harness; window.AI.model = model; drawAI(); saveAI(); };   // the conversation's /use and /model
  $('ai-harness').addEventListener('change', function (e) { var v = e.target.value, c = v.indexOf('coder:') === 0 ? window.AI.coders.find(function (x) { return 'coder:' + x.id === v; }) : null; window.AI.agent = c ? c.id : null; window.AI.harness = c ? c.harness : v; var h = window.AI.harnesses.find(function (x) { return x.name === window.AI.harness; }); window.AI.model = h && h.models[0] ? h.models[0].id : null; drawAI(); saveAI(); });
  $('ai-model').addEventListener('change', function (e) { window.AI.model = e.target.value; saveAI(); });

  /* Any script error lands in the footer with its file and line, so a blank page says why
    . */
  window.addEventListener('error', function (e) { if (/ResizeObserver loop/.test(String(e.message))) return; /* the browser's own notice that a layout settled a frame late - not a defect, and it fires whenever a card resizes while its text reflows (2026-09-19) */ var f = $('foot'); if (f) f.innerHTML = '<span style="color:var(--red,#e5484d)">script error: ' + String(e.message).replace(/</g, '&lt;') + ' <span class="dim">(' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ')</span></span>'; });
  window.addEventListener('unhandledrejection', function (e) { var f = $('foot'); if (f) f.innerHTML = '<span style="color:var(--red,#e5484d)">error: ' + String(e.reason && e.reason.message || e.reason).replace(/</g, '&lt;') + '</span>'; });

  /* ---------- plugin pages ----------
     A plugin's card script may also register a PAGE: a tab of its own beside Control room and
     Plugins, for a view too big for a card (the Architecture map with the conversation beside
     it). Tabs exist only while the plugin is selected; the page renders when shown and on every
     Layout.refresh, with the same typing guard as a card. */
  var PAGES = {};
  window.Pages = {
    register: function (p) { PAGES[p.id] = p; },
    build: function () {
      var nav = $('nav'), main = document.querySelector('main');
      var was = (document.querySelector('section[data-page].on') || {}).dataset; was = was && was.page;   // the tab showing: it stays showing after the rebuild (a room reload used to leave no view on)
      nav.querySelectorAll('a[data-page]').forEach(function (a) { a.remove(); });
      main.querySelectorAll('section[data-page]').forEach(function (s) { s.remove(); });
      var selected = (((window.ROOM || {}).plugins || {}).available || []).filter(function (p) { return p.selected; }).map(function (p) { return p.name; });
      var groups = {}; (((window.ROOM || {}).plugins || {}).available || []).forEach(function (p) { if (p.group) groups[p.name] = p.group; });
      Object.values(PAGES).forEach(function (p) {
        if (p.plugin && selected.indexOf(p.plugin) < 0) return;
        if (p.plugin && groups[p.plugin] === 'coding' && !Layout.state.coding) return;   // the Coding plugin is off: no Architecture or Tests tab
        var a = document.createElement('a'); a.href = '#' + p.id; a.dataset.view = 'page-' + p.id; a.dataset.page = p.id; a.textContent = p.title;
        a.addEventListener('click', function (e) { e.preventDefault(); showView('page-' + p.id); });
        nav.insertBefore(a, nav.querySelector('a[data-view="plugins"]'));   // Plugins stays far right
        var s = document.createElement('section'); s.id = 'view-page-' + p.id; s.className = 'view'; s.dataset.page = p.id; s.innerHTML = '<div class="page"></div>';
        main.appendChild(s);
      });
      if (was && PAGES[was] && main.querySelector('#view-page-' + was)) showView('page-' + was);
      else if (was) showView('room');   // the tab that was showing does not exist on this project: the room, never a blank page
    },
    current: function () { var s = document.querySelector('section[data-page].on'); return s ? PAGES[s.dataset.page] : null; },
    refresh: function () {
      var p = window.Pages.current(); if (!p) return;
      var el = document.querySelector('#view-page-' + p.id + ' .page'); if (!el) return;
      var a = document.activeElement, typing = a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      if (typing) { if (p.renderLive) p.renderLive(el); return; }
      try { p.render(el); } catch (err) { el.innerHTML = '<div class="empty" style="color:var(--red,#e5484d)">' + String(err.message).replace(/</g, '&lt;') + '<div class="small dim">' + String(err.stack || '').split('\n').slice(1, 3).join(' · ').replace(/</g, '&lt;') + '</div></div>'; }
    }
  };

  /* ---------- views (nav) ---------- */
  function showView(v) {
    document.querySelectorAll('.view').forEach(function (s) { s.classList.toggle('on', s.id === 'view-' + v); });
    document.querySelectorAll('.nav a').forEach(function (x) { x.classList.toggle('on', x.dataset.view === v); });
    if (v === 'plugins' && window.renderPluginsPage) window.renderPluginsPage();
    syncNav();
    /* A room laid out while hidden measures zero width and every column lands on the left.
       Measure again the moment it is visible. */
    if (v === 'room') requestAnimationFrame(function () { Layout.place(); });
    if (v.indexOf('page-') === 0) requestAnimationFrame(function () { window.Pages.refresh(); });
  }
  document.querySelectorAll('.nav a').forEach(function (x) { x.addEventListener('click', function (e) { e.preventDefault(); if (x.id === 'navhome') { if (S.id !== HOME) select(HOME, true); showView('room'); } else showView(x.dataset.view); syncNav(); }); });

  /* ---------- ＋ Card: another project's card onto this desk (Home step 2) ---------- */
  function addCardMenu() {
    var m = $('addcard'); if (!m.hidden) { m.hidden = true; return; }
    // every project's card scripts first, so the list is what exists anywhere, not what this desk happens to have loaded
    m.innerHTML = '<div class="small dim">reading the cards of every project…</div>'; m.hidden = false;
    ensureCards(S.projects.filter(function (p) { return p.exists; }).map(function (p) { return p.id; })).catch(function () {}).then(function () { if (!m.hidden) drawAddCard(m); });
  }
  function drawAddCard(m) {
    var types = Object.values(Layout.state.cards).filter(function (c) { return c.multi; }).sort(function (a, b) { return a.title < b.title ? -1 : 1; });
    var projects = S.projects.filter(function (p) { return p.exists && p.id !== S.id; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    /* this desk's own cards that are closed - what its plugins offer and Home's own on Home - come back from here */
    var selected = (((window.ROOM || {}).plugins || {}).available || []).filter(function (p) { return p.selected; }).map(function (p) { return p.name; });
    var closed = Object.values(Layout.state.cards).filter(function (c) { return Layout.isHidden(c.id) && (!c.plugin || S.id === HOME || selected.indexOf(c.plugin) >= 0) && (!c.home || S.id === HOME); }).sort(function (a, b) { return a.title < b.title ? -1 : 1; });
    // cards whose plugin is off here: shown too, greyed - with the way to turn the plugin on
    var offs = S.id === HOME ? [] : Object.values(Layout.state.cards).filter(function (c) { return c.plugin && selected.indexOf(c.plugin) < 0 && !c.home; }).sort(function (a, b) { return a.title < b.title ? -1 : 1; });
    m.innerHTML = '<div class="ac-hd"><b>This desk\'s cards</b><span class="small dim">closed for now - click one to put it back' + (closed.length ? '' : ' (every card this project offers is on the desk or in a drawer)') + '</span></div>'
      + (closed.length ? '<div class="ac-g ac-own">' + closed.map(function (c) { return '<button class="lensbtn" data-own="' + esc(c.id) + '" title="' + esc(c.purpose || '') + '">' + (window.Icons ? '<span class="lens-ico">' + Icons.of(c, 16) + '</span> ' : (c.icon ? c.icon + ' ' : '')) + esc(c.title) + '</button>'; }).join('') + '</div>' : '')
      + (offs.length ? '<div class="ac-g ac-own ac-off">' + offs.map(function (c) { return '<button class="lensbtn dim" data-off="' + esc(c.plugin) + '" title="the ' + esc(c.plugin) + ' plugin is off for this project - click to open its Settings and turn it on">' + (window.Icons ? '<span class="lens-ico">' + Icons.of(c, 16) + '</span> ' : (c.icon ? c.icon + ' ' : '')) + esc(c.title) + ' <span class="small">· needs ' + esc(c.plugin) + '</span></button>'; }).join('') + '</div>' : '')
      + '<div class="ac-hd" style="margin-top:10px"><b>A card from another project</b><span class="small dim">it stays that project\'s - the same card, read from there</span></div>'
      + '<div class="ac-g"><span class="cm-k">card</span>' + types.map(function (c, i) { return '<label><input type="radio" name="ac-type" value="' + esc(c.id) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(c.title) + ' <span class="small dim">' + esc(c.purpose || '') + '</span></label>'; }).join('') + '</div>'
      + '<div class="ac-g"><span class="cm-k">project' + (types.some(function (c) { return c.id === 'tk-attention'; }) ? 's - several make ONE card that shows them all' : '') + '</span>' + (projects.length ? projects.map(function (p) { return '<label><input type="checkbox" name="ac-p" value="' + esc(p.id) + '"> ' + esc(p.name) + '</label>'; }).join('') : '<div class="small dim">no other project is open in Cockpit</div>') + '</div>'
      + '<div class="ac-acts"><button class="btn sm" id="ac-go">Put it on the desk</button> <span class="small dim" id="ac-msg"></span></div>';
    m.hidden = false;
    m.querySelectorAll('[data-own]').forEach(function (bt) { bt.addEventListener('click', function () { Layout.show(bt.dataset.own, true); Layout.front(bt.dataset.own); m.hidden = true; showView('room'); }); });
    m.querySelectorAll('[data-off]').forEach(function (bt) { bt.addEventListener('click', function () { m.hidden = true; showView('plugins'); if (window.openSettings) window.openSettings('plugins'); }); });
    $('ac-go').addEventListener('click', function () {
      var t = (m.querySelector('input[name="ac-type"]:checked') || {}).value, ps = Array.prototype.map.call(m.querySelectorAll('input[name="ac-p"]:checked'), function (i) { return i.value; });
      var msg = function (html) { $('ac-msg').innerHTML = '<span class="ac-why">' + html + '</span>'; };   // the answer, in words a person notices - not a grey aside (2026-09-20)
      if (!t || !ps.length) { msg('pick a card and at least one project'); return; }
      var c = Layout.state.cards[t]; if (ps.length > 1 && t !== 'tk-attention') { msg(esc(c.title) + ' takes one project per card - one at a time'); return; }
      msg('adding…');
      var nameOf = function (pid) { var pr = S.projects.find(function (x) { return x.id === pid; }); return pr ? pr.name : pid; };
      var gotoLinks = function (ids) { return ids.map(function (pid) { return '<a href="#" data-goto="' + esc(pid) + '">' + esc(nameOf(pid)) + ' › Settings</a>'; }).join(', '); };
      var wireGoto = function () { $('ac-msg').querySelectorAll('[data-goto]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); m.hidden = true; select(a.dataset.goto, true); showView('plugins'); if (window.openSettings) window.openSettings('plugins'); }); }); };
      ensureCards(ps).catch(function () {}).then(function () {
        // the card's plugin must be on in THAT project - except a Tickets card, which goes wherever tickets EXIST: the process runs from the
        // conversation with the switch off (three tickets worked in one project with the switch off, and the board refused)
        var off = c.plugin ? ps.filter(function (pid) { var room = Layout.state.rooms[pid]; var pl = room && (((room.plugins || {}).available) || []).find(function (x) { return x.name === c.plugin; }); return !(pl && pl.selected); }) : [];
        var allow = c.plugin === 'tickets' && off.length ? Promise.all(off.map(function (pid) { return api('/api/p/' + pid + '/tickets').then(function (r) { return (r && r.ok && (r.tickets || []).length) ? null : pid; }).catch(function () { return pid; }); })).then(function (xs) { return xs.filter(Boolean); }) : Promise.resolve(off);
        return allow.then(function (stillOff) {
          if (stillOff.length) { msg('the <b>' + esc(c.plugin) + '</b> plugin is off for ' + esc(stillOff.map(nameOf).join(', ')) + (c.plugin === 'tickets' ? ' and it has no tickets yet' : '') + ' - turn it on there first: ' + gotoLinks(stillOff)); wireGoto(); return; }
          // and the CARD must be on in that project (its Plugins and cards switch), not just the plugin - hidden === 1 is the owner's switch; 'plugin' / 'home' are the desk's own reasons
          return Promise.all(ps.map(function (pid) { return api('/api/p/' + pid + '/layout?person=' + encodeURIComponent(Layout.state.person || 'default')).then(function (l) { return { pid: pid, off: !!(l && l.hidden && l.hidden[t] === 1) }; }).catch(function () { return { pid: pid, off: false }; }); })).then(function (rs) {
            var offCards = rs.filter(function (r) { return r.off; }).map(function (r) { return r.pid; });
            if (offCards.length) { msg('<b>' + esc(c.title) + '</b> is switched off in ' + esc(offCards.map(nameOf).join(', ')) + ' - turn the card on there first: ' + gotoLinks(offCards)); wireGoto(); return; }
            return Layout.add(t, ps, { view: true }).then(function () { m.hidden = true; showView('room'); });
          });
        });
      }).catch(function (e) { msg(esc(e.message)); });
    });
  }
  $('addcardbtn').addEventListener('click', function (e) { e.stopPropagation(); if (S.id) addCardMenu(); });
  $('addcard').addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () { $('addcard').hidden = true; });


  /* ---------- chrome ---------- */
  $('reset').addEventListener('click', function () { if (S.id) Layout.reset(); });
  $('savedefault').addEventListener('click', function () { if (!S.id) return; var b = $('savedefault'); Layout.saveDefault().then(function (ok) { b.textContent = ok ? 'Saved' : 'Could not save'; setTimeout(function () { b.textContent = 'Save layout'; }, 1800); }); });
  function known(id) { return !!id && S.projects.some(function (p) { return p.id === id; }); }   // an address naming a project the engine no longer lists goes Home
  window.addEventListener('popstate', function () { var id = idFromUrl(); select(known(id) ? id : (hasHome() ? HOME : null), false); });
  /* The engine's version in the header - and, in the footer, the one thing the page could never tell before: that the engine
     is running older code than is on its disk (a module that is not hot-loaded changed since it started). A restart is the
     owner's hand on the other machine; until then the page shows the old behaviour and nothing says why (2026-09-20). */
  function engineCheck() {
    api('/api/engine').then(function (e) {
      $('engine').textContent = 'engine ' + e.version;
      var f = $('foot'), stale = e.stale || [], mine = f && f.querySelector('#foot-stale');
      if (!f) return;
      if (stale.length) { if (!mine && f.textContent.trim()) return; f.innerHTML = '<span id="foot-stale" style="color:var(--amber,#e0a63a)">the engine is running older code than is on its disk - restart it to load: ' + stale.map(function (x) { return String(x).replace(/</g, '&lt;'); }).join(', ') + '</span>'; }
      else if (mine) f.innerHTML = '';
    }).catch(function () { /* the engine is away; the room's own poll says so */ });
  }
  engineCheck(); setInterval(engineCheck, 60000);

  refreshProjects().then(function () { var id = idFromUrl(); select(known(id) ? id : (hasHome() ? HOME : null), false); }).catch(function () { select(idFromUrl(), false); });
})();
