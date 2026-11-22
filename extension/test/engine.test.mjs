import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { youtubeAdsScript, autoplayScript, manifest } from '../build.mjs';
import { SITES } from '../src/sites.js';

const repo = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), 'utf8');
const engine = JSON.parse(read('extension/gen/engine.json'));

test('the compiled YouTube scriptlets include our own ad rules from scriptlets.txt', () => {
  const s = engine.hosts['www.youtube.com'].script;
  assert.ok(s.includes('trustedSetRequestField("youtubei/v1/player"'));
  assert.ok(s.includes('trustedPruneWindowJson("ytInitialPlayerResponse", "streamingData"'));
  // m.youtube must NOT drop streamingData (scriptlets.txt explains why).
  assert.ok(!/trustedPruneWindowJson\("ytInitialPlayerResponse", "streamingData"/.test(engine.hosts['m.youtube.com'].script));
});

test('the generated ad script parses and only runs on its own host', () => {
  const code = youtubeAdsScript(engine);
  new vm.Script(code); // throws on a syntax error
  const ctx = { location: { hostname: 'www.reddit.com' }, window: {} };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  assert.equal(ctx.window.__TS_EXT_ADS__, 1);
  assert.equal(typeof ctx.trustedSetRequestField, 'undefined');
});

test('the autoplay script turns on autoplay only', () => {
  const code = autoplayScript(read('app/src-tauri/kid-controls.js'));
  assert.ok(code.includes('var KID = {"swipeOff":false,"lock":false,"autoplayOff":true};'));
  assert.throws(() => autoplayScript('no token here'));
});

test('manifests ask for the hosts we serve and nothing broader', () => {
  for (const target of ['chrome', 'firefox']) {
    const m = manifest(target);
    assert.equal(m.manifest_version, 3);
    assert.deepEqual(m.permissions.sort(), ['alarms', 'scripting', 'storage']);
    const allowed = new Set(SITES.flatMap((s) => s.hosts));
    for (const h of m.host_permissions) {
      const host = h.match(/^https:\/\/([^/]+)\/\*$/)[1];
      assert.ok(allowed.has(host), h);
    }
    assert.ok(!JSON.stringify(m).includes('<all_urls>'));
  }
  assert.ok(manifest('firefox').browser_specific_settings.gecko.id);
  assert.equal(manifest('chrome').background.service_worker, 'background.js');
});

test('the engine was compiled for every host a site serves', () => {
  for (const site of SITES) for (const h of site.hosts) assert.ok(engine.hosts[h], `gen/engine.json has no ${h}: rerun node build.mjs --compile`);
});
