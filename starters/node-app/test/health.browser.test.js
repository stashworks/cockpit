// @feature app
// @kind test
// @flow health-check
// @purpose Proves the health-check flow through a real browser: the shell renders, the health door answers, no console errors.
/* A BROWSER test - the functional stage (docs: ARCHITECTURE.md, "Flows"). Same flow as test\health.flow.test.js, but
   driven the way a person sees it: Chromium loads the page, scripts run, the DOM is what is asserted.
     - Cockpit runs *.browser.test.js AFTER the app is up on the test database, with APP_URL set to where it answers.
       Playwright and Chromium come from Cockpit's own folder (nothing to install in this project).
     - Run by hand: APP_URL=http://127.0.0.1:{{PORT}} node --test test\health.browser.test.js (with the app running,
       and NODE_PATH pointing at Cockpit's node_modules if playwright is not installed here).
   Keep browser tests to what only a browser can prove - rendering, navigation, forms, scripts. HTTP-level truth belongs
   in the flow test; it is faster and does not need Chromium. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const URL = process.env.APP_URL;
test('flow health-check (browser): open / -> the shell renders -> /api/health answers ok', { skip: !URL && 'APP_URL not set - Cockpit sets it in the functional stage' }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const res = await page.goto(URL + '/', { waitUntil: 'load', timeout: 15000 });   // open /
    assert.equal(res.status(), 200);
    assert.equal(await page.title(), '{{TITLE}}', 'the shell renders with its title');   // the shell renders
    const h = await page.evaluate(() => fetch('/api/health').then((r) => r.json()));    // GET /api/health, from the page itself
    assert.equal(h.ok, true);                                                             // see ok
    assert.deepEqual(errors, [], 'no script or console errors on the first screen');
  } finally { await browser.close(); }
});
