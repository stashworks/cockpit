/* Codex CLI as a harness - OpenAI's own, on the owner's ChatGPT/Codex subscription
   (docs/generic-ide.md §4: each model on its vendor's own safe path). Runs `codex exec`
   headless in the project folder with JSONL output, and maps its events onto the interface.
   This file is the only place that knows what a Codex event looks like (rule 8).

   Transcript in, never a session id (rule 2): the whole prompt goes in on stdin.
   Tools: Codex's own (shell, file edits). Cockpit's tools are the cli, run through Codex's
   shell, unsandboxed (see start(): the Windows sandbox cannot run under the service).

   Event shapes (codex exec --json, JSONL), as documented at the time of writing:
     {"type":"thread.started","thread_id":...}
     {"type":"turn.started"}
     {"type":"item.started"|"item.completed","item":{"type":"agent_message","text":...}}
     {"type":"item.completed","item":{"type":"command_execution","command":...,"aggregated_output":...,"exit_code":...}}
     {"type":"item.completed","item":{"type":"file_change","changes":[{"path":...,"kind":"add|update|delete"}]}}
     {"type":"item.completed","item":{"type":"reasoning",...}}          - not carried
     {"type":"turn.completed","usage":{"input_tokens":..,"cached_input_tokens":..,"output_tokens":..}}
     {"type":"turn.failed","error":{"message":...}} | {"type":"error","message":...}
   Anything else is logged as info once, never as an error - a new event type is not a failure. */
'use strict';
const cp = require('node:child_process');
const path = require('node:path');
const toolLog = (turn, h, ev) => { try { require('../toollog').log(turn, h, ev); } catch (e) { /* never fails a turn */ } };

/* Which models a ChatGPT account may use changes without notice and is not queryable from
   the CLI; a guessed name returned 400 "not supported when using Codex with a ChatGPT
   account" (2026-09-16). So the first choice is the account's DEFAULT - no --model passed,
   Codex picks - and the named ones are offered for when the owner knows better. */
/* The list is DATA - codex-cli.models.json beside this file - edited by the owner, read on
   every call, never hard-coded. */
function MODELS() {
  try { return JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'codex-cli.models.json'), 'utf8')).models.map((m) => ({ free: false, ...m })); }
  catch (e) { return [{ id: 'default', label: 'Codex default (models.json unreadable: ' + e.message + ')', contextTokens: 400000, free: false }]; }
}

function available() { return require('../spawn-cli').versionOf('codex'); }   // kept 10 min, refreshed in the background (D6)
function setup() {
  const av = available(); let account = { ok: false, why: 'not logged in' };
  if (av.ok) { try { const t = cp.execSync('codex login status 2>&1', { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true }).trim();   /* it prints its status on stderr */ account = /logged in/i.test(t) ? { ok: true, who: t.split('\n')[0] } : { ok: false, why: t.split('\n')[0] || 'not logged in' }; } catch (e) { account = { ok: false, why: String(e.stdout || e.stderr || e.message).split('\n')[0].slice(0, 160) }; } }
  return {
    installed: av.ok, version: av.ok ? av.why : null, why: av.ok ? null : av.why, account,
    models: MODELS().map((m) => m.id),
    connect: [
      av.ok ? null : 'Install the Codex CLI on this machine: npm install -g @openai/codex (an install - ask the owner first).',
      account.ok ? null : 'Log in once, as the user the Node server runs as: run  codex login  in a terminal on this machine (browser sign-in with the ChatGPT account whose plan pays for it).',
      'Usage windows are read from Codex itself (app-server); the fleet card shows them next to the agent.'
    ].filter(Boolean)
  };
}
function probe(what) {
  if (what === 'setup') return setup();
  try { return { ok: true, text: cp.execSync('codex ' + (what === 'version' ? '--version' : what === 'exec' ? 'exec --help' : what === 'login' ? 'login status' : '--help'), { encoding: 'utf8', timeout: 20000, windowsHide: true }) }; }
  catch (e) { return { ok: false, error: String(e.stdout || e.stderr || e.message).slice(0, 1200) }; }
}

function start(turn) {
  const listeners = [];
  const on = (fn) => listeners.push(fn);
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  let said = false;   // a message went out already: the next starts a new paragraph
  let ended = false, endReason = null;

  // The system tiers ride the prompt: codex exec has no --append-system-prompt equivalent
  // that is stable across versions, and one message with the tiers first is the same thing.
  const fullPrompt = (turn.system ? '<instructions>\n' + turn.system + '\n</instructions>\n\n' : '') + turn.prompt;
  const args = ['exec', '--json'].concat(turn.model && turn.model !== 'default' ? ['--model', turn.model] : [])
    /* No sandbox, on purpose (2026-09-18). Codex's Windows sandbox runs commands under a restricted token; under the PM2
       service (session 0, no desktop) that token cannot even start node.exe - exit -1073741502, STATUS_DLL_INIT_FAILED -
       so a Codex turn could run nothing, Cockpit's cli included. Claude's turns already run with full tools; the
       project's rules and the write-time gate are the boundary here too, not a sandbox. */
    .concat(['--sandbox', 'danger-full-access', '--skip-git-repo-check', '--cd', turn.project])
    /* RETRIES THAT REMEMBER: a retry of the same ticket on this harness resumes the first try's thread
       (`codex exec … resume <id>`, the prompt still on stdin) so it starts with everything it already read. The transcript
       goes in as well (rule 2): a lost thread or another harness starts from Cockpit's record. */
    /* pictures (2026-09-25): codex exec attaches them with -i <file>; they are written to the temp folder for this turn only
       (checked with a test image: it answered its colour) */
    .concat(picFiles(turn).flatMap((f) => ['-i', f]))
    .concat(turn.resume ? ['resume', String(turn.resume)] : ['-']);
  const failed = (msg) => { setTimeout(() => emit({ type: 'error', text: msg }), 0); return { on, done: new Promise((r) => setTimeout(() => r({ reason: 'crashed' }), 5)), stop: () => {} }; };
  let child;
  try { child = launcher().spawn('codex', args, { cwd: turn.project, stdio: ['pipe', 'pipe', 'pipe'], env: turn.env || process.env }); }
  catch (e) { return failed('could not start codex: ' + e.message); }
  child.stdin.on('error', () => { /* a child that died at once: its close handler reports the turn; an unheard EPIPE would take the engine down (2026-09-30) */ });
  child.stdin.end(fullPrompt);

  let buf = '', errText = '', unknownSeen = {};
  child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); } });
  child.stderr.on('data', (d) => { errText += d.toString('utf8'); });

  function handle(line) {
    let j; try { j = JSON.parse(line); } catch (e) { return; }   // codex prints non-JSON progress lines too
    const t = j.type || '';
    if (t === 'item.completed' || t === 'item.started') {
      const it = j.item || {};
      if (it.type === 'agent_message' && t === 'item.completed' && it.text) { emit({ type: 'text', text: (said ? '\n\n' : '') + it.text }); said = true; }   // each message is its own paragraph
      else if (it.type === 'command_execution' && t === 'item.started') { emit({ type: 'tool', name: 'shell', input: String(it.command || '').slice(0, 160), id: it.id, ok: null }); toolLog(turn, 'codex-cli', { name: 'shell', id: it.id, full: it.command || '' }); }   // every command kept (engine/toollog.js)
      else if (it.type === 'command_execution' && t === 'item.completed') { emit({ type: 'tool', name: null, id: it.id, ok: it.exit_code === 0 || it.exit_code == null, output: String(it.aggregated_output || '').slice(0, 400) }); toolLog(turn, 'codex-cli', { id: it.id, ok: it.exit_code === 0 || it.exit_code == null, output: it.aggregated_output || '' }); }
      else if (it.type === 'file_change' && t === 'item.completed') (it.changes || []).forEach((c) => emit({ type: 'file', path: rel(turn.project, c.path), change: c.kind === 'add' ? 'written' : c.kind === 'delete' ? 'deleted' : 'edited' }));
    } else if (t === 'turn.completed') {
      const u = j.usage || {};
      emit({ type: 'cost', inTokens: (u.input_tokens || 0), outTokens: u.output_tokens || 0, cacheRead: u.cached_input_tokens || 0, usd: null });
    } else if (t === 'turn.failed' || t === 'error') {
      emit({ type: 'error', text: (j.error && j.error.message) || j.message || 'codex reported an error' });
    } else if (t === 'thread.started') {
      if (j.thread_id && turn.keepSession) emit({ type: 'session', id: String(j.thread_id), resumed: !!turn.resume });
      emit({ type: 'info', text: 'codex ' + turn.model + ' in ' + turn.project + (turn.resume ? ' · resumed thread ' + String(turn.resume).slice(0, 8) : '') });
    } else if (t && !unknownSeen[t] && !/^(turn\.started|item\.)/.test(t)) {
      unknownSeen[t] = 1; emit({ type: 'info', text: 'codex event not mapped: ' + t });
    }
  }

  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      if (buf.trim()) handle(buf.trim());
      if (!endReason) endReason = code === 0 ? 'done' : 'crashed';
      if (endReason === 'crashed' && errText.trim()) emit({ type: 'error', text: errText.trim().slice(0, 600) });
      ended = true; resolve({ reason: endReason, code });
    });
    child.on('error', (e) => { emit({ type: 'error', text: 'could not start codex: ' + e.message }); endReason = 'crashed'; ended = true; resolve({ reason: 'crashed' }); });
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

/* THE PLAN'S OWN READING. `codex exec --json` carries no rate limits (checked against
   exec_events.rs, 2026-09-16), but the same binary has an app-server mode whose
   `account/rateLimits/read` answers with exact percentages for both windows:
     { rateLimits: { primary:   { usedPercent, windowDurationMins, resetsAt },   // the 5-hour
                     secondary: { usedPercent, windowDurationMins, resetsAt },   // the weekly
                     planType, ... } }
   Newline-delimited JSON-RPC over stdio, the way the official SDK talks to it: initialize,
   the `initialized` notification, then the read. One short-lived process per ask, killed
   as soon as it answers; 20 s and it is reported as unknown rather than guessed. */
function usage() {
  return new Promise((resolve) => {
    let child, out = '', done = false;
    const finish = (r) => { if (done) return; done = true; try { child && child.kill(); } catch (e) {} resolve(r); };
    try { child = launcher().spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return resolve({ ok: false, why: 'could not start codex app-server: ' + e.message }); }
    const timer = setTimeout(() => finish({ ok: false, why: 'codex app-server did not answer in 20 s' }), 20000);
    child.on('error', (e) => finish({ ok: false, why: e.message }));
    child.on('close', () => finish({ ok: false, why: 'codex app-server exited before answering' }));
    /* a write to a child that already exited raises EPIPE on its stdin; with no listener Node treats it as uncaught and the
       WHOLE ENGINE exits (2026-09-30 23:15 UTC: cockpit exited code 1, the error log ending in two write EPIPE at this
       probe - it runs while Codex sits held on its usage floor) */
    child.stdin.on('error', (e) => finish({ ok: false, why: 'codex app-server closed its input: ' + e.message }));
    child.stdout.on('data', (d) => {
      out += d.toString('utf8'); let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim(); out = out.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.id === 1) { child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n' + JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} }) + '\n'); }
        else if (j.id === 2) {
          clearTimeout(timer);
          if (j.error) return finish({ ok: false, why: String(j.error.message || JSON.stringify(j.error)).slice(0, 200) });
          const rl = (j.result && j.result.rateLimits) || {};
          // named by DURATION, not position: a 'prolite' account answered with the weekly window as primary (10080 min) and no secondary
          const nameOf = (w, fallback) => !w.windowDurationMins ? fallback : w.windowDurationMins >= 10080 ? 'weekly' : w.windowDurationMins >= 1440 ? Math.round(w.windowDurationMins / 1440) + 'd' : Math.round(w.windowDurationMins / 60) + 'h';
          const win = (w, fallback) => w && typeof w.usedPercent === 'number' ? { name: nameOf(w, fallback), usedPct: Math.round(w.usedPercent), resetsAt: w.resetsAt ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : null, minutes: w.windowDurationMins || null } : null;
          finish({ ok: true, plan: rl.planType || null, windows: [win(rl.primary, '5h'), win(rl.secondary, 'weekly')].filter(Boolean) });
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cockpit', title: 'Cockpit', version: '1' }, capabilities: {} } }) + '\n');
  });
}


/* the turn's pictures as files codex can attach, removed a minute after the turn starts reading them */
function picFiles(turn) {
  const pics = Array.isArray(turn.images) ? turn.images : []; if (!pics.length) return [];
  const os = require('node:os'), fsx = require('node:fs'), px = require('node:path');
  const dir = fsx.mkdtempSync(px.join(os.tmpdir(), 'cockpit-pics-'));
  const files = pics.map((x, i) => { const f = px.join(dir, 'picture-' + (i + 1) + '.' + (x.type.split('/')[1] === 'jpeg' ? 'jpg' : x.type.split('/')[1])); fsx.writeFileSync(f, Buffer.from(x.data, 'base64')); return f; });
  setTimeout(() => { try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* the temp folder is cleaned anyway */ } }, 10 * 60000);
  return files;
}

module.exports = { setup, name: 'codex-cli', label: 'Codex CLI', models: MODELS, available, start, probe, usage, resumable: true };   // resumable: a conversation keeps its session (engine/harness.js)
