/* THE SETUP WIZARD AND THE TOUR (owner, 2026-10-08: "We need a wizard and tutorial ... a set of screens, I see you have
   Claude installed, can I connect to it, or I don't see Claude installed, install and let me know once done ... my name
   for the Home screen, then it sets up the home folder and walks through how the screens work, right for someone who
   doesn't know anything, so it has to be idiot proof").

   Shown over everything the first time Cockpit opens (until engine.json "wizardDone"), and again from Settings.
   One screen at a time, plain words, one thing to do on each. A screen that waits on something (an install, a sign-in)
   checks again every few seconds and ticks itself - nobody has to come back and press "check".
   The engine side is engine/wizard.js (GET /api/wizard, POST /api/wizard/*). The tour (Wizard.tour()) points at the real
   parts of the screen one by one. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api(url, opts) { return fetch(url, opts).then(function (r) { return r.json(); }); }
  function post(url, body) { return api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }

  /* ---------- the look: one sheet, injected once ---------- */
  var CSS = ''
    + '.wz-veil{position:fixed;inset:0;z-index:2000;background:rgba(6,8,18,.82);backdrop-filter:blur(3px);display:grid;place-items:center;padding:20px}'
    + '.wz{width:min(640px,100%);max-height:calc(100vh - 40px);overflow:auto;background:var(--panel,#12162b);border:1px solid var(--line2,#282e52);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);padding:28px 32px;color:var(--text,#eceef8);font-family:var(--body,system-ui)}'
    + '.wz h2{margin:0 0 6px;font-size:22px}.wz p{line-height:1.55;margin:10px 0;color:var(--text,#eceef8)}.wz .wz-sub{color:var(--muted,#8b91b5)}'
    + '.wz-steps{display:flex;gap:6px;margin-bottom:18px}.wz-steps i{flex:1;height:4px;border-radius:2px;background:var(--line2,#282e52)}.wz-steps i.on{background:var(--grad,#8b5cf6)}'
    + '.wz-bar{display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:22px}.wz-bar .wz-grow{flex:1}'
    + '.wz-btn{display:inline-block;padding:10px 18px;border-radius:10px;font-weight:600;cursor:pointer;border:1px solid #4f5fb0;background:linear-gradient(135deg,#2b4fa8,#5a3ea8);color:#fff;user-select:none}'
    + '.wz-btn.ghost{background:transparent;border-color:var(--line2,#282e52);color:var(--muted,#8b91b5);font-weight:500}.wz-btn.off{opacity:.45;pointer-events:none}'
    + '.wz-in{font:inherit;font-size:18px;padding:10px 12px;border-radius:10px;border:1px solid var(--line2,#282e52);background:var(--bg2,#0d1020);color:inherit;width:100%;box-sizing:border-box}'
    + '.wz-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line,#1c2140);border-radius:12px;margin:10px 0;background:var(--bg2,#0d1020)}'
    + '.wz-ico{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:700;flex:none}.wz-ico.ok{background:#14532d;color:#86efac}.wz-ico.no{background:#3b2a0a;color:#fbbf24}.wz-ico.run{background:#1e2a5a;color:#93c5fd}'
    + '.wz-row .wz-grow{flex:1}.wz-row b{display:block}.wz-row small{color:var(--muted,#8b91b5)}'
    + '.wz-log{font-family:var(--mono,monospace);font-size:12px;background:#05070f;border-radius:8px;padding:8px 10px;max-height:120px;overflow:auto;color:#9aa3c7;white-space:pre-wrap;margin-top:8px}'
    + '.wz-note{font-size:13px;color:var(--muted,#8b91b5);border-left:3px solid var(--accent,#8b5cf6);padding:6px 10px;margin:12px 0}'
    + '.wz-err{color:#fca5a5;font-size:13px;margin-top:6px}.wz-ok{color:#86efac}'
    + '.wz-check{display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin:12px 0}.wz-check input{width:18px;height:18px;margin-top:3px}'
    + '.wz-spin{display:inline-block;width:14px;height:14px;border:2px solid #93c5fd;border-right-color:transparent;border-radius:50%;animation:wzspin .8s linear infinite;vertical-align:-2px}@keyframes wzspin{to{transform:rotate(360deg)}}'
    /* the tour: a hole cut over the real thing, and a note beside it */
    + '.wt-hole{position:fixed;z-index:2100;border-radius:12px;box-shadow:0 0 0 9999px rgba(6,8,18,.72);outline:2px solid var(--cyan,#22d3ee);transition:all .25s ease;pointer-events:none}'
    + '.wt-tip{position:fixed;z-index:2101;width:min(360px,calc(100vw - 32px));background:var(--panel,#12162b);border:1px solid var(--line2,#282e52);border-radius:14px;padding:16px 18px;color:var(--text,#eceef8);box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:var(--body,system-ui)}'
    + '.wt-tip h3{margin:0 0 6px;font-size:16px}.wt-tip p{margin:0;line-height:1.5;font-size:14px}.wt-tip .wz-bar{margin-top:14px}.wt-n{font-size:12px;color:var(--muted,#8b91b5)}';
  function sheet() { if (document.getElementById('wz-css')) return; var s = document.createElement('style'); s.id = 'wz-css'; s.textContent = CSS; document.head.appendChild(s); }

  /* ---------- the screens ---------- */
  var W = { st: null, i: 0, veil: null, poll: null, msg: {}, name: null };
  var SCREENS = ['welcome', 'name', 'where', 'git', 'claude', 'home', 'folder', 'finish'];

  function load() { return api('/api/wizard').then(function (s) { W.st = s; return s; }); }
  function readName() { return api('/api/p/home/layout?person=me').then(function (m) { W.name = (m && m.name) || ''; }).catch(function () { W.name = ''; }); }

  function row(state, title, sub, action) {
    var ico = state === 'ok' ? '<span class="wz-ico ok">✓</span>' : state === 'run' ? '<span class="wz-ico run"><span class="wz-spin"></span></span>' : '<span class="wz-ico no">!</span>';
    return '<div class="wz-row">' + ico + '<div class="wz-grow"><b>' + title + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>' + (action || '') + '</div>';
  }
  function logOf(job) { return job && job.log && job.log.length ? '<div class="wz-log">' + esc(job.log.slice(-8).join('\n')) + '</div>' : ''; }

  function html() {
    var s = W.st, k = SCREENS[W.i], h = '', next = 'Next', canNext = true, back = W.i > 0, skip = null;
    h += '<div class="wz-steps">' + SCREENS.map(function (_, j) { return '<i class="' + (j <= W.i ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    if (k === 'welcome') {
      h += '<h2>Welcome to Cockpit 👋</h2>'
        + '<p>Cockpit is your desk for working with AI on your projects. You talk to the AI about a folder of work, and Cockpit keeps track of what it does.</p>'
        + '<p class="wz-sub">This setup takes about five minutes. Each screen asks one thing and says exactly what to do. You can\'t break anything.</p>';
      next = 'Let\'s start';
    } else if (k === 'name') {
      h += '<h2>What should Cockpit call you?</h2><p class="wz-sub">It greets you by name on your Home screen. You can change it any time by clicking your name there.</p>'
        + '<input class="wz-in" id="wz-name" maxlength="40" placeholder="Your first name" value="' + esc(W.name || '') + '">';
    } else if (k === 'where') {
      h += '<h2>Where Cockpit lives</h2>'
        + '<p>Cockpit runs quietly in the background on this computer. You open it in your web browser at this address:</p>'
        + '<div class="wz-row"><span class="wz-ico ok">✓</span><div class="wz-grow"><b>' + esc(s.url) + '</b><small>Bookmark it, or start Cockpit from its folder - either way it opens here.</small></div></div>'
        + '<details' + (W.msg.portOpen ? ' open' : '') + ' id="wz-portbox"><summary class="wz-sub" style="cursor:pointer">Change the port (only if another program needs this number)</summary>'
        + '<div style="display:flex;gap:10px;margin-top:10px"><input class="wz-in" id="wz-port" style="width:140px" value="' + esc(s.port) + '" inputmode="numeric"><span class="wz-btn ghost" id="wz-portgo">Use this port</span></div>'
        + '<div class="wz-sub" style="font-size:13px;margin-top:6px">The number after the colon in the address. Cockpit restarts on the new one and this page follows it.</div>'
        + (W.msg.port ? '<div class="' + (W.msg.portOk ? 'wz-ok' : 'wz-err') + '">' + esc(W.msg.port) + '</div>' : '') + '</details>'
        /* on by default: ticked unless the person turned it off (the engine switches it on the first time it runs) */
        + (s.canStartup ? '<label class="wz-check"><input type="checkbox" id="wz-startup"' + (s.startup || !s.startupChosen ? ' checked' : '') + '><span><b>Start Cockpit automatically when I sign in</b><br><span class="wz-sub" style="font-size:13px">Recommended. It runs in the background - no window - and starts itself again if it ever stops, so it is always ready when you open the address above.</span>'
          + (W.msg.startup ? '<br><span class="' + (W.msg.startupOk ? 'wz-ok' : 'wz-err') + '" style="font-size:13px">' + esc(W.msg.startup) + '</span>' : '') + '</span></label>' : '');
    } else if (k === 'git') {
      var g = s.git, gj = g.job;
      h += '<h2>Git</h2><p class="wz-sub">Git keeps the history of every change in a folder, so anything the AI changes can be looked at and undone. Cockpit needs it.</p>';
      if (g.ok) h += row('ok', 'Git is installed', esc(g.version));
      else if (gj && gj.running) h += row('run', 'Installing Git…', 'Windows may ask "Do you want to allow this app to make changes?" - click <b>Yes</b>.') + logOf(gj);
      else h += row('no', 'Git is not installed yet', g.canInstall ? 'Press Install - it takes a minute or two.' : 'Get it from git-scm.com, install it, and this screen ticks itself.', g.canInstall ? '<span class="wz-btn" id="wz-git">Install Git</span>' : '<a class="wz-btn" href="https://git-scm.com/download/win" target="_blank" rel="noopener">git-scm.com</a>') + (gj && gj.ok === false ? '<div class="wz-err">The install did not finish. You can try again.</div>' + logOf(gj) : '');
      canNext = g.ok; skip = !g.ok;
    } else if (k === 'claude') {
      var c = s.claude, cj = c.job;
      h += '<h2>Claude Code</h2><p class="wz-sub">Claude Code is the AI that does the work. Two things: it needs to be installed, and signed in to your Claude account.</p>';
      if (c.ok) h += row('ok', 'Claude Code is installed', 'version ' + esc(c.version));
      else if (cj && cj.running) h += row('run', 'Installing Claude Code…', 'This downloads Anthropic\'s official installer. About a minute.') + logOf(cj);
      else h += row('no', 'Claude Code is not installed yet', 'Press Install. No administrator rights needed.', '<span class="wz-btn" id="wz-claude">Install</span>') + (cj && cj.ok === false ? '<div class="wz-err">The install did not finish. You can try again.</div>' + logOf(cj) : '');
      if (c.ok) {
        if (c.signedIn) h += row('ok', 'Signed in', c.apiKey ? 'using an API key (billed to that key)' : 'Claude is connected to your account');
        else {
          h += row(W.msg.signin ? 'run' : 'no', W.msg.signin ? 'Waiting for you to sign in…' : 'Not signed in yet', W.msg.signin ? 'This ticks itself when you finish.' : 'Press Sign in - a window opens to do it.', '<span class="wz-btn' + (W.msg.signin ? ' ghost' : '') + '" id="wz-signin">' + (W.msg.signin ? 'Open it again' : 'Sign in') + '</span>');
          if (W.msg.signin) h += '<div class="wz-note"><b>In the window that opened:</b><br>1. If it asks you to pick a look (a colour theme), press <b>Enter</b>.<br>2. Pick <b>"Claude account with subscription"</b> and press Enter.<br>3. Your browser opens - sign in to Claude and press <b>Authorize</b>.<br>4. When the window says you are signed in, close it. This screen ticks itself.</div>';
        }
      }
      canNext = c.ok && c.signedIn; skip = !canNext;
    } else if (k === 'home') {
      h += '<h2>Your Home</h2><p>Home is your own desk - the first thing you see when Cockpit opens. It greets you, and holds your conversation with the AI and your notes. Other cards are one switch away in Settings.</p>'
        + (s.home ? row('ok', 'Home is set up', 'in ' + esc(s.home.path)) : row('no', 'Home is missing', 'Restart Cockpit and it makes one.'))
        + '<p class="wz-sub">Nothing to do here - it\'s ready.</p>';
    } else if (k === 'folder') {
      h += '<h2>Connect a folder</h2><p>A <b>project</b> in Cockpit is just a folder on your computer - a website, an app, a set of documents. Connect one and the AI can work in it.</p>'
        + '<p class="wz-sub">Cockpit adds one small hidden folder inside it (<code>.cockpit</code>) to remember things. It never moves or deletes your files.</p>'
        + (s.projects ? row('ok', s.projects === 1 ? 'One folder connected' : s.projects + ' folders connected', 'More any time from the switcher, top left.', '<span class="wz-btn ghost" id="wz-folder">Connect another</span>')
          : row('no', 'No folder connected yet', 'Optional - you can do this later.', '<span class="wz-btn" id="wz-folder">Connect a folder…</span>'));
      next = s.projects ? 'Next' : 'Skip for now';
    } else if (k === 'finish') {
      h += '<h2>You\'re all set' + (W.name ? ', ' + esc(W.name) : '') + ' 🎉</h2>'
        + '<p>One last thing: a quick look around the screen, so you know where everything is. It takes about a minute.</p>'
        + '<p class="wz-sub">You can run this setup and the tour again any time from <b>Settings</b>.</p>';
      next = 'Show me around';
    }
    h += '<div class="wz-bar">' + (back ? '<span class="wz-btn ghost" id="wz-back">Back</span>' : '<span></span>') + '<span class="wz-grow"></span>'
      + (skip ? '<span class="wz-btn ghost" id="wz-skip" title="carry on without it - Cockpit will remind you">Skip for now</span>' : '')
      + (k === 'finish' ? '<span class="wz-btn ghost" id="wz-notour">No thanks</span>' : '')
      + '<span class="wz-btn' + (canNext ? '' : ' off') + '" id="wz-next">' + next + '</span></div>';
    return h;
  }

  function draw() {
    if (!W.veil) return;
    var keepName = document.getElementById('wz-name'), typed = keepName ? keepName.value : null, hadFocus = keepName && document.activeElement === keepName;
    var portIn = document.getElementById('wz-port'), portTyped = portIn ? portIn.value : null;
    var box = W.veil.querySelector('.wz'); box.innerHTML = html();
    var n = document.getElementById('wz-name'); if (n) { if (typed !== null) n.value = typed; if (hadFocus || SCREENS[W.i] === 'name') { n.focus(); } n.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(1); }); }
    var p = document.getElementById('wz-port'); if (p && portTyped !== null && W.msg.portOpen) p.value = portTyped;
    wire();
  }
  function on(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); }
  function wire() {
    on('wz-next', function () { go(1); });
    on('wz-back', function () { go(-1); });
    on('wz-skip', function () { step(1); });
    on('wz-notour', function () { finish(false); });
    on('wz-git', function () { post('/api/wizard/install', { what: 'git' }).then(function (r) { if (!r.ok) alert(r.error); refresh(); }); });
    on('wz-claude', function () { post('/api/wizard/install', { what: 'claude' }).then(function (r) { if (!r.ok) alert(r.error); refresh(); }); });
    on('wz-signin', function () { post('/api/wizard/signin').then(function (r) { if (!r.ok) { alert(r.error); return; } W.msg.signin = true; draw(); }); });
    on('wz-folder', function () {
      var d = document.getElementById('dlg'); if (d) d.style.zIndex = 2500;   // above this screen
      if (window.openFolderDialog) window.openFolderDialog(function () { if (d) d.style.zIndex = ''; refresh(); });
    });
    var pb = document.getElementById('wz-portbox'); if (pb) pb.addEventListener('toggle', function () { W.msg.portOpen = pb.open; });
    on('wz-portgo', function () {
      var v = Number((document.getElementById('wz-port') || {}).value);
      if (v === W.st.port) { W.msg.port = 'That is the port Cockpit is on now.'; W.msg.portOk = true; draw(); return; }
      post('/api/wizard/port', { port: v }).then(function (r) {
        if (!r.ok) { W.msg.port = r.error; W.msg.portOk = false; draw(); return; }
        W.msg.port = 'Moving Cockpit to ' + r.url + ' - this page follows in a few seconds…'; W.msg.portOk = true; draw();
        follow(r.url);
      }).catch(function () { W.msg.port = 'Cockpit is moving…'; draw(); });
    });
    var su = document.getElementById('wz-startup'); if (su) su.addEventListener('change', function () { setStartup(su.checked); });
  }
  /* the engine moved to another port: wait until it answers there, then go there (the wizard carries on at the same step) */
  function follow(url) {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      // the step rides in the address: a new port is a new origin, so the browser's storage does not come along
      fetch(url + '/api/engine', { mode: 'no-cors' }).then(function () { clearInterval(t); location.href = url + '/?wizard=' + W.i; })
        .catch(function () { if (tries > 40) { clearInterval(t); W.msg.port = 'Cockpit did not come back at ' + url + '. Start it again from its folder ("Start Cockpit").'; W.msg.portOk = false; draw(); } });
    }, 1000);
  }
  function setStartup(on) {
    W.msg.startup = on ? 'Setting it up…' : 'Turning it off…'; W.msg.startupOk = true; draw();
    return post('/api/wizard/startup', { on: on }).then(function (r) {
      W.msg.startup = r.ok ? (on ? 'Done - Cockpit starts by itself when you sign in.' + (r.note ? ' (' + r.note + ')' : '') : 'Off - start it with "Start Cockpit" when you want it.') : r.error; W.msg.startupOk = !!r.ok;
      return refresh();
    });
  }
  function step(d) { W.i = Math.max(0, Math.min(SCREENS.length - 1, W.i + d)); W.msg.port = null; W.msg.startup = null; draw(); }
  function go(d) {
    var k = SCREENS[W.i];
    /* leaving "Where Cockpit lives" with the box ticked and nothing set up yet (the engine had not switched it on by itself):
       set it up now - the box is ticked by default */
    if (d > 0 && k === 'where') { var su = document.getElementById('wz-startup'); if (su && su.checked && W.st && !W.st.startup) { setStartup(true).then(function () { step(1); }); return; } }
    if (d > 0 && k === 'name') {
      var v = ((document.getElementById('wz-name') || {}).value || '').trim();
      post('/api/p/home/layout?person=me', { name: v }).then(function () { W.name = v; if (window.__hgName) window.__hgName(v); step(1); });
      return;
    }
    if (d > 0 && k === 'finish') { finish(true); return; }
    step(d);
  }
  function refresh() { return load().then(draw).catch(function () { /* the engine is moving or away; the next poll tries again */ }); }

  function open(at) {
    sheet();
    if (W.veil) return;
    W.veil = document.createElement('div'); W.veil.className = 'wz-veil'; W.veil.innerHTML = '<div class="wz" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(W.veil);
    W.i = at || 0;
    Promise.all([load(), readName()]).then(draw);
    W.poll = setInterval(function () { var k = SCREENS[W.i]; if (k === 'git' || k === 'claude' || k === 'folder' || k === 'where') refresh(); }, 2500);
  }
  function close() { if (W.poll) clearInterval(W.poll); W.poll = null; if (W.veil) W.veil.remove(); W.veil = null; }
  function finish(tour) { post('/api/wizard/done', { done: true }).then(function () { close(); if (tour) setTimeout(startTour, 300); }); }

  /* ---------- the tour ---------- */
  var STEPS = [
    { sel: '#card-home-greeting', title: 'Your greeting', text: 'This is your Home. It greets you by name - click your name to change it. The picture changes with the time of day and the season.' },
    { sel: '.dock-left', title: 'Drawers on the left', text: 'Each icon is a card tucked into a drawer: the <b>Agent fleet</b> (your AI workers), <b>Lane performance</b> (how well they are doing) and <b>Alerts</b> (anything that needs you). Click an icon to slide it open. Click it again - or anywhere else - to close it.' },
    { sel: '.dock-right', title: 'Drawers on the right', text: '<b>Notes</b> - a scratchpad that saves as you type. More cards (your projects, the clock and weather, and others) are one switch away in <b>Settings › Plugins and cards</b>.' },
    { sel: '.dock-top', title: 'The conversation', text: 'This is where you talk to the AI. Open it, type what you want in plain words, and press Send. Every conversation is kept.' },
    { sel: '#swbtn', title: 'Switch projects', text: 'Shows which project you are in. Click it to open another one, or to connect a new folder.' },
    { sel: '#aipick', title: 'Which AI answers', text: 'Claude Code is chosen for you. You only need this if you add other AIs later.' },
    { sel: '#nav', title: 'Home and Settings', text: '<b>Home</b> brings you back here from anywhere. <b>Settings</b> is where you turn extra cards on (like Projects or the clock), run this setup again, or stop Cockpit.' },
    { sel: '#reset', title: 'If the screen gets messy', text: 'You can drag cards around, resize them, or move them in and out of drawers with the small ⚙ on each card. <b>Reset layout</b> puts everything back the way it started.' }
  ];
  var T = { i: 0, hole: null, tip: null };
  function startTour() {
    sheet(); if (T.tip) return;
    T.i = 0;
    T.hole = document.createElement('div'); T.hole.className = 'wt-hole'; document.body.appendChild(T.hole);
    T.tip = document.createElement('div'); T.tip.className = 'wt-tip'; document.body.appendChild(T.tip);
    window.addEventListener('resize', place);
    show();
  }
  function endTour() { closeDrawers(); if (T.hole) T.hole.remove(); if (T.tip) T.tip.remove(); T.hole = T.tip = null; window.removeEventListener('resize', place); }
  function closeDrawers() { var L = window.Layout && Layout.state; if (!L || !L.open) return; var any = false; Object.keys(L.open).forEach(function (s) { if (L.open[s]) { L.open[s] = null; any = true; } }); if (any && Layout.place) Layout.place(false); }
  function target() { var s = STEPS[T.i]; var el = document.querySelector(s.sel); if (!el || !el.getBoundingClientRect().width) return null; return el; }
  function show() {
    // skip what is not on this screen (an empty drawer, a header part a project hides)
    while (T.i < STEPS.length && !target()) T.i++;
    if (T.i >= STEPS.length) { endTour(); return; }
    var s = STEPS[T.i];
    T.tip.innerHTML = '<div class="wt-n">' + (T.i + 1) + ' of ' + STEPS.length + '</div><h3>' + s.title + '</h3><p>' + s.text + '</p>'
      + '<div class="wz-bar"><span class="wz-btn ghost" id="wt-end">End tour</span><span class="wz-grow"></span>' + (T.i > 0 ? '<span class="wz-btn ghost" id="wt-back">Back</span>' : '') + '<span class="wz-btn" id="wt-next">' + (T.i === STEPS.length - 1 ? 'Done' : 'Next') + '</span></div>';
    T.tip.querySelector('#wt-end').onclick = endTour;
    var b = T.tip.querySelector('#wt-back'); if (b) b.onclick = function () { T.i--; while (T.i > 0 && !target()) T.i--; show(); };
    T.tip.querySelector('#wt-next').onclick = function () { T.i++; show(); };
    place();
  }
  function place() {
    if (!T.tip) return;
    var el = target(); if (!el) return;
    var r = el.getBoundingClientRect(), pad = 6, vw = window.innerWidth, vh = window.innerHeight;
    T.hole.style.left = (r.left - pad) + 'px'; T.hole.style.top = (r.top - pad) + 'px'; T.hole.style.width = (r.width + pad * 2) + 'px'; T.hole.style.height = (r.height + pad * 2) + 'px';
    var tw = T.tip.offsetWidth, th = T.tip.offsetHeight, x, y;
    if (r.right + 16 + tw < vw) { x = r.right + 16; y = r.top; }            // beside it, on the right
    else if (r.left - 16 - tw > 0) { x = r.left - 16 - tw; y = r.top; }     // on the left
    else { x = Math.min(Math.max(16, r.left), vw - tw - 16); y = r.bottom + 16; }   // under it
    if (y + th > vh - 16) y = Math.max(16, vh - th - 16);
    T.tip.style.left = x + 'px'; T.tip.style.top = y + 'px';
  }

  window.Wizard = { open: open, tour: startTour };

  /* the first time: open by itself once the page has settled (a step kept across a port move carries on there) */
  setTimeout(function () {
    var at = new URLSearchParams(location.search).get('wizard');
    if (at !== null) history.replaceState({}, '', location.pathname);   // used once
    load().then(function (s) { if (!s.done || at !== null) open(at !== null ? Number(at) || 0 : 0); }).catch(function () { /* engine away */ });
  }, 600);
})();
