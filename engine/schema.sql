-- Engine tables. Every project's cockpit.db starts with these; plugins add their own,
-- PREFIXED (github_link, not link) so two plugins cannot collide (docs/generic-ide.md §6).
-- Only CREATE IF NOT EXISTS here; widening an existing table is a migration in db.js.

CREATE TABLE IF NOT EXISTS meta (           -- the .cockpit's own facts: engine version, created
  key TEXT PRIMARY KEY, value TEXT, at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS layout (         -- card arrangement, per person, per project
  person TEXT PRIMARY KEY, json TEXT NOT NULL, at TEXT NOT NULL);

-- The conversation is Cockpit's, not any harness's (§4). Rows are written by the engine as
-- turns happen; harness and model are columns so a switch mid-conversation is just the
-- next row. Milestone 2 fills these; milestone 1 only creates them.
CREATE TABLE IF NOT EXISTS chat_thread (
  id INTEGER PRIMARY KEY, title TEXT, subjects TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_turn (
  id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  harness TEXT, model TEXT, cost_json TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chat_turn_thread ON chat_turn (thread_id, id);
CREATE TABLE IF NOT EXISTS chat_note (      -- standing rulings a conversation established; always carried forward
  id INTEGER PRIMARY KEY, thread_id INTEGER, subject TEXT, text TEXT NOT NULL, by TEXT, at TEXT NOT NULL);

-- The lens engine's tables (docs/generic-ide.md §2: shared). Plugins POPULATE these from a
-- scan; the engine walks them. LAYER = node.kind and node.parent; SUBJECT = node.subject
-- (typed: 'page:index.php'); LENS = a tag namespace. A new lens is a new namespace, zero
-- screen code. Grading (band) lives in tag_meta; a row set_by != 'derived' is a human
-- judgement a rescan never overwrites.
CREATE TABLE IF NOT EXISTS node (
  subject TEXT PRIMARY KEY, kind TEXT NOT NULL, parent TEXT, title TEXT NOT NULL,
  file TEXT, size INTEGER DEFAULT 1, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS node_parent ON node (parent);
CREATE TABLE IF NOT EXISTS edge (
  src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (src, dst, kind));
CREATE INDEX IF NOT EXISTS edge_dst ON edge (dst);
CREATE TABLE IF NOT EXISTS tag (
  subject TEXT NOT NULL, ns TEXT NOT NULL, value TEXT NOT NULL,
  source TEXT NOT NULL, why TEXT, by TEXT, at TEXT NOT NULL, PRIMARY KEY (subject, ns, value));
CREATE INDEX IF NOT EXISTS tag_ns ON tag (ns, value);
CREATE TABLE IF NOT EXISTS tag_meta (
  ns TEXT NOT NULL, value TEXT NOT NULL, band TEXT NOT NULL DEFAULT 'info',   -- bad | warn | ok | info
  label TEXT, why TEXT, set_by TEXT NOT NULL DEFAULT 'derived', at TEXT, PRIMARY KEY (ns, value));
CREATE TABLE IF NOT EXISTS ns_meta (
  ns TEXT PRIMARY KEY, title TEXT NOT NULL, purpose TEXT NOT NULL, graded INTEGER DEFAULT 0, set_by TEXT NOT NULL DEFAULT 'derived');
CREATE TABLE IF NOT EXISTS scan_run (                  -- every scan says what it yielded; a collapse is an alarm, not a zero
  id INTEGER PRIMARY KEY, plugin TEXT NOT NULL, started TEXT NOT NULL, finished TEXT, ok INTEGER, note TEXT, yields TEXT);

-- what happened in the project, whatever produced it (engine/events.js): Home's alerts and activity read this
CREATE TABLE IF NOT EXISTS event (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, text TEXT, ref TEXT, url TEXT, source TEXT, seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS event_at ON event(at);
