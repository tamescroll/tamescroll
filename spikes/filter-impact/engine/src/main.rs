//! Decision server for the filter-impact bench (spikes/filter-impact).
//!
//! Builds an adblock-rust engine from the repo's own rules/ files the way
//! app/src-tauri/src/rules.rs does, then answers one JSON request per
//! stdin line:
//!   {"op":"net","url":..,"src":..,"type":..} -> {"block":bool}
//!   {"op":"cos","url":..}                    -> {"css":..,"js":..}
//!
//! Arms (first argument):
//!   play  vendor lists only (EasyList, EasyPrivacy, uBO filters, quick
//!         fixes, unbreak) + Brave resources + our GENERIC scriptlets.
//!         No rules/scriptlets.txt, no YouTube-only scriptlets, no
//!         youtube.txt `ads` surface. What a Play build would ship.
//!   full  play + rules/scriptlets.txt + our two YouTube-only scriptlets
//!         + youtube.txt's `ads` surface: today's build, Ads blocked.
//! Second argument: path to the repo root.
use adblock::lists::{FilterSet, ParseOptions};
use adblock::resources::{MimeType, PermissionMask, Resource, ResourceType};
use adblock::Engine;
use base64::Engine as _;
use std::io::{BufRead, Write};
use std::path::Path;

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

const GENERIC: &[(&str, &[&str])] = &[
    ("set-constant.js", &["set.js"]),
    ("json-prune.js", &[]),
    ("json-prune-fetch-response.js", &[]),
    ("trusted-replace-fetch-response.js", &[]),
    ("trusted-replace-xhr-response.js", &[]),
];
// Our two YouTube-only scriptlets (trusted-set-request-field,
// trusted-prune-window-json) were dropped 2026-11-21; the "full" arm is
// now the lists plus youtube.txt's ads surface. Check out 7d51929 to
// re-run the arm as it was measured.
const YOUTUBE_ONLY: &[(&str, &[&str])] = &[];

/// `domain##selector` lines of youtube.txt's `ads` surface.
fn youtube_ads_surface(root: &Path) -> Vec<(String, String)> {
    let text = read(root, "rules/youtube.txt");
    let mut on = false;
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("!surface:") {
            on = rest.trim().starts_with("ads ");
            continue;
        }
        if !on || l.is_empty() || l.starts_with('!') {
            continue;
        }
        if let Some((d, s)) = l.split_once("##") {
            out.push((d.to_string(), s.to_string()));
        }
    }
    out
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|x| x.1).unwrap_or(url);
    rest.split(['/', '?', '#', ':']).next().unwrap_or("")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arm = args.get(1).map(String::as_str).unwrap_or("play");
    let root = Path::new(args.get(2).map(String::as_str).unwrap_or("../.."));
    let full = arm == "full";

    let mut lists = vec![
        "rules/vendor/easylist.txt",
        "rules/vendor/easyprivacy.txt",
        "rules/vendor/ubo-filters.txt",
        "rules/vendor/ubo-quick-fixes.txt",
        "rules/vendor/ubo-unbreak.txt",
    ];
    if full {
        lists.insert(0, "rules/scriptlets.txt");
    }
    let t0 = std::time::Instant::now();
    let mut set = FilterSet::new(false);
    for l in &lists {
        set.add_filter_list(read(root, l), ParseOptions::default());
    }
    let mut engine = Engine::new_with_filter_set(set);
    let mut res: Vec<Resource> =
        serde_json::from_str(&read(root, "rules/vendor/resources.json")).expect("resources.json");
    let mut ours: Vec<&(&str, &[&str])> = GENERIC.iter().collect();
    if full {
        ours.extend(YOUTUBE_ONLY.iter());
    }
    for (name, aliases) in ours {
        let body = read(root, &format!("app/src-tauri/scriptlets/{name}"));
        res.push(Resource {
            name: name.to_string(),
            aliases: aliases.iter().map(|a| a.to_string()).collect(),
            kind: ResourceType::Mime(MimeType::ApplicationJavascript),
            content: base64::engine::general_purpose::STANDARD.encode(body.as_bytes()),
            dependencies: Vec::new(),
            permission: PermissionMask::default(),
        });
    }
    engine.use_resources(res);
    let yt_ads = if full { youtube_ads_surface(root) } else { Vec::new() };
    eprintln!("engine {arm} built in {} ms", t0.elapsed().as_millis());
    println!("{{\"ready\":true,\"buildMs\":{}}}", t0.elapsed().as_millis());

    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let url = v["url"].as_str().unwrap_or("");
        let reply = match v["op"].as_str() {
            Some("net") => {
                let src = v["src"].as_str().unwrap_or("");
                let ty = v["type"].as_str().unwrap_or("other");
                let block = adblock::request::Request::new(url, src, ty, "GET")
                    .map(|r| engine.check_network_request(&r).should_block())
                    .unwrap_or(false);
                serde_json::json!({ "block": block })
            }
            Some("cos") => {
                let r = engine.url_cosmetic_resources(url);
                let mut sels: Vec<&String> = r.hide_selectors.iter().collect();
                sels.sort();
                let mut css = String::new();
                for s in sels {
                    css.push_str(s);
                    css.push_str(" { display: none !important; }\n");
                }
                let host = host_of(url);
                for (d, s) in &yt_ads {
                    if host == d || host.ends_with(&format!(".{d}")) {
                        css.push_str(s);
                        css.push_str(" { display: none !important; }\n");
                    }
                }
                serde_json::json!({ "css": css, "js": r.injected_script, "nSel": r.hide_selectors.len() })
            }
            _ => serde_json::json!({}),
        };
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
    }
}
