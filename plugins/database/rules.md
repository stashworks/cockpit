# Database plugin — how you work the live database

The Database card shows the project's MySQL database as the last scan read it: every table
with its rows, size, columns, last change and what code touches it; one click opens a
table's latest 50 rows, its columns, indexes, foreign keys and the files that read or write
it. **Everything is read through the `mysql` client into the project's `db_` tables
(`db_table`, `db_column`, `db_index`, `db_fk`, `db_peek`, `db_meta`); nothing on the card is
hand-maintained and nothing is ever written to the database.**

## What it reads, and from where
- The credentials file the wizard names (default `.env`): `DB_HOST / DB_PORT / DB_NAME /
  DB_USER / DB_PASSWORD`, or a PHP file returning `['host', 'dbname', 'username', 'password']`,
  or a `DATABASE_URL` that is `mysql://`. The password is read at scan time, handed to the
  client in its environment, and **never stored, logged or shown** — not in cockpit.db, not
  in the ledger, not in a reply of yours. If a probe of yours ever prints it, say so.
- Postgres (`DATABASE_URL=postgres://…`) is not in this cut: the scan reports that in one
  line and stops. Do not work around it with a driver — nothing is installed here.
- Caps are code, not settings: 50 rows per table, cells cut at 300 characters, exact
  `COUNT(*)` only under two million estimated rows (above that the estimate shows with `~`).

## When the plugin has just been set up
1. `scan database` — run it, wait, read the **yields** (tables, views, columns, indexes,
   keys, rows, peeked) and the note. Say them to the owner in one line.
2. If the scan failed, say exactly why (its note: the credentials file, the user, the
   client) and what the owner has to do — you cannot fix a password or install a client.
3. Then `scan architecture` if that plugin is on: the two drift checks live there and need
   both scans to have run. Report what they found, as findings, not verdicts:
   - **table-not-in-db** — the code names a table the database does not hold: a rename, a
     migration not yet run, a test-only table, or prose the scanner took for a table.
   - **table-nothing-touches** — the database holds a table no code here reads, writes or
     defines: dead data, or owned by something outside this repo.
   Ask the owner which, one short list, and stop. A table he answers for is settled with
   `tag table:<name> reach <value> "<why>"` — the finding does not come back.

## Going forward
- When the owner asks what a table holds, what its columns are, or what is in it right now:
  read the card's own queries (`plugins/database/queries.json` names them) — never guess
  from a schema file, and never open a connection of your own. If the snapshot is older
  than the question needs, run `scan database` first and say when it was read.
- The peek is **as of the last scan** (every 10 minutes while the room is open, or on ↻).
  Say "as of <time>" when you quote a row.
- A row you show the owner is his data; quote it, do not summarise it into something it does
  not say.
- Never write to the database from THIS plugin's tools, on any project: no INSERT, UPDATE,
  DELETE, DDL. The project's own tests are the one writer of the database they are declared
  for (`database:` under `## Tests` - on a dev checkout that is its own database, which is
  the sandbox; never prod), and a change to real data is the owner's hand.
