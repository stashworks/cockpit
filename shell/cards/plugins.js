/* The SETTINGS page. Five sections, each its own card with a plain sentence saying what it is:
     Project   - the name Cockpit shows and where the site runs
     AI        - the agents the engine can drive, whether each is connected, and the models each may be asked for
     Test tools- the browser and security scanner the test stages need, carried inside the engine folder
     Plugins   - what this project is made of: each on/off, with its settings behind a Settings button
     Cards     - the engine's own cards, show or hide per project, each explained
   One primary button per card at most; everything else is quiet. Was the Plugins page (2026-09-16); the plugin
   switchboard and its rules are unchanged, only the surface.

   Also the shared helpers a plugin card uses to configure itself: window.PluginUI. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
  var post = function (u, b) { return api(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); };

  /* ---------- shared, for plugin cards ---------- */
  function questionHtml(q, cur) {
    var v = cur && cur[q.key] != null ? cur[q.key] : (q.default != null ? q.default : '');
    var h = '<label class="pq' + (q.required ? ' pq-req' : '') + '"><span class="pq-l">' + esc(q.label) + (q.required ? ' <span class="dim small">required</span>' : '') + (q.help ? ' <span class="dim small">' + esc(q.help) + '</span>' : '') + '</span>';
    if (q.type === 'choice') h += '<select name="' + esc(q.key) + '">' + (q.options || []).map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === v ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>';
    else if (q.type === 'bool') h += '<input type="checkbox" name="' + esc(q.key) + '"' + (v ? ' checked' : '') + '>';
    else h += '<input type="text" name="' + esc(q.key) + '" value="' + esc(v) + '" placeholder="' + esc(q.placeholder || '') + '">';
    return h + '</label>';
  }
  window.PluginUI = {
    /* the plugin's record from the room */
    info: function (name) { return (((window.ROOM || {}).plugins || {}).available || []).find(function (p) { return p.name === name; }) || null; },
    /* a setup / settings form for a plugin, as html; saveLabel e.g. "Set up" */
    form: function (name, saveLabel) {
      var p = window.PluginUI.info(name); if (!p) return '';
      return '<form class="plw" data-p="' + esc(name) + '">' + (p.questions || []).map(function (q) { return questionHtml(q, p.answers); }).join('')
        + '<div class="plw-bar"><span class="btn" data-act="save">' + esc(saveLabel || 'Save') + '</span><span class="btn ghost" data-act="cancel">Cancel</span><span class="small bad plw-msg"></span></div></form>';
    },
    /* wire a rendered form: onSave(answers, firstTime) after the engine has stored them */
    wire: function (el, onSave, onCancel) {
      var form = el.querySelector('form.plw'); if (!form) return;
      var s = form.querySelector('[data-act="save"]'), c = form.querySelector('[data-act="cancel"]');
      if (s) s.addEventListener('click', function () {
        var ans = {}; form.querySelectorAll('[name]').forEach(function (i) { ans[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
        var p = window.PluginUI.info(form.dataset.p); var firstTime = !(p && p.lastScan);
        /* a required answer left blank is refused here, in the form (2026-09-20: the four Tickets places saved empty and the promote had nothing to go on) */
        var missing = (p ? p.questions || [] : []).filter(function (q) { return q.required && !String(ans[q.key] == null ? '' : ans[q.key]).trim(); });
        var msgEl = form.querySelector('.plw-msg'); if (missing.length) { if (msgEl) msgEl.textContent = 'needed: ' + missing.map(function (q) { return q.label; }).join(', '); return; } if (msgEl) msgEl.textContent = '';
        post(Layout.state.api + '/plugins/' + form.dataset.p + '/select', { answers: ans }).then(function (r) {
          if (onSave) onSave(r.answers || ans, firstTime);
          if (window.reloadRoom) window.reloadRoom();
          /* Coding on: the run started on the engine (the map, the runner) - go to the Tests tab and watch it fill. No AI is started. */
          if (form.dataset.p === 'coding') { var tries = 0; (function go() { var a = document.querySelector('.nav a[data-view="page-tests"]'); if (a) a.click(); else if (++tries < 20) setTimeout(go, 250); })(); return; }
          /* The AI puts the plugin together the FIRST time (owner): the setup goes to the
             conversation, and the plugin's rules tell the AI the rest. Never again after. */
          if (firstTime && p && p.hasScan && form.dataset.p !== 'tickets') {   // a scan-bearing plugin is put together by the AI the first time; the switches (Coding, Tickets) are not
            var msg = 'The ' + (p ? p.label : form.dataset.p) + ' plugin was just set up for this project with these answers: ' + JSON.stringify(r.answers || ans) + '. Put it together for the first time: run its scan, tell me what it found, and ask me what you need to know.';
            var PLACE = { architecture: 'architecture', tickets: 'tests' };   // the setup runs in the tab that owns the plugin: Architecture's in the Architecture tab, Tickets' in the Tests tab, the rest in the room
            setTimeout(function () { if (window.sendToConversation) window.sendToConversation(msg, { newThread: true, place: PLACE[form.dataset.p] || 'room' }); }, 800);
          }
        });
      });
      if (c) c.addEventListener('click', function () { if (onCancel) onCancel(); });
    },
    /* run the plugin's scan and call done() when the engine records it finished */
    scan: function (name, done) {
      post(Layout.state.api + '/plugins/' + name + '/scan').then(function () {
        var tries = 0; (function poll() { setTimeout(function () { api(Layout.state.api + '/plugins').then(function (pr) { var me = (pr.available || []).find(function (x) { return x.name === name; }); if (me && me.lastScan && me.lastScan.finished) { if (window.reloadRoom) window.reloadRoom(); if (done) done(me.lastScan); } else if (++tries < 60) poll(); }); }, 2000); })();
      });
    }
  };

  /* a section: title, the sentence that says what it is, the body */
  function section(id, title, what, body, aside, beside) {
    return '<section class="st-sec" id="st-' + id + '"><div class="st-hd"><div><div class="st-title"><h2>' + esc(title) + '</h2>' + (beside || '') + '</div><div class="st-what">' + what + '</div></div>' + (aside || '') + '</div>' + body + '</section>';
  }

  /* ---------- AI: harnesses and their models ---------- */
  var models = { at: 0, list: null, loading: false, err: null, lists: {}, editing: null, msg: {} };
  function loadModels() {
    if (models.loading) return; models.loading = true; models.err = null;
    var lastR = null; api('/api/harnesses?all=1').then(function (r) { lastR = r;
      return Promise.all((r.harnesses || []).map(function (h) {
        return Promise.all([api('/api/harnesses/probe?name=' + encodeURIComponent(h.name) + '&what=setup'), api('/api/harnesses/models?name=' + encodeURIComponent(h.name)).catch(function () { return null; })])
          .then(function (x) { models.lists[h.name] = x[1]; return Object.assign({}, h, { setup: x[0] && x[0].installed !== undefined ? x[0] : null, probeErr: x[0] && x[0].error }); });
      }));
    }).then(function (list) { models.list = list; models.at = Date.now(); if (!list.length && lastR && lastR.error) models.err = lastR.error + ' - the engine needs a restart'; }).catch(function (e) { models.err = String(e.message || e); })
      .then(function () { models.loading = false; render(); });
  }
  function modelListHtml(m) {
    var L = models.lists[m.name]; if (!L || !L.ok) return '';
    var ed = models.editing === m.name;
    var h = '<div class="st-models"><div class="st-item-hd"><span class="st-lab" style="margin:0">Models ' + esc(kindOf(m).label || m.label) + ' offers</span><span class="st-grow"></span>' + (L.editable && !ed ? '<span class="btn ghost sm" data-edit-models="' + esc(m.name) + '" title="the list the picker offers for this AI">Edit</span>' : '') + '</div>';
    if (!L.editable) return h + '<div class="st-mrow">' + (L.models || []).map(function (x) { return '<span class="lg" title="' + esc(x.id) + '">' + esc(x.label || x.id) + '</span>'; }).join('') + '</div><div class="small dim" style="margin-top:4px">This list is the local model server\'s own: pull or remove models there and press Look again.</div></div>';
    if (!ed) {
      h += '<div class="st-mrow">' + (L.models || []).map(function (x) { return '<span class="lg" title="' + esc(x.id) + '">' + esc(x.label || x.id) + '</span>'; }).join('') + '</div>';
      if (models.msg[m.name]) h += '<div class="small ok" style="margin-top:4px">' + esc(models.msg[m.name]) + '</div>';
      return h + '</div>';
    }
    h += '<div class="small dim" style="margin:6px 0">Each row is one model the picker will offer for this AI. <b>id</b> is the name the tool accepts on its command line (an alias like <code>opus</code> or a full model id - the tool\'s own docs list them); <b>label</b> is what you see in the picker; <b>context</b> is its window in tokens, used to size what each turn is given. The tool itself decides whether your account may use a model.</div>'
      + '<form class="st-mform" data-h="' + esc(m.name) + '"><div class="st-mrow2 st-mhead"><span>id</span><span>label</span><span>context</span><span></span></div>' + (L.models || []).map(function (x) { return modelRowHtml(x); }).join('')
      + '<div class="plw-bar"><span class="btn ghost sm" data-act="add-model">+ Add a model</span></div>'
      + '<div class="plw-bar"><span class="btn" data-act="save-models">Save</span><span class="btn ghost" data-act="cancel-models">Cancel</span></div></form>';
    return h + '</div>';
  }
  function modelRowHtml(x) { return '<div class="st-mrow2"><input type="text" name="id" value="' + esc(x.id) + '" placeholder="e.g. opus"><input type="text" name="label" value="' + esc(x.label || '') + '" placeholder="what the picker shows"><input type="text" name="ctx" value="' + esc(x.contextTokens || 200000) + '" placeholder="200000"><span class="st-x" data-rm title="remove this model">×</span></div>'; }
  /* the built-in three: what each is, where its maker keeps the install instructions, how to sign in. A custom
     tool carries these in its own entry. Everything else (installed? signed in? models?) comes from the probe. */
  var KINDS = {
    'claude-code': { label: 'Claude Code', what: 'Anthropic\'s coding agent. Runs on a Claude subscription (Pro or Max) or API billing.', site: 'https://docs.anthropic.com/en/docs/claude-code', signin: 'claude login' },
    'codex-cli': { label: 'Codex CLI', what: 'OpenAI\'s coding agent. Runs on a ChatGPT subscription (Plus or Pro) or an API key.', site: 'https://github.com/openai/codex', signin: 'codex login' },
    'pi': { label: 'Local', what: 'Models that run on the engine machine\'s own GPU through a local model server. Free, no account, slower, private. Cockpit reads the server\'s model list (Ollama today).', site: 'https://ollama.com', signin: 'no sign-in - start your local model server and pull a model (with Ollama: ollama pull <model>)' }
  };
  var aiTools = { cfg: null, editing: null, err: null };   // the tools configuration (custom.json) and the open form
  function kindOf(m) { if (KINDS[m.name]) return KINDS[m.name]; var t = ((aiTools.cfg && aiTools.cfg.tools) || []).find(function (x) { return x.name === m.name; }); return t ? { label: t.label, what: 'A tool you added. Cockpit runs <code>' + esc(t.command) + '</code> and streams what it prints; its own tool use and cost are not seen.', site: t.site, signin: t.signin } : {}; }
  var presets = { list: null };
  function presetsHtml() {
    if (!presets.list) { api('/ai-presets.json').then(function (r) { presets.list = r.presets || []; render(); }).catch(function () { presets.list = []; render(); }); }
    var connected = (models.list || []).filter(function (m) { return m.ok && m.setup && m.setup.account && m.setup.account.ok && !((aiTools.cfg && aiTools.cfg.off) || []).includes(m.name); });
    var h = '<div class="st-toolform"><div class="st-item-hd"><b>Add an AI</b><span class="st-grow"></span><span class="btn ghost sm" data-act="cancel-tool">Cancel</span></div>'
      + '<div class="small dim" style="margin:4px 0 10px">Pick the one you are adding and Cockpit fills in how to run it - you still install it and sign in yourself, steps 1 and 2. The three built in (Claude Code, Codex CLI, Local) are already on the list.</div>'
      + '<div class="st-presets">' + (presets.list || []).map(function (p) { return '<div class="st-preset" data-preset="' + esc(p.key) + '"><b>' + esc(p.label) + '</b><div class="small dim">' + esc(p.what) + '</div></div>'; }).join('')
      + '<div class="st-preset" data-preset="__blank"><b>Something else</b><div class="small dim">Any command-line AI that takes a prompt and prints an answer. You fill in how it is run - each field says where to find the answer.</div></div></div>';
    if (connected.length) h += '<div class="small" style="margin-top:12px"><span class="dim">Not sure what to enter?</span> ' + connected.map(function (m) { return '<span class="btn ghost sm" data-ask-ai="' + esc(m.name) + '">Ask ' + esc(kindOf(m).label || m.label) + ' to work it out</span>'; }).join(' ') + ' <span class="dim">- it reads the new tool\'s own help on the engine\'s machine and gives you the values for the form. You press Add.</span></div>';
    return h + '</div>';
  }
  function toolFormHtml(t, preset) {
    t = t || (preset ? { name: '', label: preset.label, command: preset.command, args: preset.args, site: preset.site, signin: preset.signin, models: preset.models, install: preset.install, checked: preset.checked } : { name: '', label: '', command: '', args: '', site: '', signin: '', models: '' });
    var argsStr = Array.isArray(t.args) ? t.args.map(function (a) { return /\s/.test(a) ? '"' + a + '"' : a; }).join(' ') : (t.args || '');
    var modelsStr = Array.isArray(t.models) ? t.models.map(function (m) { return m.id + (m.label && m.label !== m.id ? '=' + m.label : ''); }).join(', ') : (t.models || '');
    var lead = preset ? '<div class="small" style="margin:0 0 10px">Filled in from ' + esc(preset.label) + '\'s own documentation as of ' + esc(preset.checked || '') + '. Their flags and model names, not Cockpit\'s - if it stops answering one day, check <code>' + esc(preset.command) + ' --help</code> and Edit this entry.' + (preset.install ? '<div style="margin-top:6px"><span class="dim">Install (step 1):</span> <code>' + esc(preset.install) + '</code></div>' : '') + '</div>'
      : (t.name ? '' : '<div class="small dim" style="margin:0 0 10px">Everything here comes from the tool itself: its install page and, once installed, what <code>&lt;command&gt; --help</code> prints in a terminal on the engine\'s machine.</div>');
    return '<form class="plw st-toolform" data-was="' + esc(t.name || '') + '"><div class="st-item-hd"><b>' + (t.name ? 'Edit ' + esc(t.label) : preset ? 'Add ' + esc(preset.label) : 'Add an AI') + '</b></div>' + lead
      + '<label class="pq"><span class="pq-l">Name <span class="dim">- what the picker in the header shows for it</span></span><input name="label" value="' + esc(t.label) + '" placeholder="e.g. Grok Build"></label>'
      + '<label class="pq"><span class="pq-l">Command <span class="dim">- the word you type in a terminal to start it, after installing (the install page says; e.g. <code>grok</code>)</span></span><input name="command" value="' + esc(t.command) + '" placeholder="e.g. grok"></label>'
      + '<label class="pq"><span class="pq-l">Arguments <span class="dim">- how the tool takes a prompt and a model without asking questions. <code>&lt;command&gt; --help</code> lists its flags; put <code>{prompt}</code> where the text goes and <code>{model}</code> where the model name goes. Example: <code>-p "{prompt}" -m {model}</code>. Leave <code>{prompt}</code> out if the tool reads the prompt from standard input.</span></span><input name="args" value="' + esc(argsStr) + '" placeholder=\'e.g. -p "{prompt}" -m {model}\'></label>'
      + '<label class="pq"><span class="pq-l">Models <span class="dim">- the model names the tool accepts (its docs or <code>--help</code> list them), comma-separated; <code>name=Label</code> to show a friendlier label in the picker</span></span><input name="models" value="' + esc(modelsStr) + '" placeholder="e.g. grok-4.6=Grok 4.6"></label>'
      + '<label class="pq"><span class="pq-l">Install page <span class="dim">- the maker\'s instructions; shown in step 1 for the next person</span></span><input name="site" value="' + esc(t.site || '') + '" placeholder="https://…"></label>'
      + '<label class="pq"><span class="pq-l">Sign-in command <span class="dim">- shown in step 2; empty if the tool has no sign-in</span></span><input name="signin" value="' + esc(t.signin || '') + '" placeholder="e.g. grok login"></label>'
      + '<div class="plw-bar"><span class="btn" data-act="save-tool">' + (t.name ? 'Save' : 'Add') + '</span><span class="btn ghost" data-act="cancel-tool">Cancel</span>' + (aiTools.err ? ' <span class="small bad">' + esc(aiTools.err) + '</span>' : '') + '</div></form>';
  }
  function aiHtml() {
    if (!models.list && !models.loading && !models.err) loadModels();
    if (aiTools.cfg === null) { aiTools.cfg = {}; api('/api/harnesses/tools').then(function (r) { aiTools.cfg = r.ok ? r : {}; render(); }).catch(function () { aiTools.cfg = { pending: true }; }); }
    var all = models.list || [], off = (aiTools.cfg && aiTools.cfg.off) || [], custom = (aiTools.cfg && aiTools.cfg.tools) || [];
    var what = 'Cockpit does not talk to an AI directly. It drives an AI through that AI\'s own command-line tool: for every turn it starts the tool in the background with your prompt, streams the answer, and stops it. Getting one working is two steps of yours and none of Cockpit\'s.';
    var editor = '';   // the add / edit panel, full width above the columns
    if (aiTools.editing === '__pick') editor = presetsHtml();
    else if (aiTools.editing === '__new') editor = toolFormHtml(null);
    else if (aiTools.editing && aiTools.editing.indexOf('preset:') === 0) { var pk = aiTools.editing.slice(7), pr = (presets.list || []).find(function (p) { return p.key === pk; }); editor = pr ? toolFormHtml(null, pr) : ''; }
    else if (aiTools.editing) { var ce = custom.find(function (x) { return x.name === aiTools.editing; }); if (ce) editor = toolFormHtml(ce); }
    /* left: the how-to, then the tools configuration */
    var left = '<ol class="st-steps">'
      + '<li><b>Install the AI\'s command-line tool on the machine the engine runs on.</b> The maker\'s own instructions are linked on each AI below. Cockpit never installs anything.</li>'
      + '<li><b>Sign in to it once, in a terminal on that machine, as the user the engine runs as.</b> Your account, your plan:'
      + '<div class="st-cmds">' + all.map(function (m) { var k = kindOf(m); return k.signin ? '<div><span class="st-cmd-n">' + esc(k.label || m.label) + '</span><code>' + esc(k.signin) + '</code></div>' : ''; }).join('') + '</div>'
      + 'To change accounts later: sign out and in again the same way.</li>'
      + '<li><b>That is it.</b> Cockpit looks for the tools it knows every time this page opens; an installed, signed-in one appears on the right with who it is signed in as and its models, and from then on it is in the picker in the header. Just installed one and it is not there? Press <b>Look again</b>. You never run the tool yourself after this - Cockpit does, for each turn.</li>'
      + '</ol>';
    left += '<div class="st-item-hd" style="margin-top:6px"><span class="st-lab" style="margin:0">AIs Cockpit can drive</span></div>'
      + '<div class="small dim" style="margin:4px 0 8px">Switch one off to keep it out of the picker and the fleet - nothing is uninstalled. The three built in are known to the engine in full; one you add is run by its command line, and Cockpit streams what it prints - that is the floor: its own tool use and cost are not seen.</div>';
    left += '<div class="st-list st-tools">' + all.map(function (m) {
      var k = kindOf(m), isOff = off.indexOf(m.name) >= 0, ct = custom.find(function (x) { return x.name === m.name; });
      return '<div class="st-item' + (isOff ? '' : ' on') + '"><div class="st-item-hd"><b>' + esc(k.label || m.label) + '</b>' + (ct ? ' <span class="pl-on" style="color:var(--muted)">added</span>' : '') + '<span class="st-grow"></span>'
        + (ct ? '<span class="btn ghost sm" data-tool-edit="' + esc(m.name) + '">Edit</span> <span class="btn ghost sm" data-tool-remove="' + esc(m.name) + '">Remove</span> ' : '')
        + '<label class="sw" title="' + (isOff ? 'off - not offered' : 'on') + '"><input type="checkbox" data-tool-on="' + esc(m.name) + '"' + (isOff ? '' : ' checked') + '><span class="swk"></span></label></div>'
        + '<div class="small dim">' + (k.what || '') + '</div>'
        + '<div class="small" style="margin-top:4px">' + (k.site ? '<a class="st-link" href="' + esc(k.site) + '" target="_blank">install instructions ↗</a>' : '<span class="dim">no install page given</span>') + (k.signin ? ' <span class="dim">· sign in: </span><code>' + esc(k.signin) + '</code>' : '') + '</div></div>';
    }).join('') + '</div>';
    /* right: the tools as found on the engine's machine */
    var right;
    if (models.err) right = '<div class="small bad">' + esc(models.err) + '</div>';
    else if (!models.list) right = '<div class="small dim">looking on the engine\'s machine…</div>';
    else right = '<div class="st-list">' + all.filter(function (m) { return off.indexOf(m.name) < 0; }).map(function (m) {
      var k = kindOf(m), s = m.setup, ok = m.ok && s && s.account && s.account.ok;   // a lapsed access token is still connected - the next turn re-mints it
      var state = m.ok ? (s ? (s.account.ok ? (s.account.expired ? 'connected, idle' : 'connected') : 'installed, ' + (s.account.why || 'not signed in')) : 'installed') : 'not found';
      var todo = s && s.connect && !ok ? s.connect.filter(function (c) { return !/^Usage|^One local turn|^A generic tool/.test(c); }) : [];
      if (!m.ok && !todo.length) todo = ['Not found on the engine\'s machine: step 1, then Look again.'];
      return '<div class="st-item' + (ok ? ' on' : '') + '"><div class="st-item-hd"><b>' + esc(k.label || m.label) + '</b> <span class="lg ' + (ok ? 'ok' : m.ok ? 'warn' : 'bad') + '">' + esc(state) + '</span><span class="st-grow"></span>'
        + '</div>'
        + (ok ? '<div class="small" style="margin-top:2px">' + esc((s && s.version) || '') + (s.account.who ? ' · signed in as <b>' + esc(s.account.who) + '</b>' : '') + (m.exclusive ? ' · one turn at a time' : '') + '</div>' : '')
        + (todo.length ? '<div class="small" style="margin-top:6px">' + todo.map(function (c) { return '<div>→ ' + esc(c.replace(/ \(an install - ask the owner first\)/, '')) + '</div>'; }).join('') + '</div>' : '')
        + (m.probeErr ? '<div class="small bad">' + esc(m.probeErr) + '</div>' : '')
        + (ok ? modelListHtml(m) : '') + '</div>';
    }).join('') + '</div>';
    var body = editor + '<div class="st-two"><div>' + left + '</div><div><div class="st-item-hd" style="margin-bottom:8px"><span class="st-lab" style="margin:0">On the engine\'s machine</span><span class="st-grow"></span>' + (models.at ? '<span class="small dim" style="margin-right:8px">looked ' + new Date(models.at).toLocaleTimeString('en-US') + '</span>' : '') + '<span class="btn ghost sm" data-connect title="looks again on the engine\'s machine: which tools are installed, who each is signed in as, which models it offers">' + (models.loading ? 'looking…' : 'Look again') + '</span></div>' + right + '</div></div>';
    return section('ai', 'AI', what, body, '', aiTools.editing ? '' : '<span class="btn sm" data-tool-add>+ Add an AI</span>');
  }

  /* ---------- Test tools ---------- */
  var tools = { st: null, loading: false, err: null, timer: null };
  var wzst = { st: null, loading: false, busy: null, msg: null, ok: true };   // the wizard's state, for the start-with-Windows switch
  function loadTools() {
    if (tools.loading) return; tools.loading = true;
    api('/api/tools').then(function (r) { tools.st = r; tools.err = null; }).catch(function (e) { tools.err = String(e.message || e); }).then(function () { tools.loading = false; render(); if (tools.st && tools.st.running && !tools.timer) tools.timer = setTimeout(function () { tools.timer = null; loadTools(); }, 4000); });
  }
  function toolsHtml() {
    var coding = !!Layout.state.coding;   // the test tools are part of the Coding plugin
    if (coding && !tools.st && !tools.loading && !tools.err) loadTools();
    var what = coding ? 'Housekeeping for the engine itself. The test stages need a <b>browser</b> and a <b>security scanner</b>; both are carried inside the engine folder, so the only question is whether they are unpacked on this machine.' : 'Cockpit itself: starting with Windows, the setup and the tour, and stopping it.';
    var body, aside = '';
    if (!coding) body = '';
    else if (tools.err) body = '<div class="small bad">' + esc(tools.err) + '</div>';
    else if (!tools.st) body = '<div class="small dim">reading…</div>';
    else {
      var t = tools.st, missing = (t.missingArchives || []).length, have = (t.allArchives || []).filter(function (a) { return a.have; }).length, all = (t.allArchives || []).length;
      var semgrepHere = (t.allArchives || []).some(function (a) { return /semgrep/.test(a.file) && a.have; });
      var ready = t.browsers && t.zap && !missing && (t.semgrep || !semgrepHere);   // semgrep waits to be unpacked only when its archive is in the folder
      body = '<div class="small">Test tools on this machine: browser ' + (t.browsers ? '<span class="lg ok">ready</span>' : missing ? '<span class="lg bad">not downloaded</span>' : '<span class="lg">unpacks on first use</span>') + ' &nbsp; scanner ' + (t.zap ? '<span class="lg ok">ready</span>' : missing ? '<span class="lg bad">not downloaded</span>' : '<span class="lg">unpacks on first use</span>') + ' &nbsp; code scanner ' + (t.semgrep ? '<span class="lg ok">ready</span>' : semgrepHere ? '<span class="lg">unpacks on first use</span>' : '<span class="lg" title="semgrep as a folder: copy semgrep-win64.zip into tools\dl, then Unpack">archive not in the folder</span>') + ' <span class="dim">· ' + have + ' of ' + all + ' archives in the folder</span></div>'
        + (t.log && !ready ? '<pre class="st-log">' + esc(t.log) + '</pre>' : '');
      aside = '<div class="st-aside">' + (t.running ? '<span class="small dim">downloading…</span>' : ready ? '' : '<span class="btn ghost" id="tools-fetch" title="downloads what the folder is missing (about 1 GB the first time) and unpacks it for this machine - on the engine\'s own machine, into its own folder">' + (missing ? 'Download & unpack' : (!t.browsers || !t.zap) ? 'Unpack for this machine' : 'Check again') + '</span>') + '</div>';
    }
    /* starting with Windows: the same switch as the wizard's (engine/wizard.js startup), on by default */
    if (!wzst.st && !wzst.loading) { wzst.loading = true; api('/api/wizard').then(function (s) { wzst.st = s; }).catch(function () { wzst.st = {}; }).then(function () { wzst.loading = false; render(); }); }
    var ws = wzst.st || {}, auto = ws.canStartup ? '<div class="st-item' + (ws.startup ? ' on' : '') + '"><div class="st-item-hd"><b>Start Cockpit automatically when I sign in</b><span class="st-grow"></span>'
      + (wzst.busy ? '<span class="small dim" style="margin-right:8px">' + esc(wzst.busy) + '</span>' : '')
      + '<label class="sw" title="' + (ws.startup ? 'on' : 'off') + '"><input type="checkbox" id="eng-auto"' + (ws.startup ? ' checked' : '') + (wzst.busy ? ' disabled' : '') + '><span class="swk"></span></label></div>'
      + '<div class="small dim">On: Cockpit starts by itself in the background when you sign in to Windows, with no window, and starts again if it ever stops on its own. Stop Cockpit still stops it until you start it again or next sign in.' + (ws.startupMethod === 'shortcut' ? ' (Done with a shortcut in your Startup folder - Windows refused a scheduled task here.)' : '') + '</div>'
      + (wzst.msg ? '<div class="small ' + (wzst.ok ? 'ok' : 'bad') + '" style="margin-top:4px">' + esc(wzst.msg) + '</div>' : '') + '</div>' : '';
    /* setup and the tour again, and stopping Cockpit - it runs in the background with no window of its own (2026-10-08) */
    body = '<div class="st-list" style="margin-bottom:14px">' + auto + '<div class="st-item"><div class="st-item-hd"><b>Setup and tour</b><span class="st-grow"></span>'
      + '<span class="btn ghost sm" id="wz-again" title="your name, the port, Git, Claude Code, your Home, a folder">Run setup again</span> '
      + '<span class="btn ghost sm" id="wz-tour" title="a one-minute look around the screen">Take the tour</span> '
      + '<span class="btn ghost sm" id="setup-show" title="the list of what this computer needs, in Home\'s conversation, until it is all there or you hide it">Show the Getting started list</span></div>'
      + '<div class="small dim">The first-run screens, any time - to change the port, start with Windows, sign Claude in again.</div></div>'
      + '<div class="st-item"><div class="st-item-hd"><b>Stop Cockpit</b><span class="st-grow"></span><span class="btn ghost sm" id="eng-stop">Stop Cockpit</span></div>'
      + '<div class="small dim">Cockpit runs in the background. This stops it, and it stays stopped; start it again with "Start Cockpit" in its folder (or it starts by itself the next time you sign in, if that is on).</div></div></div>' + body;
    return section('engine', 'Engine', what, body, aside);
  }

  /* ---------- Plugins ---------- */
  var open = {};   // plugins whose settings are open on the page
  /* a switch per card */
  function cardSwitches(cards) {
    if (cards.length < 2) return '';   // one card = the plugin's switch is its switch
    return '<div class="pl-cards">' + cards.sort(function (a, b) { return (a.pos || 0) - (b.pos || 0); }).map(function (c) {
      return '<label class="pl-card" title="' + esc(c.purpose || '') + '"><input type="checkbox" data-card="' + esc(c.id) + '"' + (Layout.isHidden(c.id) ? '' : ' checked') + '><span class="swk sm"></span>' + esc(c.title) + '</label>';
    }).join('') + '</div>';
  }
  /* THE CODING PLUGIN (engine-wide; engine/config.js codingOn, shell/layout.js the gate): one switch for everything that is
     about writing software. Off (the default), none of it appears anywhere; on, it all comes back as it was. */
  function codingHtml() {
    var on = !!Layout.state.coding;
    return '<div class="st-item' + (on ? ' on' : '') + '" style="margin-bottom:12px"><div class="st-item-hd"><b>Coding</b> <span class="pl-on">every project</span><span class="st-grow"></span>'
      + '<label class="sw" title="' + (on ? 'on' : 'off') + '"><input type="checkbox" id="coding-on"' + (on ? ' checked' : '') + '><span class="swk"></span></label></div>'
      + '<div class="small dim">For software projects: the agent fleet and its queue, lane performance, alerts and the event log, backups, data views - and the project plugins for code (Architecture, Coding with its Tests tab, Tickets with the board, pipeline and deploys, GitHub, Database). '
      + (on ? 'On: switch each project\'s plugins below.' : 'Off: none of it appears anywhere - not on Home, not in a drawer, not in ＋ Card. Turning it on brings it all back.') + '</div></div>';
  }
  function pluginsHtml(r, pl) {
    var what = 'What this project is made of. Each plugin brings its own cards to the control room, its own rules for the AI, and a scan that keeps its facts fresh. Turn on what applies; <b>Settings</b> holds its questions (the repository, where the credentials are…). Off hides the cards and keeps every answer. A plugin\'s cards are switched under the plugin.';
    pl = pl.filter(function (p) { return Layout.state.coding || p.group !== 'coding'; });
    var body = codingHtml() + (pl.length ? '<div class="st-list">' + pl.map(function (p) {
      var y = p.lastScan && p.lastScan.yields ? JSON.parse(p.lastScan.yields) : null;
      var status = p.configured ? (p.lastScan ? 'last read ' + String(p.lastScan.finished || p.lastScan.started).slice(0, 16).replace('T', ' ') + (y ? ' · ' + Object.entries(y).slice(0, 4).map(function (kv) { return kv[1] + ' ' + kv[0]; }).join(', ') : '') : 'set up, not read yet') : (p.selected ? 'needs its settings' : '');
      var showForm = (p.questions || []).length && ((p.selected && !p.configured) || open[p.name]);
      return '<div class="st-item' + (p.selected ? ' on' : '') + '"><div class="st-item-hd"><b>' + esc(p.label) + '</b>'
        + '<span class="st-grow"></span>'
        + (((p.questions || []).length || p.name === 'tickets') && p.selected && p.configured ? '<span class="btn ghost sm" data-cfg="' + esc(p.name) + '">' + (open[p.name] ? 'Close' : 'Settings') + '</span>' : '')
        + (p.always ? '<span class="pl-on">always on</span>' : '<label class="sw" title="' + (p.selected ? 'on' : 'off') + '"><input type="checkbox" data-p="' + esc(p.name) + '"' + (p.selected ? ' checked' : '') + '><span class="swk"></span></label>') + '</div>'
        + '<div class="small dim">' + esc(p.purpose || '') + '</div>'
        + (status ? '<div class="small dim" style="margin-top:4px">' + esc(status) + '</div>' : '')
        + (p.selected ? cardSwitches(Object.values(Layout.state.cards).filter(function (c) { return c.plugin === p.name; })) : '')
        + (showForm ? '<div class="plw-wrap">' + window.PluginUI.form(p.name, p.configured ? 'Save' : 'Set up') + '</div>' : '')
        + (p.name === 'tickets' && open[p.name] ? verdictHtml() : '')
        + '</div>';
    }).join('') + '</div>' : '<div class="small dim">' + (Layout.state.coding ? 'The engine has no plugins yet.' : 'No other plugins.') + '</div>');
    return section('plugins', 'Plugins and cards', '', '<div class="st-two st-two-pc"><div><h3 class="st-h3">Plugins</h3><div class="st-what">' + what + '</div>' + body + '</div><div><h3 class="st-h3">Cards</h3><div class="st-what">The engine\'s own cards on the control room - the ones that belong to no plugin. Show or hide each on this project; the ones marked <b>global</b> (with Coding on: the fleet, lane performance) look the same on every project.</div>' + cardsHtml() + '</div></div>');
  }

  /* ---------- the verdict's checks (plugins/tickets/verdict.json) - QA'd and changed here ---------- */
  var vd = { j: null, editing: null, err: null };
  function verdictHtml() {
    if (vd.j === null) { vd.j = {}; api('/api/verdict').then(function (r) { vd.j = r.ok ? r : { checks: [], err: r.error }; render(); }).catch(function () { vd.j = { checks: [], err: 'the engine needs a restart before this list can be read' }; render(); }); }
    var checks = (vd.j && vd.j.checks) || [];
    var h = '<div class="st-vd"><div class="st-item-hd"><span class="st-lab" style="margin:0">The verdict\'s checks</span><span class="st-grow"></span>' + (vd.editing ? '' : '<span class="btn ghost sm" data-vd-add>+ Add a check</span>') + '</div>'
      + '<div class="small dim" style="margin:4px 0 8px">Two gates. <b>On the ticket</b>: asked of every turn once the rescan settles - all green and the ticket is verified. <b>At promote</b>: the environment, asked of the whole project before anything is promoted (the Tests tab). Each line is one question. <b>on</b> leaves it in or out; <b>blocks</b> means red holds the ticket in work, off means it only warns. The seven built in are measured by the engine; one you add is a Problems rule that must not fire on the ticket\'s files, a command that must exit 0, or a pattern that must not appear in the touched files.</div>';
    if (vd.j && vd.j.err) h += '<div class="small bad">' + esc(vd.j.err) + '</div>';
    if (vd.editing === '__new') h += vdForm(null);
    h += '<div class="st-list">' + checks.map(function (c) {
      if (vd.editing === c.id) return vdForm(c);
      return '<div class="st-item' + (c.on === false ? '' : ' on') + '"><div class="st-item-hd"><b>' + esc(c.name) + '</b> <span class="pl-on" style="color:var(--muted)" title="' + (c.gate === 'promote' ? 'asked of the whole project before anything is promoted - the Tests tab' : 'asked of every turn on a ticket - its verdict') + '">' + (c.gate === 'promote' ? 'at promote' : 'on the ticket') + '</span>' + (c.kind !== 'builtin' && c.kind !== 'family' ? ' <span class="pl-on" style="color:var(--muted)">' + esc(c.kind) + '</span>' : '') + (c.blocks === false ? ' <span class="lg warn">warns only</span>' : '') + '<span class="st-grow"></span>'
        + '<span class="btn ghost sm" data-vd-edit="' + esc(c.id) + '">Edit</span> ' + (c.kind !== 'builtin' ? '<span class="btn ghost sm" data-vd-remove="' + esc(c.id) + '">Remove</span> ' : '')
        + '<label class="small dim" title="red holds the ticket in work; off: it only warns">blocks <input type="checkbox" data-vd-blocks="' + esc(c.id) + '"' + (c.blocks === false ? '' : ' checked') + '></label> '
        + '<label class="sw" title="' + (c.on === false ? 'off - not asked' : 'on') + '"><input type="checkbox" data-vd-on="' + esc(c.id) + '"' + (c.on === false ? '' : ' checked') + '><span class="swk"></span></label></div>'
        + '<div class="small">' + esc(c.asks || '') + '</div>'
        + (c.why ? '<div class="small dim" style="margin-top:2px">' + esc(c.why) + '</div>' : '')
        + (c.measures ? '<div class="small dim" style="margin-top:2px"><b>measures</b> ' + esc(c.measures) + '</div>' : '')
        + (c.kind === 'problem' ? '<div class="small dim" style="margin-top:2px"><b>rule</b> <code>' + esc(c.rule) + '</code></div>' : c.kind === 'command' ? '<div class="small dim" style="margin-top:2px"><b>command</b> <code>' + esc(c.command) + '</code></div>' : c.kind === 'pattern' ? '<div class="small dim" style="margin-top:2px"><b>pattern</b> <code>' + esc(c.pattern) + '</code></div>' : '')
        + (c.fix ? '<div class="small dim" style="margin-top:2px"><b>when red</b> ' + esc(c.fix) + '</div>' : '') + '</div>';
    }).join('') + '</div></div>';
    return h;
  }
  function vdForm(c) {
    var b = !!(c && c.kind === 'builtin'); c = c || { id: '', kind: 'problem', name: '', asks: '', why: '', measures: '', fix: '', rule: '', command: '', pattern: '', on: true, blocks: true };
    return '<form class="plw st-toolform" data-was="' + esc(c.id) + '"><div class="st-item-hd"><b>' + (c.id ? 'Edit ' + esc(c.name) : 'Add a check') + '</b></div>'
      + (b ? '<div class="small dim" style="margin:0 0 8px">A built-in check: its wording is yours to change; what it measures is the engine\'s.</div>' : '<label class="pq"><span class="pq-l">Kind <span class="dim">- what the check is</span></span><select name="kind"><option value="problem"' + (c.kind === 'problem' ? ' selected' : '') + '>a Problems rule that must not fire on the ticket\'s files</option><option value="command"' + (c.kind === 'command' ? ' selected' : '') + '>a command run in the project folder that must exit 0</option><option value="pattern"' + (c.kind === 'pattern' ? ' selected' : '') + '>a pattern (regular expression) that must not appear in the touched files</option></select></label>'
      + '<label class="pq"><span class="pq-l">Rule <span class="dim">- for a Problems check: the rule id as Problems names it (e.g. <code>empty-catch</code>)</span></span><input name="rule" value="' + esc(c.rule || '') + '"></label>'
      + '<label class="pq"><span class="pq-l">Command <span class="dim">- for a command check: as you would type it in the project folder (e.g. <code>npm run lint</code>)</span></span><input name="command" value="' + esc(c.command || '') + '"></label>'
      + '<label class="pq"><span class="pq-l">Pattern <span class="dim">- for a pattern check: a regular expression (e.g. <code>console\\.log</code>)</span></span><input name="pattern" value="' + esc(c.pattern || '') + '"></label>')
      + (b ? '' : '<label class="pq"><span class="pq-l">Asked <span class="dim">- of every turn on a ticket, or of the whole project before a promote</span></span><select name="gate"><option value="ticket"' + (c.gate !== 'promote' ? ' selected' : '') + '>on the ticket</option><option value="promote"' + (c.gate === 'promote' ? ' selected' : '') + '>at promote</option></select></label>')
      + '<label class="pq"><span class="pq-l">Name <span class="dim">- the line on the ticket</span></span><input name="name" value="' + esc(c.name) + '"></label>'
      + '<label class="pq"><span class="pq-l">Asks <span class="dim">- the question, in one sentence</span></span><input name="asks" value="' + esc(c.asks || '') + '"></label>'
      + '<label class="pq"><span class="pq-l">Why <span class="dim">- what going red protects</span></span><input name="why" value="' + esc(c.why || '') + '"></label>'
      + '<label class="pq"><span class="pq-l">Measures <span class="dim">- exactly what is counted</span></span><input name="measures" value="' + esc(c.measures || '') + '"></label>'
      + '<label class="pq"><span class="pq-l">When red <span class="dim">- what to do about it</span></span><input name="fix" value="' + esc(c.fix || '') + '"></label>'
      + '<div class="plw-bar"><span class="btn" data-vd-save>' + (c.id ? 'Save' : 'Add') + '</span><span class="btn ghost" data-vd-cancel>Cancel</span>' + (vd.err ? ' <span class="small bad">' + esc(vd.err) + '</span>' : '') + '</div></form>';
  }
  function vdWire(el) {
    var op = function (body) { return post('/api/verdict', body).then(function (r) { if (!r.ok) { vd.err = r.error; render(); return false; } vd.j = r; vd.editing = null; vd.err = null; render(); return true; }); };
    var add = el.querySelector('[data-vd-add]'); if (add) add.addEventListener('click', function () { vd.editing = '__new'; vd.err = null; render(); });
    el.querySelectorAll('[data-vd-edit]').forEach(function (b) { b.addEventListener('click', function () { vd.editing = b.dataset.vdEdit; vd.err = null; render(); }); });
    el.querySelectorAll('[data-vd-remove]').forEach(function (b) { b.addEventListener('click', function () { if (confirm('Remove this check?')) op({ op: 'remove', id: b.dataset.vdRemove }); }); });
    el.querySelectorAll('[data-vd-on]').forEach(function (i) { i.addEventListener('change', function () { op({ op: 'save', was: i.dataset.vdOn, check: { id: i.dataset.vdOn, on: i.checked } }); }); });
    el.querySelectorAll('[data-vd-blocks]').forEach(function (i) { i.addEventListener('change', function () { op({ op: 'save', was: i.dataset.vdBlocks, check: { id: i.dataset.vdBlocks, blocks: i.checked } }); }); });
    el.querySelectorAll('form.st-toolform[data-was]').forEach(function (f) {
      if (!f.querySelector('[data-vd-save]')) return;
      f.querySelector('[data-vd-cancel]').addEventListener('click', function () { vd.editing = null; vd.err = null; render(); });
      f.querySelector('[data-vd-save]').addEventListener('click', function () {
        var g = function (n) { var x = f.querySelector('[name=' + n + ']'); return x ? x.value : undefined; };
        var was = f.dataset.was, cur = ((vd.j && vd.j.checks) || []).find(function (c) { return c.id === was; });
        op({ op: 'save', was: was || null, check: { id: was || undefined, kind: cur && cur.kind === 'builtin' ? 'builtin' : g('kind'), gate: g('gate'), rule: g('rule'), command: g('command'), pattern: g('pattern'), name: g('name'), asks: g('asks'), why: g('why'), measures: g('measures'), fix: g('fix') } });
      });
    });
  }

  /* ---------- Cards ---------- */
  function cardsHtml() {
    var cards = Object.values(Layout.state.cards).filter(function (c) { return !c.plugin && (!c.home || (window.ROOM && window.ROOM.id === 'home')); });   // Home's own cards are listed on Home only
    if (!cards.length) return '<div class="small dim">No cards yet - open the Control room once.</div>';
    var body = '<div class="st-list">' + cards.sort(function (a, b) { return (b.global ? 1 : 0) - (a.global ? 1 : 0) || (a.pos || 0) - (b.pos || 0); }).map(function (c) {
      return '<div class="st-item' + (Layout.isHidden(c.id) ? '' : ' on') + '"><div class="st-item-hd"><b>' + esc(c.title) + '</b>' + (c.global ? ' <span class="pl-on">global</span>' : '') + '<span class="st-grow"></span><label class="sw"><input type="checkbox" data-card="' + esc(c.id) + '"' + (Layout.isHidden(c.id) ? '' : ' checked') + '><span class="swk"></span></label></div>'
        + '<div class="small dim">' + esc(c.purpose || '') + '</div></div>';
    }).join('') + '</div>';
    return body;
  }

  /* ---------- the page: a nav on the left, one section on the right ---------- */
  /* ---------- Icons: the theme for every card, and a pick per card ---------- */
  var iconOpen = null;   // the card whose palette is open
  function iconsHtml() {
    if (!window.Icons) return '';
    var I = window.Icons, cfg = I.cfg(), samples = ['conversation', 'files', 'fleet', 'tk-deploys'];
    var themes = '<div class="ic-themes">' + Object.keys(I.themes).map(function (t) {
      var th = I.themes[t], faces = samples.map(function (nm) { if (t === 'emoji') { var c = Layout.state.cards[nm]; return c && c.icon ? '<span class="ico ico-emoji">' + c.icon + '</span>' : I.svg(nm, 20, 'hand'); } return I.svg(nm, 20, t); }).join('');
      return '<button class="ic-theme' + (cfg.theme === t ? ' on' : '') + '" data-theme="' + t + '" title="' + esc(th.what) + '"><span class="ic-faces">' + faces + '</span><b>' + esc(th.name) + '</b></button>';
    }).join('') + '</div>';
    var cards = Object.values(Layout.state.cards).sort(function (a, b) { return a.title < b.title ? -1 : 1; });
    var list = '<div class="st-list">' + cards.map(function (c) {
      var o = cfg.per[c.id], how = !o ? 'the theme' : o.emoji ? 'emoji ' + o.emoji : ('the "' + (o.icon || c.id) + '" drawing' + (o.theme ? ', ' + (I.themes[o.theme] || {}).name : ''));
      var row = '<div class="st-item' + (iconOpen === c.id ? ' on' : '') + '"><div class="st-item-hd"><span class="ic-cur">' + I.of(c, 22) + '</span><b>' + esc(c.title) + '</b><span class="small dim">' + esc(how) + '</span><span class="st-grow"></span>' + (o ? '<span class="btn sm" data-icon-reset="' + esc(c.id) + '">theme default</span> ' : '') + '<span class="btn sm" data-icon-pick="' + esc(c.id) + '">' + (iconOpen === c.id ? 'close' : 'choose') + '</span></div>';
      if (iconOpen === c.id) {
        row += '<div class="ic-pal"><div class="small dim" style="margin:6px 0 4px">a drawing - in the theme, or in a hand of its own:</div>'
          + '<div class="ic-hands">' + Object.keys(I.themes).filter(function (t) { return t !== 'emoji'; }).map(function (t) { return '<span class="ic-hand' + (((o && o.theme) || cfg.theme) === t ? ' on' : '') + '" data-hand="' + t + '">' + esc(I.themes[t].name) + '</span>'; }).join('') + '</div>'
          + '<div class="ic-grid">' + Object.keys(I.paths).map(function (nm) { return '<span class="ic-opt' + (((o && o.icon) || c.id) === nm && !(o && o.emoji) ? ' on' : '') + '" data-icon="' + nm + '" title="' + nm + '">' + I.svg(nm, 22, (o && o.theme) || cfg.theme) + '</span>'; }).join('') + '</div>'
          + '<div class="ic-emoji"><span class="small dim">or an emoji:</span> <input class="ic-emoji-in" maxlength="4" value="' + esc(o && o.emoji || '') + '" placeholder="' + esc(c.icon || '') + '"> <span class="btn sm" data-emoji-use="' + esc(c.id) + '">use it</span>' + (c.icon ? ' <span class="btn sm" data-emoji-own="' + esc(c.id) + '">its own ' + c.icon + '</span>' : '') + '</div></div>';
      }
      return row + '</div>';
    }).join('') + '</div>';
    return section('icons', 'Icons', 'The face on every card - in its header, on the shelves, in the + Card picker. One choice for every project. Pick a theme for all of them, then change any card on its own.', themes + list);
  }
  function wireIcons(el) {
    var I = window.Icons; if (!I) return;
    el.querySelectorAll('[data-theme]').forEach(function (b) { b.addEventListener('click', function () { I.setTheme(b.dataset.theme).then(render); }); });
    el.querySelectorAll('[data-icon-pick]').forEach(function (b) { b.addEventListener('click', function () { iconOpen = iconOpen === b.dataset.iconPick ? null : b.dataset.iconPick; render(); }); });
    el.querySelectorAll('[data-icon-reset]').forEach(function (b) { b.addEventListener('click', function () { I.setCard(b.dataset.iconReset, null).then(render); }); });
    var pal = el.querySelector('.ic-pal'); if (!pal || !iconOpen) return;
    var id = iconOpen, cur = function () { return Object.assign({}, I.cfg().per[id] || {}); };
    pal.querySelectorAll('[data-hand]').forEach(function (h) { h.addEventListener('click', function () { var o = cur(); delete o.emoji; o.theme = h.dataset.hand; if (!o.icon) o.icon = id; I.setCard(id, o).then(render); }); });
    pal.querySelectorAll('[data-icon]').forEach(function (h) { h.addEventListener('click', function () { var o = cur(); delete o.emoji; o.icon = h.dataset.icon; I.setCard(id, o).then(render); }); });
    var use = pal.querySelector('[data-emoji-use]'); if (use) use.addEventListener('click', function () { var v = pal.querySelector('.ic-emoji-in').value.trim(); if (!v) return; I.setCard(id, { emoji: v }).then(render); });
    var own = pal.querySelector('[data-emoji-own]'); if (own) own.addEventListener('click', function () { var c = Layout.state.cards[id]; if (c && c.icon) I.setCard(id, { emoji: c.icon }).then(render); });
  }

  var meName = null, meRead = false;   // Settings > Project on Home: the name the greeting uses (Home's store, person "me")
  var SECTIONS = [['project', 'Project'], ['ai', 'AI'], ['engine', 'Engine'], ['plugins', 'Plugins and cards'], ['icons', 'Icons']];
  var current = 'project';
  function render() {
    var el = document.getElementById('plpage'); if (!el) return;
    var r = window.ROOM;
    if (!r || r.missing) { el.innerHTML = '<div class="empty">Open a project first.</div>'; return; }
    var pl = (r.plugins && r.plugins.available) || [];
    var urls = ((r.cockpit && r.cockpit.urls) || []).join(', ');
    var pending = pl.filter(function (p) { return p.selected && !p.configured && (p.questions || []).length && (Layout.state.coding || p.group !== 'coding'); }).length;
    var h = '<div class="st-page"><nav class="st-nav">' + SECTIONS.map(function (x) { return '<a href="#" class="' + (current === x[0] ? 'on' : '') + '" data-sec="' + x[0] + '">' + x[1] + (x[0] === 'plugins' && pending ? ' <span class="lg warn">' + pending + '</span>' : '') + '</a>'; }).join('') + '</nav><div class="st-main">';
    if (current === 'project' && r.id === 'home' && !meRead) { meRead = true; fetch('/api/p/home/layout?person=me').then(function (x) { return x.json(); }).then(function (m) { meName = m && m.name || null; render(); }).catch(function () { /* blank */ }); }
    if (current === 'project') h += section('project', 'Project', 'The name Cockpit shows for this project and where the site runs.',
      '<form class="plw" id="pj-form">'
      + '<label class="pq"><span class="pq-l">Name <span class="dim">- what Cockpit calls this project</span></span><input name="name" value="' + esc(r.name) + '"></label>'
      + '<label class="pq"><span class="pq-l">Site <span class="dim">- the site name and the direct host:port, comma-separated; shown as links on the Project card</span></span><input name="urls" value="' + esc(urls) + '" placeholder="https://my-app.local, http://localhost:3000"></label>'
      /* how the AI talks here (2026-10-31): full answers by default, the coding projects' five-line report once a coding plugin
         is on. Automatic says which applies; the other two pin it. Same rule as engine/prompt.js talkMode. Takes effect on the
         next message. */
      + (function () {
        var cj = r.cockpit || {}, t = cj.talk === 'open' || cj.talk === 'coding' ? cj.talk : '';
        var auto = (cj.plugins || []).some(function (x) { return ['coding', 'tickets', 'architecture', 'github'].indexOf(x) >= 0; }) ? 'Coding - a coding plugin is on' : 'Writing &amp; thinking - no coding plugin is on';
        return '<label class="pq"><span class="pq-l">How its AI answers you <span class="dim">- Writing &amp; thinking = full answers, like a collaborator; Coding = a short report (done or not, tests, yes/no questions). Automatic switches to Coding when a coding plugin is turned on.</span></span><select name="talk">'
          + '<option value=""' + (t ? '' : ' selected') + '>Automatic (now: ' + auto + ')</option><option value="open"' + (t === 'open' ? ' selected' : '') + '>Writing &amp; thinking</option><option value="coding"' + (t === 'coding' ? ' selected' : '') + '>Coding</option></select></label>';
      })()
      + '<div class="plw-bar"><span class="btn" id="pj-save">Save</span><span class="small dim" id="pj-msg"></span></div></form>'
      + (r.id === 'home' ? '<form class="plw" id="me-form" style="margin-top:14px"><label class="pq"><span class="pq-l">Your name <span class="dim">- how the greeting on the window addresses you (blank: the engine\'s person key)</span></span><input name="me" value="' + esc(meName || '') + '" placeholder="Alex"></label><div class="plw-bar"><span class="btn" id="me-save">Save</span><span class="small dim" id="me-msg"></span></div></form>' : ''));
    if (current === 'ai') h += aiHtml();
    if (current === 'engine') h += toolsHtml();
    if (current === 'plugins') h += pluginsHtml(r, pl);
    if (current === 'icons') h += iconsHtml();
    el.innerHTML = h + '</div></div>';
    el.querySelectorAll('[data-sec]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); current = a.dataset.sec; render(); }); });
    if (current === 'icons') wireIcons(el);

    el.querySelectorAll('[data-connect]').forEach(function (b) { b.addEventListener('click', loadModels); });
    vdWire(el);
    var reloadTools = function () { aiTools.cfg = null; aiTools.editing = null; aiTools.err = null; models.list = null; render(); };
    var toolOp = function (body) { return post('/api/harnesses/tools', body).then(function (r) { if (!r.ok) { aiTools.err = r.error; render(); return false; } return true; }); };
    var ta = el.querySelector('[data-tool-add]'); if (ta) ta.addEventListener('click', function () { aiTools.editing = '__pick'; aiTools.err = null; render(); });
    el.querySelectorAll('[data-preset]').forEach(function (p) { p.addEventListener('click', function () { aiTools.editing = p.dataset.preset === '__blank' ? '__new' : 'preset:' + p.dataset.preset; aiTools.err = null; render(); }); });
    el.querySelectorAll('[data-ask-ai]').forEach(function (b) { b.addEventListener('click', function () {
      var name = prompt('Which AI are you adding? The name of its command-line tool, or a link to it.'); if (!name) return;
      if (!window.sendToConversation) { alert('open the Control room first - the conversation card there sends it'); return; }
      window.sendToConversation('I am adding a command-line AI to Cockpit\'s Settings › AI: ' + name + '. On this machine, find its command and read its --help (install it only if I say so - tell me if it is missing). Then give me, as six lines I can copy into the Add form: Name, Command, Arguments (with {prompt} where the prompt text goes and {model} where the model id goes; the flags that make it answer without asking questions), Models (comma-separated ids, id=Label), Install page, Sign-in command. Do not write engine/harnesses/custom.json yourself.', {});
      if (window.showView) window.showView('room'); else { var a = document.querySelector('.nav a[data-view="room"]'); if (a) a.click(); }
    }); });
    el.querySelectorAll('.st-toolform [data-act="cancel-tool"]').forEach(function (b) { b.addEventListener('click', function () { aiTools.editing = null; aiTools.err = null; render(); }); });
    el.querySelectorAll('[data-tool-edit]').forEach(function (b) { b.addEventListener('click', function () { aiTools.editing = b.dataset.toolEdit; aiTools.err = null; render(); }); });
    el.querySelectorAll('[data-tool-remove]').forEach(function (b) { b.addEventListener('click', function () { if (!confirm('Remove this tool from Cockpit? (nothing is uninstalled)')) return; toolOp({ op: 'remove', name: b.dataset.toolRemove }).then(function (ok) { if (ok) reloadTools(); }); }); });
    el.querySelectorAll('[data-tool-on]').forEach(function (i) { i.addEventListener('change', function () { toolOp({ op: i.checked ? 'on' : 'off', name: i.dataset.toolOn }).then(function (ok) { if (ok) reloadTools(); }); }); });
    el.querySelectorAll('form.st-toolform').forEach(function (f) {
      f.querySelector('[data-act="save-tool"]').addEventListener('click', function () {
        var v = function (n) { return f.querySelector('[name=' + n + ']').value; };
        var mods = v('models').split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) { var p = x.split('='); return { id: p[0].trim(), label: (p[1] || p[0]).trim() }; });
        toolOp({ op: 'save', was: f.dataset.was || null, tool: { label: v('label'), name: f.dataset.was || v('label'), command: v('command'), args: v('args'), models: mods, site: v('site'), signin: v('signin') } }).then(function (ok) { if (ok) reloadTools(); });
      });
    });
    el.querySelectorAll('[data-edit-models]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); models.editing = a.dataset.editModels; models.msg = {}; render(); }); });
    el.querySelectorAll('form.st-mform').forEach(function (f) {
      f.querySelectorAll('[data-rm]').forEach(function (x) { x.addEventListener('click', function () { x.parentNode.remove(); }); });
      f.querySelector('[data-act="add-model"]').addEventListener('click', function () { var d = document.createElement('div'); d.innerHTML = modelRowHtml({ id: '', label: '' }); var row = d.firstChild; f.insertBefore(row, f.querySelector('.plw-bar')); row.querySelector('[data-rm]').addEventListener('click', function () { row.remove(); }); row.querySelector('[name=id]').focus(); });
      f.querySelector('[data-act="cancel-models"]').addEventListener('click', function () { models.editing = null; render(); });
      f.querySelector('[data-act="save-models"]').addEventListener('click', function () {
        var rows = []; f.querySelectorAll('.st-mrow2:not(.st-mhead)').forEach(function (row) { var id = row.querySelector('[name=id]').value.trim(), lb = row.querySelector('[name=label]').value.trim(), cx = Number(row.querySelector('[name=ctx]').value) || 200000; if (id) rows.push({ id: id, label: lb || id, contextTokens: cx }); });
        post('/api/harnesses/models?name=' + encodeURIComponent(f.dataset.h), { models: rows }).then(function (res) { if (!res.ok) { alert(res.error); return; } models.editing = null; models.msg[f.dataset.h] = 'saved - the picker in the header offers this list now'; loadModels(); });
      });
    });
    var ea = el.querySelector('#eng-auto'); if (ea) ea.addEventListener('change', function () {
      var on = ea.checked; wzst.busy = on ? 'setting it up…' : 'turning it off…'; wzst.msg = null; render();
      post('/api/wizard/startup', { on: on }).then(function (res) { wzst.busy = null; wzst.ok = !!res.ok; wzst.msg = res.ok ? (on ? 'On - Cockpit starts by itself when you sign in.' : 'Off - start it with "Start Cockpit" in its folder.') + (res.note ? ' ' + res.note : '') : res.error; wzst.st = null; render(); })
        .catch(function (e) { wzst.busy = null; wzst.ok = false; wzst.msg = String(e.message || e); render(); });
    });
    var co = el.querySelector('#coding-on'); if (co) co.addEventListener('change', function () {
      co.disabled = true;
      post('/api/engine/coding', { on: co.checked }).then(function (res) { if (!res.ok) { alert(res.error); co.checked = !co.checked; co.disabled = false; return; } location.reload(); })   // every card script and desk is laid out again with the new gate
        .catch(function (e) { alert(String(e.message || e)); co.disabled = false; });
    });
    var sh = el.querySelector('#setup-show'); if (sh) sh.addEventListener('click', function () { if (!window.cvSetup) return; sh.textContent = 'it is back in Home\'s conversation'; window.cvSetup.show(); });
    var wa = el.querySelector('#wz-again'); if (wa) wa.addEventListener('click', function () { if (window.Wizard) window.Wizard.open(0); });
    var wt = el.querySelector('#wz-tour'); if (wt) wt.addEventListener('click', function () { var h = document.getElementById('navhome'); if (h) h.click(); setTimeout(function () { if (window.Wizard) window.Wizard.tour(); }, 900); });   // the tour points at Home's parts
    var es = el.querySelector('#eng-stop'); if (es) es.addEventListener('click', function () {
      if (!confirm('Stop Cockpit? It stops running in the background. Start it again with "Start Cockpit" in its folder.')) return;
      fetch('/api/engine/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(function () { document.body.innerHTML = '<div style="font:16px system-ui;color:#aab;padding:60px;text-align:center">Cockpit is stopped.<br><br>Start it again with <b>Start Cockpit</b> in its folder.</div>'; });
    });
    var tf = el.querySelector('#tools-fetch'); if (tf) tf.addEventListener('click', function () { tf.textContent = 'starting…'; fetch('/api/tools', { method: 'POST' }).then(function (x) { return x.json(); }).then(function (res) { if (!res.ok) alert(res.error); tools.st = null; loadTools(); }); });
    var pjs = el.querySelector('#pj-save'); if (pjs) pjs.addEventListener('click', function () {
      var f = el.querySelector('#pj-form'), body = { name: f.querySelector('[name=name]').value.trim(), urls: f.querySelector('[name=urls]').value };
      var tk = f.querySelector('[name=talk]'); if (tk) body.talk = tk.value;
      if (!body.name) { el.querySelector('#pj-msg').textContent = 'a name is needed'; return; }
      fetch('/api/projects/' + encodeURIComponent(r.id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (x) { return x.json(); })
        .then(function (res) { el.querySelector('#pj-msg').textContent = res.ok ? 'saved' : (res.error || 'could not save'); if (res.ok && window.ROOM && body.name) { window.ROOM.name = body.name; var sw = document.getElementById('swname'); if (sw) sw.textContent = body.name; document.title = body.name; } if (res.ok && window.reloadRoom) window.reloadRoom(); });   // the name shows at once; the room follows
    });
    var mes = el.querySelector('#me-save'); if (mes) mes.addEventListener('click', function () {
      var name = el.querySelector('#me-form [name=me]').value.trim();
      fetch('/api/p/home/layout?person=me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) }).then(function (x) { return x.json(); })
        .then(function (res) { el.querySelector('#me-msg').textContent = res.ok ? 'saved - the window says so now' : (res.error || 'could not save'); if (res.ok) { meName = name || null; if (window.__hgName) window.__hgName(name); } });
    });
    el.querySelectorAll('.sw input[data-p]').forEach(function (i) { i.addEventListener('change', function () {
      var name = i.dataset.p;
      var call = i.checked ? post(Layout.state.api + '/plugins/' + name + '/select', { answers: {} }) : post(Layout.state.api + '/plugins/' + name + '/deselect');
      call.then(function () { if (window.reloadRoom) window.reloadRoom(); });
    }); });
    el.querySelectorAll('[data-cfg]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); open[a.dataset.cfg] = !open[a.dataset.cfg]; render(); }); });
    el.querySelectorAll('.plw-wrap').forEach(function (w) { window.PluginUI.wire(w, function () { Object.keys(open).forEach(function (k) { delete open[k]; }); }, function () { Object.keys(open).forEach(function (k) { delete open[k]; }); render(); }); });
    el.querySelectorAll('input[data-card]').forEach(function (i) { i.addEventListener('change', function () { Layout.show(i.dataset.card, i.checked); render(); }); });
  }
  window.renderPluginsPage = render;
  window.openSettings = function (sec) { current = SECTIONS.some(function (x) { return x[0] === sec; }) ? sec : current; render(); };   // a link straight to one section (the card picker sends you to Plugins and cards)
})();
