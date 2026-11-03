// Main-thread half of the inference worker.
//
// Owns creating the worker, the request/response pairing, and the
// decision that the worker is not going to work. It knows nothing about
// verdicts or blur: it hands pixels over and gives back reads.
//
// EVERY failure here is a fallback, never a broken page. The caller
// keeps the in-page pipeline and uses it whenever `ready()` is false or
// a request rejects, so the worst case is exactly today's behaviour.

import { synthetic } from './synthetic-url.mjs';
// The path our request interceptor answers on whatever origin asks
// (lib.rs synthetic_resource). It must be same-origin: YouTube's
// Trusted Types refuses a blob: worker and allows a same-origin script.
//
// The MODEL-FREE artifact. The worker used to boot from the full one and
// spent 827-970ms of every navigation parsing 22.7MB of base64 before it
// could say hello; it now fetches the model bytes as bytes
// (detector.js ioHandlerFor).
export var WORKER_PATH = '/__tamescroll/gaze-page.js';

// A worker that never says hello is a worker that is not coming. Long
// enough for a cold 16MB script on a slow device, short enough that the
// in-page path still starts while the user is on his first screen.
var UP_TIMEOUT_MS = 12000;
// One image should never take this long; if it does, something is wrong
// in the worker and the caller must not wait on it forever.
var REQUEST_TIMEOUT_MS = 15000;

export function createWorkerClient(opts) {
  var o = opts || {};
  var origin = o.origin || (typeof location !== 'undefined' ? location.origin : '');
  var onEvent = o.onEvent || function () {};
  var WorkerCtor = o.Worker || (typeof Worker === 'function' ? Worker : null);
  var state = {
    up: false,
    dead: false,
    face: false,
    gender: false,
    nsfw: false,
    // Which tfjs backend the worker got. The player path only moves here
    // on 'webgl' -- a CPU worker would be slower than the thread it was
    // supposed to relieve.
    backend: null,
    // MoveNet is loaded on demand and can fail on its own without
    // killing the image path, so the player gets its own veto.
    personFailed: false,
    // When the page ASKED for MoveNet. Null until it does.
    askedPerson: null,
  };
  var pending = new Map();
  var nextId = 1;
  // See the note in request(): cumulative ms spent awaiting the worker.
  var waitTotal = 0;
  function nowMs() {
    try {
      return performance.now();
    } catch (e) {
      return 0;
    }
  }
  var worker = null;

  function die(why) {
    if (state.dead) return;
    state.dead = true;
    state.up = false;
    onEvent({ type: 'dead', why: why });
    pending.forEach(function (p) {
      clearTimeout(p.timer);
      p.reject(new Error('worker ' + why));
    });
    pending.clear();
    try {
      if (worker) worker.terminate();
    } catch (e) {
      /* already gone */
    }
    worker = null;
  }

  function url() {
    var u = origin + synthetic(WORKER_PATH);
    // Trusted Types: the policy is ours and creating one is allowed
    // because the page sends require-trusted-types-for WITHOUT a
    // trusted-types allow-list. Where Trusted Types is absent entirely
    // (most pages), the plain string is what Worker wants anyway.
    try {
      if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
        return trustedTypes
          .createPolicy('tamescroll-gaze-worker', {
            createScriptURL: function (s) {
              return s;
            },
          })
          .createScriptURL(u);
      }
    } catch (e) {
      /* a refused policy just means we try the plain string */
    }
    return u;
  }

  // ADOPT A WORKER THAT WAS ALREADY STARTED.
  //
  // Our bundle does not run until ~420ms into a navigation (measured
  // 2026-08-29), and everything the worker has to do before it can judge
  // a thumbnail -- fetch the script, load three models, compile their
  // shaders -- starts only then. lib.rs prestarts one at document_start
  // instead, so all of that overlaps with the page's own load. Anything
  // it said while nobody was listening is replayed below.
  var adopted = null;
  try {
    var pre = typeof window !== 'undefined' ? window.__TS_GAZE_PREWORKER : null;
    if (pre && pre.worker && !o.Worker) {
      adopted = pre;
      window.__TS_GAZE_PREWORKER = null;
    }
  } catch (e) {
    /* no prestart, no problem: we make our own below */
  }

  try {
    if (adopted) {
      worker = adopted.worker;
      if (adopted.cancel) clearTimeout(adopted.cancel);
    } else {
      if (!WorkerCtor) throw new Error('no Worker');
      worker = new WorkerCtor(url());
    }
  } catch (e) {
    die('construct: ' + ((e && e.message) || e));
    return api();
  }

  var upTimer = setTimeout(function () {
    if (!state.up) die('no hello');
  }, UP_TIMEOUT_MS);

  worker.onerror = function (e) {
    // Fires for a script that fails to load OR throws at top level.
    die('error: ' + ((e && e.message) || 'no message'));
  };

  function handle(msg) {
    if (msg.type === 'up') {
      clearTimeout(upTimer);
      state.up = true;
      onEvent({
        type: 'up',
        evalMs: msg.evalMs,
        fetchMs: msg.fetchMs,
        prestarted: !!adopted,
        prestartAt: adopted ? adopted.at : null,
      });
      try {
        // A prestarted worker was told to load its models the moment it
        // existed; ensureModels is idempotent, so asking twice is free
        // and asking once from here is what a fresh one needs.
        worker.postMessage({ type: 'init' });
      } catch (err) {
        die('init: ' + ((err && err.message) || err));
      }
      return;
    }
    if (msg.type === 'loaded') {
      state[msg.model] = true;
      onEvent(msg);
      return;
    }
    if (msg.type === 'loadFailed') {
      // A MODEL THAT FAILED HERE IS NOT "SETTLED", IT IS A DEAD WORKER.
      //
      // In page, a failed load has a defined degradation: no gender
      // model means presence-only flags, no NSFW model means face-only.
      // A worker missing a model has no such meaning -- it would answer
      // every image with "no faces, not nsfw", and the caller would
      // REVEAL images nothing had looked at. So a failure here hands the
      // whole path back to the in-page pipeline, which can still load
      // its own copy and degrade honestly.
      onEvent(msg);
      die('model failed: ' + msg.model);
      return;
    }
    if (msg.type === 'ready') {
      state.backend = msg.backend || null;
      onEvent(msg);
      return;
    }
    if (msg.type === 'personFailed') {
      state.personFailed = true;
      onEvent(msg);
      return;
    }
    var p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === 'error') p.reject(new Error(msg.message || 'worker error'));
    else p.resolve(msg);
  }

  worker.onmessage = function (e) {
    handle(e.data || {});
  };

  // Everything the prestarted worker said before this client existed.
  // Its 'up' and its model loads normally land in that window, and
  // dropping them would leave the queue waiting on readiness that
  // already happened.
  if (adopted && adopted.queue && adopted.queue.length) {
    var backlog = adopted.queue.slice();
    adopted.queue.length = 0;
    for (var bi = 0; bi < backlog.length; bi++) handle(backlog[bi]);
  }

  // `opts.noNsfw` skips the suggestive classifier for this one image.
  // Small images (avatars, profile pictures) are asked a face question
  // only -- see IMAGE_MIN_FACE_SIZE in init-entry.
  function classifyImage(bitmap, opts) {
    if (state.dead || !state.up) {
      try {
        bitmap.close();
      } catch (e) {
        /* nothing to release */
      }
      return Promise.reject(new Error('worker not ready'));
    }
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('worker timeout'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        // The bitmap is TRANSFERRED: no copy, and the main thread stops
        // owning the pixels the moment it hands them over.
        worker.postMessage(
          {
            type: 'image',
            id: id,
            bitmap: bitmap,
            noNsfw: !!(opts && opts.noNsfw),
            skipNsfwFor: opts && typeof opts.skipNsfwFor === 'string' ? opts.skipNsfwFor : null,
          },
          [bitmap]
        );
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // One request, one reply, same pairing as classifyImage. `transfer`
  // is the zero-copy list; anything in it is GONE from this thread the
  // moment it is posted.
  function request(msg, transfer) {
    if (state.dead || !state.up) return Promise.reject(new Error('worker not ready'));
    var id = nextId++;
    msg.id = id;
    return new Promise(function (resolve, reject) {
      // TIME SPENT WAITING FOR THE WORKER IS NOT MAIN-THREAD TIME.
      //
      // The image drain learned this in 2026-08-28 and subtracts it;
      // the player pass did not, and MEASURED on the owner's phone a
      // verdict pass is 795ms of which 785ms is this wait and 2ms is
      // ours. Charging all 795 to a 25%-of-one-second main-thread
      // budget parks the pipeline over budget after every verdict, and
      // the cheap position passes that keep patches on the subject are
      // what get refused (measured 20 positions against 62 verdicts).
      //
      // Cumulative and monotonic; callers take a delta across their own
      // pass. Concurrent requests can overlap, so a delta may exceed a
      // caller's elapsed time -- every caller floors the subtraction.
      var askedAt = nowMs();
      var ok = resolve;
      var bad = reject;
      resolve = function (v) {
        waitTotal += nowMs() - askedAt;
        ok(v);
      };
      reject = function (e) {
        waitTotal += nowMs() - askedAt;
        bad(e);
      };
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('worker timeout'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        worker.postMessage(msg, transfer || []);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // The whole-blur fallback hands over ImageData, which is CLONEABLE but
  // not transferable -- listing it as a transfer throws and would take
  // the pass with it.
  function transferable(pix) {
    try {
      return typeof ImageBitmap !== 'undefined' && pix instanceof ImageBitmap ? [pix] : [];
    } catch (e) {
      return [];
    }
  }

  function askGender() {
    if (state.up && !state.dead && !state.gender && !state.genderAsked) {
      state.genderAsked = true;
      try {
        worker.postMessage({ type: 'gender' });
      } catch (e) {
        /* asked again by the first face instead */
      }
    }
  }

  function api() {
    return {
      // Ready to be ASKED (the script is alive). Model readiness is
      // reported separately, because the caller gates its queue on the
      // same staged signals the in-page path uses.
      ready: function () {
        return state.up && !state.dead;
      },
      // Images can be judged once face and NSFW are in. The gender model
      // loads lazily, on the first face that needs it (worker-entry.js);
      // until then such an image comes back `genderPending` and stays
      // covered.
      settled: function () {
        return state.face && state.nsfw;
      },
      genderLoaded: function () {
        return !!state.gender;
      },
      // Cumulative ms this page has spent awaiting worker replies. A
      // caller takes a delta across its own work and subtracts it from
      // what it charges the main-thread budget (see request()).
      waitMs: function () {
        return waitTotal;
      },
      // The player never uses the NSFW classifier, so it must not wait
      // for it: on a phone that model lands a second after the other
      // two, and a second of a fully blurred video is a second the owner
      // called "low quality".
      genderReady: function () {
        askGender();
        return state.up && !state.dead && state.face && state.gender;
      },
      // The image path's ask, ahead of its first face (Women or Men mode
      // on YouTube). Same one-shot message as the player's.
      askGender: askGender,
      dead: function () {
        return state.dead;
      },
      classifyImage: classifyImage,
      // --- player path -------------------------------------------------
      backend: function () {
        return state.backend;
      },
      // Ask for MoveNet before anything needs it, and remember WHEN --
      // `loaded:person` alone cannot tell a model that was asked late
      // from one that answered slowly, which is the whole reason his
      // 78.8s report could not be acted on directly.
      preloadPerson: function () {
        if (state.dead || state.askedPerson != null) return false;
        state.askedPerson = Math.round(performance.now());
        try {
          worker.postMessage({ type: 'person' });
        } catch (e) {
          return false;
        }
        return true;
      },
      askedPerson: function () {
        return state.askedPerson;
      },
      personFailed: function () {
        return state.personFailed;
      },
      // One player pass over a whole frame: persons, and (on verdict
      // passes) the full-frame face pass that shares the same upload.
      videoFrame: function (bitmap, aspect, held, withFaces, withPersons) {
        return request(
          {
            type: 'vframe',
            bitmap: bitmap,
            aspect: aspect,
            held: held,
            withFaces: !!withFaces,
            // undefined means "yes" -- an older page talking to this
            // worker must keep the old behaviour.
            withPersons: withPersons !== false,
          },
          [bitmap]
        );
      },
      // Faces in a person crop, keeping the upload alive under `cid` so
      // the gender read does not have to upload the same pixels again.
      cropFaces: function (pix) {
        return request({ type: 'vfaces', bitmap: pix }, transferable(pix));
      },
      cropGender: function (cid, boxes) {
        return request({ type: 'vgender', cid: cid, boxes: boxes });
      },
      releaseCrop: function (cid) {
        if (state.dead || !state.up || !cid) return;
        try {
          worker.postMessage({ type: 'vrelease', cid: cid });
        } catch (e) {
          /* a worker that cannot be told will be swept by its own TTL */
        }
      },
      genderOnce: function (pix, boxes) {
        return request({ type: 'vgender1', bitmap: pix, boxes: boxes }, transferable(pix));
      },
      terminate: function () {
        die('terminated');
      },
    };
  }

  return api();
}
