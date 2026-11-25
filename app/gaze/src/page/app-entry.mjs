// The app's page code for a tamed site (#76), built into
// app/src-tauri/page-scripts.js by app/gaze/build/build.js and embedded in
// the binary (CODE MAY NEVER TRAVEL OVER OTA). lib.rs page_scripts_script
// sets globalThis.__TS_PAGE_CFG__ just before it:
//   run:      ids of the shared page scripts to start on this page;
//   surfaces: what hidden-status.mjs counts for the shield chip.
// Both are data lib.rs produced from the user's settings and the rules.

import { start as loginNags } from './login-nags.mjs';
import { start as instagramSuggested } from './instagram-suggested.mjs';
import { start as linkedinFeed } from './linkedin-feed.mjs';
import { start as redditDiscovery } from './reddit-discovery.mjs';
import { toNewReddit } from './old-reddit.mjs';
import { startStatus } from './hidden-status.mjs';

const SCRIPTS = {
  'login-nags': loginNags,
  'instagram-suggested': instagramSuggested,
  'linkedin-feed': linkedinFeed,
  'reddit-discovery': redditDiscovery,
  'old-reddit': toNewReddit,
};

const cfg = globalThis.__TS_PAGE_CFG__ || {};
try {
  delete globalThis.__TS_PAGE_CFG__;
} catch (e) {
  globalThis.__TS_PAGE_CFG__ = undefined;
}

for (const id of Array.isArray(cfg.run) ? cfg.run : []) {
  const run = Object.prototype.hasOwnProperty.call(SCRIPTS, id) ? SCRIPTS[id] : null;
  if (!run) continue;
  try {
    run();
  } catch (e) {
    // One script failing must not stop the others.
  }
}

if (Array.isArray(cfg.surfaces) && cfg.surfaces.length) {
  startStatus(cfg.surfaces, (status) => {
    const bridge = globalThis.TsHidden;
    if (bridge && typeof bridge.report === 'function') bridge.report(JSON.stringify(status));
  });
}
