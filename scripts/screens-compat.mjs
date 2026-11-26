#!/usr/bin/env node
// May the screens at HEAD go over the air to the build phones run now?
// (screens.rs; .github/workflows/screens.yml runs this.)
//
//   node scripts/screens-compat.mjs [--native-ok] [--disable]
//
// Prints one line and, under Actions, writes `mode` and `reason` to
// $GITHUB_OUTPUT:
//
//   publish  screens changed since that build was released, and nothing
//            native did -- safe to send.
//   sealed   the screens at HEAD are the build's own: publish the
//            "use the sealed screens" switch (also what --disable asks).
//   hold     native code changed since the release, so these screens
//            may need a native side the phones do not have yet. They
//            ship with the next build instead. --native-ok overrides,
//            for someone who has checked the native change does not
//            touch anything the screens call.
//
// "The build phones run now" is CURRENT_VERSION_CODE in appupdate.rs,
// and its release is the commit whose subject starts "<code>: release"
// (THE RELEASE RECIPE, step 7). No such commit yet means hold.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

// What the screens are built from. A change here changes what ships.
export const SCREEN_PATHS = [
  "app/index.html",
  "app/src",
  "app/public",
  "app/package.json",
  "app/pnpm-lock.yaml",
  "app/vite.config.ts",
  "app/tsconfig.json",
];

// What the screens talk to: commands, URL parameters the Kotlin bar
// loads, window globals, capabilities. In-page code (gaze, scriptlets,
// page scripts) is NOT here: it never talks to the screens.
export const NATIVE_PATHS = [
  "app/src-tauri/src",
  "app/src-tauri/gen",
  "app/src-tauri/plugins",
  "app/src-tauri/capabilities",
  "app/src-tauri/tauri.conf.json",
  "app/src-tauri/Cargo.toml",
  "app/src-tauri/Info.ios.plist",
  "app/src-tauri/ios-shortcuts",
];

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

export function currentBuild() {
  const src = readFileSync(join(root, "app/src-tauri/src/appupdate.rs"), "utf8");
  const m = src.match(/pub const CURRENT_VERSION_CODE: u64 = (\d+);/);
  if (!m) throw new Error("CURRENT_VERSION_CODE not found in appupdate.rs");
  return Number(m[1]);
}

function decide() {
  const build = currentBuild();
  if (args.has("--disable")) return { mode: "sealed", reason: `asked to switch build ${build} back to its built-in screens` };
  const rel = git("log", "-1", "--format=%H", "--extended-regexp", `--grep=^${build}: release`);
  if (!rel) return { mode: "hold", reason: `build ${build} has no "${build}: release" commit yet` };
  const changed = (paths) => git("diff", "--name-only", rel, "HEAD", "--", ...paths).split("\n").filter(Boolean);
  const screens = changed(SCREEN_PATHS);
  if (!screens.length) return { mode: "sealed", reason: `screens are unchanged since build ${build} was released` };
  const native = changed(NATIVE_PATHS);
  if (native.length && !args.has("--native-ok")) {
    return {
      mode: "hold",
      reason: `native code changed since build ${build} (${native.slice(0, 5).join(", ")}${native.length > 5 ? ", ..." : ""}); these screens ship with the next build. Re-run with native_ok once checked.`,
    };
  }
  return { mode: "publish", reason: `${screens.length} screen file(s) changed since build ${build}` };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("screens-compat.mjs")) {
  const { mode, reason } = decide();
  console.log(`${mode}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\nreason=${reason.replace(/\n/g, " ")}\nbuild=${currentBuild()}\n`);
  }
}
