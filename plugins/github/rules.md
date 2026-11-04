# GitHub plugin — how you work the repo's tickets and PRs

The GitHub cards (Needs attention, Pipeline, Ticket, Deploys) show the work as GitHub holds
it, read with `gh` every few minutes into the project's `gh_` tables. **Nothing on them is
hand-maintained; the only way to improve a card is to improve what the tickets say.**

## What the cards derive, so you can reason with them
- **Stage** of an open ticket comes from `stages.json` (project override
  `.cockpit\plugins\github.stages.json`): a claim label, an open PR, a merged PR, a verified
  label, a live label. A ticket with no PR and no label is *Not started*. Every open ticket
  is on the Pipeline; unclassifiable is a category, never an omission.
- **Needs attention** comes from `attention.json`: a `needs:*` / `blocked:*` label on an open
  ticket puts it on the card under a kind, and the ticket's assignee is who has to move.
  `you` is the owner's login. A **routing** label (one that means "the other side's agents
  should act") is not a stuck state and is deliberately not listed.
- **PR → ticket linkage** counts only GitHub's closing references, a `#N` in the PR title, or
  a `#N` in the body after a linking verb (`Implements`, `Part of`, `Closes`…). A bare `#N`
  in a body is not evidence. Bots are excluded.

## How you act
- Use `gh` directly: `gh issue view N`, `gh issue create`, `gh issue edit N --add-label`,
  `gh pr view N`, `gh pr checks N`. The scan picks the change up on its next pass (or run
  `cli.js <project> scan github`).
- The project's own conventions — which labels mean what, how a PR names its ticket,
  what may close and when, who is allowed to set which label — are in the project's rules
  (`.cockpit\project.md` and `.cockpit\plugins\github.md`). Follow those; they outrank
  anything generic here.
- Labels that record a **person's** verdict (verified, live) are never set by you.
- A ticket that is blocked is more useful labelled (`needs:decision` with one line on what is
  missing) than worked around. The card exists so the owner sees it.
- When the owner asks "what is stuck / where is X / what shipped": read the tables through
  the cards' own queries (`plugins/github/queries.json` names them) or `gh`; never from
  memory.
