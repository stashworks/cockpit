/* Engine config — the few settings that belong to the runtime, not to any project.
   Read from engine.json beside index.js if present; environment variables win over the file;
   every key has a default so a fresh checkout runs with no file at all. Project settings never
   live here (§1). Every setting is listed in CONFIGURATION.md. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* an out-of-the-way port (2026-10-08): 3000, 4000, 5000, 5173, 8000 and 8080 are what app servers and dev tools take
   first, so Cockpit stays clear of them. Taken anyway: the engine moves up to the next free one (server.js), and the
   wizard can set any other (engine.json "port"). */
const DEFAULT_PORT = 47821;
const DEFAULTS = {
  port: DEFAULT_PORT,         // engine.json "port", or COCKPIT_PORT (or PORT), overrides
  host: '127.0.0.1',          // COCKPIT_HOST overrides; this machine only by default. 0.0.0.0 = reachable from the whole network, with NO login (docs/generic-ide.md §7) - only on a network you trust
  idleUnloadMinutes: 10,      // a project nobody is looking at goes quiet after this (§13)
  person: 'default'           // COCKPIT_PERSON overrides: whose layouts, and the name Home greets; one person for now
};

function fromEnv(env) {
  const o = {};
  const port = env.COCKPIT_PORT || env.PORT;
  if (port && /^\d+$/.test(String(port).trim())) o.port = Number(port);
  if (env.COCKPIT_HOST) o.host = String(env.COCKPIT_HOST).trim();
  if (env.COCKPIT_PERSON && /^[a-z0-9][a-z0-9 _-]{0,39}$/i.test(env.COCKPIT_PERSON.trim())) o.person = env.COCKPIT_PERSON.trim();
  return o;
}

function loadEngineConfig(root) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8')); } catch (e) { /* no file = defaults */ }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { ...DEFAULTS, ...file, ...fromEnv(process.env), version: pkg.version, root };
}

/* THE CODING PLUGIN, engine-wide (owner, 2026-10-25: "DevOps / coding cards go behind the plugins"): off by default, so a
   Cockpit used for conversation and notes shows none of the software machinery - the agent fleet, lane performance, alerts,
   the event log, backups, data views, and every plugin whose plugin.json says "group": "coding" (Architecture, Coding,
   Tickets, GitHub, Database) with their cards and tabs. Settings > Plugins and cards switches it (engine.json "coding");
   COCKPIT_CODING=1 / 0 wins. Read fresh each time, so the switch needs no restart. */
function codingOn(root) {
  const env = process.env.COCKPIT_CODING;
  if (env === '1' || env === '0') return env === '1';
  try { return JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8').replace(/^﻿/, '')).coding === true; } catch (e) { return false; }
}

/* Where per-project secrets that never go in a repository are kept (a test login: <secretsDir>\<project id>\look-login.json).
   COCKPIT_SECRETS_DIR, or engine.json "secretsDir"; by default a "config" folder two levels above the engine, beside the
   folder the apps live in (e.g. engine in C:\projects\tools\cockpit -> C:\projects\config). */
function secretsDir(root) {
  if (process.env.COCKPIT_SECRETS_DIR) return path.resolve(process.env.COCKPIT_SECRETS_DIR);
  try { const f = JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8')); if (f && typeof f.secretsDir === 'string' && f.secretsDir) return path.resolve(root, f.secretsDir); } catch (e) { /* no file */ }
  return path.resolve(root, '..', '..', 'config');
}

/* Certificates for the sites the test runner reaches. Certificate checks stay ON. A project's local sites are often served by
   a local proxy with its own certificate authority (Caddy's "tls internal", mkcert): name that authority's root certificate
   (a PEM file) in COCKPIT_EXTRA_CA or engine.json "extraCa", and it is trusted IN ADDITION to the normal ones - nothing else
   changes. Only COCKPIT_INSECURE_TLS=1 switches checks off entirely (the whole engine process - a last resort, logged). */
let tlsApplied = false;   // once per process: tests.js is hot-reloaded and calls this each time
function applyTls(root) {
  if (tlsApplied) return; tlsApplied = true;
  const tls = require('node:tls');
  let extra = process.env.COCKPIT_EXTRA_CA || '';
  if (!extra) { try { const f = JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8')); if (f && typeof f.extraCa === 'string') extra = f.extraCa; } catch (e) { /* no file */ } }
  if (extra) {
    try {
      const pem = fs.readFileSync(path.resolve(root, extra), 'utf8');
      const mine = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
      if (!mine.length) throw new Error('no certificate in ' + extra);
      tls.setDefaultCACertificates(tls.getCACertificates('default').concat(mine));
      console.log('tls → trusting ' + mine.length + ' extra certificate(s) from ' + extra);
    } catch (e) { console.log('tls → COCKPIT_EXTRA_CA not used: ' + e.message); }
  }
  if (process.env.COCKPIT_INSECURE_TLS === '1') { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; console.log('tls → WARNING: certificate checks are OFF for the whole engine (COCKPIT_INSECURE_TLS=1)'); }
}

module.exports = { loadEngineConfig, DEFAULTS, DEFAULT_PORT, secretsDir, applyTls, codingOn };
