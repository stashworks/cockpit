/* The doctrine as data: prompts/doctrine.md read into rules, so the Architecture tab can list
   EVERY rule with what the map can say about it. Read fresh each call; the
   file is the source, this is a view of it.

   Each rule: id (the ### heading), rule (first sentence of **Rule:**), status, validated,
   check = { kind: 'map', values: [problem values] } when the Check line names Problems values,
   or { kind: 'judgement', where } when it names where a person judges it. Hot module. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function parse(engineRoot) {
  let text = ''; try { text = fs.readFileSync(path.join(engineRoot, 'prompts', 'doctrine.md'), 'utf8'); } catch (e) { return { ok: false, error: 'no prompts/doctrine.md', rules: [] }; }
  const rules = [];
  const parts = text.split(/^### /m).slice(1);
  for (const p of parts) {
    const lines = p.split('\n'); const id = lines[0].trim();
    if (!/^[a-z0-9-]+$/.test(id)) continue;
    const body = lines.slice(1).join('\n');
    const field = (name) => { const m = new RegExp('\\*\\*' + name + ':\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Za-z ]+:\\*\\*|\\n\\n|$)').exec(body); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
    const rule = field('Rule'), statusLine = field('Status'), check = field('Check'), scar = field('The scar'), apply = field('Apply it'), not = field('Does NOT apply when');
    const status = (/\b(active|candidate|retired)\b/.exec(statusLine) || [])[1] || 'active';
    const validated = (/Last validated:\*?\*?\s*([0-9-]+)/.exec(statusLine) || [])[1] || null;
    const values = []; const rv = /\*\*([a-z0-9-]+)\*\*/g; let m; while ((m = rv.exec(check))) values.push(m[1]);
    const kind = /^judgement/i.test(check) || (!values.length) ? 'judgement' : 'map';
    rules.push({ id, rule: rule.split(/(?<=\.)\s/)[0], ruleFull: rule, status, validated, scar, apply, not,
      check: kind === 'map' ? { kind, values, text: check } : { kind, where: cleanWhere(check), partly: backticked(check), text: check } });
  }
  return { ok: true, rules, count: rules.length, file: 'prompts/doctrine.md' };
}
function cleanWhere(c) { const w = c.replace(/^judgement/i, '').replace(/^[\s—.:(-]+/, '').replace(/^partly:?\s*/i, '').trim(); return w && w !== '.' ? w : 'a person judges this'; }
function backticked(c) { const out = []; const r = /`([a-z0-9-]+)`/g; let m; while ((m = r.exec(c))) out.push(m[1]); return out; }   // "partly: `value` catches ..." - a value the map checks for part of the rule

module.exports = { parse };
