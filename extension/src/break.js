// "Take a break": every site shows everything until settings.breakUntil
// (a timestamp), then Tame Scroll switches itself back on. Pure, so it is
// tested; the background clears the field when the break ends.

export const BREAK_MINUTES = 15;

export function onBreak(settings, now = Date.now()) {
  return !!settings && typeof settings.breakUntil === 'number' && settings.breakUntil > now;
}

/** A site's stored prefs, read as paused while a break is on. */
export function livePrefs(settings, siteId, now = Date.now()) {
  const prefs = ((settings || {}).sites || {})[siteId];
  if (!prefs || !onBreak(settings, now)) return prefs;
  return { ...prefs, on: false };
}
