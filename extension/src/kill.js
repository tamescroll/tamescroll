// Remote off switches, read from rules/kill.json: the same daily, hashed,
// DATA-ONLY update as the rules (ota.js). Two lists of names, nothing
// else: a site whose ad blocking is switched off everywhere (its Ads
// switch then counts as Shown), and page-code script ids to unregister.
// Anything malformed reads as "nothing switched off".

const NONE = Object.freeze({ adsBlockingOff: [], disabledScripts: [] });

function names(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[a-z0-9_-]{1,40}$/.test(x)) : [];
}

export function parseKill(text) {
  try {
    const k = JSON.parse(String(text || ''));
    if (!k || typeof k !== 'object') return NONE;
    return { adsBlockingOff: names(k.adsBlockingOff), disabledScripts: names(k.disabledScripts) };
  } catch (e) {
    return NONE;
  }
}

/** A site's prefs with the remote switches applied. */
export function effectivePrefs(site, prefs, kill) {
  if (!prefs || !kill || !kill.adsBlockingOff.includes(site.id)) return prefs;
  const shown = prefs.shown || [];
  return shown.includes('ads') ? prefs : { ...prefs, shown: [...shown, 'ads'] };
}
