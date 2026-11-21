#!/usr/bin/env node
// FILTER-IMPACT BENCH: what do the vendored filter lists actually do?
//
// Loads a fixed set of pages in mobile Chromium (Pixel 7 emulation) under
// three arms and records, per load: requests, requests blocked, bytes
// downloaded, load timings, page errors, a content check (did the page
// still give you what you came for) and an ad count.
//
//   off   no filtering at all
//   play  the general lists only (EasyList, EasyPrivacy, uBO filters,
//         quick fixes, unbreak) + generic scriptlets: the Play build
//   full  play + our YouTube-only rules: today's build with Ads blocked
//
// Every arm goes through the same request router, so routing overhead is
// equal across arms. Fresh browser context per load (cold cache: a first
// visit). Arms are interleaved per round so drift hits all arms equally.
//
// The decisions come from spikes/filter-impact/engine, the same
// adblock-rust version and rules/ files as the app. It is NOT the app's
// WebView: Chromium desktop with a phone viewport and UA. Cosmetic CSS
// and scriptlets are applied to the top frame only.
//
//   cd spikes/filter-impact/engine && cargo build --release
//   cd .. && npm i playwright@1.49.1 && npx playwright install chromium
//   node run.mjs [--rounds 3] [--only yt_home,cnn] [--out out]
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { chromium, devices } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const ROUNDS = Number(opt("rounds", 3));
const ONLY = opt("only", "") ? opt("only").split(",") : null;
const OUT = path.resolve(HERE, opt("out", "out"));
const SETTLE_MS = 5000; // after load, for lazy ads and trackers
const LOAD_CAP_MS = 30000;

// ---- pages ----------------------------------------------------------------
// check(): runs in the page, returns {n, ok}: n is a count of the thing you
// came for (results, articles, paragraphs); breakage shows as n falling
// against the `off` arm. ads(): visible ad units by common markers.
const YT_ITEMS = "ytm-video-with-context-renderer, ytm-compact-video-renderer, ytm-rich-item-renderer, ytm-reel-item-renderer";
const YT_ADS = "ytm-promoted-sparkles-web-renderer, ytm-promoted-video-renderer, ad-slot-renderer, ytm-companion-ad-renderer, ytm-display-ad-renderer, ytm-in-feed-ad-layout-renderer, ytm-ad-slot-renderer";
const PAGES = [
  { id: "yt_home", url: "https://m.youtube.com/", items: YT_ITEMS, adSel: YT_ADS },
  { id: "yt_search", url: "https://m.youtube.com/results?search_query=best+running+shoes", items: YT_ITEMS, adSel: YT_ADS },
  { id: "yt_watch", url: "https://m.youtube.com/watch?v=dQw4w9WgXcQ", items: "video", adSel: YT_ADS, video: true },
  { id: "google", url: "https://www.google.com/search?q=best+running+shoes", items: "a h3, [role=heading][aria-level='3']" },
  { id: "bing", url: "https://www.bing.com/search?q=best+running+shoes", items: "li.b_algo, .b_algo h2" },
  { id: "duckduckgo", url: "https://duckduckgo.com/?q=best+running+shoes", items: "article[data-testid=result], [data-testid=result]" },
  { id: "cnn", url: "https://edition.cnn.com/", items: "a[href*='/20'] span, .container__headline" },
  { id: "dailymail", url: "https://www.dailymail.co.uk/home/index.html", items: "h2 a, .linkro-darkred" },
  { id: "ndtv", url: "https://www.ndtv.com/", items: "h2 a, h3 a" },
  { id: "toi", url: "https://timesofindia.indiatimes.com/", items: "a[href*='/articleshow/']" },
  { id: "allrecipes", url: "https://www.allrecipes.com/recipe/16354/easy-meatloaf/", items: ".mm-recipes-structured-ingredients__list-item, li.mntl-sc-block-group--LI" },
  { id: "weather", url: "https://weather.com/", items: "[data-testid=TemperatureValue], span[data-testid]" },
  { id: "imdb", url: "https://m.imdb.com/title/tt0111161/", items: "[data-testid=hero__pageTitle], [data-testid=title-cast-item]" },
  { id: "fandom", url: "https://harrypotter.fandom.com/wiki/Harry_Potter", items: ".mw-parser-output > p" },
  { id: "amazon_in", url: "https://www.amazon.in/s?k=running+shoes", items: "[data-component-type=s-search-result]" },
  { id: "reddit", url: "https://www.reddit.com/r/AskReddit/", items: "shreddit-post, article" },
  { id: "wikipedia", url: "https://en.m.wikipedia.org/wiki/Bread", items: ".mw-parser-output p" },
];
const GENERIC_ADS =
  "iframe[src*='doubleclick'], iframe[src*='googlesyndication'], iframe[id^='google_ads'], ins.adsbygoogle, " +
  "[id^='div-gpt-ad'], [id*='taboola'], [class*='taboola'], [id^='outbrain'], .OUTBRAIN, iframe[src*='amazon-adsystem'], " +
  "[data-google-query-id], [aria-label='Advertisement'], .ad-slot, .adSlot";

// ---- engine processes -----------------------------------------------------
function engineBin() {
  for (const f of ["filter-engine.exe", "filter-engine"]) {
    const p = path.join(HERE, "engine", "target", "release", f);
    if (existsSync(p)) return p;
  }
  throw new Error("build spikes/filter-impact/engine first (cargo build --release)");
}
function startEngine(arm) {
  const child = spawn(engineBin(), [arm, ROOT], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = [];
  let ready;
  const readyP = new Promise((r) => (ready = r));
  rl.on("line", (line) => {
    const v = JSON.parse(line);
    if (v.ready) return ready(v);
    waiting.shift()?.(v);
  });
  const ask = (q) =>
    new Promise((r) => {
      waiting.push(r);
      child.stdin.write(JSON.stringify(q) + "\n");
    });
  return { readyP, ask, kill: () => child.kill() };
}

// Playwright resource types -> adblock-rust request types.
const TYPE = {
  document: "document", stylesheet: "stylesheet", image: "image", media: "media", font: "font",
  script: "script", texttrack: "other", xhr: "xmlhttprequest", fetch: "xmlhttprequest",
  eventsource: "other", websocket: "websocket", manifest: "other", ping: "ping", other: "other",
};

// ---- one load -------------------------------------------------------------
async function loadOnce(browser, page, arm, eng, shotPath) {
  const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "en-US" });
  const stats = { reqs: 0, blocked: 0, bytes: 0, errors: 0, blockedHosts: {}, hosts: new Set() };
  const topHost = new URL(page.url).hostname;
  if (eng) {
    const cos = await eng.ask({ op: "cos", url: page.url });
    stats.cosSelectors = cos.nSel;
    // Top frame only, before any page script (scriptlets must win the race).
    await ctx.addInitScript(
      ({ css, js, host }) => {
        if (window.top !== window || location.hostname !== host) return;
        try { (0, eval)(js); } catch (e) {}
        const put = () => {
          const s = document.createElement("style");
          s.textContent = css;
          (document.head || document.documentElement).appendChild(s);
        };
        if (document.documentElement) put();
        else document.addEventListener("readystatechange", put, { once: true });
      },
      { css: cos.css, js: cos.js, host: topHost },
    );
  }
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const u = req.url();
    if (!/^https?:/.test(u) || !eng) return route.continue();
    const frame = req.frame();
    let src = "";
    try { src = frame.url(); } catch (e) {}
    if (!src || src === "about:blank") src = page.url;
    let type = TYPE[req.resourceType()] || "other";
    if (type === "document" && frame && frame.parentFrame()) type = "sub_frame";
    const { block } = await eng.ask({ op: "net", url: u, src, type });
    if (block) {
      stats.blocked++;
      const h = new URL(u).hostname;
      stats.blockedHosts[h] = (stats.blockedHosts[h] || 0) + 1;
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => {
    stats.reqs++;
    try { stats.hosts.add(new URL(e.request.url).hostname); } catch (x) {}
  });
  cdp.on("Network.loadingFinished", (e) => (stats.bytes += e.encodedDataLength || 0));
  p.on("pageerror", () => stats.errors++);

  const t0 = Date.now();
  let navOk = true;
  try {
    await p.goto(page.url, { waitUntil: "load", timeout: LOAD_CAP_MS });
  } catch (e) {
    navOk = false;
  }
  const loadWall = Date.now() - t0;
  await p.waitForTimeout(page.video ? 12000 : SETTLE_MS);
  const m = await p
    .evaluate(
      ({ items, adSel, generic, video }) => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden";
        };
        const nav = performance.getEntriesByType("navigation")[0] || {};
        let lcp = 0;
        try {
          const e = performance.getEntriesByType("largest-contentful-paint");
          if (e.length) lcp = e[e.length - 1].startTime;
        } catch (x) {}
        const out = {
          dcl: Math.round(nav.domContentLoadedEventEnd || 0),
          load: Math.round(nav.loadEventEnd || 0),
          lcp: Math.round(lcp),
          items: [...document.querySelectorAll(items)].filter(vis).length,
          textLen: (document.body && document.body.innerText.length) || 0,
          ads: [...document.querySelectorAll(adSel ? adSel + ", " + generic : generic)].filter(vis).length,
          title: document.title.slice(0, 60),
        };
        if (video) {
          const v = document.querySelector("video");
          const mp = document.querySelector("#movie_player, .html5-video-player");
          out.videoT = v ? Math.round(v.currentTime * 10) / 10 : -1;
          out.adShowing = mp ? /ad-showing|ad-interrupting/.test(mp.className) : null;
        }
        return out;
      },
      { items: page.items, adSel: page.adSel || "", generic: GENERIC_ADS, video: !!page.video },
    )
    .catch((e) => ({ evalError: String(e).slice(0, 120) }));
  if (shotPath) await p.screenshot({ path: shotPath }).catch(() => {});
  await ctx.close();
  return {
    navOk, loadWall, ...m,
    reqs: stats.reqs, blocked: stats.blocked, kb: Math.round(stats.bytes / 1024),
    errors: stats.errors, hosts: stats.hosts.size, blockedHosts: stats.blockedHosts,
    cosSelectors: stats.cosSelectors || 0,
  };
}

// ---- main -----------------------------------------------------------------
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number" && x >= 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const engines = { play: startEngine("play"), full: startEngine("full") };
  const built = { play: await engines.play.readyP, full: await engines.full.readyP };
  const browser = await chromium.launch();
  const pages = PAGES.filter((p) => !ONLY || ONLY.includes(p.id));
  const ARMS = ["off", "play", "full"];
  const rows = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const page of pages) {
      // Rotate the arm order each round.
      const order = ARMS.map((_, i) => ARMS[(i + r) % ARMS.length]);
      for (const arm of order) {
        const shot = r === 0 ? path.join(OUT, "shots", `${page.id}-${arm}.png`) : null;
        const res = await loadOnce(browser, page, arm, engines[arm], shot);
        rows.push({ round: r, page: page.id, arm, ...res });
        process.stderr.write(
          `r${r} ${page.id.padEnd(11)} ${arm.padEnd(4)} reqs ${res.reqs} blocked ${res.blocked} ` +
            `${res.kb}KB load ${res.load ?? "-"}ms items ${res.items ?? "-"} ads ${res.ads ?? "-"}` +
            (res.videoT !== undefined ? ` video ${res.videoT}s ad ${res.adShowing}` : "") + "\n",
        );
      }
    }
  }
  await browser.close();
  engines.play.kill();
  engines.full.kill();

  // Summary: medians per page x arm.
  const summary = [];
  for (const page of pages) {
    for (const arm of ARMS) {
      const rs = rows.filter((x) => x.page === page.id && x.arm === arm);
      const col = (k) => median(rs.map((x) => x[k]));
      summary.push({
        page: page.id, arm, n: rs.length,
        reqs: col("reqs"), blocked: col("blocked"), kb: col("kb"), hosts: col("hosts"),
        dcl: col("dcl"), load: col("load"), lcp: col("lcp"), loadWall: col("loadWall"),
        items: col("items"), ads: col("ads"), errors: col("errors"), textLen: col("textLen"),
        navFail: rs.filter((x) => !x.navOk).length,
        ...(page.video ? {
          videoT: col("videoT"),
          adShowingRuns: rs.filter((x) => x.adShowing).length,
        } : {}),
      });
    }
  }
  await writeFile(path.join(OUT, "rows.json"), JSON.stringify({ built, rows }, null, 1));
  await writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  const cols = ["page", "arm", "n", "reqs", "blocked", "kb", "hosts", "dcl", "load", "lcp", "items", "ads", "errors", "navFail", "videoT", "adShowingRuns"];
  const md = [
    `# Filter impact, ${new Date().toISOString()}`,
    "",
    `Medians of ${ROUNDS} cold loads per cell, Pixel 7 emulation, Chromium ${browser.version?.() ?? ""}.`,
    "",
    "| " + cols.join(" | ") + " |",
    "|" + cols.map(() => "---").join("|") + "|",
    ...summary.map((s) => "| " + cols.map((c) => s[c] ?? "").join(" | ") + " |"),
  ].join("\n");
  await writeFile(path.join(OUT, "summary.md"), md + "\n");
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
