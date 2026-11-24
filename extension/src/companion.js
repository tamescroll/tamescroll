// HaramBlur, a separate free extension by its own developers, is Tame
// Scroll's suggested companion for blur inside videos (ZV, 2026-11-24:
// "Harambler is doing a great job and I want to promote it"). Tame
// Scroll only links to its store pages; nothing of it is bundled or
// copied (it is AGPL-3.0, see CLAUDE.md), and Tame Scroll is not
// affiliated with it. Links from its own README
// (github.com/alganzory/HaramBlur), checked 2026-11-24.

export const HARAMBLUR = {
  name: 'HaramBlur',
  chrome: 'https://chromewebstore.google.com/detail/pbcoegikffnadpahojjhgdladmmddeji',
  firefox: 'https://addons.mozilla.org/firefox/addon/haramblur/',
};

/**
 * HaramBlur's store page for this browser, or null where it has none
 * (Safari). Edge, Brave and other Chromium browsers install from the
 * Chrome Web Store.
 */
export function companionUrl(ua) {
  const u = String(ua || '');
  if (/Firefox\//.test(u)) return HARAMBLUR.firefox;
  if (/Chrome\/|Chromium\/|Edg\//.test(u)) return HARAMBLUR.chrome;
  return null;
}
