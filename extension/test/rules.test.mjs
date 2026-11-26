import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSurfaces, surfacesCss, toggles, defaultShown, pageCss, CONSENT_CSS, engineCss } from '../src/rules.js';
import { SITES, siteForHost, siteById } from '../src/sites.js';

const repo = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), 'utf8');
const engine = JSON.parse(read('extension/gen/engine.json'));

// The Rust side's every_rule_we_own_belongs_to_a_surface, over the same
// files: a rule line before any marker is dropped, so it must not exist.
for (const site of SITES) {
  test(`${site.rulesFile}: every rule reaches a surface`, () => {
    const text = read('rules/' + site.rulesFile);
    let seenMarker = false;
    let declared = 0;
    const orphans = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('!surface:')) { seenMarker = true; continue; }
      if (!line || line.startsWith('!') || !line.includes('##')) continue;
      if (!seenMarker) orphans.push(line);
      declared++;
    }
    assert.deepEqual(orphans, []);
    const parsed = parseSurfaces(text).reduce((n, s) => n + s.rules.length, 0);
    assert.equal(parsed, declared);
    assert.ok(declared > 0, 'an empty rules file means the parser read nothing');
  });
}

test('YouTube toggles: Ads last and shown by default, autoplay listed, always-on surfaces absent', () => {
  const yt = siteById('youtube');
  const t = toggles(yt, parseSurfaces(read('rules/youtube.txt')));
  assert.equal(t[t.length - 1].id, 'ads');
  assert.equal(t[t.length - 1].defaultShown, true);
  assert.ok(t.some((x) => x.id === 'autoplay_next'));
  assert.ok(t.some((x) => x.id === 'shorts'));
  assert.ok(!t.some((x) => x.id === 'mobile_nags' || x.id === 'promoted'));
  // The app's install defaults: watch recs and chips shown, ads shown, the rest hidden;
  // plus the extension-only Comments switch, which ships shown.
  assert.deepEqual(defaultShown(yt, parseSurfaces(read('rules/youtube.txt'))).sort(), ['ads', 'comments', 'home_chips', 'watch_recs']);
});

test('Reddit ads start hidden', () => {
  const rd = siteById('reddit');
  assert.deepEqual(defaultShown(rd, parseSurfaces(read('rules/reddit.txt'))), []);
});

test('a hidden surface emits its selectors, a shown one does not', () => {
  const surfaces = parseSurfaces('!surface: a A\nx.com##.one\n!surface: b B\nx.com##.two\n');
  assert.equal(surfacesCss(surfaces, []), '.one { display: none !important; }\n.two { display: none !important; }\n');
  assert.equal(surfacesCss(surfaces, ['a']), '.two { display: none !important; }\n');
});

test('ads and promoted follow the Ads switch; nags never come back', () => {
  const s = parseSurfaces('!surface: ads Ads\nx##.ad\n!surface: promoted P\nx##.pr\n!surface: mobile_nags N\nx##.nag\n');
  assert.equal(surfacesCss(s, ['ads']), '.nag { display: none !important; }\n');
  assert.equal(surfacesCss(s, ['mobile_nags']), '.ad { display: none !important; }\n.pr { display: none !important; }\n.nag { display: none !important; }\n');
});

test('home feed is hidden on desktop YouTube by default', () => {
  const yt = siteById('youtube');
  const css = pageCss({
    site: yt, host: 'www.youtube.com', engine,
    rulesText: read('rules/youtube.txt'), blurText: read('rules/blur/youtube.css'),
    prefs: { on: true, shown: ['ads', 'watch_recs', 'home_chips'], blur: false }, blurStrength: 16,
  });
  assert.ok(css.includes('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer { display: none !important; }'));
  assert.ok(css.includes('ytd-reel-shelf-renderer { display: none !important; }'));
  assert.ok(!css.includes('--ts-blur'), 'blur is off');
  // Ads shown: none of the engine's vendor selectors ship.
  for (const sel of engine.hosts['www.youtube.com'].hide) assert.ok(!css.includes(sel + ' {'), sel);
});

test('blur on appends the strength and the site sheet; site off emits nothing', () => {
  const rd = siteById('reddit');
  const base = { site: rd, host: 'www.reddit.com', engine, rulesText: read('rules/reddit.txt'), blurText: read('rules/blur/reddit.css'), blurStrength: 28 };
  const css = pageCss({ ...base, prefs: { on: true, shown: [], blur: true } });
  assert.ok(css.includes(':root { --ts-blur: 28px; --ts-blur-strong: 42px; }'));
  assert.ok(css.endsWith(read('rules/blur/reddit.css')));
  assert.ok(css.includes(engineCss(engine, rd, 'www.reddit.com')), 'ads hidden: vendor cosmetics ship');
  assert.equal(pageCss({ ...base, prefs: { on: false, shown: [], blur: true } }), '');
});

test('CONSENT_CSS is the same text as lib.rs consent_css', () => {
  const lib = read('app/src-tauri/src/lib.rs');
  const start = lib.indexOf('fn consent_css() -> &\'static str {');
  assert.ok(start > 0, 'consent_css moved; update this test and rules.js together');
  const body = lib.slice(start).split('\n"\n}')[0];
  const literal = body.slice(body.indexOf('"') + 1) + '\n';
  assert.equal(CONSENT_CSS, literal);
});

test('siteForHost matches roots and subdomains only', () => {
  assert.equal(siteForHost('www.youtube.com').id, 'youtube');
  assert.equal(siteForHost('m.youtube.com:443').id, 'youtube');
  assert.equal(siteForHost('reddit.com').id, 'reddit');
  assert.equal(siteForHost('notyoutube.com'), null);
  assert.equal(siteForHost('example.com'), null);
});
