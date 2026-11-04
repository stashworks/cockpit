// Milestone 4: the second and third harnesses, and the switch mid-conversation - against a
// running engine (COCKPIT_URL). One small read-only question per harness, then a follow-up on the same
// thread under a different harness, which must remember the first answer from Cockpit's record.
// Spends real AI turns. node test/m4-three-harnesses-and-the-switch.js <project-id>
const BASE = process.env.COCKPIT_URL || 'http://localhost:4500';
const ID = process.argv[2] || 'my-app';
const j = (r) => r.json();
const get = (u) => fetch(BASE + u).then(j);
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(j);

async function turn(thread, text, harness, model) {
  const s = await post('/api/p/' + ID + '/chat/send', { thread, text, harness, model });
  if (!s.ok) return { error: s.error };
  const res = await fetch(BASE + '/api/p/' + ID + '/chat/events?turn=' + s.turn);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; const evs = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2); try { const ev = JSON.parse(line); evs.push(ev); if (ev.type === 'end') return { thread: s.thread, evs, end: ev }; } catch (e) {} } }
  return { thread: s.thread, evs, end: evs.find((e) => e.type === 'end') };
}
function report(label, r) {
  if (r.error) { console.log(label, 'FAILED to start:', r.error); return; }
  const o = r.end.outcome || {};
  const tools = r.evs.filter((e) => e.type === 'tool' && e.name).map((e) => e.name + ' ' + (e.input || '').slice(0, 50));
  const errs = r.evs.filter((e) => e.type === 'error').map((e) => e.text.slice(0, 300));
  const infos = r.evs.filter((e) => e.type === 'info').map((e) => e.text.slice(0, 120));
  console.log('\n=== ' + label + ': ' + r.end.reason + (o.producedNothing ? ' PRODUCED NOTHING' : '') + ' · ' + (o.cost ? o.cost.inTokens + ' in / ' + o.cost.outTokens + ' out' : 'cost not reported') + ' · ' + o.durationSec + 's');
  if (tools.length) console.log('  tools:', tools.join(' | '));
  if (infos.length) console.log('  info:', infos.join(' | '));
  if (errs.length) console.log('  ERRORS:', errs.join(' || '));
  console.log('  said:', (o.text || '').replace(/\s+/g, ' ').slice(0, 400));
}
(async () => {
  const q = 'Read PHILOSOPHY.md in this project and reply with only its first heading, nothing else.';
  const which = (process.argv[3] || 'codex,pi,switch').split(',');
  let t = null;
  if (which.includes('codex')) { const r = await turn(null, q, 'codex-cli', 'default'); report('Codex CLI / gpt-5-codex', r); t = r.thread; }
  if (which.includes('pi')) { const r = await turn(null, q, 'pi', 'qwen3-coder:30b'); report('Pi / qwen3-coder:30b', r); if (!t) t = r.thread; }
  if (which.includes('switch') && t) {
    const r = await turn(t, 'What heading did you just tell me? Repeat it exactly, nothing else.', 'claude-code', 'sonnet');
    report('SWITCH -> Claude Code / sonnet on the same thread', r);
  }
})();
