#!/usr/bin/env node
// Upload a Play bundle (.aab) to a TESTING track through the Play Developer
// API, using the play-upload service account. No dependencies.
//
//   node scripts/play-upload.mjs <bundle.aab> [--track internal|alpha|beta|<closed track id>]
//                                [--notes "release notes"] [--status draft|completed]
//                                [--check]
//
// Defaults: track internal, status draft (ZV's rule: drafts unless he says
// otherwise). --check opens and discards an edit without changing anything,
// to prove the key and permission work.
//
// The key is read from secrets/play-service-account.json (gitignored) or
// $PLAY_SERVICE_ACCOUNT_JSON. The account can only release to testing
// tracks; this script refuses "production" on its own as well.

import { readFileSync, statSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PACKAGE = 'app.tamescroll.client';
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyPath = process.env.PLAY_SERVICE_ACCOUNT_JSON
  || path.join(root, 'secrets', 'play-service-account.json');

function parseArgs(argv) {
  const out = { track: 'internal', status: 'draft', notes: '', check: false, aab: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--track') out.track = argv[++i];
    else if (a === '--status') out.status = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--check') out.check = true;
    else if (!a.startsWith('--')) out.aab = a;
    else throw new Error(`unknown option ${a}`);
  }
  if (out.track === 'production') throw new Error('refusing production: testing tracks only');
  if (!['draft', 'completed'].includes(out.status)) throw new Error('--status must be draft or completed');
  if (!out.check && !out.aab) throw new Error('give a .aab path, or --check');
  return out;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function token() {
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key);
  const res = await fetch(key.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${b64url(sig)}`,
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`token: ${res.status} ${JSON.stringify(j)}`);
  return { access: j.access_token, email: key.client_email };
}

async function call(tok, method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url.replace(API, '').replace(UPLOAD, '')}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const { access, email } = await token();
  console.log(`account ${email}, package ${PACKAGE}`);
  const edit = await call(access, 'POST', `${API}/edits`, {});

  if (opt.check) {
    const tracks = await call(access, 'GET', `${API}/edits/${edit.id}/tracks`);
    for (const t of tracks.tracks || []) {
      const r = (t.releases || []).map((x) => `${x.name || '?'} [${x.status}] ${(x.versionCodes || []).join(',')}`);
      console.log(`  ${t.track}: ${r.join('; ') || '(empty)'}`);
    }
    await call(access, 'DELETE', `${API}/edits/${edit.id}`);
    console.log('check ok: edit opened and discarded, nothing changed');
    return;
  }

  const bytes = new Uint8Array(readFileSync(opt.aab));
  console.log(`uploading ${opt.aab} (${(statSync(opt.aab).size / 1e6).toFixed(1)} MB)`);
  const bundle = await call(access, 'POST',
    `${UPLOAD}/edits/${edit.id}/bundles?uploadType=media`, bytes,
    { 'content-type': 'application/octet-stream' });
  const code = String(bundle.versionCode);
  console.log(`bundle accepted: versionCode ${code}, sha256 ${bundle.sha256}`);

  const release = { versionCodes: [code], status: opt.status, name: code };
  if (opt.notes) release.releaseNotes = [{ language: 'en-US', text: opt.notes }];
  await call(access, 'PUT', `${API}/edits/${edit.id}/tracks/${opt.track}`,
    { track: opt.track, releases: [release] });
  await call(access, 'POST', `${API}/edits/${edit.id}:commit`);
  console.log(`committed: ${code} on ${opt.track} as ${opt.status}`);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
