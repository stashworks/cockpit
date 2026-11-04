# The spirit of Cockpit

The spec is the buildable reading; **this file is what it must feel like.** When a screen
satisfies the spec but not this, the screen is wrong.

## Why this exists — the problem statement

An IDE that matches how people now build with AI: for people who know systems but cannot
keep up with the speed of an AI writing code, and who are not going to read every line it
writes.

The way of working it starts from: an editor with Claude and Codex add-ons, a chat, the AI
does things, files change colour, it is tested and pushed to prod, and it works. But nobody
knows what it is writing — whether it is writing several copies of the same thing across the
codebase because it no longer holds the whole codebase in view. Even AI cannot keep track of
everything.

So the person stops tracking the code at the file level and trusts the AI and the controls,
and works one level up: features, functionality, modules, integrations, down to API
monitoring. An orchestrator watches the coders and directs them. A feature — say, a button on
a status page that copies data from the production database to UAT — is tracked from the
conversation, through ticket generation, through GitHub placing it in UAT, to prod, tested
green. And the spaghettification of the code is tracked too: duplicates, and the things AI
does not do well yet.

So it needs a chat with the frontier models, a way to track the release cycle, and a way to
see the codebase's architecture and the problems AI typically creates.

Three needs, in that order: **a chat with the frontier models** (Build), **release-cycle
tracking from the conversation to "tested green in prod"** (Features), and **a visual check of
the codebase for the problems AI has** (Architecture + Health). The user is someone who knows
systems but not code, supervising AI that codes faster than anyone can read.

## The shift

Traditional: Requirement → Developer → Code → PR → Test → Deploy

Here: **Intent → AI Orchestrator → AI Coders → Code → Automated Controls → UAT → Human
Validation → Production → Production Validation.** The IDE shows the second picture.

You should never open the system and see `src/controllers/statusController.js`. You see:

```
Refresh UAT from Production
🟢 Implemented
🟢 Unit tests
🟢 Integration tests
🟢 Security review
🟢 UAT deployment
🟢 UAT validation by a person
🟢 Production deployment
🟢 Production smoke test
Architecture health: 92/100
Technical debt introduced: +1.4
Files touched: 12
APIs touched: 3
DB objects touched: 4
```

and you drill downward **only when you care**.

## The central object is a Feature

Not a ticket, not a branch, not a conversation. A persistent object. It contains the original
conversation; from it the system extracts acceptance criteria, constraints, security
considerations, affected systems, expected behaviour. Then everything attaches to it: the
planning session, the issue, the branch, commits, PR, tests, UAT deployment, the person's
validation, production deployment, telemetry after. Six months later: *"Why does this button
exist?"* — answered by reconstructing the history, not from source comments.

## The codebase digital twin

You don't need every line; you need the **shape**. A graph, continuously rebuilt, with a zoom
control: PRODUCT → MODULES → FEATURES → SERVICES → APIs → FUNCTIONS → FILES → CODE. Overlay
runtime (POST /customer → service → repository → table). Overlay features (FEATURE-284 → Status
UI, Admin API, cloning service, audit logging). Default human altitude: Features / Services.
Claude works at Functions / Files; Codex at Files / Code; the orchestrator across the whole graph.

## Measure AI's particular weaknesses

Assume AI writes imperfect code; continuously detect the imperfections AI produces: duplication,
semantic duplication, dependency creep, architecture violations, API proliferation, schema creep,
dead code, module growth, coupling, complexity trend, test overlap/gaps, security drift, pattern
drift, dependency vulnerabilities, runtime anomalies. Not red/green lights — **trends**. "What
happened in August?" → "73% of the coupling increase came from the reporting work; three new
services independently implemented customer lookup."

## The orchestrator is a first-class persona

You chat with the **Engineering Orchestrator**, not with Claude or Codex. Before touching
anything it investigates ("I found an existing snapshot mechanism… recommend extending it… affects
Admin UI, Environment API, DB Operations… no schema change… risk low") and then delegates. You
see one tree — Orchestrator → Backend ✓ Frontend ✓ Test ✓ Security ✓ Architecture ⚠ ("existing
database-copy service duplicates ~61% of the new implementation; refactor before merging") — not
six chats. That is the guardrail against AI spaghetti.

## Conversations are engineering artifacts

INTENT → DESIGN → DECISIONS → IMPLEMENTATION → VALIDATION → RELEASE, generated from the work.
The AI produces the paperwork; nobody writes it.

## The homepage is an air-traffic-control screen

Five areas: **Build** (orchestrator chat, where features originate) · **Features** (every
capability moving Idea → Design → Building → Testing → UAT → Production → Verified) ·
**Architecture** (the living map) · **Health** (the observatory and its trends) ·
**Operations** (releases, runtime, feature-level telemetry). And in the corner a small button,
`<> Code` — the basement door. You don't live down there anymore.
