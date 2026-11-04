/* DAST - dynamic application security testing, with OWASP ZAP run from this folder (docs/plan-verification-and-tickets.md,
   Phase 3; the "dast" stage in plugins/architecture/stages.json).

   ZAP is Java; the Java runtime and ZAP itself are archives in tools\dl (tools/fetch.js), unpacked into tools\zap on
   first use. Nothing is installed: no JAVA_HOME, no PATH, no service. ZAP runs headless (-daemon) on a loopback port
   with its own home folder under tools\zap\home, and this module drives it through its JSON API:

     reset the test database -> start the app on it (tests.startApp) -> start ZAP -> seed the site tree with every
     route the map knows (ZAP's spider only follows links; the API doors it cannot see) -> spider -> wait for the
     passive scan -> active scan (the injection rules: SQLi, XSS, traversal, command injection, ...) -> read the
     alerts -> shut ZAP down -> stop the app -> write .cockpit/tests/dast.json -> rescan (the map shows the alerts
     under the DAST stage).

   It runs only when asked (POST /api/p/:id/tests/dast, or /tests dast in the chat): an active scan takes minutes and
   writes junk into the test database - which is what the test database is for. Never point it at dev or prod. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const tests = require('./tests');
const fetchTools = require('../tools/fetch');

const running = new Map();
const dir = (project) => path.join(project.cockpit.dir, 'tests');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function latest(project) { try { return JSON.parse(fs.readFileSync(path.join(dir(project), 'dast.json'), 'utf8')); } catch (e) { return null; } }

/* ZAP's pieces, unpacked for this machine when the archives are here */
function ensureZap(say) {
  let st = fetchTools.ready();
  if (st.zap) return null;
  if (st.missingArchives.some((f) => /ZAP|jre/.test(f))) return 'ZAP is not in this engine folder - run: node tools\\fetch.js --unpack (downloads ZAP and a Java runtime once; both then travel with the folder)';
  say('dast: unpacking ZAP and its Java runtime from tools\\dl (first use on this machine)');
  try { for (const p of fetchTools.PIECES) if (!p.playwright && (p.platform === process.platform || p.platform === 'any')) fetchTools.unpack(p); } catch (e) { return 'could not unpack ZAP: ' + e.message; }
  st = fetchTools.ready();
  return st.zap ? null : 'ZAP unpacked but not found where expected - the pins in tools/fetch.js may not match the archives (node tools\\fetch.js --check)';
}

async function zapStart(say) {
  const P = fetchTools.paths();
  const port = 8090 + Math.floor(Math.random() * 100);
  const home = path.join(path.dirname(P.zapDir), 'home'); fs.mkdirSync(home, { recursive: true });
  const args = ['-Xmx1024m', '-jar', P.zapJar, '-daemon', '-silent', '-host', '127.0.0.1', '-port', String(port), '-dir', home,
    '-config', 'api.disablekey=true', '-config', 'api.addrs.addr.name=127.0.0.1', '-config', 'api.addrs.addr.regex=false',
    '-config', 'connection.timeoutInSecs=20'];
  const child = cp.spawn(P.java, args, { cwd: P.zapDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; child.stdout.on('data', (d) => { log += d; if (log.length > 20000) log = log.slice(-10000); }); child.stderr.on('data', (d) => { log += d; if (log.length > 20000) log = log.slice(-10000); });
  const api = 'http://127.0.0.1:' + port;
  const t0 = Date.now(); let up = false, exited = null; child.on('exit', (c) => { exited = c; });
  while (Date.now() - t0 < 180000 && !up && exited === null) { try { const r = await fetch(api + '/JSON/core/view/version/', { signal: AbortSignal.timeout(3000) }); if (r.ok) up = true; } catch (e) { await sleep(1500); } }
  const stop = async () => { try { await fetch(api + '/JSON/core/action/shutdown/', { signal: AbortSignal.timeout(5000) }); } catch (e) { /* already gone */ } await sleep(1500); try { if (process.platform === 'win32') cp.execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); else child.kill('SIGTERM'); } catch (e) { /* gone */ } };
  if (!up) { await stop(); return { why: 'ZAP did not answer within 3 minutes' + (exited !== null ? ' (exited ' + exited + ')' : '') + ': ' + log.split('\n').filter(Boolean).slice(-4).join(' | ') }; }
  const version = (await (await fetch(api + '/JSON/core/view/version/')).json()).version;
  say('dast: ZAP ' + version + ' up on ' + api + ' (' + Math.round((Date.now() - t0) / 1000) + ' s)');
  return { api, stop, version };
}
const j = async (api, p) => { const r = await fetch(api + p, { signal: AbortSignal.timeout(30000) }); const t = await r.text(); try { return JSON.parse(t); } catch (e) { throw new Error(p + ' -> ' + t.slice(0, 200)); } };

function run(project, opts, log) {
  const id = project.entry.id;
  if (running.has(id)) return { ok: false, error: 'a DAST run is already going for this project (started ' + new Date(running.get(id).started).toISOString() + ')' };
  const say = (t) => { if (log) log(t); };
  const started = Date.now(); running.set(id, { started });
  const report = { at: new Date(started).toISOString(), ms: 0, ok: false, url: null, zap: null, spider: null, active: null, alerts: [], summary: {}, why: null };
  const finish = () => {
    report.ms = Date.now() - started; fs.mkdirSync(dir(project), { recursive: true });
    fs.writeFileSync(path.join(dir(project), 'dast.json'), JSON.stringify(report, null, 1) + '\n');
    running.delete(id);
    try { require('./projects').bump(id); } catch (e) { /* */ }
    say('dast: ' + (report.ok ? 'done' : 'stopped - ' + report.why) + ' - ' + Object.entries(report.summary).map(([k, v]) => v + ' ' + k.toLowerCase()).join(', ') + ' in ' + Math.round(report.ms / 1000) + ' s');
    try { const pl = require('./plugins'); for (const name of pl.scanned(project)) { try { pl.scan(project, name, null); } catch (e) { /* no scan */ } } } catch (e) { /* */ }
  };
  (async () => {
    const missing = ensureZap(say); if (missing) { report.why = missing; say('dast: ' + missing); return finish(); }
    const env = tests.testEnv(project);
    const setup = tests.setupCommand(project);
    if (setup) {
      say('dast: resetting the test database - ' + setup);
      const r = await new Promise((resolve) => cp.exec(setup, { cwd: project.dir, env, timeout: 5 * 60 * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, tail: String((out || '') + (errOut || '')).slice(-1500) })));
      if (!r.ok) { report.why = 'test database setup failed: ' + r.tail.split('\n').filter(Boolean).slice(-2).join(' | '); return finish(); }
    }
    const app = await tests.startApp(project, env, say);
    if (!app.url) { report.why = app.why; return finish(); }
    report.url = app.url; report.external = !!app.external;
    /* ZAP is Java, and Java refuses a hostname with an underscore (my_app_dev.local): the spider finds nothing and the
       active scan says "URL Not Found in the Scan Tree" (2026-09-19). Say so, instead of that. */
    try { const hn = new URL(app.url).hostname; if (hn.includes('_')) { report.why = 'ZAP cannot scan ' + hn + ': Java refuses a hostname with an underscore. Give the site a second name without one (my-app-dev.local, in your proxy and DNS) and put it under ## Tests as url:, or dast-url:'; say('dast: ' + report.why); app.stop(); return finish(); } } catch (e) { /* not a url */ }   // a site on its own database: spider + passive only, no injection
    let zap = null;
    try {
      zap = await zapStart(say);
      if (!zap.api) { report.why = zap.why; return; }
      report.zap = zap.version;
      const api = zap.api, base = app.url;
      /* SIGNED IN (a site of 408 urls, the active scan "done" in 1.8 s): ZAP never signed in, so behind a login
         it scanned nothing but "401 not signed in". The project's test login (## Tests login:, the same sign-in the
         probes use) goes on every request ZAP sends, through its Replacer; sign-out urls stay out of the scan so the
         session lives to the end. The session never reaches the report or the log. */
      const sec = tests.testsSection(project);
      if (sec.login && tests.signIn) {
        const s = await tests.signIn(base, sec, project);
        if (s && s.headers) {
          for (const [h, v] of Object.entries(s.headers)) if (/^(cookie|authorization)$/i.test(h)) await j(api, '/JSON/replacer/action/addRule/?description=' + encodeURIComponent('cockpit-signed-in-' + h.toLowerCase()) + '&enabled=true&matchType=REQ_HEADER&matchRegex=false&matchString=' + encodeURIComponent(h) + '&replacement=' + encodeURIComponent(v) + '&initiators=');
          for (const x of ['.*(sign-?out|log-?out|logout|signout).*']) { try { await j(api, '/JSON/spider/action/excludeFromScan/?regex=' + encodeURIComponent(x)); await j(api, '/JSON/ascan/action/excludeFromScan/?regex=' + encodeURIComponent(x)); } catch (e) { /* older ZAP */ } }
          report.signedIn = true; say('dast: signed in as the test login - ZAP scans behind the login');
        } else { report.signedIn = { ok: false, why: (s && s.why) || 'no session' }; say('dast: could not sign in (' + report.signedIn.why + ') - scanning as nobody'); }
      }
      // seed: every GET door the map knows, so the active scan sees the API and not only what the shell links to
      let routes = project.db.all("SELECT title FROM node WHERE kind = 'route'").map((r) => /^GET\s+(\/\S*)$/.exec(r.title)).filter(Boolean).map((m) => m[1].replace(/\*/g, '1').replace(/:[a-z_]+/gi, '1'));
      if (!routes.length) routes = project.db.all("SELECT n.file FROM node n JOIN tag t ON t.subject = n.subject AND t.ns = 'kind' AND t.value = 'page' WHERE n.file IS NOT NULL").map((r) => '/' + String(r.file).replace(/\\/g, '/').replace(/^\.?\//, ''));
      let seeded = 0; for (const p of routes.slice(0, 300)) { try { await j(api, '/JSON/core/action/accessUrl/?url=' + encodeURIComponent(base + p) + '&followRedirects=false'); seeded++; } catch (e) { /* a door that errors is still in the tree */ } }
      say('dast: seeded ' + seeded + ' doors from the map');
      // spider
      const sp = await j(api, '/JSON/spider/action/scan/?url=' + encodeURIComponent(base + '/') + '&recurse=true&maxChildren=0');
      const t1 = Date.now(); let st = 0;
      while (Date.now() - t1 < 5 * 60 * 1000) { st = Number((await j(api, '/JSON/spider/view/status/?scanId=' + sp.scan)).status || 0); if (st >= 100) break; await sleep(2000); }
      const urls = (await j(api, '/JSON/core/view/urls/?baseurl=' + encodeURIComponent(base))).urls || [];
      report.spider = { status: st, urls: urls.length, ms: Date.now() - t1 };
      say('dast: spider ' + st + '% - ' + urls.length + ' urls in the site tree');
      // let the passive scan catch up
      const t2 = Date.now(); while (Date.now() - t2 < 120000) { const left = Number((await j(api, '/JSON/pscan/view/recordsToScan/')).recordsToScan || 0); if (!left) break; await sleep(1500); }
      // active scan: the injection rules against everything in the tree - never against a site on its own database
      if (app.external) { report.active = { skipped: true, why: 'the site runs on its own database - spider and passive rules only; the injection rules need a *_test database, or database: under ## Tests declaring the site\'s database disposable' }; say('dast: active scan skipped - ' + report.active.why); }
      else {
      // from the same root node the spider used (base + '/'): the bare origin matched almost nothing in the tree (1.8 s)
      const as = await j(api, '/JSON/ascan/action/scan/?url=' + encodeURIComponent(base + '/') + '&recurse=true&inScopeOnly=false');
      if (as.code) throw new Error('active scan refused: ' + (as.message || as.code));
      const t3 = Date.now(); let ast = 0; const budget = (opts && opts.minutes ? Number(opts.minutes) : 20) * 60 * 1000;
      let lastSaid = 0;
      while (Date.now() - t3 < budget) { ast = Number((await j(api, '/JSON/ascan/view/status/?scanId=' + as.scan)).status || 0); if (ast >= 100) break; if (Date.now() - lastSaid > 30000) { lastSaid = Date.now(); say('dast: active scan ' + ast + '%'); } await sleep(3000); }
      if (ast < 100) { try { await j(api, '/JSON/ascan/action/stop/?scanId=' + as.scan); } catch (e) { /* */ } }
      report.active = { status: ast, ms: Date.now() - t3, partial: ast < 100 };
      }
      // the alerts
      const al = (await j(api, '/JSON/alert/view/alerts/?baseurl=' + encodeURIComponent(base) + '&start=0&count=5000')).alerts || [];
      report.alerts = al.map((a) => ({ name: a.name || a.alert, risk: a.risk, confidence: a.confidence, url: (a.url || '').replace(base, ''), method: a.method, param: a.param, attack: (a.attack || '').slice(0, 200), evidence: (a.evidence || '').slice(0, 300), description: (a.description || '').slice(0, 600), solution: (a.solution || '').slice(0, 600), reference: (a.reference || '').split('\n')[0], cwe: a.cweid, wasc: a.wascid, plugin: a.pluginId }));
      const sum = (await j(api, '/JSON/alert/view/alertsSummary/?baseurl=' + encodeURIComponent(base))).alertsSummary || {};
      report.summary = sum; report.ok = true;
    } catch (e) { report.why = e.message; say('dast: ' + e.message); }
    finally { if (zap && zap.stop) await zap.stop(); app.stop(); finish(); }
  })().catch((e) => { report.why = e.message; finish(); });
  return { ok: true, started: report.at, note: 'running; ZAP spiders, then actively scans the app on the test database - minutes, not seconds. The report lands in .cockpit/tests/dast.json and the map rescans.' };
}
/* run and wait: for the promoter */
function runAndWait(project, opts, log) {
  const r = run(project, opts, log); if (!r.ok) return Promise.resolve(latest(project));
  const id = project.entry.id, t0 = Date.now();
  return new Promise((resolve) => { const tick = () => { if (!running.has(id)) return resolve(latest(project)); if (Date.now() - t0 > 40 * 60 * 1000) return resolve(latest(project)); setTimeout(tick, 3000); }; tick(); });
}
function status(project) { const l = latest(project); const st = fetchTools.ready(); return { ok: true, running: running.has(project.entry.id), zapReady: st.zap, archives: st.missingArchives.filter((f) => /ZAP|jre/.test(f)).length === 0, latest: l ? { at: l.at, ok: l.ok, why: l.why, zap: l.zap, ms: l.ms, summary: l.summary, alerts: l.alerts.length, spider: l.spider, active: l.active } : null }; }

module.exports = { run, runAndWait, status, latest, ensureZap };
