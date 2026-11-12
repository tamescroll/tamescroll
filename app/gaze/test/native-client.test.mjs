// native-client.mjs against a FAKE port -- no real WebMessagePort, no
// device. The fake records every ArrayBuffer the client sends and lets
// the test hand back a synthetic reply for it, the same shape a real
// NativeInfer.kt reply would have (native-frame.mjs's own format).
//
// Node has no OffscreenCanvas, and the plan says this client must work
// with none available on `window` either (it may live inside a Worker)
// -- so a minimal stand-in is installed on `globalThis` before the
// module under test is imported. Its content is irrelevant here: every
// test drives the DECODED reply, never the pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeCtx {
  constructor(w, h) {
    this.w = w;
    this.h = h;
  }
  clearRect() {}
  fillRect() {}
  drawImage() {
    this.draws = this.draws || [];
    this.draws.push({ args: Array.from(arguments), smoothing: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality });
  }
  getImageData() {
    return { data: new Uint8ClampedArray(this.w * this.h * 4) };
  }
}
class FakeOffscreenCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this._ctx = new FakeCtx(w, h);
    (FakeOffscreenCanvas.instances = FakeOffscreenCanvas.instances || []).push(this);
  }
  getContext() {
    return this._ctx;
  }
}
globalThis.OffscreenCanvas = FakeOffscreenCanvas;

const { createNativeClient } = await import('../src/native-client.mjs');

function makeFakeBitmap(w, h) {
  return { width: w || 256, height: h || 256, closed: false, close() { this.closed = true; } };
}

function makeFakePort() {
  const sent = [];
  const configs = [];
  const port = {
    postMessage(data) {
      // The CONFIG frame the client sends on every ready (modelId 0, 16
      // bytes, native-config.test.mjs) is kept apart so the model
      // request counts below stay about models.
      if (data && data.byteLength === 16 && new DataView(data).getUint32(4, true) === 0) configs.push(data);
      else sent.push(data);
    },
    onmessage: null,
  };
  port.sent = sent;
  port.configs = configs;
  port.emit = function (data) {
    port.onmessage({ data: data });
  };
  return port;
}

function readRequestHeader(buf) {
  const dv = new DataView(buf);
  return {
    reqId: dv.getUint32(0, true),
    modelId: dv.getUint32(4, true),
    w: dv.getUint32(8, true),
    h: dv.getUint32(12, true),
  };
}

function buildReply(reqId, status, elapsedUs, outputs) {
  let total = 16;
  for (const o of outputs) total += 4 + o.byteLength;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, reqId, true);
  dv.setUint32(4, status, true);
  dv.setUint32(8, outputs.length, true);
  dv.setUint32(12, elapsedUs, true);
  let off = 16;
  for (const o of outputs) {
    dv.setUint32(off, o.byteLength, true);
    off += 4;
    new Uint8Array(buf, off, o.byteLength).set(new Uint8Array(o.buffer, o.byteOffset, o.byteLength));
    off += o.byteLength;
  }
  return buf;
}

function lastSent(port) {
  return port.sent[port.sent.length - 1];
}

test('ready resolves once native-ready arrives on the port', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  assert.equal(client.dead(), false);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [{ id: 1, name: 'blazeface' }] }));
  const r = await client.ready;
  assert.equal(r.backend, 'gpu');
  assert.equal(client.backend(), 'gpu');
  assert.equal(client.dead(), false);
  assert.equal(client.genderReady(), true);
});

test('a MessageEvent the page dispatched on the port is ignored (phase-j J6)', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.onmessage({ data: JSON.stringify({ type: 'native-failed', why: 'forged' }), isTrusted: false });
  assert.equal(client.dead(), false, 'an untrusted native-failed must not kill the client');
  port.onmessage({ data: JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }), isTrusted: true });
  await client.ready;
  const bmp = makeFakeBitmap(640, 360);
  const p = client.videoFrame(bmp, 16 / 9, null, false, true);
  const hdr = readRequestHeader(lastSent(port));
  port.onmessage({ data: buildReply(hdr.reqId, 0, 5000, [new Float32Array(6 * 56)]), isTrusted: false });
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false, 'a forged reply must not resolve the request');
  port.emit(buildReply(hdr.reqId, 0, 5000, [new Float32Array(6 * 56)]));
  await p;
});

test('die() closes every crop the client still holds (phase-j J7)', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;
  const bmp = makeFakeBitmap(1280, 720);
  const p = client.cropFaces(bmp);
  const hdr = readRequestHeader(lastSent(port));
  // BlazeFace's four outputs, every logit -10: no face, but the cid is
  // minted before decode and the bitmap is held under it.
  port.emit(buildReply(hdr.reqId, 0, 5000, [new Float32Array(512).fill(-10), new Float32Array(384).fill(-10), new Float32Array(512 * 16), new Float32Array(384 * 16)]));
  const r = await p;
  assert.ok(r.cid, 'a cid was minted');
  assert.equal(bmp.closed, false, 'the bitmap is held under the cid');
  client.terminate();
  assert.equal(bmp.closed, true, 'die() closed the held bitmap');
});

test('onReply tallies resolved and failed replies on the transport (phase-j J9)', async () => {
  const port = makeFakePort();
  const tally = { ok: 0, bad: 0 };
  const client = createNativeClient(port, { onReply: (ok) => { if (ok) tally.ok++; else tally.bad++; } });
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;
  const p = client.videoFrame(makeFakeBitmap(640, 360), 16 / 9, null, false, true);
  const hdr = readRequestHeader(lastSent(port));
  port.emit(buildReply(hdr.reqId, 0, 5000, [new Float32Array(6 * 56)]));
  await p;
  assert.deepEqual(tally, { ok: 1, bad: 0 });
  const p2 = client.videoFrame(makeFakeBitmap(640, 360), 16 / 9, null, false, true);
  const hdr2 = readRequestHeader(lastSent(port));
  port.emit(buildReply(hdr2.reqId, 1, 5000, []));
  await assert.rejects(p2);
  assert.deepEqual(tally, { ok: 1, bad: 1 });
});

test('a native-failed message kills the client and rejects ready', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-failed', why: 'no gpu delegate' }));
  await assert.rejects(client.ready);
  assert.equal(client.dead(), true);
  assert.equal(client.genderReady(), false);
});

test('videoFrame sends one MoveNet request and returns persons from parsePersons', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;

  const bmp = makeFakeBitmap(1280, 720);
  const p = client.videoFrame(bmp, 16 / 9, null, false, true);

  assert.equal(port.sent.length, 1, 'withFaces=false sends only the MoveNet request');
  const hdr = readRequestHeader(lastSent(port));
  assert.equal(hdr.modelId, 3, 'modelId 3 = movenet');
  assert.equal(hdr.w, 256);
  assert.equal(hdr.h, 256);

  // All-zero MoveNet output: every slot score 0, well under
  // PERSON_MIN_SCORE -- the well-defined "nobody admitted" case this
  // repo's own history calls "all twelve slots n:0".
  const movenetOut = new Float32Array(6 * 56);
  port.emit(buildReply(hdr.reqId, 0, 5000, [movenetOut]));

  const result = await p;
  assert.ok(Array.isArray(result.persons));
  assert.equal(result.persons.length, 0);
  assert.equal(typeof result.noHumanShape, 'boolean');
  assert.equal(result.personsSkipped, false);
  assert.equal(result.faces, null, 'withFaces=false leaves faces null');
  assert.equal(bmp.closed, true, 'the bitmap is always closed');
});

test('the whole-frame squash samples where tf.image.resizeBilinear samples', async () => {
  // Measured on the Redmi (spikes/gauntlet/native-pixels-1788345747.json):
  // a plain drawImage(bmp, 0, 0, 256, 256) differs from the tensor
  // path's resizeBilinear by 4.8-5.7 levels because canvas centres each
  // destination pixel on the source while tf reads src = dst * scale.
  // Shifting the source rect by (scale - 1) / 2 with bilinear ('low')
  // smoothing lands within 0.04 levels. This pins the shift and the
  // smoothing mode; the pixel numbers are the probe's to keep.
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;
  const bmp = makeFakeBitmap(640, 360);
  const p = client.videoFrame(bmp, 16 / 9, null, false, true);
  const hdr = readRequestHeader(lastSent(port));
  port.emit(buildReply(hdr.reqId, 0, 5000, [new Float32Array(6 * 56)]));
  await p;
  const canvas = new FakeOffscreenCanvas(256, 256);
  // canvasFor() caches one canvas per size on the module; reach it
  // through the ctx the client actually drew on.
  const draws = [];
  for (const c of FakeOffscreenCanvas.instances || []) if (c._ctx.draws) draws.push(...c._ctx.draws);
  // The canvas is cached per size across tests, so take the LAST squash.
  const kx = 640 / 256;
  const ky = 360 / 256;
  // The shifted source rect (-(k-1)/2, full size) runs off the bitmap by
  // a fraction of a pixel. It is drawn CLIPPED to the bitmap with the
  // destination shrunk to match -- the canvas spec's own clipping, so
  // the samples are the same -- because WebKit draws nothing at all for
  // a source rect outside the bitmap (iPhone fed the face model blank
  // frames).
  const sx = -(kx - 1) / 2;
  const sy = -(ky - 1) / 2;
  const fx = 256 / 640;
  const fy = 256 / 360;
  const d = draws.filter((x) => x.args.length === 9 && Math.abs(x.args[5] - -sx * fx) < 1e-9).pop();
  assert.ok(d, 'the squash uses the 9-argument source-rect form');
  assert.equal(d.args[1], 0, 'source rect starts inside the bitmap');
  assert.equal(d.args[2], 0, 'source rect starts inside the bitmap');
  assert.equal(d.args[3], 640 + sx);
  assert.equal(d.args[4], 360 + sy);
  assert.ok(Math.abs(d.args[5] - -sx * fx) < 1e-9);
  assert.ok(Math.abs(d.args[6] - -sy * fy) < 1e-9);
  assert.ok(Math.abs(d.args[7] - (640 + sx) * fx) < 1e-9);
  assert.ok(Math.abs(d.args[8] - (360 + sy) * fy) < 1e-9);
  // Same mapping as the unclipped rect (source x -> (x - sx) * fx), so
  // the clipped draw still ends on the destination's far edges.
  assert.ok(Math.abs(d.args[5] + d.args[7] - 256) < 1e-9);
  assert.ok(Math.abs(d.args[6] + d.args[8] - 256) < 1e-9);
  assert.equal(d.smoothing, true);
  assert.equal(d.quality, 'low');
  void canvas;
});

test('videoFrame with withPersons=false never sends a MoveNet request and reports personsSkipped', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;

  const bmp = makeFakeBitmap();
  const p = client.videoFrame(bmp, 16 / 9, null, false, false);
  assert.equal(port.sent.length, 0, 'neither model was asked for');
  const result = await p;
  assert.deepEqual(result.persons, []);
  assert.equal(result.personsSkipped, true);
  assert.equal(result.noHumanShape, false, 'a skipped pass must be inert, never "nobody is there"');
});

test('a status-1 reply rejects that request, and three in a row mark the client dead', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;

  for (let i = 0; i < 3; i++) {
    assert.equal(client.dead(), false, 'still alive before failure ' + (i + 1));
    const bmp = makeFakeBitmap();
    const p = client.videoFrame(bmp, 16 / 9, null, false, true);
    const hdr = readRequestHeader(lastSent(port));
    port.emit(buildReply(hdr.reqId, 1, 0, []));
    await assert.rejects(p, /native status 1/);
  }
  assert.equal(client.dead(), true);

  // A dead client refuses new work rather than sending it into the void.
  await assert.rejects(client.videoFrame(makeFakeBitmap(), 16 / 9, null, false, true));
});

test('a request that never gets a reply times out and rejects', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port, { requestTimeoutMs: 15 });
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;

  const p = client.videoFrame(makeFakeBitmap(), 16 / 9, null, false, true);
  await assert.rejects(p, /native timeout/);
});

test('a client that never hears native-ready dies on its own ready timeout', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port, { readyTimeoutMs: 15 });
  await assert.rejects(client.ready, /no native-ready/);
  assert.equal(client.dead(), true);
});

test('cropFaces keeps the bitmap alive under a cid; cropGender reads it back and releaseCrop closes it', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [] }));
  await client.ready;

  const bmp = makeFakeBitmap(300, 300);
  const facesP = client.cropFaces(bmp);
  const hdr1 = readRequestHeader(lastSent(port));
  assert.equal(hdr1.modelId, 1, 'modelId 1 = blazeface');

  // A confident row at anchor 0 -- same construction as
  // face-decode.test.mjs, kept minimal since this test is about the
  // cid/bitmap plumbing, not the decode arithmetic. Every other logit is
  // -10 (a logit of 0 sigmoids to 0.5, which clears the confidence floor
  // on every anchor and would keep up to FACE_MAX rows instead of one).
  const scores512 = new Float32Array(512).fill(-10);
  scores512[0] = 10;
  const outputs = [
    scores512,
    new Float32Array(384).fill(-10),
    new Float32Array(512 * 16),
    new Float32Array(384 * 16),
  ];
  port.emit(buildReply(hdr1.reqId, 0, 1000, outputs));

  const { cid, faces } = await facesP;
  assert.equal(faces.length, 1);
  assert.equal(bmp.closed, false, 'cropFaces keeps the bitmap alive for a later cropGender');

  const genderP = client.cropGender(cid, faces);
  assert.equal(port.sent.length, 2, 'one faceres request per face');
  const hdr2 = readRequestHeader(lastSent(port));
  assert.equal(hdr2.modelId, 2, 'modelId 2 = faceres');
  const gender = new Float32Array([0.9]);
  const age = new Float32Array(100);
  const desc = new Float32Array(1024);
  port.emit(buildReply(hdr2.reqId, 0, 500, [gender, age, desc]));

  const { reads } = await genderP;
  assert.equal(reads.length, 1);
  assert.equal(reads[0].gender, 'male');

  client.releaseCrop(cid);
  assert.equal(bmp.closed, true, 'releaseCrop closes the kept bitmap');
});

// 1098 smoke: the NPU trials run AFTER ready (arbitrating inside the load
// took 19s on the Redmi against the 15s ready timeout and killed the
// client). Their outcome is a `native-backends` update that rewrites the
// snapshot's report fields and touches nothing else -- not the ready
// promise, not the timer, not the failure counter.
test('a native-backends update rewrites the snapshot fields only', async () => {
  const port = makeFakePort();
  const client = createNativeClient(port);
  port.emit(JSON.stringify({ type: 'native-ready', backend: 'gpu', models: [], backends: { 1: 'gpu', 2: 'gpu', 3: 'gpu' }, npu: 'pending' }));
  await client.ready;
  assert.equal(client.snapshot().npu, 'pending');
  port.emit(JSON.stringify({ type: 'native-backends', backend: 'gpu', backends: { 1: 'gpu', 2: 'gpu', 3: 'npu' }, npu: 'ok' }));
  const snap = client.snapshot();
  assert.equal(snap.npu, 'ok');
  assert.equal(snap.backends[3], 'npu');
  assert.equal(snap.dead, false);
  assert.equal(client.dead(), false);
  // Before ready it must not resolve ready either.
  const port2 = makeFakePort();
  const client2 = createNativeClient(port2, { readyTimeoutMs: 50 });
  port2.emit(JSON.stringify({ type: 'native-backends', backend: 'gpu', backends: {}, npu: 'failed' }));
  await assert.rejects(client2.ready, /no native-ready/);
});
