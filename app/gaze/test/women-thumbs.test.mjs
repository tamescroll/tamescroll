// WOMEN-MODE THUMBNAILS, FASTER WITH THE SAME VERDICTS.
//   1. the gender model is asked for when the worker is up, in Women or
//      Men mode on YouTube only;
//   3. the worker may skip NSFW when a face already keeps the image
//      covered, and the page never reveals an answer that skipped it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wantsGenderPreload, workerMaySkipNsfw, mustRejudgeWithNsfw } from '../src/gender-wait.mjs';
import { flaggedFaceIndices } from '../src/gender-verdict.mjs';
import { createWorkerClient } from '../src/worker-client.mjs';

test('the gender model is preloaded only for a declared gender on YouTube', () => {
  assert.equal(wantsGenderPreload('smart', 'man', 'youtube'), true);
  assert.equal(wantsGenderPreload('smart', 'woman', 'youtube'), true);
  assert.equal(wantsGenderPreload('smart', 'unset', 'youtube'), false, 'Nothing-to-place: every face covered');
  assert.equal(wantsGenderPreload('all', 'woman', 'youtube'), false, 'Every picture runs no model');
  assert.equal(wantsGenderPreload('none', 'woman', 'youtube'), false);
  assert.equal(wantsGenderPreload('smart', 'woman', 'reddit'), false);
});

// The page's verdict, as init-entry applies a worker answer.
function verdict(userGender, res) {
  const faces = res.boxes || [];
  const reads = res.reads || [];
  let flagBoxes = [];
  if (faces.length) {
    if (!reads.length) flagBoxes = faces;
    else flagBoxes = flaggedFaceIndices(userGender, reads).map((i) => faces[i]);
  }
  return { face: flagBoxes.length > 0, flags: flagBoxes.length, nsfw: !flagBoxes.length && !!res.nsfw, flagBoxes };
}

// One image through the worker and back, 1136 (classifier always) or
// with the skip, including the page's re-judge.
function judge(userGender, boxes, reads, nsfwTruth, workerFlagged) {
  const old = verdict(userGender, { boxes, reads, nsfw: nsfwTruth });
  const skipped = workerMaySkipNsfw(userGender, boxes, reads, false, workerFlagged);
  let res = { boxes, reads, nsfw: skipped ? false : nsfwTruth, nsfwSkipped: skipped };
  let v = verdict(userGender, res);
  let calls = skipped ? 0 : 1;
  if (mustRejudgeWithNsfw(res, v.flagBoxes)) {
    res = { boxes, reads, nsfw: nsfwTruth, nsfwSkipped: false };
    v = verdict(userGender, res);
    calls++;
  }
  return { old, now: v, calls };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function randomRead(r) {
  const raw = r();
  return {
    gender: raw >= 0.5 ? 'male' : 'female',
    score: Math.abs(raw - 0.5) * 2,
    raw,
    age: r() < 0.1 ? undefined : 5 + r() * 60,
    childP: r() < 0.3 ? r() : undefined,
    shape: r() < 0.8 ? { norm: 2 + r() * 8 } : null,
  };
}

test('skipping NSFW changes no verdict, and calls the classifier less', () => {
  const r = rng(1136);
  let calls = 0, oldCalls = 0, n = 0;
  for (const g of ['man', 'woman', 'unset']) {
    for (let k = 0; k < 4000; k++) {
      const nf = Math.floor(r() * 4);
      const boxes = Array.from({ length: nf }, (_, i) => ({ i }));
      const reads = r() < 0.05 ? [] : boxes.map(() => randomRead(r));
      for (const truth of [false, true]) {
        const j = judge(g, boxes, reads, truth, flaggedFaceIndices);
        assert.deepEqual({ face: j.now.face, flags: j.now.flags, nsfw: j.now.nsfw },
          { face: j.old.face, flags: j.old.flags, nsfw: j.old.nsfw }, `${g} ${JSON.stringify(reads)}`);
        calls += j.calls; oldCalls += 1; n++;
      }
    }
  }
  assert.ok(calls < oldCalls * 0.8, `classifier calls ${calls} of ${oldCalls}`);
});

test('a worker whose bars disagree never reveals an image without NSFW', () => {
  // A worker one OTA push behind: it flags every face the page clears.
  const stale = (g, reads) => reads.map((_, i) => i);
  const r = rng(43);
  for (let k = 0; k < 2000; k++) {
    const boxes = [{ i: 0 }, { i: 1 }];
    const reads = boxes.map(() => randomRead(r));
    const j = judge('man', boxes, reads, true, stale);
    assert.deepEqual({ face: j.now.face, nsfw: j.now.nsfw }, { face: j.old.face, nsfw: j.old.nsfw });
  }
});

test('an answer held for the gender model may skip NSFW; it is never applied', () => {
  assert.equal(workerMaySkipNsfw('woman', [{}], [], true, flaggedFaceIndices), true);
  assert.equal(workerMaySkipNsfw('woman', [], [], false, flaggedFaceIndices), false, 'no face: NSFW is the whole question');
});

test('the client carries the skip to the worker', () => {
  const w = { posted: [], postMessage(m) { this.posted.push(m); }, terminate() {}, onmessage: null, onerror: null };
  global.window = { __TS_GAZE_PREWORKER: { worker: w, queue: [{ type: 'up' }, { type: 'loaded', model: 'face' }, { type: 'loaded', model: 'nsfw' }] } };
  global.location = { origin: 'https://m.youtube.com' };
  let c;
  try { c = createWorkerClient({ onEvent() {} }); } finally { delete global.window; }
  const bmp = { close() {} };
  c.classifyImage(bmp, { skipNsfwFor: 'woman' }).catch(() => {});
  c.classifyImage(bmp, {}).catch(() => {});
  const imgs = w.posted.filter((m) => m.type === 'image');
  assert.equal(imgs[0].skipNsfwFor, 'woman');
  assert.equal(imgs[1].skipNsfwFor, null);
});

test('the page asks for gender when the worker is up, and re-judges a skip it disagrees with', () => {
  const src = fs.readFileSync(new URL('../src/init-entry.js', import.meta.url), 'utf8');
  assert.match(src, /ev\.type === 'up'\) setTimeout\(preloadGender, 0\)/);
  assert.match(src, /wantsGenderPreload\(window\.__TS_GAZE_MODE, userGender, platformOf\(location\.hostname\)\)/);
  assert.match(src, /skipNsfwFor: nsfwRequired\.has\(img\) \? null : userGender/);
  const at = src.indexOf('if (mustRejudgeWithNsfw(res, flagBoxes))');
  assert.ok(at > 0 && at < src.indexOf('nsfw: !flagBoxes.length && !!res.nsfw'), 're-judge comes before the verdict is built');
  const w = fs.readFileSync(new URL('../src/worker-entry.js', import.meta.url), 'utf8');
  assert.match(w, /workerMaySkipNsfw\(skipFor, boxes, posted, genderPending, flaggedFaceIndices\)/);
});

test('the image path asks for gender once, without the player accessor', () => {
  const w = { posted: [], postMessage(m) { this.posted.push(m); }, terminate() {}, onmessage: null, onerror: null };
  global.window = { __TS_GAZE_PREWORKER: { worker: w, queue: [{ type: 'up' }] } };
  global.location = { origin: 'https://m.youtube.com' };
  let c;
  try { c = createWorkerClient({ onEvent() {} }); } finally { delete global.window; }
  c.askGender(); c.askGender(); c.genderReady();
  assert.equal(w.posted.filter((m) => m.type === 'gender').length, 1);
  const src = fs.readFileSync(new URL('../src/init-entry.js', import.meta.url), 'utf8');
  assert.match(src, /function preloadGender\(\) \{[\s\S]{0,400}gazeWorker\.askGender\(\);/);
});
