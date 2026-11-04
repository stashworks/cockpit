/* The Notes card - a scratchpad per project. Plain text, saved as you type into the project's own .cockpit\notes.md, so the notes travel with the project.
   Bound to its project through ctx, so it can sit on Home for any project.
   Built to stay put while you type: the text box is only rebuilt when the card is first drawn or the project changes, never by
   a refresh (a refresh that rebuilt it would take the cursor away mid-sentence), and nothing in it carries inline styles (the
   browser rewrites those, which makes a card look changed on every poll - the Agent fleet lesson, 2026-09-26). */
(function () {
  'use strict';
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
  function hm(d) { try { return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  function Notes(ctx0) {
    var X = ctx0, S = { project: null, text: null, loaded: false, err: null, saving: false, savedAt: null, timer: null, box: null, status: null, pending: false };
    function base() { return (X && X.api) || Layout.state.api; }
    function say(t, bad) { if (S.status) { S.status.textContent = t; S.status.className = 'small nt-status' + (bad ? ' bad' : ' dim'); } }
    function load() {
      S.loaded = false; S.err = null;
      api(base() + '/notes').then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'no answer');
        S.text = r.text || ''; S.loaded = true;
        if (S.box && document.activeElement !== S.box) S.box.value = S.text;
        say(r.at ? 'saved ' + hm(new Date(r.at)) : 'empty - type to start');
      }).catch(function (e) { S.err = /Unexpected token|JSON/.test(e.message) ? 'the engine needs a restart before it can keep notes' : e.message; say(S.err, true); });
    }
    function save() {
      clearTimeout(S.timer); S.timer = null;
      if (!S.box || !S.loaded) return;
      if (S.saving) { S.pending = true; return; }
      var text = S.box.value; S.saving = true; say('saving…');
      api(base() + '/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text }) }).then(function (r) {
        S.saving = false;
        if (!r || !r.ok) { say('not saved: ' + ((r && r.error) || 'no answer'), true); return; }
        S.text = text; S.savedAt = new Date(); say('saved ' + hm(S.savedAt));
        if (S.pending) { S.pending = false; save(); }
      }).catch(function (e) { S.saving = false; say('not saved: ' + e.message, true); });
    }
    function render(el) {
      var r = X && X.room; if (!r || r.missing) { el.innerHTML = '<div class="muted small">open a project</div>'; return; }
      // rebuilt only for a new project or a first draw - never on a plain refresh, so typing is never interrupted
      if (S.project === r.id && S.box && el.contains(S.box)) return;
      S.project = r.id;
      el.innerHTML = '<div class="nt"><textarea class="nt-box" spellcheck="true" placeholder="Notes for this project - anything you want to keep. Saved as you type, into the project\'s own folder."></textarea><div class="small dim nt-status">reading…</div></div>';
      S.box = el.querySelector('.nt-box'); S.status = el.querySelector('.nt-status');
      if (S.text != null) S.box.value = S.text;
      S.box.addEventListener('input', function () { say('typing…'); clearTimeout(S.timer); S.timer = setTimeout(save, 800); });
      S.box.addEventListener('blur', function () { if (S.timer) save(); });
      S.box.addEventListener('pointerdown', function (e) { e.stopPropagation(); });   // clicking into the notes is not a drag of the card
      load();
    }
    return { render: render, use: function (c) { if (X && c && X.key !== c.key) { S.project = null; } X = c; }, flush: function () { if (S.timer) save(); } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('notes') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Notes(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'notes', onByDefault: true, homeDock: ['right', 0], icon: '📝', title: 'Notes', purpose: 'a scratchpad for this project - your notes, saved as you type into the project folder', zone: 'right', pos: 2, size: [5, 10], min: [3, 4], max: [14, 40], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
  window.addEventListener('beforeunload', function () { Object.keys(INST).forEach(function (k) { INST[k].flush(); }); });
})();
