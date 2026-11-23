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
    label: 'Reddit',
    root: 'reddit.com',
    hosts: ['www.reddit.com'],
    matches: ['https://www.reddit.com/*'],
    rulesFile: 'reddit.txt',
    blurFile: 'blur/reddit.css',
    adsDefaultShown: false,
    pageSurfaces: [
      { id: 'login_nags', label: 'Sign-in pop-ups', defaultShown: false },
    ],
    scripts: [
      {
        // r/popular, r/all, News and Explore open your home feed instead.
        // Follows the rules file's Discovery feeds switch.
        id: 'reddit-discovery',
        file: 'reddit-discovery.js',
        world: 'ISOLATED',
        when: (shown) => !shown.includes('discovery'),
      },
      {
        // Signed-out "log in to see more" pop-ups: overlay hidden, scroll back.
        id: 'reddit-login-nags',
        file: 'login-nags.js',
        world: 'ISOLATED',
        when: (shown) => !shown.includes('login_nags'),
      },
    ],
  },
  // Phase 2. These rules were checked on the mobile sites the app loads
  // (x.txt on desktop in August; instagram.txt partly, facebook.txt and
  // tiktok.txt not at all), so each needs a live desktop pass before a
  // store listing. A selector that no longer matches hides nothing; it
  // never breaks the page.
  {
    id: 'x',
    label: 'X',
    root: 'x.com',
    hosts: ['x.com'],
    matches: ['https://x.com/*'],
    rulesFile: 'x.txt',
    blurFile: 'blur/x.css',
    adsDefaultShown: false,
    pageSurfaces: [
      { id: 'login_nags', label: 'Sign-in pop-ups', defaultShown: false },
    ],
    scripts: [
      {
        // Signed-out "log in to see more" pop-ups: overlay hidden, scroll back.
        id: 'x-login-nags',
        file: 'login-nags.js',
        world: 'ISOLATED',
        when: (shown) => !shown.includes('login_nags'),
      },
    ],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    root: 'instagram.com',
    hosts: ['www.instagram.com'],
    matches: ['https://www.instagram.com/*'],
    rulesFile: 'instagram.txt',
    blurFile: 'blur/instagram.css',
    adsDefaultShown: false,
    pageSurfaces: [
      { id: 'login_nags', label: 'Sign-in pop-ups', defaultShown: false },
    ],
    scripts: [
      {
        // Signed-out "log in to see more" pop-ups: overlay hidden, scroll back.
        id: 'instagram-login-nags',
        file: 'login-nags.js',
        world: 'ISOLATED',
        when: (shown) => !shown.includes('login_nags'),
      },
    ],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    root: 'facebook.com',
    hosts: ['www.facebook.com'],
    matches: ['https://www.facebook.com/*'],
    rulesFile: 'facebook.txt',
    blurFile: 'blur/facebook.css',
    adsDefaultShown: false,
    pageSurfaces: [
      { id: 'login_nags', label: 'Sign-in pop-ups', defaultShown: false },
    ],
    scripts: [
      {
        // Signed-out "log in to see more" pop-ups: overlay hidden, scroll back.
        id: 'facebook-login-nags',
        file: 'login-nags.js',
        world: 'ISOLATED',
        when: (shown) => !shown.includes('login_nags'),
      },
    ],
  },
  {
    id: 'tiktok',
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
  out.push('kill.json');
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
