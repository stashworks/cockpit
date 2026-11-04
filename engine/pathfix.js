/* THE TOOLS MUST BE FINDABLE HOWEVER THE ENGINE IS STARTED. Started hidden, at Windows sign-in, or as a service, the PATH
   may be the machine's, not yours - and gh (WinGet), codex (npm global), claude (~\.local\bin) and Git all live in
   folders their installers add for the next login, not for an engine already running. So the folders those installers
   use are appended (index.js at start; engine/wizard.js again right after it installs something, so a tool installed
   from the wizard is found without a restart). Only folders that exist are added; nothing is removed. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function candidates() {
  const home = os.homedir(), pf = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
    path.join(home, '.local', 'bin'),
    path.join(pf, 'GitHub CLI'),
    path.join(pf, 'nodejs'),
    path.join(pf, 'Git', 'cmd'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Git', 'cmd')   // Git installed for this user only
  ];
}
function widen(log) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const have = new Set((process.env.PATH || '').split(sep).map((p) => p.toLowerCase()));
  const add = candidates().filter((d) => fs.existsSync(d) && !have.has(d.toLowerCase()));
  if (add.length) { process.env.PATH = (process.env.PATH || '') + sep + add.join(sep); if (log) log('path → added ' + add.join(', ')); }
  return add;
}
module.exports = { widen };
