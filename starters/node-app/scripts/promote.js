#!/usr/bin/env node
/* {{TITLE}} - promote main to PROD, then READ IT BACK (run on the machine that hosts prod, from anywhere: node scripts\promote.js).

   attempt -> verify -> restore -> verify -> log (the doctrine: state-changes-carry-fallback; never trust reported success):
     1. {{NAME}}_prod must be clean (prod is never edited by hand) and on main; remember where it is.
     2. fetch main, fast-forward (never a merge), npm ci when the lockfile moved, apply db\migrations (scripts\migrate.js when it exists).
     3. restart PM2's "{{NAME}}".
     4. SMOKE: the health endpoint on the promoted URL answers ok with the version just promoted, the shell serves, and
        one real flow runs through a browser against the promoted URL (the files under ## Tests smoke: in
        .cockpit\project.md; default test\health.browser.test.js) - Playwright and Chromium from Cockpit's folder.
        Read back, not assumed. Only read-only flows belong in smoke: it runs against PROD.
     5. If the smoke fails: check out the previous commit, npm ci, restart, smoke again - and say so loudly.
     6. Write the result to the DEV checkout's .cockpit\tests\smoke.json so Cockpit's map shows the last promote's smoke.
   Promotion is the owner's gate: this script runs only when he says. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const NAME = '{{NAME}}', PROD = process.env.PROD_DIR || '{{PROD_DIR}}', DEV = process.env.DEV_DIR || '{{DEV_DIR}}';
const URL = process.env.PROD_URL || 'http://127.0.0.1:{{PORT_PROD}}';
const COCKPIT = process.env.COCKPIT_DIR || '{{COCKPIT_DIR}}';   // the engine folder: Playwright + browsers for the smoke flow
const sh = (cmd, opts) => cp.execSync(cmd, { cwd: PROD, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(opts || {}) }).trim();
const log = (m) => console.log('[promote ' + new Date().toISOString().slice(11, 19) + '] ' + m);
const result = { at: new Date().toISOString(), from: null, to: null, smoke: null, rolledBack: false, ok: false, steps: [] };
const step = (name, fn) => { try { const r = fn(); result.steps.push({ name, ok: true }); return r; } catch (e) { result.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 400) }); throw e; } };
const writeResult = () => { try { const d = path.join(DEV, '.cockpit', 'tests'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'smoke.json'), JSON.stringify(result, null, 1) + '\n'); } catch (e) { log('could not write the smoke result to the dev checkout: ' + e.message); } };

async function smoke(expectVersion) {
  const out = { ok: false, health: null, shell: null, version: null, flows: null };
  try {
    const h = await (await fetch(URL + '/api/health', { signal: AbortSignal.timeout(8000) })).json();
    out.health = h.ok === true; out.version = h.version || null;
    const page = await (await fetch(URL + '/', { signal: AbortSignal.timeout(8000) })).text();
    out.shell = page.includes('<title>');
    out.ok = out.health && out.shell && (!expectVersion || h.version === expectVersion);
    if (expectVersion && h.version !== expectVersion) out.why = 'health reports version ' + h.version + ', promoted ' + expectVersion;
    if (out.ok) { out.flows = smokeFlows(); if (out.flows.length && out.flows.some((f) => !f.ok)) { out.ok = false; out.why = 'flow ' + out.flows.find((f) => !f.ok).file + ' failed against ' + URL; } }
  } catch (e) { out.why = e.message; }
  return out;
}
/* the smoke flows: browser tests against the promoted URL, read-only by contract (they run against prod) */
function smokeFlows() {
  let list = ['test/health.browser.test.js'];
  try { const md = fs.readFileSync(path.join(DEV, '.cockpit', 'project.md'), 'utf8'); const sec = /^##\s+Tests\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md); const m = sec && /^\s*(?:-\s*)?smoke:\s*(.+)$/im.exec(sec[1]); if (m) list = m[1].split(',').map((x) => x.trim()).filter(Boolean); } catch (e) { /* the default */ }
  list = list.filter((f) => fs.existsSync(path.join(PROD, f)));
  if (!list.length) return [];
  if (!fs.existsSync(path.join(COCKPIT, 'node_modules', 'playwright'))) { log('smoke flows skipped: no playwright under ' + COCKPIT + ' (COCKPIT_DIR)'); return []; }
  const env = { ...process.env, APP_URL: URL, NODE_PATH: path.join(COCKPIT, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: path.join(COCKPIT, 'browsers') };
  return list.map((f) => { const r = cp.spawnSync(process.execPath, ['--test', f], { cwd: PROD, env, encoding: 'utf8', windowsHide: true, timeout: 180000 }); const ok = r.status === 0; log('smoke flow ' + f + ': ' + (ok ? 'ok' : 'FAILED')); return { file: f, ok, tail: String((r.stdout || '') + (r.stderr || '')).slice(-1500) }; });
}
/* the release notes are the tickets: every ticket the promoted commits name (#n / Ln), from the dev checkout's
   .cockpit\tickets, prepended to CHANGELOG.md in the DEV checkout (committed with the next change). Nothing written twice. */
function changelog(version) {
  try {
    const names = new Set(); const logTxt = sh('git log --format=%s%n%b ' + result.from + '..' + result.to);
    for (const m of logTxt.matchAll(/(?:^|[\s(])#(\d{1,6})\b|\bL\d+\b/g)) names.add((m[1] ? m[1] : m[0].trim()));
    if (!names.size) { log('changelog: no commit names a ticket in ' + result.from + '..' + result.to); return; }
    const dir = path.join(DEV, '.cockpit', 'tickets'); const lines = [];
    for (const n of names) { let t = null; try { t = JSON.parse(fs.readFileSync(path.join(dir, n + '.json'), 'utf8')); } catch (e) { /* not a Cockpit ticket */ } lines.push('- ' + (t && t.number ? '#' + t.number : /^L/.test(n) ? n : '#' + n) + (t ? ': ' + t.title + (t.feature ? ' (' + t.feature + ')' : '') : '')); }
    const file = path.join(DEV, 'CHANGELOG.md'); let old = ''; try { old = fs.readFileSync(file, 'utf8'); } catch (e) { old = '# Changelog\n\nThe release notes are the tickets: written by scripts\\promote.js from the commits each promote carried.\n'; }
    const entry = '\n## ' + version + ' - ' + new Date().toISOString().slice(0, 10) + ' (' + result.from + ' → ' + result.to + ')\n' + lines.join('\n') + '\n';
    const head = old.split('\n').slice(0, 3).join('\n'); const rest = old.split('\n').slice(3).join('\n');
    fs.writeFileSync(file, head + '\n' + entry + rest); result.changelog = lines; log('changelog: ' + lines.length + ' ticket' + (lines.length === 1 ? '' : 's') + ' → CHANGELOG.md in the dev checkout');
  } catch (e) { log('changelog skipped: ' + e.message); }
}
function restart() {
  try { sh('pm2 describe ' + NAME); sh('pm2 restart ' + NAME); }
  catch (e) { sh('pm2 start "' + path.join(PROD, 'server.js') + '" --name ' + NAME + ' --cwd "' + PROD + '"'); sh('pm2 save'); }
}
function install(prev) { if (!prev || sh('git diff --name-only ' + prev + ' HEAD -- package-lock.json package.json')) { log('npm ci'); sh('npm ci --omit=dev', { stdio: ['ignore', 'pipe', 'pipe'] }); } }
function migrate() { if (fs.existsSync(path.join(PROD, 'scripts', 'migrate.js'))) { log('migrations'); sh(process.execPath + ' scripts/migrate.js'); } }

(async () => {
  if (!fs.existsSync(PROD)) { log('no ' + PROD + ' - clone it first: git clone {{REPO_URL}} ' + PROD); process.exit(1); }
  step('prod is clean', () => { const st = sh('git status --porcelain'); if (st) throw new Error('prod has local changes - prod is never edited by hand:\n' + st); });
  result.from = step('remember where prod is', () => sh('git rev-parse --short HEAD'));
  step('fetch main', () => sh('git fetch origin main'));
  step('fast-forward', () => { sh('git checkout -q main'); sh('git merge --ff-only origin/main'); });
  result.to = sh('git rev-parse --short HEAD');
  const version = JSON.parse(fs.readFileSync(path.join(PROD, 'package.json'), 'utf8')).version;
  log('prod ' + result.from + ' → ' + result.to + ' (version ' + version + ')');
  step('install', () => install(result.from));
  step('migrate', migrate);
  step('restart', restart);
  await new Promise((r) => setTimeout(r, 2500));
  result.smoke = await smoke(version);
  if (result.smoke.ok) { changelog(version); }
  if (result.smoke.ok) { result.ok = true; log('SMOKE OK - prod answers ok, version ' + version + ', the shell serves. https://{{NAME}}.local'); writeResult(); return; }
  log('SMOKE FAILED - ' + (result.smoke.why || 'health or shell did not answer') + ' - restoring ' + result.from);
  try {
    step('restore', () => { sh('git checkout -q ' + result.from); install(result.to); migrate(); restart(); });
    await new Promise((r) => setTimeout(r, 2500));
    result.restoreSmoke = await smoke(null); result.rolledBack = true;
    log(result.restoreSmoke.ok ? 'restored to ' + result.from + ' and it answers. Fix the release, then promote again.' : 'RESTORE DID NOT ANSWER EITHER - prod needs a hand now: ' + (result.restoreSmoke.why || ''));
  } catch (e) { log('restore failed: ' + e.message + ' - prod needs a hand now'); }
  writeResult(); process.exit(1);
})().catch((e) => { log('stopped: ' + e.message); writeResult(); process.exit(1); });
