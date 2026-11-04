-- Database plugin tables, prefixed db_. Everything here is rewritten by scan.js from the live
-- MySQL database through the mysql client; nothing is hand-maintained and nothing is ever
-- written back. The password is not here: the scan reads it from the project's credentials
-- file at scan time and passes it to the client in its environment only.
CREATE TABLE IF NOT EXISTS db_table (
  name        TEXT PRIMARY KEY,
  type        TEXT NOT NULL,              -- table | view
  engine      TEXT,
  rows        INTEGER,                    -- COUNT(*) when exact = 1, else information_schema's estimate
  exact       INTEGER NOT NULL DEFAULT 0,
  data_bytes  INTEGER, index_bytes INTEGER,
  columns     INTEGER NOT NULL DEFAULT 0,
  pk          TEXT,                       -- json array of the primary key's columns
  created     TEXT, updated TEXT,         -- as information_schema reports them (updated is often null on InnoDB)
  comment     TEXT,
  at          TEXT NOT NULL               -- when this row was written
);
CREATE TABLE IF NOT EXISTS db_column (
  table_name  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT,                       -- the full column type: varchar(200), decimal(10,2)
  nullable    INTEGER NOT NULL DEFAULT 1,
  dflt        TEXT,
  key         TEXT,                       -- PRI | UNI | MUL | ''
  extra       TEXT,                       -- auto_increment, on update ...
  comment     TEXT,
  PRIMARY KEY (table_name, name)
);
CREATE TABLE IF NOT EXISTS db_index (
  table_name  TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_unique   INTEGER NOT NULL DEFAULT 0,
  columns     TEXT NOT NULL DEFAULT '[]', -- json array, in index order
  type        TEXT,                       -- BTREE | FULLTEXT | ...
  PRIMARY KEY (table_name, name)
);
CREATE TABLE IF NOT EXISTS db_fk (
  table_name  TEXT NOT NULL,
  name        TEXT NOT NULL,
  columns     TEXT NOT NULL DEFAULT '[]', -- json array
  ref_table   TEXT NOT NULL,
  ref_columns TEXT NOT NULL DEFAULT '[]', -- json array
  on_update   TEXT, on_delete TEXT,
  PRIMARY KEY (table_name, name)
);
CREATE TABLE IF NOT EXISTS db_peek (                   -- the latest rows of each table, as of the scan
  table_name  TEXT PRIMARY KEY,
  columns     TEXT NOT NULL DEFAULT '[]', -- json array of column names, in SELECT * order
  rows        TEXT NOT NULL DEFAULT '[]', -- json array of arrays; cells are strings, null, or truncated with an ellipsis
  order_by    TEXT,                       -- the column the rows are newest-first by, or null for the first rows
  at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS db_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT
);
CREATE INDEX IF NOT EXISTS db_column_table ON db_column (table_name, position);
CREATE INDEX IF NOT EXISTS db_fk_ref ON db_fk (ref_table);
