// THE GENDER MODEL LOADS LAZILY IN THE WORKER. Until it is in, an image
// with faces must stay covered and be judged again later, never applied
// as a verdict with no gender reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsGenderWait } from '../src/gender-wait.mjs';
import { createWorkerClient } from '../src/worker-client.mjs';

test('faces with no gender model yet are held, everything else is applied', () => {
  assert.equal(needsGenderWait({ boxes: [{}], reads: [], genderPending: true }), true);
  assert.equal(needsGenderWait({ boxes: [], reads: [], genderPending: true }), false, 'no faces: judge now');
  assert.equal(needsGenderWait({ boxes: [{}], reads: [{}], genderPending: false }), false);
  assert.equal(needsGenderWait({ boxes: [{}], reads: [] }), false, 'an old worker answer is not held');
  assert.equal(needsGenderWait(null), false);
});

function fakeWorker() {
  const posted = [];
  return { posted, postMessage(m) { posted.push(m); }, terminate() {}, onmessage: null, onerror: null };
}

function client(queue) {
  const w = fakeWorker();
  global.window = { __TS_GAZE_PREWORKER: { worker: w, queue } };
  global.location = { origin: 'https://m.youtube.com' };
  try {
    return { w, c: createWorkerClient({ onEvent() {} }) };
  } finally {
    delete global.window;
  }
}

test('images can be judged before the gender model loads', () => {
  const { c } = client([{ type: 'up' }, { type: 'loaded', model: 'face' }, { type: 'loaded', model: 'nsfw' }]);
  assert.equal(c.settled(), true);
  assert.equal(c.genderLoaded(), false);
});

test('the player asking for gender requests the model once', () => {
  const { w, c } = client([{ type: 'up' }, { type: 'loaded', model: 'face' }, { type: 'loaded', model: 'nsfw' }]);
  assert.equal(c.genderReady(), false);
  assert.equal(c.genderReady(), false);
  assert.equal(w.posted.filter((m) => m.type === 'gender').length, 1);
  w.onmessage({ data: { type: 'loaded', model: 'gender' } });
  assert.equal(c.genderReady(), true);
  assert.equal(c.genderLoaded(), true);
});
