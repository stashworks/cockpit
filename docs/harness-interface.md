# The harness interface — what every AI adapter must do

One interface, three adapters: Claude Code, Codex CLI, Pi (local). The engine never
talks to a harness except through this. It is the one thing that is expensive to change
later, so it is written down before the first adapter is built and it does not grow
without a decision.

## The idea in one paragraph

A harness runs a model in a folder with tools. Cockpit does not care how. Cockpit gives
the harness a **prompt** (the three tiers assembled), a **transcript** (what the
conversation has been so far — sized to what this model can hold), the **project folder**,
and the **tools** it may use. The harness runs one **turn** and streams back what
happened. Cockpit writes every event to the project's `.cockpit\`. The harness keeps no
memory Cockpit depends on; if the harness is swapped mid-conversation, the next one gets
the same transcript from Cockpit and carries on.

## The interface

```
Harness
  name            'claude-code' | 'codex-cli' | 'pi'
  models()        → [{ id, label, contextTokens, free }]     what this harness can run, and
                                                            whether a run costs plan or money
  available()     → { ok, why }                              is it installed, logged in, reachable
  start(turn)     → handle                                   begin one turn (below)
  stop(handle)    → void                                     kill it, process tree and all
```

```
turn
  project         absolute path of the project folder (the harness runs there)
  model           one of models().id
  prompt          the assembled tiers: global + project + plugin rules   (prompt.js)
  transcript      [{ role, text, at, harness?, model? }]  sized for this model  (§ sizing)
  message         the new user message, or null for a scheduled turn
  tools           which of Cockpit's tools this turn may use (names)
  limits          { maxMinutes, maxSilenceMinutes }        kill on silence, not on the clock
```

```
handle
  on(event)       subscribe — every event below, in order, as they happen
  done            promise → outcome
```

```
event                                one of:
  { type:'text',      text }                     model said something (streamed)
  { type:'tool',      name, input, output, ok }  a tool ran — Cockpit's or the harness's own
  { type:'file',      path, change }             a file in the project was written/edited/deleted
  { type:'cost',      inTokens, outTokens, usd? } what this turn cost, as the harness reports it
  { type:'error',     text }                     something failed and the turn continues
  { type:'end',       reason }                   'done' | 'stopped' | 'silence' | 'ceiling' | 'crashed'
```

```
outcome
  reason          the 'end' reason
  text            the model's final message
  files           every path touched, from the 'file' events
  cost            summed from the 'cost' events; null if the harness reported none
  producedNothing true when the turn ended with no tool run and no file touched
```

## Rules the interface carries

1. **Cockpit records, the harness forgets.** Every event is written to
   `.cockpit\logs\turns.jsonl` (one shape, `harness` and `model` are columns) and the
   conversation rows before the promise resolves. A harness's own session files are its
   business; Cockpit never reads them and never needs them.
2. **Transcript in, not session id in.** Cockpit hands the transcript every turn. That
   is what makes switching harnesses mid-conversation possible; it is also what makes a
   crashed harness recoverable — the next turn starts from Cockpit's record.
3. **Sized to the model.** `transcript` is cut by Cockpit to fit `contextTokens` of the
   target model: a rolling summary of the older turns, the last N turns verbatim, and
   every standing ruling from the conversation (`chat_note`) always. The harness does not
   truncate; if what it receives does not fit, it says so with an `error` event, not
   silently.
4. **Kill on silence, not on the clock.** `maxSilenceMinutes` is the working limit;
   `maxMinutes` is a ceiling for the one thing silence cannot see, a loop that keeps
   talking. Learned 2026-08-31 when the 90-minute clock killed real work.
5. **`producedNothing` is a first-class outcome.** A turn that woke, planned and exited
   reports so. It is not "finished cleanly". Learned 2026-08-31.
6. **Cost is what the harness says, attributed to the turn.** A killed turn may never
   reach the line that reports cost; the outcome then says `cost: null`, never a guess.
7. **A tool is a tool.** Cockpit's own tools (graph queries, tag grading, the queue) are
   handed to every harness the same way — as named commands the harness may call — and
   each adapter wires them in its harness's own mechanism (Claude Code: its tool
   surface; Codex CLI: same; Pi: an extension). The model sees the same names everywhere.
8. **The adapter is the only file that knows the harness.** No Claude-, Codex- or
   Pi-specific code anywhere else in the engine. If a fourth harness arrives, it is one
   new file.

## What each adapter does with this, in one line

| Adapter | Runs | Transcript goes in as | Events come from |
| --- | --- | --- | --- |
| `claude-code.js` | `claude -p` headless in the project folder, on the owner's Claude plan | the prompt plus a rendered transcript | its streamed JSON output |
| `codex-cli.js` | `codex exec` in the project folder, on the owner's Codex subscription | same | its JSON output |
| `pi.js` | Pi over RPC (stdin/stdout JSONL) with Ollama as the model endpoint | same | its RPC events |

## What is deliberately not in the interface

- No "resume a harness session". Cockpit's transcript is the session.
- No harness-specific options bag. If an adapter needs a setting, it reads it from
  `.cockpit\plugins\lanes.json` or the engine config; the interface stays the same.
- No streaming of the model's *thinking*. Text, tools, files, cost, end. Anything else is
  the adapter's to discard.

---
*Written 2026-09-16 before the first adapter. Changes to this file are decisions, made
with the owner, and dated here.*
