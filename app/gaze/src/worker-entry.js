// THE INFERENCE WORKER.
//
// Everything in here runs off the page's main thread. That is the whole
// point: on a low-end phone the models are not slow so much as they are
// IN THE WAY -- every BlazeFace pass was a task YouTube's own scroll,
// lazy-loading and comment rendering had to wait behind.
//
// This is loadable at all because of the measurement in
// synthetic_resource (lib.rs): YouTube ships
// `require-trusted-types-for 'script'` with no `trusted-types`
// directive, so our own policy is allowed, and a SAME-ORIGIN script url
// loads where a blob: one is refused. Our request interceptor answers
// that url.
//
// The protocol is deliberately thin. The worker does inference and
// NOTHING else: no policy, no thresholds, no verdicts. Whether a read
// means "cover him" is owner-tuned logic that lives on the main thread
// next to its tests (gender-verdict.mjs), and duplicating it here is how
// the two would drift.
import * as detector from './detector.js';
import { imageRead } from './face-decode.mjs';
import { flaggedFaceIndices } from './gender-verdict.mjs';
import { workerMaySkipNsfw } from './gender-wait.mjs';

// Exported, not self-starting: this file is bundled INTO the page
// bundle, which is also what gets served as the worker script. One
// artifact, two roles -- embedding a second copy of tfjs and four
// models cost 17MB of the APK for code that is byte-identical.
export function startWorker() {

  var models = { face: null, gender: null, nsfw: null, person: null };
  var loading = null;
  // The gender model loads the first time a face needs a gender read,
  // so a page with no faces never pays for it. Until it is ready an
  // image with faces is answered `genderPending` and the page keeps it
  // covered and asks again once 'loaded:gender' arrives.
  var genderLoading = null;
  var stageModel = null;
  var warmModel = null;
  function ensureGender() {
    if (genderLoading) return genderLoading;
    genderLoading = ensureModels().then(function () {
      return warmModel(stageModel('gender', detector.loadGenderModel), 'gender');
    });
    return genderLoading;
  }
  // Loaded ONLY when a player asks (a feed page has no video and MoveNet
  // is the most expensive model we ship). Null until then; `false` once
  // it has failed, so the page is told to keep the video path in-page
  // instead of asking again every 250ms.
  var personLoading = null;
  var personFailed = false;
  // Crop frames the page is still working on. The player path detects
  // faces in a crop, decides whether any of them belongs to the tracked
  // person, and only THEN pays for gender -- so the uploaded crop has to
  // outlive its first answer. Held by id, released by the page, and
  // swept on a deadline so a page that navigates mid-pass cannot leak
  // GPU memory.
  var crops = new Map();
  var nextCrop = 1;
  var CROP_TTL_MS = 8000;

  function sweepCrops() {
    var now = performance.now();
    crops.forEach(function (c, id) {
      if (now - c.at > CROP_TTL_MS) {
        detector.disposeFrame(c.t);
        crops.delete(id);
      }
    });
  }

  function post(msg, transfer) {
    try {
      self.postMessage(msg, transfer || []);
    } catch (e) {
      // A message that cannot be cloned must still not kill the worker;
      // the main thread times the request out and falls back.
      self.postMessage({ type: 'error', id: msg && msg.id, message: String((e && e.message) || e) });
    }
  }

  // Models load in the order the image path consumes them, and each one
  // reports as it lands so the main thread can start draining the moment
  // the pieces it needs exist -- the same staged readiness the in-page
  // path has, just without occupying the thread that draws the page.
  function ensureModels() {
    if (loading) return loading;
    loading = (async function () {
      // EVERY NAVIGATION PAYS THIS AGAIN. m.youtube navigations are
      // hard, so each one gets a fresh worker that loads all of these
      // from scratch -- measured 2026-08-29: the first thumbnail verdict
      // lands 2.4-3.2s after page start on a desktop, which is the
      // owner's oldest complaint ("still taking long to load"). Timing
      // each model is how the next cut gets chosen rather than guessed.
      var t0 = performance.now();
      async function stage(name, load) {
        var at = performance.now();
        try {
          var m = await load();
          // BYTES AND GRAPH ARE DIFFERENT LEVERS. `ms` alone could not
          // tell a smaller model from a warm HTTP cache, which is what
          // made a 50%-smaller faceres unmeasurable on 2026-08-31.
          var fm = null;
          var fb = null;
          try {
            fm = detector.fetchMsByKind[name];
            fb = detector.fetchMsByKind[name + ':bytes'];
          } catch (e) {
            /* instrumentation only */
          }
          post({
            type: 'loaded',
            model: name,
            ms: Math.round(performance.now() - at),
            fetchMs: typeof fm === 'number' ? fm : null,
            bytes: typeof fb === 'number' ? fb : null,
          });
          return m;
        } catch (e) {
          post({
            type: 'loadFailed',
            model: name,
            ms: Math.round(performance.now() - at),
            message: String((e && e.message) || e),
          });
          return null;
        }
      }
      // STARTED TOGETHER, reported as each one lands. Since the models
      // are fetched rather than parsed out of the script, most of a load
      // is a request the others do not have to wait behind; each still
      // posts its own 'loaded' the moment it is ready, which is what the
      // drain gates on.
      var faceP = stage('face', detector.loadModel);
      var nsfwP = stage('nsfw', detector.loadNsfwModel);
      // Before saying ready: run each model once on a blank frame so the
      // WebGL kernels are compiled. Measured 2026-08-29 -- without this
      // the FIRST thumbnail of every navigation cost 1.25s against
      // 60-100ms for every one after it.
      //
      // Each model is warmed the moment IT lands rather than after all
      // three, so a model's compilation overlaps the download of the
      // ones behind it.
      var warmAt = performance.now();
      var warmParts = {};
      function warmWhen(p, key) {
        return p.then(function (m) {
          models[key] = m;
          if (!m) return m;
          var one = {};
          one[key] = m;
          return detector.warmUp(one).then(function (t) {
            if (t) {
              for (var k in t) warmParts[key === k ? k : key + ':' + k] = t[k];
            }
            return m;
          });
        });
      }
      await Promise.all([
        warmWhen(faceP, 'face'),
        warmWhen(nsfwP, 'nsfw'),
      ]);
      var warmMs = Math.round(performance.now() - warmAt);
      // A worker that is missing a model answers every image with "no
      // faces, not suggestive", which the main thread would act on by
      // REVEALING it. It reports the failure instead and the client hands
      // the path back to the in-page pipeline (worker-client.mjs).
      // `backend` decides whether the PLAYER path may come here at all:
      // a CPU-backend worker is slower than the main thread it was meant
      // to unblock.
      stageModel = stage;
      warmModel = warmWhen;
      post({
        type: 'ready',
        backend: detector.backendName(),
        ms: Math.round(performance.now() - t0),
        warmMs: warmMs,
        warmParts: warmParts,
      });
    })();
    return loading;
  }

  // One image: faces, per-face reads, and the NSFW answer. Same shape and
  // same order as the in-page path, including starting the classifier
  // alongside the face pass rather than after it -- neither needs the
  // other's answer and both read the one uploaded frame.
  async function handleImage(msg) {
    var bmp = msg.bitmap;
    var frame = null;
    var t0 = performance.now();
    try {
      frame = detector.uploadFrame(bmp);
      // noNsfw: the caller is asking about a small image -- an avatar or
      // a profile picture. nsfwjs resizes to 224 either way, so it costs
      // the same 13ms on a 48px source as on a thumbnail, and what it
      // would be judging is a face-sized crop of a person's head. The
      // face pass is the whole question there.
      var wantNsfw = !!models.nsfw && !msg.noNsfw;
      function runNsfw() {
        return detector.isNsfw(models.nsfw, bmp, frame).catch(function () {
          return false;
        });
      }
      // skipNsfwFor (the declared gender): the page lets the classifier
      // wait for the faces, and be skipped when a face already keeps the
      // image covered (gender-wait.mjs). Without it, both start together
      // exactly as before.
      var skipFor = typeof msg.skipNsfwFor === 'string' ? msg.skipNsfwFor : null;
      var nsfwP = wantNsfw && skipFor === null ? runNsfw() : null;
      var boxes = models.face ? await detector.detectFaceBoxes(models.face, bmp, frame) : [];
      var reads = [];
      var genderPending = false;
      if (boxes.length && models.gender) {
        reads = await detector.classifyFaceGenders(models.gender, bmp, boxes, frame, { square: true });
      } else if (boxes.length) {
        genderPending = true;
        ensureGender();
      }
      var posted = reads.map(imageRead);
      var nsfwSkipped = false;
      if (wantNsfw && !nsfwP) {
        if (workerMaySkipNsfw(skipFor, boxes, posted, genderPending, flaggedFaceIndices)) nsfwSkipped = true;
        else nsfwP = runNsfw();
      }
      var nsfw = nsfwP ? await nsfwP : false;
      post({
        type: 'verdict',
        id: msg.id,
        boxes: boxes,
        // face-decode owns what an image verdict carries across a
        // boundary. It was an object literal here, and what the literal
        // left out (`raw`, `shape.norm`) made `flaggedFaceIndices`' null
        // guard DEAD on this path while it stayed live in-page -- both of
        // that guard's predicates fail open on a missing field, so it
        // never fired and never logged. Finding 52 priced it at 48 junk
        // marks over 370 thumbnails. The 1024-float descriptor is still
        // dropped; see imageRead.
        reads: posted,
        nsfw: !!nsfw,
        nsfwSkipped: nsfwSkipped,
        genderPending: genderPending,
        ms: Math.round(performance.now() - t0),
      });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: String((e && e.message) || e) });
    } finally {
      detector.disposeFrame(frame);
      try {
        bmp.close();
      } catch (e) {
        /* already closed */
      }
    }
  }

  function ensurePerson() {
    if (models.person) return Promise.resolve(models.person);
    if (personFailed) return Promise.resolve(null);
    if (!personLoading) {
      personLoading = detector.loadPersonModel().then(
        function (m) {
          models.person = m;
          post({ type: 'loaded', model: 'person' });
          return m;
        },
        function (e) {
          // NOT a dead worker: images do not use MoveNet, so the image
          // path is unaffected. The page is told, and keeps the player
          // in-page.
          personFailed = true;
          post({ type: 'personFailed', message: String((e && e.message) || e) });
          return null;
        }
      );
    }
    return personLoading;
  }

  // ONE PLAYER PASS. The person detector and the full-frame face pass
  // read the SAME uploaded frame -- the pairing the in-page path already
  // makes for the same reason (one 1080p texture upload, not two).
  // `withFaces` is false on the cheap position-only passes, which is the
  // majority of them.
  async function handleFrame(msg) {
    var bmp = msg.bitmap;
    var frame = null;
    var t0 = performance.now();
    try {
      // THE PERSON PASS IS THE EXPENSIVE HALF, AND ON SOME FOOTAGE IT
      // FINDS NOBODY PASS AFTER PASS. MEASURED on a Snapdragon 662
      // (2026-08-31): passP50 506ms of a 798ms verdict, with all twelve
      // diagnostic slots reading n:0 -- 63% of every verdict spent on a
      // model contributing nothing, while the face path did the work.
      // The page decides when to skip it; see wantPersons there.
      var wantPersons = msg.withPersons !== false;
      var person = wantPersons ? await ensurePerson() : null;
      if (wantPersons && !person) {
        post({ type: 'error', id: msg.id, message: 'no person model' });
        return;
      }
      frame = detector.uploadFrame(bmp);
      var persons = person
        ? await detector.detectPersons(person, bmp, msg.aspect, msg.held, frame)
        : [];
      var faces = null;
      if (msg.withFaces && models.face) {
        faces = await detector.detectFaceBoxes(models.face, bmp, frame);
      }
      post({
        type: 'vframe',
        id: msg.id,
        // Structured clone copies an array's ELEMENTS, not the extra
        // properties detectPersons hangs on it, so they travel by name.
        persons: Array.prototype.slice.call(persons),
        // A SKIPPED PASS MUST BE INERT, NEVER "NOBODY IS THERE". The
        // ghost gate refuses an uncorroborated face only on
        // `length === 0 && noHumanShape === true`, so a skipped pass
        // reports false here and the face fallback keeps covering. The
        // failure direction of a skip is a possible ghost, never an
        // uncovered person.
        noHumanShape: person ? !!persons.noHumanShape : false,
        // Diagnostic only: the number the gate thresholded on.
        maxKp: person && typeof persons.maxKp === 'number' ? persons.maxKp : null,
        personsSkipped: !person,
        rejectedBoxes: persons.rejectedBoxes || [],
        faces: faces,
        ms: Math.round(performance.now() - t0),
      });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: String((e && e.message) || e) });
    } finally {
      detector.disposeFrame(frame);
      try {
        bmp.close();
      } catch (e) {
        /* already closed */
      }
    }
  }

  // A crop's faces, KEEPING the upload. See `crops`: the page decides
  // between this answer and paying for gender.
  async function handleCropFaces(msg) {
    var bmp = msg.bitmap;
    var t0 = performance.now();
    try {
      sweepCrops();
      var frame = detector.uploadFrame(bmp);
      var faces = models.face ? await detector.detectFaceBoxes(models.face, bmp, frame) : [];
      var cid = nextCrop++;
      crops.set(cid, { t: frame, at: performance.now() });
      post({ type: 'vfaces', id: msg.id, cid: cid, faces: faces, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: String((e && e.message) || e) });
    } finally {
      try {
        bmp.close();
      } catch (e) {
        /* already closed */
      }
    }
  }

  async function handleCropGender(msg) {
    var c = crops.get(msg.cid);
    if (!c || !models.gender) {
      post({ type: 'error', id: msg.id, message: c ? 'no gender model' : 'crop gone' });
      return;
    }
    try {
      var reads = await detector.classifyFaceGenders(models.gender, null, msg.boxes, c.t, { square: true });
      post({ type: 'vgender', id: msg.id, reads: reads });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: String((e && e.message) || e) });
    }
  }

  // A one-shot gender read on pixels the page will not ask about again
  // (the native-resolution face re-crop, and the whole-blur fallback).
  async function handleGenderOnce(msg) {
    var bmp = msg.bitmap;
    var frame = null;
    try {
      if (!models.gender) throw new Error('no gender model');
      frame = detector.uploadFrame(bmp);
      var reads = await detector.classifyFaceGenders(models.gender, bmp, msg.boxes, frame, { square: true });
      post({ type: 'vgender', id: msg.id, reads: reads });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: String((e && e.message) || e) });
    } finally {
      detector.disposeFrame(frame);
      try {
        bmp.close();
      } catch (e) {
        /* already closed */
      }
    }
  }

  function releaseCrop(cid) {
    var c = crops.get(cid);
    if (!c) return;
    detector.disposeFrame(c.t);
    crops.delete(cid);
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    if (msg.type === 'vframe') {
      ensureModels().then(function () {
        return handleFrame(msg);
      });
      return;
    }
    if (msg.type === 'vfaces') {
      ensureModels().then(function () {
        return handleCropFaces(msg);
      });
      return;
    }
    if (msg.type === 'vgender') {
      ensureGender().then(function () {
        return handleCropGender(msg);
      });
      return;
    }
    if (msg.type === 'vgender1') {
      ensureGender().then(function () {
        return handleGenderOnce(msg);
      });
      return;
    }
    if (msg.type === 'gender') {
      ensureGender();
      return;
    }
    if (msg.type === 'vrelease') {
      releaseCrop(msg.cid);
      return;
    }
    if (msg.type === 'init') {
      ensureModels();
      return;
    }
    // LOADING IS NOT USING. MoveNet was only ever requested by the first
    // video frame that reached this worker, so on a watch page the model
    // the player is waiting for started loading behind the whole image
    // drain. His phone reported `loaded:person` at 78,807ms -- the
    // player had no person pass for the first minute and a half of the
    // page. The page asks for it the moment it attaches a real player.
    if (msg.type === 'person') {
      ensurePerson();
      return;
    }
    if (msg.type === 'image') {
      ensureModels().then(function () {
        return handleImage(msg);
      });
      return;
    }
  };

  // How much of the worker's start-up is fetching and evaluating this
  // script (EVAL_CLOCK is the artifact's first statement), against
  // everything the page does before it gets here.
  var evalMs = null;
  var fetchMs = null;
  try {
    if (typeof globalThis.__TS_GAZE_EVAL0 === 'number') {
      evalMs = Math.round(performance.now() - globalThis.__TS_GAZE_EVAL0);
      // AND THE PART NOBODY HAS EVER MEASURED. A worker's timeOrigin is
      // set when the worker is CREATED, before its script is fetched, so
      // EVAL0 -- the clock the build stamps as the artifact's first
      // statement -- is exactly how long the browser spent getting and
      // compiling this file. On his phone the worker reports `up` at
      // 800ms of which eval is 120ms, and the other 680ms has been
      // attributed to nothing for three sessions. This splits it.
      fetchMs = Math.round(globalThis.__TS_GAZE_EVAL0);
    }
  } catch (e) {
    /* no clock, no number */
  }
  post({ type: 'up', evalMs: evalMs, fetchMs: fetchMs });
}
