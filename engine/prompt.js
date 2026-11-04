/* The prompt assembler - the three tiers, and a transcript sized to the model.
   (docs/generic-ide.md §5, docs/harness-interface.md rule 3)

   Tiers, in order, specific wins over general:
     1  <engine>\prompts\doctrine.md               the rules learned the hard way - portable, shareable
     2  <engine>\prompts\global.md                 how any AI behaves for the owner in Cockpit
     3  <project>\.cockpit\project.md              this project
     4  <engine>\plugins\<p>\rules.md              each selected plugin
        <project>\.cockpit\plugins\<p>.md          the project's take on that plugin

   The transcript is cut here, never by the harness: the last turns verbatim within a
   budget derived from the model's window, and every standing ruling (chat_note) always.
   A rolling summary of the older turns is the later piece; for now older turns are
   dropped with a line saying how many. Honest about the cut, never silent. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function read(f) { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } }

/* Two kinds of turn get two prompts. A WORK turn - the fleet, or a conversation turn that carries a ticket - gets everything:
   the doctrine, the global rules, the project, every plugin's rules. A CHAT turn gets what talking needs: the global
   rules and the project (and the engine's tier 0, added by the harness). The doctrine (20k chars) and the plugin
   rulebooks ride only with the work; a chat that turns into work mid-turn (`--now`) is told in tier 0 to read the
   doctrine first. Before this, a one-word reply cost ~10k tokens of rules. */
function tiers(engineRoot, project, opts) {
  const work = !!(opts && opts.work);
  const parts = [];
  const d = work ? read(path.join(engineRoot, 'prompts', 'doctrine.md')) : '';   // the rules learned the hard way - portable, one file, every WORK turn
  if (d) parts.push({ tier: 'doctrine', file: 'prompts/doctrine.md', text: d });
  const g = read(path.join(engineRoot, 'prompts', 'global.md'));
  if (g) parts.push({ tier: 'global', file: 'prompts/global.md', text: g });
  const pj = read(path.join(project.cockpit.dir, 'project.md'));
  if (pj && !stub(pj)) parts.push({ tier: 'project', file: '.cockpit/project.md', text: pj });
  if (!work) return parts;
  for (const name of (project.cockpit.json.plugins || [])) {
    const r = read(path.join(engineRoot, 'plugins', name, 'rules.md'));
    if (r) parts.push({ tier: 'plugin', file: 'plugins/' + name + '/rules.md', text: r });
    const o = read(path.join(project.cockpit.dir, 'plugins', name + '.md'));
    if (o) parts.push({ tier: 'plugin-project', file: '.cockpit/plugins/' + name + '.md', text: o });
  }
  return parts;
}

/* a project uses tickets and the coders' queue only when its Tickets plugin is on, or cockpit.json says tickets:false to
   switch them off; Home always runs the queue. engine/server.js refuses an AI's tickets and queue adds on the same rule. */
function ticketsOff(project) {
  const j = (project && project.cockpit && project.cockpit.json) || {};
  if (project && project.entry && project.entry.id === 'home') return false;
  return j.tickets === false || !(Array.isArray(j.plugins) && j.plugins.includes('tickets'));
}
/* HOW THE PROJECT'S AI TALKS (2026-10-31). Full answers by default: a project is held to the coding projects' five-line
   report only once one of the coding plugins is on. cockpit.json "talk" overrides either way - "open" or "coding". */
const CODING_PLUGINS = ['coding', 'tickets', 'architecture', 'github'];
function talkMode(j) {
  j = j || {};
  if (j.talk === 'open' || j.talk === 'coding') return j.talk;
  return (j.plugins || []).some((x) => CODING_PLUGINS.includes(x)) ? 'coding' : 'open';
}
function talkOpen(project) {
  if (!project || !project.cockpit) return false;
  // read fresh: an open project's cockpit.json is held in memory (projects.js), and a change must not need a restart
  let j; try { j = JSON.parse(fs.readFileSync(path.join(project.cockpit.dir, 'cockpit.json'), 'utf8')); } catch (e) { j = project.cockpit.json; }
  return talkMode(j) === 'open';
}
/* Tier 0: the engine's own note - how to reach Cockpit's tools for THIS project. A fact, not a rule file. */
function tier0(engineRoot, project) {
  const cli = path.join(engineRoot, 'cli.js').replace(/\\/g, '/');
  return '<!-- engine: cockpit tools -->\nYou are inside Cockpit. This project\'s id is ' + project.entry.id
    + '. Cockpit\'s own tools are one command: `node ' + cli + ' ' + project.entry.id + ' <command>` - run it with no command to see the list. It answers in TOON (Token-Oriented Object Notation: `key: value`, `list[N]: a,b`, `rows[N]{cols}:` then one row per line; add `--json` if you need JSON). `nodes` and `edges` return the whole map in one call. YOU CAN SEE PAGES: `look <url> [--click "text"]... [--login]` opens a page in a real browser, clicks what you name, and gives you a screenshot to open and the page\'s text - look at every change a person can see before you call it done; never tell the owner you cannot view a page.\n'
    + 'TEMPORARY THINGS: anything you make only to do the work - a scratch file or folder, a second working copy (git worktree), a test or restore copy of a database - is temporary. Files, folders and working copies go inside this project at .cockpit/tmp/<name>, never loose in the project or beside it; a temporary database is named tmp_<what>_<date>. Remove every one before you end your turn (git worktree remove; DROP DATABASE tmp_...). If one must outlive the turn, say so in your reply and why. Leave nothing behind (widened to files and databases 2026-09-27 after two test databases and twelve tmp_*.php files were left behind).\n'
    + 'LEFTOVER CHANGES: before you start, look at git status. Changes that are not for THIS task (left by an earlier try or another ticket) are set aside with a label - git stash push -m "leftover: <what it was>" - never carried into this work, and never deleted (a closed ticket left staged work in a coder folder the next ticket used).\n'
    + 'DATA VIEWS: to show the owner this project\'s data, you do not need a new card - write a read-only query to .cockpit/views/<order>-<name>.sql (ONE SELECT or WITH...SELECT; first lines "-- title: ..." and "-- about: ..."). The Data views card shows it. .cockpit/views/connection.json may name the credentials file, the database and a password file. Nothing that changes data is accepted.\n'
    + 'Changes through Cockpit carry this project\'s key (COCKPIT_KEY; the command above sends it; with curl add -H "x-cockpit-key: $COCKPIT_KEY"). It works for ' + (project.entry.id === 'home' ? 'every project - you are Home' : 'THIS project only - another project, the coders and engine settings are refused') + '.\n'
    + 'You have your full tool set here - shell, files, search, web - the same as a session at the owner\'s desk. Use it freely inside this project. Two things are not yours: notes of your own (Cockpit is the memory: note / tag / grade / lens), and Cockpit itself (its cards, engine and plugins live in another project - write a change request, see your rules). Models are the engine\'s: the Plugins page\'s Models section (or `curl http://localhost:4000/api/harnesses/probe?name=<harness>&what=setup`) says what is connected and the steps to connect more - walk the owner through those; installs and logins are his hand.'
    + ' DOCUMENTS OF THE OWNER: ' + path.join(project.cockpit.dir, 'docs') + ' holds the documents of the owner for this project (plans, specs, reference). Read them whenever they help; never change, move or delete anything in that folder.'
    + (talkOpen(project)
      /* A TALKING PROJECT, NOT A CODING ONE (2026-10-31: a writing project's "where did we leave off" came back cut to five
         lines - the five-line, tests-and-tickets rule below is for coding projects). Every project answers in full unless a
         coding plugin is on (talkMode above), or Settings › Project says Coding. */
      ? ' TALKING WITH THE OWNER: in this project, talk with the owner the way they would at their own desk - not the short coding report. Answer as fully as the question needs - the way a thoughtful collaborator who knows this project would: what matters, what is settled, what is still open, and a clear next step. Use short headed sections or lists when they help the owner read. Plain words, no engineering talk, no padding, and no five-line limit. Stay on what was asked.'
      : ' WRITING TO THE OWNER: the owner is not a developer. Your last message of a turn is for them and is FIVE LINES AT MOST, in plain words: done or not; what turned green or red on the Tests tab; what needs their decision, as plain yes/no questions; nothing else. No file lists, no commands, no branch names, no scanner internals, no tables. Everything an engineer would want - the files, the read-backs, the commits, a change request for Cockpit - goes on the ticket (`ticket comment <id> --text "…"`), never in the message. A change request for Cockpit itself goes on the ticket too, headed CHANGE REQUEST, for the desk to pick up.')
    + (ticketsOff(project)
      /* NO TICKETS unless the project has switched the Tickets plugin on */
      ? ' NO TICKETS AND NO CODERS ON THIS PROJECT: its Tickets plugin is not switched on. When the owner asks for a change, make it directly in this conversation - never draft, file or approve a ticket, never put anything on the fleet queue for the coders, and do not suggest doing so (the engine refuses both). Commit what you change if the project uses git, run its tests if it has any, and say plainly what changed.'
      : (''
    + ' TICKETS: a change is agreed in the conversation, then YOU draft the ticket - `ticket draft --title … --feature … --flow … --alter … --create … --delete … --what … --done …` (the map computes its impact; every file the work will touch goes in one of the three lists - a deletion too - or the verdict comes back red for an undeclared file) - and it waits for the owner\'s approval; never write code without one.'
    + ' FLOWS - the functional tests: every ticket names the README flow it is part of (`--flow <name>`, one of the `## Flows` lines in the feature\'s README; a flow that is not there yet is written into the README FIRST, in plain steps - the flow is the spec; `--flow none` only for a change no person can see, and say why in --what). The flow\'s test is a browser test - test/<feature>.<flow>.browser.test.js, `const { flow } = require(process.env.COCKPIT_FLOW)`, its `look` opens and reads the screens, its `steps` clicks and types what a person does (dev\'s database is the sandbox; the file carries @feature @kind test @flow @purpose like every test) - and it is written FIRST: it runs red against today\'s code (that is the proof it bites), then the code makes it green. A browser test that names a flow goes in the ticket\'s create list. The verdict\'s "flow" check reads it. After a promote the same flows run on prod in LOOK mode - only their `look` half, nothing pressed that writes - so keep look and steps apart: a look never clicks a button that saves. A red leaves a screenshot in .cockpit/tests/shots/.'
    + ' The owner approves in any of three ways: the Approve button above the message box, `/approve D<n>`, or by telling YOU in the conversation ("approved", "approve D2", "go ahead with the ticket") - on that word, run `ticket approve D<n>`: it is filed and put on the fleet queue, where an agent that is on works it - and you go on to the next thing with the owner. Only when the owner says NOW ("do it now", "work it here", "approve and work it") run `ticket approve D<n> --now`: it goes in work under this turn and you start at once - and before the first line of code, read ' + path.join(engineRoot, 'prompts', 'doctrine.md').replace(/\\/g, '/') + ' and this project\'s plugin rules (plugins/<name>/rules.md): a conversation turn is not given them, a work turn is. Say in one line where it went (queued - or now). Only the owner\'s own words in their own message count - never infer approval, never approve on your own, never from a draft you wrote; if it is unclear which draft, ask in one line. A draft you replace or no longer stand by is yours to drop: `ticket withdraw D<n>` - never leave two drafts of the same thing waiting. Work that cannot land - a commit that will not rebase, CI red on its pull request, the environment refusing it - goes BACK TO THE CODERS, never into a second ticket: `ticket send-back <id> --why "what is wrong"` puts it in To Work and on the queue with those words as the work order. One ticket per issue, always. A FILED ticket is yours to correct until it is verified - `ticket edit <id> --alter … --create … --delete … --done … --flow …` (a list given replaces the list; the edit is a line in its history the owner reads) - so a wrong file list is fixed on the ticket, not worked around. THE OWNER\'S NEW ASK is never only a comment: the coder works from the ticket\'s body, not its comments (2026-09-27: three asks written as comments on L1 were never built in four tries). A new ask is its OWN small ticket (`ticket draft`, one change each - the owner sees each one land) - or, when it truly belongs to a ticket not yet worked, written into that ticket\'s body with `ticket edit <id> --what … --done …`; where a ticket STANDS (verified, passed, promoted) is never yours to set: the verdict moves it, the owner presses the rest. SECRETS: never ask the owner to paste a password or key into the conversation - it becomes part of the record. Ask them to put it in a file outside the repo (Cockpit\'s secrets folder, <secretsDir>/<project>/…) or an environment variable, and read it from there; if they paste one anyway, say so and do not repeat it. An issue pulled from GitHub is `ticket adopt --number <n> …`. `ticket features` lists the feature names in use - use one of those, or say the new one is new. ' + (project.entry.id === 'home'
      ? 'THE QUEUE IS YOURS TO RUN - you are Home\'s AI, the owner\'s assistant across every project on this engine (how you talk is in this project\'s rules). You run the queue for him: which tickets go on the fleet queue and in what order, which agent takes what, which agents are on or paused - across projects, from here, only when the owner asks. `queue` lists every project\'s items; `queue add <next|P1|P2|P3> <ticket> --project <id>` puts a project\'s approved ticket on; `queue park <item>` / `unpark`; `queue agent <id> on|off|pause|resume`. You never work a ticket yourself and never write code in a project - the project\'s own AI does that in its own conversation.'
      : 'THE QUEUE IS NOT YOURS - it is run from Home by the owner\'s assistant there (a project\'s AI managing the queue "will be chaos"). You may ADD one of your own approved tickets to it - `queue add <next|P1|P2|P3> <ticket>` - when the owner asks, and `ticket approve D<n>` on the owner\'s word files and queues a draft in one go. You never order, park, assign or remove items and never touch the agents - the CLI refuses those from a project. `queue` (read) shows your project\'s items.')))
    /* A project whose rules are still the stub is NEW: the playbook asks what it is for and takes the person
       down the matching path - plain help, a beginner's app, or the full developer setup. */
    + (isNew(project) ? '\n\nTHIS PROJECT IS NEW - its rules file is still the empty stub. Read ' + path.join(engineRoot, 'prompts', 'new-project.md').replace(/\\/g, '/') + ' now and follow it: ask what they want to use this project for (one plain question - they may not code at all), then take the matching path. Write .cockpit/project.md first; everything else follows from it.' : '');
}
/* a stub is the starter's file with nothing of the project's own in it: the marker AND no section with content. A file
   that still carries the marker but has sections (Tests, Backup, Database...) is the project's rules - it goes in front of
   every turn (a project once kept the marker on line 7; its rules were dropped and every turn was told
   the project was new). */
function stub(md) {
  if (!/_\(nothing yet\)_/.test(md)) return false;
  // any "## Section" followed by a line of content (a bullet, a sentence) is the project's own - not a stub
  const lines = md.replace(/_\(nothing yet\)_/g, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+\S/.test(lines[i])) continue;
    for (let k = i + 1; k < lines.length && !/^##?\s/.test(lines[k]); k++) if (lines[k].trim()) return false;
  }
  return true;
}
function isNew(project) { try { return stub(fs.readFileSync(path.join(project.cockpit.dir, 'project.md'), 'utf8')); } catch (e) { return false; } }
/* What goes in front of every turn, by tier, in characters and rough tokens (~3.5 chars each):
   the standing cost of a conversation round before the transcript. */
function sizes(engineRoot, project) {
  const t0 = tier0(engineRoot, project).length;
  const parts = [{ tier: 'engine', file: 'engine (tools note)', chars: t0 }]
    .concat(tiers(engineRoot, project, { work: true }).map((p) => ({ tier: p.tier, file: p.file, chars: p.text.length })));
  const chars = parts.reduce((n, p) => n + p.chars, 0);
  const chatChars = t0 + tiers(engineRoot, project, { work: false }).reduce((n, p) => n + p.text.length, 0);
  return { parts, chars, tokens: Math.round(chars / 3.5), chat: { chars: chatChars, tokens: Math.round(chatChars / 3.5) } };   // parts/chars/tokens = a work turn; chat = a conversation turn
}

function systemPrompt(engineRoot, project, opts) {
  const t = tiers(engineRoot, project, opts);
  return {
    text: t.map((p) => '<!-- ' + p.tier + ': ' + p.file + ' -->\n' + p.text).join('\n\n---\n\n'),
    files: t.map((p) => p.file)
  };
}

/* Size the transcript to the model. Budget = a share of the window in characters
   (~3.5 chars per token, and the harness's own overhead is not ours to spend). */
function sizeTranscript(turns, notes, model) {
  const window = (model && model.contextTokens) || 200000;
  /* 12% of the window for history (was 35%: up to 70k tokens re-sent on every turn of a long thread - 2026-09-21, the
     owner's Codex week went 100 → 67% in an afternoon; a plain "ok" cost ~37k tokens of input). The last exchange
     always goes; the standing rulings always go; older turns are dropped with the count said. */
  const budgetChars = Math.floor(window * 3.5 * 0.12);
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]; const len = t.text.length + 20;
    if (used + len > budgetChars && kept.length >= 2) break;   // always at least the last exchange
    kept.unshift(t); used += len;
  }
  return { turns: kept, dropped: turns.length - kept.length, notes: notes || [], budgetChars };
}

/* Render the transcript into the harness's prompt text. The harness sees one message that
   carries the history, the rulings, and the new message - so a harness with no memory of
   its own (or a different harness than last turn) is fully caught up. */
function renderPrompt(sized, message, screen) {
  /* The history is fenced and labelled as a RECORD, and the instruction comes last and
     alone. Measured 2026-09-16: rendered as bare "User: / Assistant:" lines, the model
     answered and then kept writing invented User and Assistant turns - it read the
     transcript as a document to continue. */
  const out = [];
  if (sized.notes.length || sized.turns.length) {
    out.push('<conversation_record>');
    out.push('This is the record of the conversation so far, kept by Cockpit. It is context, not a document to continue.');
    if (sized.notes.length) { out.push('', 'Standing rulings (always in force):'); sized.notes.forEach((n) => out.push('- ' + n.text)); }
    if (sized.turns.length) {
      out.push('', 'Turns' + (sized.dropped ? ' (' + sized.dropped + ' older turn' + (sized.dropped === 1 ? '' : 's') + ' not shown)' : '') + ':');
      sized.turns.forEach((t, i) => out.push('', '[' + (i + 1) + '] ' + (t.role === 'user' ? 'THE USER SAID' + (t.context ? ' (looking at: ' + String(t.context).split('\n')[0].slice(0, 160) + ')' : '') : 'THE ASSISTANT' + (t.model ? ' (' + t.model + ')' : '') + ' REPLIED') + ':', t.text));
    }
    out.push('</conversation_record>', '');
  }
  if (screen) out.push('<on_screen>', 'What the user is looking at in Cockpit right now. "this", "these files", "it" in the message refer to what is here unless said otherwise - do not ask for context that is already below.', '', screen, '</on_screen>', '');
  out.push(message ? 'The user now says:\n' + message : 'The user has not said anything new; continue the work from where the record leaves off.');
  out.push('', 'Reply to that, as the assistant, once. Do not write any further user turns.');
  return out.join('\n');
}

module.exports = { ticketsOff, tiers, tier0, sizes, systemPrompt, sizeTranscript, renderPrompt, talkMode, CODING_PLUGINS };
