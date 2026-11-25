// Developer builds only: an unpacked install reloads itself when a new
// build lands in its folder, so testing on ZV's PC never needs the reload
// button on chrome://extensions. build.mjs writes build-id.txt last;
// Chrome serves an unpacked extension's files straight from disk.
//
// `node build.mjs --store` swaps this file for dev-reload-store.js, so
// the package sent to a store holds none of this: no build-id.txt, no
// management call, no self-reload.

const api = globalThis.browser || globalThis.chrome;
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** True for an unpacked (developer) install. */
export async function isDevBuild() {
  try {
    const me = await api.management.getSelf();
    return me.installType === 'development';
  } catch (e) {
    return false;
  }
}

async function onDiskId() {
  const r = await fetch(api.runtime.getURL('build-id.txt'), { cache: 'no-store' });
  return r.ok ? (await r.text()).trim() : '';
}

/** Reloads the extension if a newer build is on disk. */
export async function checkForNewBuild() {
  if (!(await isDevBuild())) return;
  try {
    const id = await onDiskId();
    if (id && id !== BUILD_ID) api.runtime.reload();
  } catch (e) {} // mid-build: the folder is being rewritten
}

/** Background: look for a new build every 30 seconds. */
export function watchBuilds() {
  isDevBuild().then((dev) => { if (dev) api.alarms.create('dev-update', { periodInMinutes: 0.5 }); });
}

/** Popup: look once, asking the background which build is running. */
export async function checkFromPopup() {
  try {
    if (!(await isDevBuild())) return;
    const [{ id }, disk] = await Promise.all([api.runtime.sendMessage({ type: 'build-id' }), onDiskId()]);
    if (disk && id && disk !== id) api.runtime.reload();
  } catch (e) {}
}
