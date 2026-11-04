/* WHICH GITHUB ACCOUNT A PROJECT WORKS AS. gh keeps several logins at once; `gh auth token
   --user <login>` hands out one account's token without switching the global active account.
   The GitHub plugin's "your login" answer names the account; the engine puts that account's
   token into the environment of everything it runs for the project - the feed's reads and
   every AI turn - so gh and git push inside a conversation act as that account. A company project stays
   on its team account, a personal project runs as the owner, nothing flips. A login gh does not know
   is reported once and the project runs on whatever gh's active account is. */
'use strict';
const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const cache = {};   // login -> { token, at } ; tokens are re-read every 30 min (gh refreshes them itself)
const warned = {};

function loginFor(p) {
  try { const a = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'plugins', 'github.json'), 'utf8')); return String(a.you || '').trim() || null; } catch (e) { return null; }
}
function tokenFor(login) {
  if (!login) return null;
  const c = cache[login]; if (c && Date.now() - c.at < 30 * 60000) return c.token;
  try {
    const token = cp.execFileSync('gh', ['auth', 'token', '--user', login], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    cache[login] = { token: token || null, at: Date.now() }; return token || null;
  } catch (e) {
    if (!warned[login]) { warned[login] = 1; console.log('gh → no login for ' + login + ' on this machine (gh auth login, then it is used automatically); running as gh\'s active account'); }
    cache[login] = { token: null, at: Date.now() }; return null;
  }
}
/* the environment additions for anything run on behalf of a project */
/* A PROJECT WITHOUT ITS OWN GITHUB LOGIN GETS NONE.
   It used to fall back to gh's active account on the machine - another project's - so a conversation in one project
   could close another project's issues. Now gh gets a token that is refused, and git gets no credential helper, so neither acts as anyone.
   Home keeps the machine's account: it is the owner's assistant across every project. A project that needs GitHub names
   its account in the GitHub plugin ("your login"). This stops mistakes; an AI determined to dig out the machine's stored
   login still could - the wall for that is a Windows user of its own (declined for now, 2026-09-25). */
const NO_LOGIN = 'cockpit-no-github-login-for-this-project';
function envFor(p) {
  const login = loginFor(p); const token = tokenFor(login);
  if (token) return { GH_TOKEN: token, GITHUB_TOKEN: token, COCKPIT_GH_USER: login };
  if (p && p.entry && p.entry.id === 'home') return {};   // Home: the machine's account
  // no login named, or one gh does not know (reported once, above): nobody - never the machine's account
  return { GH_TOKEN: NO_LOGIN, GITHUB_TOKEN: NO_LOGIN, COCKPIT_GH_USER: '(none - this project has no GitHub login)',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}
module.exports = { loginFor, tokenFor, envFor };
