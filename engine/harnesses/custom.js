/* The generic adapter: any command-line AI tool the owner adds on the Settings › AI page. One entry in custom.json is one harness. Cockpit knows nothing about the tool beyond what the entry
   says: the command, how the prompt and the model are passed, which models it may be asked for. What comes back on
   stdout is the answer, streamed as text; there are no tool or file events (the tool's own work is invisible to
   Cockpit) and no cost - the interface's floor, honestly reported. Sign-in is the tool's own business: "installed"
   is all Cockpit can see.

   custom.json:
     { "off": ["pi"],                              harnesses switched off - hidden from the picker and the fleet
       "tools": [ { "name": "grok", "label": "Grok CLI", "command": "grok",
                    "args": ["-p", "{prompt}", "--model", "{model}"],   {prompt} {model} {system} {systemFile} {cwd}
                    "models": [ { "id": "grok-4", "label": "Grok 4", "contextTokens": 128000 } ],
                    "site": "https://…", "signin": "grok login", "stdin": false } ] }
   No {prompt} in args: the prompt goes in on stdin. No {system}/{systemFile}: the system tiers are prepended to
   the prompt. Re-read when the file changes. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const FILE = path.join(__dirname, 'custom.json');
const launcher = () => require('../spawn-cli');

function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return { off: [], tools: [] }; } }
function write(j) { fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n'); }

function adapterFor(t) {
  const name = String(t.name || '').trim();
  const models = () => (t.models || []).map((m) => ({ id: m.id, label: m.label || m.id, contextTokens: Number(m.contextTokens) || 128000, free: !!m.free }));
  function available() {
    const r = launcher().resolve(t.command); if (!r.ok) return { ok: false, why: r.why };
    let v = ''; try { v = cp.execSync('"' + r.via.replace(/^node /, '') + '" --version', { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim().split('\n')[0]; } catch (e) { v = 'installed'; }
    return { ok: true, why: v };
  }
  function setup() {
    const av = available();
    return {
      installed: av.ok, version: av.ok ? av.why : null, why: av.ok ? null : av.why,
      account: av.ok ? { ok: true, who: 'the tool\'s own login (Cockpit cannot see it)', expired: false } : { ok: false, why: 'not installed' },
      models: models().map((m) => m.id),
      connect: [
        av.ok ? null : 'Install ' + (t.label || name) + ' on this machine' + (t.site ? ': ' + t.site : '') + '. Cockpit never installs.',
        t.signin ? 'Sign in on this machine as the user the engine runs as: ' + t.signin : null,
        'A generic tool: Cockpit streams what it prints as the answer. Its own tool use and files are not seen; nothing is known about cost.'
      ].filter(Boolean)
    };
  }
  function start(turn) {
    const listeners = []; const on = (fn) => listeners.push(fn); const emit = (ev) => listeners.forEach((fn) => fn(ev));
    const tmp = path.join(turn.project, '.cockpit', 'cache'); try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) { /* exists */ }
    const sysFile = path.join(tmp, name + '-system.md'); fs.writeFileSync(sysFile, turn.system || '');
    const argsT = Array.isArray(t.args) ? t.args : String(t.args || '').split(/\s+/).filter(Boolean);
    const hasPrompt = argsT.some((a) => a.includes('{prompt}')), hasSys = argsT.some((a) => a.includes('{system}') || a.includes('{systemFile}'));
    const promptText = hasSys ? turn.prompt : (turn.system ? turn.system + '\n\n---\n\n' + turn.prompt : turn.prompt);
    const args = argsT.map((a) => a.replace('{prompt}', promptText).replace('{model}', turn.model).replace('{system}', turn.system || '').replace('{systemFile}', sysFile).replace('{cwd}', turn.project));
    const failed = (msg) => { setTimeout(() => emit({ type: 'error', text: msg }), 0); return { on, done: new Promise((r) => setTimeout(() => r({ reason: 'crashed' }), 5)), stop: () => {} }; };
    let child;
    try { child = launcher().spawn(t.command, args, { cwd: turn.project, stdio: ['pipe', 'pipe', 'pipe'], env: turn.env || process.env }); }
    catch (e) { return failed('could not start ' + t.command + ': ' + e.message); }
    child.stdin.on('error', () => { /* a child that died at once: its close handler reports the turn; an unheard EPIPE would take the engine down (2026-09-30) */ });
    if (!hasPrompt) { child.stdin.write(promptText); } child.stdin.end();
    let err = '';
    child.stdout.on('data', (d) => emit({ type: 'text', text: d.toString('utf8') }));
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const done = new Promise((resolve) => {
      child.on('close', (code) => { if (code !== 0 && err.trim()) emit({ type: 'error', text: err.trim().slice(0, 2000) }); emit({ type: 'end', reason: code === 0 ? 'done' : 'crashed' }); resolve({ reason: code === 0 ? 'done' : 'crashed' }); });
      child.on('error', (e) => { emit({ type: 'error', text: e.message }); emit({ type: 'end', reason: 'crashed' }); resolve({ reason: 'crashed' }); });
    });
    return { on, done, pid: child.pid, stop: () => { try { process.platform === 'win32' ? cp.execSync('taskkill /pid ' + child.pid + ' /T /F', { windowsHide: true }) : child.kill('SIGKILL'); } catch (e) { /* gone */ } } };
  }
  return { name, label: t.label || name, custom: true, models, available, setup, start, probe: (what) => (what === 'setup' ? setup() : { ok: true }) };
}

/* the harness layer registers each of these; re-read by harness.reload() when custom.json changes */
module.exports = { adapters: () => read().tools.filter((t) => t.name && t.command).map(adapterFor), read, write, FILE,
  /* a harness layer from before this file existed registers a module as one adapter: give it a dud one instead of a
     crash, so the picker keeps working until the engine restarts and reads the file the new way */
  name: 'custom', label: 'custom tools (restart the engine)', custom: true, models: () => [], available: () => ({ ok: false, why: 'restart the engine to load the tools you added' }), setup: () => ({ installed: false, why: 'restart needed' }), probe: () => ({ ok: false }) };
