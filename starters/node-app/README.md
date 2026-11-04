# {{TITLE}}

{{PURPOSE}}

- **One Node process, no dependencies, plain HTML/JS.** `server.js` serves `public\` and the
  API; every folder under `modules\` with an `index.js` is a module. No framework, no build.
- **One MySQL 8 database per environment.** Tables are prefixed by module.
- **Two environments on the server:** `{{NAME}}_dev` (:{{PORT_DEV}}, `https://{{NAME}}-dev.local`, where
  code is written — the Cockpit project) and `{{NAME}}_prod` (:{{PORT_PROD}}, `https://{{NAME}}.local`,
  tracks `main`, promoted with `scripts\promote-prod.cmd`). No test environment.
- **The repo holds code, never data or secrets.** `.env` is per checkout and ignored; the data
  lives in MySQL on the server and in its nightly dump.

Run: `node server.js` (reads `.env`, defaults to :{{PORT_DEV}}). Check: `npm run check`.

The rules the AI works under are in `.cockpit\project.md` (not in the repo).

## Flows

What a person does with the app, step by step - the plan every flow test proves (`test\*.flow.test.js`, `@flow <name>`).
A flow names screens and actions; the last step is what the person sees.

- health-check: open / → GET /api/health → see ok

## Backup

- `scripts\backup.js` dumps the database (`DB_NAME` from the environment) to `BACKUP_DIR` (default `..\backups`) as plain SQL
  and prints `{ file, bytes, tables: { name: rows } }` last - what was written, read back.
- `scripts\restore.js <file>` drops every table and applies the file; refuses a database not named `*_test` / `*_dev`
  unless `--prod` (the owner's hand). Prints the same summary.
- Cockpit runs backup → restore → compare on the test database at the end of every test run (the restore drill), and
  reads the age of the newest file in the folder named under `## Backup` in `.cockpit\project.md` (`folder:`, `every:`).

## Tests

- `npm test` runs every `test\*.test.js` with node's own runner; Cockpit runs each file on its own the same way.
- `test\setup-db.js` runs FIRST under Cockpit: it drops and recreates `{{NAME}}_test`, applies `db\schema.sql` and every
  module's `data\schema.sql` + `data\seed.sql`. It refuses any database not named `*_test`. It needs `mysql2` in this
  project (an install the owner approves) or the `mysql` client on PATH.
- A flow test starts the app on a free port against the test database, walks the flow's steps over HTTP, asserts the
  effect, stops the app. `test\health.flow.test.js` is the shape to copy.
- Unit tests sit beside them (`test\<module>.test.js`) for logic that deserves its own proof.
- A browser test (`test\*.browser.test.js`) drives the running app through Chromium for what only a browser can
  prove - rendering, navigation, forms, scripts. Cockpit runs them after the app is up (`APP_URL` set) with its own
  Playwright and Chromium; this project installs nothing. `test\health.browser.test.js` is the shape to copy.
