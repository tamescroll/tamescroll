// Regenerates rules/manifest.json — the index the app's rules OTA
// (app/src-tauri/src/ota.rs) fetches to learn what changed. Run after
// ANY edit to the files listed below, commit + push together with them;
// a pushed rule change without a manifest bump is invisible to shipped
// apps.
//
//   node scripts/gen-rules-manifest.mjs
//
// Hashes are over LF-normalized bytes: raw.githubusercontent.com serves
// git-blob bytes, and this repo's index stores LF (core.autocrlf may
// leave CRLF in the working tree on Windows). resources.json and the
// scriptlets are deliberately absent — they are CODE and ship in the
// binary only (docs/rules-updates.md, store policy).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rulesDir = join(root, 'rules');

// Must stay in sync with rules::embedded() in app/src-tauri/src/rules.rs
// — a name missing there is ignored by every shipped app.
const FILES = [
  'youtube.txt',
  'reddit.txt',
  'x.txt',
  'tiktok.txt',
  'instagram.txt',
  'facebook.txt',
  'twitch.txt',
  'linkedin.txt',
  'pinterest.txt',
  'scriptlets.txt',
  'tuning.json',
  'blur/youtube.css',
  'blur/reddit.css',
  'blur/x.css',
  'blur/tiktok.css',
  'blur/instagram.css',
  'blur/facebook.css',
  'blur/twitch.css',
  'blur/linkedin.css',
  'blur/pinterest.css',
  // The browser extension's remote off switches (extension/src/kill.js).
  // Data only; the app has no use for it and ignores the name.
  'kill.json',
  'vendor/easylist.txt',
  'vendor/easyprivacy.txt',
  'vendor/ubo-filters.txt',
  'vendor/ubo-quick-fixes.txt',
  'vendor/ubo-unbreak.txt',
];

const files = {};
for (const name of FILES) {
  const text = readFileSync(join(rulesDir, name), 'utf8').replaceAll('\r\n', '\n');
  files[name] = { sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

const manifest = { version: 1, files };
writeFileSync(join(rulesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`rules/manifest.json: ${FILES.length} files`);
