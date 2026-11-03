// Clean-room request-editor scriptlet test. Loads the scriptlet body into
// a fake DOM (stub window.fetch + XMLHttpRequest), runs it, then drives a
// /player request and asserts the outbound JSON body gained the field
// (field name from a public write-up at iter.ca, NOT uBO/AdGuard code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../trusted-set-request-field.js', import.meta.url), 'utf8');

function load(win) {
  const ctx = { window: win, XMLHttpRequest: win.XMLHttpRequest, Response, JSON, Object, String, Date, RegExp, Array };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.__fn = trustedSetRequestField;', ctx);
  return ctx.__fn;
}

test('fetch: adds the field to a matching /player POST body', () => {
  let sent = null;
  const win = { fetch: function (input, init) { sent = { input, init }; return Promise.resolve(); }, XMLHttpRequest: undefined };
  const fn = load(win);
  fn('/youtubei/v1/player', 'playbackContext.contentPlaybackContext.isInlinePlaybackNoAd', 'true');
  win.fetch('https://www.youtube.com/youtubei/v1/player?key=x', { method: 'POST', body: JSON.stringify({ videoId: 'abc', playbackContext: { contentPlaybackContext: { referer: 'r' } } }) });
  const body = JSON.parse(sent.init.body);
  assert.equal(body.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
  assert.equal(body.playbackContext.contentPlaybackContext.referer, 'r'); // siblings preserved
  assert.equal(body.videoId, 'abc');
});

test('fetch: creates missing intermediate objects', () => {
  let sent = null;
  const win = { fetch: function (i, init) { sent = init; return Promise.resolve(); }, XMLHttpRequest: undefined };
  const fn = load(win);
  fn('/player', 'a.b.c', 'true');
  win.fetch('/youtubei/v1/player', { body: JSON.stringify({ x: 1 }) });
  assert.deepEqual(JSON.parse(sent.body), { x: 1, a: { b: { c: true } } });
});

test('fetch: leaves non-matching URLs untouched', () => {
  let sent = null;
  const win = { fetch: function (i, init) { sent = init; return Promise.resolve(); }, XMLHttpRequest: undefined };
  const fn = load(win);
  fn('/player', 'a', 'true');
  const orig = JSON.stringify({ x: 1 });
  win.fetch('/youtubei/v1/browse', { body: orig });
  assert.equal(sent.body, orig);
});

test('fetch: non-JSON body passes through, no throw', () => {
  let sent = null;
  const win = { fetch: function (i, init) { sent = init; return Promise.resolve(); }, XMLHttpRequest: undefined };
  const fn = load(win);
  fn('/player', 'a', 'true');
  win.fetch('/youtubei/v1/player', { body: 'not json' });
  assert.equal(sent.body, 'not json');
});

test('parses true/false/number/string values', () => {
  const win = { fetch: function (i, init) { win._b = init.body; return Promise.resolve(); }, XMLHttpRequest: undefined };
  const fn = load(win);
  fn('/player', 'v', 'false');
  win.fetch('/player', { body: '{}' });
  assert.equal(JSON.parse(win._b).v, false);
  const fn2 = load(win); fn2('/player', 'n', '42');
  win.fetch('/player', { body: '{}' });
  assert.equal(JSON.parse(win._b).n, 42);
});

test('XHR: edits matching send body', () => {
  const calls = [];
  class FakeXHR {
    open(m, u) { this._u = u; }
    send(b) { calls.push({ u: this._u, b }); }
  }
  const win = { fetch: undefined, XMLHttpRequest: FakeXHR };
  const fn = load(win);
  fn('/player', 'flag', 'true');
  const x = new FakeXHR();
  x.open('POST', 'https://www.youtube.com/youtubei/v1/player');
  x.send(JSON.stringify({ q: 1 }));
  assert.equal(JSON.parse(calls[0].b).flag, true);
  assert.equal(JSON.parse(calls[0].b).q, 1);
});
