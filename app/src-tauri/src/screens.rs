//! OVER-THE-AIR SCREENS (his 2026-11-25: "why are we having to bump the
//! versions again and again? Can't we do OTA updates?").
//!
//! The app's own screens -- home, settings, library, links, the tour --
//! are the Vite build in `app/dist`, which `generate_context!` seals into
//! the binary. This module puts a layer in front of that sealed copy: a
//! newer, SIGNED copy of the same files, published from CI to the
//! `screens` branch, is served instead when one exists for this exact
//! build. Everything else stays where it was:
//!
//! * Only the app's own screens travel. Nothing that runs inside YouTube
//!   or any other site does (CLAUDE.md, "CODE MAY NEVER TRAVEL OVER OTA";
//!   scriptlets, the gaze bundle and the page scripts are all still
//!   compiled in). The Kotlin bar over a site is native and needs a build.
//! * A bundle names the ONE build it was made against (`for_build`), so a
//!   phone on another build never runs screens that expect native code it
//!   does not have, and a new build always starts from its own sealed copy.
//! * TAMPER CHECK: the manifest carries an Ed25519 signature made by a key
//!   that lives only in the repo's Actions secrets; this binary holds the
//!   public half. Every file is then checked against the manifest's
//!   SHA-256, at download AND at every load.
//! * FALLBACK: a bundle that has not yet proven itself must call
//!   `screens_ready` within READY_WINDOW of its page loading. If it does
//!   not, the app drops back to the sealed copy for the rest of the run
//!   and reloads the launcher; a second miss marks it bad for good.
//!   Any error anywhere here means "use the sealed copy" -- the sealed
//!   screens are never touched, so the worst case is the old screens.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use base64::Engine as _;
use serde::Deserialize;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Manager, Wry};

use crate::ota::sha256_hex;

/// The raw branch the publish workflow (`.github/workflows/screens.yml`)
/// writes to. A branch of its own keeps the bundles' history off `main`.
const DEFAULT_BASE_URL: &str = "https://raw.githubusercontent.com/tamescroll/tamescroll/screens/";

/// Public half of the screens signing key (`scripts/screens-keygen.mjs`).
/// The private half exists only as the `SCREENS_SIGNING_KEY` Actions
/// secret and in the gitignored `secrets/` folder on his PC.
const PUBLIC_KEY_HEX: &str = "35b0b858a58ec8d3947d0c5618a11804d4fad48a5764466b9e62ce199c8935c9";

/// How long a not-yet-proven bundle has, from its page being served, to
/// report that it started. main.ts reports right after its first paint,
/// which takes well under a second even on the old Redmi.
const READY_WINDOW: Duration = Duration::from_secs(15);

/// Misses before a bundle is marked bad for good. One miss already drops
/// it for the rest of that run; the second stops it being tried again.
const STRIKES_TO_BAN: u32 = 2;

/// Manifest format this build understands. A future format is ignored.
const FORMAT: u64 = 1;

/// The key every manifest is checked against. Tests sign with their own.
fn public_key() -> String {
    #[cfg(test)]
    if let Ok(k) = std::env::var("TS_SCREENS_TEST_KEY") {
        return k;
    }
    PUBLIC_KEY_HEX.to_string()
}

pub fn base_url() -> String {
    std::env::var("TAMESCROLL_SCREENS_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileEntry {
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub format: u64,
    pub for_build: u64,
    /// Publish time in unix seconds; a bundle replaces another only if
    /// its seq is higher.
    pub seq: u64,
    /// The commit the screens were built from; read by people looking
    /// at a phone's cache, not by the app.
    #[serde(default)]
    #[allow(dead_code)]
    pub commit: String,
    /// A published "go back to the sealed screens" (the workflow's
    /// disable switch): phones drop their bundle and serve the binary's.
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub files: BTreeMap<String, FileEntry>,
}

/// Checks the signature over the EXACT manifest bytes, then parses. The
/// signature file is base64 of the 64-byte Ed25519 signature.
pub fn verify_manifest(json: &[u8], sig_b64: &str, public_key_hex: &str) -> Result<Manifest, String> {
    use ed25519_dalek::{Signature, VerifyingKey};
    let key_bytes: [u8; 32] = hex32(public_key_hex).ok_or("bad public key")?;
    if key_bytes == [0u8; 32] {
        return Err("no screens key in this build".into());
    }
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|e| e.to_string())?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(sig_b64.trim())
        .map_err(|e| e.to_string())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| e.to_string())?;
    key.verify_strict(json, &sig).map_err(|_| "signature does not match".to_string())?;
    let m: Manifest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    for (name, f) in &m.files {
        if !safe_name(name) {
            return Err(format!("unsafe file name {name}"));
        }
        if f.sha256.len() != 64 || !f.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("bad hash for {name}"));
        }
    }
    Ok(m)
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Manifest names are dist-relative paths ("index.html",
/// "assets/index-abc.js"). Nothing absolute, nothing climbing out.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && name.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

/// What a signed, verified manifest means for THIS build. Pure, tested.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Not for this build, older than what we run, or banned: ignore.
    Ignore(&'static str),
    /// Drop any bundle and serve the sealed screens.
    UseSealed,
    /// A newer bundle to fetch and use.
    Take,
}

pub fn judge(m: &Manifest, this_build: u64, active_seq: Option<u64>, banned: &[u64]) -> Verdict {
    if m.format != FORMAT {
        return Verdict::Ignore("unknown format");
    }
    if m.for_build != this_build {
        return Verdict::Ignore("made for another build");
    }
    if banned.contains(&m.seq) {
        return Verdict::Ignore("marked bad on this phone");
    }
    if m.disabled {
        return if active_seq.is_some() { Verdict::UseSealed } else { Verdict::Ignore("already on the sealed screens") };
    }
    if !m.files.contains_key("index.html") {
        return Verdict::Ignore("no index.html");
    }
    match active_seq {
        Some(s) if s >= m.seq => Verdict::Ignore("already running this or newer"),
        _ => Verdict::Take,
    }
}

// ---------------------------------------------------------------- state

/// A loaded bundle: only the files that DIFFER from the sealed copy are
/// held; anything else resolves to the sealed file of the same name.
struct Bundle {
    seq: u64,
    files: HashMap<String, Arc<Vec<u8>>>,
    /// Every name the manifest lists. A name it does not list is not part
    /// of this bundle and falls through to the sealed copy.
    names: std::collections::HashSet<String>,
    proven: AtomicBool,
}

struct State {
    active: Option<Arc<Bundle>>,
    /// The bundle replaced during this run, kept so a page that loaded
    /// its HTML from it can still fetch the scripts that HTML names.
    previous: Option<Arc<Bundle>>,
}

static STATE: RwLock<State> = RwLock::new(State { active: None, previous: None });
static SEALED: OnceLock<Box<dyn tauri::Assets<Wry>>> = OnceLock::new();
static DIR: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle<Wry>> = OnceLock::new();
static WATCHING: Mutex<Option<u64>> = Mutex::new(None);
static REFRESH_LOCK: Mutex<()> = Mutex::new(());

fn sealed_file(name: &str) -> Option<Vec<u8>> {
    let key = AssetKey::from(name);
    SEALED.get()?.get(&key).map(|c| c.into_owned())
}

/// The asset provider the app is built with: bundle first, the replaced
/// bundle second, the sealed copy last.
pub struct ScreenAssets;

impl tauri::Assets<Wry> for ScreenAssets {
    fn setup(&self, app: &tauri::App<Wry>) {
        let _ = APP.set(app.handle().clone());
        if let Ok(dir) = app.path().app_data_dir() {
            let dir = dir.join("screens-cache");
            let _ = DIR.set(dir.clone());
            load_cached(&dir);
        }
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let name = key.as_ref().trim_start_matches('/');
        let (active, previous) = {
            let s = STATE.read().unwrap();
            (s.active.clone(), s.previous.clone())
        };
        if name == "index.html" {
            if let Some(b) = &active {
                watch(b);
            }
        }
        // The replaced bundle never serves a page, only the files a page
        // already loaded from it may still name (hashed scripts, styles).
        let previous = previous.filter(|_| name != "index.html");
        for b in [&active, &previous].into_iter().flatten() {
            if let Some(bytes) = b.files.get(name) {
                return Some(Cow::Owned(bytes.as_ref().clone()));
            }
            if b.names.contains(name) {
                break; // listed and identical to the sealed file
            }
        }
        SEALED.get()?.get(key)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        match SEALED.get() {
            Some(s) => s.iter(),
            None => Box::new(std::iter::empty()),
        }
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        match SEALED.get() {
            Some(s) => s.csp_hashes(html_path),
            None => Box::new(std::iter::empty()),
        }
    }
}

/// Wraps the context's sealed assets. Call before `.build(ctx)`.
pub fn install(ctx: &mut tauri::Context<Wry>) {
    let sealed = ctx.set_assets(Box::new(ScreenAssets));
    let _ = SEALED.set(sealed);
}

/// For the diagnostics line: which screens are showing.
pub fn current() -> String {
    match &STATE.read().unwrap().active {
        Some(b) => format!("ota-{}", b.seq),
        None => "built-in".into(),
    }
}

/// main.ts calls this once it has painted. Proves the active bundle.
pub fn mark_ready() {
    let Some(b) = STATE.read().unwrap().active.clone() else { return };
    if b.proven.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(dir) = DIR.get() {
        let _ = std::fs::write(dir.join("proven"), b.seq.to_string());
        let _ = std::fs::remove_file(dir.join("strikes"));
    }
}

/// The page of an unproven bundle was just served: give it READY_WINDOW
/// to report in, once per bundle per run.
fn watch(b: &Arc<Bundle>) {
    if b.proven.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut w = WATCHING.lock().unwrap();
        if *w == Some(b.seq) {
            return;
        }
        *w = Some(b.seq);
    }
    let b = b.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_WINDOW);
        if b.proven.load(Ordering::SeqCst) {
            return;
        }
        strike(b.seq);
        {
            let mut s = STATE.write().unwrap();
            if s.active.as_ref().is_some_and(|a| a.seq == b.seq) {
                s.previous = s.active.take();
            }
        }
        reload_launcher();
    });
}

fn strike(seq: u64) {
    let Some(dir) = DIR.get() else { return };
    let path = dir.join("strikes");
    let n = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| {
            let (s, n) = t.trim().split_once(' ')?;
            (s.parse::<u64>().ok()? == seq).then(|| n.parse::<u32>().ok()).flatten()
        })
        .unwrap_or(0)
        + 1;
    let _ = std::fs::write(&path, format!("{seq} {n}"));
    if n >= STRIKES_TO_BAN {
        let mut banned = read_banned(dir);
        banned.push(seq);
        let list: Vec<String> = banned.iter().map(|s| s.to_string()).collect();
        let _ = std::fs::write(dir.join("banned"), list.join("\n"));
        let _ = std::fs::remove_file(dir.join("current.json"));
        let _ = std::fs::remove_file(dir.join("current.sig"));
    }
}

fn read_banned(dir: &Path) -> Vec<u64> {
    std::fs::read_to_string(dir.join("banned"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect()
}

/// Reloads the main webview only if it is showing the launcher, never a
/// site the user is reading.
fn reload_launcher() {
    let Some(app) = APP.get() else { return };
    let Some(main) = app.get_webview_window("main") else { return };
    let on_launcher = main
        .url()
        .map(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
        .unwrap_or(false);
    if on_launcher {
        let _ = main.eval("location.reload()");
    }
}

fn blob_path(dir: &Path, sha: &str) -> PathBuf {
    dir.join("blobs").join(sha)
}

/// Builds a Bundle from a verified manifest, taking each file from the
/// sealed copy when it matches, else from `fetch` (cache or network).
/// Every byte is checked against the manifest hash.
fn assemble(m: &Manifest, mut fetch: impl FnMut(&str) -> Result<Vec<u8>, String>) -> Result<Bundle, String> {
    let mut files = HashMap::new();
    for (name, f) in &m.files {
        if let Some(sealed) = sealed_file(name) {
            if sha256_hex(&sealed) == f.sha256 {
                continue;
            }
        }
        let bytes = fetch(&f.sha256)?;
        if sha256_hex(&bytes) != f.sha256 {
            return Err(format!("{name}: hash mismatch"));
        }
        files.insert(name.clone(), Arc::new(bytes));
    }
    Ok(Bundle {
        seq: m.seq,
        files,
        names: m.files.keys().cloned().collect(),
        proven: AtomicBool::new(false),
    })
}

fn this_build() -> u64 {
    crate::appupdate::CURRENT_VERSION_CODE
}

/// Startup: the bundle saved by an earlier run, re-verified end to end.
fn load_cached(dir: &Path) {
    let (Ok(json), Ok(sig)) = (
        std::fs::read(dir.join("current.json")),
        std::fs::read_to_string(dir.join("current.sig")),
    ) else {
        return;
    };
    let Ok(m) = verify_manifest(&json, &sig, &public_key()) else { return };
    if m.for_build != this_build() {
        // Another build's bundle (the app was updated): start clean.
        let _ = std::fs::remove_dir_all(dir);
        return;
    }
    if judge(&m, this_build(), None, &read_banned(dir)) != Verdict::Take {
        return;
    }
    let Ok(b) = assemble(&m, |sha| std::fs::read(blob_path(dir, sha)).map_err(|e| e.to_string())) else {
        return;
    };
    let proven = std::fs::read_to_string(dir.join("proven"))
        .is_ok_and(|t| t.trim().parse::<u64>().ok() == Some(m.seq));
    b.proven.store(proven, Ordering::SeqCst);
    STATE.write().unwrap().active = Some(Arc::new(b));
}

fn http_bytes(url: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    resp.into_reader()
        .take(16 * 1024 * 1024)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Checks the screens branch and takes a newer bundle for this build.
/// Called with the rules refresh (launch, every 24h, the About button).
/// The new screens show the next time the launcher page loads.
pub fn refresh() -> Result<String, String> {
    let _guard = REFRESH_LOCK.lock().unwrap();
    let dir = DIR.get().cloned().ok_or("not set up")?;
    let base = base_url();
    let json = http_bytes(&format!("{base}manifest.json"))?;
    let sig = String::from_utf8(http_bytes(&format!("{base}manifest.sig"))?).map_err(|e| e.to_string())?;
    let m = verify_manifest(&json, &sig, &public_key())?;
    let active_seq = STATE.read().unwrap().active.as_ref().map(|b| b.seq);
    match judge(&m, this_build(), active_seq, &read_banned(&dir)) {
        Verdict::Ignore(why) => Ok(format!("screens: {why}")),
        Verdict::UseSealed => {
            let _ = std::fs::remove_file(dir.join("current.json"));
            let _ = std::fs::remove_file(dir.join("current.sig"));
            let mut s = STATE.write().unwrap();
            s.previous = s.active.take();
            Ok("screens: back to built-in".into())
        }
        Verdict::Take => {
            std::fs::create_dir_all(dir.join("blobs")).map_err(|e| e.to_string())?;
            let b = assemble(&m, |sha| {
                let cached = blob_path(&dir, sha);
                if let Ok(bytes) = std::fs::read(&cached) {
                    if sha256_hex(&bytes) == sha {
                        return Ok(bytes);
                    }
                }
                let bytes = http_bytes(&format!("{base}blobs/{sha}"))?;
                if sha256_hex(&bytes) != sha {
                    return Err("download hash mismatch".into());
                }
                std::fs::write(&cached, &bytes).map_err(|e| e.to_string())?;
                Ok(bytes)
            })?;
            // Only once every file verified: point the cache at it.
            std::fs::write(dir.join("current.json"), &json).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("current.sig"), &sig).map_err(|e| e.to_string())?;
            let mut s = STATE.write().unwrap();
            s.previous = s.active.take();
            s.active = Some(Arc::new(b));
            Ok(format!("screens: updated to {}", m.seq))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn key() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk: String = sk.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        (sk, pk)
    }

    fn signed(json: &str, sk: &SigningKey) -> String {
        base64::engine::general_purpose::STANDARD.encode(sk.sign(json.as_bytes()).to_bytes())
    }

    const GOOD: &str = r#"{"format":1,"for_build":1150,"seq":100,"commit":"abc","files":{"index.html":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}"#;

    #[test]
    fn a_signed_manifest_verifies_and_a_touched_one_does_not() {
        let (sk, pk) = key();
        let sig = signed(GOOD, &sk);
        let m = verify_manifest(GOOD.as_bytes(), &sig, &pk).expect("verifies");
        assert_eq!(m.for_build, 1150);
        let touched = GOOD.replace("1150", "1151");
        assert!(verify_manifest(touched.as_bytes(), &sig, &pk).is_err());
        // Another key's signature is refused too.
        let other = SigningKey::from_bytes(&[8u8; 32]);
        assert!(verify_manifest(GOOD.as_bytes(), &signed(GOOD, &other), &pk).is_err());
        // And a build with no key refuses everything.
        assert!(verify_manifest(GOOD.as_bytes(), &sig, &"0".repeat(64)).is_err());
    }

    #[test]
    fn names_that_climb_out_are_refused_even_when_signed() {
        let (sk, pk) = key();
        for bad in ["../x", "/etc/x", "a/../../x", "a\\b", "a//b"] {
            let json = GOOD.replace("index.html", bad).replace('\\', "\\\\");
            assert!(verify_manifest(json.as_bytes(), &signed(&json, &sk), &pk).is_err(), "{bad}");
        }
    }

    fn manifest(build: u64, seq: u64, disabled: bool) -> Manifest {
        let mut files = BTreeMap::new();
        files.insert("index.html".into(), FileEntry { sha256: "a".repeat(64) });
        Manifest { format: 1, for_build: build, seq, commit: String::new(), disabled, files }
    }

    #[test]
    fn a_bundle_only_runs_on_the_build_it_was_made_for() {
        assert_eq!(judge(&manifest(1150, 5, false), 1150, None, &[]), Verdict::Take);
        assert!(matches!(judge(&manifest(1149, 5, false), 1150, None, &[]), Verdict::Ignore(_)));
        assert!(matches!(judge(&manifest(1151, 5, false), 1150, None, &[]), Verdict::Ignore(_)));
    }

    #[test]
    fn only_a_newer_unbanned_bundle_replaces_the_running_one() {
        assert_eq!(judge(&manifest(1150, 6, false), 1150, Some(5), &[]), Verdict::Take);
        assert!(matches!(judge(&manifest(1150, 5, false), 1150, Some(5), &[]), Verdict::Ignore(_)));
        assert!(matches!(judge(&manifest(1150, 4, false), 1150, Some(5), &[]), Verdict::Ignore(_)));
        assert!(matches!(judge(&manifest(1150, 6, false), 1150, None, &[6]), Verdict::Ignore(_)));
        let mut future = manifest(1150, 6, false);
        future.format = 2;
        assert!(matches!(judge(&future, 1150, None, &[]), Verdict::Ignore(_)));
    }

    #[test]
    fn the_disable_switch_returns_to_the_sealed_screens() {
        assert_eq!(judge(&manifest(1150, 9, true), 1150, Some(5), &[]), Verdict::UseSealed);
        assert!(matches!(judge(&manifest(1150, 9, true), 1150, None, &[]), Verdict::Ignore(_)));
    }

    /// Stands in for the binary's sealed screens.
    struct FakeSealed(HashMap<String, Vec<u8>>);
    impl tauri::Assets<Wry> for FakeSealed {
        fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
            self.0.get(key.as_ref().trim_start_matches('/')).map(|b| Cow::Borrowed(b.as_slice()))
        }
        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(std::iter::empty())
        }
        fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::empty())
        }
    }

    /// One-thread HTTP server: path -> body, 404 for anything else, and
    /// a log of every path asked for.
    fn serve(routes: Arc<Mutex<HashMap<String, Vec<u8>>>>, log: Arc<Mutex<Vec<String>>>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Write};
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut line = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let _ = reader.read_line(&mut line);
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) <= 2 {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
                log.lock().unwrap().push(path.clone());
                let body = routes.lock().unwrap().get(&path).cloned();
                let (status, body) = match body {
                    Some(b) => ("200 OK", b),
                    None => ("404 Not Found", b"nope".to_vec()),
                };
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(&body);
            }
        });
        base
    }

    /// The whole path a phone takes: a signed bundle on the server ->
    /// refresh -> the launcher is served the new page, unchanged files
    /// come from the sealed copy without being downloaded -> a restart
    /// restores it from the cache -> the disable switch -> two missed
    /// starts ban it.
    #[test]
    fn end_to_end_download_serve_restore_disable_and_ban() {
        let (sk, pk) = key();
        std::env::set_var("TS_SCREENS_TEST_KEY", &pk);
        let font = b"FONT-BYTES".to_vec();
        let mut sealed = HashMap::new();
        sealed.insert("index.html".to_string(), b"<html>old</html>".to_vec());
        sealed.insert("assets/font.woff2".to_string(), font.clone());
        let _ = SEALED.set(Box::new(FakeSealed(sealed)));
        let dir = std::env::temp_dir().join(format!("ts-screens-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = DIR.set(dir.clone());

        let page = b"<html>new</html>".to_vec();
        let js = b"console.log('new')".to_vec();
        let build = this_build();
        let manifest = format!(
            r#"{{"format":1,"for_build":{build},"seq":200,"files":{{"index.html":{{"sha256":"{}"}},"assets/font.woff2":{{"sha256":"{}"}},"assets/new.js":{{"sha256":"{}"}}}}}}"#,
            sha256_hex(&page), sha256_hex(&font), sha256_hex(&js)
        );
        let routes = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut r = routes.lock().unwrap();
            r.insert("manifest.json".to_string(), manifest.clone().into_bytes());
            r.insert("manifest.sig".to_string(), signed(&manifest, &sk).into_bytes());
            r.insert(format!("blobs/{}", sha256_hex(&page)), page.clone());
            r.insert(format!("blobs/{}", sha256_hex(&js)), js.clone());
        }
        let log = Arc::new(Mutex::new(Vec::new()));
        std::env::set_var("TAMESCROLL_SCREENS_URL", serve(routes.clone(), log.clone()));

        let get = |name: &str| <ScreenAssets as tauri::Assets<Wry>>::get(&ScreenAssets, &AssetKey::from(name)).map(|c| c.into_owned());
        assert_eq!(get("index.html").unwrap(), b"<html>old</html>");
        assert_eq!(refresh().unwrap(), "screens: updated to 200");
        assert_eq!(get("index.html").unwrap(), page);
        assert_eq!(get("assets/new.js").unwrap(), js);
        assert_eq!(get("assets/font.woff2").unwrap(), font);
        assert!(
            !log.lock().unwrap().iter().any(|p| p.contains(&sha256_hex(&font))),
            "a file identical to the sealed one must not be downloaded"
        );
        assert_eq!(current(), "ota-200");
        assert_eq!(refresh().unwrap(), "screens: already running this or newer");

        // A restart: state gone, cache restored and re-verified.
        STATE.write().unwrap().active = None;
        load_cached(&dir);
        assert_eq!(get("index.html").unwrap(), page);
        mark_ready();
        assert_eq!(std::fs::read_to_string(dir.join("proven")).unwrap(), "200");

        // A cached blob that was altered on disk fails the restore.
        std::fs::write(blob_path(&dir, &sha256_hex(&js)), b"tampered").unwrap();
        STATE.write().unwrap().active = None;
        load_cached(&dir);
        assert_eq!(get("index.html").unwrap(), b"<html>old</html>");
        std::fs::write(blob_path(&dir, &sha256_hex(&js)), &js).unwrap();
        load_cached(&dir);
        assert_eq!(current(), "ota-200");

        // A tampered manifest on the server is refused; the bundle stays.
        let evil = manifest.replace("\"seq\":200", "\"seq\":300");
        routes.lock().unwrap().insert("manifest.json".to_string(), evil.into_bytes());
        assert!(refresh().is_err());
        assert_eq!(current(), "ota-200");

        // The disable switch.
        let off = format!(r#"{{"format":1,"for_build":{build},"seq":400,"disabled":true}}"#);
        {
            let mut r = routes.lock().unwrap();
            r.insert("manifest.json".to_string(), off.clone().into_bytes());
            r.insert("manifest.sig".to_string(), signed(&off, &sk).into_bytes());
        }
        assert_eq!(refresh().unwrap(), "screens: back to built-in");
        assert_eq!(get("index.html").unwrap(), b"<html>old</html>");
        assert_eq!(current(), "built-in");
        assert!(!dir.join("current.json").exists());

        // Two missed starts ban a bundle and drop it from the cache.
        {
            let mut r = routes.lock().unwrap();
            r.insert("manifest.json".to_string(), manifest.clone().into_bytes());
            r.insert("manifest.sig".to_string(), signed(&manifest, &sk).into_bytes());
        }
        assert_eq!(refresh().unwrap(), "screens: updated to 200");
        strike(200);
        assert!(read_banned(&dir).is_empty());
        strike(200);
        assert_eq!(read_banned(&dir), vec![200]);
        assert!(!dir.join("current.json").exists());
        STATE.write().unwrap().active = None;
        assert_eq!(refresh().unwrap(), "screens: marked bad on this phone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_does_not_match_its_hash_fails_the_whole_bundle() {
        let body = b"<html>new</html>".to_vec();
        let mut m = manifest(1150, 5, false);
        m.files.get_mut("index.html").unwrap().sha256 = sha256_hex(&body);
        let ok = assemble(&m, |_| Ok(body.clone())).expect("assembles");
        assert_eq!(ok.files["index.html"].as_slice(), body.as_slice());
        assert!(assemble(&m, |_| Ok(b"<html>evil</html>".to_vec())).is_err());
        assert!(assemble(&m, |_| Err("offline".into())).is_err());
    }
}
