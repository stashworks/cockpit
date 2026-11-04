-- GitHub plugin tables, prefixed gh_. Everything here is rewritten by scan.js from gh; nothing
-- is hand-maintained. Stage and attention are DERIVED at scan time from labels and PRs by the
-- rules in stages.json and attention.json, so a card only lists.
CREATE TABLE IF NOT EXISTS gh_issue (
  number      INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,              -- open | closed
  author      TEXT,
  assignees   TEXT NOT NULL DEFAULT '[]', -- json array of logins
  labels      TEXT NOT NULL DEFAULT '[]', -- json array of label names
  module      TEXT,                       -- the module:<key> label, if one
  created     TEXT, updated TEXT, closed TEXT,
  url         TEXT,
  body        TEXT,                       -- first 4000 chars
  stage       TEXT,                       -- derived: see stages.json
  stage_rule  TEXT,                       -- the sentence that put it there
  at          TEXT NOT NULL               -- when this row was written
);
CREATE TABLE IF NOT EXISTS gh_pr (
  number      INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,              -- open | merged | closed
  draft       INTEGER NOT NULL DEFAULT 0,
  author      TEXT,
  head        TEXT, base TEXT,
  created     TEXT, updated TEXT, merged TEXT,
  merge_commit TEXT,
  checks      TEXT,                       -- pass | fail | pending | none (open PRs)
  review      TEXT,                       -- reviewDecision
  mergeable   TEXT,
  url         TEXT,
  tickets     TEXT NOT NULL DEFAULT '[]', -- json [{number, how}] by the linkage rule
  at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gh_attention (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,              -- decide | click | evidence | external | qa | failing
  rank        INTEGER NOT NULL DEFAULT 9,
  who         TEXT NOT NULL,              -- you | <name> | nobody
  number      INTEGER,                    -- ticket or PR number, if one
  what        TEXT NOT NULL,              -- ticket | pr | summary
  title       TEXT NOT NULL,
  text        TEXT NOT NULL,              -- why it is here, one line
  url         TEXT,
  at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gh_env (
  env         TEXT NOT NULL,              -- uat | prod | ...
  at          TEXT NOT NULL,
  version     TEXT,                       -- json as the endpoint returned it
  ok          INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  PRIMARY KEY (env, at)
);
CREATE TABLE IF NOT EXISTS gh_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT
);
CREATE INDEX IF NOT EXISTS gh_issue_state ON gh_issue (state, stage);
CREATE INDEX IF NOT EXISTS gh_pr_state ON gh_pr (state, merged);
