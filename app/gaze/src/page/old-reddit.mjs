// old.reddit.com has none of the markup Tame Scroll's Reddit rules hide,
// so it would show every feed untouched. While Reddit is tamed, the same
// page opens on www.reddit.com instead. Shared by the extension
// (extension/src/old-reddit.js, which first checks Reddit is switched on)
// and the app (page-scripts.js).

/** Sends this old.reddit.com page to the same path on www.reddit.com. */
export function toNewReddit() {
  if (!/^old\.reddit\.com$/i.test(location.hostname)) return;
  location.replace('https://www.reddit.com' + location.pathname + location.search + location.hash);
}
