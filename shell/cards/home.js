/* Home: Cockpit's front door is a project like any other - any folder named home (C:\projects\home, say), id
   "home" - always there, open when nothing else is picked. Its desk holds other projects' cards (Layout.add) next
   to the cards here, which exist only on Home:
     home-greeting   good morning / afternoon / evening / night, the date, the weather where you are, and a picture
                     for the season and the time of day (shell/img/home/<season>-<part>.jpg; a sky gradient until one
                     is there - the owner supplies the pictures)
     home-projects   every project Cockpit knows: live or quiet, when it was last opened - click to go in
     home-alerts     what went wrong or wants you across every project, from engine/events.js; its count is the badge
                     on the Home link on every page
   The folder name is fixed (home) so a copy of Cockpit sent to someone else needs no path changes; the label on
   the front is theirs to change. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u) { return fetch(u).then(function (r) { return r.json(); }); };
  function ago(iso) { if (!iso) return 'never'; var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }

  /* ---------- the greeting ---------- */
  function partOfDay(h) { return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'; }
  function season(d) { var m = d.getMonth(); return m < 2 || m === 11 ? 'winter' : m < 5 ? 'spring' : m < 8 ? 'summer' : 'autumn'; }   // northern hemisphere, by month
  var QUOTES = [
    'A little progress each day adds up to big results.', 'Do the next right thing.', 'What gets measured gets moved.',
    'Slow is smooth; smooth is fast.', 'Ship the small thing.', 'The best time to plant a tree was twenty years ago. The second best time is now.',
    'You do not rise to the level of your goals; you fall to the level of your systems.'
  ];
  /* THE OWNER'S OWN LINES: a project may supply them through a project extension (engine/ext.js) - the engine setting
     "missionSource" names it as "<project id>/<extension>/<read command>" (engine.json or COCKPIT_MISSION_SOURCE), and the
     command answers { lines: [{ text }] }. The stock QUOTES above are the default when nothing is named. Read once a page,
     again after 6 h.
     RANDOM ON LOAD: one pick per page load, kept until the next load, so refreshes do not flicker. */
  var PICK = Math.random();
  var MISSION = { lines: null, at: 0, loading: false };
  function loadMission() {
    if (MISSION.loading || (MISSION.at && Date.now() - MISSION.at < 6 * 3600e3)) return;
    MISSION.loading = true;
    api('/api/engine').then(function (e) {
      var src = e && e.missionSource; if (!src || !/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(src)) return null;
      var parts = src.split('/');
      return fetch('/api/p/' + parts[0] + '/ext/' + parts[1] + '/' + parts[2]).then(function (r) { return r.json(); }).then(function (j) {
        var l = j && j.ok && j.data && j.data.lines; if (Array.isArray(l) && l.length) MISSION.lines = l.map(function (x) { return x.text; }).filter(Boolean);
      });
    }).catch(function () { /* none: the stock lines stay */ }).then(function () { MISSION.at = Date.now(); MISSION.loading = false; if (MISSION.lines) Layout.refresh(); });
  }
  /* where you are, for the weather. Click the place name on the banner to change it: a city name, looked up with
     open-meteo's geocoder, pick one. Kept on the engine (the Home project's layout store, person "place") so every
     browser agrees, with a copy in this browser. No weather until a place is set. */
  var PLACE = (function () { try { return JSON.parse(localStorage.getItem('cockpit.home.place')) || null; } catch (e) { return null; } })();
  var placeLoaded = false;
  function loadPlace() {
    if (placeLoaded) return; placeLoaded = true;
    api('/api/p/home/layout?person=place').then(function (r) { if (r && r.lat && r.lon) { PLACE = r; try { localStorage.setItem('cockpit.home.place', JSON.stringify(r)); } catch (e) { /* */ } W.at = 0; weather(); } }).catch(function () {});
  }
  function savePlace(pl) {
    PLACE = pl; try { localStorage.setItem('cockpit.home.place', JSON.stringify(pl)); } catch (e) { /* */ }
    fetch('/api/p/home/layout?person=place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pl) }).catch(function () {});
    W.at = 0; W.cur = null; weather(); Layout.refresh();
  }
  /* the picker fills its own list as you type (no card redraw needed while the field has focus); Enter takes the
     first match, a click takes any */
  var PK = { open: false, q: '', hits: [], seq: 0 };
  function hitsHtml() { return PK.hits.length ? PK.hits.map(function (h, i) { return '<div class="hg-hit" data-i="' + i + '">' + esc(h.name) + '</div>'; }).join('') : (PK.q.length > 1 ? '<div class="hg-hit dim">nothing by that name</div>' : '<div class="hg-hit dim">type a city name</div>'); }
  function findPlaces(q, box) {
    var my = ++PK.seq; PK.q = q;
    if (q.length < 2) { PK.hits = []; if (box) box.innerHTML = hitsHtml(); return; }
    if (box) box.innerHTML = '<div class="hg-hit dim">looking…</div>';
    fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=6&language=en&format=json').then(function (r) { return r.json(); })
      .then(function (j) { if (my !== PK.seq) return; PK.hits = (j.results || []).map(function (x) { return { name: x.name + (x.admin1 ? ', ' + x.admin1 : '') + (x.country_code && x.country_code !== 'US' ? ', ' + x.country_code : ''), lat: x.latitude, lon: x.longitude }; }); if (box) { box.innerHTML = hitsHtml(); wireHits(box); } })
      .catch(function (e) { if (my !== PK.seq) return; PK.hits = []; if (box) box.innerHTML = '<div class="hg-hit bad">' + esc(e.message) + '</div>'; });
  }
  function wireHits(box) { box.querySelectorAll('.hg-hit[data-i]').forEach(function (h) { h.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); pick(PK.hits[Number(h.dataset.i)]); }); }); }
  function pick(h) { if (!h) return; PK.open = false; PK.hits = []; PK.q = ''; if (document.activeElement && document.activeElement.classList.contains('hg-q')) document.activeElement.blur(); savePlace(h); }   // blur first: the card does not redraw under a focused field
  var W = { at: 0, cur: null, err: null, loading: false };
  function weather() {
    if (!PLACE || W.loading || Date.now() - W.at < 600000) return;
    W.loading = true;
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + PLACE.lat + '&longitude=' + PLACE.lon + '&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit&timezone=auto')
      .then(function (r) { return r.json(); }).then(function (j) { W.cur = j.current || null; W.err = null; }).catch(function (e) { W.err = e.message; })
      .then(function () { W.at = Date.now(); W.loading = false; Layout.refresh(); });
  }
  var WMO = { 0: ['clear', '☀'], 1: ['mostly clear', '🌤'], 2: ['partly cloudy', '⛅'], 3: ['overcast', '☁'], 45: ['fog', '🌫'], 48: ['fog', '🌫'], 51: ['drizzle', '🌦'], 53: ['drizzle', '🌦'], 55: ['drizzle', '🌧'], 61: ['rain', '🌧'], 63: ['rain', '🌧'], 65: ['heavy rain', '🌧'], 71: ['snow', '🌨'], 73: ['snow', '🌨'], 75: ['heavy snow', '❄'], 80: ['showers', '🌦'], 81: ['showers', '🌧'], 82: ['showers', '⛈'], 95: ['thunderstorm', '⛈'], 96: ['thunderstorm', '⛈'], 99: ['thunderstorm', '⛈'] };
  /* THE PAGE'S PICTURE: Home's whole
     background follows the season and the time of day, as the band's picture did. shell/img/home/bg/ - the first of
     <season>-<part>, <part>, (at night: <season>-evening, evening), default - as .jpg, .png or .webp. Looked up once per
     season-and-part, not on every redraw; app.css paints it through --home-bg. */
  var EXTS = ['png', 'jpg', 'webp'], BG = { key: null };
  function firstPic(names, done) {
    var list = []; names.forEach(function (n) { EXTS.forEach(function (x) { list.push('/img/home/bg/' + n + '.' + x); }); });
    (function next(i) { if (i >= list.length) return done(null); var im = new Image(); im.onload = function () { done(list[i]); }; im.onerror = function () { next(i + 1); }; im.src = list[i]; })(0);
  }
  function background() {
    var d = new Date(), part = partOfDay(d.getHours()), sea = season(d), key = sea + '-' + part;
    if (BG.key === key) return; BG.key = key;
    var names = [key, part].concat(part === 'night' ? [sea + '-evening', 'evening'] : []).concat([sea + '-afternoon', 'default', 'autumn-afternoon']);   // with nothing for the hour: the season's day picture, then the autumn day (the owner's default)
    firstPic(names, function (u) { if (u && BG.key === key) document.documentElement.style.setProperty('--home-bg', 'url(' + u + ')'); });
  }
  background(); setInterval(background, 60000);
  function clockText() { return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  setInterval(function () { document.querySelectorAll('.hc-time').forEach(function (t) { t.textContent = clockText(); }); }, 15000);   // the time moves on its own; no card redraw
  /* who the greeting is for: the name from Settings > Project on Home ("Your name"), kept on Home as person "me";
     with none set, the engine's person key (engine/config.js "person"), capitalised; "default" greets "there" */
  var ME = { name: null, read: false, known: false, editing: false };   // known: the saved name has been read (so "set your name" never flashes before it arrives)
  window.__hgName = function (name) { ME.name = name || null; ME.read = true; ME.known = true; if (window.Layout) Layout.refresh(); };
  function saveName(name) {
    return fetch('/api/p/home/layout?person=me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
      .then(function (r) { return r.json(); }).then(function (res) { if (res && res.ok) window.__hgName(name); return res; });
  }
  function who() {
    if (!ME.read) { ME.read = true; fetch('/api/p/home/layout?person=me').then(function (r) { return r.json(); }).then(function (m) { if (m && m.name) ME.name = m.name; ME.known = true; Layout.refresh(); }).catch(function () { ME.known = true; /* the key */ }); }
    if (ME.name) return ME.name;
    var p = (window.Layout && Layout.state.person) || 'you'; return p === 'default' ? 'there' : p.charAt(0).toUpperCase() + p.slice(1);
  }
  /* THE BAND BROKEN UP: the greeting is one bare card, the date, time and weather another; the picture is
     the page's own now (above). A desk saved with the old full-width band gets both put at the top, once. */
  function unband() {
    var L = Layout.state, g = L.pos && L.pos['home-greeting'];
    if (L.project !== 'home' || !g || g.w < 1100) return;
    var RW = (L.root && L.root.clientWidth) || 1600;
    Object.assign(g, { x: 20, y: 8, w: 640, h: 104, size: 'fixed' }); delete L.locked['home-greeting'];
    L.pos['home-clock'] = Object.assign({ z: ++L.zTop, mode: 'free', rot: 0 }, L.pos['home-clock'] || {}, { x: Math.max(0, RW - 20 - 440), y: 8, w: 440, h: 104, size: 'fixed' });
    setTimeout(function () { Layout.place(); Layout.save(); }, 0);
  }
  Layout.register({ id: 'home-greeting', onByDefault: true, icon: '🌅', title: 'Greeting', home: true, purpose: 'good morning, afternoon or evening, with a thought for the day - on the picture, no panel', zone: 'left', pos: -9, size: [8, 3], min: [3, 2], max: [24, 12],
    render: function (el) {
      unband();
      var d = new Date(), part = partOfDay(d.getHours());
      loadMission();
      var lines = (MISSION.lines && MISSION.lines.length) ? MISSION.lines : QUOTES;   // the owner's own, else the stock few
      /* YOUR NAME, RIGHT HERE (2026-10-08: a fresh install said "Good morning, there" and the only place to change it was
         Settings > Project on Home). The name in the greeting is the link: with none saved it is underlined and says
         "what should I call you?" on hover; clicked, a box takes its place in the line (no extra line - the card is a fixed
         height and its bottom edge is a resize handle). Enter saves, Escape cancels. Settings keeps its field too. */
      var name = who();
      var nameHtml = ME.editing ? '<input type="text" class="hg-name-in" maxlength="40" placeholder="your name" title="Enter saves · Esc cancels" value="' + esc(ME.name || '') + '" style="font:inherit;width:6.5em;background:rgba(0,0,0,.35);color:inherit;border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:0 6px">'
        : '<a href="#" class="hg-name-set" title="' + (ME.name ? 'change your name' : 'what should I call you? click to set your name') + '" style="color:inherit;text-decoration:' + (ME.known && !ME.name ? 'underline dotted' : 'none') + '">' + esc(name) + '</a>';
      var h = '<div class="hh"><h1>Good ' + (part === 'night' ? 'evening' : part) + ', ' + nameHtml + '</h1><div class="hg-quote">“' + esc(lines[Math.floor(PICK * lines.length)]) + '”</div></div>';
      if (el.innerHTML !== h && !(ME.editing && el.querySelector('.hg-name-in'))) {
        el.innerHTML = h;
        el.querySelectorAll('.hg-name-set').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); ME.editing = true; Layout.refresh(); setTimeout(function () { var i = el.querySelector('.hg-name-in'); if (i) { i.focus(); i.select(); } }, 0); }); });
        var inp = el.querySelector('.hg-name-in');
        if (inp) {
          inp.addEventListener('click', function (e) { e.stopPropagation(); });
          inp.addEventListener('keydown', function (e) {
            // blur first: a card with the cursor in it is not redrawn (typing is never interrupted), so the box would stay
            if (e.key === 'Escape') { ME.editing = false; inp.blur(); Layout.refresh(); }
            if (e.key === 'Enter') { e.preventDefault(); var v = inp.value.trim(); ME.editing = false; inp.blur(); saveName(v).catch(function () { Layout.refresh(); }); }
          });
        }
      }
      el.closest('.card').classList.add('card-bare');
    } });
  Layout.register({ id: 'home-clock', icon: '🕒', title: 'Date, time and weather', home: true, purpose: 'today\'s date, the time and the weather where you are (click the place to change it) - on the picture, no panel', zone: 'right', pos: -9, size: [6, 3], min: [3, 2], max: [24, 12],
    render: function (el) {
      var d = new Date();
      loadPlace(); weather();
      var wx = W.cur ? (WMO[W.cur.weather_code] || ['', '']) : null;
      el.innerHTML = '<div class="hc"><div class="hc-when"><div class="hg-date">' + d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + '</div><div class="hc-time">' + clockText() + '</div></div>'
        + '<div class="hg-side">'
        + (!PLACE ? '<div class="hg-wait"><a href="#" class="hg-place" title="where the weather is for">set your place for the weather</a></div>'
          : W.cur ? '<div class="hg-wx"><span class="hg-ico">' + wx[1] + '</span><div><b>' + Math.round(W.cur.temperature_2m) + '°F</b> <span class="dim">' + esc(wx[0]) + '</span><br><a href="#" class="hg-place" title="where the weather is for - click to change">' + esc(PLACE.name) + '</a></div></div>' : '<div class="hg-wait">' + (W.err ? 'no weather: ' + esc(W.err) : 'reading the weather…') + ' · <a href="#" class="hg-place">' + esc(PLACE.name) + '</a></div>')
        + (PK.open ? '<div class="hg-pick"><input type="text" class="hg-q" placeholder="a city - London, Denver, Sydney…" value="' + esc(PK.q) + '"><div class="hg-hits">' + hitsHtml() + '</div><div class="hg-hint">matches appear as you type · Enter takes the first · Esc closes</div></div>' : '')
        + '</div></div>';
      var pl = el.querySelector('.hg-place'); if (pl) pl.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); PK.open = !PK.open; PK.hits = []; PK.q = ''; Layout.refresh(); if (PK.open) setTimeout(function () { var q = el.querySelector('.hg-q'); if (q) q.focus(); }, 0); });
      var q = el.querySelector('.hg-q'), box = el.querySelector('.hg-hits'), tmr = null;
      if (q) {
        q.addEventListener('click', function (e) { e.stopPropagation(); });
        q.addEventListener('input', function () { clearTimeout(tmr); var v = q.value.trim(); tmr = setTimeout(function () { findPlaces(v, box); }, 350); });
        q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (PK.hits.length) pick(PK.hits[0]); else { clearTimeout(tmr); findPlaces(q.value.trim(), box); } } if (e.key === 'Escape') { PK.open = false; Layout.refresh(); } });
        if (box) wireHits(box);
      }
      el.closest('.card').classList.add('card-bare');
    } });

  /* ---------- the projects ---------- */
  var P = { list: null, at: 0, loading: false };
  function loadProjects() {
    if (P.loading || Date.now() - P.at < 30000) return; P.loading = true;
    api('/api/projects').then(function (r) { P.list = (r.projects || []).filter(function (p) { return p.id !== 'home'; }); }).catch(function () {}).then(function () { P.at = Date.now(); P.loading = false; Layout.refresh(); });
  }
  Layout.register({ id: 'home-projects', homeDock: ['right', 1], icon: '🗂', title: 'Projects', home: true, purpose: 'every project Cockpit knows - live or quiet, when you were last in it; click to go in', zone: 'right', pos: -1, size: [7, 10], min: [4, 5], max: [12, 30], grows: true,
    render: function (el) {
      if (!P.list) { loadProjects(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      loadProjects();
      var items = P.list.slice().sort(function (a, b) { return (b.lastOpened || '') < (a.lastOpened || '') ? -1 : 1; });
      /* FIRST RUN (2026-10-08): Home is where a fresh install opens, so the way in is here, not only in the switcher */
      if (!items.length) {
        el.innerHTML = '<div class="hp-empty"><p><b>Connect your first folder.</b></p><p class="small dim">Pick a folder you work in - a code repository or any folder of files. Cockpit adds a <code>.cockpit</code> folder inside it and touches nothing else.</p><p><span class="btn hp-connect">＋ Connect a folder…</span></p><p class="small dim">Later, the switcher (top left) opens more.</p></div>';
        var cb = el.querySelector('.hp-connect'); if (cb) cb.addEventListener('click', function (e) { e.stopPropagation(); if (window.openFolderDialog) window.openFolderDialog(); });
        return;
      }
      el.innerHTML = '<div class="hp">' + items.map(function (p) {
        // a real link: Ctrl/Cmd/Shift+click or a middle click opens the project in a new tab; ↗ does it with a plain click (2026-09-27)
        return '<a class="hp-row" data-id="' + esc(p.id) + '" href="/' + esc(p.id) + '" title="' + esc(p.path) + '"><span class="hp-dot' + (p.loaded ? ' live' : '') + (p.exists ? '' : ' gone') + '"></span><b>' + esc(p.name) + '</b><span class="small dim">' + (!p.exists ? 'folder missing' : p.loaded ? 'live' : 'quiet') + ' · ' + ago(p.lastOpened) + '</span><span class="hp-new" title="open in a new tab">↗</span><span class="hp-go">›</span></a>';
      }).join('') + '</div>';
      el.querySelectorAll('.hp-row').forEach(function (r) { r.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;   // the browser opens it in a new tab
        e.preventDefault();
        window.open('/' + r.dataset.id, '_blank');   // every project opens in its own tab; Home stays
      }); });
      setTimeout(function () { Layout.snug('home-projects'); }, 0);
    } });
  /* ---------- alerts: what went wrong or wants you, across every project (engine/events.js) ---------- */
  /* one alert, in full: what happened, where, when, the whole
     text, and the way to the thing it is about - drawn at the top of the card, like a finding's card on the Tests tab */
  var WHERE = { ticket: 'the Tickets board, with this ticket open', fleet: 'the Tickets board, with this ticket open', tests: 'the Tests tab', dast: 'the Tests tab', promote: 'the Tests tab', backup: 'the Backups card' };
  function alertCard(e, pid, name) {
    var kind = String(e.kind || ''), head = kind.split('.')[0], where = WHERE[head] || 'the project\'s Alerts card';
    var when = new Date(e.at); var stamp = isNaN(when) ? String(e.at) : when.toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return '<div class="fd al-detail"><div class="fd-hd"><b>' + esc(e.title) + '</b> <span class="lg ' + (e.level === 'alert' ? 'bad' : e.level === 'warn' ? 'warn' : 'ok') + '">' + esc(e.level) + '</span><span style="flex:1"></span><span class="tkx" data-al-close title="close">✕</span></div>'
      + '<div class="fd-what">' + (e.text ? esc(e.text) : '<span class="dim">no more detail than the title</span>') + '</div>'
      + '<div class="small dim" style="margin-top:6px"><b>' + esc(name || pid) + '</b> · ' + esc(stamp) + ' · ' + esc(kind) + (e.ref ? ' · about <code>' + esc(e.ref) + '</code>' : '') + (e.source ? ' · from ' + esc(e.source) : '') + '</div>'
      + '<div class="fd-acts" style="margin-top:10px"><span class="btn sm" data-al-go title="' + esc(where) + '">Go to it</span> <span class="small dim">→ ' + esc(where) + '</span>' + (e.url ? ' <a class="btn ghost sm" href="' + esc(e.url) + '" target="_blank">open on GitHub</a>' : '') + (!e.seen ? ' <span class="btn ghost sm" data-al-seen="' + e.id + '" data-al-p="' + esc(pid) + '">seen</span>' : '') + '</div></div>';
  }
  /* NOT_ALERTS - what an alert is NOT.

     So everything the ticket process already shows on its own card is excluded: the tickets, the
     coders working them, their test runs and their promotes. What is left is the estate - a backup
     that did not happen, and whatever else is added later that no ticket owns. Every kind recorded
     today is backup, fleet.*, tests.* or ticket.*, so Alerts is backups plus anything new; that is
     the intent, not an oversight. An empty Alerts card means nothing outside the ticket process
     needs a person, which is the answer he wants at a glance.

     The same component serves the Event log with mode 'log', where nothing is filtered at all. */
  var NOT_ALERTS = 'ticket.,fleet.,tests.,promote.';
  /* one event as a row - the Home card (every project) and the project's own Alerts card draw the same row */
  function alertRow(e, pid) {
    return '<div class="al-row lv-' + esc(e.level) + (e.seen ? ' seen' : '') + '" data-p="' + esc(pid) + '" data-id="' + e.id + '" data-kind="' + esc(e.kind || '') + '" data-ref="' + esc(e.ref || '') + '" data-url="' + esc(e.url || '') + '" title="' + esc(e.kind + ' · ' + e.at) + ' - click for the detail"><span class="al-dot"></span><div class="al-body"><b>' + esc(e.title) + '</b>' + (e.text ? '<span class="muted">' + esc(e.text) + '</span>' : '') + '<span class="small dim">' + ago(e.at) + '</span></div>' + (!e.seen ? '<span class="al-ok" data-seen="' + e.id + '" title="seen - take it off the list">✓</span>' : '') + '</div>';
  }
  var A = { list: null, unseen: null, at: 0, loading: false, err: null, missing: [] };
  /* what the Home card lists and the badge counts - one filter for both, so they can never disagree */
  function alertsNow() {
    var skip = NOT_ALERTS.split(',');
    return (A.list || []).filter(function (e) { return !e.seen && (e.level === 'warn' || e.level === 'alert') && !skip.some(function (k) { return (e.kind || '').indexOf(k) === 0; }); });
  }
  function loadAlerts(force) {
    if (A.loading || (!force && Date.now() - A.at < 30000)) return; A.loading = true;
    api('/api/home/events?limit=80&unseen=1&level=warn&notKind=' + encodeURIComponent(NOT_ALERTS)).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'no answer');
      A.list = r.events || []; A.unseen = r.unseen || null; A.missing = r.missing || []; A.err = null;
    }).catch(function (e) { A.err = /Unexpected token|JSON/.test(e.message) ? 'the engine needs a restart before it can list events' : e.message; if (!A.list) A.list = []; })
      .then(function () { A.at = Date.now(); A.loading = false; Layout.refresh(); badge(); });
  }
  function badge() {
    var nh = document.getElementById('navhome'); if (!nh) return;
    /* the badge counts what the Alerts card lists, nothing more (the badge said 62 while the card was
       empty - it counted every unseen warning, including the coder and ticket events the card leaves to the board) */
    var shown = alertsNow();
    var n = window.Layout && Layout.state.coding ? shown.length : 0, b = nh.querySelector('.badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'badge'; nh.appendChild(b); }
    b.textContent = n >= 80 ? '80+' : String(n); b.classList.toggle('hot', shown.some(function (e) { return e.level === 'alert'; }));
  }
  function markSeen(items) {
    return fetch('/api/home/events/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(items === 'all' ? { all: true } : { items: items }) }).then(function () { A.at = 0; loadAlerts(true); });
  }
  Layout.register({ id: 'home-alerts', coding: true, homeDock: ['left', 2], icon: '🚨', title: 'Alerts', home: true, purpose: 'only what needs you to drop what you are doing - a backup that failed, and anything else outside the ticket process. Tickets, coders and tests are on their own cards; everything that happened is on the Event log.', zone: 'left', pos: -3, size: [5, 10], min: [4, 5], max: [12, 40], grows: true,
    render: function (el) {
      if (!A.list) { loadAlerts(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      loadAlerts();
      /* ONLY WHAT NEEDS YOU NOW (2026-10-31: the card is for "drop what you're doing and look at these" - no "everything"
         lens and no project pick; the Event log is the record). The count is the rows listed, the same filter as the badge -
         the engine's unseen total also counts the coder and ticket kinds this card leaves out, so it disagreed with the list. */
      var shown = alertsNow();
      var h = '<div class="al-top"><span class="small">' + (shown.length ? '<b>' + shown.length + '</b> ' + (shown.length === 1 ? 'needs you' : 'need you') : 'All clear - nothing needs you') + '</span><span style="flex:1"></span>' + (shown.length ? '<a href="#" class="small" data-al="seen-all">all seen</a>' : '') + '</div>';
      if (A.err) h += '<div class="small bad" style="margin:4px 0">' + esc(A.err) + '</div>';
      var det = A.detail && A.list.find(function (e) { return e.project === A.detail.p && e.id === A.detail.id; }); if (det) h += alertCard(det, det.project, det.projectName); else A.detail = null;
      var byP = {}; shown.forEach(function (e) { (byP[e.project] = byP[e.project] || { name: e.projectName, rows: [] }).rows.push(e); });
      Object.keys(byP).forEach(function (pid) {
        var g = byP[pid];
        h += '<div class="al-proj"><b>' + esc(g.name) + '</b><span class="small dim">' + g.rows.length + '</span></div>';
        h += g.rows.map(function (e) { return alertRow(e, pid); }).join('');
      });
      if (A.missing.length) h += '<div class="small dim" style="margin-top:6px">not readable: ' + A.missing.map(esc).join(', ') + '</div>';
      if (!Layout.paint(el, h)) return;   // unchanged: leave the nodes and their listeners in place, no flicker
      // "all seen" marks only the rows listed - the coder and ticket events stay unseen for the Event log
      el.querySelectorAll('[data-al="seen-all"]').forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); markSeen(shown.map(function (x) { return { project: x.project, ids: [x.id] }; })); }); });
      el.querySelectorAll('.al-ok').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); var row = b.closest('.al-row'); markSeen([{ project: row.dataset.p, ids: [Number(b.dataset.seen)] }]); }); });
      el.querySelectorAll('.al-row').forEach(function (r) { r.addEventListener('click', function () { A.detail = { p: r.dataset.p, id: Number(r.dataset.id) }; Layout.refresh(); }); });
      var dc = el.querySelector('[data-al-close]'); if (dc) dc.addEventListener('click', function () { A.detail = null; Layout.refresh(); });
      var dg = el.querySelector('[data-al-go]'); if (dg && det) dg.addEventListener('click', function () { if (window.goTo) window.goTo({ project: det.project, kind: det.kind, ref: det.ref }); });
      var ds = el.querySelector('[data-al-seen]'); if (ds) ds.addEventListener('click', function () { markSeen([{ project: ds.dataset.alP, ids: [Number(ds.dataset.alSeen)] }]); });
      setTimeout(function () { Layout.snug('home-alerts'); }, 0);
    } });
  function Alerts(ctx0, mode) {
    var LOG = mode === 'log';
    var X = ctx0, S = { list: null, unseen: null, at: 0, loading: false, err: null, all: LOG };
    function base() { return (X && X.api) || Layout.state.api; }
    function load(force) {
      if (S.loading || (!force && Date.now() - S.at < 30000)) return; S.loading = true;
      /* 60, not 200: every row carries a relative time ("3 min ago"), so the whole card is rebuilt
         on each poll simply because a minute passed - at 200 rows that was 118 KB of DOM replaced
         every 30 seconds, which is what the owner saw as a flash (2026-09-23). A log is scrolled,
         not read whole; the older ones are in .cockpit/logs. */
      api(base() + '/events?limit=' + (LOG ? 60 : 80) + (S.all ? '' : '&unseen=1&level=warn') + (LOG ? '' : '&notKind=' + encodeURIComponent(NOT_ALERTS))).then(function (r) {
        if (!r.ok) throw new Error(r.error || 'no answer');
        S.list = r.events || []; S.unseen = r.unseen || null; S.err = null;
      }).catch(function (e) { S.err = /Unexpected token|JSON/.test(e.message) ? 'the engine needs a restart before it can list events' : e.message; if (!S.list) S.list = []; })
        .then(function () { S.at = Date.now(); S.loading = false; Layout.refresh(); });
    }
    function markSeen(ids) { return fetch(base() + '/events/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ids === 'all' ? { all: true } : { ids: ids }) }).then(function () { S.at = 0; load(true); A.at = 0; loadAlerts(true); }); }
    function render(el) {
      var r = X.room;
      if (!r || r.missing) { el.innerHTML = '<div class="muted small">no project open</div>'; return; }
      if (S.project !== r.id) { S.project = r.id; S.list = null; S.unseen = null; S.at = 0; S.err = null; }   // another project: start over
      if (!S.list) { load(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      load();
      var n = S.unseen ? (S.unseen.alert + S.unseen.warn) : 0;
      /* Alerts: only what needs you, counted from the rows listed (2026-10-31 - see the Home card). The Event log keeps its lenses. */
      var h = LOG ? '<div class="al-top"><span class="lensbtn' + (S.all ? '' : ' on') + '" data-al="unseen" title="alerts and things waiting on you in this project, not yet seen">needs you' + (n ? ' <b>' + n + '</b>' : '') + '</span><span class="lensbtn' + (S.all ? ' on' : '') + '" data-al="all" title="everything that happened in this project, seen or not">everything</span><span style="flex:1"></span>' + (!S.all && S.list.length ? '<a href="#" class="small" data-al="seen-all">all seen</a>' : '') + '</div>'
        : '<div class="al-top"><span class="small">' + (S.list.length ? '<b>' + S.list.length + '</b> ' + (S.list.length === 1 ? 'needs you' : 'need you') : 'All clear - nothing needs you here') + '</span><span style="flex:1"></span>' + (S.list.length ? '<a href="#" class="small" data-al="seen-all">all seen</a>' : '') + '</div>';
      if (S.err) h += '<div class="small bad" style="margin:4px 0">' + esc(S.err) + '</div>';
      var det = S.detail && S.list.find(function (e) { return e.id === S.detail; }); if (det) h += alertCard(det, X.project, r.name); else S.detail = null;
      if (LOG && !S.list.length && !S.err) h += '<div class="muted small">' + (S.all ? 'nothing has happened here yet' : 'nothing needs you in this project') + '</div>';
      h += S.list.map(function (e) { return alertRow(e, X.project); }).join('');
      if (!Layout.paint(el, h)) return;   // unchanged: the old rows and their handlers stay (it rewrote ~800 elements a minute, 2026-09-29)
      el.querySelectorAll('[data-al]').forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); if (b.dataset.al === 'seen-all') { markSeen(LOG ? 'all' : S.list.map(function (x) { return x.id; })); return; } S.all = b.dataset.al === 'all'; S.at = 0; S.list = null; Layout.refresh(); }); });
      el.querySelectorAll('.al-ok').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); markSeen([Number(b.dataset.seen)]); }); });
      el.querySelectorAll('.al-row').forEach(function (row) { row.addEventListener('click', function () { S.detail = Number(row.dataset.id); Layout.refresh(); }); });
      var dc = el.querySelector('[data-al-close]'); if (dc) dc.addEventListener('click', function () { S.detail = null; Layout.refresh(); });
      var dg = el.querySelector('[data-al-go]'); if (dg && det) dg.addEventListener('click', function () { if (window.goTo) window.goTo({ project: X.project, kind: det.kind, ref: det.ref }); });
      var ds = el.querySelector('[data-al-seen]'); if (ds) ds.addEventListener('click', function () { markSeen([Number(ds.dataset.alSeen)]); });
      setTimeout(function () { Layout.snug(X.key); }, 0);
    }
    return { render: render, use: function (c) { X = c; }, tick: function () { if (S.list) load(); } };
  }
  var AINST = {};
  function alertsInst(ctx, mode) { ctx = ctx || (Layout.ctx ? Layout.ctx(mode === 'log' ? 'events-log' : 'alerts') : null);
    var key = (mode === 'log' ? 'log:' : '') + ctx.key; var I = AINST[key]; if (!I) I = AINST[key] = Alerts(ctx, mode); I.use(ctx); return I; }
  Layout.register({ id: 'alerts', coding: true, notHome: true, icon: '🚨', title: 'Alerts', purpose: 'things outside the ticket process that need a person in this project - a backup that did not happen, and whatever else no ticket owns. Tickets, coders, their tests and their promotes are on the ticket card, not here; everything that happened is on the Event log.', zone: 'left', pos: 0, size: [5, 8], min: [4, 5], max: [12, 40], grows: true, multi: true,
    render: function (el, density, size, ctx) { alertsInst(ctx).render(el); } });
  /* THE EVERYTHING FEED, named for what it is. Same component, nothing filtered out: every
     level, every kind, ticket traffic included. Alerts is what needs you; this is the record. */
  Layout.register({ id: 'events-log', coding: true, notHome: true, icon: '📜', title: 'Event log', purpose: 'everything that happened in this project, newest first - ticket moves, coder turns, tests, backups, pushes. The record, not a to-do list: what needs you is on Alerts.', zone: 'left', pos: 1, size: [5, 10], min: [4, 5], max: [12, 40], grows: true, multi: true,
    render: function (el, density, size, ctx) { alertsInst(ctx, 'log').render(el); } });
  setInterval(function () { Object.keys(AINST).forEach(function (k) { AINST[k].tick(); }); }, 30000);

  // the badge on the Home link, on every page, every half minute - Alerts are a coding card: with the Coding plugin off
  // (shell/layout.js, the gate) there is no badge either
  var alertsOn = function () { return !!(window.Layout && Layout.state.coding); };
  setInterval(function () { if (alertsOn()) loadAlerts(); else badge(); }, 30000); setTimeout(function () { if (alertsOn()) loadAlerts(); }, 3000);

  // the greeting follows the clock: a new minute may be a new part of the day, and the date line moves at midnight
  setInterval(function () { if (window.ROOM && window.ROOM.id === 'home') Layout.refresh(); }, 60000);
})();
