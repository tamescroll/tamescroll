import { invoke } from "@tauri-apps/api/core";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/spectral/400.css";
import "@fontsource/spectral/500.css";
import "./styles.css";

type Platform = {
  id: string;
  name: string;
  url: string;
  tint: string;
  ready: boolean;
};

// ---------- views ----------

const views = {
  launcher: document.querySelector<HTMLElement>("#view-launcher")!,
  settings: document.querySelector<HTMLElement>("#view-settings")!,
  onboard: document.querySelector<HTMLElement>("#view-onboard")!,
  links: document.querySelector<HTMLElement>("#view-links")!,
};

// Set by the update section: raises the update prompt once the
// launcher is on screen (#55).
let onLauncherShown: () => void = () => {};

function showView(name: keyof typeof views) {
  (Object.keys(views) as (keyof typeof views)[]).forEach((k) => {
    views[k].hidden = k !== name;
  });
  if (name === "launcher") onLauncherShown();
}

const tiles = document.querySelector<HTMLElement>("#tiles")!;
const status = document.querySelector<HTMLElement>("#status")!;
const blurToggle = document.querySelector<HTMLElement>("#blur-toggle")!;
const blurCaption = document.querySelector<HTMLElement>("#blur-caption")!;
const bringBack = document.querySelector<HTMLElement>("#bring-back")!;
const strengthRow = document.querySelector<HTMLElement>("#blur-strength-row")!;
const strengthToggle = document.querySelector<HTMLElement>("#blur-strength")!;

// Design tints (board 1A): muted warm letter glyphs, never platform
// brand colors. Falls back to the Rust-side tint for new platforms.
const DESIGN_TINTS: Record<string, string> = {
  youtube: "var(--tint-yt)",
  reddit: "var(--tint-rd)",
  x: "var(--tint-x)",
  instagram: "var(--tint-ig)",
  tiktok: "var(--tint-tt)",
};

// Per-platform launcher captions (board 1A). Fallback: "Cleaned".
const TILE_NOTES: Record<string, string> = {
  youtube: "No Shorts, no autoplay, no sidebar",
  reddit: "Your subreddits only, no Popular",
  x: "Following only, no For You",
  instagram: "No Reels, no Explore",
  tiktok: "Following and search only",
};

// ---------- gaze mode / strength / gender (Rust-mirrored) ----------

type GazeMode = "off" | "blur" | "smart";
const BLUR_KEY = "tamescroll.blur";

function migrate(raw: string | null): GazeMode {
  if (raw === "off" || raw === "blur" || raw === "smart") return raw;
  if (raw === "1") return "blur";
  return "off"; // "0", absent, or unrecognised
}

localStorage.setItem(BLUR_KEY, migrate(localStorage.getItem(BLUR_KEY)));

function getMode(): GazeMode {
  return migrate(localStorage.getItem(BLUR_KEY));
}

function setMode(value: GazeMode) {
  localStorage.setItem(BLUR_KEY, value);
  // Mirror into Rust: Android's single webview reads the mode from
  // there on every platform page load (the launcher's localStorage is
  // origin-locked and unreadable from platform pages).
  void invoke("set_gaze_mode", { mode: value }).catch(() => {});
  renderBlurToggle();
}

const STRENGTH_KEY = "tamescroll.blurpx";
const STRENGTHS = [8, 16, 28] as const;

function getStrength(): number {
  const px = Number(localStorage.getItem(STRENGTH_KEY));
  return (STRENGTHS as readonly number[]).includes(px) ? px : 16;
}

function setStrength(px: number) {
  localStorage.setItem(STRENGTH_KEY, String(px));
  void invoke("set_blur_strength", { px }).catch(() => {});
  renderBlurToggle();
}

const GENDER_KEY = "tamescroll.gender";
type UserGender = "man" | "woman" | "unset";

function getGender(): UserGender {
  const g = localStorage.getItem(GENDER_KEY);
  return g === "man" || g === "woman" ? g : "unset";
}

function setGender(g: UserGender) {
  localStorage.setItem(GENDER_KEY, g);
  void invoke("set_user_gender", { gender: g }).catch(() => {});
  renderBlurToggle();
}

// What to blur (his 2026-10-27): the one question the user answers,
// asked as the store-approved apps ask it. Each answer is a stored
// mode + gender pair, so coverage is exactly what Smart gave before:
// "women" is Smart for a man, "men" is Smart for a woman. Smart with
// no gender (an older first-run skip, or Settings' old "Not set") has
// no answer of its own and keeps covering every face until changed.
type BlurChoice = "all" | "women" | "men" | "none";

function getChoice(): BlurChoice | null {
  const mode = getMode();
  if (mode === "blur") return "all";
  if (mode === "off") return "none";
  const g = getGender();
  return g === "man" ? "women" : g === "woman" ? "men" : null;
}

function setChoice(c: BlurChoice) {
  if (c === "women") setGender("man");
  if (c === "men") setGender("woman");
  setMode(c === "all" ? "blur" : c === "none" ? "off" : "smart");
}

const CAPTIONS: Record<BlurChoice, string> = {
  all: "Blurs every picture and preview on the pages you browse.",
  women: "Blurs women in pictures and previews. Faces it can't place stay covered.",
  men: "Blurs men in pictures and previews. Faces it can't place stay covered.",
  none: "",
};

function renderBlurToggle() {
  const mode = getMode();
  const choice = getChoice();
  blurToggle.querySelectorAll<HTMLButtonElement>(".toggle-opt").forEach((btn) => {
    const active = btn.dataset.value === choice;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", String(active));
  });
  // The watch player is not blurred (his 2026-10-27 ruling, gaze
  // PLAYER_VIDEO_BLUR); the pane's own line says so.
  blurCaption.textContent = choice
    ? CAPTIONS[choice]
    : "Every face is blurred until you choose. Pick one above to change it.";
  const px = getStrength();
  strengthRow.hidden = mode === "off";
  strengthToggle.querySelectorAll<HTMLButtonElement>(".toggle-opt").forEach((btn) => {
    const active = Number(btn.dataset.value) === px;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", String(active));
  });
}

blurToggle.querySelectorAll<HTMLButtonElement>(".toggle-opt").forEach((btn) => {
  btn.addEventListener("click", () => setChoice(btn.dataset.value as BlurChoice));
});
strengthToggle.querySelectorAll<HTMLButtonElement>(".toggle-opt").forEach((btn) => {
  btn.addEventListener("click", () => setStrength(Number(btn.dataset.value)));
});

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// iPhone: the home screen icon is a widget the person adds. The steps
// show in Settings -> Sites and once during the welcome screens.
if (IOS) {
  const tpl = document.querySelector<HTMLTemplateElement>("#ios-home-steps")!;
  document.querySelectorAll(".ios-home-steps").forEach((slot) => {
    slot.appendChild(tpl.content.cloneNode(true));
  });
  document.querySelector<HTMLElement>("#ios-home-card")!.hidden = false;
}
const IOS_HOME_KEY = "ts.iosHomeNudge";
const nudge = document.querySelector<HTMLElement>("#ios-home-nudge")!;
function iosHomeDismissed(): boolean {
  try { return localStorage.getItem(IOS_HOME_KEY) === "off"; } catch { return false; }
}
function dismissIosHome() {
  try { localStorage.setItem(IOS_HOME_KEY, "off"); } catch { /* shown again next launch */ }
  nudge.hidden = true;
}
nudge.hidden = !IOS || iosHomeDismissed();
document.querySelector<HTMLButtonElement>("#ios-home-hide")!.addEventListener("click", dismissIosHome);
document.querySelector<HTMLButtonElement>("#ios-home-added")!.addEventListener("click", () => {
  dismissIosHome();
  const card = document.querySelector<HTMLElement>("#ios-home-card")!;
  card.querySelector<HTMLElement>(".card-body")!.textContent = "Done. Tap it any time to open YouTube here.";
});
document.querySelector<HTMLButtonElement>("#ios-home-show")!.addEventListener("click", () => {
  siteHere.textContent = "";
  showView("settings");
  showPane("bringback");
  document.querySelector<HTMLElement>("#ios-home-card")!.scrollIntoView({ block: "start" });
});

renderBlurToggle();
// Sync stored state into Rust at startup too, not just on change —
// otherwise a relaunch would leave Rust at defaults until first touch.
void invoke("set_gaze_mode", { mode: getMode() }).catch(() => {});
void invoke("set_blur_strength", { px: getStrength() }).catch(() => {});
void invoke("set_user_gender", { gender: getGender() }).catch(() => {});

// ---------- filter terms (Settings -> Filters) ----------

const TERMS_KEY = "tamescroll.terms";

function readTerms(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(TERMS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function writeTerms(terms: string[]) {
  localStorage.setItem(TERMS_KEY, JSON.stringify(terms));
  void invoke("set_user_terms", { terms }).catch(() => {});
  renderTermChips();
}

function renderTermChips() {
  const host = document.querySelector<HTMLElement>("#term-chips")!;
  host.textContent = "";
  const terms = readTerms();
  if (!terms.length) {
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.style.textAlign = "left";
    hint.textContent = "No terms of your own yet.";
    host.append(hint);
    return;
  }
  terms.forEach((term) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = term;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${term}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      writeTerms(readTerms().filter((t) => t !== term));
    });
    chip.append(label, remove);
    host.append(chip);
  });
}

document.querySelector<HTMLFormElement>("#term-form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.querySelector<HTMLInputElement>("#term-input")!;
  const term = input.value.trim();
  if (!term) return;
  const terms = readTerms();
  if (!terms.includes(term)) writeTerms([...terms, term]);
  input.value = "";
});

renderTermChips();
void invoke("set_user_terms", { terms: readTerms() }).catch(() => {});

// ---------- rules refresh (Settings -> About) ----------
// Rules also refresh silently on launch + every 24h (Rust side); this
// button is the owner-visible "do it now" for when a platform breaks
// something and a fix just landed.

const refreshForm = document.querySelector<HTMLFormElement>("#rules-refresh-form")!;
const refreshBtn = document.querySelector<HTMLButtonElement>("#rules-refresh")!;
const refreshStatus = document.querySelector<HTMLElement>("#rules-refresh-status")!;

refreshForm.addEventListener("submit", (e) => {
  e.preventDefault();
  refreshBtn.disabled = true;
  refreshStatus.textContent = "Checking…";
  invoke<string>("refresh_rules")
    .then((msg) => {
      refreshStatus.textContent =
        msg === "rules up to date" ? "Already up to date." : `${msg}. Reopen a site to apply.`;
    })
    .catch(() => {
      refreshStatus.textContent = "Couldn't reach the update server. Current rules stay active.";
    })
    .finally(() => {
      refreshBtn.disabled = false;
    });
});

// ---------- app update (launch prompt + Settings -> About) ----------
// His 2026-11-07 (#55): "directly give the update prompt" when a build
// is released, instead of reopening the releases link or Play each time.
//
// Two sources, one offer:
//  - Sideload APK: the Rust check reads the signed manifest; "Update now"
//    is MainActivity's TsUpdater (hash-pinned download, then the system
//    installer, which always asks the user to confirm).
//  - Play build: no TsUpdater exists there. TsStoreUpdate asks Google
//    Play's In-App Updates API instead, and Play does the download.
// Either way the offer opens a sheet over the launcher on launch and
// fills the About card. "Later" snoozes that version for a day. Desktop
// (and any build with neither bridge) keeps the About card only.

type UpdateStatus = {
  available: boolean;
  versionCode: number;
  versionName: string;
  notes: string;
  apkUrl: string;
};

type StoreUpdate = {
  state: "available" | "none" | "downloading" | "downloaded" | "cancelled" | "failed";
  versionCode?: number;
  percent?: number;
};

type Offer = { code: number; name: string; notes: string; via: "sideload" | "play" };

const updateCard = document.querySelector<HTMLElement>("#app-update-card")!;
const updateNotes = document.querySelector<HTMLElement>("#app-update-notes")!;
const updateBtn = document.querySelector<HTMLButtonElement>("#app-update-btn")!;
const updateStatus = document.querySelector<HTMLElement>("#app-update-status")!;
const updateSheet = document.querySelector<HTMLElement>("#update-sheet")!;
const sheetTitle = document.querySelector<HTMLElement>("#update-title")!;
const sheetNotes = document.querySelector<HTMLElement>("#update-sheet-notes")!;
const sheetNow = document.querySelector<HTMLButtonElement>("#update-now")!;
const sheetLater = document.querySelector<HTMLButtonElement>("#update-later")!;
const sheetStatus = document.querySelector<HTMLElement>("#update-sheet-status")!;

const tsWin = window as unknown as {
  TsUpdater?: { install: () => void };
  TsStoreUpdate?: { check: () => void; start: () => void; complete: () => void };
  __tsUpdateStatus?: (m: string) => void;
  __tsStoreUpdate?: (s: StoreUpdate) => void;
};
const hasInstaller = typeof tsWin.TsUpdater !== "undefined";
const hasStore = typeof tsWin.TsStoreUpdate !== "undefined";
const isAndroid = /Android/i.test(navigator.userAgent);

const SNOOZE_KEY = "tamescroll.updateSnooze";
const SNOOZE_MS = 24 * 60 * 60 * 1000;

let offer: Offer | null = null;
let manifest: UpdateStatus | null = null;
let playReady = false; // a flexible Play update has downloaded
let dismissed = false; // closed this session: do not raise it again

function snoozed(code: number): boolean {
  try {
    const s = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "null") as { code: number; until: number } | null;
    return !!s && s.code === code && Date.now() < s.until;
  } catch {
    return false;
  }
}

function setUpdateStatus(m: string) {
  updateStatus.textContent = m;
  sheetStatus.textContent = m;
}

function closeSheet() {
  updateSheet.hidden = true;
  dismissed = true;
}

function maybeShowSheet() {
  if (!offer || dismissed || snoozed(offer.code)) return;
  // Only over the plain launcher: never over onboarding, settings, or a
  // link that is on its way to a site.
  if (views.launcher.hidden || !handoff.hidden) return;
  updateSheet.hidden = false;
}

function describe(o: Offer): string {
  if (o.notes) return o.name ? `New in ${o.name}: ${o.notes}` : o.notes;
  return o.name ? `Version ${o.name} is ready to install.` : "A new version is ready to install.";
}

function present(o: Offer) {
  offer = o;
  sheetTitle.textContent = playReady ? "Update downloaded" : "An update is ready";
  sheetNotes.textContent = describe(o);
  sheetNow.textContent = playReady ? "Restart to finish" : "Update now";
  updateNotes.textContent = describe(o);
  updateBtn.textContent = sheetNow.textContent;
  updateBtn.hidden = false;
  updateCard.hidden = false;
  maybeShowSheet();
}

function startUpdate() {
  if (!offer) return;
  if (offer.via === "sideload" && tsWin.TsUpdater) {
    setUpdateStatus("Checking…");
    sheetNow.disabled = true;
    updateBtn.disabled = true;
    tsWin.TsUpdater.install();
  } else if (offer.via === "play" && tsWin.TsStoreUpdate) {
    if (playReady) {
      setUpdateStatus("Restarting…");
      tsWin.TsStoreUpdate.complete();
    } else {
      setUpdateStatus("Opening Google Play…");
      tsWin.TsStoreUpdate.start();
    }
  }
}

sheetNow.addEventListener("click", startUpdate);
updateBtn.addEventListener("click", startUpdate);
sheetLater.addEventListener("click", () => {
  if (offer) {
    try {
      localStorage.setItem(SNOOZE_KEY, JSON.stringify({ code: offer.code, until: Date.now() + SNOOZE_MS }));
    } catch {
      /* no storage: it simply asks again next launch */
    }
  }
  closeSheet();
});
document.querySelector<HTMLElement>("#update-scrim")!.addEventListener("click", closeSheet);

onLauncherShown = maybeShowSheet;

// Sideload progress (MainActivity UpdateBridge.report). Anything that is
// not a step forward gives the button back so the user can try again.
tsWin.__tsUpdateStatus = (m: string) => {
  setUpdateStatus(m);
  // "Starting install…" gives the button back too: the system installer
  // reports nothing if it is cancelled or refuses, so a retry must stay open.
  if (!/^Downloading/.test(m)) {
    sheetNow.disabled = false;
    updateBtn.disabled = false;
  }
};

// Play's answers (MainActivity StoreUpdateBridge).
tsWin.__tsStoreUpdate = (s: StoreUpdate) => {
  if (s.state === "available" || s.state === "downloaded") {
    playReady = s.state === "downloaded";
    const code = s.versionCode ?? offer?.code ?? 0;
    // The notes live in the sideload manifest; they describe this build
    // only when the codes match (play-build.sh ships the same code).
    const same = manifest && manifest.versionCode === code;
    present({
      code,
      name: same ? manifest!.versionName : code > 1000 ? `0.1.${code - 1000}` : "",
      notes: same ? manifest!.notes : "",
      via: "play",
    });
    if (playReady) setUpdateStatus("");
  } else if (s.state === "downloading") {
    setUpdateStatus(`Downloading update… ${s.percent ?? 0}%`);
    closeSheet();
  } else if (s.state === "cancelled") {
    setUpdateStatus("Update not started. You can update any time from here.");
  } else if (s.state === "failed") {
    setUpdateStatus("The update didn't finish. Try again.");
  }
};

invoke<UpdateStatus>("app_update_check")
  .then((s) => {
    manifest = s;
    if (hasStore) {
      // Play decides whether there is an update; the manifest only
      // supplies the words. Re-present if Play already answered.
      if (offer?.via === "play") tsWin.__tsStoreUpdate?.({ state: playReady ? "downloaded" : "available", versionCode: offer.code });
      return;
    }
    // An Android build without the installer is a Play build, which must
    // never point at the releases page.
    if (!s.available || (isAndroid && !hasInstaller)) return;
    // iPhone updates come through TestFlight or the App Store, never the
    // Android download on the releases page.
    if (IOS) return;
    if (hasInstaller) {
      present({ code: s.versionCode, name: s.versionName, notes: s.notes, via: "sideload" });
    } else {
      // Desktop: no in-app install; the About card just says it exists.
      updateNotes.textContent = describe({ code: s.versionCode, name: s.versionName, notes: s.notes, via: "sideload" });
      updateBtn.hidden = true;
      updateStatus.textContent = "Get the new build from the releases page.";
      updateCard.hidden = false;
    }
  })
  .catch(() => {
    /* offline / no manifest: stay hidden, never nag */
  });

if (hasStore) {
  try {
    tsWin.TsStoreUpdate!.check();
  } catch {
    /* Play unavailable: no prompt */
  }
}

// ---------- diagnostics (Settings -> About) ----------
// Owner ask 2026-08-28: "can't you implement a diagnostics feature in the
// app ... so you can always check the logs", then, choosing the shape
// himself, "or give me the control of reporting".
//
// So: the app collects, and HE sends. The platform pages write redacted
// reports to a local file (diag-report.mjs builds and gates them,
// MainActivity's TsDiag bridge stores them); this card shows what is
// there and offers the three things he can do with it. Nothing is
// uploaded, which is also why the About copy above still says there is
// no telemetry.
//
// Android-only: the bridge lives in the one WebView both the launcher
// and the platforms share. On desktop the card stays hidden -- reports
// are readable there over CDP, which is what this exists to replace.

type DiagLine = {
  t?: number;
  app?: { versionCode?: number };
  page?: { platform?: string; kind?: string };
  worker?: { backend?: string };
  images?: { n?: number; gapsP95?: number };
};

const diagCard = document.querySelector<HTMLElement>("#diag-card")!;
const diagSummary = document.querySelector<HTMLElement>("#diag-summary")!;
const diagStatus = document.querySelector<HTMLElement>("#diag-status")!;
const diagBridge = (window as unknown as {
  TsDiag?: { read: () => string; share: () => void; clear: () => void };
}).TsDiag;

function refreshDiag() {
  if (!diagBridge) return;
  let raw = "";
  try {
    raw = diagBridge.read();
  } catch {
    diagStatus.textContent = "Couldn't read the diagnostics file.";
    return;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) {
    diagSummary.textContent = "Nothing collected yet. Open a site and come back.";
    return;
  }
  // The last report is the one that explains whatever just annoyed him,
  // so it is the one summarised. The rest are in the file.
  let last: DiagLine = {};
  try {
    last = JSON.parse(lines[lines.length - 1]) as DiagLine;
  } catch {
    /* a truncated tail line is not worth failing the card over */
  }
  const bits = [`${lines.length} report${lines.length === 1 ? "" : "s"}`];
  if (last.app?.versionCode) bits.push(`build ${last.app.versionCode}`);
  if (last.page?.platform) bits.push(`${last.page.platform} ${last.page.kind ?? ""}`.trim());
  if (last.worker?.backend) bits.push(`worker ${last.worker.backend}`);
  if (typeof last.images?.gapsP95 === "number") bits.push(`slowest gap ${last.images.gapsP95}ms`);
  diagSummary.textContent = bits.join(" · ");
}

if (diagBridge) {
  diagCard.hidden = false;
  refreshDiag();
  document.querySelector<HTMLButtonElement>("#diag-share")!.addEventListener("click", () => {
    diagStatus.textContent = "";
    try {
      diagBridge.share();
    } catch {
      diagStatus.textContent = "No app to share with.";
    }
  });
  document.querySelector<HTMLButtonElement>("#diag-copy")!.addEventListener("click", () => {
    try {
      const text = diagBridge.read();
      if (!text) {
        diagStatus.textContent = "Nothing to copy yet.";
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => {
          diagStatus.textContent = "Copied.";
        },
        () => {
          diagStatus.textContent = "Clipboard refused. Use Share instead.";
        },
      );
    } catch {
      diagStatus.textContent = "Couldn't read the diagnostics file.";
    }
  });
  document.querySelector<HTMLButtonElement>("#diag-clear")!.addEventListener("click", () => {
    try {
      diagBridge.clear();
    } catch {
      /* a failed delete leaves the file, which the next read will show */
    }
    diagStatus.textContent = "Cleared.";
    refreshDiag();
  });
}

// ---------- bring back (surfaces) ----------

type SurfaceInfo = { id: string; label: string; default_shown: boolean };

const SHOWN_KEY = "tamescroll.shown";

// THE MAP IS MIRRORED NATIVELY (#50). WebView localStorage reaches disk
// lazily: measured on the emulator, a setting flipped and the app swiped
// away at once came back with its OLD value. MainActivity's TsPrefs writes
// synchronously, so it is read first and written on every change; desktop
// has no bridge and keeps localStorage alone.
type PrefsBridge = { get(key: string): string | null; set(key: string, value: string): boolean };
function prefsBridge(): PrefsBridge | null {
  return ((window as unknown as { TsPrefs?: PrefsBridge }).TsPrefs) ?? null;
}

function parseShownMap(raw: string | null | undefined): Record<string, string[]> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readShownMap(): Record<string, string[]> {
  let native: string | null = null;
  try {
    native = prefsBridge()?.get("shown") ?? null;
  } catch {
    native = null;
  }
  return parseShownMap(native) ?? parseShownMap(localStorage.getItem(SHOWN_KEY)) ?? {};
}

function writeShownMap(map: Record<string, string[]>) {
  const json = JSON.stringify(map);
  localStorage.setItem(SHOWN_KEY, json);
  try {
    prefsBridge()?.set("shown", json);
  } catch {
    // localStorage still has it; the mirror is a backstop, not the store.
  }
}

// The whole map for Rust, cleaned: one malformed entry would fail the
// invoke's deserialisation and with it the tap, so only string lists go.
function shownMapForRust(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(readShownMap())) {
    if (Array.isArray(list)) out[id] = list.filter((v) => typeof v === "string");
  }
  return out;
}

function getShown(platformId: string): string[] {
  const shown = readShownMap()[platformId];
  return Array.isArray(shown) ? shown : [];
}

// SEED THE DEFAULTS ONCE. (owner 2026-08-27: "no recommendations did we
// remove them keep the option but don't disable right on")
//
// The stored map is the user's own choice and must never be overwritten
// by a later build's opinion, so this runs exactly once per install and
// only for platforms the user has never touched. Everything after that
// is theirs: flipping a default-shown surface to Hidden persists an
// empty list, which is a real stored choice and is left alone.
const SEEDED_KEY = "tamescroll.shown.seeded";

async function seedDefaultShown(platformIds: string[]) {
  try {
    if (localStorage.getItem(SEEDED_KEY)) return;
    const map = readShownMap();
    for (const id of platformIds) {
      if (Array.isArray(map[id])) continue;
      const list = await invoke<SurfaceInfo[]>("surfaces", { id });
      const defaults = list.filter((s) => s.default_shown).map((s) => s.id);
      if (defaults.length) map[id] = defaults;
    }
    writeShownMap(map);
    localStorage.setItem(SEEDED_KEY, "1");
  } catch (error) {
    // A failed seed must not stop the launcher rendering: the user simply
    // gets the fully-cleaned default and can turn the surface on himself.
    console.warn("tamescroll: could not seed default surfaces", error);
  }
}

function setShown(platformId: string, shown: string[]) {
  const map = readShownMap();
  map[platformId] = shown;
  writeShownMap(map);
}

function surfaceRow(platformId: string, surface: SurfaceInfo): HTMLElement {
  const row = document.createElement("div");
  row.className = "setting-row";

  const label = document.createElement("span");
  label.className = "setting-label";
  label.textContent = surface.label;

  const toggle = document.createElement("div");
  toggle.className = "toggle";
  toggle.setAttribute("role", "radiogroup");
  toggle.setAttribute("aria-label", surface.label);

  const paint = () => {
    const isShown = getShown(platformId).includes(surface.id);
    toggle.querySelectorAll<HTMLButtonElement>(".toggle-opt").forEach((btn) => {
      const active = (btn.dataset.value === "shown") === isShown;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  };

  (["hidden", "shown"] as const).forEach((value) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toggle-opt";
    btn.setAttribute("role", "radio");
    btn.dataset.value = value;
    btn.textContent = value === "hidden" ? "Hidden" : "Shown";
    btn.addEventListener("click", () => {
      const current = getShown(platformId).filter((id) => id !== surface.id);
      setShown(platformId, value === "shown" ? [...current, surface.id] : current);
      paint();
    });
    toggle.append(btn);
  });

  paint();
  row.append(label, toggle);
  return row;
}

async function renderBringBack(readyPlatforms: Platform[]) {
  bringBack.textContent = "";
  if (!readyPlatforms.length) {
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Add a site on the home screen first — its settings show up here.";
    bringBack.append(hint);
    return;
  }
  for (const platform of readyPlatforms) {
    try {
      const surfaces = await invoke<SurfaceInfo[]>("surfaces", { id: platform.id });
      if (surfaces.length === 0) continue;

      const details = document.createElement("details");
      details.className = "platform-settings";
      details.dataset.platform = platform.id;
      const summary = document.createElement("summary");
      summary.textContent = platform.name;
      details.append(summary);
      surfaces.forEach((surface) => details.append(surfaceRow(platform.id, surface)));
      bringBack.append(details);
    } catch {
      // One platform's toggles failing to load must not block the rest.
    }
  }
}

// ---------- chosen platforms ----------

// Chosen platforms (owner decision 2026-08-19): a launcher that shows
// every platform is itself a temptation surface — a hub. The grid only
// ever shows platforms the user explicitly brought in, and adding one
// is type-to-match: we match only what the user types, never list or
// suggest (design board 1D; also the no-circumvention stance — the
// launcher must not advertise platforms someone removed from their life).
const CHOSEN_KEY = "tamescroll.chosen";

function readChosen(): string[] | null {
  const raw = localStorage.getItem(CHOSEN_KEY);
  if (raw === null) return null; // onboarding not done yet
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeChosen(ids: string[]) {
  localStorage.setItem(CHOSEN_KEY, JSON.stringify(ids));
}

// ANY SITE CAN BE A TILE (his 2026-10-27, #35: a calm browser, YouTube is
// one site). The platforms we tame stay in CHOSEN_KEY; every other site
// the user adds is a bare address here and opens like the search box.
type Site = { host: string; name: string; url: string };
const SITES_KEY = "tamescroll.sites";

function readSites(): Site[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SITES_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((s) => s && typeof s.host === "string" && typeof s.url === "string")
      : [];
  } catch {
    return [];
  }
}

function writeSites(sites: Site[]) {
  localStorage.setItem(SITES_KEY, JSON.stringify(sites));
}

const bareHost = (host: string) => host.toLowerCase().replace(/^(www|m|mobile)\./, "");

// "wikipedia.org", "https://www.bbc.co.uk/news" -> a site; a plain word or
// a sentence is not one (the search box takes those).
function siteFromInput(raw: string): Site | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return null;
  const host = bareHost(u.hostname);
  // The name is the site's own label: en.wikipedia.org -> Wikipedia,
  // bbc.co.uk -> BBC (a two-part ending like .co.uk is skipped).
  const parts = host.split(".");
  let i = parts.length - 2;
  if (i > 0 && parts[i].length <= 3 && parts[i + 1].length === 2) i--;
  const label = parts[i];
  return {
    host,
    name: label.length <= 3 ? label.toUpperCase() : label.charAt(0).toUpperCase() + label.slice(1),
    url: `https://${u.hostname.toLowerCase()}/`,
  };
}

function addSite(site: Site) {
  const sites = readSites();
  if (!sites.some((s) => s.host === site.host)) writeSites([...sites, site]);
}

function siteTile(site: Site): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "tile";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = site.name.charAt(0);
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = site.name;
  const note = document.createElement("span");
  note.className = "note";
  note.textContent = site.host;
  el.append(dot, name, note);
  el.setAttribute("aria-label", `${site.name}, ${site.host}`);
  el.addEventListener("click", () => {
    el.classList.add("opening");
    void openAddress(site.url);
  });
  return el;
}

function glyphFor(platform: Platform): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.color = DESIGN_TINTS[platform.id] ?? platform.tint;
  dot.textContent = platform.name.charAt(0);
  return dot;
}

function tile(platform: Platform): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "tile";
  el.disabled = !platform.ready;

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = platform.name;

  const note = document.createElement("span");
  note.className = "note";
  // "Tamed" marks the sites we clean specially, so the care shows
  // without making them the point of the app.
  note.textContent = platform.ready
    ? `Tamed · ${TILE_NOTES[platform.id] ?? "feeds hidden"}`
    : "Not ready yet";

  el.append(glyphFor(platform), name, note);
  // The note is hidden in the compact grid; the label still reads it out.
  el.classList.toggle("is-tamed", platform.ready);
  el.setAttribute("aria-label", `${platform.name}, ${note.textContent}`);

  if (platform.ready) {
    el.addEventListener("click", () => {
      void open(platform, undefined, el);
    });
  }

  return el;
}

// Type-to-match: reveal a platform only after the user types its name.
// Never a list, never a suggestion (board 1D step 2).
function matchPlatforms(platforms: Platform[], query: string, exclude: string[]): Platform[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  // Not-ready platforms still match — "we don't support that" would be a
  // lie for one we know but haven't finished; the row says so instead.
  return platforms.filter(
    (p) => !exclude.includes(p.id) && p.name.toLowerCase().startsWith(q)
  );
}

function matchRow(platform: Platform, query: string, onAdd: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "match-row";
  const grow = document.createElement("span");
  grow.className = "grow";
  const bold = document.createElement("b");
  bold.textContent = platform.name.slice(0, query.trim().length);
  const dim = document.createElement("span");
  dim.className = "dim";
  dim.textContent = platform.name.slice(query.trim().length);
  grow.append(bold, dim);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn-solid";
  if (platform.ready) {
    add.textContent = "Add";
    add.addEventListener("click", onAdd);
  } else {
    add.textContent = "Not ready yet";
    add.disabled = true;
    add.classList.remove("btn-solid");
    add.classList.add("link-btn");
  }
  row.append(glyphFor(platform), grow, add);
  return row;
}

// ---------- launcher rendering ----------

let restingStatus = "";
const NEWLINE = String.fromCharCode(10);

// A BLANK HOME IS THE DESIGN (his ruling 2026-09-10, reversing the
// morning's Subscriptions landing an hour after it shipped): the tile
// opens the platform's front page, feed hidden, nothing else.
async function open(platform: Platform, url?: string, tile?: HTMLElement) {
  // Instant feedback: the webview keeps the launcher painted ~0.5s after
  // navigate() until YouTube commits (probe_open_frames.py, his phone),
  // so without this a tap looks ignored for half a second.
  tile?.classList.add("opening");
  status.textContent = `Opening ${platform.name}…`;
  // The document is torn down ~50ms after navigate() and its pending
  // frame with it (measured: #status is null by 55ms), so give the
  // feedback two frames to reach the screen before asking for the page.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  try {
    await invoke("open_platform", {
      strength: getStrength(),
      id: platform.id,
      mode: getMode(),
      gender: getGender(),
      shown: getShown(platform.id),
      // The page a link asked for (1107); Rust re-checks the host.
      url: url ?? null,
      // Every platform's list, so a page reached from ANOTHER platform (a
      // YouTube link inside Reddit) wears its own prefs, not this tile's.
      shownMap: shownMapForRust(),
    });
    // Android navigates this very document away: restoring here would
    // paint the un-dimmed tile as the LAST frame before teardown (measured,
    // the feedback never reached the screen). Desktop keeps the launcher,
    // so it restores once the new window is up.
    if (!isAndroid) {
      status.textContent = restingStatus;
      tile?.classList.remove("opening");
    }
  } catch (error) {
    status.textContent = `Could not open ${platform.name}: ${String(error)}`;
    tile?.classList.remove("opening");
  }
}

// ---------- open a link ----------
// The one place a pasted link can go. Hosts mirror MainActivity's
// linkHosts and Rust's link_host_belongs; Rust re-checks before it
// navigates, so this list can only be stricter than the app, never looser.
const LINK_HOSTS: Record<string, string> = {
  "youtube.com": "youtube", "www.youtube.com": "youtube",
  "m.youtube.com": "youtube", "youtu.be": "youtube",
};

function platformForLink(raw: string): { platform: Platform; url: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const id = LINK_HOSTS[u.hostname.toLowerCase()];
  if (!id) return null;
  const platform = allPlatforms.find((p) => p.id === id && p.ready);
  if (!platform) return null;
  return { platform, url: u.toString() };
}

const openLinkForm = document.querySelector<HTMLFormElement>("#open-link")!;
const openLinkInput = document.querySelector<HTMLInputElement>("#open-link-input")!;
openLinkForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = openLinkInput.value;
  if (!raw.trim()) return;
  const hit = platformForLink(raw);
  openLinkInput.value = "";
  if (hit) {
    if (!(readChosen() ?? []).includes(hit.platform.id)) {
      writeChosen([...(readChosen() ?? []), hit.platform.id]);
      refreshAll();
    }
    void open(hit.platform, hit.url);
    return;
  }
  // Anything else is an address or a search; Rust decides which and only
  // ever opens http(s).
  void openAddress(raw);
});

async function openAddress(raw: string) {
  status.textContent = "Opening…";
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  try {
    await invoke("open_address", {
      input: raw,
      mode: getMode(),
      strength: getStrength(),
      gender: getGender(),
      shownMap: shownMapForRust(),
    });
    if (!isAndroid) status.textContent = restingStatus;
  } catch (error) {
    status.textContent = `Could not open that: ${String(error)}`;
  }
}

function renderTiles(platforms: Platform[], chosen: string[]) {
  tiles.textContent = "";
  platforms
    .filter((p) => chosen.includes(p.id))
    .forEach((platform) => tiles.append(tile(platform)));
  readSites().forEach((site) => tiles.append(siteTile(site)));

  // "Add a site" tile: expands into a box that takes a tamed site's
  // name or any address.
  const add = document.createElement("button");
  add.className = "tile add";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "+";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "Add a site";
  const note = document.createElement("span");
  note.className = "note";
  note.textContent = "Its name or address";
  add.append(dot, name, note);
  add.addEventListener("click", () => {
    add.replaceWith(addMatchBox(platforms));
  });
  tiles.append(add);
}

function addMatchBox(platforms: Platform[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "add-match";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "wikipedia.org, Reddit...";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  const result = document.createElement("div");
  box.append(input, result);

  input.addEventListener("input", () => {
    result.textContent = "";
    const chosen = readChosen() ?? [];
    const q = input.value;
    // A tamed site's own address adds that site, not a bare tile.
    const site = siteFromInput(q);
    const tamed = site ? platformForPage(site.url) : undefined;
    const matches = tamed
      ? chosen.includes(tamed.id) ? [] : [tamed]
      : matchPlatforms(platforms, q, chosen);
    if (matches.length) {
      result.append(
        matchRow(matches[0], tamed ? matches[0].name : q, () => {
          writeChosen([...chosen, matches[0].id]);
          refreshAll();
        })
      );
    } else if (site && !tamed) {
      result.append(siteRow(site, () => {
        addSite(site);
        refreshAll();
      }));
    } else if (q.trim().length >= 3 && !site) {
      const none = document.createElement("p");
      none.className = "match-none";
      none.textContent = "Type the site's address, like wikipedia.org.";
      result.append(none);
    }
  });

  setTimeout(() => input.focus(), 0);
  return box;
}

function siteRow(site: Site, onAdd: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "match-row";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = site.name.charAt(0);
  const grow = document.createElement("span");
  grow.className = "grow";
  grow.textContent = site.host;
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn-solid";
  if (readSites().some((s) => s.host === site.host)) {
    add.textContent = "Added";
    add.disabled = true;
  } else {
    add.textContent = "Add";
    add.addEventListener("click", onAdd);
  }
  row.append(dot, grow, add);
  return row;
}

// "Manage platforms": every chosen platform as an In/Out row, inside
// Settings. Out is the default state of the world; In is the explicit
// act (and arrives via type-to-match, never a listing).
function renderManage(platforms: Platform[]) {
  const host = document.querySelector<HTMLElement>("#manage-platforms")!;
  host.textContent = "";
  const chosen = readChosen() ?? [];
  const sites = readSites();
  if (!chosen.length && !sites.length) return;

  const details = document.createElement("details");
  details.className = "platform-settings";
  const summary = document.createElement("summary");
  summary.textContent = "Remove a site";
  details.append(summary);

  const row = (text: string, onRemove: () => void) => {
    const el = document.createElement("div");
    el.className = "setting-row";
    const label = document.createElement("span");
    label.className = "setting-label";
    label.textContent = text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link-btn";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      onRemove();
      refreshAll();
    });
    el.append(label, remove);
    details.append(el);
  };
  platforms
    .filter((p) => chosen.includes(p.id))
    .forEach((platform) =>
      row(platform.name, () => writeChosen((readChosen() ?? []).filter((id) => id !== platform.id)))
    );
  sites.forEach((site) =>
    row(site.host, () => writeSites(readSites().filter((s) => s.host !== site.host)))
  );
  host.append(details);
}

// ---------- links: make tamescroll your YouTube (1108) ----------
//
// MEASURED ON HIS PHONE: YouTube's links are system_configured, so a
// bare youtu.be tap opens the YouTube app in every state of OUR package.
// The one recipe that works is YouTube's master "Open supported links"
// OFF plus ours ON. Android gives no API to set either; it gives one to
// open the exact page. So this screen walks the user through both
// switches, then proves it with a real link. State comes from the OS
// where it will say (DomainVerificationManager, API 31+) and from the
// probe otherwise; a field the OS refuses is null, never guessed.

type LinksBridge = {
  openDefaultApps(pkg: string | null): void;
  openAppInfo(pkg: string): void;
  probe(): void;
  pinShortcut(id: string): string;
  pinNamed?(id: string, name: string): string;
  pinState?(id: string): string;
  state(): string;
};
type PkgLinkState = { allowed?: boolean; hosts?: Record<string, number> };
type LinksState = {
  probed?: boolean;
  youtubeInstalled?: boolean;
  ours?: PkgLinkState;
  youtube?: PkgLinkState;
};

const YOUTUBE_PKG = "com.google.android.youtube";
const linksBridge = (window as unknown as { TsLinks?: LinksBridge }).TsLinks;
const linksCard = document.querySelector<HTMLElement>("#links-card")!;
let linksReturn: () => void = () => showView("launcher");

function readLinksState(): LinksState {
  if (!linksBridge) return {};
  try {
    const parsed = JSON.parse(linksBridge.state());
    return parsed && typeof parsed === "object" ? (parsed as LinksState) : {};
  } catch {
    return {};
  }
}

// Ours "on" = the master switch allowed AND youtu.be selected (1) or
// verified (2). Unknown when the OS would not say.
function oursOn(s: LinksState): boolean | null {
  if (!s.ours || typeof s.ours.allowed !== "boolean") return null;
  const v = s.ours.hosts?.["youtu.be"] ?? 0;
  return s.ours.allowed && v > 0;
}
function youtubeOff(s: LinksState): boolean | null {
  if (s.youtubeInstalled === false) return true;
  if (!s.youtube || typeof s.youtube.allowed !== "boolean") return null;
  return !s.youtube.allowed;
}
function linksOwned(s: LinksState): boolean {
  if (s.probed) return true;
  return oursOn(s) === true && youtubeOff(s) === true;
}

function linksApplicable(): boolean {
  return !!linksBridge && (readChosen() ?? []).includes("youtube");
}

function renderLinksCard() {
  if (!linksApplicable()) {
    linksCard.hidden = true;
    return;
  }
  const s = readLinksState();
  const owned = linksOwned(s);
  linksCard.hidden = false;
  document.querySelector<HTMLElement>("#links-card-tick")!.className = owned ? "tick on" : "tick warn";
  document.querySelector<HTMLElement>("#links-card-title")!.textContent = owned
    ? "YouTube links open here"
    : "YouTube links still open in the YouTube app";
  document.querySelector<HTMLElement>("#links-card-body")!.textContent = owned
    ? "A link from WhatsApp or mail lands in tamescroll, cleaned."
    : "Two switches and a test. Takes a minute.";
  const btn = document.querySelector<HTMLButtonElement>("#links-card-btn")!;
  btn.textContent = owned ? "Review" : "Set up";
}

function renderLinksView() {
  const s = readLinksState();
  const rows: Record<string, boolean | null> = {
    "yt-off": youtubeOff(s),
    "ours-on": oursOn(s),
    probe: s.probed ? true : null,
  };
  document.querySelectorAll<HTMLElement>("#links-steps .step").forEach((li) => {
    const done = rows[li.dataset.step ?? ""] === true;
    li.classList.toggle("done", done);
  });
  const uninstall = document.querySelector<HTMLElement>('.step[data-step="uninstall"]')!;
  uninstall.hidden = s.youtubeInstalled === false;
  renderPinStep();
  const note = document.querySelector<HTMLElement>("#links-note")!;
  if (linksOwned(s)) {
    note.textContent = "Done. YouTube links open in tamescroll.";
  } else if (rows["yt-off"] === null && rows["ours-on"] === null) {
    note.textContent = "This phone won't report the switches, so the test is the proof.";
  } else {
    note.textContent = "";
  }
}

// What the launcher said when asked to pin, in the user's words. On a
// launcher that refuses pin requests (olauncher on his own phone) the
// long-press route still works on most of them, so it is offered.
const PIN_WORDS: Record<string, string> = {
  pinned: "Already on your home screen.",
  requested: "Confirm on the dialog that just opened. It's in your app list too, as \"Tame for YouTube\".",
  listed: "Added to your app list as \"Tame for YouTube\". To call it something else, rename it in your launcher (on olauncher: start typing its name in the app list, then tap Rename).",
  unsupported: "Your launcher doesn't take shortcuts from apps. Long-press the tamescroll icon and drag YouTube out, or pick another launcher.",
  unavailable: "This phone can't add shortcuts.",
  refused: "That didn't work. Try from the home screen instead.",
};

function renderPinStep() {
  const li = document.querySelector<HTMLElement>('.step[data-step="pin"]');
  if (!li || !linksBridge?.pinState) return;
  let st: { supported?: boolean; pinned?: boolean; listed?: boolean } = {};
  try { st = JSON.parse(linksBridge.pinState("youtube")); } catch { /* the OS would not say */ }
  li.classList.toggle("done", st.pinned === true || (st.listed === true && st.supported === false));
  const body = li.querySelector<HTMLElement>(".step-body")!;
  const btn = li.querySelector<HTMLButtonElement>("button")!;
  const nameBox = li.querySelector<HTMLInputElement>("#pin-name");
  // The name box only matters where the launcher takes a shortcut: an
  // app-list entry's name is fixed, and the launcher renames it.
  if (nameBox) nameBox.hidden = !!(st.pinned || st.supported === false);
  if (st.pinned) {
    body.textContent = st.listed
      ? "On your home screen, and in your app list as \"Tame for YouTube\"."
      : "On your home screen.";
    btn.hidden = true;
  } else if (st.listed && st.supported !== false) {
    // In the app list already; the home icon (with their name) is still on offer.
    body.textContent = "In your app list as \"Tame for YouTube\". Add a home screen icon and name it what you like.";
    btn.hidden = false;
  } else if (st.listed) {
    // A launcher that won't pin (olauncher) gets the app-list entry.
    body.textContent = "In your app list as \"Tame for YouTube\". Rename it in your launcher if you like.";
    btn.hidden = true;
  } else if (st.supported === false) {
    // The button still helps here: it switches on the app-list entry.
    body.textContent = "Your launcher won't take a shortcut, so this adds \"Tame for YouTube\" to your app list.";
    btn.hidden = false;
  } else {
    body.textContent = "Adds \"Tame for YouTube\" to your app list, and a home screen icon you name yourself.";
    btn.hidden = false;
  }
}

function openLinksView(returnTo: () => void) {
  linksReturn = returnTo;
  renderLinksView();
  showView("links");
}

document.querySelectorAll<HTMLButtonElement>("#view-links [data-act]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!linksBridge) return;
    try {
      switch (btn.dataset.act) {
        case "yt-off": linksBridge.openDefaultApps(YOUTUBE_PKG); break;
        case "ours-on": linksBridge.openDefaultApps(null); break;
        case "probe": linksBridge.probe(); break;
        case "pin": {
          const name = (document.querySelector<HTMLInputElement>("#pin-name")?.value ?? "").trim();
          const r = String(linksBridge.pinNamed
            ? linksBridge.pinNamed("youtube", name)
            : linksBridge.pinShortcut("youtube"));
          const note = document.querySelector<HTMLElement>("#links-note")!;
          note.textContent = PIN_WORDS[r] ?? "";
          renderPinStep();
          break;
        }
        case "uninstall": linksBridge.openAppInfo(YOUTUBE_PKG); break;
      }
    } catch {
      document.querySelector<HTMLElement>("#links-note")!.textContent =
        "That page wouldn't open. Find it under Settings, Apps.";
    }
  });
});
// The user comes back from a system page: re-read what the OS says.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!views.links.hidden) renderLinksView();
  if (!views.settings.hidden) renderLinksCard();
});
document.querySelector<HTMLButtonElement>("#links-done")!.addEventListener("click", () => linksReturn());
document.querySelector<HTMLButtonElement>("#links-back")!.addEventListener("click", () => linksReturn());
document.querySelector<HTMLButtonElement>("#links-card-btn")!.addEventListener("click", () => {
  openLinksView(() => {
    showView("settings");
    showPane("bringback");
    renderLinksCard();
  });
});

// ---------- look and text size (his 2026-10-28) ----------
// Night (default) or Paper. index.html applies the stored values before
// the first paint; these keep the page, the pickers and the phone's own
// bars in step after a tap.

const LOOK_KEY = "tamescroll.look";
const TEXT_KEY = "tamescroll.text";
type Look = "night" | "paper";

function readLook(): Look {
  return localStorage.getItem(LOOK_KEY) === "paper" ? "paper" : "night";
}

function applyLook(look: Look) {
  localStorage.setItem(LOOK_KEY, look);
  if (look === "paper") document.documentElement.dataset.look = "paper";
  else delete document.documentElement.dataset.look;
  document.querySelectorAll<HTMLButtonElement>(".look").forEach((btn) => {
    const on = btn.dataset.look === look;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", String(on));
  });
  // The strips behind the clock and the nav bar are the phone's, not the
  // page's: tell MainActivity so they match. Absent on desktop.
  try {
    (window as unknown as { TsLook?: { set(look: string): void } }).TsLook?.set(look);
  } catch {
    // An old shell without the bridge keeps its dark strips.
  }
}

function applyText(size: "normal" | "large") {
  localStorage.setItem(TEXT_KEY, size);
  if (size === "large") document.documentElement.dataset.text = "large";
  else delete document.documentElement.dataset.text;
  document.querySelectorAll<HTMLButtonElement>("#text-toggle .toggle-opt").forEach((btn) => {
    const on = btn.dataset.value === size;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", String(on));
  });
}

document.querySelectorAll<HTMLButtonElement>(".look").forEach((btn) => {
  btn.addEventListener("click", () => applyLook(btn.dataset.look as Look));
});
document.querySelectorAll<HTMLButtonElement>("#text-toggle .toggle-opt").forEach((btn) => {
  btn.addEventListener("click", () => applyText(btn.dataset.value === "large" ? "large" : "normal"));
});
applyLook(readLook());
applyText(localStorage.getItem(TEXT_KEY) === "large" ? "large" : "normal");

// A small hello above the question, by the phone's clock.
function renderGreeting() {
  const h = new Date().getHours();
  const line =
    h < 5 ? "Up late?" : h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : h < 22 ? "Good evening." : "Up late?";
  document.querySelector<HTMLElement>("#greet")!.textContent = line;
}

// ---------- settings view ----------

const PANES = ["bringback", "blur", "filters", "look", "about"] as const;

function showPane(name: (typeof PANES)[number]) {
  PANES.forEach((p) => {
    document.querySelector<HTMLElement>(`#pane-${p}`)!.hidden = p !== name;
  });
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.pane === name);
  });
}

document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => showPane(btn.dataset.pane as (typeof PANES)[number]));
});

document.querySelector<HTMLButtonElement>("#open-settings")!.addEventListener("click", () => {
  siteHere.textContent = "";
  showView("settings");
  showPane("bringback");
});

document.querySelector<HTMLButtonElement>("#settings-back")!.addEventListener("click", () => {
  showView("launcher");
});

// ---------- onboarding (his 2026-10-27, #35: three steps) ----------
// Welcome, the demo (skippable), what to blur, the look, done. The blur step asks what to blur (his
// 2026-10-27), never the user's own gender: no fourth step. No
// platform picker: the home screen's "Add a site" is where sites come in,
// so the first thing the app teaches is the browser, not one platform.
// The YouTube links and home-icon offers live in Settings -> Sites.

function runOnboarding(done: () => void) {
  showView("onboard");
  const steps = document.querySelectorAll<HTMLElement>(".ob-step");

  const count = document.querySelector<HTMLElement>("#ob-count")!;
  const back = document.querySelector<HTMLButtonElement>("#ob-back")!;
  const trail: string[] = [];

  function goto(step: string, remember = true) {
    const current = [...steps].find((el) => !el.hidden)?.dataset.step;
    if (remember && current) trail.push(current);
    steps.forEach((el) => {
      el.hidden = el.dataset.step !== step;
    });
    count.textContent = "";
    back.hidden = step === "welcome" || step === "done";
  }

  back.addEventListener("click", () => {
    const prev = trail.pop();
    if (prev) goto(prev, false);
  });
  // The demo replays from its busy state each time it is shown.
  const demo = document.querySelector<HTMLElement>("#ob-demo")!;
  function playDemo() {
    demo.classList.remove("play");
    void demo.offsetWidth;
    demo.classList.add("play");
  }
  document.querySelector<HTMLButtonElement>("#ob-start")!.addEventListener("click", () => {
    goto("demo");
    playDemo();
  });
  const afterDemo = () => goto("blur");
  document.querySelector<HTMLButtonElement>("#ob-skip-demo")!.addEventListener("click", afterDemo);
  document.querySelector<HTMLButtonElement>("#ob-demo-next")!.addEventListener("click", afterDemo);
  document.querySelector<HTMLButtonElement>("#ob-demo-replay")!.addEventListener("click", playDemo);

  // COMMIT ON REACHING "done", not on its button, so a reload there
  // (an Android link arrival navigates the webview) does not start over.
  function finish(choice: BlurChoice) {
    writeChosen(readChosen() ?? []);
    setChoice(choice);
    goto("look");
  }

  document.querySelectorAll<HTMLButtonElement>("#ob-blur-cards .ob-card").forEach((btn) => {
    btn.addEventListener("click", () => finish(btn.dataset.choice as BlurChoice));
  });
  document.querySelector<HTMLButtonElement>("#ob-look-next")!.addEventListener("click", () =>
    goto(IOS ? "home" : "done"));
  document.querySelector<HTMLButtonElement>("#ob-home-next")!.addEventListener("click", () => {
    dismissIosHome();
    goto("done");
  });
  document.querySelector<HTMLButtonElement>("#ob-home-later")!.addEventListener("click", () => goto("done"));

  document.querySelector<HTMLButtonElement>("#ob-open")!.addEventListener("click", () => done());

  goto("welcome", false);
}

// ---------- startup ----------

// On Android cold start this module can run before the Rust side has
// finished registering the webview, and the first invoke dies with an
// ACL error ("platforms not allowed. Plugin not found") — seen
// intermittently on emulator cold boots (probe19, 2026-08-19). The
// window is tens of milliseconds wide, so a short bounded retry rides
// it out; a real failure still surfaces after the last attempt.
async function invokeStartup<T>(cmd: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await invoke<T>(cmd);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

let allPlatforms: Platform[] = [];
// The last Sites render, so a caller can wait for it instead of starting
// a second one that would interleave its rows with this one's.
let bringBackReady: Promise<void> = Promise.resolve();

// THE TODAY LINE (2026-10-27 redesign): the calm made visible. The count
// is the requests the block rules stopped today, kept by MainActivity on
// this phone; where there is no such bridge (desktop) the card stays out.
const today = document.querySelector<HTMLElement>("#today")!;

function renderToday(chosen: string[]) {
  const stats = (window as unknown as { TsStats?: { stoppedToday(): number } }).TsStats;
  if (!stats) {
    today.hidden = true;
    return;
  }
  let n = 0;
  try {
    n = Number(stats.stoppedToday()) || 0;
  } catch {
    today.hidden = true;
    return;
  }
  const tamed = allPlatforms.filter((p) => p.ready && chosen.includes(p.id)).length;
  today.querySelector(".today-num")!.textContent = n.toLocaleString();
  today.querySelector(".today-text")!.textContent =
    n === 1 ? "ad or tracker stopped today" : "ads and trackers stopped today";
  today.querySelector(".today-sub")!.textContent =
    n === 0
      ? "Open a site and watch this climb."
      : tamed > 0
        ? `Feeds hidden on ${tamed} of your sites.`
        : "Add a site to tame its feeds too.";
  today.hidden = false;
}

function refreshAll() {
  const chosen = readChosen() ?? [];
  renderGreeting();
  renderTiles(allPlatforms, chosen);
  renderToday(chosen);
  renderManage(allPlatforms);
  renderLinksCard();
  bringBackReady = renderBringBack(allPlatforms.filter((p) => p.ready && chosen.includes(p.id)));
}

// THE TOP BAR INSIDE A SITE (his 2026-10-27, #33). MainActivity draws it
// natively above every site and sends its taps here: ?search=<page> opens
// home with the box holding that page's address, selected, the way a
// browser's address bar works; ?settings=<page> opens Settings -> Sites
// at that page's site.
function barRequest(): { kind: "search" | "settings"; page: string } | null {
  const params = new URLSearchParams(location.search);
  for (const kind of ["search", "settings"] as const) {
    const page = params.get(kind);
    if (page !== null) return { kind, page };
  }
  return null;
}

function platformForPage(page: string): Platform | undefined {
  const bare = bareHost;
  let host = "";
  try {
    host = bare(new URL(page).hostname);
  } catch {
    return undefined;
  }
  return allPlatforms.find((p) => {
    try {
      const own = bare(new URL(p.url).hostname);
      return host === own || host.endsWith(`.${own}`);
    } catch {
      return false;
    }
  });
}

async function openSiteSettings(page: string) {
  showView("settings");
  showPane("bringback");
  await bringBackReady;
  const platform = platformForPage(page);
  const details = platform
    ? bringBack.querySelector<HTMLDetailsElement>(`details[data-platform="${platform.id}"]`)
    : null;
  if (details) {
    details.open = true;
    details.scrollIntoView({ block: "start" });
    return;
  }
  // A site we don't tame: say what still works there, and offer it as a tile.
  const site = siteFromInput(page);
  if (site && !platform) renderSiteHere(site);
}

const siteHere = document.querySelector<HTMLElement>("#site-here")!;

function renderSiteHere(site: Site) {
  siteHere.textContent = "";
  const card = document.createElement("section");
  card.className = "card";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = site.host;
  const body = document.createElement("p");
  body.className = "card-body";
  body.textContent = "Blur and ad blocking work here. We don't hide this site's feeds.";
  const actions = document.createElement("div");
  actions.className = "actions";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn-ghost";
  const paint = () => {
    const added = readSites().some((s) => s.host === site.host);
    add.textContent = added ? "In your sites" : "Add to your sites";
    add.disabled = added;
  };
  add.addEventListener("click", () => {
    addSite(site);
    refreshAll();
    paint();
  });
  paint();
  actions.append(add);
  card.append(title, body, actions);
  siteHere.append(card);
}

// Home-screen shortcut or link launch (Android). Cold start: MainActivity
// can't win the URL race against wry's initial load, so the pending
// platform is PULLED from a one-shot JavascriptInterface bridge. Warm
// start (onNewIntent) navigates here with ?open=<id> instead. A link
// (1107) rides beside the id: cold start as "id" + newline + url from the
// bridge, warm start as ?open=id&url=... Rust decides whether the url
// belongs to the platform. Read ONCE, before any view is painted.
function pendingRequest(): { id: string; url: string } | null {
  const bridge = (window as unknown as { TsShortcuts?: { consume(): string } })
    .TsShortcuts;
  let requested = "";
  try {
    requested = bridge?.consume() ?? "";
  } catch {
    // bridge absent (desktop) or blocked — fall through to the param
  }
  let url = "";
  if (requested.includes(NEWLINE)) {
    const [id, u] = requested.split(NEWLINE);
    requested = id;
    url = u ?? "";
  }
  if (!requested) {
    const params = new URLSearchParams(location.search);
    requested = params.get("open") ?? "";
    url = params.get("url") ?? "";
  }
  return requested ? { id: requested, url } : null;
}

const handoff = document.querySelector<HTMLElement>("#handoff")!;

// THE LAUNCHER PAINTS FROM THE LAST RUN, THEN CATCHES UP (his 2026-10-22:
// "instead of that loading, if we could have already preloaded the
// screen ... that would make it feel more instantaneous"). The tiles used
// to wait on the `platforms` invoke, which on a cold start rides out the
// bridge-registration retry above, so he looked at an empty dark page
// first. The platform list only changes with a build, so the copy from
// the last run is the right picture; the real list replaces it the
// moment Rust answers.
const PLATFORMS_CACHE_KEY = "tamescroll.platforms";

function readCachedPlatforms(): Platform[] | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLATFORMS_CACHE_KEY) ?? "null");
    return Array.isArray(parsed) && parsed.length ? (parsed as Platform[]) : null;
  } catch {
    return null;
  }
}

async function start() {
  // A LINK OR SHORTCUT MUST NOT SHOW THE LAUNCHER FIRST (his 2026-09-10:
  // "it first shows the tamescroll page and then gets me to YouTube").
  // The pending request is read BEFORE any view is painted; when there
  // is one, the page stays on the dark handoff line until the platform
  // document replaces it.
  // A link shared from another app (not a site we tame) arrives as
  // ?open=search&url=<link> and fills the address box like the top bar.
  const request = pendingRequest();
  const shared = request?.id === "search" ? request : null;
  const pending = shared ? null : request;
  const bar = shared ? { kind: "search" as const, page: shared.url } : pending ? null : barRequest();

  // Only the plain launch paints early: a link or shortcut keeps its
  // handoff line, and a first run goes to onboarding, which needs the
  // real list.
  const cached = pending ? null : readCachedPlatforms();
  const chosenAtStart = readChosen();
  if (cached && chosenAtStart !== null) {
    allPlatforms = cached;
    showView("launcher");
    renderTiles(allPlatforms, chosenAtStart);
  }

  try {
    allPlatforms = await invokeStartup<Platform[]>("platforms");
    try {
      localStorage.setItem(PLATFORMS_CACHE_KEY, JSON.stringify(allPlatforms));
    } catch {
      /* the early paint is a nicety; the launcher works without it */
    }
    await seedDefaultShown(allPlatforms.map((p) => p.id));

    const handoffTarget = pending
      ? allPlatforms.find((p) => p.id === pending.id && p.ready)
      : undefined;

    const chosen = readChosen();
    if (handoffTarget) {
      handoff.hidden = false;
      handoff.textContent = `Opening ${handoffTarget.name}…`;
    } else if (chosen === null) {
      runOnboarding(() => {
        showView("launcher");
        refreshAll();
      });
    } else {
      showView("launcher");
      refreshAll();
      if (bar) {
        history.replaceState(null, "", location.pathname);
        if (bar.kind === "search") {
          openLinkInput.value = bar.page;
          openLinkInput.focus();
          openLinkInput.select();
        } else {
          void openSiteSettings(bar.page);
        }
      }
    }

    // THE RULE COUNT MUST NOT GATE THE APP (1107). rules_summary calls
    // engine() per platform, and engine() BUILDS the 152k-rule adblock
    // engine synchronously if it is not warm yet -- measured on his
    // phone: a cold youtu.be link sat on this launcher for 20 seconds
    // (page start :13, open_platform :33, "adblock engine warmed in
    // 25.3s" at :33). Every line below this one -- the shortcut, the
    // link -- waited on a caption. So the count is requested and nothing
    // waits for it. The "N rules active" caption it fed is gone (his
    // 2026-10-27: it read like a log line); the call stays because it
    // warms the engine before the first site is opened.
    restingStatus = "";
    status.textContent = "";
    void invoke<Record<string, number>>("rules_summary").catch(() => {});

    if (pending) {
      history.replaceState(null, "", location.pathname);
      if (handoffTarget) {
        // The user created this platform's home-screen icon or sent it a
        // link — an explicit choice, so it also brings the platform in.
        const current = readChosen() ?? [];
        if (!current.includes(handoffTarget.id)) {
          writeChosen([...current, handoffTarget.id]);
        }
        // The launcher is rendered underneath so a failed open lands on
        // a real page; it stays hidden while the handoff line shows.
        refreshAll();
        void open(handoffTarget, pending.url || undefined).finally(() => {
          // Desktop keeps this document; Android replaces it. Either way
          // the line has done its job once open() has resolved.
          if (!isAndroid) { handoff.hidden = true; showView("launcher"); }
        });
      } else {
        showView("launcher");
        refreshAll();
      }
    }
  } catch (error) {
    showView("launcher");
    status.textContent = `Could not load your sites: ${String(error)}`;
  }
}

void start();
