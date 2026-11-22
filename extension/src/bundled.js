// The rules files as they were when this package was built. The OTA copy
// in storage wins once one has been fetched and verified (ota.js).
import youtubeTxt from '../../rules/youtube.txt';
import redditTxt from '../../rules/reddit.txt';
import xTxt from '../../rules/x.txt';
import instagramTxt from '../../rules/instagram.txt';
import facebookTxt from '../../rules/facebook.txt';
import tiktokTxt from '../../rules/tiktok.txt';
import youtubeBlur from '../../rules/blur/youtube.css';
import redditBlur from '../../rules/blur/reddit.css';
import xBlur from '../../rules/blur/x.css';
import instagramBlur from '../../rules/blur/instagram.css';
import facebookBlur from '../../rules/blur/facebook.css';
import tiktokBlur from '../../rules/blur/tiktok.css';
import engine from '../gen/engine.json';

export const BUNDLED = {
  'youtube.txt': youtubeTxt,
  'reddit.txt': redditTxt,
  'x.txt': xTxt,
  'instagram.txt': instagramTxt,
  'facebook.txt': facebookTxt,
  'tiktok.txt': tiktokTxt,
  'blur/youtube.css': youtubeBlur,
  'blur/reddit.css': redditBlur,
  'blur/x.css': xBlur,
  'blur/instagram.css': instagramBlur,
  'blur/facebook.css': facebookBlur,
  'blur/tiktok.css': tiktokBlur,
};

export const ENGINE = engine;
