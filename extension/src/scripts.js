// Which page-code scripts the settings call for. Pure, so it is tested.
import { SITES } from './sites.js';
import { effectivePrefs } from './kill.js';

/** The registrations the settings call for: [{ id, js, matches, world, runAt }]. */
export function wantedScripts(settings, kill) {
  const out = [];
  for (const site of SITES) {
    const prefs = effectivePrefs(site, (settings.sites || {})[site.id], kill);
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
