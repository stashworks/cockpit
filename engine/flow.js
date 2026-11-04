/* The flow helper - what a project's browser flow test requires.

   A functional test is a README flow clicked through in a real browser: open the page, click what a person clicks,
   type what they type, read what they would see. The project writes one file per flow, next to its other tests:

     // @feature runbooks
     // @kind test
     // @flow start-grow
     // @purpose Clicks the start-grow flow through: a bed, a runbook, Activate, the run on the task list.
     const { flow } = require(process.env.COCKPIT_FLOW);
     flow({ name: 'start-grow', feature: 'runbooks',
       look:  async (c) => { await c.open('/start_grow.php'); await c.see('Start a New Grow'); },          // read-only: runs everywhere
       steps: async (c) => { await c.fill('Bed', c.TEST + 'bed'); await c.click('Activate'); await c.see('run started'); }   // writes: dev only
     });

   Named test/<feature>.<flow>.browser.test.js it runs in the Tests tab's app stage on dev (look, then steps, with the
   dev database as the sandbox) and, after a promote, in LOOK mode on prod: the screens the flow touches are opened
   and read, nothing that writes is pressed - the customer's data is never written by a test (the line never crossed).
   A red leaves a screenshot in .cockpit/tests/shots/<flow>.png, named in the test's output.

   Without APP_URL (the project's own `npm test`) the flow is skipped, not failed: it only runs where a browser and a
   running app are - Cockpit's stage sets both. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LOOK = !!process.env.COCKPIT_LOOK;
const URL = String(process.env.APP_URL || '').replace(/\/$/, '');
const SHOTS = process.env.COCKPIT_SHOTS || '';
const TEST = '__test__';

function slug(s) { return String(s || 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

/* the context a flow's steps get: a few verbs in the words of the README flow, on the Playwright page underneath (c.page) */
function ctx(page) {
  const c = { page, url: URL, look: LOOK, TEST, assert, step: '' };
  const at = (s) => { c.step = s; };
  c.open = async (p) => { at('open ' + p); const r = await page.goto(/^https?:/.test(p) ? p : URL + p, { waitUntil: 'domcontentloaded', timeout: 30000 }); assert.ok(r && r.status() < 400, 'open ' + p + ' answered ' + (r ? r.status() : 'nothing')); };
  c.see = async (text) => { at('see "' + text + '"'); await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error('did not see "' + text + '" on ' + page.url()); }); };
  c.notSee = async (text) => { at('not see "' + text + '"'); const n = await page.getByText(text, { exact: false }).count(); assert.equal(n, 0, 'saw "' + text + '" on ' + page.url() + ' and should not have'); };
  c.click = async (label) => { at('click ' + label); if (LOOK && !c.reading) throw new Error('click "' + label + '" in look mode - a look never presses; put it under steps'); const el = page.getByRole('button', { name: label }).or(page.getByRole('link', { name: label })).or(page.getByText(label, { exact: true })).first(); await el.click({ timeout: 15000 }); await page.waitForLoadState('domcontentloaded').catch(() => {}); };
  c.follow = async (label) => { at('follow ' + label); const el = page.getByRole('link', { name: label }).first(); await el.click({ timeout: 15000 }); await page.waitForLoadState('domcontentloaded').catch(() => {}); };   // a link: reading, allowed in look mode
  c.fill = async (label, value) => { at('fill ' + label); if (LOOK) throw new Error('fill "' + label + '" in look mode - a look never types; put it under steps'); await page.getByLabel(label).or(page.getByPlaceholder(label)).first().fill(String(value), { timeout: 15000 }); };
  c.select = async (label, value) => { at('select ' + label); if (LOOK) throw new Error('select "' + label + '" in look mode'); await page.getByLabel(label).first().selectOption(String(value), { timeout: 15000 }); };
  c.text = async () => page.locator('body').innerText();
  c.shot = async (name) => { if (!SHOTS) return null; try { fs.mkdirSync(SHOTS, { recursive: true }); const f = path.join(SHOTS, slug(name) + '.png'); await page.screenshot({ path: f, fullPage: true }); return f; } catch (e) { return null; } };
  return c;
}

/* one flow = one node:test; look first (always), then steps (dev only); a red is the step it stopped at, with the shot */
function flow(spec) {
  const name = spec.name || 'flow'; const title = 'flow ' + name + (LOOK ? ' (look)' : '');
  if (!URL) { test(title, { skip: 'no APP_URL - a browser flow runs in Cockpit\'s Tests tab, against the running app' }, () => {}); return; }
  test(title, async () => {
    let chromium; try { ({ chromium } = require('playwright')); } catch (e) { throw new Error('playwright is not reachable from this test (NODE_PATH should point at the engine\'s node_modules): ' + e.message); }
    const browser = await chromium.launch({ headless: true });
    /* ONE SIGN-IN PER RUN: the runner names a session file (COCKPIT_SESSION). The first flow that signs in saves the browser's
       cookies there; later flows start already signed in, so a run no longer trips the site's sign-in rate limit (a site
       answered 429). A flow that tests the sign-in itself says freshSignIn: true and always goes through the form. */
    const SESSION = process.env.COCKPIT_SESSION || '';
    // the runner signs in ONCE before the flows (tests.js bootstrapSession), so a flow needs no signIn of its own to start
    // signed in (2026-09-30, #4845: the reuse needed spec.signIn, so a flow without one ran signed out)
    const reuse = !!(SESSION && !spec.freshSignIn && fs.existsSync(SESSION));
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, ...(reuse ? { storageState: SESSION } : {}) });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    const c = ctx(page);
    try {
      if (spec.signIn && process.env.COCKPIT_TEST_USER && !reuse) {
        c.reading = true; await spec.signIn(c, { user: process.env.COCKPIT_TEST_USER, pass: process.env.COCKPIT_TEST_PASS || '' }); c.reading = false;
        if (SESSION && !spec.freshSignIn) { try { await context.storageState({ path: SESSION }); } catch (e) { /* the next flow signs in itself */ } }
      } else if (reuse) {
        /* a signed-in flow ends ON the site; a reused session starts on about:blank, where a flow's first same-site fetch
           ('/api/v1/me/...') cannot even parse its url (dashboard.chat-with-agent, 2026-09-29) - start on the site's front */
        c.reading = true; await c.open('/'); c.reading = false;
      }
      if (spec.look) await spec.look(c);
      if (!LOOK && spec.steps) await spec.steps(c);
      if (!LOOK && spec.sweep) await spec.sweep(c);
      if (errors.length) throw new Error('the page threw ' + errors.length + ' JavaScript error' + (errors.length === 1 ? '' : 's') + ': ' + errors[0]);
    } catch (e) {
      const shot = await c.shot(name);
      if (!LOOK && spec.sweep) { try { await spec.sweep(c); } catch (x) { /* the sweep after a red: best effort */ } }
      throw new Error('flow ' + name + ' stopped at "' + c.step + '" on ' + page.url() + ': ' + e.message + (shot ? ' - screenshot ' + shot : ''));
    } finally { await browser.close().catch(() => {}); }
  });
}

module.exports = { flow, LOOK, URL, TEST };
