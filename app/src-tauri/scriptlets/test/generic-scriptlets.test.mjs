// The three generic scriptlets the public lists call on many sites:
// json-prune-xhr-response, nano-setTimeout-booster (nano-stb) and
// remove-node-text (rmnt). Each test runs the scriptlet in a vm context
// with a minimal fake of the one browser API it patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// ---- json-prune-xhr-response ---------------------------------------------
function fakeXhrWorld() {
  class XMLHttpRequest {
    open(method, url) { this.url = url; this.readyState = 1; }
    finish(body, type = '') { this.body = body; this.responseType = type; this.readyState = 4; }
  }
  Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
    configurable: true, enumerable: true, get() { return typeof this.body === 'string' ? this.body : ''; },
  });
  Object.defineProperty(XMLHttpRequest.prototype, 'response', {
    configurable: true, enumerable: true, get() { return this.body; },
  });
  const ctx = { XMLHttpRequest, Object, JSON, Array, String, RegExp };
  vm.createContext(ctx);
  vm.runInContext(src('json-prune-xhr-response.js') + ';this.__fn = jsonPruneXhrResponse;', ctx);
  return ctx;
}

test('json-prune-xhr-response prunes matching URLs only, text and json', () => {
  const ctx = fakeXhrWorld();
  ctx.__fn('data.viewer.instream_video_ads data.scrubber', '', 'propsToMatch', '/api/graphql');
  const body = JSON.stringify({ data: { viewer: { instream_video_ads: [1], name: 'kept' }, scrubber: 1 } });

  const hit = new ctx.XMLHttpRequest();
  hit.open('POST', 'https://www.facebook.com/api/graphql/');
  hit.finish(body);
  const out = JSON.parse(hit.responseText);
  assert.equal(out.data.viewer.instream_video_ads, undefined);
  assert.equal(out.data.scrubber, undefined);
  assert.equal(out.data.viewer.name, 'kept');
  assert.equal(hit.responseText, hit.responseText, 'stable across reads');

  const miss = new ctx.XMLHttpRequest();
  miss.open('GET', 'https://www.facebook.com/other');
  miss.finish(body);
  assert.equal(miss.responseText, body, 'other URLs untouched');

  const json = new ctx.XMLHttpRequest();
  json.open('POST', 'https://www.facebook.com/api/graphql/');
  json.finish(JSON.parse(body), 'json');
  assert.equal(json.response.data.viewer.instream_video_ads, undefined);

  const broken = new ctx.XMLHttpRequest();
  broken.open('POST', 'https://www.facebook.com/api/graphql/');
  broken.finish('for (;;);{"not json');
  assert.equal(broken.responseText, 'for (;;);{"not json', 'unparseable passes through');
});

test('json-prune-xhr-response honours the required paths and [-] wildcards', () => {
  const ctx = fakeXhrWorld();
  ctx.__fn('nodes.[-].sponsored', 'nodes', 'propsToMatch', '/graphql');
  const x = new ctx.XMLHttpRequest();
  x.open('POST', '/graphql');
  x.finish(JSON.stringify({ nodes: [{ sponsored: 1, id: 1 }, { id: 2 }] }));
  assert.deepEqual(JSON.parse(x.responseText), { nodes: [{ id: 1 }, { id: 2 }] });

  const y = new ctx.XMLHttpRequest();
  y.open('POST', '/graphql');
  const without = JSON.stringify({ other: { sponsored: 1 } });
  y.finish(without);
  assert.equal(y.responseText, without, 'required path missing: untouched');
});

// ---- nano-setTimeout-booster ------------------------------------------------
function timerWorld() {
  const calls = [];
  const window = { setTimeout: (fn, d) => { calls.push(d); return calls.length; } };
  const ctx = { window, Math, Number, String, Array, RegExp, parseInt, parseFloat, isNaN, isFinite };
  vm.createContext(ctx);
  vm.runInContext(src('nano-setTimeout-booster.js') + ';this.__fn = nanoSetTimeoutBooster;', ctx);
  return { ctx, calls };
}

test('nano-stb speeds up only the matching countdown', () => {
  const { ctx, calls } = timerWorld();
  ctx.__fn('tick', '1000', '0.02');
  ctx.window.setTimeout(function tick() { /* countdown */ }, 1000);
  ctx.window.setTimeout(function tick() {}, 500);
  ctx.window.setTimeout(function other() {}, 1000);
  assert.deepEqual(calls, [20, 500, 1000]);
});

test('nano-stb defaults: any callback, 1000ms, x0.05; * matches any delay; boost is clamped', () => {
  let w = timerWorld();
  w.ctx.__fn();
  w.ctx.window.setTimeout(() => {}, 1000);
  w.ctx.window.setTimeout(() => {}, 999);
  assert.deepEqual(w.calls, [50, 999]);

  w = timerWorld();
  w.ctx.__fn('/showad/i', '*', '0');
  w.ctx.window.setTimeout(function showAd() {}, 17000);
  assert.deepEqual(w.calls, [17]);
});

// ---- remove-node-text -------------------------------------------------------
function domWorld() {
  // Just enough DOM: nodes with a name and text, a document that lists
  // them, and a MutationObserver the test drives by hand.
  const removed = [];
  const node = (name, text) => ({
    nodeName: name, nodeType: 1, textContent: text,
    getElementsByTagName: () => [],
    remove() { removed.push(text); },
  });
  let observerCb = null;
  class MutationObserver {
    constructor(cb) { observerCb = cb; }
    observe() {}
    disconnect() { observerCb = null; }
  }
  const initial = [node('SCRIPT', 'window.adblockDetected = true'), node('SCRIPT', 'app.start()')];
  const document = {
    documentElement: {},
    getElementsByTagName: (n) => initial.filter((x) => x.nodeName === n),
    addEventListener() {},
  };
  const ctx = { document, MutationObserver, String, RegExp, setTimeout };
  vm.createContext(ctx);
  vm.runInContext(src('remove-node-text.js') + ';this.__fn = removeNodeText;', ctx);
  const add = (n) => observerCb && observerCb([{ addedNodes: [n] }]);
  return { ctx, removed, node, add };
}

test('rmnt removes matching scripts already present and as they arrive', () => {
  const w = domWorld();
  w.ctx.__fn('script', 'adblock');
  assert.deepEqual(w.removed, ['window.adblockDetected = true']);
  w.add(w.node('SCRIPT', 'if (adblock) wall()'));
  w.add(w.node('SCRIPT', 'render()'));
  w.add(w.node('DIV', 'adblock in a div is not a script'));
  assert.deepEqual(w.removed, ['window.adblockDetected = true', 'if (adblock) wall()']);
});

test('rmnt takes a /regex/ and does nothing without both arguments', () => {
  let w = domWorld();
  w.ctx.__fn('script', '/ADBLOCK/i');
  assert.equal(w.removed.length, 1);
  w = domWorld();
  w.ctx.__fn('script', '');
  w.ctx.__fn('', 'adblock');
  assert.equal(w.removed.length, 0);
});
