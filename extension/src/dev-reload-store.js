// The store build's stand-in for dev-reload.js: a store install never
// reloads itself and never reads its own folder. Updates come from the
// store; filter rules come from the daily data-only update (ota.js).
export const BUILD_ID = 'store';
export async function isDevBuild() { return false; }
export async function checkForNewBuild() {}
export function watchBuilds() {}
export async function checkFromPopup() {}
