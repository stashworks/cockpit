/* projects.json — the folders the engine has been shown. Like VS Code's recent workspaces:
   id, path, name, when it was last opened, whether it is pinned. This is the ONLY state the
   engine keeps outside a project's .cockpit\. Removing an entry forgets the folder; it
   never touches the folder itself. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let FILE = null;
let list = [];
let seen = 0;

function load(root) {
  FILE = path.join(root, 'projects.json');
  reread();
  return list;
}
/* The engine folder can be shared between machines (over a network share), so the file may change
   under a running engine. Re-read it whenever its mtime moves; never serve a stale copy. */
function reread() {
  let st; try { st = fs.statSync(FILE).mtimeMs; } catch (e) { st = 0; }
  if (st === seen) return;
  seen = st;
  // a BOM in front (Windows PowerShell 5's Set-Content -Encoding utf8 writes one) emptied the project list on 2026-09-28
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '')).projects || []; } catch (e) { if (!st) list = []; }
}
function save() { fs.writeFileSync(FILE, JSON.stringify({ projects: list }, null, 2) + '\n'); }

/* An id is the folder name, lowercased, non-alphanumerics collapsed to '-'. It is what the
   URL carries (/my-app, /notes - §13), so it must be short and stable. A clash gets a
   numeric suffix rather than a rename of the existing project. */
function slug(dir) {
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  let id = base, n = 2;
  while (list.some((p) => p.id === id)) id = base + '-' + n++;
  return id;
}

function all() { reread(); return list.slice(); }
function get(id) { reread(); return list.find((p) => p.id === id) || null; }
function byPath(dir) { const norm = path.resolve(dir).toLowerCase(); return list.find((p) => path.resolve(p.path).toLowerCase() === norm) || null; }

function add(dir, name) {
  const existing = byPath(dir);
  if (existing) return existing;
  const p = { id: slug(dir), path: path.resolve(dir), name: name || path.basename(dir), added: new Date().toISOString(), lastOpened: null, pinned: false };
  list.push(p); save();
  return p;
}
function touch(id) { const p = get(id); if (p) { p.lastOpened = new Date().toISOString(); save(); } return p; }
function remove(id) { const before = list.length; list = list.filter((p) => p.id !== id); if (list.length !== before) save(); return list.length !== before; }
function update(id, patch) { const p = get(id); if (!p) return null; Object.assign(p, patch); save(); return p; }

module.exports = { load, all, get, byPath, add, touch, remove, update };
