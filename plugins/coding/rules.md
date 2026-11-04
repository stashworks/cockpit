# Coding - how the AI works a project with this plugin on

The Tests tab is the state of the project: the Environment (the live app - tests, flows, doors, contract, backup
and restore) and the Static stages (the map's rules). It runs by itself - on switch-on, after every turn that
touches files, before a promote. Nothing on it blocks you; the owner works its reds with you in the conversation.

## The flows are the functional tests

- Every feature's README has `## Flows`: one line per thing a person does with it, in plain steps
  (`- start-grow: open Start a Grow -> pick a bed -> pick a runbook -> Activate -> see the run on the task list`).
  The flow is the spec. A feature with no flows gets them first, written from what its code does.
- One browser test per flow: `test/<feature>.<flow>.browser.test.js`, header `@feature @kind test @flow @purpose`,
  `const { flow } = require(process.env.COCKPIT_FLOW)`, `flow({ name, feature, look, steps })`.
  `look` opens and reads the screens - it runs everywhere, prod included after a promote, so it never presses
  anything that saves. `steps` clicks and types what a person does - dev only; dev's database is the sandbox;
  make your own rows and sweep them. A red names the step it stopped at and leaves a screenshot in
  `.cockpit/tests/shots/`.
- The map says where the gaps are: `flow without a test`, `flow not clicked through`, `test names unknown flow`.
  When the owner asks you to work the reds, draft one ticket per feature for its missing browser flows - `--flow`
  on each - and let the owner approve; the queue writes them.
- Every ticket names its flow (`--flow <name>`, or `--flow none` with why, for a change no person can see). The
  browser test is in the ticket's create list and is written FIRST: it runs red against today's code, the code
  makes it green. The verdict's "flow" check reads it.
- Nothing goes to prod until every flow clicks through on dev. After a promote the `look` half of every flow runs
  on prod; green closes the tickets, red rolls prod back.

## Working a ticket: read what you are handed, run only what is named

The ticket prompt carries a briefing: every file it names, read for you (what it is, its purpose, the tests that name it),
and the feature's README flows. Open a named file once when the work needs it; do not grep the project for what the
briefing already says. Inside the turn run only the test files the ticket names and the ones you create
(`node --test <file>`, one at a time) - never `npm test` or the whole plan: the engine runs the whole plan after your
turn and the verdict reads that. (a ticket turn was costing a million tokens of reading and re-running.)

Before you end a turn on a ticket: commit, then `ticket check <id>` - the verdict as Cockpit will give it, check by check,
with the map re-read. Put every red line right and check again; end only on green, or say plainly what you could not
make green. A red verdict costs a whole extra turn; the check costs seconds. (43 of the first 55
verdicts were red - most on things the coder could have seen before ending.)

## Deleting

A turn deletes only the files its ticket names under `--delete`. No `git clean`, no `git checkout .` over a dirty tree,
no `rm -rf <directory>`, no delete by wildcard - a cleanup that takes what it was not pointed at destroys work nobody
asked about (2026-09-22: 97 test files, and a whole project's .cockpit folder, in one night). Clear a build folder by
naming that folder, never a parent and never a path assembled from two others. `.cockpit` is the project's memory, not
its code: never yours to remove. The verdict's "nothing deleted that the ticket did not name" check reads git for this.
The engine also refuses those three commands outright in your shell - you will see COCKPIT REFUSED with what to do
instead. That is not a bug to work around: name the files, or ask the owner.

## Five lines to the owner

Your last message of a turn: done or not; what went green or red on the Tests tab; what needs their decision as a
plain yes/no. The engineering goes on the ticket (`ticket comment`).
