// tamescroll gaze Stage B runtime. Injected on every platform page in
// every launcher mode (see app/src-tauri/src/lib.rs gaze_script()); what
// actually runs per mode is pipeline-plan.mjs — smart is the full
// face/gender pipeline, off and blur-all run only the compulsory NSFW
// removal tier. Never breaks the page: every fallible step is wrapped so
// a failure disables gaze and leaves the site working.
//
// Blur-first, always: every <img>/<video> gets .ts-gaze-pending the
// instant we know it's real content-sized media, before any inference —
// nothing may ever flash unblurred. Detection only ever *removes* blur
// once it has positively cleared something; it never races ahead of it.
//
// Architecture: docs/gaze-research.md §5/§6 (clean-room reproduction of
// HaramBlur's *behaviour* — MutationObserver dispatch, frame-skip video
// sampling — never its AGPL-3.0 source; see NOTICE / VISION.md).
import * as dom from './dom.js';
import { shouldRetry } from './image-retry.mjs';
import { wantPersons, notePersons, resetPersonSkip, forcePersonLook, personsLive } from './person-skip.mjs';
import { createNativeClient, NATIVE_INFER } from './native-client.mjs';
import * as cadence from './cadence.mjs';
import * as detector from './detector.js';
import {
  flaggedFaceIndices,
  countRefusedByNullGuard,
  faceMeta,
  isNullRead,
  hasDescriptorSignal,
  FACE_MIN_NATIVE_PX,
  GENDER_MIN_SCORE,
  GENDER_CLEAR_SCORE,
  GENDER_CLEAR_SCORE_FEMALE,
  GENDER_CHILD_MASS,
  NULL_MINT_NM_FLOOR,
} from './gender-verdict.mjs';
import { markShape, markRing } from './face-marks.mjs';
import {
  createIdentityMemory,
  askIdentity,
  trustNeeded,
} from './identity-memory.mjs';
import { clampBodies, BODY_CLAMP_PAD } from './body-clamp.mjs';
import {
  personCropRegion,
  headCropRegion,
  personFromFace,
  boundBodyToSlot,
  lastSlotDiag,
  faceInsideIndex,
  faceOrderBySize,
} from './person-gate.mjs';

// CROP-BUDGET PRIORITY. `confidence` is NOT one scale: a MoveNet person
// carries the model's slot score and a personFromFace body carries
// BlazeFace's face confidence. Measured on the R18 classroom, same run:
// skeletal persons score 0.057-0.321 while synthetic bodies score
// 0.35-0.93, so sorting the two together puts EVERY face-derived body
// above EVERY real person, every pass. That was latent while `all.length`
// stayed at or below ZOOM_MAX_PERSONS and everybody got a read anyway; the
// weak tier pushes it to 5-6 and the sort starts deciding who is starved.
//
// Who it starves is the problem. A face-derived body already HAS its face
// (R16 gave it faceBox, so it no longer re-detects), whereas a skeletal
// person's read is the only way they can ever accumulate the consecutive
// same-gender reads a clear requires. The adult woman teaching this class
// is a skeletal person at 0.18-0.32 and she is FALSE COVER on 10 of 10
// frames with cs:0 on every track — outranked by construction.
//
// So: compare within a population, not across. Skeletal persons first,
// then synthetic bodies, each ordered by their own confidence. This is
// not a claim that a skeleton beats a face as evidence — it is a refusal
// to pretend two different measurements are one number.
function cropPriority(a, b) {
  var aSyn = a && a.fromFace ? 1 : 0;
  var bSyn = b && b.fromFace ? 1 : 0;
  if (aSyn !== bSyn) return aSyn - bSyn;
  return (b.confidence || 0) - (a.confidence || 0);
}

import {
  updatePersonTracks,
  wipeIfEmpty,
  setVerdictCadence,
  blurredCoastBudgetMs,
  blurredTracks,
  presentTracks,
  mergePresented,
  clearedFaceBox,
  demoteTracks,
  cosineSim,
  bumpLife,
  iou,
  PTRACK_IOU_MIN,
  trackNeedsRead,
  setUserGender,
} from './person-track.mjs';
import * as sceneGate from './scene-gate.mjs';
import { fitBox } from './crop-geometry.mjs';
import {
  supportsRegionBlur,
  initRegionBlur,
  applyRegionBlur,
  clearRegionBlur,
  clearAllRegionBlur,
  expandToBody,
  padBox,
  imagePriority,
} from './region-blur.mjs';
import * as videoRegion from './video-region.mjs';
import { createTextMatcher } from './text-signals.mjs';
import { buildReport, reportViolations, platformOf, pageKind, imgDiagRead } from './diag-report.mjs';
import { watchUrlForShorts, watchUrlForShortsHref } from './shorts-redirect.mjs';
import { planForMode, rotateBudget } from './pipeline-plan.mjs';
import { createWorkerClient } from './worker-client.mjs';
import { startWorker } from './worker-entry.js';
import { installMiniplayer } from './miniplayer.mjs';
import { makeVerdictCache, verdictKey } from './verdict-cache.mjs';
import * as imageBudget from './image-budget.mjs';
import { applyTuningFromWindow, TUNED, TUNE_REFUSED, TUNE_CLAMPED, tunableNames, currentValue } from './tuning.mjs';
import { applyOverrides, overrideBlock, setToken as setOverrideToken } from './tuning-override.mjs';
import * as autoTest from './auto-test.mjs';
import { installTuneUi } from './tune-overlay.mjs';
import * as delayCore from './delay-core.mjs';
import { playerBlurWanted, isPhoneUa, playerSwitchShown } from './player-switch.mjs';
import { attachDelay } from './delay-presenter.mjs';
import { attachDelayGl, PRESENTER_GL } from './gl-presenter.mjs';
import * as perf from './perf.mjs';
import { needsGenderWait, wantsGenderPreload, mustRejudgeWithNsfw } from './gender-wait.mjs';
import * as codecProbe from './codec-probe.mjs';
import { makeTimeline, resetTimeline, pushSnapshot, pushCut, boxesAt, latestSnapshot } from './track-timeline.mjs';

// ONE ARTIFACT, TWO ROLES.
//
// This bundle is evaluated into the page AND served (by the Rust request
// interceptor, on the page's own origin) as the inference worker's
// script. Building two bundles meant two copies of tfjs and four copies
// of every model -- 17MB of APK for bytes that were identical. In a
// worker there is no document, and none of the page pipeline below can
// or should run.
// __TS_GAZE_MODELS_ONLY: a WORKER pulled this artifact in for its model
// bytes (model-blobs-lazy fallback). Starting a second message handler
// there would answer every request twice.
if (
  typeof importScripts === 'function' &&
  typeof document === 'undefined' &&
  !self.__TS_GAZE_MODELS_ONLY
) {
  startWorker();
} else
(function () {
  // THE PAGE KIND, ON <html>, FOR THE RULES TO SCOPE ON (2026-09-05).
  // m.youtube uses the same ytm-rich-grid-renderer on the home feed AND
  // on Subscriptions, and the home-feed rule hid both: with the shipped
  // defaults the Subscriptions tab was a blank page. CSS cannot see the
  // URL, so this writes `data-ts-page` from pageKind() at start and on
  // every navigation, and rules/youtube.txt scopes the grid rule on it.
  // Fails CLOSED: until the attribute lands the rule still hides.
  try {
    var tsPagePlatform = platformOf(location.hostname);
    var tsPageLast = null;
    // A SHORT IS A VIDEO: /shorts/<id> becomes /watch?v=<id> before the
    // swipe feed can draw (see shorts-redirect.mjs). The click hook
    // catches the in-page route; the tick catches everything else.
    var shortsToWatch = function () {
      if (tsPagePlatform !== 'youtube') return false;
      var w = watchUrlForShorts(location.pathname, location.search);
      if (!w) return false;
      location.replace(w);
      return true;
    };
    if (tsPagePlatform === 'youtube') {
      document.addEventListener('click', function (ev) {
        var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
        if (!a) return;
        var w = watchUrlForShortsHref(a.getAttribute('href'), location.origin);
        if (!w) return;
        ev.preventDefault();
        ev.stopPropagation();
        location.assign(w);
      }, true);
    }
    var syncTsPage = function () {
      if (shortsToWatch()) return;
      var k = pageKind(tsPagePlatform, location.pathname);
      if (k === tsPageLast) return;
      tsPageLast = k;
      document.documentElement.setAttribute('data-ts-page', k);
    };
    syncTsPage();
    window.addEventListener('popstate', syncTsPage);
    setInterval(syncTsPage, 500);
  } catch (e) { /* a missing attribute only keeps the feed hidden */ }
  // Distinctive, minification-proof marker (property assignment with a
  // string literal — esbuild won't rename it) so the Rust side can prove
  // this exact bundle is what got injected. See lib.rs gaze tests.
  window.__TS_GAZE_BUNDLE__ = 'v7'; // v7: crowd path (faces past MoveNet's 6) + no cut blackout
  // What the dials read before any local override -- see the boot block.
  var shippedTuning = null;

  // OTA TUNING, FIRST, BEFORE ANY VERDICT CAN BE MADE.
  // The numbers ride the rules OTA so a threshold change costs a git
  // push instead of a 56MB install -- four of those landed on the owner
  // in one night. tuning.mjs whitelists the keys and CLAMPS every value
  // to a range declared in code, and refuses everything else, so the
  // worst a bad push can do is move a dial to an edge that file already
  // considered safe. It cannot throw.
  try {
    // THE CLAIM COMES BEFORE THE FIRST DIAL IS APPLIED. applyTuningFromWindow
    // runs every SPEC setter, and the perf setters call the phone bridge
    // even at value 0 (setSustainedPerf(0) -> call('sustained')), which
    // takes the one-shot door for perf.mjs alone -- measured on the Redmi
    // on 1100: no shared_prefs file ever appeared, the override store had
    // no token, and a "+" did not survive a reload. So the door is opened
    // here, once, and the same token handed to both modules before any
    // setter can ask for it.
    var perfTok = null;
    try {
      var takeTok = window.__TS_TAKE_PERF_TOKEN;
      perfTok = typeof takeTok === 'function' ? takeTok() : null;
    } catch (e) { perfTok = null; }
    perf.provideToken(perfTok);
    setOverrideToken(perfTok);
    applyTuningFromWindow(window);
    // THREE WRITERS, ONE WHITELIST, IN A FIXED ORDER.
    //
    //   1. the OTA push        every phone, decided here
    //   2. his own overrides   this phone, decided in the panel
    //   3. the auto-test arm   this reload only, thrown away at the end
    //
    // Each later layer wins for the KEYS IT NAMES and for no others, so
    // a protection fix pushed over the air still lands on a phone with a
    // couple of speed dials set by hand. All three go through the same
    // SPEC clamp; none of them can throw a boot.
    //
    // `shippedTuning` is snapshotted BETWEEN 1 and 2, because nothing
    // downstream can reconstruct it -- it is what "Reset to shipped" in
    // the panel puts the dials back to.
    shippedTuning = {};
    var tnames = tunableNames();
    for (var ti = 0; ti < tnames.length; ti++) shippedTuning[tnames[ti]] = currentValue(tnames[ti]);
    // O1 (phase-o): claim the one-shot door ONCE, here, and hand the SAME
    // token to both perf.mjs and the override store. Before this, each
    // module lazily self-claimed __TS_TAKE_PERF_TOKEN the first time IT
    // needed the phone -- a page that touched a perf dial before the
    // panel could leave the override store's own claim racing an already-
    // spent door. Centralizing the claim here means there is exactly one
    // caller of __TS_TAKE_PERF_TOKEN in the whole bundle.
    applyOverrides(window);
  } catch (e) {}

  // O7 (phase-o): applyPendingArm used to share the tuning try above with
  // codecProbe.install and the ids.tuning report block below it -- a
  // malformed auto-test run state (a non-integer arm index reaching this
  // far) threw out of applyPendingArm and silently took both of those
  // with it: the codec probe never installed, and the report never
  // carried which OTA numbers this phone actually applied. A diagnostic
  // must not be able to take a page mutation with it, and neither may
  // take the other's report block, so each gets its own try now.
  try {
    autoTest.applyPendingArm(window);
  } catch (e) {}

  try {
    // Which codec the player is fed (research 2026-09-03 #1): wrap the
    // MediaSource entry points before the player opens a buffer. Read-only.
    // After all three tuning layers, because CODEC_PROBE is one of them.
    if (codecProbe.CODEC_PROBE === 1) codecProbe.install(window);
  } catch (e) {}

  try {
    // WHICH NUMBERS IS HIS PHONE ACTUALLY RUNNING?
    //
    // Nothing recorded it. The channel exists so a threshold can move
    // without an install, and the artifact he sends back could not say
    // whether a pushed number reached his device, was CLAMPED to a range
    // edge, or was refused -- so a tuned phone and an untuned one
    // produced identical reports and every ring read since the channel
    // shipped has been unattributable. Three numbers, all of them
    // numeric or null, so the report's shape check passes them.
    var ids = window.__TS_GAZE_IDS || (window.__TS_GAZE_IDS = {});
    ids.tuning = { applied: TUNED, refused: TUNE_REFUSED, clamped: TUNE_CLAMPED };
  } catch (e) {}

  // Drag-to-miniplayer (owner ask, twice). Installed BEFORE the mode
  // gate and before the bench hook: it is a player behaviour, not a
  // gaze one, and it has to work in off mode too. Its own re-entry
  // guard makes the Started+Finished double eval a no-op.
  try {
    installMiniplayer(window);
  } catch (e) {}
  // Closes the eval clock the build opens as the artifact's first
  // statement — see build/build.js. The delta is what evaluating 22.7MB
  // of bundle costs on THIS device, per page load.
  try {
    if (typeof window.__TS_GAZE_EVAL0 === 'number') {
      window.__TS_GAZE_EVALMS = Math.round(performance.now() - window.__TS_GAZE_EVAL0);
      // WHEN, not just how long. The worker cannot start before this
      // script runs, and measured 2026-08-29 that is ~420ms into a
      // navigation -- which is most of the wait before the first
      // thumbnail resolves. readyState says which page-load event
      // delivered us, and therefore whether an earlier delivery exists.
      window.__TS_GAZE_EVALAT = Math.round(window.__TS_GAZE_EVAL0);
      window.__TS_GAZE_READY0 = document.readyState;
    }
  } catch (e) {}

  // EFFECTIVE VALUES OF THE GATING CONSTANTS, published once at boot.
  // R15 found FACE_MIN_NATIVE_PX emitted by the minifier as `var IY;` with
  // no initializer, so the size gate compared against `undefined` and had
  // never fired in any shipped bundle — invisible for six rounds because
  // nothing in the artifact said what the thresholds actually WERE, only
  // what the source claimed. A constant that goes dead now shows up as
  // `null` in the next round's meta.json. Wrapped because a probe must
  // never be able to throw inside the pipeline.
  try {
    var dbgC = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
    dbgC.cfg = {
      faceMinPx: FACE_MIN_NATIVE_PX,
      faceMinConf: detector.FACE_MIN_CONFIDENCE,
      // THE BARS A PLAYER PATCH IS ACTUALLY DECIDED AT (ledger K11).
      // The native-vs-worker parity gate was written over
      // GENDER_MIN_SCORE and GENDER_IMAGE_MIN_SCORE -- the FLAG bars --
      // and passed, while 2 of 24 reads flipped at `clearBarFor` and
      // the child gate, which are what decide whether a covered person
      // is REVEALED. A parity probe cannot re-derive these (that is the
      // G1/G5/G9 failure: an instrument that re-implements a shipped
      // rule is a check that cannot fail), so it reads them from the
      // running bundle here, the same way R15's faceMinPx is read.
      genderMinScore: GENDER_MIN_SCORE,
      clearScore: GENDER_CLEAR_SCORE,
      clearScoreFemale: GENDER_CLEAR_SCORE_FEMALE,
      childMass: GENDER_CHILD_MASS,
      nmFloor: NULL_MINT_NM_FLOOR,
    };
  } catch (e) {}

  // Compulsory tier (handoff decision #1): the pipeline boots in every
  // launcher mode so NSFW media can be removed outright; what else runs
  // is the plan's call (pipeline-plan.mjs, unit-tested policy).
  // Bench hook (spikes/perf-harness/bench.html): expose the raw
  // detector fns and touch NOTHING else. The flag is only ever set by
  // our local bench page — never by injected boot scripts.
  if (window.__TS_BENCH__) {
    window.__TS_BENCH_API = {
      setBackend: detector.forceBackend,
      loadFace: detector.loadModel,
      loadNsfw: detector.loadNsfwModel,
      loadGender: detector.loadGenderModel,
      detect: detector.detectFaceBoxes,
      nsfw: detector.isNsfw,
      genders: detector.classifyFaceGenders,
      // R25: the person pass too. The round measured a woman standing at
      // the frame edge whose MoveNet slot carried maxKp 0.03-0.12 while
      // the person beside her scored 0.50, and the first question that
      // asks is whether the SQUASH in personPixelSource (a 16:9 frame
      // drawn into a 256x256 square, i.e. 1.78x horizontal compression)
      // is what costs her the evidence. That cannot be answered without
      // running the same model on the same frame two ways.
      loadPerson: detector.loadPersonModel,
      persons: detector.detectPersons,
      tf: detector.tfHandle,
      loadUrl: detector.loadModelUrl,
    };
    return;
  }

  var plan = planForMode(window.__TS_GAZE_MODE);

  // LEAVE A NOTE FOR THE NEXT NAVIGATION.
  //
  // The worker cannot be prestarted at document_start without knowing
  // the mode, and at document_start nothing of ours has run yet: the
  // mode arrives with this script, ~250-425ms in (measured 2026-08-29).
  // One key on the platform's own origin carries it forward, so the NEXT
  // page load starts loading models before the page has parsed its own
  // scripts. A stale hint costs nothing either way: too-smart prestarts
  // a worker nobody adopts (it terminates itself), not-yet-smart just
  // behaves exactly as it did before this existed.
  try {
    var hint = window.__TS_GAZE_MODE === 'smart' ? 'smart' : 'no';
    if (sessionStorage.getItem('tsGazeMode') !== hint) {
      sessionStorage.setItem('tsGazeMode', hint);
    }
  } catch (e) {
    /* storage refused (private mode, partitioning): no prestart, no harm */
  }

  if (!plan.boot) return;

  // Declared user gender (protection engine): set by the Rust boot
  // script from launcher state. "man"/"woman" filters the opposite
  // gender; anything else means undeclared — any face stays covered.
  var userGender =
    window.__TS_GAZE_GENDER === 'man' || window.__TS_GAZE_GENDER === 'woman'
      ? window.__TS_GAZE_GENDER
      : 'unset';

  // person-track needs it too: GENDER_TRACK_MEAN re-derives a verdict
  // from a track's mean sigmoid, and that ladder lives in
  // gender-verdict.mjs and is CALLED, never reimplemented -- so the
  // pure tracker module has to be able to name the declared gender.
  setUserGender(userGender);

  // 64 -> 120 2026-08-24 (owner: "why are all the logos blurred — the
  // LTT tab, my own channel avatar"): sub-120px images are UI chrome
  // (avatars, channel logos, badges), not content — HaramBlur exempts
  // the same class. Trade-off accepted: tiny thumbnails skip the NSFW
  // check too; content thumbnails on every supported platform measure
  // well above this.
  var IMAGE_MIN_SIZE = 120;
  // ...but "not content" turned out to include the thing he asked for
  // next. Owner, 2026-08-28: "profile pics do not get blurred". A
  // profile picture IS a photograph of a person, and the only thing that
  // separates it from a channel logo is whether there is a face in it --
  // which is the question this pipeline exists to answer. Size cannot
  // separate them and never could.
  //
  // So images from here up to IMAGE_MIN_SIZE are asked the FACE question
  // only: a logo has no face and clears, a person's photo is covered
  // under the same gender policy as any thumbnail. The suggestive
  // classifier is skipped for them (see noNsfw) -- it costs the same
  // 13ms at any source size and has nothing to say about a head shot.
  // Below this, an image is genuinely too small to read a face out of
  // and is left alone, which keeps badges and icons off the queue.
  var IMAGE_MIN_FACE_SIZE = 48;
  // Cushion on an avatar's face patch. The face box already arrives
  // enlarged 1.4x for the gender crop; this is the margin that covers
  // hair and chin on a picture where the head fills the frame.
  var AVATAR_PATCH_PAD = 0.22;
  // Images in [IMAGE_MIN_FACE_SIZE, IMAGE_MIN_SIZE) -- face pass only.
  var faceOnlyImgs = typeof WeakSet === 'function' ? new WeakSet() : null;
  // Judged verdicts, keyed on the exact url, for the life of THIS page.
  // The measurement that justifies it and the two properties that make
  // replaying a verdict safe are in verdict-cache.mjs.
  var verdictCache = makeVerdictCache();
  function imgKey(img) {
    try {
      return verdictKey(img.currentSrc || img.src || '', !!(faceOnlyImgs && faceOnlyImgs.has(img)));
    } catch (e) {
      return null;
    }
  }
  // Passive, so it can never delay the scroll it is observing. Bound to
  // the document because YouTube scrolls the window on desktop and an
  // inner container on mobile web -- capture catches both.
  var lastScrollAt = -1e9;
  try {
    document.addEventListener(
      'scroll',
      function () {
        lastScrollAt = performance.now();
        // What is near the viewport just changed, and the drain may have
        // stood down over a queue of far-away images. Cheap: drainImages
        // no-ops while one is already armed.
        if (typeof imageQueue !== 'undefined' && imageQueue.length) drainImages();
      },
      { passive: true, capture: true }
    );
  } catch (e) {}
  var SCROLL_QUIET_MS = 250;
  var SCROLL_INTERVAL_MS = 500;
  function scrolling(now) {
    return now - lastScrollAt < SCROLL_QUIET_MS;
  }

  // One real macrotask. scheduler.yield() is the purpose-built API and
  // returns to the event loop at user-visible priority where it exists.
  //
  // WHERE IT DOES NOT, setTimeout(0) IS NOT FREE: measured in this
  // WebView, a setTimeout(0) yield costs 4.92ms against 0.004ms for a
  // MessageChannel one -- the nested-timer clamp, not the work. The
  // image path yields twice per thumbnail, so on an engine without
  // scheduler.yield that is ~10ms of pure clamp per image. WebView2 has
  // the API and pays neither; Android's System WebView is the platform
  // this is for, and it is the one nothing here can measure.
  var yieldChannel = null;
  var yieldQueue = [];
  function channelYield() {
    if (!yieldChannel) {
      yieldChannel = new MessageChannel();
      yieldChannel.port1.onmessage = function () {
        var next = yieldQueue.shift();
        if (next) next();
      };
    }
    return new Promise(function (resolve) {
      yieldQueue.push(resolve);
      yieldChannel.port2.postMessage(0);
    });
  }
  function yieldToBrowser() {
    try {
      if (typeof scheduler !== 'undefined' && scheduler && typeof scheduler.yield === 'function') {
        return scheduler.yield();
      }
      if (typeof MessageChannel === 'function') return channelYield();
    } catch (e) {}
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  var SPEND_WINDOW_MS = 1000;
  var spends = [];
  function noteSpend(at, ms) {
    spends.push(at, ms);
    if (spends.length > 80) spends.splice(0, spends.length - 80);
  }
  function overBudget(now, frac) {
    var total = 0;
    for (var i = 0; i < spends.length; i += 2) {
      if (now - spends[i] <= SPEND_WINDOW_MS) total += spends[i + 1];
    }
    return total > SPEND_WINDOW_MS * (frac > 0 ? frac : imageBudget.IMG_BUDGET_SPEND);
  }

  // THE BUDGET WAS SIZED FOR THE WRONG MOMENT (owner 2026-08-27, phone
  // screenshot of a search page with the second thumbnail still covered:
  // "still taking long to load why should that be the case because it's
  // only single thumbnails").
  //
  // Measured under a 6x throttle: ONE thumbnail costs 304ms p50 (35ms to
  // load the CORS clone, 204ms BlazeFace + gender, the rest nsfwjs). At
  // a flat 25% of a 1s window that is under one image per second, so six
  // visible thumbnails take the several seconds he is looking at. The
  // cost per image is real work on three models; the pacing is ours.
  //
  // But 25% was chosen to fix jank WHILE SCROLLING, and the drain
  // already refuses to run at all during a scroll. So the cap that
  // matters is the one applied when the page is STILL -- and a still
  // page has nothing to be janky about: no scroll to keep smooth, no
  // layout, usually no video. Spending most of the thread there is
  // invisible, and it is exactly when he is waiting.
  //
  // The player keeps the tight cap unconditionally: its own budget gate
  // passes no fraction, and the raised one is refused whenever a player
  // pass has run recently, because the pool is shared and the comments
  // starvation this budget fixed was the player's inference queued
  // ahead of YouTube's own callbacks.
  // A SCROLL USED TO STOP THE QUEUE DEAD (owner 2026-08-27, on the phone:
  // "it processes some, then it halts, then it takes time to process the
  // next ... the speed is still much less compared to the speed that
  // someone scrolls").
  //
  // Measured at 6x throttle on a search page, flicking every 700ms: 0.39
  // images/s while scrolling against 1.43 still. A person scrolls past
  // several thumbnails a second, so the queue fell permanently behind him
  // and every halt he describes is this gate. Refusing to run at all was
  // justified by "blur-first means waiting only delays a reveal" -- true,
  // but the reveal IS what he is waiting for, and a delayed one is the
  // thing he is reporting.
  //
  // So the scroll now caps the drain instead of stopping it: one image at
  // a time, at a fraction small enough that the work cannot own the
  // thread the scroll needs. The still-page budget is untouched.
  var SCROLL_BATCH_MAX = 1;
  var IDLE_QUIET_MS = 1000;
  var lastPlayerPassAt = -1e9;
  var PLAYER_ACTIVE_MS = 2000;
  function imageBudgetFrac(now) {
    // Probe override (spikes/gauntlet/probe_scrollfeel.py). Choosing
    // these fractions is a trade between throughput and scroll
    // smoothness, and it cannot be chosen without measuring both against
    // each other -- which needs a rebuild per value unless the value can
    // be set from outside. Clamped, and a number or nothing: the worst a
    // page could do with it is spend a little more of its own thread.
    var over = window.__TS_IMG_BUDGET;
    if (typeof over === 'number' && over > 0) return over > 0.8 ? 0.8 : over;
    if (now - lastPlayerPassAt < PLAYER_ACTIVE_MS) return imageBudget.IMG_BUDGET_SPEND;
    if (scrolling(now)) return imageBudget.IMG_BUDGET_SCROLL;
    if (now - lastScrollAt < IDLE_QUIET_MS) return imageBudget.IMG_BUDGET_SPEND;
    return imageBudget.IMG_BUDGET_IDLE;
  }

  var IMAGE_BATCH_MAX = 4;
  // How many images may be in flight at once: imageBudget.IMAGE_LANES (OTA);
  // __TS_IMG_LANES overrides it for A/B.
  // How far below the fold an image can be and still be worth spending
  // the thread on: two viewports, i.e. roughly what a flick brings up
  // next. imagePriority returns 0 for anything on screen, the distance
  // below the fold, and a large constant for anything already passed --
  // so this defers the passed ones too.
  var FAR_PRIORITY_PX = 2000;
  // How many queued images are SORTED by distance. Bounded so the
  // ordering pass cannot itself become the jank it prevents.
  var PRIORITY_SCAN_MAX = 64;
  // How many get a distance KEY. Much larger than the sort window,
  // because an unkeyed image silently bypasses the far-defer check
  // below -- `typeof pri === 'number'` is false, so it is batched no
  // matter how far off screen it is. MEASURED 2026-08-31 on m.youtube
  // home: the queue grows linearly with the scroll and reached 85 after
  // 19,500px (search reached 65 after 13,600px), so the tail past 64 is
  // a normal session, not a pathological one -- 21 images bypassing the
  // check at that point, and more the further he goes. Keying is a rect
  // read, which is one layout flush for the whole loop; a wasted
  // inference is ~174ms on his phone. The read is the cheap side.
  var PRIORITY_KEY_MAX = 512;
  var VIDEO_SAMPLE_INTERVAL_MS = 500; // caps inference at ~2/s per feed video
  // Player detection cadence (redesign 2026-08-24, blur-pipeline-audit,
  // + owner "not instantaneous — HaramBlur is snappier"): the person
  // POSITION pass is cheap (~30ms warm desktop) and floors at 120ms
  // (~8Hz) — the adaptive throttle (1.5x measured pass cost, capped 1s)
  // is what protects slow devices, not a high floor. The EXPENSIVE
  // part — per-person crop + gender — runs at most every
  // ZOOM_INTERVAL_MS; in between, passes update positions only, so
  // verdict cadence and position cadence are decoupled (no beat
  // frequency, no per-frame verdict flips).
  var VIDEO_PLAYER_SAMPLE_INTERVAL_MS = 120;
  var ZOOM_INTERVAL_MS = 400;
  var VIDEO_CLEAN_STREAK_TO_UNBLUR = 4;

  var failed = false;
  var model = null;
  var nsfwModel = null;
  var genderModel = null;
  // Person/pose model (MoveNet MultiPose, person-gate.mjs). Loads LAST
  // — it only ever refines: gates ambiguous face candidates and covers
  // backside persons. null = no gating, no backside coverage (fail-safe
  // in the "never drop extra blur" direction).
  var personModel = null;
  // Declared HERE, not next to ensurePersonModel: boot() scans the
  // document -- and so can call attachVideo -- before execution ever
  // reaches the bottom of this file, and a `var` initialiser down there
  // would then reset a flag that had already been set.
  var personWanted = false;
  var personLoading = null;
  // Guards the face-model load so it runs exactly once whether it is the
  // post-load-idle deferral OR a played player video that kicks it early
  // (see ensureFaceModels).
  var faceModelsKicked = false;
  // True once the NSFW model load has SETTLED (loaded or failed). The
  // smart-mode drain must wait for it: images drained into the
  // !nsfwModel branch were revealed WITHOUT the compulsory NSFW check
  // and nothing ever re-checked them (review 2026-08-23 #2).
  var nsfwSettled = false;
  // True once the gender model load has SETTLED (loaded or failed).
  // Owner phone bug 2026-08-22: gender loaded last and nothing
  // re-verdicts, so every image drained before it arrived was flagged
  // presence-only — both genders blurred on any slow device. The drain
  // now waits for settlement instead; on failure this still flips true
  // and the presence-only degradation applies to everything equally.
  var genderSettled = false;
  // THE INFERENCE WORKER (2026-08-27). Images are classified off the
  // main thread where the platform lets us have one -- see
  // worker-client.mjs and synthetic_resource in lib.rs. `null` means we
  // never got one and everything below runs exactly as it did before.
  var gazeWorker = null;
  // Images whose faces are waiting for the worker's gender model.
  var genderHeld = [];
  // Images whose last answer skipped NSFW where the page's own bars clear
  // every face: they are asked again with the classifier.
  var nsfwRequired = new WeakSet();
  function holdForGender(img, res) {
    if (!needsGenderWait(res)) return false;
    if (genderHeld.indexOf(img) === -1) genderHeld.push(img);
    // The model can land while this image was in flight; its 'loaded'
    // has then already been handled, so judge it again now.
    if (gazeWorker && gazeWorker.genderLoaded()) releaseGenderHeld();
    return true;
  }
  function releaseGenderHeld() {
    var held = genderHeld;
    genderHeld = [];
    for (var i = 0; i < held.length; i++) {
      if (imageQueue.indexOf(held[i]) === -1) imageQueue.push(held[i]);
    }
    if (held.length) drainImages();
  }
  // Women or Men mode on YouTube: ask for the gender model as soon as the
  // worker is up, not when the first face is found (gender-wait.mjs).
  // The hold above still covers any face judged before it lands.
  function preloadGender() {
    try {
      if (!gazeWorker || !gazeWorker.ready()) return;
      if (!wantsGenderPreload(window.__TS_GAZE_MODE, userGender, platformOf(location.hostname))) return;
      gazeWorker.askGender();
    } catch (e) {
      /* the first face still asks for it */
    }
  }
  function workerAlive() {
    return !!gazeWorker && gazeWorker.ready();
  }
  // THE PLAYER'S INFERENCE MOVES TOO (2026-08-28), under conditions.
  //
  // The image path proved the shape: everything the models do belongs
  // off the thread that draws the page. The player is the bigger half of
  // that cost -- MoveNet plus a face crop and a gender read per person,
  // four times a second, on a watch page that is simultaneously loading
  // comments and a related rail. It is also the half with a red line
  // through it, so it moves only when all three of these hold, and it
  // comes straight back the moment one of them stops:
  //   * the worker is alive (same test the image path uses);
  //   * its tfjs backend is WEBGL -- a worker that fell back to CPU is
  //     slower than the main thread it was meant to relieve, and the
  //     player cannot absorb that;
  //   * MoveNet loaded there. It is loaded on demand, because a feed
  //     page has no video and it is the most expensive model we ship.
  // Anything else -- no worker, a rejected request, a timeout -- and the
  // video runs the in-page pipeline exactly as it always has.
  var workerVideoBanned = false;
  var anyVideoAttached = false;
  // How long a playing video waits for a worker that is up but has not
  // reported its models yet, before this page loads its own set.
  var WORKER_VIDEO_GRACE_MS = 3000;
  // NATIVE INFERENCE (plan 2026-09-02-native-inference). Android hands the
  // page a MessagePort to a TFLite engine (NativeInfer.kt); the
  // document-start stash in lib.rs parks it on window.__TS_NATIVE_PORT and
  // announces it. When that client is ready and NATIVE_INFER > 0, every
  // player-path model call goes through it instead of the WebGL worker --
  // same result shapes, so the policy above the accessor does not know.
  // One-way on failure: a client that dies (3 consecutive failures) stays
  // dead for the page and vid() falls back to the worker.
  var nativeClient = null;
  var nativeDeadCounted = false;
  function nativeLife(key) {
    try {
      var d = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
      d.life = d.life || {};
      if (d.life.nativeReady === undefined) {
        d.life.nativeReady = 0;
        d.life.nativeFailed = 0;
        d.life.nativeDead = 0;
        d.life.nativePasses = 0;
      }
      d.life[key] = (d.life[key] || 0) + 1;
    } catch (e) {}
  }
  function nativeMark(k, v) {
    try {
      var t = (window.__TS_GAZE_NATIVE = window.__TS_GAZE_NATIVE || {});
      t[k] = v;
    } catch (e) {}
  }
  function nativeVideo() {
    try {
      if (!nativeClient) return false;
      if (nativeClient.dead()) {
        if (!nativeDeadCounted) {
          nativeDeadCounted = true;
          nativeLife('nativeDead');
          nativeMark('dead', Math.round(performance.now()));
        }
        return false;
      }
      return NATIVE_INFER > 0 && nativeClient.genderReady();
    } catch (e) {
      return false;
    }
  }
  // The engine the player path talks to. Read ONCE per crop chain and
  // once per budget window (phase-j J7/J8): a cid belongs to the client
  // that minted it, and waitMs() is per client.
  function vid() {
    return nativeVideo() ? nativeClient : gazeWorker;
  }
  function adoptNativePort() {
    // The document-start stash (lib.rs native_port_stash_script) keeps
    // Kotlin's port in its own closure and hands it out ONCE through a
    // non-configurable taker (phase-j J6): a page script can neither
    // pre-define nor replace that property, and a port it hands us
    // through any other route is not read at all.
    var port = null;
    try {
      var take = window.__TS_TAKE_NATIVE_PORT;
      port = typeof take === 'function' ? take() || null : null;
    } catch (e) {
      port = null;
    }
    if (!port) return;
    if (nativeClient && nativeClient.port === port) return;
    if (nativeClient) {
      // Kotlin re-bound (a second onPageStarted on this document): the
      // old port is closed on its side, so the old client would only die.
      try {
        nativeClient.terminate();
      } catch (e) {}
      nativeClient = null;
      nativeDeadCounted = false;
    }
    try {
      nativeClient = createNativeClient(port, {
        onReply: function (ok) {
          nativeLife(ok ? 'nativeReplies' : 'nativeErrors');
        },
      });
      nativeClient.port = port;
    } catch (e) {
      nativeClient = null;
      nativeLife('nativeFailed');
      nativeMark('why', String((e && e.message) || e).slice(0, 90));
      return;
    }
    nativeMark('adopted', Math.round(performance.now()));
    nativeClient.ready.then(
      function (r) {
        nativeLife('nativeReady');
        nativeMark('ready', Math.round(performance.now()));
        nativeMark('backend', (r && r.backend) || '?');
        if (r && typeof r.initMs === 'number') nativeMark('initMs', r.initMs);
      },
      function (e) {
        nativeLife('nativeFailed');
        nativeMark('why', String((e && e.message) || e).slice(0, 90));
      }
    );
  }
  function watchNativePort() {
    adoptNativePort();
    try {
      window.addEventListener('ts-native-port', adoptNativePort);
    } catch (e) {}
    exposeEnginesForParity();
  }
  // Task 3 (device parity): a probe needs BOTH engines on the same frame.
  // Flag-gated like __TS_GATE_AUDIT -- nothing in the app sets
  // __TS_NATIVE_PARITY, a test pins that, and without it no engine handle
  // is reachable from the page world.
  function exposeEnginesForParity() {
    try {
      if (!window.__TS_NATIVE_PARITY) return;
      window.__TS_GAZE_ENGINES = {
        native: function () {
          return nativeClient;
        },
        worker: function () {
          return gazeWorker;
        },
      };
    } catch (e) {}
  }
  function workerVideo() {
    if (nativeVideo()) return true;
    if (workerVideoBanned) return false;
    try {
      return !!(
        gazeWorker &&
        gazeWorker.ready() &&
        gazeWorker.backend() === 'webgl' &&
        !gazeWorker.personFailed()
      );
    } catch (e) {
      return false;
    }
  }
  // One-way: once the player path has fallen back it stays fallen back
  // for the life of the page. A path that flapped between two engines
  // mid-video would produce exactly the inconsistency the tracker reads
  // as a person appearing and disappearing.
  function banWorkerVideo(why) {
    if (workerVideoBanned) return;
    workerVideoBanned = true;
    try {
      var t = (window.__TS_GAZE_WORKER = window.__TS_GAZE_WORKER || {});
      t.videoBanned = String((why && why.message) || why || '?').slice(0, 90);
    } catch (e) {
      /* a marker must never break the fallback it is describing */
    }
    ensureFaceModels();
    if (anyVideoAttached) ensurePersonModel();
  }
  // Enough of the chain to hand out a verdict, wherever it lives. The
  // in-page test is unchanged; the worker's is its own staged readiness
  // (face + gender), which is the same pair `genderSettled` gates on.
  function videoModelsReady() {
    if (workerVideo()) return vid().genderReady();
    return !!model && genderSettled;
  }
  // Is a gender read available at all? The crop path skips work it
  // cannot use when it is not.
  function genderAvailable() {
    return workerVideo() ? vid().genderReady() : !!genderModel;
  }
  // Everything that ever wore pending/flagged, for the fail-open sweep.
  // WeakRefs + a per-element tracked flag: virtualised feeds detach
  // thousands of media nodes per long scroll, and strong refs here would
  // pin every one of them for the life of the page (review 2026-08-19).
  var hasWeakRef = typeof WeakRef === 'function';
  var blurredEls = [];

  function track(el) {
    if (el.__tsGazeTracked) return;
    el.__tsGazeTracked = true;
    blurredEls.push(hasWeakRef ? new WeakRef(el) : el);
  }

  function trackedEl(entry) {
    return hasWeakRef && entry instanceof WeakRef ? entry.deref() : entry;
  }

  function markPending(el) {
    el.classList.add(dom.PENDING_CLASS);
    track(el);
  }

  function markFlagged(el) {
    el.classList.remove(dom.PENDING_CLASS);
    el.classList.add(dom.FLAGGED_CLASS);
    track(el);
  }

  function clearEl(el) {
    el.classList.remove(dom.PENDING_CLASS, dom.FLAGGED_CLASS);
    if (regionBlur) clearRegionBlur(el);
  }

  // Compulsory tier: the element leaves the page. The whole feed item
  // goes when we know its container (no blurred hole in the layout);
  // deliberately NOT tracked in blurredEls — a removal survives the
  // fail-open sweep, because "pipeline died" must never mean "the one
  // thing we positively identified comes back".
  function markRemoved(el) {
    el.classList.remove(dom.PENDING_CLASS, dom.FLAGGED_CLASS);
    if (regionBlur) clearRegionBlur(el);
    var item = textItemSelector && el.closest ? el.closest(textItemSelector) : null;
    (item || el).classList.add(dom.REMOVED_CLASS);
  }

  function failOpen(reason, err) {
    if (failed) return;
    failed = true;
    try {
      observer.disconnect();
    } catch (e) {
      /* best-effort */
    }
    for (var i = 0; i < blurredEls.length; i++) {
      var el = trackedEl(blurredEls[i]);
      if (el) clearEl(el);
    }
    blurredEls.length = 0;
    if (regionBlur) clearAllRegionBlur();
    videoRegion.clearAll();
    // eslint-disable-next-line no-console
    console.warn('tamescroll gaze: disabled after ' + reason, err);
  }

  dom.injectStyle();

  // Face-region blur (owner ask 2026-08-19): flagged-by-gender images
  // blur just the face rects, rest stays visible. Whole-element blur
  // remains the fallback (no backdrop-filter, videos, NSFW flags) and
  // the snap-back state whenever the viewport moves.
  var regionBlur = supportsRegionBlur();
  if (regionBlur) initRegionBlur(dom.FLAGGED_CLASS);

  // Text signals (handoff decision #5): the cheap pre-filter that runs
  // BEFORE any model. Seed list is embedded; user terms arrive from the
  // Rust boot script. A matcher construction failure must never take
  // the visual pipeline down — text signal simply switches off.
  var textMatcher = null;
  try {
    textMatcher = createTextMatcher(window.__TS_USER_TERMS);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('tamescroll gaze: text matcher unavailable', e);
  }

  // Per-host feed-item containers, live-DOM-verified only (project rule:
  // selectors are read from the live DOM, never guessed). The whole
  // item's textContent is the haystack — title + channel + captions in
  // one read, no per-field selectors to drift.
  //   ytd-video-renderer          www.youtube search results (verified
  //                               live 2026-08-19; thumbnails carry NO
  //                               alt/aria-label — alt="true").
  //   ytm-video-with-context-renderer  m.youtube feed/related items
  //                               (live-verified 2026-08-19 session).
  // Other platforms join as their containers get live-verified.
  //   shreddit-post               www.reddit.com feed posts (verified
  //                               live 2026-08-19: thumbnails sit in
  //                               its LIGHT DOM so closest() reaches
  //                               it; title lands in the first ~60
  //                               chars of textContent).
  var TEXT_ITEMS = [
    { suffix: 'youtube.com', item: 'ytd-video-renderer, ytm-video-with-context-renderer' },
    { suffix: 'reddit.com', item: 'shreddit-post' },
  ];

  var textItemSelector = (function () {
    var host = (location.hostname || '').replace(/^www\./, '');
    for (var i = 0; i < TEXT_ITEMS.length; i++) {
      var c = TEXT_ITEMS[i];
      if (host === c.suffix || host.slice(-c.suffix.length - 1) === '.' + c.suffix) {
        return c.item;
      }
    }
    return null;
  })();

  // Text for a media element: generic attributes (alt/aria-label, nearest
  // labelled link) plus, where a verified container exists, the whole
  // feed item's text. Capped — matching cost is linear in haystack size.
  function mediaText(el) {
    var parts = [];
    if (el.alt && el.alt.length > 4) parts.push(el.alt);
    var own = el.getAttribute && el.getAttribute('aria-label');
    if (own) parts.push(own);
    if (el.closest) {
      var link = el.closest('a[aria-label], a[title]');
      if (link) parts.push(link.getAttribute('aria-label') || link.getAttribute('title'));
      if (textItemSelector) {
        var item = el.closest(textItemSelector);
        if (item) parts.push((item.textContent || '').slice(0, 500));
      }
    }
    return parts.join(' ');
  }

  // ---- image pipeline -----------------------------------------------
  var imageSeen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  var imageQueue = [];
  // How many times an image has come back from the pipeline as a failure
  // rather than a verdict. Weak so a recycled feed cannot leak entries.
  var imageTries = typeof WeakMap === 'function' ? new WeakMap() : null;

  function attempts(img) {
    if (!imageTries) return 0;
    return imageTries.get(img) || 0;
  }

  // Put a failed image back at the end of the queue, at most
  // IMAGE_MAX_TRIES times. It is still covered while it waits, so a
  // retry can only ever move it from "covered forever" to "judged".
  function requeueAfterFailure(img) {
    if (!imageTries || !img) return false;
    var n = attempts(img) + 1;
    imageTries.set(img, n);
    if (
      !shouldRetry(n, {
        connected: img.isConnected !== false,
        queued: imageQueue.indexOf(img) !== -1,
      })
    ) {
      return false;
    }
    imageQueue.push(img);
    // Behind whatever is already waiting, and never in the same tick:
    // the reason it failed is usually that the worker is busy.
    setTimeout(drainImages, RETRY_DELAY_MS);
    return true;
  }

  var RETRY_DELAY_MS = 1200;

  // THE BOOT TIMELINE, one number per milestone.
  //
  // "Still taking long to load" has been answered three times with a
  // faster model and never with a measurement of where the wait actually
  // is. Model readiness is now ~790ms after a navigation while the first
  // thumbnail resolves at ~2.1s, so most of the wait is NOT inference.
  // Each mark is written once; a probe reads them together.
  function bootMark(name) {
    try {
      var t = (window.__TS_GAZE_BOOT = window.__TS_GAZE_BOOT || {});
      if (t[name] === undefined) t[name] = Math.round(performance.now());
    } catch (e) {
      /* a marker must never break the pipeline */
    }
  }

  var imageDraining = false;

  // AN UNBOUNDED IDLE WAIT IS NOT A DEFERRAL, IT IS A HANG (owner
  // 2026-08-27, phone: "still taking long to load ... it's only single
  // thumbnails").
  //
  // Measured on a search page under a 6x throttle: the bundle evaluates
  // in 75ms and the four model loads cost 61 + 364 + 608 + 852ms -- but
  // the FIRST of them did not start until 28.4s into the page. Nothing
  // was slow; nothing had been scheduled. requestIdleCallback with no
  // timeout waits for an idle period, and a YouTube feed under load on a
  // slow device does not have one for half a minute. Every thumbnail
  // stays covered for that whole window, which is exactly what he is
  // looking at.
  //
  // A timeout makes the callback fire anyway once the deadline passes,
  // with didTimeout set, which is the behaviour the deferral always
  // meant: yield if there is a chance to, but do not wait forever.
  var IDLE_TIMEOUT_MS = 1200;
  var idle =
    typeof requestIdleCallback === 'function'
      ? function (cb) {
          return requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS });
        }
      : function (cb) {
          setTimeout(function () {
            cb({ timeRemaining: function () { return 8; }, didTimeout: true });
          }, 200);
        };

  // Shared face verdict for a pixel source: boxes -> per-face gender ->
  // per-face flags (owner report 2026-08-24: all-or-nothing flagging
  // blurred a confident same-gender face because ANOTHER face in the
  // thumbnail failed the bar — now only the failing faces' boxes come
  // back). Without the gender model (still loading, or failed) every
  // face covers — the old presence behavior, which is also the fail-safe.
  function faceCheck(el, sharedImg) {
    // A YIELD BETWEEN THE TWO MODELS. Measured on a search page under a
    // 6x throttle: the worst single main-thread task was 1,724ms, and it
    // is ONE image -- BlazeFace and the gender classifier run back to
    // back with only a microtask between them, so the browser cannot
    // paint or scroll across either. Yielding between them halves the
    // worst case for free: the two are already sequential, nothing about
    // the verdict changes, and a thumbnail waiting a frame longer is
    // still blurred the whole time (blur-first).
    return detector.detectFaceBoxes(model, el, sharedImg).then(function (faces) {
      if (!faces.length) return { verdict: 'clear', flagBoxes: [], reads: [], faces: [] };
      if (!genderModel) return { verdict: 'flag', flagBoxes: faces, reads: [], faces: faces };
      return yieldToBrowser().then(function () {
      return detector
        .classifyFaceGenders(genderModel, el, faces, sharedImg, { square: true })
        .then(function (genders) {
        var idx = flaggedFaceIndices(userGender, genders);
        var flagBoxes = [];
        for (var i = 0; i < idx.length; i++) flagBoxes.push(faces[idx[i]]);
        return {
          verdict: idx.length ? 'flag' : 'clear',
          flagBoxes: flagBoxes,
          reads: genders,
          faces: faces,
        };
      });
      });
    });
  }

  // WHY WAS THIS THUMBNAIL COVERED? (owner 2026-08-27: "sometimes these
  // thumbnail blurs blur the male character as well")
  //
  // The image path had no diagnostics at all, so every explanation for a
  // wrongly-covered man was a guess: a low gender score, the child gate
  // firing on a small face, a text-signal hit on the title, or a
  // neighbour's body box swallowing him. Those need different fixes, so
  // the ring records which one actually fired. Bounded and fully
  // guarded — instrumentation has thrown inside this pipeline before and
  // cost two releases.
  // Every image the pipeline has finished, not just the last 120 the
  // ring keeps. The report's denominator.
  var imgTotal = 0;

  function noteImgDiag(entry) {
    try {
      imgTotal++;
      // The ring is capped at 120, so its LENGTH cannot count throughput
      // -- a scroll probe reading it saw 0 images processed while the
      // pipeline was working normally. This is the honest total.
      window.__TS_GAZE_IMGTOTAL = imgTotal;
      var ring = (window.__TS_GAZE_IMGDIAG = window.__TS_GAZE_IMGDIAG || []);
      ring.push(entry);
      if (ring.length > 120) ring.splice(0, ring.length - 120);
    } catch (e) {
      /* never let a probe break a verdict */
    }
  }

  // ONE PLACE THAT TURNS A VERDICT INTO PIXELS, because there are now
  // two paths that produce one (in page and in the worker) and a second
  // copy of this is how they would drift.
  //
  // Only the FAILING faces' person-regions get patches (cleared faces in
  // the same image stay sharp — owner 2026-08-24); the whole-blur class
  // stays on until the first successful patch placement, so blur-first
  // holds throughout.
  // The corner radius the page already gives this element, so the patch
  // is the same shape as what it covers. Read once per flagged avatar.
  function elementRadius(el) {
    try {
      var r = getComputedStyle(el).borderRadius;
      return r && r !== '0px' ? r : null;
    } catch (e) {
      return null;
    }
  }

  function applyVerdictToImage(img, result) {
    if (result.nsfw) {
      // Compulsory tier: removed outright, every mode, no setting.
      markRemoved(img);
    } else if (result.face) {
      markFlagged(img);
      if (regionBlur && result.flagBoxes.length) {
        // AN AVATAR HAS NO BODY IN FRAME. expandToBody reaches 1.2
        // head-widths sideways, a full head above and SIX head-heights
        // below -- anthropometrics for a thumbnail where the body is
        // actually there. On a 68px profile picture every one of those
        // runs off the edge and clamps, so the patch becomes the whole
        // square over a round picture: the owner's "profile picture
        // blur is spreaded all over, and it isn't confined to the
        // profile picture area" (2026-08-29). Below the thumbnail floor
        // the face IS the subject -- pad it and take the element's own
        // corner radius so a round avatar gets a round patch.
        var avatar = !!(faceOnlyImgs && faceOnlyImgs.has(img));
        var bodies = [];
        for (var rb = 0; rb < result.flagBoxes.length; rb++) {
          bodies.push(
            avatar
              ? padBox(result.flagBoxes[rb], AVATAR_PATCH_PAD)
              : expandToBody(result.flagBoxes[rb])
          );
        }
        applyRegionBlur(img, bodies, avatar ? { radius: elementRadius(img) } : null);
      }
    } else if (plan.revealClears) {
      clearEl(img);
    }
  }

  function detectImage(img) {
    // Text pre-filter: a hit keeps the element covered without spending
    // any inference on it. Whole-element blur (no face boxes to narrow
    // to — the signal is about the item, not a region).
    if (plan.textFilter && textMatcher) {
      try {
        if (textMatcher.test(mediaText(img))) {
          markFlagged(img);
          noteImgDiag({ why: 'text', faces: 0, reads: [] });
          return Promise.resolve();
        }
      } catch (e) {
        /* matcher error: fall through to the visual pipeline */
      }
    }
    // ALREADY JUDGED, SAME PIXELS. A repeated url skips the bitmap and
    // the whole inference; the verdict it replays was measured on this
    // exact image earlier on this page.
    var ckey = imgKey(img);
    if (ckey) {
      var cached = verdictCache.get(ckey);
      if (cached) {
        noteImgDiag({
          t: Math.round(performance.now()),
          ms: 0,
          where: 'cache',
          w: img.naturalWidth,
          why: cached.nsfw ? 'nsfw' : cached.face ? 'face' : 'clear',
          faces: cached.reads ? cached.reads.length : 0,
          flagged: cached.flagBoxes ? cached.flagBoxes.length : 0,
          reads: [],
        });
        applyVerdictToImage(img, cached);
        return Promise.resolve();
      }
    }
    var tImg0 = performance.now();
    var tLoad = 0;
    var tFace = 0;
    // ONE UPLOAD PER THUMBNAIL. BlazeFace, the gender head and the NSFW
    // classifier each ran their own fromPixels of the SAME element --
    // three texture uploads of every thumbnail, two of them pure
    // duplication. Same reasoning as the video path (detector.uploadFrame):
    // the target is a Helio G88 where bus bandwidth, not shader
    // throughput, is what the owner feels. `frame` is owned HERE and
    // disposed on both exits; a null upload falls back to the old
    // per-detector uploads, so a tainted or undrawable source behaves
    // exactly as before.
    var frame = null;
    var bitmap = null;
    function releaseFrame() {
      if (frame) {
        detector.disposeFrame(frame);
        frame = null;
      }
      // A pixel source that owns memory until it is closed (an
      // ImageBitmap) must be released here; nothing else will.
      if (bitmap) {
        try {
          bitmap.close();
        } catch (e) {
          /* a closed or foreign bitmap must never break a verdict */
        }
        bitmap = null;
      }
    }
    // OFF-THREAD PATH. The main thread's whole job here becomes: make an
    // ImageBitmap, hand it over (transferred, not copied), apply the
    // answer. The verdict rules stay HERE -- flaggedFaceIndices and the
    // thresholds are owner-tuned policy with tests, and a second copy
    // inside the worker is how the two would drift.
    if (workerAlive()) {
      // OUR THREAD'S SHARE, MEASURED IN SEGMENTS.
      //
      // Charging "elapsed minus the worker's inference ms" was already
      // better than charging the wall clock, but it still bills this
      // thread for time an image spends QUEUED behind another one --
      // two lanes are in flight, so the second image's wait looked like
      // work here (max 1,077ms on an image whose own inference was
      // 512ms). The budget exists to protect the scroll, and a queue in
      // another thread does not touch the scroll. So time the two
      // segments that genuinely run here: preparing the bitmap, and
      // applying the verdict.
      var mainMs = 0;
      var tPrep0 = performance.now();
      return dom
        .loadDetectable(img)
        .then(function (el) {
          tLoad = performance.now() - tImg0;
          if (el && typeof el.close === 'function' && el !== img) bitmap = el;
          return createImageBitmap(el);
        })
        .then(function (bmp) {
          releaseFrame();
          mainMs += performance.now() - tPrep0;
          return gazeWorker.classifyImage(bmp, {
            noNsfw: !!(faceOnlyImgs && faceOnlyImgs.has(img)),
            skipNsfwFor: nsfwRequired.has(img) ? null : userGender,
          });
        })
        .then(function (res) {
          if (failed) return;
          // Faces but no gender model yet: nothing is applied or cached,
          // so the image stays covered exactly as it is now, and it is
          // judged again once 'loaded:gender' arrives.
          if (holdForGender(img, res)) {
            noteImgDiag({ t: Math.round(performance.now()), where: 'worker', why: 'gender-wait' });
            return { mainMs: mainMs };
          }
          var faces = res.boxes || [];
          var reads = res.reads || [];
          var flagBoxes = [];
          if (faces.length) {
            if (!reads.length) {
              // No gender model in the worker: presence-only, the same
              // fail-safe the in-page path uses.
              flagBoxes = faces;
            } else {
              var idx = flaggedFaceIndices(userGender, reads);
              for (var i = 0; i < idx.length; i++) flagBoxes.push(faces[idx[i]]);
            }
          }
          // The worker skipped NSFW on a face it read as covered, and the
          // bars here disagree: nothing is applied, and it is judged again
          // with the classifier.
          if (mustRejudgeWithNsfw(res, flagBoxes)) {
            nsfwRequired.add(img);
            if (imageQueue.indexOf(img) === -1) imageQueue.push(img);
            noteImgDiag({ t: Math.round(performance.now()), where: 'worker', why: 'nsfw-rejudge' });
            drainImages();
            return { mainMs: mainMs };
          }
          var result = {
            face: flagBoxes.length > 0,
            flagBoxes: flagBoxes,
            nsfw: !flagBoxes.length && !!res.nsfw,
            reads: reads,
          };
          noteImgDiag({
            t: Math.round(performance.now()),
            ms: Math.round(performance.now() - tImg0),
            load: Math.round(tLoad),
            face: res.ms,
            // What this image cost THIS thread, timed rather than
            // derived: the bitmap and the verdict. Queue time in the
            // worker is deliberately NOT in here.
            main: Math.round(mainMs),
            w: img.naturalWidth,
            where: 'worker',
            src: (img.currentSrc || img.src || '').slice(0, 90),
            why: result.nsfw ? 'nsfw' : result.face ? 'face' : 'clear',
            faces: reads.length,
            flagged: flagBoxes.length,
            // How many of those faces the null guard refused a mark. It
            // is the ONLY number that says whether 1104's fix fires at
            // all on his phone, and `faces` minus `flagged` cannot say
            // it -- a same-gender clear subtracts there too.
            nr: countRefusedByNullGuard(reads),
            // 1 when the worker skipped NSFW because a face keeps it covered.
            ns: res.nsfwSkipped ? 1 : 0,
            reads: reads.map(function (r, ri) {
              return imgDiagRead(r, res.boxes && res.boxes[ri], img.naturalWidth);
            }),
          });
          var tApply0 = performance.now();
          verdictCache.set(ckey || imgKey(img), result);
          applyVerdictToImage(img, result);
          mainMs += performance.now() - tApply0;
          return { mainMs: mainMs };
        })
        .catch(function (e) {
          releaseFrame();
          // The worker refused or died mid-flight. Fail CLOSED for this
          // image (it stays blurred, as it already is) and let the
          // client's own death handling decide whether the in-page
          // pipeline takes over from here.
          noteImgDiag({
            t: Math.round(performance.now()),
            why: 'error',
            where: 'worker',
            msg: String((e && e.message) || e).slice(0, 80),
            try: attempts(img),
          });
          // A TIMEOUT IS NOT A VERDICT.
          //
          // MEASURED on a real Android WebView 2026-08-30: the first two
          // images of a navigation came back `worker timeout` at 20.6s,
          // and the third -- the same avatar, judged normally -- landed
          // at 23.8s. The worker was not broken, it was still compiling
          // the shaders for shapes a blank warm-up frame never produces,
          // and the 15s request timeout fired underneath it.
          //
          // Failing closed is right; failing closed FOREVER is not.
          // Nothing ever put that image back on the queue, so it stayed
          // covered for the life of the page and looked identical to one
          // still waiting -- which is the owner's oldest report,
          // "processes some, then it halts". Bounded so a genuinely
          // unjudgeable image (CORS refused, decode failure) still
          // settles into staying covered instead of looping.
          requeueAfterFailure(img);
        });
    }
    return dom
      .loadDetectable(img)
      .then(function (el) {
        tLoad = performance.now() - tImg0;
        if (el && typeof el.close === 'function' && el !== img) bitmap = el;
        frame = detector.uploadFrame(el);
        // Faces first (cheaper, most common hit) — smart mode only.
        // NSFW runs when the faces cleared: a gender-cleared image can
        // still be suggestive, and the compulsory tier owns that call.
        // A face-FLAGGED image skips NSFW — it stays covered by blur
        // either way, and the spared inference keeps the batch moving
        // (revisit when strictness modes map face flags to reveal).
        // NSFW model missing degrades to face-only, never breaks page.
        if (!plan.faceGender) {
          if (!nsfwModel) return { face: false, flagBoxes: [], nsfw: false };
          return detector.isNsfw(nsfwModel, el, frame).then(function (nsfw) {
            return { face: false, flagBoxes: [], nsfw: nsfw };
          });
        }
        // NSFW IS STARTED ALONGSIDE THE FACE PASS, NOT AFTER IT.
        //
        // The two read the same frame and neither needs the other's
        // answer, but they ran end to end, so every face-clear image --
        // the large majority -- paid 13ms of nsfwjs strictly after
        // BlazeFace and faceres had finished. Started together, the
        // classifier's GPU readback overlaps the face pass's work
        // instead of queueing behind it.
        //
        // The only thing this spends that the old order did not is one
        // nsfw pass on a face-FLAGGED image, whose answer is then
        // discarded (measured: 2 of 25 images on a search page). The
        // verdict is unchanged either way -- flagged stays flagged.
        var nsfwP = nsfwModel && !(faceOnlyImgs && faceOnlyImgs.has(img))
          ? detector.isNsfw(nsfwModel, el, frame).catch(function () {
              // A failed classifier must not fail the image: face-only
              // is the documented degrade.
              return false;
            })
          : null;
        return faceCheck(el, frame).then(function (face) {
          tFace = performance.now() - tImg0 - tLoad;
          if (face.verdict === 'flag' || !nsfwP) {
            return {
              face: face.verdict === 'flag',
              flagBoxes: face.flagBoxes,
              nsfw: false,
              reads: face.reads,
              faces: face.faces,
            };
          }
          return nsfwP.then(function (nsfw) {
            // NSFW flags are whole-image by nature — no face boxes.
            return { face: false, flagBoxes: [], nsfw: nsfw, reads: face.reads, faces: face.faces };
          });
        });
      })
      .then(function (result) {
        releaseFrame();
        if (failed) return;
        noteImgDiag({
          // Wall-clock stamp, so a probe can read the GAPS BETWEEN images
          // and not just the cost of each. The owner's report is about
          // the gaps ("it processes some, then it halts, then it takes
          // time to process the next"), and nothing recorded them.
          t: Math.round(performance.now()),
          ms: Math.round(performance.now() - tImg0),
          load: Math.round(tLoad),
          face: Math.round(tFace),
          w: img.naturalWidth,
          src: (img.currentSrc || img.src || '').slice(0, 90),
          why: result.nsfw ? 'nsfw' : result.face ? 'face' : 'clear',
          faces: result.reads ? result.reads.length : 0,
          flagged: result.flagBoxes ? result.flagBoxes.length : 0,
          nr: countRefusedByNullGuard(result.reads),
          reads: (result.reads || []).map(function (r, ri) {
            return imgDiagRead(r, result.faces && result.faces[ri], img.naturalWidth);
          }),
        });
        verdictCache.set(ckey || imgKey(img), result);
        applyVerdictToImage(img, result);
      })
      .catch(function (e) {
        releaseFrame();
        // Fail-closed for imagery: could not verify, stays blurred.
        // Counted, because a thumbnail that fails here stays covered for
        // the life of the page and looks identical to one still waiting
        // (owner 2026-08-27, phone: a thumbnail that never resolves).
        noteImgDiag({
          why: 'error',
          msg: String((e && e.message) || e).slice(0, 80),
          try: attempts(img),
        });
        // Same bound, same reason as the worker path above: a transient
        // failure must not mean covered for the life of the page.
        requeueAfterFailure(img);
        // eslint-disable-next-line no-console
        console.warn('tamescroll gaze: image check failed, staying blurred', e);
      });
  }

  // A FINISHED BATCH WENT TO THE BACK OF THE IDLE QUEUE (same owner
  // report as SCROLL_BUDGET_FRAC: "then it takes time to process the
  // next"). Every re-arm went through requestIdleCallback, so after four
  // images the queue waited for an idle slice that a busy YouTube feed
  // does not hand out -- up to the full IDLE_TIMEOUT_MS, measured as
  // 1,090ms at the 90th percentile between two images on a page that was
  // sitting still. Nothing about that wait protects anything: the spend
  // budget and the per-image yield are what keep the thread free, and
  // both still apply. A continuation goes straight to a macrotask.
  // Who is allowed to judge an image yet. The worker reports the same
  // staged readiness the in-page loads do (a FAILED model counts as
  // settled, exactly as it does in page), and while it is still loading
  // we wait rather than starting the in-page models -- starting them
  // would mean two copies of every model on a phone.
  function imagesReady() {
    if (gazeWorker && !gazeWorker.dead()) return gazeWorker.ready() && gazeWorker.settled();
    return plan.faceGender ? !!model && genderSettled && nsfwSettled : !!nsfwModel;
  }

  function drainImages(soon) {
    if (imageDraining) return;
    imageDraining = true;
    var arm = soon
      ? function (cb) {
          setTimeout(function () {
            cb({ didTimeout: true, timeRemaining: function () { return 0; } });
          }, 0);
        }
      : idle;
    arm(function (deadline) {
      // The flag is released when the BATCH finishes, not when the
      // callback starts (owner 2026-08-27: "it's processing multiple
      // together but ... it processes some, then it halts"). Releasing
      // it here let a second drain start while the first was still
      // running, so batches interleaved: every image took longer, and
      // they all landed together at the end instead of one at a time.
      // Every exit below releases it -- and so does the batch promise.
      var release = function () {
        imageDraining = false;
      };
      if (failed) {
        release();
        imageQueue.length = 0;
        return;
      }
      // Readiness depends on the plan: face modes wait on BlazeFace,
      // NSFW-only modes (off / blur-all) wait on the NSFW classifier.
      // Face modes wait for BlazeFace AND the gender AND NSFW loads to
      // settle — draining earlier hands out irreversible presence-only
      // flags (gender) or irreversible unchecked reveals (NSFW).
      // Hidden page: every GPU readback fence-wait is clamped to ~1s+
      // by Chrome's nested-timer throttling (found 2026-08-23), so a
      // hidden tab would grind through the queue at seconds per image
      // for nobody. Park the queue; the visibilitychange listener
      // below re-arms the drain the moment the page shows again.
      if (document.hidden) {
        release();
        return;
      }
      bootMark('firstDrain');
      if (!imagesReady()) {
        // Model still loading: back off instead of re-arming the idle
        // callback immediately — the immediate re-arm was a tight loop
        // eating every idle slice for the whole model-load window,
        // exactly the INSTANT-rule violation Stage B must never commit
        // (review 2026-08-19).
        release();
        if (imageQueue.length) setTimeout(drainImages, 250);
        return;
      }
      // THE SEARCH PAGE IS WORSE THAN THE PLAYER, AND NOBODY HAD LOOKED.
      // (owner 2026-08-27: "where the sluggishness shows out is when I
      // click the search button and the time it takes to load or show
      // the results")
      //
      // Measured under a 6x main-thread throttle, scrolling a results
      // page for 12s: 112 long tasks, 14,532ms of them, worst single
      // 1,416ms, over 60 result items. The thread is saturated -- worse
      // than the player path was before its budget landed, because this
      // drain had NONE of the three protections the player got. An idle
      // deadline decides how many images to DEQUEUE and then hands the
      // whole batch to Promise.all, which runs them as one unbroken
      // burst: on a G88 that is four faces plus four gender reads plus
      // four NSFW classifications with no gap anywhere in it.
      //
      // Same three levers, same reasoning as the player:
      //   - while the page is scrolling, do nothing at all. Unlike the
      //     player there is no exposure risk in waiting: blur-first
      //     means every unchecked thumbnail is ALREADY blurred, so
      //     deferring only delays a REVEAL.
      //   - share the rolling main-thread budget with the player.
      //   - run the batch serially with a real macrotask between images
      //     instead of one burst, so the worst task is one image rather
      //     than four.
      var nowMs = performance.now();
      if (overBudget(nowMs, imageBudgetFrac(nowMs))) {
        release();
        if (imageQueue.length) setTimeout(drainImages, SCROLL_QUIET_MS);
        return;
      }
      var batchMax = scrolling(nowMs) ? SCROLL_BATCH_MAX : IMAGE_BATCH_MAX;
      // LOOKAHEAD ORDERING. One layout read per drain (at most 4Hz, and
      // never while scrolling -- the gate above already returned), then
      // the queue runs nearest-to-the-viewport first: what is on screen,
      // then what is just below it, then what he has already passed.
      // The SORT is bounded so a page that has queued hundreds of images
      // cannot turn the ordering itself into the jank it exists to
      // prevent. The KEYS are not: an unkeyed image bypasses the
      // far-defer check below entirely, and "the tail is far off screen
      // by definition" -- what this comment used to claim -- is false.
      // The tail is in ARRIVAL order, so it holds whatever was tagged
      // most recently, near and far alike, and past 64 the far ones were
      // being judged unconditionally.
      var keys = null;
      if (imageQueue.length > 1) {
        try {
          var vh = window.innerHeight || 1;
          var scan = imageQueue.length > PRIORITY_SCAN_MAX ? PRIORITY_SCAN_MAX : imageQueue.length;
          var keyed = imageQueue.length > PRIORITY_KEY_MAX ? PRIORITY_KEY_MAX : imageQueue.length;
          keys = new WeakMap();
          for (var pi = 0; pi < keyed; pi++) {
            keys.set(imageQueue[pi], imagePriority(imageQueue[pi].getBoundingClientRect(), vh));
          }
          var head = imageQueue.slice(0, scan);
          head.sort(function (a, b) {
            return keys.get(a) - keys.get(b);
          });
          for (var pj = 0; pj < scan; pj++) imageQueue[pj] = head[pj];
        } catch (e) {
          /* non-fatal: fall back to arrival order */
          keys = null;
        }
      }
      // ORDERING WAS NOT ENOUGH: THE FAR ONES STILL SPEND HIS BUDGET.
      //
      // The queue ran nearest-first but still ran everything, so after a
      // few screens most of each batch was thumbnails he had already
      // scrolled past -- work that competes with the six on his screen
      // for the same 60%. Every image the queue skips here is one the
      // visible screen gets instead, and nothing is lost: an image far
      // off screen stays queued and stays blurred (blur-first), and the
      // next drain re-sorts, so it is picked up as he approaches it.
      //
      // A scroll is what changes the answer, so a scroll re-arms the
      // drain -- otherwise a queue of nothing-but-far images would sit
      // there with no one left to wake it.
      var batch = [];
      var skipped = 0;
      for (var qi = 0; qi < imageQueue.length; ) {
        if (batch.length >= batchMax || !(deadline.didTimeout || deadline.timeRemaining() > 0)) break;
        var cand = imageQueue[qi];
        if (cand && cand.isConnected === false) {
          // Gone from the document while it waited; nothing to reveal.
          imageQueue.splice(qi, 1);
          continue;
        }
        // Beyond PRIORITY_KEY_MAX there is still no key, and that
        // stays fail-open on the NEAR side: an unkeyed image is judged
        // rather than deferred, so nothing can be stranded covered.
        var pri = keys ? keys.get(cand) : 0;
        // Probe override, same reasoning as __TS_IMG_BUDGET: this
        // distance is a trade (visible thumbnails resolve sooner, far
        // ones later) and A/B-ing it must not need a rebuild per side.
        var farPx = typeof window.__TS_IMG_FAR === 'number' ? window.__TS_IMG_FAR : FAR_PRIORITY_PX;
        if (typeof pri === 'number' && pri > farPx) {
          skipped++;
          qi++;
          continue;
        }
        imageQueue.splice(qi, 1);
        batch.push(cand);
      }
      // TWO IMAGES IN FLIGHT, NOT ONE AND NOT FOUR.
      //
      // Strictly serial leaves the thread idle across every GPU readback
      // (three models per image, each ending in an await). Unbounded
      // overlap is what produced the 11-second image and the clump the
      // owner reported. Two lanes keep the thread busy through one
      // image's readbacks with the other's work, and cap how far behind
      // any single image can fall.
      if (batch.length) bootMark('firstBatch');
      var lanes = typeof window.__TS_IMG_LANES === 'number' ? window.__TS_IMG_LANES : imageBudget.IMAGE_LANES;
      if (lanes < 1) lanes = 1;
      var runners = [];
      for (var li = 0; li < lanes && li < batch.length; li++) {
        runners.push(
          (function (lane) {
            var seq = Promise.resolve();
            for (var bi = lane; bi < batch.length; bi += lanes) {
              seq = seq.then(
                (function (img, first) {
                  return function () {
                    return (first ? Promise.resolve() : yieldToBrowser()).then(function () {
                      var at = performance.now();
                      return Promise.resolve(detectImage(img)).then(function (r) {
                        // CHARGE THE MAIN THREAD FOR MAIN-THREAD TIME
                        // ONLY.
                        //
                        // This budget exists to stop our work owning the
                        // thread a scroll needs, and it was measured
                        // when every model ran ON that thread, where
                        // elapsed time and thread time were the same
                        // number. Since the player and images moved into
                        // the worker (2026-08-28) they are not: an image
                        // whose inference happens off-thread still
                        // charged its full wall clock, so at the 0.15
                        // scroll fraction ONE worker image (152ms
                        // measured at 6x) blew a 150ms budget and the
                        // drain slept 250ms -- over and over. That is
                        // the owner's "processes some, then it halts",
                        // now caused by the fix for it.
                        //
                        // The worker path reports the segments it
                        // actually ran here (bitmap + verdict); the
                        // in-page path reports nothing and is charged
                        // in full, which is correct there -- it really
                        // did spend all of it on this thread.
                        var elapsed = performance.now() - at;
                        var mine =
                          r && typeof r.mainMs === 'number' ? Math.min(r.mainMs, elapsed) : elapsed;
                        noteSpend(performance.now(), mine);
                        return r;
                      });
                    });
                  };
                })(batch[bi], bi === lane)
              );
            }
            return seq;
          })(li)
        );
      }
      var seq = Promise.all(runners);
      seq
        .catch(function () {
          /* detectImage fails closed on its own; the queue must not stop */
        })
        .then(function () {
          release();
          // Only continue for work that is actually eligible; if every
          // remaining image is far off screen, the next scroll wakes it.
          if (imageQueue.length > skipped) drainImages(true);
        });
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && imageQueue.length) drainImages();
  });

  // WE WERE DECODING EVERY THUMBNAIL TWICE (owner 2026-08-27, on the
  // phone: the queue cannot keep up with a scroll).
  //
  // Measured: 30 of 30 thumbnails on a search page were fetched twice.
  // The bytes came from cache -- but the DECODE did not, and that second
  // decode is 39ms of an 89ms image on this desktop, the largest single
  // stage, ahead of BlazeFace and the gender head together.
  //
  // The clone exists because a cross-origin <img> with no crossorigin
  // attribute taints anything it is uploaded into, whatever the server
  // sends back. The attribute is what decides that, and it is only
  // consulted when the image LOADS -- so setting it on an image that has
  // not loaded yet (every lazy thumbnail he is about to scroll into)
  // makes the page's own decode usable and deletes our second one.
  //
  // Two guards, because a broken thumbnail is worse than a slow one:
  // only hosts measured to send an ACAO header, and an error handler
  // that puts the image back exactly as it was and lets the clone path
  // handle it. An already-loaded image is left alone -- changing the
  // attribute there would restart a load that has already finished.
  var CORS_SAFE_HOST = /(^|\.)(ytimg\.com|ggpht\.com|redd\.it|redditmedia\.com|twimg\.com|cdninstagram\.com)$/;
  function preflightCors(img) {
    try {
      if (img.crossOrigin || img.complete) return;
      var src = img.currentSrc || img.src;
      if (!src) return;
      var host = new URL(src, location.href).hostname;
      if (!CORS_SAFE_HOST.test(host)) return;
      img.addEventListener(
        'error',
        function () {
          // CORS refused (or anything else): restore the plain load so
          // the user still sees his thumbnail.
          if (img.crossOrigin) {
            img.removeAttribute('crossorigin');
            img.src = src;
          }
        },
        { once: true }
      );
      img.crossOrigin = 'anonymous';
    } catch (e) {
      /* never let this optimisation break tagging */
    }
  }

  // THE ONE IMAGE WE ARE FORBIDDEN TO READ AND HAVE NO REASON TO JUDGE.
  //
  // m.youtube's top-left mark is not the ordinary inline-SVG logo: when
  // Google is running a promo it is an <img> served from
  // www.gstatic.com. MEASURED 2026-08-31 on the live mobile home page:
  // `IMG#home-icon.mobile-topbar-logo.ytmLogoEntityLogo`, 122x48
  // displayed at (-1,-1), natural 244x96, alt "Creators share their
  // morning routines", computed `filter: blur(24px)` -- permanently.
  // The host refuses CORS (fetch throws TypeError, a crossOrigin
  // 'anonymous' load fails outright, while ytimg.com reads fine), so
  // every attempt ends `cors-denied` and fail-closed keeps it covered
  // for the life of the page. Owner, 2026-08-31: "why is the top left
  // thing of YouTube blurred? It's annoying."
  //
  // NARROW ON PURPOSE. This is the logo element only -- it does NOT
  // touch `ytm-profile-icon`, the account avatar that sits in the same
  // bar and IS a photograph of a person, which stays judged. A site's
  // own wordmark carries nobody to protect, so declining to cover it
  // costs no exposure.
  var CHROME_IGNORE = 'img.mobile-topbar-logo';

  function isIgnoredChrome(img) {
    try {
      return !!(img && img.closest && img.matches && img.matches(CHROME_IGNORE));
    } catch (e) {
      return false;
    }
  }

  function tagImage(img) {
    if (failed || dom.hasPlayerAncestor(img)) return;
    if (isIgnoredChrome(img)) {
      clearEl(img);
      return;
    }
    if (imageSeen && imageSeen.has(img)) return;
    preflightCors(img);

    function check() {
      if (failed) return;
      if (imageSeen && imageSeen.has(img)) return;
      var side = Math.min(img.naturalWidth, img.naturalHeight);
      if (side >= IMAGE_MIN_FACE_SIZE) {
        if (imageSeen) imageSeen.add(img);
        if (side < IMAGE_MIN_SIZE && faceOnlyImgs) faceOnlyImgs.add(img);
        // blur-all: the Stage A sheet already blankets the image — no
        // pending class, the queue exists only for NSFW removal.
        if (plan.preBlur) markPending(img);
        bootMark('firstTag');
        imageQueue.push(img);
        drainImages();
      } else if (img.naturalWidth) {
        // AN IMAGE WE WILL NEVER CHECK MUST NOT STAY COVERED.
        //
        // Found 2026-08-27 while chasing "still taking long to load":
        // eight elements on a search page still carried the pending
        // class after everything had settled, and every one was a 24x24
        // channel avatar (68px natural). retagImage pre-blurs on any src
        // swap -- correct, blur-first, and at that moment the new image
        // has no dimensions to judge -- but tagImage then declines to
        // queue anything under IMAGE_MIN_SIZE. Nothing ever cleared them
        // again, so avatars sat blurred for the life of the page. They
        // are the brown blobs in the owner's phone screenshots.
        //
        // Blur-first is kept: the cover holds until the image has loaded
        // and we can see it is below the size we check at, which is the
        // moment the decision "we are not looking at this one" is
        // actually made. Since 2026-08-28 that floor is
        // IMAGE_MIN_FACE_SIZE, so what reaches here is badges and icons,
        // not profile pictures.
        clearEl(img);
      }
    }

    if (img.complete && img.naturalWidth) {
      check();
    } else {
      img.addEventListener('load', check, { once: true });
    }
  }

  // src swaps (lazy-load placeholder -> real image) need re-evaluation:
  // blur immediately, forget prior verdict, re-check the new content.
  function retagImage(img) {
    if (failed || dom.hasPlayerAncestor(img)) return;
    // Never pre-blur it on a src swap either -- retagImage marks pending
    // BEFORE tagImage runs, so without this the logo flashes covered
    // every time YouTube rotates its promo mark.
    if (isIgnoredChrome(img)) {
      clearEl(img);
      return;
    }
    if (imageSeen) imageSeen.delete(img);
    if (regionBlur) clearRegionBlur(img); // stale overlays die with the old src
    if (plan.preBlur) markPending(img);
    tagImage(img);
  }

  // ---- video pipeline -------------------------------------------------
  var videoCanvas = null;

  function ensureVideoCanvas() {
    if (!videoCanvas) {
      videoCanvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(detector.INPUT_SIZE, detector.INPUT_SIZE)
          : Object.assign(document.createElement('canvas'), {
              width: detector.INPUT_SIZE,
              height: detector.INPUT_SIZE,
            });
    }
    return videoCanvas;
  }

  // THE PLAYER SWITCH BELONGS TO THE VIDEO HE IS WATCHING, NOT TO A
  // STREAM OR AN ELEMENT. It used to live per <video> and loadstart forced
  // it back on, and YouTube fires loadstart on the SAME watch page for an
  // ad handing over to the video, a quality switch and a fullscreen
  // toggle -- his 2026-10-22 report: "when I turn it off or make the
  // screen bigger or smaller, then again the blur shows up". So his tap
  // is remembered here, by watch id, and only a DIFFERENT watch id goes
  // back to the default (player-switch.mjs: OFF on a phone, ON on
  // desktop; the pill watcher below checks every 250ms).
  var playerBlurChoice = null;
  var onPhone = isPhoneUa(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  function watchVideoId() {
    try {
      if (location.pathname.indexOf('/watch') !== 0) return null;
      return new URLSearchParams(location.search).get('v') || null;
    } catch (e) {
      return null;
    }
  }
  function playerBlurWantedNow() {
    return playerBlurWanted(watchVideoId(), playerBlurChoice, onPhone);
  }

  function attachVideo(video) {
    // Video sampling is face/gender-driven — smart mode only. In
    // blur-all the Stage A sheet covers feed videos; in off, videos are
    // a known compulsory-tier gap (no NSFW sampling yet — noted for the
    // strictness spec pass).
    if (!plan.faceGender) return;

    // The WATCH PLAYER samples live too (owner decision 2026-08-23,
    // HaramBlur-parity: the old player exemption is reversed for smart
    // mode). Player videos get an in-player toggle so a wrong verdict
    // is one tap from gone; feed videos keep the plain pipeline.
    var isPlayer = dom.hasPlayerAncestor(video);
    // The same element serves both roles on m.youtube: on /watch it is
    // the video the user chose to watch, anywhere else it is a feed
    // preview that plays because a thumbnail scrolled past.
    function feedPreview() {
      try {
        return location.pathname.indexOf('/watch') !== 0;
      } catch (e) {
        return false;
      }
    }

    // THE PLAYER IS THE THING HE IS LOOKING AT, SO ITS MODEL GOES FIRST.
    // MoveNet used to be requested by the first video frame that reached
    // the worker, which put a 4.94MB load behind the whole thumbnail
    // drain: his phone reported it landing at 78,807ms. Asking here
    // decouples loading from using. Deliberately NOT for feed previews
    // -- a preview is transient and the lazy path is right for it.
    // A player attaches BEFORE the worker has its backend, so a one-shot
    // check here fires never -- measured: asked stayed null for 198s.
    // Bounded poll instead: the worker is ready within seconds or the
    // player is not going through it at all.
    // A video that starts with its blur off (a phone) does not load the
    // model it is not using: start() kicks the loads when he turns it on.
    if (isPlayer && !feedPreview() && playerBlurWantedNow()) {
      var personTries = 0;
      var askPerson = function () {
        if (failed || dead) return;
        try {
          if (workerVideo() && vid().preloadPerson()) {
            var wm = (window.__TS_GAZE_WORKER = window.__TS_GAZE_WORKER || {});
            wm['asked:person'] = Math.round(performance.now());
            return;
          }
        } catch (e) {
          /* the first frame still asks; this is only a head start */
        }
        if (++personTries < 40) setTimeout(askPerson, 500);
      };
      askPerson();
    }
    if (video.__tsGazeAttached) return;
    video.__tsGazeAttached = true;
    anyVideoAttached = true;
    // One tap off, one tap back on — per watched video. While off, the
    // video is cleared and sampling halts entirely (no spent frames).
    // A player element that attaches mid-video (YouTube rebuilt it)
    // takes his tap for this video, or the default.
    var playerBlurOn = !isPlayer || playerBlurWantedNow();
    if (playerBlurOn) markPending(video);
    // PiP surfaces the RAW stream in a window our overlays can't follow
    // (review C8) — close the hole where supported.
    if (isPlayer && 'disablePictureInPicture' in video) {
      try {
        video.disablePictureInPicture = true;
      } catch (e) {
        /* not supported — nothing to close */
      }
    }

    var lastSample = 0;
    var cleanStreak = 0;
    var sampling = false;
    var intervalId = null;
    var rvfcArmed = false;
    var dead = false;
    var hasRvfc = typeof video.requestVideoFrameCallback === 'function';
    var pill = null;
    var tuneUi = null;
    var pillRefresh = null;
    // The player unblurs faster than feed videos: 2s of guaranteed
    // blackout on a video the user deliberately opened was the review's
    // #13 — one clean second is enough to trust a face-free frame.
    var unblurStreak = isPlayer ? 2 : VIDEO_CLEAN_STREAK_TO_UNBLUR;
    // Owner ask 2026-08-24: the watch player blurs just the face regions,
    // not the whole video (feed videos keep whole blur — too small/fast
    // to track). Falls back to whole blur where backdrop-filter is
    // unsupported. Region videos also sample faster so the overlay chases
    // the face.
    var useRegionVideo = isPlayer && regionBlur && videoRegion.canRegionVideo(video);
    var sampleInterval = isPlayer ? VIDEO_PLAYER_SAMPLE_INTERVAL_MS : VIDEO_SAMPLE_INTERVAL_MS;
    // True while region overlays are live on this video, so a clear knows
    // to tear them down and blur-first can strip cleanly.
    var regionActive = false;
    // Person tracks (person-track.mjs) — the ONLY temporal state the
    // player path keeps (redesign 2026-08-24). Reset whenever the stream
    // identity changes (loadstart, pill re-enable, giveUp): old tracks
    // describe a video that no longer exists.
    var videoTracks = [];
    // Boxes whose birth the null-mint hold refused last pass. See
    // updatePersonTracks: a null read mints on its SECOND sighting.
    var nullHeld = [];
    // ---- DELAY LINE (Stage B, plan 2026-09-02) ----
    // The picture the viewer sees is DELAY_MS behind the frame the
    // tracker judged. presenter (delay-presenter.mjs) hides the real
    // <video>, holds a bitmap ring and paints a canvas inside the
    // player; timeline (track-timeline.mjs) keeps the verdicts keyed by
    // media time so the renderer interpolates between two KNOWN
    // verdicts for the presented frame instead of extrapolating past
    // the last one. Player only, region mode only, never a feed
    // preview, and off entirely when DELAY_MS is 0 (OTA). While a
    // presenter is attached the CSS blur on the hidden video paints
    // nothing, so every whole-cover decision also drives
    // presenter.cover() -- coverVideo/uncoverVideo below are the only
    // two doors.
    var presenter = null;
    var slowDetach = null;
    // PRESENTER_GL: once the GL presenter refuses or loses its context on
    // this video, the 2D presenter owns it for good (no retry loop).
    var glRefused = false;
    var timeline = makeTimeline(0);
    // Media time of the frame the pass in flight was judged on
    // (verdictBusy serialises passes, so one slot is enough).
    var passMediaTime = 0;
    // THE CUT IS KEYED AT THE FRAME THAT SHOWED IT. The scene gate samples
    // the LIVE video -- the newest rVFC frame the presenter's ring just
    // captured -- while every pass is keyed at its frame's mediaTime. Keyed
    // at `video.currentTime` (a clock reading up to a luma tick later) the
    // cut landed 10-100ms AFTER that frame, so a verdict on the cut frame
    // itself sat on the old-shot side: the rule-3'' walk stopped at it
    // (Redmi, events-v1096e 65.532: a certain man covered 19 frames), and a
    // demotion pass keyed 11-56ms before its own cut back-projected blur
    // onto the previous shot's last frames (88.188, 140.374). Never later
    // than the clock: cutBetween is (from, to], so a cut AT the pass frame
    // puts that frame on the new-shot side.
    function cutMediaTime() {
      var newest = presenter ? presenter.newestMediaTime() : null;
      return typeof newest === 'number' ? Math.min(video.currentTime, newest) : video.currentTime;
    }
    // The gate only knows the cut lies in (previous sample, this sample];
    // the ring holds those frames, so ask it which one carried the jump
    // (delay-presenter.locateCut, phase-m M4). Falls back to the sample's
    // own reading when the ring cannot say -- the 1096 behaviour, never
    // an earlier guess that could put a pre-cut verdict on the new side.
    function locateCutMediaTime(gateFrom) {
      var to = cutMediaTime();
      var at = presenter && typeof gateFrom === 'number' ? presenter.locateCut(gateFrom, to) : null;
      if (typeof at === 'number') {
        bumpLife('cutLocated');
        return at;
      }
      bumpLife('cutUnlocated');
      return to;
    }
    // Probe-only: the last answer boxesFn gave the renderer (the timeline
    // entries and the merged target), so a drawn rect can be told apart
    // from the target it was drawn toward. References, no copies.
    var lastTarget = null;
    function delayWanted() {
      return isPlayer && useRegionVideo && !feedPreview() && delayCore.DELAY_MS > 0;
    }
    function delayAttach() {
      if (presenter || !delayWanted()) return;
      var host = video.closest ? video.closest('#movie_player') : null;
      if (!host) return;
      var p = null;
      if (PRESENTER_GL === 1 && !glRefused) {
        p = attachDelayGl(video, host, {
          delayMs: delayCore.DELAY_MS,
          onLost: function (why) {
            // Called AFTER the GL presenter detached itself. Hand the
            // video to the 2D presenter: same cover-first refill, so the
            // swap can only cover, never expose.
            glRefused = true;
            bumpLife('presenterGlLost');
            if (presenter === p) {
              delayDetach();
              delayAttach();
            }
          },
        });
        if (!p) {
          glRefused = true;
          bumpLife('presenterGlRefused');
        }
      }
      if (!p) p = attachDelay(video, host, { delayMs: delayCore.DELAY_MS, onFrame: null });
      if (!p) return;
      presenter = p;
      // Blur-in-frame (idea #5): the presenter paints the renderer's
      // rectangles when BLUR_IN_FRAME is 1; inert otherwise.
      videoRegion.setPainter(video, p.canPaint() ? p.paintPatches : null);
      // PLAYBACK_SLOW poll (inert at 0): reads the decoder's own dropped
      // share every 5s, only ever on the watch player.
      slowDetach = perf.watchPlayback(video);
      timeline = makeTimeline(delayCore.DELAY_MS + 2000);
      videoRegion.setTimeline(video, function () {
        if (!presenter) return null;
        var m = presenter.presentedMediaTime();
        if (m == null) return null;
        var b = boxesAt(timeline, m);
        if (!b) {
          bumpLife('delayVerdictLate');
          lastTarget = null;
          return null;
        }
        // Rule 1 hold (track-timeline.mjs): the frame ran past the newest
        // verdict and got that verdict's boxes, padded. Counted apart from
        // delayVerdictLate, which is now only the cases the hold refused.
        var newest = latestSnapshot(timeline);
        if (newest && m > newest.mediaTime) bumpLife('delayHeldLate');
        var merged = mergePresented(b);
        lastTarget = { m: m, entries: b, merged: merged };
        return merged;
      });
      // Blur-first: the hidden video is pending/flagged until the first
      // verdict says otherwise, and the canvas must say the same.
      presenter.cover(true);
      try {
        // Read-only probe hook, same contract as __TS_GAZE_VTRACKS.
        window.__TS_DELAY_STATS = function () {
          if (!presenter) return null;
          return {
            stats: presenter.stats(),
            presentedMediaTime: presenter.presentedMediaTime(),
            snapshots: latestSnapshot(timeline),
            delayMs: delayCore.DELAY_MS,
            lastTarget: lastTarget,
          };
        };
      } catch (e) {
        /* probes never break the pipeline */
      }
    }
    function delayDetach() {
      if (!presenter) return;
      var p = presenter;
      presenter = null;
      videoRegion.clearPainter(video);
      if (slowDetach) {
        try { slowDetach(); } catch (e) { /* timer already gone */ }
        slowDetach = null;
      }
      videoRegion.clearTimeline(video);
      timeline = makeTimeline(0);
      try {
        p.detach();
      } catch (e) {
        /* a presenter fault must not take the player path down */
      }
    }
    function coverVideo() {
      // Every whole-cover decision comes through here, including a pass
      // that was already in flight when the pill went off: it must not
      // put the blur back under a switch that reads "Blur off".
      if (isPlayer && !playerBlurOn) return;
      markFlagged(video);
      if (presenter) presenter.cover(true);
    }
    function uncoverVideo() {
      clearEl(video);
      if (presenter) presenter.cover(false);
    }
    // ---- end delay line state ----
    // Persons admitted by the LAST person pass, fed back into
    // parsePersons as its hysteresis input (R17). Continuity of the
    // DETECTOR, not of a verdict: it is dropped wherever positions stop
    // meaning what they meant — cut, seek, loadstart, stream change —
    // and holding it one pass too long can only re-admit a box that is
    // still geometrically where it was.
    var heldPersons = [];
    window.__TS_SAMPLERS = (window.__TS_SAMPLERS || 0) + 1;
    var samplerId = window.__TS_SAMPLERS;
    // Ceiling on a single person's verdict work before it is abandoned
    // as unknown (⇒ covered). Registered in docs/detection-engine.md.
    var VERDICT_TIMEOUT_MS = 900;
    var lastPassAt = 0;
    // Per-VIDEO, and wiped on loadstart with the rest of the per-video
    // state. An identity that has earned a clear in this stream says
    // nothing about the next one.
    var identityMem = createIdentityMemory();
    // IDENTITY MEMORY WAS DELETED IN R13. Do not rebuild it without
    // reading this first — it was the owner's own idea (2026-08-24,
    // "keep the person in memory and always blur her/him"), it sounded
    // obviously right, and it shipped. It was measured for three rounds
    // and it does not work, for a reason that is structural rather than
    // a bad threshold:
    //
    //   * The match was a MAX over a bank that only ever grew. Max of k
    //     draws is non-decreasing in k, so the best-match score rises
    //     with bank size BY CONSTRUCTION, independently of who is on
    //     screen. Measured across one 15s window: the best-match FLOOR
    //     climbed from 0.00 (bank of 2) to 0.68 (bank of 6+), against a
    //     threshold of 0.85.
    //   * The bank saturated at MEM_MAX 8 within ~15 seconds of two
    //     people being on screen, and in R13's run it was already at the
    //     cap on the FIRST captured frame.
    //   * The descriptor cannot separate identity at this operating
    //     point at all: docs/detection-engine.md registers 17% of
    //     DIFFERENT-person pairs scoring >=0.9, against a same-person
    //     5th percentile of 0.28. Those distributions overlap across
    //     their whole useful range, so there is no threshold to move to
    //     — with 8 entries x 3 exemplars the false-match probability is
    //     ~1-(1-0.17)^24, i.e. essentially certain.
    //
    // Put together: given a few seconds of video, memory returns
    // "blurred" for almost any face, and the entry doing the covering
    // usually belongs to someone else. R11 measured the end state — a
    // woman reading a CERTAIN CLEAR stayed covered for all ten frames
    // while the bank sat pinned at the cap. That is the mechanism behind
    // the owner's oldest complaint, "why does it keep blurring me": in
    // man mode the bank fills with women and then re-covers HIM.
    //
    // What removing it costs, honestly, because it is not zero: a person
    // who was once read as certainly opposite-gender and who now reads
    // UNCERTAIN no longer gets re-covered on someone else's cleared
    // track. That case is a person swap, which is an identity question,
    // and the measurement above says this descriptor cannot answer it.
    // It is instead bounded by the two mechanisms that do not depend on
    // recognising anybody: a new track always starts blurred, and a
    // cleared track is revoked by CLEARED_TTL_MS or by two abstained
    // reads (see `abstained` in gender-verdict.mjs).
    // Face center inside any (padded) person box — used to keep the
    // full-frame face fallback from duplicating a MoveNet person.
    // Which admitted person's box contains this face's centre, or -1.
    // Returns the INDEX rather than a boolean because one person box can
    // contain several people's faces and only one of them is that person
    // — see faceOwnerIndex's caller for what the rest are worth.
    // MOVED TO person-gate.mjs (phase-g G1) so a bench can call the
    // rule instead of re-deriving it. It is imported at the top of this
    // file; the padding and the -1 contract are unchanged.
    function faceInsideAny(face, persons) {
      return faceInsideIndex(face, persons) !== -1;
    }
    // ADAPTIVE cadence (owner phone 2026-08-24 "very laggy"): the target
    // interval stretches to 1.5x the measured pass cost, capped at 1s —
    // a Helio-class GPU taking 400ms/pass self-throttles to ~1.6Hz
    // instead of saturating its own render thread; desktop stays at the
    // 250ms floor. Interpolation keeps the patch moving either way.
    var lastPassMs = 0;
    // Verdict passes are ~5-10x a position pass; mixing their cost into
    // lastPassMs throttled the CHEAP passes to ~1Hz after every verdict
    // tick (review A11) — the two costs adapt separately: position cost
    // drives the pass floor, verdict cost stretches the zoom interval.
    var lastVerdictMs = 0;
    // Gender pacing: crops+gender run when this much time has passed;
    // position-only passes in between (see cadence note above).
    var lastZoomAt = 0;
    // In-flight guard for the VERDICT pass (crops + gender + descriptor).
    // MEASURED 2026-08-25 on the dev app: verdict passes were issued
    // every ~400ms but only ~0.5/s actually completed, so five of them
    // stacked on the single WebGL queue and each new one made the
    // backlog worse. 51 issued / 12 completed in 22s — the tracker saw
    // position updates ONLY, every person stayed at their initial
    // blurred state, and no amount of state-machine tuning could clear
    // anyone. The adaptive throttle could not help either: it keys off
    // lastVerdictMs, which is only written when a verdict COMPLETES.
    var verdictBusy = false;
    // Set by a verdict pass that found neither a person nor a face.
    // THE TWO POPULATIONS THE GHOST GATE SPLITS. Bounded rings of
    // three numbers each -- the face's own confidence, its native size,
    // and the frame keypoint maximum the gate thresholded on. No urls,
    // no free text; they cost the report nothing and they are the only
    // way to tell "the gate is refusing graphics" from "the gate is
    // refusing people", which on his hardware is currently unknown.
    function faceAlreadyCovered(face) {
      // DOES THE REFUSAL ACTUALLY COST COVERAGE? A face the gate throws
      // away is only an exposure if nobody else is covering that spot --
      // a second face in the same shot, or the same person still held by
      // a coasting track, would cover it anyway. Tracks here are the
      // PREVIOUS pass's, which is exactly the right question: was this
      // subject covered at the moment we refused them.
      var cx = (face.x1 + face.x2) / 2;
      var cy = (face.y1 + face.y2) / 2;
      for (var i = 0; i < videoTracks.length; i++) {
        var t = videoTracks[i];
        if (!t || t.state !== 'blurred' || !t.box) continue;
        if (cx >= t.box.x1 && cx <= t.box.x2 && cy >= t.box.y1 && cy <= t.box.y2) return 1;
      }
      return 0;
    }

    function noteFaceGate(ring, face, persons, video) {
      try {
        var d = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
        var r = (d[ring] = d[ring] || []);
        var vw = (video && video.videoWidth) || 0;
        var vh = (video && video.videoHeight) || 0;
        var px = vw && vh
          ? Math.round(Math.min((face.x2 - face.x1) * vw, (face.y2 - face.y1) * vh))
          : null;
        var entry = {
          // WHEN, not just how often. "not blurred instantly" (owner,
          // 2026-09-01) is a DURATION, and a ring with no clock can only
          // say a face was refused, never for how long the person it
          // belonged to stayed sharp. Page-relative ms, so it carries
          // nothing about the content.
          ms: Math.round(performance.now()),
          c: Math.round((face.confidence || 0) * 100) / 100,
          px: px,
          k: typeof persons.maxKp === 'number' ? persons.maxKp : null,
          cov: faceAlreadyCovered(face),
          // WHAT THE INSIDE OF THE DETECTION LOOKS LIKE. Confidence,
          // size and the frame keypoint max all failed to separate the
          // refused population from the kept one (refused conf p50 0.78
          // vs kept 0.79, px 72 vs 79, and the keypoint separator sat at
          // 0.098 against 0.101). BlazeFace's own six landmarks are the
          // only per-face signal we have that describes the ARRANGEMENT
          // inside the box, and they cost no inference. Recorded on BOTH
          // sides so the populations can be compared before any rule is
          // written -- every previous version of this gate was
          // calibrated on one side and refused people.
          m: markRing(markShape(face)),
        };
        r.push(entry);
        if (r.length > 60) r.shift();
        return entry;
      } catch (e) {}
      return null;
    }

    var emptyFrame = false;
    // Consecutive verdict passes that saw nothing. Absence has to be
    // seen twice before it is believed — see wipeIfEmpty.
    var emptyStreak = 0;
    // Largest box height seen by this verdict pass, and by the last pass
    // that saw anything. Subject scale decides how much an empty frame is
    // worth: big subject vanishing = cut, small subject vanishing = miss.
    var passMaxBoxH = 0;
    var lastMaxBoxH = 0;
    // Backstop: a verdict pass that never reports back must not wedge
    // the guard shut for the life of the video.
    var VERDICT_STALL_MS = 4000;
    // Zero-readback (plan-blur-v2 Stage 1): the person pass feeds the
    // VIDEO ELEMENT straight into fromPixels (texture upload, in-graph
    // resize) — no 2D canvas, no getImageData sync readback. If that
    // path ever errors non-fatally (driver quirk), the canvas fallback
    // takes over permanently for this video.
    var directPersonOk = true;
    // Pass epoch (review A6): cut/seek/loadstart bump it; a pass that
    // started under an older epoch discards its result instead of
    // resurrecting pre-discontinuity people as fresh tracks.
    var passEpoch = 0;
    // Round-robin cursor for crowd scenes: which slice of a large group
    // gets a gender read this pass (everyone is tracked regardless).
    var crowdCursor = 0;
    // The SAME rotation, for the primary MoveNet pick. Separate cursor
    // because it rotates a DIFFERENT list: `persons` (skeletal only),
    // where crowdCursor rotates `all` (skeletal + face-derived bodies)
    // and only ever runs when the fallback stage pushed that list past
    // the budget. Sharing one cursor would advance it twice on a pass
    // that took both paths, and on a 6-person list two advances of 3 is
    // a rotation of zero -- i.e. silently no rotation at all.
    var personCursor = 0;
    var personCanvas = null;
    function ensurePersonCanvas() {
      if (!personCanvas) {
        personCanvas = document.createElement('canvas');
        personCanvas.width = detector.PERSON_INPUT_SIZE;
        personCanvas.height = detector.PERSON_INPUT_SIZE;
      }
      return personCanvas;
    }
    function personPixelSource() {
      if (directPersonOk) return video;
      var pc = ensurePersonCanvas();
      var pctx = pc.getContext('2d');
      pctx.drawImage(video, 0, 0, detector.PERSON_INPUT_SIZE, detector.PERSON_INPUT_SIZE);
      return pctx.getImageData(0, 0, detector.PERSON_INPUT_SIZE, detector.PERSON_INPUT_SIZE);
    }
    // WHOLE-FRAME VERDICT for the non-region path (feed videos, and a
    // player whose host cannot take overlays): does any face in this
    // frame mean the video stays covered? Same two steps as the region
    // path -- faces, then a gender read only if there were any -- and
    // the same two homes for them.
    // THE ONLY EVIDENCE THE OTHER FOUR PLATFORMS HAVE, COUNTED.
    //
    // On Reddit, X, Instagram and Facebook `isPlayer` is false (16), so
    // `wholeFrameFlagged` is the whole pipeline: ONE boolean per frame,
    // and a frame where the detector finds nothing is indistinguishable
    // from a frame with nobody in it -- `cleanStreak++`, four of them
    // reach `clearEl`. 16a asserted the 1089 letterbox could not make
    // that happen and the phase-E critic measured 3 blind frames in 241
    // where the squash had 0, concentrated in his 38-64px band.
    //
    // NO COUNTER EXISTED ON THIS BRANCH AT ALL, which is how a one-way
    // change got called zero. These two say how often the only evidence
    // there is comes back empty, and how often that reveals a video.
    // Seeded on the first sample so an absent key cannot be mistaken for
    // a hook that was never wired (the loop-34 defect).
    function wholeFrameLife(key) {
      try {
        var d = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
        d.life = d.life || {};
        if (d.life.wholeFrameSamples === undefined) {
          d.life.wholeFrameSamples = 0;
          d.life.wholeFrameNoFaces = 0;
          d.life.wholeFrameCleared = 0;
        }
        d.life[key] = (d.life[key] || 0) + 1;
      } catch (e) {}
    }
    function wholeFrameFlagged(pixels) {
      function anyFlagged(genders) {
        var meta = faceMeta(userGender, genders);
        for (var mi = 0; mi < meta.length; mi++) {
          if (meta[mi].flagged) return true;
        }
        return false;
      }
      if (workerVideo()) {
        // One engine per cid (phase-j J7): the client that minted it is
        // the only one that can read or release it, whatever vid()
        // answers by the time the reply lands.
        var eng = vid();
        return eng.cropFaces(pixels).then(function (r) {
          var faces = r.faces || [];
          if (!faces.length) {
            wholeFrameLife('wholeFrameNoFaces');
            eng.releaseCrop(r.cid);
            return false;
          }
          return eng
            .cropGender(r.cid, faces)
            .then(function (g) {
              return anyFlagged(g.reads || []);
            })
            .catch(function () {
              // A read we could not get is a face we cannot clear.
              return true;
            })
            .then(function (v) {
              eng.releaseCrop(r.cid);
              return v;
            });
        });
      }
      return detector.detectFaceBoxes(model, pixels).then(function (faces) {
        if (!faces.length) wholeFrameLife('wholeFrameNoFaces');
        if (!faces.length || !genderModel) return faces.length > 0;
        return detector.classifyFaceGenders(genderModel, pixels, faces, { square: true }).then(anyFlagged);
      });
    }
    // THE PERSON PASS RUNS ON EVERY PASS. (2026-08-31, reverted the
    // same night it shipped.)
    //
    // 1068-1070 backed MoveNet off to one pass in three once it had
    // admitted nobody three times running, because on his phone it costs
    // 504ms of a 795ms verdict and reads n:0 in all twelve slots. The
    // cadence numbers were real -- verdicts 2.09s -> 1.21s, position
    // passes 10/min -> 62/min -- and HE REPORTED THE THING THAT MATTERS:
    // "it's not blurring the female".
    //
    // A skipped pass is not inert to anything downstream. It reports an
    // empty person list to the tracker and to the eraser, and no held
    // flag fixes that: whichever way the ghost gate's evidence is set on
    // a pass the model never ran, one of the two directions is wrong.
    // Refusing loses a real person; minting paints graphics. Blur-first
    // says the exposure is the unacceptable one, and an owner-visible
    // miss settles it -- so the model runs, every pass, as it did in
    // 1067.
    //
    // The worker protocol keeps `withPersons`, because it is the honest
    // way to express "this pass did not run the model" if a future round
    // ever needs it. It is always true here.
    // AFTER THE MODEL HAS ADMITTED NOBODY THIS MANY PASSES RUNNING, it
    // stops being asked every pass. One admitted person resets it
    // instantly, so on footage where MoveNet works this is inert.
    // The person-skip policy lives in person-skip.mjs so its constants
    // can ride the OTA tuning channel. It ships INERT (PERSON_SKIP_EVERY
    // = 1 means never skip); see that file for why the cost is kept
    // reversible.

    function runPass(withFaces, mark, keepFrame) {
      var aspect = video.videoWidth / (video.videoHeight || 1);
      var askPersons = wantPersons();
      if (workerVideo()) {
        // createImageBitmap replaces the synchronous fromPixels(video)
        // texture upload -- it is async and the bitmap is TRANSFERRED,
        // so the only main-thread work a pass now costs is asking.
        // With a presenter attached the pass reads the NEWEST ring
        // frame -- the frame the viewer will see DELAY_MS from now --
        // so the verdict can land before the frame is presented. A
        // ring that is empty (just attached, just flushed) falls back
        // to the live frame; either way passMediaTime names the frame
        // the snapshot below is keyed on.
        var frameP = presenter
          ? presenter.requestVerdictFrame().then(function (r) {
              if (r && r.bitmap) {
                passMediaTime = r.mediaTime;
                return r.bitmap;
              }
              passMediaTime = video.currentTime;
              return createImageBitmap(video);
            })
          : (passMediaTime = video.currentTime, createImageBitmap(video));
        return Promise.resolve(frameP)
          .then(function (bmp) {
            mark('upload');
            var onNative = nativeVideo();
            return vid()
              .videoFrame(bmp, aspect, heldPersons, withFaces, askPersons)
              .then(function (r) {
                // Counted on the RESOLVED frame (phase-j J9), never on
                // the intent to send one.
                if (onNative) nativeLife('nativePasses');
                return r;
              });
          })
          .then(function (r) {
            // Structured clone copies an array's elements, not the
            // properties detectPersons hangs on the array itself.
            var persons = (r.persons || []).slice();
            persons.noHumanShape = !!r.noHumanShape;
            persons.maxKp = typeof r.maxKp === 'number' ? r.maxKp : null;
            persons.rejectedBoxes = r.rejectedBoxes || [];
            // A SKIPPED PASS MUST BE READABLE AS ONE ALL THE WAY DOWN.
            // 1070 shipped a skip whose only downstream signal was an
            // empty person list, which `emptyFrame` read as "nobody is
            // there" and the eraser acted on. The flag rides the array
            // so every consumer can tell "the model looked and found
            // nobody" from "the model did not look".
            // COUNT THE SKIP ITSELF (critic B3). `PERSON_SKIP_EVERY 3`
            // does NOT stop the model: person-skip runs it ONE PASS IN
            // THREE, so "faceNoShape went to 0 because the gate cannot
            // fire on a pass that ran no model" predicts about a third
            // of the old count, not zero. Nothing in the page could tell
            // those two apart -- there has never been a counter for a
            // skipped pass anywhere in app/gaze/src -- so the mechanism
            // was asserted rather than measured. This is the number that
            // settles it: skipped against passes, read on his phone.
            persons.skipped = !!r.personsSkipped;
            if (persons.skipped) bumpLife('personPassSkipped');
            // notePersons stamps the held answer onto a skipped pass.
            notePersons(persons, !!r.personsSkipped);
            return { persons: persons, faces: r.faces || [] };
          })
          .catch(function (e) {
            // A refused or timed-out pass is not a broken video: the
            // page takes the path back and this pass coasts, which is
            // the same thing a failed in-page pass has always done.
            banWorkerVideo(e);
            throw e;
          });
      }
      passMediaTime = video.currentTime;
      var frame = directPersonOk ? detector.uploadFrame(video) : null;
      keepFrame(frame);
      mark('upload');
      // Same rule on the in-page path. An empty array with noHumanShape
      // left false is the inert answer the ghost gate ignores.
      var personsP = askPersons
        ? detector.detectPersons(personModel, personPixelSource(), aspect, heldPersons, frame)
        : Promise.resolve([]);
      return personsP
        .then(function (persons) {
          if (!askPersons) { persons.skipped = true; bumpLife('personPassSkipped'); }
          notePersons(persons, !askPersons);
          return persons;
        })
        .then(function (persons) {
          if (!withFaces) return { persons: persons, faces: null };
          return detector
            .detectFaceBoxes(
              model,
              directPersonOk ? video : personPixelSource(),
              directPersonOk ? frame : null
            )
            .then(function (faces) {
              return { persons: persons, faces: faces };
            });
        });
    }
    // Scene gate (scene-gate.mjs): 16x16 luma thumbnail classifies the
    // player's motion. 'cut' forces an immediate pass + gender read;
    // 'static' relaxes cadence toward 1Hz — but ONLY while no track is
    // blurred (a blurred track is mid-verdict: its clear credit and any
    // drifting subject need full cadence — plan-blur-v2 risk register).
    var GATE_INTERVAL_MS = 100;
    var gateCanvas = null;
    var prevLuma = null;
    // Media time of the PREVIOUS gate sample's frame: the far edge of the
    // window a detected cut can lie in (phase-m M4, see cutMediaTime).
    var prevGateMedia = null;
    var lastGateAt = 0;
    var lastCutAt = 0;
    var sceneState = 'motion';
    function gateTick(now) {
      if (now - lastGateAt < GATE_INTERVAL_MS) return;
      lastGateAt = now;
      var gateFrom = prevGateMedia;
      prevGateMedia = presenter ? cutMediaTime() : null;
      try {
        if (!gateCanvas) {
          gateCanvas = document.createElement('canvas');
          gateCanvas.width = sceneGate.GATE_SIZE;
          gateCanvas.height = sceneGate.GATE_SIZE;
        }
        var g = gateCanvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(video, 0, 0, sceneGate.GATE_SIZE, sceneGate.GATE_SIZE);
        var d = g.getImageData(0, 0, sceneGate.GATE_SIZE, sceneGate.GATE_SIZE).data;
        var n = sceneGate.GATE_SIZE * sceneGate.GATE_SIZE;
        var cur = sceneGate.lumaGrid(d, n);
        if (prevLuma) {
          var lumaDelta = sceneGate.meanAbsDelta(prevLuma, cur);
          sceneState = sceneGate.classifyScene(lumaDelta);
          // THE DELTA BEHIND EVERY CUT DECISION (S10). S6's critic asked
          // for CUT_DELTA to move and was refused pending a count; S10
          // measured the cost of being wrong -- 6 of 7 revoked clears sit
          // within 0.21s of a cutDetected -- so the calibration question
          // is now load-bearing. A histogram separates "these are real
          // cuts" from "the threshold is picking up camera motion", and
          // nothing has ever recorded the value.
          try {
            var dbgL = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
            if (!dbgL.luma) dbgL.luma = [];
            dbgL.luma.push(Math.round(lumaDelta * 10) / 10);
            if (dbgL.luma.length > 600) dbgL.luma.shift();
          } catch (e) {}
        }
        prevLuma = cur;
      } catch (e) {
        // Tainted canvas: the gate goes inert ('motion' = no behaviour
        // change); the main path's own taint handling decides giveUp.
        sceneState = 'motion';
      }
      if (sceneState === 'cut' && now - lastCutAt >= sceneGate.CUT_MIN_GAP_MS) {
        lastCutAt = now;
        // COUNT THE CUTS (S6 critic finding 2). Everything downstream of
        // this branch — demoteTracks, the forced verdict, both throttle
        // bypasses below — is sized by how often it fires, and nothing
        // has ever recorded it. `cutCoastExpired` cannot be interpreted
        // without it: 10 expiries is a different story at 4 cuts than at
        // 40. Deliberately just the counter this round; the critic's
        // proposed changes to CUT_DELTA and the forced-pass gap are NOT
        // taken until this number exists on real footage.
        bumpLife('cutDetected');
        // The timeline must know a cut happened at THIS media time, or
        // boxesAt would carry the old shot's patches across it.
        if (presenter) pushCut(timeline, locateCutMediaTime(gateFrom));
        // A cut is where new people appear: bypass the interval AND
        // force the next pass to re-read gender, not just positions.
        lastSample = 0;
        lastZoomAt = 0;
        // Positions are MEANINGLESS across a cut — IoU association would
        // glue the old shot's blur states onto whoever stands nearest in
        // the new shot (owner 2026-08-24: subjects "switching one
        // another"). DEMOTE, don't wipe (review C2): boxes persist so
        // coverage holds through the pass gap, but every verdict state
        // resets to blurred — identity memory, not stale association,
        // decides who re-clears.
        videoTracks = demoteTracks(videoTracks);
        // Same reasoning one level down: positions are meaningless
        // across a cut, so the detector's own continuity goes with them.
        // Holding a pre-cut box open would re-admit a slot sitting where
        // somebody USED to stand — a GHOST, which the owner counts.
        heldPersons = [];
        // A HELD "MoveNet ADMITS NOBODY" ANSWER MUST NOT OUTLIVE ITS
        // SHOT (phase-i critic I10). PERSON_SKIP_EVERY backs the model
        // off for up to PERSON_EMPTY_STREAK + (PERSON_SKIP_EVERY - 1)
        // passes on evidence from the OLD shot; nothing above this line
        // touches that independent cycle, so a cut into a shot with a
        // faceless subject would otherwise wait out the same backoff a
        // static shot would -- up to ~5.4s measured on the arm64 Redmi.
        // ONE forced look, not a reset: a reset on every cut ran the
        // model 3x as often on his 30-cuts-per-150s footage and gave
        // stage A's verdict gap back (1201 -> 2068ms) -- see
        // forcePersonLook in person-skip.mjs. The back-off stays; the
        // next pass asks MoveNet and its answer decides.
        forcePersonLook();
        passEpoch++;
        // NO whole-frame blackout here. Measured 2026-08-25: cuts fire
        // every ~2.8s on ordinary edited video, so blacking out the
        // frame until the forced pass landed meant the player spent
        // most of its life fully blurred — the loudest form of "not
        // accurate". Existing patches persist through the gap instead
        // (demoteTracks keeps the boxes), and the forced pass is
        // already at the front of the queue.
      }
    }
    function anyBlurredTrack() {
      for (var i = 0; i < videoTracks.length; i++) {
        if (videoTracks[i].state === 'blurred') return true;
      }
      return false;
    }
    // Per-person face/gender crop (the audit's person-primary pass): the
    // person's region cropped at NATIVE resolution, aspect-preserving
    // (square-stretch distorted faces and flipped gender reads — live
    // regression 2026-08-24). This is the ONLY face/gender path for the
    // player: small faces fill the model input by construction, so the
    // old full-frame pass, rescue floor and native recheck are gone.
    // 224 matches the gender model's input exactly — a bigger crop was
    // pure readback cost; 3 persons/pass caps the worst-case burst
    // (owner phone 2026-08-24 "very laggy").
    var ZOOM_CROP_SIZE = 224;
    var ZOOM_MAX_PERSONS = 3;
    // R30 CRITIC F2 — THE CLEAR LADDER WAS NEVER THE BINDING CONSTRAINT
    // ON MULTI-PERSON FOOTAGE. THIS BUDGET IS.
    //
    // Measured on rotation entry 5 (`4u3jS_cTHH0` t=415, studio kitchen,
    // 3-4 men + 1 woman, `man`), replayed from the stored `obs` probe
    // over 24 unique verdict passes:
    //
    //   observations per pass   1:2  2:7  3:6  4:11  5:2  6:2
    //   VERDICT observations    1:2  2:7  3:21   <- never above 3
    //
    // Fifteen of thirty recorded passes carried 4-6 people and not one
    // of them ever produced more than three gender reads. Over 60s of
    // continuous playback, `cropRotated` fires 64 times against ~131
    // verdict passes -- ~49% of passes are budget-limited -- and
    // **61 of 105 tracks never received a single non-uncertain read in
    // their entire life**, at a lifetime p50 of 1.47s and a maximum of
    // 4.44s. A track alive for 4.4s sees ~10 verdict passes. That is not
    // a cadence problem and no accumulation rule reaches it: the read
    // never arrives, so there is nothing to accumulate.
    //
    // ONE MORE PERSON PER PASS, AND ONLY WHERE THE DEVICE HAS ALREADY
    // PROVED IT CAN AFFORD IT. The crop+gender stage is 64 of a verdict
    // pass's 102ms for three persons (S9) ~ 21ms/person; the desktop
    // verdict p50 in this window is 113ms. The gate reads the LAST
    // COMPLETED verdict cost, so a phone that is slow for any reason --
    // thermal, a heavier shot, a debug build -- never widens, and the
    // owner's "very laggy" report that set this cap at 3 in the first
    // place (2026-08-24) stays honoured on the hardware it came from.
    // `lastVerdictMs` is 0 until a verdict lands, so the first pass on
    // every video is always the narrow budget.
    //
    // WHY 4 AND NOT `persons.length`: the rotation already guarantees
    // every person is read eventually, so this buys arrival RATE, not
    // coverage, and the tail risk of an unbounded burst is exactly what
    // the cap exists to stop. Four covers the 4-person mode of this
    // distribution (11 of 24 passes) at one inference of extra cost.
    var ZOOM_MAX_PERSONS_FAST = 4;
    var ZOOM_BUDGET_FAST_MS = 250;
    // OFF THE MAIN THREAD, THIS CAP IS MEASURING THE WRONG THING.
    //
    // Owner 2026-08-28: "what if you drop the blur frame rate for it to
    // work more accurately". That is the right trade and the worker
    // makes it free to take. Every number above was chosen against ONE
    // cost -- how long a verdict pass occupies the thread YouTube draws
    // with -- and a crop the worker runs does not occupy it at all.
    // What the cap still costs is accuracy: a person who does not get a
    // crop gets no gender read, and a person with no read cannot ever
    // accumulate the consecutive same-gender reads a CLEAR requires, so
    // the budget is measured false-cover (R30 critic F2).
    //
    // Six is MoveNet MultiPose's own ceiling, so on the worker path
    // nobody is starved. The cadence pays for it by itself and in
    // exactly the direction he asked for: effZoom is lastVerdictMs *
    // VERDICT_DUTY, so a pass that reads more people simply runs less
    // often.
    var ZOOM_MAX_PERSONS_WORKER = 6;
    function zoomBudget() {
      if (workerVideo()) return ZOOM_MAX_PERSONS_WORKER;
      return lastVerdictMs && lastVerdictMs < ZOOM_BUDGET_FAST_MS
        ? ZOOM_MAX_PERSONS_FAST
        : ZOOM_MAX_PERSONS;
    }
    var zoomCanvas = null;
    // createImageBitmap(video, crop, {resize}) crops + scales GPU-side
    // and feeds fromPixels directly — the zoom pass's getImageData
    // readback is gone (plan-blur-v2 Stage 1). Canvas path stays as the
    // runtime fallback for WebViews without it.
    var hasImageBitmap = typeof createImageBitmap === 'function';

    // Crop pixels for one person's region: ImageBitmap where supported,
    // else the old canvas + getImageData. Both aspect-preserving
    // (square-stretch distorted faces — live regression 2026-08-24).
    function cropPersonPixels(region) {
      var vw = video.videoWidth;
      var vh = video.videoHeight;
      var sw = Math.max(1, (region.x2 - region.x1) * vw);
      var sh = Math.max(1, (region.y2 - region.y1) * vh);
      var scale = ZOOM_CROP_SIZE / Math.max(sw, sh);
      var dw = Math.max(32, Math.round(sw * scale));
      var dh = Math.max(32, Math.round(sh * scale));
      if (hasImageBitmap) {
        return createImageBitmap(video, region.x1 * vw, region.y1 * vh, sw, sh, {
          resizeWidth: dw,
          resizeHeight: dh,
        });
      }
      if (!zoomCanvas) zoomCanvas = document.createElement('canvas');
      zoomCanvas.width = dw;
      zoomCanvas.height = dh;
      var zctx = zoomCanvas.getContext('2d');
      zctx.drawImage(video, region.x1 * vw, region.y1 * vh, sw, sh, 0, 0, dw, dh);
      return Promise.resolve(zctx.getImageData(0, 0, dw, dh));
    }
    // A gender read on pixels nothing will ask about twice: the
    // native-resolution face re-crop, and the whole-blur fallback's
    // frame. The worker takes ownership of the bitmap.
    function genderOnPixels(pix, boxes) {
      if (workerVideo()) {
        return vid().genderOnce(pix, boxes).then(function (r) {
          return r.reads || [];
        });
      }
      return detector.classifyFaceGenders(genderModel, pix, boxes, { square: true });
    }

    // WHAT THE GHOST GATE IS THROWING AWAY, in the only terms that
    // settle it: the gender verdict the refused face WOULD have
    // produced. The two rings say the refused and kept populations look
    // alike on confidence and size; they cannot say whether a refusal
    // was a person. This runs the same native-res read a kept face gets
    // and stamps it on the ring entry.
    //
    // DIAGNOSTIC ONLY and it must stay that way: it is gated on
    // __TS_GATE_AUDIT, which nothing in the app ever sets, because the
    // read costs a crop and an inference per refused face on the very
    // pass the gate exists to make cheap. The face is still refused --
    // no patch, no track, no memory -- so the audit cannot change what
    // is on screen, only what the artifact says about it.
    function auditRefusedFace(entry, faceBox) {
      try {
        if (!entry || !window.__TS_GATE_AUDIT) return;
        var vw = video.videoWidth || 0;
        var vh = video.videoHeight || 0;
        if (!vw || !vh) return;
        // Same square-in-native-pixels crop as faceRegionInVideo, on a
        // box already normalized to the FRAME (this pass is full-frame).
        var side = Math.min((faceBox.x2 - faceBox.x1) * vw, (faceBox.y2 - faceBox.y1) * vh);
        var hx = ((faceBox.x1 + faceBox.x2) / 2) * vw;
        var hy = ((faceBox.y1 + faceBox.y2) / 2) * vh;
        var half = side / 2;
        var fr = {
          x1: Math.max(0, (hx - half) / vw),
          y1: Math.max(0, (hy - half) / vh),
          x2: Math.min(1, (hx + half) / vw),
          y2: Math.min(1, (hy + half) / vh),
        };
        cropPersonPixels(fr)
          .then(function (fpix) {
            return genderOnPixels(fpix, [{ x1: 0, y1: 0, x2: 1, y2: 1 }]).then(function (g) {
              if (fpix && typeof fpix.close === 'function') fpix.close();
              var r = g && g[0];
              if (!r) return;
              entry.g = r.gender === 'male' ? 1 : r.gender === 'female' ? 2 : 0;
              entry.s = Math.round((r.score || 0) * 100) / 100;
            });
          })
          .catch(function () {});
      } catch (e) {}
    }

    // Tile-recall probe (R16). Runs the SAME detector over a 2x2 grid of
    // native-resolution quadrants and reports how many faces that finds
    // against the single full-frame pass, plus what it cost. Nothing here
    // feeds the pipeline: it exists so the tiling decision is made on
    // numbers from real footage rather than on the arithmetic of
    // 1920 -> 256. Guarded end to end — instrumentation has killed two
    // releases here and does not get to kill a third.
    var tileProbeBusy = false;
    function tileProbe(baseCount) {
      if (tileProbeBusy) return;
      tileProbeBusy = true;
      var t0 = performance.now();
      var quads = [
        { x1: 0, y1: 0, x2: 0.55, y2: 0.55 },
        { x1: 0.45, y1: 0, x2: 1, y2: 0.55 },
        { x1: 0, y1: 0.45, x2: 0.55, y2: 1 },
        { x1: 0.45, y1: 0.45, x2: 1, y2: 1 },
      ];
      var found = [];
      var chain = Promise.resolve();
      quads.forEach(function (q) {
        chain = chain.then(function () {
          return cropPersonPixels(q)
            .then(function (pix) {
              return detector.detectFaceBoxes(model, pix).then(function (fs) {
                if (pix && typeof pix.close === 'function') pix.close();
                var qw = q.x2 - q.x1;
                var qh = q.y2 - q.y1;
                for (var i = 0; i < fs.length; i++) {
                  found.push({
                    x1: q.x1 + fs[i].x1 * qw,
                    y1: q.y1 + fs[i].y1 * qh,
                    x2: q.x1 + fs[i].x2 * qw,
                    y2: q.y1 + fs[i].y2 * qh,
                  });
                }
              });
            })
            .catch(function () {});
        });
      });
      chain.then(function () {
        // Quadrants overlap by 10% so a face on a seam is not cut in two;
        // dedupe what that double-counts.
        var uniq = [];
        for (var i = 0; i < found.length; i++) {
          var dup = false;
          for (var j = 0; j < uniq.length; j++) {
            if (boxIou(found[i], uniq[j]) > 0.3) {
              dup = true;
              break;
            }
          }
          if (!dup) uniq.push(found[i]);
        }
        var ms = Math.round(performance.now() - t0);
        try {
          var dbgP = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
          dbgP.tile = (dbgP.tile || [])
            .concat([{ base: baseCount, tiled: uniq.length, ms: ms }])
            .slice(-12);
        } catch (e) {}
        tileProbeBusy = false;
      });
    }

    function boxIou(a, b) {
      var ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
      var iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
      var inter = ix * iy;
      var ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
      return ua > 0 ? inter / ua : 0;
    }

    // One person's observation: face+gender read from their crop.
    // No face at all = backside/turned-away = unknown ⇒ covered.
    function observePerson(person) {
      var region = personCropRegion(person);
      // WHICH CROP THIS READ ACTUALLY RAN ON (R28). The head crop only
      // wins where it is smaller, so "it shipped" and "it fired on this
      // footage" are different claims -- R27 lost a whole rebuild cycle
      // to exactly that ambiguity on the clamp. Counted, never thrown.
      try {
        var hcr = headCropRegion(person);
        bumpLife(
          hcr && Math.abs((hcr.x2 - hcr.x1) - (region.x2 - region.x1)) < 1e-9
            ? 'cropHead'
            : 'cropBody'
        );
      } catch (e) {}
      var obs = { box: person, flagged: true, certain: false, faceFound: false };
      var zpix = null;
      var zpixRef = null;
      // The worker's copy of this crop, when the worker detected in it.
      // Kept alive there between the face pass and the gender read --
      // the same pixels, uploaded once -- and released here, on the one
      // path every outcome goes through.
      var zcid = 0;
      var zeng = null; // the client that minted zcid (phase-j J7)
      function done(result) {
        if (zpix && typeof zpix.close === 'function') zpix.close();
        if (zcid) {
          try {
            zeng.releaseCrop(zcid);
          } catch (e) {
            /* a worker that cannot be told sweeps it on its own TTL */
          }
          zcid = 0;
        }
        return result;
      }
      // The gender read for faces found in THIS crop. Over the worker
      // that is the upload the face pass already made (`zcid`); when the
      // face box came from the person instead, no upload was made and
      // the crop is still ours to send.
      function cropGenderReads(faces) {
        if (!workerVideo()) return detector.classifyFaceGenders(genderModel, zpixRef, faces, { square: true });
        if (zcid) {
          return zeng.cropGender(zcid, faces).then(function (r) {
            return r.reads || [];
          });
        }
        return vid().genderOnce(zpixRef, faces).then(function (r) {
          return r.reads || [];
        });
      }
      // WATCHDOG (measured 2026-08-25): createImageBitmap on the live
      // <video> can hang without ever settling — not reject, HANG. The
      // per-person verdict chain is serial, so ONE hung crop stalled the
      // whole pass forever, and a CDP run showed 38 of 49 verdict passes
      // never reaching the tracker: every person stayed at their initial
      // blurred state for the life of the video. That is exactly the
      // owner's "Linus is not clearing at all". A verdict that hasn't
      // landed within VERDICT_TIMEOUT_MS is abandoned as unknown (⇒
      // covered, the fail-safe direction) so the NEXT pass still runs.
      var settled = false;
      var work = cropPersonPixels(region)
        .then(function (pix) {
          zpix = pix;
          return observeCropped(zpix);
        })
        .then(done)
        .catch(function () {
          // Unreadable crop (taint rejects createImageBitmap, sync
          // canvas throw rejects here too): unknown ⇒ covered.
          //
          // COUNTED (R28 critic S1). Every throw in the whole chain --
          // crop, detect, attribute, classify, and the inner native-crop
          // fallback -- lands here and becomes a hard cover that is
          // INDISTINGUISHABLE in the artifact from an honest
          // `personNoFace`. Its volume could not be estimated at all,
          // which is worse than it being large: no round could bound it.
          try {
            bumpLife('observeThrew');
          } catch (e) {}
          return done(obs);
        })
        .then(function (r) {
          settled = true;
          return r;
        });
      return Promise.race([
        work,
        new Promise(function (resolve) {
          setTimeout(function () {
            if (settled) return;
            var dbgW = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
            dbgW.timeouts = (dbgW.timeouts || 0) + 1;
            resolve(obs);
          }, VERDICT_TIMEOUT_MS);
        }),
      ]);

      // NATIVE-RES face crop for the gender read (owner 2026-08-25 "still
      // not accurate" + the gender model swaying all night). Detection
      // runs on the 224px person crop, which is fine for FINDING a face
      // — but the face inside it is often only 40-60px, and feeding that
      // to faceres meant classifying an upscaled blur. HaramBlur reads
      // the FACE crop; so do we now: the winning face box is mapped back
      // to video coordinates and re-cut from the source at 224px.
      // MEASURED R10 (runs/r10-woman): a woman lecturer 33 native pixels
      // wide was handed to faceres as a 135x68 smear inside a 224 frame,
      // and the model answered with a CONSTANT — raw sigmoid 0.635 +- 0.02
      // across 24 reads of four different subjects, with the age head
      // simultaneously pinned at its training prior (36.9 +- 1.4 on a hall
      // of undergraduates). Two heads returning their priors at once is
      // what "no signal" looks like. That constant is labelled `male`,
      // which is inert in man mode but a CERTAIN flag in woman mode, so
      // every woman in the shot was covered, permanently, on all ten
      // frames.
      //
      // Half of that was our own chain. The face box comes back SQUARE IN
      // MODEL SPACE (detector.js squarifies against a 256x256 resize of a
      // non-square crop), so composing it through rw/rh here produced a
      // region whose native-pixel aspect was the person box's aspect —
      // 2.36:1 on a standing figure. `cropPersonPixels` preserves that,
      // and `classifyFaceGenders` then stretches it back to 224x224. The
      // face arrived at the model stretched more than twice as wide as it
      // really is.
      //
      // So build the region SQUARE IN NATIVE PIXELS. `min(w,h)` is the
      // honest side: the squarify used `max` on the STRETCHED axis, so the
      // short side is the one that survived the stretch unscaled and still
      // carries the true FACE_ENLARGE'd face size. Centre it on the box
      // centre and clamp to the frame.
      function faceRegionInVideo(faceBox) {
        // faceBox is normalized to the person crop; region is normalized
        // to the frame. Compose the two.
        var rw = region.x2 - region.x1;
        var rh = region.y2 - region.y1;
        var x1 = region.x1 + faceBox.x1 * rw;
        var y1 = region.y1 + faceBox.y1 * rh;
        var x2 = region.x1 + faceBox.x2 * rw;
        var y2 = region.y1 + faceBox.y2 * rh;
        var vw = video.videoWidth || 0;
        var vh = video.videoHeight || 0;
        if (!vw || !vh) return { x1: x1, y1: y1, x2: x2, y2: y2 };
        // Work in native pixels — the whole bug is that normalized units
        // hide the frame aspect (third time in this codebase: see
        // personFromFace and person-gate's own header).
        var side = Math.min((x2 - x1) * vw, (y2 - y1) * vh);
        var hx = ((x1 + x2) / 2) * vw;
        var hy = ((y1 + y2) / 2) * vh;
        var half = side / 2;
        return {
          x1: Math.max(0, (hx - half) / vw),
          y1: Math.max(0, (hy - half) / vh),
          x2: Math.min(1, (hx + half) / vw),
          y2: Math.min(1, (hy + half) / vh),
          // Native side length, so the caller can decide whether there are
          // enough real pixels to be worth asking about.
          nativePx: side,
        };
      }
      // Asking below FACE_MIN_NATIVE_PX is worse than not asking: the null
      // answer arrives labelled `male` with a score that clears
      // GENDER_MIN_SCORE and therefore counts as CERTAIN — certain enough
      // to condemn a woman or revoke an earned clear, all on zero
      // information. The constant itself lives in gender-verdict.mjs; see
      // the comment there for why a function-local `var` could not.

      function genderFromNativeFace(faceBox) {
        var fr = faceRegionInVideo(faceBox);
        // ABSTAIN rather than guess. 'unknown' is not a third verdict —
        // faceMeta already turns an undirected read into
        // {flagged:true, certain:false}, i.e. exactly the honest state a
        // person with no visible face gets. The subject stays COVERED
        // (blur-first is unchanged); what changes is that an unresolvable
        // face may no longer revoke a clear or poison memory.
        if (fr.nativePx && fr.nativePx < FACE_MIN_NATIVE_PX) {
          // Stamp px on the REFUSAL too. R15 turned this gate on and the
          // artifact promptly lost the very number that justifies it —
          // sixteen reads came back `px: null`, so the next round could
          // not have re-derived the threshold from its own evidence.
          return Promise.resolve([
            { gender: 'unknown', score: 0, age: 0, desc: null, px: Math.round(fr.nativePx) },
          ]);
        }
        // The face box already carries FACE_ENLARGE context; keep it.
        return cropPersonPixels(fr).then(function (fpix) {
          return genderOnPixels(fpix, [{ x1: 0, y1: 0, x2: 1, y2: 1 }])
            .then(function (g) {
              if (fpix && typeof fpix.close === 'function') fpix.close();
              // Stamp the size the model actually saw. R11's critic could
              // not tell whether FACE_MIN_NATIVE_PX was even reachable
              // (no read ever returned 'unknown'); with px on the read
              // that is one number to look at instead of an inference.
              try {
                if (g && g.length && fr && fr.nativePx) {
                  g[0].px = Math.round(fr.nativePx);
                }
              } catch (e) {}
              return g;
            })
            .catch(function (e) {
              if (fpix && typeof fpix.close === 'function') fpix.close();
              throw e;
            });
        });
      }

      // Gender for the person: the LARGEST face gets a native-res crop
      // (the person's own face dominates their region); any additional
      // faces in the crop keep the cheap in-crop read, since they only
      // ever act as a veto on clearing.
      // Which detected face belongs to THIS person: the one whose centre
      // is nearest the MoveNet head anchor (mapped into crop space), and
      // only if it is plausibly close. Without a head anchor (person
      // facing away) fall back to the largest face, which in a crop
      // centred on this person is normally theirs.
      function ownFaceIndex(faces) {
        if (!faces.length) return -1;
        var rw = region.x2 - region.x1;
        var rh = region.y2 - region.y1;
        if (typeof person.headX === 'number' && typeof person.headY === 'number' && rw > 0 && rh > 0) {
          var hx = (person.headX - region.x1) / rw;
          var hy = (person.headY - region.y1) / rh;
          var best = -1;
          var bestD = Infinity;
          for (var i = 0; i < faces.length; i++) {
            var cx = (faces[i].x1 + faces[i].x2) / 2;
            var cy = (faces[i].y1 + faces[i].y2) / 2;
            var fw = faces[i].x2 - faces[i].x1;
            var d = Math.sqrt((cx - hx) * (cx - hx) + (cy - hy) * (cy - hy));
            // Within roughly one face-width of the head keypoint.
            if (d < bestD && d <= Math.max(0.18, fw)) {
              bestD = d;
              best = i;
            }
          }
          if (best !== -1) return best;
          return -1;
        }
        return bestIndex(faces);
      }

      function bestIndex(faces) {
        var bi = 0;
        var ba = 0;
        for (var i = 0; i < faces.length; i++) {
          var a = (faces[i].x2 - faces[i].x1) * (faces[i].y2 - faces[i].y1);
          if (a > ba) {
            ba = a;
            bi = i;
          }
        }
        return bi;
      }

      function classifyBest(faces) {
        var bigIdx = 0;
        var bigArea = 0;
        for (var fi = 0; fi < faces.length; fi++) {
          var fa = (faces[fi].x2 - faces[fi].x1) * (faces[fi].y2 - faces[fi].y1);
          if (fa > bigArea) {
            bigArea = fa;
            bigIdx = fi;
          }
        }
        var ownIdx = ownFaceIndex(faces);
        if (ownIdx !== -1) bigIdx = ownIdx;
        return genderFromNativeFace(faces[bigIdx])
          .then(function (nat) {
            if (faces.length === 1) return nat;
            // The multi-face pass that used to run here was DEAD WORK,
            // verified by reading every consumer (R7 critic F3):
            //   - `all[bigIdx] = nat[0]` overwrote the only element read;
            //   - the caller's `own === -1` branch returns without ever
            //     touching `meta`, and its `faceDesc` pick resolves to
            //     `bigIdx` too (bigIdx defaults to bestIndex);
            //   - the `own !== -1` branch reads `meta[own]`, and bigIdx
            //     was already forced to `own` above.
            // So `nat[0]` was the answer in both branches while a whole
            // extra faceres inference per neighbour face was computed and
            // thrown away — and it fired exactly on crowd and two-shot
            // crops, where the pass is already most expensive.
            //
            // It cannot simply be deleted: the caller indexes this array
            // by `own`, and a SHORT array yields undefined there, which
            // falls back to flagged:true — a silent FALSE COVER of the
            // person we just read. So the array keeps its length and the
            // faces we did not read are filled with what they honestly
            // are: unread. faceMeta turns that into covered-and-uncertain,
            // which is the blur-first default and is never consumed
            // anyway (only the attr probe prints it).
            var out = new Array(faces.length);
            for (var i = 0; i < faces.length; i++) {
              out[i] = i === bigIdx ? nat[0] : { gender: 'unknown', score: 0, age: 0, desc: null };
            }
            return out;
          })
          .catch(function () {
            // Native re-crop failed (taint/unsupported): fall back to
            // the in-crop read rather than losing the verdict.
            return cropGenderReads(faces);
          });
      }

      // A face-derived person ALREADY CARRIES ITS FACE. Re-detecting it in
      // the crop is a whole BlazeFace inference spent re-finding a box we
      // were handed, and it runs at ~2% of the model input where the
      // model's evaluation floor is ~5% (see person-gate's faceBox note),
      // so it frequently fails and costs the track its verdict as well as
      // the time. Map the known box into crop coordinates and hand it
      // straight to the same code path — ownFaceIndex, classifyBest, the
      // descriptor and the reads probe all work unchanged, because the
      // only thing that changed is where the box came from.
      function knownFaceInCrop() {
        var fb = person && person.faceBox;
        if (!fb) return null;
        var rw = region.x2 - region.x1;
        var rh = region.y2 - region.y1;
        if (!(rw > 0) || !(rh > 0)) return null;
        var box = {
          x1: (fb.x1 - region.x1) / rw,
          y1: (fb.y1 - region.y1) / rh,
          x2: (fb.x2 - region.x1) / rw,
          y2: (fb.y2 - region.y1) / rh,
          confidence: typeof person.confidence === 'number' ? person.confidence : 0.5,
        };
        // If the crop does not actually contain it, fall back to detecting
        // rather than handing the models a box outside their own pixels.
        // MOST of it, not a corner (R28 critic F3): the old test passed a
        // box 95% outside the crop, and the head crop this round ships is
        // about an eighth the area of the body crop it replaces, so a
        // faceBox that sat comfortably inside the old one now routinely
        // hangs off the edge. The consequence was not a bad read but a
        // SILENT COVER under the wrong label -- detection is skipped, the
        // off-crop box goes to ownFaceIndex, its centre lands outside
        // [0,1] and the person is hard-covered as `ownMissSkipped`.
        var ix = Math.max(0, Math.min(box.x2, 1) - Math.max(box.x1, 0));
        var iy = Math.max(0, Math.min(box.y2, 1) - Math.max(box.y1, 0));
        var whole = (box.x2 - box.x1) * (box.y2 - box.y1);
        if (!(whole > 0) || ix * iy < whole * 0.5) return null;
        return [box];
      }

      function observeCropped(zpix) {
        zpixRef = zpix;
        var known = knownFaceInCrop();
        var facesP = known
          ? Promise.resolve(known)
          : workerVideo()
            ? (zeng = vid()).cropFaces(zpix).then(function (r) {
                // The crop is now the worker's; `zcid` is how the gender
                // read reaches the same upload.
                zcid = r.cid;
                return r.faces || [];
              })
            : detector.detectFaceBoxes(model, zpix);
        return facesP.then(function (faces) {
          // WHY A TRACK IS COVERED, COUNTED AT THE SOURCE (R23).
          //
          // A 60s continuous trace of rotation entry 5 in `man` mode put
          // 75.7% of all blurred track-samples on `lv:'uncertain'` --
          // i.e. the overwhelming majority of false cover is not a wrong
          // verdict, it is NO VERDICT. But `uncertain` has three
          // completely different producers with three different fixes,
          // and nothing in six rounds of artifacts could tell them apart:
          // the detector found no face in the crop at all; a face was
          // found but none of them belongs to this person; or a face was
          // read and its certainty fell short. Guessing which dominates
          // is how S6 spent a round building the wrong thing.
          //
          // One counter per outcome, on a path that already branches.
          if (!faces.length) {
            bumpLife('personNoFace');
            return obs;
          }
          // NO ATTRIBUTABLE FACE ⇒ DECIDE BEFORE PAYING FOR THE READ.
          //
          // `ownFaceIndex` is pure and reads only `faces` plus this
          // person's head anchor, so its answer is already knowable here.
          // It was being computed at the TOP of classifyBest and again by
          // the caller, with a full faceres inference on a fresh 224px
          // native crop in between -- and when it comes back -1 the
          // caller returns hard-covered without ever reading the result.
          // The probe at the `attr` block measured `own === -1` on 25% of
          // reads, and S9 measured the crop+gender stage at 64 of a
          // verdict pass's 102ms, so that is a quarter of the most
          // expensive stage computed and thrown away -- proportionally
          // worse on a Helio G88, which is the target.
          //
          // It also stops a real defect, not just waste: the discarded
          // path still salvaged `desc` from `bestIndex`, i.e. the LARGEST
          // face in a padded crop that R19 measured as containing more
          // than one face 19 times in 40. On a two-shot that stores the
          // NEIGHBOUR's descriptor on this person's track, which is the
          // one input `identityBroken` trusts.
          if (ownFaceIndex(faces) === -1) {
            bumpLife('ownMissSkipped');
            return { box: person, flagged: true, certain: false, faceFound: true, desc: null };
          }
          var faceDesc = null;
          // THE RAW READS, HOISTED OUT OF THE CLOSURE THEY ARRIVE IN.
          // `genders` is the parameter of the .then below, and that
          // callback CLOSES before the `metaP.then` that builds the
          // observation -- they are siblings, not nested. Reading
          // `genders` from the builder is a ReferenceError, which
          // rejects the whole chain and drops the pass SILENTLY: every
          // face then fails closed to covered, which is a correctly
          // cleared man being blurred. That is exactly the trap the
          // loop-37b note on `mintNoShape` describes, and it was walked
          // into again on 2026-09-01 -- 84 `observeThrew` on 84 reads,
          // caught on a device and not by 461 green tests.
          var genderReads = null;
          var metaP = genderAvailable()
            ? classifyBest(faces).then(function (genders) {
                genderReads = genders;
                // Identity descriptor comes from the natively-cropped
                // primary face (index 0 when it was the only face).
                var ownI = ownFaceIndex(faces);
                var pickI = genders.length > 1 ? (ownI === -1 ? bestIndex(faces) : ownI) : 0;
                var pick = genders[pickI];
                var pickFace = faces[pickI] || null;
                if (pick) faceDesc = pick.desc || null;
                // Calibration probe: the raw model reads behind every
                // verdict, so a CDP run can say WHY someone stays
                // covered (wrong direction vs low certainty vs age).
                // WRAPPED (R22). This block sits directly inside the
                // verdict promise chain: anything that throws in here
                // rejects the verdict for the whole person, and a probe
                // throwing inside this exact chain silently discarded
                // every gender read for two releases. The `slots` probe
                // below has always been guarded; these two were not, and
                // R22 adds fields to both — so they get the guard first.
                try {
                if (pick) {
                  var dbgR = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                  dbgR.reads = dbgR.reads || [];
                  dbgR.reads.push({
                    g: pick.gender,
                    s: Math.round(pick.score * 100) / 100,
                    a: Math.round(pick.age),
                    // Probability MASS under GENDER_ADULT_AGE, not the
                    // mean. `a` and `pc` disagreeing is the R18 finding:
                    // the mean of a bimodal age posterior lands between
                    // its two modes, so a child can read `a: 22` while
                    // most of the mass sits under 18.
                    pc: typeof pick.childP === 'number' ? Math.round(pick.childP * 100) / 100 : null,
                    n: faces.length,
                    // Raw sigmoid and the native face size behind it:
                    // the two numbers R11's critic had to infer.
                    v: typeof pick.raw === 'number' ? Math.round(pick.raw * 1000) / 1000 : null,
                    px: typeof pick.px === 'number' ? pick.px : null,
                    // The person box this read was made for, so a banked read
                    // can be joined to the track that consumed it (1096e).
                    pb: [Math.round(person.x1 * 1000) / 1000, Math.round(person.y1 * 1000) / 1000, Math.round(person.x2 * 1000) / 1000, Math.round(person.y2 * 1000) / 1000],
                    // Was this read REFUSED as the model's prior? Without
                    // it the abstention is invisible in the artifact —
                    // which is exactly how it shipped dead for a round.
                    // isNullRead is pure and type-guarded, so it cannot
                    // throw in here (instrumentation has killed two
                    // releases; it does not get to kill a third).
                    ab: isNullRead(pick) ? 1 : 0,
                    // BlazeFace's own confidence in the box this read came
                    // from. detectFaceBoxes has always returned it and
                    // nothing has ever looked at it; R15's dominant failure
                    // is patches built on faces that are not faces, and the
                    // detector's opinion of them is the one number that
                    // could separate those from small REAL faces without a
                    // second model. Measure before tuning FACE_MIN_CONFIDENCE.
                    fc:
                      pickFace && typeof pickFace.confidence === 'number'
                        ? Math.round(pickFace.confidence * 100) / 100
                        : null,
                    // The region this read came from, so a read can be
                    // JOINED to a patch. Fifteen rounds of artifacts have
                    // carried reads and patches side by side with no way to
                    // say which produced which — R15's f007 has one read at
                    // score 0.97, above GENDER_INSTANT_CLEAR, and a man
                    // covered anyway, and the artifact cannot say whether
                    // those are the same person.
                    b: [
                      Math.round(region.x1 * 1000) / 1000,
                      Math.round(region.y1 * 1000) / 1000,
                      Math.round(region.x2 * 1000) / 1000,
                      Math.round(region.y2 * 1000) / 1000,
                    ],
                    // THE TWO FREE NULL TESTS NOBODY HAS EVER LOOKED AT
                    // (R22). `nm` is the faceres descriptor's magnitude
                    // before L2-normalisation; `ab`/`v` already carry the
                    // 1-D null test on the gender sigmoid, and R11
                    // measured that band at a 1-D gap of 0.035 — too thin
                    // to threshold alone, which is why an orthogonal one
                    // matters. `ap` is the age posterior's SHAPE
                    // (peak bin / peak mass / entropy) beside its mean;
                    // the mean demonstrably does NOT separate a graphic
                    // from a face (title-card reads age 33-56 against a
                    // real man's 33-45, fully overlapping). Both are
                    // computed inside loops that already run.
                    nm:
                      pick.shape && typeof pick.shape.norm === 'number'
                        ? Math.round(pick.shape.norm * 100) / 100
                        : null,
                    ap: pick.shape
                      ? [
                          pick.shape.ageBin,
                          Math.round(pick.shape.ageMass * 1000) / 1000,
                          Math.round(pick.shape.ageEnt * 100) / 100,
                        ]
                      : null,
                  });
                  if (dbgR.reads.length > 300) dbgR.reads.shift();
                }
                } catch (e) {}
                return faceMeta(userGender, genders);
              })
            : Promise.resolve(
                faces.map(function () {
                  return { flagged: true, certain: false };
                })
              );
          return metaP.then(function (meta) {
            // ONE face decides this person: the one at their head.
            // Neighbours' faces routinely land in the same padded crop
            // (measured 2026-08-25: 2-3 faces per crop in a two-shot),
            // and the old "any flagged face flags the person" rule made
            // a confidently-male adult permanently blurred whenever a
            // covered person stood beside him. Each neighbour has their
            // OWN person track and is covered by it — vetoing here
            // covered the wrong people, it never added protection.
            var own = ownFaceIndex(faces);
            // WRAPPED (R22), same reason as the `reads` probe above: this
            // is inside the verdict chain, and `hx`/`hy` below divide by
            // `region.x2 - region.x1` with no positive guard while the
            // `d` IIFE right beneath them has one. `own` is read AFTER
            // the block, so the guard must not swallow its assignment.
            try {
            var dbgA = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
            dbgA.attr = dbgA.attr || [];
            dbgA.attr.push({
              own: own,
              nf: faces.length,
              // CROP-SPACE, which is the space ownFaceIndex actually
              // compares in. R18's critic caught this logging person.headX
              // in FRAME coordinates against face centres in CROP
              // coordinates, so the artifact could not check a single one
              // of the function's decisions — an example from that run
              // read `hx 0.62` against a face centre `0.65`, an apparent
              // distance of 0.036 against a 0.18 floor, which "should"
              // have matched and did not, because the two numbers were
              // not in the same space. `own === -1` hard-returns a
              // covered verdict and ran at 25% of reads, so this is a
              // first-order FALSE COVER source that has been unauditable
              // for two rounds.
              hx: person.headX === null ? null : Math.round(((person.headX - region.x1) / (region.x2 - region.x1)) * 100) / 100,
              hy: person.headY === null ? null : Math.round(((person.headY - region.y1) / (region.y2 - region.y1)) * 100) / 100,
              fc: faces.map(function (f) {
                return [
                  Math.round(((f.x1 + f.x2) / 2) * 100) / 100,
                  Math.round(((f.y1 + f.y2) / 2) * 100) / 100,
                ];
              }),
              // The DECISION, not just its inputs: distance to each face
              // and the bar that face was judged against. R19's queue
              // asks the next round to recompute `d` and a proposed
              // `0.5 * fw` for every attr row and confirm that every
              // currently-correct attribution survives before narrowing
              // the tolerance. That cannot be done from centres alone —
              // the bar is per-CANDIDATE (`max(0.18, fw)` uses the
              // candidate face's own width), which is the suspected
              // defect, so it has to be recorded per candidate.
              d: (function () {
                if (person.headX === null || person.headY === null) return null;
                var rw = region.x2 - region.x1;
                var rh = region.y2 - region.y1;
                if (!(rw > 0) || !(rh > 0)) return null;
                var qx = (person.headX - region.x1) / rw;
                var qy = (person.headY - region.y1) / rh;
                return faces.map(function (f) {
                  var cx = (f.x1 + f.x2) / 2;
                  var cy = (f.y1 + f.y2) / 2;
                  return [
                    Math.round(Math.sqrt((cx - qx) * (cx - qx) + (cy - qy) * (cy - qy)) * 1000) / 1000,
                    Math.round(Math.max(0.18, f.x2 - f.x1) * 1000) / 1000,
                    Math.round((f.x2 - f.x1) * 1000) / 1000,
                  ];
                });
              })(),
              meta: meta.map(function (m) {
                return (m.flagged ? 'F' : 'c') + (m.certain ? '!' : '?');
              }),
            });
            if (dbgA.attr.length > 120) dbgA.attr.shift();
            } catch (e) {}
            if (own === -1) {
              // BACKSTOP. observeCropped now answers this before paying
              // for the read, so this branch is reachable only if
              // ownFaceIndex were non-deterministic over the same
              // `faces`. Kept because the failure mode if it ever is
              // would be an unattributed read clearing somebody.
              return { box: person, flagged: true, certain: false, faceFound: true, desc: faceDesc };
            }
            var mine = meta[own] || { flagged: true, certain: false };
            // The read HAPPENED and was attributed -- so this is the one
            // place that can say what the evidence actually was. See the
            // note at `personNoFace`. `readClearCertain` is the only
            // outcome of the four that can ever lift a patch.
            bumpLife(
              !mine.flagged && mine.certain
                ? 'readClearCertain'
                : mine.abstained
                  ? 'readAbstain'
                  : mine.certain
                    ? 'readFlagCertain'
                    : mine.weak
                      ? 'readWeak'
                      : 'readUncertain'
            );
            var obsOut = {
              box: person,
              flagged: mine.flagged,
              certain: mine.certain,
              // One read confident enough to clear on its own — see
              // GENDER_INSTANT_CLEAR. Never set on the flag side.
              instant: !!mine.instant,
              // The model answered from its prior rather than from the
              // face (isNullRead). person-track needs to tell this apart
              // from a weak directional read, because a cleared track
              // absorbs `uncertain` for CLEARED_TTL_MS while an
              // abstention revokes it in two.
              //
              // THIS LINE IS THE WHOLE FIX. R12 shipped the abstention
              // and both consumers, and this builder copied three fields
              // and silently dropped the fourth — so the branch in
              // person-track was unreachable and `abstainDemote` never
              // appeared in any run. The unit tests passed throughout
              // because they hand `abstained` straight to
              // updatePersonTracks and never cross this boundary. When
              // you add a verdict field, add it HERE too, and prove it
              // with a life counter in a real run, not with a test.
              abstained: !!mine.abstained,
              // WHICH KIND OF ABSTENTION. person-track's clear grace
              // refuses every abstention because ONE of them is a child,
              // and a grace for children is exactly what must not exist.
              // The other kind is a face we simply could not read, which
              // is the situation the grace already forgives. Carried
              // here, per the warning above, because a builder that
              // drops a field makes its consumer unreachable and the
              // unit tests hand observations straight to
              // updatePersonTracks. `clearGraceNull` is its counter.
              childAbstain: !!mine.childAbstain,
              // Weak same-direction evidence (S6). Added HERE at the same
              // time as its producer and consumer, per the warning above:
              // R12 shipped `abstained` in gender-verdict and person-track
              // and forgot this line, so the branch was unreachable for
              // two releases and no unit test could see it. `weakClear` is
              // its life counter — if it never appears in a run, this
              // line is the first place to look.
              weak: !!mine.weak,
              // MAY THIS READ CREATE A PATCH? (see faceMeta's null
              // branch.) Copied here for the same reason `abstained` is:
              // the builder that drops a field makes its consumer
              // unreachable, and a green suite cannot see that because
              // the unit tests hand observations straight to
              // updatePersonTracks. `nullDropped` is the counter that
              // proves this line is alive in a real run.
              nullMint: !!mine.nullRead,
              // DID THIS CROP CARRY DESCRIPTOR SIGNAL? Read from the raw
              // gender read, not from `mine`, because faceMeta answers
              // about the VERDICT and this is a question about the
              // evidence. clampBodies uses it to decide who may push a
              // neighbour's patch edge back, and a graphic that reads
              // clear must never be allowed to -- measured on the
              // RcGyVTAoXEU stage, where a projected backdrop graphic is
              // detected as a face, reads clear, and pulls the speaker's
              // patch off her side.
              //
              // Added HERE and not only in body-clamp, per the warning
              // on `abstained` above: a builder that drops a field makes
              // its consumer unreachable and no unit test can see it.
              // `clampFired` is the life counter that proves it alive.
              // THE RAW GENDER SIGMOID (P(male)), for GENDER_TRACK_MEAN.
              // person-track averages these across a track's reads and
              // re-derives the verdict from the mean; `score` cannot be
              // averaged in its place because it is folded around 0.5
              // and has already thrown the direction away.
              //
              // Added HERE and not only in person-track, per the warning
              // on `abstained` above: a builder that drops a field makes
              // its consumer unreachable and no unit test can see it,
              // because the tests hand observations straight to
              // updatePersonTracks. `trackMean` is the life counter that
              // proves this line is alive in a real run.
              raw:
                genderReads &&
                genderReads[own] &&
                typeof genderReads[own].raw === 'number'
                  ? genderReads[own].raw
                  : null,
              signal: hasDescriptorSignal(genderReads && genderReads[own]),
              faceFound: true,
              desc: faceDesc,
            };
            // IDENTITY OUTLIVES THE TRACK. See identity-memory.mjs for
            // why this exists and why R13's version is not being
            // rebuilt: over the 482 frames a man is covered on the
            // corpus, the covering track changes 260 times and a track
            // is born blurred, so an earned clear cannot survive to the
            // pass that would confirm it.
            //
            // Applied AFTER the observation is built rather than inside
            // faceMeta, because faceMeta answers about THIS READ and
            // this is a question about the subject across reads. It can
            // only ever move an observation toward CLEAR, so it cannot
            // add coverage 1081 did not have.
            var memRead = genderReads && genderReads[own];
            // A READ THAT CARRIED NO SIGNAL IS NOT AN ANSWER.
            // MEASURED LIVE ON HIS PHONE (1082, 116 reads, one face per
            // read, px p50 140, face confidence p50 0.80): faceres'
            // descriptor magnitude alternates on the SAME subject --
            // 11.0, 1.1, 3.8, 11.0, 0.2, 0.2, 0.3, 6.5 -- with 57 flips
            // in 116 reads and 42% under NULL_MINT_NM_FLOOR. The two
            // populations are indistinguishable on size, confidence,
            // frame position and edge contact, and every low one reads
            // v~0.62 age~37, which is this model's PRIOR. That is an
            // execution failure on his GPU, not a property of the
            // picture; the corpus decodes frames from files and almost
            // never reproduces it.
            //
            // Until 1083 such a read ABSTAINED, and an abstain is an
            // EVENT: it fails closed and it REVOKES an earned clear
            // (abstainStreak). So a man who had been correctly cleared
            // was re-covered by a read containing nothing, twice a
            // second, which is the flicker he reports as "messy" and
            // "the blur stays up longer".
            //
            // Inert is not the same as dropped, and the difference is
            // the loop-37b defect: a DROPPED observation lets a blurred
            // track coast to death and uncovers somebody. positionOnly
            // still moves the box and still refreshes the track -- it
            // simply carries no verdict, so blurred stays blurred and
            // cleared stays cleared. An UNMATCHED one still births, and
            // newTrack starts BLURRED, so a new subject is covered.
            //
            // The corpus cannot price this (it is device-only) but it
            // does prove it harmless: exposure 82.0s -> 81.0s, false
            // cover unchanged at 218.0s in man mode, unchanged in woman
            // mode. `noSignalInert` is the counter that proves it alive
            // in a real run.
            if (mine.abstained && !hasDescriptorSignal(memRead)) {
              obsOut.positionOnly = true;
              obsOut.abstained = false;
              obsOut.certain = false;
              obsOut.instant = false;
              obsOut.weak = false;
              bumpLife('noSignalInert');
            }
            if (
              askIdentity(identityMem, faceDesc, {
                readClear: !mine.flagged && mine.certain,
                certainOpposite: mine.flagged && mine.certain,
                // Not "is it certain" -- just "does it point our way".
                leansOwn: !!memRead && (userGender === 'man'
                  ? memRead.raw >= 0.5
                  : memRead.raw < 0.5),
                hasSignal: hasDescriptorSignal(memRead),
                need: trustNeeded(userGender),
              })
            ) {
              obsOut.flagged = false;
              obsOut.certain = true;
              obsOut.abstained = false;
              obsOut.weak = false;
              // The shipped escape person-track already honours: clear a
              // blurred track without waiting out CLEAR_STREAK_N, which
              // is the requirement the churn makes unreachable.
              obsOut.instant = true;
              // AND IT MAY PUSH A NEIGHBOUR'S PATCH EDGE BACK.
              // clampBodies only lets `flagged === false && signal ===
              // true` push, and `signal` is this read's descriptor
              // magnitude -- which on his phone is absent 36-42% of the
              // time (see the noSignalInert note above). So the man
              // standing next to her could not push her patch off his
              // own face on the very passes where the model failed,
              // which is measured: bodyClampFired 2-3 in 75 seconds
              // while her body box spanned x 0.371-0.916 and his head
              // sat at x 0.463, inside it.
              //
              // A REMEMBERED identity is not a graphic: it is trusted
              // only after `need` reads that each carried nm >=
              // NULL_MINT_NM_FLOOR, so the signal requirement is
              // satisfied by its history rather than by this one
              // inference. That is exactly the evidence the guard was
              // asking for, and the guard exists to stop a projected
              // graphic pushing an edge -- a graphic never accumulates
              // trusted clears.
              obsOut.signal = true;
              bumpLife('memClear');
            }
            return obsOut;
          });
        });
      }
    }

    // Cross-origin video with no CORS taints the canvas: getImageData
    // throws SecurityError on EVERY frame, forever — no header we can
    // set from this side changes that (Reddit v.redd.it, X twimg). A
    // video we can never analyse must fail OPEN, not stay blurred: the
    // user chose to play it, and "the post you chose to open plays
    // normally" is the Stage A contract Stage B may not break
    // (review 2026-08-19).
    function giveUp(reason, err) {
      if (dead) return;
      dead = true;
      stop();
      delayDetach();
      clearEl(video);
      videoRegion.clear(video);
      regionActive = false;
      videoTracks = [];
      heldPersons = [];
      lastPassAt = 0;
      identityMem = createIdentityMemory();
      // eslint-disable-next-line no-console
      console.warn('tamescroll gaze: video unreadable, failing open (' + reason + ')', err);
    }

    // A DUTY-CYCLE GOVERNOR, NOT A GUESS. (owner 2026-08-27: "the
    // YouTube app still feels sluggish and not like how it generally
    // feels")
    //
    // FIRST REAL NUMBER THIS PROJECT HAS FOR A SLOW DEVICE. The dev app
    // was CPU-throttled 6x through CDP -- the conventional low-end-mobile
    // factor, and it throttles the MAIN THREAD, which is exactly the
    // resource our pipeline and YouTube's lazy comment/related callbacks
    // compete for. 30s of playback, same page, same video position, the
    // in-player pill as the A/B:
    //
    //   blur ON : 137 long tasks, 19,769ms of them, worst single 2,329ms
    //   blur OFF: 0 long tasks
    //
    // Two thirds of wall-clock with the main thread blocked. That is the
    // whole complaint, and it is ours, not YouTube's.
    //
    // The old multiplier was 1.5, i.e. "spend up to 67% of the main
    // thread on inference for ever". That is a fine rule for a machine
    // that finishes a pass in 25ms and a catastrophic one for a machine
    // that takes 150ms, because the SAME fraction of a much scarcer
    // thread is what the user feels. A duty cycle states the budget
    // directly: a pass may occupy at most 1/DUTY of the time until the
    // next one.
    //
    // ASYMMETRIC ON PURPOSE, because the two passes carry different
    // risk. The POSITION pass is what discovers a new person, and
    // blur-first means discovery is the only step that can leave someone
    // uncovered -- so it keeps the tighter budget (50%). The VERDICT
    // pass only decides whether someone already covered may be CLEARED;
    // stretching it makes people stay blurred slightly longer, which is
    // the safe direction by definition. Its ceiling is raised to 2s for
    // the same reason: on a device where a verdict costs 600ms, the old
    // 1s cap meant verdicts ran back-to-back with no gap at all.
    // THE HARD BUDGET, and it is the one that actually binds.
    //
    // The two duty multipliers below are per-pass-TYPE, and the first
    // throttled re-measurement showed why that is not enough: a verdict
    // pass records into lastVerdictMs, which gates only the zoom
    // interval, so its cost never widened the outer gate at all (review
    // A11 split them deliberately, to stop one expensive verdict
    // throttling the cheap position passes to 1Hz). The result was that
    // halving the position duty moved total blocked time 19,769 ->
    // 19,160ms out of 30,000: nothing, because position passes were
    // never what was spending it.
    //
    // So the budget is enforced on the RESOURCE rather than on either
    // pass: how many milliseconds of main thread has the pipeline used
    // in the last second, whoever used them. Above the share, the next
    // pass waits. This bounds the number the owner is feeling -- 66% of
    // wall-clock blocked -- directly, on any device, without either
    // pass type having to know about the other.
    //
    // 0.35 leaves roughly two thirds of the thread to YouTube, which is
    // what has to be true for its lazy comment and related-rail
    // callbacks to run while he scrolls. On this desktop a pass costs
    // ~25ms against a 120ms floor (~20%), so the budget never binds and
    // desktop behaviour is unchanged by construction.
    var POSITION_DUTY = 2;
    var POSITION_MAX_INTERVAL_MS = 1000;
    // VERDICT_MAX_INTERVAL_MS and VERDICT_DUTY both live in cadence.mjs
    // and are READ FROM THERE at every use, not copied here. They are on
    // the OTA tuning channel, and a closure copy taken at attachVideo
    // time would freeze whatever the value was when this video was
    // attached -- so a pushed number would apply to the next video and
    // not this one, which is exactly the silent half-applied state the
    // channel must never produce.

    // See the yield block inside sampleOnce.
    var INPUT_YIELD_MAX = 3;
    var inputYields = 0;
    function inputPending() {
      try {
        var sch = navigator.scheduling;
        return !!(sch && typeof sch.isInputPending === 'function' && sch.isInputPending());
      } catch (e) {
        return false;
      }
    }

    function sampleOnce() {
      if (failed || dead || video.paused || document.hidden) return;
      if (isPlayer && !playerBlurOn) return;
      // A FEED PREVIEW DURING A SCROLL IS NOT WORTH A PASS. m.youtube
      // plays its feed previews into the SHARED player, so scrolling the
      // home feed paid for the entire video pipeline -- person model,
      // repeated passes, an overlay loop pinned to a player that is
      // itself moving -- on top of judging every thumbnail going by.
      // The owner feels it as the finger catching (2026-08-29: "when I
      // touch the finger, it acts like there's something that was
      // stopped"), and named the control himself: "recommendation page
      // is much nicer to scroll through" -- the watch page's list plays
      // no previews.
      //
      // Blur-first is what makes this safe: the preview is covered
      // WHOLE for as long as the scroll lasts, so nothing is exposed,
      // and the pass that narrows it to patches runs the moment the
      // finger stops.
      if (isPlayer && feedPreview() && scrolling(performance.now())) {
        if (useRegionVideo) coverVideo();
        return;
      }
      // Same rule as the image drain: verdicts handed out before the
      // gender load settles are presence-only — for video that is a
      // few wrongly-blurred seconds rather than a permanent flag, but
      // the pending blur already covers the wait, so just wait.
      if (!videoModelsReady()) return;
      var now = performance.now();
      // Scene gate first: a hard cut zeroes lastSample/lastZoomAt so
      // the checks below let this very call through at full depth.
      if (isPlayer) gateTick(now);
      var floor = sampleInterval;
      if (isPlayer && sceneState === 'static' && !anyBlurredTrack()) {
        // Nothing changing on screen and nothing mid-verdict: ~1Hz
        // safety-net cadence (plan-blur-v2 Stage 1).
        floor = sceneGate.STATIC_INTERVAL_MS;
      }
      // 2x/3x playback compresses on-screen motion into less wall time
      // (owner edge-case ask): tighten the cadence proportionally so
      // patch lag doesn't scale with playback speed. The adaptive
      // pass-cost throttle still wins on slow devices.
      var rate = isPlayer && video.playbackRate > 1 ? Math.min(3, video.playbackRate) : 1;
      // WHEN POSITIONS ARE BEING SKIPPED, lastPassMs IS FROZEN AND MUST
      // NOT DRIVE THE FLOOR (phase-i critic I11). Once personsLive() is
      // false the gate below refuses every position pass on this video
      // for good, so lastPassMs's one write site (the .finally below)
      // goes silent -- it freezes at whatever a position pass happened
      // to cost before the back-off, a race between 0 (never ran one)
      // and a real MoveNet cost. The old expression fed that frozen
      // value straight into `Math.max(floor / rate, lastPassMs *
      // POSITION_DUTY)`, which is `0 * POSITION_DUTY` on a fresh video
      // that backed off before its first position pass completed.
      // Explicit now: no live position-pass cost to throttle from means
      // the floor IS the design ceiling, not an unrecorded race.
      var effInterval = isPlayer
        ? (personsLive()
            ? Math.min(POSITION_MAX_INTERVAL_MS, Math.max(floor / rate, lastPassMs * POSITION_DUTY))
            : POSITION_MAX_INTERVAL_MS)
        : sampleInterval;
      // WHILE THE PAGE IS MOVING, GET OUT OF THE WAY.
      //
      // MEASURED, and it is the owner's complaint verbatim. Under a 6x
      // main-thread throttle, scrolling a watch page down to the
      // comments: first comment thread renders at 7.1s with blur on and
      // 2.2s with it off, and reaching 40 threads takes 38.2s against
      // 2.2s. Seventeen times slower, on the interaction he does most.
      // isInputPending alone does not cover this -- it is false in the
      // gaps BETWEEN scroll events, which is exactly when YouTube's
      // IntersectionObserver and fetch callbacks want to run.
      //
      // So a scroll puts the pipeline in a slow lane for a moment after
      // the last event. Not off: a person newly on screen must still be
      // covered, and the position pass is the cheap one that does that.
      // What stops is the EXPENSIVE half -- crops, gender, descriptor --
      // whose only job is deciding whether someone already covered may
      // be CLEARED. Deferring that keeps people blurred slightly longer,
      // which is the safe direction, and it costs nothing visible
      // because the patches keep tracking throughout.
      if (isPlayer && scrolling(now)) effInterval = Math.max(effInterval, SCROLL_INTERVAL_MS);
      // THE VERDICT CLOCK (hoisted above the position gate, 2026-09-02).
      // effZoom is the interval the verdict pass runs on:
      // min(VERDICT_MAX_INTERVAL_MS, max(ZOOM_INTERVAL_MS, lastVerdictMs *
      // VERDICT_DUTY)). It used to be computed BELOW `now - lastSample <
      // effInterval`, so a verdict could only START at a position slot
      // -- every effInterval (lastPassMs * POSITION_DUTY, ~540ms on the
      // Redmi with the native engine) from the last pass. Measured, 1093:
      // verdict cost p50 431-474ms asks for effZoom 862-948 and the gap
      // read 1189-1213; VERDICT_DUTY 1.5 (effZoom 711) read 1180 -- the
      // duty dial moved the gap 3% because the verdict waited for the
      // slot after the one it missed. A DUE verdict now starts on the
      // first sampler tick (120ms) it is not busy, regardless of the
      // position interval; position passes keep their own interval.
      var effZoom = Math.min(cadence.VERDICT_MAX_INTERVAL_MS,
        Math.max(ZOOM_INTERVAL_MS, lastVerdictMs * cadence.VERDICT_DUTY));
      if (isPlayer && scrolling(now)) effZoom = Math.max(effZoom, cadence.VERDICT_MAX_INTERVAL_MS);
      // A STILL SCENE WITH NOTHING COVERED RELAXES THE EXPENSIVE CLOCK
      // (1106). `static` has reached `floor` above -- the POSITION pass
      // -- since blur-v2, and never this one, so a locked-off shot ran
      // crop+gender at full rate. Deliberately ABOVE the cap: the cap
      // bounds how long a MOVING scene may go unread, and this is the
      // case where nothing is moving. Same `!anyBlurredTrack()` gate as
      // the position floor, and see cadence.mjs for why that gate stays.
      if (isPlayer && cadence.STATIC_VERDICT_MS > 0 && sceneState === 'static'
        && !anyBlurredTrack()) {
        effZoom = Math.max(effZoom, cadence.STATIC_VERDICT_MS);
      }
      var verdictDue = isPlayer && !verdictBusy && now - lastZoomAt >= effZoom;
      if (now - lastSample < effInterval && !verdictDue) return;
      if (sampling) return;
      // The rolling main-thread budget (see SPEND_BUDGET_FRAC). Checked
      // AFTER the interval so a cheap device never pays for the lookup.
      if (isPlayer) lastPlayerPassAt = now;
      if (isPlayer && overBudget(now)) return;
      // YIELD TO THE FINGER. (owner 2026-08-26: "the page loads a lot and
      // the comments or the below recommendation do not load ... just the
      // loading icon on the page which makes it feel very sluggish")
      //
      // Measured on desktop, this is NOT request blocking: every YouTube
      // endpoint the watch page needs -- /youtubei/v1/next included --
      // returns false from should_block_request, and scrolling the live
      // dev app loads 20 then 40 comment threads normally. What the owner
      // sees on a Helio G88 is main-thread starvation. YouTube's comments
      // and related rail are lazy: an IntersectionObserver fires, a fetch
      // resolves, a callback renders. Every one of those is a task, and a
      // verdict pass that costs 100ms here costs several hundred there,
      // issued every 400ms. The spinner is those callbacks queued behind
      // our inference.
      //
      // A pass is never urgent to the millisecond -- the tracker
      // interpolates between them and blur-first keeps every existing
      // patch exactly where it is while we wait. A scroll gesture IS
      // urgent, because the user is looking at it. So when the scheduler
      // says input is waiting, hand the thread back.
      //
      // BOUNDED, because a busy page could otherwise keep input pending
      // for ever and starve the pipeline into a permanently stale patch:
      // at most INPUT_YIELD_MAX consecutive skips, after which the pass
      // runs regardless. Feature-detected -- isInputPending is Chromium
      // only, and its absence simply means no yielding.
      if (inputPending()) {
        if (inputYields < INPUT_YIELD_MAX) {
          inputYields++;
          return;
        }
      }
      inputYields = 0;
      lastSample = now;
      sampling = true;
      var myEpoch = passEpoch;

      // PERSON-PRIMARY player path (redesign 2026-08-24): MoveNet finds
      // the persons, each person's native-res crop decides their gender,
      // the tracker + state machine decide the patches. ONE pass, one
      // cadence — the person is the unit of blur, the face only reads
      // gender, and non-persons never enter the pipeline (the entire
      // phantom class the old gates chased is excluded by construction).
      if (useRegionVideo && (workerVideo() || personModel)) {
        // CAPPED, like the position pass above (R28 critic S2). This
        // line had no Math.min while `effInterval` has had one at 1000ms
        // since Stage 1, and the asymmetry is self-sustaining: three
        // persons each hitting VERDICT_TIMEOUT_MS 900 make lastVerdictMs
        // 2.7s, which sets the next gap to 4.05s, and every blurred
        // track holds for all of it. Desktop never sees it (p50 ~100ms
        // parks this at the floor); a Helio G88 at 3-4x that cost is one
        // hiccup away from the runaway. verdictBusy already forbids
        // overlapping passes, so a cap cannot build a backlog.
        // effZoom is computed above the position gate now (a due verdict
        // starts on any tick); the scroll clamp rides with it. Never a
        // second verdict pass while one is still running: one GPU queue,
        // and a backlog is indistinguishable from a hang.
        var wasVerdict = !verdictBusy && now - lastZoomAt >= effZoom;
        // A POSITION PASS WHERE MoveNet IS NOT LIVE IS 511ms OF NOTHING.
        // Measured on the arm64 Redmi 2026-09-02: 31 of 66 passes were
        // position passes, every one 511ms of MoveNet admitting nobody
        // (all twelve slots n:0, his regime), yielding zero observations
        // while a verdict waited on the same GPU queue. Patches keep
        // riding the renderer's velocity between verdicts exactly as
        // they did, because those passes never moved a track here.
        if (isPlayer && !wasVerdict && !personsLive()) {
          bumpLife('positionPassSkipped');
          sampling = false;
          return;
        }
        if (wasVerdict) {
          verdictBusy = true;
          setTimeout(function () {
            verdictBusy = false;
          }, VERDICT_STALL_MS);
        }
        try {
          // ONE upload for both detectors when they read the same source.
          // On the fast path (directPersonOk) the person pass and the
          // full-frame face pass are both handed this <video> element, and
          // each used to upload it separately -- ~8.3MB twice per verdict
          // pass at 1080p. Only shared when the sources are IDENTICAL: with
          // directPersonOk false the person pass reads a 256px ImageData
          // and the face pass reads the video, which are different pixels
          // and must stay two uploads.
          // STAGE TIMING (measurement only). The verdict pass is p50
          // 109ms on this desktop against a position pass at 27ms, and
          // every optimisation proposal so far has guessed at where that
          // goes. Marks are cheap (performance.now), guarded, and never
          // touch control flow.
          var stageT0 = performance.now();
          var stage = {};
          function mark(name) {
            try {
              stage[name] = Math.round(performance.now() - stageT0);
            } catch (e) {}
          }
          // See noteSpend below: everything this pass spends waiting on
          // the worker belongs to the worker, not to the main-thread
          // budget. Baseline taken before the first request goes out.
          // Bound to ONE engine (phase-j J8): each client keeps its own
          // cumulative wait, so a baseline from one and a delta from the
          // other would charge or forgive a pass by their difference.
          var waitEng = workerVideo() ? vid() : null;
          var waitBase = waitEng ? waitEng.waitMs() : null;
          var sharedFrame = null;
          var frameDone = false;
          var releaseFrame = function () {
            if (frameDone) return;
            frameDone = true;
            detector.disposeFrame(sharedFrame);
            sharedFrame = null;
          };
          // The full-frame face pass, when this pass asked for one. It
          // shares the person pass's single upload -- in page that was
          // always true and is why the two are paired; over the worker
          // it is also why they are ONE message.
          var passFaces = null;
          runPass(wasVerdict, mark, function (f) {
            sharedFrame = f;
          })
            .then(function (r) {
              passFaces = r.faces;
              return r.persons;
            })
            .then(function (persons) {
              mark('persons');
              // How many people this pass had to crop. The crop+gender
              // stage is 64 of a verdict pass's 102ms (S9), and whether
              // that scales with the person count decides whether
              // ZOOM_MAX_PERSONS is the phone lever or a red herring.
              try {
                stage.n = persons.length;
              } catch (e) {}
              // Probe-visible pass marker (verification probes read this).
              window.__TS_GAZE_PERSONS = persons.length;
              // Hysteresis input for the NEXT pass. Stamped from the
              // admitted set only, so a person the gate refused this pass
              // cannot hold themselves open on the next one.
              // EPOCH-GUARDED. A discontinuity (cut / seek / loadstart)
              // clears heldPersons, but a pass already in flight resolves
              // AFTER that and would put the pre-discontinuity people
              // straight back — letting a person who is no longer there
              // hold a post-cut noise slot open for up to PERSON_HOLD_MAX
              // passes, which renders as a GHOST. Same rule the
              // observation path applies below at `myEpoch !== passEpoch`.
              heldPersons = myEpoch === passEpoch ? persons : [];
              // Raw slot scores BEFORE our gates, so a "zero persons"
              // wide shot can be attributed: model blind, or our own
              // floor discarding a real detection. Wrapped because a
              // probe must never be able to throw inside the pipeline.
              try {
                var dbgS = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                if (!dbgS.slots) dbgS.slots = [];
                dbgS.slots.push({
                  n: persons.length,
                  // How many of those were admitted by the R17 hysteresis
                  // rather than by the ordinary floor, and the oldest
                  // hold age. A hold that never fires is dead code; one
                  // that pins at PERSON_HOLD_MAX is a latch. Neither is
                  // visible from `n` alone.
                  hd: persons.filter(function (q) { return (q.hold || 0) > 0; }).length,
                  ha: persons.reduce(function (m, q) { return Math.max(m, q.hold || 0); }, 0),
                  // score / confident-at-0.3 / MAX keypoint / count-at-0.15
                  // / box height. The last two are R14's question: a slot
                  // reading `confident 0` is ambiguous between "MoveNet
                  // saw nothing" and "MoveNet saw a wrist at 0.28 and the
                  // threshold ate it", and those want opposite fixes.
                  raw: lastSlotDiag.map(function (s) {
                    return (
                      s.score +
                      '/' + s.confident +
                      '/' + s.maxKp +
                      '/' + s.nKp15 +
                      '/' + s.h +
                      // R18: the ANCHOR's own evidence. `confident` says
                      // how many keypoints cleared 0.3; hk/sk say whether
                      // the ones the anchor actually requires did. A
                      // back-turned child fails on these two and on
                      // nothing else.
                      '/' + s.hk +
                      '/' + s.sk +
                      // R22: WHICH keypoints were confident, as a
                      // bitmask, so a round can ask whether a slot's
                      // evidence is an anatomical set or scattered
                      // letterform hits. `confident` is only a count.
                      '/' + s.kb +
                      '/' + (s.b ? s.b.join(',') : '') +
                      // R20: the confident-keypoint hull beside the model
                      // box, so a round can finally attribute an over-wide
                      // patch to one or the other.
                      '/' + (s.k ? s.k.join(',') : '') +
                      // R28: the three rungs of the headW ladder measured
                      // on the SAME slot, so the shoulder rung's constant
                      // can be derived from our own footage instead of an
                      // anthropometry table. Empty when that pair is not
                      // confident, which is itself the answer.
                      '/' + (s.hwE === null ? '' : s.hwE) +
                      '/' + (s.hwY === null ? '' : s.hwY) +
                      '/' + (s.hwS === null ? '' : s.hwS)
                    );
                  }),
                });
                if (dbgS.slots.length > 40) dbgS.slots.shift();
              } catch (e) {}
              // Position observations are free — track ALL persons
              // (review A8: slicing position passes to 3 let a 4th
              // flagged person's track starve and expire). Only the
              // crop/gender work is capped, highest-confidence first.
              // THE CROP BUDGET WAS A PERMANENT RANKING, NOT A BUDGET.
              //
              // Measured, gauntlet R24, runs/r24-woman (graduation stage,
              // `woman` mode, SIX MoveNet persons, no cut in 15s). The
              // slot scores were W1 0.399, speaker 0.324, W3 0.236, W4
              // 0.140, M1 0.127, M2 0.091 -- and on a locked-off shot
              // those scores barely move, so `sort(cropPriority)` returns
              // the SAME order every pass and `slice(0, 3)` hands the
              // crops to the SAME three people forever. Ranks 4, 5 and 6
              // were never read at all: tracks 15 and 16 held `cs:0`,
              // `cm:0`, `lv:'uncertain'` for the entire window while
              // `readClearCertain` was 33, all of it landing on the two
              // people who were already cleared. Blur-first then covers
              // the starved three permanently -- two of them women, in
              // woman mode, which is FALSE COVER on 10 of 10 frames.
              //
              // This is R18's lesson one level up. R18 fixed WHO the sort
              // compares (skeletal vs synthetic are not one scale); it
              // left in place the assumption that a sort can decide a
              // budget at all. It cannot: confidence says who will give
              // the BEST read, never who NEEDS one, and the person who
              // needs one is by definition the person who has not had one.
              //
              // The crowd path 200 lines below already rotates for
              // exactly this reason -- but it only runs when the face
              // fallback pushes `all` past the budget, and here all six
              // faces sit inside person boxes, so no synthetic is minted
              // and that rotation never fires. Same defect, same fix,
              // applied to the list that actually gets sliced.
              //
              // Ordering within the pass is still by confidence; the
              // cursor only chooses WHERE in that order the window
              // starts. Below the budget nothing changes at all, so every
              // one/two/three-person round already scored is untouched.
              //
              // Direction of risk: everyone is read HALF as often on a
              // six-person shot, so a cleared person is revoked one pass
              // later. That is bounded by the verdict cadence and it is
              // the safe side of the trade -- an unread person stays
              // COVERED under blur-first, which is what starvation was
              // already doing to three people permanently.
              var byConf = persons.slice().sort(cropPriority);
              // The cursor advances only on a VERDICT pass: position
              // passes run at the 120ms floor against a 400ms verdict
              // cadence and never take a crop, so letting them turn the
              // cursor would spin it 2-3 extra places between reads and
              // make the window's stride depend on the cadence rather
              // than on the budget.
              var slice = rotateBudget(byConf, zoomBudget(), personCursor);
              var picked = slice.take;
              var rest = slice.rest;
              if (wasVerdict) {
                personCursor = slice.cursor;
                if (rest.length) bumpLife('cropRotated');
              }
              // Position-only pass: skip the crops+gender, just move the
              // tracks (verdict state untouched in the tracker).
              if (!wasVerdict) {
                return persons.map(function (p) {
                  return { box: p, positionOnly: true };
                });
              }
              // Clear credit accrues by the GAP between gender reads,
              // not the (shorter) pass interval — otherwise the split
              // cadence would silently triple the clear hold. Clamped
              // so the first-ever read can't dump seconds of credit.
              var verdictDt = Math.min(1000, lastZoomAt ? now - lastZoomAt : sampleInterval);
              lastZoomAt = now;
              var dbgV = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
              dbgV.vEnter = (dbgV.vEnter || 0) + 1;
              dbgV.vE = dbgV.vE || {}; dbgV.vE[samplerId] = (dbgV.vE[samplerId]||0)+1;
              dbgV.vP = (dbgV.vP || []).concat([persons.length]).slice(-40);
              dbgV.log = (dbgV.log || []).concat(['  vEnter persons=' + persons.length]).slice(-60);
              // FULL-FRAME FACE PASS — two jobs (both measured):
              //  1. Close-ups: MoveNet needs body context a face-filling
              //     shot doesn't have (owner frame: daughter close-up,
              //     0 persons, fully exposed).
              //  2. CROWDS: MoveNet MultiPose reports at most SIX
              //     people. BlazeFace returns up to 20, so in a group
              //     shot everyone past the sixth is covered through
              //     here (owner 2026-08-25: "work with 10+ people").
              // A face with no pose behind it becomes a head+torso
              // person (personFromFace) — deliberately modest geometry.
              return Promise.resolve(passFaces || [])
                .then(function (faces) {
                  mark('fullFaces');
                  var extra = [];
                  // TILE-RECALL PROBE — measurement only, off unless the
                  // harness sets the flag, and it never touches `extra`,
                  // `persons` or any track. R16 measured 4-15 faces found
                  // in an auditorium containing ~100 people, and the
                  // suspected cause is resolution, not any threshold: the
                  // full-frame pass resizes 1920x1080 to INPUT_SIZE 256,
                  // so a 40px back-row face arrives ~9px tall. Before
                  // anyone pays for tiling on a Helio G88, measure what it
                  // would actually BUY on this exact footage and what it
                  // costs. Fire-and-forget so a slow probe cannot stall
                  // the pass it is measuring.
                  if (window.__TS_TILE_PROBE && model) {
                    try {
                      tileProbe(faces.length);
                    } catch (e) {}
                  }
                  // Tallest face this pass found — the free scale
                  // reference the fallback needs to tell a close-up's
                  // neighbouring TEXTURE from a genuinely distant person.
                  var maxFaceH = 0;
                  for (var mf = 0; mf < faces.length; mf++) {
                    var fh = faces[mf].y2 - faces[mf].y1;
                    if (fh > maxFaceH) maxFaceH = fh;
                  }
                  // ONE PERSON BOX IS ONE PERSON, NOT EVERY FACE IN IT.
                  // A face landing inside an admitted MoveNet box used to
                  // be dropped outright, on the assumption that the box IS
                  // that face's person. In a seated row that is false: R16
                  // measured a woman at cx 0.30 whose face WAS detected,
                  // fell inside the SPEAKER's box (whose patch spans
                  // x 0.317-0.706), and so produced no observation of her
                  // own — she sat fully sharp in the 0.087-wide gap
                  // between two patches, in man mode, on three frames of
                  // one run. Her face was also inside the speaker's CROP,
                  // where ownFaceIndex correctly picked the speaker's, so
                  // she was invisible to every stage at once.
                  // Largest face first, so the face that claims a box is
                  // the one most likely to belong to it; every other face
                  // in that box gets its own body. mergeTracks unions the
                  // genuine overlaps, so an over-claim costs one merged
                  // patch rather than a stack.
                  //
                  // BOTH HALVES LIVE IN person-gate.mjs NOW (phase-g G1).
                  // The bench that measures how much of the corpus lands
                  // on this fallback had its own copy of the rule -- a
                  // private, unpadded, non-claiming version -- and it
                  // under-counted the synthetic share by half again
                  // (194 of 1153 against the real 317). Two copies of a
                  // decision rule is the same defect as one bench
                  // modelling a shipped mapping, so there is one copy.
                  var order = faceOrderBySize(faces);
                  // NOTHING HUMAN-SHAPED IN FRAME => a face here is a
                  // graphic, not a person MoveNet missed (R21). Only
                  // consulted when the person pass admitted NOBODY: with
                  // even one admitted person the frame demonstrably
                  // contains humans and the fallback keeps covering the
                  // ones MoveNet did not reach. See frameHasNoHumanShape
                  // for the corpus measurement that sets the floor and
                  // for the two neighbouring cases it must not take.
                  var noShape = persons.length === 0 && persons.noHumanShape === true;
                  var claimed = {};
                  for (var oj = 0; oj < order.length; oj++) {
                    var fi = order[oj];
                    var owner = faceInsideIndex(faces[fi], persons);
                    if (owner !== -1 && !claimed[owner]) {
                      claimed[owner] = 1;
                      continue;
                    }
                    // WHAT THE GATE IS ACTUALLY REFUSING, not just how
                    // often. On his phone this branch takes about three
                    // faces in four (faceNoShape 127 against ~41 gender
                    // reads in one 250s window) because MoveNet admits
                    // NOBODY there -- twelve slots n:0 in every window
                    // since loop 27 -- so PFF_FRAME_KP_FLOOR alone
                    // decides whether a detected face becomes a patch,
                    // and that floor was calibrated on gauntlet footage,
                    // never on his hardware. A refused REAL face is an
                    // uncovered person, which is his oldest complaint;
                    // the gate exists because of his other one. The two
                    // rings below are what tells them apart: if the
                    // refused population looks like the kept one, the
                    // floor is refusing people.
                    // OWNER RULING 2026-09-01: "she needs to be blurred".
                    // The gate is now a COUNTER, not a refusal. What it
                    // was refusing is measured and it is people: on his
                    // phone 60 refused against 19 kept, conf p50 0.78 vs
                    // 0.79, px p50 72 vs 79 -- the same population, split
                    // by whether MoveNet's frame noise happened to clear
                    // 0.1 that pass. 48 of 60 refusals were a face
                    // nothing else covered, and an audit that ran the
                    // real gender read on every refused face found 25 of
                    // 60 would have produced a patch.
                    //
                    // HONEST COST, HIS CALL AND HE MADE IT: a graphic
                    // that reads as a face now mints a patch, which is
                    // his "random blur marks here and there". The null
                    // band is the discriminator on the right axis, but
                    // shipping it as a MINT gate was refuted -- it lands
                    // on the same subject every pass, and it refused HER
                    // (loop 37c, executed: tracks 0 with the gate, 1
                    // without). So no gate replaces this one.
                    if (noShape) {
                      auditRefusedFace(
                        noteFaceGate('gateRefused', faces[fi], persons, video),
                        faces[fi]
                      );
                      try {
                        var dbgN = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                        dbgN.life = dbgN.life || {};
                        dbgN.life.faceNoShape = (dbgN.life.faceNoShape || 0) + 1;
                      } catch (e) {}
                    }
                    // The two rings must stay two POPULATIONS even now
                    // that both mint: `gateRefused` is what the keypoint
                    // floor would have thrown away, `gateKept` is what it
                    // corroborated. Recording every face in both would
                    // make the comparison that found this defect
                    // meaningless.
                    if (!noShape) noteFaceGate('gateKept', faces[fi], persons, video);
                    // THE COMPOSITE FRAME (R29). A face with no admitted
                    // person still gets a body, but where MoveNet
                    // MEASURED that person and merely refused to admit
                    // them, the measurement bounds the extrapolation.
                    // Only ever shrinks, so the patch SET is unchanged —
                    // see the block above boundBodyToSlot.
                    var synth = personFromFace(
                      faces[fi],
                      video.videoWidth / (video.videoHeight || 1)
                    );
                    var bounded = boundBodyToSlot(synth, faces[fi], persons.rejectedBoxes);
                    if (bounded !== synth) {
                      try {
                        var dbgB = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                        dbgB.life = dbgB.life || {};
                        dbgB.life.bodyFromSlot = (dbgB.life.bodyFromSlot || 0) + 1;
                      } catch (e) {}
                    }
                    extra.push(bounded);
                  }
                  try {
                    var dbgT = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                    dbgT.life = dbgT.life || {};
                    // THE HEIGHTS THE RULE ACTUALLY USES. R15 first
                    // calibrated the threshold against `reads.px`, which is
                    // the face found INSIDE a crop and mapped back — a
                    // different number from the full-frame face that built
                    // the crop in the first place. The rule then fired zero
                    // times and the artifact could not say why. Record the
                    // full-frame heights, whether each was inside a person,
                    // and the max, so the constant is derived from its own
                    // input.
                    dbgT.ff = (dbgT.ff || [])
                      .concat([
                        {
                          mx: Math.round(maxFaceH * 1000) / 1000,
                          hs: faces.map(function (fb) {
                            return Math.round((fb.y2 - fb.y1) * 1000) / 1000;
                          }),
                          // Centres too: a crowd rule needs to know
                          // whether the faces SPAN the frame or cluster in
                          // one band, and a count alone cannot say.
                          cx: faces.map(function (fb) {
                            return Math.round(((fb.x1 + fb.x2) / 2) * 100) / 100;
                          }),
                          cy: faces.map(function (fb) {
                            return Math.round(((fb.y1 + fb.y2) / 2) * 100) / 100;
                          }),
                          in: faces.map(function (fb) {
                            return faceInsideAny(fb, persons) ? 1 : 0;
                          }),
                          np: persons.length,
                        },
                      ])
                      .slice(-12);
                  } catch (e) {}
                  // Everyone is TRACKED; only the verdict budget is
                  // capped. Unverdicted people keep their existing
                  // state, and a brand-new one starts covered.
                  var all = picked.concat(extra);
                  // Negative detection (owner idea): remember that THIS
                  // verdict pass saw an empty frame, so the tracker can
                  // erase ghosts instead of coasting them.
                  // REFUSED FACES ARE NOT EVIDENCE OF A HUMAN. Skipping
                  // the mint is not the same as removing a patch: leave
                  // the refused face counted here and `emptyFrame` stays
                  // false, so wipeIfEmpty stands down and any track that
                  // was already blurred coasts its full window over the
                  // graphic. R21's slide got away with it only because
                  // the ghost was a BIRTH; a cut from a person to a title
                  // card is the common case and the gate alone would not
                  // clear it.
                  // A DETECTED FACE IS EVIDENCE OF A FACE, whatever the
                  // keypoint floor thought of the frame. While this read
                  // `noShape ? 0 : faces.length`, a pass that DETECTED
                  // faces reported an EMPTY FRAME, emptyStreak climbed
                  // and wipeIfEmpty ERASED a patch that was already on
                  // her. Measured in his regime over 220s: wipeErased
                  // 10, erasing 21 BLURRED tracks, with faceNoShape 74.
                  // That is the same defect class as the 1070 skip,
                  // which was reverted for exactly this reason.
                  var faceEvidence = faces.length;
                  // A PASS THAT NEVER RAN THE MODEL HAS NOTHING TO SAY
                  // ABOUT AN EMPTY FRAME, and this is the exact line
                  // 1070 got wrong. There, a skipped pass contributed
                  // `persons.length === 0` to emptyFrame, emptyStreak
                  // climbed on passes that had looked at nothing, and
                  // wipeIfEmpty took the blur off a covered woman -- "it's
                  // not blurring the female". A skip is INERT here: the
                  // eraser only ever acts on evidence a pass actually
                  // gathered.
                  emptyFrame = !persons.skipped
                    && persons.length === 0 && faceEvidence === 0;
                  // Largest thing this pass actually saw. It is the
                  // cheapest available read on subject scale — already
                  // computed, no extra pixels — and scale is what decides
                  // whether "I see nobody" next pass is a detector miss
                  // or a real cut. See wipeIfEmpty.
                  passMaxBoxH = 0;
                  for (var mb = 0; mb < persons.length; mb++) {
                    var ph = persons[mb].y2 - persons[mb].y1;
                    if (ph > passMaxBoxH) passMaxBoxH = ph;
                  }
                  // DELIBERATELY STILL GATED ON noShape, and it is the
                  // one place that stays. A face the keypoint floor did
                  // not corroborate now MINTS a patch (owner ruling), but
                  // letting it set the subject SCALE is a different
                  // question and it runs the erasing way: a face
                  // feeds faceHeight * 3 into the NEXT pass's `prevMaxH`,
                  // so a hallucinated face 0.357 tall reports a subject
                  // scale of 1.07 and ARMS wipeIfEmpty's one-pass `big`
                  // shortcut. Both of that eraser's measured misfires
                  // were it erasing people who were still there.
                  for (var mf = 0; !noShape && mf < faces.length; mf++) {
                    var fh = (faces[mf].y2 - faces[mf].y1) * 3;
                    if (fh > passMaxBoxH) passMaxBoxH = fh;
                  }
                  var dbgF = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                  dbgF.faceStage = (dbgF.faceStage || []).concat([faces.length + '/' + all.length]).slice(-40);
                  dbgF.log = (dbgF.log || []).concat(['  faceStage all=' + all.length]).slice(-60);
                  // READ THE BUDGET ONCE. The loop bound and the cursor
                  // advance must be the same number or the round-robin
                  // skips or repeats people whenever the device crosses
                  // ZOOM_BUDGET_FAST_MS mid-pass.
                  var zb = zoomBudget();
                  if (all.length > zb) {
                    // Round-robin the crops so a large group is fully
                    // classified across a few passes instead of the
                    // same three people every time.
                    all.sort(cropPriority);
                    var start = crowdCursor % all.length;
                    var budget = [];
                    for (var c = 0; c < zb; c++) {
                      budget.push(all[(start + c) % all.length]);
                    }
                    crowdCursor = (start + zb) % all.length;
                    for (var r2 = 0; r2 < all.length; r2++) {
                      if (budget.indexOf(all[r2]) === -1) rest.push(all[r2]);
                    }
                    return budget;
                  }
                  return all;
                })
                .catch(function () {
                  // Fallback pass failed — the person pass still stands.
                  return picked;
                })
                .then(function (all) {
                  var observations = [];
                  // Un-cropped extra persons still move their tracks.
                  rest.forEach(function (p) {
                    observations.push({ box: p, positionOnly: true, at: now });
                  });
                  var chain = Promise.resolve();
                  all.forEach(function (p, pi) {
                    // GENDER ONLY FOR TRACKS THAT NEED A READ (plan
                    // 2026-09-02, Task 4). A crop + gender read costs
                    // ~536ms of faceres on the arm64 Redmi; a track whose
                    // verdict is already SETTLED -- a flag-certain blur,
                    // or a cleared track refreshed inside
                    // GENDER_REFRESH_MS -- gains nothing from paying for
                    // another one this pass. Matched by best IoU against
                    // the TRACKER'S OWN state as it stood before this
                    // pass (`videoTracks`, not yet updated by this pass's
                    // observations) -- the same association threshold
                    // `updatePersonTracks` itself uses, so a person this
                    // pass finds nowhere near an existing track (a new
                    // subject, or one MoveNet never gave a certain read
                    // to and so can never reach `flag-certain`) always
                    // falls through the `matchedTrack &&` guard and gets
                    // read, exactly as before.
                    var matchedTrack = null;
                    var bestTrackIou = 0;
                    for (var vt = 0; vt < videoTracks.length; vt++) {
                      var trackIou = iou(p, videoTracks[vt].box);
                      if (trackIou >= PTRACK_IOU_MIN && trackIou > bestTrackIou) {
                        bestTrackIou = trackIou;
                        matchedTrack = videoTracks[vt];
                      }
                    }
                    if (matchedTrack && !trackNeedsRead(matchedTrack, now)) {
                      bumpLife('genderReadSkipped');
                      observations.push({ box: p, positionOnly: true, at: now });
                      return;
                    }
                    // Serial, not parallel: one GPU queue, smaller bursts.
                    //
                    // AND SPLIT INTO SEPARATE TASKS. (2026-08-27) Serial
                    // promises are MICROtasks, so N persons ran as ONE
                    // main-thread task and the browser could not paint,
                    // scroll or deliver a tap until the last of them
                    // finished. Under a 6x throttle the worst single task
                    // measured 2,329ms. Jank is felt as task LENGTH, not
                    // as total cost, so yielding a real macrotask between
                    // people is nearly free and cuts the worst case by
                    // the number of people in frame.
                    if (pi > 0) chain = chain.then(yieldToBrowser);
                    chain = chain.then(function () {
                      return observePerson(p).catch(function (e) {
                        var dbgE = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                        dbgE.errs = (dbgE.errs || []).concat([String((e && e.message) || e)]).slice(-8);
                        throw e;
                      }).then(function (obs) {
                        obs.verdictDt = verdictDt;
                        obs.at = now;
                        observations.push(obs);
                      });
                    });
                  });
                  return chain.then(function () {
                    var dbgX = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                    verdictBusy = false;
                    dbgX.log = (dbgX.log || []).concat(['  chainDone obs=' + observations.length]).slice(-60);
                    dbgX.vDone = (dbgX.vDone || 0) + 1;
                    dbgX.vD = dbgX.vD || {}; dbgX.vD[samplerId] = (dbgX.vD[samplerId]||0)+1;
                    dbgX.vLen = (dbgX.vLen || []).concat([observations.length]);
                    // Calibration probe (review B): two persons in the
                    // SAME frame are definitionally different people —
                    // their pairwise sim is the cross-person band.
                    var dbg = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                    dbg.cross = dbg.cross || [];
                    for (var a = 0; a < observations.length; a++) {
                      for (var b2 = a + 1; b2 < observations.length; b2++) {
                        if (!observations[a].desc || !observations[b2].desc) continue;
                        dbg.cross.push(
                          Math.round(cosineSim(observations[a].desc, observations[b2].desc) * 100) / 100
                        );
                      }
                    }
                    if (dbg.cross.length > 400) dbg.cross = dbg.cross.slice(-400);
                    return observations;
                  });
                });
            })
            .then(function (observations) {
              mark('crops');
              if (failed || dead) return;
              // Discontinuity landed while this pass was in flight:
              // these observations describe a frame that no longer
              // exists (review A6) — drop them, the forced pass that
              // the discontinuity queued is right behind.
              if (myEpoch !== passEpoch) {
                var dbgD = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                dbgD.dropped = (dbgD.dropped || 0) + 1;
                bumpLife('passDropped');
                // ...AND DO NOT MAKE THE REPLACEMENT WAIT A FULL CADENCE
                // FOR IT (R23). `lastZoomAt` was advanced before the crops
                // ran, so a pass discarded here pushed the next verdict a
                // full effZoom (400ms) into the future -- and these drops
                // are not uniformly distributed, they land preferentially
                // in the ~200ms after a cut, which is exactly the moment
                // the clear ladder needs its first rung. Zeroing it makes
                // the forced pass genuinely immediate. Costs nothing: the
                // in-flight guard (`verdictBusy`) still prevents a second
                // pass while one is running.
                lastZoomAt = 0;
                return;
              }
              var dbgK = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
              dbgK.kept = (dbgK.kept || 0) + 1;
              dbgK.keptV = (dbgK.keptV || 0) + (observations.some(function (o) { return !o.positionOnly; }) ? 1 : 0);
              dbgK.shape = dbgK.shape || [];
              dbgK.log = (dbgK.log || []).concat([
                (wasVerdict ? 'V' : 'p') + ' obs=' + observations.length,
              ]).slice(-60);
              dbgK.shape.push(samplerId + ':' + observations.map(function (o) {
                return (o.positionOnly ? 'P' : (o.flagged ? 'F' : 'c') + (o.certain ? '!' : '?'));
              }).join('+'));
              if (dbgK.shape.length > 60) dbgK.shape.shift();
              var dt = lastPassAt ? now - lastPassAt : sampleInterval;
              lastPassAt = now;
              if (wasVerdict) {
                // Nobody in frame at all: every surviving patch is a
                // ghost riding out its coast window. Kill them now —
                // but only once TWO passes agree. One empty pass is not
                // evidence of an empty room: at wide subject scale
                // MoveNet and BlazeFace fail together, for the same
                // reason, so their agreement is a single blind spot
                // counted twice. Gauntlet R5 caught the eraser firing on
                // a stage holding ~40 people.
                emptyStreak = emptyFrame ? emptyStreak + 1 : 0;
                var wipeBefore = videoTracks.length;
                var wipeBlurred = 0;
                for (var wb = 0; wb < videoTracks.length; wb++) {
                  if (videoTracks[wb].state === 'blurred') wipeBlurred++;
                }
                videoTracks = wipeIfEmpty(
                  videoTracks,
                  emptyFrame ? 0 : 1,
                  0,
                  emptyStreak,
                  lastMaxBoxH,
                  // Did the shot actually change? Only then may a big
                  // subject's disappearance be believed on one pass —
                  // otherwise it is a detection miss and the patch has to
                  // survive it (r8b f009). One verdict interval of slack,
                  // because the cut is detected on the gate tick and the
                  // wipe happens on the verdict pass that follows it.
                  lastCutAt !== 0 && now - lastCutAt <= effZoom
                );
                // THE ERASER HAD NO COUNTER, AND THAT IS WHY THE 1070
                // REGRESSION WAS FOUND BY THE OWNER AND NOT BY A PROBE.
                // From outside, a pass that ERASED a patch is
                // indistinguishable from a pass that never minted one --
                // coverage simply reads 0 either way. These two fail for
                // different reasons and are counted apart: an empty frame
                // that should not be empty is a detector (or a skipped
                // pass) defect, and an erasure is that defect reaching
                // the screen. `wipeErasedBlurred` is the exposure number:
                // every one of those was a person we had decided to cover.
                try {
                  var dbgW = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                  dbgW.life = dbgW.life || {};
                  if (emptyFrame) dbgW.life.emptyFrame = (dbgW.life.emptyFrame || 0) + 1;
                  if (wipeBefore > 0 && videoTracks.length === 0) {
                    dbgW.life.wipeErased = (dbgW.life.wipeErased || 0) + 1;
                    dbgW.life.wipeErasedTracks =
                      (dbgW.life.wipeErasedTracks || 0) + wipeBefore;
                    dbgW.life.wipeErasedBlurred =
                      (dbgW.life.wipeErasedBlurred || 0) + wipeBlurred;
                  }
                } catch (e) {}
                if (!emptyFrame) lastMaxBoxH = passMaxBoxH;
                emptyFrame = false;
              }
              // Keep the coast window in step with the verdict cadence —
              // on a slow device the cadence is what decides whether a
              // covered person's patch survives to the next pass.
              setVerdictCadence(effZoom);
              // AND RECORD WHAT THAT ACTUALLY DERIVED (phase-D D9). The
              // report carried the PUSHED value of
              // PTRACK_MIN_COAST_PASSES and nothing else, and the same
              // pushed value means two different coasts at two different
              // cadences -- 1.33 is 2660ms at told 2000 and 2000ms at
              // told 1500, which is the whole of D1. A dial nobody can
              // read back is a dial nobody can verify pushed. Two
              // numbers, both numeric, so the report's shape check
              // passes them.
              try {
                var dbgC = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                dbgC.tuning = dbgC.tuning || {};
                dbgC.tuning.coastMs = blurredCoastBudgetMs();
                dbgC.tuning.toldMs = effZoom;
              } catch (e) {}
              // THE ADJACENCY CLAMP. A synthetic body is 7.4 face-heights
              // wide, and in his regime EVERY body is synthetic --
              // MoveNet admits nobody (loops 35/36/37, all twelve slots
              // n:0 on his phone, three times). In a two-shot that width
              // swallows the man standing next to the subject, and a man
              // the pipeline correctly CLEARED being covered by his
              // neighbour's patch is the single biggest error left:
              // measured on a 10-video labelled corpus at his measured
              // 1.45s verdict cadence, FALSE COVER 292.0s against
              // EXPOSURE 38.5s.
              //
              // BEFORE the provenance probe on purpose, so `obs` records
              // the boxes the TRACKER is handed rather than the ones it
              // would have been handed. And before updatePersonTracks,
              // which dedupes internally (person-track.mjs:598) -- the
              // clamp has to be a property of the box that goes into the
              // merge, not something applied after one won it.
              var preClamp = observations;
              observations = clampBodies(observations, BODY_CLAMP_PAD);
              try {
                var nClamped = 0;
                for (var ci = 0; ci < observations.length; ci++) {
                  if (observations[ci] !== preClamp[ci]) nClamped++;
                }
                // NOT `clampFired` -- that name is TAKEN, by the patch
                // geometry clamp in region-blur (clampFired /
                // clampNoLegalEdge / clampNoCore). Reusing it would have
                // added two unrelated events into one number and
                // silently rebased every reading of it that any earlier
                // round has quoted. Caught by reading the EMITTED
                // bundle, not the source.
                //
                // bumpLife counts by ONE; an edge moved on three
                // observations in a pass is three, because the question
                // this answers is "did the clamp fire in the wild, and
                // how often", and a per-pass boolean cannot say.
                for (var cj = 0; cj < nClamped; cj++) bumpLife('bodyClampFired');
              } catch (e) {}
              // OBSERVATION PROVENANCE (gauntlet R19). `slots` shows what
              // MoveNet raw-produced and `tracks` shows what survived, and
              // between them sits the one step no artifact has ever
              // recorded: personFromFace minting synthetic bodies, and
              // dedupeObservations choosing ONE box per human. R19 scored
              // FALSE COVER on a cleared man whose face sat inside another
              // track's patch, and could not say from the artifact whether
              // the offending box was MoveNet's measurement or an
              // extrapolation that beat it on area in `preferred()`.
              // `f` is the fromFace flag; `p` positionOnly; `v` the
              // verdict shape. Wrapped because instrumentation has killed
              // two releases and does not get to kill a third.
              try {
                var dbgO = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                dbgO.obs = dbgO.obs || [];
                dbgO.obs.push(
                  observations.map(function (o) {
                    var bx = (o && o.box) || {};
                    return {
                      f: bx.fromFace ? 1 : 0,
                      p: o && o.positionOnly ? 1 : 0,
                      v: o && o.positionOnly ? 'P' : (o && o.flagged ? 'F' : 'c') + (o && o.certain ? '!' : '?'),
                      b: [bx.x1, bx.y1, bx.x2, bx.y2].map(function (n) {
                        return typeof n === 'number' ? Math.round(n * 1000) / 1000 : null;
                      }),
                      // R29: the head anchor sameHuman actually judges on.
                      // `obs` is recorded PRE-dedupe, so the merge decision
                      // is reconstructible offline -- but only with these
                      // four numbers. Without them `dedupeMerged` is a
                      // count no round can act on, and the corpus cannot
                      // price a change to the merge bar at all.
                      h: [bx.headX, bx.headY, bx.headW, bx.headH].map(function (n) {
                        return typeof n === 'number' ? Math.round(n * 1000) / 1000 : null;
                      }),
                    };
                  })
                );
                // NOT the post-dedupe list, and this is deliberate:
                // dedupeObservations bumps `dedupeMerged` and
                // `dedupeHeadSplit`, so calling it a second time from a
                // probe would DOUBLE every merge counter every round has
                // ever quoted. With the head anchors above, sameHuman is
                // a pure function of what is recorded here, so the merge
                // decision is reconstructible offline without re-running
                // anything that counts.
                if (dbgO.obs.length > 60) dbgO.obs = dbgO.obs.slice(-60);
              } catch (e) {
                /* probes never break the pipeline */
              }
              // `nullHeld` is a sibling of videoTracks and NOT part of
              // it, deliberately: wipeIfEmpty and demoteTracks both
              // replace the track array, and a hold that vanished with
              // them would refuse the same subject a second time.
              videoTracks = updatePersonTracks(videoTracks, observations, dt, nullHeld);
              nullHeld = videoTracks.nullHeld || [];
              // THE DRAWN GEOMETRY, never the raw tracker box. The
              // presenter draws from this snapshot, and handing it
              // `videoTracks` meant the side pad, the top pad, the R27
              // clamp and the merge in blurredTracks never reached a
              // presented frame (Redmi, 1094: 22-30 of 48 covered
              // certain-male reads were a neighbour's unclamped box).
              if (presenter) pushSnapshot(timeline, passMediaTime, presentTracks(videoTracks));
              mark('tracks');
              // Calibration probe: per-track state after every pass, so
              // a "why is he not clearing" question is answered by
              // measurement instead of a guess.
              var dbgT = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
              dbgT.tracks = dbgT.tracks || [];
              dbgT.tracks.push(
                videoTracks.map(function (tk) {
                  return {
                    id: tk.id,
                    st: tk.state,
                    cs: tk.clearStreak,
                    fs: tk.flagStreak,
                    cm: Math.round(tk.clearMs || 0),
                    lv: tk.lastVerdict,
                    // S6 weak-evidence streak. Measurement only (the clear
                    // it was built for exposed a child and was removed the
                    // same round) — this is how a future round sizes how
                    // often consistent sub-bar evidence actually occurs.
                    ws: tk.weakStreak || 0,
                    // How much of flagStreak came from ABSTENTIONS (S10).
                    // The design intent is "2 consecutive certain
                    // opposite reads"; abstentions advance the same
                    // counter, so a mix also revokes. Measurement only.
                    as: tk.abstainStreak || 0,
                    // The two fields every TTL/stale question needs and
                    // no trace has ever carried: paths 3, 4 and `stale`
                    // are invisible in the per-pass record, so they could
                    // only be reasoned about from aggregates that cannot
                    // be joined to a frame.
                    ca: Math.round(tk.clearAge || 0),
                    mm: Math.round(tk.missMs || 0),
                    // R19: the track's own box. Without it a patch cannot
                    // be attributed to the track that drew it, which is
                    // the join every geometry question needs.
                    b: tk.box
                      ? [tk.box.x1, tk.box.y1, tk.box.x2, tk.box.y2].map(function (n) {
                          return typeof n === 'number' ? Math.round(n * 1000) / 1000 : null;
                        })
                      : null,
                    // Read off the TRACK, not its box. The box is
                    // reconstructed as a bare four-field literal by
                    // newTrack, ema and coastStep, so `tk.box.fromFace`
                    // was undefined on every track ever recorded — 145
                    // of 145 across six runs reported 0, including a
                    // pass whose only observation was a synthetic body.
                    f: tk.fromFace ? 1 : 0,
                    // R27 directional margin: the clamp's three inputs.
                    // Without them a patch that did NOT move is
                    // indistinguishable from a clamp that never fired,
                    // which is exactly the ambiguity the first
                    // after-capture ran into.
                    cf: tk.coreFresh ? 1 : 0,
                    // `fe` is flagEvidence (a certain flag not yet revoked by a
                    // certain clear) -- NOT `cf`, which is coreFresh; two
                    // replays read cf as the flag and were wrong (phase-m M5).
                    fe: tk.flagEvidence ? 1 : 0,
                    co: tk.core
                      ? [tk.core.x1, tk.core.y1, tk.core.x2, tk.core.y2].map(function (n) {
                          return typeof n === 'number' ? Math.round(n * 1000) / 1000 : null;
                        })
                      : null,
                    hf: (function () {
                      var fb = clearedFaceBox(tk);
                      return fb
                        ? [fb.x1, fb.y1, fb.x2, fb.y2].map(function (n) {
                            return Math.round(n * 1000) / 1000;
                          })
                        : null;
                    })(),
                  };
                })
              );
              if (dbgT.tracks.length > 200) dbgT.tracks = dbgT.tracks.slice(-200);
              // Hysteresis boundary: patches follow track STATE, which
              // only ever flips instantly toward blur; the clear
              // direction needs CLEAR_HOLD_MS of continuous confident
              // reads (person-track.mjs). No per-sample recomputation
              // flicker — the audit's core hit-and-miss fix.
              var render = blurredTracks(videoTracks);
              if (render.length) {
                // setTracks false = player host vanished — whole blur,
                // no person may be exposed.
                if (videoRegion.setTracks(video, render)) {
                  video.classList.remove(dom.PENDING_CLASS, dom.FLAGGED_CLASS);
                  track(video);
                  regionActive = true;
                  if (presenter) presenter.cover(false);
                } else {
                  coverVideo();
                }
              } else {
                uncoverVideo();
                videoRegion.clear(video);
                regionActive = false;
              }
            })
            // The shared frame is the caller's to free, and a tensor leaked
            // once per verdict pass would be far worse than the duplicate
            // upload it exists to remove. Released on BOTH exits, and
            // releaseFrame is idempotent, so an early return upstream that
            // already freed it is harmless.
            .then(releaseFrame, function (e) {
              releaseFrame();
              throw e;
            })
            .catch(function (e) {
              if (e && e.name === 'SecurityError') {
                // Tainted source (cross-origin, no CORS): permanent for
                // this stream — fail open, same as the canvas path.
                giveUp('tainted source', e);
                return;
              }
              if (directPersonOk) {
                // Direct fromPixels(video) hit a driver quirk — retry
                // next pass through the canvas fallback (plan-blur-v2
                // Stage 1 risk register).
                directPersonOk = false;
              }
              // Cannot verify this pass — tracks coast, patches hold.
              var dbgP = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
              dbgP.passFails = (dbgP.passFails || 0) + 1;
              dbgP.lastFail = String((e && e.message) || e);
              // eslint-disable-next-line no-console
              console.warn('tamescroll gaze: person pass failed', e);
            })
            .finally(function () {
              mark('end');
              try {
                var dbgSt = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
                if (!dbgSt.stages) dbgSt.stages = [];
                stage.v = wasVerdict ? 1 : 0;
                dbgSt.stages.push(stage);
                if (dbgSt.stages.length > 120) dbgSt.stages.shift();
                // MONOTONIC, because the ring above is not. `stages` is
                // capped at 120 here and sliced to 40 in the report, so
                // its LENGTH saturates and a b-minus-a diff across a
                // window measures the fill, not the rate -- which is
                // how a 2.09s verdict gap got written down as 5.77s.
                // Same defect the image ring already carries a total for.
                dbgSt.passesTotal = (dbgSt.passesTotal || 0) + 1;
                if (wasVerdict) dbgSt.verdictsTotal = (dbgSt.verdictsTotal || 0) + 1;
                if (wasVerdict && lateAttachPending) {
                  // First verdict: hand the video to the presenter. Its
                  // refill starts covered, so the only state between the
                  // whole-video blur and the first patch is another blur.
                  lateAttachPending = false;
                  delayAttach();
                  if (!presenter) uncoverVideo();
                  dbgSt.lateAttachAt = (dbgSt.lateAttachAt || 0) + 1;
                }
                // A COUNTER THAT DOES NOT EXIST UNTIL IT FIRES CANNOT BE
                // READ AS ZERO. Every one of these is written as
                // `(x || 0) + 1` at its own site, so an absent key is
                // ambiguous between "never happened" and "the hook is
                // not there" -- and that ambiguity is exactly why the
                // 1070 eraser regression was found by him and not by a
                // probe. Seeded on the first player pass so a report
                // showing 0 is EVIDENCE.
                var lf = (dbgSt.life = dbgSt.life || {});
                lf.emptyFrame = lf.emptyFrame || 0;
                lf.wipeErased = lf.wipeErased || 0;
                lf.wipeErasedTracks = lf.wipeErasedTracks || 0;
                lf.wipeErasedBlurred = lf.wipeErasedBlurred || 0;
                lf.faceNoShape = lf.faceNoShape || 0;
                lf.bodyFromSlot = lf.bodyFromSlot || 0;
                lf.genderReadSkipped = lf.genderReadSkipped || 0;
                lf.delayVerdictLate = lf.delayVerdictLate || 0;
lf.delayHeldLate = lf.delayHeldLate || 0;
              } catch (e) {}
              var cost = performance.now() - now;
              if (wasVerdict) lastVerdictMs = cost;
              else lastPassMs = cost;
              // CHARGE THE MAIN THREAD FOR MAIN-THREAD TIME ONLY -- the
              // same correction the image drain got in 2026-08-28, which
              // this path never received.
              //
              // MEASURED on the owner's phone (1067, m.youtube watch,
              // 62 verdict passes): end p50 795ms, of which the person
              // reply accounts for 785 and our own segments 2. Charging
              // 795 against SPEND_BUDGET_FRAC (0.25 of a 1s window) puts
              // the pipeline over budget for most of a second after
              // EVERY verdict, and overBudget() refuses the cheap
              // position passes that keep a patch on a moving subject:
              // 20 positions to 62 verdicts, one pass every 1.46s
              // against a 1000ms floor. The cadence itself is unchanged
              // (verdicts are capped at VERDICT_MAX_INTERVAL_MS anyway);
              // what comes back is the tracking in between.
              //
              // Floored at 0: concurrent image requests share the same
              // cumulative counter, so a delta can exceed this pass's
              // own elapsed time. The in-page path has no baseline and
              // is charged in full, which is correct -- it really did
              // spend all of it here.
              var mine = cost;
              if (waitBase !== null) {
                var waited = waitEng.waitMs() - waitBase;
                if (waited > 0) mine = Math.max(0, cost - waited);
              }
              noteSpend(performance.now(), mine);
              // Cost telemetry for the gauntlet's mobile budget. Owner
              // 2026-08-25: "be sure to make it optimized and
              // performance oriented — that is the only way this app
              // would be helpful." Accuracy that costs a phone its
              // frame rate is not a win, so every round records both.
              var dbgC = (window.__TS_GAZE_IDS = window.__TS_GAZE_IDS || {});
              dbgC.cost = dbgC.cost || { verdict: [], pass: [] };
              var bucket = wasVerdict ? dbgC.cost.verdict : dbgC.cost.pass;
              bucket.push(Math.round(cost));
              if (bucket.length > 120) bucket.shift();
              // RECORD WHAT THE THROTTLE ACTUALLY SAW (phase-i critic
              // I11): the cadence row has never banked either of
              // these, so a stale lastPassMs was unreadable from
              // outside. Both numeric, same shape as
              // dbgC.tuning.coastMs/toldMs above.
              dbgC.tuning = dbgC.tuning || {};
              dbgC.tuning.lastPassMs = lastPassMs;
              dbgC.tuning.effInterval = effInterval;
              sampling = false;
            });
        } catch (e) {
          // A sync throw from drawImage/getImageData is the tainted-
          // canvas case: permanent for this element — fail open.
          sampling = false;
          giveUp('tainted canvas', e);
        }
        return;
      }

      // Whole-blur path (feed videos, no player host / no backdrop-
      // filter, person model still loading or failed): full-frame faces
      // + clean streak. A player waiting on the person model sits here
      // briefly — blur-first already covers it, and the region path
      // takes over the moment the model lands.
      try {
        var canvas = ensureVideoCanvas();
        var ctx2d = canvas.getContext('2d');
        // ASPECT-PRESERVING, and it was not until 2026-09-02. This was
        // the four-argument drawImage, which squashed a 640x360 stream
        // into the square and handed faceres every face 1.78x taller
        // than wide -- the squareBox defect one stage earlier, where
        // squareBox cannot reach it. See crop-geometry.fitBox for the
        // measurement (17 of 18 faces carry more descriptor signal
        // undistorted) and engine-findings 16a.
        //
        // NOTHING DOWNSTREAM READS A BOX FROM THIS BUFFER, which is what
        // makes the change safe with no coordinate mapping anywhere:
        // wholeFrameFlagged returns ONE BOOLEAN for the frame and the
        // caller applies whole-video blur.
        var fit = fitBox(
          video.videoWidth, video.videoHeight, detector.INPUT_SIZE
        );
        // The bars must be painted, not left: this canvas is reused, so
        // an unpainted margin still holds the PREVIOUS frame and would
        // hand the detector two frames at once.
        ctx2d.fillStyle = '#000';
        ctx2d.fillRect(0, 0, detector.INPUT_SIZE, detector.INPUT_SIZE);
        ctx2d.drawImage(video, fit.dx, fit.dy, fit.dw, fit.dh);
        var pixels = ctx2d.getImageData(0, 0, detector.INPUT_SIZE, detector.INPUT_SIZE);
        wholeFrameLife('wholeFrameSamples');
        wholeFrameFlagged(pixels)
          .then(function (anyFlagged) {
            if (failed) return;
            if (anyFlagged) {
              cleanStreak = 0;
              coverVideo();
            } else {
              cleanStreak++;
              if (cleanStreak >= unblurStreak) {
                wholeFrameLife('wholeFrameCleared');
                uncoverVideo();
              }
            }
          })
          .catch(function (e) {
            // Cannot verify this frame — do not advance the clean streak.
            cleanStreak = 0;
            // eslint-disable-next-line no-console
            console.warn('tamescroll gaze: video sample failed', e);
          })
          .finally(function () {
            sampling = false;
          });
      } catch (e) {
        sampling = false;
        giveUp('tainted canvas', e);
      }
    }

    function rvfcLoop() {
      // Toggled-off players must not keep burning a callback per frame
      // (review 2026-08-23 #9) — the pill's re-enable path calls start().
      if (failed || dead || rvfcArmed || (isPlayer && !playerBlurOn)) return;
      rvfcArmed = true;
      video.requestVideoFrameCallback(function () {
        rvfcArmed = false;
        sampleOnce();
        if (!video.paused) rvfcLoop();
      });
    }

    // Late attach (DELAY_LATE_ATTACH): the presenter waits for the first
    // verdict; until then the whole video wears the flagged class.
    var lateAttachPending = false;
    function start() {
      if (failed || dead) return;
      if (playerBlurOn) {
        if (delayCore.DELAY_LATE_ATTACH === 1 && !presenter && delayWanted()) {
          lateAttachPending = true;
          coverVideo();
        } else {
          delayAttach();
        }
      }
      // A played video can't wait for post-load idle to bring the models
      // — the deferral would hold it blur-first forever on a busy watch
      // page. Kick the loads now (both idempotent).
      //
      // ATTACHING a video is not enough to justify them, which is what
      // this used to key off: a YouTube search page carries a hidden
      // preview <video> that never plays, so every search loaded four
      // models nothing on the page would use. Now that images are
      // classified in the worker, that was also a second copy of every
      // model in memory on a phone. PLAYING is the moment the in-page
      // path genuinely needs them.
      // ...unless the worker owns the player too, in which case this
      // page holds no models at all.
      //
      // A worker that is still COMING UP gets a moment: play fires
      // around two seconds in and the worker reports its models a
      // fraction of a second later, so loading a second set the instant
      // a video plays would lose the saving on every watch page opened
      // directly. Blur-first covers the wait, and a worker that never
      // arrives times itself out and lands here anyway.
      if (!workerVideo()) {
        if (gazeWorker && !gazeWorker.dead()) {
          setTimeout(function () {
            if (dead || failed || workerVideo()) return;
            ensureFaceModels();
            ensurePersonModel();
          }, WORKER_VIDEO_GRACE_MS);
        } else {
          ensureFaceModels();
          ensurePersonModel();
        }
      }
      if (hasRvfc) {
        // rvfcLoop's armed-flag makes the play/playing double-fire (and a
        // parked callback surviving a pause) collapse into one loop —
        // without it every play/pause cycle stacked another loop
        // (review 2026-08-19).
        rvfcLoop();
      } else if (!intervalId) {
        intervalId = setInterval(sampleOnce, sampleInterval);
      }
    }

    function stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      // rVFC loop self-terminates on the `video.paused` check above.
    }

    video.addEventListener('play', start);
    video.addEventListener('playing', start);
    video.addEventListener('pause', stop);
    video.addEventListener('ended', stop);
    // A seek is a discontinuity like a cut (owner edge-case ask:
    // fast-forward/arrow-key skips): old positions are meaningless.
    // Fresh tracks, immediate full pass, new luma baseline.
    video.addEventListener('seeked', function () {
      if (failed || dead) return;
      videoTracks = [];
      // The delay line's verdict history goes with the tracker: its
      // snapshots describe tracks that no longer exist, at media times
      // playback is no longer next to (a seek back left one old
      // snapshot presenting a frozen patch for the whole way back --
      // owner report 2026-09-02, track-timeline.BACK_JUMP_S).
      resetTimeline(timeline);
      heldPersons = [];
      prevLuma = null;
      prevGateMedia = null;
      sceneState = 'motion';
      lastSample = 0;
      lastZoomAt = 0;
      passEpoch++;
      if (video.paused) {
        // Seeked while PAUSED (review A7): no pass will run until play
        // — the landed frame is unknown, so cover it whole. The first
        // pass after play replaces this with real patches.
        if (useRegionVideo) coverVideo();
      } else {
        sampleOnce();
      }
    });
    // Paused = nothing moves: zero the velocities and re-pin, or the
    // overlay extrapolator would keep sliding/scaling patches over a
    // frozen frame (owner edge-case ask 2026-08-24).
    video.addEventListener('pause', function () {
      for (var i = 0; i < videoTracks.length; i++) {
        videoTracks[i].vx = 0;
        videoTracks[i].vy = 0;
        videoTracks[i].vw = 0;
        videoTracks[i].vh = 0;
      }
      if (regionActive) videoRegion.setTracks(video, blurredTracks(videoTracks));
    });

    // A reused element is a NEW video (YouTube SPA watch->watch keeps
    // the same <video> and just swaps the stream — review 2026-08-23
    // #5): every per-video decision is stale the moment loadstart
    // fires. Reset them all — a tainted giveUp on the previous stream,
    // the user's toggle, the clean streak — and blur-first the new one.
    video.addEventListener('loadstart', function () {
      // O2 (phase-o): a settle/measure timer this attach's attachRun
      // armed belongs to the stream that was playing when it started --
      // an SPA watch->watch swap (the comment two lines down) reuses the
      // same <video>, so without this a timer from the OLD stream could
      // still fire against the NEW one and push a row measuring neither.
      // The run's own stored state is untouched; the next attach (below)
      // picks the same arm back up and measures it from scratch.
      // 1100: attachRun's OWN seek fires loadstart on this element, so
      // the cancel is keyed on the video id -- same id, same stream,
      // the arm stands; a different id is the swap described above.
      try { autoTest.cancelRunOnLoad(window); } catch (e) {}
      if (failed) return;
      dead = false;
      cleanStreak = 0;
      // Stale overlays belong to the previous stream — drop them before
      // blur-first covers the new one, or they'd sit at old-face coords.
      if (regionActive) {
        videoRegion.clear(video);
        regionActive = false;
      }
      videoTracks = [];
      heldPersons = [];
      lastPassAt = 0;
      if (presenter) {
        timeline = makeTimeline(delayCore.DELAY_MS + 2000);
        presenter.cover(true);
      }
      // New stream = new scene: forget the luma baseline and re-enable
      // the direct pixel path (a per-stream quirk shouldn't outlive it).
      prevLuma = null;
      prevGateMedia = null;
      sceneState = 'motion';
      lastCutAt = 0;
      directPersonOk = true;
      // The person-skip back-off is per-STREAM evidence: "MoveNet has
      // admitted nobody for three passes running" is a statement about
      // the footage, and a new stream makes it stale. Without this the
      // back-off survives an SPA watch->watch, so the first passes of a
      // new video that DOES contain people could be skipped on the last
      // video's emptiness. Inert while PERSON_SKIP_EVERY is 1, which is
      // exactly why it went unnoticed -- and it is on the OTA channel,
      // so it would have armed itself the moment the dial was pushed.
      resetPersonSkip();
      passEpoch++;
      // Same watch id = the same video reloading its stream (an ad
      // ending, a quality or fullscreen switch): his tap stands. A new
      // video takes the default.
      var keepOff = isPlayer && !playerBlurWantedNow();
      if (playerBlurOn === keepOff) {
        playerBlurOn = !keepOff;
        if (pillRefresh) pillRefresh();
      }
      if (keepOff) return;
      markPending(video);
      if (!video.paused) start();
    });

    // NO PLAYBACK-QUALITY FLOOR HERE, and that is a measured decision.
    //
    // R11 built one (raise ABR to hd720 so small faces carry more
    // pixels), shipped it behind a backoff, and then measured it against
    // itself. Verdict: REVERTED. The identical capture at 480p, 720p and
    // 1080p produced the SAME nine falsely-covered frames out of ten. The
    // seated subject who reads `uncertain` with a ~50px face still reads
    // `uncertain` with a ~112px one. Source resolution costs ~+4ms p50 on
    // the verdict pass and buys nothing, because every crop is resampled
    // to a fixed model input anyway — this pipeline is very nearly
    // resolution-independent.
    //
    // Her cover is the faceres NULL OUTPUT, not a shortage of pixels: a
    // constant `male` ~0.3 read that is a CERTAIN opposite-gender flag in
    // woman mode. Pixels cannot fix a model returning its prior.
    //
    // Two further reasons not to re-try this: raising the rung spends the
    // owner's mobile data on a Helio G88 for zero visible gain, and
    // YouTube's setPlaybackQuality has been a documented no-op since
    // 2019, so the only remaining lever writes the platform's own
    // storage — outside BLOCK-ONLY as written.
    //
    // What DID come out of it is a harness rule, not product code: two
    // runs of the same video minutes apart differed 854x480 vs 1280x720,
    // so `vw`/`vh` is now recorded per frame and a resolution mismatch
    // invalidates a cross-round comparison.
    // THE PILL HAS TO OUTRANK YOUTUBE'S OWN CONTROL CHROME, and inside
    // #movie_player it cannot. MEASURED 2026-08-31 on a live m.youtube
    // watch page: #movie_player carries a transform, so it creates a
    // stacking context and our z-index of 2147483645 is capped at that
    // element's own level. YouTube's controls are NOT in there --
    // `.player-controls-background` (position absolute, opacity 0,
    // pointer-events auto, covering the whole 412x231 player) lives
    // under #player-control-container, a LATER SIBLING of #player, both
    // children of #player-container-id. So it paints over everything
    // inside the player, the pill included.
    //
    // That element does not exist on a freshly loaded page -- YouTube
    // builds its control overlay on the FIRST TAP on the video, and it
    // then stays for the life of the page. MEASURED, one trace: fresh
    // page, a tap on the pill toggles "Blur on" -> "Blur off"; one tap
    // on the video; six seconds later the controls have autohidden but
    // the background remains and elementFromPoint at the pill's centre
    // returns `player-controls-background`; a tap on the pill now does
    // NOTHING ("Blur off" -> "Blur off") and a press with 25px of thumb
    // roll shrinks the player to 347x195 instead. His blur switch died
    // the moment he touched the video, and became a drag handle.
    //
    // #player-container-id is the fix: a sibling of the control
    // container, later in the DOM, and still inside the player subtree
    // so element fullscreen keeps the pill rendered -- YouTube's own
    // controls live outside #movie_player too and are visible in
    // fullscreen, so the fullscreen element is at or above this one.
    // It is `position: fixed`, so it is the containing block for the
    // absolutely-positioned pill exactly as #movie_player was, and the
    // two share the same box: the pill does not move a pixel.
    var pillHost = null;
    if (isPlayer && video.closest) {
      var moviePlayer = video.closest('#movie_player');
      pillHost = (moviePlayer && moviePlayer.closest('#player-container-id')) || moviePlayer || null;
    }
    if (pillHost) {
      // In-player toggle (owner ask): a wrong live verdict must be one
      // tap from gone. Lives INSIDE the player container so element
      // fullscreen keeps it visible (fixed-position elements outside
      // the fullscreen element are not rendered). ALWAYS visible on the
      // player (owner 2026-08-24: it is the whole-video blur switch, so
      // it must not vanish when nothing is currently covered); it is our
      // own control, not a platform nag, so NO NAGS is not in play.
      // Styled as a visible SWITCH (owner 2026-08-24: "needs a thing
      // that shows so people know it's a toggle") — label + track +
      // sliding knob, sized for touch (36px tall hit area on mobile).
      pill = document.createElement('button');
      pill.type = 'button';
      // Named so the miniplayer can hide it: at 0.56 scale the pill eats
      // a third of a 231px-wide box, and it outranks the mini cover's
      // z-index, so it would be the one thing still tappable in there.
      pill.className = 'ts-gaze-pill';
      pill.style.cssText =
        'position:absolute;top:48px;right:8px;z-index:2147483645;' +
        'display:flex;align-items:center;gap:7px;' +
        'background:rgba(0,0,0,.55);color:#fff;font:500 12px system-ui;' +
        'padding:8px 12px;border:none;border-radius:999px;opacity:.85;' +
        'cursor:pointer;pointer-events:auto;min-height:36px;';
      var pillLabel = document.createElement('span');
      var pillTrack = document.createElement('span');
      pillTrack.style.cssText =
        'position:relative;width:30px;height:16px;border-radius:999px;' +
        'background:#4a4;transition:background .15s;flex:none;';
      var pillKnob = document.createElement('span');
      pillKnob.style.cssText =
        'position:absolute;top:2px;left:16px;width:12px;height:12px;' +
        'border-radius:50%;background:#fff;transition:left .15s;';
      pillTrack.appendChild(pillKnob);
      pill.appendChild(pillLabel);
      // His 2026-10-22 ask: video blur on a phone is "labelled in beta".
      if (onPhone) {
        var pillBeta = document.createElement('span');
        pillBeta.textContent = 'Beta';
        pillBeta.style.cssText =
          'font:600 9px system-ui;letter-spacing:.04em;text-transform:uppercase;' +
          'padding:1px 5px;border-radius:999px;border:1px solid rgba(255,255,255,.6);opacity:.85;';
        pill.appendChild(pillBeta);
      }
      pill.appendChild(pillTrack);
      var pillPaint = function () {
        pillLabel.textContent = playerBlurOn ? 'Blur on' : 'Blur off';
        pillTrack.style.background = playerBlurOn ? '#4a4' : '#777';
        pillKnob.style.left = playerBlurOn ? '16px' : '2px';
      };
      pillPaint();
      pillRefresh = pillPaint;
      // `tapped` = his choice, held for this watch id; the watcher only
      // follows the page to what is wanted and records nothing.
      var setPlayerBlur = function (on, tapped) {
        playerBlurOn = on;
        if (tapped) playerBlurChoice = { id: watchVideoId(), on: on };
        // A pass in flight was judged for the old state: drop it.
        passEpoch++;
        pillPaint();
        if (playerBlurOn) {
          cleanStreak = 0;
          videoTracks = [];
          heldPersons = [];
          lastPassAt = 0;
          markPending(video);
          if (!video.paused) start();
        } else {
          // Pill off = the viewer wants the raw stream: the delayed
          // picture and its audio go with the patches.
          delayDetach();
          clearEl(video);
          videoRegion.clear(video);
          regionActive = false;
          videoTracks = [];
          heldPersons = [];
          lastPassAt = 0;
        }
      };
      pill.addEventListener('click', function (e) {
        e.stopPropagation();
        setPlayerBlur(!playerBlurOn, true);
      });
      pillHost.appendChild(pill);
      // THE TUNING PANEL, behind a gear of our own beside the switch.
      //
      // Same host as the pill for the same three reasons: element
      // fullscreen keeps it rendered, YouTube's control overlay cannot
      // paint over it, and the miniplayer's own sheet hides it with the
      // pill. It is NOT bound to the pill -- a long press there would
      // have made his one escape hatch from a wrong verdict ambiguous,
      // and the panel is a developer tool while the pill is not.
      //
      // Nothing here can fail the player: a panel that cannot be built
      // is a panel that is not there.
      try {
        // His ruling 2026-10-27 (PLAYER_VIDEO_BLUR): with no switch on the
        // player, the gear beside it goes too.
        if (playerSwitchShown()) tuneUi = installTuneUi({
          doc: document,
          host: pillHost,
          win: window,
          pill: pill,
          video: video,
          shipped: shippedTuning,
          nativeInfo: function () {
            return nativeClient && typeof nativeClient.snapshot === 'function' ? nativeClient.snapshot() : null;
          },
        });
        // A run in flight picks itself up here: this is the first moment
        // there is a player to seek, and the arm is already applied
        // (boot). One attach, one arm -- attachRun refuses a second.
        autoTest.attachRun(window, {
          video: video,
          nativeInfo: function () {
            return nativeClient && typeof nativeClient.snapshot === 'function' ? nativeClient.snapshot() : null;
          },
          codecInfo: function () { return codecProbe.served(); },
          // O5 (phase-o): what the row was actually measuring, alongside
          // the drop percentage -- playerBlurOn is in scope right here.
          blurOn: function () { return !!playerBlurOn; },
        });
      } catch (e) {
        /* the panel is a tool, the player is the product */
      }
      // THE PILL AND THE GEAR ARE WATCH-PAGE CONTROLS, AND THE PLAYER
      // THEY LIVE ON OUTLIVES THE WATCH PAGE.
      //
      // On m.youtube #player-container-id is SHARED: the feed plays its
      // autoplay previews into it, and leaving /watch by a single-page
      // navigation collapses it to height 0 at the top of the feed
      // rather than removing it. The <video> inside stays CONNECTED, so
      // the teardown below -- which only fires on a disconnected or
      // failed video -- never ran, and the pill and gear stayed on
      // screen with no player behind them.
      //
      // MEASURED 2026-09-03 on the Redmi, m.youtube home, path "/":
      // pill "Blur on" at (716,96) 99x36 and the gear at (675,96) 36x36
      // while #player-container-id measures 823x0. A fixed badge at the
      // top right of a feed that scrolls under it, so every video in
      // turn wears it -- his report, "when I am just scrolling it gets
      // highlighted and whatnot".
      //
      // Hidden rather than destroyed: the same player comes back on the
      // next watch page, and rebuilding the panel would drop his
      // overrides with it. The gear is found by class because
      // installTuneUi owns the element.
      //
      // The gate is the miniplayer's, for the miniplayer's reason: a
      // preview is transient, the switch is a watch-page control, and a
      // preview is covered WHOLE anyway, so there is no per-face verdict
      // on it for the pill to undo.
      var chromeHidden = false;
      var setChrome = function (hide) {
        // No switch on the player (PLAYER_VIDEO_BLUR 0): the pill still
        // exists, because the watcher below is what turns a feed preview's
        // blur off when the page becomes a watch page, but it is never shown.
        hide = hide || !playerSwitchShown();
        if (hide === chromeHidden) return;
        chromeHidden = hide;
        pill.style.display = hide ? 'none' : 'flex';
        var gear = (tuneUi && tuneUi.gear) ||
          (pillHost.querySelector ? pillHost.querySelector('.ts-gaze-gear') : null);
        if (gear) gear.style.display = hide ? 'none' : '';
        if (hide && tuneUi) {
          try { tuneUi.close(); } catch (e) { /* already gone with the host */ }
        }
      };
      setChrome(feedPreview());
      var pillWatch = setInterval(function () {
        if (!video.isConnected || failed) {
          clearInterval(pillWatch);
          // O2 (phase-o): the video this run was attached to is gone or
          // dead -- a timer it armed must not fire against whatever
          // attaches next.
          try { autoTest.cancelRun(window); } catch (e) {}
          if (pill.parentNode) pill.parentNode.removeChild(pill);
          if (tuneUi) {
            try { tuneUi.destroy(); } catch (e) { /* already gone with the host */ }
            tuneUi = null;
          }
          return;
        }
        setChrome(feedPreview());
        // The page moved on to a DIFFERENT video (an SPA watch->watch
        // whose loadstart came before the URL changed, or off /watch to
        // the feed's previews): follow it to that page's default.
        var wantOn = playerBlurWantedNow();
        if (wantOn !== playerBlurOn) setPlayerBlur(wantOn, false);
      }, 250);
    }

    if (!video.paused) start();
  }

  // ---- discovery: MutationObserver + initial sweep --------------------
  // Discovery has to pierce shadow DOM: Reddit's player custom element
  // keeps its <video> inside an open shadow root, invisible to both
  // querySelectorAll and a document-level MutationObserver (probe25
  // 2026-08-19: feed videos played with zero gaze classes — the whole
  // video pipeline was unreachable on Reddit). Three legs: the light-DOM
  // scan below descends into any open roots it passes, boot() deep-scans
  // roots that existed before us, and attachShadow is wrapped so roots
  // created after us register the moment they exist.
  var OBSERVER_CONFIG = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  };

  var observedRoots = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

  function observeRoot(root) {
    if (failed || !root) return;
    if (observedRoots) {
      if (observedRoots.has(root)) return;
      observedRoots.add(root);
    }
    try {
      observer.observe(root, OBSERVER_CONFIG);
    } catch (e) {
      /* not a valid observe target — nothing to watch */
    }
    // Document styles stop at the shadow boundary; without this the
    // pending/flagged classes inside the root are inert (probe26).
    dom.injectStyleInto(root);
    scanAdded(root);
  }

  function scanAdded(node) {
    // 1 = element, 11 = shadow root (DocumentFragment) — both scannable.
    if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return;
    if (node.tagName === 'IMG') tagImage(node);
    else if (node.tagName === 'VIDEO') attachVideo(node);
    if (node.nodeType === 1 && node.shadowRoot) observeRoot(node.shadowRoot);
    if (!node.querySelectorAll) return;
    var imgs = node.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) tagImage(imgs[i]);
    var vids = node.querySelectorAll('video');
    for (var j = 0; j < vids.length; j++) attachVideo(vids[j]);
    var all = node.querySelectorAll('*');
    for (var k = 0; k < all.length; k++) {
      if (all[k].shadowRoot) observeRoot(all[k].shadowRoot);
    }
  }

  var observer = new MutationObserver(function (mutations) {
    if (failed) return;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'childList') {
        m.addedNodes.forEach(scanAdded);
      } else if (m.type === 'attributes' && m.target && m.target.tagName === 'IMG') {
        if (!dom.hasPlayerAncestor(m.target)) retagImage(m.target);
      }
    }
  });

  function startObserving() {
    observer.observe(document.documentElement, OBSERVER_CONFIG);
    // scanAdded also deep-scans: it descends into every open shadow
    // root already in the tree and registers it with the observer.
    scanAdded(document.documentElement);
  }

  // Roots created after boot: wrap attachShadow so they register at
  // creation. Pure pass-through otherwise — same return value, and a
  // failure in our side never reaches the page (observeRoot guards).
  var origAttachShadow = Element.prototype.attachShadow;
  if (typeof origAttachShadow === 'function') {
    Element.prototype.attachShadow = function (init) {
      var root = origAttachShadow.call(this, init);
      observeRoot(root);
      return root;
    };
  }

  function boot() {
    if (document.documentElement) startObserving();
    else document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  }

  boot();

  // Model loading is deferred to POST-LOAD IDLE (owner report
  // 2026-08-22, "lot of loading": tf's webgl backend init compiles
  // shaders on the main thread and the model parses are heavy — doing
  // that while the page is still fetching and painting is exactly the
  // jank a low-end phone can't hide). Blur-first is already live via
  // boot(), so everything sits safely pending until the models arrive;
  // deferral only ever delays UNBLURRING, never exposure. The 5s timer
  // is the fallback for documents whose load event already fired or
  // never fires.
  function whenSettled(fn) {
    var fired = false;
    var go = function () {
      if (fired) return;
      fired = true;
      idle(fn);
    };
    // The hard cap is unconditional now. It used to arm only when the
    // document had not finished loading, on the assumption that `load`
    // was the long pole -- but the measurement above put the delay after
    // that, in the idle wait, and a page that never goes idle is exactly
    // the page whose `load` also drags. 4s is the ceiling on how long a
    // thumbnail may sit covered for scheduling reasons alone.
    // Already complete when we were evaluated? Then there is nothing
    // left to defer AROUND. Measured on desktop: the bundle is not
    // evaluated until the page-load Finished event (eval starts at 8.1s
    // on a throttled search page), so by the time this runs the document
    // is as settled as it is going to get, and the extra 250ms was pure
    // delay in front of a user who is already waiting.
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', function () { setTimeout(go, 250); }, { once: true });
    setTimeout(go, 4000);
  }

  // NSFW-only modes (off / blur-all): the face and gender models never
  // load — only the classifier the compulsory tier needs. If it cannot
  // load, fail open: in "off", pre-blurred media would otherwise stay
  // covered forever on a page the user asked to see unblurred.
  //
  // Off mode may NOT defer the load (review 2026-08-23 #8): its
  // pre-blur holds the whole feed hostage until the classifier clears
  // it — a user who chose "Off" staring at seconds of blur is the
  // deferral backfiring. Blur-all defers: its blur IS the intended
  // visual, NSFW removal timing is not user-visible.
  if (!plan.faceGender) {
    var kickNsfw = function () {
      detector
        .loadNsfwModel()
        .then(function (nsfw) {
          if (failed) return;
          nsfwModel = nsfw;
          if (imageQueue.length) drainImages();
        })
        .catch(function (e) {
          failOpen('nsfw model unavailable', e);
        });
    };
    if (plan.preBlur) kickNsfw();
    else whenSettled(kickNsfw);
    return;
  }

  // Blur-first is already live via boot(); load the detector once the
  // page settles and only start draining once it's ready. A failure
  // here is exactly the "AI never in the critical path" rule from
  // VISION.md applied to failure, not just latency: if it can't run,
  // don't punish the page.
  // THE WORKER STARTS IMMEDIATELY, the in-page models still wait.
  //
  // Fetching and compiling a 16MB script off-thread costs the page
  // nothing that matters -- the whole point is that none of it lands on
  // the thread drawing the feed -- so the sooner it starts, the sooner
  // thumbnails resolve. The in-page path keeps its post-load-idle
  // deferral, because that one DOES compile shaders on this thread.
  startInferenceWorker();
  startDiagnostics();

  // DIAGNOSTICS THAT CAN LEAVE THE PAGE.
  //
  // Owner 2026-08-28: "can't you implement a diagnostics feature in the
  // app so that it automatically gets reported ... or give me the
  // control of reporting". He controls it -- nothing here uploads
  // anything. The report is handed to the host process, which appends it
  // to a local file the Settings pane can show and share.
  //
  // The reason this exists at all: every number this project has is from
  // a desktop under a 6x throttle, and his phone is the machine the
  // complaints come from. The report is built and REDACTED by
  // diag-report.mjs, and refused by its own invariant check if anything
  // that could identify what he watched survived -- see that file.
  var DIAG_INTERVAL_MS = 300000;
  var lastDiagAt = 0;
  var longTasks = 0;
  var longTaskMax = 0;
  // WHOSE LONG TASK WAS IT?
  //
  // His phone reported 77 long tasks, worst 360ms, and the count alone
  // cannot say whether that is our inference or YouTube's own work --
  // which is the difference between a bug we can fix and a number we
  // have to live with. `spends` already records every main-thread
  // segment we knowingly spend (the image budget is built on it), so a
  // long task that OVERLAPS one of those segments had our work inside
  // it. Overlap is not authorship: a 360ms task can be YouTube's with
  // 20ms of ours in the middle. It is still the only attribution
  // available from inside the page, and 0 overlaps would settle it
  // outright.
  var longTasksOurs = 0;
  var longTaskOursMax = 0;
  function taskOverlapsOurWork(startTime, duration) {
    var end = startTime + duration;
    for (var i = 0; i < spends.length; i += 2) {
      var segEnd = spends[i];
      var segStart = segEnd - spends[i + 1];
      if (segStart < end && segEnd > startTime) return true;
    }
    return false;
  }

  function startDiagnostics() {
    try {
      // The main-thread cost the whole worker migration was about, from
      // the browser's own accounting rather than ours.
      if (typeof PerformanceObserver === 'function') {
        new PerformanceObserver(function (list) {
          var e = list.getEntries();
          for (var i = 0; i < e.length; i++) {
            longTasks++;
            if (e[i].duration > longTaskMax) longTaskMax = e[i].duration;
            if (taskOverlapsOurWork(e[i].startTime, e[i].duration)) {
              longTasksOurs++;
              if (e[i].duration > longTaskOursMax) longTaskOursMax = e[i].duration;
            }
          }
        }).observe({ entryTypes: ['longtask'] });
      }
    } catch (e) {
      /* longtask is Chromium-only; its absence is not a failure */
    }
    try {
      // A phone page is not closed, it is HIDDEN. That is the only
      // reliable "this session is over" signal there, so it is the one
      // that drains.
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) submitDiag('hidden');
      });
      // BACK IS A NAVIGATION, NOT A HIDE, and on Android the launcher
      // and every platform share ONE WebView -- so leaving YouTube for
      // the launcher fires pagehide and nothing else. Without this the
      // only way to bank a report was to background the whole app or
      // to browse past the five-minute tick, which is not how anyone
      // uses the thing. Both listeners are idempotent: submitDiag just
      // rebuilds and overwrites.
      addEventListener('pagehide', function () {
        submitDiag('pagehide');
        // O2 (phase-o): the same reason BACK needs its own listener here
        // -- a shared WebView means leaving for the launcher (or any
        // navigation off this document entirely) fires pagehide and
        // nothing else a per-video listener would catch. A settle/measure
        // timer this document armed must die with it.
        try { autoTest.cancelRun(window); } catch (e) {}
      });
      setInterval(function () {
        if (!document.hidden) submitDiag('tick');
      }, DIAG_INTERVAL_MS);
    } catch (e) {
      /* diagnostics must never be the thing that breaks a page */
    }
    try {
      // Probe hook, same shape as __TS_GAZE_RENDER: a report on demand,
      // so a run can be verified without waiting five minutes or
      // pretending the page went away.
      window.__TS_DIAG_NOW = function () {
        submitDiag('probe');
        return window.__TS_DIAG_LAST || null;
      };
    } catch (e) {
      /* a hook that cannot be installed is not a failure */
    }
  }

  /// Bytes of the rules sheet this page actually received.
  function injectedCssBytes() {
    try {
      var el = document.getElementById('tamescroll-rules');
      return el && el.textContent ? el.textContent.length : 0;
    } catch (e) {
      return 0;
    }
  }

  function diagSnapshot() {
    var app = window.__TS_DIAG_APP || {};
    var ua = navigator.userAgent || '';
    var host = '';
    var path = '';
    try {
      host = location.hostname;
      path = location.pathname;
    } catch (e) {
      /* an opaque origin still gets a report, just without a kind */
    }
    var platform = platformOf(host);
    return {
      id: diagId(),
      t: app.t || null,
      versionCode: app.versionCode,
      versionName: app.versionName,
      os: /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows' : 'other',
      // Version-SHAPED substrings only, and diag-report drops anything
      // that is not (a device name with punctuation in it is not worth
      // a violation).
      osVersion: (ua.match(/Android (\d+(?:\.\d+)*)/) || [])[1],
      model: (ua.match(/;\s*([A-Za-z0-9 _-]{2,24})\s*(?:Build|\))/) || [])[1],
      webview: (ua.match(/Chrome\/(\d+(?:\.\d+)*)/) || [])[1],
      cores: navigator.hardwareConcurrency,
      dpr: window.devicePixelRatio,
      vw: window.innerWidth,
      vh: window.innerHeight,
      platform: platform,
      kind: pageKind(platform, path),
      gazeMode: window.__TS_GAZE_MODE || 'none',
      gender: userGender === 'unset' ? 'none' : userGender,
      blurPx: app.blurPx,
      ageMs: Math.round(performance.now()),
      rulesGen: app.rulesGen,
      otaLast: app.otaLast,
      otaAgeH: app.otaAgeH,
      activeRules: app.activeRules,
      // Measured HERE, not stamped by Rust: the injected sheet is what
      // this page actually received, and a page that got the wrong
      // platform's rules (the 2026-08-28 per-host ownership bug) shows
      // up as a byte count that does not match its platform.
      cssBytes: injectedCssBytes(),
      seen: app.seen,
      blocked: app.blocked,
      evalMs: window.__TS_GAZE_EVALMS,
      timing: window.__TS_GAZE_TIMING || {},
      worker: window.__TS_GAZE_WORKER || {},
      imgTotal: imgTotal,
      imgdiag: window.__TS_GAZE_IMGDIAG || [],
      playerAttached: anyVideoAttached,
      codec: codecProbe.served(),
      native: nativeClient && typeof nativeClient.snapshot === 'function' ? nativeClient.snapshot() : null,
      perf: perf.slowStats(),
      // What the presenter painted (phase-n N10): the two dials that
      // change what a patch LOOKS like report here, not only on the
      // probe hook.
      paint: (function () {
        try {
          var d = typeof window.__TS_DELAY_STATS === 'function' ? window.__TS_DELAY_STATS() : null;
          return d && d.stats ? d.stats : null;
        } catch (e) {
          return null;
        }
      })(),
      ids: window.__TS_GAZE_IDS || {},
      // WHICH DIALS THIS PHONE IS ACTUALLY RUNNING, and what the
      // on-device A/B measured. `engine.tuning` says what arrived over
      // the air; a local override wins over that for its own key, so
      // without this a hand-tuned phone reports as a stock one.
      tune: (function () {
        try {
          var b = overrideBlock(window);
          b.autotest = autoTest.results(window);
          return b;
        } catch (e) {
          return null;
        }
      })(),
      render: typeof window.__TS_GAZE_RENDER === 'function' ? window.__TS_GAZE_RENDER() : null,
      longTasks: longTasks,
      longTaskMaxMs: Math.round(longTaskMax),
      longTasksOurs: longTasksOurs,
      longTaskOursMaxMs: Math.round(longTaskOursMax),
    };
  }

  var myDiagId = null;
  function diagId() {
    if (myDiagId) return myDiagId;
    var hex = '0123456789abcdef';
    var out = '';
    for (var i = 0; i < 16; i++) out += hex[(Math.random() * 16) | 0];
    myDiagId = out;
    return out;
  }

  function submitDiag(reason) {
    try {
      var now = performance.now();
      if (reason === 'tick' && now - lastDiagAt < DIAG_INTERVAL_MS - 1000) return;
      lastDiagAt = now;
      var report = buildReport(diagSnapshot());
      // THE SECOND GATE. The unit tests prove the builder redacts; this
      // proves THIS report did, on this page, with this data. A report
      // that fails is dropped, and the fact that it was dropped is the
      // only thing recorded.
      var href = '';
      try {
        href = location.href;
      } catch (e) {
        /* nothing to compare against is not a reason to send anyway */
      }
      var bad = reportViolations(report, href);
      if (bad.length) {
        window.__TS_DIAG_REFUSED = bad.slice(0, 4);
        return;
      }
      var json = JSON.stringify(report);
      // Readable by a desktop probe over CDP; on the phone it goes to
      // the host, which is the only path off the page.
      window.__TS_DIAG_LAST = json;
      if (window.TsDiag && typeof window.TsDiag.submit === 'function') {
        window.TsDiag.submit(json);
      }
    } catch (e) {
      /* a diagnostic that throws is worse than no diagnostic */
    }
  }

  whenSettled(function () {
    if (failed) return;
    // A live worker owns the image path, so the in-page models are only
    // loaded for the PLAYER (attachVideo asks) or when the worker is
    // not coming. Loading both would double the model memory on a phone
    // for no gain.
    if (workerAlive() || (gazeWorker && !gazeWorker.dead())) return;
    ensureFaceModels();
  });

  function startInferenceWorker() {
    if (!plan.boot || failed) return;
    watchNativePort();
    // Probe escape hatch, and the only way to A/B the two paths on one
    // build. Also the switch to pull if the worker ever misbehaves on a
    // platform we cannot reproduce here.
    try {
      if (window.__TS_NO_WORKER) return;
    } catch (e) {
      /* no window is not a case that reaches here */
    }
    try {
      bootMark('workerNew');
      gazeWorker = createWorkerClient({
        onEvent: function (ev) {
          try {
            var t = (window.__TS_GAZE_WORKER = window.__TS_GAZE_WORKER || {});
            t[ev.type === 'loaded' || ev.type === 'loadFailed' ? ev.type + ':' + ev.model : ev.type] =
              Math.round(performance.now());
            if (ev.why) t.why = String(ev.why).slice(0, 120);
            if (ev.type === 'up') {
              if (typeof ev.evalMs === 'number') t.evalMs = ev.evalMs;
              if (typeof ev.fetchMs === 'number') t.fetchMs = ev.fetchMs;
              // Was this worker already running when the page bundle
              // arrived, and when was it started? Without both numbers
              // the prestart is unfalsifiable.
              t.prestarted = !!ev.prestarted;
              if (typeof ev.prestartAt === 'number') t.prestartAt = ev.prestartAt;
            }
            // How long each model actually took, not just when it
            // landed: a fresh worker loads all of them on EVERY
            // navigation, and this is what has to come down.
            if (typeof ev.ms === 'number') {
              var ms = (t.ms = t.ms || {});
              ms[ev.type === 'ready' ? 'total' : ev.model] = ev.ms;
            }
            // The bytes half of a model load, and how many there were --
            // a warm cache and a smaller file look identical in `ms`.
            if (ev.type === 'loaded' && typeof ev.fetchMs === 'number') {
              var fm2 = (t.fetch = t.fetch || {});
              fm2[ev.model] = ev.fetchMs;
              if (typeof ev.bytes === 'number') fm2[ev.model + 'B'] = ev.bytes;
            }
            // WHICH BACKEND THE WORKER GOT, kept where a report can read
            // it. This is the single field that decides whether the
            // player path is off the main thread on a given device at
            // all: on CPU, workerVideo() refuses and everything runs
            // exactly as it did before -- silently.
            if (ev.type === 'ready') {
              t.backend = ev.backend || 'none';
              if (typeof ev.warmMs === 'number') t.warmMs = ev.warmMs;
              if (ev.warmParts) t.warmParts = ev.warmParts;
            }
            if (ev.type === 'dead') t.dead = true;
          } catch (e) {
            /* a probe marker must never break the boot */
          }
          if (ev.type === 'loaded' && ev.model === 'gender') releaseGenderHeld();
          if (ev.type === 'up') setTimeout(preloadGender, 0);
          if (ev.type === 'dead') {
            // Whatever it was, the images still have to be judged: fall
            // all the way back to the in-page pipeline, loading the
            // models now because nobody has yet. NSFW too -- while the
            // worker was alive its load was deliberately skipped.
            ensureFaceModels();
            loadInPageNsfw();
            releaseGenderHeld();
            if (imageQueue.length) drainImages();
            return;
          }
          if (ev.type === 'personFailed') {
            // No MoveNet in the worker means no person pass there, and
            // the crops only exist to serve one. The player comes back
            // whole; images are untouched and stay where they are.
            banWorkerVideo('person model');
            return;
          }
          if (ev.type === 'loaded' || ev.type === 'loadFailed' || ev.type === 'ready') {
            if (imageQueue.length) drainImages();
          }
        },
      });
      // A prestarted worker can already be up by now.
      setTimeout(preloadGender, 0);
    } catch (e) {
      gazeWorker = null;
    }
  }

  // Load the face models at most once. Called from the post-load-idle
  // deferral above AND, crucially, the moment a player video actually
  // starts playing (setupVideo): a watched video is held blur-first
  // pending until `model`+`genderSettled` arrive, so if the page never
  // reaches idle (a busy watch page: buffering stream + slow below-fold)
  // the deferral leaves the player permanently blurred — the same
  // "deferral holds it hostage" failure that off mode is exempted from.
  // A user watching a video justifies the load cost then and there.
  function ensureFaceModels() {
    if (faceModelsKicked || failed) return;
    faceModelsKicked = true;
    loadFaceModels();
  }

  // MODEL LOAD TIMING. Four models load serially and every number this
  // project has for them came from an RTX desktop, where the whole chain
  // is under a second and invisible. Under a 6x main-thread throttle the
  // person model -- the one a playing video is waiting on -- was not
  // ready for 12.6s, and until it is the player falls back to blurring
  // the WHOLE video. Ten seconds of a fully blurred video is the owner's
  // "low quality" as much as any edge is. Guarded, and read through
  // window.__TS_GAZE_TIMING by the perf probe.
  function markLoad(name, at) {
    try {
      var t = (window.__TS_GAZE_TIMING = window.__TS_GAZE_TIMING || {});
      t[name] = Math.round(performance.now() - at);
      t[name + 'At'] = Math.round(performance.now());
    } catch (e) {}
  }

  // The worker owns the image path exactly while it is alive and not
  // known-dead. Anything the in-page pipeline loads ONLY for images can
  // be skipped while this holds.
  function workerOwnsImages() {
    try {
      return !!(gazeWorker && !gazeWorker.dead());
    } catch (e) {
      return false;
    }
  }

  // Called when the worker dies after we skipped this load.
  function loadInPageNsfw() {
    if (nsfwModel) return Promise.resolve(nsfwModel);
    return detector.loadNsfwModel().then(
      function (nsfw) {
        nsfwModel = nsfw;
        nsfwSettled = true;
        if (imageQueue.length) drainImages();
        return nsfw;
      },
      function (e) {
        // eslint-disable-next-line no-console
        console.warn('tamescroll gaze: nsfw model unavailable, face-only', e);
        nsfwSettled = true;
        if (imageQueue.length) drainImages();
        return null;
      }
    );
  }

  // The no-video ordering: the model the image drain is waiting on
  // first, the player's model after it. Same loads, same failure
  // handling, opposite order — see the comment at the swap.
  function nsfwThenPerson() {
    if (workerOwnsImages()) {
      // Nothing on this page is waiting for an in-page NSFW answer, so
      // go straight to the model a player would want.
      nsfwSettled = true;
      if (personWanted) return Promise.resolve(ensurePersonModel());
      return Promise.resolve();
    }
    var t1 = performance.now();
    return detector
      .loadNsfwModel()
      .then(
        function (nsfw) {
          nsfwModel = nsfw;
          markLoad('nsfw', t1);
        },
        function (e) {
          // eslint-disable-next-line no-console
          console.warn('tamescroll gaze: nsfw model unavailable, face-only', e);
        }
      )
      .then(function () {
        nsfwSettled = true;
        if (imageQueue.length) drainImages();
        // NOT loaded here any more. A search or feed page has nothing
        // that can use MoveNet, and loading it anyway spent 1.1s of the
        // main thread (6x throttle) in the exact window the owner is
        // waiting on thumbnails. attachVideo asks for it the moment a
        // video exists -- including one that arrives by SPA navigation,
        // where the bundle is never re-evaluated and this is the only
        // thing that would ever ask.
        //
        // The wait that buys is fail-safe: until the model lands the
        // player runs the whole-blur path, which covers rather than
        // exposes.
        if (personWanted) return ensurePersonModel();
      });
  }

  function ensurePersonModel() {
    personWanted = true;
    if (personModel || personLoading) return personLoading;
    // Order still holds: whatever the image drain is waiting on goes
    // first. Asking before nsfw has settled would put MoveNet back in
    // front of the reveal, which is the bug this ordering fixed.
    if (!nsfwSettled) return null;
    var tp = performance.now();
    personLoading = detector.loadPersonModel().then(
      function (person) {
        personModel = person;
        markLoad('person', tp);
      },
      function (e) {
        // eslint-disable-next-line no-console
        console.warn('tamescroll gaze: person model unavailable, whole-blur player', e);
      }
    );
    return personLoading;
  }

  function loadFaceModels() {
  var t0 = performance.now();
  detector
    .loadModel()
    .then(function (loaded) {
      markLoad('face', t0);
      if (failed) return;
      model = loaded;
      // Gender loads SECOND, before NSFW: the drain waits for it to
      // settle (flags handed out without it are permanent — the
      // both-genders-blurred phone bug), so it is on the unblur
      // critical path. Failure degrades to presence-only for every
      // image equally.
      return detector
        .loadGenderModel()
        .then(
          function (gender) {
            genderModel = gender;
            markLoad('gender', t0);
          },
          function (e) {
            // eslint-disable-next-line no-console
            console.warn('tamescroll gaze: gender model unavailable, presence-only', e);
          }
        )
        .then(function () {
          genderSettled = true;
          if (imageQueue.length) drainImages();
          // WHICH MODEL IS THIRD DEPENDS ON THE PAGE (owner 2026-08-27,
          // phone, on a SEARCH page: "still taking long to load").
          //
          // Person was unconditionally third because a playing video
          // waits on it. But the image drain waits for nsfwSettled, and
          // nsfw is loaded LAST -- so on a page with no video at all,
          // every thumbnail sat covered through a 1.1s person-model load
          // that nothing on the page could use. Measured under a 6x
          // throttle on a search page: person 1100ms, sitting directly
          // in front of the load that actually gates the reveal.
          //
          // So the two swap when the document has no video element. A
          // feed preview creates one on demand and a watch page has one
          // before we ever get here, so the check errs toward the old
          // order whenever a player might be involved.
          var playerLikely = true;
          try {
            playerLikely = !!document.querySelector('video');
          } catch (e) {
            /* keep the player-first order if the query fails */
          }
          if (!playerLikely) return nsfwThenPerson();
          // Person model THIRD (redesign 2026-08-24): the player's
          // region path is person-primary now, so the model a playing
          // video is waiting on outranks NSFW (which only ever ADDS
          // removals). Failure degrades the player to whole blur.
          return detector
            .loadPersonModel()
            .then(
              function (person) {
                personModel = person;
                markLoad('person', t0);
              },
              function (e) {
                // eslint-disable-next-line no-console
                console.warn('tamescroll gaze: person model unavailable, whole-blur player', e);
              }
            )
            .then(function () {
              // NSFW IS THE WORKER'S JOB WHEN THERE IS A WORKER.
              //
              // In page, this model exists for the image pipeline -- the
              // video path has never used it. With the worker alive the
              // images are classified there, so loading a second copy
              // here buys nothing and costs a model's worth of memory on
              // the device that can least afford it, on a watch page
              // where the page ALREADY holds face, gender and MoveNet.
              // If the worker dies, its 'dead' handler calls
              // loadInPageNsfw() and the in-page drain waits as before.
              if (workerOwnsImages()) return null;
              // NSFW last. Images verified face-clean before it arrives
              // were cleared under face-only rules — acceptable:
              // blur-first already held while they were pending, and the
              // next src swap re-checks.
              return detector.loadNsfwModel().then(
                function (nsfw) {
                  nsfwModel = nsfw;
                  markLoad('nsfw', t0);
                },
                function (e) {
                  // Degrade to face-only, loudly but harmlessly.
                  // eslint-disable-next-line no-console
                  console.warn('tamescroll gaze: nsfw model unavailable, face-only', e);
                }
              );
            })
            .then(function () {
              nsfwSettled = true;
              if (imageQueue.length) drainImages();
            });
        });
    })
    .catch(function (e) {
      failOpen('detector init error', e);
    });
  }
})();
