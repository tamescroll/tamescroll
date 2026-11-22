// The rules files as they were when this package was built. The OTA copy
// in storage wins once one has been fetched and verified (ota.js).
import youtubeTxt from '../../rules/youtube.txt';
import redditTxt from '../../rules/reddit.txt';
import youtubeBlur from '../../rules/blur/youtube.css';
import redditBlur from '../../rules/blur/reddit.css';
import engine from '../gen/engine.json';

export const BUNDLED = {
  'youtube.txt': youtubeTxt,
  'reddit.txt': redditTxt,
  'blur/youtube.css': youtubeBlur,
  'blur/reddit.css': redditBlur,
};

export const ENGINE = engine;
