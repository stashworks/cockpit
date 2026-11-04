/* The input probe - Cockpit's own, route-aware fuzz of the running app (the "dast" stage's second row: ZAP does not
   know a door's input shape; the map does, near enough).

   For every door the map knows, the fields it reads are lifted from its file (req.body.x, req.query.x, :param,
   const { a, b } = req.body) and each hostile payload is sent in all of them at once - as JSON body, as the query
   string, and in the path - so one request per payload per door. What is looked for is not the vulnerability
   itself (that is ZAP's job) but the app's REACTION, which is what a cheap probe can prove every run:
     crash      a 5xx - the door fell over on input
     leak       a stack trace, a SQL error, a file path in the answer - the door told the attacker how it is built
     reflected  the payload came back unescaped in HTML - cross-site scripting
     slow       more than 8 s - an input that stalls the app
   Runs as nobody: doors that refuse the probe (401/403/redirect) are counted, not fuzzed - that depth comes with the
   signed-in contract. Capped so a run stays under a few minutes on the largest map. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MARK = 'cockpitxss';
const PAYLOADS = [
  { name: 'sql-quote', v: "x' OR '1'='1" },
  { name: 'xss', v: '<script>' + MARK + '</script>' },
  { name: 'traversal', v: '../../../../etc/passwd' },
  { name: 'object-for-string', v: { $gt: '' } },
  { name: 'huge', v: 'A'.repeat(20000) },
  { name: 'number-overflow', v: 1e308 },
  { name: 'null', v: null },
];
const LEAK = /\bat [\w.<>\[\] ]+ \((?:[A-Za-z]:\\|\/)[^)]+:\d+:\d+\)|\bER_[A-Z_]+\b|SQLSTATE|You have an error in your SQL syntax|syntax error at or near|TypeError: |ReferenceError: |Cannot read propert|ENOENT: no such file|node_modules[\\/]/;

function fieldsOf(project, file) {
  const out = new Set();
  try {
    const src = fs.readFileSync(path.join(project.dir, file), 'utf8');
    for (const m of src.matchAll(/\b(?:req|request|ctx)\.(?:body|query|params)\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
    for (const m of src.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_ ,:]*)\}\s*=\s*(?:await\s+)?(?:req|request|ctx)\.(?:body|query|params)\b/g)) m[1].split(',').forEach((f) => { const k = f.split(':')[0].trim(); if (/^[A-Za-z_]\w*$/.test(k)) out.add(k); });
    for (const m of src.matchAll(/\bbody\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
  } catch (e) { /* no file: generic fields */ }
  const f = [...out].filter((k) => !/^(then|catch|length|toString|constructor|on|pipe)$/.test(k)).slice(0, 8);
  return f.length ? f : ['q', 'id', 'name', 'email', 'text'];
}

async function fuzzStage(project, env, url, routes, report, say, headers) {
  const H = headers || {};   // the signed-in pass sends the test user's cookie or token
  const t0 = Date.now(), BUDGET = 4 * 60 * 1000;
  const out = { routes: 0, requests: 0, refused: 0, findings: [], ms: 0, capped: false };
  const list = routes.slice(0, 200);
  for (const r of list) {
    if (Date.now() - t0 > BUDGET) { out.capped = true; break; }
    const file = (project.db.all('SELECT file FROM node WHERE subject = ?', r.subject)[0] || {}).file;
    const fields = fieldsOf(project, file);
    const hasParam = /:[a-z_]+|\*/i.test(r.path);
    // is this door open to nobody? one clean request says
    let base = 0; try { const res = await fetch(url + r.path.replace(/\*/g, '1').replace(/:[a-z_]+/gi, '1'), { method: r.method, redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { ...H, 'content-type': 'application/json' }, body: /^(POST|PUT|PATCH)$/.test(r.method) ? '{}' : undefined }); base = res.status; } catch (e) { base = -1; }
    out.requests++;
    if (base === 401 || base === 403 || (base >= 300 && base < 400)) { out.refused++; continue; }
    out.routes++;
    for (const p of PAYLOADS) {
      if (Date.now() - t0 > BUDGET) { out.capped = true; break; }
      const sv = typeof p.v === 'string' ? p.v : JSON.stringify(p.v);
      const body = {}; fields.forEach((f) => { body[f] = p.v; });
      const qs = '?' + fields.map((f) => encodeURIComponent(f) + '=' + encodeURIComponent(sv.slice(0, 2000))).join('&');
      const pth = r.path.replace(/\*/g, encodeURIComponent(sv.slice(0, 200))).replace(/:[a-z_]+/gi, encodeURIComponent(sv.slice(0, 200)));
      const clean = r.path.replace(/\*/g, '1').replace(/:[a-z_]+/gi, '1');
      const targets = [{ where: 'body+query', u: url + clean + qs }];   // the payload in every field, as body and as query
      if (hasParam) targets.push({ where: 'path', u: url + pth });        // and in the path parameter
      for (const t of targets) {
        const t1 = Date.now(); let status = 0, text = '', ct = '';
        try {
          const res = await fetch(t.u, { method: r.method, redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { ...H, 'content-type': 'application/json' }, body: /^(POST|PUT|PATCH|DELETE)$/.test(r.method) ? JSON.stringify(body) : undefined });
          status = res.status; ct = res.headers.get('content-type') || ''; text = (await res.text()).slice(0, 200000);
        } catch (e) { status = /timeout|abort/i.test(e.name + e.message) ? -2 : -1; text = e.message; }
        out.requests++;
        const ms = Date.now() - t1;
        const add = (kind, evidence) => out.findings.push({ route: r.subject, method: r.method, path: r.path, payload: p.name, where: t.where, status, kind, evidence: String(evidence).slice(0, 240), ms });
        if (status >= 500) add('crash', text.replace(/\s+/g, ' ').slice(0, 240));
        if (status === -2 || ms > 8000) add('slow', ms + ' ms');
        const leak = LEAK.exec(text); if (leak && status !== -1) add('leak', text.slice(Math.max(0, leak.index - 80), leak.index + 160).replace(/\s+/g, ' '));
        if (p.name === 'xss' && /html/i.test(ct) && text.includes('<script>' + MARK + '</script>')) add('reflected', 'the payload came back unescaped in HTML');
      }
    }
  }
  // one finding per door per kind: the first payload that showed it, the rest counted
  const seen = {}; const compact = [];
  for (const f of out.findings) { const k = f.route + '|' + f.kind; if (seen[k]) { seen[k].also++; continue; } seen[k] = { ...f, also: 0 }; compact.push(seen[k]); }
  out.findings = compact; out.ms = Date.now() - t0;
  report.fuzz = out;
  say('tests: input probe' + (headers ? ' (signed in)' : '') + ' - ' + out.routes + ' doors fuzzed (' + out.refused + ' refused the probe), ' + out.requests + ' requests, ' + compact.length + ' finding' + (compact.length === 1 ? '' : 's') + (out.capped ? ' (time budget reached)' : '') + ' in ' + Math.round(out.ms / 1000) + ' s');
}

module.exports = { fuzzStage, PAYLOADS, fieldsOf };
