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

test('Smart blur runs only for Women or Men, with the runtime before its starter', async () => {
  const { gazeGender } = await import('../src/gaze-settings.js');
  const gaze = (smart) => wantedScripts({ sites: { youtube: { on: true, shown: [], smart } } }).find((s) => s.id === 'youtube-gaze');
  assert.equal(gaze(undefined), undefined, 'a setting from before Smart blur is off');
  assert.equal(gaze('off'), undefined);
  assert.equal(gaze('nonsense'), undefined);
  for (const c of ['women', 'men']) {
    const g = gaze(c);
    assert.deepEqual(g.js, ['gaze.js', 'gaze-prelude.js']);
    assert.equal(g.world, 'ISOLATED', 'the page must never see the runtime');
  }
  assert.equal(wantedScripts({ sites: { youtube: { on: false, shown: [], smart: 'women' } } }).some((s) => s.id === 'youtube-gaze'), false, 'YouTube paused runs nothing');
  // "women" is Smart for a man, as in the app.
  assert.equal(gazeGender({ smart: 'women' }), 'man');
  assert.equal(gazeGender({ smart: 'men' }), 'woman');
  assert.equal(gazeGender({}), null);
});
