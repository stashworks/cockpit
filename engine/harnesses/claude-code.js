/* Claude Code as a harness - the only harness for Claude, because a Claude subscription plan
   works nowhere else (docs/generic-ide.md §4). Runs `claude -p` headless in the project
   folder with stream-json output, and maps its events onto the interface. This file is the
   only place that knows what a Claude Code event looks like (rule 8).

   Transcript in, never a session id (rule 2): the whole prompt - history, rulings, the new
   message - goes in on stdin, and sessions are not persisted on Claude's side. Costs a few
   thousand cached tokens per turn more than --resume would; buys the switch mid-conversation.

   Tools: Claude Code's own, allow-listed from the turn. dontAsk means anything not on the
   list is refused rather than prompted for - a headless run cannot answer a prompt. */
'use strict';
const cp = require('node:child_process');
const path = require('node:path');
const toolLog = (turn, h, ev) => { try { require('../toollog').log(turn, h, ev); } catch (e) { /* never fails a turn */ } };

/* The model list is DATA - claude-code.models.json beside this file - because Claude Code
   cannot list what a subscription allows and the owner does not want it in code
   (2026-09-16: "can we not hard code somehow?"). Read on every call; edit, no restart. */
function MODELS() {
  try { return JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'claude-code.models.json'), 'utf8')).models.map((m) => ({ free: false, ...m })); }
  catch (e) { return [{ id: 'opus', label: 'Claude Opus (models.json unreadable: ' + e.message + ')', contextTokens: 200000, free: false }]; }
}

function available() { return require('../spawn-cli').versionOf('claude'); }   // kept 10 min, refreshed in the background (D6)

function start(turn) {
  const listeners = [];
  const on = (fn) => listeners.push(fn);
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  let ended = false, endReason = null;
  // a harness that cannot even start still answers the interface: one error event, then end
  const failed = (msg) => { setTimeout(() => emit({ type: 'error', text: msg }), 0); return { on, done: new Promise((r) => setTimeout(() => r({ reason: 'crashed' }), 5)), stop: () => {} }; };

  /* RETRIES THAT REMEMBER: a fleet turn keeps its session on Claude's side (turn.keepSession), says
     its id (the 'session' event), and a retry of the same ticket on this harness resumes it (turn.resume) - the second
     try starts with everything the first one read instead of reading it all again. Rule 2 still holds: the transcript
     goes in as well, so a different harness or a lost session starts from Cockpit's record. Conversations stay as
     they were: no session persisted. */
  /* pictures: the message goes in as one stream-json user message carrying image blocks - how the desk's own messages reach
     Claude (checked 2026-09-25 with a test image: it answered its colour) */
  const pics = Array.isArray(turn.images) ? turn.images : [];
  const args = ['-p', ...(pics.length ? ['--input-format', 'stream-json'] : []), '--output-format', 'stream-json', '--verbose', ...(turn.keepSession ? [] : ['--no-session-persistence']), ...(turn.resume ? ['--resume', String(turn.resume)] : []),
    '--model', turn.model, '--permission-mode', 'dontAsk',
    '--allowedTools', (turn.tools || []).join(','),
    /* Cockpit is the memory. Claude Code keeps its own notes under ~\.claude\projects\...;
       on 2026-09-16 a turn wrote its findings there instead of into the map, and the owner
       could not see them. Writes into any .claude folder are refused. */
    '--disallowedTools', 'Write(**/.claude/**),Edit(**/.claude/**),Write(**\\.claude\\**),Edit(**\\.claude\\**)',
    /* as a FILE: with the doctrine in tier 1 the prompt passed 32 KB and Windows refused the command
       line (2026-09-17, spawn ENAMETOOLONG). One file per turn, gone when the turn closes. */
    '--append-system-prompt-file', sysFile(turn)];

  let child;
  try { child = launcher().spawn('claude', args, { cwd: turn.project, stdio: ['pipe', 'pipe', 'pipe'], env: turn.env || process.env }); }
  catch (e) { return failed('could not start claude: ' + e.message); }
  child.stdin.on('error', () => { /* a child that died at once: its close handler reports the turn; an unheard EPIPE would take the engine down (2026-09-30) */ });
  if (pics.length) child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: turn.prompt }].concat(pics.map((x) => ({ type: 'image', source: { type: 'base64', media_type: x.type, data: x.data } }))) } }) + '\n');
  else child.stdin.end(turn.prompt);

  let buf = '';
  let said = false;   // a text block went out already: the next starts a new paragraph
  let ctx = 0;   // the context the session carried into its last step: what a resumed session will cost per step (engine/harness.js)
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); }
  });
  let errText = '';
  child.stderr.on('data', (d) => { errText += d.toString('utf8'); });

  function handle(line) {
    let j; try { j = JSON.parse(line); } catch (e) { emit({ type: 'error', text: 'unparseable line: ' + line.slice(0, 200) }); return; }
    if (j.type === 'assistant' && j.message && j.message.usage) { const u0 = j.message.usage; ctx = (u0.input_tokens || 0) + (u0.cache_read_input_tokens || 0) + (u0.cache_creation_input_tokens || 0) || ctx; }
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const c of j.message.content) {
        if (c.type === 'text' && c.text) { emit({ type: 'text', text: (said ? '\n\n' : '') + c.text }); said = true; }   // each block is its own paragraph
        else if (c.type === 'tool_use') {
          const input = c.input || {};
          emit({ type: 'tool', name: c.name, input: summarise(c.name, input), id: c.id, ok: null });
          toolLog(turn, 'claude-code', { name: c.name, id: c.id, full: input.command || input.file_path || input.path || input.pattern || JSON.stringify(input) });   // every command kept (engine/toollog.js)
          const fp = input.file_path || input.path;
          if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) emit({ type: 'file', path: rel(turn.project, fp), change: c.name === 'Write' ? 'written' : 'edited' });
        }
        // thinking blocks are the harness's business - not streamed (interface: "not in the interface")
      }
    } else if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const c of j.message.content) if (c.type === 'tool_result') { emit({ type: 'tool', name: null, id: c.tool_use_id, ok: !c.is_error, output: typeof c.content === 'string' ? c.content.slice(0, 400) : '' }); toolLog(turn, 'claude-code', { id: c.tool_use_id, ok: !c.is_error, output: typeof c.content === 'string' ? c.content : '' }); }
    } else if (j.type === 'result') {
      const u = j.usage || {};
      emit({ type: 'cost', inTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), outTokens: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, usd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null, durationMs: j.duration_ms, turns: j.num_turns });
      if (j.is_error || (j.subtype && j.subtype !== 'success')) emit({ type: 'error', text: 'result: ' + (j.subtype || 'error') + (j.result ? ' - ' + String(j.result).slice(0, 300) : '') });
    } else if (j.type === 'system' && j.subtype === 'init') {
      /* WHOSE MONEY: the init event says where the credentials came from - 'none' is the owner's
         login (the subscription plan); anything else is an API key that bills separately. Said out loud every turn. */
      const src = j.apiKeySource || 'unknown';
      if (j.session_id && turn.keepSession) emit({ type: 'session', id: String(j.session_id), resumed: !!turn.resume, context: ctx });
      emit({ type: 'info', text: 'claude ' + (j.model || '') + ' in ' + turn.project + (turn.resume ? ' · resumed session ' + String(turn.resume).slice(0, 8) : '') + ' · auth: ' + (src === 'none' ? 'login (subscription plan)' : 'API KEY via ' + src + ' - billed to the API account, not the plan') });
      emit({ type: 'auth', source: src });
    }
    // rate_limit_event: status only, no percentage until a warning band - the reading comes from usage() instead
  }

  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      if (buf.trim()) handle(buf.trim());
      if (!endReason) endReason = code === 0 ? 'done' : 'crashed';
      if (endReason === 'crashed' && errText.trim()) emit({ type: 'error', text: errText.trim().slice(0, 600) });
      ended = true; resolve({ reason: endReason, code });
      try { require('node:fs').unlinkSync(args[args.indexOf('--append-system-prompt-file') + 1]); } catch (e) { /* already gone */ }
    });
    child.on('error', (e) => { emit({ type: 'error', text: 'could not start claude: ' + e.message }); endReason = 'crashed'; ended = true; resolve({ reason: 'crashed' }); });
  });

  // Stop = the whole process tree, not just the top (rule 4; state-changes-carry-fallback).
  function stop(reason) {
    if (ended) return;
    endReason = reason || 'stopped';
    if (process.platform === 'win32') { try { cp.execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch (e) { child.kill(); } }
    else child.kill('SIGTERM');
  }

  return { on, done, stop, pid: child.pid };   // the watchdog looks at this process's family before calling a quiet turn stuck (engine/harness.js)
}

function sysFile(turn) {
  const fs = require('node:fs'), os = require('node:os');
  const dir = path.join(os.tmpdir(), 'cockpit'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'claude-system-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.md');
  fs.writeFileSync(f, turn.system || ''); return f;
}
/* the shared launcher, always the file on disk - so a fix to it reaches a running engine */
function launcher() { const f = path.join(__dirname, '..', 'spawn-cli.js'); delete require.cache[require.resolve(f)]; return require(f); }
function rel(root, p) { try { const r = path.relative(root, p); return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p; } catch (e) { return p; } }
function summarise(name, input) {
  if (input.file_path) return rel(process.cwd(), input.file_path);
  if (input.pattern) return input.pattern + (input.path ? ' in ' + input.path : '');
  if (input.command) return String(input.command).slice(0, 120);
  const s = JSON.stringify(input); return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/* The Models section's reading of this harness: installed, the login it runs as, how to connect. */
function setup() {
  const av = available(); const home = require('node:os').homedir();
  let account = { ok: false, why: 'not logged in' };
  try {
    const c = JSON.parse(require('node:fs').readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth;
    if (c && c.accessToken) account = { ok: true, who: 'claude.ai login' + (c.subscriptionType ? ' (' + c.subscriptionType + ' plan)' : ''), expired: !!(c.expiresAt && c.expiresAt < Date.now()) };
  } catch (e) { /* no credentials file */ }
  if (!account.ok && process.env.ANTHROPIC_API_KEY) account = { ok: true, who: 'API key from the environment (pay per token - not the plan)' };
  return {
    installed: av.ok, version: av.ok ? av.why : null, why: av.ok ? null : av.why, account,
    models: MODELS().map((m) => m.id),
    connect: [
      av.ok ? null : 'Install Claude Code on this machine: npm install -g @anthropic-ai/claude-code (an install - ask the owner first).',
      account.ok ? null : 'Log in once, as the user the Node server runs as: open a terminal on this machine and run  claude login  - it opens the browser; the login is kept in ~/.claude/.credentials.json and refreshed by Claude itself.',
      account.expired ? 'Idle: the short-lived access token has lapsed (routine after a few hours without a turn - the login itself stands). The next Claude turn re-mints it; until then the usage reading is stale.' : null,
      'Usage (5-hour and weekly windows) is read from the plan itself; the fleet card shows it next to the agent.'
    ].filter(Boolean)
  };
}
function probe(what) {
  if (what === 'setup') return setup();
  if (what === 'shim') {   // how `claude` resolves on this machine, and what the shim says
    const r = launcher().resolve('claude'); let text = '';
    try { const out = cp.execSync('where claude', { encoding: 'utf8', timeout: 15000, windowsHide: true }); text = out; const cmd = out.split(/\r?\n/).find((l) => /\.cmd$/i.test(l.trim())); if (cmd) text += '\n--- ' + cmd.trim() + '\n' + require('node:fs').readFileSync(cmd.trim(), 'utf8'); } catch (e) { text += '\n' + e.message; }
    return { ok: true, resolved: r, text };
  }
  try { return { ok: true, text: cp.execSync('claude ' + (what === 'version' ? '--version' : '--help'), { encoding: 'utf8', timeout: 20000, windowsHide: true }) }; } catch (e) { return { ok: false, error: String(e.message).slice(0, 400) }; }
}
/* THE PLAN'S OWN READING, on demand. The stream carries a rate_limit_event per turn, but
   with a percentage only once a warning band is crossed. The exact figure is what the
   interactive /usage screen shows, and it comes from one account endpoint with the login
   Claude Code already keeps in ~.claude.credentials.json (verified 2026-09-16: five_hour
   6.0, seven_day 16.0, with resets). Undocumented, so a changed shape reports as unknown,
   never as a number. The token is refreshed by Claude Code itself on its next turn; an
   expired one is reported as such rather than refreshed here. */
/* ONE LOGIN PER CODER (four more Claude coders, each on its own account). A coder with its own
   CLAUDE_CONFIG_DIR keeps its login - .credentials.json - there instead of ~\.claude (documented by Claude Code); the
   engine passes that folder so each coder's usage is read from its own account. No folder = the machine's own login. */
function credentialsFile(configDir) { return configDir ? path.join(configDir, '.credentials.json') : path.join(require('node:os').homedir(), '.claude', '.credentials.json'); }
function loginOf(configDir) {
  try { const c = JSON.parse(require('node:fs').readFileSync(credentialsFile(configDir), 'utf8')).claudeAiOauth; return c && c.accessToken ? { ok: true, plan: c.subscriptionType || null, expired: !!(c.expiresAt && c.expiresAt < Date.now()) } : { ok: false, why: 'no login token yet' }; }
  catch (e) { return { ok: false, why: 'not logged in yet' }; }
}
function usage(opts) {
  const configDir = opts && opts.configDir;
  return new Promise((resolve) => {
    let c; try { c = JSON.parse(require('node:fs').readFileSync(credentialsFile(configDir), 'utf8')).claudeAiOauth; }
    catch (e) { return resolve({ ok: false, why: 'no Claude Code login on this machine' }); }
    if (!c || !c.accessToken) return resolve({ ok: false, why: 'no login token in the credentials file' });
    if (c.expiresAt && c.expiresAt < Date.now()) return resolve({ ok: false, why: 'idle - the access token lapsed; the next Claude turn re-mints it (the login stands)' });
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
    fetch('https://api.anthropic.com/api/oauth/usage', { signal: ctrl.signal, headers: { Authorization: 'Bearer ' + c.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json', 'User-Agent': 'claude-cli/' + (available().why.split(' ')[0] || '2') } })
      .then(async (r) => {
        clearTimeout(timer);
        if (r.status !== 200) return resolve({ ok: false, why: 'usage endpoint answered HTTP ' + r.status });
        let j; try { j = await r.json(); } catch (e) { return resolve({ ok: false, why: 'usage endpoint answered non-JSON' }); }
        const win = (w, name) => w && typeof w.utilization === 'number' ? { name, usedPct: Math.round(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, locked: w.locked_reason || null } : null;
        const windows = [win(j.five_hour, '5h'), win(j.seven_day, 'weekly'), win(j.seven_day_opus, 'weekly opus'), win(j.seven_day_sonnet, 'weekly sonnet')].filter(Boolean);
        if (!windows.length) return resolve({ ok: false, why: 'usage endpoint shape changed - no windows found' });
        resolve({ ok: true, plan: null, windows });
      }).catch((e) => { clearTimeout(timer); resolve({ ok: false, why: e.name === 'AbortError' ? 'usage endpoint did not answer in 15 s' : e.message }); });
  });
}

module.exports = { setup, name: 'claude-code', label: 'Claude Code', models: MODELS, available, start, probe, usage, loginOf, configEnv: 'CLAUDE_CONFIG_DIR', resumable: true };   // resumable: a conversation keeps its session (engine/harness.js); configEnv: where a coder of this kind keeps its own login   // resumable: a conversation keeps its session (engine/harness.js)
