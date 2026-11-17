#!/usr/bin/env bash
# ONE-CLICK RELEASE (his 2026-10-23 ask: "i need a other simpler way").
# Double-click release.bat in the repo root; it runs this in Git Bash.
# This is THE RELEASE RECIPE from CLAUDE.md, start to finish, with every
# check the recipe says a human must not skip done here instead:
#   - the gaze bundle is built FIRST (tauri does not build it)
#   - the APK's mtime is checked, never gradlew's exit code
#   - the asset is uploaded from a file named after the release
#   - the served APK is re-downloaded and hashed, and isDraft is read
# It must run on HIS PC: the APK is a release build signed with the key
# keystore.properties names (store/README.md), and an APK signed with any
# other key will not install over the app.
#
# Version: if the version in appupdate.rs has no GitHub release yet, that
# version is released (a bump left in the tree is used, not doubled);
# otherwise everything is bumped by one first.
#
# Notes: updates/next-notes.txt (one line) if present, else a generic line.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nRELEASE STOPPED: %s\n' "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPO=tamescroll/tamescroll
LOG="$ROOT/release.log"
: > "$LOG"

if [ -z "${JAVA_HOME:-}" ]; then
  export JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot'
fi
[ -n "${ANDROID_HOME:-}" ] || die "ANDROID_HOME is not set."
command -v gh >/dev/null || die "the GitHub CLI (gh) is not installed."
gh auth status >/dev/null 2>&1 || die "gh is not signed in: run 'gh auth login' once."
KP=app/src-tauri/gen/android/keystore.properties
[ -f "$KP" ] || die "$KP is missing: the release APK cannot be signed (store/README.md)."
ls app/src-tauri/gen/android/app/src/main/assets/models/*.tflite >/dev/null 2>&1 \
  || die "assets/models/*.tflite are missing: run spikes/native/convert.py first."

say "Bringing main up to date"
git checkout -q main
git pull -q --ff-only --autostash origin main || die "git pull failed (see above)."

# ---- version ------------------------------------------------------------
RS=app/src-tauri/src/appupdate.rs
CONF=app/src-tauri/tauri.conf.json
PROPS=app/src-tauri/gen/android/app/tauri.properties
CODE=$(sed -n 's/.*CURRENT_VERSION_CODE: u64 = \([0-9]*\);.*/\1/p' "$RS")
[ -n "$CODE" ] || die "could not read CURRENT_VERSION_CODE from $RS."
if gh release view "app-v0.1.$((CODE - 1000))" --repo "$REPO" >/dev/null 2>&1; then
  CODE=$((CODE + 1))
fi
NAME="0.1.$((CODE - 1000))"
TAG="app-v$NAME"
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && die "$TAG already exists."
say "Releasing $CODE ($NAME)"
sed -i "s/CURRENT_VERSION_CODE: u64 = [0-9]*;/CURRENT_VERSION_CODE: u64 = $CODE;/" "$RS"
sed -i "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$NAME\"/" "$CONF"
if [ -f "$PROPS" ]; then
  sed -i "s/^tauri.android.versionCode=.*/tauri.android.versionCode=$CODE/;s/^tauri.android.versionName=.*/tauri.android.versionName=$NAME/" "$PROPS"
else
  printf 'tauri.android.versionName=%s\ntauri.android.versionCode=%s\n' "$NAME" "$CODE" > "$PROPS"
fi

NOTES="Bug fixes and improvements."
if [ -s updates/next-notes.txt ]; then NOTES=$(head -n 1 updates/next-notes.txt | tr -d '\r'); fi

# ---- build --------------------------------------------------------------
say "Building the gaze bundle (must come first)"
node app/gaze/build/build.js >>"$LOG" 2>&1 || die "gaze bundle build failed (release.log)."

say "Building the Rust library (several minutes)"
STAMP=$(date +%s)
( cd app && npx tauri android build --debug --target aarch64 >>"$LOG" 2>&1 ) || true
SO=app/src-tauri/target/aarch64-linux-android/debug/libapp_lib.so
[ -f "$SO" ] && [ "$(stat -c %Y "$SO")" -ge "$STAMP" ] || die "the Rust build did not produce a new $SO (release.log)."

say "Stripping"
STRIP=$(ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe 2>/dev/null | sort | tail -1)
[ -n "$STRIP" ] || die "llvm-strip not found under ANDROID_HOME/ndk."
JNI=app/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a
mkdir -p "$JNI"
"$STRIP" --strip-unneeded -o "$JNI/libapp_lib.so" "$SO"

say "Packaging the APK"
APK=app/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk
( cd app/src-tauri/gen/android && ./gradlew :app:clean :app:assembleArm64Release -x :app:rustBuildArm64Release >>"$LOG" 2>&1 ) || true
# gradlew exits 0 on a failed task: the mtime is the truth.
[ -f "$APK" ] && [ "$(stat -c %Y "$APK")" -ge "$STAMP" ] || die "gradle did not produce a new APK (release.log)."
"$JAVA_HOME/bin/jarsigner" -verify "$APK" >>"$LOG" 2>&1 || die "the APK is not signed: check keystore.properties."
SIZE=$(stat -c %s "$APK")
[ "$SIZE" -lt 120000000 ] || die "APK is $((SIZE / 1000000))MB: the .so was not stripped or a duplicate was packaged."

# ---- publish ------------------------------------------------------------
OUT="$ROOT/release-out"
mkdir -p "$OUT"
FILE="$OUT/tamescroll-$CODE.apk"
cp "$APK" "$FILE"
URL="https://github.com/$REPO/releases/download/$TAG/tamescroll-$CODE.apk"

say "Publishing $TAG"
gh release create "$TAG" "$FILE" --repo "$REPO" --title "Tame Scroll $NAME" --notes "$NOTES" >>"$LOG" 2>&1 \
  || die "gh release create failed (release.log). Check for a leftover draft."

node scripts/gen-app-manifest.mjs "$FILE" "$URL" "$NOTES" >>"$LOG" 2>&1
git add "$RS" "$CONF" updates/app-manifest.json
git commit -q -m "$CODE: release $NAME" -m "$NOTES"
git push -q origin main || die "push to main failed; the release is up but the updater does not know yet."

# ---- verify (recipe step 8) ---------------------------------------------
say "Checking what the phone will download"
[ "$(gh release view "$TAG" --repo "$REPO" --json isDraft -q .isDraft)" = "false" ] || die "$TAG is a DRAFT: the download 404s."
WANT=$(sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p' updates/app-manifest.json)
GOT=$(curl -sSL "$URL" | sha256sum | cut -d' ' -f1)
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || die "served APK hash $GOT does not match the manifest $WANT."

printf '\nDONE: %s (%s) is live. Phones get it from Settings > About > Check for updates.\nsha256 %s\n' "$NAME" "$CODE" "$GOT"
