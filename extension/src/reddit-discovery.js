// Reddit's discovery pages -- r/popular, r/all, News and Explore -- are
// sent to your home feed, which keeps only communities you joined. Runs
// at document_start in the extension's world while the Discovery feeds
// switch is off. The sidebar links to them are hidden by rules/reddit.txt.

const DISCOVERY = /^\/(r\/(popular|all)|news|explore)(\/|$)/i;

function check() {
  if (DISCOVERY.test(location.pathname)) location.replace('/');
}

check();
// Reddit moves between pages without a reload.
let last = location.pathname;
setInterval(() => {
  if (location.pathname !== last) { last = location.pathname; check(); }
}, 300);
