//! Writes `extension/gen/engine.json`: for each site host the extension
//! serves, the vendor-list cosmetic selectors and the scriptlet code the
//! app's engine would inject there.
//!
//! The engine is built by `engine_inputs.rs`, the same file the app's
//! rules.rs uses, over the same list files, so the two cannot drift.
//! Run `node extension/build.mjs --compile` (or `cargo run --release --
//! <repo>/rules <out.json>` from this folder) after any vendor-list or
//! scriptlet change; CI fails when the committed file is stale.

#[path = "../../../app/src-tauri/src/engine_inputs.rs"]
#[allow(dead_code)]
mod engine_inputs;

use adblock::cosmetic_filter_cache::ProceduralOrActionFilter;
use serde_json::{json, Map, Value};

/// The page each host is asked about. Cosmetic results depend on the
/// host, not the path, so the root is enough.
const HOSTS: &[&str] = &[
    "www.youtube.com",
    "m.youtube.com",
    "www.reddit.com",
    "x.com",
    "www.instagram.com",
    "www.facebook.com",
    "www.tiktok.com",
    "www.twitch.tv",
    "www.linkedin.com",
    "www.pinterest.com",
];

// Keep in step with `hosts` in extension/src/sites.js (test/engine.test.mjs checks).

fn main() {
    let mut args = std::env::args().skip(1);
    let rules_dir = args.next().expect("usage: compile <rules dir> <out.json>");
    let out = args.next().expect("usage: compile <rules dir> <out.json>");

    let lists: Vec<String> = engine_inputs::ENGINE_LISTS
        .iter()
        .map(|name| {
            std::fs::read_to_string(format!("{rules_dir}/{name}"))
                .unwrap_or_else(|e| panic!("{rules_dir}/{name}: {e}"))
        })
        .collect();
    let engine = engine_inputs::build_engine_from_lists(&lists);

    let mut hosts = Map::new();
    for host in HOSTS {
        let res = engine.url_cosmetic_resources(&format!("https://{host}/"));
        let mut hide: Vec<String> = res.hide_selectors.into_iter().collect();
        hide.sort();
        let mut styles: Vec<(String, String)> = res
            .procedural_actions
            .iter()
            .filter_map(|encoded| serde_json::from_str::<ProceduralOrActionFilter>(encoded).ok())
            .filter_map(|filter| filter.as_css())
            .collect();
        styles.sort();
        hosts.insert(
            (*host).to_string(),
            json!({
                "hide": hide,
                "styles": styles,
                "script": res.injected_script,
            }),
        );
    }

    let doc = json!({
        "generatedBy": "extension/compile (adblock-rust 0.13.2 over rules/ via engine_inputs.rs)",
        "lists": engine_inputs::ENGINE_LISTS,
        "hosts": Value::Object(hosts),
    });
    let mut text = serde_json::to_string_pretty(&doc).expect("serialise");
    text.push('\n');
    std::fs::write(&out, text).unwrap_or_else(|e| panic!("{out}: {e}"));
    eprintln!("wrote {out}");
}
