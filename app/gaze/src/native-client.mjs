// Page-side client for the Android native tensor runner (NativeInfer.kt,
// Task 2's other half) -- and, unmodified per the plan's iOS note, a
// future WKScriptMessageHandler transport. Same call shape as
// worker-client.mjs's player-path API (videoFrame/cropFaces/cropGender/
// releaseCrop/genderOnce/waitMs/backend/dead), so Task 4's transport
// selection can hand either client to the same caller.
//
// This module owns NOTHING policy-shaped: it draws frames to the sizes
// the models want (the SAME squash geometry detector.js's tensor path
// uses today -- see drawTo below), sends them down the port, and turns
// raw model outputs into boxes/reads through face-decode.mjs and
// person-gate.mjs -- the same decode the WebGL Worker path calls. One
// implementation, two transports.
//
// FAIL-SAFE, NEVER FAIL-OPEN: a reply with status != 0, a reply that
// fails to decode, or a request that times out all count as a failure.
// Three in a row and this client marks itself `dead()` so the caller
// (Task 4) falls back to the Worker for the rest of the page -- the
// worst case is exactly today's behaviour, never a wrong answer taken
// as a right one.
import { encodeRequest, decodeReply, parseReady } from './native-frame.mjs';
import { faceRowsFromOutputs, facesFromRows, genderReadsFromOutputs, squareBox } from './face-decode.mjs';
import { parsePersons, frameHasNoHumanShape, frameMaxKp, rejectedSlotBoxes, lastSlotDiag } from './person-gate.mjs';

var MODEL_BLAZEFACE = 1;
var MODEL_FACERES = 2;
var MODEL_MOVENET = 3;

// Both BlazeFace and MoveNet take a 256x256 input on this device (Task 0a
// REPORT.md); faceres takes 224x224. PERSON_LETTERBOX ships OFF
// (detector.js) so this mirrors the SQUASH the tensor path uses today --
// fixing the findings-16b squash is a round, not this task.
var FACE_SIZE = 256;
var PERSON_SIZE = 256;
var GENDER_SIZE = 224;

// One image should never take this long on a tensor runner that is
// answering in tens of milliseconds (Task 1's GPU-REPORT.md); a request
// stuck this long means the port or the interpreter is wedged.
var DEFAULT_REQUEST_TIMEOUT_MS = 4000;
// A native side that never says hello is one that is not coming.
var DEFAULT_READY_TIMEOUT_MS = 15000;
// Crop frames the page is still working on -- see worker-entry.js's
// `crops`. Here the "upload" IS the source bitmap itself (native has no
// GPU-resident frame handle for the page to hold onto), kept alive so a
// later cropGender can re-crop it at 224 per face without asking the
// caller to re-draw the whole frame.
var CROP_TTL_MS = 8000;

// KILL SWITCH, on the OTA channel (tuning.mjs). 1 = the player path uses
// the native engine whenever Kotlin handed the page a live port; 0 = the
// WebGL worker exactly as 1092 ran it, the port ignored. A number, not
// code: pushing 0 is how a bad native build is turned off on every phone
// without an install.
export var NATIVE_INFER = 1;
export function setNativeInfer(v) { NATIVE_INFER = v; }
// WHICH MODELS RUN ON THE CPU (performance batch, 2026-09-03; OTA
// NATIVE_CPU_MASK, ships 0 = every model on the GPU delegate as 1093
// measured it). Bit 0 = BlazeFace, bit 1 = faceres, bit 2 = MoveNet. A
// set bit asks NativeInfer.kt to rebuild that interpreter on XNNPACK (4
// threads); the GPU delegate then stops competing with the video decode
// and the page's own compositing for the one GPU the phone has. Sent as
// a CONFIG request (modelId 0, w = mask) on EVERY native-ready;
// the reply is the ordinary empty-outputs ack and is not waited on.
export var NATIVE_CPU_MASK = 0;
export function setNativeCpuMask(v) { NATIVE_CPU_MASK = Math.max(0, Math.min(7, Math.round(v))); }
export var CONFIG_MODEL_ID = 0;
// NPU AUTO-TRY (owner, 2026-09-03: "let it auto detect if the phone has
// NPU then it uses NPU and it mentions it somewhere"). NativeInfer.kt
// tries the Qualcomm QNN delegate first when this is 1, then GPU, then
// CPU, and reports per-model backends in its ready message. 0 = never
// try it (OTA kill switch, NATIVE_NPU). Flags bit 0 of the CONFIG
// request. SHIPS 0 (phase-n N1): the engine's arbiter compares the NNAPI
// graph against the shipping one on one real frame, all heads, within
// 2% -- but that gate has not been priced the way loop 34 priced a new
// faceres backend (probe_faceres_parity, 100 real crops, three heads),
// and until it is the NPU is his to switch on, per phone, over the air.
// The engine's own default is 0 too, so a page that never sends a
// CONFIG never starts a trial.
export var NATIVE_NPU = 0;
export function setNativeNpu(v) { NATIVE_NPU = v > 0 ? 1 : 0; }
export function configFlags() { return NATIVE_NPU === 1 ? 1 : 0; }

export function createNativeClient(port, opts) {
  var o = opts || {};
  var requestTimeoutMs = typeof o.requestTimeoutMs === 'number' ? o.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  var readyTimeoutMs = typeof o.readyTimeoutMs === 'number' ? o.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS;

  function nowMs() {
    try {
      return performance.now();
    } catch (e) {
      return Date.now();
    }
  }

  var state = {
    backend: null,
    backends: null,
    npu: null,
    gpu: null,
    models: null,
    dead: false,
    consecutiveFailures: 0,
  };
  var pending = new Map();
  var nextReqId = 1;
  // Cumulative ms spent awaiting a native reply -- same contract as
  // worker-client's waitMs: a caller takes a delta across its own pass
  // and subtracts it from the main-thread budget it charges.
  var waitTotal = 0;
  var crops = new Map(); // cid -> { bitmap, at }
  var nextCrop = 1;

  var readyResolve;
  var readyReject;
  var ready = new Promise(function (res, rej) {
    readyResolve = res;
    readyReject = rej;
  });
  var readyTimer = setTimeout(function () {
    die('no native-ready');
  }, readyTimeoutMs);

  function sweepCrops() {
    var now = nowMs();
    crops.forEach(function (c, id) {
      if (now - c.at > CROP_TTL_MS) {
        try {
          c.bitmap.close();
        } catch (e) {
          /* already closed */
        }
        crops.delete(id);
      }
    });
  }

  function die(why) {
    clearTimeout(readyTimer);
    if (state.dead) return;
    state.dead = true;
    pending.forEach(function (p) {
      clearTimeout(p.timer);
      p.reject(new Error('native ' + why));
    });
    pending.clear();
    // A dead client never sees another cropFaces, so nothing would sweep
    // the full-resolution bitmaps it still holds (phase-j J7): close
    // them here, or ~3.7MB each leaks for the life of the page.
    crops.forEach(function (cr) {
      try {
        cr.bitmap.close();
      } catch (e) {
        /* already closed */
      }
    });
    crops.clear();
    try {
      readyReject(new Error('native ' + why));
    } catch (e) {
      /* already settled */
    }
  }

  // `onReply(ok)` is the transport's own tally (phase-j J9): a counter
  // that bumps where the reply LANDS cannot read non-zero on a run where
  // nothing ever answered, which the caller-side count did.
  var onReply = opts && typeof opts.onReply === 'function' ? opts.onReply : null;
  function noteFailure() {
    state.consecutiveFailures++;
    if (onReply) onReply(false);
    if (state.consecutiveFailures >= 3) die('3 consecutive request failures');
  }
  function noteSuccess() {
    state.consecutiveFailures = 0;
    if (onReply) onReply(true);
  }

  // One request, one reply, matched by reqId. `rgba` is transferred
  // (zero-copy) -- the caller must not read it again after calling this.
  function send(modelId, w, h, rgba) {
    if (state.dead) return Promise.reject(new Error('native dead'));
    var reqId = nextReqId++;
    var buf;
    try {
      buf = encodeRequest(reqId, modelId, w, h, rgba);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise(function (resolve, reject) {
      var askedAt = nowMs();
      var ok = function (v) {
        waitTotal += nowMs() - askedAt;
        resolve(v);
      };
      var bad = function (e) {
        waitTotal += nowMs() - askedAt;
        reject(e);
      };
      var timer = setTimeout(function () {
        pending.delete(reqId);
        noteFailure();
        bad(new Error('native timeout'));
      }, requestTimeoutMs);
      pending.set(reqId, { resolve: ok, reject: bad, timer: timer });
      try {
        port.postMessage(buf, [buf]);
      } catch (e) {
        pending.delete(reqId);
        clearTimeout(timer);
        noteFailure();
        bad(e);
      }
    });
  }

  // The config request carries no pixels: a bare 16-byte header with
  // modelId CONFIG_MODEL_ID and the mask in the `w` slot. Matched by
  // reqId like any other request so a lost ack times out rather than
  // leaking a pending entry.
  function configure(mask, flags) {
    if (state.dead) return Promise.reject(new Error('native dead'));
    var reqId = nextReqId++;
    var buf = new ArrayBuffer(16);
    var view = new DataView(buf);
    view.setUint32(0, reqId >>> 0, true);
    view.setUint32(4, CONFIG_MODEL_ID >>> 0, true);
    view.setUint32(8, mask >>> 0, true);
    view.setUint32(12, (flags || 0) >>> 0, true);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(reqId);
        reject(new Error('native config timeout'));
      }, requestTimeoutMs);
      pending.set(reqId, { resolve: resolve, reject: reject, timer: timer });
      try {
        port.postMessage(buf, [buf]);
      } catch (e) {
        pending.delete(reqId);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  port.onmessage = function (e) {
    // A MessageEvent the page DISPATCHED on this port (rather than one
    // the port delivered) arrives with isTrusted false (phase-j J6): a
    // script holding the port object could otherwise forge a reply that
    // reads "no faces" on every frame.
    if (e && e.isTrusted === false) return;
    var data = e && e.data;
    if (typeof data === 'string') {
      var msg = parseReady(data);
      if (!msg) return; // not our protocol -- ignore rather than throw
      if (msg.update) {
        // Post-ready NPU trial outcome: report fields only, never the
        // ready promise or the timer.
        if (msg.backend) state.backend = msg.backend;
        if (msg.backends) state.backends = msg.backends;
        if (typeof msg.npu === 'string') state.npu = msg.npu;
        if (msg.gpu) state.gpu = msg.gpu;
        if (msg.npuWhy) state.npuWhy = msg.npuWhy;
        if (typeof msg.nGpu === 'number') state.nGpu = msg.nGpu;
        return;
      }
      clearTimeout(readyTimer);
      if (msg.ok) {
        state.backend = msg.backend;
        state.models = msg.models;
        state.backends = msg.backends || null;
        state.npu = typeof msg.npu === 'string' ? msg.npu : 'absent';
        state.gpu = msg.gpu || null;
        state.npuWhy = msg.npuWhy || null;
        state.nGpu = typeof msg.nGpu === 'number' ? msg.nGpu : -1;
        // ALWAYS sent (phase-n, the CONFIG leak): the engine outlives
        // the document, so a mask one page set stays set until another
        // page says otherwise -- the 1098 smoke's cpumask1 arm left the
        // NEXT page reading native 'cpu' with the dial at 0. The engine
        // rebuilds only what changed, so the default case is one
        // 16-byte round trip.
        configure(NATIVE_CPU_MASK, configFlags()).catch(function () { /* counted at the reply */ });
        try {
          readyResolve({ backend: msg.backend, models: msg.models });
        } catch (err) {
          /* already settled */
        }
      } else {
        die('native-failed: ' + msg.why);
      }
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    var reply;
    try {
      reply = decodeReply(data);
    } catch (err) {
      // Cannot be attributed to one pending request -- but it IS
      // evidence the native side answered something wrong.
      noteFailure();
      return;
    }
    var p = pending.get(reply.reqId);
    if (!p) return; // late reply for a request we already timed out
    pending.delete(reply.reqId);
    clearTimeout(p.timer);
    if (reply.status !== 0) {
      noteFailure();
      p.reject(new Error('native status ' + reply.status));
      return;
    }
    noteSuccess();
    p.resolve(reply);
  };

  // --- drawing --------------------------------------------------------
  //
  // Lazy, reused canvases -- one per input size, exactly like the tensor
  // path reuses one detector module instance per page. Works whether
  // this client lives on the main thread or inside a Worker (no
  // `document` reference anywhere).
  var canvas256 = null;
  var canvas224 = null;
  // iPhone before iOS 16.4 has no OffscreenCanvas; there this client
  // runs on the page's thread, so a plain canvas does the same job.
  function makeCanvas(size) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(size, size);
    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  }
  function canvasFor(size) {
    if (size === GENDER_SIZE) {
      if (!canvas224) canvas224 = makeCanvas(GENDER_SIZE);
      return canvas224;
    }
    if (!canvas256) canvas256 = makeCanvas(FACE_SIZE);
    return canvas256;
  }

  // Whole-frame squash to `size`x`size` -- same geometry as
  // detector.js's tensor path (resizeBilinear with no letterbox pad),
  // and the SAME SAMPLES: tf.image.resizeBilinear (alignCorners false,
  // halfPixelCenters false) reads src = dst * scale, while canvas
  // drawImage centres each destination pixel on the source
  // (src = (dst + 0.5) * scale - 0.5). Shifting the source rect by
  // (scale - 1) / 2 with 'low' (bilinear) smoothing cancels that:
  // measured on the Redmi against a JS resizeBilinear, mean abs diff
  // 0.04 levels, against 4.8-5.7 for the plain squash and 3.7-4.7 for
  // 'high' (spikes/gauntlet/native-pixels-1788345747.json). The gates
  // downstream (PFF_FRAME_KP_FLOOR, the person score floor) were
  // calibrated on the tensor path, so the native engine must see the
  // pixels that path would have seen.
  // drawImage with the source rect clipped to the bitmap first, and the
  // destination shrunk to match -- what the canvas spec does by itself
  // and Chrome does, so Android's pixels are unchanged. WebKit (iPhone)
  // instead draws NOTHING when the source rect runs off the bitmap, and
  // every 256 squash below starts half a pixel outside it: the face
  // model was fed a blank frame and found no faces on a page full of them.
  function drawClipped(ctx, bitmap, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight) {
    var bw = bitmap.width;
    var bh = bitmap.height;
    var fx = dWidth / sWidth;
    var fy = dHeight / sHeight;
    var x0 = Math.max(sx, 0);
    var y0 = Math.max(sy, 0);
    var x1 = Math.min(sx + sWidth, bw);
    var y1 = Math.min(sy + sHeight, bh);
    if (!(x1 > x0 && y1 > y0)) return;
    ctx.drawImage(
      bitmap,
      x0,
      y0,
      x1 - x0,
      y1 - y0,
      dx + (x0 - sx) * fx,
      dy + (y0 - sy) * fy,
      (x1 - x0) * fx,
      (y1 - y0) * fy
    );
  }

  function drawTo(size, bitmap) {
    var canvas = canvasFor(size);
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    var sw = bitmap.width;
    var sh = bitmap.height;
    var kx = sw / size;
    var ky = sh / size;
    drawClipped(ctx, bitmap, -(kx - 1) / 2, -(ky - 1) / 2, sw, sh, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size).data;
  }

  // A single face crop, aspect-preserving-squared (squareBox) then drawn
  // at GENDER_SIZE. Filled black first: cropAndResize's out-of-range
  // extrapolation is zero, and canvas drawImage's source rect clips
  // (rather than throwing) when it runs off the bitmap, so a black fill
  // is the closest equivalent for the part that clips away.
  function drawSquareCrop(bitmap, sq) {
    var canvas = canvasFor(GENDER_SIZE);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, GENDER_SIZE, GENDER_SIZE);
    var sw = bitmap.width;
    var sh = bitmap.height;
    var sx = sq.x1 * sw;
    var sy = sq.y1 * sh;
    var sWidth = (sq.x2 - sq.x1) * sw;
    var sHeight = (sq.y2 - sq.y1) * sh;
    if (sWidth > 0 && sHeight > 0) {
      drawClipped(ctx, bitmap, sx, sy, sWidth, sHeight, 0, 0, GENDER_SIZE, GENDER_SIZE);
    }
    return ctx.getImageData(0, 0, GENDER_SIZE, GENDER_SIZE).data;
  }

  // faceres' 3 outputs (gender [N,1], age [N,100], descriptor [N,1024])
  // arrive one-at-a-time from N single-face requests (faceres batch is 1
  // natively -- REPORT.md). Assemble them into the flat layout
  // genderReadsFromOutputs expects, matching each reply's own outputs by
  // LENGTH -- the wire protocol carries no tensor name, only byteLength
  // (see native-frame.mjs), so this is the same "match by size" the
  // BlazeFace decode already does.
  function assembleGenderReads(replies, boxes) {
    var n = boxes.length;
    var genderData = new Float32Array(n);
    var ageData = new Float32Array(n * 100);
    var descData = new Float32Array(n * 1024);
    for (var i = 0; i < replies.length; i++) {
      var sorted = replies[i].outputs.slice().sort(function (a, b) {
        return a.length - b.length;
      });
      genderData[i] = sorted[0][0];
      ageData.set(sorted[1], i * 100);
      descData.set(sorted[2], i * 1024);
    }
    return genderReadsFromOutputs(genderData, ageData, descData, boxes, true);
  }

  // --- player path ------------------------------------------------------

  // All three interpreters load at construction on the Kotlin side
  // (Task 2 Step 2) -- there is no separate "ask for MoveNet" step here,
  // unlike the Worker, which loads it lazily on first use.
  function preloadPerson() {
    return true;
  }

  // One player pass: MoveNet (if withPersons) and BlazeFace (if
  // withFaces) on the SAME 256 frame -- one drawImage/getImageData, two
  // requests, mirroring worker-entry's one-upload-two-models pairing.
  function videoFrame(bitmap, aspect, held, withFaces, withPersons) {
    var wantPersons = withPersons !== false;
    var rgba;
    try {
      rgba = drawTo(PERSON_SIZE, bitmap);
    } catch (e) {
      try {
        bitmap.close();
      } catch (e2) {
        /* already closed */
      }
      return Promise.reject(e);
    }
    var personReq = wantPersons ? send(MODEL_MOVENET, PERSON_SIZE, PERSON_SIZE, rgba) : Promise.resolve(null);
    var faceReq = withFaces ? send(MODEL_BLAZEFACE, PERSON_SIZE, PERSON_SIZE, rgba) : Promise.resolve(null);
    return Promise.all([personReq, faceReq])
      .then(function (r) {
        var personReply = r[0];
        var faceReply = r[1];
        var persons = [];
        var noHumanShape = false;
        var maxKp = null;
        var rejectedBoxes = [];
        if (wantPersons && personReply) {
          // MoveNet's single [1,6,56] output, flattened -- the exact
          // shape parsePersons already reads off a tf tensor .data().
          persons = parsePersons(personReply.outputs[0], undefined, aspect, held);
          // R21: snapshot synchronously, right next to the call that
          // produced it -- see detector.js's detectPersons for why this
          // cannot be deferred into a later tick.
          noHumanShape = frameHasNoHumanShape(lastSlotDiag);
          maxKp = frameMaxKp(lastSlotDiag);
          rejectedBoxes = rejectedSlotBoxes(lastSlotDiag);
        }
        var faces = null;
        if (withFaces && faceReply) {
          faces = facesFromRows(faceRowsFromOutputs(faceReply.outputs));
        }
        return {
          persons: persons,
          // A SKIPPED PASS MUST BE INERT -- see worker-entry.js's
          // handleFrame comment. `wantPersons` false means we never
          // asked, so this must read false regardless of the model.
          noHumanShape: noHumanShape,
          maxKp: maxKp,
          personsSkipped: !wantPersons,
          rejectedBoxes: rejectedBoxes,
          faces: faces,
        };
      })
      .finally(function () {
        try {
          bitmap.close();
        } catch (e) {
          /* already closed */
        }
      });
  }

  // Faces in a person crop, KEEPING the source bitmap alive under a cid
  // so cropGender can re-crop it at 224 per face without a re-upload
  // from the caller.
  function cropFaces(pix) {
    sweepCrops();
    var t0 = nowMs();
    var rgba;
    try {
      rgba = drawTo(FACE_SIZE, pix);
    } catch (e) {
      try {
        pix.close();
      } catch (e2) {
        /* already closed */
      }
      return Promise.reject(e);
    }
    return send(MODEL_BLAZEFACE, FACE_SIZE, FACE_SIZE, rgba).then(
      function (reply) {
        var faces = facesFromRows(faceRowsFromOutputs(reply.outputs));
        var cid = nextCrop++;
        crops.set(cid, { bitmap: pix, at: nowMs() });
        return { cid: cid, faces: faces, ms: Math.round(nowMs() - t0) };
      },
      function (err) {
        try {
          pix.close();
        } catch (e) {
          /* already closed */
        }
        throw err;
      }
    );
  }

  function cropGender(cid, boxes) {
    var c = crops.get(cid);
    if (!c) return Promise.reject(new Error('crop gone'));
    if (!boxes.length) return Promise.resolve({ reads: [] });
    c.at = nowMs();
    var reqs = boxes.map(function (b) {
      var sq = squareBox(b, c.bitmap.width, c.bitmap.height);
      var rgba = drawSquareCrop(c.bitmap, sq);
      return send(MODEL_FACERES, GENDER_SIZE, GENDER_SIZE, rgba);
    });
    return Promise.all(reqs).then(function (replies) {
      return { reads: assembleGenderReads(replies, boxes) };
    });
  }

  function releaseCrop(cid) {
    var c = crops.get(cid);
    if (!c) return;
    try {
      c.bitmap.close();
    } catch (e) {
      /* already closed */
    }
    crops.delete(cid);
  }

  // A one-shot gender read on pixels the caller will not ask about
  // again (native-resolution face re-crop, whole-blur fallback) -- the
  // bitmap is closed here rather than kept, unlike cropFaces.
  function genderOnce(pix, boxes) {
    if (!boxes.length) {
      try {
        pix.close();
      } catch (e) {
        /* already closed */
      }
      return Promise.resolve({ reads: [] });
    }
    var reqs = boxes.map(function (b) {
      var sq = squareBox(b, pix.width, pix.height);
      var rgba = drawSquareCrop(pix, sq);
      return send(MODEL_FACERES, GENDER_SIZE, GENDER_SIZE, rgba);
    });
    return Promise.all(reqs)
      .then(function (replies) {
        return { reads: assembleGenderReads(replies, boxes) };
      })
      .finally(function () {
        try {
          pix.close();
        } catch (e) {
          /* already closed */
        }
      });
  }

  function terminate() {
    die('terminated');
    try {
      if (port.close) port.close();
    } catch (e) {
      /* already gone */
    }
  }

  return {
    ready: ready,
    configure: configure,
    backend: function () {
      return state.backend;
    },
    /** For the diagnostics report: which engine each model landed on. */
    snapshot: function () {
      return {
        backend: state.backend,
        npu: state.npu,
        backends: state.backends,
        gpu: state.gpu,
        npuWhy: state.npuWhy,
        nGpu: state.nGpu,
        dead: state.dead,
      };
    },
    dead: function () {
      return state.dead;
    },
    // Mirrors worker-client's genderReady: whether the player path may
    // rely on gender reads. Native loads all three interpreters before
    // ever posting native-ready, so this is just "alive and answered".
    genderReady: function () {
      return !state.dead && !!state.backend;
    },
    preloadPerson: preloadPerson,
    videoFrame: videoFrame,
    cropFaces: cropFaces,
    cropGender: cropGender,
    releaseCrop: releaseCrop,
    genderOnce: genderOnce,
    waitMs: function () {
      return waitTotal;
    },
    terminate: terminate,
  };
}
