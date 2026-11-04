# Configuration

Cockpit runs with no configuration at all: every setting below has a default. There are three
places a setting can live:

1. **Engine settings** — `engine.json` beside `index.js` (not committed; create it if you need it),
   or an environment variable. **Environment variables win over `engine.json`.**
2. **Per-project settings** — files inside that project's `.cockpit\` folder, mostly written by the
   Plugins page wizards.
3. **Per-project rules** — sections in the project's `.cockpit\project.md`, read by both the AI and
   the engine.

## 1. Engine settings

| `engine.json` key | Environment variable | Default | What it does |
| --- | --- | --- | --- |
| `port` | `COCKPIT_PORT`, or `PORT` | `47821` | The port the engine serves the shell and API on. Taken by another program: the next free one, up to 20 higher. The setup wizard sets it here. |
| `host` | `COCKPIT_HOST` | `127.0.0.1` | The address it listens on: this machine only. `0.0.0.0` opens it to every machine on the network, **with no login**. Only do that on a network you trust. |
| `extraCa` | `COCKPIT_EXTRA_CA` | none | A PEM file of extra root certificates to trust, in addition to the normal ones: for example your local proxy's certificate authority (Caddy `tls internal`, mkcert), so the test runner can reach your local HTTPS sites. Certificate checks stay on. A relative `engine.json` value is relative to the engine folder. |
| `idleUnloadMinutes` | — | `10` | A project nobody is looking at closes its database and stops its timers after this many minutes. |
| `person` | `COCKPIT_PERSON` | `default` | Whose card layouts are loaded and saved, and the name Home's greeting uses (`default` greets "there"). A name set in Home's Settings ("Your name") overrides the greeting. |
| `secretsDir` | `COCKPIT_SECRETS_DIR` | `<engine folder>\..\..\config` | Where per-project secrets that must never be in a repository are kept. Today: `<secretsDir>\<project id>\look-login.json` = `{ "url", "email", "password" }`, the test login the browser checks and `cli look --login` sign in with. A relative `engine.json` value is relative to the engine folder. |
| `boxedCards` | `COCKPIT_BOXED_CARDS` (comma-separated) | none | Project ids allowed to supply their own cards, shown in a sealed iframe (`engine/ext.js`, `shell/boxcards.js`). The first one listed is the one the shell shows. |
| `missionSource` | `COCKPIT_MISSION_SOURCE` | none | Where Home's greeting line comes from, as `<project id>/<extension>/<read command>` - a project extension (below) answering `{ "lines": [{ "text": "..." }] }`. None = the built-in quotes. |
| `autostart` | — | not set (= switched on the first time `Start Cockpit` runs) | Whether Cockpit starts by itself when you sign in to Windows (a Scheduled Task for your user; README "Staying on"). Written by the wizard and Settings → Engine; `false` once you switch it off, and it is never switched back on by itself. |
| `coding` | `COCKPIT_CODING` (`1` / `0`) | `false` | The Coding plugin: every coding/DevOps card, tab and plugin (README "Coding is a plugin"). Off, none of them appear and the code map is not read in the background. Switched in Settings → Plugins and cards. |
| `setupHidden` | — | not set | `true` once the Getting started checklist is done or hidden: it no longer shows in Home's conversation (it never shows in other projects). `false` = shown again (Settings → Engine). |
| `externalBackupStatus` | `COCKPIT_EXTERNAL_BACKUP_STATUS` | none | A JSON file an outside backup job writes, `{ "at": "<ISO time>", "ok": true, "failed": [] }`. When set, Home raises an alert if the last run failed or is more than 26 hours old. |

Other environment variables the engine reads:

| Variable | Default | What it does |
| --- | --- | --- |
| `OLLAMA_HOST_URL` | `http://localhost:11434` | Where the Pi harness finds Ollama. |
| `COCKPIT_CODER_TEST_WORKERS` | `4` | Caps test-runner workers (vitest, jest) in every process a coder starts, so several coders can share one machine. |
| `COCKPIT_CODER_TASKS` | `2` | Passed to coders as `CODER_TURBO_CONCURRENCY` for monorepo task runners. |
| `COCKPIT_INSECURE_TLS` | off | `1` turns certificate checks off for the whole engine process. A last resort; it logs a warning at start-up. Prefer `COCKPIT_EXTRA_CA`. |
| `COCKPIT_AUTOSTART_DRYRUN` | off | `1`: switching "start when I sign in" on or off writes what it would run to `logs\autostart-dryrun.ps1` and changes nothing on the machine (for testing). |
| `COCKPIT_LAUNCHED_BY` | — | Set to `start.ps1` by the launcher/watchdog. Only an engine started that way switches autostart on by default; `node index.js` from a terminal never does. |
| `COCKPIT_URL` | `http://localhost:<port>` | Where `cli.js` finds the engine. The engine sets it for its own child processes; set it yourself only to point the cli or the live tests (`test/m*.js`) at another engine. |

## 2. Per-project files (`<project>\.cockpit\`)

| File | What it holds |
| --- | --- |
| `cockpit.json` | Engine version stamp, plugins selected, project type. Also: `"backup": { "everyMinutes": n, "off": true }` (backup schedule; default once a day), `"wake": { "model": "...", "off": true }` (Home only: the queue's wake-up turns). |
| `project.md` | The project's rules for every AI (tier 2). Sections the engine also reads are listed below. |
| `plugins\<plugin>.json` | Each plugin wizard's answers (e.g. `github.json`: `repo`, `you`, `people`, `lookbackDays`, `localPrefix`, `versionUrls`). |
| `plugins\<plugin>.md` | Optional: this project's additions to the plugin's rules. |
| `plugins\github.queue.json` | The GitHub queue: `holdLabels` (labels that keep a ticket off the coders' queue), `skipAssignees` (logins whose tickets are someone else's), `strong` (`{ "labels": [...], "harness": "claude-code" }`: tickets only that harness may take), `blockedLabels` (`{ "owner": "blocked:waiting-on-owner", "other": "blocked:waiting-on-someone-else" }`: the labels a coder adds when it is stopped by the owner, or by another person). |
| `plugins\github.attention.json`, `github.stages.json`, `architecture.typescript.json`, `tickets.json` | Overrides of the plugin defaults with the same shape (see each plugin's own `.json` files for the fields). |
| `coders.json` | How a coder's own folder (`<project>\.coders\<coder>`) is set up: `setup` steps (`run`, `copy` with `replace`, `bash` with `env`), `db` (the coder's own test database, e.g. `myapp_{coderdb}_test`), `land: "dev"` (merge finished work into the dev folder). |
| `ext.json` | Project extensions: a program Cockpit may run for the project's cards, with its read and write commands listed, e.g. `{ "assistant": { "run": ["node", "tools/assistant.cjs"], "read": ["list"], "write": ["write"] } }`. |
| `views\*.sql`, `views\connection.json` | Read-only data views (one SELECT each) and how to connect to the database for them. |

## 3. Sections of `project.md` the engine reads

```
## Tests
- command: pnpm test           what Cockpit runs instead of node --test per file
- scoped: pnpm turbo test --filter={packages}   run only what a turn touched
- setup: node test/setup-db.js resets the *_test database first
- start: node server.js        how to start the app for runtime checks
- url: http://127.0.0.1:5900   where it answers (or the deployed site)
- public: /api/health, /login  doors that may answer without a login
- login: POST /api/login       the sign-in door
- user: look-login             the test user (default: <secretsDir>\<project>\look-login.json)
- budget: 800ms                per-request time budget
- gate: github <workflow>      read the tests line from a GitHub Actions workflow on main

## Backup
- folder: D:\backups\my-app    where the real backups land (age is checked)
- every: 24                    hours between backups
- by: <who>                    who keeps production backups (a managed database)
- drill: <file>                a restore drill's result file

## Review
- review: codex-cli <model>    a second model reads every ticket's change once
```

## What is never configuration

Runtime data the engine writes beside `index.js` — `projects.json` (the folders you have opened),
`fleet.json` (agents and the queue), `turns.jsonl`, `logs\`, `backups\`, `run\`, `accounts\` (extra
Claude logins for coders) and the downloaded `browsers\` and `tools\` archives — is ignored by git
and safe to delete when the engine is stopped (deleting `projects.json` forgets your projects;
their `.cockpit\` folders are untouched).
