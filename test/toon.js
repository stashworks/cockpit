/* TOON encoder: shapes the cli actually emits, checked against the spec's forms. */
'use strict';
const assert = require('node:assert/strict');
const { encode } = require('../engine/toon');

const t = (name, v, want) => { const got = encode(v); assert.equal(got, want, name + '\n--- got ---\n' + got + '\n--- want ---\n' + want); console.log('ok  ' + name); };

t('flat object', { ok: true, n: 3, name: 'Acme', why: null }, 'ok: true\nn: 3\nname: Acme\nwhy: null');
t('strings that must be quoted', { a: '', b: ' x', c: 'a,b', d: 'k: v', e: '42', f: 'true', g: '-dash', h: 'line\nbreak', i: 'say "hi"' },
  'a: ""\nb: " x"\nc: "a,b"\nd: "k: v"\ne: "42"\nf: "true"\ng: "-dash"\nh: "line\\nbreak"\ni: "say \\"hi\\""');
t('primitive array inline (a colon means quotes, per spec)', { tags: ['kind:test', 'reach:entry-point'], none: [] }, 'tags[2]: "kind:test","reach:entry-point"\nnone[0]:');
t('uniform rows are tabular', { items: [{ id: 1, title: 'a', status: 'queued' }, { id: 2, title: 'b, c', status: null }] },
  'items[2]{id,title,status}:\n  1,a,queued\n  2,"b, c",null');
t('keys in any order still tabular', { rows: [{ a: 1, b: 2 }, { b: 3, a: 4 }] }, 'rows[2]{a,b}:\n  1,2\n  4,3');
t('ragged objects become a list', { rows: [{ a: 1 }, { a: 2, b: 3 }] }, 'rows[2]:\n  - a: 1\n  - a: 2\n    b: 3');
t('objects with arrays become a list', { nodes: [{ subject: 'file:x.js', tags: ['a', 'b'] }, { subject: 'file:y.js', tags: [] }] },
  'nodes[2]:\n  - subject: "file:x.js"\n    tags[2]: a,b\n  - subject: "file:y.js"\n    tags[0]:');
t('nested object', { project: { id: 'acme-web', urls: { dev: 'https://x.local' } }, after: 1 }, 'project:\n  id: acme-web\n  urls:\n    dev: "https://x.local"\nafter: 1');
t('root array', [{ id: 1, v: 'x' }, { id: 2, v: 'y' }], '[2]{id,v}:\n  1,x\n  2,y');
t('root primitive', 'hello', 'hello');
t('empty object', {}, '');
t('array of arrays', { grid: [[1, 2], [3]] }, 'grid[2]:\n  - [2]: 1,2\n  - [1]: 3');
t('quoted key', { 'needs attention': 1, 'a-b': 2 }, '"needs attention": 1\n"a-b": 2');
t('list item whose first value is an object', { l: [{ meta: { x: 1 }, n: 2 }] }, 'l[1]:\n  - meta:\n      x: 1\n    n: 2');
console.log('ALL PASSED');
