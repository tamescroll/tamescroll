# Tame Scroll browser extension

Tame Scroll for desktop browsers: one Manifest V3 extension for Chrome and
Edge, with a Firefox build from the same code. ZV asked for it on
2026-11-21, which reverses the earlier "browser extension stays dead"
ruling.

It serves **YouTube, Reddit, X, Instagram, Facebook and TikTok**, the same
six platforms as the app. YouTube and Reddit were phase 1. The other four
use the app's rules as they are, and those were checked on the mobile sites
the app loads (x.txt on desktop in August, instagram.txt partly,
facebook.txt and tiktok.txt not at all). Each needs a live desktop pass
before a store listing. A selector that no longer matches hides nothing;
it never breaks the page.

## What it does

| | YouTube | Reddit |
|---|---|---|
| Algorithmic feeds hidden | Home feed, shelves, chips, previews, search inserts | r/popular, r/all |
| Shorts | Hidden, and a short opens as a normal video | n/a |
| Autoplay next video | Stopped just before the end | n/a |
| Ads switch | Starts **shown**, like the app | Starts hidden |
| Blur images (Stage A) | Search, subscriptions, channels | Feeds |
| Bring back | Every surface, one by one | Every surface |
| Look | Night or Paper | |

X, Instagram, Facebook and TikTok get their rules files' surfaces (For you
tab, Explore, Reels, Suggested posts, People you may know, For You feed and
so on), each with a Bring back toggle, the Ads switch (starts hidden) and
Stage A blur.

## Browsers

| Browser | Build | Status |
|---|---|---|
| Chrome | `dist/chrome` | Smoke-tested (offline fixtures) |
| Edge | `dist/chrome`, unchanged | Same Chromium engine and store format |
| Firefox 128+ | `dist/firefox` | `web-ext lint`: 0 errors, 0 warnings |
| Safari (Mac, iPhone) | `dist/safari` | Packaged by Apple's converter on a GitHub Mac (`.github/workflows/safari.yml`), built unsigned. A commit with `[safari-testflight]` signs it with the iPhone app's existing key and uploads to TestFlight |

## Where each piece comes from

Nothing here is a second copy of the app's protection logic:

- **Surfaces** are read from `rules/youtube.txt` and `rules/reddit.txt`,
  the same files the app reads. `src/rules.js` parses them the way
  `rules.rs` does, and `test/rules.test.mjs` runs the same
  every-rule-reaches-a-surface check.
- **Ad cosmetics and scriptlets** come from `gen/engine.json`, which
  `compile/` writes with adblock-rust over the app's own lists, through
  `app/src-tauri/src/engine_inputs.rs`, the file the app's engine is built
  from. CI recompiles it and fails if the committed copy is stale.
- **Shorts redirect** bundles `app/gaze/src/shorts-redirect.mjs`.
- **Autoplay stop** is `app/src-tauri/kid-controls.js` with only its
  autoplay control switched on.
- **Blur** is `rules/blur/*.css`.

## Rules over the air

The background fetches `rules/manifest.json` from the repo once a day and
updates only the rules and blur files, checked against their sha256 like
`ota.rs`. Those are data. Every line of code ships inside the package:
Manifest V3 forbids remote code, and so does this repo.

An OTA copy fetched under an older extension version is ignored, so a new
package's built-in rules are never shadowed by stale ones.

## Build and test

```
cd extension
npm ci
npm test                 # unit tests
node build.mjs           # dist/chrome and dist/firefox
node build.mjs --compile # also regenerate gen/engine.json (needs cargo)
node smoke/smoke.mjs     # offline browser smoke test (Playwright)
```

After a change to `rules/vendor/*`, `rules/scriptlets.txt` or a scriptlet,
run `node build.mjs --compile` and commit `gen/engine.json`.

## Try it in Chrome

1. `node build.mjs`
2. Open `chrome://extensions`, turn on Developer mode.
3. Load unpacked, and pick `extension/dist/chrome`.

Firefox: `about:debugging`, This Firefox, Load Temporary Add-on, and pick
`extension/dist/firefox/manifest.json`. Firefox treats site access as
optional in Manifest V3, so allow it for YouTube and Reddit from the
extension's menu.

## Publishing (not done yet)

- Publish from a **Google account used only for Tame Scroll**, never the
  account behind Hijri First. The Chrome Web Store's repeat-abuse policy
  can suspend "related developer accounts".
- The name and icon are our own glyph, never a platform's logo.
- The listing declares no data collection; `web/privacy.html` needs an
  extension section first.
