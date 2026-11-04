/* Verify the verifier for the website-php scanner: a tiny plain-PHP site with the two shapes the first PHP project's
   change request named (2026-09-18) - __DIR__ includes, and ON UPDATE / ON DUPLICATE KEY UPDATE inside INSERTs.
   node test/scan-php.js */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const root = path.join(os.tmpdir(), 'cockpit-scan-php');
fs.rmSync(root, { recursive: true, force: true });
const W = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
W('index.php', "<?php\nrequire_once __DIR__ . '/lib/db.php';\nrequire_once dirname(__FILE__) . '/inc/header.php';\ninclude 'inc/footer.php';\n?>\n<html><body><a href=\"plants.php\">plants</a></body></html>\n");
W('plants.php', "<?php\nrequire_once __DIR__ . '/lib/db.php';\n$rows = $db->query(\"SELECT * FROM plants WHERE id = 1\");\n$db->query(\"INSERT INTO waterings (plant_id, at) VALUES (1, NOW()) ON DUPLICATE KEY UPDATE at = NOW()\");\n?><html><body>x</body></html>\n");
W('lib/db.php', "<?php\nrequire_once dirname(__DIR__) . '/config.php';\n$db = new mysqli('h', 'u', 'p', 'd');\n$db->query(\"CREATE TABLE IF NOT EXISTS log (id INT, at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)\");\n$db->query(\"UPDATE plants SET name = 'x' WHERE id = 1\");\n");
W('config.php', "<?php\n$cfg = ['db' => 'd'];\n");
W('inc/header.php', "<?php echo '<h1>hi</h1>';\n");
W('inc/footer.php', "<?php echo '</body>';\n");

const dbFile = path.join(root, '.cockpit', 'cockpit.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const { DatabaseSync } = require('node:sqlite');
const db0 = new DatabaseSync(dbFile); db0.exec(fs.readFileSync(path.join(__dirname, '..', 'engine', 'schema.sql'), 'utf8')); db0.close();
cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'plugins', 'architecture', 'scan.js'), root, dbFile, JSON.stringify({ type: 'website-php', skip: '.cockpit' })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const { openDb } = require('../engine/db');
const db = openDb(dbFile, path.join(__dirname, '..', 'engine', 'schema.sql'));
const edges = db.all("SELECT src, dst, kind FROM edge WHERE kind = 'include'").map((e) => e.src.replace('file:', '') + ' -> ' + e.dst.replace('file:', ''));
const tables = db.all("SELECT subject FROM node WHERE kind = 'table'").map((r) => r.subject.replace('table:', '')).sort();
const writes = db.all("SELECT src, dst FROM edge WHERE kind = 'writes'").map((e) => e.src.replace('file:', '') + ' -> ' + e.dst.replace('table:', '')).sort();
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
ok('__DIR__ include resolves', edges.includes('index.php -> lib/db.php'), edges.join(', '));
ok('dirname(__FILE__) include resolves', edges.includes('index.php -> inc/header.php'), edges.join(', '));
ok('plain include still resolves', edges.includes('index.php -> inc/footer.php'), edges.join(', '));
ok('dirname(__DIR__) include resolves one level up', edges.includes('lib/db.php -> config.php'), edges.join(', '));
ok('tables are the real ones only (CREATE TABLE inside PHP code is not read by this scanner - not in scope)', JSON.stringify(tables) === JSON.stringify(['plants', 'waterings']), JSON.stringify(tables));
ok('ON DUPLICATE KEY UPDATE and ON UPDATE invent no table', !tables.includes('at') && !tables.includes('current_timestamp'), JSON.stringify(tables));
ok('UPDATE plants SET is a write to plants', writes.includes('lib/db.php -> plants'), writes.join(', '));
ok('INSERT INTO waterings is a write to waterings', writes.includes('plants.php -> waterings'), writes.join(', '));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
