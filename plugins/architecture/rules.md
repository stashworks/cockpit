# Architecture plugin — how you work the map

The map is Cockpit's graph: nodes (site › folder › file, plus database tables), edges
(include, link, form, fetch, script, import, reads, writes, defines) and tags in lenses
(kind, reach, data, problem). It is **measured from the code by a scan**, not guessed. You
drive the scan and keep the map honest; the owner decides what things mean.

Scanners by project type: `website-php` — a website: PHP pages, HTML, scripts, styles, SQL in strings, `markdown`
(notes and wiki-links), `typescript` (a pnpm/turbo monorepo: kinds page · component ·
route · worker · service · module · script · migration · test; `import` edges resolved
through workspace packages; `fetch` from a web file naming `/api/...` to the router mounted
there; `reads`/`writes` from SQL strings and Kysely calls; `defines` from a migration to
the table it creates).

## The tool

Everything below is one command, given to you in the engine's note at the top of your
instructions: `node <cli> <project> <command>`. Run it with no command to see the list.
It returns JSON. Do not reach into `.cockpit\` by hand; the tool is the only door.

## When the plugin has just been set up

1. `scan architecture` — run it, wait for it, read the **yields**. Say them to the owner
   in one line (files, pages, tables, edges).
2. `lenses`, then `graph --lens reach` — find what nothing points at.
3. Report **findings, not verdicts**: "8 files nothing points at: …" A file nothing points
   at is an entry point, a scheduled script, an API called from outside, or dead — and
   they all look the same to the scanner. Ask the owner which, one short list, and stop.
4. When the owner answers, record it so it survives every rescan:
   - a whole value means something different here → `grade <ns> <value> <band> [label] [why]`
   - one file is an exception → `tag <subject> reach entry-point "<why the owner gave>"`
   Then say what you recorded, exactly.

## Going forward

- After the owner changes code that adds or removes an include, link or table, offer a
  rescan; say what moved in one line (compare yields).
- If a rescan's yields **collapse** (tables 68 → 0, pages 16 → 0) the scanner broke, not
  the site. Say so; do not report it as a clean result.
- Never re-grade something the owner graded. If you think a grade is wrong, say why and
  ask; the map is his.
- `kind` is a heuristic (a "page" renders HTML or echoes). When the owner says a file is
  an API or a handler, tag it and move on; do not argue with the regex.

## The project's files are the owner's

**Never change the project's files to make the map nicer.** Not the encoding, not the
line endings, not an arrow in a note, not a stray include. The scan READS. If you think a
file should change, say so and stop; the owner changes it or tells you to. (2026-09-16: a
turn rewrote every note in the owner's vault to "normalise" it. That is the one thing this
plugin must never do.)

## How the Architecture card lays this project out

The card's Flow view is driven by **this project's** file:
`.cockpit\plugins\architecture.layout.json` - the columns, what lands in each (by kind,
nodeKind, tag, role: source|hub|sink|isolated, or folder prefix), and which edge kinds are
drawn. The scan seeds it once from the plugin's default for the project type; after that
it is the project's own and you may change it **when the owner asks for a different
view**. Edit the file (it is inside `.cockpit\`, so this is allowed); the card reads it on
the next draw. Say what you changed. If a column matches nothing, the card says so.

## When the owner wants to see something the map does not show

**A new lens is a new namespace. You can make one; you cannot change the card.** The card
draws whatever lenses exist. So when the owner asks for a view the map lacks ("who owns
what data", "which pages are public", "what belongs to the council service"):

1. Decide the namespace and its values in plain words, e.g. `owner` with values
   `council`, `health-cards`, `import-job`, `shared`.
2. `lens owner "Data ownership" "Which part of the app owns each table and page"` — the
   lens appears in the bar at once. Add `graded` only if values mean good/bad.
3. Work through the map with `graph`, `node`, `find` and the code, and `tag` each subject:
   `tag table:health_log owner import-job "written only by auto_import.php"`.
4. Say what you built: the lens, its values, how many subjects carry each, and what you
   could not decide. Ask about those; do not guess an owner for a table you cannot trace.

Findings that are not tags (a fact about the project as a whole, a decision the owner
made) go in with `note`. Nothing goes anywhere else.
