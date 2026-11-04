/* LAG WATCH (move the engine's blocking git/gh work off its main thread). Measure first:
   every synchronous child-process call (execFileSync / execSync / spawnSync) that takes over half a second freezes the
   whole engine - queue, pages, API - for that long. This records each one with its command, folder and caller, plus the
   event loop's stall percentiles every minute, to logs/blocking.log. Installed once per engine process, from a module the
   engine re-reads without a restart (engine/ghqueue.js), so it measures the running engine as it is. Read-only: it
   times the calls, it never changes what they do or return. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const LOG = path.join(__dirname, '..', 'logs', 'blocking.log');
const SLOW_MS = 500;
const put = (line) => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, new Date().toISOString() + '  ' + line + '\n'); } catch (e) { /* never break the engine over a log line */ } };
const caller = () => String(new Error().stack || '').split('\n').slice(3, 7).map((l) => l.trim().replace(/^at /, '').replace(/\(?[A-Za-z]:\\[^)]*\\(engine|plugins)\\/, '$1/')).join(' < ');
const short = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').slice(0, 140);

function install() {
  if (global.__cockpitLagwatch) return false;
  global.__cockpitLagwatch = true;
  for (const name of ['execFileSync', 'execSync', 'spawnSync']) {
    const orig = cp[name];
    cp[name] = function timed(cmd, a, b) {
      const t0 = Date.now();
      try { return orig.apply(this, arguments); }
      finally {
        const ms = Date.now() - t0;
        if (ms >= SLOW_MS) {
          const args = Array.isArray(a) ? a.filter((x) => !/^(-c|safe\.directory=\*|core\.quotepath=off)$/.test(x)).slice(0, 6).join(' ') : '';
          const opts = Array.isArray(a) ? b : a;
          put('BLOCKED ' + ms + 'ms  ' + name + ' ' + short(cmd) + ' ' + short(args) + '  cwd=' + short(opts && opts.cwd) + '  from ' + caller());
        }
      }
    };
  }
  const h = monitorEventLoopDelay({ resolution: 50 }); h.enable();
  setInterval(() => {
    const ms = (n) => Math.round(n / 1e6);
    if (ms(h.max) >= SLOW_MS) put('LOOP   p50=' + ms(h.percentile(50)) + 'ms p99=' + ms(h.percentile(99)) + 'ms max=' + ms(h.max) + 'ms over the last minute');
    h.reset();
  }, 60000).unref();
  put('lagwatch installed in engine pid ' + process.pid + ' (slow = ' + SLOW_MS + 'ms)');
  return true;
}
module.exports = { install, LOG };
