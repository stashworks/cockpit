// Who may change what (engine/scope.js) and the GitHub lock (engine/ghauth.js): no engine, no network. node test/scope.js
const scope = require('../engine/scope'), ghauth = require('../engine/ghauth');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const req = (h) => ({ headers: h || {} });

const kk = scope.keyFor('acme-web'), pw = scope.keyFor('notes'), home = scope.keyFor('home');
ok('each project gets its own key, stable within a run', kk !== pw && scope.keyFor('acme-web') === kk);
const cK = scope.caller(req({ 'x-cockpit-key': kk })), cP = scope.caller(req({ 'x-cockpit-key': pw })), cH = scope.caller(req({ 'x-cockpit-key': home }));
ok('acme-web\'s AI may change acme-web', scope.allows(cK, 'acme-web'));
ok('notes\' AI may NOT change acme-web', !scope.allows(cP, 'acme-web'));
ok('a project\'s AI may NOT change engine-wide things (coders, project list)', !scope.allows(cK, '*'));
ok('Home\'s AI may change any project and engine-wide things', scope.allows(cH, 'acme-web') && scope.allows(cH, 'notes') && scope.allows(cH, '*'));
const owner = scope.caller(req({ 'sec-fetch-site': 'same-origin' }));
ok('the owner\'s browser may change anything', owner.who === 'owner' && scope.allows(owner, 'acme-web') && scope.allows(owner, '*'));
const bare = scope.caller(req({}));
ok('a request with no key and no browser mark (a raw curl) may change nothing', !scope.allows(bare, 'acme-web') && !scope.allows(bare, '*'));
ok('a key this engine did not issue may change nothing', !scope.allows(scope.caller(req({ 'x-cockpit-key': 'made-up' })), 'acme-web'));
ok('the refusal names the project and says who may', /belongs to notes .* project acme-web.*Only Home and the owner/.test(scope.refusal(cP, 'acme-web')), scope.refusal(cP, 'acme-web'));

// bulk removals: five, then refused; the owner is never limited
let allowed = 0; for (let i = 0; i < 8; i++) if (scope.bulkOk(cK)) allowed++;
ok('an AI may remove ' + scope.BULK_MAX + ' things in ' + scope.BULK_WINDOW_MIN + ' minutes, then is refused', allowed === scope.BULK_MAX, allowed + ' allowed');
ok('another project\'s count is separate', scope.bulkOk(cP));
let o = 0; for (let i = 0; i < 20; i++) if (scope.bulkOk(owner)) o++;
ok('the owner is not limited', o === 20);

// the GitHub lock
const mk = (id) => ({ entry: { id }, cockpit: { dir: require('node:path').join(require('node:os').tmpdir(), 'no-such-' + id) } });
const pwEnv = ghauth.envFor(mk('notes'));
ok('a project with no GitHub login gets a token GitHub refuses, not the machine\'s', /^cockpit-no-github-login/.test(pwEnv.GH_TOKEN || '') && pwEnv.GITHUB_TOKEN === pwEnv.GH_TOKEN);
ok('...and git gets no credential helper and cannot prompt', pwEnv.GIT_CONFIG_KEY_0 === 'credential.helper' && pwEnv.GIT_CONFIG_VALUE_0 === '' && pwEnv.GIT_TERMINAL_PROMPT === '0');
ok('Home keeps the machine\'s account', Object.keys(ghauth.envFor(mk('home'))).length === 0);

console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
