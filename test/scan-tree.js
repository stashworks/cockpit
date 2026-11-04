// The Architecture scan builds a folder TREE (site > a > b > c > file), every ancestor present.
// Runs the website-php scanner over a scratch site and checks the crumbs of a 3-deep file.
// node test/scan-tree.js
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const root = path.join(os.tmpdir(), 'cockpit-scan-tree');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
fs.writeFileSync(path.join(root, 'index.php'), '<?php require "a/lib.php"; ?><html><a href="a/b/c/deep.php">x</a></html>');
fs.writeFileSync(path.join(root, 'a', 'lib.php'), '<?php function q(){}');
fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'deep.php'), '<?php echo 1;');
const dbFile = path.join(root, 'test.db');
const { DatabaseSync } = require('node:sqlite');
const db0 = new DatabaseSync(dbFile); db0.exec(fs.readFileSync(path.join(__dirname, '..', 'engine', 'schema.sql'), 'utf8')); db0.close();
cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'plugins', 'architecture', 'scan.js'), root, dbFile, JSON.stringify({ type: 'website-php', skip: '.cockpit' })], { stdio: ['ignore', 'ignore', 'ignore'] });
const { openDb } = require('../engine/db'); const g = require('../engine/graph');
const db = openDb(dbFile, path.join(__dirname, '..', 'engine', 'schema.sql'));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const top = g.graph(db, {}).nodes.map((n) => n.title);
ok('site level holds the top folder and "a" only', top.length === 2 && top.includes('a') && top.includes('/ (top level)'), top.join(', '));
const crumbs = g.crumbs(db, 'file:a/b/c/deep.php').map((c) => c.title).join(' > ');
ok('deep file crumbs are site > a > b > c > deep.php', crumbs === 'cockpit-scan-tree > a > b > c > deep.php', crumbs);
const under = g.graph(db, { parent: 'folder:a' }).nodes.map((n) => n.title);
ok('"a" contains folder b and file lib.php', under.includes('b') && under.includes('lib.php'), under.join(', '));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
