// Milestone 3b: the AI in the app puts the plugin together. Same calls the Plugins card makes.
const BASE = process.env.COCKPIT_URL || 'http://localhost:4500';
const j = (r) => r.json();
const get = (u) => fetch(BASE + u).then(j);
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(j);
// Runs against a live engine; spends one real Claude Code turn. node test/m3-ai-sets-up-plugin.js <project-id>
const ID = process.argv[2] || 'my-app';
(async () => {
  // 1. the wizard's Select
  const sel = await post('/api/p/' + ID + '/plugins/architecture/select', { answers: { type: 'website-php', liveUrl: 'http://localhost:9000', skip: '.cockpit,.git,node_modules,vendor,cache,.vscode,nbproject,aeon_unzipped' } });
  console.log('selected:', sel.ok);
  // 2. the message the card sends to the conversation
  const msg = 'The Architecture plugin was just set up for this project with these answers: ' + JSON.stringify(sel.answers) + '. Put it together for the first time: run its scan, tell me what it found, and ask me what you need to know.';
  const s = await post('/api/p/' + ID + '/chat/send', { thread: null, text: msg, harness: 'claude-code', model: 'sonnet' });
  console.log('turn', s.turn, 'thread', s.thread);
  // 3. watch
  const res = await fetch(BASE + '/api/p/' + ID + '/chat/events?turn=' + s.turn);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2); let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      if (ev.type === 'tool' && ev.name) console.log('  tool', ev.name, (ev.input || '').slice(0, 110));
      if (ev.type === 'error') console.log('  ERROR', ev.text.slice(0, 200));
      if (ev.type === 'end') { console.log('\n=== outcome:', ev.reason, ev.outcome.producedNothing ? 'PRODUCED NOTHING' : '', ev.outcome.cost ? ev.outcome.cost.inTokens + ' in / ' + ev.outcome.cost.outTokens + ' out' : '', ev.outcome.durationSec + 's'); console.log('\n=== the AI said:\n' + ev.outcome.text); process.exit(0); } } }
})();
