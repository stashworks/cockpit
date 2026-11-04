#!/usr/bin/env node
/* Architecture scan - populates the engine's graph tables for one project.
   Run as a child process by the engine:  node scan.js <projectDir> <dbPath> <answersJson>
   Prints ONE JSON line at the end: { ok, yields: {...}, note } - what each extractor found,
   so a pattern that stops matching says so instead of reporting a confident zero.

   Scanner per project type (answers.type). Each produces the same three things:
     nodes  site > folder > file, typed subjects ('file:card_health.php')
     edges  file -> file (include, link, form, fetch), file -> table (reads / writes)
     tags   kind, reach, data - each a lens; grading in tag_meta, descriptions in ns_meta

   Everything derived is rewritten on every scan; anything a human set (set_by != 'derived')
   is left alone. */
'use strict';
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [,, projectDir, dbPath, answersJson] = process.argv;
const answers = JSON.parse(answersJson || '{}');
const SKIP = new Set(String(answers.skip || '.cockpit,.git,node_modules,vendor').split(',').map((s) => s.trim()).filter(Boolean).concat(['.coders', 'accounts']));   // the coders' own folders are copies of the project, never part of its map (engine/workspaces.js)
const type = answers.type || 'website-php';
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
const say = (s) => process.stderr.write(s + '\n');

/* ---------- WHICH CODE IS READ ----------
   The map read whatever branch the project folder happened to be on. On one project that was a coder's old branch (issue-2986,
   50 commits behind main), and a full review filed a ticket for a hole main had already closed. So a project with an online
   history is read from its CURRENT MAIN: a read-only copy at <project>\.cockpit\cache\mainline, fetched and reset to
   origin's main branch at every scan, locked so no clean-up takes it. Everything about the project itself (.cockpit settings,
   test results, ARCHITECTURE.md) still comes from and goes to the real folder. A project with no remote - or answers.readMain
   false - is read as the folder is. codeDir is what the code analysis reads; projectDir (ROOT_DIR) stays the project. */
const ROOT_DIR = projectDir;
let codeDir = projectDir, readFrom = 'the folder as it is';
if (answers.readMain !== false) {
  try {
    const cp0 = require('node:child_process');
    const g = (args, cwd) => cp0.execFileSync('git', ['-c', 'safe.directory=*'].concat(args), { cwd: cwd || projectDir, encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (fs.existsSync(path.join(projectDir, '.git')) && g(['remote']).split(/\s+/).includes('origin')) {
      g(['fetch', '-q', 'origin']);
      let ref = ''; try { ref = g(['rev-parse', '--abbrev-ref', 'origin/HEAD']); } catch (e) { /* not set */ }
      if (!ref || ref === 'origin/HEAD') ref = ['origin/main', 'origin/master'].find((r) => { try { g(['rev-parse', '--verify', '-q', r]); return true; } catch (e) { return false; } }) || '';
      if (ref) {
        const ml = path.join(projectDir, '.cockpit', 'cache', 'mainline');
        /* checked out EXACTLY as stored (core.autocrlf=false): a Windows checkout turns every line ending into CRLF, and the
           project's formatter (endOfLine lf) then called all 1,212 files wrong - noise, not findings (first run, 2026-09-27).
           A copy made the old way (no .lf mark beside it) is rewritten once. */
        const LF = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'], lfMark = ml + '.lf';
        if (fs.existsSync(path.join(ml, '.git')) && !fs.existsSync(lfMark)) { try { g(['worktree', 'unlock', ml]); } catch (e) { /* not locked */ } g(['worktree', 'remove', '--force', '--force', ml]); }
        if (!fs.existsSync(path.join(ml, '.git'))) {
          try { g(LF.concat(['worktree', 'add', '--detach', ml, ref])); } catch (e) { g(['worktree', 'prune']); g(LF.concat(['worktree', 'add', '--detach', ml, ref])); }   // a stale record of a copy that was deleted by hand
          try { g(['worktree', 'lock', '--reason', 'Cockpit map: current ' + ref + ' - read-only, never edited', ml]); } catch (e) { /* locked already */ }
          fs.writeFileSync(lfMark, 'checked out with LF line endings, as stored - ' + new Date().toISOString() + '\n');
        } else { g(LF.concat(['checkout', '-q', '--detach', '--force', ref]), ml); try { g(['clean', '-fdq'], ml); } catch (e) { /* nothing to clear */ } }
        codeDir = ml; readFrom = ref + ' at ' + g(['rev-parse', '--short', 'HEAD'], ml);
      }
    }
  } catch (e) { say('map: could not read the main branch - reading the folder as it is: ' + String(e.message).split('\n')[0]); codeDir = projectDir; }
}
say('map reads: ' + readFrom);

/* comments blanked out, every newline kept (so line numbers still match): code in a comment is an example, not code.
   A small reader, not a regex: text inside quotes is skipped, so a "/*" in a string (a large monorepo'sfinancials.use("/*", ...)) or a
   URL's // is never taken for a comment - the first regex version blanked the very line it was meant to find (2026-09-27). */
function uncomment(src) {
  const s = String(src || ''); let out = '', i = 0, q = null;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (q) { out += c; if (c === '\\' && i + 1 < s.length) { out += n; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '*') { const end = s.indexOf('*/', i + 2), stop = end < 0 ? s.length : end + 2; out += s.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue; }
    if (c === '/' && n === '/') { const end = s.indexOf('\n', i); const stop = end < 0 ? s.length : end; out += ' '.repeat(stop - i); i = stop; continue; }
    out += c; i++;
  }
  return out;
}

/* ---------- walk ---------- */
function walk(dir, rel, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else out.push({ rel: r, abs: path.join(dir, e.name), name: e.name, dir: rel });
  }
}

/* ---------- scanners ---------- */
const SCANNERS = {
  'website-php': {
    take: (f) => /\.(php|html?|js|css|inc)$/i.test(f.name),
    /* a test is a test on a PHP site too (2026-09-20: every .js read as 'script', so no flow could ever be proven on a PHP project) -
       the same rule the Node scanner uses below; a declared @kind test wins as well. A screen is a page: one that prints, or opens
       with <html>/<form>, or pulls in the site's header (a screen that starts with a comment used to read as an include), or says @kind screen. */
    kindOf: (f, src) => (/(^|\/)(__tests__|tests?)\//i.test(f.rel) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(f.name) || /@kind\s+test\b/i.test(src.slice(0, 2000))) ? 'test'
      : /\.php$/i.test(f.name) ? (/(\$_(GET|POST|REQUEST)|echo|\?>|<html|<body)/i.test(src) && !/^\s*<\?php\s*(\/\/|\/\*|namespace|function|class|require|include|\$)/.test(src.slice(0, 200)) || /<html|<body|<form/i.test(src) || /\b(?:require|include)(?:_once)?\s*\(?\s*[^;]{0,120}header\.php/i.test(src) || /@kind\s+screen\b/i.test(src.slice(0, 2000)) ? 'page' : 'include') : /\.html?$/i.test(f.name) ? 'page' : /\.js$/i.test(f.name) ? 'script' : /\.css$/i.test(f.name) ? 'style' : 'file',
    edges: (f, src, known) => {
      const out = [];
      const resolve = (t) => { t = t.replace(/^\.\//, '').replace(/[?#].*$/, ''); if (!t || /^(https?:|mailto:|javascript:|#|\/\/)/i.test(t)) return null; const cands = [t, (f.dir ? f.dir + '/' : '') + t, path.posix.normalize((f.dir ? f.dir + '/' : '') + t)]; for (const c of cands) if (known.has(c)) return c; return null; };
      let m;
      const re1 = /\b(require|include)(_once)?\s*\(?\s*['"]([^'"]+)['"]/g;  while ((m = re1.exec(src))) { const t = resolve(m[3]); if (t) out.push([t, 'include']); }
      // require_once __DIR__ . '/lib/x.php' - and dirname(__FILE__), dirname(__DIR__) (one level up), dirname(dirname(__FILE__))
      const re1b = /\b(?:require|include)(?:_once)?\s*\(?\s*(__DIR__|dirname\s*\(\s*__FILE__\s*\)|dirname\s*\(\s*__DIR__\s*\)|dirname\s*\(\s*dirname\s*\(\s*__FILE__\s*\)\s*\))\s*\.\s*['"]\/?([^'"]+)['"]/g;
      while ((m = re1b.exec(src))) { const up = /dirname\s*\(\s*(?:__DIR__|dirname)/.test(m[1]); const base = up ? path.posix.dirname(f.dir || '.') : (f.dir || ''); const t = resolve(path.posix.normalize((base && base !== '.' ? base + '/' : '') + m[2])); if (t) out.push([t, 'include']); }
      const re2 = /href\s*=\s*['"]([^'"]+\.(?:php|html?))(?:[?#][^'"]*)?['"]/gi; while ((m = re2.exec(src))) { const t = resolve(m[1]); if (t) out.push([t, 'link']); }
      const re3 = /action\s*=\s*['"]([^'"]+\.php)(?:[?#][^'"]*)?['"]/gi;     while ((m = re3.exec(src))) { const t = resolve(m[1]); if (t) out.push([t, 'form']); }
      const re4 = /(?:fetch|\$\.(?:get|post|ajax|getJSON)|XMLHttpRequest|open)\s*\(\s*['"]([^'"]+\.php)(?:[?#][^'"]*)?['"]/gi; while ((m = re4.exec(src))) { const t = resolve(m[1]); if (t) out.push([t, 'fetch']); }
      const re5 = /<script[^>]+src\s*=\s*['"]([^'"]+\.js)['"]/gi;               while ((m = re5.exec(src))) { const t = resolve(m[1]); if (t) out.push([t, 'script']); }
      const re6 = /url\s*:\s*['"]([^'"]+\.php)(?:[?#][^'"]*)?['"]/gi;             while ((m = re6.exec(src))) { const t = resolve(m[1]); if (t) out.push([t, 'fetch']); }
      const re7 = /<link[^>]+href\s*=\s*['"]([^'"]+\.css)(?:[?#][^'"]*)?['"]/gi;        while ((m = re7.exec(src))) { const t = resolve(m[1]); if (t) out.push([t, 'link']); }
      return out;
    },
    tables: (src) => {
      /* Only inside string literals that hold a SQL statement. Measured 2026-09-16 on the
         owner's site: a bare FROM/JOIN regex over the whole source produced 99 "tables"
         including it, a, another, your, if, one - English prose. A statement has a verb. */
      const reads = new Set(), writes = new Set();
      const lits = src.match(/"(?:[^"\\]|\\.){0,4000}"|'(?:[^'\\]|\\.){0,4000}'|<<<['"]?(\w+)['"]?[\s\S]{0,6000}?\n\s*\1;/g) || [];
      for (const lit of lits) {
        if (!/\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(lit)) continue;
        let m;
        const rr = /\b(?:FROM|JOIN)\s+[`"']?([a-z_][a-z0-9_]*)[`"']?/gi; while ((m = rr.exec(lit))) reads.add(m[1].toLowerCase());
        // UPDATE names a table only as `UPDATE t SET`: `ON UPDATE CURRENT_TIMESTAMP` and `ON DUPLICATE KEY UPDATE col = ...` are not writes to a table called current_timestamp or col (a PHP site: 7 invented tables)
        const rw = /\b(?:INSERT\s+INTO|UPDATE(?=\s+(?:LOW_PRIORITY\s+|IGNORE\s+)?[`"']?[a-z_][a-z0-9_]*[`"']?(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s+SET\b)|DELETE\s+FROM|REPLACE\s+INTO)\s+(?:LOW_PRIORITY\s+|IGNORE\s+)?[`"']?([a-z_][a-z0-9_]*)[`"']?/gi; while ((m = rw.exec(lit))) writes.add(m[1].toLowerCase());
      }
      ['select', 'where', 'set', 'values', 'dual', 'the', 'a', 'an', 'of'].forEach((k) => { reads.delete(k); writes.delete(k); });
      return { reads: [...reads], writes: [...writes] };
    }
  },
  /* TypeScript monorepo (pnpm / turbo) - first written against one real monorepo, but nothing
     in it is specific to that project: workspace packages, relative imports, Hono/Express-style routers,
     Next.js app-router pages, raw SQL and Kysely on pg, SQL migrations, workers.
       kind    page (app-router page/layout/route), component (.tsx), route (declares HTTP
               routes), worker, service (lib/services), migration (.sql), script, test, module
       edges   import (resolved: relative, index, workspace package by name),
               fetch (a web file naming an /api/... path -> the router file mounted there),
               reads / writes (SQL verbs and Kysely calls), defines (migration -> table)
     Tests and type declarations are scanned for the tree but carry no edges out. */
  'typescript': {
    take: (f) => /\.(ts|tsx|mjs|cjs|js|sql|html?|css)$/i.test(f.name) && !/\.d\.ts$/i.test(f.name) && !/^(dist|\.next|\.turbo|coverage|build)(\/|$)/.test(f.rel) && !/(^|\/)(dist|\.next|\.turbo|coverage|build)\//.test(f.rel),
    prepare: (taken, projectDir) => {
      /* CONVENTIONS are data: plugins/architecture/typescript.json, overridden per project by
         .cockpit/plugins/architecture.typescript.json (modules there replace the list). */
      const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
      const conv = Object.assign({}, readJ(path.join(__dirname, 'typescript.json')) || {}, readJ(path.join(ROOT_DIR, '.cockpit', 'plugins', 'architecture.typescript.json')) || {});
      const rx = (k, fallback) => { const c = conv[k]; try { return c && c.re ? new RegExp(c.re, c.flags || '') : (typeof c === 'string' ? new RegExp(c, 'i') : fallback); } catch (e) { say('typescript.json: bad regex for ' + k + ' (' + e.message + ')'); return fallback; } };
      const C = {
        route: rx('route', /$^/g), perm: rx('permission', /$^/g), mount: rx('mount', /$^/g), call: rx('call', /$^/g), tableCall: rx('tableCall', /$^/gi),
        adminish: rx('adminish', /$^/), pageEntry: rx('pageEntry', /(^|\/)app\/.*\/page\.(tsx|jsx|ts|js)$/),
        sensitive: (conv.sensitive || []).map((r) => { try { return { re: new RegExp(r.re, 'i'), value: r.value, label: r.label || r.value, band: r.band || 'warn' }; } catch (e) { return null; } }).filter(Boolean),
        modules: (conv.modules || []).map((m) => { try { return { key: m.key, title: m.title || m.key, tier: m.tier || 'product', re: new RegExp(m.re, 'i'), keyFrom: m.keyFrom || 0 }; } catch (e) { return null; } }).filter(Boolean),
        authNote: conv.authNote || 'no permission check on the route'
      };
      const moduleOf = (rel) => { for (const m of C.modules) { const x = m.re.exec(rel); if (x) return m.keyFrom ? String(x[m.keyFrom] || m.key || 'unsorted').toLowerCase() : m.key; } return C.modules.length ? 'unsorted' : null; };
      ctx_modulesSeen = C.modules;
      /* workspace packages: name -> entry file, from every package.json under apps/ and packages/ */
      const pkgs = {}, aliases = [];
      const walkPkgs = (dir, rel, depth) => {
        if (depth > 3) return;
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
          if (SKIP.has(e.name)) continue;
          if (e.isDirectory()) walkPkgs(path.join(dir, e.name), rel ? rel + '/' + e.name : e.name, depth + 1);
          else if (e.name === 'package.json' && rel) {
            try { const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')); if (j.name) pkgs[j.name] = rel; } catch (e2) {}
          }
          /* tsconfig "paths": '@/*' -> './src/*' relative to baseUrl - the alias every Next app imports
             through; without it a page's reach stopped at its own file (12 of 293 pages, 2026-09-16) */
          else if (e.name === 'tsconfig.json' && rel) {
            try {
              // '@/*' is not a comment: strip comments only if the file does not parse as it is
              const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
              let raw = text; try { JSON.parse(raw); } catch (e3) { raw = text.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/,\s*([}\]])/g, '$1'); }
              const j = JSON.parse(raw), co = j.compilerOptions || {}, base = path.posix.normalize(rel + '/' + (co.baseUrl || '.')).replace(/\/\.$/, '');
              for (const [pat, targets] of Object.entries(co.paths || {})) if (Array.isArray(targets) && targets.length && pat.endsWith('/*')) aliases.push({ root: rel, prefix: pat.slice(0, -1), to: path.posix.normalize(base + '/' + targets[0].replace(/\*$/, '')) });
            } catch (e2) {}
          }
        }
      };
      walkPkgs(projectDir, '', 0);
      /* router mounts: app.route('/api/x', xRouter) or app.use('/api/x', xRouter) -> the import that defines xRouter */
      const mounts = [];
      for (const f of taken) {
        if (!/\.(ts|js|mjs)$/i.test(f.name)) continue;
        let src; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
        if (!/\.(route|use)\(\s*['"`]\/api\//.test(src)) continue;
        const imports = {}; let m; const ri = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
        while ((m = ri.exec(src))) { const names = m[1] ? m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()) : [m[2]]; names.forEach((n) => { if (n) imports[n] = m[3]; }); }
        const rm = /\.(?:route|use)\(\s*['"`](\/api\/[^'"`]*)['"`]\s*,\s*(\w+)/g;
        while ((m = rm.exec(src))) if (imports[m[2]]) mounts.push({ prefix: m[1].replace(/\/$/, ''), spec: imports[m[2]], from: f, name: m[2] });
      }
      /* NESTED MOUNTS (2026-09-28: 70 of a large monorepo's"dead routes" had no /api prefix - settingsRouter.route("/", rolesRouter) sits
         inside app.route("/api/v1/settings", settingsRouter), and only the outer step was read, so no call could ever match them).
         Every <router>.route|use('<path>', <importedRouter>) is an edge parent-file -> child-file; a file's full prefix is its
         parents' prefixes added up, 'app'-level mounts being the root. Resolved by file, so the router's variable name does not matter. */
      const filePrefix = {};
      {
        const rels = new Set(taken.map((f) => f.rel)); const absOf = {}; taken.forEach((f) => { absOf[f.rel] = f.abs; });
        const resolve = (fromRel, spec, hops) => {
          if (!/^\./.test(spec)) return null;
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)).replace(/\.(m?js|ts|tsx)$/, '');
          const hit = [base + '.ts', base + '.tsx', base + '.js', base + '.mjs', base + '/index.ts', base + '/index.js'].find((c) => rels.has(c)) || null;
          /* a pass-through file - `export { default } from "./settings/index.js"` (a large monorepo'sroutes/settings.ts) - is the router it
             re-exports: follow it (a few hops at most) */
          if (hit && (hops || 0) < 4) { let s = ''; try { s = fs.readFileSync(absOf[hit], 'utf8'); } catch (e) { /* */ } const re = /export\s*\{\s*default(?:\s+as\s+default)?\s*\}\s*from\s*['"]([^'"]+)['"]/.exec(s); if (re) return resolve(hit, re[1], (hops || 0) + 1) || hit; }
          return hit;
        };
        const parentOf = {};   // childRel -> [{ parentRel, prefix, root }]
        for (const f of taken) {
          if (!/\.(ts|js|mjs)$/i.test(f.name) || /(^|\/)(__tests__|__mocks__|fixtures?)\/|\.(test|spec)\./i.test(f.rel)) continue;
          let src; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
          if (!/\.(route|use|mount)\s*\(\s*['"`]/.test(src)) continue;
          const imports = {}; let m; const ri = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
          while ((m = ri.exec(src))) { const names = m[1] ? m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()) : [m[2]]; names.forEach((n) => { if (n) imports[n] = m[3]; }); }
          const rm = /\b(\w+)\s*\.\s*(?:route|use|mount)\s*\(\s*['"`]([^'"`]*)['"`]\s*,\s*(\w+)\s*\)/g;
          while ((m = rm.exec(src))) { if (!imports[m[3]]) continue; const child = resolve(f.rel, imports[m[3]]); if (!child) continue; (parentOf[child] = parentOf[child] || []).push({ parentRel: f.rel, prefix: m[2] === '/' ? '' : m[2].replace(/\/$/, ''), root: /^(app|server|api)$/i.test(m[1]) }); }
        }
        const full = (rel, seen) => {
          if (filePrefix[rel] !== undefined) return filePrefix[rel];
          const ps = parentOf[rel]; if (!ps || seen.has(rel)) return null;
          seen.add(rel);
          for (const p of ps) { const up = p.root ? '' : full(p.parentRel, seen); if (up !== null && up !== undefined) { filePrefix[rel] = up + p.prefix; return filePrefix[rel]; } }
          return null;
        };
        Object.keys(parentOf).forEach((rel) => full(rel, new Set()));
      }
      return { pkgs, aliases, mounts, filePrefix, C, moduleOf, routes: [], calls: [], pages: [], tablesOfFile: {} };
    },
    kindOf: (f, src0) => {
      const src = uncomment(src0);   // an example route in a doc comment is not a route (a large monorepo'spermission library, 2026-09-27)
      if (/\.sql$/i.test(f.name)) return /migrations?\//i.test(f.rel) ? 'migration' : 'sql';
      if (/\.html?$/i.test(f.name)) return 'page';
      if (/\.css$/i.test(f.name)) return 'style';
      /* a TEST first (2026-10-02: a large monorepo'sintegrations browser tests stub the provider with ['DELETE', '/api/...'] request
         rows, so the route rule below took them for route files - their flows read "no test names it" and the stubs became
         routes); a declared @kind test wins too */
      if (/(^|\/)(__tests__|tests?)\//i.test(f.rel) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(f.name) || /@kind\s+test\b/i.test(String(src0).slice(0, 2000))) return 'test';
      // plain Node: route('GET', '/x') or a module returning ['GET', '/x', handler] rows (the node-app starter's shape)
      if (/\b(?:route|app|router|r)\s*\(\s*['"](?:GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*['"]\//.test(src) || /\[\s*['"](?:GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*['"]\//.test(src)) return 'route';
      if (/(^|\/)app\/.*\/(page|layout|route|loading|error|template|not-found)\.(tsx|ts|jsx|js)$/i.test(f.rel) || /(^|\/)app\/(page|layout)\.(tsx|jsx)$/i.test(f.rel)) return 'page';
      if (/\.(tsx|jsx)$/i.test(f.name)) return 'component';
      if (/\.(get|post|put|patch|delete)\(\s*['"`]\//.test(src) && /(router|app|route)/i.test(src.slice(0, 4000))) return 'route';
      if (/(^|\/)workers?\//i.test(f.rel) || /(^|\/)jobs?\//i.test(f.rel)) return 'worker';
      /* THE COMMON TS LAYOUTS THAT FELL THROUGH TO 'module' (a large monorepo: 748 file-without-kind once files had
         features): a Cloudflare / edge worker's entry is a door; a daemon or cron app is a worker; hooks, stores, contexts,
         providers, agents, tools, handlers, runtimes, adapters and clients are logic; a workspace package's src/ is logic. */
      if (/(^|\/)apps\/cf-[^/]+\/src\/index\.[cm]?[jt]s$/i.test(f.rel) || /(^|\/)(edge|functions)\/[^/]+\.[cm]?[jt]s$/i.test(f.rel)) return 'route';
      if (/(^|\/)(automation-cron|cron|daemon|scheduler)s?\//i.test(f.rel) || /(^|\/)test-e2e\//i.test(f.rel) && /\.[cm]?[jt]s$/i.test(f.name) && /e2e/i.test(f.name)) return /test-e2e\//i.test(f.rel) ? 'test' : 'worker';
      if (/(^|\/)(services?|lib|utils?|helpers?|hooks|stores?|contexts?|providers?|agents?|tools?|handlers?|runtime|adapters?|clients?|integrations|middleware|core|domain|queues?|evals?|rbac|chips|hitl|handoffs)\//i.test(f.rel)) return 'service';
      if (/(^|\/)packages\/[^/]+\/src\//i.test(f.rel) || /(^|\/)src\/[^/]+\.[cm]?[jt]s$/i.test(f.rel) && /(^|\/)packages\//i.test(f.rel)) return 'service';
      // a plain .ts helper beside pages, components or routes (data maps, route helpers, i18n tables) is logic too
      if (/\.[cm]?ts$/i.test(f.name) && /(^|\/)(app|components|data|i18n|routes|machines|webhooks)\//i.test(f.rel)) return 'service';
      if (/(^|\/)scripts?\//i.test(f.rel) || /\.(mjs|cjs)$/i.test(f.name)) return 'script';
      return 'module';
    },
    edges: (f, src, known, ctx) => {
      const out = [];
      if (/\.sql$/i.test(f.name)) return out;
      const kind = /\.(test|spec)\./i.test(f.name) || /(^|\/)__tests__\//.test(f.rel) ? 'test' : '';
      if (kind === 'test') return out;   // tests reach everything; drawing them would hide the shape
      const tryFile = (base) => { for (const c of [base, base + '.ts', base + '.tsx', base + '.js', base + '.mjs', base + '/index.ts', base + '/index.tsx', base + '/index.js']) if (known.has(c)) return c; return null; };
      const resolveFrom = (base, spec) => {
        if (spec.startsWith('.')) return tryFile(path.posix.normalize((base.dir ? base.dir + '/' : '') + spec).replace(/\.js$/, ''));
        for (const a of ctx.aliases || []) if (spec.startsWith(a.prefix) && (base.rel + '/').startsWith(a.root + '/')) { const t = tryFile(path.posix.normalize(a.to + '/' + spec.slice(a.prefix.length)).replace(/\.js$/, '')); if (t) return t; }
        // workspace package: '@acme/db' or '@acme/db/src/x' -> packages/db/src/index.ts or that path
        for (const [name, rel] of Object.entries(ctx.pkgs)) {
          if (spec === name) return tryFile(rel + '/src/index') || tryFile(rel + '/index') || tryFile(rel + '/src');
          if (spec.startsWith(name + '/')) return tryFile(rel + '/' + spec.slice(name.length + 1)) || tryFile(rel + '/src/' + spec.slice(name.length + 1));
        }
        return null;
      };
      let m;
      if (/\.html?$/i.test(f.name)) {
        const web = (t) => { t = t.replace(/[?#].*$/, ''); if (!t || /^(https?:|\/\/|data:)/i.test(t)) return null; const bare = t.replace(/^\.?\//, ''); const cands = [(f.dir ? f.dir + '/' : '') + bare, bare]; for (const c of cands) if (known.has(c)) return c; for (const k of known) if (k.endsWith('/' + bare)) return k; return null; };
        const rs = /<script[^>]+src\s*=\s*['"]([^'"]+)['"]/gi; while ((m = rs.exec(src))) { const t = web(m[1]); if (t) out.push([t, 'script']); }
        const rl = /<link[^>]+rel\s*=\s*['"]stylesheet['"][^>]*href\s*=\s*['"]([^'"]+)['"]|<link[^>]+href\s*=\s*['"]([^'"]+\.css)['"]/gi; while ((m = rl.exec(src))) { const t = web(m[1] || m[2]); if (t) out.push([t, 'link']); }
        return out;
      }
      if (/\.css$/i.test(f.name)) return out;
      const ri = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
      const seen = new Set();
      while ((m = ri.exec(src))) { const t = resolveFrom(f, m[1] || m[2] || m[3]); if (t && t !== f.rel && !seen.has(t)) { seen.add(t); out.push([t, 'import']); } }
      // a web file naming an /api/... path reaches the router mounted at the longest matching prefix
      if (ctx.mounts.length && /['"`]\/api\//.test(src)) {
        const rp = /['"`](\/api\/[a-z0-9_\-\/]+)/gi; const hit = new Set();
        while ((m = rp.exec(src))) {
          const p = m[1]; let best = null;
          for (const mt of ctx.mounts) if ((p === mt.prefix || p.startsWith(mt.prefix + '/')) && (!best || mt.prefix.length > best.prefix.length)) best = mt;
          if (!best) continue;
          if (best.from.rel === f.rel) continue;   // the mounting file itself: its imports already say this
          const t = resolveFrom(best.from, best.spec);
          if (t && t !== f.rel && !hit.has(t)) { hit.add(t); out.push([t, 'fetch']); }
        }
      }
      return out;
    },
    tables: (src, f) => {
      const reads = new Set(), writes = new Set(), defines = new Set();
      let m;
      if (f && /\.(html?|css)$/i.test(f.name)) return { reads: [], writes: [], defines: [] };
      if (f && /\.sql$/i.test(f.name)) {
        const rc = /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]{2,})"?/gi; while ((m = rc.exec(src))) defines.add(m[1].toLowerCase());
        const ra = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]{2,})"?/gi; while ((m = ra.exec(src))) defines.add(m[1].toLowerCase());
        ['if', 'only', 'exists', 'not', 'temp', 'temporary', 'unlogged'].forEach((k) => defines.delete(k));
        return { reads: [], writes: [], defines: [...defines] };
      }
      // SQL inside string / template literals only - a statement has a verb (the PHP scanner's lesson)
      const lits = src.match(/`(?:[^`\\]|\\.){0,6000}`|"(?:[^"\\]|\\.){0,4000}"|'(?:[^'\\]|\\.){0,4000}'/g) || [];
      for (const lit0 of lits) {
        // a statement has a SHAPE, not just a verb: 'UPDATE is pending' in a message string is prose (measured on a large monorepo: is, to, on, public)
        if (!/\bSELECT\b[\s\S]{0,2000}?\bFROM\s|\bINSERT\s+INTO\s|\bUPDATE\s+(?:ONLY\s+)?[\w."]+\s+SET\b|\bDELETE\s+FROM\s|\bWITH\s+\w+\s+AS\s*\(/i.test(lit0)) continue;
        /* NOT TABLES (2026-10-02 validation on a large monorepo: hono, vitest, columns, tables, inserted, source were "tables"):
           a literal that is JavaScript (import ... from "x" / require(...)) is code, not SQL; the system catalogs
           (information_schema.x, pg_catalog.x) are not the app's tables - drop those references before reading */
        if (/\bimport\s[\s\S]{0,200}?\bfrom\s*["'`]|\brequire\s*\(/.test(lit0)) continue;
        const lit = lit0.replace(/\b(?:information_schema|pg_catalog|pg_temp\w*)\s*\.\s*"?\w+"?/gi, ' sys_catalog ');
        const rr = /\b(?:FROM|JOIN)\s+(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]{2,})\b"?(?:\s+(?:AS\s+)?[a-z_]\w*)?\s*(?=WHERE\b|JOIN\b|LEFT\b|RIGHT\b|INNER\b|CROSS\b|FULL\b|ON\b|GROUP\b|ORDER\b|LIMIT\b|UNION\b|RETURNING\b|USING\b|FOR\b|SET\b|WITH\b|,|;|\)|$)/gi; while ((m = rr.exec(lit))) reads.add(m[1].toLowerCase());
        // the shape continues after the table: INSERT INTO t (| VALUES | SELECT, UPDATE t [alias] SET, DELETE FROM t WHERE|USING|RETURNING|end (measured 2026-09-17: prose inside a literal that also held real SQL gave 'above', 'they', 'when')
        const rw = /\b(?:INSERT\s+INTO\s*(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]{2,})\b"?\s*(?=\(|VALUES\b|SELECT\b|DEFAULT\b)|UPDATE\s+(?:ONLY\s+)?(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]{2,})\b"?(?:\s+(?:AS\s+)?[a-z_]\w*)?\s+(?=SET\b)|DELETE\s+FROM\s+(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]{2,})\b"?(?:\s+(?:AS\s+)?[a-z_]\w*)?\s*(?=WHERE\b|USING\b|RETURNING\b|;|$))/gi; while ((m = rw.exec(lit))) writes.add((m[1] || m[2] || m[3]).toLowerCase());
      }
      // Kysely / query-builder calls
      const rk = /\.(selectFrom|insertInto|updateTable|deleteFrom)\(\s*['"]([a-z_][a-z0-9_.]*)['"]/g;
      while ((m = rk.exec(src))) { const t = m[2].split('.').pop().toLowerCase(); (m[1] === 'selectFrom' ? reads : writes).add(t); }
      ['select', 'where', 'set', 'values', 'dual', 'the', 'and', 'for', 'not', 'unnest', 'generate_series', 'lateral', 'only', 'json_each', 'jsonb_each', 'jsonb_array_elements', 'public', 'information_schema', 'pg_catalog', 'pg_class', 'pg_tables', 'each', 'this', 'that', 'with', 'into', 'from', 'table', 'where', 'returning',
        'sys_catalog', 'inserted', 'deleted', 'excluded', 'source', 'target', 'new', 'old', 'columns', 'tables', 'pg_policies', 'pg_roles', 'pg_namespace', 'pg_attribute', 'pg_indexes', 'pg_stat_activity', 'pg_proc', 'pg_type', 'pg_constraint', 'pg_trigger', 'pg_settings', 'pg_extension', 'pg_publication'].forEach((k) => { reads.delete(k); writes.delete(k); });
      return { reads: [...reads], writes: [...writes], defines: [] };
    },
    entry: (kind) => /^(page|route|worker|migration|sql|script|test)$/.test(kind),
    /* per file, for the lenses: routes it declares (with the guard inside each declaration's own
       argument list - never the next route's), API paths it calls, the page URL, the tables it names */
    collect: (f, src0, subj, kind, ctx) => {
      if (kind === 'test') return;
      /* test files and CI guard scripts hold route-SHAPED strings (fixtures: '/a', '/webhooks/x', '/api/auth/sign-in/email' in
         a test table) - 24 of a large monorepo's212 "dead routes" were those (an audit's report). Nothing there declares or calls. */
      if (/(^|\/)(__tests__|__mocks__|__fixtures__|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)scripts\/ci\//i.test(f.rel)) return;
      const src = uncomment(src0);   // comments blanked, line numbers kept: example routes in docs are not routes
      const C = ctx.C; let m;
      /* ROUTER-LEVEL PERMISSIONS (2026-09-27: financials.ts guards all nine routes with ONE line,
         financialsRouter.use("/*", requirePermission("financials.read")) - the map called every one of them open).
         <router>.use([path,] ...requirePermission("x")) guards that router's routes under the path. */
      const guards = []; const useRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*(?:(["'`])([^"'`]*)\2\s*,\s*)?(?:[A-Za-z_$][\w$.]*(?:\([^()]*\))?\s*,\s*)*requirePermission\s*\(\s*["'`]([^"'`]+)["'`]/g;
      while ((m = useRe.exec(src))) guards.push({ router: m[1], prefix: String(m[3] || '').replace(/\/?\*+$/, ''), perm: m[4] });
      C.route.lastIndex = 0;
      const decl = [];   // each declaration's position, for the route's own tables below
      while ((m = C.route.exec(src))) {
        decl.push({ at: m.index, n: ctx.routes.length });
        const win = src.slice(m.index, m.index + 400), stop = win.search(/=>\s*\{|async\s*\(/), args = stop > 0 ? win.slice(0, stop) : win;
        C.perm.lastIndex = 0; const p = C.perm.exec(args);
        const g = m.groups || {};
        const router = g.router || m[1] || 'app', sub = g.path || m[4] || '/';
        const guard = p ? null : guards.find((x) => x.router === router && (!x.prefix || sub === x.prefix || sub.startsWith(x.prefix + '/')));
        ctx.routes.push({ router, method: String(g.method || m[2]).toUpperCase(), sub, permission: p ? p[1] : guard ? guard.perm : null, permFrom: p ? 'route' : guard ? 'router' : null, file: f.rel, line: src.slice(0, m.index).split('\n').length });
      }
      const tb = new Set(); C.tableCall.lastIndex = 0; while ((m = C.tableCall.exec(src))) tb.add(m[1].toLowerCase());
      if (tb.size) ctx.tablesOfFile[f.rel] = [...tb];
      /* A ROUTE'S OWN TABLES (owned-table-written-elsewhere): a route was given every table its FILE names, as
         writes for any non-GET - a large monorepo'scrm.ts (46 routes, 16 tables) made 27 write routes x 16 tables, 27 findings from one
         file. Now: the tables named between this declaration and the next, a write only where that text inserts / updates /
         upserts / deletes it (a .from('t') chain or SQL). A handler that does its work through helpers above the first route
         falls back to the tables those helpers write. */
      const chainTables = (text) => {
        const r = new Set(), w = new Set(); let k; C.tableCall.lastIndex = 0;
        while ((k = C.tableCall.exec(text))) { const t = k[1].toLowerCase(); const stmt = text.slice(k.index, k.index + 400).split(/;\s*(?:\n|$)/)[0]; (/\.\s*(?:insertInto|updateTable|deleteFrom)\s*\(/.test(k[0]) || /\.\s*(?:insert|update|upsert|delete)\s*\(/.test(stmt) ? w : r).add(t); }
        const sq = SCANNERS.typescript.tables(text); sq.writes.forEach((t) => w.add(t)); sq.reads.forEach((t) => r.add(t));
        w.forEach((t) => r.delete(t)); return { reads: [...r], writes: [...w] };
      };
      if (decl.length) {
        const helpers = chainTables(src.slice(0, decl[0].at));
        decl.forEach((d, i) => {
          const own = chainTables(src.slice(d.at, i + 1 < decl.length ? decl[i + 1].at : src.length));
          const r = ctx.routes[d.n]; if (!r) return;
          r.writes = own.writes.length || own.reads.length ? own.writes : (r.method !== 'GET' ? helpers.writes : []);
          r.reads = own.writes.length || own.reads.length ? own.reads : helpers.reads;
        });
      }
      if (kind !== 'migration') { /* route files too: a door calling a door is a finding (2026-09-18, found by the fixture) */ C.call.lastIndex = 0; const seen = new Set(); while ((m = C.call.exec(src))) { const u = m[2].split('?')[0]; if (!seen.has(u)) { seen.add(u); ctx.calls.push({ file: f.rel, url: u }); } }
        /* EVERY API ADDRESS WRITTEN IN THE FILE (#4554's report: 119 of 212 "dead routes" had callers the call pattern missed):
           `${ENDPOINT}/${id}` with ENDPOINT a constant in the same file, api(RECENT_SEARCHES_PATH, ...), api<T>(<newline> `/api/...`).
           Constants holding an /api/ address are resolved; any other ${...} is a wildcard. A file that mounts routers is skipped -
           its '/api/v1/x' strings are prefixes, not calls. */
        C.mount.lastIndex = 0;
        if (!C.mount.test(src)) {
          const consts = {}; const cre = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(["'`])(\/api\/[^"'`$\s]*)\2/g;
          while ((m = cre.exec(src))) consts[m[1]] = m[3];
          const declaredHere = new Set(ctx.routes.filter((r) => r.file === f.rel).map((r) => r.sub));   // a route's own declaration is not a call to it (the fixture caught that)
          const add = (u) => { if (declaredHere.has(u)) return; u = u.split('?')[0].replace(/\$\{[^}]*\}/g, '*'); if (/^\/api\//.test(u) && !seen.has(u)) { seen.add(u); ctx.calls.push({ file: f.rel, url: u }); } };
          Object.values(consts).forEach(add);
          const lre = /`([^`]*)`|"(\/api\/[^"\n]*)"|'(\/api\/[^'\n]*)'/g;
          while ((m = lre.exec(src))) { let t = m[1] !== undefined ? m[1] : (m[2] || m[3]); t = t.replace(/^\$\{\s*([A-Za-z_$][\w$]*)\s*\}/, (x, id) => (consts[id] !== undefined ? consts[id] : x)); t = t.replace(/^\$\{[^}]*\}(?=\/api\/)/, ''); add(t); }   // `${apiUrl}/api/v1/...`: the leading base is the server's address, not a path
        }
      }
      if (kind === 'page' && C.pageEntry.test(f.rel)) {
        const url = '/' + f.rel.replace(/^.*?\/app\//, '').replace(/\/page\.[a-z]+$/, '').split('/').filter((seg) => seg && !/^\(.*\)$/.test(seg)).join('/');
        ctx.pages.push({ file: f.rel, url: url === '/' ? '/' : url.replace(/\/$/, '') });
      }
    },
    /* after every file: routes become nodes, calls become edges, pages get their reach, and the
       lenses domain / permission / rbac / sensitivity / criticality are written */
    finish: (ctx, out) => {
      const { C, moduleOf } = ctx, { nodes, edges, tags, yields, known } = out;
      const norm = (p) => '/' + String(p).replace(/^\/+|\/+$/g, '').split('/').map((x) => (/^(:|\$\{|\[)/.test(x) || /^\d+$/.test(x) ? '*' : x)).join('/');
      const prefixOf = {}; ctx.mounts.forEach((mt) => { prefixOf[mt.name] = mt.prefix; });
      const byPath = {}; const routeSubj = {};
      const sens = (t) => C.sensitive.filter((r) => r.re.test(t));
      yields.routes = 0; yields.calls = 0; yields.callsUnmatched = 0; yields.pagesReached = 0;
      for (const r of ctx.routes) {
        if (/(^|\/)(__tests__|tests?)\//i.test(r.file) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(r.file)) continue;   // a test's stubbed requests are not the app's routes
        const pre = (ctx.filePrefix && ctx.filePrefix[r.file] !== undefined) ? ctx.filePrefix[r.file] : (prefixOf[r.router] || '');   // the file's full nested prefix, else the one-step mount
        const full = norm(pre + (r.sub === '/' ? '' : r.sub)) || '/';
        const subj = 'route:' + r.method + ' ' + full; if (routeSubj[subj]) continue; routeSubj[subj] = r;
        (byPath[full] = byPath[full] || []).push(subj);
        nodes.push({ subject: subj, kind: 'route', parent: 'file:' + r.file, title: r.method + ' ' + full, file: r.file, size: 1 }); yields.routes++;
        edges.push(['file:' + r.file, subj, 'declares']);
        tags.push([subj, 'kind', 'endpoint']);
        const mod = moduleOf(r.file); if (mod) tags.push([subj, 'domain', mod, 'the route file it is declared in']);
        if (r.permission) { tags.push([subj, 'permission', r.permission, r.permFrom === 'router' ? 'requirePermission set once for the whole router (.use)' : 'requirePermission in the route declaration']); tags.push([subj, 'rbac', 'guarded', 'carries a per-route permission']); }
        else tags.push([subj, 'rbac', 'no-permission-check', C.authNote]);
        // the route's own tables when its scanner recorded them (collect, 2026-10-03); otherwise the file's, by method, as before
        const own = Array.isArray(r.writes) || Array.isArray(r.reads);
        const tw = own ? (r.writes || []) : (r.method === 'GET' ? [] : (ctx.tablesOfFile[r.file] || []));
        const tr = own ? (r.reads || []).filter((t) => !tw.includes(t)) : (r.method === 'GET' ? (ctx.tablesOfFile[r.file] || []) : []);
        const tbl = tw.concat(tr);
        if (tbl.length) tags.push([subj, 'data', tw.length ? 'writes' : 'reads', own ? 'the tables its own handler touches' : 'method and the tables its file names']);
        for (const t of tbl) {
          const ts = 'table:' + t; if (!known.tables.has(ts)) { known.tables.add(ts); out.newTables.push(ts); }
          edges.push([subj, ts, tw.includes(t) ? 'writes' : 'reads']);
          if (mod && !out.tableDomain[ts]) { out.tableDomain[ts] = 1; tags.push([ts, 'domain', mod, 'a route in this module touches it']); }
          for (const sv of sens(t)) { if (!out.tableSens[ts + sv.value]) { out.tableSens[ts + sv.value] = 1; tags.push([ts, 'sensitivity', sv.value, 'table naming convention']); } tags.push([subj, 'sensitivity', sv.value, 'reaches ' + t]); }
        }
      }
      /* calls: a web file naming an API path reaches the route (walk the path back for wildcards) */
      const callsOf = {};
      const routeKeys = Object.keys(byPath).map((k) => [k, k.split('/')]);
      for (const c of ctx.calls) {
        const want = norm(c.url); let hit = byPath[want];
        /* a * in the CALL is a variable segment - /api/v1/settings/${kind}/${id} reaches /settings/titles/* and /settings/position-levels/*
           when the two have the same length, every segment equal or a * on either side, at least the first two segments literal */
        if (!hit && want.includes('*')) { const ws = want.split('/'); const found = []; for (const [k, ks] of routeKeys) { if (ks.length === ws.length && ks[1] === ws[1] && (ws[2] === '*' || ks[2] === ws[2] || ks[2] === '*') && ks.every((s, i) => s === ws[i] || s === '*' || ws[i] === '*')) found.push(...byPath[k]); } if (found.length) hit = found; }
        if (!hit) { const segs = want.split('/'); for (let i = segs.length; i > 1 && !hit; i--) hit = byPath[segs.slice(0, i).join('/')]; }
        if (!hit) { yields.callsUnmatched++; continue; }
        for (const subj of hit) { edges.push(['file:' + c.file, subj, 'calls']); (callsOf[c.file] = callsOf[c.file] || new Set()).add(subj); yields.calls++; }
      }
      /* pages: the reach is the transitive import closure - a page calls almost nothing itself */
      const imp = {}; edges.forEach((e) => { if (e[2] === 'import') (imp[e[0].slice(5)] = imp[e[0].slice(5)] || []).push(e[1].slice(5)); });
      const sensOfRoute = {}; tags.forEach((t) => { if (t[1] === 'sensitivity' && t[0].startsWith('route:')) (sensOfRoute[t[0]] = sensOfRoute[t[0]] || new Set()).add(t[2]); });
      for (const pg of ctx.pages) {
        const subj = 'file:' + pg.file, seen = new Set([pg.file]), stack = [pg.file], routes = new Set();
        while (stack.length && seen.size < 4000) { const f = stack.pop(); (callsOf[f] || []).forEach((r) => routes.add(r)); (imp[f] || []).forEach((t) => { if (!seen.has(t)) { seen.add(t); stack.push(t); } }); }
        tags.push([subj, 'page', pg.url]);
        const mod = moduleOf(pg.file); if (mod) tags.push([subj, 'domain', mod, 'the module its file belongs to']);
        if (routes.size) {
          const open = [...routes].filter((r) => !routeSubj[r].permission).length;
          tags.push([subj, 'rbac', open === 0 ? 'guarded' : open === routes.size ? 'no-permission-check' : 'partly-guarded', (routes.size - open) + ' of ' + routes.size + ' reachable API routes demand a permission']);
          const sv = new Set(); routes.forEach((r) => (sensOfRoute[r] || []).forEach((v) => sv.add(v))); sv.forEach((v) => tags.push([subj, 'sensitivity', v, 'reaches data tagged ' + v]));
          yields.pagesReached++;
        } else tags.push([subj, 'reach', 'no-api-calls', 'no API call is visible from this page or what it imports']);
        if (C.adminish.test(pg.url)) tags.push([subj, 'criticality', 'admin-surface', 'the URL looks administrative']);
      }
      /* every file's business area, when the project named its modules */
      if (C.modules.length) for (const f of out.taken) { const mod = moduleOf(f.rel); if (mod && !ctx.pages.some((p) => p.file === f.rel)) tags.push(['file:' + f.rel, 'domain', mod, 'path rule']); }
      /* the lenses' descriptions and grades, beside the code that produces the values */
      out.ns.push(['domain', 'Business areas', 'Which area of the business each part of the code belongs to (the project\'s own module rules).', 0]);
      out.ns.push(['permission', 'Permission map', 'Which named permission unlocks which route - how far one permission reaches.', 0]);
      out.ns.push(['rbac', 'Role-based access check', 'Whether each route and page sits behind a permission, or whether anyone signed in can reach it.', 1]);
      out.ns.push(['sensitivity', 'Sensitive data', 'Where money, personal data and credentials can be reached from.', 1]);
      out.ns.push(['criticality', 'Admin surfaces', 'The screens where a mistake costs most: URLs that look administrative (admin, settings, members, roles, permissions, billing, integrations, import, export). One value - a screen either is one or is not; the lit ones are the pages to test and guard first.', 1]);
      out.ns.push(['page', 'Page URLs', 'Each screen\'s URL - one value per page, so this only means something inside one feature: pick a URL and see which screen it is and what that screen reaches.', 0]);
      out.tm.push(['rbac', 'no-permission-check', 'bad', 'no permission check', 'the route declares no permission; any signed-in role reaches it'], ['rbac', 'partly-guarded', 'warn', 'partly guarded', 'some of what it reaches checks a permission and some does not'], ['rbac', 'guarded', 'ok', 'guarded', 'a permission is required']);
      C.sensitive.forEach((r) => out.tm.push(['sensitivity', r.value, r.band, r.label, r.band === 'info' ? 'worth knowing, not itself a problem' : 'reaches ' + r.label]));
      out.tm.push(['criticality', 'admin-surface', 'warn', 'administrative', 'the URL looks administrative'], ['reach', 'no-api-calls', 'info', 'no API calls', 'this page reaches no API the scan can see'], ['kind', 'endpoint', 'info', 'endpoint', 'an HTTP route']);
      C.modules.forEach((m) => { if (m.keyFrom) return; if (!out.tm.some((t) => t[0] === 'domain' && t[1] === m.key)) out.tm.push(['domain', m.key, 'info', m.title, m.tier === 'foundation' ? 'foundation - used by everything by design' : '']); });
      if (C.modules.some((m) => m.keyFrom)) { const seen = new Set(tags.filter((t) => t[1] === 'domain').map((t) => t[2])); for (const k of seen) if (k !== 'unsorted' && !out.tm.some((t) => t[0] === 'domain' && t[1] === k)) out.tm.push(['domain', k, 'info', k, 'the modules\\' + k + '\\ folder']); }
      if (C.modules.length) out.tm.push(['domain', 'unsorted', 'info', 'Unsorted', 'no module rule matched']);
    },
    facts: (src, f) => /(^|\/)(__tests__|tests?)\//i.test(f.rel) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(f.name) ? { ownConnect: false, functions: [], secret: false, noAssert: /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+$|_test\.[cm]?[jt]sx?$/.test(f.rel) && !/\b(assert|expect|should|toBe|toEqual|strictEqual|deepEqual|rejects|throws)\b|\.waitFor(URL|Selector|Response)?\s*\(|process\.exit\s*\(\s*[^0)\s]|throw\s+new\s+Error/.test(src) } : ({   // a test's fixtures are not secrets, its helpers not twins
      ownConnect: ownConnectOf(src),
      functions: [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_]\w*)\s*[<(]/gm)].map((m) => m[1]).concat([...src.matchAll(/^export\s+const\s+([a-zA-Z_]\w*)\s*=\s*(?:async\s*)?\(/gm)].map((m) => m[1])).filter((n) => !/^(main|run|handler|default|init|setup|register|GET|POST|PUT|PATCH|DELETE|Page|Layout|middleware|generateMetadata)$/.test(n)),
      /* the BODY of each function, fingerprinted (fix the noisy rules - duplicate-function fired 635 times on
         a large monorepo for any two files sharing a name: every script's own log(), decide(), parseArgs()). A twin is the same name AND the
         same code; whitespace and comments do not count, and a body under ~120 characters is too small to be worth a finding. */
      fnHash: (() => { const out = {}; for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_]\w*)\s*[<(]|^export\s+const\s+([a-zA-Z_]\w*)\s*=\s*(?:async\s*)?\(/gm)) {
        const name = m[1] || m[2]; const open = src.indexOf('{', m.index); if (open < 0) continue;
        let depth = 0, end = -1; for (let i = open; i < Math.min(src.length, open + 40000); i++) { const ch = src[i]; if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = i; break; } }
        if (end < 0) continue;
        const body = src.slice(open, end + 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\s+/g, '');
        if (body.length >= 120) out[name] = require('node:crypto').createHash('sha1').update(body).digest('hex').slice(0, 16);
      } return out; })(),
      secret: /\b(password|passwd|api[_-]?key|secret|token)\s*[=:]\s*['"][A-Za-z0-9_\-]{16,}['"]/i.test(src) && !/process\.env/.test(src)
    })
  },
  'markdown': {
    take: (f) => /\.md$/i.test(f.name),
    kindOf: () => 'note',
    edges: (f, src, known) => {
      const out = []; let m;
      const byName = {}; for (const k of known) byName[k.replace(/\.md$/i, '').split('/').pop().toLowerCase()] = k;
      const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g; while ((m = re.exec(src))) { const t = byName[m[1].trim().toLowerCase()]; if (t) out.push([t, 'link']); }
      const re2 = /\]\(([^)]+\.md)\)/gi; while ((m = re2.exec(src))) { const t = path.posix.normalize((f.dir ? f.dir + '/' : '') + m[1]); if (known.has(t)) out.push([t, 'link']); }
      return out;
    },
    tables: () => ({ reads: [], writes: [] })
  }
};
const S = SCANNERS[type];
if (!S) { console.log(JSON.stringify({ ok: false, note: 'no scanner for type ' + type })); process.exit(2); }

/* ---------- read ---------- */
const files = []; walk(codeDir, '', files);
const taken = files.filter(S.take);

/* ---------- the reader: declarations (docs/plan-verification-and-tickets.md, Phase 2) ----------
   What the code is FOR, declared in it: file headers (@feature @kind @flow @purpose @auth @sensitive, the
   first 40 lines, the language's comment form), feature READMEs (@feature, ## Tables, ## Flows), and - for a
   codebase not yet tagged - the mapping file .cockpit/plugins/architecture.declared.json holding the same
   claims outside the code. Precedence: hand-set > declared > mapped > inferred. The vocabulary is
   plugins/architecture/tags.json; every declaration is checked against what the scan sees the code do. */
let lastRunOK = null; try { const lr = JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'tests', 'latest.json'), 'utf8')); const rr = {}; for (const r of lr.files || []) rr[r.file] = r.skipped ? null : !!r.ok; lastRunOK = (rel) => rr[rel] !== false; } catch (e) { lastRunOK = null; }
const TAGS = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'tags.json'), 'utf8')); } catch (e) { say('tags.json unreadable: ' + e.message); return { tags: {}, kinds: { values: [] }, header: {} }; } })();
const KNOWN_TAGS = new Set(Object.keys(TAGS.tags || {}));
const KIND_VALUES = new Set((TAGS.tags && TAGS.tags.kind && TAGS.tags.kind.values) || ['screen', 'action', 'logic', 'data', 'test', 'tool']);
/* THE WORDS PEOPLE ACTUALLY WRITE (a large monorepo: 116 kind-unknown after the file splits tagged new files @kind route /
   component / service / module / hook - the scanner's own kindOf uses those very words). Each maps onto the schema's six;
   a value that maps nowhere is still kind-unknown. */
const KIND_ALIAS = { route: 'action', routes: 'action', endpoint: 'action', handler: 'action', controller: 'action', api: 'action',
  component: 'screen', page: 'screen', view: 'screen', layout: 'screen', ui: 'screen',
  service: 'logic', module: 'logic', hook: 'logic', lib: 'logic', util: 'logic', utils: 'logic', helper: 'logic', store: 'logic', worker: 'logic', job: 'logic', middleware: 'logic',
  model: 'data', schema: 'data', migration: 'data', sql: 'data', repository: 'data', repo: 'data',
  script: 'tool', config: 'tool', cli: 'tool', fixture: 'test', spec: 'test' };
const normKind = (k) => { const s = String(k || '').trim().toLowerCase(); return KIND_VALUES.has(s) ? s : (KIND_ALIAS[s] && KIND_VALUES.has(KIND_ALIAS[s]) ? KIND_ALIAS[s] : s); };
const DECL = { files: {}, features: {}, mapping: null, unknown: [] };   // files[rel] = { feature, kind, flow[], purpose, auth, sensitive, source }
function parseHeader(src, f) {
  if (f && /\.(css|scss|less|md)$/i.test(f.name)) return null;   // @import, @media, prose - not headers
  const head = src.split('\n').slice(0, Number((TAGS.header && TAGS.header.readFromLines) || 40)).join('\n');
  /* a tag sits at the start of a comment line - nothing before it but comment punctuation - so @mention in prose and
     @scope/package in an import are not tags (2026-09-18: 13 false unknown-tag findings) */
  const out = {}; const line = /^[ \t]*(?:\/\/|\/\*+|\*|--|<!--|#)?[ \t]*(@[a-z][a-z-]*[ \t]+.+)$/gm; let lm;
  const pairs = [];   // one tag per line, or several on one line: the line is split at the next @tag
  while ((lm = line.exec(head))) { const tail = lm[1].replace(/\s*(\*\/|-->)\s*$/, ''); for (const part of tail.split(/\s+(?=@[a-z][a-z-]*\s)/)) { const pm = /^@([a-z][a-z-]*)\s+(.+)$/.exec(part.trim()); if (pm) pairs.push([pm[1], pm[2].trim()]); } }
  for (const [k, v] of pairs) {
    /* a tag not in tags.json is unknown - unless it is one of the JSDoc / TypeScript / tooling tags a header carries anyway
       (and @authz, the access convention some codebases already have: the candidate spelling for @auth) */
    if (!KNOWN_TAGS.has(k)) { if (!/^(param|returns?|type|typedef|template|property|prop|see|todo|deprecated|example|throws|module|license|author|since|version|file|fileoverview|default|private|public|protected|readonly|override|ts-ignore|ts-expect-error|ts-nocheck|ts-check|jsx|jest-environment|vitest-environment|eslint-disable|eslint-enable|authz(-[a-z-]+)?|media|import|font-face|keyframes|supports|layer|charset|internal|description|summary|remarks|link|inheritdoc|constructor|class|function|method|namespace|name|memberof|async|generator|abstract|static|implements|extends|augments|enum|kind)$/.test(k)) out._unknown = (out._unknown || []).concat(k); continue; }
    if (k === 'flow') out.flow = (out.flow || []).concat(v.split(',').map((x) => x.trim()).filter(Boolean));
    else if (k === 'feature' && out.feature && out.feature !== v) out._twice = true;
    else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
// feature READMEs: any README.md carrying an @feature line
for (const f of files) {
  if (!/^readme\.md$/i.test(f.name)) continue;
  let src = ''; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
  const fm = /@feature\s+([a-z0-9_-]+)/i.exec(src); if (!fm) continue;
  const name = fm[1].toLowerCase(); const F = DECL.features[name] = DECL.features[name] || { purpose: '', tables: [], flows: [], source: 'declared', readme: f.rel };
  const sec = (title) => { const m = new RegExp('^##\\s+' + title + '\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))', 'im').exec(src); return m ? m[1] : ''; };
  /* READ THE WAYS PEOPLE LIST TABLES (2026-10-02 audit of a monorepo: the READMEs list tables as a markdown table,
     `| \`financial_snapshots\` | purpose |`, and this parser only took a bare "- name" - it stripped everything from the first
     backtick, so it read ZERO tables from every README: 223 table-unowned whatever the coders wrote, and 58 tables a coder
     added changed nothing). Now: a table row's first cell, a bullet's first word, either backticked or bare; the header row
     and the |---| rule are skipped. "(read-only)" / "(tie with x)" notes after the name do not matter. */
  F.tables = sec('Tables').split('\n').map((l) => {
    const line = l.trim(); if (!line || /^\|?\s*:?-{2,}/.test(line)) return '';
    if (!/^(\||[-*+]\s)/.test(line)) return '';   // only a table row or a bullet - a prose sentence ("The dashboard has no tables") is not a list
    const cell = line.startsWith('|') ? (line.split('|')[1] || '') : line.replace(/^[-*+]\s+/, '');
    const m = /^\s*\x60?([A-Za-z_][A-Za-z0-9_.]*)\x60?/.exec(cell); return m ? m[1].replace(/^public\./, '').toLowerCase() : '';
  }).filter((t) => /^[a-z_][a-z0-9_]*$/.test(t) && t !== 'table' && t !== 'tables' && t !== 'name');
  F.flows = sec('Flows').split('\n').map((l) => /^[-*]\s*([^:]+):\s*(.+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[1].trim(), steps: m[2].split(/→|->/).map((x) => x.trim()).filter(Boolean) }));
  /* what this feature may ask of other modules: the words under "## Depends on", lower-cased. Only
     compared with feature keys, so prose around the keys is harmless */
  F.dependsOn = (sec('Depends on').match(/[a-z][a-z0-9_-]*/gi) || []).map((x) => x.toLowerCase());
  const purpose = src.split('\n').find((l) => l.trim() && !/^#|@feature/.test(l.trim())); F.purpose = purpose ? purpose.trim() : '';
}
// the mapping file
try {
  const mf = path.join(projectDir, '.cockpit', 'plugins', 'architecture.declared.json');
  if (fs.existsSync(mf)) {
    const m = JSON.parse(fs.readFileSync(mf, 'utf8')); DECL.mapping = { file: mf, files: 0 };
    for (const [name, F] of Object.entries(m.features || {})) if (!DECL.features[name]) DECL.features[name] = { purpose: F.purpose || '', tables: F.tables || [], flows: F.flows || [], dependsOn: (F.dependsOn || []).map((x) => String(x).toLowerCase()), source: 'mapped' };
    for (const [rel, d] of Object.entries(m.files || {})) { DECL.files[rel] = Object.assign({ source: 'mapped' }, d); DECL.mapping.files++; }
  }
} catch (e) { say('mapping file unreadable: ' + e.message); }
/* FAMILIES. A family is an organising label
   over features, and each family sits at one level: a shared service, a module, or the dashboard. Lines may point down
   (module -> service) and the dashboard may read every module; a line pointing up, a module reading another module's
   tables, or a module calling another module it does not list under "## Depends on" is a red flag. Per project:
   .cockpit/plugins/architecture.families.json { families: [{ name, level, members: [feature keys], why }] }. No file, no
   families and no family rules - every other project is unchanged. */
const FAM = { of: {}, list: [] };
try {
  const ff = path.join(projectDir, '.cockpit', 'plugins', 'architecture.families.json');
  if (fs.existsSync(ff)) {
    const j = JSON.parse(fs.readFileSync(ff, 'utf8'));
    for (const f of j.families || []) {
      if (!f || !f.name) continue;
      const level = ['service', 'module', 'dashboard'].includes(f.level) ? f.level : 'module';
      FAM.list.push({ name: f.name, level, why: f.why || '' });
      for (const k of f.members || []) FAM.of[String(k).toLowerCase()] = { name: f.name, level };
    }
  }
} catch (e) { say('families file unreadable: ' + e.message); }
say('declarations: ' + Object.keys(DECL.features).length + ' features, ' + Object.keys(DECL.files).length + ' mapped files' + (DECL.mapping ? '' : ' (no mapping file)') + (FAM.list.length ? ', ' + FAM.list.length + ' families' : ''));
const known = new Set(taken.map((f) => f.rel));
say('files ' + files.length + ', scanned ' + taken.length + ' (' + type + ')');

const nodes = [], edges = [], tags = [];
const siteName = path.basename(projectDir);
const SITE = 'site:' + siteName;
nodes.push({ subject: SITE, kind: 'site', parent: null, title: siteName, file: null, size: 1 });
/* Folders are a TREE: site > council > services > file, every ancestor present, each folder
   the child of the one above it. The first cut filed every folder directly under the site,
   so "one up" from council/services was the site and the trail was never deeper than two
  . Top-level files sit in a "/ (top level)" folder of their own so the
   site level stays a small ring rather than fifty files beside four folders. */
const folders = new Set();
const folderSubject = (dir) => 'folder:' + (dir || '/');
function ensureFolder(dir) {
  if (folders.has(dir)) return;
  folders.add(dir);
  const parentDir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  if (dir && parentDir) ensureFolder(parentDir);
  nodes.push({ subject: folderSubject(dir), kind: 'folder', parent: dir && parentDir ? folderSubject(parentDir) : SITE,
    title: dir ? dir.split('/').pop() : '/ (top level)', file: dir || null, size: 1 });
}
for (const f of taken) ensureFolder(f.dir);

const yields = { files: taken.length, pages: 0, includes: 0, imports: 0, links: 0, forms: 0, fetches: 0, scripts: 0, tables: 0, reads: 0, writes: 0, defines: 0, problems: 0 };
const tableSubjects = new Set();
const inbound = {};
/* Sensitive data, found by the scanner - no list to write.
   A table is money / personal / credentials by its NAME or by its COLUMNS (CREATE TABLE bodies in .sql files);
   a route or file that reaches it inherits the mark. A project's own conventions list adds to this, never replaces it. */
const SENSITIVE = [
  { value: 'financial', label: 'money',          band: 'warn', name: /(^|_)(financial|billing|invoice|payment|subscription|stripe|qbo|price|pricing|charge|refund|payout|ledger|tax|budget|expense|revenue|wallet|card)s?(_|$)/i, col: /(^|_)(price|amount|total|balance|cost|fee|tax|iban|account_number|routing|card_(number|last4)|cvv|stripe_|invoice_|payment_)/i },
  { value: 'pii',       label: 'personal data',  band: 'warn', name: /(^|_)(user|member|contact|person|people|profile|employee|customer|client|patient|student|lead|prospect|address|phone)s?(_|$)/i, col: /(^|_)(email|phone|mobile|first_name|last_name|full_name|dob|birth|ssn|passport|address|street|postcode|zip|gender|ip_address)(_|$)/i },
  { value: 'secrets',   label: 'credentials',    band: 'bad',  name: /(^|_)(auth|session|token|credential|secret|permission|role|api_key|oauth|password)s?(_|$)/i, col: /(^|_)(password|pass_hash|password_hash|secret|token|api_key|access_key|refresh_token|private_key|otp|totp)(_|$)/i },
  { value: 'audit',     label: 'audit trail',    band: 'info', name: /(^|_)(audit|log)s?(_|$)/i, col: /^$/ }
];
const tableColumns = {};   // table -> [column names] from CREATE TABLE bodies
function harvestColumns(src) {
  const re = /CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-z_]+\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\)\s*(?:;|WITH|INHERITS|PARTITION|ENGINE|$)/gi; let m;
  while ((m = re.exec(src))) { const cols = m[2].split(/,\s*(?![^()]*\))/).map((c) => (c.trim().match(/^"?([a-z_][a-z0-9_]*)"?/i) || [])[1]).filter((c) => c && !/^(primary|unique|constraint|foreign|check|key|index)$/i.test(c)); (tableColumns[m[1].toLowerCase()] = tableColumns[m[1].toLowerCase()] || []).push(...cols); }
}
function sensitivityOf(table) { const cols = tableColumns[table] || []; return SENSITIVE.filter((r) => r.name.test(table) || cols.some((c) => r.col.test(c))).map((r) => r.value); }
/* AI slop - the habits of machine-written code a person would not leave. Counted per file
   here; the thresholds and whether each is on live in problems.json. Add a habit: a count here, a rule there. */
function slopCounts(src, f, kind) {
  const code = /\.(php|[cm]?[jt]sx?)$/i.test(f.name);
  if (!code) return null;
  const c = {}, isTest = kind === 'test', isTool = kind === 'script' || /(^|\/)(scripts?|bin|tools?|cli)\//i.test(f.rel);   // a test's mocks return canned data by design; a tool takes its paths and commands from argv by design
  // catch blocks: empty (nothing but whitespace), and fake-success (return a literal, no throw and no logging)
  const catches = src.match(/catch\s*(?:\([^)]*\))?\s*\{[^{}]*\}/g) || [];
  c.emptyCatch = catches.filter((b) => /\{\s*\}$/.test(b)).length;
  // a catch with a comment is a decision someone wrote down; the SILENT one is the slop. null / false are "not found", not success
  c.fakeSuccess = isTest ? 0 : catches.filter((b) => !/throw|console\.|log|logger|emit|report|say\(|rethrow|reject|\/\/|\/\*/i.test(b) && /return\s*(\[\s*\]|\{\s*\}|\{\s*ok\s*:\s*true|true\b|''|""|\x60\x60)/.test(b)).length;
  // uppercase only: 'todo' is a product word in some apps; not 'placeholder': an HTML attribute far more often than a stub
  c.todo = (src.match(/\b(TODO|FIXME|XXX|HACK)\b/g) || []).length + (src.match(/not implemented/gi) || []).length;
  const notTooling = !/(^|\/)(scripts?|bin|cli|tools?)\//i.test(f.rel) && !/^(cli|index)\./i.test(f.name) && kind !== 'test' && kind !== 'script';
  c.debugLog = notTooling ? (src.match(/\bconsole\.(log|debug)\s*\(/g) || []).length : 0;
  // commented-out code: a run of 8+ consecutive // lines that look like code, not prose
  let run = 0, runs = 0; for (const line of src.split('\n')) { const t = line.trim(); if (/^\/\/\s*\S/.test(t) && /[;{}()=]|=>|\breturn\b|\bconst\b|\bif\b/.test(t) && !/^\/\/\s*[A-Z][a-z].{20,}[.!?]$/.test(t)) { if (++run === 8) runs++; } else run = 0; }
  c.commentedCode = runs;
  /* unbounded reads: SELECT ... FROM t with neither WHERE nor LIMIT in the same statement. Read in code with its comments
     taken out, through quoted identifiers and literals to the statement's end; a FROM that is a set-returning function or a
     CTE of the same code is bounded upstream. An audit (2026-09-28): 13 of 13 findings were false - the old pattern stopped
     at the first quote (public."member" ... LIMIT 1), read English in comments, and flagged CTEs and jsonb functions. */
  c.unbounded = 0;
  if (!isTest) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"\x60])\/\/[^\n]*/gm, '$1').replace(/^\s*--[^\n]*/gm, '');
    /* + a data-modifying CTE: WITH u AS (UPDATE ... RETURNING id) (a role-level-conversion.ts) */
    const ctes = new Set([...code.matchAll(/\b([a-z_][a-z0-9_]*)\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(\s*(?:SELECT|UPDATE|INSERT|DELETE|WITH|VALUES)\b/gi)].map((m) => m[1].toLowerCase()));
    /* SELECT and FROM in capitals, as SQL is written: "Select a row from the table", <select>, import { Select } from ...
       are words, not queries (an audit: all 12 web-app findings were UI text and JSX) */
    for (const m of code.matchAll(/\bSELECT\b[^;\x60]{0,400}?\bFROM\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))?)(\s*\()?/g)) {
      if (m[2]) continue;   // FROM a function call: jsonb_to_recordset(...), generate_series(...)
      if (ctes.has(m[1].replace(/"/g, '').split('.').pop().toLowerCase())) continue;
      /* THE OWNER'S RULE STANDS AS WRITTEN (2026-10-03: "every query has a WHERE or a LIMIT" - a count gets LIMIT 1 too, no
         exceptions for what a query returns). Only the scanner's own blind spots are read past, where the clause IS there:
           - a statement built from joined pieces ('SELECT', '...', 'FROM campaign', `WHERE ...`].join) is read across them
             (an ads-sync.ts: its WHERE sat in the next piece, past the backtick the reading stopped at)
           - a clause added when the code runs ("${table}"${where}${limitOffset}) is a WHERE / LIMIT the text cannot see
           - MAXRESULTS is QuickBooks' LIMIT */
      const raw = code.slice(m.index + m[0].length, m.index + m[0].length + 600);
      const joined = /['"]\s*[,+]\s*['"\x60]/.test(m[0]);
      const rest = joined ? raw.split(/;|\]\s*\.join\b/)[0] : raw.split(/;|\x60/)[0];
      if (/^\s*\$\{/.test(rest)) continue;
      if (!/\b(WHERE|LIMIT|JOIN|FETCH|TOP|OFFSET|MAXRESULTS)\b/i.test(rest)) c.unbounded++;
    }
  }
  // uncapped retry: an endless loop that awaits and catches - no attempt counter in sight
  c.uncappedRetry = isTest ? 0 : (src.match(/(while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{[\s\S]{0,1200}?\bcatch\b/g) || []).filter((b) => !/attempt|retries|tries|max|count|budget|deadline|<\s*\d|<=\s*\d/i.test(b)).length;
  c.typeEscape = /\.[cm]?tsx?$/i.test(f.name) ? (src.match(/\bas\s+any\b|@ts-ignore|@ts-expect-error|:\s*any\b/g) || []).length : 0;
  // SAST: the injection shapes readable in the source (tests exempt - they build strings on purpose)
  const INPUT = '(req\\.(body|query|params|headers)|params\\.|query\\.|body\\.|\\binput\\b|argv|searchParams)';
  c.sqlConcat = isTest ? 0 : (src.match(/["'\x60][^"'\x60]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE)\b[^"'\x60]*["'\x60]\s*\+\s*[a-zA-Z_$]/g) || []).length;
  c.evalUse = isTest ? 0 : (src.match(/\beval\s*\(|new\s+Function\s*\(/g) || []).length;
  // only a file that uses child_process can shell out; regex.exec(input) is not a shell (2026-09-18: bos.ts and calendar-utils.ts were false hits)
  c.shellInput = isTest || isTool || !/child_process/.test(src) ? 0 : (src.match(new RegExp('(?<![\\/\\w])\\.?\\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\\s*\\([^)]*' + INPUT, 'g')) || []).filter((m) => !/^\.exec\(/.test(m.trim()) || true).length;
  c.rawHtml = isTest ? 0 : (src.match(/dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!['"\x60])|\.innerHTML\s*=\s*(?!['"\x60])/g) || []).length;
  c.pathInput = isTest || isTool ? 0 : (src.match(new RegExp('\\b(readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|readdir|readdirSync|unlink|unlinkSync|sendFile|stat|statSync)\\s*\\([^)]*' + INPUT, 'g')) || []).length;
  c.openRedirect = isTest || isTool ? 0 : (src.match(new RegExp('\\bredirect\\s*\\(\\s*' + INPUT, 'g')) || []).length;
  return c;
}
const facts = {};   // per file, what the problem finder needs: kind, tables written, own db connect, functions, secrets, out-degree
const entryPoints = new Set();   // files reached from outside by design (a scanner's `entry` rule): never "nothing points here"
let ctx_modulesSeen = [];
const ctx = S.prepare ? S.prepare(taken, codeDir) : {};   // whatever a scanner needs to know across files (packages, router mounts)
const YIELD_OF = { include: 'includes', import: 'imports', link: 'links', form: 'forms', fetch: 'fetches', script: 'scripts' };
// the PHP-era facts, kept as the default so the two older scanners are untouched
const defaultFacts = (src) => ({
  ownConnect: /\b(new\s+mysqli\s*\(|mysqli_connect\s*\(|new\s+PDO\s*\(|mysql_connect\s*\()/i.test(src),
  functions: [...src.matchAll(/^\s*function\s+([a-zA-Z_]\w*)\s*\(/gm)].map((m) => m[1]),
  secret: /\b(password|passwd|pwd|api[_-]?key|secret)\s*[=:]\s*['"][^'"]{6,}['"]/i.test(src) && !/\$_(POST|GET|ENV|SERVER)|getenv\(/i.test(src.slice(0, 400)) });
const DRIFT = [];
for (const f of taken) {
  let src = ''; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
  const subj = 'file:' + f.rel;
  const kind = S.kindOf(f, src);
  if (/\.sql$/i.test(f.name)) harvestColumns(src);
  { const h = parseHeader(src, f); if (h) { if (h._unknown) DECL.unknown.push([subj, h._unknown]); if (h._twice) (DECL.twice = DECL.twice || []).push(subj); const mapped = DECL.files[f.rel]; if (mapped && mapped.source === 'mapped' && h.feature && h.kind) (DECL.redundant = DECL.redundant || []).push(subj); DECL.files[f.rel] = Object.assign({}, mapped || {}, h, { source: 'declared', flow: h.flow || (mapped && mapped.flow) || [] }); } }
  if (kind === 'page') yields.pages++;
  // formatting drift inside one file - what no config can excuse: two indent styles, two line endings, trailing blanks, no final newline
  if (/\.([cm]?[jt]sx?|php|py|css|html?|sql|json|md)$/i.test(f.name) && src.length > 200 && src.length < 400000) {
    const lines = src.split('\n'); const crlf = (src.match(/\r\n/g) || []).length, bareLf = lines.length - 1 - crlf;
    let tabs = 0, spaces = 0, trailing = 0; for (const ln of lines) { if (/^\t/.test(ln)) tabs++; else if (/^ {2,}/.test(ln)) spaces++; if (/[ \t]+\r?$/.test(ln) && ln.trim()) trailing++; }
    const indented = tabs + spaces, drift = [];
    if (indented > 20 && Math.min(tabs, spaces) > indented * 0.05) drift.push('tabs and spaces both indent (' + tabs + ' tab lines, ' + spaces + ' space lines)');
    if (crlf > 3 && bareLf > 3) drift.push('CRLF and LF line endings mixed (' + crlf + ' / ' + bareLf + ')');
    if (lines.length > 30 && trailing > lines.length * 0.03) drift.push(trailing + ' lines end in blanks');
    if (!/\n$/.test(src) && lines.length > 30) drift.push('no newline at the end');
    if (drift.length) DRIFT.push([subj, drift.join('; ')]);   // emitted once the rules are loaded
  }
  if (S.entry && S.entry(kind, f)) entryPoints.add(subj);
  nodes.push({ subject: subj, kind: 'file', parent: folderSubject(f.dir), title: f.name, file: f.rel, size: Math.max(1, Math.round(src.length / 1000)) });
  tags.push([subj, 'kind', kind]);
  let out = 0;
  for (const [t, ek] of S.edges(f, src, known, ctx)) { edges.push([subj, 'file:' + t, ek]); inbound['file:' + t] = (inbound['file:' + t] || 0) + 1; yields[YIELD_OF[ek] || 'scripts']++; out++; }
  const tb = S.tables(src, f);
  for (const t of tb.reads) { const ts = 'table:' + t; tableSubjects.add(ts); edges.push([subj, ts, 'reads']); yields.reads++; out++; }
  for (const t of tb.writes) { const ts = 'table:' + t; tableSubjects.add(ts); edges.push([subj, ts, 'writes']); yields.writes++; out++; }
  for (const t of tb.defines || []) { const ts = 'table:' + t; tableSubjects.add(ts); edges.push([subj, ts, 'defines']); yields.defines++; }
  tags.push([subj, 'data', tb.writes.length ? (tb.reads.length ? 'reads-and-writes' : 'writes') : tb.reads.length ? 'reads' : (tb.defines || []).length ? 'defines' : 'no-database']);
  facts[subj] = { kind, writes: tb.writes, out, size: src.length, slop: slopCounts(src, f, kind), ...(S.facts ? S.facts(src, f) : defaultFacts(src)) };
  if (S.collect) S.collect(f, src, subj, kind, ctx);
}
/* a scanner's second pass, after every file is known: lens work that needs the whole picture */
const EXTRA = { ns: [], tm: [], newTables: [], tableDomain: {}, tableSens: {} };
if (S.finish) {
  S.finish(ctx, { nodes, edges, tags, yields, taken, known: { tables: tableSubjects }, newTables: EXTRA.newTables, tableDomain: EXTRA.tableDomain, tableSens: EXTRA.tableSens, ns: EXTRA.ns, tm: EXTRA.tm });
  for (const ts of EXTRA.newTables) { /* tables first seen through a route; the loop below writes their nodes */ }
}
/* the FEATURE of a table: what defines it, else the
   majority of its writers, else its readers - so the tables view can group by feature */
{
  const domainOf = {}; for (const t of tags) if (t[1] === 'domain') domainOf[t[0]] = t[2];
  const has = new Set(tags.filter((t) => t[1] === 'domain').map((t) => t[0]));
  const pick = (ts, kind) => { const c = {}; for (const e of edges) if (e[1] === ts && e[2] === kind && domainOf[e[0]] && domainOf[e[0]] !== 'unsorted') c[domainOf[e[0]]] = (c[domainOf[e[0]]] || 0) + 1; const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return best ? best[0] : null; };
  for (const ts of tableSubjects) { if (has.has(ts)) continue; const d = pick(ts, 'defines') || pick(ts, 'writes') || pick(ts, 'reads'); if (d) tags.push([ts, 'domain', d, 'the feature of what defines or writes it']); }
}
/* a "table" nothing defines, nothing writes and only one file reads is a word from prose, not a table (2026-09-18: public, add, due, fan, foo, for, was) */
{
  const defined = new Set(), written = new Set(), readers = {};
  for (const e of edges) { if (e[2] === 'defines') defined.add(e[1]); else if (e[2] === 'writes') written.add(e[1]); else if (e[2] === 'reads') (readers[e[1]] = readers[e[1]] || new Set()).add(e[0]); }
  const junk = [...tableSubjects].filter((ts) => !defined.has(ts) && !written.has(ts) && (readers[ts] ? readers[ts].size : 0) <= 1 && !/_/.test(ts.slice(6)));
  if (junk.length) { const j = new Set(junk); junk.forEach((ts) => tableSubjects.delete(ts)); for (let i = edges.length - 1; i >= 0; i--) if (j.has(edges[i][1])) edges.splice(i, 1); for (let i = tags.length - 1; i >= 0; i--) if (j.has(tags[i][0])) tags.splice(i, 1); say('dropped ' + junk.length + ' prose "tables": ' + junk.slice(0, 8).map((t) => t.slice(6)).join(', ')); }
}
if (tableSubjects.size) {
  nodes.push({ subject: 'db:tables', kind: 'folder', parent: SITE, title: 'database tables', file: null, size: 1 });
  for (const ts of tableSubjects) { nodes.push({ subject: ts, kind: 'table', parent: 'db:tables', title: ts.slice(6), file: null, size: 1 }); tags.push([ts, 'kind', 'table']); yields.tables++; }
}
/* ENTRY BY CONVENTION, for every scanner (2026-09-29: 76 "nothing points here" on a large monorepo; about 30 were files a tool or a
   framework loads by name, not dead code): config and setup files, Next.js special files, tests (the runner is what
   points at them), and whatever a package.json (main/module/exports/bin, and the files its scripts run) or a wrangler
   file (main) names - with dist/ or lib/ read back to src/. What is left really is imported by nothing. */
{
  const CONV = [/(^|\/)[^/]+\.config\.[cm]?[jt]s$/i, /(^|\/)(vitest|jest)\.setup\.[cm]?[jt]sx?$/i,
    /(^|\/)(middleware|instrumentation|instrumentation-client)\.[jt]s$/i,
    /(^|\/)app\/(.+\/)?(page|layout|template|default|loading|error|global-error|not-found|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[jt]sx?$/i,
    /(^|\/)(test-e2e|e2e|__tests__|tests?)\//i, /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i];
  const byRel = new Set(taken.map((f) => f.rel));
  const refer = (dir, p) => {
    if (typeof p !== 'string' || /^(https?:|node:|-)/.test(p) || !/[./]/.test(p)) return;
    const r = path.posix.normalize(path.posix.join(dir || '.', p.replace(/^\.\//, '')));
    for (const c of [r, r.replace(/(^|\/)(dist|lib|build)\//, '$1src/')]) {
      const base = c.replace(/\.(d\.ts|[cm]?[jt]sx?)$/, '');
      for (const x of [c, base + '.ts', base + '.tsx', base + '.js', base + '.mjs', base + '.cjs', base + '/index.ts', base + '/index.tsx', base + '/index.js']) if (byRel.has(x)) entryPoints.add('file:' + x);
    }
  };
  const walkJson = (dir, v) => { if (typeof v === 'string') refer(dir, v); else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkJson(dir, x)); };
  const dirs = new Set(); for (const f of taken) { let d = path.posix.dirname(f.rel); while (d && d !== '.' && !dirs.has(d)) { dirs.add(d); d = path.posix.dirname(d); } } dirs.add('.');
  for (const d of dirs) {
    let pj = null; try { pj = JSON.parse(fs.readFileSync(path.join(codeDir, d, 'package.json'), 'utf8')); } catch (e) { /* none here */ }
    if (pj) { ['main', 'module', 'browser', 'types', 'exports', 'bin'].forEach((k) => walkJson(d, pj[k])); Object.values(pj.scripts || {}).forEach((cmd) => String(cmd).split(/[\s"'=]+/).filter((t) => /\.[cm]?[jt]sx?$/.test(t)).forEach((t) => refer(d, t))); }
    for (const w of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) { let s = ''; try { s = fs.readFileSync(path.join(codeDir, d, w), 'utf8'); } catch (e) { continue; } const m = /^\s*"?main"?\s*[=:]\s*["']([^"']+)["']/m.exec(s); if (m) refer(d, m[1]); }
  }
  /* launchers: a shell / PowerShell / batch script, a launchd plist, a systemd unit, a Dockerfile, a Procfile or a CI
     workflow that names a code file starts it (a large monorepo'sautomation-cron: host/run-daemon.sh runs src/daemon.ts) - the
     path is tried from the launcher's folder, its parent (the package) and the root */
  const LAUNCH = /(\.(sh|bash|ps1|cmd|bat|plist|service|timer|ya?ml)|^Dockerfile[^/]*|^Procfile)$/i;
  // and one folder down: launchers often sit in a folder with no code of their own (automation-cron/host/run-daemon.sh)
  const launchDirs = new Set(dirs); launchDirs.add('.github/workflows');
  for (const d of dirs) { let sub = []; try { sub = fs.readdirSync(path.join(codeDir, d), { withFileTypes: true }); } catch (e) { continue; } for (const en of sub) if (en.isDirectory() && !/^(node_modules|\.git|dist|build|\.next|\.turbo|coverage|vendor)$/.test(en.name)) launchDirs.add(d === '.' ? en.name : d + '/' + en.name); }
  for (const d of launchDirs) {
    let ents = []; try { ents = fs.readdirSync(path.join(codeDir, d), { withFileTypes: true }); } catch (e) { continue; }
    for (const en of ents) {
      if (!en.isFile() || !LAUNCH.test(en.name)) continue;
      let s = ''; try { s = fs.readFileSync(path.join(codeDir, d, en.name), 'utf8'); } catch (e) { continue; } if (s.length > 300000) continue;
      for (const m of s.matchAll(/[\w@.\/-]+\.[cm]?[jt]sx?\b/g)) { const p = m[0].replace(/^\.\//, ''); refer(d, p); refer(path.posix.dirname(d), p); refer('.', p); }
    }
  }
  for (const f of taken) if (CONV.some((re) => re.test(f.rel))) entryPoints.add('file:' + f.rel);
}
// reach: does anything point at this file? A page nothing links to may be an entry point (index) or dead.
for (const f of taken) { const subj = 'file:' + f.rel; const n = inbound[subj] || 0; tags.push([subj, 'reach', n === 0 ? (entryPoints.has(subj) || /^index\.(php|html?)$/i.test(f.name) ? 'entry-point' : 'nothing-points-here') : n >= 5 ? 'widely-used' : 'reached']); }
for (const ts of tableSubjects) { const w = edges.filter((e) => e[1] === ts && e[2] === 'writes').length, r = edges.filter((e) => e[1] === ts && e[2] === 'reads').length, d = edges.filter((e) => e[1] === ts && e[2] === 'defines').length; tags.push([ts, 'data', w && r ? 'reads-and-writes' : w ? 'writes' : r ? 'reads' : 'defines']); tags.push([ts, 'reach', r + w >= 5 ? 'widely-used' : r + w ? 'reached' : 'defined-never-used']); if (r && !w) tags.push([ts, 'reach', 'read-but-never-written']); }

/* ---------- the Problems lens: what vibe-coding leaves behind ----------
   Findings, not verdicts: each is a pattern that is usually a problem, with the why on the
   tag. The owner grades what it means here; the map never argues.

   THE RULES ARE DATA: plugins/architecture/problems.json (on/off, thresholds, severity,
   wording), overridden per project by <project>/.cockpit/plugins/architecture.problems.json.
   Only the LOOKING is code, below - one block per rule, gated on rules[id].on. */
const RULES = (() => {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).rules || {}; } catch (e) { return {}; } };
  const base = read(path.join(__dirname, 'problems.json'));
  const over = read(path.join(projectDir, '.cockpit', 'plugins', 'architecture.problems.json'));
  for (const id of Object.keys(over)) base[id] = { ...(base[id] || {}), ...over[id] };
  return base;
})();
/* OWN DATABASE CONNECTION = the file holds its own connection details. The
   rule's concern is credentials and settings living in several places - not that a file opens a pool. A pool built from the
   project's shared address and settings helpers ({ connectionString: url, ...poolOptions("workers:x") }) is not one; a file
   that reads a database variable from the environment itself, writes host / user / password / a postgres:// URL, or sets its
   own pool sizes without the shared settings, is. Comments are not code (a large monorepo'spool-errors.ts only MENTIONS new Pool(...)).
   On one monorepo: 30 of 31 workers built from getWorkerDatabaseUrl() + poolOptions() cleared; audit-events-worker, which
   reads AUDIT_DATABASE_URL itself, stays. Checked against the 45 files the old rule flagged or had accepted. */
function ownConnectOf(src) {
  const code = String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/gm, '$1');
  const calls = [...code.matchAll(/\bnew\s+(?:Pool|Client)\s*\(|\bcreatePool\s*\(|\bpostgres\s*\(/g)];
  if (!calls.length) return false;
  for (const m of calls) {
    let i = m.index + m[0].length, depth = 1; while (i < code.length && depth) { const ch = code[i++]; if (ch === '(') depth++; else if (ch === ')') depth--; }
    const arg = code.slice(m.index + m[0].length, i - 1);
    if (/process\.env/.test(arg) || /\b(host|user|password|port|database)\s*:/.test(arg) || /postgres(?:ql)?:\/\//.test(arg)) return true;
    if (!/\.\.\.\s*[A-Za-z_$][\w$.]*\s*\(/.test(arg) && /\b(max|min|idleTimeoutMillis|connectionTimeoutMillis|statement_timeout)\s*:/.test(arg)) return true;
  }
  return /process\.env\.[A-Z0-9_]*(?:DATABASE|PG|DB_|POSTGRES)[A-Z0-9_]*\b|process\.env\[['"][A-Z0-9_]*(?:DATABASE|PG|POSTGRES)/.test(code);
}
const R = (id) => RULES[id] && RULES[id].on !== false ? RULES[id] : null;
/* ONE-OFF SCRIPTS ARE NOT THE APP (fix the noisy rules). An operator script (scripts/, apps/x/scripts/, CI and
   infra tooling) opens its own connection, writes tables directly and pulls in half the code BY DESIGN - on a large monorepo they were a
   large share of own-db-connection, no-single-writer and god-file. Those rules judge the running app. */
const isScriptFile = (s) => /^file:(?:.*\/)?scripts\//.test(s) || /^file:(?:\.github|infra|ops|tools)\//.test(s);
const writersOf = {}; edges.filter((e) => e[2] === 'writes' && !isScriptFile(e[0])).forEach((e) => { (writersOf[e[1]] = writersOf[e[1]] || new Set()).add(e[0]); });
const fileSubjects = Object.keys(facts);
const outDegrees = fileSubjects.map((s) => facts[s].out).sort((a, b) => a - b);
const godRule = R('god-file') || {};
/* a god file is an OUTLIER: the top 1% and at least 25 things reached (top 5% flagged ~150 files on any big
   repo by definition - a percentile always has a top). problems.json can still set topPercent / minReach per project. */
const godLine = outDegrees.length ? Math.max(godRule.minReach || 25, outDegrees[Math.floor(outDegrees.length * (1 - (godRule.topPercent || 1) / 100))]) : (godRule.minReach || 25);
/* a twin = the same name AND the same code where the language gives a body fingerprint (facts.fnHash - TypeScript/JavaScript);
   same-named functions with different bodies are not duplicates, and a body too small to fingerprint is not counted. Languages
   without fingerprints keep the name-only check. The key carries the name first, so the message still reads "function x()". */
const definedIn = Object.create(null); fileSubjects.forEach((s) => { const fh = facts[s].fnHash; facts[s].functions.forEach((fn) => { const key = fh ? (fh[fn] ? fn + '#' + fh[fn] : null) : fn; if (key) (definedIn[key] = definedIn[key] || []).push(s); }); });
/* CHECKED, IT'S FINE (2026-09-29): a person or an AI looked at a finding and it is not a problem - a hand-set tag
   ns 'accepted', value = the rule, why = the reason (cli: tag <subject> accepted <rule> "<why>"; the Architecture card's
   "it's fine"). The finding is not raised again for that subject; the count of them is kept, never hidden. */
let ACCEPTED = null;
const accepted = (subject, value) => { if (!ACCEPTED) { ACCEPTED = new Set(); try { for (const r of db.prepare("SELECT subject, value FROM tag WHERE ns = 'accepted' AND source != 'derived'").all()) ACCEPTED.add(r.subject + '|' + r.value); } catch (e) { /* no tags yet */ } } return ACCEPTED.has(subject + '|' + value); };
const problem = (subject, value, why) => { if (accepted(subject, value)) { yields.accepted = (yields.accepted || 0) + 1; return; } const d = RULES[value] && RULES[value].doctrine; tags.push([subject, 'problem', value, why + (d ? ' [doctrine: ' + d + ']' : '')]); yields.problems++; };
/* A RULE WHOSE TOOL DID NOT RUN IS NOT CLEAN (a large monorepo'stab said "checked here - nothing found" on every semgrep rule while Windows' Application Control was blocking semgrep,
   and on lint/prettier rules the scan had skipped). The site carries unchecked:<rule>; the tab shows it grey, never green. */
const unchecked = (rule, why) => { if (R(rule)) tags.push([SITE, 'unchecked', rule, why]); };
if (R('format-drift')) for (const [subj, why] of DRIFT) problem(subj, 'format-drift', why);
/* WRITERS ARE PRODUCT CODE FILES. a large monorepo'snumbers were inflated three ways: test
   files that insert their own setup rows counted as writers (3 of entities' 4), a route counted again beside the file it is
   declared in (contacts read "53", 4 real files), and test folders like test-e2e. A route's write is its file's write; tests,
   fixtures, seeds, migrations and one-off scripts are not writers of a product table. */
const NSW_SKIP = /^file:(?:.*\/)?(?:scripts?|migrations?|seeds?|fixtures?|__tests__|tests?|test-e2e|e2e)\//i;
const nswFile = (s) => { if (s.startsWith('route:')) { const n = nodes.find((x) => x.subject === s); return n && n.file ? 'file:' + n.file : null; } return s; };
if (R('no-single-writer')) for (const [ts, ws0] of Object.entries(writersOf)) {
  const ws = new Set([...ws0].map(nswFile).filter((s) => s && !NSW_SKIP.test(s) && !/\.(test|spec)\.[cm]?[jt]sx?$/i.test(s) && !(facts[s] && facts[s].kind === 'test')));
  if (ws.size >= (RULES['no-single-writer'].minWriters || 4)) problem(ts, 'no-single-writer', 'written from ' + ws.size + ' files: ' + [...ws].map((s) => s.slice(5)).slice(0, 6).join(', ') + (ws.size > 6 ? '…' : ''));
}
const ownConnectCount = fileSubjects.filter((s) => facts[s].ownConnect && !isScriptFile(s)).length;
for (const s of fileSubjects) {
  const f = facts[s]; const script = isScriptFile(s);
  if (R('sql-in-page') && f.kind === 'page' && f.writes.length) problem(s, 'sql-in-page', 'renders HTML and writes ' + f.writes.slice(0, 4).join(', ') + (f.writes.length > 4 ? '…' : ''));
  // one shared connection file is the GOOD shape; the finding is several files each opening their own
  if (R('own-db-connection') && f.ownConnect && !script && ownConnectCount >= (RULES['own-db-connection'].minFiles || 2)) problem(s, 'own-db-connection', 'opens its own database connection instead of a shared one (' + ownConnectCount + ' files do)');
  if (R('god-file') && !script && f.out >= godLine) problem(s, 'god-file', 'reaches ' + f.out + ' things (top ' + (godRule.topPercent || 1) + '% is ' + godLine + '+)');
  if (R('secret-in-code') && f.secret) problem(s, 'secret-in-code', 'a password or key literal in the source');
}
if (R('duplicate-function')) for (const [key, files] of Object.entries(definedIn)) if (new Set(files).size > 1) { const fn = key.split('#')[0], same = key.includes('#'); [...new Set(files)].forEach((s) => problem(s, 'duplicate-function', 'function ' + fn + '() ' + (same ? 'has the SAME code in ' : 'is also defined in ') + [...new Set(files)].filter((x) => x !== s).map((x) => x.slice(5)).slice(0, 3).join(', '))); }
// A finding the owner has already answered does not come back: his hand-set reach tag on a
// subject (entry point, live Node service, written by the importers…) settles it.
const ownerAnswered = new Set(db.prepare("SELECT subject FROM tag WHERE ns = 'reach' AND source != 'derived'").all().map((r) => r.subject));
if (R('nothing-points-here')) { const skip = new RegExp('\\.(' + ((RULES['nothing-points-here'].skipExtensions || ['css', 'js']).join('|')) + ')$', 'i'); for (const f of taken) { const s = 'file:' + f.rel; const t = tags.find((x) => x[0] === s && x[1] === 'reach'); if (t && t[2] === 'nothing-points-here' && !skip.test(f.name) && !ownerAnswered.has(s)) problem(s, 'nothing-points-here', 'no include, link, form, fetch or script names it - an entry point, a scheduled script, or dead'); } }
if (R('defined-never-used')) for (const ts of tableSubjects) { if (!ownerAnswered.has(ts) && tags.some((t) => t[0] === ts && t[1] === 'reach' && t[2] === 'defined-never-used')) problem(ts, 'defined-never-used', 'a migration creates it; no code here reads or writes it - dropped in all but the schema, or used by something outside this repo'); }
if (R('write-never-read')) for (const ts of tableSubjects) { const w = edges.some((e) => e[1] === ts && e[2] === 'writes'), r = edges.some((e) => e[1] === ts && e[2] === 'reads'); if (w && !r && !ownerAnswered.has(ts)) problem(ts, 'write-never-read', 'written by ' + edges.filter((e) => e[1] === ts && e[2] === 'writes').map((e) => e[0].slice(5)).slice(0, 4).join(', ') + '; nothing here reads it'); }
/* ---- AI slop: per-file counts against the thresholds in problems.json ---- */
const slopRule = (id, key, text) => { const r = R(id); if (!r) return; const min = r.min || 1; for (const s of fileSubjects) { const c = facts[s].slop; if (c && (c[key] || 0) >= min) problem(s, id, text(c[key])); } };
slopRule('empty-catch', 'emptyCatch', (n) => n + ' catch block' + (n === 1 ? '' : 's') + ' that swallow' + (n === 1 ? 's' : '') + ' the error and do' + (n === 1 ? 'es' : '') + ' nothing');
slopRule('fake-success', 'fakeSuccess', (n) => n + ' catch block' + (n === 1 ? '' : 's') + ' that answer' + (n === 1 ? 's' : '') + ' a failure with canned data - the caller believes it worked');
slopRule('todo-stub', 'todo', (n) => n + ' TODO / FIXME / placeholder marks - unfinished work shipped as finished');
slopRule('debug-logging', 'debugLog', (n) => n + ' console.log calls left in a production path');
slopRule('commented-out-code', 'commentedCode', (n) => n + ' block' + (n === 1 ? '' : 's') + ' of commented-out code (8+ lines) - kept "just in case"; git is the just-in-case');
slopRule('unbounded-query', 'unbounded', (n) => n + ' SELECT' + (n === 1 ? '' : 's') + ' with no WHERE and no LIMIT - fine on ten rows, a stall on a million');
slopRule('uncapped-retry', 'uncappedRetry', (n) => n + ' endless retry loop' + (n === 1 ? '' : 's') + ' with no attempt cap - a failing dependency becomes a hot loop');
slopRule('sql-string-built', 'sqlConcat', (n) => n + ' SQL statement' + (n === 1 ? '' : 's') + ' built by string concatenation - the door to injection; bind parameters instead');
slopRule('eval-use', 'evalUse', (n) => n + ' eval / new Function - code from data');
slopRule('shell-with-input', 'shellInput', (n) => n + ' shell command' + (n === 1 ? '' : 's') + ' built from request input - command injection');
slopRule('raw-html-from-data', 'rawHtml', (n) => n + ' place' + (n === 1 ? '' : 's') + ' where HTML from a variable is rendered raw - cross-site scripting');
slopRule('path-from-input', 'pathInput', (n) => n + ' file operation' + (n === 1 ? '' : 's') + ' on a path from request input - path traversal');
slopRule('open-redirect', 'openRedirect', (n) => n + ' redirect' + (n === 1 ? '' : 's') + ' to a URL from request input - open redirect');
slopRule('type-escape', 'typeEscape', (n) => n + ' type escapes (as any, @ts-ignore, : any) - the checker was switched off where it complained');
/* called from OUTSIDE by design - a provider's webhook, an OAuth redirect, an uptime or deploy check - is not dead because nothing
   in the repo calls it (17 of one monorepo's 212) */
const EXTERNAL_DOOR = /(^|\/)(webhooks?|callback|callbacks|oauth|health|healthz|ready|readyz|live|livez|version|status|ping|metrics|csp-report|well-known|\.well-known)(\/|$)|^\/?$/i;
if (R('dead-route')) { const called = new Set(edges.filter((e) => e[2] === 'calls').map((e) => e[1])); for (const n of nodes) if (n.kind === 'route' && !called.has(n.subject) && !ownerAnswered.has(n.subject) && !EXTERNAL_DOOR.test(String(n.title || '').replace(/^[A-Z]+\s+/, ''))) problem(n.subject, 'dead-route', 'declared in ' + (n.file || '?') + '; nothing in this code calls it - an external client, or dead'); }
if (R('test-without-assertion')) for (const s of fileSubjects) { if (facts[s].kind === 'test' && facts[s].noAssert) problem(s, 'test-without-assertion', 'a test file with no assert/expect/should - it passes whatever the code does'); }
if (R('read-never-written')) for (const ts of tableSubjects) { if (/^table:(pg_|information_schema)/.test(ts)) continue; /* the database's own catalog is read, never written - not a finding */ if (!ownerAnswered.has(ts) && tags.some((t) => t[0] === ts && t[1] === 'reach' && t[2] === 'read-but-never-written')) problem(ts, 'read-never-written', 'no code here writes it; filled from outside this code'); }
/* ---- drift against the LIVE database: what the Database plugin's last read holds (db_table, written only by that scan; read here).
   Both scans must have run; no db_table, or an empty one, is no evidence and no finding (2026-09-18, ticket D1) ---- */
{
  let live = null; try { live = db.prepare('SELECT name, type FROM db_table').all(); } catch (e) { /* the Database plugin is not on for this project */ }
  if (live && live.length) {
    const readAt = (() => { try { return String((db.prepare("SELECT value FROM db_meta WHERE key = 'scannedAt'").get() || {}).value || '').slice(0, 16).replace('T', ' '); } catch (e) { return ''; } })();
    const held = new Map(live.map((r) => [String(r.name).toLowerCase(), r.type]));
    // an owner's reach answer ("filled from outside") settles reach, not existence: a table the code reads and the database lacks is a finding regardless
    if (R('table-not-in-db')) for (const ts of tableSubjects) { const n = ts.slice(6); if (/^(pg_|information_schema)/i.test(n) || held.has(n.toLowerCase())) continue; problem(ts, 'table-not-in-db', 'the code names it; the database read at ' + readAt + ' (' + live.length + ' tables) does not hold it - a rename, a migration not run, a test-only table, or a word the scanner took for a table'); }
    if (R('table-nothing-touches')) {
      const named = new Set([...tableSubjects].map((ts) => ts.slice(6).toLowerCase()));
      for (const r of live) {
        if (r.type !== 'table' || named.has(String(r.name).toLowerCase())) continue;
        const ts = 'table:' + r.name; if (ownerAnswered.has(ts)) continue;
        // the table goes on the map so the finding has a subject: a live table this code never touches
        if (!nodes.some((n) => n.subject === 'db:tables')) nodes.push({ subject: 'db:tables', kind: 'folder', parent: SITE, title: 'database tables', file: null, size: 1 });
        nodes.push({ subject: ts, kind: 'table', parent: 'db:tables', title: r.name, file: null, size: 1 }); tags.push([ts, 'kind', 'table']);
        problem(ts, 'table-nothing-touches', 'in the database read at ' + readAt + '; no code here reads, writes or defines it');
      }
    }
  }
}

/* ---------- the project-level checks: secrets in config and logs, .env, dependencies, migrations, lint (2026-09-18) ---------- */
{
  const cpx = require('node:child_process');
  const git = (args) => { try { return cpx.execSync('git ' + args, { cwd: codeDir, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } };
  const isRepo = git('rev-parse --is-inside-work-tree') !== null;
  const ensureFile = (rel, kind) => { const subj = 'file:' + rel; if (!nodes.some((n) => n.subject === subj)) { nodes.push({ subject: subj, kind: 'file', parent: folderSubject(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)), title: path.posix.basename(rel), file: rel, size: 1 }); tags.push([subj, 'kind', kind || 'file'], [subj, 'layer', 'outside', 'config or data, not code']); } return subj; };
  const SECRET = /\b(password|passwd|pwd|api[_-]?key|secret|token|private[_-]?key|client[_-]?secret)\b["']?\s*[=:]\s*["']?[A-Za-z0-9_\-\/+=]{16,}["']?/i;   // "api_key": "..." in JSON too
  // a committed .env (the repo holds code, never secrets)
  if (isRepo && R('env-committed')) { const tracked = (git('ls-files -- .env .env.* **/.env **/.env.*') || '').split('\n').map((l) => l.trim()).filter((l) => l && !/\.example$|\.sample$|\.template$/i.test(l)); for (const rel of tracked) problem(ensureFile(rel, 'config'), 'env-committed', 'an environment file in the repository - every clone and every backup has the secrets'); }
  // secrets in config files and logs (not taken by the code scanners)
  for (const f of files) {
    if (/(^|\/)(node_modules|\.git|dist|build|coverage)\//.test(f.rel + '/')) continue;
    const isConf = /\.(json|ya?ml|toml|ini|conf|cfg|properties)$/i.test(f.name) && !/package(-lock)?\.json$|tsconfig|\.cockpit\//.test(f.rel), isLog = /\.log$/i.test(f.name);
    if (!isConf && !isLog) continue;
    let st; try { st = fs.statSync(f.abs); } catch (e) { continue; } if (st.size > 2 * 1024 * 1024) continue;
    let src = ''; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
    if (!SECRET.test(src)) continue;
    if (/\.example$|\.sample$/i.test(f.name)) continue;
    if (isConf && R('secret-in-config')) problem(ensureFile(f.rel, 'config'), 'secret-in-config', 'a password, key or token literal in a config file');
    if (isLog && R('secret-in-log')) problem(ensureFile(f.rel, 'log'), 'secret-in-log', 'a password, key or token written to a log');
  }
  // .env.example: every variable the code reads is listed
  const exampleRel = files.find((f) => f.rel === '.env.example'); const envRead = new Set();
  for (const f of taken) { if (!facts['file:' + f.rel] || facts['file:' + f.rel].kind === 'test') continue; let src = ''; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; } let m; const re = /process\.env\.([A-Z][A-Z0-9_]{2,})|process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]|getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g; while ((m = re.exec(src))) envRead.add(m[1] || m[2] || m[3]); }
  if (exampleRel && envRead.size && R('env-example-incomplete')) {
    let ex = ''; try { ex = fs.readFileSync(exampleRel.abs, 'utf8'); } catch (e) { /* */ }
    const listed = new Set((ex.match(/^\s*([A-Z][A-Z0-9_]{2,})\s*=/gm) || []).map((l) => l.trim().split('=')[0].trim()));
    const missing = [...envRead].filter((k) => !listed.has(k) && !/^(NODE_ENV|HOME|PATH|PWD|TEMP|TMP|USERPROFILE|CI|PORT|DEBUG|TZ)$/.test(k)).sort();
    if (missing.length) problem(ensureFile('.env.example', 'config'), 'env-example-incomplete', missing.length + ' variable' + (missing.length === 1 ? '' : 's') + ' the code reads and the example does not list: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : ''));
  }
  // a migration edited after the one following it existed
  if (isRepo && R('migration-edited-after-run')) {
    const migs = taken.filter((f) => /migrations?\//i.test(f.rel) && /\.sql$/i.test(f.name) && !/\.down\.sql$/i.test(f.name)).map((f) => f.rel).sort();
    for (let i = 0; i < migs.length - 1; i++) {
      const later = git('log -1 --format=%ct --diff-filter=A -- "' + migs[i + 1] + '"'), edits = git('log --format=%ct --diff-filter=M -- "' + migs[i] + '"');
      if (!later || !edits) continue; const laterAt = Number(later.trim()), editedAfter = edits.split('\n').map(Number).filter((t) => t && t > laterAt);
      if (editedAfter.length) problem('file:' + migs[i], 'migration-edited-after-run', 'changed ' + editedAfter.length + ' time' + (editedAfter.length === 1 ? '' : 's') + ' after the next migration existed - the copies that already ran it never see the change');
    }
  }
  // dependencies: the lockfile, npm audit, outdated majors (network calls; skipped quietly when npm is not there or offline)
  const pkgRel = files.find((f) => f.rel === 'package.json');
  if (pkgRel) {
    const pkgSubj = ensureFile('package.json', 'config');
    const hasLock = files.some((f) => /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f.rel));
    if (!hasLock && R('lockfile-missing')) problem(pkgSubj, 'lockfile-missing', 'no lockfile - installs are not reproducible');
    const npm = (args) => { try { return cpx.execSync('npm ' + args, { cwd: codeDir, encoding: 'utf8', timeout: 90000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e && e.stdout ? String(e.stdout) : null; } };
    if (R('vulnerable-dependency') && hasLock) {
      const usePnpm = files.some((f) => f.rel === 'pnpm-lock.yaml'); const out = usePnpm ? (() => { try { return cpx.execSync('pnpm audit --json --prod', { cwd: codeDir, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e && e.stdout ? String(e.stdout) : null; } })() : npm('audit --json --omit=dev'); let j = null; try { j = JSON.parse(out || ''); } catch (e) { /* offline, or not npm */ }
      const v = j && j.metadata && j.metadata.vulnerabilities; if (v) { const n = (v.critical || 0) + (v.high || 0) + (v.moderate || 0); if (n) problem(pkgSubj, 'vulnerable-dependency', n + ' known vulnerabilit' + (n === 1 ? 'y' : 'ies') + ' in production dependencies (' + (v.critical || 0) + ' critical, ' + (v.high || 0) + ' high, ' + (v.moderate || 0) + ' moderate) - npm audit'); yields.audit = v; }
      else say('npm audit: no reading (offline, or not an npm project)');
    }
    if (R('outdated-major')) {
      const out = npm('outdated --json'); let j = null; try { j = JSON.parse(out || '{}'); } catch (e) { /* */ }
      if (j) { const majors = Object.entries(j).filter(([k, x]) => x.current && x.latest && x.current.split('.')[0] !== x.latest.split('.')[0]); if (majors.length) problem(pkgSubj, 'outdated-major', majors.length + ' dependenc' + (majors.length === 1 ? 'y' : 'ies') + ' a major version behind: ' + majors.slice(0, 6).map(([k, x]) => k + ' ' + x.current + ' → ' + x.latest).join(', ') + (majors.length > 6 ? ' …' : '')); }
    }
  }
  // lint: the project's own eslint, when it has one; its report per file
  if (R('lint-error') || R('lint-warning')) {
    const eslintBin = path.join(projectDir, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint');
    const hasConfig = files.some((f) => /^(\.eslintrc(\.[a-z]+)?|eslint\.config\.[cm]?[jt]s)$/.test(f.rel));
    if (fs.existsSync(eslintBin) && hasConfig) {
      let out = null; try { out = cpx.execSync('"' + eslintBin + '" . -f json --no-error-on-unmatched-pattern', { cwd: codeDir, encoding: 'utf8', timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch (e) { out = e && e.stdout ? String(e.stdout) : null; }
      let rep2 = null; try { rep2 = JSON.parse(out || ''); } catch (e) { say('eslint: no report'); ['lint-error', 'lint-warning'].forEach((r) => unchecked(r, 'eslint ran but gave no report')); }
      if (Array.isArray(rep2)) { let files2 = 0; for (const r of rep2) { const rel = path.relative(codeDir, r.filePath).replace(/\\/g, '/'); const subj = 'file:' + rel; if (!facts[subj]) continue; if (r.errorCount && R('lint-error')) { problem(subj, 'lint-error', r.errorCount + ' lint error' + (r.errorCount === 1 ? '' : 's') + ': ' + [...new Set(r.messages.filter((m) => m.severity === 2).map((m) => m.ruleId))].slice(0, 4).join(', ')); files2++; } else if (r.warningCount >= 5 && R('lint-warning')) problem(subj, 'lint-warning', r.warningCount + ' lint warnings'); } say('eslint: ' + rep2.length + ' files linted, ' + files2 + ' with errors'); yields.lint = rep2.length; }
    } else {
      /* no root eslint: the project's CI lint job on main answers for lint errors (engine/tests.js ciLint, 2026-10-03) - one
         reading for the site, no per-file detail, so lint-warning stays unchecked unless the project switches it off */
      let ci = null; try { ci = JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'tests', 'ci-lint.json'), 'utf8')); } catch (e) { /* never read */ }
      const fresh = ci && Date.now() - Date.parse(ci.runAt || ci.at) < 7 * 86400000;
      if (fresh) {
        yields.lint = 'CI ' + ci.job + ': ' + ci.conclusion + ' @ ' + String(ci.sha).slice(0, 7);
        say('lint: from CI - ' + yields.lint);
        if (!ci.ok && R('lint-error')) problem(SITE, 'lint-error', 'the CI ' + ci.job + ' job on main is ' + ci.conclusion + ' (' + ci.workflow + ' run ' + ci.run + ', ' + String(ci.sha).slice(0, 7) + ')');
        unchecked('lint-warning', 'judged by CI: the ' + ci.job + ' job reports pass / fail only, not per-file warnings');
      } else { say('lint: no eslint in this project (node_modules/.bin/eslint + a config) - skipped'); ['lint-error', 'lint-warning'].forEach((r) => unchecked(r, 'no eslint at the project root (node_modules/.bin/eslint + a root config) and no recent CI lint reading - lint did not run')); }
    }
  }
  if (R('format-prettier')) {
    const prettierBin = path.join(projectDir, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
    /* FORMATTING COUNTS ONLY WHERE THE PROJECT ENFORCES IT (a large monorepo'smap showed 1,212 "format" findings - true, but
       that project has only a manual `format` script and no check in CI, so style drift buried the real findings). The formatter runs when
       a config exists AND something enforces it: a CI workflow, a check script, or lint-staged. */
    const cfgExists = files.some((f) => /^(\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?js)$/.test(f.rel)) || (() => { try { return !!JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8')).prettier; } catch (e) { return false; } })();
    const enforced = (() => {
      try { const pkg = JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8')); if (Object.values(pkg.scripts || {}).some((v) => /prettier\s+(--check|-c\b|--list-different|-l\b)/.test(v)) || pkg['lint-staged'] || fs.existsSync(path.join(codeDir, '.lintstagedrc'))) return true; } catch (e) { /* no package.json */ }
      const wf = path.join(codeDir, '.github', 'workflows'); try { return fs.readdirSync(wf).some((f) => /prettier\s+(--check|-c\b|--list-different)|format:check/.test(fs.readFileSync(path.join(wf, f), 'utf8'))); } catch (e) { return false; }
    })();
    const hasCfg = cfgExists && enforced;
    if (cfgExists && !enforced) yields.formatter = 'not enforced by the project - not reported';
    if (fs.existsSync(prettierBin) && hasCfg) {
      let out = ''; try { cpx.execSync('"' + prettierBin + '" --list-different .', { cwd: codeDir, encoding: 'utf8', timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch (e) { out = String(e.stdout || ''); }   // exit 1 = files differ, listed on stdout
      let n = 0; for (const line of out.split('\n')) { const rel = line.trim().replace(/\\/g, '/'); if (rel && facts['file:' + rel]) { problem('file:' + rel, 'format-prettier', 'prettier --check would rewrite it - the project\'s own formatting config is not applied here'); n++; } }
      say('prettier: ' + n + ' file' + (n === 1 ? '' : 's') + ' differ');
    } else unchecked('format-prettier', !cfgExists ? 'no prettier config - the formatter did not run' : !enforced ? 'the project does not enforce prettier (no check in CI or scripts) - not run on purpose' : 'no prettier in node_modules/.bin - the formatter did not run');
  }
}

/* ---------- the risk matrix's inputs ---------- */
{
  // sensitivity on every table the scanner has not already marked (the TypeScript scanner marks by its own list first)
  const marked = new Set(tags.filter((t) => t[1] === 'sensitivity').map((t) => t[0] + '|' + t[2]));
  for (const ts of tableSubjects) for (const v of sensitivityOf(ts.slice(6))) if (!marked.has(ts + '|' + v)) { marked.add(ts + '|' + v); tags.push([ts, 'sensitivity', v, 'table or column names']); }
  // files and routes inherit the marks of the tables they read or write
  const sensOf = {}; tags.forEach((t) => { if (t[1] === 'sensitivity' && t[0].startsWith('table:')) (sensOf[t[0]] = sensOf[t[0]] || new Set()).add(t[2]); });
  for (const e of edges) if ((e[2] === 'reads' || e[2] === 'writes') && sensOf[e[1]]) for (const v of sensOf[e[1]]) if (!marked.has(e[0] + '|' + v)) { marked.add(e[0] + '|' + v); tags.push([e[0], 'sensitivity', v, 'reaches ' + e[1].slice(6)]); }
  SENSITIVE.forEach((r) => { if (!EXTRA.tm.some((t) => t[0] === 'sensitivity' && t[1] === r.value)) EXTRA.tm.push(['sensitivity', r.value, r.band, r.label, r.band === 'info' ? 'worth knowing, not itself a risk' : 'reachable from here']); });
  if (!EXTRA.ns.some((n) => n[0] === 'sensitivity')) EXTRA.ns.push(['sensitivity', 'Sensitive data', 'Where money, personal data and credentials can be reached from - found from table and column names.', 1]);

  // churn: how many times each file changed in the last 90 days (one git call; none if not a repo)
  const churn = {};
  try {
    const out = require('node:child_process').execSync('git log --since=90.days --name-only --pretty=format:', { cwd: codeDir, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    out.split('\n').forEach((l) => { l = l.trim(); if (l) churn[l] = (churn[l] || 0) + 1; });
  } catch (e) { say('churn: no git history read (' + String(e.message).split('\n')[0].slice(0, 80) + ')'); }
  // tested: a test file names the file (its basename without extension) somewhere in its source - and, once a run exists,
  // only a test that PASSED in the last run counts (Phase 3: the runner writes .cockpit/tests/latest.json)
  let lastRun = null; try { lastRun = JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'tests', 'latest.json'), 'utf8')); } catch (e) { /* no run yet */ }
  const runResult = {}; if (lastRun) for (const r of lastRun.files || []) runResult[r.file] = r.skipped ? null : !!r.ok;
  const testPassed = (rel) => !lastRun ? true : runResult[rel] !== false;   // no run yet: naming counts; a run: a failing or missing test proves nothing
  const testSrc = []; for (const f of taken) if (facts['file:' + f.rel] && facts['file:' + f.rel].kind === 'test') { if (lastRun && runResult[f.rel] === false) { tags.push(['file:' + f.rel, 'testrun', 'fail', 'failed in the last run ' + String(lastRun.at).slice(0, 16)]); if (R('test-failing')) problem('file:' + f.rel, 'test-failing', 'failed in the last run (' + String(lastRun.at).slice(0, 16).replace('T', ' ') + ') - cli tests --failures for its output'); continue; } if (lastRun && runResult[f.rel] === true) tags.push(['file:' + f.rel, 'testrun', 'pass', 'passed in the last run ' + String(lastRun.at).slice(0, 16)]); if (lastRun && runResult[f.rel] === null) tags.push(['file:' + f.rel, 'testrun', 'skipped', 'not run by Cockpit\'s runner (needs the project\'s runner)']); try { testSrc.push(fs.readFileSync(f.abs, 'utf8')); } catch (e) { /* skip */ } }
  yields.testRun = lastRun ? lastRun.summary : null;
  // the auth probe and the API contract from the last run (the app-start stages)
  if (lastRun && lastRun.probe && lastRun.probe.results) {
    for (const p of lastRun.probe.results) { if (!nodes.some((n) => n.subject === p.route)) continue; tags.push([p.route, 'probe', p.verdict, p.method + ' ' + p.path + ' → ' + p.status + ' unauthenticated']); if (p.verdict === 'open' && !lastRun.probe.noAuthAtAll && R('door-open')) problem(p.route, 'door-open', 'answered an unauthenticated ' + p.method + ' with ' + p.status + ' and is not declared public (## Tests public: …, or @auth none)'); }
    EXTRA.ns.push(['probe', 'Auth probe', 'What each door did when hit unauthenticated in the last test run: refused (401/403/redirect), open (2xx, not declared public), public (2xx, declared), not found, error.', 1]);
    EXTRA.tm.push(['probe', 'refused', 'ok', 'refused', ''], ['probe', 'public', 'ok', 'public', 'declared public'], ['probe', 'open', 'bad', 'open', 'answers without a login and is not declared public'], ['probe', 'not-found', 'info', 'not found', ''], ['probe', 'other', 'info', 'other', ''], ['probe', 'error', 'warn', 'error', 'the request failed']);
    yields.probe = { routes: lastRun.probe.routes, refused: lastRun.probe.refused, open: lastRun.probe.open };
  }
  // the signed-in pass (## Tests login: / user:): what each door did for the test user
  if (lastRun && lastRun.signedIn && !lastRun.signedIn.skipped) {
    const si = lastRun.signedIn;
    if (!si.ok) { yields.signedIn = { ok: false }; if (R('login-failed')) problem(SITE, 'login-failed', si.why || 'the sign-in under ## Tests did not work - every door behind the login went unprobed'); }
    else {
      yields.signedIn = { ok: true, answer: si.probe.ok, refuse: si.probe.refused };
      const nobody = {}; if (lastRun.probe && lastRun.probe.results) for (const p of lastRun.probe.results) nobody[p.route] = p.verdict;
      for (const p of si.probe.results) { if (!nodes.some((n) => n.subject === p.route)) continue; tags.push([p.route, 'signed-in', p.verdict, p.method + ' ' + p.path + ' → ' + p.status + ' as the test user']); if (p.verdict === 'refused' && nobody[p.route] === 'refused' && R('door-refuses-user')) problem(p.route, 'door-refuses-user', 'refuses the test user too (' + p.status + ') - role-bound, or the login does not reach it; if a plain user should get in, this is a break'); }
      EXTRA.ns.push(['signed-in', 'Signed in', 'What each door did for the TEST USER in the last run (## Tests login: / user:): ok, refused (a role the test user lacks - or a broken door), not found, error.', 1]);
      EXTRA.tm.push(['signed-in', 'ok', 'ok', 'answers', ''], ['signed-in', 'refused', 'warn', 'refused', 'even signed in'], ['signed-in', 'not-found', 'info', 'not found', ''], ['signed-in', 'redirect', 'info', 'redirect', 'sends elsewhere, not to a sign-in'], ['signed-in', 'other', 'info', 'other', ''], ['signed-in', 'error', 'warn', 'error', '']);
    }
  }
  // a migration with no way back
  for (const f of taken) if (/(^|\/)db\/migrations\/[^/]+\.sql$/i.test(f.rel) && !/\.down\.sql$/i.test(f.name) && !fs.existsSync(f.abs.replace(/\.sql$/i, '.down.sql')) && R('migration-irreversible')) problem('file:' + f.rel, 'migration-irreversible', 'no .down.sql beside it - a migration is a change that can come back; the promote script cannot restore without it');
  if (lastRun && lastRun.setup && lastRun.setup.ok === false && /cycle|down\.sql/i.test(lastRun.setup.tail || '') && R('migration-cycle-failed')) problem('folder:db/migrations', 'migration-cycle-failed', 'the up-down-up cycle on the test database failed in the last run: ' + String(lastRun.setup.tail || '').split('\n').filter(Boolean).slice(-1)[0]);
  // the restore drill from the last run, and the real backup folder (## Backup folder: / every:)
  // a project with no database has nothing to back up: the checks below want a DB_NAME-like key in .env.example, or a table on the map
  const hasDb = nodes.some((n) => n.kind === 'table') || (() => { try { return /^\s*(DB_NAME|DATABASE_NAME|MYSQL_DATABASE|PGDATABASE|DATABASE_URL)\s*=/m.test(fs.readFileSync(path.join(projectDir, '.env.example'), 'utf8')); } catch (e) { return false; } })();
  if (lastRun && lastRun.restore && !lastRun.restore.skipped) { yields.restore = { ok: lastRun.restore.ok, tables: lastRun.restore.tables, rows: lastRun.restore.rows }; if (!lastRun.restore.ok && R('restore-failed')) problem(SITE, 'restore-failed', 'the backup → restore round trip on the test database failed' + (lastRun.restore.step ? ' at ' + lastRun.restore.step : '') + ': ' + (lastRun.restore.why || (lastRun.restore.diffs || []).slice(0, 3).join('; '))); }
  /* a production drill (## Backup drill:, with by: naming the managed database that keeps the real backups) is the backup's
     proof: the Tests tab's Backup line grades it (engine/verify.js) - here it only stops the "undeclared / unproven" findings
     (2026-09-30: a large monorepo'sdrill passed, 2485 tables, and the map still said no backup was declared) */
  const bkDecl = (() => { try { const md = fs.readFileSync(path.join(projectDir, '.cockpit', 'project.md'), 'utf8'); const sec = /^##\s+Backup\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md); return sec ? { by: /^\s*(?:-\s*)?by:\s*\S/im.test(sec[1]), drill: /^\s*(?:-\s*)?drill:\s*\S/im.test(sec[1]) } : {}; } catch (e) { return {}; } })();
  if (!(lastRun && lastRun.restore && !lastRun.restore.skipped) && hasDb && lastRun && lastRun.restore && lastRun.restore.skipped && !bkDecl.drill && R('restore-unproven')) problem(SITE, 'restore-unproven', lastRun.restore.why);
  { const bk = (() => { try { const md = fs.readFileSync(path.join(projectDir, '.cockpit', 'project.md'), 'utf8'); const sec = /^##\s+Backup\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md); const o = {}; if (sec) for (const k of ['folder', 'every']) { const m = new RegExp('^\\s*(?:-\\s*)?' + k + ':\\s*(.+)$', 'im').exec(sec[1]); if (m) o[k] = m[1].trim(); } return o; } catch (e) { return {}; } })();
    if (bk.folder) {
      let newest = 0, n = 0; try { for (const f of fs.readdirSync(bk.folder)) { const st = fs.statSync(path.join(bk.folder, f)); if (st.isFile()) { n++; if (st.mtimeMs > newest) newest = st.mtimeMs; } } } catch (e) { newest = -1; }
      const every = Number(bk.every) || 24, ageH = newest > 0 ? (Date.now() - newest) / 3600e3 : null;
      yields.backups = { folder: bk.folder, files: n, ageHours: ageH === null ? null : Math.round(ageH) };
      if (newest === -1 && R('backup-folder-missing')) problem(SITE, 'backup-folder-missing', bk.folder + ' cannot be read from here - the declared backup folder does not exist or this machine cannot see it');
      else if (!n && R('backup-none')) problem(SITE, 'backup-none', bk.folder + ' is empty - no backup has ever landed there');
      else if (ageH > every * 1.5 && R('backup-stale')) problem(SITE, 'backup-stale', 'the newest file in ' + bk.folder + ' is ' + Math.round(ageH) + ' h old; one is expected every ' + every + ' h - the job stopped');
    } else if (hasDb && !(bkDecl.by && bkDecl.drill) && R('backup-undeclared')) problem(SITE, 'backup-undeclared', 'no folder: under ## Backup in project.md - Cockpit cannot see whether backups are landing');
  }
  // the last promote's smoke (scripts/promote.js writes it into this checkout)
  let smoke = null; try { smoke = JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'tests', 'smoke.json'), 'utf8')); } catch (e) { /* never promoted through the script */ }
  if (smoke) { yields.smoke = { at: smoke.at, ok: smoke.ok, rolledBack: smoke.rolledBack, flows: smoke.smoke && smoke.smoke.flows ? smoke.smoke.flows.length : 0 }; if (!smoke.ok && R('smoke-failed')) problem(SITE, 'smoke-failed', 'the last promote (' + String(smoke.at).slice(0, 16).replace('T', ' ') + ') failed its smoke' + (smoke.rolledBack ? ' and was rolled back to ' + smoke.from : ' and could not be rolled back - prod needs a hand') + ': ' + ((smoke.smoke && smoke.smoke.why) || '')); }
  // the performance numbers from the last test run (tests.js perfStage)
  if (lastRun && lastRun.perf) {
    const pf = lastRun.perf; yields.perf = { p50: pf.p50, p95: pf.p95, slow: pf.slow.length, burstSlow: pf.burstSlow.length, regressed: pf.regressed.length, budget: pf.budget };
    for (const t of pf.slow) if (nodes.some((n) => n.subject === t.route) && R('slow-door')) problem(t.route, 'slow-door', t.ms + ' ms for one request, budget ' + pf.budget + ' ms');
    for (const b of pf.burstSlow) { const rn = nodes.find((n) => n.kind === 'route' && n.title === 'GET ' + b.path); if (rn && R('door-folds-under-load')) problem(rn.subject, 'door-folds-under-load', 'p95 ' + b.p95 + ' ms with 10 requests at once (budget ×3 = ' + pf.budget * 3 + ' ms)'); }
    for (const t of pf.regressed) if (nodes.some((n) => n.subject === t.route) && R('door-regressed')) problem(t.route, 'door-regressed', t.ms + ' ms, was ' + t.prev + ' ms last run');
  }
  // the input probe from the last test run (engine/fuzz.js): how each door reacted to hostile input
  if (lastRun && lastRun.fuzz && lastRun.fuzz.findings) {
    yields.fuzz = { routes: lastRun.fuzz.routes, refused: lastRun.fuzz.refused, findings: lastRun.fuzz.findings.length };
    const RULE = { crash: 'input-crash', leak: 'input-leak', reflected: 'input-reflected', slow: 'input-slow' };
    /* a 503 that SAYS why - a JSON error naming a switched-off or unconfigured feature ({"error":"billing_not_configured"},
       "briefing_disabled") - is the door refusing honestly, not falling over (2026-09-30: 5 of a large monorepo's8 "crashes") */
    const honest503 = (f) => Number(f.status) === 503 && /"(error|message)"\s*:\s*"[^"]*(disabled|not[ _]configured|off|unavailable|not enabled)/i.test(String(f.evidence || ''));
    for (const f of lastRun.fuzz.findings) { const rule = RULE[f.kind]; if (!rule || !R(rule) || !nodes.some((n) => n.subject === f.route)) continue; if (f.kind === 'crash' && honest503(f)) continue; problem(f.route, rule, ({ crash: 'answered ' + f.status, leak: 'the answer shows how the door is built', reflected: 'the payload came back unescaped in HTML', slow: 'took ' + f.ms + ' ms' })[f.kind] + ' on the ' + f.payload + ' payload in the ' + f.where + (f.also ? ' (+' + f.also + ' more payload' + (f.also === 1 ? '' : 's') + ')' : '') + (f.evidence && f.kind !== 'slow' ? ': ' + f.evidence.slice(0, 160) : '')); }
  }
  // the last SAST run (engine/sast.js: semgrep from tools\semgrep, the rule packs beside it) - one problem per finding, on its file
  let sastRun = null; try { sastRun = JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'tests', 'sast.json'), 'utf8')); } catch (e) { /* never run */ }
  if (sastRun) {
    yields.sast = { at: sastRun.at, ok: sastRun.ok, findings: (sastRun.findings || []).length, summary: sastRun.summary };
    if (!sastRun.ok && R('sast-failed')) problem(SITE, 'sast-failed', 'the last SAST run (' + String(sastRun.at).slice(0, 16).replace('T', ' ') + ') did not run: ' + (sastRun.why || ''));
    if (!sastRun.ok) Object.keys(RULES).filter((r) => /^sast-/.test(r) && r !== 'sast-failed').forEach((r) => unchecked(r, 'semgrep did not run in the last test run: ' + String(sastRun.why || '').split('\n').pop().slice(0, 160)));
    // one line per kind of flaw (the rule's vulnerability_class), the way the tab's own checks are lines - not by severity
    const CLASS = { 'Cross-Site-Scripting (XSS)': 'sast-xss', 'SQL Injection': 'sast-sql-injection', 'Command Injection': 'sast-command-injection', 'Code Injection': 'sast-code-injection', 'Hard-coded Secrets': 'sast-secrets', 'Cryptographic Issues': 'sast-crypto', 'Insecure Hashing Algorithm': 'sast-crypto', 'Mishandled Sensitive Information': 'sast-sensitive-info', 'Improper Authentication': 'sast-authentication', 'Improper Authorization': 'sast-authorization', 'Server-Side Request Forgery (SSRF)': 'sast-ssrf', 'XML Injection': 'sast-xml-injection', 'Cookie Security': 'sast-cookie', 'Improper Validation': 'sast-validation', 'Improper Encoding': 'sast-validation', 'Insecure Deserialization': 'sast-deserialization', 'Path Traversal': 'sast-path-traversal', 'Open Redirect': 'sast-open-redirect', 'Cross-Site Request Forgery (CSRF)': 'sast-csrf' };
    for (const f of sastRun.findings || []) {
      const cls = (f.classes || []).map((c) => CLASS[String(c).trim()]).find(Boolean) || 'sast-other'; if (!R(cls)) continue;
      const n = nodes.find((x) => x.file === f.file); if (!n) continue;
      problem(n.subject, cls, f.rule + ' (semgrep, ' + f.severity + ') at line ' + f.line + ': ' + f.message + (f.cwe ? ' · ' + f.cwe : ''));
    }
  } else Object.keys(RULES).filter((r) => /^sast-/.test(r) && r !== 'sast-failed').forEach((r) => unchecked(r, 'semgrep has not run on this project yet (it runs in every full test run)'));
  // the last DAST run (engine/dast.js: ZAP against the app on the test database) - grouped by alert, worst first
  let dastRun = null; try { dastRun = JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'tests', 'dast.json'), 'utf8')); } catch (e) { /* never run */ }
  if (dastRun) {
    yields.dast = { at: dastRun.at, ok: dastRun.ok, summary: dastRun.summary, alerts: (dastRun.alerts || []).length, partial: !!(dastRun.active && dastRun.active.partial) };
    const byName = {};
    for (const a of dastRun.alerts || []) { const k = a.risk + '|' + a.name; (byName[k] = byName[k] || { risk: a.risk, name: a.name, urls: new Set(), params: new Set(), solution: a.solution, cwe: a.cwe, evidence: a.evidence }).urls.add((a.method || 'GET') + ' ' + (a.url || '/').split('?')[0]); if (a.param) byName[k].params.add(a.param); }
    for (const g of Object.values(byName)) {
      const rule = g.risk === 'High' ? 'dast-high' : g.risk === 'Medium' ? 'dast-medium' : g.risk === 'Low' ? 'dast-low' : null; if (!rule || !R(rule)) continue;
      const urls = [...g.urls].slice(0, 12);
      // on the route when one matches the first URL exactly, else on the site
      // on every door the alert names (up to 6); on the site when none of its urls is a door the map knows
      const doors = [...g.urls].map((u) => nodes.find((n) => n.kind === 'route' && n.title === u)).filter(Boolean).slice(0, 6);
      const targets = doors.length ? doors.map((n) => n.subject) : [SITE];
      for (const target of targets)
      problem(target, rule, g.name + ' (ZAP, ' + g.risk + ')' + (g.params.size ? ' via ' + [...g.params].slice(0, 5).join(', ') : '') + ' on ' + g.urls.size + ' url' + (g.urls.size === 1 ? '' : 's') + ': ' + urls.join(', ') + (g.urls.size > urls.length ? ' …' : '') + (g.cwe ? ' · CWE-' + g.cwe : '') + (g.solution ? ' · fix: ' + g.solution.replace(/<[^>]+>/g, '').slice(0, 220) : ''));
    }
    if (!dastRun.ok && R('dast-failed')) problem(SITE, 'dast-failed', 'the last DAST run (' + String(dastRun.at).slice(0, 16).replace('T', ' ') + ') did not finish: ' + (dastRun.why || ''));
  }
  if (lastRun && lastRun.contract) { for (const b of lastRun.contract.breaks || []) if (nodes.some((n) => n.subject === b.route) && R('contract-break')) problem(b.route, 'contract-break', 'the response changed against the recorded contract: ' + b.changes.join('; ')); yields.contract = { checked: lastRun.contract.checked, breaks: (lastRun.contract.breaks || []).length }; }
  const joinedTests = testSrc.join('\n');
  for (const f of taken) {
    const subj = 'file:' + f.rel; if (!facts[subj]) continue;
    const n = churn[f.rel] || 0; tags.push([subj, 'churn', n === 0 ? 'still' : n < 3 ? 'some' : n < 8 ? 'busy' : 'hot', n + ' change' + (n === 1 ? '' : 's') + ' in 90 days']);
    if (facts[subj].kind !== 'test') { const base = f.name.replace(/\.[^.]+$/, ''); const tested = base.length > 2 && joinedTests.indexOf(base) >= 0; tags.push([subj, 'tested', tested ? 'yes' : 'no', tested ? (lastRun ? 'a passing test names it' : 'a test names it (no run yet)') : 'no passing test names it']); }
  }
  EXTRA.ns.push(['ticket', 'Tickets', 'Which ticket each thing is in - set by Cockpit when a ticket is filed with that file in scope; it survives rescans. Things with a finding and no ticket are the backlog.', 0]);
  EXTRA.ns.push(['churn', 'Churn', 'How often each file changed in the last 90 days (git). Code that moves is code that breaks.', 0]);
  EXTRA.tm.push(['churn', 'hot', 'info', 'hot (8+)', ''], ['churn', 'busy', 'info', 'busy (3-7)', ''], ['churn', 'some', 'info', 'some (1-2)', ''], ['churn', 'still', 'info', 'still', 'unchanged in 90 days']);
  EXTRA.tm.push(['testrun', 'pass', 'ok', 'passed', 'passed in the last run'], ['testrun', 'fail', 'bad', 'failed', 'failed in the last run'], ['testrun', 'skipped', 'info', 'not run', 'needs the project\'s runner']);
  EXTRA.ns.push(['testrun', 'Last test run', 'How each test file did in Cockpit\'s last run (cli tests --run / /tests run).', 1]);
  EXTRA.ns.push(['tested', 'Test coverage', 'What automated testing is missing. A file counts as tested when a test that PASSED in the last run names it (before any run: when a test names it); untested actions and logic are the gaps to close - a door nobody tests is a door that breaks unseen. Crude and honest: a name in a test is not full coverage, but no name at all is no test. A feature box goes amber the moment anything inside it is untested; hover for the count.', 1]);
  EXTRA.tm.push(['tested', 'yes', 'ok', 'tested', 'a test file names it'], ['tested', 'no', 'warn', 'untested', 'no test names it - a gap for automated testing'], ['tested', 'skipped', 'info', 'skipped', 'its test passed but skipped part of it, with a reason - not proven']);

  // impact per node: 1-5 from reach (transitive dependents), exposure, sensitivity, writes, guard
  const depsOf = {}; edges.forEach((e) => { if (/^(import|include|calls|script|link|fetch|form)$/.test(e[2])) (depsOf[e[1]] = depsOf[e[1]] || []).push(e[0]); });
  const reachCount = (start) => { const seen = new Set([start]); const q = [start]; while (q.length) { const x = q.pop(); for (const d of depsOf[x] || []) if (!seen.has(d)) { seen.add(d); q.push(d); } } return seen.size - 1; };
  const reachOf = {}; nodes.forEach((n) => { if (n.kind === 'file' || n.kind === 'table' || n.kind === 'route') reachOf[n.subject] = reachCount(n.subject); });
  const sorted = Object.values(reachOf).sort((a, b) => b - a); const top5 = sorted[Math.floor(sorted.length * 0.05)] || 0, top20 = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const live = new Set(tags.filter((t) => t[1] === 'reach' && (t[2] === 'entry-point' || t[2] === 'reached' || t[2] === 'widely-used')).map((t) => t[0]));
  const sensitive = new Set(tags.filter((t) => t[1] === 'sensitivity' && t[2] !== 'audit').map((t) => t[0]));
  const writer = new Set(edges.filter((e) => e[2] === 'writes').map((e) => e[0]));
  const unguarded = new Set(tags.filter((t) => t[1] === 'rbac' && t[2] === 'no-permission-check').map((t) => t[0]));
  const IMPACT_LABEL = { 5: 'critical', 4: 'high', 3: 'medium', 2: 'low', 1: 'minimal' };
  for (const n of nodes) {
    if (!(n.subject in reachOf)) continue;
    const why = []; let sc = 1; const r = reachOf[n.subject];
    if (r >= top5 && r > 0) { sc += 2; why.push(r + ' things depend on it (top 5%)'); } else if (r >= top20 && r > 0) { sc += 1; why.push(r + ' things depend on it (top 20%)'); }
    if (n.kind === 'table' ? true : live.has(n.subject)) { sc += 1; why.push(n.kind === 'table' ? 'data' : 'on a live path'); }
    if (sensitive.has(n.subject)) { sc += 1; why.push('touches money, personal data or credentials'); }
    if (writer.has(n.subject) || (n.kind === 'table' && edges.some((e) => e[1] === n.subject && e[2] === 'writes'))) { sc += 1; why.push('writes data'); }
    if (unguarded.has(n.subject)) { sc += 1; why.push('no permission check'); }
    sc = Math.max(1, Math.min(5, sc));
    tags.push([n.subject, 'impact', String(sc), why.join('; ') || 'reaches little, on no live path']);
  }
  EXTRA.ns.push(['impact', 'Impact', 'What breaks if this bites: 1-5 from how much depends on it, whether a person can reach it, whether it touches sensitive data, whether it writes, and (routes) whether it is guarded.', 1]);
  EXTRA.tm.push(['impact', '5', 'bad', 'critical', ''], ['impact', '4', 'bad', 'high', ''], ['impact', '3', 'warn', 'medium', ''], ['impact', '2', 'info', 'low', ''], ['impact', '1', 'info', 'minimal', '']);

}

/* ---------- declarations applied: precedence, the declared lens, owned tables, flows ---------- */
const DECLARED_LAYER = {};   // subject -> layer from a declared kind, read by the shape block below
{
  const LAYER_OF_KIND = { screen: 'screens', action: 'actions', logic: 'logic', data: 'data', test: 'outside', tool: 'outside' };
  const dropTag = (subject, ns) => { for (let i = tags.length - 1; i >= 0; i--) if (tags[i][0] === subject && tags[i][1] === ns) tags.splice(i, 1); };
  const inferredDomain = {}; tags.forEach((t) => { if (t[1] === 'domain') inferredDomain[t[0]] = t[2]; });
  yields.declared = 0; yields.mapped = 0; yields.inferred = 0; yields.untagged = 0;
  /* a route takes its file's declared feature too (2026-10-04: agent-chat/chat.ts says @feature agent, but its route
     POST /agents/:id/chat kept the path rule's "comms" and read as a cross-feature write of agent_conversations) */
  const routesOf = {}; for (const e of edges) if (e[2] === 'declares' && String(e[1]).startsWith('route:')) (routesOf[e[0]] = routesOf[e[0]] || []).push(e[1]);
  for (const f of taken) {
    const subj = 'file:' + f.rel; if (!facts[subj]) continue;
    const d = DECL.files[f.rel];
    if (d && d.feature) {
      const feat = String(d.feature).toLowerCase();
      if (inferredDomain[subj] !== feat) { dropTag(subj, 'domain'); tags.push([subj, 'domain', feat, d.source === 'declared' ? 'declared in the file header' : 'the mapping file']); }
      for (const rs of routesOf[subj] || []) if (inferredDomain[rs] !== feat) { dropTag(rs, 'domain'); tags.push([rs, 'domain', feat, 'its file declares ' + feat]); }
      tags.push([subj, 'declared', d.source, d.source === 'declared' ? '@feature in the header' : 'an entry in the mapping file']); yields[d.source]++;
    } else if (inferredDomain[subj] && inferredDomain[subj] !== 'unsorted') { tags.push([subj, 'declared', 'inferred', 'placed by the project\'s path rules']); yields.inferred++; }
    else { tags.push([subj, 'declared', 'untagged', 'no header, no mapping entry, no rule places it']); yields.untagged++; }
    if (d && d.kind && KIND_VALUES.has(normKind(d.kind))) DECLARED_LAYER[subj] = LAYER_OF_KIND[normKind(d.kind)];
    if (d && d.purpose) tags.push([subj, 'purpose', 'yes', String(d.purpose).slice(0, 300)]);
  }
  // owned tables: the README / mapping says whose they are
  for (const [name, Fd] of Object.entries(DECL.features)) for (const t of Fd.tables || []) { const ts = 'table:' + t; if (!tableSubjects.has(ts)) continue; dropTag(ts, 'domain'); tags.push([ts, 'domain', name, (Fd.source === 'declared' ? 'the feature README' : 'the mapping file') + ' lists it']); }
  // flows: nodes, with the screens, actions and tests that name them
  const flowSubj = (feat, name) => 'flow:' + feat + '/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const flowsOf = {}; let nFlows = 0;
  for (const [name, Fd] of Object.entries(DECL.features)) for (const fl of Fd.flows || []) { const fs2 = flowSubj(name, fl.name); flowsOf[fl.name.toLowerCase()] = flowsOf[fl.name.toLowerCase()] || []; flowsOf[fl.name.toLowerCase()].push({ subject: fs2, feature: name, steps: fl.steps || [] }); if (!nodes.some((n) => n.subject === fs2)) { if (!nFlows) nodes.push({ subject: 'flows:all', kind: 'folder', parent: SITE, title: 'flows', file: null, size: 1 }); nodes.push({ subject: fs2, kind: 'flow', parent: 'flows:all', title: fl.name, file: null, size: Math.max(1, (fl.steps || []).length) }); tags.push([fs2, 'kind', 'flow'], [fs2, 'domain', name, 'defined in the feature']); nFlows++; } }
  yields.flows = nFlows;
  const namesFlow = {};   // flow subject -> { screens: [], tests: [] }
  const skippedOf = {};   // test file -> what it skipped and why, when it passed with a part not run (engine/tests.js skippedParts)
  /* its own read of the last run: `lastRun` above lives in another block (2026-10-02: referencing it here crashed EVERY
     scan from 2026-09-30 21:07 UTC - "lastRun is not defined" - and froze the map and the Tests tab's Flows line) */
  try { const lr = JSON.parse(fs.readFileSync(path.join(projectDir, '.cockpit', 'tests', 'latest.json'), 'utf8')); for (const r of lr.files || []) if (r.ok && Array.isArray(r.skippedParts) && r.skippedParts.length) skippedOf['file:' + r.file] = r.skippedParts; } catch (e) { /* no run yet */ }   // keyed like nf.tests ('file:<rel>') - keyed by the bare path, no flow ever went grey (2026-10-02)
  for (const f of taken) {
    const subj = 'file:' + f.rel; const d = DECL.files[f.rel]; if (!d || !d.flow || !d.flow.length) continue;
    const myFeat = (tags.find((t) => t[0] === subj && t[1] === 'domain') || [])[2];
    const isTest = facts[subj] && facts[subj].kind === 'test';
    for (const fname of d.flow) {
      if (/^none$/i.test(fname)) continue;   // "@flow none" is the documented way to say a file serves no flow (six tests read as unknown flows)
      const cands = flowsOf[fname.toLowerCase()] || [];
      const hit = cands.find((c) => c.feature === myFeat) || cands[0];
      if (!hit) { tags.push([subj, 'problem', isTest ? 'test-names-unknown-flow' : 'flow-not-in-feature', 'names flow "' + fname + '"' + (cands.length ? ', which belongs to ' + cands.map((c) => c.feature).join(', ') : ', which no README or mapping defines')]); yields.problems++; continue; }
      if (!isTest && hit.feature !== myFeat && myFeat) { tags.push([subj, 'problem', 'flow-not-in-feature', 'names flow "' + fname + '" of ' + hit.feature + ' from ' + myFeat]); yields.problems++; }
      edges.push([subj, hit.subject, isTest ? 'proves' : 'part-of']);
      const nf = namesFlow[hit.subject] = namesFlow[hit.subject] || { screens: [], tests: [] }; (isTest ? nf.tests : nf.screens).push(subj);
      if (isTest && typeof lastRunOK === 'function' && !lastRunOK(f.rel)) nf.failed = (nf.failed || []).concat(subj);
    }
  }
  // steps that name nothing: a step matches a screen's title / URL or a route's path, loosely
  // what a step can name: a route's path, a page's URL, a screen file's path - compared with everything but letters and digits removed, on both sides
  const pageUrl = {}; tags.forEach((t) => { if (t[1] === 'page') pageUrl[t[0]] = t[2]; });
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const titles = nodes.filter((n) => n.kind === 'route' || (n.kind === 'file' && facts[n.subject] && /page|component/.test(facts[n.subject].kind))).map((n) => norm((n.title || '') + ' ' + (pageUrl[n.subject] || '') + ' ' + (n.file || '')));
  const screenFlow = {};   // a flow with at least one step on a screen or URL the map knows (flow-not-clicked below)
  for (const list of Object.values(flowsOf)) for (const fl of list) { for (const step of fl.steps) { if (/^(see|read|expect|check|confirm|verify|notice)\b/i.test(step.trim())) continue;   /* an outcome, not a place: the assertion the flow's test makes */ /* only a step that names a PLACE is judged: a path (/settings/team, POST /api/ship) or "open / go to / visit X". "switch to
       Roles tab", "click Create role", "enter a name" are what a person does on the screen they are on - the browser test proves
       those; judging them fired on 184 of a large monorepo's190 flows, including the ones with passing tests. */
    const pathIn = /(?:^|\s)(\/[A-Za-z0-9_\-/.:[\]{}]+)/.exec(step);
    if (!pathIn && !/^(open|go to|navigate to|visit|land on)\b/i.test(step.trim())) continue;
    const st = pathIn ? pathIn[1] : step.toLowerCase().replace(/^(open|go to|navigate to|visit|land on)\s+(the\s+|a\s+|an\s+)?/, ''); const words = pathIn ? [norm(st)].filter(Boolean) : st.split(/\s+/).map(norm).filter((w) => w.length > 2); if (!words.length) continue; const found = titles.some((t) => words.every((w) => t.indexOf(w) >= 0)); if (found) (screenFlow[fl.subject] = true); if (!found && R('flow-step-missing')) { problem(fl.subject, 'flow-step-missing', 'step "' + step + '" names no screen or action the scan can find'); } }
    const nf = namesFlow[fl.subject] || { screens: [], tests: [] };
    const passing = nf.tests.filter((t) => !(nf.failed || []).includes(t));
    /* a test that passed with a part SKIPPED proves only what it ran: the flow is grey - "skipped", with
       the test's own reason - never green, and never red: nothing failed */
    const proving = passing.filter((t) => !skippedOf[t]);
    const partial = passing.filter((t) => skippedOf[t]);
    if (!proving.length && partial.length) {
      tags.push([fl.subject, 'tested', 'skipped', 'not proven - skipped: ' + skippedOf[partial[0]].join('; ').slice(0, 220)]);
      if (R('flow-skipped')) problem(fl.subject, 'flow-skipped', 'its test skips part of it: ' + skippedOf[partial[0]].join('; ').slice(0, 200));
      continue;
    }
    tags.push([fl.subject, 'tested', proving.length ? 'yes' : 'no', proving.length ? proving.length + ' passing test' + (proving.length === 1 ? '' : 's') + ' prove' + (proving.length === 1 ? 's' : '') + ' it' : nf.tests.length ? 'its test failed in the last run' : 'no test names it']);
    if (!nf.tests.length && R('flow-without-test')) problem(fl.subject, 'flow-without-test', 'no test names this flow - it is unproven');
    if (nf.tests.length && !proving.length && R('flow-failing')) problem(fl.subject, 'flow-failing', 'its test failed in the last run - the flow is broken or the test is');
    // functional = clicked through: at least one of its tests is a browser flow (*.browser.test.js, engine/flow.js)
    /* A FLOW WITH NO SCREEN (2026-09-30: cicd/run-ci-locally, cicd/uat-smoke-gate - GitHub Actions and a terminal, nothing a browser can click) is proven by any test that names it; only a flow that walks a known screen must be clicked through */
    if (nf.tests.length && screenFlow[fl.subject] && !nf.tests.some((t) => /\.browser\.(test|spec)\.[cm]?js$/i.test(t)) && R('flow-not-clicked')) problem(fl.subject, 'flow-not-clicked', 'its test' + (nf.tests.length === 1 ? '' : 's') + ' call the pages but never click them - no *.browser.test.js names this flow');
  }
  EXTRA.ns.push(['declared', 'Declared', 'Where each file\'s architecture comes from: declared in its header, mapped in .cockpit/plugins/architecture.declared.json, inferred by the project\'s path rules, or untagged. The counts are the migration progress.', 0]);
  EXTRA.tm.push(['declared', 'declared', 'ok', 'declared', '@feature in the file header'], ['declared', 'mapped', 'info', 'mapped', 'an entry in the mapping file'], ['declared', 'inferred', 'info', 'inferred', 'placed by a path rule'], ['declared', 'untagged', 'warn', 'untagged', 'nothing says what it is for']);
}

/* ---------- the shape: Screens -> Actions -> Logic -> Data ---------- */
{
  const LAYER_OF = { page: 'screens', component: 'screens', route: 'actions', endpoint: 'actions', include: 'logic', worker: 'logic', service: 'logic', module: 'logic', script: 'outside', test: 'outside', style: 'screens', migration: 'data', sql: 'data', table: 'data', note: 'outside', file: 'logic' };
  const kindOf = {}; tags.forEach((t) => { if (t[1] === 'kind') kindOf[t[0]] = t[2]; });
  const domainOf = {}; tags.forEach((t) => { if (t[1] === 'domain' && t[2] !== 'unsorted') domainOf[t[0]] = t[2]; });
  const featureOfNode = (s) => domainOf[s] && !/^(none|shared|other|unsorted|-|\?)$/i.test(domainOf[s]) ? domainOf[s] : null;
  const layerOf = {}, observedLayer = {};
  for (const n of nodes) {
    if (n.kind === 'table') layerOf[n.subject] = 'data';
    else if (n.kind === 'route') layerOf[n.subject] = 'actions';
    else if (n.kind === 'file') { const k = kindOf[n.subject] || 'file'; layerOf[n.subject] = LAYER_OF[k] || 'logic'; if (k === 'script' && /(^|\/)(scripts?|bin|tools?|cli)\//i.test(n.file || '')) layerOf[n.subject] = 'outside'; }
    observedLayer[n.subject] = layerOf[n.subject];
    if (n.kind === 'file' && DECLARED_LAYER[n.subject]) layerOf[n.subject] = DECLARED_LAYER[n.subject];   // a declared kind wins; the observed one is checked against it below
    // a code file inside a feature that is none of the four by shape and says nothing by tag: the fallback put it in Logic, which hides it
    if (n.kind === 'file' && !DECLARED_LAYER[n.subject] && kindOf[n.subject] === 'module' && /\.([cm]?[jt]sx?|php|py)$/i.test(n.file || '') && featureOfNode(n.subject) && R('file-without-kind')) problem(n.subject, 'file-without-kind', 'not a screen, an action, logic or data by its shape, and no @kind says - it sits in Logic by default; say which it is');
    if (layerOf[n.subject]) tags.push([n.subject, 'layer', layerOf[n.subject], DECLARED_LAYER[n.subject] ? 'declared (@kind)' : 'from what it is (' + (n.kind === 'file' ? kindOf[n.subject] : n.kind) + ')']);
  }
  EXTRA.ns.push(['layer', 'Shape', 'The four kinds a feature is made of, and the one rule: every arrow goes ONE column to the right. Screens (what a person sees) → Actions (the routes a screen asks for) → Logic (the code that does it) → Data (the tables). A screen never touches a table, a door never queries, data never reaches back, one feature never writes another\'s table. Grey curves keep the rule; red dashed ones break it, and each red one is a finding on Problems.', 0]);
  EXTRA.tm.push(['layer', 'screens', 'info', 'Screens', 'what a person sees; asks, never touches data'], ['layer', 'actions', 'info', 'Actions', 'the routes: the single door into a feature'], ['layer', 'logic', 'info', 'Logic', 'the code that does the work; the only layer that reads and writes'], ['layer', 'data', 'info', 'Data', 'the tables, owned by one feature each'], ['layer', 'outside', 'info', 'Outside', 'tests, scripts, tooling - not part of any feature']);
  // the shape rules: each a Problems value (problems.json says on/off, band, weight); findings carry the arrow that broke it
  const declaredBy = {}; edges.forEach((e) => { if (e[2] === 'declares') declaredBy[e[1]] = e[0]; });
  const shapeHit = {};
  const shape = (subject, value, why) => { const k = subject + '|' + value; if (shapeHit[k]) return; shapeHit[k] = 1; problem(subject, value, why); };
  /* one write, one finding (2026-10-03): now that a route carries its own writes, a route's write is said on the route and
     its file is not said again for the same table - as owned-table-written-elsewhere already does */
  const routeWrote = new Set(); { const parentOf = {}; nodes.forEach((n) => { if (n.kind === 'route') parentOf[n.subject] = n.parent; }); edges.forEach((e) => { if (e[2] === 'writes' && String(e[0]).startsWith('route:') && parentOf[e[0]]) routeWrote.add(parentOf[e[0]] + '|' + e[1]); }); }
  for (const e of edges) {
    const [src, dst, kind] = e; const ls = layerOf[src], ld = layerOf[dst];
    if ((kind === 'reads' || kind === 'writes') && ls === 'screens' && R('screen-touches-data')) shape(src, 'screen-touches-data', kind + ' ' + dst.slice(6) + ' directly - a screen asks an action; it never touches a table');
    if ((kind === 'reads' || kind === 'writes') && ls === 'actions' && src.startsWith('file:') && R('sql-in-action')) shape(src, 'sql-in-action', kind + ' ' + dst.slice(6) + ' inside the door - the query belongs in logic, the route only checks who asks and hands off');
    /* not a cross-feature write (a large monorepo: 299 once files had features): a one-off script or a migration (maintenance,
       not a feature's behaviour), or either side being a SHARED feature - problems.json cross-feature-write.shared, default
       platform / shell / cicd / shared / core: shared infrastructure owns no product table and may be written through */
    const cfShared = new Set((RULES['cross-feature-write'] && RULES['cross-feature-write'].shared) || ['platform', 'shell', 'cicd', 'shared', 'core']);
    // + tests (2026-10-02 spot-check: 7 of a large monorepo's79 were test files writing the tables they set up)
    const cfSkip = /(^|\/)(scripts?|migrations?|seeds?|fixtures?|__tests__|tests?)\//i.test(src) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(src) || cfShared.has(domainOf[src]) || cfShared.has(domainOf[dst]) || (String(src).startsWith('file:') && routeWrote.has(src + '|' + dst));
    if (!cfSkip && kind === 'writes' && domainOf[src] && domainOf[dst] && domainOf[src] !== domainOf[dst] && R('cross-feature-write')) shape(src, 'cross-feature-write', 'writes ' + dst.slice(6) + ', which belongs to ' + domainOf[dst] + ' - one feature owns a table; others ask it through its actions');
    if (kind === 'calls' && ls === 'actions' && src.startsWith('file:') && R('action-calls-action')) shape(src, 'action-calls-action', 'calls ' + dst.slice(6) + ' from inside a route file - a door should call logic, not another door');
    if (kind === 'import' && ls === 'data' && ld && ld !== 'data' && R('data-reaches-up')) shape(src, 'data-reaches-up', 'imports ' + dst.slice(5) + ' - data defines; it never reaches up into logic or screens');
  }
  /* ---- families and the lines between them (FAM is read with the declarations above) ---- */
  if (FAM.list.length) {
    const famOf = (d) => (d ? FAM.of[d] || null : null);
    for (const [s, d] of Object.entries(domainOf)) {
      const f = famOf(d);
      tags.push([s, 'family', f ? f.name : 'unassigned', f ? 'feature ' + d : 'feature ' + d + ' is in no family']);
      if (f) tags.push([s, 'level', f.level, f.name]);
    }
    EXTRA.ns.push(['family', 'Families', 'The organising label over features: each family groups related features, and sits at one level - shared service, module or dashboard. Lines point down into the shared services, the dashboard fans out across the modules, and a module asks another module only through a declared dependency. The project\'s families are in .cockpit/plugins/architecture.families.json.', 0]);
    EXTRA.ns.push(['level', 'Levels', 'Shared services at the bottom, modules above them, the dashboard on top. A line may point down or across to a declared dependency; a line pointing up is a red flag.', 0]);
    for (const f of FAM.list) EXTRA.tm.push(['family', f.name, 'info', f.name, ({ service: 'shared service', module: 'module', dashboard: 'dashboard' })[f.level] + (f.why ? ' - ' + f.why : '')]);
    EXTRA.tm.push(['family', 'unassigned', 'warn', 'Unassigned', 'its feature is in no family - add the feature to .cockpit/plugins/architecture.families.json']);
    EXTRA.tm.push(['level', 'service', 'info', 'Shared service', 'always on; everything may use it; it uses nothing above it'], ['level', 'module', 'info', 'Module', 'uses the shared services; asks another module only through a declared dependency'], ['level', 'dashboard', 'info', 'Dashboard', 'the single pane of glass - reads every module through its functions']);
    const RANK = { service: 0, module: 1, dashboard: 2 };
    const notApp = (s) => /(^|\/)(scripts?|migrations?|seeds?|fixtures?|__tests__|tests?)\//i.test(s) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(s);
    const label = (s) => String(s).replace(/^[a-z]+:/, '');
    for (const [src, dst, kind] of edges) {
      if (!/^(import|calls|fetch|reads|writes)$/.test(kind)) continue;
      const a = domainOf[src], b = domainOf[dst]; if (!a || !b || a === b || notApp(src)) continue;
      const fa = famOf(a), fb = famOf(b); if (!fa || !fb) continue;
      if (RANK[fa.level] < RANK[fb.level]) { if (R('line-points-up')) shape(src, 'line-points-up', kind + ' ' + label(dst) + ' - ' + a + ' (' + fa.level + ') depends on ' + b + ' (' + fb.level + '); lines point down only'); continue; }
      if (fa.level === 'service' || fb.level !== 'module') continue;   // into a shared service, or service to service: allowed
      if (kind === 'writes') continue;                                // cross-feature-write already says it
      if (kind === 'reads') { if (R('module-reaches-into-module')) shape(src, 'module-reaches-into-module', 'reads ' + label(dst) + ', a table of ' + b + ' - ask ' + b + ' through its functions, never its tables'); continue; }
      if (fa.level === 'dashboard') continue;                         // the dashboard reads every module through its functions
      const deps = (DECL.features[a] && DECL.features[a].dependsOn) || [];
      if (!deps.includes(b) && R('undeclared-module-dependency')) shape(src, 'undeclared-module-dependency', kind + ' ' + label(dst) + ' of ' + b + ' - ' + a + ' does not list ' + b + ' under "## Depends on" in its README');
    }
  }
  /* ---- the declaration checks (tags.json): a claim against what the code does ---- */
  const featuresSeen = new Set(tags.filter((t) => t[1] === 'domain' && t[0].startsWith('file:')).map((t) => t[2]));
  const declaredFeatures = new Set(Object.keys(DECL.features));
  for (const f of taken) {
    const subj = 'file:' + f.rel; const d = DECL.files[f.rel]; if (!d) continue;
    const feat = d.feature ? String(d.feature).toLowerCase() : null;
    if (feat && feat !== 'shared' && !declaredFeatures.has(feat) && R('tag-without-readme')) problem(subj, 'tag-without-readme', 'names feature "' + feat + '", which has no README and no mapping entry');
    if (d.kind && !KIND_VALUES.has(normKind(d.kind)) && R('kind-unknown')) problem(subj, 'kind-unknown', '@kind ' + d.kind + ' is not one of ' + [...KIND_VALUES].join(', '));
    const dl = DECLARED_LAYER[subj], ol = observedLayer[subj];
    if (dl && ol && dl !== ol && R('kind-disagrees')) {
      const strong = (ol === 'actions' && edges.some((e) => e[0] === subj && e[2] === 'declares')) || ol === 'data' || (ol === 'screens' && dl !== 'screens' && (kindOf[subj] === 'page' || /\.html?$/i.test(f.name))) || (dl === 'screens' && edges.some((e) => e[0] === subj && (e[2] === 'reads' || e[2] === 'writes')));
      if (strong) problem(subj, 'kind-disagrees', 'declared ' + d.kind + ' but the code looks like ' + ol + (ol === 'actions' ? ' (it declares routes)' : ol === 'data' ? ' (it is SQL)' : dl === 'screens' ? ' (a screen that reads or writes tables)' : ''));
    }
    if (d.source === 'declared' && !d.purpose && R('purpose-missing')) problem(subj, 'purpose-missing', 'a header with no @purpose');
    if (d.purpose && String(d.purpose).length > 220 && R('purpose-long')) problem(subj, 'purpose-long', String(d.purpose).length + ' characters - one sentence is the contract');
    if (d.source === 'declared' && (!d.flow || !d.flow.length) && (dl === 'screens' || (facts[subj] && facts[subj].kind === 'test' && /\.browser\.(test|spec)\./i.test(subj))) && R('tag-missing')) problem(subj, 'tag-missing', 'a ' + (dl === 'screens' ? 'screen' : 'test') + ' with no @flow');
  }
  for (const [subj, ks] of DECL.unknown) if (R('tag-unknown')) problem(subj, 'tag-unknown', '@' + ks.join(', @') + ' - not in tags.json; a tag enters through the schema');
  for (const subj of DECL.twice || []) if (R('feature-twice')) problem(subj, 'feature-twice', 'two @feature lines - a file belongs to one feature');
  for (const subj of DECL.redundant || []) if (R('mapping-redundant')) problem(subj, 'mapping-redundant', 'the header now carries what the mapping file says - remove the mapping entry');
  const owtEdges = edges.filter((e) => e[2] === 'writes' && String(e[0]).startsWith('route:')).concat(edges.filter((e) => e[2] === 'writes' && !String(e[0]).startsWith('route:')));   // routes first, so a file is not said again for its route's write
  const owtRouteSaid = new Set();
  for (const [name, Fd] of Object.entries(DECL.features)) {
    if (!featuresSeen.has(name) && R('readme-without-files')) problem(Fd.readme ? 'file:' + Fd.readme : 'flows:all', 'readme-without-files', 'feature "' + name + '" is declared but no file carries it');
    for (const t of Fd.tables || []) { const ts = 'table:' + t; if (!tableSubjects.has(ts)) { if (R('listed-table-undefined')) problem(Fd.readme ? 'file:' + Fd.readme : 'flows:all', 'listed-table-undefined', 'lists table ' + t + ', which nothing defines or touches'); continue; } if (R('owned-table-written-elsewhere')) for (const e of owtEdges) {
        /* the SAME exclusions as cross-feature-write, and never the same write twice (2026-10-02 validation: once READMEs were
           read this rule woke at 251, counting test files, CI scripts and shared code as writers, and re-flagging every
           write cross-feature-write already reports - same doctrine, two findings) */
        if (e[1] !== ts || e[2] !== 'writes' || !domainOf[e[0]] || domainOf[e[0]] === name) continue;
        if (/(^|\/)(scripts?|migrations?|seeds?|fixtures?|__tests__|tests?)\//i.test(e[0]) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(e[0])) continue;
        const shared = new Set((RULES['cross-feature-write'] && RULES['cross-feature-write'].shared) || ['platform', 'shell', 'cicd', 'shared', 'core']);
        if (shared.has(domainOf[e[0]]) || shared.has(name)) continue;
        if (domainOf[ts] === name && R('cross-feature-write')) continue;   // cross-feature-write already says it
        /* one write, one finding: a route that writes the table is said on the ROUTE; its file is not said again for the same
           table (2026-10-02 spot-check: 14 files flagged on top of their own routes) */
        if (e[0].startsWith('file:') && owtRouteSaid.has(e[0] + '|' + t)) continue;
        if (e[0].startsWith('route:')) { const rn = nodes.find((n) => n.subject === e[0]); if (rn && rn.parent) owtRouteSaid.add(rn.parent + '|' + t); }
        shape(e[0], 'owned-table-written-elsewhere', 'writes ' + t + ', which ' + name + '\'s README says it owns');
      } }
  }
  /* a table is OWNED when a README lists it, or when the code gives it exactly one feature (the domain lens tags a table with the
     module whose routes touch it). Unlisted-but-obvious was paperwork: 352 findings on a large monorepo (fix the noisy
     rules). What stays is the real question - a table no feature claims and no single feature's code explains. */
  if (R('table-unowned')) { const owned = new Set(); for (const Fd of Object.values(DECL.features)) (Fd.tables || []).forEach((t) => owned.add('table:' + t)); const doms = {}; const fileDom = {}; tags.forEach((t) => { if (t[1] === 'domain' && String(t[0]).startsWith('file:')) fileDom[t[0]] = t[2]; }); edges.forEach((e) => { if ((e[2] === 'reads' || e[2] === 'writes') && String(e[1]).startsWith('table:') && String(e[0]).startsWith('file:') && !isScriptFile(e[0]) && fileDom[e[0]] && fileDom[e[0]] !== 'unsorted') (doms[e[1]] = doms[e[1]] || new Set()).add(fileDom[e[0]]); }); /* the features of every app file that READS or WRITES the table (routes reach tables through helpers, so route-only credit missed billing's subscriptions); a table merely defined in a migration is not explained by it */ if (declaredFeatures.size) for (const ts of tableSubjects) if (!owned.has(ts) && !(doms[ts] && doms[ts].size === 1) && !/^table:(pg_|information_schema)/.test(ts)) problem(ts, 'table-unowned', doms[ts] && doms[ts].size > 1 ? 'no README lists it, and features ' + [...doms[ts]].join(', ') + ' all touch it - which one owns its shape?' : 'no README lists it and no feature\'s code touches it'); }
}

/* ---------- write (derived rows replaced; human rows kept) ---------- */
db.exec('BEGIN');
db.exec("DELETE FROM node"); db.exec("DELETE FROM edge"); db.exec("DELETE FROM tag WHERE source = 'derived'");
const insN = db.prepare('INSERT OR REPLACE INTO node (subject, kind, parent, title, file, size, at) VALUES (?,?,?,?,?,?,?)');
/* ---------- Phase 5: the system keeps itself honest ---------- */
// ARCHITECTURE.md from the schema (engine/archdoc.js): written when missing or generated on an older schema; a hand-written one is reported
try {
  const archdoc = require(path.join(__dirname, '..', '..', 'engine', 'archdoc.js'));
  const st = archdoc.status(projectDir);
  if (st.handWritten) { if (R('architecture-doc-handwritten')) problem(SITE, 'architecture-doc-handwritten', 'ARCHITECTURE.md is hand-written; the schema is v' + st.version + ' - check it says the same, or regenerate (cli architecture-doc --force)'); }
  else { const w = archdoc.write(projectDir, false); if (w.written) say('ARCHITECTURE.md ' + w.why + ' (schema v' + w.version + ')'); yields.architectureDoc = 'v' + w.version; }
} catch (e) { say('ARCHITECTURE.md not written: ' + e.message); }
// the doctrine inbox: due for review at five notes or when the oldest is over 30 days (the review is a person's, with the AI)
try {
  const inbox = path.join(__dirname, '..', '..', 'prompts', 'doctrine-inbox');
  const notes = fs.readdirSync(inbox).filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f)).map((f) => ({ f, at: fs.statSync(path.join(inbox, f)).mtimeMs }));
  const oldestDays = notes.length ? Math.round((Date.now() - Math.min(...notes.map((n) => n.at))) / 86400e3) : 0;
  yields.doctrineInbox = { notes: notes.length, oldestDays };
  if ((notes.length >= 5 || oldestDays > 30) && R('doctrine-review-due')) problem(SITE, 'doctrine-review-due', notes.length + ' lesson' + (notes.length === 1 ? '' : 's') + ' in the doctrine inbox, the oldest ' + oldestDays + ' days - review them into doctrine.md (/lesson review in the chat)');
} catch (e) { /* no inbox */ }
// the standing backlog: what every scan leaves for people - counted once, kept in the history with the per-feature findings
const backlog = { untagged: yields.untagged || 0, tagsWithoutReadme: 0, flowsWithoutTest: 0, flowsFailing: 0, unticketedFindings: 0, findings: 0 };
{
  const ticketed = new Set(db.prepare("SELECT subject FROM tag WHERE ns = 'ticket'").all().map((r) => r.subject));
  for (const t of tags) if (t[1] === 'problem') { backlog.findings++; if (t[2] === 'tag-without-readme') backlog.tagsWithoutReadme++; if (t[2] === 'flow-without-test') backlog.flowsWithoutTest++; if (t[2] === 'flow-failing') backlog.flowsFailing++; if (!ticketed.has(t[0]) && !/^(doctrine-review-due|architecture-doc-|backup-|restore-|smoke-|dast-failed|login-failed|lockfile-missing|env-example)/.test(t[2])) backlog.unticketedFindings++; }
  yields.backlog = backlog;
}
try {
  const hf = path.join(projectDir, '.cockpit', 'plugins', 'architecture.history.json');
  let hist = []; try { hist = JSON.parse(fs.readFileSync(hf, 'utf8')).scans || []; } catch (e) { /* first time */ }
  const counts = {}, perFeature = {}; const domainNow = {}; tags.forEach((t) => { if (t[1] === 'domain') domainNow[t[0]] = t[2]; });
  tags.forEach((t) => { if (t[1] === 'problem') { counts[t[2]] = (counts[t[2]] || 0) + 1; const d = domainNow[t[0]]; if (d && d !== 'unsorted') perFeature[d] = (perFeature[d] || 0) + 1; } });
  hist.push({ at: now, files: taken.length, counts, features: perFeature, backlog }); hist = hist.slice(-40);
  fs.writeFileSync(hf, JSON.stringify({ _note: 'Per-scan counts of every Problems value, per feature, and the standing backlog - the trend on the cards. Written by the scan; the last 40.', scans: hist }, null, 1) + '\n');
} catch (e) { say('history not written: ' + e.message); }

for (const n of nodes) insN.run(n.subject, n.kind, n.parent, n.title, n.file, n.size, now);
const insE = db.prepare('INSERT OR IGNORE INTO edge (src, dst, kind, at) VALUES (?,?,?,?)');
for (const e of edges) insE.run(e[0], e[1], e[2], now);
const insT = db.prepare("INSERT OR IGNORE INTO tag (subject, ns, value, source, why, by, at) VALUES (?,?,?,'derived',?,?,?)");
/* a tag a person set answers that lens for that subject: the scanner's own value is not written beside it
   (2026-09-17: server.js carried reach:entry-point* and reach:nothing-points-here at once) */
const byHand = new Set(db.prepare("SELECT subject || '\u0001' || ns AS k FROM tag WHERE source != 'derived'").all().map((r) => r.k));
for (const t of tags) { if (byHand.has(t[0] + '\u0001' + t[1])) continue; insT.run(t[0], t[1], t[2], t[3] || null, 'architecture-scan', now); }

/* Descriptions and grades live beside the code that produces the values, so they cannot
   drift; a row a person set (set_by != 'derived') is never overwritten. */
const ns = db.prepare("INSERT INTO ns_meta (ns, title, purpose, graded, set_by) VALUES (?,?,?,?,'derived') ON CONFLICT(ns) DO UPDATE SET title = CASE WHEN ns_meta.set_by = 'derived' THEN excluded.title ELSE ns_meta.title END, purpose = CASE WHEN ns_meta.set_by = 'derived' THEN excluded.purpose ELSE ns_meta.purpose END, graded = excluded.graded");
ns.run('kind', 'What is it', 'Which files are pages a person sees, which are includes behind them, which are scripts, styles and tables.', 0);
ns.run('reach', 'Reach', 'What nothing points at. A page nothing links to is an entry point or dead; a table read but never written is filled from outside this code.', 1);
ns.run('data', 'Data', 'Which files touch the database, and whether they read, write, or both.', 0);
ns.run('problem', 'Problems', 'What vibe-coding leaves behind: tables nobody owns, SQL in pages, private database connections, copy-paste functions, god files, secrets in code, dead ends. Findings, not verdicts - grade what each means here.', 1);
EXTRA.ns.forEach((r) => ns.run(r[0], r[1], r[2], r[3]));
const tm = db.prepare("INSERT INTO tag_meta (ns, value, band, label, why, set_by, at) VALUES (?,?,?,?,?,'derived',?) ON CONFLICT(ns, value) DO UPDATE SET band = CASE WHEN tag_meta.set_by = 'derived' THEN excluded.band ELSE tag_meta.band END, label = CASE WHEN tag_meta.set_by = 'derived' THEN excluded.label ELSE tag_meta.label END, why = CASE WHEN tag_meta.set_by = 'derived' THEN excluded.why ELSE tag_meta.why END, at = excluded.at");
[['reach', 'nothing-points-here', 'warn', 'nothing points here', 'no include, link, form, fetch or script tag names this file'],
 ['reach', 'entry-point', 'ok', 'entry point', 'an index file: reached from outside by design'],
 ['reach', 'reached', 'ok', 'reached', 'at least one thing points at it'],
 ['reach', 'widely-used', 'ok', 'widely used', 'five or more things point at it'],
 ['reach', 'read-but-never-written', 'warn', 'read, never written', 'no code here writes this table; it is filled from somewhere else'],
 ['reach', 'defined-never-used', 'info', 'defined, never used', 'a migration creates it; no code here reads or writes it'],
 ['kind', 'component', 'info', 'component', ''], ['kind', 'route', 'info', 'route', 'declares HTTP routes'], ['kind', 'worker', 'info', 'worker', ''], ['kind', 'service', 'info', 'service', ''], ['kind', 'migration', 'info', 'migration', ''], ['kind', 'test', 'info', 'test', ''], ['kind', 'module', 'info', 'module', ''], ['kind', 'sql', 'info', 'sql', ''], ['data', 'defines', 'info', 'defines', 'a migration that creates or alters tables'],
 ['kind', 'page', 'info', 'page', ''], ['kind', 'include', 'info', 'include', ''], ['kind', 'script', 'info', 'script', ''], ['kind', 'style', 'info', 'style', ''], ['kind', 'table', 'info', 'table', ''], ['kind', 'note', 'info', 'note', ''], ['kind', 'file', 'info', 'file', ''],
 ['data', 'reads', 'info', 'reads', ''], ['data', 'writes', 'info', 'writes', ''], ['data', 'reads-and-writes', 'info', 'reads and writes', ''], ['data', 'no-database', 'info', 'no database', '']
].concat(Object.entries(RULES).map(([id, r]) => ['problem', id, r.band || 'info', r.label || id, (r.why || '') + (r.doctrine ? ' · doctrine: ' + r.doctrine : '')]))   // the Problems descriptions come from problems.json, same place as the rules
.concat(EXTRA.tm)
.forEach((r) => tm.run(r[0], r[1], r[2], r[3], r[4], now));
db.exec('COMMIT');

/* The Flow layout is the PROJECT'S: seeded once from layouts.json by type, then the project's
   own (the owner or the AI edits it; a rescan never overwrites it). */
try {
  const layoutFile = path.join(projectDir, '.cockpit', 'plugins', 'architecture.layout.json');
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'layouts.json'), 'utf8'));
  /* a seeded layout the project never edited follows the TYPE (a project kept the PHP columns after
     its type changed to Node) - "never edited" = its columns and edges still equal some template's */
  let reseed = false;
  if (fs.existsSync(layoutFile)) {
    try { const cur = JSON.parse(fs.readFileSync(layoutFile, 'utf8')); const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
      /* untouched = still equal to some template, OR still carrying the seed note without an _edited mark (the templates
         themselves change - 2026-09-18, the four columns - and a seeded copy should follow) */
      const untouched = !cur._edited && (Object.keys(all).filter((k) => k[0] !== '_').some((k) => same(cur.columns, all[k].columns) && same(cur.edges, all[k].edges)) || /Seeded from the plugin's default/.test(cur._note || ''));
      const seededFor = cur._seededFor || (/type "([^"]+)"/.exec(cur._note || '') || [])[1];
      const current = all[type] && same(cur.columns, all[type].columns) && same(cur.edges, all[type].edges);
      reseed = untouched && !!all[type] && (seededFor !== type || !current);
      if (reseed) say('layout followed the ' + (seededFor !== type ? 'type: ' + seededFor + ' -> ' + type : 'plugin\'s new default for ' + type));
    } catch (e) { /* unreadable: leave it, the card reports it */ }
  }
  if (!fs.existsSync(layoutFile) || reseed) {
    const def = all[type] || all['website-php'];
    fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
    fs.writeFileSync(layoutFile, JSON.stringify({ _seededFor: type, _note: 'This project\'s Flow layout for the Architecture card. Seeded from the plugin\'s default for type "' + type + '"; edit freely and set _edited: true to keep your edits; a seeded copy follows the plugin defaults and the project type. Columns match by kind, nodeKind, tag ("ns:value"), role (source|hub|sink|isolated) or folder (prefix); first match wins. edges = which edge kinds to draw.', ...def }, null, 2) + '\n');
    say('layout seeded: ' + layoutFile);
  }
} catch (e) { say('layout not seeded: ' + e.message); }

const note = 'site ' + siteName + ': ' + taken.length + ' files, ' + edges.length + ' edges';
say(note);
yields.readFrom = readFrom;   // which code this map is of - current main, or the folder as it is
console.log(JSON.stringify({ ok: true, yields, note }));
