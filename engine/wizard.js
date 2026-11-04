/* THE FIRST-RUN WIZARD's engine side (owner, 2026-10-08: "We need a wizard and tutorial ... idiot proof"). The browser
   walks a new person through: their name, where Cockpit runs (the port, starting with Windows), Git, Claude Code
   (installed? signed in?), Home, a first folder, and a tour. This file answers what the screens need and does the few
   things a browser cannot:
     state()          what is in place right now (every screen re-asks every few seconds, so an install finished
                      elsewhere ticks itself)
     install(what)    Git (winget) or Claude Code (Anthropic's official installer), hidden, its output kept for the screen
     signin()         opens a window running `claude`, where the person signs in; state() sees the result
     setPort(port)    saves the port in engine.json and moves the engine there (a new engine starts, this one stops)
     startup(on)      "Start Cockpit automatically when I sign in": a Scheduled Task for this Windows user only, run at
                      their sign-in, hidden, that keeps Cockpit running (scripts\start.ps1 -Watch, the watchdog). No
                      service, no administrator. Where Windows refuses the task, a Startup-folder shortcut does the same.
                      On by default (autoDefault); engine.json "autostart" remembers the person's choice.
     done(flag)       the wizard is finished (engine.json "wizardDone"); Settings can run it again
     stop()           the engine stops (there is no console window to close any more), and leaves run\stopped so the
                      watchdog knows it was on purpose and does not start it again
   Every action here is the owner's alone (server.js refuses an AI). Nothing is installed without the person pressing
   the button for it. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');

let ROOT = null, CONFIG = null;
function init(root, config) { ROOT = root; CONFIG = config; }

const engineFile = () => path.join(ROOT, 'engine.json');
function readFile() { try { return JSON.parse(fs.readFileSync(engineFile(), 'utf8').replace(/^﻿/, '')); } catch (e) { return {}; } }
function writeFile(patch) { const f = Object.assign(readFile(), patch); fs.writeFileSync(engineFile(), JSON.stringify(f, null, 2) + '\n'); return f; }

const startupDir = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const startupLink = () => path.join(startupDir(), 'Cockpit.lnk');
const credFile = () => path.join(os.homedir(), '.claude', '.credentials.json');

/* the installs: one at a time each, their output kept (the last 200 lines) for the screen */
const jobs = global.__cockpitWizardJobs || (global.__cockpitWizardJobs = {});
function job(what) { return jobs[what] || null; }

function tools() {
  const sc = require('./spawn-cli');
  const git = sc.versionOf('git'), claude = sc.versionOf('claude');
  const winget = process.platform === 'win32' ? sc.versionOf('winget') : { ok: false };
  const signedIn = !!process.env.ANTHROPIC_API_KEY || fs.existsSync(credFile());
  return {
    git: { ok: git.ok, version: git.ok ? git.why : null, canInstall: winget.ok, job: job('git') },
    claude: { ok: claude.ok, version: claude.ok ? claude.why.split(/\s/)[0] : null, signedIn, apiKey: !!process.env.ANTHROPIC_API_KEY, canInstall: process.platform === 'win32', job: job('claude') }
  };
}

function state() {
  const f = readFile();
  const home = require('./registry').get('home');
  const others = require('./registry').all().filter((p) => p.id !== 'home');
  return {
    ok: true,
    done: !!f.wizardDone,
    port: CONFIG.port, savedPort: f.port || null, defaultPort: require('./config').DEFAULT_PORT, url: 'http://localhost:' + CONFIG.port,
    ...startupState(), canStartup: process.platform === 'win32',
    home: home ? { path: home.path } : null,
    projects: others.length,
    ...tools()
  };
}

/* ---------- installs ---------- */
function run(what, file, args, after) {
  if (jobs[what] && jobs[what].running) return { ok: false, error: 'already installing' };
  const j = jobs[what] = { running: true, ok: null, started: new Date().toISOString(), log: [] };
  const add = (chunk) => { String(chunk).split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd()).filter(Boolean).forEach((l) => j.log.push(l)); if (j.log.length > 200) j.log.splice(0, j.log.length - 200); };
  let child;
  try { child = cp.spawn(file, args, { windowsHide: true, env: process.env }); }
  catch (e) { j.running = false; j.ok = false; add('could not start: ' + e.message); return { ok: false, error: e.message }; }
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('error', (e) => { add('could not start: ' + e.message); });
  child.on('close', (code) => {
    require('./pathfix').widen(console.log);   // the new tool's folder, for this running engine and everything it starts
    const sc = require('./spawn-cli'); sc.forget(what === 'claude' ? 'claude' : 'git');
    j.running = false; j.code = code;
    j.ok = after();
    add(j.ok ? 'done.' : 'the install finished but the tool is not found yet (exit ' + code + ')');
    console.log('wizard → install ' + what + ': ' + (j.ok ? 'ok' : 'not found after the install, exit ' + code));
  });
  console.log('wizard → installing ' + what);
  return { ok: true };
}
function install(what) {
  if (process.platform !== 'win32') return { ok: false, error: 'installing from here is for Windows; on this system install it the usual way' };
  const sc = require('./spawn-cli');
  if (what === 'git') {
    if (!sc.versionOf('winget').ok) return { ok: false, error: 'winget (the Windows app installer) is not on this PC - get Git from git-scm.com' };
    return run('git', 'winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent'], () => { sc.forget('git'); return sc.versionOf('git').ok; });
  }
  if (what === 'claude') {
    /* Anthropic's own installer (no administrator), then ~\.local\bin on your PATH for new windows */
    const bin = path.join(os.homedir(), '.local', 'bin').replace(/'/g, "''");
    const ps = "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; "
      + "Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression; "
      + "$u = [Environment]::GetEnvironmentVariable('Path','User'); if ($u -notlike '*" + bin + "*') { [Environment]::SetEnvironmentVariable('Path', ($u.TrimEnd(';') + ';" + bin + "'), 'User'); 'added " + bin + " to your PATH' }";
    return run('claude', 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], () => { sc.forget('claude'); return sc.versionOf('claude').ok; });
  }
  return { ok: false, error: 'nothing called ' + what + ' to install' };
}

/* ---------- sign in to Claude: a window of its own, where `claude` asks you to sign in ---------- */
function signin() {
  if (!require('./spawn-cli').versionOf('claude').ok) return { ok: false, error: 'Claude Code is not installed yet' };
  if (process.platform !== 'win32') return { ok: false, error: 'open a terminal and run: claude' };
  const msg = "$Host.UI.RawUI.WindowTitle = 'Sign in to Claude'; Write-Host ''; Write-Host '  Sign in to Claude' -ForegroundColor Cyan; Write-Host '  Follow the steps below. When it says you are signed in, close this window.'; Write-Host ''; claude";
  /* 2026-10-19: was `cmd /c start "Sign in to Claude" powershell -Command <msg>`. Node escapes the quotes it adds around
     each argument, so cmd split the title into words and Windows said it "cannot find 'in'". Now: no cmd, no title
     argument (the window sets its own title), and the script travels base64-encoded, so no quoting can break it. */
  const ch = cp.spawn('powershell.exe', ['-NoProfile', '-Command',
    "Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile','-EncodedCommand','" + Buffer.from(msg, 'utf16le').toString('base64') + "'"],
  { detached: true, stdio: 'ignore', windowsHide: true });
  ch.unref();
  console.log('wizard → opened the Claude sign-in window');
  return { ok: true };
}

/* ---------- the port ---------- */
function free(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}
async function setPort(port) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'a port is a whole number from 1024 to 65535' };
  if (port === CONFIG.port) { writeFile({ port }); return { ok: true, url: 'http://localhost:' + port, same: true }; }
  if (!(await free(port, CONFIG.host))) return { ok: false, error: 'port ' + port + ' is already in use by another program - pick another' };
  writeFile({ port });
  return { ok: true, url: 'http://localhost:' + port, restart: true };
}
/* a new engine in the background (on the saved port), then this one goes - called after the answer has been sent */
function restart() {
  const env = { ...process.env }; delete env.COCKPIT_PORT; delete env.PORT; delete env.COCKPIT_URL;   // the saved port wins
  env.COCKPIT_LOG_FILE = env.COCKPIT_LOG_FILE || path.join(ROOT, 'logs', 'engine.log');   // hidden: it writes its own log (index.js)
  const ch = cp.spawn(process.execPath, [path.join(ROOT, 'index.js')], { cwd: ROOT, env, detached: true, stdio: 'ignore', windowsHide: true });
  ch.unref();
  console.log('wizard → restarting on the saved port (new engine pid ' + ch.pid + ')');
  setTimeout(() => process.exit(0), 400);
}

/* ---------- start with Windows, and keep running ----------
   WHY COCKPIT KEPT STOPPING (2026-10-25, the owner's wife's PC): it ran only while something kept it running. It started
   only from Start Cockpit.cmd (the Startup shortcut was an unticked box in the wizard, so after a restart nothing started
   it); an engine that hit an error ended (index.js writes the reason to logs\crash.log and exits) and nothing started it
   again; and with Windows Terminal as the default terminal a "hidden" console could still show up, and closing it ended
   the engine. Now: a Scheduled Task for this user, at their sign-in, runs scripts\start.ps1 -Watch - a watchdog with no
   window that starts the engine with no console at all and starts it again if it ends on its own. Stop (Settings, or
   Stop Cockpit.cmd) leaves run\stopped first, and the watchdog never undoes a stop.
   A task for the current user, run as that user, needs no administrator. If Windows refuses it anyway (a locked-down
   PC), a shortcut in the Startup folder runs the same watchdog. COCKPIT_AUTOSTART_DRYRUN=1 writes what would be run to
   logs\autostart-dryrun.ps1 and changes nothing on the machine (tests). */
const TASK_PATH = '\\Cockpit\\', TASK_NAME = 'Cockpit';
const dryRun = () => process.env.COCKPIT_AUTOSTART_DRYRUN === '1';
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/* what Windows runs at sign-in: the watchdog, with no window (conhost --headless runs PowerShell with no console at all;
   without conhost, PowerShell's own hidden window, which can flash for a moment) */
function launcher() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const ps = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const conhost = path.join(sys, 'System32', 'conhost.exe');
  const args = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + path.join(ROOT, 'scripts', 'start.ps1') + '" -Watch -AtLogon';
  return fs.existsSync(conhost) ? { exe: conhost, args: '--headless "' + ps + '" ' + args } : { exe: ps, args };
}
function taskScript(on) {
  if (!on) return "Unregister-ScheduledTask -TaskPath " + q(TASK_PATH) + " -TaskName " + q(TASK_NAME) + " -Confirm:$false -ErrorAction SilentlyContinue; 'ok'";
  const l = launcher();
  return "$ErrorActionPreference = 'Stop'; $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; "
    + '$a = New-ScheduledTaskAction -Execute ' + q(l.exe) + ' -Argument ' + q(l.args) + ' -WorkingDirectory ' + q(ROOT) + '; '
    + '$t = New-ScheduledTaskTrigger -AtLogOn -User $me; '
    // no time limit; started late if the PC was busy at sign-in; started again (3 times, a minute apart) if it fails to start; one at a time
    + '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Hidden; '
    + '$p = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited; '
    + 'Register-ScheduledTask -TaskPath ' + q(TASK_PATH) + ' -TaskName ' + q(TASK_NAME) + ' -Action $a -Trigger $t -Settings $s -Principal $p -Description ' + q('Starts Cockpit (' + ROOT + ') in the background when you sign in, and keeps it running. Turn it off in Cockpit: Settings - Engine.') + " -Force | Out-Null; 'ok'";
}
function shortcutScript() {
  const l = launcher();
  return '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + q(startupLink()) + '); $s.TargetPath = ' + q(l.exe) + '; $s.Arguments = ' + q(l.args) + '; '
    + '$s.WorkingDirectory = ' + q(ROOT) + '; $s.WindowStyle = 7; $s.Description = ' + q('Starts Cockpit in the background') + "; $s.Save(); 'ok'";
}
function runPs(script) {
  return new Promise((resolve) => cp.execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 60000 }, (err, out, errOut) => resolve(err ? { ok: false, error: String(errOut || err.message).trim().split(/\r?\n/)[0] } : { ok: /ok/.test(String(out)) })));
}
/* is the task there? schtasks answers in a few milliseconds; the answer is kept for 15 s (the wizard asks every few seconds) */
let taskSeen = { at: 0, on: false }, dryState = null;
function taskExists() {
  if (dryRun()) return !!(dryState && dryState.method === 'task');
  if (process.platform !== 'win32') return false;
  if (Date.now() - taskSeen.at < 15000) return taskSeen.on;
  let on = false; try { cp.execFileSync('schtasks.exe', ['/Query', '/TN', TASK_PATH + TASK_NAME], { windowsHide: true, timeout: 10000, stdio: 'ignore' }); on = true; } catch (e) { /* not there */ }
  taskSeen = { at: Date.now(), on }; return on;
}
function startupState() {
  const task = taskExists(), link = dryRun() ? !!(dryState && dryState.method === 'shortcut') : fs.existsSync(startupLink());
  return { startup: task || link, startupMethod: task ? 'task' : link ? 'shortcut' : null, startupChosen: readFile().autostart !== undefined };
}
async function startup(on) {
  if (process.platform !== 'win32') return { ok: false, error: 'only on Windows' };
  taskSeen.at = 0;
  if (dryRun()) {
    try { fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'logs', 'autostart-dryrun.ps1'), '# COCKPIT_AUTOSTART_DRYRUN=1 - nothing was run. This is what would be.\n' + taskScript(!!on) + '\n# the old Startup shortcut, removed: ' + startupLink() + '\n'); } catch (e) { /* only a record */ }
    dryState = on ? { method: 'task' } : null; writeFile({ autostart: !!on });
    console.log('wizard → autostart ' + (on ? 'on' : 'off') + ' (dry run: logs\\autostart-dryrun.ps1)');
    return { ok: true, dryRun: true, ...startupState() };
  }
  if (!on) {
    const r = await runPs(taskScript(false));
    try { fs.unlinkSync(startupLink()); } catch (e) { /* already gone */ }
    taskSeen.at = 0; writeFile({ autostart: false });
    console.log('wizard → autostart off' + (r.ok ? '' : ' (' + r.error + ')'));
    return { ok: true, ...startupState() };
  }
  let r = await runPs(taskScript(true)); taskSeen.at = 0;
  if (r.ok && taskExists()) { try { fs.unlinkSync(startupLink()); } catch (e) { /* the old way, gone */ } writeFile({ autostart: true }); console.log('wizard → autostart on (a Scheduled Task for this user)'); return { ok: true, ...startupState() }; }
  const why = r.error || 'the task was not created';
  r = await runPs(shortcutScript());
  if (r.ok && fs.existsSync(startupLink())) { writeFile({ autostart: true }); console.log('wizard → autostart on (Startup shortcut; the task was refused: ' + why + ')'); return { ok: true, note: 'Windows refused a scheduled task (' + why + '), so a Startup shortcut does it instead', ...startupState() }; }
  return { ok: false, error: 'Windows would not let Cockpit start itself at sign-in: ' + why + (r.error ? '; the Startup shortcut failed too: ' + r.error : '') };
}
/* ON BY DEFAULT: the first time the engine runs from Start Cockpit (or the watchdog) and nobody has chosen yet, it switches
   itself on - so a PC that was set up before this existed starts with Windows from the next Start Cockpit, with no
   clicking. Someone who turns it off is never switched back. `node index.js` from a terminal (a developer) is left alone. */
function autoDefault() {
  if (process.platform !== 'win32' || process.env.COCKPIT_LAUNCHED_BY !== 'start.ps1') return;
  if (readFile().autostart !== undefined) return;
  startup(true).then((r) => { if (!r.ok) console.log('wizard → could not switch autostart on by default: ' + r.error); }).catch((e) => console.log('wizard → autostart: ' + e.message));
}

function done(flag) { writeFile({ wizardDone: flag !== false }); return { ok: true, done: flag !== false }; }

/* stopped on purpose: the file run\stopped tells the watchdog (scripts\start.ps1 -Watch) not to start it again */
function stop() {
  console.log('wizard → stop asked for from the browser');
  try { fs.mkdirSync(path.join(ROOT, 'run'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'run', 'stopped'), 'stopped from the browser ' + new Date().toISOString() + '\n'); } catch (e) { /* the stop still happens */ }
  setTimeout(() => process.exit(0), 300); return { ok: true };
}

module.exports = { init, state, install, signin, setPort, restart, startup, autoDefault, done, stop, free };
