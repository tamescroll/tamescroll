# Chrome Web Store: Tame Scroll extension

Everything needed to list the extension, ready to paste. Nothing has been
submitted: creating the developer account, paying the fee and pressing
Submit are ZV's. The same package also goes to Microsoft Edge Add-ons
unchanged.

## 1. Build the package

```
cd extension
npm ci
node build.mjs --store     # dist/chrome-store and dist/tamescroll-chrome-<version>.zip
node store-check.mjs       # fails on anything a store build must not carry
TS_EXT_DIR=dist/chrome-store node smoke/smoke.mjs   # the browser smoke test, on the store package
```

Upload `extension/dist/tamescroll-chrome-<version>.zip`. Bump `version`
in `extension/package.json` for every new upload: the store refuses a
version it has seen.

What the store build changes against the developer build:

- **No self-update from the PC.** The unpacked build reloads itself when a
  new build lands in its folder (`src/dev-reload.js`). The store build
  swaps that file for `src/dev-reload-store.js`, which does nothing: no
  `build-id.txt`, no `management` call, no `runtime.reload`. Store
  installs are updated by the store.
- **Only sites that have had a live pass.** Pinterest carries
  `notInStore` in `src/sites.js` (only Explore was checked), so the store
  build leaves out its site access and its switch: the listing must not
  offer what nobody has seen work. `store-check.mjs` fails if the package
  reaches a site this listing does not name.
- **The 128px icon has a clear margin** (96px glyph, rounded corners), as
  the store's image guidelines ask.

## 2. Account (ZV's hands)

1. Use a Google account **used only for Tame Scroll**, never the account
   behind Hijri First: the store's repeat-abuse policy can suspend
   "related developer accounts" together.
2. Register at https://chrome.google.com/webstore/devconsole and pay the
   one-time US$5 fee.
3. Account tab: publisher name **Tame Scroll**, contact email
   `tamescroll@proton.me` (verify it).
4. Turn on 2-step verification on the account (the store requires it to
   publish).

## 3. Store listing tab

**Name** (from the package): Tame Scroll

**Summary** (from the package, 98 of 132 characters):
A calmer social media: no algorithmic feeds, no Shorts or Reels, no autoplay, optional blur.

**Category:** Lifestyle, Well-being. (If that category is not offered,
Productivity, Tools.)

**Language:** English

**Description** (rejected 2026-11-25 for "keyword spam" over a bare list of brand names; name each site once, only beside what Tame Scroll does there):

```
Tame Scroll takes the endless scroll out of social media, so you can open a site, do what you came for, and leave.

It hides the parts of a page built to keep you scrolling: algorithmic feeds, Shorts and Reels, autoplay, suggested posts and trending panels. What you came for stays: search, the people and channels you follow, and the posts you open.

WHAT IT DOES
• YouTube: hides the home feed, Shorts, video previews, the Explore menu and search inserts. A short opens as a normal video, and autoplay stops at the end of the video. Ads stay shown unless you switch them off yourself.
• Reddit: hides r/popular, r/all, News and Explore, and posts from communities you have not joined.
• X: hides the For you tab, Explore trends and sidebar suggestions.
• Instagram: hides Explore, Reels and suggested posts from accounts you don't follow.
• TikTok: hides the For You feed, Explore, LIVE and suggested accounts, and stops the endless swipe on an opened video.
• Twitch: hides home recommendations, recommended channels and the Browse menu.
• LinkedIn: hides the news panel and posts from people you don't follow.
• Facebook: hides sign-in pop-ups on public pages when you are signed out.
• Ads are hidden by default on the other sites.
• Sign-in pop-ups are hidden when you are signed out. Real login pages and age checks are always left alone.
• Optional picture blur on each site, in three strengths.

BRING BACK ONLY WHAT YOU WANT
Every hidden part has its own switch, per site, and the page changes as you flip it.

PAIRS WELL WITH HARAMBLUR
For blur that finds people inside videos too, we suggest HaramBlur, a separate free extension by its own developers. Tame Scroll is not affiliated with it.

PRIVATE BY DESIGN
No account, no analytics, no tracking, no server of ours. Your settings stay in your browser. Once a day the extension fetches updated filter rules, a small data file. Privacy policy: https://tamescroll.com/privacy.html

OPEN SOURCE
Code: https://github.com/tamescroll/tamescroll. Ad and tracker filters come from EasyList, EasyPrivacy and the uBlock Origin filter lists.

Tame Scroll is an independent project, not affiliated with or endorsed by any of the sites it works on.
```

**Images** (in this folder, regenerate with `node store/chrome-web-store/shots.mjs`
after `node build.mjs --store`):

| Slot | File | Size |
|---|---|---|
| Store icon | `extension/icons-store/icon-128.png` | 128x128 |
| Screenshots (in order) | `screenshot-1.png` to `screenshot-4.png` | 1280x800 |
| Small promo tile | `promo-small.png` | 440x280 |
| Marquee promo tile (optional) | `promo-marquee.png` | 1400x560 |

The screenshots are the store package's own popup, against offline
fixture pages drawn in grey: no platform logo, thumbnail or person
appears, and no live site was loaded to make them.

**Official URL:** none (needs a verified domain in Search Console; skip).
**Homepage URL:** https://tamescroll.com/
**Support URL:** https://github.com/tamescroll/tamescroll/issues

## 4. Privacy practices tab

**Single purpose:**

```
Tame Scroll makes social media sites less compulsive to use. On the social media sites it serves it hides the page elements designed to keep people scrolling, such as algorithmic feeds, Shorts and Reels, autoplay, suggested posts, ads and sign-in pop-ups, and can blur pictures. Every part can be brought back per site.
```

**Permission justifications:**

`storage`
```
Stores the user's choices: which sites are on, which hidden parts they brought back, picture blur and its strength, and the latest verified copy of the filter rules. Nothing is synced or sent anywhere.
```

`scripting`
```
Registers and unregisters the extension's own bundled page scripts as the user changes settings, for example the script that opens a YouTube short as a normal video runs only while Shorts are hidden, and the YouTube ad script runs only if the user switches YouTube ads off. All scripts are files inside the package; no code is fetched.
```

`alarms`
```
Schedules the once-a-day check for updated filter rules (a data file of CSS selectors, verified by SHA-256 before use).
```

Host permissions (`https://www.youtube.com/*`, `https://m.youtube.com/*`, `https://www.reddit.com/*`, `https://x.com/*`, `https://www.instagram.com/*`, `https://www.facebook.com/*`, `https://www.tiktok.com/*`, `https://www.twitch.tv/*`, `https://www.linkedin.com/*`, plus content scripts on `old.reddit.com` and YouTube embeds):
```
These are the only sites the extension changes. On each it adds a stylesheet that hides the distracting parts the user has not brought back, applies picture blur if the user turned it on, and reports to the popup what was hidden on the page. old.reddit.com is opened on www.reddit.com while Reddit is switched on, because the hiding rules only match the current Reddit layout. Embedded YouTube players on other sites get a stylesheet (inside the player frame only) that hides the end-of-video suggestions. The extension has no access to any other site.
```

**Remote code:** No, I am not using remote code.
```
All JavaScript ships in the package. The daily update fetches only data: CSS selector lists and blur CSS (rules/*.txt, rules/blur/*.css) and a JSON list of switch names (rules/kill.json), each checked against a SHA-256 manifest before use. None of it is executed as code.
```

**Data usage:** tick **none** of the data types. The extension reads page
layout inside the tab to decide what to hide, but nothing is collected,
stored or transmitted. Then tick all three certifications (no selling or
transferring data, no use unrelated to the single purpose, no use for
creditworthiness or lending).

**Privacy policy URL:** https://tamescroll.com/privacy.html (its "The
browser extension" section lands with this pull request; check it is live
before submitting).

## 5. Distribution tab

- **Visibility: Unlisted first.** Anyone with the link can install it, it
  does not appear in search, and it goes through the same review. Switch
  to Public once a few days of real use look right.
- Regions: all. Price: free.

## 6. Test instructions for the reviewer (Account tab, or the box at submit)

```
No account or login is needed. After installing, open https://www.youtube.com: the home feed is hidden and only search remains. Click the toolbar icon to see what was hidden on the page and switch any part back under "Bring back". https://www.reddit.com/r/popular opens the home page instead. Ads are shown on YouTube by default; switch "Ads" off under Bring back on YouTube to hide them.
```

## Policy check (2026-11-23)

What was checked against the Chrome Web Store program policies, and what
it found.

| Policy | Finding |
|---|---|
| Single purpose | One purpose, less compulsive social media, on eight named sites. Ad hiding and sign-in pop-up hiding are disclosed as part of it. |
| Permissions | `storage`, `scripting`, `alarms` and the eight sites only. No `tabs`, no `<all_urls>`, no `management` (`getSelf` needs no permission, and the store build does not call it). `store-check.mjs` fails the build if a new one appears. |
| Remote code (MV3) | All JS ships in the package. The daily update is CSS selectors, blur CSS and a JSON list of names, hash-checked; none is executed. **Fixed:** page bundles carried the ad scriptlets' source as text strings (60 KB, unused there) and now carry only the cosmetic rules; the scriptlets live in `youtube-ads.js` alone. |
| Remote off switch | `rules/kill.json` holds two lists of names from a fixed set (sites whose ad hiding is off, script ids to unregister). It can only turn bundled scripts off, never add one: config, not code. |
| Self-update from the PC | **Fixed:** left out of the store build entirely (see section 1). |
| Ad blocking | Allowed in the store. YouTube's ads start shown, so blocking there is the user's act; disclosed in the description. Filter lists credited with their licences (GPLv3, CC BY-SA, MPL-2.0) in `THIRD-PARTY-NOTICES.txt`. |
| Sign-in pop-ups | Hides only signed-out pop-ups the user did not open, never real login pages or age gates (PR #72 legal review). Worded "hides sign-in pop-ups", never "browse without an account". |
| Deceptive behaviour / misrepresented functionality | Listing claims only what has had a live desktop pass: YouTube, Reddit, X, Instagram and LinkedIn signed in; TikTok, Twitch and Facebook signed out (Facebook claims only its signed-out pop-ups). Pinterest left out of the store build until it has had a full pass. |
| Redirects | Reddit's discovery pages open the home page, a YouTube short opens as a normal video, old.reddit opens on www.reddit, each only while that switch is on, and all disclosed. |
| User data / privacy | No collection, no transmission beyond the rules fetch (IP seen by GitHub). Privacy policy gains an extension section. |
| Obfuscation | Bundles are not minified, as the store asks for readable code. |
| Trademarks | Name and icon are our own; platform names used only descriptively, with a not-affiliated line; no platform logos in images. |
| Spam / keyword stuffing | One listing, no repeated keywords, site names listed once. |

Firefox Add-ons later: `dist/tamescroll-firefox-<version>.zip` is built the
same way. AMO asks for source code when the package is bundled, so upload
a zip of the repo's `extension/`, `rules/` and the two `app/` files it
bundles alongside.
