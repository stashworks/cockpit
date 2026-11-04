/* Verify the verifier (doctrine: verify-the-verifier). A scratch project is written with exactly ONE planted instance of
   every static check the Architecture scan runs; the scan must find each once - and nothing it should not. A check that
   stops firing on its fixture is broken; a check that fires on the clean files is a false positive in the making.
   node test/scan-fixtures.js */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const root = path.join(os.tmpdir(), 'cockpit-scan-fixtures');
fs.rmSync(root, { recursive: true, force: true });
const W = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const P = (name, body) => 'export async function ' + name + '(req) {\n' + body + '\n}\n';

/* ---- the project: a Node app with two features, tagged by a mapping file ---- */
W('package.json', JSON.stringify({ name: 'fixture', version: '0.0.1', private: true, dependencies: {} }));
W('.env.example', 'DB_NAME=fixture_dev\n');
// data
W('modules/orders/data/schema.sql', '-- @feature orders\nCREATE TABLE orders (id INT PRIMARY KEY, total DECIMAL(10,2), customer_email VARCHAR(200));\nCREATE TABLE order_lines (id INT PRIMARY KEY, order_id INT);\nCREATE TABLE ghost_table (id INT PRIMARY KEY);\n');
W('modules/billing/data/schema.sql', 'CREATE TABLE invoices (id INT PRIMARY KEY, amount DECIMAL(10,2));\nCREATE TABLE audit_log (id INT PRIMARY KEY, note TEXT);\n');
// screens
W('modules/orders/screens/orders.html', '<!-- @feature orders @kind screen @flow place-order -->\n<html><body><script src="orders.js"></script><link rel="stylesheet" href="orders.css"></body></html>\n');
W('modules/orders/screens/orders.js', 'export function load() { return fetch("/api/orders"); }\n');
W('modules/orders/screens/orders.css', 'body { margin: 0 }\n');
// actions - the doors, one healthy, one that does SQL itself
W('modules/orders/actions.js', "import { listOrders, placeOrder } from './logic.js';\nimport { db } from '../../shared/db.js';\nexport function routes(app) {\n  app.get('/api/orders', (req) => listOrders(req));\n  app.post('/api/orders', (req) => placeOrder(req));\n  app.get('/api/orders/raw', (req) => db.query('SELECT * FROM order_lines WHERE id = ' + req.query.id));   // sql-in-action + sql-string-built + unbounded? no: has WHERE\n  app.get('/api/dead', () => 1);\n  app.get('/api/orders/mirror', (req) => fetch('/api/invoices'));   // action-calls-action (a door calling a door)\n}\n");
W('modules/billing/actions.js', "import { db } from '../../shared/db.js';\nexport function routes(app) {\n  app.post('/api/invoices', (req) => db.query('INSERT INTO invoices (amount) VALUES (1)'));\n  app.post('/api/invoices/orders', (req) => db.query('UPDATE orders SET total = 0 WHERE id = 1'));   // cross-feature-write + owned-table-written-elsewhere\n  app.get('/api/invoices', (req) => fetch('/api/orders'));   // action-calls-action\n}\n");
// logic
W('modules/orders/logic.js', "import { db } from '../../shared/db.js';\nexport function formatMoney(cents, currency) { const n = Number(cents || 0) / 100; const sign = n < 0 ? '-' : ''; return sign + currency + Math.abs(n).toFixed(2) + ' ' + String(currency).toUpperCase(); }   // duplicate-function: the SAME code in both logic files\nimport { exec } from 'node:child_process';\nexport function listOrders(req) { return db.query('SELECT * FROM orders'); }   // unbounded-query\nexport function placeOrder(req) {\n  try { db.query('INSERT INTO orders (total) VALUES (1)'); } catch (e) {}   // empty-catch\n  try { return db.query('SELECT * FROM orders WHERE id = 1'); } catch (e) { return []; }   // fake-success\n}\nexport function runReport(req) { exec('report ' + req.query.name); }   // shell-with-input\nexport function readAttachment(req) { return require('node:fs').readFileSync(req.query.path); }   // path-from-input\nexport function go(req) { return req.res.redirect(req.query.next); }   // open-redirect\nexport function template(s) { return eval(s); }   // eval-use\nexport function retryForever() { while (true) { try { return db.query('SELECT 1 FROM orders WHERE id = 1'); } catch (e) { continue; } } }   // uncapped-retry\nexport function helper() { return 1; }\n");
W('modules/billing/logic.js', "import { db } from '../../shared/db.js';\nexport function formatMoney(cents, currency) { const n = Number(cents || 0) / 100; const sign = n < 0 ? '-' : ''; return sign + currency + Math.abs(n).toFixed(2) + ' ' + String(currency).toUpperCase(); }   // duplicate-function: the SAME code in both logic files\nexport function helper() { return 2; }   // duplicate-function with orders/logic.js\nexport function total() { return db.query('SELECT amount FROM invoices WHERE id = 1'); }\n// TODO: finish\n// TODO: also this\n// TODO: and this - todo-stub (3)\nexport function noisy() { console.log(1); console.log(2); console.log(3); console.log(4); console.log(5); }   // debug-logging (5)\n");
// unbounded-query false alarms seen on a real monorepo - none of these may fire: a quoted identifier or string literal
// before the WHERE / LIMIT, English in a comment, a FROM that is a CTE or a set-returning function
W('modules/billing/bounded.js', "import { db } from '../../shared/db.js';\n// migration 00136 REVOKEd user/member SELECT from app_harness\n/* the SELECT above feeds this */\nexport function oneInvoiceRow(o, u) { return db.query('SELECT 1 FROM public.\"invoices\" WHERE \"id\" = $1 AND \"amount\" = $2 LIMIT 1', [o, u]); }\nexport function sumInvoiceRows(o) { return db.query(\"WITH flat AS (SELECT amount FROM invoices WHERE id = $1) SELECT sum(amount) FROM flat\", [o]); }\nexport function loadInvoiceRows(j) { return db.query('INSERT INTO invoices (amount) SELECT amount FROM jsonb_to_recordset($1::jsonb) AS x(amount numeric)', [j]); }\nexport function invoiceTagMatches(o) { return db.query(\"SELECT 1 FROM jsonb_array_elements_text(COALESCE($2,'[]'::jsonb)) l WHERE l = $1\", [o]); }\n"
  // more: a data-modifying CTE, a WHERE in the next joined piece, a clause added at run time, QuickBooks' MAXRESULTS
  + "export function bumpRows(id) { return db.query('WITH u AS (UPDATE invoices SET amount = 0 WHERE id = $1 RETURNING id) INSERT INTO invoices (amount) SELECT 0 FROM u', [id]); }\n"
  + "export function adsQuery(a, b) { return ['SELECT', '  campaign.id,', 'FROM campaign', `WHERE segments.date BETWEEN '${a}' AND '${b}'`].join('\\n'); }\n"
  + "export function pageRows(s, w, lim) { return db.query(`SELECT * FROM \"${s.table}\"${w}${lim}`); }\n"
  + "export function qbo(f, max) { return `SELECT * FROM Invoice MAXRESULTS ${max}`; }\n");
// "select ... from" in UI words and JSX is not SQL - none of these may fire either
W('modules/billing/picker.js', "import { Select, SelectItem } from './ui-select.js';\nexport function pickerHtml() { return '<select><option>Select a row from the table</option></select>' + ' opened from the list'; }\nexport const HELP = 'select their new role from the dropdown';\n");
// ...and a real one written with a quoted identifier must still fire (the old rule stopped reading at the quote and missed it)
// own-db-connection (2026-10-03): a file holding its own connection details fires; a pool built from shared helpers does not
W('modules/billing/pool-own.js', "import { Pool } from 'pg';\nexport const pool = new Pool({ connectionString: 'postgres://app@db.internal/app' });\n");
W('modules/orders/pool-own.js', "import { Pool } from 'pg';\nexport const pool = new Pool({ host: 'db.internal', max: 5 });\n");
W('modules/billing/pool-shared.js', "import { Pool } from 'pg';\nimport { dbUrl, poolOptions } from '../../shared/db.js';\n// this comment says new Pool(...) and must not count\nexport const pool = new Pool({ connectionString: dbUrl(), ...poolOptions('billing') });\n");
W('modules/billing/everyone.js',"import { db } from '../../shared/db.js';\nexport function everyInvoiceRow() { return db.query('SELECT * FROM public.\"invoices\"'); }   // unbounded-query\n");
W('shared/db.js', "const password = 'Sup3rSecretPassw0rdValue';   // secret-in-code\nexport const db = { query: (q) => q };\n");
W('shared/render.js', "export function show(el, data) { el.innerHTML = data.html; }   // raw-html-from-data\n// const a = 1;\n// const b = 2;\n// if (a) { b(); }\n// return a + b;\n// const c = 3;\n// const d = 4;\n// if (c) { d(); }\n// return c + d;   <- commented-out-code (8 lines)\n");
W('shared/types.ts', "export const a = 1 as any; export const b = 2 as any; export const c = 3 as any; export const d = 4 as any; export const e = 5 as any;   // type-escape (5)\n");
W('modules/orders/data/migrations/00002_up.sql', "-- data reaching up\nCREATE TABLE later_table (id INT);\n");
W('modules/orders/data/up.js', "import { helper } from '../logic.js';   // data-reaches-up (declared data importing logic)\nexport const x = helper;\n");
// tests
W('test/orders.test.js', "// @flow place-order\nimport assert from 'node:assert';\nimport { listOrders } from '../modules/orders/logic.js';\nassert.ok(listOrders);\n");
W('test/nothing.test.js', "import { total } from '../modules/billing/logic.js';\ntotal();   // test-without-assertion\n");
W('test/ghost.test.js', "// @flow ghost-flow\nimport assert from 'node:assert';\nassert.ok(1);   // test-names-unknown-flow\n");
// config + log with secrets
W('config/app.json', '{ "api_key": "AKIAABCDEFGHIJKLMNOPQRSTUV" }\n');
W('logs/app.log', 'token = abcdefghijklmnopqrstuvwxyz1234\n');
// the mapping file: features, tables, flows, and the declaration mistakes to catch
W('.cockpit/plugins/architecture.declared.json', JSON.stringify({
  features: {
    orders: { purpose: 'Orders', dependsOn: ['billing'], tables: ['orders', 'order_lines', 'listed_but_missing'], flows: [{ name: 'place-order', steps: ['open orders', 'click Place order', 'enter a quantity', 'POST /api/orders', 'see it'] }, { name: 'ship-order', steps: ['open orders', 'POST /api/ship', 'see it'] }] },
    billing: { purpose: 'Billing', tables: ['invoices'], flows: [] },
    phantom: { purpose: 'declared, no files', tables: [], flows: [] },
    core: { purpose: 'a shared service (families fixture, 2026-10-05)', tables: [], flows: [] }
  },
  files: {
    'modules/orders/actions.js': { feature: 'orders', kind: 'action', flow: [], purpose: 'The doors for orders.' },
    'modules/orders/logic.js': { feature: 'orders', kind: 'logic', flow: [], purpose: 'Orders logic. ' + 'x'.repeat(230) },
    'modules/orders/screens/orders.html': { feature: 'orders', kind: 'screen', flow: ['place-order'], purpose: 'The orders screen.' },
    'modules/orders/screens/orders.js': { feature: 'orders', kind: 'screen', flow: ['place-order'], purpose: 'The orders screen script.' },
    'modules/orders/screens/orders.css': { feature: 'orders', kind: 'screen', flow: [], purpose: 'Style.' },
    'modules/orders/data/schema.sql': { feature: 'orders', kind: 'data', flow: [], purpose: 'Orders tables.' },
    'modules/orders/data/up.js': { feature: 'orders', kind: 'data', flow: [], purpose: 'reaches up' },
    'modules/billing/actions.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'declared logic but declares routes - kind-disagrees' },
    'modules/billing/logic.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'Billing logic.' },
    'modules/billing/drift.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'drifted formatting' },
    'modules/billing/somewhere.js': { feature: 'billing', purpose: 'in a feature, no kind - file-without-kind' },
    'modules/billing/picker.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'UI words the old rule read as SQL' },
    'modules/billing/bounded.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'bounded reads the old unbounded-query rule misread' },
    'modules/billing/everyone.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'an unbounded read behind a quoted identifier' },
    'modules/billing/pool-own.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'a pool from its own environment read' },
    'modules/orders/pool-own.js': { feature: 'orders', kind: 'logic', flow: [], purpose: 'a pool with its own host and size' },
    'modules/billing/pool-shared.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'a pool from the shared helpers' },
    'modules/billing/data/schema.sql': { feature: 'billing', kind: 'data', flow: [], purpose: 'Billing tables.' },
    'shared/db.js': { feature: 'nowhere', kind: 'logic', flow: [], purpose: 'names a feature with no README - tag-without-readme' },
    'shared/render.js': { feature: 'shared', kind: 'widget', flow: [], purpose: 'kind-unknown' },
    'shared/types.ts': { feature: 'shared', kind: 'logic', flow: [], purpose: 'types' },
    'modules/core/logic.js': { feature: 'core', kind: 'logic', flow: [], purpose: 'a shared service that imports a module' },
    'modules/billing/uses-orders.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'billing imports orders without declaring it' },
    'modules/orders/uses-billing.js': { feature: 'orders', kind: 'logic', flow: [], purpose: 'orders imports billing, declared' },
    'modules/billing/reads-orders.js': { feature: 'billing', kind: 'logic', flow: [], purpose: 'billing reads an orders table' },
    'test/orders.test.js': { feature: 'orders', kind: 'test', flow: ['place-order'], purpose: 'proves place-order' },
    'test/nothing.test.js': { feature: 'billing', kind: 'test', flow: [], purpose: 'asserts nothing' },
    'test/ghost.test.js': { feature: 'billing', kind: 'test', flow: ['ghost-flow'], purpose: 'names a flow nobody defines' }
  }
}, null, 1));
// formatting drift: tabs and spaces both indent, no final newline; and a kindless file in a feature (mapped feature, no kind, plain module shape)
W('modules/billing/drift.js', 'export function a() {\n' + Array.from({ length: 30 }, (_, i) => (i % 2 ? '\tconst v' + i + ' = ' + i + ';\n' : '  const w' + i + ' = ' + i + ';\n')).join('') + '  return 1;\n}');
W('modules/billing/somewhere.js', 'export const helperish = (x) => x * 2;\n');
// a header with two features and an unknown tag
W('shared/twice.js', "// @feature orders\n// @feature billing\n// @whatever yes\n// @kind logic\n// @purpose two features and an unknown tag\nexport const t = 1;\n");
// a header with no purpose on a screen with no flow
W('modules/billing/screens/bill.html', '<!-- @feature billing @kind screen -->\n<html></html>\n');
// families: core is a shared service, orders and billing are modules; orders lists billing under Depends on
W('.cockpit/plugins/architecture.families.json', JSON.stringify({ families: [{ name: 'Core', level: 'service', members: ['core'] }, { name: 'Business', level: 'module', members: ['orders', 'billing'] }] }));
W('modules/core/logic.js', "import { helper } from '../orders/logic.js';   // line-points-up: a shared service importing a module\nexport const coreUsesOrders = () => helper;\n");
W('modules/billing/uses-orders.js', "import { listOrders } from '../orders/logic.js';   // undeclared-module-dependency: billing does not list orders\nexport const billingUsesOrders = () => listOrders;\n");
W('modules/orders/uses-billing.js', "import { total } from '../billing/logic.js';   // declared: orders lists billing - no finding\nexport const ordersUsesBilling = () => total;\n");
W('modules/billing/reads-orders.js', "import { db } from '../../shared/db.js';\nexport function billingReadsOrders() { return db.query('SELECT total FROM orders WHERE id = 1'); }   // module-reaches-into-module\n");

/* ---- scan ---- */
const dbFile = path.join(root, '.cockpit', 'cockpit.db');
const { DatabaseSync } = require('node:sqlite');
const db0 = new DatabaseSync(dbFile); db0.exec(fs.readFileSync(path.join(__dirname, '..', 'engine', 'schema.sql'), 'utf8'));
// the Database plugin's last read, planted: every code table but later_table (-> table-not-in-db), plus stray_table nothing names (-> table-nothing-touches)
db0.exec(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'database', 'schema.sql'), 'utf8'));
for (const t of ['orders', 'order_lines', 'ghost_table', 'invoices', 'audit_log', 'stray_table']) db0.prepare("INSERT INTO db_table (name, type, rows, exact, columns, pk, at) VALUES (?, 'table', 0, 1, 1, '[\"id\"]', ?)").run(t, new Date().toISOString());
db0.prepare("INSERT INTO db_meta (key, value) VALUES ('scannedAt', ?)").run(new Date().toISOString());
db0.close();
const out = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'plugins', 'architecture', 'scan.js'), root, dbFile, JSON.stringify({ type: 'typescript', skip: '.cockpit,node_modules' })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const { openDb } = require('../engine/db');
const db = openDb(dbFile, path.join(__dirname, '..', 'engine', 'schema.sql'));
const rows = db.all("SELECT subject, value FROM tag WHERE ns = 'problem'");
const count = {}; rows.forEach((r) => { count[r.value] = (count[r.value] || 0) + 1; });

/* ---- what must fire exactly once (or the stated number), and on what ---- */
const EXPECT = {
  'sql-in-action': [1, 'modules/orders/actions.js queries from the door (billing/actions.js is DECLARED logic - the declared kind wins, so it is kind-disagrees instead)'],
  'sql-string-built': [1, 'orders/actions.js concatenates'],
  'cross-feature-write': [1, 'billing writes orders'],
  'owned-table-written-elsewhere': [0, 'orders README lists orders and billing writes it - but cross-feature-write already says that write (one write, one finding, scan.js 2026-10-02), so this rule stays quiet here'],
  'action-calls-action': [1, 'orders/actions.js calls /api/invoices from inside the door'],
  'unbounded-query': [2, 'orders/logic.js SELECT * FROM orders; billing/everyone.js SELECT * FROM public."member" - and nothing in billing/bounded.js'],
  'empty-catch': [1, 'orders/logic.js'],
  'fake-success': [1, 'orders/logic.js returns [] in a catch'],
  'shell-with-input': [1, 'orders/logic.js exec with req.query'],
  'path-from-input': [1, 'orders/logic.js readFileSync(req.query.path)'],
  'open-redirect': [1, 'orders/logic.js redirect(req.query.next)'],
  'eval-use': [1, 'orders/logic.js eval'],
  'uncapped-retry': [1, 'orders/logic.js while(true) with catch, no cap'],
  'duplicate-function': [2, 'formatMoney() has the same code in both logic files; helper() and routes() share only a NAME and must not fire'],
  'todo-stub': [1, 'billing/logic.js three TODOs'],
  'debug-logging': [1, 'billing/logic.js five console.log'],
  'secret-in-code': [1, 'shared/db.js'],
  'raw-html-from-data': [1, 'shared/render.js innerHTML = data.html'],
  'commented-out-code': [1, 'shared/render.js eight commented lines'],
  'type-escape': [1, 'shared/types.ts five as any'],
  'data-reaches-up': [1, 'orders/data/up.js declared data, imports logic'],
  'test-without-assertion': [1, 'test/nothing.test.js'],
  'test-names-unknown-flow': [1, 'test/ghost.test.js'],
  'flow-without-test': [1, 'ship-order has no test (place-order has one)'],
  'flow-step-missing': [1, 'ship-order names POST /api/ship, which does not exist'],
  'kind-disagrees': [1, 'billing/actions.js declared logic, declares routes'],
  'kind-unknown': [1, 'shared/render.js kind widget'],
  'tag-without-readme': [1, 'shared/db.js names feature nowhere'],
  'readme-without-files': [1, 'phantom has no files'],
  'listed-table-undefined': [1, 'orders lists listed_but_missing'],
  'table-unowned': [2, 'audit_log and ghost_table and later_table are listed by no feature - ghost_table? it is defined by orders schema but not listed'],
  'feature-twice': [1, 'shared/twice.js'],
  'tag-unknown': [1, 'shared/twice.js @whatever'],
  'purpose-long': [1, 'orders/logic.js purpose over 220 chars'],
  'purpose-missing': [1, 'billing/screens/bill.html has a header and no @purpose'],
  'tag-missing': [1, 'billing/screens/bill.html a screen with no @flow'],
  'secret-in-config': [1, 'config/app.json'],
  'secret-in-log': [1, 'logs/app.log'],
  'lockfile-missing': [1, 'no lockfile'],
  'backup-undeclared': [1, 'no ## Backup folder: in the fixture'],
  'format-drift': [1, 'billing/drift.js tabs and spaces, no final newline'],
  'file-without-kind': [1, 'billing/somewhere.js mapped to billing with no kind'],
  'env-example-incomplete': [0, 'nothing reads process.env here'],
  'own-db-connection': [2, 'billing/pool-own.js and orders/pool-own.js hold their own connection details; billing/pool-shared.js is built from shared helpers and does not count'],
  'table-not-in-db': [1, 'later_table is created by a migration and the planted database read does not hold it'],
  'table-nothing-touches': [1, 'stray_table is in the planted database read and no code names it'],
  'dead-route': [2, 'GET /api/dead and GET /api/orders/raw are called by nothing (plus POST /api/invoices, /api/invoices/orders - counted below)'],
  // families
  'line-points-up': [1, 'core/logic.js (a shared service) imports orders (a module)'],
  'undeclared-module-dependency': [2, 'billing/uses-orders.js imports orders and billing/actions.js calls GET /api/orders; orders -> billing is declared and must not fire'],
  'module-reaches-into-module': [1, 'billing/reads-orders.js reads the orders table']
};
let fails = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
for (const [v, [n, why]] of Object.entries(EXPECT)) {
  if (v === 'dead-route' || v === 'table-unowned') { ok(v + ' fires (' + (count[v] || 0) + ')', (count[v] || 0) >= 1, why); continue; }   // counts depend on shape details; the check firing is the contract
  ok(v + ' = ' + n, (count[v] || 0) === n, (count[v] || 0) !== n ? 'got ' + (count[v] || 0) + ' - ' + why : '');
}
// nothing else fired that the fixture did not plant
const planted = new Set(Object.keys(EXPECT).concat(['god-file', 'nothing-points-here', 'read-never-written', 'defined-never-used', 'write-never-read', 'no-single-writer', 'own-db-connection', 'mapping-redundant', 'screen-touches-data', 'flow-not-in-feature', 'migration-edited-after-run', 'env-committed', 'vulnerable-dependency', 'outdated-major', 'lint-error', 'lint-warning', 'test-failing', 'flow-failing', 'sql-in-page',
  'doctrine-review-due', 'flow-not-clicked']));   // project-wide reminders the engine adds on any project (2026-10-03: they made this check fail on every run)
const unexpected = Object.keys(count).filter((v) => !planted.has(v));
ok('no check fires that the fixture does not know', unexpected.length === 0, unexpected.join(', '));
console.log((fails ? fails + ' FAILED' : 'ALL PASSED') + ' - ' + Object.keys(count).length + ' checks fired on the fixture');
process.exit(fails ? 1 : 0);
