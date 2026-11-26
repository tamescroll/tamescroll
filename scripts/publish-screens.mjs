#!/usr/bin/env node
// Signs a copy of the app's screens for over-the-air delivery
// (app/src-tauri/src/screens.rs). .github/workflows/screens.yml runs it;
// it can be run by hand with the key from secrets/.
//
//   SCREENS_SIGNING_KEY="$(cat secrets/screens-signing-key.pem)" \
//     node scripts/publish-screens.mjs --dist app/dist --out <screens-branch-checkout> [--disable]
//
// Writes into --out:
//   manifest.json  {format, for_build, seq, commit, disabled, files}
//   manifest.sig   base64 Ed25519 signature over manifest.json's bytes
//   blobs/<sha256> every file, named by its hash (never deleted, so a
//                  phone mid-download never loses the file it wants)
//
// Refuses to sign with a key whose public half is not the one compiled
// into screens.rs -- phones would refuse the result anyway, silently.
// Prints "unchanged" and writes nothing when --out already serves the
// same files for the same build.

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentBuild } from "./screens-compat.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const dist = opt("--dist") ?? join(root, "app/dist");
const out = opt("--out");
const disable = argv.includes("--disable");
if (!out) {
  console.error("usage: publish-screens.mjs --dist app/dist --out <dir> [--disable]");
  process.exit(2);
}

const pem = process.env.SCREENS_SIGNING_KEY;
if (!pem || !pem.includes("PRIVATE KEY")) {
  console.error("SCREENS_SIGNING_KEY is not set (the Actions secret, or secrets/screens-signing-key.pem).");
  process.exit(1);
}
const key = createPrivateKey(pem);
const pub = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const screensRs = readFileSync(join(root, "app/src-tauri/src/screens.rs"), "utf8");
const compiled = screensRs.match(/const PUBLIC_KEY_HEX: &str = "([0-9a-f]{64})";/)?.[1];
if (compiled !== pub) {
  console.error("This key is not the one screens.rs checks against; phones would refuse what it signs.");
  process.exit(1);
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const build = currentBuild();
const files = {};
if (!disable) {
  if (!existsSync(join(dist, "index.html"))) {
    console.error(`${dist} has no index.html -- run the screens build first.`);
    process.exit(1);
  }
  mkdirSync(join(out, "blobs"), { recursive: true });
  for (const p of walk(dist).sort()) {
    const name = relative(dist, p).split(sep).join("/");
    const h = sha(readFileSync(p));
    files[name] = { sha256: h };
    const blob = join(out, "blobs", h);
    if (!existsSync(blob)) copyFileSync(p, blob);
  }
}

// Same build, same files (or still disabled): nothing to publish.
const servedPath = join(out, "manifest.json");
if (existsSync(servedPath)) {
  try {
    const served = JSON.parse(readFileSync(servedPath, "utf8"));
    if (served.for_build === build && !!served.disabled === disable && JSON.stringify(served.files ?? {}) === JSON.stringify(files)) {
      console.log("unchanged");
      process.exit(0);
    }
    if (disable && served.for_build !== build) {
      console.log("unchanged (nothing is served to this build)");
      process.exit(0);
    }
  } catch {
    /* unreadable: replace it */
  }
}

const manifest = {
  format: 1,
  for_build: build,
  seq: Math.floor(Date.now() / 1000),
  commit: process.env.GITHUB_SHA ?? "",
  disabled: disable,
  files,
};
const json = Buffer.from(JSON.stringify(manifest, null, 1) + "\n");
writeFileSync(servedPath, json);
writeFileSync(join(out, "manifest.sig"), sign(null, json, key).toString("base64") + "\n");
console.log(disable ? `published: build ${build} back to its built-in screens` : `published: ${Object.keys(files).length} files for build ${build}, seq ${manifest.seq}`);
