// Face detector + gender classifier wrapping the embedded models.
//
// Clean-room note (docs/gaze-research.md §5): HaramBlur is AGPL-3.0 and
// cited as a behaviour reference ONLY — nothing here comes from it. The
// box decode + anchor generation below are adapted from vladmandic/human
// (MIT — see NOTICE), which implements the standard MediaPipe BlazeFace
// SSD decode for the exact 4-output converted model we embed.
//
// v1 was presence-only ("is there a face"). The protection engine's
// gender stage (docs/handoff-protection-engine.md decision #3) needs
// per-face boxes + per-face gender, so the decode now runs in full:
// classificator logits + box regressors -> anchors -> NMS -> boxes,
// then gender (Oarriaga mini-Xception, 64x64 grayscale) per surviving
// box. NMS + decode run in plain JS off a SINGLE tensor download: every
// extra GPU->CPU download is a fence wait, and hidden pages clamp those
// to ~1s each (Chrome nested-timer throttling, found 2026-08-23).
import * as tf from '@tensorflow/tfjs-core';
import { squareBox, fitBox } from './crop-geometry.mjs';
import * as genderInput from './gender-input.mjs';
import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgl';
import * as tfconv from '@tensorflow/tfjs-converter';
// The blobs arrive through one indirection so the PAGE build can ship
// without them -- see model-blobs.mjs. Every loader below awaits ready()
// before asking for bytes; in the full artifact that resolves
// immediately, and in the page artifact it fetches them once, only if
// the worker is unavailable and the in-page pipeline is actually needed.
import { ready as modelsReady, blob as modelBlob } from './model-blobs-lazy.mjs';
import {
  parsePersons,
  frameHasNoHumanShape,
  frameMaxKp,
  rejectedSlotBoxes,
  lastSlotDiag,
  unpadPersons,
} from './person-gate.mjs';
// The BlazeFace anchor/NMS decode and the faceres verdict loop live in
// face-decode.mjs now -- the native (TFLite) path needs the exact same
// arithmetic and has no tensor ops to do it with, so this is the one
// copy both paths call. See face-decode.mjs's header.
import { generateAnchors, facesFromRows, genderReadsFromOutputs, FACE_MIN_CONFIDENCE } from './face-decode.mjs';

import { synthetic } from './synthetic-url.mjs';
export var INPUT_SIZE = 256; // matches the embedded face model's fixed input shape
export var NSFW_INPUT_SIZE = 224; // MobileNetV2Mid fixed input shape
export var GENDER_INPUT_SIZE = 224; // faceres (HSE-FaceRes) fixed input shape


// Face-box knobs — registered in docs/detection-engine.md.
// 0.2 -> 0.35 2026-08-24 (owner: "sometimes false blurs"): sub-0.35
// detections on the observed set were mostly non-faces (patterns,
// hands), each one a phantom patch. Still below the 0.5 common default
// so obscured real faces keep flagging — fail-safe leans kept.
//
// FACE_IOU / FACE_MAX / FACE_ENLARGE and the R26 calibration story for
// the 1.4 enlarge factor now live in face-decode.mjs, next to the NMS
// call that uses them -- this re-export is the one place detector.js's
// own callers (init-entry.js reads `detector.FACE_MIN_CONFIDENCE`) still
// see it.
export { FACE_MIN_CONFIDENCE };

function b64ToBuffer(b64) {
  var binStr = atob(b64);
  var len = binStr.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes.buffer;
}

// tf.io.IOHandler.load() must return ModelArtifacts — NOT the raw
// model.json shape: weightSpecs (flattened, no `paths`) rather than
// weightsManifest, plus format/signature so GraphModel can resolve
// default outputs.
function artifacts(modelJson, weightData) {
  var weightSpecs = [];
  for (var g = 0; g < modelJson.weightsManifest.length; g++) {
    var group = modelJson.weightsManifest[g];
    for (var w = 0; w < group.weights.length; w++) weightSpecs.push(group.weights[w]);
  }
  return {
    modelTopology: modelJson.modelTopology,
    weightSpecs: weightSpecs,
    weightData: weightData,
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    convertedBy: modelJson.convertedBy,
    signature: modelJson.signature,
    userDefinedMetadata: modelJson.userDefinedMetadata,
  };
}

function embeddedIoHandler(modelJson, weightsB64) {
  return {
    load: function () {
      return Promise.resolve(artifacts(modelJson, b64ToBuffer(weightsB64)));
    },
  };
}

// THE MODELS, FETCHED AS THEMSELVES.
//
// Inlined base64 was the only delivery that worked when this was
// written; measured again 2026-08-29 on the live app, fetching our own
// synthetic url succeeds on reddit (214ms), x (184ms) and m.youtube
// (176ms) with no CSP violation. What inlining costs is paid on every
// single worker start: 93.9% of a 22.7MB script is base64 that has to be
// parsed as JS and then decoded. Raw bytes skip both.
//
// The inlined copy remains the fallback: if a platform ever does refuse
// the fetch, the alternative is a pipeline with no models at all, which
// leaves every image covered forever.
var MODEL_ASSETS = {
  face: 'blazeface',
  gender: 'faceres',
  nsfw: 'nsfw',
  person: 'person',
};

function assetOrigin() {
  try {
    if (typeof location !== 'undefined' && location.origin) return location.origin;
  } catch (e) {
    /* a worker with no location falls through to a relative url */
  }
  return '';
}

// THE BROWSER EXTENSION SERVES THE MODELS FROM ITS OWN PACKAGE.
//
// The app answers /__tamescroll/models/ on the page's own origin; the
// extension has no request interceptor, and Chrome reserves every
// package path that starts with an underscore, so its content script
// names a base of its own (extension/src/gaze-prelude.js) and the files
// are fetched from chrome-extension://.../gaze-models/. Unset on every
// app build, where this is the old url exactly.
function modelBase() {
  try {
    var b = globalThis.__TS_GAZE_MODEL_BASE;
    if (typeof b === 'string' && b) return b;
  } catch (e) {
    /* no globalThis is not a case any supported engine has */
  }
  return assetOrigin() + '/__tamescroll/models/';
}

/**
 * How long each model's BYTES took, apart from building its graph.
 *
 * `ms.gender` in the boot record spans both, and on 2026-08-31 that made
 * a candidate model unmeasurable: three runs read 1012, 1411 and 299ms,
 * and 299ms is a warm HTTP cache rather than a faster model. Bytes and
 * graph are different levers -- a smaller file moves the first, a
 * simpler graph the second -- so they are timed apart.
 */
export var fetchMsByKind = {};

async function fetchedArtifacts(kind) {
  var base = modelBase() + MODEL_ASSETS[kind];
  var at = typeof performance !== 'undefined' ? performance.now() : 0;
  var jsonRes = await fetch(synthetic(base + '.json'));
  if (!jsonRes.ok) throw new Error('model json ' + jsonRes.status);
  var modelJson = await jsonRes.json();
  var binRes = await fetch(synthetic(base + '.bin'));
  if (!binRes.ok) throw new Error('model bin ' + binRes.status);
  var weightData = await binRes.arrayBuffer();
  if (!weightData || !weightData.byteLength) throw new Error('model bin empty');
  try {
    fetchMsByKind[kind] = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : 0) - at
    );
    // Bytes on the wire, so a cache hit is visible as such rather than
    // read as a smaller model.
    fetchMsByKind[kind + ':bytes'] = weightData.byteLength;
  } catch (e) {
    /* instrumentation must never fail a load */
  }
  return artifacts(modelJson, weightData);
}

/**
 * An IOHandler for one model: fetched bytes when we can get them, the
 * inlined base64 when we cannot. Never throws for a reason the caller
 * can do anything about -- a total failure surfaces as a load failure,
 * which every caller already degrades from.
 */
async function ioHandlerFor(kind) {
  // Already here? Then this is a page that was handed the full bundle
  // because our own urls do not work on this host (lib.rs
  // synthetic_reachable), and asking for them would buy a 404.
  try {
    var have = modelBlob(kind);
    if (have) return embeddedIoHandler(have[0], have[1]);
  } catch (e) {
    /* no blobs on this thread: fetch below */
  }
  try {
    var a = await fetchedArtifacts(kind);
    return {
      load: function () {
        return Promise.resolve(a);
      },
    };
  } catch (e) {
    await modelsReady();
    var b = modelBlob(kind);
    if (!b) throw e;
    return embeddedIoHandler(b[0], b[1]);
  }
}



// SEGMENTATION COST SPIKE (owner ask, target 4 of the stability round).
// Measurement only, and deliberately NOT wired into any pipeline: the
// instruction is to get the NUMBER before building on it. The model is
// handed in as base64 over the debug channel rather than embedded,
// because embedding it would grow the shipped bundle for a spike, and
// the platform CSPs forbid fetching it at runtime. Guarded and wrapped:
// instrumentation must never be able to throw inside the pipeline.
try {
  if (typeof window !== 'undefined') {
    window.__TS_GAZE_SEG_SPIKE = async function (modelJsonStr, weightsB64, opts) {
      try {
        var o = opts || {};
        var size = o.size || 256;
        var iters = o.iters || 30;
        await initBackend();
        var t0 = (typeof performance !== 'undefined' ? performance : Date).now();
        var m = await tfconv.loadGraphModel(embeddedIoHandler(JSON.parse(modelJsonStr), weightsB64));
        var loadMs = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
        var video = document.querySelector('video');
        if (!video) return { error: 'no video element' };
        var warm = [];
        var runs = [];
        for (var i = 0; i < iters; i++) {
          var a = (typeof performance !== 'undefined' ? performance : Date).now();
          var res = tf.tidy(function () {
            var img = tf.browser.fromPixels(video);
            var r = tf.image.resizeBilinear(tf.expandDims(img, 0), [size, size]);
            return m.execute(tf.div(tf.cast(r, 'float32'), 255));
          });
          // The download is the honest half of the cost -- a mask that
          // never leaves the GPU cannot be intersected with a track box
          // in JS, and every consumer we would build needs the pixels.
          var data = await res.data();
          tf.dispose(res);
          var b = (typeof performance !== 'undefined' ? performance : Date).now();
          (i < 5 ? warm : runs).push(+(b - a).toFixed(2));
          if (i === iters - 1) warm.push(data.length);
        }
        runs.sort(function (x, y) { return x - y; });
        m.dispose();
        return {
          loadMs: +loadMs.toFixed(1),
          size: size,
          iters: runs.length,
          warmup: warm.slice(0, 5),
          p50: runs[Math.floor(runs.length * 0.5)],
          p90: runs[Math.floor(runs.length * 0.9)],
          min: runs[0],
          max: runs[runs.length - 1],
          backend: tf.getBackend(),
          mem: tf.memory().numTensors,
        };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    };
  }
} catch (e) {
  /* no window (tests) */
}

/** Picks WebGL, falls back to CPU. Throws if both fail. Idempotent:
 * every model loader awaits this, because NSFW-only modes (compulsory
 * tier in off/blur-all) load the classifier WITHOUT loadModel() —
 * leaving backend choice to tfjs auto-init there meant an unchosen,
 * possibly-CPU backend. One shared promise, first caller wins. */
var backendReady = null;
function initBackend() {
  if (!backendReady) {
    backendReady = (async function () {
      try {
        // Reuse one shader across differing tensor SHAPES (shape passed as
        // a uniform) instead of recompiling per shape. The batched gender
        // pass runs with a varying face-count first dim, so without this
        // every new face-count on the feed recompiled ~67 shaders on the
        // main thread. Measured on a real Android WebView (2026-08-23):
        // total gender-path compiles 223 -> 98, per-new-batch-size
        // recompiles at batch 5 68 -> 12, gender output bit-identical
        // (male:0.92274 both). Must be set before the backend compiles
        // anything, i.e. before tf.ready().
        tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true);
        // setBackend reports failure BOTH ways: rejecting, or resolving
        // false — a webgl init that fails politely must still fall back.
        var ok = await tf.setBackend('webgl');
        if (!ok) throw new Error('webgl backend unavailable');
        await tf.ready();
      } catch (e) {
        await tf.setBackend('cpu');
        await tf.ready();
      }
    })();
  }
  return backendReady;
}

/** Bench-only: raw tfjs handle so the harness can time individual
 * stages (fromPixels vs execute vs readback) without rebuilding. */
export var tfHandle = tf;

/** Bench-only: load a candidate model by URL so the harness can compare
 * models without re-embedding. Never called from the shipped boot path. */
export function loadModelUrl(url) {
  return tfconv.loadGraphModel(url);
}

/** Bench-only (spikes/perf-harness): pin a specific backend so each can
 * be timed in isolation. Never called from the shipped boot path. */
export async function forceBackend(name) {
  var ok = await tf.setBackend(name);
  if (!ok) throw new Error(name + ' backend unavailable');
  await tf.ready();
  backendReady = Promise.resolve();
}

/** Loads backend + model. Throws on total failure — caller fails open. */
export async function loadModel() {
  await initBackend();
  return tfconv.loadGraphModel(await ioHandlerFor('face'));
}

/**
 * Loads the NSFW classifier (nsfwjs MobileNetV2Mid, MIT — see NOTICE).
 * Loaded separately from the face model so a failure here degrades to
 * face-only detection instead of taking the whole pipeline down.
 */
export async function loadNsfwModel() {
  await initBackend();
  return tfconv.loadGraphModel(await ioHandlerFor('nsfw'));
}

/**
 * Loads the gender classifier (HSE-FaceRes via vladmandic/human-models
 * faceres.json, MIT — see NOTICE; replaced mini-Xception 2026-08-24
 * after live calibration showed its scores unusable on real thumbnails,
 * see embed-gender.js). Separate load like the NSFW model: a failure
 * degrades to presence-only flagging (any face stays covered), never a
 * break.
 */
export async function loadGenderModel() {
  await initBackend();
  return tfconv.loadGraphModel(await ioHandlerFor('gender'));
}

// Person model input dim (MoveNet MultiPose: dynamic, multiple of 32,
// 128-512; 256 = documented accuracy/speed default). A 192 experiment
// (owner phone "very laggy") was reverted same night: a small corner
// facecam person went undetected — small subjects are the owner's
// oldest complaint, and the ADAPTIVE pass cadence (init-entry) is the
// phone lever instead. Registered in docs/detection-engine.md.
export var PERSON_INPUT_SIZE = 256;

// LETTERBOX THE PERSON PASS INSTEAD OF SQUASHING IT (findings 16b).
//
// The resize below has always been an unconditional square, so on his
// 640x360 decode every person reaches a COCO-trained detector at 56% of
// natural width.
//
// SHIPS OFF, AND THE REASON IS A RESULT RATHER THAN A SEQUENCING
// ARGUMENT (findings 18). 16b measured +22.8% admissions at a flat 0.35
// slot-score threshold on the RAW model output. Through the SHIPPED gate
// -- which is an anchor gate, an evidence gate, a size gate, a keypoint
// union and hysteresis, not a threshold -- 225 corpus frames give
// **373 admissions against 373, exactly flat**, with the more/less split
// at 47-44 (sign test p = 0.83).
//
// WHAT SURVIVES is narrower and better: **8 frames where only the
// letterbox admits ANYBODY against 1** (p = 0.039). A frame that admits
// nobody does not get a smaller patch, it gets no measured body at all
// and falls back to a synthetic one projected from the face. Eight
// frames in 225 does not yet pay for re-scoring the whole labelled
// corpus, which is what flipping this costs.
//
// The flag exists so both arms run on one build. `unpadPersons` is
// correct and measured -- 315 matched people, median edge deltas exactly
// 0.000, 0 boxes out of range -- so the geometry is not what is holding
// it back.
export var PERSON_LETTERBOX = false;
export function setPersonLetterbox(v) { PERSON_LETTERBOX = !!v; }

/**
 * Loads the person/pose model (MoveNet MultiPose Lightning, Apache-2.0
 * — see NOTICE; our hybrid uint8/f16 requant of Google's f16 tfjs
 * release, build/requant-uint8.py). Separate load like NSFW/gender: a
 * failure degrades to no person gating (fail-safe: nothing extra is
 * dropped, backside coverage just doesn't happen).
 */
export async function loadPersonModel() {
  await initBackend();
  return tfconv.loadGraphModel(await ioHandlerFor('person'));
}

/**
 * Person boxes for a frame. pixelSource should already be square (the
 * caller's sample canvas stretches the video the same way the face path
 * does, so face and person coordinates live in the same stretched
 * space). MoveNet wants RAW int32 pixels — no normalization (unlike
 * BlazeFace's [-1,1]); output [1,6,56] parsed by person-gate.mjs.
 */
// Probe only: tfjs is bundled, not global, so a leak check has no way to
// reach tf.memory() from page scope. Wrapped and guarded -- instrumentation
// must never be able to throw inside the pipeline (that cost two releases).
try {
  if (typeof window !== 'undefined') {
    window.__TS_GAZE_MEM = function () {
      try {
        return tf.memory();
      } catch (e) {
        return null;
      }
    };
  }
} catch (e) {
  /* no window (tests) */
}

// ONE UPLOAD PER VERDICT PASS, SHARED BY BOTH DETECTORS.
//
// On the fast path both the person pass and the full-frame face pass read
// the SAME <video> element, and each uploaded it independently. At 1080p
// that is ~8.3MB per fromPixels, so ~16.6MB per verdict pass across a
// shared memory bus -- half of it pure duplication. Invisible on a
// discrete GPU, which is why every previous measurement missed it; the
// target is a Helio G88 with a Mali-G52 and LPDDR4X, where bandwidth is
// the scarce resource, not shader throughput.
//
// Caller owns the tensor and must dispose it. Returns null if the source
// cannot be uploaded, in which case each detector falls back to its own
// upload and behaviour is exactly as before.
/** Which tfjs backend actually got picked. The worker reports this to
 * the page: routing the PLAYER's 4Hz pipeline into a worker that fell
 * back to CPU would be slower than the main thread, not faster, so the
 * page only hands the video path over when this says 'webgl'. */
// COMPILE THE SHADERS BEFORE A USER IS WAITING ON THEM.
//
// Measured 2026-08-29 on a fresh m.youtube navigation: the models were
// loaded and reporting ready at 738ms, the drain dispatched its first
// batch at 738ms -- and the first thumbnail resolved at 1990ms. Every
// image after it took 60-100ms. The 1.25s is WebGL kernel compilation,
// which tfjs does lazily on the first execution of each graph, and a
// hard navigation means a fresh worker paying it again every time.
//
// Running each model once on a blank frame moves that cost into the
// window where the page is still loading anyway. Failures are ignored
// on purpose: a warm-up is an optimisation, and a model that cannot run
// on a blank frame will report its real error on a real one.
export async function warmUp(models) {
  if (typeof ImageData === 'undefined') return;
  var pix;
  try {
    pix = new ImageData(WARM_SIZE, WARM_SIZE);
  } catch (e) {
    return;
  }
  var frame = uploadFrame(pix);
  if (!frame) return null;
  var t = {};
  async function timed(name, run) {
    var at = performance.now();
    await run().catch(noop);
    t[name] = Math.round(performance.now() - at);
  }
  try {
    // A blank frame finds no faces, so the gender model has to be handed
    // a box directly or its graph never runs.
    var box = { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 };
    await timed('compile', function () {
      return compileOnly(models, pix, frame, box);
    });
    // THE BLANK REAL RUNS ARE NOT ON THE CRITICAL PATH EITHER.
    //
    // compileOnly above is what buys the parallel shader compilation.
    // What followed it was one full inference per model on a blank
    // frame, and the point of a warm-up is to make the FIRST REAL IMAGE
    // cheap -- but a blank run does not make it cheaper, it does the
    // same work earlier, on a frame nobody is looking at, while the
    // drain waits and the whole fold stays covered.
    //
    // MEASURED on a real Android WebView 2026-08-30: compile phases
    // 1532 + 10385 + 1383ms, blank runs 10040 + 4044 + 10763ms on top of
    // them, and `ready` -- which gates every verdict -- came at 24,040ms.
    // Whatever the blank runs would have saved the first image, the user
    // paid for it up front and then waited for it again.
    //
    // Still available for benchmarking, where the point IS to separate
    // compilation from execution.
    if (warmBench()) {
      if (models.face) await timed('face', function () { return detectFaceBoxes(models.face, pix, frame); });
      if (models.gender) {
        await timed('gender', function () {
          return classifyFaceGenders(models.gender, pix, [box], frame, { square: true });
        });
      }
      if (models.nsfw) await timed('nsfw', function () { return isNsfw(models.nsfw, pix, frame); });
    // THE SECOND RUN IS A MEASUREMENT, AND IT WAS ON THE CRITICAL PATH.
    //
    // It exists to answer "was all of that one-time compilation?" -- on
    // the desktop it costs 9-18ms and the answer is free. MEASURED on a
    // real Android WebView 2026-08-30: face2 3552ms and nsfw2 3070ms,
    // 6.6 SECONDS of the 15.9s warm-up, and nothing is judged until warm
    // finishes, so the user watched a fully covered feed for it. A
    // diagnostic does not get to delay the first thumbnail.
    //
    // Still available on demand: set __TS_WARM_BENCH before the worker
    // starts and both numbers come back exactly as before.
      if (models.face) await timed('face2', function () { return detectFaceBoxes(models.face, pix, frame); });
      if (models.nsfw) await timed('nsfw2', function () { return isNsfw(models.nsfw, pix, frame); });
    }
  } catch (e) {
    /* see above: a warm-up never reports */
  } finally {
    disposeFrame(frame);
  }
  return t;
}

var WARM_SIZE = 256;
function noop() {}

function warmBench() {
  try {
    return !!globalThis.__TS_WARM_BENCH;
  } catch (e) {
    return false;
  }
}

// COMPILE EVERY SHADER AT ONCE INSTEAD OF ONE AT A TIME.
//
// Measured 2026-08-29: warming the three models in sequence cost
// 1481-2047ms, and a SECOND run of the same graphs cost 9-18ms -- so
// essentially all of it is one-time WebGL program compilation, paid
// again by every fresh worker, which means every hard navigation.
// tfjs can create all the programs first and then wait on them together
// (KHR_parallel_shader_compile), so the driver compiles them in
// parallel rather than blocking on each link in turn.
//
// ENGINE_COMPILE_ONLY makes every kernel build its program and return
// WITHOUT running it, so the reads inside our own passes get nothing --
// they are expected to fail and are swallowed. The flag is restored in a
// finally: leaving it set would make the whole pipeline silently answer
// with empty tensors.
async function compileOnly(models, pix, frame, box) {
  var env;
  try {
    env = tf.env();
    if (!env || typeof env.set !== 'function') return;
  } catch (e) {
    return;
  }
  try {
    env.set('ENGINE_COMPILE_ONLY', true);
    if (models.face) await detectFaceBoxes(models.face, pix, frame).catch(noop);
    if (models.gender) {
      await classifyFaceGenders(models.gender, pix, [box], frame, { square: true }).catch(noop);
    }
    if (models.nsfw) await isNsfw(models.nsfw, pix, frame).catch(noop);
    var b = tf.backend();
    if (b && typeof b.checkCompileCompletionAsync === 'function') {
      await b.checkCompileCompletionAsync();
      b.getUniformLocations();
    }
  } catch (e) {
    /* a failed pre-compile just means the warm-up below pays for it */
  } finally {
    try {
      env.set('ENGINE_COMPILE_ONLY', false);
    } catch (e) {
      /* nothing left to do; the next pass would answer empty */
    }
  }
}

export function backendName() {
  try {
    return tf.getBackend();
  } catch (e) {
    return null;
  }
}

export function uploadFrame(pixelSource) {
  try {
    return tf.browser.fromPixels(pixelSource);
  } catch (e) {
    return null;
  }
}

export function disposeFrame(t) {
  if (t) {
    try {
      tf.dispose(t);
    } catch (e) {
      /* a disposed or foreign tensor must never break the pass */
    }
  }
}

export async function detectPersons(model, pixelSource, aspect, held, sharedImg) {
  // The pad, computed OUTSIDE the tidy and kept as a LOCAL. One detector
  // module instance serves every video element on the page, so module
  // state here would hand a caller another element's geometry -- the R21
  // defect `lastSlotDiag` already carries a paragraph about.
  // fitBox only needs the RATIO and `aspect` is that ratio; the integers
  // below are what the pad is actually built from, so the forward pad and
  // the inverse map cannot disagree by a rounding.
  var lbFit = null;
  if (PERSON_LETTERBOX) {
    var ar = typeof aspect === 'number' && aspect > 0 ? aspect : 16 / 9;
    var f0 = fitBox(ar, 1, PERSON_INPUT_SIZE);
    var dwI = Math.max(1, Math.min(PERSON_INPUT_SIZE, Math.round(f0.dw)));
    var dhI = Math.max(1, Math.min(PERSON_INPUT_SIZE, Math.round(f0.dh)));
    lbFit = {
      dx: Math.floor((PERSON_INPUT_SIZE - dwI) / 2),
      dy: Math.floor((PERSON_INPUT_SIZE - dhI) / 2),
      dw: dwI,
      dh: dhI,
    };
  }
  var out = tf.tidy(function () {
    // `sharedImg` = a frame already uploaded by the caller. See uploadFrame:
    // the person pass and the full-frame face pass run back to back on the
    // SAME video element, and each was doing its own fromPixels of a full
    // 1080p frame -- ~8.3MB across the bus, twice, per verdict pass. A
    // tensor created OUTSIDE this tidy is not disposed by it, so ownership
    // stays with the caller.
    var img = sharedImg || tf.browser.fromPixels(pixelSource);
    var resized;
    if (lbFit) {
      // Fit, then pad with ZERO -- black bars, the same contract as the
      // whole-frame face path's fillRect. MoveNet takes int32 0..255, so
      // 0 is black rather than an undefined value.
      var fitted = tf.image.resizeBilinear(tf.expandDims(img, 0), [lbFit.dh, lbFit.dw]);
      resized = tf.pad(fitted, [
        [0, 0],
        [lbFit.dy, PERSON_INPUT_SIZE - lbFit.dh - lbFit.dy],
        [lbFit.dx, PERSON_INPUT_SIZE - lbFit.dw - lbFit.dx],
        [0, 0],
      ]);
    } else {
      resized = tf.image.resizeBilinear(tf.expandDims(img, 0), [PERSON_INPUT_SIZE, PERSON_INPUT_SIZE]);
    }
    return model.execute(tf.cast(resized, 'int32'));
  });
  var data;
  try {
    data = await out.data();
  } finally {
    tf.dispose(out);
  }
  // MoveNet normalizes its outputs to ITS OWN INPUT, so with a pad in
  // front of it every coordinate is 0..1 of the PADDED CANVAS. Mapped
  // back here, at the boundary, before anything reads a coordinate --
  // `parsePersons` reads them from more than a dozen places and a
  // per-site fix only has to be forgotten once to be wrong. A null fit
  // returns the buffer untouched, so the squash arm is bit-identical.
  data = unpadPersons(data, lbFit, PERSON_INPUT_SIZE);
  // `held` = the persons this same video returned on the PREVIOUS pass,
  // for parsePersons' admission hysteresis (R17). Passed through rather
  // than stored here: one module instance serves every video element, so
  // module-level continuity state would leak across streams.
  var persons = parsePersons(data, undefined, aspect, held);
  // R21. Snapshot "MoveNet saw nothing human-shaped" HERE, next to the
  // pass that produced it, and hang it on the result. lastSlotDiag is
  // module state cleared by every parsePersons call, and ONE detector
  // module instance serves every video element on the page — so a caller
  // reading it later, from inside a promise, can be handed a different
  // element's pass. The gauntlet asserts a single sampler, so no run
  // could ever show this; a YouTube page with the player and a feed
  // preview has two. Captured synchronously, it cannot desynchronize.
  persons.noHumanShape = frameHasNoHumanShape(lastSlotDiag);
  // The NUMBER behind that boolean, captured in the same breath and for
  // the same reason -- see frameMaxKp.
  persons.maxKp = frameMaxKp(lastSlotDiag);
  // R29, and captured here for exactly the reason above: the boxes of
  // the slots this pass REFUSED, so the face fallback can bound a
  // synthetic body onto a person MoveNet measured but would not admit.
  persons.rejectedBoxes = rejectedSlotBoxes(lastSlotDiag);
  return persons;
}

/**
 * NSFW classification against a pixel source. Returns true when the
 * image should stay covered. The graph ends in a Softmax, so the five
 * outputs (Drawing, Hentai, Neutral, Porn, Sexy — nsfwjs class order)
 * are already probabilities. Thresholds: explicit (Porn+Hentai) > 0.5,
 * or Sexy > 0.8 — conservative start, calibration pass pending.
 * MobileNetV2 wants [0,1] input, unlike BlazeFace's [-1,1].
 */
export async function isNsfw(model, pixelSource, sharedImg) {
  var scores = tf.tidy(function () {
    // `sharedImg` — see uploadFrame. On the image path BlazeFace, the
    // gender head and this classifier all read the SAME <img>, so the
    // element was uploaded three times per thumbnail. A tensor created
    // outside this tidy survives it; the caller disposes.
    var img = sharedImg || tf.browser.fromPixels(pixelSource);
    img = tf.image.resizeBilinear(img, [NSFW_INPUT_SIZE, NSFW_INPUT_SIZE]);
    img = tf.cast(img, 'float32');
    img = tf.div(img, 255);
    img = tf.expandDims(img, 0);
    return model.execute(img, 'Identity:0');
  });
  var data;
  try {
    data = await scores.data();
  } finally {
    tf.dispose(scores);
  }
  var hentai = data[1];
  var porn = data[3];
  var sexy = data[4];
  return porn + hentai > 0.5 || sexy > 0.8;
}

// Anchor generation (adapted from vladmandic/human, MIT) lives in
// face-decode.mjs now, shared with the native path's plain-JS decode.
var anchorsT = null;

function ensureAnchors() {
  if (!anchorsT) anchorsT = tf.tensor2d(generateAnchors(INPUT_SIZE));
  return anchorsT;
}

/**
 * Full face detection: returns an array of { x1, y1, x2, y2, confidence }
 * with coordinates normalized to 0..1 of the source (enlarged and
 * squarified in model space for downstream gender crops). Empty array =
 * no faces. Decode adapted from vladmandic/human getBoxes (MIT); the CPU
 * half (NMS, enlarge, squarify, marks) is face-decode.mjs's
 * `facesFromRows`, shared with the native path.
 */
export async function detectFaceBoxes(model, pixelSource, sharedImg) {
  var anchors = ensureAnchors();
  var out = tf.tidy(function () {
    var img = sharedImg || tf.browser.fromPixels(pixelSource);
    var input = tf.expandDims(img, 0);
    var resized = tf.image.resizeBilinear(input, [INPUT_SIZE, INPUT_SIZE]);
    var norm = tf.sub(tf.div(tf.cast(resized, 'float32'), 127.5), 1);
    var res = model.execute(norm, ['Identity:0', 'Identity_1:0', 'Identity_2:0', 'Identity_3:0']);
    // Sort by tensor size: [384x1, 512x1, 384x16, 512x16] -> concat each
    // scale's logit + regressor, then both scales -> [896, 17]:
    // [logit, dx, dy, w, h, 12 landmark values we ignore].
    var sorted = res.slice().sort(function (a, b) {
      return a.size - b.size;
    });
    var c384 = tf.concat([sorted[0], sorted[2]], 2);
    var c512 = tf.concat([sorted[1], sorted[3]], 2);
    var batch = tf.squeeze(tf.concat([c512, c384], 1), [0]);
    var centers = tf.add(tf.slice(batch, [0, 1], [-1, 2]), anchors);
    var halfSizes = tf.div(tf.slice(batch, [0, 3], [-1, 2]), 2);
    var starts = tf.sub(centers, halfSizes);
    var ends = tf.add(centers, halfSizes);
    // THE SIX FACIAL LANDMARKS WERE COMPUTED AND THROWN AWAY.
    // Columns 5..16 are 6 (x, y) pairs -- right eye, left eye, nose,
    // mouth, right ear, left ear -- regressed RELATIVE TO THE ANCHOR
    // CENTRE, exactly like dx/dy. They cost no inference: the model
    // already produced them and they are sitting on the GPU beside the
    // box. They are the only per-face signal we have that describes the
    // INSIDE of a face, which is what separates a face from a graphic
    // that happens to be face-shaped -- the axis the keypoint floor and
    // the confidence score both failed on (measured: refused conf p50
    // 0.78 vs kept 0.79, same population).
    //
    // COST: one [896, 17] download instead of [896, 5] -- 61KB against
    // 18KB, still exactly ONE GPU->CPU round trip, which is the part
    // that costs. Gathering only the kept rows would be fewer bytes and
    // a SECOND fence wait, which is the wrong trade on this backend.
    var scores = tf.sigmoid(tf.slice(batch, [0, 0], [-1, 1]));
    var marks = tf.add(
      tf.slice(batch, [0, 5], [-1, 12]),
      tf.tile(anchors, [1, 6])
    );
    return tf.concat([scores, starts, ends, marks], 1);
  });
  var data;
  try {
    data = await out.data();
  } finally {
    tf.dispose(out);
  }
  // `data` is already the [896,17] rows facesFromRows expects: [score,
  // x1,y1,x2,y2, mark0..mark11] per row, stride 17.
  return facesFromRows(data);
}

/**
 * Per-face gender for ALL boxes from detectFaceBoxes in one batched
 * inference (one fromPixels, one execute, one download — N separate
 * calls were N GPU round trips). Model semantics (human-models
 * faceres.json, HSE-FaceRes, MIT — reader adapted from vladmandic/human
 * faceres.ts, MIT, see NOTICE): input is a 224x224 RGB crop with values
 * 0..255 float; the model is multi-head (age/gender/descriptor) and the
 * gender head is the [N,1] output — a sigmoid where <=0.5 reads female,
 * >0.5 male, and confidence is 2*|v-0.5|.
 * Returns [{ gender: 'female'|'male', score }] parallel to boxes.
 */
export async function classifyFaceGenders(model, pixelSource, boxes, sharedImg, opts) {
  if (!boxes.length) return [];
  var square = !!(opts && opts.square);
  var genderHeadFound = false;
  var outs = tf.tidy(function () {
    // `sharedImg` — see uploadFrame and isNsfw. Ownership stays with the
    // caller; a tensor made outside this tidy is not disposed by it.
    var img = sharedImg || tf.browser.fromPixels(pixelSource);
    var input = tf.expandDims(tf.cast(img, 'float32'), 0);
    var srcH = img.shape[0];
    var srcW = img.shape[1];
    var rects = [];
    var inds = [];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var y1 = b.y1;
      var x1 = b.x1;
      var y2 = b.y2;
      var x2 = b.x2;
      if (square) {
        // ASPECT-PRESERVING CROP -- the arithmetic and the four days it
        // cost are in crop-geometry.mjs. Both the image path and the
        // worker's video path reach faceres through here, so there is
        // one implementation and one test rather than two chances to
        // get it wrong.
        var sq = squareBox({ x1: x1, y1: y1, x2: x2, y2: y2 }, srcW, srcH);
        x1 = sq.x1;
        x2 = sq.x2;
        y1 = sq.y1;
        y2 = sq.y2;
      }
      rects.push([y1, x1, y2, x2]);
      inds.push(0);
    }
    // cropAndResize interpolates from the 0..255 float source — faceres
    // wants exactly that range, so no further normalisation.
    var crops = tf.image.cropAndResize(input, rects, inds, [GENDER_INPUT_SIZE, GENDER_INPUT_SIZE]);
    // ONE LINE, AND IT COVERS BOTH PATHS. The image path and the
    // worker's per-person video path both reach faceres through here, so
    // a single write turns grey on everywhere -- which is also why it
    // must stay inside this tidy and inside the 0..255 float range
    // faceres wants (there is no normalisation after this point).
    // Rec.601 luma, broadcast back to 3 channels because the graph's
    // input shape is fixed at [N,224,224,3].
    if (genderInput.GENDER_GREY > 0) {
      var lum = tf.sum(tf.mul(crops, tf.tensor1d([0.299, 0.587, 0.114])), -1, true);
      crops = tf.tile(lum, [1, 1, 1, 3]);
    }
    var res = model.execute(crops);
    var list = Array.isArray(res) ? res : [res];
    var genderT = null;
    var ageT = null;
    for (var t = 0; t < list.length; t++) {
      if (list[t].shape.length === 2 && list[t].shape[1] === 1) genderT = list[t];
      // age_pred/Softmax: [N,100], p(age==i) — expected value = age.
      if (list[t].shape.length === 2 && list[t].shape[1] === 100) ageT = list[t];
    }
    var descT = null;
    for (var d = 0; d < list.length; d++) {
      // global_pooling/Mean: [N,1024] identity descriptor — the face
      // RECOGNITION embedding (identity memory, plan-blur-v2 /
      // owner ask 2026-08-24 "keep the person in memory").
      if (list[d].shape.length === 2 && list[d].shape[1] === 1024) descT = list[d];
    }
    if (genderT) genderHeadFound = true;
    return [
      genderT ? tf.clone(genderT) : tf.zeros([boxes.length, 1]),
      ageT ? tf.clone(ageT) : tf.zeros([boxes.length, 100]),
      descT ? tf.clone(descT) : tf.zeros([boxes.length, 1024]),
    ];
  });
  var data;
  var ageData;
  var descData;
  var hadGenderHead = true;
  try {
    // One parallel wait, not three serial GPU fences (review A11).
    var downloaded = await Promise.all([outs[0].data(), outs[1].data(), outs[2].data()]);
    data = downloaded[0];
    ageData = downloaded[1];
    descData = downloaded[2];
    // A zeros fallback (missing gender head) would read v=0 -> "female
    // 0.99" (review A12) — report zero confidence instead.
    hadGenderHead = genderHeadFound;
  } finally {
    tf.dispose(outs);
  }
  // The verdict loop (age-as-mass, descriptor normalise, raw sigmoid
  // kept alongside the folded confidence -- see face-decode.mjs for the
  // R18/R22/R11/R23 notes this used to carry inline) is
  // genderReadsFromOutputs now, shared with the native TFLite path.
  return genderReadsFromOutputs(data, ageData, descData, boxes, hadGenderHead);
}
