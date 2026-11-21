//! Builds the adblock-rust engine from the vendored filter lists and
//! scriptlet resources. Split out of lib.rs because the list of vendored
//! files is long and only grows; lib.rs stays focused on the app shell.
//!
//! Everything here is compiled into the binary (`include_str!`), the same
//! convention `rules/youtube.txt` already used, so a shipped build never
//! reads these files off disk. Refresh the snapshots with
//! `node scripts/update-lists.mjs`; see rules/vendor/README.md.
//!
//! Scriptlets are OUR OWN clean-room implementations (MPL-2.0) in
//! `app/src-tauri/scriptlets/` — uBlock Origin's scriptlet file is GPLv3
//! and compiling GPL code into this MPL binary would both violate the
//! repo's licence rule (see NOTICE) and poison App Store distribution.
//! The filter LISTS below reference scriptlets by name; our resources
//! answer to those names.
//!
//! Our own three cosmetic files (youtube/reddit/x) are NOT fed into the
//! `FilterSet` below (Phase 3, docs/plan.md settings pane) — per-surface
//! "bring back" toggles need to turn individual selectors on and off,
//! which the engine's opaque cosmetic-filter cache does not support.
//! Instead `parse_surfaces` below reads the same files' `!surface: <id>
//! <Label>` markers and groups their rules by surface; lib.rs assembles
//! the CSS itself. Vendor lists and blur CSS are untouched by this split.

use std::sync::RwLock;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::resources::{MimeType, PermissionMask, Resource, ResourceType};
use adblock::Engine;

/// Our own cosmetic rules — algorithmic-surface removal, not ad blocking.
/// Each file's header carries the design rules that govern it. No longer
/// fed into the engine (see module doc); parsed into surfaces instead.
const YOUTUBE_RULES: &str = include_str!("../../../rules/youtube.txt");
const REDDIT_RULES: &str = include_str!("../../../rules/reddit.txt");
const X_RULES: &str = include_str!("../../../rules/x.txt");
const TIKTOK_RULES: &str = include_str!("../../../rules/tiktok.txt");
const INSTAGRAM_RULES: &str = include_str!("../../../rules/instagram.txt");
const FACEBOOK_RULES: &str = include_str!("../../../rules/facebook.txt");

/// Upstream filter lists. These block ads and trackers by network pattern
/// and cosmetic selector; the scriptlet resources below are what actually
/// let the `##+js(...)` rules inside them do anything.
const EASYLIST: &str = include_str!("../../../rules/vendor/easylist.txt");
const EASYPRIVACY: &str = include_str!("../../../rules/vendor/easyprivacy.txt");
const UBO_FILTERS: &str = include_str!("../../../rules/vendor/ubo-filters.txt");
const UBO_QUICK_FIXES: &str = include_str!("../../../rules/vendor/ubo-quick-fixes.txt");
const UBO_UNBREAK: &str = include_str!("../../../rules/vendor/ubo-unbreak.txt");

/// Brave's own scriptlet/redirect resources (MPL-2.0), already in the
/// exact JSON shape `adblock::resources::Resource` deserializes from.
/// Carries Brave's additions (de-amp, playback fixes, etc.) — not the
/// generic uBO scriptlet names; ours below cover those.
const BRAVE_RESOURCES_JSON: &str = include_str!("../../../rules/vendor/resources.json");

/// Stage A blur CSS (owned by lib.rs conceptually, embedded here so all
/// OTA-able rule files live in one lookup). resources.json and the
/// scriptlets are deliberately ABSENT from this map: they are CODE, and
/// code ships in the binary only (docs/rules-updates.md, store policy).
const BLUR_YOUTUBE: &str = include_str!("../../../rules/blur/youtube.css");
const BLUR_REDDIT: &str = include_str!("../../../rules/blur/reddit.css");
const BLUR_X: &str = include_str!("../../../rules/blur/x.css");
const BLUR_TIKTOK: &str = include_str!("../../../rules/blur/tiktok.css");
const BLUR_INSTAGRAM: &str = include_str!("../../../rules/blur/instagram.css");
const BLUR_FACEBOOK: &str = include_str!("../../../rules/blur/facebook.css");
const SCRIPTLET_RULES: &str = include_str!("../../../rules/scriptlets.txt");
pub const TUNING_JSON: &str = include_str!("../../../rules/tuning.json");

/// Every rules file the OTA layer may override, keyed by its
/// repo-relative name under `rules/` — the same names
/// `rules/manifest.json` uses. `None` for anything else, which is how
/// ota.rs knows a manifest entry is not for this build.
/// Every OTA-able rules file, in a fixed order. The one list; the
/// generation hash in ota.rs walks it, so a file added to `embedded`
/// and forgotten here would silently not affect the generation -- which
/// is what the test below is for.
pub const FILES: &[&str] = &[
    "youtube.txt",
    "reddit.txt",
    "x.txt",
    "tiktok.txt",
    "instagram.txt",
    "facebook.txt",
    "scriptlets.txt",
    "blur/youtube.css",
    "blur/reddit.css",
    "blur/x.css",
    "blur/tiktok.css",
    "blur/instagram.css",
    "blur/facebook.css",
    "vendor/easylist.txt",
    "vendor/easyprivacy.txt",
    "vendor/ubo-filters.txt",
    "vendor/ubo-quick-fixes.txt",
    "vendor/ubo-unbreak.txt",
];

pub fn embedded(name: &str) -> Option<&'static str> {
    match name {
        "youtube.txt" => Some(YOUTUBE_RULES),
        "reddit.txt" => Some(REDDIT_RULES),
        "x.txt" => Some(X_RULES),
        "tiktok.txt" => Some(TIKTOK_RULES),
        "instagram.txt" => Some(INSTAGRAM_RULES),
        "facebook.txt" => Some(FACEBOOK_RULES),
        "scriptlets.txt" => Some(SCRIPTLET_RULES),
        // NUMBERS, NOT CODE. Whitelisted and clamped page-side by
        // app/gaze/src/tuning.mjs; see the header there for why each
        // range is where it is.
        "tuning.json" => Some(TUNING_JSON),
        "blur/youtube.css" => Some(BLUR_YOUTUBE),
        "blur/reddit.css" => Some(BLUR_REDDIT),
        "blur/x.css" => Some(BLUR_X),
        "blur/tiktok.css" => Some(BLUR_TIKTOK),
        "blur/instagram.css" => Some(BLUR_INSTAGRAM),
        "blur/facebook.css" => Some(BLUR_FACEBOOK),
        "vendor/easylist.txt" => Some(EASYLIST),
        "vendor/easyprivacy.txt" => Some(EASYPRIVACY),
        "vendor/ubo-filters.txt" => Some(UBO_FILTERS),
        "vendor/ubo-quick-fixes.txt" => Some(UBO_QUICK_FIXES),
        "vendor/ubo-unbreak.txt" => Some(UBO_UNBREAK),
        _ => None,
    }
}

/// Our clean-room scriptlets. Function-style: the body starts with
/// `function name(` so adblock-rust injects the body once as a dependency
/// and emits `name(arg1, arg2, ...)` calls per matching filter rule, with
/// arguments properly quoted by the engine.
///
/// (name, aliases, body). Names and aliases carry the `.js` suffix
/// because the engine's lookup appends it to the name a filter uses —
/// `##+js(set, ...)` looks up `set.js`.
///
/// Coverage is deliberately the set the YouTube ad rules in
/// ubo-filters.txt actually call. Known-unimplemented names those lists
/// also reference (`trusted-json-edit-xhr-request`,
/// `trusted-prevent-dom-bypass`, `rpnt`, `rmnt`, `nano-stb`): their rules
/// are skipped silently by the engine — they are anti-detection
/// countermeasures, not the core ad strip. Add implementations here if
/// they ever become load-bearing.
const SCRIPTLETS: &[(&str, &[&str], &str)] = &[
    (
        "set-constant.js",
        &["set.js"],
        include_str!("../scriptlets/set-constant.js"),
    ),
    (
        "json-prune.js",
        &[],
        include_str!("../scriptlets/json-prune.js"),
    ),
    (
        "json-prune-fetch-response.js",
        &[],
        include_str!("../scriptlets/json-prune-fetch-response.js"),
    ),
    (
        "trusted-replace-fetch-response.js",
        &[],
        include_str!("../scriptlets/trusted-replace-fetch-response.js"),
    ),
    (
        "trusted-replace-xhr-response.js",
        &[],
        include_str!("../scriptlets/trusted-replace-xhr-response.js"),
    ),
    (
        // Our own request-editor (not a uBO name): sets one dotted field on
        // outbound JSON request bodies. Used on YouTube's /player request
        // (rules/scriptlets.txt). Clean-room from a public write-up.
        "trusted-set-request-field.js",
        &[],
        include_str!("../scriptlets/trusted-set-request-field.js"),
    ),
    (
        // Our own inline-JSON pruner (not a uBO name). Strips ad slots
        // out of the player response that YouTube EMBEDS in the watch
        // page HTML, before the page's own inline script assigns it.
        // Blocking requests cannot reach a pre-roll: its stream is
        // googlevideo.com, the same origin as the real video.
        "trusted-prune-window-json.js",
        &[],
        include_str!("../scriptlets/trusted-prune-window-json.js"),
    ),
];

/// Builds the engine the whole app shares: every vendored filter list
/// compiled in, plus the scriptlet resources those lists' `+js(...)`
/// filters need to actually produce injectable JavaScript.
pub fn build_engine() -> Engine {
    load_or_build_engine(crate::ota::cache_dir().as_deref())
}

/// The lists the engine is compiled from, in order. Through the OTA
/// layer: an updated list snapshot wins over the embedded one on the
/// next rebuild.
const ENGINE_LISTS: [&str; 6] = [
    "scriptlets.txt",
    "vendor/easylist.txt",
    "vendor/easyprivacy.txt",
    "vendor/ubo-filters.txt",
    "vendor/ubo-quick-fixes.txt",
    "vendor/ubo-unbreak.txt",
];

fn build_engine_from_lists(lists: &[String]) -> Engine {
    let mut set = FilterSet::new(false);
    for text in lists {
        set.add_filter_list(text.clone(), ParseOptions::default());
    }
    let mut engine = Engine::new_with_filter_set(set);
    engine.use_resources(resources());
    engine
}

/// THE COLD START PAID 3-25 SECONDS FOR THIS ON HIS PHONE (queue item h),
/// and paid it TWICE: the warm-up thread in `run()` and the rebuild after
/// the OTA cache loads each parse 152k rules from text. The engine can
/// serialise its compiled form, so a build is written next to the OTA
/// cache under a key that names exactly what went into it -- the crate
/// version, our version and the bytes of every list -- and the next
/// start deserialises instead. A key mismatch (new build, new OTA list)
/// falls through to a full build and replaces the file; a corrupt file
/// does the same. Resources are not part of the serialised form and are
/// re-attached either way.
pub(crate) fn load_or_build_engine(cache_dir: Option<&std::path::Path>) -> Engine {
    let lists: Vec<String> = ENGINE_LISTS.iter().map(|l| crate::ota::rules_text(l)).collect();
    let key = engine_key(&lists);
    let file = cache_dir.map(|d| d.join(format!("engine-{key}.bin")));

    if let Some(path) = &file {
        if let Ok(bytes) = std::fs::read(path) {
            let mut engine = Engine::default();
            if engine.deserialize(&bytes).is_ok() {
                engine.use_resources(resources());
                return engine;
            }
            let _ = std::fs::remove_file(path);
        }
    }

    let engine = build_engine_from_lists(&lists);
    if let (Some(path), Some(dir)) = (&file, cache_dir) {
        // Atomic: a half-written file must never be picked up by the
        // next start. Stale keys are pruned so the directory holds one.
        let tmp = path.with_extension("tmp");
        if std::fs::create_dir_all(dir).is_ok()
            && std::fs::write(&tmp, engine.serialize()).is_ok()
            && std::fs::rename(&tmp, path).is_ok()
        {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    let name = e.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("engine-") && name.ends_with(".bin") && e.path() != *path {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
    }
    engine
}

fn engine_key(lists: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(env!("CARGO_PKG_VERSION").as_bytes());
    h.update(b"|adblock-0.13.2|");
    for text in lists {
        h.update((text.len() as u64).to_le_bytes());
        h.update(text.as_bytes());
    }
    let digest = h.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// All scriptlet/redirect resources available to `+js(...)` filters:
/// Brave's own set, plus our clean-room implementations of the generic
/// names the lists call.
fn resources() -> Vec<Resource> {
    let mut resources: Vec<Resource> = serde_json::from_str(BRAVE_RESOURCES_JSON)
        .expect("rules/vendor/resources.json must deserialize into Vec<adblock::resources::Resource>");

    for (name, aliases, body) in SCRIPTLETS {
        resources.push(Resource {
            name: (*name).to_string(),
            aliases: aliases.iter().map(|a| (*a).to_string()).collect(),
            kind: ResourceType::Mime(MimeType::ApplicationJavascript),
            content: base64_encode(body.as_bytes()),
            dependencies: Vec::new(),
            // Default mask = usable from any list we compile in. The
            // `trusted-` names are safe here because every list is a
            // curated snapshot in this repo, not user-supplied input.
            permission: PermissionMask::default(),
        });
    }

    resources
}

/// Standard base64 (RFC 4648, with padding) — `Resource::content` must be
/// base64-encoded (adblock-rust decodes it with `BASE64_STANDARD`), and
/// pulling in a whole crate for this one call site isn't worth it.
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// One toggleable "bring back" surface (docs/plan.md Phase 3 settings
/// pane): a named group of cosmetic rules from one of our own rule files,
/// delimited by a `!surface: <id> <Human label>` marker line. `always_on`
/// surfaces are ad/promo surfaces the settings pane never offers a toggle
/// for — VISION.md: ad-hiding is never user-toggleable.
pub struct Surface {
    pub id: &'static str,
    pub label: &'static str,
    pub always_on: bool,
    /// Starts SHOWN on a fresh install; the toggle still exists and the
    /// user's own choice always wins once they make one.
    pub default_shown: bool,
    pub rules: Vec<(&'static str, &'static str)>,
}

/// Ad/promo/nag surface ids across all files. Kept as one list rather
/// than per-file because the marker convention is the same everywhere.
/// None has a toggle of its own: nags never come back, and `ads` and
/// `promoted` follow the per-platform ads switch (lib.rs ADS_SURFACE).
fn is_always_on(id: &str) -> bool {
    matches!(id, "ads" | "mobile_nags" | "promoted")
}

/// Surfaces that ship SHOWN. Owner, 2026-08-27, looking at a watch page
/// with an empty space where the related videos used to be: "no
/// recommendations did we remove them keep the option but don't disable
/// right on". Watch-page recommendations are not an algorithmic FEED --
/// they are how you get to the next video you actually chose -- so the
/// toggle stays and the default flips. Same list shape as is_always_on,
/// for the same reason: one convention, all files.
fn is_default_shown(id: &str) -> bool {
    // home_chips is the topic chip row on m.youtube home. It is the only
    // non-video, non-shelf thing on that page (censused over nine loads,
    // 2026-08-31) but it is a NAVIGATION control and the owner did not
    // name it, so it ships SHOWN: nothing on his home changes and he
    // gains a switch.
    matches!(id, "watch_recs" | "home_chips")
}

/// Parses one of our `!surface:`-annotated rule files into its surfaces.
/// Line-based on purpose — these are three small, well-controlled files,
/// not worth a regex crate for. A `!surface:` marker starts a surface;
/// every rule line (`domain##selector`) belongs to the most recent marker
/// until the next one. Comment and blank lines are otherwise ignored, and
/// a rule line before any marker is dropped rather than guessed at.
fn parse_surfaces(text: &'static str) -> Vec<Surface> {
    let mut surfaces: Vec<Surface> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("!surface:") {
            let rest = rest.trim();
            let (id, label) = rest.split_once(' ').unwrap_or((rest, ""));
            surfaces.push(Surface {
                id,
                label,
                always_on: is_always_on(id),
                default_shown: is_default_shown(id),
                rules: Vec::new(),
            });
            continue;
        }
        if line.is_empty() || line.starts_with('!') {
            continue;
        }
        if let Some((domain, selector)) = line.split_once("##") {
            if let Some(surface) = surfaces.last_mut() {
                surface.rules.push((domain.trim(), selector.trim()));
            }
        }
    }
    surfaces
}

/// Parsed once and cached, but REPLACEABLE: a rules OTA refresh calls
/// `rebuild_surfaces` to re-parse from the updated files. `Surface`
/// borrows `&'static str` throughout (call sites all over lib.rs rely on
/// it), so each rebuild leaks its parsed set via `Box::leak` — bounded
/// by design: at most one leak per refresh, refreshes happen at most a
/// few times a day, and each set is a few KB.
static SURFACES: RwLock<Option<&'static Vec<(&'static str, Vec<Surface>)>>> = RwLock::new(None);

fn build_surfaces() -> &'static Vec<(&'static str, Vec<Surface>)> {
    fn leaked(name: &str) -> &'static str {
        Box::leak(crate::ota::rules_text(name).into_boxed_str())
    }
    Box::leak(Box::new(vec![
        ("youtube", parse_surfaces(leaked("youtube.txt"))),
        ("reddit", parse_surfaces(leaked("reddit.txt"))),
        ("x", parse_surfaces(leaked("x.txt"))),
        ("tiktok", parse_surfaces(leaked("tiktok.txt"))),
        ("instagram", parse_surfaces(leaked("instagram.txt"))),
        ("facebook", parse_surfaces(leaked("facebook.txt"))),
    ]))
}

fn all_surfaces() -> &'static Vec<(&'static str, Vec<Surface>)> {
    if let Some(s) = *SURFACES.read().unwrap() {
        return s;
    }
    let built = build_surfaces();
    let mut w = SURFACES.write().unwrap();
    // A racing first caller may have won; keep theirs (ours leaks once).
    if w.is_none() {
        *w = Some(built);
    }
    w.unwrap()
}

/// Re-parses surfaces from the current (possibly OTA-overridden) rule
/// files. Called by the OTA layer after a successful refresh.
pub fn rebuild_surfaces() {
    let built = build_surfaces();
    *SURFACES.write().unwrap() = Some(built);
}

/// The toggleable surfaces for one platform id, or `None` for a platform
/// with no surface-annotated rule file (Instagram, TikTok).
pub fn platform_surfaces(platform_id: &str) -> Option<&'static Vec<Surface>> {
    all_surfaces()
        .iter()
        .find(|(id, _)| *id == platform_id)
        .map(|(_, surfaces)| surfaces)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A RULE WITHOUT A SURFACE ABOVE IT IS A RULE THAT DOES NOTHING.
    ///
    /// parse_surfaces attaches each `domain##selector` line to the most
    /// recent `!surface:` marker and DROPS anything before the first one,
    /// silently. rules/facebook.txt shipped its first draft that way:
    /// eleven selectors, zero surfaces, nothing applied, and a live probe
    /// that looked like it passed because the vendor lists match some of
    /// the same words. Every file we own is checked here, so a new one
    /// cannot repeat it.
    #[test]
    fn every_rule_we_own_belongs_to_a_surface() {
        for (id, _) in all_surfaces() {
            let file = format!("{id}.txt");
            let text = embedded(&file).unwrap_or_else(|| panic!("{file} must be embedded"));
            let mut seen_marker = false;
            let mut orphans = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                if line.starts_with("!surface:") {
                    seen_marker = true;
                    continue;
                }
                if line.is_empty() || line.starts_with('!') {
                    continue;
                }
                if line.contains("##") && !seen_marker {
                    orphans.push(line.to_string());
                }
            }
            assert!(orphans.is_empty(), "{file}: rules before any !surface: marker are dropped: {orphans:?}");
            // Parse the embedded file itself, not the process-wide set: the
            // OTA test swaps a youtube.txt with one extra rule into that set
            // while this runs (CI, 2026-10-27: "51 declared, 52 reached").
            let parsed: usize = parse_surfaces(text).iter().map(|s| s.rules.len()).sum();
            let declared = text
                .lines()
                .map(str::trim)
                .filter(|l| !l.starts_with('!') && l.contains("##"))
                .count();
            assert_eq!(parsed, declared, "{file}: {declared} rules declared, {parsed} reached a surface");
        }
    }


    /// The parser must actually find the sections youtube.txt declares,
    /// including one it must never let the settings pane toggle off.
    #[test]
    fn youtube_surfaces_parse_with_an_always_on_ads_surface() {
        let surfaces = platform_surfaces("youtube").expect("youtube should have surfaces");
        assert!(
            surfaces.len() >= 3,
            "expected at least 3 youtube surfaces, got {}",
            surfaces.len()
        );

        let ads = surfaces
            .iter()
            .find(|s| s.id == "ads")
            .expect("youtube should have an 'ads' surface");
        assert!(ads.always_on, "the youtube ads surface must be always_on");
        assert!(
            !ads.rules.is_empty(),
            "the ads surface should have parsed at least one rule"
        );

        let home = surfaces
            .iter()
            .find(|s| s.id == "home")
            .expect("youtube should have a 'home' surface");
        assert!(!home.always_on, "the home surface must be toggleable");
        assert!(!home.rules.is_empty(), "home surface should have rules");
    }

    /// reddit.txt and x.txt must parse too, and their ad/promo surfaces
    /// must come out always_on under the shared naming convention.
    #[test]
    fn reddit_and_x_surfaces_mark_ads_and_promoted_always_on() {
        let reddit = platform_surfaces("reddit").expect("reddit should have surfaces");
        let reddit_ads = reddit
            .iter()
            .find(|s| s.id == "ads")
            .expect("reddit should have an 'ads' surface");
        assert!(reddit_ads.always_on);

        let x = platform_surfaces("x").expect("x should have surfaces");
        let promoted = x
            .iter()
            .find(|s| s.id == "promoted")
            .expect("x should have a 'promoted' surface");
        assert!(promoted.always_on);

        let tiktok = platform_surfaces("tiktok").expect("tiktok should have surfaces");
        for id in ["foryou", "explore", "swipe", "suggested"] {
            let s = tiktok
                .iter()
                .find(|s| s.id == id)
                .unwrap_or_else(|| panic!("tiktok should have a '{id}' surface"));
            assert!(!s.always_on, "'{id}' must be user-toggleable");
            assert!(!s.rules.is_empty(), "'{id}' must carry rules");
        }
        let tt_promoted = tiktok
            .iter()
            .find(|s| s.id == "promoted")
            .expect("tiktok should have a 'promoted' surface");
        assert!(tt_promoted.always_on);
        // The m.youtube lesson, pinned: the feed-item element is shared
        // with the opened-video page, so the For You rule must stay
        // scoped to the homepage container and never hide the testid
        // bare.
        let foryou = tiktok.iter().find(|s| s.id == "foryou").unwrap();
        assert!(
            foryou.rules.iter().any(|(_, sel)| sel
                .contains(r#"[id^="main-content-homepage"] [data-e2e="recommend-list-item-container"]"#)),
            "For You feed rule must be scoped to the homepage container"
        );
        assert!(
            !tiktok.iter().any(|s| s
                .rules
                .iter()
                .any(|(_, sel)| sel.trim() == r#"[data-e2e="recommend-list-item-container"]"#)),
            "recommend-list-item-container must never be hidden unscoped — \
             it is also the video the user opened"
        );
    }
}

#[cfg(test)]
mod preview_surface_tests {
    /// The mobile preview rule must land in the `previews` surface, not
    /// somewhere else in the file — a live DOM read on 2026-08-27 showed
    /// the injected sheet carrying the DESKTOP selector and not the
    /// mobile one, so the question "is it parsed at all" needs an answer
    /// that does not depend on a running app.
    #[test]
    fn previews_surface_carries_both_desktop_and_mobile_selectors() {
        let surfaces = super::platform_surfaces("youtube").expect("youtube surfaces");
        let previews = surfaces
            .iter()
            .find(|s| s.id == "previews")
            .expect("previews surface");
        let sels: Vec<String> = previews
            .rules
            .iter()
            .map(|(d, s)| format!("{d}##{s}"))
            .collect();
        assert!(
            sels.iter().any(|r| r == "youtube.com##ytd-video-preview"),
            "desktop selector missing: {sels:?}"
        );
        assert!(
            sels.iter().any(|r| r == "m.youtube.com##ytm-video-preview"),
            "mobile selector missing: {sels:?}"
        );
    }

    #[test]
    fn home_chips_ships_shown_and_is_scoped_to_the_browse_page() {
        // CENSUSED over nine m.youtube home loads 2026-08-31: the only
        // things on home are ytm-rich-item-renderer (37, the videos),
        // ytm-rich-section-renderer (7, the shelves), this chip bar (4,
        // one per load) and ytm-continuation-item-renderer (4). The chip
        // bar is the whole of the owner's "etc." -- but it is a
        // NAVIGATION control and he did not name it, so hiding it by
        // default would change his home without being asked.
        let surfaces = super::platform_surfaces("youtube").expect("youtube surfaces");
        let chips = surfaces
            .iter()
            .find(|s| s.id == "home_chips")
            .expect("home_chips surface");
        assert!(
            chips.default_shown,
            "home_chips must ship SHOWN -- he did not ask for the chips to go"
        );
        let sels: Vec<String> = chips
            .rules
            .iter()
            .map(|(d, s)| format!("{d}##{s}"))
            .collect();
        assert_eq!(
            sels,
            vec!["m.youtube.com##ytm-browse ytm-feed-filter-chip-bar-renderer".to_string()],
            "only the measured mobile selector belongs here"
        );
        // Scoped to the browse page: search has its own chip bar and this
        // surface has nothing to say about it.
        assert!(sels[0].contains("ytm-browse "), "must stay scoped to browse");
    }
}

#[cfg(test)]
mod engine_cache_tests {
    use super::*;
    use adblock::request::Request;

    fn blocks(engine: &Engine) -> bool {
        let req = Request::new(
            "https://googleads.g.doubleclick.net/pagead/id",
            "https://m.youtube.com/watch?v=x",
            "script",
            "GET",
        )
        .unwrap();
        engine.check_network_request(&req).should_block()
    }

    /// Queue item h: the second start must READ the compiled engine, not
    /// rebuild it, and the read engine must decide like the built one.
    #[test]
    fn serialised_engine_is_reused_and_decides_the_same() {
        let dir = std::env::temp_dir().join(format!("ts-engine-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let built = load_or_build_engine(Some(&dir));
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(files.len(), 1, "one engine file, no tmp left behind");
        let path = files[0].path();
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("engine-"));
        let written = std::fs::metadata(&path).unwrap().modified().unwrap();

        let loaded = load_or_build_engine(Some(&dir));
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            written,
            "second call must not rewrite the file"
        );
        assert!(blocks(&built), "the built engine blocks a doubleclick script");
        assert_eq!(blocks(&loaded), blocks(&built));

        // A corrupt file is replaced, not trusted.
        std::fs::write(&path, b"garbage").unwrap();
        let rebuilt = load_or_build_engine(Some(&dir));
        assert!(std::fs::metadata(&path).unwrap().len() > 1000);
        assert_eq!(blocks(&rebuilt), blocks(&built));

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod engine_timing_probe {
    use super::*;
    #[test]
    #[ignore]
    fn where_the_seconds_go() {
        let t = std::time::Instant::now();
        let lists: Vec<String> = ENGINE_LISTS.iter().map(|l| crate::ota::rules_text(l)).collect();
        eprintln!("lists      {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let _k = engine_key(&lists);
        eprintln!("key        {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let r = resources();
        eprintln!("resources  {:?} ({} entries)", t.elapsed(), r.len());
        let t = std::time::Instant::now();
        let mut set = FilterSet::new(false);
        for text in &lists { set.add_filter_list(text.clone(), ParseOptions::default()); }
        eprintln!("parse      {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let mut e = Engine::new_with_filter_set(set);
        eprintln!("compile    {:?}", t.elapsed());
        let t = std::time::Instant::now();
        e.use_resources(r);
        eprintln!("use_res    {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let bytes = e.serialize();
        eprintln!("serialize  {:?} ({} bytes)", t.elapsed(), bytes.len());
        let t = std::time::Instant::now();
        let mut d = Engine::default();
        d.deserialize(&bytes).unwrap();
        eprintln!("deserialize{:?}", t.elapsed());
        let t = std::time::Instant::now();
        d.use_resources(resources());
        eprintln!("use_res2   {:?}", t.elapsed());
    }
}
