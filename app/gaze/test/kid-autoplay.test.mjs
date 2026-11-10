// "Autoplay next video" Hidden (ZV 2026-11-10): the watch video is paused
// a moment before its end, so YouTube never reaches the ended state its
// autoplay and end screen start from. Runs app/src-tauri/kid-controls.js
// in a fake page with the config lib.rs would splice in, and drives a
// fake <video> through its media events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../src-tauri/kid-controls.js', import.meta.url), 'utf8');

function page({ path = '/watch', autoplayOff = true } = {}) {
  const listeners = {};
  const document = {
    body: {},
    addEventListener(type, fn, capture) {
      if (capture === true) (listeners[type] = listeners[type] || []).push(fn);
    },
  };
  const window = { addEventListener() {} };
  const ctx = { window, document, location: { pathname: path }, history: {}, isFinite, Math, setTimeout, setInterval() {} };
  vm.createContext(ctx);
  const cfg = JSON.stringify({ swipeOff: false, lock: false, autoplayOff });
  vm.runInContext(SRC.replace('/*TS_KID*/ null', cfg), ctx);

  // One fire of a media event: the document's capture listeners first,
  // then the player's own listener on the video unless one stopped it.
  function fire(v, type) {
    let stopped = false;
    const e = { target: v, stopImmediatePropagation() { stopped = true; } };
    for (const fn of listeners[type] || []) {
      fn(e);
      if (stopped) break;
    }
    if (!stopped) v.youtubeSaw.push(type);
  }
  return { fire };
}

function video(extra = {}) {
  return {
    tagName: 'VIDEO', duration: 300, currentTime: 0, paused: false,
    playbackRate: 1, loop: false, youtubeSaw: [],
    pause() { this.paused = true; },
    closest() { return null; },
    ...extra,
  };
}

test('the watch video pauses just short of its end', () => {
  const { fire } = page();
  const v = video({ currentTime: 120 });
  fire(v, 'timeupdate');
  assert.equal(v.paused, false, 'mid-video playback is left alone');
  v.currentTime = 299.6;
  fire(v, 'timeupdate');
  assert.equal(v.paused, true, 'held before the end');
});

test('play on a held video starts it over', () => {
  const { fire } = page();
  const v = video({ currentTime: 299.6 });
  fire(v, 'timeupdate');
  v.paused = false;
  fire(v, 'play');
  assert.equal(v.currentTime, 0);
});

test('an ended event never reaches the player', () => {
  const { fire } = page();
  const v = video({ currentTime: 300 });
  fire(v, 'ended');
  assert.ok(!v.youtubeSaw.includes('ended'));
});

test('the margin grows with playback speed', () => {
  const { fire } = page();
  const v = video({ currentTime: 299, playbackRate: 2 });
  fire(v, 'timeupdate');
  assert.equal(v.paused, true, '1s from the end at 2x is inside the margin');
});

test('Shorts, feed previews, loops, live streams and ads are left alone', () => {
  for (const [path, extra] of [
    ['/shorts/abc', {}],
    ['/', {}],
    ['/watch', { loop: true }],
    ['/watch', { duration: Infinity }],
    ['/watch', { closest: () => ({}) }],
  ]) {
    const { fire } = page({ path });
    const v = video({ currentTime: 299.8, ...extra });
    if (!isFinite(v.duration)) v.currentTime = 1e9;
    fire(v, 'timeupdate');
    fire(v, 'ended');
    assert.equal(v.paused, false, `${path} ${JSON.stringify(Object.keys(extra))}`);
    assert.ok(v.youtubeSaw.includes('ended'), `${path} keeps its ended`);
  }
});

test('Autoplay Shown leaves the video and YouTube alone', () => {
  const { fire } = page({ autoplayOff: false });
  const v = video({ currentTime: 299.8 });
  fire(v, 'timeupdate');
  fire(v, 'ended');
  assert.equal(v.paused, false);
  assert.ok(v.youtubeSaw.includes('ended'));
});
