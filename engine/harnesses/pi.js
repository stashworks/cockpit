/* Pi as a harness - for the LOCAL model only (docs/generic-ide.md §4: "use pi only for the
   local, so each one has its own harness"). Pi gives the model read / write / edit / bash
   whatever the model is, which is the thing the local model never had. Runs Pi in print
   mode in the project folder against the machine's own Ollama (localhost by default - the engine
   runs where the models are; OLLAMA_HOST_URL points elsewhere), and maps its output onto the interface.

   Models are whatever Ollama has loaded; asked for live, cached a minute. Pi reaches Ollama
   as an OpenAI-compatible provider declared in ~/.pi/agent/models.json - see setupNote().

   Everything below is written against Pi's documented CLI (print / JSON mode, --provider,
   --model, --append-system-prompt, --no-session) and is verified against the real binary
   through the probe before it is counted on (docs/generic-ide.md §4: "verify Ollama tool
   calling first"). Where Pi's JSON shape differs, this file is the only one that changes. */
'use strict';
const cp = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const toolLog = (turn, h, ev) => { try { require('../toollog').log(turn, h, ev); } catch (e) { /* never fails a turn */ } };

const OLLAMA = process.env.OLLAMA_HOST_URL || 'http://localhost:11434';
// on `global` so a re-read of this file keeps it (D6, 2026-09-30)
let modelCache = global.__cockpitPiModels || (global.__cockpitPiModels = { at: 0, list: [] });

/* Ollama is asked over HTTP from node itself - no curl, no PATH assumptions: the engine may run
   as a scheduled task or service whose environment is not a user's shell (it once said
   "no models or not running" while ollama serve was up on 0.0.0.0:11434). Synchronous on
   purpose (a harness check is synchronous in the interface); bounded to 4 s. */
function ollamaModels() {
  if (Date.now() - modelCache.at < 60000) return modelCache.list;
  /* D6 (2026-09-30): after the first answer, a stale list is returned at once and refreshed IN this process with an async
     request - lagwatch measured the synchronous child at up to 1.4 s a minute. Only the first ask in a process waits. */
  if (modelCache.at) {
    if (!modelCache.refreshing) {
      modelCache.refreshing = true;
      const done = (list, err) => { modelCache = global.__cockpitPiModels = { at: Date.now(), list, err }; };
      const req = http.get(OLLAMA + '/api/tags', (r) => { let s = ''; r.on('data', (d) => { s += d; }); r.on('end', () => { try { done((JSON.parse(s).models || []).map((m) => ({ id: m.name, label: m.name + ' (local)', contextTokens: 32000, free: true })), null); } catch (e) { done([], 'unreadable answer: ' + e.message); } }); });
      req.on('error', (e) => done([], String(e.message).slice(0, 200)));
      req.setTimeout(4000, () => req.destroy(new Error('timeout')));
    }
    return modelCache.list;
  }
  let list = [], err = null;
  try {
    const out = cp.execFileSync(process.execPath, ['-e',
      'const http=require("node:http");const u=process.argv[1];const req=http.get(u,(r)=>{let s="";r.on("data",(d)=>s+=d);r.on("end",()=>{process.stdout.write(s)})});req.on("error",(e)=>{process.stderr.write(String(e.message));process.exit(2)});req.setTimeout(4000,()=>{req.destroy(new Error("timeout"))});',
      OLLAMA + '/api/tags'], { encoding: 'utf8', timeout: 6000, windowsHide: true });
    const j = JSON.parse(out);
    list = (j.models || []).map((m) => ({ id: m.name, label: m.name + ' (local)', contextTokens: 32000, free: true }));
  } catch (e) { err = String(e.stderr || e.message).slice(0, 200); }
  modelCache = global.__cockpitPiModels = { at: Date.now(), list, err };
  return list;
}
function models() { const l = ollamaModels(); return l.length ? l : [{ id: 'none', label: 'no local model - is Ollama running?', contextTokens: 8000, free: true }]; }

function available() {
  const pv = require('../spawn-cli').versionOf('pi');   // kept 10 min, refreshed in the background (D6)
  if (!pv.ok) return pv;
  const v = pv.why;
  const m = ollamaModels();
  if (!m.length) return { ok: false, why: v + ' - but Ollama at ' + OLLAMA + (modelCache.err ? ' did not answer: ' + modelCache.err : ' has no models') };
  const prov = ensureProvider(m);
  if (!prov.ok) return { ok: false, why: v + ' - could not write ' + prov.file + ': ' + prov.error };
  return { ok: true, why: v + ' · ' + m.length + ' local model' + (m.length === 1 ? '' : 's') + (prov.changed ? ' · provider written' : '') };
}
function probe(what) {
  if (what === 'setup') return setup();
  if (what === 'ollama') { modelCache.at = 0; const l = ollamaModels(); return { ok: !modelCache.err, models: l.map((m) => m.id), error: modelCache.err || null, url: OLLAMA }; }
  if (what === 'auth') { try { return { ok: true, text: cp.execSync('pi auth check ollama', { encoding: 'utf8', timeout: 20000, windowsHide: true }) }; } catch (e) { return { ok: false, error: String(e.stdout || e.stderr || e.message).slice(0, 800) }; } }
  /* Read Pi's own installed docs for a term (models.json, provider…), so the adapter is
     written against what THIS Pi expects, not a README from the web. Read-only. */
  if (what === 'doc' || what.startsWith('doc:')) {
    const fs = require('node:fs');
    let root; try { root = path.dirname(cp.execSync('pi --version >nul 2>&1 && where pi', { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true }).split(/\r?\n/)[0]); } catch (e) { return { ok: false, error: 'where pi failed' }; }
    const pkg = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
    if (what.startsWith('doc:')) {   // one named file from the package, bounded
      const [rel, off] = what.slice(4).split('@');          // doc:docs/rpc.md@20000 - a later window
      const f = path.resolve(pkg, rel);
      if (!f.startsWith(pkg)) return { ok: false, error: 'outside the package' };
      try { const t = fs.readFileSync(f, 'utf8'); const o = Number(off) || 0; return { ok: true, file: rel, length: t.length, offset: o, text: t.slice(o, o + 20000) }; } catch (e) { return { ok: false, error: e.code || e.message }; }
    }
    const hits = [];
    const walk = (d, depth) => { if (depth > 3 || hits.length > 40) return; let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f, depth + 1); } else if (/\.md$/i.test(e.name)) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (x) { continue; } let i = -1; while ((i = t.indexOf('models.json', i + 1)) >= 0 && hits.length < 40) { hits.push({ file: path.relative(pkg, f), text: t.slice(Math.max(0, i - 200), i + 1400) }); i += 1400; } } } };
    walk(pkg, 0);
    return { ok: true, pkg, hits };
  }
  try { return { ok: true, text: cp.execSync('pi ' + (what === 'version' ? '--version' : '--help'), { encoding: 'utf8', timeout: 20000, windowsHide: true }) }; }
  catch (e) { return { ok: false, error: String(e.stdout || e.stderr || e.message).slice(0, 1500) }; }
}
/* Pi sees Ollama only through a provider entry in ~/.pi/agent/models.json (its docs/models.md,
   read from the installed package 2026-09-16). The engine keeps that entry itself - the
   provider block plus whatever models Ollama has right now - on the machine it runs on.
   Anything else in the file (other providers, the owner's own entries) is left untouched;
   the file is rewritten only when the ollama entry actually changes. */
function ensureProvider(list) {
  const fs = require('node:fs'), os = require('node:os');
  const dir = path.join(os.homedir(), '.pi', 'agent'), file = path.join(dir, 'models.json');
  let j = {}; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { j = {}; }
  j.providers = j.providers || {};
  const want = { baseUrl: OLLAMA + '/v1', api: 'openai-completions', apiKey: 'ollama',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: list.map((m) => ({ id: m.id })) };
  const have = j.providers.ollama;
  if (have && JSON.stringify(have) === JSON.stringify(want)) return { ok: true, changed: false, file };
  j.providers.ollama = want;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n'); return { ok: true, changed: true, file }; }
  catch (e) { return { ok: false, error: e.message, file }; }
}
function setup() {
  const av = available(); modelCache.at = 0; const l = ollamaModels();
  return {
    installed: av.ok || !/not on PATH/i.test(av.why || ''), version: av.ok ? av.why.split(' - ')[0] : null, why: av.ok ? null : av.why,
    account: modelCache.err ? { ok: false, why: 'Ollama at ' + OLLAMA + ' did not answer: ' + modelCache.err } : { ok: true, who: 'Ollama at ' + OLLAMA + ' (local, free)' },
    models: l.map((m) => m.id),
    connect: [
      /not on PATH/i.test(av.why || '') ? 'Install Pi on this machine: npm install -g @mariozechner/pi-coding-agent (an install - ask the owner first).' : null,
      modelCache.err ? 'Start Ollama on this machine (ollama serve, or the Ollama app); the engine reads ' + OLLAMA + '/api/tags. Another address: set OLLAMA_HOST_URL for the Node server.' : null,
      !l.length && !modelCache.err ? 'Ollama has no models yet: ollama pull qwen3-coder:30b (or any chat model that fits the card) - a download, not an install.' : null,
      'One local turn at a time, engine-wide (the card\'s memory). ' + setupNote()
    ].filter(Boolean)
  };
}
function setupNote() { return 'Pi reaches Ollama through ~/.pi/agent/models.json; the engine writes the ollama provider there itself.'; }

function start(turn) {
  const listeners = [];
  const on = (fn) => listeners.push(fn);
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  let ended = false, endReason = null;

  /* RPC mode (Pi's docs/rpc.md, read from the installed package 2026-09-16): commands go in
     on stdin as JSON lines, events come out on stdout as JSON lines, LF-delimited only.
     The prompt travels as JSON, so its size and its newlines are no one's problem - the
     print-mode attempt lost the message entirely on Windows. The system tiers still go in
     as a file through --append-system-prompt. Pi is asked to stop after the run settles. */
  const fs = require('node:fs');
  const tmp = path.join(turn.project, '.cockpit', 'cache'); try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) { /* exists */ }
  const sysFile = path.join(tmp, 'pi-system.md'); fs.writeFileSync(sysFile, turn.system || '');
  const args = ['--mode', 'rpc', '--no-session', '--provider', 'ollama', '--model', turn.model, '--append-system-prompt', sysFile];
  const failed = (msg) => { setTimeout(() => emit({ type: 'error', text: msg }), 0); return { on, done: new Promise((r) => setTimeout(() => r({ reason: 'crashed' }), 5)), stop: () => {} }; };
  let child;
  try { child = launcher().spawn('pi', args, { cwd: turn.project, stdio: ['pipe', 'pipe', 'pipe'], env: turn.env || process.env }); }
  catch (e) { return failed('could not start pi: ' + e.message); }
  child.stdin.on('error', () => { /* a child that died at once: its close handler reports the turn; an unheard EPIPE would take the engine down (2026-09-30) */ });
  child.stdin.write(JSON.stringify({ id: 'turn', type: 'prompt', message: turn.prompt }) + '\n');

  let buf = '', errText = '', unknownSeen = {}, lastUsage = null;
  child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line.trim()) handle(line); } });
  child.stderr.on('data', (d) => { errText += d.toString('utf8'); });

  function handle(line) {
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    const t = j.type || '';
    if (t === 'response') { if (j.command === 'prompt' && j.success === false) { emit({ type: 'error', text: 'pi refused the prompt: ' + (j.error || '') }); finish('crashed'); } return; }
    if (t === 'message_update') {
      if (j.usage) lastUsage = j.usage;
      const ev = j.assistantMessageEvent || {};
      if (ev.type === 'text_delta' && ev.delta) emit({ type: 'text', text: ev.delta });
      // thinking deltas are the harness's business - not carried
    } else if (t === 'tool_execution_start') {
      const inp = j.args || {};
      emit({ type: 'tool', name: j.toolName || 'tool', input: String(inp.path || inp.file_path || inp.command || JSON.stringify(inp)).slice(0, 160), id: j.toolCallId, ok: null });
      toolLog(turn, 'pi', { name: j.toolName || 'tool', id: j.toolCallId, full: inp.command || inp.path || inp.file_path || JSON.stringify(inp) });   // every command kept (engine/toollog.js)
      const fp = inp.path || inp.file_path;
      if (fp && /^(write|edit)$/i.test(j.toolName || '')) emit({ type: 'file', path: rel(turn.project, fp), change: /write/i.test(j.toolName) ? 'written' : 'edited' });
    } else if (t === 'tool_execution_end') {
      const out = ((j.result && j.result.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      emit({ type: 'tool', name: null, id: j.toolCallId, ok: !j.isError, output: out.slice(0, 400) });
      toolLog(turn, 'pi', { id: j.toolCallId, ok: !j.isError, output: out });
    } else if (t === 'agent_settled') {
      const u = lastUsage;
      if (u) emit({ type: 'cost', inTokens: u.input || 0, outTokens: u.output || 0, cacheRead: u.cacheRead || 0, usd: 0 });
      finish('done');
    } else if (t === 'extension_error' || t === 'error') {
      emit({ type: 'error', text: j.message || j.error || 'pi reported an error' });
    } else if (t && !unknownSeen[t] && !/^(agent_start|agent_end|turn_start|turn_end|message_start|message_end|tool_execution_update|queue_update|session)$/.test(t)) {
      unknownSeen[t] = 1; emit({ type: 'info', text: 'pi event not mapped: ' + t });
    }
  }
  // RPC mode does not exit on its own; when the run has settled, close stdin and let it go.
  function finish(reason) { if (ended) return; endReason = reason; try { child.stdin.end(); } catch (e) { /* closed */ } setTimeout(() => { if (!ended) stop(reason); }, 1500); }

  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      if (buf.trim()) handle(buf.trim());
      if (!endReason) endReason = code === 0 ? 'done' : 'crashed';
      if (endReason === 'crashed' && errText.trim()) emit({ type: 'error', text: errText.trim().slice(0, 600) });
      ended = true; resolve({ reason: endReason, code });
    });
    child.on('error', (e) => { emit({ type: 'error', text: 'could not start pi: ' + e.message }); endReason = 'crashed'; ended = true; resolve({ reason: 'crashed' }); });
  });
  function stop(reason) {
    if (ended) return;
    endReason = reason || 'stopped';
    if (process.platform === 'win32') { try { cp.execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch (e) { child.kill(); } }
    else child.kill('SIGTERM');
  }
  return { on, done, stop, pid: child.pid };   // the watchdog looks at this process's family before calling a quiet turn stuck (engine/harness.js)
}
function launcher() { const f = path.join(__dirname, '..', 'spawn-cli.js'); delete require.cache[require.resolve(f)]; return require(f); }
function rel(root, p) { try { const r = path.relative(root, p); return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p; } catch (e) { return p; } }

module.exports = { setup, name: 'pi', label: 'Pi (local)', models, available, start, probe, setupNote };
