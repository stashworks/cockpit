# Scope: declared architecture, automated testing, tickets — in phases

Agreed 2026-09-18. Everything here is built in Cockpit; the first project through it
is a pilot project, built by Cockpit. No project-specific references in the design.

## Principles (settled)

- **The codebase declares.** Headers and feature READMEs carry the architecture; nothing in the
  code knows Cockpit exists (`@feature`, `@kind`, `@flow`, `ARCHITECTURE.md`).
- **The ticket system maintains.** Nothing in the code or its declarations changes except through a
  ticket.
- **Architecture verifies — QA and IV&V.** Cockpit reads what the code declares and what it does,
  and reports where they disagree. It never edits declarations, fixes findings, or closes tickets.
- **Humans at two gates:** ticket creation, and the last step before prod. Everything between is
  automated; the map and the tests are the reviewer.
- **Every finding is fixed;** the risk matrix sets the order. One slice = one ticket.
- **Tests run in Cockpit, locally.** GitHub is optional per project (tickets live there when its
  plugin is on; an own ticketing system is later). Testing is not optional.

## Phase 1 — the tagging matrix (design)

The schema everything else reads. A file in the architecture plugin (like `problems.json`), one row
per tag: **tag · where it goes · allowed values · declared or computed · how it is verified · how it
changes**.

- Declared, in the code: `@feature` (its README is the vocabulary entry), `@kind`
  (screen | action | logic | data), `@flow` (on screens, actions and tests; defined in the
  feature README's `## Flows`). A README also names the tables it owns.
- Computed, never declared: reads/writes, reach, impact, churn, tested, sensitivity, problems, the
  inferred layer. A declared claim about any of these would be the lie the doctrine warns about.
- Verified every scan: a tag with no README, a kind not in the schema, a flow with no test, a
  header that disagrees with what the file does, an owned table written from elsewhere.
- Changed only by ticket; the findings above are the maintenance backlog.
- The plugin **generates** `ARCHITECTURE.md` and the README template from this schema, so the doc a
  stranger reads and the rules the scanner enforces are one source.

Deliverable: the schema draft, corrected by the owner. Nothing below starts before it is agreed.

## Phase 2 — conventions, starter, reader

- `ARCHITECTURE.md` (the four kinds, the one-column-right rule, the three tags — a page, portable).
- The feature README template (`@feature`, purpose, owned tables, `## Flows`).
- The header line format for code, SQL and HTML.
- The starter: a new project and a new module are born as the four kinds
  (`modules\<name>\screens\`, `actions.js`, `logic.js`, `data\`) with the docs, a first feature,
  one flow and its test, the tags in place.
- The reader, in the scanner: declared beats inferred; declared / inferred / untagged per file (the
  migration progress for an old codebase); the disagreement checks as Problems findings.
- Proof: the pilot project's first module built by Cockpit through the starter, and the map reads it without a
  mapping file.

## Phase 3 — the automated testing system

Comes before tickets, so a ticket's done-when can be proven.

- Layers: **unit** (a logic module does what it says) · **flow** (log in → a feature's actions
  in order → the right rows in the right tables; API-level against the dev server, fast, no browser)
  · **screen** (a browser drives the critical flows only) · **UAT** (a person, on the step before
  prod).
- The flow test format, named by `@flow`; the feature README's flow list is the
  contract.
- Test data: the seed a flow needs, who owns it (the feature), reset between runs.
- Cockpit's own runner (local, PM2-hosted), the report it writes, and the plugin that reads it:
  pass/fail per flow, feature and ticket.
- Test coverage becomes *flows with a passing test*; the Features cards' tests line becomes real
  coverage; the graduation rule (a change to a feature leaves every flow of it passing) made
  mechanical.
- Environments per project, in its rules: dev → prod, or dev → uat → prod; the last step before prod
  is the human gate.
- Optional second-model review: one pass, the reviewer reports, the ticket's own AI decides, no
  loop; a per-project switch, off with one model.

## Phase 4 — tickets

- **Template:** feature · kinds touched · flows touched · doctrine rules and how the change
  honours them · **files to create and files to alter** · tests required · done-when as a read-back
  (the count fell, the curve went grey, the flow passes).
- **Impact analysis at creation** (the owner's gate): from the declared file list, the map computes
  the impact (worst of the altered files), the blast radius rolled up to features and flows (the
  flows that must be re-tested), fragility (churn, coverage), shape crossings, and a ticket risk
  band on the same 5×5 matrix — seen before approval, so a ticket can be split or given more tests.
- **Create ticket from a finding:** the context loaded — meaning, doctrine rule, matrix, where it
  bites, trend, features by risk, and the picked scope with each file's L×I.
- **Where:** a GitHub issue when the plugin is on (labels carry feature and kind); Cockpit's own
  system later, not now.
- **The gate:** no ticket, no code; new files carry their tags; the doctrine rules named before
  writing; the effect read back after.
- **Work:** the AI in conversation, or the queue manager hands the ticket to an agent when agents
  are on; code and the named tests written together; a PR names the ticket where GitHub is used.
- **Verify (automated):** the tests, and the map's before/after on the ticket's scope — findings
  down, no new red curves, coverage not down, no new slop. **Undeclared change:** files touched but
  not declared are a finding on the ticket; declared but untouched is reported.
- **States:** created → in work → verified → passed <the step before prod> → promoted (owner's
  word) → closed when the rescan on the promoted code confirms done-when.
- **On the map:** a finding links its tickets and shows "in a ticket / unticketed"; the AI's
  discussion notes save onto the finding (dated, model); each Features card shows its open tickets.

## Phase 5 — maintenance and maturity

- The matrix changes by ticket; orphaned tags, missing READMEs and untested flows are the standing
  backlog the scan produces.
- Tests grow by tickets; the trend per check and per feature shows whether new work adds slop.
- Ad hoc reporting over the tags (a query, a saved report) — later, when a question the pages do not
  answer comes up.
- Cockpit's own engine opened as a Cockpit project (owner's to-do).

## Not now

An own ticketing system · ad hoc reports · multi-model review loops · project-specific mappings as
anything but a migration aid.
