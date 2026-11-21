#!/usr/bin/env bash
# ONE-CLICK PLAY BUILD. Double-click play-build.bat in the repo root; it
# runs this in Git Bash. Produces the signed .aab to upload in Play
# Console, at release-out/tamescroll-play-<code>.aab. Nothing is pushed or
# published: the upload is done by hand in Play Console.
#
# Every check below is a roadblock this repo has already hit once
# (CLAUDE.md THE RELEASE RECIPE, store/README.md "Roadblocks"):
#   - models missing   -> the engine silently runs on the worker
#   - stale gaze bundle -> tauri does not rebuild it
#   - gradlew exit 0 on failure -> the .aab mtime is the truth
#   - unsigned bundle   -> Play Console refuses it
#   - the install permission or the updater sneaking back in -> policy
#
# Version: the same versionCode as the newest sideload release, read from
# appupdate.rs. Play refuses a code it has seen, so a second upload of the
# same version needs a sideload release (release.bat) first.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nPLAY BUILD STOPPED: %s\n' "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="$ROOT/play-build.log"
: > "$LOG"
ANDROID_DIR=app/src-tauri/gen/android

if [ -z "${JAVA_HOME:-}" ]; then
  export JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot'
fi
[ -n "${ANDROID_HOME:-}" ] || die "ANDROID_HOME is not set."
ls "$ANDROID_DIR"/app/src/main/assets/models/*.tflite >/dev/null 2>&1 \
  || die "assets/models/*.tflite are missing: run spikes/native/convert.py first."
KP="$ANDROID_DIR/keystore.properties"
[ -f "$KP" ] || die "$KP is missing. See store/README.md, 'Upload key'."
JKS=$(sed -n 's/^storeFile=//p' "$KP" | tr -d '\r')
[ -n "$JKS" ] && [ -f "$JKS" ] || die "keystore.properties names storeFile '$JKS', which does not exist."

# ---- version ------------------------------------------------------------
RS=app/src-tauri/src/appupdate.rs
PROPS="$ANDROID_DIR"/app/tauri.properties
CODE=$(sed -n 's/.*CURRENT_VERSION_CODE: u64 = \([0-9]*\);.*/\1/p' "$RS")
[ -n "$CODE" ] || die "could not read CURRENT_VERSION_CODE from $RS."
NAME="0.1.$((CODE - 1000))"
say "Building Play $CODE ($NAME)"
printf 'tauri.android.versionName=%s\ntauri.android.versionCode=%s\n' "$NAME" "$CODE" > "$PROPS"

# ---- build --------------------------------------------------------------
say "Building the gaze bundle (must come first)"
node app/gaze/build/build.js >>"$LOG" 2>&1 || die "gaze bundle build failed (play-build.log)."

say "Building the Rust library (several minutes)"
STAMP=$(date +%s)
( cd app && npx tauri android build --debug --target aarch64 >>"$LOG" 2>&1 ) || true
SO=app/src-tauri/target/aarch64-linux-android/debug/libapp_lib.so
[ -f "$SO" ] && [ "$(stat -c %Y "$SO")" -ge "$STAMP" ] || die "the Rust build did not produce a new $SO (play-build.log)."

say "Stripping"
STRIP=$(ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe 2>/dev/null | sort | tail -1)
[ -n "$STRIP" ] || die "llvm-strip not found under ANDROID_HOME/ndk."
JNI="$ANDROID_DIR"/app/src/main/jniLibs/arm64-v8a
mkdir -p "$JNI"
"$STRIP" --strip-unneeded -o "$JNI/libapp_lib.so" "$SO"

# The play build type has no Rust task of its own (RustPlugin wires debug
# and release only), so it packages the stripped library from jniLibs.
say "Packaging the Play bundle"
AAB="$ANDROID_DIR"/app/build/outputs/bundle/arm64Play/app-arm64-play.aab
( cd "$ANDROID_DIR" && ./gradlew :app:clean :app:bundleArm64Play >>"$LOG" 2>&1 ) || true
[ -f "$AAB" ] && [ "$(stat -c %Y "$AAB")" -ge "$STAMP" ] || die "gradle did not produce a new .aab (play-build.log)."

# ---- checks -------------------------------------------------------------
say "Checking the bundle"
"$JAVA_HOME/bin/jarsigner" -verify "$AAB" >>"$LOG" 2>&1 || die "the .aab is not signed: check keystore.properties."
TMP=$(mktemp -d)
( cd "$TMP" && "$JAVA_HOME/bin/jar" xf "$ROOT/$AAB" base/manifest/AndroidManifest.xml )
MANIFEST="$TMP/base/manifest/AndroidManifest.xml"
[ -f "$MANIFEST" ] || die "could not read the bundle's manifest."
grep -aq "REQUEST_INSTALL_PACKAGES" "$MANIFEST" && die "the bundle still asks for REQUEST_INSTALL_PACKAGES (Play policy)."
grep -aq "READ_PHONE_STATE" "$MANIFEST" && die "the bundle asks for READ_PHONE_STATE (needs a Play declaration)."
rm -rf "$TMP"
SIZE=$(stat -c %s "$AAB")
[ "$SIZE" -lt 150000000 ] || die ".aab is $((SIZE / 1000000))MB: the .so was not stripped or a duplicate was packaged."

OUT="$ROOT/release-out"
mkdir -p "$OUT"
FILE="$OUT/tamescroll-play-$CODE.aab"
cp "$AAB" "$FILE"
printf '\nDONE: %s\n%sMB, versionCode %s, signed with the upload key.\nUpload it in Play Console > Testing > Internal testing first.\n' \
  "$FILE" "$((SIZE / 1000000))" "$CODE"
