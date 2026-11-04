# Plan: declared architecture, automated testing, tickets — execution detail

The scope is `scope-verification-and-tickets.md` (agreed 2026-09-18). This is the same plan written
to execute against: per phase the goal, the deliverables with their files in the engine, the tasks
in order, what the owner decides, and **done-when as a read-back** — every phase ends by reading
its effect on a real project, never by claiming it. The first project through every phase is
a pilot project built by Cockpit, from a Cockpit conversation.

Conventions used throughout:
- **Engine files** are paths inside the Cockpit folder. Hot files (cards, scanners, `prompts\`, hot engine modules) need no
  restart; `engine\server.js`, `harness.js`, `plugins.js`, `projects.js`, `index.js` need
  an engine restart — each phase says which.
- **Owner gates** are marked ⛔: nothing past them without the owner's word.
- **Read-back** = the check that proves the phase, run against the pilot project and reported verbatim.

---

## Phase 1 — the tagging matrix

**Goal.** One schema every later phase reads: what a person declares in the code, what each tag is
for, what it applies to, how the scan verifies it, how it changes. Only declared things are in the
matrix — everything Cockpit computes (reads/writes, reach, impact, churn, coverage, sensitivity,
the findings) is the scan reading the code back and belongs to the scan's own rules, not here.

**The idea in one line.** The scan can read what code *does*; it cannot read what code is *for*.
The tags supply the intent; every finding is the gap between the two.

**The matrix** (agreed 2026-09-18; `journey` renamed `flow` — the same word as the graph)

| tag | applies to | used for — the questions it answers | where | values | verified by the scan | changes by |
|---|---|---|---|---|---|---|
| `@feature` | every file | **grouping** — what is this file part of; what features exist and what belongs to each; what am I touching with this ticket; which feature is riskiest, least tested, most changed | file header; the feature's README | any name; a feature exists when its README exists; `shared` for code every feature uses; one feature per file | a tag with no README; a README with no files; a file with two features; a file with none (`untagged`) | ticket |
| `@kind` | every file | **the shape** — which of the four is this; is the code shaped as the architecture says; where does an arrow skip a column or run backwards | file header | `screen` · `action` · `logic` · `data` (tests, scripts and tooling are outside: `@kind test` / `@kind tool`) | the kind disagrees with what the file does (a `logic` file declaring routes; a `screen` reading a table); a value not in this list | the schema |
| `@flow` | screens, actions, tests | **paths and testing** — which user paths does this file take part in; which test proves each path; if I change this file, which paths must be re-tested; which paths have no test; what does a person actually do that this code serves | headers of screens and tests (actions inherit from the screens that call them, may declare too); defined in the feature README's `## Flows` as `- name: step → step → step` | the README's list | a flow with no test naming it; a test naming an unlisted flow; a screen naming a flow its feature does not define; a flow whose steps name an action that does not exist | ticket |
| `@purpose` | every file | **understanding** — what is this file for, in one sentence, so anyone opening it knows before reading the code | file header | one sentence | missing; longer than a sentence (info) | ticket |
| README `## Tables` | the feature's README | **ownership** — who owns this table; who else writes it, and should not; which feature's data does this change reach | the feature's README | the table names the feature owns | an owned table written from another feature; a listed table nothing defines; a table nobody lists (`unowned`) | ticket |
| `@auth` *(reserved)* | actions | **intended access** — what is this door supposed to require, so the scan can compare with what it does | action file header | `none` · `user` · `admin` · a permission name | the declared requirement disagrees with the check the code makes; missing once required | the schema (to require it), then ticket |
| `@sensitive` *(reserved)* | data | **intended exposure** — what a table holds when its name and columns do not say | schema file header or README `## Tables` | `money` · `personal` · `credentials` | overrides inference; missing once required | the schema, then ticket |

**Not tags, computed instead** (a claim would be the lie the doctrine warns about): which tickets
touched a file (`git log` on the file - every commit and PR names its ticket), reads/writes, reach,
impact, churn, coverage, sensitivity by inference, the findings.

**Precedence.** Hand-set in Cockpit (the owner's) > declared in the code > inferred by the scan.
Untagged shows as untagged; the count per feature is the migration progress on an old codebase.

**Adding a tag later.** A tag enters through the schema (a ticket); its `applies to` says whose job
it is to carry it, so the next scan lists every file that should carry it and does not
(`tag-missing: <tag>`, per feature) - the rollout is one ticket per feature slice and the count
falling to zero is the read-back. A tag not in the schema is `tag-unknown`: nothing enters through a
single file.

**Header syntax.** One tag per line, or all on one line; the comment form of the language:
```
// @feature tasks
// @kind action
// @flow add-task, list-tasks
// @purpose The routes for tasks: who may ask, then hand off to logic.
```
`-- @feature tasks` for SQL, `<!-- @feature tasks @kind screen -->` for HTML. Read from the first
40 lines of a file.

**README contract** (`modules\<name>\README.md`): an `@feature <name>` line, one paragraph of
purpose, `## Tables` (one per line), `## Flows` (`- name: step → step → step`, a step is a screen
or an action by name), optionally `## Seed` (what the flows need in the test database).

**Deliverables**
1. `plugins\architecture\tags.json` — the matrix above as data: per tag `declared`, `appliesTo`,
   `usedFor`, `where`, `values`, `verify` (the finding ids), `changesBy`, `required` (false for the
   reserved two); the header syntax and the README contract as fields, so the doc generator and
   the scanner read one source. A `_note` records why each rule is as it is.
2. This section, corrected by the owner.

**Tasks, in order**
1. Write `tags.json` from the table (Cockpit, this session).
2. ⛔ Owner corrects and approves.

**Owner decides:** the kind names as they stand; `shared` as the name for common code; whether
`@purpose` is required on every file from day one or rolled out like a later tag (proposal:
required on new files, `tag-missing` on old ones).

**Done-when.** `tags.json` exists and parses; `node -e "const t=require('./plugins/architecture/tags.json');Object.keys(t.tags).forEach(k=>console.log(k,t.tags[k].appliesTo))"`
prints the seven tags with what they apply to; the owner has said "approved".

---

## Phase 2 — the reader, on an existing project first (adjusted 2026-09-18)

**Goal.** The scanner reads declarations - from file headers and feature READMEs when they exist,
and from a **mapping file** that holds the same declarations outside the code when they do not yet -
prefers them to inference, and reports where a declaration and the code disagree. Proven on an
existing, large, untagged codebase before any project is born tagged: the owner retrofits first.

**The mapping file** - `.cockpit\plugins\architecture.declared.json`, the migration aid from the
scope. The same vocabulary as the headers and READMEs, held in one place:
```
features: { <name>: { purpose, tables: [..], flows: [ { name, steps: [..] } ] } }    <- the README equivalents
files:    { "<path>": { feature, kind, flow: [..], purpose } }                        <- the header equivalents
```
Precedence: **hand-set in Cockpit > declared in the code > mapped (this file) > inferred**. The
views show all four states; a mapped entry whose file later gains a matching header is reported as
redundant, so the file empties as the code becomes self-describing (a later, separate project of
tickets - not in this plan). The file lives in `.cockpit\` and is not committed for a repo whose
owner has not decided to carry it.

**Deliverables**
1. **The draft** - `cli declare --draft` (route `POST /api/p/:id/declared/draft`, `server.js`):
   writes the mapping file from what the map already knows - `feature` from the project's path
   rules, `kind` from the layer, `tables` from ownership, `purpose` empty, `flows` empty - one
   entry per file, so every claim is reviewable before it counts. Never overwrites an existing file
   (`--force` to redraft); `cli declare` shows the counts.
2. **Filling it** - the project's own AI, in its conversation: flows per feature from the
   screen → action → table chains it can see; a purpose sentence per feature first, per file over
   time. The gate applies: the AI edits the mapping file, never the code, for this.
3. **The reader** in `scan.js`: headers (`@feature @kind @flow @purpose @auth @sensitive`, first
   40 lines, the language's comment form), feature READMEs (`@feature`, `## Tables`, `## Flows`),
   the mapping file; precedence applied; `domain` and `layer` tags carry their source; a `declared`
   lens per file (declared / mapped / inferred / untagged - the counts are the migration progress);
   flows become nodes (`flow:<feature>/<name>`) with edges to the screens, actions and tests that
   name them and to their feature; the 18 checks from `tags.json` as Problems values (a
   `decl: true` group in `problems.json`); `file-untagged` is a lens value, not a finding (it
   would swamp an old codebase).
4. **The views**: a **Declarations** block on Problems between AI slop and Process slips; the
   declared / mapped / inferred / untagged split on each Features card; `declared` in the colour-by
   bar; flows listed on a feature's card once they exist.
5. **The gate line** in `prompts\global.md`: a new file carries `@feature`, `@kind`, `@purpose`;
   a new screen, action or test its `@flow`; on a project with a mapping file, a new file is
   added to the mapping file instead until the tickets move the declarations into the code.
6. **Practice checks in the reader**: `vulnerable-dependency` (`npm audit` per scan, band by
   severity), `env-example-incomplete`, `migration-edited-after-run`, `lockfile-missing`.
7. **The starter and the generated docs** (`gen-docs.js` → `ARCHITECTURE.md`, the README template;
   the four-kind module layout; lockfile + `npm ci`) are built as the schema's other reader but not
   exercised on a new project until the owner starts one.

**Tasks, in order**
1. The draft route and cli; draft the owner's existing project; read the counts back.
2. The reader: headers, READMEs, mapping; the `declared` lens; precedence; the flow nodes.
3. The checks, the Declarations block, the cards, the colour-by lens.
4. ⛔ Owner: the project's AI fills flows and purposes for one feature; rescan; review the findings.
5. The deliberate-break test (below); then the practice checks; then the starter and docs.

**Owner decides:** which feature is filled first; whether `purpose` per file is worth the AI's time
on an old codebase or per feature is enough until the tickets.

**Done-when (read-back).** On the existing project: `cli declare` reports every file mapped
(`mapped` = the file count, `inferred` 0, `untagged` 0) with `declared` 0 until headers exist;
one feature has flows and purposes filled and the Features card lists its flows; changing one
mapping entry's kind from `logic` to `screen` on a file that reads tables and rescanning produces
exactly one `kind-disagrees` finding, and restoring it removes it; adding a flow step that names a
missing action produces one `flow-step-missing`. Restart needed: yes (`server.js`, the draft route).

---

## Phase 3 — the automated testing system

**Goal.** Tests run in Cockpit, locally, and Cockpit reads the result per flow, feature and (later)
ticket — so a change is proven by tests before a ticket can close.

**Deliverables**
1. **Test layers, as conventions in `ARCHITECTURE.md` and the starter:**
   - **unit** — `test\*.test.js`, `node --test`, a logic module's own behaviour;
   - **flow** — `test\*.flow.test.js`, header `@flow <name>`: starts the app against a
     **test database** (`<name>_test`, created empty, schema applied, seeded), drives the flow's
     actions in order over HTTP, asserts the rows in the tables the README names, and tears down;
   - **screen** — `test\screens\*.screen.test.js`, a browser (Playwright, an install the owner
     approves per machine) for flows marked `critical: true` in the README — not in the first
     cut; the convention is reserved;
   - **UAT** — a person on the step before prod; not automated; recorded on the ticket (Phase 4).
2. **Test data** — `modules\<name>\data\seed.sql` owned by the feature; the flow runner applies
   `schema.sql` then every module's `seed.sql` into the test database; reset = drop and recreate
   before each run. A flow never depends on data another flow left behind.
3. **The runner** — `engine\tests.js` (hot module) + a route `POST /api/p/:id/tests/run`
   (`server.js`, restart): runs `npm test` (or the project's configured command, in `project.md`
   under an `## Environments` / `## Tests` section) in the project folder with `NODE_ENV=test` and
   the test database name; captures the `node --test` reporter output (`--test-reporter=tap` or the
   JSON reporter) into `.cockpit\tests\<timestamp>.json`; one run at a time per project; a
   `/tests` slash command and a cli `tests` command; the room card **Tests** (or the existing Test
   coverage view) shows the last run: pass / fail per file, per flow (from the `@flow`
   headers), per feature.
4. **Coverage becomes real** — the Test coverage lens: a file is `tested` when a test *that passed
   in the last run* names it; a flow is `covered` when its flow test passed; the Features
   cards' tests line = flows covered / flows declared; the graduation rule as a Problems check
   `flow-failing` (bad) and `flow-untested` (warn).
5. **Environments in the rules** — `project.md` gets a fixed `## Environments` section the engine
   parses: an ordered list (`dev → prod` or `dev → uat → prod`), each with its folder, URL, database
   and PM2 name; the last before prod is the human gate. Cockpit reads it for the ticket states
   (Phase 4) and for `/status`.
6. **Smoke test after promote** — the promote script (`scripts\promote-prod.cmd` in the starter)
   ends by reading the promoted environment back: the health endpoint and one flow test against it;
   a failure restores the previous release (attempt → verify → restore → verify → log) and says so.
   "Promoted" is a claim until it answers.
7. **Second-model review, optional** — a per-project switch in `project.md` (`review: <harness>` or
   none); when set, after a ticket's work the review harness gets the diff and the ticket, answers
   once, and its answer is attached to the ticket; the working AI decides. No loop. Built in Phase 4
   where the ticket exists; designed here.

**Tasks, in order**
1. Test database convention + `seed.sql` in the starter; the flow test template runs the module's
   one flow end to end on a scratch project.
2. `engine\tests.js` + route + slash/cli; the report file; the Tests view (last run, per flow).
3. The lens and the cards read the last run; `flow-failing` / `flow-untested` checks.
4. `## Environments` parsed from `project.md`; `/status` shows the chain.
5. ⛔ Owner: approve any install the screen layer needs (deferred until a flow is marked
   critical); confirm the test database naming (`<name>_test`) and who creates it (the AI, in the
   bootstrap playbook step 8).

**Status 2026-09-18 — built, with the portable tooling decision.** Every stage in
`plugins\architecture\stages.json` is built except the per-role permission matrix (waits on `@auth`
becoming required) and sustained load (when a project is customer-facing). What landed beyond the
list above, and the decisions behind it:

- **Portable tooling, nothing installed** (the browsers for both Windows and Mac inside the
  folders so there is no install; ZAP without a Java install → Java is a *folder*, not an install).
  `tools\fetch.js` keeps Chromium (Playwright), OWASP ZAP and a Java runtime as archives under
  `tools\dl` for Windows and Mac (Apple silicon), ~1 GB, gitignored; unpacked for the machine on
  first use. Playwright is the engine's own dependency; a project's test reaches it through
  `NODE_PATH`. The Plugins page has a "Test tooling" section with the download-on-host button.
- **Functional** — `test\*.browser.test.js` run after the app is up (`APP_URL`); a failing
  flow fails the run. Proven on the pilot project (Chromium unpacked on the engine's machine at first use; 5.9 s).
- **DAST** — `engine\dast.js`: ZAP headless from the folder, seeded with the map's doors,
  spider → active scan → alerts by risk under the DAST stage; on demand (`/tests dast`, the
  button). **Input probe** — `engine\fuzz.js`: every run, hostile payloads in every field each
  door reads; crash / leak / reflected / slow. Fixture `test\fuzz.js`.
- **Signed-in pass** — `## Tests login: / user:`; probe, contract (`<route> (user)`) and
  fuzz again as the test user. Fixture `test\signed-in.js`.
- **Performance** — every GET door timed alone, ten at once on the health door and the five
  slowest; `budget:`; regression against the previous run. Fixture `test\perf.js`.
- **Restore drill** — the starter's `scripts\backup.js` / `restore.js`; backup → restore →
  compare on the test database every run; `## Backup folder: / every:` for the real backups'
  age. Fixture `test\restore.js`. (The pilot project needed its `DB_PASSWORD` before the drill and
  `setup-db` can run for real.)
- **Smoke** — `promote.js` runs the `smoke:` browser flows against the promoted URL.
- **Lint everywhere** — formatting drift without a tool; prettier / eslint when the project has
  them. **Four kinds** — `file-without-kind`. Fixture: 47 planted checks.
- **Feature cards** — a doors row (probed / open / hurt) and "least proven by runs".

**Done-when (read-back).** On the pilot project: `/tests` runs the module's flow test against `<name>_test`
and the Tests view shows it passing with its flow name; the Features card shows `1 of 1 flows
covered`; commenting out an assertion so the test fails and running again turns the flow red and
raises `flow-failing`; restoring it clears both. Restart needed: yes (`server.js`).

---

## Phase 4 — tickets

**Goal.** A change enters through a ticket the owner approved with the impact in front of him, is
worked and verified automatically, waits at the step before prod for a person, and closes only when
the rescan proves its done-when.

**Deliverables**
1. **The ticket template** (`plugins\github\ticket.md`, used by Create ticket and by the AI when it
   files one): title · feature · kinds touched · flows touched · doctrine rules and how the
   change honours them · **files to create** · **files to alter** · tests required (the flows'
   tests, plus new ones) · done-when as a read-back · the impact analysis (pasted by Cockpit) ·
   labels `feature:<x>`, `kind:<y>`, `risk:<band>`.
2. **Impact analysis** — `engine\impact.js` (hot) + `POST /api/p/:id/impact {files}`: from the map,
   for the declared files: the worst impact score; the blast radius (everything that reaches them,
   rolled up to features and to **flows** — the flows become the ticket's required tests);
   fragility (churn, tested); shape crossings (a screen and a table in one ticket; two features);
   a ticket risk band on the 5×5 (likelihood from what is altered — new file 1, quiet covered file
   2, busy 3, hot or untested 4, hot untested god file 5 — × the impact). Shown on the Create ticket
   card and pasted into the issue.
3. **Create ticket** — from a finding (the Problems card, with the scope) or from a blank form on
   the Architecture tab; the AI proposes the file list from the scope; Cockpit runs the impact
   analysis; ⛔ the owner approves; Cockpit files a GitHub issue through the project's GitHub
   account (`engine\ghauth.js`, `gh issue create`) with the template filled and the labels; the
   issue number is written as a hand-set tag `ticket:#<n>` on every subject in the scope (survives
   rescans; the finding shows "in ticket #n"; the Features card counts open tickets from the GitHub
   plugin's `gh_issue` table filtered by `feature:` label).
4. **The gate, enforced** — `prompts\global.md`: no ticket, no code; the ticket's number named in
   the first line of the work; the header tags on new files; the doctrine rules named; the effect
   read back. The queue manager: a queue item may carry `ticket:#n`; the agent's turn gets it in the
   prompt.
5. **Verify (automated)** — when a turn that touched files ends (the existing rescan hook), if the
   turn carried a ticket: `engine\verify.js` compares the scan before and after on the ticket's
   scope — findings down, no new red curves, coverage not down, no new slop — and the files touched
   against the declared list (**undeclared change** and **declared but untouched** as findings on
   the ticket); runs the tests (Phase 3); writes a verdict to `.cockpit\tickets\<n>.json` and, when
   GitHub is on, a comment on the issue. Green = the ticket moves to *verified*; red = back to *in
   work* with the failure attached.
6. **States** — created → in work → verified → passed <the step before prod> (⛔ a person marks it,
   from the ticket card, after UAT) → promoted (⛔ the owner's word; the promote script records it)
   → closed when the rescan on the promoted environment confirms done-when. Kept in
   `.cockpit\tickets\<n>.json`; mirrored to issue labels `status:<state>` when GitHub is on.
7. **On the map** — a finding shows its tickets and *in a ticket / unticketed*; the AI's discussion
   notes save onto the finding (`POST /api/p/:id/finding/note`, stored in the map's `chat_note`-like
   table, shown dated with the model); each Features card shows open tickets; the Problems view
   gains a filter *unticketed only* — the backlog.
8. **Second-model review** — the switch from Phase 3 wired: after work, before verify.
9. **Commits and PRs name the ticket** (`#41: …`) — part of the gate; it is what makes "tickets that
   touched this file" computable (`git log` on the file), shown on the file card and in the impact
   analysis. No ticket list in headers, ever.
10. **CODEOWNERS generated from the READMEs** when GitHub is on — ownership declared once in the
    README (`@feature`, an optional `@owner` line), enforced by GitHub's reviewers.
11. **CHANGELOG generated from the closed tickets at promote** — the release notes are the tickets;
    nothing is written twice.

**Tasks, in order**
1. The template and `impact.js`; the Create ticket card with the impact shown; filing to GitHub;
   the `ticket:#n` tag.
2. The gate text; the queue item carrying a ticket.
3. `verify.js` on the rescan hook; the verdict file; the issue comment.
4. States and the ticket card (create / in work / verified / passed / promoted / closed); the promote
   script writes *promoted*.
5. Notes on findings; open tickets on Features; the unticketed filter.
6. ⛔ Owner: the first real ticket on the pilot project, from a finding, approved with its impact in front of
   the owner; the AI works it; the verdict comes back; UAT on dev; promote on the owner's word; the rescan closes
   it.

**Owner decides:** the exact template wording; the risk band that forces a split (proposal: a
*critical* ticket must be split or carry a second-model review); whether a *verified* ticket may
be promoted without UAT for a project with only dev → prod (proposal: no — UAT on dev is the
gate, however small).

**Status 2026-09-18 — built through item 11; the first real ticket (task 6) waits on the owner.**
- **Corrected the same evening (owner): tickets come out of the CONVERSATION, not a form.** "We talk and then
  you create the ticket." The Create-ticket form was removed. The path now: the change is agreed in the chat →
  the AI drafts (`cli ticket draft --title --feature --alter --create --what --done`; `ticket adopt --number`
  for an issue pulled from GitHub) → the draft waits on the Tickets card under *new tickets* with the impact
  beside it → the owner edits (feature = a dropdown of the map's features + earlier tickets' + "new", for one
  name per feature), **Approve and file** (the number goes at the FRONT of the title: `#7: …`), Reject, or
  Discuss (back to the chat). The finding card's *Create ticket* asks the AI in the chat to draft one for the
  scope. Doctrine and Why are the AI's to fill; the owner sees What, Files, Done-when, Impact.
- `engine	ickets.js` (impact, draft, create, states, afterScan), `engineerify.js`, `pluginsgithub	icket.md`,
  routes `impact`, `tickets`, `tickets/draft`, `tickets/:id[/state|/comment]`; the Create-ticket form on the
  Problems card (live impact, preview, Ask the AI, File = the gate); the tickets strip and the backlog toggle;
  the Tickets card (shell/cards/tickets.js) with the two human moves; the File card's "touched by".
- A turn names the ticket (`#12` in the message, or `/queue P2 #12 …`) → the ticket body rides in the prompt,
  in-work, scope snapshot → tests + rescan land → verdict (6 checks) → verified or back with the reason on the
  issue. passed → promoted from the promote's commit range; promoted → closed when the finding is gone.
- Second-model review: `## Review review: <harness> [model]` - read-only, one answer, on the ticket.
- CHANGELOG.md from the promoted tickets (promote.js); `cli codeowners` from README `@owner` lines.
- Not built: notes saved onto a finding (the chat's screen context made it moot - the conversation IS the note,
  and `/note` records a ruling on the thread).
- ⛔ Owner: the exact template wording (pluginsgithub	icket.md is the proposal); the split rule (critical →
  split or second-model review - implemented as advice on the form, not a block); UAT before promote on a
  dev → prod project (implemented: verified → passed is a human click, always).

**Done-when (read-back).** On the pilot project, one ticket goes through every state with nothing done by hand
except the two gates; the issue carries the impact analysis and the verdicts; the finding it came
from shows the ticket, then shows the count fallen after promote; an undeclared file touched during
the work appears as a finding on the ticket. Restart needed: yes (`server.js`, `harness.js`).

---

## Phase 5 — maintenance and maturity

**Goal.** The system keeps itself honest without a person remembering to.

**Deliverables**
1. The schema changes by ticket only; a change to `tags.json` regenerates `ARCHITECTURE.md` in every
   project on its next scan (the file carries the schema version; a stale one is a finding).
2. The standing backlog from every scan: untagged files, tags without READMEs, flows without
   tests, failing flows, unticketed findings — visible on the Features cards and the Problems
   view; the trend per check and per feature shows whether new work adds slop.
3. The doctrine inbox review: monthly or at five notes, promoting lessons into `doctrine.md`.
4. Cockpit's own engine opened as a Cockpit project (owner's to-do), so its lessons and scans have a
   home.
5. Later, when a question the pages do not answer comes up: ad hoc reports over the tags (a query,
   a saved report). Not before.

**Status 2026-09-18 — built; the reviews are the owner's.**
1. `enginearchdoc.js`: ARCHITECTURE.md generated from tags.json (schema version in its first line) into a project
   when missing or generated on an older schema; a hand-written one is a finding, never touched;
   `cli architecture-doc [--force]`.
2. The standing backlog on the Problems view (findings, not in a ticket, files untagged, features without a README,
   flows without a test, flows failing) with the move since the previous scan; per-feature findings in the history,
   a trend line on each Features card. History is written last, so every check is counted.
3. `doctrine-review-due` (five notes or the oldest over 30 days) under the Process stage; `/lesson review` puts the
   inbox into the chat for the review the owner holds with the AI - doctrine.md stays his to edit.
4. The engine is a Cockpit project (`cockpit-engine`, architecture plugin on; 256 files, 322 findings, all untagged
   - its own backlog). ARCHITECTURE.md landed in the engine repo.
5. Ad hoc reports: not built, by design.

**Status 2026-09-18 — the Database plugin (ticket D1), built.** `plugins\database\`: a scan every
10 minutes while the room is open reads the project's live MySQL database through the `mysql`
client (zero-install; PATH or the newest MySQL Server install) into `db_table / db_column /
db_index / db_fk / db_peek / db_meta`; the Database card lists every table (rows, size, columns,
last change, what code touches it) and opens one to its latest 50 rows, columns, indexes, keys
and files. Credentials come from the file the wizard names (`.env` with `DB_*`, a PHP config
returning host/dbname/username/password, or a `mysql://` `DATABASE_URL`); the password goes to
the client as `MYSQL_PWD` only and is never stored, logged or shown. Caps in code: 50 rows, 300
chars a cell, exact counts under 2M rows. Two drift checks in the architecture scan, rules in
`problems.json`: `table-not-in-db` (code names a table the database lacks) and
`table-nothing-touches` (the database holds a table no code touches; the table goes on the map
so the finding has a subject). Read-back on a PHP site: 24 tables = `information_schema`'s
24; `readings` 6,739 = 6,739; no password bytes in cockpit.db; the fixture counts 49 (47 + 2) and
both checks go silent when the planted read is removed. Not in this cut: Postgres (reported,
not read), owner-written SQL, any write. The pilot project could not be the first project through it: its
`.env` names a database that does not exist on the engine's MySQL yet.

**Done-when.** Two consecutive weekly reviews with the backlog visible and shrinking on the pilot project; the
first doctrine review held.

---

## Order and dependencies, in one line each

1. Matrix (design) → 2. docs + starter + reader (needs 1) → 3. testing (needs flows from 1–2 and a
project from 2) → 4. tickets (needs 3, so done-when is provable) → 5. maintenance (needs all).

## Not in this plan

An own ticketing system · ad hoc reports · multi-model review loops · project-specific mapping files
as anything but a migration aid · the screen (browser) test layer beyond its reserved convention ·
conventional-commit *types* (the ticket carries that) · semantic-version ceremony (a date-stamped
promote is enough) · ADR folders (the doctrine inbox and the notes on findings are that) · pre-commit
hooks (the gate runs in Cockpit; hooks fight the AI) · ticket numbers in file headers (computed from git).
