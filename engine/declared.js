/* The mapping file - declarations held outside the code (docs/plan-verification-and-tickets.md,
   Phase 2). For a codebase that has no headers or feature READMEs yet, `.cockpit\plugins\
   architecture.declared.json` carries the same claims in one place, in the same vocabulary as
   plugins/architecture/tags.json: per feature the README equivalents (purpose, tables, flows), per
   file the header equivalents (feature, kind, flow, purpose). The scanner reads it after headers
   and before inference. This module drafts it from what the map already knows, so every claim is
   reviewable before it counts, and reports its counts. Hot module. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KIND_OF_LAYER = { screens: 'screen', actions: 'action', logic: 'logic', data: 'data', outside: 'tool' };

function file(project) { return path.join(project.cockpit.dir, 'plugins', 'architecture.declared.json'); }
function read(project) { try { return JSON.parse(fs.readFileSync(file(project), 'utf8')); } catch (e) { return null; } }

/* Draft from the map: feature from the domain lens (the project's path rules), kind from the layer
   lens (tests carry kind test), tables owned from the domain of each table, purpose and flows
   empty - the project's AI fills those in its conversation. */
function draft(project, opts) {
  const f = file(project);
  if (fs.existsSync(f) && !(opts && opts.force)) return { ok: false, error: 'a mapping file exists - declare --force to redraft it (every filled purpose and flow would be lost)' };
  const db = project.db;
  const nodes = db.all("SELECT subject, kind, file FROM node WHERE kind IN ('file', 'table')");
  const tags = db.all("SELECT subject, ns, value FROM tag WHERE ns IN ('domain', 'layer', 'kind')");
  const by = {}; for (const t of tags) (by[t.subject] = by[t.subject] || {})[t.ns] = t.value;
  const out = { _note: 'Declarations held outside the code until the tickets move them into headers and feature READMEs (plugins/architecture/tags.json is the vocabulary). Drafted from the map on ' + new Date().toISOString().slice(0, 10) + ': feature from the path rules, kind from the layer; purpose and flows are for the project\'s AI to fill, per feature first. The scan reads this after headers and before inference; an entry whose file gains a matching header is reported as redundant.', features: {}, files: {} };
  let filesMapped = 0;
  for (const n of nodes) {
    const t = by[n.subject] || {};
    const feature = t.domain && t.domain !== 'unsorted' ? t.domain : null;
    if (n.kind === 'table') { if (feature) { const F = out.features[feature] = out.features[feature] || { purpose: '', tables: [], flows: [] }; F.tables.push(n.subject.slice(6)); } continue; }
    const kind = t.kind === 'test' ? 'test' : KIND_OF_LAYER[t.layer] || 'logic';
    if (feature) out.features[feature] = out.features[feature] || { purpose: '', tables: [], flows: [] };
    out.files[n.file] = { feature: feature || 'shared', kind, flow: [], purpose: '' };
    filesMapped++;
  }
  for (const k of Object.keys(out.features)) out.features[k].tables.sort();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out, null, 1) + '\n');
  return { ok: true, file: path.relative(project.dir, f), features: Object.keys(out.features).length, files: filesMapped, note: 'drafted; purpose and flows are empty - fill them per feature in the project\'s conversation, then rescan' };
}

/* The counts: how far the declarations have come. */
function status(project) {
  const m = read(project);
  const db = project.db;
  const decl = db.all("SELECT value, COUNT(*) AS n FROM tag WHERE ns = 'declared' GROUP BY value");
  const counts = { declared: 0, mapped: 0, inferred: 0, untagged: 0 }; for (const r of decl) counts[r.value] = r.n;
  const filled = m ? Object.values(m.features).filter((F) => F.purpose || (F.flows && F.flows.length)).length : 0;
  const flows = m ? Object.values(m.features).reduce((t, F) => t + ((F.flows || []).length), 0) : 0;
  const purposes = m ? Object.values(m.files).filter((x) => x.purpose).length : 0;
  return { ok: true, mapping: m ? { file: path.relative(project.dir, file(project)), features: Object.keys(m.features).length, filesMapped: Object.keys(m.files).length, featuresFilled: filled, flows, purposes } : null, files: counts, note: m ? 'the scan reads the mapping after headers and before inference' : 'no mapping file - declare --draft writes one from the map' };
}

module.exports = { draft, status, read, file };
