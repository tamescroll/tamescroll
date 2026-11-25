// THE IMAGE PATH ON IPHONE, OFF THE PAGE'S THREAD (2026-11-12).
//
// WKWebView cannot start the inference worker (worker-client.mjs), so on
// iPhone every model ran in the page, on the main thread, and the
// simulator measured ~5s per thumbnail. iPhone has its own engine
// instead: Core ML behind native-client.mjs (TsInfer.swift, the iPhone
// twin of Android's NativeInfer.kt). This module dresses that client as
// the worker the image drain already knows -- the same classifyImage
// reply worker-entry's handleImage posts -- so init-entry's off-thread
// branch, its verdict rules and its failure handling are reused as they
// are. Faces and gender go native; the NSFW classifier, which has no
// native model yet, stays in the page and is handed in as `nsfw`.
//
// Mirrors worker-entry.js handleImage step for step, including the
// NSFW skip (workerMaySkipNsfw) and imageRead's trimmed reads, so the
// two image paths cannot answer differently.
import { imageRead } from './face-decode.mjs';
import { flaggedFaceIndices } from './gender-verdict.mjs';
import { workerMaySkipNsfw } from './gender-wait.mjs';

/**
 * `client`: a createNativeClient() instance. `opts.nsfw(bitmap)` returns
 * a Promise of a boolean; `opts.onEvent(ev)` receives the worker-client
 * events init-entry handles (up, loaded, ready, dead).
 */
export function createNativeImageEngine(client, opts) {
  var o = opts || {};
  var onEvent = typeof o.onEvent === 'function' ? o.onEvent : function () {};
  var nsfw = typeof o.nsfw === 'function' ? o.nsfw : function () { return Promise.resolve(false); };
  var isReady = false;
  var isDead = false;
  var t0 = performance.now();

  function emit(ev) {
    try {
      onEvent(ev);
    } catch (e) {
      /* a listener that throws must not stop the engine */
    }
  }
  function die(why) {
    if (isDead) return;
    isDead = true;
    isReady = false;
    emit({ type: 'dead', why: why });
  }

  emit({ type: 'up' });
  client.ready.then(
    function (r) {
      if (isDead) return;
      isReady = true;
      var ms = Math.round(performance.now() - t0);
      emit({ type: 'loaded', model: 'face', ms: ms });
      emit({ type: 'loaded', model: 'gender', ms: ms });
      emit({ type: 'ready', backend: 'native:' + ((r && r.backend) || '?'), ms: ms });
    },
    function (e) {
      die(String((e && e.message) || e));
    }
  );

  function bitmapCopy(bmp) {
    // cropFaces keeps (and later closes) the bitmap it is given; NSFW
    // reads its own copy so neither side closes the other's.
    return createImageBitmap(bmp);
  }

  function classifyImage(bmp, req) {
    var r = req || {};
    var started = performance.now();
    if (!isReady || client.dead()) {
      try {
        bmp.close();
      } catch (e) {
        /* already closed */
      }
      if (client.dead()) die('native dead');
      return Promise.reject(new Error('native not ready'));
    }
    var wantNsfw = !r.noNsfw;
    var skipFor = typeof r.skipNsfwFor === 'string' ? r.skipNsfwFor : null;
    var nsfwSrc = wantNsfw ? bitmapCopy(bmp) : Promise.resolve(null);
    var nsfwP = null;
    function runNsfw() {
      return nsfwSrc.then(function (copy) {
        if (!copy) return false;
        return Promise.resolve(nsfw(copy))
          .catch(function () {
            return false;
          })
          .finally(function () {
            try {
              copy.close();
            } catch (e) {
              /* already closed */
            }
          });
      });
    }
    if (wantNsfw && skipFor === null) nsfwP = runNsfw();
    var cid = null;
    return nsfwSrc
      .then(function () {
        return client.cropFaces(bmp);
      })
      .then(function (res) {
        cid = res.cid;
        var boxes = res.faces || [];
        if (!boxes.length) return { boxes: boxes, reads: [] };
        return client.cropGender(cid, boxes).then(function (g) {
          return { boxes: boxes, reads: (g && g.reads) || [] };
        });
      })
      .then(function (fr) {
        if (cid !== null) client.releaseCrop(cid);
        var posted = fr.reads.map(imageRead);
        var nsfwSkipped = false;
        if (wantNsfw && !nsfwP) {
          if (workerMaySkipNsfw(skipFor, fr.boxes, posted, false, flaggedFaceIndices)) nsfwSkipped = true;
          else nsfwP = runNsfw();
        }
        if (nsfwSkipped) {
          nsfwSrc.then(function (copy) {
            try {
              if (copy) copy.close();
            } catch (e) {
              /* already closed */
            }
          });
        }
        return (nsfwP || Promise.resolve(false)).then(function (isNsfw) {
          return {
            boxes: fr.boxes,
            reads: posted,
            nsfw: !!isNsfw,
            nsfwSkipped: nsfwSkipped,
            genderPending: false,
            ms: Math.round(performance.now() - started),
          };
        });
      })
      .catch(function (e) {
        if (cid !== null) client.releaseCrop(cid);
        if (client.dead()) die('native dead');
        throw e;
      });
  }

  function no() {
    return Promise.reject(new Error('native images only'));
  }

  return {
    ready: function () {
      return isReady && !client.dead();
    },
    settled: function () {
      return isReady || isDead;
    },
    genderLoaded: function () {
      return isReady;
    },
    waitMs: function () {
      return client.waitMs();
    },
    genderReady: function () {
      return isReady;
    },
    askGender: function () {},
    dead: function () {
      return isDead || client.dead();
    },
    classifyImage: classifyImage,
    backend: function () {
      return isReady ? 'native' : null;
    },
    preloadPerson: function () {
      return false;
    },
    askedPerson: function () {
      return false;
    },
    personFailed: function () {
      return true;
    },
    videoFrame: no,
    cropFaces: no,
    cropGender: no,
    releaseCrop: function () {},
    genderOnce: no,
    terminate: function () {
      die('terminated');
    },
  };
}
