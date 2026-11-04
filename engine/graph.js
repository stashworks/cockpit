/* ONE graph, generic (re-based on the
   engine's own tables so no plugin's vocabulary is in the code).

     LAYER     node.kind, node.parent            where you are - the plugin's scan declares it
     SUBJECT   node.subject, typed: 'page:x.php' what a node IS
     LENS      a tag namespace                   what you are asking about it

   The children of a parent are the ONLY hierarchy walk; a lens only changes their colour. A
   node's colour comes from the tags its descendants carry, graded by tag_meta - a table,
   not a switch. The legend is whatever values were found. A NEW LENS IS A NEW NAMESPACE. */
'use strict';

function root(db) { return db.get("SELECT subject FROM node WHERE parent IS NULL ORDER BY subject LIMIT 1"); }

/* every leaf beneath a subject (the subject itself if it is a leaf) - cached per db per scan */
const cache = new WeakMap();
function descendants(db) {
  const stamp = (db.get('SELECT max(at) m, count(*) n FROM node') || {});
  const key = (stamp.m || '') + ':' + stamp.n;
  let c = cache.get(db);
  if (c && c.key === key) return c.map;
  const rows = db.all('SELECT subject, parent FROM node');
  const kids = {}; rows.forEach((r) => { if (r.parent) (kids[r.parent] = kids[r.parent] || []).push(r.subject); });
  const map = {};
  const walk = (s) => { if (map[s]) return map[s]; const out = []; (kids[s] || []).forEach((k) => { if (kids[k]) out.push(...walk(k)); else out.push(k); }); if (!out.length) out.push(s); map[s] = out; return out; };
  rows.forEach((r) => walk(r.subject));
  cache.set(db, { key, map });
  return map;
}

function lenses(db) {
  const meta = {}; db.all('SELECT * FROM ns_meta').forEach((m) => { meta[m.ns] = m; });
  const found = db.all('SELECT ns, count(DISTINCT subject) n FROM tag GROUP BY ns ORDER BY ns');
  return found.map((f) => ({ ns: f.ns, title: (meta[f.ns] || {}).title || f.ns, purpose: (meta[f.ns] || {}).purpose || '', graded: !!(meta[f.ns] || {}).graded, subjects: f.n }));
}

function graph(db, opts) {
  const lens = opts.lens || null;
  const parent = opts.parent || (root(db) || {}).subject;
  if (!parent) return { ok: false, note: 'nothing scanned yet' };
  const pnode = db.get('SELECT * FROM node WHERE subject = ?', parent);
  if (!pnode) return { ok: false, note: 'no such node: ' + parent };
  const kids = db.all('SELECT * FROM node WHERE parent = ? ORDER BY title', parent);
  const desc = descendants(db);
  const meta = {}; db.all('SELECT * FROM tag_meta WHERE ns = ?', lens || '').forEach((m) => { meta[m.value] = m; });
  const nsm = lens ? db.get('SELECT * FROM ns_meta WHERE ns = ?', lens) : null;
  const graded = !!(nsm && nsm.graded);
  const BAND_RANK = { bad: 3, warn: 2, ok: 1, info: 0 };

  // tags of every leaf, for the lens, in one query. A HUMAN'S TAG REPLACES THE SCANNER'S in
  // the same lens on the same subject: once the owner says "live Node service", the derived
  // "nothing points here" no longer counts against that file (2026-09-16: council stayed
  // amber after the owner had answered, because the worst of both colours won).
  const byLeaf = {}, ownerSaid = {};
  if (lens) {
    const rows = db.all('SELECT subject, value, source FROM tag WHERE ns = ?', lens);
    rows.forEach((t) => { if (t.source !== 'derived') ownerSaid[t.subject] = 1; });
    rows.forEach((t) => { if (t.source !== 'derived' || !ownerSaid[t.subject]) (byLeaf[t.subject] = byLeaf[t.subject] || []).push(t.value); });
  }

  const legendCount = {};
  const nodes = kids.map((k) => {
    const leaves = desc[k.subject] || [k.subject];
    const dist = {}; let worst = 'info', worstRank = -1;
    leaves.forEach((l) => (byLeaf[l] || []).forEach((v) => {
      dist[v] = (dist[v] || 0) + 1;
      const b = (meta[v] || {}).band || 'info';
      if (BAND_RANK[b] > worstRank) { worstRank = BAND_RANK[b]; worst = b; }
    }));
    Object.keys(dist).forEach((v) => { legendCount[v] = (legendCount[v] || 0) + 1; });
    const isLeaf = !db.get('SELECT 1 FROM node WHERE parent = ? LIMIT 1', k.subject);
    return { subject: k.subject, kind: k.kind, title: k.title, file: k.file, size: leaves.length, dist, band: graded ? (worstRank < 0 ? 'quiet' : worst) : null, drill: isLeaf ? null : k.subject,
      tip: k.title + (Object.keys(dist).length ? ' — ' + Object.entries(dist).map(([v, n]) => v + ' ' + n).join(', ') : '') };
  });
  const legend = Object.entries(legendCount).sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n, label: (meta[value] || {}).label || value, band: (meta[value] || {}).band || 'info', why: (meta[value] || {}).why || '' }));
  return { ok: true, parent, kind: pnode.kind, title: pnode.title, crumbs: crumbs(db, parent), lens, lensTitle: nsm ? nsm.title : lens, purpose: nsm ? nsm.purpose : '', graded, nodes, legend };
}

function crumbs(db, subject) {
  const out = []; let s = subject, guard = 0;
  while (s && guard++ < 20) { const n = db.get('SELECT subject, title, parent FROM node WHERE subject = ?', s); if (!n) break; out.unshift({ subject: n.subject, title: n.title }); s = n.parent; }
  return out;
}

/* one node and everything that touches it - the rail when a node is selected */
function detail(db, subject) {
  const n = db.get('SELECT * FROM node WHERE subject = ?', subject);
  if (!n) return null;
  const out = db.all('SELECT e.kind, e.dst subject, n.title, n.kind nodeKind FROM edge e LEFT JOIN node n ON n.subject = e.dst WHERE e.src = ? ORDER BY e.kind, n.title', subject);
  const inn = db.all('SELECT e.kind, e.src subject, n.title, n.kind nodeKind FROM edge e LEFT JOIN node n ON n.subject = e.src WHERE e.dst = ? ORDER BY e.kind, n.title', subject);
  const tags = db.all('SELECT t.ns, t.value, t.source, t.why, m.band, m.label FROM tag t LEFT JOIN tag_meta m ON m.ns = t.ns AND m.value = t.value WHERE t.subject = ? ORDER BY t.ns, t.value', subject);
  const children = db.all('SELECT subject, kind, title FROM node WHERE parent = ? ORDER BY title', subject);
  return { ...n, out, in: inn, tags, children, crumbs: crumbs(db, subject) };
}

/* A human grades a value: survives every rescan (set_by = the person). */
function grade(db, ns, value, band, label, why, by) {
  db.run('INSERT INTO tag_meta (ns, value, band, label, why, set_by, at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(ns, value) DO UPDATE SET band = excluded.band, label = COALESCE(excluded.label, tag_meta.label), why = COALESCE(excluded.why, tag_meta.why), set_by = excluded.set_by, at = excluded.at', ns, value, band, label || null, why || null, by || 'owner', db.now());
}

function find(db, q) {
  const like = '%' + String(q || '').toLowerCase() + '%';
  return db.all('SELECT subject, kind, title, file FROM node WHERE lower(subject) LIKE ? OR lower(title) LIKE ? ORDER BY title LIMIT 60', like, like);
}
/* A hand-set tag: source 'owner', so the scan's DELETE of derived rows never touches it. */
function tagByHand(db, subject, ns, value, why, by) {
  if (!db.get('SELECT 1 FROM node WHERE subject = ?', subject)) return { ok: false, error: 'no such node: ' + subject };
  db.run('INSERT OR REPLACE INTO tag (subject, ns, value, source, why, by, at) VALUES (?,?,?,?,?,?,?)', subject, ns, value, 'owner', why || null, by || 'owner', db.now());
  return { ok: true };
}

/* Taking a hand-set tag back (the 59 no-single-writer "accepted" marks coders set on their own work were
   removed so the corrected rule could recount). Only rows a person or a coder set; the scan's derived rows are its own.
   value '*' takes back every value of that lens on the subject. Returns how many went. */
function untagByHand(db, subject, ns, value) {
  if (!subject || !ns) return { ok: false, error: 'subject and lens are needed' };
  const before = db.get("SELECT count(*) n FROM tag WHERE subject = ? AND ns = ? AND source != 'derived'" + (value && value !== '*' ? ' AND value = ?' : ''), ...[subject, ns].concat(value && value !== '*' ? [value] : [])).n;
  db.run("DELETE FROM tag WHERE subject = ? AND ns = ? AND source != 'derived'" + (value && value !== '*' ? ' AND value = ?' : ''), ...[subject, ns].concat(value && value !== '*' ? [value] : []));
  return { ok: true, removed: before };
}

/* A NEW LENS IS A NEW NAMESPACE: this describes it (title, the question it answers, whether
   its values are graded). Set by a person or the AI on the owner's instruction; a rescan's
   derived descriptions never overwrite a row set_by != 'derived'. */
function describeLens(db, ns, title, purpose, graded, by) {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(ns || '')) return { ok: false, error: 'a lens name is lowercase letters, digits, - or _' };
  db.run('INSERT INTO ns_meta (ns, title, purpose, graded, set_by) VALUES (?,?,?,?,?) ON CONFLICT(ns) DO UPDATE SET title = excluded.title, purpose = excluded.purpose, graded = excluded.graded, set_by = excluded.set_by', ns, title || ns, purpose || '', graded ? 1 : 0, by || 'owner');
  return { ok: true, ns };
}

/* The whole map in one call each, for an AI that cannot loop. Bounded; says so if cut. */
function allNodes(db, kind) {
  const rows = kind ? db.all('SELECT subject, kind, parent, title, file, size FROM node WHERE kind = ? ORDER BY subject LIMIT 20001', kind) : db.all('SELECT subject, kind, parent, title, file, size FROM node ORDER BY subject LIMIT 20001');
  const tags = {}, purpose = {}; db.all('SELECT subject, ns, value, source, why FROM tag').forEach((t) => { (tags[t.subject] = tags[t.subject] || []).push(t.ns + ':' + t.value + (t.source !== 'derived' ? '*' : '')); if (t.ns === 'purpose' && t.why) purpose[t.subject] = t.why; });   // the @purpose sentence rides along: it is text, not a value
  return { ok: true, count: Math.min(rows.length, 20000), truncated: rows.length > 20000, legend: '* = set by a person', nodes: rows.slice(0, 20000).map((r) => ({ ...r, tags: tags[r.subject] || [], ...(purpose[r.subject] ? { purpose: purpose[r.subject] } : {}) })) };
}
function allEdges(db, kind) {
  const rows = kind ? db.all('SELECT src, dst, kind FROM edge WHERE kind = ? ORDER BY src, dst LIMIT 60001', kind) : db.all('SELECT src, dst, kind FROM edge ORDER BY src, dst LIMIT 60001');
  return { ok: true, count: Math.min(rows.length, 60000), truncated: rows.length > 60000, edges: rows.slice(0, 60000) };
}

module.exports = { graph, lenses, detail, grade, root, crumbs, find, tagByHand, untagByHand, describeLens, allNodes, allEdges };
