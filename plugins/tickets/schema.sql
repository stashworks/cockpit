-- Tickets plugin tables, prefixed tk_. The tickets themselves are files (.cockpit/tickets/<id>.json, engine/tickets.js);
-- these hold what Recent deploys reads: what reached the main branch (from the project's own git, first-parent), and
-- what each environment reports running (the optional version endpoints). Rewritten by scan.js on every read.
CREATE TABLE IF NOT EXISTS tk_deploy (
  sha         TEXT PRIMARY KEY,
  short       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  author      TEXT,
  at          TEXT NOT NULL,              -- committer date, ISO
  merge       INTEGER NOT NULL DEFAULT 0, -- 1 when a merge commit (a PR landed); 0 for a direct commit on the branch
  tickets     TEXT NOT NULL DEFAULT '[]', -- json array of ticket ids the subject or body names: "#123", "L2"
  pr          INTEGER                     -- the PR number when the subject carries one (squash merges: "(#123)")
);
CREATE TABLE IF NOT EXISTS tk_env (
  env         TEXT NOT NULL,
  at          TEXT NOT NULL,
  version     TEXT,                       -- the JSON the endpoint answered
  ok          INTEGER NOT NULL DEFAULT 1,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS tk_env_at ON tk_env (env, at);
CREATE TABLE IF NOT EXISTS tk_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT
);

-- A RELEASE: the moment an environment started serving a different commit. tk_env is every reading; this is only the changes - what actually shipped, and where.
CREATE TABLE IF NOT EXISTS tk_release (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  at TEXT NOT NULL,          -- when Cockpit first saw the new version (its scan interval is the accuracy)
  sha TEXT NOT NULL,         -- what it serves now
  prev TEXT                  -- what it served before
);
CREATE INDEX IF NOT EXISTS tk_release_at ON tk_release (env, at);
