// set-constant must compose with another accessor already on the link.
//
// This is the bug that let a pre-roll ad reach the owner twice
// (2026-08-25): another scriptlet had installed an accessor on
// window.ytInitialPlayerResponse, set-constant then walked
// `ytInitialPlayerResponse.playerAds`, read `undefined` through that
// getter ("not there yet") and replaced the whole accessor, so the first
// trap never saw the page's assignment.
//
// The scriptlet that collided (our own trusted-prune-window-json) was
// dropped on 2026-11-21 along with our YouTube rule, but any public-list
// scriptlet that traps a global can hit the same thing, so set-constant's
// delegation stays pinned here against a minimal stand-in trap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SETC = readFileSync(new URL('../set-constant.js', import.meta.url), 'utf8');

// A configurable get/set accessor that deletes `field` from whatever the
// page assigns: the shape any trapping scriptlet installs.
const TRAP = `function stripOnAssign(prop, field) {
  var value;
  Object.defineProperty(window, prop, {
    configurable: true,
    get: function () { return value; },
    set: function (v) { if (v && typeof v === 'object') delete v[field]; value = v; },
  });
}`;

function load() {
  const window = {};
  const ctx = { window, Object, JSON, Array, String, Number, RegExp };
  vm.createContext(ctx);
  vm.runInContext(TRAP + ';' + SETC + ';this.__trap = stripOnAssign;this.__setc = setConstant;', ctx);
  return { window: ctx.window, trap: ctx.__trap, setc: ctx.__setc };
}

function playerResponse() {
  return { adSlots: [1, 2, 3], playerAds: [{}], videoDetails: { title: 'real video' } };
}

test('set-constant after an existing trap keeps the trap working', () => {
  const { window, trap, setc } = load();
  trap('ytInitialPlayerResponse', 'adSlots');
  setc('ytInitialPlayerResponse.playerAds', 'undefined');
  window.ytInitialPlayerResponse = playerResponse();
  const got = window.ytInitialPlayerResponse;
  assert.equal(got.adSlots, undefined, 'the earlier trap was clobbered');
  assert.equal(got.playerAds, undefined, 'set-constant did not apply');
  assert.equal(got.videoDetails.title, 'real video');
});

test('reassignment keeps both working (YouTube reassigns on SPA navigation)', () => {
  const { window, trap, setc } = load();
  trap('ytInitialPlayerResponse', 'adSlots');
  setc('ytInitialPlayerResponse.playerAds', 'undefined');
  window.ytInitialPlayerResponse = playerResponse();
  window.ytInitialPlayerResponse = playerResponse();
  assert.equal(window.ytInitialPlayerResponse.adSlots, undefined);
  assert.equal(window.ytInitialPlayerResponse.playerAds, undefined);
  assert.equal(window.ytInitialPlayerResponse.videoDetails.title, 'real video');
});
