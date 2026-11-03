//! In-app update CHECK (owner ask 2026-08-23: stop re-sending the APK
//! over WhatsApp for every build). This module only ever READS a signed
//! manifest and decides whether a newer build exists — it never installs
//! anything. The actual download + install is Android-native
//! (MainActivity's UpdateBridge), gated behind the system installer's
//! own user confirmation, and the APK is pinned to the sha256 this
//! manifest carries. Desktop has no in-app install path (users pull the
//! desktop build from the release page); the check still returns so the
//! About pane can link out.
//!
//! Trust model: the manifest URL is fixed (below / env override for
//! tests), fetched over https from the same GitHub raw host as the rules
//! OTA. The download URL and hash the installer uses come only from this
//! Rust-fetched manifest, never from page JavaScript — so the worst a
//! hostile platform page can do by poking the bridge is trigger a
//! hash-pinned, user-confirmed prompt to install the real app.

use serde::Serialize;

const DEFAULT_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/tamescroll/tamescroll/main/updates/app-manifest.json";

fn manifest_url() -> String {
    std::env::var("TAMESCROLL_UPDATE_URL").unwrap_or_else(|_| DEFAULT_MANIFEST_URL.to_string())
}

/// This build's Android versionCode. Kept in lockstep with
/// gen/android tauri.properties `tauri.android.versionCode` by the
/// release flow; the check compares the manifest against this.
pub const CURRENT_VERSION_CODE: u64 = 1137;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UpdateStatus {
    pub available: bool,
    #[serde(rename = "currentVersionCode")]
    pub current_version_code: u64,
    #[serde(rename = "versionCode")]
    pub version_code: u64,
    #[serde(rename = "versionName")]
    pub version_name: String,
    pub notes: String,
    #[serde(rename = "apkUrl")]
    pub apk_url: String,
    pub sha256: String,
}

fn up_to_date() -> UpdateStatus {
    UpdateStatus {
        available: false,
        current_version_code: CURRENT_VERSION_CODE,
        version_code: CURRENT_VERSION_CODE,
        version_name: String::new(),
        notes: String::new(),
        apk_url: String::new(),
        sha256: String::new(),
    }
}

/// Pure parse+compare, unit-testable without the network. A malformed or
/// older manifest yields `available: false` rather than an error — the
/// About pane must degrade to "you're up to date", never nag.
pub fn evaluate(manifest_json: &str, current: u64) -> Result<UpdateStatus, String> {
    let v: serde_json::Value =
        serde_json::from_str(manifest_json).map_err(|e| format!("manifest parse: {e}"))?;

    let version_code = v
        .get("versionCode")
        .and_then(|x| x.as_u64())
        .ok_or("manifest missing versionCode")?;
    let apk_url = v
        .get("apkUrl")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let sha256 = v
        .get("sha256")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let version_name = v
        .get("versionName")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let notes = v
        .get("notes")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    // A newer build only "counts" as installable if it actually carries
    // a URL and a hash — a manifest that bumps the number but omits
    // either can't be verified, so treat it as nothing to offer.
    let available = version_code > current && !apk_url.is_empty() && !sha256.is_empty();

    Ok(UpdateStatus {
        available,
        current_version_code: current,
        version_code,
        version_name,
        notes,
        apk_url,
        sha256,
    })
}

/// Fetches the manifest and evaluates it against this build. Any network
/// or parse failure degrades to "up to date" (Err is only returned for
/// the caller to log; the command wrapper turns it into up_to_date()).
pub fn check() -> UpdateStatus {
    match crate::ota::http_get(&manifest_url()).and_then(|j| evaluate(&j, CURRENT_VERSION_CODE)) {
        Ok(status) => status,
        Err(_) => up_to_date(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_manifest_with_url_and_hash_is_available() {
        let json = r#"{"versionCode":1001,"versionName":"0.1.1","apkUrl":"https://x/app.apk","sha256":"abc","notes":"fixes"}"#;
        let s = evaluate(json, 1000).unwrap();
        assert!(s.available);
        assert_eq!(s.version_code, 1001);
        assert_eq!(s.version_name, "0.1.1");
        assert_eq!(s.apk_url, "https://x/app.apk");
    }

    #[test]
    fn same_or_older_version_is_not_available() {
        let json = r#"{"versionCode":1000,"apkUrl":"https://x/app.apk","sha256":"abc"}"#;
        assert!(!evaluate(json, 1000).unwrap().available);
        let older = r#"{"versionCode":999,"apkUrl":"https://x/app.apk","sha256":"abc"}"#;
        assert!(!evaluate(older, 1000).unwrap().available);
    }

    #[test]
    fn newer_but_missing_url_or_hash_is_not_available() {
        let no_url = r#"{"versionCode":1001,"sha256":"abc"}"#;
        assert!(!evaluate(no_url, 1000).unwrap().available);
        let no_hash = r#"{"versionCode":1001,"apkUrl":"https://x/app.apk"}"#;
        assert!(!evaluate(no_hash, 1000).unwrap().available);
    }

    #[test]
    fn malformed_manifest_is_an_error_not_a_panic() {
        assert!(evaluate("not json", 1000).is_err());
        assert!(evaluate("{}", 1000).is_err()); // missing versionCode
    }
}
