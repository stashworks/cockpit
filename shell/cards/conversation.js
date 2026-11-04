/* The Conversation card - the centre of the room (docs/spirit.md). You talk to the project;
   Cockpit records every turn in this project's .cockpit\ and hands the transcript to
   whichever harness/model you pick, so switching mid-conversation loses nothing (§4).

   Layout inside the card: a thread picker on top (new / existing), the turns, then a
   composer with the harness+model selector. While a turn runs, its events stream in
   below the last message: text as it arrives, tool lines compactly, the cost line at the
   end. A turn that ends having done nothing says so - "produced nothing" is an outcome. */
(function () {
  'use strict';
  /* THE OWNER'S CLOCK, NOT UTC's.
     Every time Cockpit shows comes off an ISO string, which is UTC; sliced raw it reads as tomorrow all evening. */
  function whenLocal(s) { if (!s) return ''; var t = new Date(s); return isNaN(t) ? String(s).slice(0, 16).replace('T', ' ') : t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* A reply reads like the web chat: a small markdown subset. Every piece is escaped before it is marked up, so nothing in a reply becomes live HTML. */
  function inline(t) {
    return String(t).split(/(`[^`\n]+`)/).map(function (p, i) {
      if (i % 2) return '<code>' + esc(p.slice(1, -1)) + '</code>';
      return esc(p)
        .replace(/([a-z)][.!?])(?=[A-Z][a-z])/g, '$1<br><br>')   // older replies glued their pieces together: "done.Next" reads as two paragraphs
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    }).join('');
  }
  function md(s) {
    var lines = String(s == null ? '' : s).replace(/\r/g, '').split('\n'), h = '', para = [], code = null, list = null, rows = null;
    function flush() {
      if (para.length) { h += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; }
      if (list) { h += '<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>'; list = null; }
      if (rows) {
        h += '<div class="md-tw"><table>' + rows.map(function (r, i) { var c = i ? 'td' : 'th'; return '<tr>' + r.map(function (x) { return '<' + c + '>' + inline(x) + '</' + c + '>'; }).join('') + '</tr>'; }).join('') + '</table></div>';
        rows = null;
      }
    }
    lines.forEach(function (ln) {
      if (code !== null) { if (/^\s*```/.test(ln)) { h += '<pre><code>' + esc(code.join('\n')) + '</code></pre>'; code = null; } else code.push(ln); return; }
      if (/^\s*```/.test(ln)) { flush(); code = []; return; }
      var m;
      if (/^\s*\|.*\|\s*$/.test(ln)) {
        if (!rows) flush();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(ln)) return;   // the |---|---| line under the header
        rows = rows || []; rows.push(ln.trim().slice(1, -1).split('|').map(function (x) { return x.trim(); })); return;
      }
      if (rows) flush();
      if (!ln.trim()) { flush(); return; }
      if ((m = /^\s*(#{1,4})\s+(.*)$/.exec(ln))) { flush(); h += '<div class="md-h md-h' + m[1].length + '">' + inline(m[2]) + '</div>'; return; }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) { flush(); h += '<hr>'; return; }
      if ((m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(ln))) {
        var tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        if (para.length || (list && list.tag !== tag && !m[1])) flush();
        list = list || { tag: tag, items: [] };
        list.items.push('<li' + (m[1].length >= 2 ? ' class="md-sub"' : '') + '>' + inline(m[3]) + '</li>'); return;
      }
      if (list && /^\s{2,}\S/.test(ln)) { list.items[list.items.length - 1] = list.items[list.items.length - 1].replace(/<\/li>$/, '<br>' + inline(ln.trim()) + '</li>'); return; }
      if (list) flush();
      if ((m = /^\s*>\s?(.*)$/.exec(ln))) { flush(); h += '<blockquote>' + inline(m[1]) + '</blockquote>'; return; }
      para.push(ln);
    });
    if (code !== null) h += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';   // still streaming: show the open block as it grows
    flush();
    return h;
  }
  function k(n) { return n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
  var post = function (u, b) { return api(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); };

  /* ONE INSTANCE PER DESK CARD (Home step 1, 2026-09-19): a Conversation card is bound to a project through its
     ctx, never through window.ROOM or Layout.state.api, so three of them - three projects - can sit on one desk,
     each with its own threads, its own live stream, its own draft. X is the latest ctx the desk handed us. */
  /* the Getting started checklist's state: one for the page, shared by every conversation card (see setupHtml) */
  var SETUP = { data: null, loading: false };
  function loadSetup() {
    if (SETUP.loading) return; SETUP.loading = true;
    fetch('/api/setup').then(function (r) { return r.json(); }).then(function (s) { SETUP.data = s; SETUP.loading = false; if (window.Layout && Layout.refresh) Layout.refresh(); }).catch(function () { SETUP.loading = false; });
  }
  function setSetupHidden(hidden) {
    return fetch('/api/setup/hidden', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden: hidden }) }).then(function (r) { return r.json(); })
      .then(function () { SETUP.data = null; loadSetup(); }).catch(function () { /* the engine is away */ });
  }
  window.cvSetup = {
    hide: function () { if (SETUP.data) SETUP.data.hidden = true; if (window.Layout && Layout.refresh) Layout.refresh(); return setSetupHidden(true); },
    show: function () { return setSetupHidden(false); },
    recheck: function () { SETUP.data = null; loadSetup(); }
  };

  function Conversation(ctx0) {
  var X = ctx0;
  var C = { project: null, threads: [], thread: null, turn: null, live: [], liveText: '', es: null, draft: '', pics: [] };
  /* PICTURES: paste or drop an image into the box; it shows as a
     thumbnail, and goes to the AI inside the message - the way the desk's pictures reach it. Up to 5; a large one is scaled
     down to 1600 px on its long side first (the AI sees no more than that anyway). */
  var PICS_MAX = 5, PIC_EDGE = 1600;
  function picsHtml() {
    if (!C.pics.length) return '<div id="cv-pics" class="cv-pics" hidden></div>';
    return '<div id="cv-pics" class="cv-pics">' + C.pics.map(function (x, i) { return '<span class="cv-pic"><img src="' + x.url + '" alt="picture ' + (i + 1) + '"><b data-pic-x="' + i + '" title="remove">✕</b></span>'; }).join('') + '<span class="small dim">sent with your next message</span></div>';
  }
  function drawPics(el) {
    var box = el && el.querySelector('#cv-pics'); if (!box) return;
    var tmp = document.createElement('div'); tmp.innerHTML = picsHtml(); var fresh = tmp.firstChild;
    box.replaceWith(fresh);
    fresh.querySelectorAll('[data-pic-x]').forEach(function (x) { x.addEventListener('mousedown', function (e) { e.preventDefault(); C.pics.splice(Number(x.dataset.picX), 1); drawPics(el); }); });
  }
  function addPic(el, file) {
    if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
    if (C.pics.length >= PICS_MAX) { say('up to ' + PICS_MAX + ' pictures a message', true); return; }
    var rd = new FileReader();
    rd.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, PIC_EDGE / Math.max(w, h)), url = rd.result, type = file.type;
        if (k < 1 || file.size > 3.5e6) {
          var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'; url = c.toDataURL(type, 0.9);
          if (url.length > 6.5e6) { type = 'image/jpeg'; url = c.toDataURL(type, 0.8); }
        }
        C.pics.push({ type: type, data: url.slice(url.indexOf(',') + 1), url: url }); drawPics(el);
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  }

  function base() { return X.api; }
  function loadThreads() { return api(base() + '/chat/threads').then(function (r) { C.threads = r.threads || []; }); }
  /* the place this instance lives in - the room's card ('room'), the Architecture tab, the Tests tab - keeps its own
     current thread per project, so each shows what it was last on and runs its own turn */
  function place() { return X.place || 'room'; }
  function memKey() { return 'cockpit.conv.' + X.project + '.' + place(); }
  function remember(id) { try { if (id) localStorage.setItem(memKey(), String(id)); else localStorage.removeItem(memKey()); } catch (e) { /* */ } }
  function remembered() { try { return Number(localStorage.getItem(memKey())) || null; } catch (e) { return null; } }
  function loadThread(id) { remember(id); return api(base() + '/chat/thread?id=' + id).then(function (t) { C.thread = t && !t.error ? t : null; C.jumpToEnd = true; }); }   // the jump to the end is asked for once the thread is here - asked before, a redraw in between spent it on the old one (2026-09-20)
  /* ---------- slash commands ----------
     Typed into the composer, run here, never sent to the model. Each is one of the things the
     owner otherwise does by clicking around or through cli.js; the result shows as a line in
     the log (C.sys), not as a turn. The list is data so the picker and /help read the same thing. */
  var SLASH = [
    { cmd: '/help', args: '', what: 'this list' },
    { cmd: '/new', args: '', what: 'start a new conversation' },
    { cmd: '/use', args: '<harness> [model]', what: 'switch the AI: /use claude opus · /use codex · /use pi qwen3-coder (prefixes are enough)' },
    { cmd: '/model', args: '<model>', what: 'switch the model on the current harness' },
    { cmd: '/note', args: '<text>', what: 'record a standing ruling on this conversation (always in force)' },
    { cmd: '/queue', args: '<next|P1|P2|P3> [#ticket] <title> -- <ask>', what: 'put work on the queue for an agent' },
    { cmd: '/tickets', args: '', what: 'the tickets of this project: drafts waiting for your word first, then the rest by state' },
    { cmd: '/approve', args: '<D-id>', what: 'approve a drafted ticket - it is filed and the AI starts on it here (the same as the Approve & work it button above the box)' },
    { cmd: '/reject', args: '<D-id> [why]', what: 'reject a drafted ticket' },
    { cmd: '/lesson', args: '<text> | review', what: 'a lesson that might generalize - into the doctrine inbox; /lesson review puts the inbox in the box for the review you hold with the AI' },
    { cmd: '/scan', args: '<plugin>', what: 'run a plugin\'s scan now (architecture, github…)' },
    { cmd: '/tests', args: '[run | failures | dast]', what: 'the project\'s tests: /tests run runs them in Cockpit (test database, NODE_ENV=test); /tests shows the last report; /tests failures the failing output' },
    { cmd: '/status', args: '', what: 'this project\'s AI, its login and usage windows, what is running, the standing prompt per turn' },
    { cmd: '/cost', args: '', what: 'what this conversation has cost: tokens, cached, seconds, dollars where known' },
    { cmd: '/stop', args: '', what: 'stop the running turn' },
    { cmd: '/remote', args: 'on [name] | off | status', what: 'Claude Code Remote Control for this project: a session in this folder your phone can drive (claude.ai → Remote Control)' }
  ];
  function when(ms) { if (!ms) return ''; var m = Math.round((ms - Date.now()) / 60000); return m <= 0 ? 'resets now' : m < 90 ? 'resets in ' + m + ' min' : m < 2880 ? 'resets in ' + Math.round(m / 60) + ' h' : 'resets in ' + Math.round(m / 1440) + ' d'; }
  function impLine(i) { if (!i) return ''; return '\n' + (i.ok ? (i.imported ? i.imported + ' remote session' + (i.imported === 1 ? '' : 's') + ' brought into this project\'s conversations (see the dropdown)' : 'no new remote transcript to bring in' + (i.skipped ? ' (' + i.skipped + ' already here)' : '')) : (i.text || 'import did not run')); }
  function status() {
    var r = X.room || {}, hs = window.AI.harnesses || [], cur = hs.find(function (x) { return x.name === window.AI.harness; });
    Promise.all([api('/api/fleet?brief=1'), api('/api/harnesses'), cur ? api('/api/harnesses/probe?name=' + cur.name + '&what=setup') : Promise.resolve(null)]).then(function (rr) {
      var fleet = rr[0] || {}, busy = (rr[1] && rr[1].busy) || [], su = rr[2];
      var L = [];
      L.push('project   ' + (r.name || X.project) + '  (' + X.project + ')');
      L.push('AI        ' + (cur ? cur.label + ' · ' + window.AI.model : 'none chosen') + (su && su.account ? '  ·  ' + (su.account.ok ? (su.account.expired ? 'connected, idle' : 'connected') + ' as ' + su.account.who : 'not logged in: ' + su.account.why) : ''));
      (fleet.agents || []).forEach(function (a) { if (a.usage && a.usage.windows && a.usage.windows.length) L.push('usage     ' + a.harness + ': ' + a.usage.windows.map(function (w) { return w.name + ' ' + (100 - (w.usedPct || 0)) + '% left' + (w.resetsAt ? ' (' + when(w.resetsAt) + ')' : ''); }).join(' · ') + (a.usage.plan ? ' · ' + a.usage.plan : '')); });
      L.push('running   ' + (busy.length ? busy.map(function (b) { return b.harness + ' on ' + b.project + ' since ' + String(b.since).slice(11, 16); }).join(', ') : 'nothing'));
      L.push('agents    ' + ((fleet.agents || []).filter(function (a) { return a.on; }).map(function (a) { return a.id + (a.paused ? ' (paused)' : ''); }).join(', ') || 'all off') + (fleet.pausedAll ? ' · queue paused' : '') + ' · ' + ((fleet.items || []).filter(function (i) { return i.project === X.project && i.status !== 'done'; }).length) + ' queue items here');
      if (r.prompt) L.push('prompt    ' + (r.prompt.tokens >= 1000 ? (r.prompt.tokens / 1000).toFixed(1) + 'k' : r.prompt.tokens) + ' tokens in front of every turn (' + (r.prompt.parts || []).map(function (p) { return p.tier + ' ' + Math.round(p.chars / 1024) + 'KB'; }).join(', ') + ')');
      L.push('thread    ' + (C.thread ? C.thread.turns.length + ' turns · ' + C.thread.notes.length + ' ruling' + (C.thread.notes.length === 1 ? '' : 's') : 'none yet'));
      say(L.join('\n'));
    }).catch(function (e) { say('status: ' + (e.message || e), true); });
  }
  function cost() {
    if (!C.thread) { say('no conversation yet', true); return; }
    var t = { turns: 0, inT: 0, outT: 0, cached: 0, ms: 0, usd: 0, usdKnown: false };
    C.thread.turns.forEach(function (x) { if (!x.cost_json) return; var c = JSON.parse(x.cost_json); t.turns++; t.inT += c.inTokens || 0; t.outT += c.outTokens || 0; t.cached += c.cacheRead || 0; t.ms += c.durationMs || 0; if (typeof c.usd === 'number') { t.usd += c.usd; t.usdKnown = true; } });
    say('this conversation: ' + t.turns + ' AI turn' + (t.turns === 1 ? '' : 's') + ' · ' + k(t.inT) + ' in (' + k(t.cached) + ' cached) / ' + k(t.outT) + ' out · ' + Math.round(t.ms / 1000) + ' s'
      + (t.usdKnown ? ' · $' + t.usd.toFixed(2) + ' at API rates (a plan login pays nothing per token; the usage windows are the real cost)' : ' · no dollar figure - on a plan, the usage windows are the cost'));
  }
  /* where the reader is in the log: at the bottom (follow new text), or a distance from the bottom to restore after a
     re-render. A thread change or a message the reader just sent always goes to the bottom. */
  function readerPlace(log) {
    if (!log || C.jumpToEnd) { C.jumpToEnd = false; return { bottom: true }; }
    /* a log with no height (its card hidden, a drawer closed) has no place to keep; one that asked for its end and has not been
       scrolled away from since is still at its end, whatever a redraw between the ask and the frame measured (2026-09-20) */
    if (log.clientHeight === 0 || log.dataset.wantEnd === '1') return { bottom: true };
    var fromBottom = log.scrollHeight - log.clientHeight - log.scrollTop;
    return fromBottom < 40 ? { bottom: true } : { bottom: false, fromBottom: fromBottom };
  }
  function putReader(log, place) {
    if (!log) return;
    log.scrollTop = !place || place.bottom ? log.scrollHeight : Math.max(0, log.scrollHeight - log.clientHeight - place.fromBottom);
    if (!place || place.bottom) { requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; }); log.dataset.wantEnd = '1'; } else delete log.dataset.wantEnd;   // again once the layout has settled; and again when the card is SHOWN - a drawer's card is drawn hidden, at no height, and opened later (2026-09-20)
  }
  /* Drafts waiting for the owner - shown above the box, because the conversation is where the owner is and the
     Tickets card is below the fold. Fetched once per project version. */
  function draftsHtml() {
    var r = X.room; if (!r || r.missing) return '';
    if (C.draftsVersion !== r.version) { C.draftsVersion = r.version; api(base() + '/tickets').then(function (x) { C.drafts = x.ok ? x.tickets.filter(function (t) { return t.state === 'draft'; }) : []; var el = C.el && C.el.querySelector('#cv-drafts'); if (el) { el.outerHTML = draftsHtml(); wireDrafts(); } }).catch(function () {}); }
    var ds = C.drafts || [];
    if (!ds.length) return '<div id="cv-drafts" hidden></div>';
    return '<div id="cv-drafts" class="cv-drafts"><b>' + ds.length + ' ticket' + (ds.length === 1 ? '' : 's') + ' waiting for your word</b>' + ds.map(function (t) {
      return '<div class="cv-draft"><span class="cv-draft-id">' + esc(t.id) + '</span> <span class="cv-draft-t" title="' + esc(t.title) + '">' + esc(t.title) + '</span> <span class="btn" data-approve="' + esc(t.id) + '" data-mode="queue" title="files the ticket and puts it on the fleet queue - an agent that is on works it while you go on to the next thing">Approve &amp; queue</span> <span class="btn ghost" data-approve="' + esc(t.id) + '" data-mode="now" title="files the ticket and the AI starts on it here, now">now</span> <span class="btn ghost" data-reject="' + esc(t.id) + '">Reject</span> <a href="#" class="cv-draft-more" data-open-ticket="' + esc(t.id) + '" title="the full draft on the Tickets card">details</a></div>';
    }).join('') + '</div>';
  }
  /* THIS card's strip - the id repeats per place (the room's card, the Tests tab's), so it is found inside the card, never page-wide
     (2026-09-20: the docked strip's Approve did nothing - the first strip on the page, the room's hidden one, got the wiring) */
  function wireDrafts() {
    var el = C.el && C.el.querySelector('#cv-drafts'); if (!el) return;
    el.querySelectorAll('[data-approve]').forEach(function (b) { b.addEventListener('click', function () { decide(b.dataset.approve, true, '', b.dataset.mode || 'queue'); }); });
    el.querySelectorAll('[data-reject]').forEach(function (b) { b.addEventListener('click', function () { var why = prompt('why? (optional)') || ''; decide(b.dataset.reject, false, why); }); });
    el.querySelectorAll('[data-open-ticket]').forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); if (window.Layout && Layout.isHidden && Layout.isHidden('tickets')) Layout.show('tickets', true); if (window.__tickets && window.__tickets.open) window.__tickets.open(b.dataset.openTicket); setTimeout(function () { var c = document.getElementById('card-tickets'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 400); }); });
  }
  /* the owner's decision on a draft, straight to the engine. Approve is the gate (a click, never words); the work
     starts in the same click: the filed ticket is handed to the AI in this conversation ("Work it now"). */
  function decide(id, yes, why, mode) {
    mode = mode || 'queue';
    post(base() + '/tickets/' + encodeURIComponent(id) + (yes ? '/approve' : '/reject'), yes ? { mode: mode === 'queue' ? 'queue' : 'shell-now' } : { why: why || null }).then(function (r) {
      if (r.ok === false) return say(r.error, true);
      C.drafts = null; C.draftsVersion = null;
      if (!yes) { say(id + ' rejected.'); if (window.Layout) Layout.refresh(); return; }
      var ref = r.ticket && r.ticket.number ? '#' + r.ticket.number : (r.ticket && r.ticket.id) || id;
      if (mode === 'queue') { say(id + ' approved - ' + (r.note || 'filed as ' + ref) + '.' + (r.agentsOn ? '' : ' (Settings › AI: turn an agent on and it starts.)')); if (window.Layout) Layout.refresh(); return; }
      say(id + ' approved' + (r.ticket && r.ticket.number ? ' and filed as #' + r.ticket.number : ' as ' + ref) + ' - "' + (r.ticket && r.ticket.title || '') + '".' + (C.turn ? ' The AI is mid-turn; tell it to work ' + ref + ' when this turn ends.' : ' Handing it to the AI now.'));
      if (window.Layout) Layout.refresh();
      if (!C.turn) send('Work ' + ref + ' now - it is approved. Do the work the ticket declares, nothing outside it, and end with a short status in plain words.');
    }).catch(function (e) { say(String(e.message || e), true); });
  }
  function say(text, err) { C.sys.push({ text: text, err: !!err, at: new Date() }); Layout.refresh(); }
  function pick(list, key, q) { q = String(q || '').toLowerCase(); return list.find(function (x) { return String(x[key]).toLowerCase() === q; }) || list.find(function (x) { return String(x[key]).toLowerCase().indexOf(q) === 0; }) || list.find(function (x) { return String(x[key]).toLowerCase().indexOf(q) >= 0; }); }
  /* PROJECT COMMANDS. A /name that is not one of Cockpit's own is looked up in the project's
     .claude/commands/<name>.md - the folder Claude Code itself reads, committed with the project's code, so the command travels
     with the project to any machine and any Claude session there knows it too. Cockpit sends the file's instructions to
     whichever AI this conversation uses (any harness), with the words after the command in place of $ARGUMENTS. */
  function projectCommand(name, args) {
    var file = '.claude/commands/' + name + '.md';
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) { say('unknown command /' + name + ' - /help lists them', true); return; }
    api(base() + '/file?path=' + encodeURIComponent(file)).then(function (r) {
      if (!r || !r.ok || !r.text) { say('unknown command /' + name + ' - /help lists Cockpit\'s; a project command is a file at ' + file, true); return; }
      var body = String(r.text).replace(/^---[\s\S]*?\n---\s*/, '').replace(/\$ARGUMENTS/g, args || '');
      send('The owner ran the project command /' + name + (args ? ' ' + args : '') + ' (' + file + '). Carry it out exactly as written:\n\n' + body);
    });
  }
  function slash(line) {
    var m = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim()); if (!m) return false;
    var cmd = '/' + m[1].toLowerCase(), rest = m[2].trim();
    var def = SLASH.find(function (d) { return d.cmd === cmd; });
    if (!def) { projectCommand(m[1].toLowerCase(), rest); return true; }
    C.draft = '';
    switch (cmd) {
      case '/help': say(SLASH.map(function (d) { return d.cmd + (d.args ? ' ' + d.args : '') + '  —  ' + d.what; }).join('\n')); break;
      case '/new': C.thread = null; C.live = []; remember(null); say('new conversation - the next message starts it'); break;
      case '/stop': if (C.turn) { stop(); say('stopping'); } else say('nothing is running'); break;
      case '/status': status(); break;
      case '/remote': {
        var ra = rest.split(/\s+/)[0] || 'status', rn = rest.replace(/^\S+\s*/, '').trim();
        if (['on', 'off', 'status'].indexOf(ra) < 0) { say('/remote on [name] | off | status', true); break; }
        say('remote ' + ra + '…');
        post(base() + '/remote', { action: ra, name: rn || undefined }).then(function (r) {
          if (ra === 'on') say(r.ok ? 'Remote Control on: "' + r.remote.name + '" · id ' + r.id + '\nopen claude.ai (or the Claude app) → Remote Control → pick it. /remote off ends it; import-claude brings the transcript here afterwards.' + (r.text ? '\n— claude said —\n' + r.text : '') : (r.error || 'did not start') + (r.text ? '\n— claude said —\n' + r.text : ''), !r.ok);
          else if (ra === 'off') { say(r.ok ? 'Remote Control off' + (r.was ? ' (' + r.was.name + ')' : '') + impLine(r.imported) + (r.text ? '\n— claude said —\n' + r.text : '') : r.error, !r.ok); loadThreads().then(function () { Layout.refresh(); }); }
          else { say((r.remote ? 'on: "' + r.remote.name + '" · id ' + r.remote.id + ' · since ' + whenLocal(r.remote.started) : 'off') + impLine(r.imported) + (r.agents ? '\n— claude agents —\n' + r.agents : '')); if (r.imported && r.imported.imported) loadThreads().then(function () { Layout.refresh(); }); }
        }); break;
      }
      case '/cost': cost(); break;
      case '/use': case '/model': {
        var parts = rest.split(/\s+/).filter(Boolean), hs = window.AI.harnesses || [], h, model;
        if (cmd === '/model') { h = hs.find(function (x) { return x.name === window.AI.harness; }); model = parts[0]; }
        else { if (!parts[0]) { say(hs.map(function (x) { return x.label + (x.ok ? ': ' + x.models.map(function (mm) { return mm.id; }).join(', ') : ' - ' + x.why); }).join('\n')); break; } h = pick(hs, 'name', parts[0]) || pick(hs, 'label', parts[0]); model = parts[1]; }
        if (!h) { say('no harness matches "' + parts[0] + '" - ' + hs.map(function (x) { return x.name; }).join(', '), true); break; }
        if (!h.ok) { say(h.label + ' is not available: ' + h.why, true); break; }
        var mm = model ? pick(h.models, 'id', model) : (h.name === window.AI.harness ? h.models.find(function (x) { return x.id === window.AI.model; }) : null) || h.models[0];
        if (model && !mm) { say(h.label + ' has no model like "' + model + '": ' + h.models.map(function (x) { return x.id; }).join(', '), true); break; }
        window.setAI(h.name, mm.id); say('now ' + h.label + ' · ' + mm.id); break;
      }
      case '/note': if (!rest) { say('/note <text>', true); break; } if (!C.thread) { say('no conversation yet - a ruling belongs to one; say something first', true); break; }
        post(base() + '/chat/note', { thread: C.thread.id, text: rest }).then(function (r) { if (r.ok === false) return say(r.error, true); loadThread(C.thread.id).then(function () { say('ruling recorded'); }); }); break;
      case '/lesson': if (!rest) { say('/lesson <text> | /lesson review', true); break; }
        if (rest === 'review') { fetch('/api/doctrine/inbox').then(function (r) { return r.json(); }).then(function (r) { if (!r.ok) return say(r.error, true); if (!r.notes.length) return say('the doctrine inbox is empty - nothing to review'); var ta = document.querySelector('#cv-in'); if (!ta) return; ta.value = 'Doctrine review - ' + r.notes.length + ' lesson' + (r.notes.length === 1 ? '' : 's') + ' in the inbox. For each: does it generalise beyond the project it came from, is it already covered by a rule in doctrine.md, and if it earns a rule, draft the rule in the doctrine\'s form (name, the rule, why, a Check line). I decide and edit doctrine.md myself; you never write it.\n\n' + r.notes.map(function (n) { return '--- ' + n.file + ' ---\n' + n.text; }).join('\n\n'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); }); break; }
        post(base() + '/lesson', { text: rest }).then(function (r) { say(r.ok ? 'in the doctrine inbox as ' + r.file + ' (' + r.inbox + ' waiting for review)' : r.error, !r.ok); }); break;
      case '/tickets': api(base() + '/tickets').then(function (r) { if (!r.ok) return say(r.error, true); if (!r.tickets.length) return say('no tickets yet'); var ds = r.tickets.filter(function (t) { return t.state === 'draft'; }), rs = r.tickets.filter(function (t) { return t.state !== 'draft'; }); say((ds.length ? 'waiting for your word:\n' + ds.map(function (t) { return '  ' + t.id + '  ' + t.title + '   (/approve ' + t.id + ' · /reject ' + t.id + ')'; }).join('\n') + (rs.length ? '\n' : '') : '') + rs.map(function (t) { return '  ' + (t.number ? '#' + t.number : t.id) + '  ' + t.state + '  ' + t.title; }).join('\n')); }); break;
      case '/approve': case '/reject': {
        var tid = (rest.split(/\s+/)[0] || '').toUpperCase(), why = rest.slice(tid.length).trim();
        if (!/^D\d+$/.test(tid)) { say(cmd + ' <D-id>  - the drafts are listed by /tickets', true); break; }
        if (cmd === '/approve') { decide(tid, true, '', /\bnow\b/i.test(why) ? 'now' : 'queue'); break; }   // /approve D2 = queue; /approve D2 now = here
        decide(tid, false, why); break;
      }
      case '/queue': {
        var dd = rest.indexOf(' -- '), head = (dd > 0 ? rest.slice(0, dd) : rest).trim().split(/\s+/), pr = head[0], tkn = /^#?(L\d+|\d+)$/.test(head[1] || '') ? head[1].replace(/^#/, '') : null, title = head.slice(tkn ? 2 : 1).join(' '), ask = dd > 0 ? rest.slice(dd + 4).trim() : '';
        if (!/^(next|P1|P2|P3)$/.test(pr || '') || !title) { say('/queue <next|P1|P2|P3> [#ticket] <title> -- <the ask>', true); break; }
        post('/api/fleet/items', { project: X.project, title: title, text: ask || title, priority: pr, source: 'conversation', ticket: tkn }).then(function (r) { say(r.ok === false ? r.error : 'queued ' + pr + ': ' + title + (r.id ? ' (#' + r.id + ')' : ''), r.ok === false); }); break;
      }
      case '/tests': {
        if (rest === 'dast') post(base() + '/tests/dast', {}).then(function (r) { say(r.ok ? 'DAST started - ZAP spiders and actively scans the app on the test database; minutes, not seconds. The Problems tab (DAST stage) shows the alerts when it lands.' : r.error, !r.ok); });
        else if (rest === 'run') post(base() + '/tests/run', {}).then(function (r) { say(r.ok ? 'tests started: ' + r.files + ' file' + (r.files === 1 ? '' : 's') + (r.command ? ' via ' + r.command : ', each with node --test') + (r.env && r.env.db ? ' · ' + r.env.db : '') + ' - the map rescans when the report lands' : r.error, !r.ok); });
        else if (rest === 'failures') api(base() + '/tests/failures').then(function (r) { say((r.failures || []).length ? r.failures.map(function (f) { return '✗ ' + f.file + '\n' + (f.tail || '').split('\n').slice(-12).join('\n'); }).join('\n\n') : 'no failing tests in the last run'); });
        else api(base() + '/tests').then(function (r) { var l = r.latest; say(l ? 'last run ' + whenLocal(l.at) + ' · ' + l.summary.passed + ' passed, ' + l.summary.failed + ' failed, ' + l.summary.skipped + ' skipped · ' + Math.round(l.ms / 1000) + ' s' + (l.env && l.env.db ? ' · ' + l.env.db : '') + (l.setup ? ' · setup ' + (l.setup.ok ? 'ok' : 'FAILED') : '') + '\n' + l.files.map(function (f) { return (f.skipped ? '–' : f.ok ? '✓' : '✗') + ' ' + f.file; }).join('\n') : 'no run yet - /tests run (' + r.testFiles + ' test file' + (r.testFiles === 1 ? '' : 's') + ' found' + (r.command ? ', command: ' + r.command : '') + ')' + (r.running ? ' · a run is going now' : '')); });
        break;
      }
      case '/scan': if (!rest) { say('/scan <plugin>', true); break; }
        post(base() + '/plugins/' + encodeURIComponent(rest) + '/scan').then(function (r) { say(r.ok ? rest + ' scan started - the Architecture tab / cards update when it lands' : r.error, !r.ok); }); break;
    }
    return true;
  }
  function send(text) {
    C.jumpToEnd = true;
    if (!text.trim() && !C.pics.length) return;
    if (text.trim()[0] === '/') { slash(text); return; }
    if (C.turn) { say('a turn is running - wait for it, or /stop', true); return; }   // the composer stays open for commands
    var blocked = window.harnessBlocked && window.AI && window.harnessBlocked(window.AI.harness);
    if (blocked) { C.live = [{ type: 'error', text: blocked }]; Layout.refresh(); return; }
    var screen = window.Screen && window.Screen.context ? window.Screen.context : null;   // what the owner is looking at rides with the message
    post(base() + '/chat/send', { thread: C.thread ? C.thread.id : null, text: text, harness: window.AI && window.AI.harness, model: window.AI && window.AI.model, agent: (window.AI && window.AI.agent) || '', context: screen ? screen.text : null, images: C.pics.map(function (x) { return { type: x.type, data: x.data }; }) }).then(function (r) {
      if (!r.ok) { C.live.push({ type: 'error', text: r.error }); Layout.refresh(); return; }
      C.turn = r.turn; C.live = []; C.liveText = ''; C.draft = ''; C.pics = [];
      // sending ends the typing: drop the focus so the full redraw (composer disabled, cleared) is not deferred
      if (document.activeElement && document.activeElement.id === 'cv-in') document.activeElement.blur();   // (the id repeats per place; this only drops the focus)
      loadThreads().then(function () { return loadThread(r.thread); }).then(function () { Layout.refresh(); listen(r.turn); });
    });
  }
  /* the thread just loaded has a turn running on it: follow that turn live (2026-09-20: after a refresh the Tests tab's conversation
     showed the newest thread but did not listen to the turn running on it - "not updating") */
  function follow() {
    if (!C.thread || C.turn) return;
    api(base() + '/chat/running').then(function (r) { var run = ((r && r.running) || []).find(function (x) { return x && x.thread === C.thread.id; }); if (run && !C.turn) { C.turn = run.turn; C.live = []; C.liveText = ''; listen(run.turn); Layout.refresh(); } }).catch(function () {});
  }
  function listen(turn) {
    if (C.es) C.es.close();
    C.live = []; C.liveText = '';   // the engine replays the turn so far on every connection - a second listen must not double it
    var es = new EventSource(base() + '/chat/events?turn=' + turn);
    C.es = es;
    es.onmessage = function (m) {
      var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.type === 'text') C.liveText += ev.text; else C.live.push(ev);
      /* A LONG TURN MUST NOT TAKE THE PAGE DOWN (2026-09-26: opening a coder's 45-minute turn replayed 963 events and redrew the
         card for each one - the browser ran out of memory). Only the latest events are kept for the live view, and a burst of
         events is drawn once, not once per event. */
      if (C.live.length > 300) C.live = C.live.slice(-300);
      if (C.liveText.length > 60000) C.liveText = C.liveText.slice(-60000);
      if (ev.type === 'end') { es.close(); C.es = null; C.turn = null; loadThread(C.thread.id).then(function () { loadThreads(); Layout.refresh(); }); return; }
      if (!C.redraw) C.redraw = setTimeout(function () { C.redraw = null; Layout.refresh(); }, 150);
    };
    es.onerror = function () {
      /* the stream dropped before 'end' (an engine restart, a network blip): ask whether the turn is still running - if not, it is
         over, read the thread; if it is, listen again (2026-09-20: a card on Home spun on a turn that had long ended) */
      es.close(); if (C.es !== es) return; C.es = null;
      setTimeout(function () {
        if (C.turn !== turn) return;
        api(base() + '/chat/running').then(function (r) {
          var still = ((r && r.running) || []).some(function (x) { x = x || {}; return x.turn === turn; });
          if (still) { listen(turn); return; }
          C.turn = null; C.live = []; C.liveText = ''; if (C.thread) loadThread(C.thread.id).then(function () { loadThreads(); Layout.refresh(); }); else Layout.refresh();
        }).catch(function () { setTimeout(function () { if (C.turn === turn) listen(turn); }, 5000); });
      }, 1500);
    };
  }
  function stop() { if (C.turn) post(base() + '/chat/stop', { turn: C.turn }); }
  /* Other cards hand work to the conversation (a plugin just set up, a file to look at). */
  C.sys = C.sys || [];
  function sendTo(text, o) { if (o && o.newThread) { C.thread = null; C.live = []; } send(text); }
  /* the engine started a turn on its own (the tests setup, engine/setup.js): show that conversation here and follow the turn live */
  function attach(thread, turn) { if (!thread) return; if (C.es) { C.es.close(); C.es = null; } C.turn = null; C.live = []; C.liveText = ''; loadThread(Number(thread)).then(function () { loadThreads(); if (turn) { C.turn = Number(turn); listen(C.turn); } Layout.refresh(); }); }

  function toolLine(ev) {
    if (ev.name) return '<div class="cv-tool">⚙ <b>' + esc(ev.name) + '</b> <span class="dim">' + esc(ev.input || '') + '</span></div>';
    if (ev.ok === false) return '<div class="cv-tool err">✕ tool failed <span class="dim">' + esc((ev.output || '').slice(0, 160)) + '</span></div>';
    return '';
  }

  /* The message log on its own, so it can be refreshed while the composer keeps the focus. */
  /* the project's own commands (.claude/commands/*.md) in the / list too, with their descriptions - read once per project */
  function loadProjCmds(project) {
    C.projCmds = []; C.projCmdsFor = project;
    api(base() + '/files?path=' + encodeURIComponent('.claude/commands')).then(function (r) {
      if (C.projCmdsFor !== project || !r || !r.ok) return;
      (r.entries || []).filter(function (e) { return !e.dir && /^[a-z0-9][a-z0-9_-]*\.md$/i.test(e.name); }).forEach(function (e) {
        var name = e.name.replace(/\.md$/i, '').toLowerCase();
        api(base() + '/file?path=' + encodeURIComponent('.claude/commands/' + e.name)).then(function (f) {
          if (C.projCmdsFor !== project) return;
          var m = /^---[\s\S]*?\bdescription:\s*(.+)[\s\S]*?---/.exec((f && f.text) || '');
          if (!SLASH.some(function (x) { return x.cmd === '/' + name; })) C.projCmds.push({ cmd: '/' + name, args: '', what: (m ? m[1].trim() : 'a command of this project') + ' (this project)' });
        });
      });
    });
  }
  function pickerOpts() {
    var d = C.draft || ''; if (!/^\/\S*$/.test(d)) return [];   // a slash and no argument yet
    if (C.projCmdsFor !== C.project) loadProjCmds(C.project);
    var q = d.trim().toLowerCase(); return SLASH.concat(C.projCmds || []).filter(function (x) { return x.cmd.indexOf(q) === 0; });
  }
  function pickerHtml() {
    var opts = pickerOpts(); if (!opts.length) return '<div class="cv-pick" hidden></div>';
    return '<div class="cv-pick">' + opts.map(function (o, i) { return '<div class="cv-pick-i' + (i === (C.pickAt || 0) ? ' on' : '') + '" data-i="' + i + '"><b>' + esc(o.cmd) + '</b> <span class="dim">' + esc(o.args) + '</span><span class="cv-pick-w">' + esc(o.what) + '</span></div>'; }).join('') + '</div>';
  }
  function drawPicker(el) {
    var old = el.querySelector('.cv-pick'); if (!old) return;
    var tmp = document.createElement('div'); tmp.innerHTML = pickerHtml(); var nw = tmp.firstChild; old.replaceWith(nw);
    nw.querySelectorAll('.cv-pick-i').forEach(function (it) { it.addEventListener('mousedown', function (e) { e.preventDefault(); var ta = el.querySelector('#cv-in'); ta.value = C.draft = pickerOpts()[Number(it.dataset.i)].cmd + ' '; ta.focus(); drawPicker(el); }); });
  }
  /* GETTING STARTED - the checklist a new machine needs, in order, checked live (GET /api/setup).
     It is about THIS MACHINE, so it belongs to one place: Home's own conversation (or the screen with no project open), on an
     empty conversation. Never in another project's conversation, never in the Architecture/Tests tabs' conversations
     (2026-10-25: it followed every new conversation into every project). Once everything required is there, or the person
     says "Don't show this again", the engine remembers it (engine.json "setupHidden" - for every browser, every project)
     and it does not come back anywhere; Settings > Engine can bring it back. */
  function setupPlace() { return (!X.project || X.project === 'home') && place() === 'room'; }
  function setupHtml() {
    if (!setupPlace()) return '';
    var s = SETUP.data;
    if (!s) { loadSetup(); return ''; }
    if (s.hidden) return '';
    var line = function (r, n) {
      return '<div style="display:flex;gap:8px;align-items:flex-start;margin:6px 0">'
        + '<span style="min-width:22px;text-align:center;font-weight:600;color:' + (r.ok ? 'var(--green,#3fb950)' : 'var(--amber,#d29922)') + '">' + (r.ok ? '✓' : n) + '</span>'
        + '<div><div>' + esc(r.title) + (r.ok && r.have ? ' <span class="dim small">· ' + esc(r.have) + '</span>' : '') + '</div>'
        + (r.ok ? '' : '<div class="small muted">' + esc(r.how) + '</div>') + '</div></div>';
    };
    var h = '<div class="cv-setup" style="border:1px solid var(--line,#333);border-radius:10px;padding:12px 14px;margin:10px 6px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center"><b>Getting started' + (s.ready ? ' - ready' : '') + '</b>'
      + '<span class="small"><a href="#" onclick="cvSetup.recheck();return false">Check again</a> · <a href="#" onclick="cvSetup.hide();return false" title="it will not show again, here or in any project - Settings › Engine brings it back">' + (s.ready ? 'Hide' : 'Don\'t show this again') + '</a></span></div>';
    h += '<div class="small muted" style="margin:4px 0 6px">' + (s.ready ? 'Everything Cockpit needs is here. Open a project and talk to it below.' : 'Do these in order. Each one is checked on this machine as you go.') + '</div>';
    h += s.required.map(function (r, i) { return line(r, i + 1); }).join('');
    h += '<div class="small dim" style="margin-top:10px">Optional - only for the feature named:</div>';
    h += s.optional.map(function (r) { return line(r, '·'); }).join('');
    return h + '</div>';
  }
  function logHtml() {
    var h = '';
    if (C.thread) {
      if (C.thread.notes.length) h += '<div class="cv-notes"><b>Standing rulings</b>' + C.thread.notes.map(function (n) { return '<div>• ' + esc(n.text) + '</div>'; }).join('') + '</div>';
      C.thread.turns.forEach(function (t) {
        var cost = t.cost_json ? JSON.parse(t.cost_json) : null;
        h += '<div class="cv-turn ' + t.role + '"><div class="cv-who">' + (t.role === 'user' ? 'You' : esc((t.harness || 'assistant') + (t.model ? ' · ' + t.model : ''))) + ' <span class="dim">' + esc(t.at.slice(11, 16)) + '</span>'
          + (cost ? ' <span class="dim cv-cost">· ' + k(cost.inTokens) + ' in' + (cost.cacheRead ? ' (' + k(cost.cacheRead) + ' cached)' : '') + ' / ' + k(cost.outTokens) + ' out' + (cost.durationMs ? ' · ' + Math.round(cost.durationMs / 1000) + 's' : '') + '</span>' : '') + '</div>' + (t.role === 'user' ? '<div class="cv-text plain">' + esc(t.text) : '<div class="cv-text">' + md(t.text)) + '</div></div>';
      });
    } else if (!C.turn) {
      h += setupHtml();
      h += '<div class="cv-empty"><img src="/img/helmet-64.png" alt="" style="height:56px;opacity:.85"><div class="muted">Talk to the project. The AI is chosen in the header; switch it any time and the conversation carries on.</div></div>';
    }
    if (C.turn) {
      h += '<div class="cv-turn assistant live"><div class="cv-who">' + esc((window.AI && window.AI.harness) + ' · ' + (window.AI && window.AI.model)) + ' <span class="dim">working…</span></div>';
      h += C.live.filter(function (e) { return e.type === 'tool' || e.type === 'error' || e.type === 'file'; }).map(function (e) { return e.type === 'tool' ? toolLine(e) : e.type === 'file' ? '<div class="cv-tool">✎ ' + esc(e.change) + ' <b>' + esc(e.path) + '</b></div>' : '<div class="cv-tool err">' + esc(e.text) + '</div>'; }).join('');
      h += '<div class="cv-text">' + md(C.liveText) + '</div><div class="cv-cursor" title="working…"><span class="cur-wrap"><img src="/img/helmet.png" alt=""></span><span class="cv-cursor-dots"><i></i><i></i><i></i></span></div></div>';
    }
    if (C.sys.length) h += C.sys.slice(-6).map(function (x) { return '<div class="cv-sys' + (x.err ? ' err' : '') + '">' + esc(x.text) + '</div>'; }).join('');
    var last = C.live.length ? C.live[C.live.length - 1] : null;
    if (!C.turn && last && last.type === 'end' && last.outcome) {
      var o = last.outcome;
      h += '<div class="cv-end small dim">' + (o.reason === 'done' ? 'finished' : 'ended: ' + esc(o.reason)) + (o.producedNothing ? ' · <b>produced nothing</b>' : '') + (o.files && o.files.length ? ' · touched ' + o.files.map(esc).join(', ') : '') + (o.cost ? ' · ' + k(o.cost.inTokens) + ' in' + (o.cost.cacheRead ? ' (' + k(o.cost.cacheRead) + ' cached)' : '') + ' / ' + k(o.cost.outTokens) + ' out' : ' · cost not reported') + (o.durationSec ? ' · ' + o.durationSec + 's' : '') + '</div>';
    }
    return h;
  }

    /* while the person is typing here, only the log is redrawn; the composer is left alone */
    function renderLive(el) { var log = el.querySelector('#cv-log'); if (log) { var keep = readerPlace(log); log.innerHTML = logHtml(); putReader(log, keep); } }
    function render(el) {
      var r = X.room;
      if (!r || r.missing) { el.innerHTML = setupHtml() + '<div class="muted small">no project open</div>'; return; }
      // a project forgotten and added again under the same id is a new project: its .cockpit stamp changed (2026-09-20: the docked card kept showing the old conversation)
      // the project moved (its version changed - a turn ended, a ticket moved): a card not listening to a turn re-reads its thread, quietly
      if (C.roomVersion !== undefined && r.version !== C.roomVersion && !C.turn && C.thread && !C.reloading) { C.reloading = true; loadThread(C.thread.id).then(function () { loadThreads(); C.reloading = false; Layout.refresh(); }).catch(function () { C.reloading = false; }); }
      C.roomVersion = r.version;
      var stamp = r.cockpit && r.cockpit.created;
      if (C.project !== r.id || (stamp && C.stamp && C.stamp !== stamp)) { C.project = r.id; C.stamp = stamp; C.thread = null; C.threads = []; C.turn = null; C.live = []; C.liveText = ''; C.drafts = null; C.draftsVersion = null; if (C.es) { C.es.close(); C.es = null; }
        /* Coming (back) to a project: if a turn is still running here, re-attach to it - the
           engine replays its events, so nothing is lost by having switched away (owner,
           2026-09-16: "swap between projects without losing the conversations or any work"). */
        Promise.all([loadThreads(), api(base() + '/chat/running')]).then(function (rr) {
          /* a running turn belongs to the place that holds its thread; a place with no thread of its own takes the
             running one only if it is the room's card (the old habit) - the tabs stay on their own business */
          var running = (rr[1] && rr[1].running) || [], mine = remembered(), has = function (id) { return C.threads.some(function (t) { return t.id === id; }); };
          /* a coder's working log (a Fleet # thread) is never opened by default - it is the queue's, not a conversation, and a long
             one is heavy (2026-09-26) - the newest CONVERSATION is */
          var fleetT = function (id) { var t = C.threads.find(function (x) { return x.id === id; }); return !!(t && /^Fleet #/.test(t.title || '')); };
          var run = running.find(function (r) { return r.thread === mine; }) || (place() === 'room' && !mine ? running.find(function (r) { return !fleetT(r.thread); }) : null);
          if (run) { C.turn = run.turn; C.live = []; C.liveText = ''; loadThread(run.thread).then(function () { Layout.refresh(); listen(run.turn); }); }
          else if (mine && has(mine)) loadThread(mine).then(function () { follow(); Layout.refresh(); });   // where this place was last
          else if (C.threads.some(function (t) { return !fleetT(t.id); })) loadThread(C.threads.find(function (t) { return !fleetT(t.id); }).id).then(function () { follow(); Layout.refresh(); });   // else the newest conversation, not a blank one
          else Layout.refresh();
        }); }

      var h = '<div class="cv">';
      // thread picker
      /* Starting a conversation must never mean scrolling (a busy project can have 133
         threads). A native select scrolls to whatever is selected, so the first option sits far above
         the view and is unreachable in practice. The button is outside the list and always in place;
         the option stays in the list for anyone who looks for it there. */
      h += '<div class="cv-top"><select id="cv-proj" title="who this card talks to - this project, or another: Home is your assistant">' + projectOptions(X.project) + '</select>'
        + '<span class="btn cv-new" id="cv-new" title="start a new conversation - always here, however many you have">＋ New</span>'
        + '<select id="cv-thread"><option value="">＋ New conversation</option>' + C.threads.map(function (t) { return '<option value="' + t.id + '"' + (C.thread && C.thread.id === t.id ? ' selected' : '') + '>' + esc(t.title) + ' <span class="dim">(' + t.n + ')</span></option>'; }).join('') + '</select>'
        + (C.thread ? '<span class="small dim">' + C.thread.turns.length + ' turns · ' + (C.thread.notes.length ? C.thread.notes.length + ' ruling' + (C.thread.notes.length === 1 ? '' : 's') + ' · ' : '') + 'in .cockpit\\conversations\\</span>' : '<span class="small dim">the conversation is recorded in this project\'s .cockpit\\</span>')
        + '</div>';
      // turns
      h += '<div class="cv-log" id="cv-log">' + logHtml() + '</div>';
      // composer
      var scr = window.Screen && window.Screen.context;
      h += '<div class="cv-compose">' + draftsHtml() + (scr ? '<div class="cv-screen small" title="sent with your next message, so you can just ask about it">chat sees: <b>' + esc(scr.label) + '</b></div>' : '') + pickerHtml() + picsHtml() + '<textarea id="cv-in" placeholder="' + (C.turn ? 'a turn is running… (/stop ends it)' : 'Say what you want done, or ask about the project  (Enter sends · Shift+Enter for a new line · / for commands)') + '"' + (C.turn ? '' : '') + '>' + esc(C.draft) + '</textarea>'
        + '<div class="cv-bar"><span class="small dim">' + esc(window.AI && window.AI.harness ? (window.AI.harnesses.find(function (x) { return x.name === window.AI.harness; }) || {}).label + ' · ' + window.AI.model : 'no AI chosen - pick one in the header') + '</span><span style="flex:1"></span>'
        + (C.turn ? '<span class="btn ghost" id="cv-stop">Stop</span>' : '<span class="btn" id="cv-send">Send</span>') + '</div></div>';
      h += '</div>';
      var before = readerPlace(el.querySelector('#cv-log'));
      if (!Layout.paint(el, h)) return;

      var log = el.querySelector('#cv-log'); if (log) { putReader(log, before); log.addEventListener('scroll', function () { if (log.scrollHeight - log.clientHeight - log.scrollTop > 40) delete log.dataset.wantEnd; }); }
      C.el = el; wireDrafts();
      var ta = el.querySelector('#cv-in');
      // Enter sends, Shift+Enter is a new line
      if (ta) {
        /* the box grows with what you type, like the web chat, so the whole message reads without scrolling back up -
           up to 40% of the window; past that it scrolls (engine.css max-height) */
        var grow = function () { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
        grow();   // a restored draft opens at its full height
        ta.addEventListener('input', function () { C.draft = ta.value; C.pickAt = 0; grow(); drawPicker(el); });
        ta.addEventListener('paste', function (e) { var items = (e.clipboardData && e.clipboardData.items) || []; var got = false; for (var i = 0; i < items.length; i++) { if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { addPic(el, items[i].getAsFile()); got = true; } } if (got && !(e.clipboardData.getData('text') || '').trim()) e.preventDefault(); });
        ta.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.items || [], function (x) { return x.kind === 'file'; })) e.preventDefault(); });
        ta.addEventListener('drop', function (e) { var fs = (e.dataTransfer && e.dataTransfer.files) || []; if (!fs.length) return; e.preventDefault(); for (var i = 0; i < fs.length; i++) addPic(el, fs[i]); });
        drawPics(el);
        ta.addEventListener('keydown', function (e) {
          var opts = pickerOpts();
          if (opts.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); C.pickAt = (C.pickAt + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length; drawPicker(el); return; }
          if (opts.length && e.key === 'Tab') { e.preventDefault(); ta.value = C.draft = opts[C.pickAt].cmd + ' '; drawPicker(el); return; }
          if (e.key === 'Escape' && opts.length) { ta.value = C.draft = ''; drawPicker(el); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (opts.length && opts.length > 1 && !/\s/.test(C.draft)) { ta.value = C.draft = opts[C.pickAt].cmd + ' '; drawPicker(el); return; } send(ta.value); }
        });
        if (C.turn) ta.disabled = false;   // a running turn still takes /stop and the rest
      }
      var sb = el.querySelector('#cv-send'); if (sb) sb.addEventListener('click', function () { send(ta.value); });
      var st = el.querySelector('#cv-stop'); if (st) st.addEventListener('click', stop);
      el.querySelector('#cv-thread').addEventListener('change', function (e) { var v = e.target.value; if (!v) { C.thread = null; C.live = []; Layout.refresh(); } else loadThread(Number(v)).then(function () { C.live = []; follow(); Layout.refresh(); }); });
      var pj = el.querySelector('#cv-proj'); if (pj) pj.addEventListener('change', function () { talkTo(X.key, pj.value); });
      var nw = el.querySelector('#cv-new'); if (nw) nw.addEventListener('click', function () { C.thread = null; C.live = []; remember(null); Layout.refresh(); });
    }
    return { render: render, renderLive: renderLive, sendTo: sendTo, attach: attach, use: function (c) { X = c; } };
  }
  /* the instances, by desk key; the desk's own project's instance is what the pages and sendToConversation reach */
  var INST = {};
  function own() { return window.Layout && Layout.ctx ? Layout.ctx('conversation') : { key: 'conversation', api: Layout.state.api, room: window.ROOM, own: true }; }
  /* WHO THE CARD TALKS TO: a picker on the card - this project, or any other; Home is the assistant.
     The choice is kept on the card in the layout (pos.talk) and the instance is re-bound to that project's ctx, so
     from inside any project you can turn to Home's AI and back without leaving. A page or a board that sends to "the
     conversation" is about THIS project, so it turns the card back to it first. */
  var PROJ = { list: null, at: 0 };
  function projects() { if (!PROJ.list || Date.now() - PROJ.at > 60000) { PROJ.at = Date.now(); api('/api/projects').then(function (r) { PROJ.list = (r.projects || []).filter(function (p) { return p.exists; }); Layout.refresh(); }).catch(function () {}); } return PROJ.list || []; }
  function projectOptions(current) {
    var list = projects().slice().sort(function (a, b) { return a.id === 'home' ? -1 : b.id === 'home' ? 1 : (a.name < b.name ? -1 : 1); });
    if (!list.some(function (p) { return p.id === current; })) list.unshift({ id: current, name: current });
    return list.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === current ? ' selected' : '') + '>' + esc(p.id === 'home' ? 'Home · your assistant' : p.name) + '</option>'; }).join('');
  }
  function talkCtx(ctx) {
    var pos = Layout.state.pos[ctx.key], talk = pos && pos.talk;
    if (!talk || talk === ctx.project) return ctx;
    var room = (Layout.state.rooms || {})[talk] || null;
    if (!room && window.ensureCards) window.ensureCards([talk]).then(function () { Layout.refresh(); }).catch(function () {});
    return { key: ctx.key, type: ctx.type, project: talk, projects: [talk], api: '/api/p/' + talk, room: room, rooms: ctx.rooms, own: false, talk: true };
  }
  function talkTo(key, project) {
    var pos = Layout.state.pos[key]; if (!pos) return;
    var ctx = Layout.ctx(key); if (project === ctx.project) delete pos.talk; else pos.talk = project;
    Layout.save(); Layout.refresh();
  }
  function inst(ctx) { ctx = talkCtx(ctx || own()); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Conversation(ctx); I.use(ctx); return I; }
  /* a place's own instance of THIS project's conversation: 'room' is the desk's card; the Architecture and Tests tabs
     each have their own (own thread, own turn, the same thread list) */
  function placeCtx(pl) { var c = own(); if (!pl || pl === 'room') return c; return Object.assign({}, c, { key: 'conversation#' + pl, place: pl }); }
  window.conversationCtx = placeCtx;
  window.attachConversation = function (place, thread, turn) { inst(placeCtx(place || 'room')).attach(thread, turn); };   // a turn the engine started: follow it in that place's conversation
  window.sendToConversation = function (text, o) {
    var pl = (o && o.place) || 'room';
    if (pl === 'room') { var pos = Layout.state.pos.conversation; if (pos && pos.talk) { delete pos.talk; Layout.save(); } }
    inst(placeCtx(pl)).sendTo(text, o);
  };
  Layout.register({ id: 'conversation', onByDefault: true, homeDock: ['top', 0], icon: '💬', title: 'Conversation', purpose: 'where you and the AI talk about this project; every turn is recorded in the project itself', zone: 'stage', pos: 0, size: [12, 20], min: [6, 8], max: [12, 40], prefer: 'tall', multi: true,
    renderLive: function (el, ctx) { inst(ctx).renderLive(el); },
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
})();
