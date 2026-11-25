// GLOBAL PRIVACY CONTROL (#81): navigator.globalPrivacyControl = true on
// every site, the signal that says "do not sell or share my data". It is
// the page half of the Ask sites not to sell my data switch; MainActivity
// adds the Sec-GPC: 1 header on top-level loads it starts itself.
//
// Shipped inside the app (app/src-tauri/gpc-page.js, built by
// gaze/build/build.js, embedded in lib.rs), never over the air: it runs
// inside every page, so it is code, and code never travels OTA.

/**
 * Defines the property on Navigator's prototype, the place the spec puts
 * it, as a read-only getter. `isOn` is asked once, when the document
 * starts: the switch is read from the phone, never from the page.
 * Returns whether it installed.
 */
export function installGpc(win, isOn) {
  try {
    if (!isOn()) return false;
    const nav = win && win.navigator;
    if (!nav) return false;
    Object.defineProperty(Object.getPrototypeOf(nav), 'globalPrivacyControl', {
      get() {
        return true;
      },
      set: undefined,
      configurable: true,
      enumerable: true,
    });
    return true;
  } catch (e) {
    return false;
  }
}
