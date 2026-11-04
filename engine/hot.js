/* hot(file) - require a module, re-reading it when its file changes on disk.

   The engine may run on one machine while it is edited from another over a network share. Every
   change to a core module was a restart at the engine's keyboard - five in one afternoon.
   Adapters and plugins already reload on mtime; this does the same for engine modules that
   hold no state worth keeping across a reload (graph, conversation, prompt). Modules that
   hold live state - projects (open databases), harness (running turns), plugins (running
   scans), the server itself - are NOT hot: a change to those is still a restart. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const seen = {};
function hot(file) {
  const f = path.resolve(file);
  let mt = 0; try { mt = fs.statSync(f).mtimeMs; } catch (e) { /* missing: let require throw */ }
  if (seen[f] !== undefined && seen[f] !== mt) { delete require.cache[require.resolve(f)]; console.log('hot → reloaded ' + path.basename(f)); }
  seen[f] = mt;
  return require(f);
}
module.exports = { hot };
