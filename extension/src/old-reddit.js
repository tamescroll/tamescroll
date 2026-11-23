// old.reddit.com has none of the markup Tame Scroll's Reddit rules hide,
// so it would show every feed untouched. While Reddit is switched on in
// Tame Scroll, it opens the same page on www.reddit.com instead.
chrome.storage.local.get('settings').then((st) => {
  const reddit = st.settings && st.settings.sites && st.settings.sites.reddit;
  if (reddit && reddit.on === false) return;
  location.replace('https://www.reddit.com' + location.pathname + location.search + location.hash);
});
