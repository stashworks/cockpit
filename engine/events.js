/* Events - ONE record of what happened in a project, whatever produced it (step 3 of Home, 2026-09-19).
   A ticket moved, a verdict came back, a promote went out or was rolled back, a test run went red or green
   again, an agent gave up. Each project keeps its own in its cockpit.db (table event); across() reads every
   project's for Home - the master alert card, notifications, recent activity, and later "what needs me?" by
   voice all read this one table. Nothing here decides what to do; it says what happened, and whether it is
   yours to look at:
     level  info  - it happened, for the record
            warn  - it wants you: a draft to approve, a verified ticket to pass, a turn that did nothing
            alert - it went wrong: a failed promote, red tests, an agent out of tries, a scan that broke
   record() drops a repeat (same kind + ref + title inside ten minutes) so a poll cannot flood the list. */
'use strict';

const LEVELS = ['info', 'warn', 'alert'];
const ready = new WeakSet();
function table(db) {
  if (ready.has(db)) return;
  db.exec('CREATE TABLE IF NOT EXISTS event (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, text TEXT, ref TEXT, url TEXT, source TEXT, seen INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE INDEX IF NOT EXISTS event_at ON event(at)');
  ready.add(db);
  try { db.run('ALTER TABLE event ADD COLUMN times INTEGER DEFAULT 1'); } catch (e) { /* already there */ }
}

/* record(p, { kind, level, title, text?, ref?, url?, source? }) → the row id, or null when it was a repeat */
function record(p, ev) {
  if (!p || !p.db || !ev || !ev.kind || !ev.title) return null;
  const db = p.db; table(db);
  const level = LEVELS.includes(ev.level) ? ev.level : 'info';
  /* ONE ALERT PER CONDITION, NOT ONE PER EVENT (33 of them were the same red test run, recorded again every run). While an alert is still unseen and its
     condition still holds, a new one of the same kind (and ref) UPDATES it: the time moves, the words move, and it counts
     how many times it has happened. The count is the useful part - "tests red (33 runs since 03:36)" is one line to act on.
     A repeat within ten minutes is still dropped entirely. An alert the owner has SEEN starts a new one, so a condition that
     comes back after he looked is not hidden inside an old row. */
  const since = new Date(Date.now() - 600000).toISOString();
  const dup = db.get('SELECT id FROM event WHERE kind = ? AND title = ? AND ifnull(ref, \'\') = ifnull(?, \'\') AND at > ? LIMIT 1', ev.kind, ev.title, ev.ref || null, since);
  if (dup) return null;
  if (level !== 'info') {
    const open = db.get('SELECT id, times FROM event WHERE kind = ? AND ifnull(ref, \'\') = ifnull(?, \'\') AND seen = 0 ORDER BY at DESC LIMIT 1', ev.kind, ev.ref || null);
    if (open) {
      const times = Number(open.times || 1) + 1;
      db.run('UPDATE event SET at = ?, level = ?, title = ?, text = ?, times = ? WHERE id = ?', new Date().toISOString(), level, String(ev.title).slice(0, 200) + ' (' + times + ' times)', ev.text ? String(ev.text).slice(0, 1000) : null, times, open.id);
      return Number(open.id);
    }
  }
  const r = db.run('INSERT INTO event (at, kind, level, title, text, ref, url, source, seen) VALUES (?,?,?,?,?,?,?,?,0)', new Date().toISOString(), ev.kind, level, String(ev.title).slice(0, 200), ev.text ? String(ev.text).slice(0, 1000) : null, ev.ref || null, ev.url || null, ev.source || null);
  return Number(r.lastInsertRowid);
}
/* list(p, { limit, unseen, level, since, notKind, onlyKind }) - newest first.
   notKind / onlyKind are comma-separated kind PREFIXES ('ticket.,fleet.'), so a caller can ask for
   events that are not about the ticket process. That is the difference between the two cards
  : ALERTS is things outside ticketing that need a person - a backup failing,
   tests red - and the EVENT LOG is everything that happened, ticket traffic included. A ticket
   moving is not an alert; it filled the Alerts card with 25 rows and buried the two that mattered. */
function list(p, o) {
  o = o || {}; table(p.db);
  const w = [], a = [];
  if (o.unseen) w.push('seen = 0');
  if (o.level === 'warn') w.push("level IN ('warn','alert')"); else if (o.level === 'alert') w.push("level = 'alert'");
  if (o.since) { w.push('at > ?'); a.push(o.since); }
  String(o.notKind || '').split(',').filter(Boolean).forEach((k) => { w.push('kind NOT LIKE ?'); a.push(k + '%'); });
  const only = String(o.onlyKind || '').split(',').filter(Boolean);
  if (only.length) { w.push('(' + only.map(() => 'kind LIKE ?').join(' OR ') + ')'); only.forEach((k) => a.push(k + '%')); }
  a.push(Math.min(500, Math.max(1, Number(o.limit) || 100)));
  return p.db.all('SELECT * FROM event' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY at DESC, id DESC LIMIT ?', ...a);
}
function counts(p) { table(p.db); const r = { info: 0, warn: 0, alert: 0 }; p.db.all("SELECT level, count(*) n FROM event WHERE seen = 0 GROUP BY level").forEach((x) => { r[x.level] = x.n; }); return r; }
/* resolve(p, { kind, ref }) - an alert clears itself when the thing it is about moves on: a backup lands → its failure is over; tests go green → the red is over; a ticket moves → what it waited for
   is over. kind matches a prefix ('ticket.' = every ticket event); ref, when given, must match. Returns how many. */
function resolve(p, o) {
  if (!p || !p.db || !o || !o.kind) return 0; table(p.db);
  const w = ['seen = 0', 'kind LIKE ?'], a = [String(o.kind).replace(/[%_]/g, '') + '%'];
  if (o.ref !== undefined && o.ref !== null) { w.push('ref = ?'); a.push(String(o.ref)); }
  if (o.level) { w.push("level IN ('warn','alert')"); }
  return p.db.run('UPDATE event SET seen = 1 WHERE ' + w.join(' AND '), ...a).changes;
}
/* seen(p, ids) marks those; seen(p, 'all') everything */
function seen(p, ids) {
  table(p.db);
  if (ids === 'all') return p.db.run('UPDATE event SET seen = 1 WHERE seen = 0').changes;
  let n = 0; [].concat(ids || []).forEach((id) => { n += p.db.run('UPDATE event SET seen = 1 WHERE id = ?', Number(id)).changes; }); return n;
}
/* every project's events in one list, each row carrying its project (Home reads this) */
function across(projectIds, o) {
  const projects = require('./projects'), registry = require('./registry');
  let rows = [], totals = { info: 0, warn: 0, alert: 0 }, missing = [];
  (projectIds || registry.all().map((x) => x.id)).forEach((id) => {
    const e = registry.get(id); if (!e) return;
    let p = null; try { p = projects.open(id); } catch (err) { missing.push(id); return; }
    if (!p || p.missing) { missing.push(id); return; }
    try {
      list(p, o).forEach((r) => rows.push({ ...r, project: id, projectName: e.name || id }));
      const c = counts(p); totals.info += c.info; totals.warn += c.warn; totals.alert += c.alert;
    } catch (err) { missing.push(id + ': ' + err.message); }
  });
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { events: rows.slice(0, Math.min(500, Number((o || {}).limit) || 100)), unseen: totals, missing };
}
module.exports = { record, list, counts, seen, across, LEVELS, resolve };
