// Which page-code scripts the settings call for. Pure, so it is tested.
import { SITES } from './sites.js';

/** The registrations the settings call for: [{ id, js, matches, world, runAt }]. */
export function wantedScripts(settings) {
  const out = [];
  for (const site of SITES) {
    const prefs = (settings.sites || {})[site.id];
    if (!prefs || prefs.on === false) continue;
    const shown = prefs.shown || [];
    for (const s of site.scripts) {
      if (!s.when(shown)) continue;
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
