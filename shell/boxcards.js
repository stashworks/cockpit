/* BOXED CARDS - one trusted project's own cards, in a sealed box. The engine setting "boxedCards" (engine.json, or
   COCKPIT_BOXED_CARDS) names the project; the first one listed is the one shown here. That project writes the cards in its
   own folder (.cockpit/cards/cards.json + one .html each; the engine's ext.js serves them to that project only). Each is
   shown in an iframe that is sealed twice over:
     - sandbox="allow-scripts" without allow-same-origin: it is a stranger to Cockpit's page and its storage;
     - a Content-Security-Policy of default-src 'none': it cannot fetch, load or send anything, anywhere.
   Its only way out is the messenger below, which does three things, and only for that project:
     cockpit.read(command, args)   one of the read commands of the project's "assistant" extension (its .cockpit/ext.json)
     cockpit.save(body)            that extension's write command (its program checks it)
     cockpit.chat(text)            a message into the project's conversation; cockpit.reply() reads its latest answer
   The cards appear on that project's desk and on Home only (projectOnly). No project named = no boxed cards. Hot: no
   engine restart. */
(function () {
  'use strict';
  var PA = null, API = null, CARDS = {}, FRAMES = new Map(), loaded = null;
  /* which project, asked of the engine once */
  function boxProject() {
    if (PA) return Promise.resolve(PA);
    return fetch('/api/engine').then(function (r) { return r.json(); }).then(function (e) {
      var id = e && Array.isArray(e.boxedCards) && e.boxedCards[0]; if (!id || !/^[a-z0-9-]+$/.test(id)) return null;
      PA = id; API = '/api/p/' + PA; return PA;
    }).catch(function () { return null; });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* what goes in front of the card's own html: the seal, and the messenger's inside half */
  var SEAL = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">'
    + '<style>html,body{margin:0;background:transparent;color:#e6e9f5;font:13px/1.45 "Segoe UI",system-ui,sans-serif}</style>'
    + '<script>(function(){var n=0,w={};window.addEventListener("message",function(e){var d=e.data||{};if(d.box!=="reply"||!w[d.id])return;var p=w[d.id];delete w[d.id];d.ok?p[0](d.data):p[1](new Error(d.error||"refused"));});'
    + 'function ask(m){return new Promise(function(ok,no){var id=++n;w[id]=[ok,no];m.box="ask";m.id=id;parent.postMessage(m,"*");});}'
    + 'window.cockpit={read:function(c,a){return ask({op:"read",cmd:c,args:a||[]});},save:function(b){return ask({op:"save",body:b});},chat:function(t){return ask({op:"chat",text:t});},reply:function(){return ask({op:"reply"});}};})();<\/script></head><body>';

  function send(src, id, ok, x) { try { src.postMessage(ok ? { box: 'reply', id: id, ok: true, data: x } : { box: 'reply', id: id, ok: false, error: String(x) }, '*'); } catch (e) { /* the card is gone */ } }
  function j(r) { return r.json(); }
  var thread = null;   // PA's conversation: its most recent thread, found once
  function paThread() { return thread ? Promise.resolve(thread) : fetch(API + '/chat/threads').then(j).then(function (r) { var t = (r.threads || [])[0]; thread = t ? t.id : null; return thread; }); }
  window.addEventListener('message', function (e) {
    var d = e.data || {}; if (d.box !== 'ask' || !FRAMES.has(e.source)) return;   // only a box Cockpit made may ask
    var src = e.source;
    if (d.op === 'read') {
      if (!/^[a-z0-9-]{1,30}$/.test(String(d.cmd))) return send(src, d.id, false, 'not a command');
      return fetch(API + '/ext/assistant/' + d.cmd + '?args=' + encodeURIComponent(JSON.stringify(Array.isArray(d.args) ? d.args : []))).then(j)
        .then(function (r) { r && r.ok ? send(src, d.id, true, r.data) : send(src, d.id, false, (r && r.error) || 'no answer'); }).catch(function (x) { send(src, d.id, false, x.message); });
    }
    if (d.op === 'save') {
      return fetch(API + '/ext/assistant/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d.body || {}) }).then(j)
        .then(function (r) { r && r.ok ? send(src, d.id, true, r.data) : send(src, d.id, false, (r && r.error) || 'not saved'); }).catch(function (x) { send(src, d.id, false, x.message); });
    }
    if (d.op === 'chat') {
      var text = String(d.text || '').trim().slice(0, 4000); if (!text) return send(src, d.id, false, 'nothing to say');
      return paThread().then(function (t) { return fetch(API + '/chat/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t ? { text: text, thread: t } : { text: text }) }); }).then(j)
        .then(function (r) { if (r && r.thread) thread = r.thread; r && r.ok ? send(src, d.id, true, { turn: r.turn }) : send(src, d.id, false, (r && r.error) || 'not sent'); }).catch(function (x) { send(src, d.id, false, x.message); });
    }
    if (d.op === 'reply') {
      return Promise.all([paThread(), fetch(API + '/chat/running').then(j)]).then(function (a) {
        var busy = ((a[1] && a[1].running) || []).some(function (x) { return x.thread === a[0]; });
        return fetch(API + '/chat/threads').then(j).then(function (r) { var t = (r.threads || []).find(function (x) { return x.id === a[0]; }); send(src, d.id, true, { working: busy, last: t ? t.last : '', at: t ? t.updated : null }); });
      }).catch(function (x) { send(src, d.id, false, x.message); });
    }
    send(src, d.id, false, 'a boxed card can only read, save or chat');
  });

  function frameFor(el, card) {
    var f = el.querySelector('iframe.boxcard-frame');
    if (f && f.dataset.hash === card.hash) return;   // unchanged: never rebuild (a rebuild restarts the card)
    if (f) FRAMES.delete(f.contentWindow);
    el.innerHTML = '';
    f = document.createElement('iframe');
    f.className = 'boxcard-frame'; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('title', card.title); f.dataset.hash = card.hash;
    f.srcdoc = SEAL + card.html;
    el.appendChild(f);
    FRAMES.set(f.contentWindow, card.id);
  }
  function register(card) {
    if (CARDS[card.id]) { CARDS[card.id] = card; return; }
    CARDS[card.id] = card;
    Layout.register({ id: 'box-' + card.id, icon: '▣', title: card.title, projectOnly: PA, multi: true, zone: card.zone, pos: 20, size: card.size, min: [3, 3], max: [24, 40],
      purpose: (card.purpose || 'a project\'s own card') + ' - written by ' + PA + ', shown in a sealed box',
      render: function (el, density, size, ctx) {
        var c = CARDS[card.id];
        if (c.missing) { el.classList.remove('boxcard-body'); Layout.paint(el, '<div class="muted small">This card is no longer in ' + esc(PA) + '\'s cards.</div>'); return; }
        if (c.error) { Layout.paint(el, '<div class="small bad">' + esc(c.error) + '</div>'); return; }
        el.classList.add('boxcard-body'); frameFor(el, c);
      } });
  }
  /* a new card is put on Home once, by itself; Home remembers which it was given (person "box-seeded"), so a card the
     owner later removes from Home stays removed */
  function seedHome(cards) {
    fetch('/api/p/home/layout?person=box-seeded').then(j).then(function (m) {
      var had = (m && m.ids) || [], add = cards.filter(function (c) { return !c.error && had.indexOf(c.id) < 0; });
      if (!add.length) return;
      var chain = add.reduce(function (pr, c) { return pr.then(function () { return Layout.add('box-' + c.id, [PA]).catch(function () { /* not placeable here */ }); }); }, Promise.resolve());
      return chain.then(function () { return fetch('/api/p/home/layout?person=box-seeded', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: had.concat(add.map(function (c) { return c.id; })) }) }); });
    }).catch(function () { /* next load */ });
  }
  /* ONE COPY: Home and the project's desk show the same cards - the ones the project last built and checked in
     .cockpit/cards/. A broken card breaks only its own sealed box. */
  function stage() { return 'list'; }
  function load() {
    var st = stage();
    return boxProject().then(function (id) { if (!id) return null; return fetch(API + '/ext/cards/' + st).then(j); }).then(function (r) {
      if (!r) return;
      var got = (r && r.ok && r.cards) || [];
      Object.keys(CARDS).forEach(function (id) { if (!got.some(function (c) { return c.id === id; })) CARDS[id] = { id: id, title: CARDS[id].title, missing: st }; });
      got.forEach(register);
      if (Layout.state.project === 'home') seedHome(got);
    }).catch(function () { /* no boxed cards: nothing to show */ });
  }
  /* the project changes its cards while you watch: look again every minute, and redraw only a card whose contents changed */
  setInterval(function () {
    if (document.hidden || !API || !Object.keys(CARDS).length) return;
    fetch(API + '/ext/cards/' + stage()).then(j).then(function (r) {
      var moved = false; ((r && r.ok && r.cards) || []).forEach(function (c) { var o = CARDS[c.id]; if (!o || o.hash !== c.hash || o.error !== c.error || o.missing) { register(c); moved = true; } });
      if (moved) Layout.refresh();
    }).catch(function () { /* next minute */ });
  }, 60000);
  window.BoxCards = { load: load, cards: CARDS };
})();
