// The person's choices, in chrome.storage.local under `settings`:
//   { look: 'night'|'paper', blurPx: 8|16|28,
//     sites: { youtube: { on, shown: [...], blur } , ... } }
// Each site is seeded ONCE from the install defaults, like the app: a
// choice already stored is never changed by a later default.

import { SITES, blurPx } from './sites.js';
import { parseSurfaces, defaultShown } from './rules.js';

// Switches added after launch that ship SHOWN. A site seeded before one
// existed gets it added to `shown` once, so an update never starts
// hiding something nobody chose to hide. `added` records what was done.
const ADDED_SHOWN = { youtube: ['comments'] };

export function seed(settings, textFor) {
  const s = settings && typeof settings === 'object' ? { ...settings } : {};
  s.look = s.look === 'paper' ? 'paper' : 'night';
  s.blurPx = blurPx(s.blurPx);
  s.sites = { ...(s.sites || {}) };
  for (const site of SITES) {
    const later = ADDED_SHOWN[site.id] || [];
    const have = s.sites[site.id];
    if (have) {
      const added = Array.isArray(have.added) ? have.added : [];
      const missing = later.filter((id) => !added.includes(id));
      if (missing.length) {
        s.sites[site.id] = { ...have, shown: [...new Set([...(have.shown || []), ...missing])], added: [...added, ...missing] };
      }
      continue;
    }
    s.sites[site.id] = {
      on: true,
      shown: defaultShown(site, parseSurfaces(textFor(site.rulesFile))),
      blur: false,
      added: [...later],
    };
  }
  return s;
}
