import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SITES } from '../src/sites.js';
import { parseSurfaces, defaultShown } from '../src/rules.js';
import { presetsFor, applyPreset, currentPreset, siteSummary } from '../src/presets.js';

const surfacesOf = (site) => parseSurfaces(readFileSync(new URL(`../../rules/${site.rulesFile}`, import.meta.url), 'utf8'));
const yt = SITES.find((s) => s.id === 'youtube');
const rd = SITES.find((s) => s.id === 'reddit');

test('a fresh YouTube install reads as Balanced, Reddit as Calm', () => {
  assert.equal(currentPreset(yt, surfacesOf(yt), { on: true, shown: defaultShown(yt, surfacesOf(yt)), blur: false }), 'balanced');
  assert.equal(currentPreset(rd, surfacesOf(rd), { on: true, shown: defaultShown(rd, surfacesOf(rd)), blur: false }), 'calm');
});

test('every preset round-trips to itself on every site', () => {
  for (const site of SITES) {
    const sf = surfacesOf(site);
    for (const p of presetsFor(site, sf)) {
      const prefs = applyPreset(site, sf, { on: true, shown: [], blur: false }, p.id);
      assert.equal(currentPreset(site, sf, prefs), p.id, `${site.id} ${p.id}`);
    }
  }
});

test('a choice never touches the Ads switch', () => {
  const sf = surfacesOf(yt);
  for (const id of ['calm', 'balanced', 'blur']) {
    assert.ok(applyPreset(yt, sf, { on: true, shown: ['ads'], blur: false }, id).shown.includes('ads'));
    assert.ok(!applyPreset(yt, sf, { on: true, shown: [], blur: false }, id).shown.includes('ads'));
  }
});

test('Balanced is offered only where it differs from Calm', () => {
  assert.deepEqual(presetsFor(rd, surfacesOf(rd)).map((p) => p.id), ['calm', 'blur']);
  assert.deepEqual(presetsFor(yt, surfacesOf(yt)).map((p) => p.id), ['calm', 'balanced', 'blur']);
});

test('paused and custom read as such', () => {
  const sf = surfacesOf(yt);
  assert.equal(currentPreset(yt, sf, { on: false, shown: [], blur: false }), 'off');
  assert.equal(currentPreset(yt, sf, { on: true, shown: ['shorts'], blur: false }), 'custom');
  assert.equal(siteSummary(yt, sf, { on: true, shown: ['shorts'], blur: false }), '1 part brought back');
  assert.equal(siteSummary(yt, sf, { on: true, shown: [], blur: false }), 'Everything tamed');
});
