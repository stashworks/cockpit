/* TOON - Token-Oriented Object Notation - encoder.

   What the AI reads from Cockpit's tools is JSON's information at ~40% fewer tokens: keys
   once per table instead of once per row, no braces, no quotes unless a value needs them.
   Encode only - the model reads it, Cockpit never has to parse it back. Follows the TOON
   spec (toonformat.dev, v1): 2-space indent, comma delimiter, length markers.

     obj            key: value            nested: key: then indented lines
     primitives[]   key[3]: a,b,c
     uniform rows   key[2]{id,name}:      one row per line, values in column order
                      1,Alice
                      2,Bob
     anything else  key[2]:               list items, "- " prefix, objects continue indented
                      - id: 1
                        tags[2]: x,y
                      - plain
   Strings are quoted only when they must be (empty, spaces at the ends, a comma / colon /
   quote / backslash / newline / bracket, or a string that reads as a number, true, false,
   null, or starts with "-"). No dependency: 80 lines beats a package install. */
'use strict';

const IND = '  ';
const KEY_OK = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isPrim(v) { return v === null || v === undefined || typeof v !== 'object'; }
function esc(s) { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'; }
function str(s) {
  if (s === '' || /^\s|\s$/.test(s) || /[,:"\\\n\r\t\[\]{}]/.test(s) || s === 'true' || s === 'false' || s === 'null' || NUMERIC.test(s) || s[0] === '-') return esc(s);
  return s;
}
function prim(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Object.is(v, -0) ? 0 : v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return String(v);
  return str(String(v));
}
function key(k) { return KEY_OK.test(k) ? k : esc(k); }

/* An array is tabular when every element is a flat object with the same keys, in any order,
   and every value is a primitive. Header order = the first object's. */
function tabular(a) {
  if (!a.length || !a.every((o) => o && typeof o === 'object' && !Array.isArray(o))) return null;
  const cols = Object.keys(a[0]); if (!cols.length) return null;
  for (const o of a) { const k = Object.keys(o); if (k.length !== cols.length || !cols.every((c) => c in o && isPrim(o[c]))) return null; }
  return cols;
}

function lines(out, prefix, depth, v) {
  /* prefix is the "key" or "- " or "" that opens this value's first line */
  const pad = IND.repeat(depth), dash = prefix.startsWith('- ') ? 1 : 0;   // "- key:" opens a list item: its children sit two spaces past the dash
  const kid = depth + 1 + dash, kpad = IND.repeat(kid);
  if (isPrim(v)) { out.push(pad + prefix + (prefix.endsWith(':') ? ' ' : '') + prim(v)); return; }
  if (Array.isArray(v)) {
    const head = prefix.replace(/:$/, '');
    if (!v.length) { out.push(pad + head + '[0]:'); return; }
    if (v.every(isPrim)) { out.push(pad + head + '[' + v.length + ']: ' + v.map(prim).join(',')); return; }
    const cols = tabular(v);
    if (cols) {
      out.push(pad + head + '[' + v.length + ']{' + cols.map(key).join(',') + '}:');
      for (const o of v) out.push(kpad + cols.map((c) => prim(o[c])).join(','));
      return;
    }
    out.push(pad + head + '[' + v.length + ']:');
    for (const item of v) {
      if (isPrim(item)) out.push(kpad + '- ' + prim(item));
      else if (Array.isArray(item)) lines(out, '- ', kid, item);
      else {
        const ks = Object.keys(item);
        if (!ks.length) { out.push(kpad + '-'); continue; }
        ks.forEach((k, i) => lines(out, (i === 0 ? '- ' : '') + key(k) + ':', kid + (i === 0 ? 0 : 1), item[k]));
      }
    }
    return;
  }
  const ks = Object.keys(v);
  if (prefix) out.push(pad + prefix);
  for (const k of ks) lines(out, key(k) + ':', prefix ? kid : depth, v[k]);
}

/* "- key: value" opens a list-item object; its remaining keys sit under the key, two spaces
   past the dash. lines() handles that with the depth arithmetic above; when the first key's
   value is itself nested, the "- key:" line is emitted and the children indent from there. */
function encode(v) {
  const out = [];
  if (isPrim(v)) return prim(v);
  if (Array.isArray(v)) { lines(out, '', 0, v); return out.join('\n'); }
  for (const k of Object.keys(v)) lines(out, key(k) + ':', 0, v[k]);
  return out.join('\n');
}

module.exports = { encode };
