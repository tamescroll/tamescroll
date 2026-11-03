## Session state (update every session)

**Last updated:** 2026-09-26 (handoff; no work since 2026-09-10).
**1120 IS THE RELEASE**, served hash verified, HEAD pushed, tree clean
apart from scratch frames under `.overnight/`. Every session-state block
before this one moved to `docs/handoffs-archive.md` (bottom section).
The running log with raw numbers is `docs/autonomy-log.md`; the owner's
map of calls is artifact e198a03e.

**WHAT THE APP IS NOW (1113-1120, all on his phone `e3d369ee`):**
tile tap dims at once (1113); all three models on GPU on his Adreno --
the crash breadcrumb now needs 3 strikes (1114); a link or shortcut
never paints the launcher first (1115); the YouTube shortcut is a plain
cream "Y" on our ink (red tile retired 2026-10-28) and the links "Set up" step reports what the launcher did
(1116/1117); onboarding's last step offers the home icon (1118);
**YouTube opens on its BLANK home -- the Subscriptions landing shipped in
1118 and was REVERTED in 1119 on his word, do not bring it back**;
mini player no longer leaves the title under the top bar or the chips
bar mid-screen (1120). OTA rules: the watch-next related-items SECTION
is hidden (per-item hiding kept fetching 600+ videos into a hidden
column).

**HIS RULINGS, standing:** mobile first; browser extension stays dead;
student gender model PARKED (it was tried 5 Sept and lost: best 0.977 vs
shipped 0.986 -- do not call it "unmeasured" again); NULL_MINT_NM_FLOOR
stays 5 (6 measured +30% exposure); GENDER_IMAGE_NM_FLOOR 6 (thumbnail
junk); grey is ON over OTA (`GENDER_GREY` 1); NULL_HOLD_PASSES ships 1
(weak read refused once, then covered); home icon must be OUR glyph,
never YouTube's logo.

**OPEN WORK LIVES IN GITHUB ISSUES** (since 2026-10-22), not in this
file, WORKLIST.md or docs/owner-issues.md:
https://github.com/tamescroll/tamescroll/issues
In order: #2 YouTube-change canary (ask him first: what counts as
broken, how he wants to hear) · #3 Reddit pass · #4 X pass · #5 Windows
pass · #6 Play listing pack (his hands) · #7 and #8 need a repro from
him. Label `needs-owner` = his call or his hands; never push those
without his word. A new ask from him becomes an issue before work
starts. Work lands through pull requests; CI (`.github/workflows/ci.yml`)
runs the gaze tests, the Rust tests and the rules-manifest check.

**DEVICE FACTS THAT COST TIME:** his launcher is olauncher; HyperOS
ignores injected Back (keyevent and nav-bar taps) -- Back cannot be
driven from adb; the old Redmi `1ec2c48e0621` is PIN-locked and its CDP
touch injection times out. Probes for all of the above live in
`spikes/gauntlet/probe_*.py` (open/search/link frames, watch scroll,
mini, pin icon, 1118). Python cannot open `/z/...` paths -- use `Z:/`;
a chained command that `cd`s breaks later relative paths.

**Everything before 2026-09-03 16:30 has moved to
`docs/handoffs-archive.md`** -- ~6,400 lines of superseded session logs
that were loading in full at every session start and consuming the
context window before any work began. Nothing was deleted; the durable
rules from them are distilled below and the narrative is one file away.

---

# STANDING RULES -- distilled 2026-09-04 from ~40 stacked handoffs

Everything before 2026-09-03 16:30 lives in `docs/handoffs-archive.md`.
It was moved, not deleted -- this file loads in full at every session
start, and 6,900 lines of superseded session logs were consuming the
context window before any work began. **When a fact below stops being
true, fix it here; do not append a new handoff on top.**

## THE MEASUREMENT RULES, each earned by a wrong published number

**MATCHED EXPOSURE OR THE NUMBER IS MEANINGLESS.** The clear bar sits far
above the label boundary -- `GENDER_CLEAR_SCORE` 0.45 male means **raw >=
0.725** -- so a label flip between 0.50 and 0.725 changes NOTHING that
ships. And any arm wins an accuracy column by leaning female, which is a
threshold move in disguise. **Tune each arm's own bar to a COMMON
EXPOSURE and read false cover.** Findings 29, 40, 41, 45, 47 and 50 each
turned on this, and the last one was caught the same day it was written.
Print AUC beside the table: a bar solver can move a matched-exposure
cell, nothing can move AUC.

**AN INSTRUMENT THAT RE-DERIVES A SHIPPED RULE IS A CHECK THAT CANNOT
FAIL** -- phase-g caught three of them in one session, each written after
the rule forbidding it. The remedy worked all three times: move the rule
into a module, call it from BOTH sides, delete the copy. `person-gate`,
`crop-geometry`, `host-scale` and `bench/head-train.mjs` all exist for
this reason.

**PIN THE CADENCE.** ~30 benches build options by hand; passing no
`fixedCadence` tells the tracker the 500ms BANK interval and derives a
1250ms coast where his phone is told 2000 and coasts 4000. Four published
tables were measured that way and THREE REVERSED. Pass `hisRegimeOpts(g)`
and `thinFrames(w, K_HIS)`. `arch-arms.CONTROL` is the single source of
the control triple and `test/control-triple.test.mjs` runs the shipped
arm over the corpus to assert it.

**A NUMBER WHOSE SHAPE LOOKS FAMILIAR IS A CLAIM ABOUT THE INSTRUMENT.**
`face-recall.mjs` printed 31%, which is 1/3, the thinning ratio.

**COUNT PEOPLE, NOT ROWS.** His corpus is 2,159 reads but only 51
clusters over ten videos, so a leave-one-video-out fit sees ~46 distinct
identities. Finding 51's arm looked like a result about labels and was a
result about n.

**A BENCH THAT REPORTS A BOUND MUST NAME THE ROWS BEHIND IT.** Finding
48's "open these frames" section is what caught its own 388-vs-5 error.

**BREAK AN ASSERTION TO PROVE A NEW TEST CAN FAIL.** This repo has
shipped a check that could not fail more than once, including a `#[test]`-
less function in lib.rs holding ten dead assertions.

**VERIFY A CONSTANT IN THE EMITTED BUNDLE, NEVER THE SOURCE**, and verify
it is READ rather than merely emitted. `app/src-tauri/gaze-page.js`. A
constant once shipped dead as `var IY;` for six rounds.

**RESTART THE EMULATOR BEFORE BELIEVING A FAILURE OR A TIMING NUMBER.**
The stale-emulator trap has invented a regression five times.

## PROTECTION DECISIONS ARE HIS, ALWAYS

Anything that trades exposure -- a bar, a floor, a coast, grey, a
resolution -- is his call, not a judgement call. Report the trade with
both columns and wait.

**Blur patches are SOLID** (he said it twice): never punch holes,
windows, cut-outs or sharp regions into a patch, and never split one
around somebody. `subtractBox` and the R24 mask hole were both shipped
and both rejected. *"Blur the subject so well that its shape is not
visible"*, qualified as *"slight shape visible is fine, it just shouldn't
be super tight"*. A silhouette-tight mask is the wrong direction too.
The cost is accepted and must not be re-litigated: a cleared person
inside someone else's patch gets covered. Fix that upstream -- better
association, refusing a merge, tighter observation geometry -- never by
cutting a window in the blur.

**REFUSED ON PRINCIPLE, do not re-open:**
- **Per-race calibration.** Inferring skin tone to correct the model is
  biometric categorisation on a sensitive characteristic -- the same
  clause (AI Hub Model License 2.c) that killed the Qualcomm NPU delegate
  in loop 47. TFLite's own NNAPI delegate is the legal route.
- **Reading HaramBlur's code.** AGPL-3.0; vendoring relicenses the app
  and ends App Store distribution. Running it and scoring its output is
  fine.
- **Patching YouTube's bytecode** (the ReVanced approach). Hard rule, and
  it is what got ProTube removed.

## THE MACHINES

- **His phone: 23122PCD1I** (Redmi 13, SM4450 / Adreno 613, Android 16).
  Not on a cable here. Reaches builds through the in-app updater. Its
  reports arrive via Settings -> About -> Share.
- **Old Redmi `1ec2c48e0621`** (M2010J19SI, Helio G85, Mali): the arm64
  smoke device, on adb, CDP over `adb forward`. It lies LANDSCAPE -- lock
  rotation and read `innerWidth` before believing any rect.
- **x86_64 emulator**: fallback. Relaunch with `-no-snapshot-load` when a
  restart does not come back.
- Use `$ANDROID_HOME/platform-tools/adb.exe` (37.0.0). The `adb` on PATH
  is a stray 28.0.3 with no `mdns`.
- **C: is nearly full.** Everything bulky goes on Z:. torch/transformers
  live in a venv at `Z:/ml`; the HF cache is there too. `pip` ignores
  POSIX `TMPDIR` on Windows -- set `TEMP`.

## THE RELEASE RECIPE

1. Bump `app/src-tauri/gen/android/app/tauri.properties` versionCode (+1)
   and versionName, and `appupdate.rs` `CURRENT_VERSION_CODE` to match.
   tauri.properties is GITIGNORED/autogen -- the lockstep that is
   tracked lives in `tauri.conf.json` version + `appupdate.rs`.
2. `node app/gaze/build/build.js` FIRST -- `tauri android build` does NOT
   rebuild the gaze bundle, and an APK built without it silently carries
   the previous bundle. Check `window.__TS_GAZE_BUNDLE__`.
3. `npx tauri android build --debug --target aarch64`.
4. STRIP before packaging: `llvm-strip --strip-unneeded` the .so (NDK
   27.1) into `jniLibs/arm64-v8a`.
5. `gradlew :app:clean :app:assembleArm64Debug -x :app:rustBuildArm64Debug`.
   **gradlew exits 0 on that task failing -- check the APK mtime, never
   the exit code.** Check APK size against the entry sum: incremental
   packaging has shipped an orphaned duplicate .so.
6. `gh release create app-vX.Y.Z <apk> --repo tamescroll/tamescroll`.
   The asset is named after the FILE -- do not upload from a temp path.
7. `node scripts/gen-app-manifest.mjs <apk> <releaseDownloadURL> "<notes>"`,
   commit and push `updates/app-manifest.json`.
8. **Verify: re-download the served APK and hash it against the raw
   manifest, and check `isDraft` is false.** A failed `gh release create`
   can leave a draft that `gh release view` reports happily while the
   download URL 404s.

The manifest URL is hardcoded in `appupdate.rs` AND `MainActivity.kt` --
keep them in lockstep.

**`assets/models/*.tflite` are GITIGNORED** (33MB). Regenerate with
`spikes/native/convert.py` before an Android build on a fresh clone, or
the engine reports `native-failed` and everything silently runs on the
worker.

**A constant changed in source and not in `rules/tuning.json` silently
REVERTS on every device the moment the OTA lands.** `test/tuning.test.mjs`
is the only thing standing between here and that; it refuses a tunable
missing from its SHIPPED map. `tune-overlay.test.mjs` likewise refuses a
dial with no plain-language label in his gear panel.

**CODE MAY NEVER TRAVEL OVER OTA** -- it runs inside YouTube's page. JSON
is handed over JSON-ESCAPED as a STRING and parsed page-side, never as an
object literal (a `${` reaching an injected template was remotely lethal
once).

**Rules OTA:** rerun `scripts/gen-rules-manifest.mjs` and commit after ANY
`rules/` edit or shipped apps never see it. **The OTA cache in app-data
SHADOWS local `rules/` edits, so a rules change cannot be verified
locally -- only after pushing.**

## RECURRING GOTCHAS

- **The Bash heredoc breaks on long bench bodies.** Use the Write tool.
- Repo files are CRLF; a python patch must normalise before matching, and
  a python text-mode read turns CRLF into LF.
- `execFileSync` cannot spawn a `.cmd` on Windows without a shell (use
  esbuild's JS API).
- Two GPU bench jobs at once need different `--port`.
- **Re-read a bank after a re-run** -- scoring a still-running job
  silently reports the previous run's numbers.
- FairFace `sample.json` and `full.json` are GROUPED BY RACE, so a head-N
  slice is one race. `run.mjs` interleaves.
- The descriptor is `face.desc` (NOT `descriptor`); nm is
  `face.shape.norm` (NOT `face.nm`) -- `face-decode.mjs:237`.
- Person objects are FLAT `{x1,y1,x2,y2,confidence}` (person-gate.mjs:1004),
  not `{box:{...}}`.
- `movenet-multipose.json`'s weightsManifest names `weights.bin`, which
  the app never reads (it loads through `embeddedIoHandler`). A plain URL
  load does read it, and the 404 body decodes as a 3-value tensor -- which
  looks exactly like a corrupt model.
- A probe that CDP-navigates straight to m.youtube never calls
  `open_platform`, so the sheet is built from DEFAULTS and his toggles are
  not what you are measuring. Drive the launcher first.
- `elementsFromPoint` CANNOT see a `pointer-events: none` element, and
  every patch we draw is one. Set `pointerEvents = 'auto'` first or the
  probe is blind -- this retracted three "verified" claims.
- A `display:none` overlay is still in the DOM with a 0x0 rect; a patch
  count with no display check overstates coverage, which is the dangerous
  direction.
- After a compaction, `git diff` the files a summary calls "edited"
  before trusting them -- a pre-compaction edit was once lost and the
  build shipped the old code.

## HIS OPEN RULINGS, all exposure trades, none pushed

**NEW THIS SESSION, and 1104 must ship before either can travel:**

- **The thumbnail null guard (finding 53), ALREADY IN 1104.** junk marks
  -66%, real marks -13.7%, and **16 thumbnails of 370 (4.3%) go from
  covered to completely uncovered.** `GENDER_IMAGE_NM_FLOOR` 0 reverts it
  over OTA without touching the video path.
- **The sub-40px floor (finding 54).** 1.3% of video patches, compute
  free, instrument thin. Not built.

**STANDING:** `NULL_MINT_NM_FLOOR` 5 -> 5.5 (OTA) or 6 (build) ·
mirror-averaging (compute, marginal -- 7 women for 1.4-1.6x of the gender
inference) · `GENDER_IMAGE_MIN_SCORE` 0.40 -> 0.35 · decision boundary
0.50 -> 0.65 · `PTRACK_MIN_COAST_PASSES` 2 -> 1.33 · `DELAY_MS` 1500 -> 0
(the boxes-on-top technique, already shippable via gear -> Blur delay ->
0) · 720p · the child gate by policy.
