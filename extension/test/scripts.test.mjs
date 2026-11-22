import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantedScripts } from '../src/scripts.js';

const ids = (settings) => wantedScripts(settings).map((s) => s.id).sort();

test('install defaults on YouTube: Shorts redirect and autoplay stop, no ad scriptlets (ads shown)', () => {
  assert.deepEqual(ids({ sites: { youtube: { on: true, shown: ['ads', 'watch_recs'] } } }), ['youtube-autoplay', 'youtube-shorts']);
});

test('ads hidden adds the ad scriptlets in the page world', () => {
  const w = wantedScripts({ sites: { youtube: { on: true, shown: [] } } });
  const ads = w.find((s) => s.id === 'youtube-ads');
  assert.equal(ads.world, 'MAIN');
  assert.equal(ads.runAt, 'document_start');
});

test('bringing back Shorts and autoplay, or turning YouTube off, removes them', () => {
  assert.deepEqual(ids({ sites: { youtube: { on: true, shown: ['ads', 'shorts', 'autoplay_next'] } } }), []);
  assert.deepEqual(ids({ sites: { youtube: { on: false, shown: [] } } }), []);
});
