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

/// adblock-rust appends one `try {\n<call>\n} catch ( e ) { }\n` block per
/// scriptlet call after the resource code, in hash-set order, so the same
/// lists gave a different script on every run and CI's "engine.json is
/// current" check failed at random. The calls are independent; peel them
/// off the end and put them back sorted.
fn stable_script(script: &str) -> String {
    const TAIL: &str = "\n} catch ( e ) { }\n";
    let mut rest = script;
    let mut calls: Vec<&str> = Vec::new();
    while rest.ends_with(TAIL) {
        let body_end = rest.len() - TAIL.len();
        let Some(start) = rest[..body_end].rfind("try {\n") else { break };
        let call = &rest[start + "try {\n".len()..body_end];
        if call.contains('\n') { break; } // not a one-line call block: stop
        calls.push(&rest[start..]);
        rest = &rest[..start];
    }
    calls.sort();
    // The resource code before the calls comes in hash order too. It is
    // only top-level function declarations (app/src-tauri/scriptlets/),
    // which hoist, so sorting them by their text changes nothing.
    let mut chunks: Vec<&str> = Vec::new();
    let mut head = rest;
    while let Some(i) = head.rfind("\nfunction ") {
        chunks.push(&head[i + 1..]);
        head = &head[..i + 1];
    }
    if head.starts_with("function ") { chunks.push(head); head = ""; }
    chunks.sort();
    let mut out = head.to_string();
    for c in chunks {
        out.push_str(c);
        if !c.ends_with('\n') { out.push('\n'); }
    }
    for c in calls { out.push_str(c); }
    out
}

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
                "script": stable_script(&res.injected_script),
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
