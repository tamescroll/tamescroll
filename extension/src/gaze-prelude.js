// Smart blur on YouTube: the app's own gender-aware blur (app/gaze), run
// as a content script. Registered only while YouTube's "Smart blur" is
// Women or Men (sites.js, scripts.js); gaze.js, which runs just before
// this file in the same world, only defines the boot function.
//
// This hands the runtime the same facts the app's boot script hands it
// (app/src-tauri/src/lib.rs gaze_script_with), read from the person's
// settings, then starts it:
//   - mode "smart" and the declared gender ("women" is Smart for a man);
//   - the blur strength, as the two CSS variables the runtime blurs with;
//   - the phone's own tuning numbers (rules/tuning.json, plus the one
//     desktop difference below), as a STRING the runtime parses,
//     whitelists and clamps (tuning.mjs);
//   - where the models live: inside this package, not on the page's
//     origin (detector.js modelBase);
//   - no inference worker: a content script cannot start one from the
//     package, so the runtime takes its own in-page path, the fallback
//     every app build already has.
import tuningJson from '../../rules/tuning.json';
import { gazeGender } from './gaze-settings.js';

// The phone's numbers, with one difference ZV chose for the extension
// (2026-11-24, "Yes, with an on/off switch"): the watch player's video is
// blurred too, with the Blur on/off switch on the player. On the phone
// that switch is off (PLAYER_VIDEO_BLUR 0, his ruling 2026-10-27, for the
// lag); a desktop has the headroom, and a desktop player starts with the
// blur ON (player-switch.mjs PLAYER_BLUR_START_OFF only applies to phones).
export function desktopTuning() {
  return { ...tuningJson, PLAYER_VIDEO_BLUR: 1 };
}

(function () {
  if (window.__TS_GAZE_STARTED__) return;
  window.__TS_GAZE_STARTED__ = 1;
  chrome.storage.local.get('settings').then((st) => {
    const settings = (st && st.settings) || {};
    const prefs = (settings.sites || {}).youtube || {};
    const gender = gazeGender(prefs);
    if (prefs.on === false || !gender || typeof globalThis.__tsGazeBoot !== 'function') return;
    const px = settings.blurPx === 8 || settings.blurPx === 28 ? settings.blurPx : 16;
    window.__TS_GAZE_HOST = 'extension';
    window.__TS_GAZE_MODE = 'smart';
    window.__TS_GAZE_GENDER = gender;
    window.__TS_GAZE_TUNING__ = JSON.stringify(desktopTuning());
    window.__TS_GAZE_MODEL_BASE = chrome.runtime.getURL('gaze-models/');
    window.__TS_NO_WORKER = 1;
    const root = document.documentElement;
    if (root) {
      root.style.setProperty('--ts-blur', px + 'px');
      root.style.setProperty('--ts-blur-strong', Math.floor((px * 3) / 2) + 'px');
    }
    globalThis.__tsGazeBoot();
  }, () => {});
})();
