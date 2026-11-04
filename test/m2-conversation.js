// Milestone 2 acceptance: a real turn through Claude Code, recorded by Cockpit.
const fs = require('node:fs'), path = require('node:path');
const BASE = 'http://localhost:4500';
// Runs against a live engine on :4500. Spends two small Claude Code turns on the owner's plan.
// node test/m2-conversation.js <scratch folder>
const DEMO = path.resolve(process.argv[2] || path.join(require('node:os').tmpdir(), 'cockpit-demo-project'));
const j = (r) => r.json();
const get = (u) => fetch(BASE + u).then(j);
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j);
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };

(async () => {
  fs.mkdirSync(path.join(DEMO, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(DEMO, 'notes', 'a.md'), '# a note\n\nThe secret word is pelican.\n');
  const r = await post('/api/projects', { path: DEMO });
  const ID = r.project.id;

  // send a message on a new thread, sonnet, read-only
  const s = await post('/api/p/' + ID + '/chat/send', { thread: null, text: 'Read notes/a.md and reply with only the secret word.', harness: 'claude-code', model: 'sonnet' });
  ok('send starts a turn', s.ok && s.turn && s.thread, JSON.stringify(s));

  // read the event stream until 'end'
  const events = [];
  await new Promise((resolve) => {
    fetch(BASE + '/api/p/' + ID + '/chat/events?turn=' + s.turn).then(async (res) => {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const line = chunk.replace(/^data: /, ''); try { const ev = JSON.parse(line); events.push(ev); if (ev.type === 'end') return resolve(); } catch (e) {} } }
      resolve();
    });
  });
  const types = events.map((e) => e.type);
  ok('events: start first', types[0] === 'start', types.join(','));
  ok('events: a tool ran (Read)', events.some((e) => e.type === 'tool' && e.name === 'Read'));
  ok('events: text arrived', events.some((e) => e.type === 'text'));
  ok('events: cost reported in tokens', events.some((e) => e.type === 'cost' && e.inTokens > 0 && e.outTokens > 0));
  const end = events.find((e) => e.type === 'end');
  ok('events: end with reason done', end && end.reason === 'done', end && end.reason);
  ok('outcome: not producedNothing', end && end.outcome && end.outcome.producedNothing === false);
  ok('the model read the file', /pelican/i.test(end.outcome.text), JSON.stringify(end.outcome.text));

  // what Cockpit recorded
  const t = await get('/api/p/' + ID + '/chat/thread?id=' + s.thread);
  ok('thread has user + assistant turns', t.turns.length === 2 && t.turns[0].role === 'user' && t.turns[1].role === 'assistant', t.turns.map((x) => x.role).join(','));
  ok('assistant turn carries harness and model', t.turns[1].harness === 'claude-code' && t.turns[1].model === 'sonnet');
  ok('thread titled from the first message', /secret word/.test(t.title), t.title);
  const convDir = path.join(DEMO, '.cockpit', 'conversations');
  const md = fs.readdirSync(convDir).find((f) => f.startsWith('0001-'));
  ok('markdown mirror written', !!md, md);
  ok('mirror contains the answer', md && /pelican/i.test(fs.readFileSync(path.join(convDir, md), 'utf8')));
  const log = fs.readFileSync(path.join(DEMO, '.cockpit', 'logs', 'turns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('turns.jsonl has one row per event, harness+model as columns', log.length >= events.length && log.every((l) => l.harness === 'claude-code' && l.model === 'sonnet'), log.length + ' rows');

  // second turn on the same thread: the transcript is handed over (no session id)
  const s2 = await post('/api/p/' + ID + '/chat/send', { thread: s.thread, text: 'What was the secret word you just told me? One word.', harness: 'claude-code', model: 'sonnet' });
  await new Promise((resolve) => { fetch(BASE + '/api/p/' + ID + '/chat/events?turn=' + s2.turn).then(async (res) => { const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); if (/"type":"end"/.test(buf)) return resolve(); } resolve(); }); });
  const t2 = await get('/api/p/' + ID + '/chat/thread?id=' + s.thread);
  const last = t2.turns[t2.turns.length - 1];
  ok('second turn remembers via the transcript Cockpit handed over', last.role === 'assistant' && /pelican/i.test(last.text), JSON.stringify(last.text));
  const startEv2 = log.length; // just informational
  ok('4 turns on the thread', t2.turns.length === 4, t2.turns.length);

  await fetch(BASE + '/api/projects/' + ID, { method: 'DELETE' });
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
