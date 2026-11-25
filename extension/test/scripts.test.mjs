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

import { parseKill } from '../src/kill.js';

test('kill.json switches YouTube ad blocking and named scripts off, and nothing else', () => {
  const off = { sites: { youtube: { on: true, shown: [] } } };
  assert.ok(ids(off).includes('youtube-ads'));
  const kill = parseKill(JSON.stringify({ adsBlockingOff: ['youtube'], disabledScripts: ['youtube-shorts'] }));
  const w = wantedScripts(off, kill).map((s) => s.id);
  assert.ok(!w.includes('youtube-ads'), 'ad scriptlets unregistered');
  assert.ok(!w.includes('youtube-shorts'), 'named script unregistered');
  assert.ok(w.includes('youtube-autoplay'), 'everything else stays');
  assert.deepEqual(parseKill('not json'), { adsBlockingOff: [], disabledScripts: [] });
  assert.deepEqual(parseKill('{"adsBlockingOff":["youtube","<script>"]}').adsBlockingOff, ['youtube']);
});

test('HaramBlur links to the store of the browser it is opened in, never on Safari', async () => {
  const { companionUrl, HARAMBLUR } = await import('../src/companion.js');
  assert.equal(companionUrl('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'), HARAMBLUR.chrome);
  assert.equal(companionUrl('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0'), HARAMBLUR.chrome);
  assert.equal(companionUrl('Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0'), HARAMBLUR.firefox);
  assert.equal(companionUrl('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), null);
});
