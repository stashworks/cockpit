/* PR -> ticket linkage and a PR's checks, shared by the scan (scan.js) and the fleet's read of a ticket when a turn
   ends (engine/ghqueue.js) - one rule, so the board and the queue never disagree about which PR is a ticket's.

   The 2026-08-10 audit ruling: a bare `#N` in a body is NOT evidence (every audited bare mention was diagnostic).
   Linkage counts only closingIssuesReferences, a `#N` in the TITLE, or a body `#N` after a linking verb
   (Implements / Part of / Closes ...). Bots are excluded - dependabot changelogs carry other repos' issue numbers. */
'use strict';
// whole words only (2026-11-01): without \b, "before #12" and "are #12" read as "re #12", so a PR that only mentioned a ticket
// in passing counted as finishing it
const LINKING = /\b(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve|implements|implement|part of|refs|ref|re)\s*:?\s*#(\d+)/gi;
const isBot = (login) => !login || /\[bot\]$/i.test(login) || /^(dependabot|github-actions|app\/)/i.test(login);
function ticketsOf(pr) {
  const m = new Map();
  for (const c of pr.closingIssuesReferences || []) m.set(c.number, 'closes');
  for (const x of String(pr.title || '').matchAll(/#(\d+)/g)) if (!m.has(+x[1])) m.set(+x[1], 'title');
  for (const x of String(pr.body || '').matchAll(LINKING)) if (!m.has(+x[1])) m.set(+x[1], 'body-verb');
  const rest = remaining(pr.body) || unsaid(pr, m);
  return [...m].map(([number, how]) => (rest ? { number, how, remaining: rest } : { number, how }));
}
/* A "PART OF" PR THAT NEVER SAYS WHAT IS LEFT IS NOT A FINISH. Measured once: 101 of the last 150
   merged PRs on one project said "Part of #N" with no Remaining line, and each one moved its ticket to In UAT. Two alert
   PRs did exactly that while the fix itself was never built. Now a merged "Part of" PR with no Remaining line sends the ticket
   back to its coder, who either does the rest or adds "Remaining: none" to that PR's body (which then counts as the finish).
   Only PRs merged from UNSAID_FROM on - the tickets already in UAT keep the reading they were moved on. */
const UNSAID_FROM = '2026-10-03T14:00:00Z';
const LINE = /^[ \t>*_-]*remaining[*_]*\s*:/im;
const UNSAID = 'not said - the PR says "Part of" but has no Remaining line. Compare the ticket\'s Closes when with main: if nothing is left, add the line "Remaining: none" to that PR\'s body (gh pr edit <PR> --body-file <file>) and stop; otherwise do the rest';
function unsaid(pr, m) {
  if (LINE.test(String(pr.body || '')) || !pr.mergedAt || pr.mergedAt < UNSAID_FROM) return null;
  const text = String(pr.title || '') + '\n' + String(pr.body || '');
  return [...m.keys()].some((n) => new RegExp('part of\\s*:?\\s*#' + n + '\\b', 'i').test(text)) ? UNSAID : null;
}
/* PART OF IT (a merged "Part of" PR moved its ticket to In UAT while half the ticket was still undone -
   "yes", send it back to To work instead). The coder says so in the PR body: "Remaining: <what is left>"; "Remaining: none"
   means this PR finishes the ticket's "Closes when" (no line at all: see unsaid() above). Returns the remaining text, or null
   when nothing is left. */
function remaining(body) {
  const m = /^[ \t>*_-]*remaining[*_]*\s*:[*_]*[ \t]*(.*)$/im.exec(String(body || '')); if (!m) return null;
  const t = m[1].replace(/[*_`]/g, '').trim();
  /* "none" LEADS the line, however it goes on (2026-09-28: "Remaining: none. Once merged, a member ..." and "none - once this
     merges ..." read as work left, so #4591 and #4588 went back to To work after merging and coders redid them). "none" must be
     followed by the end or punctuation - "none of the tests ..." is not a none. */
  return !t || /^(none|nothing|n\/a|-+)\b\s*($|[.,;:!()—–-])/i.test(t) ? null : t.slice(0, 300);
}
function checksOf(pr) {
  const roll = pr.statusCheckRollup || [];
  if (!roll.length) return pr.state === 'OPEN' ? 'none' : null;
  const st = roll.map((c) => String(c.conclusion || c.state || '').toUpperCase());
  if (st.some((s) => /FAIL|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(s))) return 'fail';
  if (st.some((s) => /PENDING|IN_PROGRESS|QUEUED|EXPECTED|^$/.test(s))) return 'pending';
  return 'pass';
}
module.exports = { LINKING, isBot, ticketsOf, checksOf, remaining };
