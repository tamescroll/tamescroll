// The popup's "How calm should it be?" choices, the app's ideas-round
// sheet (app-polish/ideas, 2026-11-21): Calm, Balanced, Just blur, plus a
// custom mix and Paused. Pure functions over a site's prefs, so tested.
//
// A choice never touches the Ads switch: on YouTube ads start shown and
// blocking them is the person's own choice (docs/legal-position.md).

import { toggles } from './rules.js';

function partIds(site, surfaces) {
  return toggles(site, surfaces).map((t) => t.id).filter((id) => id !== 'ads');
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** The choices a site offers; Balanced only where it differs from Calm. */
export function presetsFor(site, surfaces) {
  const ids = partIds(site, surfaces);
  const out = [{
    id: 'calm', label: 'Calm',
    body: 'Feeds, short videos and suggestions hidden. Search and what you follow stay.',
  }];
  if ((site.balanced || []).some((id) => ids.includes(id))) {
    out.push({
      id: 'balanced', label: 'Balanced',
      body: 'Suggestions beside what you open come back. Feeds and short videos stay hidden.',
    });
  }
  out.push({ id: 'blur', label: 'Just blur', body: 'The site as it is, with pictures blurred.' });
  return out;
}

/** Applies a choice to one site's prefs and returns the new prefs. */
export function applyPreset(site, surfaces, prefs, preset) {
  const ids = partIds(site, surfaces);
  const keepAds = (prefs.shown || []).includes('ads');
  let shown;
  let blur = !!prefs.blur;
  if (preset === 'calm') shown = [];
  else if (preset === 'balanced') shown = (site.balanced || []).filter((id) => ids.includes(id));
  else if (preset === 'blur') { shown = ids.slice(); blur = true; }
  else throw new Error('unknown preset ' + preset);
  if (keepAds) shown.push('ads');
  return { ...prefs, on: true, shown, blur };
}

/** Which choice the prefs match: off, calm, balanced, blur or custom. */
export function currentPreset(site, surfaces, prefs) {
  if (!prefs || prefs.on === false) return 'off';
  const ids = partIds(site, surfaces);
  const back = (prefs.shown || []).filter((id) => id !== 'ads' && ids.includes(id));
  if (prefs.blur && sameSet(back, ids)) return 'blur';
  if (back.length === 0) return 'calm';
  const bal = (site.balanced || []).filter((id) => ids.includes(id));
  if (bal.length && sameSet(back, bal)) return 'balanced';
  return 'custom';
}

/** The plain summary under a site's name, as the app's Sites list words it. */
export function siteSummary(site, surfaces, prefs) {
  const p = currentPreset(site, surfaces, prefs);
  if (p === 'off') return 'Paused';
  if (p === 'calm') return 'Everything tamed';
  if (p === 'balanced') return 'Balanced';
  if (p === 'blur') return 'Just blur';
  const ids = partIds(site, surfaces);
  const back = (prefs.shown || []).filter((id) => ids.includes(id)).length;
  return back === 1 ? '1 part brought back' : `${back} parts brought back`;
}
