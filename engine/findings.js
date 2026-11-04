/* FINDINGS TICKETS ARE DONE WHEN THE FINDINGS ARE GONE. The 10-02 round of map-findings tickets all
   merged and the Tests tab did not move: coders explained the findings in their PRs, and an explanation clears nothing.
   A findings ticket carries, in its body, the rule and the exact subjects it was filed for:

     <!-- cockpit:findings {"rule":"cross-feature-write","subjects":["file:apps/api/src/x.ts", ...]} -->

   After its PR merges and a map scan has run on the merged main, the subjects still carrying problem:<rule> are counted.
   None left: the ticket stays In UAT. Any left: it goes back to its coder with the ones left named. A finding is cleared by
   fixing it or by `cli tag <subject> accepted <rule> "why"` - the scanner then leaves it out (plugins/architecture/scan.js).
   A turn that clears every finding by accepting them, with no PR, is done the same way. Rules are pure where they can be,
   tested in test/findings.js. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const MARK = /<!--\s*cockpit:findings\s+(\{[\s\S]*?\})\s*-->/;
const SCANNER = 'architecture';   // the plugin whose scan writes problem:* tags

function marker(rule, subjects) { return '<!-- cockpit:findings ' + JSON.stringify({ rule, subjects }) + ' -->'; }
function parse(body) {
  const m = MARK.exec(String(body || '')); if (!m) return null;
  try { const o = JSON.parse(m[1]); return o && typeof o.rule === 'string' && Array.isArray(o.subjects) && o.subjects.length ? { rule: o.rule, subjects: o.subjects.map(String) } : null; } catch (e) { return null; }
}
/* the subjects of f still carrying the finding, given the set of subjects tagged problem:<f.rule> now */
function leftOf(f, tagged) { return f.subjects.filter((s) => tagged.has(s)); }
function tagged(db, rule) { return new Set(db.all("SELECT subject FROM tag WHERE ns = 'problem' AND value = ?", rule).map((r) => r.subject)); }
/* the newest good map scan that STARTED after `at` - only it has read the code as it was at `at` or later */
function scanAfter(db, at) {
  if (!at) return null;
  try { return db.get('SELECT id, started, finished FROM scan_run WHERE plugin = ? AND ok = 1 AND finished IS NOT NULL AND started > ? ORDER BY id DESC LIMIT 1', SCANNER, at) || null; } catch (e) { return null; }
}
/* what the check says about one ticket. Pure: f = parse(body), left = leftOf(...). */
function verdict(f, left) {
  const n = f.subjects.length;
  if (!left.length) return { done: true, note: 'all ' + n + ' ' + f.rule + ' finding(s) this ticket was filed for are gone from the map' };
  const list = left.slice(0, 15).map((s) => '`' + s + '`').join(', ') + (left.length > 15 ? ' and ' + (left.length - 15) + ' more' : '');
  return { done: false, note: left.length + ' of ' + n + ' ' + f.rule + ' finding(s) are still on the map after the merge: ' + list
    + '. Fix each one, or if it is right as it is, mark it: cli tag <subject> accepted ' + f.rule + ' "<why>". An explanation in the PR clears nothing.' };
}

/* FINDINGS FROM A RUN ARE JUDGED ONLY ON A RUN OF THE FIX. A code rule is read from main by the scan, so
   any scan after the merge sees the fix. A failing flow or a crash on hostile input comes from a TEST RUN, and the test copy
   follows main every 2 hours - a run soon after the merge tested the code before it, and would send a good fix back. The
   run records which code each part tested (engine/tests.js): version = the site the flows clicked, repoVersion = the folder
   the unit tests ran in, stagesVersion = the site the probes hit. A rule from a run is judged only when every part it comes
   from tested a commit that holds the merge. A rule whose run records no version (dast-*) is never judged here. */
const FROM_RUN = { 'flow-failing': ['version'], 'flow-skipped': ['version'], 'test-failing': ['version', 'repoVersion'], 'input-crash': ['stagesVersion'], 'input-leak': ['stagesVersion'], 'input-reflected': ['stagesVersion'], 'input-slow': ['stagesVersion'] };
/* semgrep's findings (sast-*) come from its own report, sast.json, which records the commit it scanned (engine/sast.js) */
const fromRun = (rule) => FROM_RUN[rule] || (/^sast-/.test(rule) ? ['sast'] : /^dast-/.test(rule) ? ['dastVersion'] : null);
function latestRun(p) {
  let run = null; try { run = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'tests', 'latest.json'), 'utf8')); } catch (e) { /* none */ }
  /* only a scan that RAN counts (2026-10-03: semgrep crashed in 2 s on 0 files, the map dropped its findings, and #5423 was
     "confirmed" on a scan that never looked) - a failed run is reported as such, never as a clean one */
  try { const s = JSON.parse(fs.readFileSync(path.join(p.cockpit.dir, 'tests', 'sast.json'), 'utf8')); run = { ...(run || {}), sast: s.commit ? { at: s.at, commit: s.commit, ran: !!s.ok && Number(s.files) > 0, why: s.why || null } : null }; } catch (e) { /* none */ }
  return run;
}
/* does commit `sha` hold commit `merge`? read in the current-main copy the scan keeps (it has every merge)
   REMEMBERED (2026-10-06: Cockpit froze for the owner - the same two pairs were asked every pass, each hitting the 10 s
   timeout, 296 freezes of 8-10 s in four hours, blocking.log). A "yes" never changes for two fixed commits, so it is kept
   for good; a "no" or a timeout is asked again after 10 minutes (the copy may not have fetched the commit yet). */
const HOLDS_NO_TTL = 10 * 60000;
const holdsMemo = new Map();
function holds(p, merge, sha) {
  const key = p.dir + '|' + merge + '|' + sha, was = holdsMemo.get(key);
  if (was && (was.yes || Date.now() - was.at < HOLDS_NO_TTL)) return was.yes;
  const ml = path.join(p.dir, '.cockpit', 'cache', 'mainline');
  let yes = false;
  try { cp.execFileSync('git', ['-c', 'safe.directory=*', 'merge-base', '--is-ancestor', merge, sha], { cwd: fs.existsSync(path.join(ml, '.git')) ? ml : p.dir, stdio: 'ignore', timeout: 10000, windowsHide: true }); yes = true; } catch (e) { yes = false; }
  holdsMemo.set(key, { yes, at: Date.now() });
  if (holdsMemo.size > 5000) holdsMemo.delete(holdsMemo.keys().next().value);
  return yes;
}
/* when the evidence for f is ready: { at } = judge on a scan that started after `at`; { wait } = not yet, and why. Pure apart
   from the run file and git, both passed in for the tests. */
function evidence(f, merge, run, holdsFn) {
  const parts = fromRun(f.rule); if (!parts) return { at: null };
  if (!run) return { wait: 'no test run yet' };
  if (!merge) return { wait: 'no merge commit to look for' };
  if (parts[0] === 'sast') {
    if (!run.sast) return { wait: 'the last security scan does not say which code it scanned' };
    if (run.sast.ran === false) return { wait: 'the last security scan did not run (' + String(run.sast.why || '').slice(0, 60) + ') - nothing to judge on' };
    if (!holdsFn(merge, run.sast.commit)) return { wait: 'the last security scan read ' + String(run.sast.commit).slice(0, 9) + ', which does not hold the merge yet' };
    return { at: run.sast.at };
  }
  for (const k of parts) {
    const v = run[k]; if (!v) return { wait: 'the last test run does not say which code it tested (' + k + ')' };
    if (!holdsFn(merge, v)) return { wait: 'the last test run tested ' + String(v).slice(0, 9) + ', which does not hold the merge yet' };
  }
  return { at: run.at };
}

module.exports = { MARK, SCANNER, FROM_RUN, marker, parse, leftOf, tagged, scanAfter, verdict, latestRun, holds, evidence };
