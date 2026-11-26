// Which page-code scripts the settings call for. Pure, so it is tested.
import { SITES } from './sites.js';
import { effectivePrefs } from './kill.js';
import { livePrefs } from './break.js';

/** The registrations the settings call for: [{ id, js, matches, world, runAt }]. */
export function wantedScripts(settings, kill, now = Date.now()) {
  const out = [];
  for (const site of SITES) {
    const prefs = effectivePrefs(site, livePrefs(settings, site.id, now), kill);
    if (!prefs || prefs.on === false) continue;
    const shown = prefs.shown || [];
    for (const s of site.scripts) {
      if (!s.when(shown)) continue;
      if (kill && kill.disabledScripts.includes(s.id)) continue;
      out.push({
        id: s.id,
        js: [s.file],
        matches: site.matches,
        world: s.world,
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true,
      });
    }
  }
  return out;
}
