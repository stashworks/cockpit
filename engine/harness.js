/* The harness layer - docs/harness-interface.md, made runnable.

   Adapters live in engine/harnesses/<name>.js and export:
     name, models(), available(), start(turn) -> handle { on(fn), done, stop() }
   This module is the only caller. It builds the turn (prompt tiers + sized transcript),
   records every event (rule 1), enforces kill-on-silence and the ceiling (rule 4),
   computes the outcome (rules 5, 6), and writes the assistant's turn when it ends.
   Nothing harness-specific is here (rule 8). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const live = (file) => new Proxy({}, { get: (_, k) => require('./hot').hot(path.join(__dirname, file))[k] });   // stateless modules: always the file on disk
const prompt = live('prompt.js');
const conv = live('conversation.js');

/* A conversation's session on its harness, per thread, so the next message resumes it (see run): <project>\.cockpit\sessions.json */
const sessions = {
  file: (p) => path.join(p.cockpit.dir, 'sessions.json'),
  all(p) { try { return JSON.parse(fs.readFileSync(this.file(p), 'utf8')); } catch (e) { return {}; } },
  write(p, all) { try { fs.writeFileSync(this.file(p), JSON.stringify(all, null, 1) + '\n'); } catch (e) { /* the next message starts fresh */ } },
  get(p, t) { return this.all(p)[String(t)] || null; },
  set(p, t, v) { const all = this.all(p); all[String(t)] = { ...v, at: new Date().toISOString() }; this.write(p, all); },
  drop(p, t) { const all = this.all(p); delete all[String(t)]; this.write(p, all); }
};

/* The CPU a process and everything under it has used, in seconds, and the names of those processes - the watchdog's
   "is it actually working" (see run). Windows reads Win32_Process (kernel + user time, 100 ns ticks); elsewhere ps.
   Resolves null when the list cannot be read, which the watchdog treats as "cannot tell" - stopped as before. */
const BUSY_CPU_SEC = 1.5;   // CPU used between two readings 15 s apart that counts as working (an idle harness uses ~0)
function treeCpu(rootPid) {
  const cp = require('node:child_process');
  const win = process.platform === 'win32';
  const cmd = win ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$([int64]$_.KernelModeTime + [int64]$_.UserModeTime),$($_.Name)" }']]
    : ['ps', ['-eo', 'pid=,ppid=,times=,comm=']];
  return new Promise((resolve) => cp.execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 20000, maxBuffer: 1 << 24 }, (e, out) => {
    if (e || !out) return resolve(null);
    const kids = new Map(), info = new Map();
    for (const line of String(out).split(/\r?\n/)) {
      const m = win ? /^(\d+),(\d+),(\d+),(.*)$/.exec(line.trim()) : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2];
      info.set(pid, { cpu: win ? +m[3] / 1e7 : +m[3], name: m[4].trim() });
      if (pid !== ppid) (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(pid);
    }
    if (!info.has(rootPid)) return resolve(null);
    let cpuSec = 0; const names = [], seen = new Set(), todo = [rootPid];
    while (todo.length) { const p = todo.pop(); if (seen.has(p)) continue; seen.add(p); const i = info.get(p); if (i) { cpuSec += i.cpu; if (p !== rootPid && !names.includes(i.name)) names.push(i.name); } (kids.get(p) || []).forEach((k) => todo.push(k)); }
    resolve({ cpuSec, names, count: seen.size });
  }));
}

const adapters = {};
const running = new Map();   // turnId -> { handle, events: [], listeners: Set, outcome, project, threadId, harness, model }
let seq = 0;

/* Adapters are re-read when their file changes on disk. The engine may run on one machine
   while its files are edited from another over a network share; without this every adapter
   change was a restart at the engine's keyboard. */
let DIR = null;
const mtimes = {};
function load(engineRoot) {
  DIR = path.join(engineRoot, 'harnesses');
  reload();
  return Object.keys(adapters);
}
function reload() {
  // the launcher the adapters share is reloaded on the same rule
  const helper = path.join(DIR, '..', 'spawn-cli.js');
  try { const mt = fs.statSync(helper).mtimeMs; if (mtimes[helper] !== mt) { mtimes[helper] = mt; delete require.cache[require.resolve(helper)]; Object.keys(mtimes).forEach((k) => { if (k.startsWith(DIR) && !k.endsWith(':loaded')) mtimes[k] = 0; }); } } catch (e) { /* no helper */ }
  const cj = path.join(DIR, 'custom.json');
  try { const mt = fs.statSync(cj).mtimeMs; if (mtimes[cj] !== mt) { mtimes[cj] = mt; delete mtimes[path.join(DIR, 'custom.js')]; } } catch (e) { /* no custom tools yet */ }
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.js')) continue;
    const file = path.join(DIR, f);
    let mt; try { mt = fs.statSync(file).mtimeMs; } catch (e) { continue; }
    if (mtimes[file] === mt) continue;
    try {
      delete require.cache[require.resolve(file)];
      const a = require(file);
      if (typeof a.adapters === 'function') { for (const k of Object.keys(adapters)) if (adapters[k].custom) delete adapters[k]; for (const c of a.adapters()) adapters[c.name] = c; }   // one file, several tools (custom.js)
      else adapters[a.name] = a;
      mtimes[file] = mt;
      if (mtimes[file + ':loaded']) console.log('harness → reloaded ' + (a.name || f));
      mtimes[file + ':loaded'] = 1;
    } catch (e) { console.error('harness ' + f + ' failed to load: ' + e.message); }
  }
}
function list(includeOff) {
  reload();
  let off = []; try { off = require('./harnesses/custom.js').read().off || []; } catch (e) { /* none */ }
  return Object.values(adapters).filter((a) => includeOff || !off.includes(a.name)).map((a) => { const av = a.available(); return { name: a.name, label: a.label, custom: !!a.custom, off: off.includes(a.name), ok: av.ok, why: av.why, models: av.ok ? a.models() : [] }; });
}

/* Run one turn on a thread. Returns the turn id at once; events arrive on subscribe(). */
/* Turns still running, engine-wide: who is on what. The local model gets a HARD lock - two
   Pi turns fight over one card's VRAM, so two local AI jobs never start at once. Frontier harnesses run in parallel freely. */
const EXCLUSIVE = { pi: true };   // harnesses that may run one turn at a time, engine-wide
function busy() {
  return [...running.values()].filter((r) => !r.outcome).map((r) => ({ turn: r.id, harness: r.harness, model: r.model, project: r.project.entry.id, thread: r.threadId, ticket: r.ticket || null, since: new Date(r.started).toISOString() }));
}
function runningIn(projectId) { return busy().filter((b) => b.project === projectId); }
/* the tickets whose turn ended and whose verdict is still coming (the tests, the rescan) - "testing" on the board */
function verifyingIn(projectId) { return [...running.values()].filter((r) => r.verifying && r.ticket && r.project.entry.id === projectId).map((r) => ({ ticket: r.ticket, since: r.verifying, turn: r.id })); }

function run(engineRoot, project, threadId, harnessName, modelId, message, opts) {
  reload();
  const a = adapters[harnessName];
  if (!a) throw new Error('no such harness: ' + harnessName);
  if (EXCLUSIVE[harnessName]) { const other = busy().find((b) => b.harness === harnessName); if (other) throw new Error(a.label + ' is busy on ' + other.project + ' (since ' + other.since.slice(11, 16) + ') - one local turn at a time'); }
  const model = a.models().find((m) => m.id === modelId) || a.models()[0];
  const t = conv.thread(project, threadId);
  if (!t) throw new Error('no such thread: ' + threadId);
  let screen = opts && opts.context ? String(opts.context).slice(0, 12000) : null;   // what the owner is looking at (the Problems card, its picked files)
  /* the ticket this turn works (Phase 4): named in the message (#12, L3) or carried by the queue item. Its body rides
     in the prompt; it goes in-work; its scope is snapshotted so the rescan can judge the change when the turn ends. */
  const ticketsMod = require('./hot').hot(path.join(__dirname, 'tickets.js'));
  let ticket = null; { const named = (opts && opts.ticket) || (() => { const m = /(?:^|[\s(])#?(L\d+|\d{1,6})\b(?=[\s:.,)]|$)/.exec(message || ''); return m ? m[1] : null; })(); if (named) ticket = ticketsMod.get(project, named); }
  if (ticket && (ticket.state === 'created' || ticket.state === 'in-work' || ticket.state === 'verified')) {
    screen = 'TICKET ' + (ticket.number ? '#' + ticket.number : ticket.id) + ' - ' + ticket.title + ' (state ' + ticket.state + ', risk ' + (ticket.impact && ticket.impact.band) + ')\nThis turn works this ticket and nothing else. Name it in the first line and in every commit (' + (ticket.number ? '#' + ticket.number : ticket.id) + ': ...). Touch only the files it declares; a file it does not declare is a finding on the ticket - say so and stop if the work needs one.\n\n' + ticket.body + '\n\n' + (() => { try { return ticketsMod.briefing(project, ticket); } catch (e) { return ''; } })() + (screen ? '\n\n' + screen : '');   // the briefing: the named files read for the coder, the feature's flows, run-only-what-is-named
    if (ticket.state === 'created') ticketsMod.setState(project, ticket.id, 'in-work', a.name, 'work started in turn ' + (seq + 1));
  } else ticket = null;
  /* PICTURES PASTED INTO THE CONVERSATION: they go to the AI
     inside the message, as the desk's do - never written to the project. The record keeps a line saying they were there. */
  const images = (opts && Array.isArray(opts.images) ? opts.images : []).filter((x) => x && /^image\/(png|jpeg|gif|webp)$/.test(x.type) && typeof x.data === 'string' && x.data.length);
  const said = images.length ? (message ? message + '\n\n' : '') + '[' + images.length + ' picture' + (images.length === 1 ? '' : 's') + ' attached]' : message;
  if (said && !(opts && opts.retryFresh)) conv.addTurn(project, threadId, 'user', said, null, null, null, screen);

  /* CONVERSATIONS RUN LIKE AN INTERACTIVE SESSION. An interactive AI session is ONE continuing session: what was said stays in it, cached, and a message adds only
     itself. A conversation here used to start a fresh process for every message and re-send the rules and the recent
     record each time - the smallest Claude reply read ~89k tokens and cost $0.77. Now a conversation keeps its session
     and the next message RESUMES it, sending only the new words; the record Cockpit keeps is still written, and is what
     a fresh start uses when there is no session to resume (a new thread, another harness or model, a session gone). */
  const chat = !(opts && opts.fleet) && !!a.resumable;
  const saved = chat && !(opts && opts.retryFresh) ? sessions.get(project, threadId) : null;
  // a session lives in the login folder it ran under, so another coder (another account) cannot resume it (2026-09-25)
  /* A SESSION THAT HAS GROWN TOO BIG STARTS FRESH. A resumed session never shrinks: every step rereads all of it. One project's reached
     ~240k tokens a step, so one build message read 7-17M; another's ~1.5M a message. Once the context its last step carried
     passes SESSION_MAX, the next message starts a fresh session from Cockpit's own record of the conversation (the messages, not
     every file and test output the old session read) - the conversation goes on, its cost per step drops back. For every project. */
  const SESSION_MAX = 150000;
  const tooBig = !!(saved && saved.context && saved.context > SESSION_MAX);
  const chatResume = !tooBig && saved && saved.harness === a.name && saved.model === model.id && (saved.agent || null) === ((opts && opts.agentId) || null) ? saved.id : null;
  const sized = prompt.sizeTranscript(t.turns, t.notes, model);
  // a WORK turn (the fleet, or a ticket named in the message) gets the doctrine and the plugin rules; a chat turn does not
  // ...and from 2026-09-23 the same line decides the tools and the time limit, further down: work is a coder, chat is a conversation.
  const isWork = !!ticket || !!(opts && opts.fleet);
  const sys = prompt.systemPrompt(engineRoot, project, { work: isWork });
  // Tier 0, from the engine: how to reach Cockpit's tools for THIS project. Not a rule file; a
  // fact. The text lives in prompt.js so the Project card's size line counts the same bytes.
  sys.text = prompt.tier0(engineRoot, project) + '\n\n---\n\n' + sys.text;
  // a harness that cannot see pictures is told they were sent, so it says so instead of guessing
  const seen = images.length && !['claude-code', 'codex-cli'].includes(a.name) ? said + ' (this AI cannot see pictures: say so, and ask the owner to describe what it shows)' : message;
  const turnId = ++seq;
  /* a coder's turn in its own folder on a project that lands in dev (engine/land.js): its work is judged on dev after it lands */
  const landing = !!(ticket && opts && opts.cwd && (() => { try { return require('./workspaces').landsInDev(project); } catch (e) { return false; } })());
  const rec = { id: turnId, ticket: ticket ? ticket.id : null, before: ticket && (!(opts && opts.cwd) || landing) ? (() => { try { return require('./hot').hot(path.join(__dirname, 'verify.js')).before(project, ticket.id); } catch (e) { return null; } })() : null, handle: null, events: [], listeners: new Set(), outcome: null, project, threadId, harness: a.name, model: model.id, started: Date.now(), lastEvent: Date.now(), text: '', files: new Set(), cost: null, toolRan: false };
  running.set(turnId, rec);

  const turn = {
    project: (opts && opts.cwd) || project.dir, model: model.id,   // a coder's turn runs in its own folder (engine/workspaces.js); everything else in the project's
    env: require('./guard').envFor({ ...process.env, ...require('./ghauth').envFor(project), ...((opts && opts.env) || {}), COCKPIT_THREAD: String(threadId), COCKPIT_TURN: String(turnId), COCKPIT_PROJECT: project.entry.id, COCKPIT_KEY: require('./scope').keyFor(project.entry.id), ...(opts && opts.fleet ? { COCKPIT_FLEET: '1' } : {}), ...(opts && opts.agentId ? { COCKPIT_AGENT: String(opts.agentId) } : {}) }),   // COCKPIT_AGENT: who is acting, so a hand tag (cli tag ... accepted) is signed by the coder, not "owner" (2026-10-02)   // the key lets this turn change ITS project only (engine/scope.js)
      // the guard rides every turn: git clean, git checkout ., rm -r on a directory are refused before they run (engine/guard.js)   // the project's GitHub account rides every turn (engine/ghauth.js); the thread and turn, so cli ticket draft can say where a ticket came from
    system: sys.text, systemFiles: sys.files,
    images,   // [{ type, data(base64) }] - a harness that can see them takes them; one that cannot is told they were sent
    // resumed: the session already holds the record - only the new message (and what is on screen) goes in
    prompt: chatResume ? prompt.renderPrompt({ turns: [], notes: [], dropped: 0 }, seen, screen) : prompt.renderPrompt(sized, seen, screen),
    transcript: chatResume ? [] : sized.turns, dropped: chatResume ? 0 : sized.dropped,
    keepSession: !!(opts && opts.fleet) || chat, resume: (opts && opts.resume) || chatResume || null,   // a fleet turn keeps its session and a retry resumes it (engine/fleet.js); a conversation keeps one and every next message resumes it
    /* FULL hands by default:
       the same tools a Claude Code session on the desk has - shell, files, search, web.
       The first cut allowed only the cli through the shell; the model spent turns being
       refused. The fences that stay are rules, not tool bans: Cockpit is the memory (no
       .claude writes - enforced), and Cockpit itself is changed by a change request. A
       project can narrow this in cockpit.json.harness.tools. */
    /* One tool set and one time limit, for chat and for work alike. A narrower chat set and a
       10-minute cap were tried on 2026-09-23 and REVERTED the same evening, on the evidence:
       reading the turn log showed the expensive turns were not a chat flailing, they were tickets
       being WORKED in the conversation - turn 27 made 8 edits, ran the tests four times, cut a
       branch, pushed and opened PR #4057 in 52 steps, which is what that job costs. Agent was never
       called once in 143k logged lines, so removing it saved nothing. And a cap would have killed a
       real build mid-commit whenever the ask named no ticket number.
       The waste was two turns that answered a question by downloading every issue BODY (~154k
       tokens each). That is a habit, and habits belong in the prompt - see prompts/global.md,
       "Ask for the narrowest thing that answers the question". */
    tools: (opts && opts.tools) || (project.cockpit.json.harness && project.cockpit.json.harness.tools)
      || ['Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'],   // PowerShell is a separate tool on Windows; it was refused until named (2026-09-16)
    /* NO CEILING ON A CONVERSATION. The ceiling only ever caught a turn that keeps TALKING forever; quiet-but-working is the CPU
       check's now, and in a conversation the owner is there with Stop. Unattended turns keep one: the fleet passes its
       own (120, engine/fleet.js), Home's wake-ups theirs (engine/wake.js). */
    limits: { maxMinutes: Infinity, maxSilenceMinutes: 8, ...((opts && opts.limits) || {}) }
  };
  emit(rec, { type: 'start', harness: a.name, model: model.id, transcriptTurns: sized.turns.length, dropped: sized.dropped, systemFiles: sys.files, tools: turn.tools });
  if (tooBig) emit(rec, { type: 'info', text: 'the session of this conversation had grown to ' + Math.round(saved.context / 1000) + 'k tokens a step - continuing in a fresh session from the record Cockpit keeps of the conversation' });

  const handle = a.start(turn);
  rec.handle = handle;
  handle.on((ev) => {
    rec.lastEvent = Date.now();
    if (ev.type === 'text') rec.text += ev.text;
    if (ev.type === 'tool') { rec.toolRan = true; rec.steps = (rec.steps || 0) + 1; }   // steps: for the session-size estimate below
    if (ev.type === 'file') rec.files.add(ev.path);
    if (ev.type === 'cost') rec.cost = ev;
    if (ev.type === 'auth') rec.auth = ev.source;
    if (ev.type === 'session') { rec.session = { harness: a.name, id: ev.id, resumed: !!ev.resumed }; if (ev.context) rec.sessionContext = ev.context; if (chat) sessions.set(project, threadId, { harness: a.name, model: model.id, agent: (opts && opts.agentId) || null, id: ev.id, context: ev.context || 0 }); }   // said to the fleet at the end: the next try resumes it; a conversation's is kept for its next message
    emit(rec, ev);
  });

  // Kill on silence, not on the clock (rule 4); the ceiling is for the loop that keeps talking.
  /* QUIET IS NOT STUCK. A project lost two conversation turns in a row: each started a long calculation, said nothing
     while it ran, and was killed at the silence limit mid-answer. Now, when a turn has been quiet past the limit, the
     watchdog reads the CPU its whole process family has used - the harness and everything it started - twice, a check
     apart. Climbing: it is computing, and it is left alone (the silence clock restarts from that reading). Flat, or no
     process to read: it really is stuck, and it is stopped as before. The ceiling still bounds the whole turn. */
  const watchdog = setInterval(() => {
    const now = Date.now(), quiet = (now - Math.max(rec.lastEvent, rec.lastBusy || 0)) / 60000, total = (now - rec.started) / 60000;
    if (total > turn.limits.maxMinutes) { handle.stop('ceiling'); return; }
    if (quiet <= turn.limits.maxSilenceMinutes) { rec.cpu = undefined; return; }
    if (!handle.pid) { handle.stop('silence'); return; }
    if (rec.checking) return;
    rec.checking = true;
    treeCpu(handle.pid).then((t) => {
      rec.checking = false;
      if (rec.outcome) return;
      const prev = rec.cpu; rec.cpu = t;
      if (t && prev === undefined) return;                                    // the first reading: judge on the next one
      if (t && prev && t.cpuSec - prev.cpuSec > BUSY_CPU_SEC) {
        rec.lastBusy = Date.now();
        if (!rec.saidBusy) { rec.saidBusy = true; emit(rec, { type: 'info', text: 'quiet, but still working - ' + t.names.slice(0, 4).join(', ') + ' using CPU; the silence limit waits while it computes' }); }
        return;
      }
      handle.stop('silence');
    });
  }, 15000);

  handle.done.then((end) => {
    clearInterval(watchdog);
    // leftover working copies beside the project are cleared once nothing else runs there (engine/sweep.js, owner 2026-09-26)
    setTimeout(() => { try { if (!busy().some((b) => b.project === project.entry.id)) require('./hot').hot(path.join(__dirname, 'sweep.js')).run(project); } catch (e) { /* never fail a turn over housekeeping */ } }, 5000);
    const reason = (end && end.reason) || 'done';
    rec.outcome = { reason, text: rec.text, files: [...rec.files], cost: rec.cost, producedNothing: !rec.toolRan && rec.files.size === 0 && !rec.text.trim(), durationSec: Math.round((Date.now() - rec.started) / 1000) };
    /* a conversation's resume that died at once with nothing said is the SESSION failing, not the answer: the session is
       dropped and the same message goes again, fresh, with Cockpit's record - the owner still gets his reply */
    if (chatResume && rec.outcome.producedNothing && rec.outcome.durationSec < 60) {
      sessions.drop(project, threadId);
      emit(rec, { type: 'info', text: 'the conversation\'s session could not be resumed - starting it fresh from Cockpit\'s record' });
      try { const again = run(engineRoot, project, threadId, harnessName, modelId, message, { ...(opts || {}), retryFresh: true }); emit(rec, { type: 'end', reason: 'restarted', outcome: { ...rec.outcome, restartedAs: again } }); } catch (e) { emit(rec, { type: 'end', reason, outcome: rec.outcome }); }
      setTimeout(() => running.delete(turnId), 10 * 60 * 1000).unref(); return;
    }
    /* a RESUMED session reports its RUNNING TOTAL, not this message's (measured 2026-09-25: $0.671 for "hi", then $0.733 for a
       follow-up that read 97% of its input from cache). This turn's own cost is the difference; the total is kept for the next. */
    if (chat && rec.cost && typeof rec.cost.usd === 'number') {
      const total = rec.cost.usd, prevUsd = chatResume && saved && typeof saved.usd === 'number' ? saved.usd : 0;
      rec.cost = { ...rec.cost, usd: Math.max(0, total - prevUsd), sessionUsd: total };
      rec.outcome.cost = rec.cost;
      const s = sessions.get(project, threadId); if (s) sessions.set(project, threadId, { ...s, usd: total });
    }
    /* the session size, for ANY harness: the exact figure
       when the harness says it (Claude: the context its last step carried), otherwise the tokens this message read divided by
       its steps (every tool call is a step, plus the answer). Past SESSION_MAX the next message starts fresh (above). */
    if (chat && rec.cost && rec.cost.inTokens) {
      const s = sessions.get(project, threadId);
      if (s) { const est = rec.sessionContext || Math.round(rec.cost.inTokens / ((rec.steps || 0) + 1)); if (est) sessions.set(project, threadId, { ...s, context: est }); }
    }
    // The assistant's turn is recorded from what Cockpit saw, not from what the harness claims.
    if (rec.text.trim()) conv.addTurn(project, threadId, 'assistant', rec.text.trim(), a.name, model.id, rec.cost);
    if (rec.session) rec.outcome.session = rec.session; if (opts && opts.resume) rec.outcome.resumed = opts.resume;
    emit(rec, { type: 'end', reason, outcome: rec.outcome });
    ledger(engineRoot, { harness: a.name, model: model.id, project: project.entry.id, thread: threadId, reason, auth: rec.auth || null, producedNothing: rec.outcome.producedNothing, files: rec.files.size, cost: rec.cost, durationSec: rec.outcome.durationSec, fleet: !!(opts && opts.fleet) });
    if (typeof a.usage === 'function') probeUsage((opts && opts.agentId) || a.name).catch(() => {});   // a fresh plan reading after every turn
    try { require('./projects').bump(project.entry.id); } catch (e) { /* closed */ }
    /* A turn that touched files makes the map stale: rescan the plugins that scan (the card should follow the work). Skipped while a scan is already running; a scan failure
       is logged, never fatal to the turn. */
    if (rec.files.size && !landing) {   // a landing coder's tests run on dev once its work is there (below), not on dev before it is
      /* The verify loop (Phase 3, 2026-09-18): a turn that touched files runs the project's tests, then the scan reads the
         report (the runner rescans when it lands). A turn that only wrote tests, docs or the mapping still counts - a
         change is a change. One run at a time per project; a run already going is left alone. Never the dev database:
         the runner sets the test environment itself. */
      try { const t = require('./hot').hot(path.join(__dirname, 'tests.js')); const r = t.run(project, (line) => console.log('[' + project.entry.id + '] ' + line), { light: true, files: [...rec.files] });   /* the files this turn touched: a project with a scoped: command runs only their packages */ /* after a turn: the test files only; the environment runs at promote */ if (r.ok) rec.testsStarted = true; console.log('tests → ' + (r.ok ? 'started after turn ' + turnId + ' (' + r.files + ' file' + (r.files === 1 ? '' : 's') + (r.command ? ', ' + r.command : '') + ')' : r.error)); if (r.ok) rec.testsStarted = r.started; }
      catch (e) { console.error('tests after turn: ' + e.message); }
      // the scan follows the run when there is one; without one, rescan now
      if (!rec.testsStarted) { try { const pl = require('./plugins'); for (const name of pl.scanned(project)) { try { const r = pl.scan(project, name, null); if (r && r.ok) console.log('scan → ' + name + ' after turn ' + turnId + ' touched ' + rec.files.size + ' file' + (rec.files.size === 1 ? '' : 's')); } catch (e) { /* this plugin has no scan */ } } } catch (e) { console.error('rescan after turn: ' + e.message); } }
    }
    /* the ticket's verdict: once the tests (when they ran) and the rescan have landed, verify.js judges the change on
       the ticket's scope and moves it - verified, or back to in-work with the failure attached. */
    /* not for a turn run in a coder's own folder (engine/workspaces.js): verify.js reads the PROJECT's folder, so its
       verdict there describes the main folder - on 2026-09-25 pi read that folder's leftovers as its own and deleted two of
       the owner's documents "to clear the check". The pull request's own CI judges folder work until verify follows it. */
    if (rec.ticket && !(opts && opts.cwd)) {
      /* the second-model review (Phase 4, item 8): ## Review in project.md names a harness (review: codex-cli gpt-5.1);
         it gets the diff of the touched files and the ticket, read-only tools, one answer - attached to the ticket. The
         working AI decides what to do with it; nothing loops. Never the same harness that did the work. */
      try {
        const rv = (() => { try { const md = require('node:fs').readFileSync(path.join(project.cockpit.dir, 'project.md'), 'utf8'); const sec = /^##\s+Review\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md); const m = sec && /^\s*(?:-\s*)?review:\s*(\S+)(?:\s+(\S+))?/im.exec(sec[1]); return m ? { harness: m[1], model: m[2] || null } : null; } catch (e) { return null; } })();
        if (rv && rv.harness !== a.name && adapters[rv.harness] && rec.files.size && !(opts && opts.review)) {
          const tk = ticketsMod.get(project, rec.ticket);
          let diff = ''; try { diff = require('node:child_process').execFileSync('git', ['-c', 'safe.directory=*', 'diff', '--', ...[...rec.files].map((f) => path.isAbsolute(f) ? path.relative(project.dir, f) : f)], { cwd: project.dir, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); } catch (e) { diff = '(no diff: ' + e.message + ')'; }
          const ask = 'SECOND-MODEL REVIEW of ticket ' + (tk.number ? '#' + tk.number : tk.id) + ' - ' + tk.title + '. Another model did the work; you review it once, read-only, and answer in under 300 words: (1) does the change do what the ticket says, (2) what it misses or risks, (3) anything touched outside the declared files, (4) your verdict: accept / accept with notes / send back. No code.\n\nTHE TICKET:\n' + tk.body.slice(0, 6000) + '\n\nTHE DIFF (' + [...rec.files].length + ' files):\n' + diff.slice(0, 40000);
          const thread = conv.create(project, 'Review ' + (tk.number ? '#' + tk.number : tk.id) + ': ' + tk.title);
          const rid = run(engineRoot, project, thread, rv.harness, rv.model || (adapters[rv.harness].models()[0] || {}).id, ask, { review: true, tools: ['Read', 'Glob', 'Grep'], limits: { maxMinutes: 10, maxSilenceMinutes: 4 } });
          const off = subscribe(rid, (ev) => { if (ev.type !== 'end') return; off(); const text = (ev.outcome && ev.outcome.text || '').trim(); const tk2 = ticketsMod.get(project, rec.ticket); if (tk2) { tk2.reviews = (tk2.reviews || []).concat({ at: new Date().toISOString(), harness: rv.harness, model: rv.model, turn: rid, text: text.slice(0, 4000) }); ticketsMod.save(project, tk2); ticketsMod.comment(project, tk2.id, '**Second-model review** (' + rv.harness + (rv.model ? ' ' + rv.model : '') + '):\n\n' + text.slice(0, 4000)); } console.log('review → ' + rec.ticket + ' by ' + rv.harness + ' (' + text.length + ' chars)'); });
          console.log('review → ' + rec.ticket + ' asked of ' + rv.harness);
        }
      } catch (e) { console.error('review after turn: ' + e.message); }
      const t0 = Date.now(); const pl = require('./plugins'); const tmod = require('./hot').hot(path.join(__dirname, 'tests.js'));
      const settle = () => {
        const busy = (rec.testsStarted && tmod.status(project).running) || pl.selected(project).some((n) => pl.scanning(project, n));
        if (busy && Date.now() - t0 < 30 * 60 * 1000) return setTimeout(settle, 5000).unref();
        rec.verifying = null;
        try { const v = require('./hot').hot(path.join(__dirname, 'verify.js')).after(project, rec.ticket, rec.before, [...rec.files], rec.files.size ? tmod.latest(project) : null, turnId); if (v) { try { require('./fleet').verdict(project, rec.ticket, v); } catch (e2) { /* not a fleet turn, or the fleet is not loaded */ } } if (v) console.log('verify → ' + rec.ticket + ' ' + (v.verdict.green ? 'GREEN' : 'RED') + (v.moved ? ' → ' + v.moved : '') + ': ' + v.verdict.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')); }
        catch (e) { console.error('verify after turn: ' + e.message); }
      };
      rec.verifying = new Date().toISOString();   // the turn is over; the tests and the rescan run, then the verdict - the board shows the ticket as "testing" meanwhile
      setTimeout(settle, rec.files.size ? 8000 : 500).unref();
    }
    /* THE INNER LOOP: a coder that worked in its own folder on a dev-landing project - its committed work
       is checked in its folder and merged into dev (engine/land.js); then the after-turn tests run ON DEV with the landed
       files (the browser flows click through the dev site with the work in it) and the ticket's verdict is given there,
       exactly as for a turn worked in the dev folder. Not landed = a red verdict naming why, and the fleet's retry. */
    if (landing) {
      rec.verifying = new Date().toISOString();
      const say = (line) => console.log('[' + project.entry.id + '] ' + line);
      const fleetVerdict = (v) => { try { require('./fleet').verdict(project, rec.ticket, v); } catch (e) { /* not a fleet turn */ } };
      require('./hot').hot(path.join(__dirname, 'land.js')).land(project, opts.agentId || a.name, say).then((r) => {
        if (!r.ok) {
          rec.verifying = null;
          const text = 'not landed in dev (' + r.step + '): ' + r.why;
          try { ticketsMod.log(project, rec.ticket, text, 'cockpit'); } catch (e) { /* */ }
          say('land → ' + rec.ticket + ' RED: ' + text);
          fleetVerdict({ verdict: { green: false, checks: [{ id: 'land', name: 'landed in dev', ok: false, detail: r.why }] }, red: ['landed in dev - ' + r.step], text });
          return;
        }
        if (r.landed) { try { ticketsMod.log(project, rec.ticket, 'landed in dev: ' + r.commits + ' commit(s), ' + r.from.slice(0, 9) + ' → ' + r.to.slice(0, 9) + ' (' + r.files.length + ' file' + (r.files.length === 1 ? '' : 's') + ')', 'cockpit'); } catch (e) { /* */ } }
        const landed = (r.files || []).map((f) => path.join(project.dir, f));
        const tmod = require('./hot').hot(path.join(__dirname, 'tests.js')), pl = require('./plugins');
        let started = false;
        if (landed.length) { try { const tr = tmod.run(project, say, { light: true, files: landed }); started = !!tr.ok; say('tests → ' + (tr.ok ? 'started on dev after landing (' + tr.files + ' file' + (tr.files === 1 ? '' : 's') + ')' : tr.error)); } catch (e) { say('tests after landing: ' + e.message); } }
        const t0 = Date.now();
        const settle = () => {
          const busyNow = (started && tmod.status(project).running) || pl.selected(project).some((n) => pl.scanning(project, n));
          if (busyNow && Date.now() - t0 < 30 * 60 * 1000) return setTimeout(settle, 5000).unref();
          rec.verifying = null;
          try { const v = require('./hot').hot(path.join(__dirname, 'verify.js')).after(project, rec.ticket, rec.before, landed, landed.length ? tmod.latest(project) : null, turnId); if (v) { fleetVerdict(v); say('verify → ' + rec.ticket + ' ' + (v.verdict.green ? 'GREEN' : 'RED') + ' on dev: ' + v.verdict.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')); } }
          catch (e) { console.error('verify after landing: ' + e.message); }
        };
        setTimeout(settle, landed.length ? 8000 : 500).unref();
      });
    }
    setTimeout(() => running.delete(turnId), 10 * 60 * 1000).unref();   // keep the event log reachable a while
  }).catch((e) => {
    clearInterval(watchdog);
    rec.outcome = { reason: 'crashed', error: String(e.message || e), text: rec.text, files: [...rec.files], cost: rec.cost, producedNothing: true };
    emit(rec, { type: 'end', reason: 'crashed', outcome: rec.outcome });
  });
  return turnId;
}

function emit(rec, ev) {
  const stamped = { ...ev, at: new Date().toISOString() };
  rec.events.push(stamped);
  conv.logEvent(rec.project, rec.id, rec.threadId, rec.harness, rec.model, ev);
  for (const fn of rec.listeners) { try { fn(stamped); } catch (e) { /* a dead listener */ } }
}

function subscribe(turnId, fn) {
  const rec = running.get(turnId);
  if (!rec) return null;
  rec.events.forEach(fn);                        // replay what already happened
  if (rec.outcome) return () => {};              // and nothing more will
  rec.listeners.add(fn);
  return () => rec.listeners.delete(fn);
}
/* A ticket approved in the middle of a turn (the owner's word in the conversation, cli ticket approve) joins that turn: it goes
   in-work, its scope is snapshotted now, and the verdict at the end judges the work as the ticket's - the same as if the turn had
   been started with it. One ticket per turn: a turn that already carries one says so. */
function attachTicket(turnId, project, ticketId) {
  const rec = running.get(turnId); if (!rec || rec.outcome || rec.ticket) return false;
  const ticketsMod = require('./hot').hot(path.join(__dirname, 'tickets.js'));
  const tk = ticketsMod.get(project, ticketId); if (!tk || tk.state !== 'created') return false;
  ticketsMod.setState(project, tk.id, 'in-work', rec.harness, 'approved in the conversation; work started in turn ' + turnId);
  rec.ticket = tk.id;
  try { rec.before = require('./hot').hot(path.join(__dirname, 'verify.js')).before(project, tk.id); } catch (e) { rec.before = null; }
  return true;
}
function stop(turnId) { const rec = running.get(turnId); if (rec && rec.handle && !rec.outcome) { rec.handle.stop('stopped'); return true; } return false; }
function status(turnId) { const rec = running.get(turnId); return rec ? { id: rec.id, harness: rec.harness, model: rec.model, events: rec.events.length, outcome: rec.outcome } : null; }

/* Read-only probe: the harness binary's own --help / --version, so an adapter can be checked
   against the real CLI on the machine the engine runs on (the desk cannot run them itself). */
function probe(name, what) {
  reload();
  const a = adapters[name]; if (!a || !a.probe) return { ok: false, error: 'no such harness' };
  return a.probe(what);
}
/* The global turn ledger: one line per finished turn, every harness, every project, fleet or
   conversation - the Lane performance card reads it. Engine-level like fleet.json, because the question is about the AGENTS, across
   projects. Each project's own .cockpit\logs keeps the full event stream. */
function ledger(engineRoot, row) {
  try { fs.appendFileSync(path.join(engineRoot, 'turns.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); } catch (e) { /* never fail a turn over bookkeeping */ }
}
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
/* ONE-TIME import of the turns a project logged before the ledger existed. Each
   project's .cockpit\logs\turns.jsonl 'end' rows carry everything a ledger row does; they are
   appended once, in time order, and the project gets a marker so it is never read again. */
function importOldTurns(engineRoot) {
  const ledgerFile = path.join(engineRoot, 'turns.jsonl');
  const have = new Set(readLines(ledgerFile).map((r) => r.project + '|' + String(r.at).slice(0, 19)));
  let imported = 0;
  for (const p of require('./registry').all()) {
    const logDir = path.join(p.path, '.cockpit', 'logs'), marker = path.join(logDir, '.imported-to-ledger');
    if (fs.existsSync(marker)) continue;
    const rows = readLines(path.join(logDir, 'turns.jsonl')).filter((ev) => ev.type === 'end').map((ev) => { const o = ev.outcome || {}; return { at: ev.ts, harness: ev.harness, model: ev.model, project: p.id, thread: ev.thread, reason: ev.reason, producedNothing: !!o.producedNothing, files: (o.files || []).length, cost: o.cost || null, durationSec: o.durationSec || 0, fleet: false, imported: true }; })
      .filter((r) => r.harness && !have.has(r.project + '|' + String(r.at).slice(0, 19)));
    if (rows.length) { fs.appendFileSync(ledgerFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); imported += rows.length; }
    try { if (fs.existsSync(logDir)) fs.writeFileSync(marker, new Date().toISOString() + ' ' + rows.length + ' turns imported\n'); } catch (e) { /* project may be read-only */ }
  }
  if (imported) console.log('ledger → imported ' + imported + ' earlier turn' + (imported === 1 ? '' : 's') + ' from project logs');
}
function performance(engineRoot, sinceMs) {
  let rows = readLines(path.join(engineRoot, 'turns.jsonl')).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const cut = sinceMs ? Date.now() - sinceMs : 0;
  rows = rows.filter((r) => !cut || Date.parse(r.at) >= cut);
  const by = {};
  rows.forEach((r) => {
    const k = r.harness; const s = by[k] || (by[k] = { harness: k, turns: 0, produced: 0, nothing: 0, failed: 0, fleet: 0, inTokens: 0, outTokens: 0, cacheRead: 0, seconds: 0, costRows: 0, projects: {}, models: {} });
    s.turns++; if (r.fleet) s.fleet++;
    if (r.reason !== 'done') s.failed++; else if (r.producedNothing) s.nothing++; else s.produced++;
    if (r.cost) { s.inTokens += r.cost.inTokens || 0; s.outTokens += r.cost.outTokens || 0; s.cacheRead += r.cost.cacheRead || 0; s.costRows++; }
    s.seconds += r.durationSec || 0; s.projects[r.project] = (s.projects[r.project] || 0) + 1; s.models[r.model] = (s.models[r.model] || 0) + 1;
  });
  return { rows: rows.length, agents: Object.values(by) };
}

/* USAGE LEFT, from the harness itself. ONE mechanism: adapter.usage() answers with the plan's own
   windows (Claude from its account endpoint, Codex from its app-server); the engine asks at
   start, on a timer, after every turn, and when the owner clicks the pill. The answer lands
   on the agent through fleet and beats a hand-entered number because it is the plan's own. */
function noteUsage(harnessName, u) {
  let fleet; try { fleet = require('./fleet'); } catch (e) { return; }
  if (fleet.usageFromHarness) fleet.usageFromHarness(harnessName, u);
}
/* Per CODER, not per kind: several Claude coders each on their own account read their own plan.
   Every fleet agent whose harness can answer is asked with its own login folder (the harness's configEnv in the agent's
   env); `only` names one agent - or, for callers from before, a harness, which asks every agent of that kind. */
async function probeUsage(only) {
  reload();
  const out = {};
  let agents = []; try { agents = require('./fleet').state().agents || []; } catch (e) { /* the fleet is not loaded */ }
  if (!agents.length) agents = Object.values(adapters).map((a) => ({ id: a.name, harness: a.name, env: null }));
  for (const ag of agents) {
    const a = adapters[ag.harness];
    if (!a || typeof a.usage !== 'function' || (only && ag.id !== only && ag.harness !== only)) continue;
    if (!a.available().ok) { out[ag.id] = { ok: false, why: 'not available' }; continue; }
    const configDir = a.configEnv && ag.env ? ag.env[a.configEnv] : null;
    let r; try { r = await a.usage({ configDir }); } catch (e) { r = { ok: false, why: e.message }; }
    out[ag.id] = r;
    if (r && r.ok) noteUsage(ag.id, { status: 'read', plan: r.plan || null, windows: r.windows || [] });
  }
  return out;
}
function canProbeUsage(harnessName) { const a = adapters[harnessName]; return !!(a && typeof a.usage === 'function'); }

module.exports = { load, list, run, subscribe, stop, attachTicket, status, probe, busy, runningIn, EXCLUSIVE, performance, importOldTurns, probeUsage, canProbeUsage, verifyingIn };
