# Cockpit as a generic IDE — design record

The design Cockpit is built from. Section numbers are referenced from the code (`§1`, `§13` ...),
so they are kept stable; a few early sections that only described one machine's migration have
been removed, which is why some numbers are skipped.

The aim: an IDE for any folder, that starts nothing for a folder nobody has open, where each
site, app or notes vault is a project, and where the AI works with the project higher up the
stack than the code — through its architecture, its tickets and its conversation.

---

## 1. Engine and project

**The Cockpit folder is the engine and runtime.** The shared files needed to run any
project. It has no project of its own.

**A project is a folder.** Inside it, **`.cockpit\`** — the same way `.vscode\` and
`.obsidian\` work — holds everything that project needs to remember: config, the database,
screen layouts, hand-set tags and grades, decisions, conversations, logs.

The project folder can be moved and reconnected to the engine and it works exactly as
before, with nothing lost. Two rules make that true:

1. **No absolute paths inside `.cockpit\`.** Everything is relative to the project folder
   or declared once in the project config.
2. **The engine stamps `.cockpit\` with its version** and upgrades an older one in place
   when it opens it — like Obsidian opening an older vault.

**Two ways to run, one design.** "Open the IDE and choose a folder" and "copy the IDE into
the project folder and run it there" are the same thing; only where the runtime sits
differs.

**Start on demand.** One runtime. A project loads when its page is opened; its feeds and
scans tick only while it is open; nothing runs for a folder nobody has open.

---

## 2. Three layers; one is per project type

| Layer | What | Shared or per project |
| --- | --- | --- |
| **Shell** | control room, cards, layouts, drag/resize, the conversation window | shared |
| **Engine** | the graph (layer + subject + lens), tags, health, feature ledger, "worth a look" | shared — the architecture tags are needed for every kind of project |
| **Plugins** | what a project is made of and how to read it — pages, APIs, data, people, work queue | selected per project |

---

## 3. Plugins — generic cards that connect through a wizard

To connect a project to GitHub, select the GitHub plugin, answer its wizard, and the GitHub
cards appear on the control room. Local git, the same. A project with no git, or no code,
does not select that plugin and those cards do not exist for it.

Named **plugins**, not features — *Feature* already means the product-feature ledger (the
green-light cards) and the two would collide in every sentence.

A plugin is one folder that brings:

- its **wizard** — what to connect: which repo, which token, which folder, which labels;
- its **feeds** — how it reads its source;
- its **cards** — what appears on the control room when it is selected;
- its **rules** — the prompt tier it adds (§5);
- its **tools** — the scripts the rules tell the AI to run (§5).

Select it, the wizard runs, its cards appear. Don't select it, they do not exist.

**No project is a plugin.** Everything specific to one project — its people map, PR title
prefixes, check names, `status:` / `needs:` label names, paths — is an answer the GitHub
plugin's wizard asks for. A second GitHub project answers differently and gets the same cards.

**Architecture is a plugin with a per-type scanner.** The lens engine is shared; *how to
read the folder* differs (TypeScript routes, HTML/PHP pages, markdown links). The wizard's
first question is what kind of project this is, or it detects it, and loads the matching
scanner. After setup, changes come through the chat window — grade a tag, rename a module,
say "this is fine" — and land in `.cockpit\` as human judgements a rescan never overwrites.

The Website profile of the Architecture plugin: a folder of code plus a live URL; scan the
code for pages and routes, crawl the site for what is actually served, join the two.

---

## 4. Any AI, switchable, one conversation

Claude, Codex and local models are run through a **harness** — the loop, the tools and the
session, with the model underneath. One harness for all three is not possible on consumer
subscription plans (as of 2026):

- **Anthropic does not allow Pro/Max subscription access from third-party harnesses.**
  Outside Claude Code it is an API key or paid extra usage — per-token money. **So Claude
  Code is the Claude harness.**
- **OpenAI tolerates ChatGPT/Codex subscriptions in third-party harnesses** but has not
  committed to it in its terms. Codex CLI, OpenAI's own, carries no such risk.
- Local models have no such constraint.

**Therefore: one harness per model, each on its vendor's own safe path:**

| Model | Harness | Why |
| --- | --- | --- |
| Claude | **Claude Code** | the only way to use a Claude subscription plan |
| Codex | **Codex CLI** | OpenAI's own — never subject to the tolerated-not-promised risk |
| Local | **Pi** (Mario Zechner, MIT) | no subscription in play; gives the local model real hands |

All three sit behind **one adapter interface** (`docs/harness-interface.md`): start a turn,
stream events, expose Cockpit's tools, import/export a session. All three are drivable from
a program — Claude Code headless, `codex exec`, Pi's print/JSON mode. Pi brings `read` /
`write` / `edit` / `bash` to whatever model it runs (Ollama through an OpenAI-compatible
endpoint), JSONL sessions, `AGENTS.md` tiers, and no MCP by design.

Every AI uses the same logging and the same md files, so a conversation can switch AI
mid-way — start on a local model, switch to Claude to finish, switch back — without losing
context.

**Cockpit owns the conversation; the harnesses do not — and with three harnesses this is
load-bearing.** No harness can carry a session from Claude Code into itself. So:

- every turn is written to `.cockpit\` by Cockpit, in one format, harness and model are
  columns;
- switching hands the next harness the transcript **from Cockpit** (sized, §9);
- one turn log, one shape;
- the chat window, the logs and the md files are in one place — `.cockpit\`.

---

## 5. AI startup files — three tiers, inherited

A central start file on the engine holds the standard rules for any AI, so every project
inherits them; then a project file with that project's specifics; then a file per plugin, so
turning a plugin on adds its rules.

| Tier | Lives in | Example |
| --- | --- | --- |
| **Global** | `<engine>\prompts\doctrine.md` + `prompts\global.md` | how any AI behaves for the owner |
| **Project** | `<project>\.cockpit\project.md` | "this is a Hugo site, deploy is `make publish`, never touch `/legacy`" |
| **Plugin** | `<plugin>\rules.md` | GitHub: how to claim, what a Closes-when is, never closing keywords |

Cockpit assembles global + project + every selected plugin's rules into the prompt for
whichever engine runs. The Claude harness gets this almost for free (it is how Claude Code's
own CLAUDE.md hierarchy works); for Codex and local, Cockpit assembles the same three.

**Rule of the plugin format:** a plugin ships its rules *and* its tools, and the rules say
"run the tool," not "remember the rule." Written instructions fail where one script works;
`rules.md` is short because the tools carry the weight.

---

## 6. Folder structure

### The engine

```
Cockpit\
├── index.js                     node .  →  runtime; opens projects on demand
├── cli.js                       the tools every AI turn uses (TOON output, §17)
├── engine\                      shared, project-agnostic
│   ├── server.js                HTTP, routes, project registry (which folders are open)
│   ├── projects.js              open/close a folder; read + upgrade its .cockpit\
│   ├── graph.js                 layer + subject + lens; tags
│   ├── conversation.js          the ONE conversation store
│   ├── harness.js               the adapter interface: start turn, stream, tools, session
│   ├── harnesses\               claude-code.js  codex-cli.js  pi.js   (§4)
│   ├── prompt.js                assembles global + project + plugin rules   (§5)
│   └── schema.sql               engine tables only
├── shell\                       the control room
├── plugins\                     one folder per plugin — below
├── prompts\                     tier 1 — doctrine.md, global.md, new-project.md
├── starters\                    project starters (§15)
├── projects.json                the folders opened (runtime data, not committed)
└── docs\
```

`projects.json` is the only state the engine keeps of its own (plus `fleet.json` for the
queue, §14).

### A plugin — `plugins\github\`

```
plugins\github\
├── plugin.json        name, the wizard's questions, cards, scan
├── scan.js            reads its source, writes the plugin's tables
├── cards\             the cards it brings
├── rules.md           tier 3 — how to claim, Closes-when, never closing keywords
└── schema.sql         the plugin's own tables, PREFIXED (gh_pr, not pr)
```

Every plugin has the same parts: manifest, wizard, feeds, cards, rules + tools. The engine
loads the ones a project selected and nothing else.

### A project — `<folder>\.cockpit\`

```
C:\projects\my-app\
├── src\ …                         the code — untouched
└── .cockpit\
    ├── cockpit.json               engine version stamp · plugins selected · project type
    ├── project.md                 tier 2 — this project's rules for any AI
    ├── plugins\
    │   ├── github.json            the wizard's answers: repo, labels, people, prefix
    │   ├── github.md              (optional) this project's additions to the plugin's rules
    │   └── architecture.json      scanner type, conventions
    ├── cockpit.db                 ONE database: conversations, tags, layouts, feed cache
    ├── conversations\*.md         the same rows as the db, as markdown — readable, greppable
    ├── decisions\                 tag grades and rulings set by hand; a rescan never overwrites
    ├── logs\turns.jsonl           one shape, every engine — engine is a column
    └── cache\                     rebuildable: code map, source cache, scan results
```

**Everything above `cache\` is the owner's and irreplaceable; `cache\` can be deleted any
time and the next scan rebuilds it.** That is also the backup line.

### Where the md files go, and the order they are read

| Tier | Path | Who edits it |
| --- | --- | --- |
| 1 global | `Cockpit\prompts\doctrine.md`, `global.md` | the owner, once |
| 2 project | `<project>\.cockpit\project.md` | the owner, per project |
| 3 plugin | `Cockpit\plugins\<name>\rules.md` | ships with the plugin; never edited per project |
| 3′ project's take | `<project>\.cockpit\plugins\<name>.md` | the owner, optional |

Assembled 1 → 2 → (3, 3′) per selected plugin. Specific wins over general, same as nested
CLAUDE.md files. Projects never edit a plugin's `rules.md`: a plugin update would clobber
the edit or have to merge it; keeping the project's words in the project folder lets both
change independently and moves with the folder.

### Three projects side by side

| | A team SaaS repo | A website | A notes vault |
| --- | --- | --- | --- |
| plugins | github, tickets, coding, architecture | git, architecture (site), coding | architecture (markdown) |
| `project.md` | the team's conventions | "Hugo site, `make publish`" | "keep frontmatter" |
| plugin settings | repo, labels, people, PR prefix | repo, live URL | vault root, folders |
| cards | fleet, board, pipeline, deploys, attention, architecture | pages, deploys, architecture | notes graph, architecture, conversation |
| engines | any | any | any |

---

## 7. Where the engine runs

One engine, on the machine the coders (and any local models) run on; the owner views the
shell from any browser on the network. One prompt assembler, one place — `prompt.js`.

Consequence, recorded as a deliberate choice: the shell is bound to the **LAN, no login**
by default (`host` in the engine config; set it to `127.0.0.1` to keep it on one machine).
That stays until someone deliberately adds authentication; "connect to a site" and remote
control both tempt opening it wider, and neither may.

---

## 8. Every model gets the same hands — the harness, not a protocol

Models do not have the same tools by default: Claude Code and Codex edit files; a local
model behind a plain chat endpoint has no file editor. The answer is the harness: Pi gives
the local model `read` / `write` / `edit` / `bash`, and Cockpit adds its own tools (graph
queries, tag grading, the queue) through `cli.js`. Claude Code and Codex CLI bring their own
hands; Cockpit exposes the same tools to them the same way.

---

## 9. Switching models mid-conversation

What remains after the switch itself is size: Claude takes a long transcript, a local
model's window is a fraction of it. When switching *down*, Cockpit sizes the hand-off to the
model being switched to — a rolling summary, the last N turns verbatim, and every standing
ruling recorded in that conversation (`chat_note`), always. The owner sees one continuous
conversation; each model sees what fits.

---

## 10. `.cockpit\` is not in git — and how it is backed up

`.cockpit\` is IDE state, not codebase. It never enters the repository — other people may
work in the same repo. It moves with the folder, not with the clone.

Whatever backs up the project folder backs it up. On top of that the engine keeps its own
copies (`engine/backup.js`): the code and database on a schedule, and `.cockpit\` itself in a
vault, hourly for a day and daily for two weeks, put back automatically if the folder
disappears. `cache\` is excluded.

---

## 12. Order of work

Milestones, as built:

| # | Milestone | Proves |
| --- | --- | --- |
| 1 | Engine opens a folder: creates `.cockpit\` with its version stamp, shows an empty control room with the conversation card, remembers it in `projects.json`, start-on-demand | the project model — no plugins, no AI |
| 2 | One harness adapter (Claude Code) driving a conversation stored in `.cockpit\` | the conversation is Cockpit's |
| 3 | Architecture plugin with the markdown scanner, on the first project | the engine is generic |
| 4 | Second harness (Codex CLI) and the switch mid-conversation | the load-bearing piece |

The milestone tests are `test/m1-project-model.js` … `test/m4-three-harnesses-and-the-switch.js`.

---

## 13. One engine, many projects — how switching works

A single engine runs every project; connecting to a project shows that project's own
screens and data, and swapping between projects never leaves the main app.

- **One engine, one browser tab.** A project switcher in the top-left corner, like VS
  Code's workspace name. Pick a project, the whole control room re-renders for it.
- **Each project has its own screens.** Which cards exist is decided by the plugins that
  project selected in its `.cockpit\`. The layout — where cards were dragged and sized —
  is per project, in `.cockpit\`.
- **Each project has its own data.** Its own `cockpit.db`, conversations, tags, logs.
  Switching projects switches databases; nothing bleeds across.
- **Start on demand, precisely.** The engine *process* runs all the time. A *project* is
  loaded — database open, feeds ticking, scans scheduled — only while selected. Switch away
  and it goes quiet within minutes (`idleUnloadMinutes`); switch back and it wakes. Ten
  registered projects cost nothing until one is opened.
- **The URL carries the project** — `/my-app`, `/notes` — so a bookmark opens straight
  into one.
- **The conversation is per project.** Home (a project in a folder named `home`) is the
  exception: its AI is the owner's assistant across every project.

---

## 14. Vocabulary: "queue manager", never "orchestrator"

"Orchestrator" is a word with a special meaning and gets confusing; the mechanical part is
the queue manager.

- **Queue manager** = the fleet: agents take items, run turns, record outcomes, expire
  claims. In code it is `fleet` and `queue`; in prose it is the queue manager. Never call it
  an orchestrator.
- **Orchestrator** keeps its special meaning from spirit.md - the persona the owner talks to,
  the one that reviews, decides and shapes work. That is the Conversation card. The word is
  not used for anything mechanical.

### The queue manager and the conversation

- **The queue manager decides nothing about what the work should be.** It takes items and
  runs them.
- **Deciding lives in the Conversation card.** Reviewing the repo, writing the process,
  weighing decisions, filing and shaping tickets, telling the owner what is blocked and on
  what - happens in the project's conversation. The owner talks; the AI there creates
  whatever the interaction needs: a ticket, a ruling in `project.md`, a queue item for an
  agent, a note on the map.
- **Therefore the conversation AI can feed the queue.** `cli.js queue add` (and list / park).
- **And it must know what the project knows.** The project's memory (state, rulings, the
  people, the conventions) is written into `.cockpit\project.md` and
  `.cockpit\plugins\github.md`. Cockpit is the memory.
- The GitHub plugin's cards are instruments (attention, pipeline, ticket, deploys, health),
  not the decision-maker. They show; the conversation decides.

## 15. A new project bootstraps itself from the conversation

After making a folder and opening it in Cockpit, the owner just talks to it; the AI provides
the scripts and does the setup.

- **The trigger is the empty rules file.** While `.cockpit\project.md` is the stub, the
  engine's tier-0 note tells the AI the project is new and to read
  `prompts\new-project.md` — the playbook: ask what the project is for (one plain question), then
  plain help with no setup, a beginner's app on safe defaults, or the full developer setup: the rules
  first, then the starter, git, plugins, process manager, site names, prod - reading each
  step back, stopping at the owner's gates, asking the owner only for what a person must do
  (DNS, logins).
- **Starters are files**, `starters\<kind>\`, with `{{NAME}}`-style placeholders; the cli
  copies one in (`starter node-app --name … --title … --purpose …`). A new kind of project =
  a new folder here, no engine change.
- **Everything is a cli command**: `plugin-select`, `project-set`, `import-claude`,
  `starter`, `starters`. The AI inside a project can do the whole setup.
- The owner's machine conventions (process manager, proxy, database, backups, gates, GitHub
  logins) belong in Home's `project.md`, not in code.

## 16. The doctrine lives in the engine

The rules learned the hard way — rule cards and the maturity ladder — are part of the engine
prompt, so they are updated in one place and the next turn everywhere reads them, yet kept
separate enough to hand to someone else.

- **One file: `prompts\doctrine.md`.** Tier 1 of every turn, ahead of `global.md`, read
  fresh each time (no restart). Nothing in it mentions Cockpit except in asides, so the
  file is the shareable artefact — send it, and it stands on its own.
- **Lessons go to an inbox, never into the file mid-project:** `cli <project> lesson "…"`
  → one dated file in `prompts\doctrine-inbox\`; a review promotes, adds evidence, or
  rejects. Status on every rule (active / candidate / retired); git is the memory.
- **The Architecture tab checks the checkable rules retroactively.** A Problems value that
  detects a doctrine rule names it (`problems.json` → `doctrine`), the finding's *why*
  carries it, and the Problems legend gains a second row grouped by rule. Two detectors
  exist for it: `write-never-read` (a queue with no consumer) and
  `test-without-assertion` (a verifier that cannot fail). Rules the map cannot check say
  `Check: judgement` in the doctrine and point at the surface where a human judges.

## 17. The tools speak TOON

Everything the AI reads back from `cli.js` is TOON (Token-Oriented Object Notation): the
same object as JSON, keys once per table instead of once per row, no braces, quotes only
where a value needs them. `engine/toon.js` is the encoder (spec v1, no dependency; tests in
`test/toon.js`); `--json` anywhere on the line gives JSON. Measured on a large monorepo:
`nodes` 1.88 MB → 1.46 MB of characters, `edges` 1.48 MB → 1.23 MB — and the tokenizer likes
the table form better than the character count suggests. TOON only wins when the data is
TABULAR — `nodes` as a list of objects each carrying a `tags[]` array came out *larger* than
JSON, so the cli flattens tags to one space-separated cell. Shape outputs as rows of
primitives and the format pays; nest them and it does not.

## 19. The feature level

The map one level up, as a visual anyone building with AI can understand. A **feature** = a
name + the pages, routes, code and tables that make it. Source: the project's module rules
(`.cockpit\plugins\architecture.typescript.json`, e.g. business areas by path regex), or -
free, for the node-app starter - the `modules\<name>\` folder (`keyFrom` on a module rule
takes the key from a capture group). Tables inherit the feature of what defines them, else
the majority of their writers, else their readers. Nothing new is stored: features are the
`domain` lens, and the views below are computed in the card from the same nodes and edges
the Flow draws.

- **Features** (opens first): one card per feature - pages / routes / files / tables, live or
  orphaned (something a person can reach leads into it, or not), doctrine findings, dead files
  inside. Click a card → the Flow of that feature (its nodes plus what they touch, one hop).
- **Tables**: one row per table - feature, written by (grouped by feature; several features
  writing one table shows amber), read by, defined in, findings; sensitive first; a search box.
- **Flow / Levels**: the drill-down; the Flow filtered to one feature when picked.
- **Doctrine** (on the Problems lens, above the map): EVERY rule in prompts\doctrine.md as a row
  with one of four states - found N (the Problems values it maps to, clickable), checked here and
  nothing found, not a rule on this project (switched off or missing in problems.json), or judged
  elsewhere with where the doctrine says to look. `engine/doctrine.js` parses the file; `GET
  /api/doctrine` serves it; the checklist joins the doctrine's own Check line with the rules'
  `doctrine` field in problems.json.
- An unedited Flow layout follows the project type (a seeded file whose columns still equal a
  template's is reseeded when the type changes; an edited one is never touched).

## 20. The risk matrix

A finding is a piece of work, not a colour: clicking it gives context, not a flow chart. Its
card is a risk matrix - likelihood × impact per affected thing - with the features ranked by
risk, where it bites, the trend, and two handles: Create ticket and Discuss in chat.
- **Impact** is a lens the scan writes per node (1-5): +2 top-5% reach / +1 top-20% (transitive
  dependents), +1 on a live path (tables always), +1 touches money / personal data / credentials,
  +1 writes data, +1 unguarded route. Reused by everything.
- **Sensitivity is scanned, not listed:** table names and CREATE TABLE column names against
  built-in patterns (money, personal, credentials, audit); files and routes inherit the marks
  of the tables they reach. A project's own list adds.
- **Likelihood** = the check's `weight` in problems.json (1-5, how likely the finding bites),
  +1 if the file changed 3+ times in 90 days (`churn` lens, one git call), +1 if no test names it
  (`tested` lens), -1 if unchanged in 90 days.
- Bands by the product (problems.json `risk`): ≥16 critical, ≥9 high, ≥4 medium, else low.
- `.cockpit\plugins\architecture.history.json` keeps the last 40 scans' counts; the card shows
  the trend against the previous scan.
