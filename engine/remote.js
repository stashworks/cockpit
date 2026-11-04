/* Remote Control for a project - Claude Code's own, wrapped.

   `claude --bg --remote-control "<project>"` starts a background Claude Code session IN the
   project folder, registered with the owner's claude.ai so the phone / claude.ai shows it
   under Remote Control. It carries Cockpit's prompt tiers (tier 0 + doctrine + global +
   project + plugins), so it knows cli.js and the rules; it runs on this machine, so cli.js
   is loopback. What it is NOT: Cockpit's page. The conversation lives in Claude's session
   until `import-claude` brings it into this project's record.

   Everything Claude prints comes back verbatim - an id, or the reason it did not start.
   Untested under the PM2 service on 2026-09-17: whether a session with no console registers.
   The owner's first /remote on is the test. Hot module: fix and retry without a restart. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

function file(project) { return path.join(project.cockpit.dir, 'remote.json'); }
function read(project) { try { return JSON.parse(fs.readFileSync(file(project), 'utf8')); } catch (e) { return null; } }
function write(project, o) { if (o) fs.writeFileSync(file(project), JSON.stringify(o, null, 2) + '\n'); else try { fs.unlinkSync(file(project)); } catch (e) { /* none */ } }

function launcher(engineRoot) { const f = path.join(engineRoot, 'engine', 'spawn-cli.js'); delete require.cache[require.resolve(f)]; return require(f); }
function run(engineRoot, project, args, ms) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    const finish = (code, why) => { if (done) return; done = true; resolve({ code, out: out.trim(), err: err.trim(), why }); };
    try { child = launcher(engineRoot).spawn('claude', args, { cwd: project.dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...require('./ghauth').envFor(project) } }); }
    catch (e) { return resolve({ code: -1, out: '', err: 'could not start claude: ' + e.message }); }
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('close', (code) => finish(code, 'closed'));
    child.on('error', (e) => { err += String(e.message); finish(-1, 'error'); });
    setTimeout(() => { if (!done) { finish(null, 'still running after ' + Math.round(ms / 1000) + ' s - left it running'); } }, ms);
  });
}

async function start(engineRoot, project, name) {
  const cur = read(project); if (cur && cur.id) return { ok: false, error: 'already on: ' + cur.name + ' (' + cur.id + ') - /remote off first', remote: cur };
  const prompt = require('./prompt');
  const sys = prompt.tier0(engineRoot, project) + '\n\n---\n\n' + prompt.systemPrompt(engineRoot, project).text
    + '\n\n---\n\nThis session is driven from the owner\'s phone through Remote Control. Keep answers short; he is reading on a small screen. Cockpit\'s cli is reachable as usual.';
  const label = name || ('Cockpit · ' + (project.entry.name || project.entry.id));
  // as a file: the prompt is over Windows' 32 KB argument limit (spawn ENAMETOOLONG on the first try, 2026-09-17)
  const sysF = path.join(project.cockpit.dir, 'remote-system.md'); fs.writeFileSync(sysF, sys);
  const r = await run(engineRoot, project, ['--bg', '--remote-control', label, '--append-system-prompt-file', sysF, '--disallowedTools', 'Write(**/.claude/**),Edit(**/.claude/**)'], 45000);
  const text = [r.out, r.err].filter(Boolean).join('\n');
  // the id `claude attach` takes - the first short token that looks like one, else whatever was printed
  const m = /\b([a-z0-9]{6,12})\b/i.exec(r.out.split('\n').find((l) => /\b(id|session|attach|started)\b/i.test(l)) || r.out) ;
  const id = m ? m[1] : null;
  const rec = { id, name: label, started: new Date().toISOString(), text: text.slice(0, 2000), code: r.code, why: r.why };
  if (id || r.why === 'still running after 45 s - left it running') write(project, rec);
  return { ok: !!id, id, remote: rec, error: id ? null : 'claude did not print a session id - what it said is below', text };
}
/* Claude keeps a session as <home>\.claude\projects\<slug>\<id>.jsonl, slug = the folder path with
   every non-alphanumeric character as '-'. Match case-insensitively: the drive letter's case follows
   however the folder was named. */
function sessionsDir(project) {
  const base = path.join(require('node:os').homedir(), '.claude', 'projects');
  const want = String(project.dir).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  let names = []; try { names = fs.readdirSync(base); } catch (e) { return null; }
  const hit = names.find((n) => n.toLowerCase() === want); return hit ? path.join(base, hit) : null;
}
function importSessions(engineRoot, project) {
  return new Promise((resolve) => {
    const dir = sessionsDir(project);
    if (!dir) return resolve({ ok: false, text: 'no Claude session store for this folder yet (' + String(project.dir).replace(/[^a-zA-Z0-9]/g, '-') + ')' });
    cp.execFile(process.execPath, [path.join(engineRoot, 'tools', 'import-claude-sessions.js'), project.dir, dir], { timeout: 120000, windowsHide: true }, (err, out, errOut) => {
      const text = [out, errOut].filter(Boolean).join('\n').trim();
      const m = /(\d+) sessions? imported, (\d+) skipped/.exec(text);
      resolve({ ok: !err, imported: m ? Number(m[1]) : 0, skipped: m ? Number(m[2]) : 0, text: text.slice(-1500), dir });
    });
  });
}
async function stop(engineRoot, project) {
  const cur = read(project); if (!cur) return { ok: false, error: 'nothing on' };
  const r = cur.id ? await run(engineRoot, project, ['stop', cur.id], 30000) : { out: '', err: 'no id was recorded - stop it with  claude agents  /  claude stop <id>  on the machine' };
  write(project, null);
  const imp = await importSessions(engineRoot, project);   // the session's transcript into this project's conversations
  try { require('./projects').bump(project.entry.id); } catch (e) { /* the room re-reads on its own poll */ }
  return { ok: true, was: cur, text: [r.out, r.err].filter(Boolean).join('\n'), imported: imp };
}
async function status(engineRoot, project) {
  const cur = read(project);
  const r = await run(engineRoot, project, ['agents'], 30000);
  const imp = await importSessions(engineRoot, project);   // status also pulls in anything finished since
  if (imp.imported) { try { require('./projects').bump(project.entry.id); } catch (e) { /* */ } }
  return { ok: true, remote: cur, imported: imp, agents: [r.out, r.err].filter(Boolean).join('\n').slice(0, 3000) };
}

module.exports = { start, stop, status, read, importSessions, sessionsDir };
