#!/usr/bin/env node
/* Portable test tooling - downloaded once, carried inside this folder, never installed.

   The functional (browser) and DAST stages need three things the engine does not ship: Chromium for
   Playwright, OWASP ZAP, and the Java runtime ZAP is written in. All three exist as plain archives, so
   they live here as archives - tools\dl\ - for BOTH Windows and Mac (Apple silicon), and are unpacked for
   whichever machine this folder is on the first time a test needs them. Copy the folder, and it runs;
   nothing goes on the machine, no installer, no PATH, no registry, no JAVA_HOME.

     node tools\fetch.js            download whatever is missing from tools\dl (both platforms)
     node tools\fetch.js --unpack   also unpack for THIS platform (browsers\, tools\zap\)
     node tools\fetch.js --check    say what is present, download nothing

   Why archives are kept rather than unpacked folders: a Mac .app and a Java runtime carry symlinks and
   executable bits that Windows cannot store, so the Mac pieces must be unpacked ON the Mac. The archives
   are the portable form; the unpacked folders are per-machine and gitignored, like node_modules.

   Versions are pinned below. Playwright's revision must match the installed package (browsers.json) -
   `npx playwright install chromium --dry-run` prints the current one; `--check` flags a mismatch. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.join(__dirname, '..');
const DL = path.join(root, 'tools', 'dl');
const BROWSERS = path.join(root, 'browsers');
const ZAP = path.join(root, 'tools', 'zap');

const CFT = '153.0.8010.12', PW_REV = '1243', FFMPEG_REV = '1011', WINLDD_REV = '1007';   // playwright 1.63.0
const ZAP_VER = '2.17.0';
const JRE_TAG = 'jdk-21.0.12.1%2B1', JRE_VER = '21.0.12.1_1';
const cdn = 'https://cdn.playwright.dev/';

/* each piece: file name in tools\dl, where it comes from, which platform it serves, where it unpacks to
   (relative to the engine root) and the file whose presence means "unpacked" */
const PIECES = [
  { file: 'chrome-win64.zip', url: cdn + 'builds/cft/' + CFT + '/win64/chrome-win64.zip', platform: 'win32', to: 'browsers/chromium-' + PW_REV, marker: 'chrome-win64/chrome.exe', playwright: true },
  { file: 'chrome-headless-shell-win64.zip', url: cdn + 'builds/cft/' + CFT + '/win64/chrome-headless-shell-win64.zip', platform: 'win32', to: 'browsers/chromium_headless_shell-' + PW_REV, marker: 'chrome-headless-shell-win64/chrome-headless-shell.exe', playwright: true },
  { file: 'ffmpeg-win64.zip', url: cdn + 'builds/ffmpeg/' + FFMPEG_REV + '/ffmpeg-win64.zip', platform: 'win32', to: 'browsers/ffmpeg-' + FFMPEG_REV, marker: 'ffmpeg-win64.exe', playwright: true },
  { file: 'winldd-win64.zip', url: cdn + 'builds/winldd/' + WINLDD_REV + '/winldd-win64.zip', platform: 'win32', to: 'browsers/winldd-' + WINLDD_REV, marker: 'PrintDeps.exe', playwright: true },
  { file: 'chrome-mac-arm64.zip', url: cdn + 'builds/cft/' + CFT + '/mac-arm64/chrome-mac-arm64.zip', platform: 'darwin', to: 'browsers/chromium-' + PW_REV, marker: 'chrome-mac-arm64/Google Chrome for Testing.app', playwright: true },
  { file: 'chrome-headless-shell-mac-arm64.zip', url: cdn + 'builds/cft/' + CFT + '/mac-arm64/chrome-headless-shell-mac-arm64.zip', platform: 'darwin', to: 'browsers/chromium_headless_shell-' + PW_REV, marker: 'chrome-headless-shell-mac-arm64/chrome-headless-shell', playwright: true },
  { file: 'ffmpeg-mac-arm64.zip', url: cdn + 'builds/ffmpeg/' + FFMPEG_REV + '/ffmpeg-mac-arm64.zip', platform: 'darwin', to: 'browsers/ffmpeg-' + FFMPEG_REV, marker: 'ffmpeg-mac-arm64', playwright: true },
  { file: 'ZAP_' + ZAP_VER + '_Crossplatform.zip', url: 'https://github.com/zaproxy/zaproxy/releases/download/v' + ZAP_VER + '/ZAP_' + ZAP_VER + '_Crossplatform.zip', platform: 'any', to: 'tools/zap', marker: 'ZAP_' + ZAP_VER + '/zap-' + ZAP_VER + '.jar' },
  { file: 'jre-win-x64.zip', url: 'https://github.com/adoptium/temurin21-binaries/releases/download/' + JRE_TAG + '/OpenJDK21U-jre_x64_windows_hotspot_' + JRE_VER + '.zip', platform: 'win32', to: 'tools/zap/jre-win', marker: 'bin/java.exe', strip: 1 },
  /* semgrep, as a folder: the embeddable Python with semgrep in it and the rule packs beside it, zipped at the desk -
     not downloaded from anywhere; the archive is put in tools\dl by hand and unpacked here. engine/sast.js runs it. */
  { file: 'semgrep-win64.zip', url: null, platform: 'win32', to: 'tools', marker: 'semgrep/python/Scripts/semgrep.exe', group: 'semgrep' },
  { file: 'jre-mac-arm64.tar.gz', url: 'https://github.com/adoptium/temurin21-binaries/releases/download/' + JRE_TAG + '/OpenJDK21U-jre_aarch64_mac_hotspot_' + JRE_VER + '.tar.gz', platform: 'darwin', to: 'tools/zap/jre-mac', marker: 'Contents/Home/bin/java', strip: 1 },
];

/* what the rest of the engine asks: where is the browser folder, where is java, where is ZAP's jar */
function paths() {
  const p = process.platform;
  return {
    browsers: BROWSERS,
    java: p === 'win32' ? path.join(ZAP, 'jre-win', 'bin', 'java.exe') : path.join(ZAP, 'jre-mac', 'Contents', 'Home', 'bin', 'java'),
    zapJar: path.join(ZAP, 'ZAP_' + ZAP_VER, 'zap-' + ZAP_VER + '.jar'),
    zapDir: path.join(ZAP, 'ZAP_' + ZAP_VER),
  };
}
function ready() {   // { browsers, zap } - true when unpacked for this platform
  const mine = PIECES.filter((x) => x.platform === process.platform || x.platform === 'any');
  const has = (x) => fs.existsSync(path.join(root, x.to, x.marker));
  return { browsers: mine.filter((x) => x.playwright).every(has), zap: mine.filter((x) => !x.playwright && x.group !== 'semgrep').every(has), semgrep: mine.filter((x) => x.group === 'semgrep').every(has), missingArchives: mine.filter((x) => !fs.existsSync(path.join(DL, x.file)) && x.url).map((x) => x.file) };
}

async function download(piece) {
  const dest = path.join(DL, piece.file), tmp = dest + '.part';
  if (fs.existsSync(dest)) return 'have';
  if (!piece.url) return 'no archive';   // built at the desk (semgrep): nothing to download - the archive is copied into tools\dl
  fs.mkdirSync(DL, { recursive: true });
  const res = await fetch(piece.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(piece.url + ' -> ' + res.status);
  const total = Number(res.headers.get('content-length') || 0); let got = 0, lastPct = -1;
  const out = fs.createWriteStream(tmp);
  for await (const chunk of res.body) { out.write(chunk); got += chunk.length; const pct = total ? Math.floor(got * 10 / total) * 10 : -1; if (pct !== lastPct) { lastPct = pct; process.stdout.write('\r  ' + piece.file + ' ' + (total ? pct + '%' : Math.round(got / 1e6) + ' MB')); } }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(tmp, dest); process.stdout.write('\r  ' + piece.file + ' ' + Math.round(got / 1e6) + ' MB\n');
  return 'downloaded';
}
function unpack(piece) {   // tar handles .zip and .tar.gz on Windows 10+, Mac and Linux alike; nothing to install
  const to = path.join(root, piece.to);
  if (fs.existsSync(path.join(to, piece.marker))) return 'unpacked';
  const archive = path.join(DL, piece.file);
  if (!fs.existsSync(archive)) return 'no archive';
  fs.mkdirSync(to, { recursive: true });
  const args = ['-xf', archive, '-C', to]; if (piece.strip) args.push('--strip-components=' + piece.strip);
  const r = cp.spawnSync('tar', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('tar failed on ' + piece.file + ': ' + (r.stderr || '').slice(-400));
  if (piece.playwright) fs.writeFileSync(path.join(to, 'INSTALLATION_COMPLETE'), '');   // what Playwright looks for before it trusts a browser folder
  return 'unpacked now';
}
async function main() {
  const a = process.argv.slice(2);
  const st = ready();
  if (a.includes('--check')) {
    for (const p of PIECES) console.log((fs.existsSync(path.join(DL, p.file)) ? 'have   ' : 'MISSING') + '  ' + p.file + '  (' + p.platform + ')');
    console.log('this platform: browsers ' + (st.browsers ? 'ready' : 'not unpacked') + ', zap ' + (st.zap ? 'ready' : 'not unpacked'));
    try { const b = require(path.join(root, 'node_modules', 'playwright-core', 'browsers.json')); const rev = b.browsers.find((x) => x.name === 'chromium').revision; if (rev !== PW_REV) console.log('PLAYWRIGHT REVISION MISMATCH: package wants ' + rev + ', this script pins ' + PW_REV + ' - update the pins'); } catch (e) { console.log('playwright not installed in node_modules'); }
    return;
  }
  console.log('downloading to ' + DL);
  for (const p of PIECES) { const r = await download(p); if (r === 'have') console.log('  ' + p.file + ' (have)'); }
  if (a.includes('--unpack')) for (const p of PIECES) if (p.platform === process.platform || p.platform === 'any') console.log('  ' + p.to + ': ' + unpack(p));
  const after = ready(); console.log('this platform: browsers ' + (after.browsers ? 'ready' : 'archives present, run --unpack') + ', zap ' + (after.zap ? 'ready' : 'archives present, run --unpack'));
}
module.exports = { PIECES, paths, ready, unpack, download, ZAP_VER, PW_REV };
if (require.main === module) main().catch((e) => { console.error('fetch: ' + e.message); process.exit(1); });
