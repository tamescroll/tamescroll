// Checks the store packages `node build.mjs --store` wrote, against the
// Chrome Web Store and Firefox Add-ons rules this repo has to keep:
//   - no developer self-reload (management, runtime.reload, build-id.txt);
//   - no code built from text (eval, new Function, string timers);
//   - nothing executable fetched: every fetch() is the daily rules
//     manifest or a file inside the package;
//   - only the permissions the listing justifies;
//   - the scriptlets live in youtube-ads.js alone.
// Exits 1 with every failure listed. CI runs it after the store build.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ALLOWED_PERMISSIONS = ['alarms', 'scripting', 'storage'];
// The sites the listing and its host-permission justification name
// (store/chrome-web-store/README.md). A new one fails here until the
// listing, the justification and web/privacy.html name it too.
const LISTED_HOSTS = [
  'https://www.youtube.com/*', 'https://m.youtube.com/*', 'https://www.reddit.com/*', 'https://x.com/*',
  'https://www.instagram.com/*', 'https://www.facebook.com/*', 'https://www.tiktok.com/*',
  'https://www.twitch.tv/*', 'https://www.linkedin.com/*',
];
// Hosts the gaze bundle may NAME (in comments, error text and page
// checks): the sites it runs on, and the W3C, GitHub and MDN links in
// tfjs's own error messages. None of them is fetched from.
const GAZE_OK_HOSTS = /^(www\.youtube\.com|m\.youtube\.com|youtube\.com|i\.ytimg\.com|www\.w3\.org|github\.com|developer\.mozilla\.org)$/;
const fails = [];

function files(dir) {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
}

export function checkPackage(dir) {
  const out = [];
  const name = (p) => p.slice(dir.length + 1).replace(/\\/g, '/');
  if (existsSync(join(dir, 'build-id.txt'))) out.push('build-id.txt is in the package');
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const extra = (m.permissions || []).filter((p) => !ALLOWED_PERMISSIONS.includes(p));
  if (extra.length) out.push(`unjustified permissions: ${extra.join(', ')}`);
  if ((m.optional_permissions || []).length) out.push('optional_permissions are not in the listing');
  const unlisted = (m.host_permissions || []).filter((h) => !LISTED_HOSTS.includes(h));
  if (unlisted.length) out.push(`host_permissions not in the listing: ${unlisted.join(', ')}`);
  for (const f of files(dir).filter((p) => p.endsWith('.js'))) {
    // Line comments out: the scriptlets' own comments mention fetch().
    const js = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const n = name(f);
    if (/\bmanagement\.|runtime\.reload\(|build-id\.txt/.test(js)) out.push(`${n}: developer self-reload code`);
    if (/\beval\s*\(|new Function\s*\(|\bFunction\s*\(\s*['"`]|set(Timeout|Interval)\s*\(\s*['"`]/.test(js)) out.push(`${n}: code built from text`);
    if (/importScripts\s*\(|document\.createElement\(\s*['"]script['"]\s*\)/.test(js)) out.push(`${n}: loads a script at run time`);
    if (n !== 'youtube-ads.js' && /function jsonPrune|scriptlet/i.test(js) && /\bscript:\s*["'`]function/.test(js)) out.push(`${n}: carries scriptlet code as text`);
    // gaze.js is Smart blur's runtime with TensorFlow.js inside, whose
    // model loaders call fetch() on whatever URL they are handed. The
    // runtime hands them package files only (gaze-models/, through
    // detector.js modelBase), and gaze.js may not name any other host.
    if (n === 'gaze.js') {
      const hosts = [...js.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((x) => x[1]).filter((h) => !GAZE_OK_HOSTS.test(h));
      if (hosts.length) out.push(`gaze.js names hosts it could fetch from: ${[...new Set(hosts)].join(', ')}`);
      continue;
    }
    for (const [, arg] of js.matchAll(/\bfetch\(\s*([^,)]+)/g)) {
      if (!/^(url|(api\d*|chrome)\.runtime\.getURL)\b/.test(arg.trim())) out.push(`${n}: fetch(${arg.trim()}) is not a rules or package URL`);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const target of ['chrome-store', 'firefox-store']) {
    const dir = join(here, 'dist', target);
    if (!existsSync(dir)) { fails.push(`${target}: missing, run node build.mjs --store`); continue; }
    for (const f of checkPackage(dir)) fails.push(`${target}: ${f}`);
  }
  if (fails.length) {
    console.error(fails.join('\n'));
    process.exit(1);
  }
  console.log('store packages: ok');
}
