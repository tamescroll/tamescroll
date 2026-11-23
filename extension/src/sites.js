// The sites the extension serves, and everything per-site that is not a
// rule. Phase 1 was YouTube and Reddit; X, Instagram, Facebook and TikTok
// follow (see extension/README.md for what has been checked live).
//
// `adsDefaultShown` mirrors the app (lib.rs ads_default_shown): YouTube's
// Ads switch starts SHOWN, so blocking is the person's own choice there
// (ZV, 2026-10-27, docs/legal-position.md). Every other site starts Hidden.
//
// `pageSurfaces` are settings that are page code rather than rules, listed
// here and never in rules/*.txt, exactly like the app's kid_surfaces: a
// rules OTA must never hand out a switch that needs code to work.
//
// `scripts` are bundled files the background registers or unregisters as
// settings change. `when(shown)` says whether one should run. Nothing in a
// script's body is ever fetched: MV3 forbids remote code, and the repo's
// own rule is that code never travels over the air.

export const SITES = [
  {
    id: 'youtube',
    // Balanced: what comes back under the Balanced choice in the popup.
    balanced: ['watch_recs', 'home_chips'],
    label: 'YouTube',
    root: 'youtube.com',
    hosts: ['www.youtube.com', 'm.youtube.com'],
    matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
    rulesFile: 'youtube.txt',
    blurFile: 'blur/youtube.css',
    adsDefaultShown: true,
    pageSurfaces: [
      { id: 'autoplay_next', label: 'Autoplay next video', defaultShown: false },
    ],
    scripts: [
      {
        // The engine's ad scriptlets, compiled from the same lists the app
        // uses (gen/engine.json). Page context, before YouTube's own code.
        id: 'youtube-ads',
        file: 'youtube-ads.js',
        world: 'MAIN',
        when: (shown) => !shown.includes('ads'),
      },
      {
        // A short opens as a normal video (app/gaze/src/shorts-redirect.mjs).
        // Page context, because it hooks YouTube's own history calls.
        id: 'youtube-shorts',
        file: 'youtube-shorts.js',
        world: 'MAIN',
        when: (shown) => !shown.includes('shorts'),
      },
      {
        // Stops the watch player just short of its end, so autoplay and
        // the end screen never start (app/src-tauri/kid-controls.js).
        id: 'youtube-autoplay',
        file: 'youtube-autoplay.js',
        world: 'ISOLATED',
        when: (shown) => !shown.includes('autoplay_next'),
      },
    ],
  },
  {
    id: 'reddit',
    balanced: [],
    label: 'Reddit',
    root: 'reddit.com',
    hosts: ['www.reddit.com'],
    matches: ['https://www.reddit.com/*'],
    rulesFile: 'reddit.txt',
    blurFile: 'blur/reddit.css',
    adsDefaultShown: false,
    pageSurfaces: [],
    scripts: [],
  },
  // Phase 2. These rules were checked on the mobile sites the app loads
  // (x.txt on desktop in August; instagram.txt partly, facebook.txt and
  // tiktok.txt not at all), so each needs a live desktop pass before a
  // store listing. A selector that no longer matches hides nothing; it
  // never breaks the page.
  {
    id: 'x',
    balanced: ['sidebar'],
    label: 'X',
    root: 'x.com',
    hosts: ['x.com'],
    matches: ['https://x.com/*'],
    rulesFile: 'x.txt',
    blurFile: 'blur/x.css',
    adsDefaultShown: false,
    pageSurfaces: [],
    scripts: [],
  },
  {
    id: 'instagram',
    balanced: [],
    label: 'Instagram',
    root: 'instagram.com',
    hosts: ['www.instagram.com'],
    matches: ['https://www.instagram.com/*'],
    rulesFile: 'instagram.txt',
    blurFile: 'blur/instagram.css',
    adsDefaultShown: false,
    pageSurfaces: [],
    scripts: [],
  },
  {
    id: 'facebook',
    balanced: ['marketplace'],
    label: 'Facebook',
    root: 'facebook.com',
    hosts: ['www.facebook.com'],
    matches: ['https://www.facebook.com/*'],
    rulesFile: 'facebook.txt',
    blurFile: 'blur/facebook.css',
    adsDefaultShown: false,
    pageSurfaces: [],
    scripts: [],
  },
  {
    id: 'tiktok',
    balanced: ['suggested'],
    label: 'TikTok',
    root: 'tiktok.com',
    hosts: ['www.tiktok.com'],
    matches: ['https://www.tiktok.com/*'],
    rulesFile: 'tiktok.txt',
    blurFile: 'blur/tiktok.css',
    adsDefaultShown: false,
    pageSurfaces: [],
    scripts: [],
  },
];

/** Every page pattern the extension serves, for the manifest. */
export function allMatches() {
  return SITES.flatMap((s) => s.matches);
}

/** The site a page host belongs to: the root itself or any subdomain. */
export function siteForHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  return SITES.find((s) => h === s.root || h.endsWith('.' + s.root)) || null;
}

export function siteById(id) {
  return SITES.find((s) => s.id === id) || null;
}

/** Every rules file the extension reads, for the OTA layer. */
export function rulesFiles() {
  const out = [];
  for (const s of SITES) out.push(s.rulesFile, s.blurFile);
  return out;
}

// Blur strength presets, the same three the app offers (lib.rs
// blur_strength_px). Anything else falls back to Medium.
export const BLUR_PRESETS = [
  { px: 8, label: 'Light' },
  { px: 16, label: 'Medium' },
  { px: 28, label: 'Strong' },
];

export function blurPx(px) {
  return BLUR_PRESETS.some((p) => p.px === px) ? px : 16;
}
