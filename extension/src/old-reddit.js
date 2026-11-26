// old.reddit.com opens on www.reddit.com while Reddit is switched on in
// Tame Scroll. The redirect is shared with the app:
// app/gaze/src/page/old-reddit.mjs.
import { toNewReddit } from '../../app/gaze/src/page/old-reddit.mjs';
import { livePrefs } from './break.js';

chrome.storage.local.get('settings').then((st) => {
  const reddit = livePrefs(st.settings, 'reddit');
  if (reddit && reddit.on === false) return;
  toNewReddit();
});
