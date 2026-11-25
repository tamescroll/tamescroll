//! The engine's INPUTS, shared by the app and the browser extension's
//! rule compiler (`extension/compile/`). Both sides call these same
//! functions over the same lists, so the extension's cosmetic CSS and
//! scriptlet code are what the app's engine would produce for the same
//! URL -- not a second reading of the lists (CLAUDE.md: an instrument
//! that re-derives a shipped rule is a check that cannot fail).
//!
//! Only `adblock` and `serde_json` may be used here, so the file compiles
//! inside both crates. Paths in `include_str!` are relative to this file.

use adblock::lists::{FilterSet, ParseOptions};
use adblock::resources::{MimeType, PermissionMask, Resource, ResourceType};
use adblock::Engine;

/// Brave's own scriptlet/redirect resources (MPL-2.0), already in the
/// exact JSON shape `adblock::resources::Resource` deserializes from.
/// Carries Brave's additions (de-amp, playback fixes, etc.) — not the
/// generic uBO scriptlet names; ours below cover those.
pub const BRAVE_RESOURCES_JSON: &str = include_str!("../../../rules/vendor/resources.json");

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
pub const SCRIPTLETS: &[(&str, &[&str], &str)] = &[
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

/// The lists the engine is compiled from, in order. Through the OTA
/// layer: an updated list snapshot wins over the embedded one on the
/// next rebuild.
pub const ENGINE_LISTS: [&str; 6] = [
    "scriptlets.txt",
    "vendor/easylist.txt",
    "vendor/easyprivacy.txt",
    "vendor/ubo-filters.txt",
    "vendor/ubo-quick-fixes.txt",
    "vendor/ubo-unbreak.txt",
];

pub fn build_engine_from_lists(lists: &[String]) -> Engine {
    let mut set = FilterSet::new(false);
    for text in lists {
        set.add_filter_list(text.clone(), ParseOptions::default());
    }
    let mut engine = Engine::new_with_filter_set(set);
    engine.use_resources(resources());
    engine
}

/// All scriptlet/redirect resources available to `+js(...)` filters:
/// Brave's own set, plus our clean-room implementations of the generic
/// names the lists call.
pub fn resources() -> Vec<Resource> {
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
pub fn base64_encode(data: &[u8]) -> String {
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
