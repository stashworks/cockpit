# Doctrine — the rules learned the hard way

One file, portable. It is read by every AI turn Cockpit runs (tier 1, before any project's
rules) and it can be handed to anyone: nothing in it depends on Cockpit. These are sensible
defaults drawn from real projects; change them to suit your own. **Edit this file in one
place; the next turn everywhere reads the new rules.**

Each rule carries the scar that earned it, how to apply it, the boundary where it does not
apply, and a **Check** line: whether the Architecture map can find violations
retroactively (a lens value), or whether it is a judgement only a reader can make.

## How this file stays alive

1. **A lesson that might generalize goes to the inbox, not into this file mid-project:**
   `node <cli> <project> lesson "<one paragraph: what happened, what rule it suggests>"`
   — it lands as one dated file in the engine's `prompts\doctrine-inbox\`. Never edit the
   rules from inside a project turn.
2. **Review** (monthly, or when the inbox holds five notes): the owner, or a session opened
   in the Cockpit project, promotes notes into rules — new rule, evidence on an existing
   rule, or rejection with a line saying why — and empties the inbox.
3. **Status** on every rule: `active` · `candidate` (one project's evidence) · `retired`
   (kept, with why it died). A rule nobody has validated in twelve months is challenged.
4. **Git is the memory.** Every change to this file is a commit; the history is the answer
   to "why do we believe this" a year on.
5. **Project numbers stay in projects.** "24k tokens of harness overhead" is a machine fact
   for one project; the rule here is "measure your harness overhead before sizing anything".

## The rules

### honest-partial-beats-guessed-whole
**Rule:** An agent's report describes only what actually happened. "Here is where I stopped
and why" is a successful outcome; a report describing work that did not happen is the one
unrecoverable failure, because the next consumer trusts it.
**Status:** active
**The scar:** Local-model trials, same week: one model confabulated an entire status
report from stale files (fictional completed work, fictional decisions) and separately
produced an assertion-free always-PASS test — coverage theater. Its replacement reported its
own command failures verbatim and was usable for exactly that reason. Honesty under
failure, not capability, was the hiring criterion.
**Apply it:** In every agent's standing instructions, in these words: report only what you
actually did; an honest partial beats a guessed whole. Grade agents on say-do gap first.
Verify claims against ground truth (the pushed branch, the changed row) before crediting
any report.
**Does NOT apply when:** Never. This is the trust floor everything else stands on.
**Check:** judgement — the owner's comparison of a report against the ground truth (Cockpit
keeps the ledger).

### never-trust-reported-success
**Rule:** A success code is a claim, not evidence. Verify the state actually changed: count
the rows, diff the page, read the value back, check the file landed.
**Status:** active
**The scar:** An LLM server silently truncating prompts while returning HTTP 200; a migration
UPDATE matching zero rows under row-security and "succeeding" (it had only ever run where
there was nothing to fail on); a teardown DELETE reporting success while deleting nothing.
A compose flow that "sent" messages that never sent.
**Apply it:** Every automated action pairs with a read-back assertion on the actual effect.
"The API said OK" is the beginning of verification, not the end.
**Does NOT apply when:** Truly idempotent no-stakes operations — but a read-back usually
costs near zero, so default to doing it.
**Check:** judgement (partly: `test-without-assertion` catches tests that cannot fail).

### verify-the-verifier
**Rule:** No detector, test, or alarm is trusted until it has been watched failing on a
deliberately broken input. Permanently-green and permanently-red are the same disease: both
train people to stop looking.
**Status:** active
**The scar:** One week: a leak-detector test that could not fire on any input
(found by simulating the leak); a runbook "verification" step that passed whether or not
the patch had run; a drift alarm red 14 consecutive runs because the detector itself was
broken — and everyone had learned to scroll past it.
**Apply it:** Red-green every new check (make it fail first). Mutation-test critical
assertions. For any long-green check ask "what would this print if the thing were broken?"
For any long-red alarm ask "is it measuring at all?" A canary must be observed alerting
once before it counts as armed.
**Does NOT apply when:** Never exempt. Cheapest rule per bug found in this doctrine.
**Check:** Architecture → Problems → **test-without-assertion** (a test file that asserts
nothing cannot fail).

### one-writer-per-resource
**Rule:** Every mutable resource (working tree, config file, deploy branch, device, table)
has exactly one writer at a time, enforced by locks and claim protocols — and every actor
fetches fresh state before acting. A rejected push means you are behind, never that you
should force.
**Status:** active
**The scar:** A two-writers-one-tree near-miss and the claim protocol (status label +
timestamped claim comment, earlier claim wins) that ended it. At the catastrophic
end: a bot on a stale checkout force-pushed a deploy branch backwards and broke live
checkout for 37 minutes.
**Apply it:** Locks taken by the scheduler, not trusted to the agent. Claim before edit.
Fetch before work. Ban force-push in the rules AND in branch protection (code, not
prompts). On shared machines single-writer applies to services and GPUs too.
**Does NOT apply when:** Read-only consumers — parallelize reads freely.
**Check:** Architecture → Problems → **no-single-writer** (a table written from many files
has no owner).

### every-queue-needs-a-consumer
**Rule:** Ship every queue WITH its consumer, a depth gauge, and an aging alarm — in the
same change. This includes human queues: approvals, decisions, operator tasks.
**Status:** active
**The scar:** A watcher loop that silently died, repeatedly; a maintenance payload that
deleted itself unexecuted. 31 approved tasks nothing ever ran for a week; a warm
prospect's perfect reply rotting three days in a drafts folder no process read. Subtlest:
a prod deploy sitting hours in a human's approval queue with no age alarm — humans are
queues too.
**Apply it:** For every place work can wait, name what drains it, how you see its depth,
and what fires when it ages. "Drafted" and "routed somewhere" must never display as "done".
**Does NOT apply when:** Genuinely fire-and-forget telemetry. If anyone would ever act on
it, it is a queue.
**Check:** Architecture → Problems → **write-never-read** (a table code writes and nothing
reads: a queue with no consumer, or dark data).

### caps-in-code-not-prompts
**Rule:** Any limit an agent must respect (rate, spend, scope, volume) lives in code or
config the agent cannot edit — never only in its instructions.
**Status:** active
**The scar:** An agent rate limiter (60 calls/hr, in code) held, while every prompt-level rule
eventually bent under pressure. Elsewhere: a social account suspended after
an agent batch-fired actions a prompt "limited".
**Apply it:** Hard caps in the tool/client layer; prompts explain the cap, code enforces
it. Budget brakes (for example a hard stop at 75% of a weekly quota) are the same rule applied to
money.
**Does NOT apply when:** Judgement calls that cannot be numeric — those get a human gate
instead (copilot-not-autopilot).
**Check:** judgement.

### copilot-not-autopilot
**Rule:** Agents propose and do volume; humans keep a small written list of permanent
gates — deploy, spend, scope, security posture, anything irreversible. Tier the gates: not
every action deserves the same tap.
**Status:** active
**The scar:** A working shape that held: the coder merges its own green routine PRs (removing
the human from THAT loop was an improvement), while prod deploys, enforcement flips, and
customer-charging changes stay human-gated. An industrial-control setup has the same division by
design: AI monitors and recommends, a human applies. Every disaster story in comparable
setups traces to an action that bypassed its gate.
**Apply it:** Write the permanent-gate list down per project. Everything not on it,
automate fully — approval friction on routine work quietly recreates the bottleneck the
system exists to remove.
**Does NOT apply when:** Reversible-in-seconds actions with read-back verification can earn
their way off the gate list — on evidence, never by default.
**Check:** judgement — the gate list is in each project's rules; the ledger shows what ran.

### deterministic-first-ai-for-judgment
**Rule:** Where rules suffice, write rules (algorithms, schedulers, gates, caps). Spend AI
only where judgement is genuinely required — and wrap the AI in a deterministic envelope.
**Status:** active
**The scar:** A home-automation controller: a tuned deterministic algorithm matched the AI's
performance at near-zero cost with total predictability. Industrial control: AI monitors and
recommends; deterministic plant logic and a human hold the controls. A coding fleet: the tick
scheduler, claim protocol, and merge gates are all deterministic — the AI works inside them,
never as them.
**Apply it:** For each automation ask "rules or judgement?" Rules → code. Judgement → AI
inside caps, gates, and read-back verification. Revisit when the algorithm's tweaking
burden exceeds what AI supervision would cost.
**Does NOT apply when:** Exploration and diagnosis, where you do not yet know the rules — AI
is often how you DISCOVER the algorithm worth writing.
**Check:** judgement.

### ai-must-beat-the-manual-baseline
**Rule:** An AI (or any automation) earns its place only by beating the existing process on
TOTAL effort — including supervision, correction, and rework — not on output quality alone.
**Status:** active
**The scar:** A device manager for eleven units: AI-run management produced results no better
than manual and took MORE total work — retired in favour of a deterministic algorithm.
A first local coding model: free tokens, but its output demanded more review effort
than frontier authorship would have cost — shelved on economics, not sentiment.
**Apply it:** Before automating, write down the manual baseline's total cost. After a
trial, compare honestly INCLUDING your own supervision time. "It works" is not the bar; "it
costs less all-in" is.
**Does NOT apply when:** The automation buys something manual cannot do at all (24/7
monitoring, scale, speed) — then compare against not-having-it, and say so.
**Check:** judgement — Cockpit's Lane performance card gives the cost half (turns, produced,
nothing, tokens).

### context-as-code
**Rule:** Put the operation where the AI can read and write it: plain files in one
versioned place — playbooks per domain, state files, queues, reports. Load context on
demand; never dump everything into one window.
**Status:** active
**The scar:** Whole operations run on this: repo instructions, a task queue file,
inbox/outbox folders, state markers, memory files — with the same failure everyone hits,
context rot when the pile grows, solved the same way (markers, on-demand loading,
one-brief summaries).
**Apply it:** New project bootstrap: one folder; a rules file (rules, voice, boundaries);
queue in/out; state; a START-HERE index that supersedes rather than accumulates. Version
it. Old state notes get superseded-by headers, not deleted. (In Cockpit: `.cockpit\`
per project, `project.md` the rules, the ledger the state.)
**Does NOT apply when:** Data that must not be broadly readable — credentials never in the
readable plane.
**Check:** Architecture → Problems → **secret-in-code** (a password or key literal in
source is in every copy and every backup).

### match-model-to-phase
**Rule:** Route work phases to capability tiers: cheap/free models scout, map, and do
tightly-pinned mechanical steps; expensive models judge, design, and build; a DIFFERENT
model than the author reviews. Handoffs pay a context tax — split only where an artifact
can genuinely carry the baton.
**Status:** active
**The scar:** Free-local-scout → frontier-build → cross-model-review, adopted during a
quota crunch. Counter-scar bounding the rule: the connective insight in a multi-day
investigation existed only because ONE context carried discovery through fix —
over-splitting phases would have killed it. A 9-phase-9-model pipeline that
works for architect-sized features would be pure overhead for a bug fix.
**Apply it:** Cheap tiers get pins with exact steps, explicit encodings, named insertion
points, and a one-report rule. Review by a different model than the author — diversity
catches self-consistent errors. Split phases only when the handoff artifact is the real
interface.
**Does NOT apply when:** Deep investigations and design arcs — keep one strong context
end-to-end and pay for it.
**Check:** judgement — the ledger records which model ran each turn.

### measure-dont-guess-capacity
**Rule:** Capacity numbers (context windows, memory, quotas, harness overhead, speed) are
measured on the actual system, never assumed from specs or benchmarks. Re-measure after
any environment change.
**Status:** active
**The scar:** A night lost to a "capacity ceiling" that was actually the measuring process's
own leaked child processes holding 30 GB of GPU — every restart orphaned a runner, and each
ladder rung measured the previous rungs' leak. Also: agent harness overhead measured at
~24k tokens/turn (invisible until measured, decisive once known), and a token-budget
"capacity" that was a 2x-wrong guess until measured.
**Apply it:** Stress-ladder up to failure, record every rung. Between rungs: kill process
TREES and verify the meter reads near-zero before continuing. Benchmarks select candidates;
only your own harness's numbers decide.
**Does NOT apply when:** Never — but scale the rigour to the stakes.
**Check:** judgement — the Project card shows the standing prompt's size per turn; the
ledger shows tokens per turn.

### state-changes-carry-fallback
**Rule:** Any unattended automation that changes system state carries an automatic
fallback to last-known-good in the same script — and any restart kills the full process
tree, then verifies the resource is actually free before relaunching.
**Status:** active
**The scar:** A no-fallback config change bricked a service for 90+ unattended minutes.
Separately, restarts that killed the parent but orphaned the children invalidated a full
night of measurements and starved the machine to allocation failure.
**Apply it:** Attempt new state → verify with a real operation → on failure restore
previous state → verify again → log both. Recovery paths are straight-line scripts; no
cleverness where things are already broken.
**Does NOT apply when:** Human-attended changes where the human IS the fallback — but
unattended is the default assumption.
**Check:** judgement.

### taste-loop
**Rule:** Every human correction gets written back into the instruction/playbook that
produced the mistake, before the task closes. Track corrections-per-output by category;
falling numbers earn autonomy, flat numbers keep the gate.
**Status:** active
**The scar:** A local model absorbed a claim-protocol correction and a one-report correction
each after a single write-back — measurably better next turn. The boundary, from the same
data: the loop CONVERGES on structure (protocols, formats, verification habits stick) and
PLATEAUS on judgement — which is exactly where the permanent human gates belong.
**Apply it:** Correction → written into the producing rules file, same day. A signal nobody
reads is dark data: every feedback log needs a consumer.
**Does NOT apply when:** One-off contexts that will never recur — but be suspicious of how
rarely that is true.
**Check:** judgement — a theme that recurs three times becomes a line in the project's rules.

### visible-or-unwanted
**Rule:** Before building software to make something visible, check whether it is
invisible or just unwanted. Only one of those is a software problem. Denominate the daily
loop in the scarce currency — the owner's decisions, not the system's ideas.
**Status:** candidate
**The scar:** An operator built a priority-visibility layer; nine tracked goals never
moved once — the constraint was want, not awareness; it was deleted. A project backlog file
said the same in its header: anything not converted to an issue, a calendar entry, or a
decision "sits here and rots".
**Apply it:** When a surfaced item sits untouched for weeks, the question is "do we
actually want this?" — answer it (do it, delete it, or consciously park it with a date)
instead of building a louder dashboard. Status surfaces exist to hand the human a SHORT
list of decisions, not more to read.
**Does NOT apply when:** The item genuinely was invisible — the test is whether making it
visible once caused action.
**Check:** judgement — Needs attention's age is the signal.

### delete-only-what-you-declared
**Rule:** A turn may delete only the files its ticket names. No command that removes what it was not
pointed at: no `git clean`, no `git checkout .` over a dirty tree, no `rm -rf <directory>`, no delete by
wildcard or by pattern. Clear a build folder by naming that folder; never a parent, never a path you
assembled from two others.
**Status:** active
**The scar:** One overnight run, two accidents by the same coder. `rm -rf apps/api/dist/__tests__
apps/api/src/routes/__tests__` — it meant the compiled copies and pasted the source path beside them: 97 real
test files gone, no ticket asked for it, no commit explained it. And a `git clean` to tidy the tree took
`.cockpit` with it (untracked, not ignored): 66 tickets, their verdicts, the project rules and every
conversation - the engine opened the project a minute later and wrote a fresh empty folder over the hole.
Both were cleanup, neither was the work.
**Apply it:** Deleting is work, so it is declared: the ticket lists the file under `--delete`, or you do not
delete it. To tidy your own mess, name your own files. If a cleanup seems needed beyond the ticket, say so in
one line and stop - the owner decides. `.cockpit` is never yours: it is the project's memory, not its code.
**Does NOT apply when:** Nothing. A wider clean is the owner's hand, never a turn's.
**Check:** the verdict reads what a turn touched against what the ticket declared; a deletion outside the
list is red, and the engine keeps an hourly copy of `.cockpit` for a week (engine/backup.js) because a rule
is not a guarantee.

### one-folder-no-copies
**Rule:** Work in the one folder Cockpit gave you. Never make another copy of the repo - no `git worktree add`, no
second clone, no `cp -r` of the project - and never leave throwaway files at the top of your folder.
**Status:** active
**The scar:** One coder made ten side copies of the whole repo for parallel jobs (`.wt-2709`, `.wt-3047` ...), another
an `issue-3000-local`, each with its own install - over a million files, never removed. pnpm hard-links package files
into every install, so the running dev site held some of them "in use" and the owner could not delete them by hand.
Temp files with flattened paths (a whole Windows path with its slashes stripped, `nul`, `-`) piled up beside them.
**Apply it:** One ticket at a time, in your folder, on its own branch. Need scratch space? Put it under
`.cockpit/tmp/<ticket>` and delete it before the turn ends. Write temp files to the system temp folder, never with
a path pasted into a file name.
**Does NOT apply when:** Nothing. Two tickets at once is two coders, never one coder with two copies.
**Check:** engine/janitor.js removes any leftover copy and junk file older than a day, every night, and logs what it
found - a name in that log is this rule broken.

### optional-checks-are-reported-not-forced
**Rule:** A failing optional check (mutation testing, anything outside the required set) is reported on the pull request in
one line and left. Never run the mutation tool in your folder to chase it, and never make any check pass by switching
checking off (`// @ts-nocheck`, lint disables, skipped tests) or by touching files the ticket does not name.
**Status:** active.
**The scar:** A mutation-testing tool configured to run IN PLACE writes `// @ts-nocheck` and its mutants into every file of
the app it tests, and takes them out only when the run finishes. Cut off - a timeout, a killed process - it leaves them
all. More than once a coder chasing a red optional mutation check left thousands of such files in its folder, and the next
turn took the leftovers for someone's edit and stashed them. None reached main; each cost turns and nearly mixed into real work.
**Apply it:** A required check red - fix it. An optional one red - name it and why in one line on the PR, end the turn.
If any tool that rewrites the tree in place was interrupted, run `git diff --stat` at once: its leftovers are restored to
HEAD by name, never stashed as "leftovers" and never committed. If you cannot restore them, stop and say so.
**Does NOT apply when:** The ticket itself owns the mutation-testing setup - then run it to the end, uninterrupted, and
check `git diff --stat` after.
**Check:** a pull request or stash whose diff adds `// @ts-nocheck` to more than a handful of files is this rule broken.

## The building code — the maturity ladder

Build bottom-up through the rungs; most projects should STOP at rung 0 or 1
(ai-must-beat-the-manual-baseline).

- **Rung 0 — interactive.** You + an AI session + context-as-code (a folder, a rules file,
  state in files). *An interactive session for tweaking IS the right architecture for most
  things — the ladder exists so you notice when a rung is not worth climbing.*
- **Rung 1 — advisor loop.** Add one scheduled read-only agent turn (monitor / briefing)
  with an outbox and a calendar slot where you read it. Promotion test to rung 2: the
  advisor's recommendations have been right (or cheaply wrong) often enough that you would
  let it act.
- **Rung 2 — single working lane.** Add a task queue, claim-before-work, write-back
  verification, a human-gate list.
- **Rung 3 — multi-lane.** Per-lane state, a shared coordination root, one writer per
  resource enforced by the scheduler.
- **Rung 4 — do not build it.** A fully autonomous fleet. If a domain seems to demand it,
  split the domain instead.

**Bootstrap sequence for a new project (rung 0 → 1 in one sitting):**
1. A folder, a rules file, state in files, and this doctrine wired in (Cockpit does this:
   `.cockpit\project.md`, and this file is read every turn).
2. Write the permanent-human-gate list — even at rung 0, it disciplines you.
3. Write the manual baseline cost down.
4. First scheduled advisor turn + outbox + a calendar slot where you read it.
5. Stop. Earn the next rung with evidence, not enthusiasm.
