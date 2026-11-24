import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/init-entry.js', import.meta.url), 'utf8');

// Slice to MARKERS, never a character count: a fixed window silently
// stops covering the block as the comments above it grow, which has
// already cost this repo two rounds.
const block = src.slice(src.indexOf('var chromeHidden'), src.indexOf('}, 250);'));

test('the pill and the gear are hidden off the watch page', () => {
  assert.ok(block.includes('setChrome(feedPreview())'), 'the visibility gate must be the path');
  // Both controls, or the gear alone keeps riding the feed.
  assert.ok(block.includes("pill.style.display = hide ? 'none' : 'flex'"), 'the pill hides');
  // The gear comes from the panel it belongs to, not a class query
  // against a separately-resolved host: that query read null on the
  // device and the gear rode the feed while the pill hid correctly.
  assert.ok(block.includes('tuneUi && tuneUi.gear'), 'the gear is taken from the panel');
  assert.ok(block.includes(".ts-gaze-gear"), 'with a class query as the fallback');
});

test('an open tuning panel closes with them', () => {
  const set = block.slice(block.indexOf('var setChrome'), block.indexOf('setChrome(feedPreview())'));
  assert.ok(set.includes('tuneUi.close()'), 'a panel left open would paint on the feed too');
  assert.ok(!set.includes('tuneUi.destroy()'), 'destroy would drop his overrides on every feed visit');
});

test('the gate is re-checked on a single-page navigation, not only at attach', () => {
  // m.youtube leaves the <video> CONNECTED when it leaves /watch, so the
  // teardown below never fires and a one-shot check at attach time would
  // never run again. The tick is what catches the SPA nav.
  const tick = block.slice(block.indexOf('var pillWatch'));
  assert.ok(tick.includes('setChrome(feedPreview())'), 'the interval must re-check');
  assert.ok(
    tick.indexOf('return;') < tick.lastIndexOf('setChrome(feedPreview())'),
    'the teardown branch must return before the re-check, not fall through it'
  );
});

test('an unreadable path leaves his escape hatch ON SCREEN', () => {
  // setChrome(hide) takes feedPreview() directly, so feedPreview's own
  // failure mode decides what a thrown location does: false = not a
  // preview = pill shown. Hiding the blur switch on an error would take
  // away the one tap that undoes a wrong verdict.
  const fn = src.slice(src.indexOf('function feedPreview()'), src.indexOf('function feedPreview()') + 320);
  const c = fn.indexOf('catch');
  assert.ok(c > 0 && fn.slice(c, c + 80).includes('return false'), 'feedPreview fails "watch page"');
});

const tune = readFileSync(new URL('../src/tune-overlay.mjs', import.meta.url), 'utf8');

test('the panel hands its gear element back', () => {
  const ret = tune.slice(tune.lastIndexOf('return {'));
  assert.ok(/\bgear: gear\b/.test(ret), 'installTuneUi must expose the gear it owns');
});

test('with no switch on the player, the pill is never shown and the gear is never built', () => {
  // His ruling 2026-10-27 (PLAYER_VIDEO_BLUR): the pill element stays
  // because its watcher turns a preview's blur off on a watch page, but
  // setChrome must hide it whatever the page is.
  const set = block.slice(block.indexOf('var setChrome'), block.indexOf('setChrome(feedPreview())'));
  assert.ok(set.includes('hide = hide || !playerSwitchShown()'), 'the pill would show with no blur behind it');
  assert.ok(/if \(playerSwitchShown\(\)( && [^)]*)?\) tuneUi = installTuneUi\(/.test(src), 'the gear would ride a player with no switch');
  // The browser extension shows the switch but never the developer gear.
  assert.ok(src.includes("if (playerSwitchShown() && window.__TS_GAZE_HOST !== 'extension') tuneUi = installTuneUi("), 'the extension would draw the gear');
});
