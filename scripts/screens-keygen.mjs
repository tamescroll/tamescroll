#!/usr/bin/env node
// One-time: make the signing key for over-the-air screens (screens.rs).
//
//   node scripts/screens-keygen.mjs
//
// Writes the PRIVATE key to secrets/screens-signing-key.pem (gitignored)
// and prints only the PUBLIC key, which goes into PUBLIC_KEY_HEX in
// app/src-tauri/src/screens.rs. Then store the private key as the
// SCREENS_SIGNING_KEY Actions secret:
//
//   gh secret set SCREENS_SIGNING_KEY --repo tamescroll/tamescroll < secrets/screens-signing-key.pem
//
// Never prints, logs or commits the private key. Refuses to overwrite an
// existing key: a new key locks every shipped build out of new screens
// until a build carrying the new public half reaches it.

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "secrets", "screens-signing-key.pem");
if (existsSync(out)) {
  console.error(`${out} already exists; refusing to replace it.`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
// SPKI DER for Ed25519 is a fixed 12-byte prefix + the 32-byte key.
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
console.log(raw.toString("hex"));
