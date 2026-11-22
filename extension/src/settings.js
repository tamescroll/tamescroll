// The person's choices, in chrome.storage.local under `settings`:
//   { look: 'night'|'paper', blurPx: 8|16|28,
//     sites: { youtube: { on, shown: [...], blur } , ... } }
// Each site is seeded ONCE from the install defaults, like the app: a
// choice already stored is never changed by a later default.

import { SITES, blurPx } from './sites.js';
import { parseSurfaces, defaultShown } from './rules.js';

export function seed(settings, textFor) {
  const s = settings && typeof settings === 'object' ? { ...settings } : {};
  s.look = s.look === 'paper' ? 'paper' : 'night';
  s.blurPx = blurPx(s.blurPx);
  s.sites = { ...(s.sites || {}) };
  for (const site of SITES) {
    if (s.sites[site.id]) continue;
    s.sites[site.id] = {
      on: true,
      shown: defaultShown(site, parseSurfaces(textFor(site.rulesFile))),
      blur: false,
    };
  }
  return s;
}
