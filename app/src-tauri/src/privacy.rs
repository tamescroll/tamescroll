//! PRIVACY ON EVERY SITE (#81).
//!
//! The one place that knows which link parameters are tracking and which
//! switches the Privacy settings flip. Everything that cleans a link --
//! the address box, a shared link, a link tapped inside a page, the
//! address the menu copies or shares -- asks `clean` here, so the list
//! exists exactly once. Kotlin reaches it over JNI (`nativeCleanUrl`) and
//! keeps no copy of its own.
//!
//! The list is deliberately short and boring: parameters whose only job
//! is to say "this click came from that ad, mail or share". Anything a
//! site could need to show the page (YouTube's v, t, list and index,
//! Google's q, a search's page number, an OAuth `state`) is never here,
//! and `clean_link_keeps_what_a_site_needs` is the test that says so.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// Exact names, compared lower-case.
pub(crate) const TRACKING_PARAMS: &[&str] = &[
    // ad networks and social click ids
    "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "twclid", "ttclid",
    "yclid", "li_fat_id", "rb_clickid", "wickedid",
    // mail platforms
    "mc_eid", "mc_cid", "_hsenc", "_hsmi", "oly_anon_id", "oly_enc_id", "vero_id", "s_cid",
    // share buttons
    "igshid", "igsh",
];

/// Any name starting with one of these (UTM campaign tags).
pub(crate) const TRACKING_PREFIXES: &[&str] = &["utm_"];

/// YouTube's `si` names who shared the link. On any other site `si` can
/// be an ordinary parameter, so it goes only here.
const YOUTUBE_ONLY: &[&str] = &["si"];

static BLOCK_TRACKERS: AtomicBool = AtomicBool::new(true);
static CLEAN_LINKS: AtomicBool = AtomicBool::new(true);
static GPC: AtomicBool = AtomicBool::new(true);
/// Links Rust cleaned itself (the address box and shared links never pass
/// through Kotlin's navigation hook). Kotlin drains it into its weekly
/// count with `take_cleaned`.
static CLEANED_PENDING: AtomicU32 = AtomicU32::new(0);

/// Tests that flip the switches take this, so they cannot interleave.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn set_switches(block_trackers: bool, clean_links: bool, gpc: bool) {
    BLOCK_TRACKERS.store(block_trackers, Ordering::Relaxed);
    CLEAN_LINKS.store(clean_links, Ordering::Relaxed);
    GPC.store(gpc, Ordering::Relaxed);
}

pub(crate) fn block_trackers() -> bool {
    BLOCK_TRACKERS.load(Ordering::Relaxed)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn gpc() -> bool {
    GPC.load(Ordering::Relaxed)
}

pub(crate) fn clean_links() -> bool {
    CLEAN_LINKS.load(Ordering::Relaxed)
}

pub(crate) fn take_cleaned() -> u32 {
    CLEANED_PENDING.swap(0, Ordering::Relaxed)
}

fn is_youtube(host: &str) -> bool {
    ["youtube.com", "youtu.be"].iter().any(|r| host == *r || host.ends_with(&format!(".{r}")))
}

fn is_tracking(key: &str, host: &str) -> bool {
    let key = key.to_ascii_lowercase();
    TRACKING_PARAMS.contains(&key.as_str())
        || TRACKING_PREFIXES.iter().any(|p| key.starts_with(p))
        || (YOUTUBE_ONLY.contains(&key.as_str()) && is_youtube(host))
}

/// The lower-case host of an http(s) url, or None for anything else.
fn http_host(url: &str) -> Option<String> {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        return None;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// The url with its tracking parameters removed, and how many went.
/// Nothing else is touched: the rest of the text comes back byte for byte
/// (no re-encoding), a url with nothing to remove comes back unchanged,
/// and anything that is not http(s) is left alone.
pub(crate) fn clean(url: &str) -> (String, usize) {
    let Some(host) = http_host(url) else { return (url.to_string(), 0) };
    let (before, fragment) = match url.split_once('#') {
        Some((b, f)) => (b, Some(f)),
        None => (url, None),
    };
    let Some((base, query)) = before.split_once('?') else { return (url.to_string(), 0) };
    let mut kept: Vec<&str> = Vec::new();
    let mut removed = 0;
    for part in query.split('&') {
        let key = part.split('=').next().unwrap_or("");
        if is_tracking(key, &host) {
            removed += 1;
        } else {
            kept.push(part);
        }
    }
    if removed == 0 {
        return (url.to_string(), 0);
    }
    let mut out = base.to_string();
    if !kept.is_empty() {
        out.push('?');
        out.push_str(&kept.join("&"));
    }
    if let Some(f) = fragment {
        out.push('#');
        out.push_str(f);
    }
    (out, removed)
}

/// `clean` behind the switch, for navigations Rust starts itself. A link
/// that lost something is counted for the week (`take_cleaned`).
pub(crate) fn clean_for_navigation(url: &str) -> String {
    if !clean_links() {
        return url.to_string();
    }
    let (out, removed) = clean(url);
    if removed > 0 {
        CLEANED_PENDING.fetch_add(1, Ordering::Relaxed);
    }
    out
}

/// Whether `url` is a different site from the page that asked for it,
/// by the same rule the block lists use.
pub(crate) fn is_third_party(url: &str, source_url: &str) -> bool {
    adblock::request::Request::new(url, source_url, "other", "GET")
        .map(|r| r.is_third_party)
        .unwrap_or(false)
}

/// Opens `url` in the main webview with `Sec-GPC: 1` on the request, when
/// Ask sites not to sell my data is on: `WebView.loadUrl(url, headers)`,
/// the one way Android lets an app add a header to a top-level load.
/// Returns false when the switch is off or the load could not be handed
/// over, and the caller navigates the ordinary way.
#[cfg(target_os = "android")]
pub(crate) fn load_with_gpc<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>, url: &tauri::Url) -> bool {
    if !gpc() {
        return false;
    }
    let target = url.to_string();
    win.with_webview(move |webview| {
        webview.jni_handle().exec(move |env, _activity, view| {
            let sent = (|| -> jni::errors::Result<()> {
                let map = env.new_object("java/util/HashMap", "()V", &[])?;
                let key = env.new_string("Sec-GPC")?;
                let one = env.new_string("1")?;
                env.call_method(
                    &map,
                    "put",
                    "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
                    &[(&key).into(), (&one).into()],
                )?;
                let page = env.new_string(&target)?;
                env.call_method(view, "loadUrl", "(Ljava/lang/String;Ljava/util/Map;)V", &[(&page).into(), (&map).into()])?;
                Ok(())
            })();
            if sent.is_err() {
                // Without the header, but never without the page.
                let _ = env.exception_clear();
                if let Ok(page) = env.new_string(&target) {
                    let _ = env.call_method(view, "loadUrl", "(Ljava/lang/String;)V", &[(&page).into()]);
                }
            }
        });
    })
    .is_ok()
}

#[cfg(target_os = "android")]
mod jni_bridge {
    use jni::objects::{JClass, JString};
    use jni::sys::{jboolean, jint, jstring};
    use jni::JNIEnv;

    fn get(env: &mut JNIEnv, s: &JString) -> Option<String> {
        env.get_string(s).ok().map(|v| v.into())
    }

    /// The cleaned url, or null when there was nothing to clean (or the
    /// Clean links switch is off): the caller keeps what it had.
    #[no_mangle]
    pub extern "system" fn Java_app_tamescroll_client_MainActivity_nativeCleanUrl(
        mut env: JNIEnv,
        _class: JClass,
        url: JString,
    ) -> jstring {
        let Some(u) = get(&mut env, &url) else { return std::ptr::null_mut() };
        let out = std::panic::catch_unwind(|| {
            if !super::clean_links() {
                return None;
            }
            let (c, n) = super::clean(&u);
            (n > 0).then_some(c)
        })
        .unwrap_or(None);
        match out {
            Some(c) => env.new_string(c).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut()),
            None => std::ptr::null_mut(),
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_app_tamescroll_client_MainActivity_nativeSetPrivacy(
        _env: JNIEnv,
        _class: JClass,
        block_trackers: jboolean,
        clean_links: jboolean,
        gpc: jboolean,
    ) {
        super::set_switches(block_trackers != 0, clean_links != 0, gpc != 0);
    }

    #[no_mangle]
    pub extern "system" fn Java_app_tamescroll_client_MainActivity_nativeIsThirdParty(
        mut env: JNIEnv,
        _class: JClass,
        url: JString,
        source_url: JString,
    ) -> jboolean {
        let (Some(u), Some(s)) = (get(&mut env, &url), get(&mut env, &source_url)) else { return 0 };
        std::panic::catch_unwind(|| super::is_third_party(&u, &s)).unwrap_or(false) as jboolean
    }

    #[no_mangle]
    pub extern "system" fn Java_app_tamescroll_client_MainActivity_nativeTakeCleaned(
        _env: JNIEnv,
        _class: JClass,
    ) -> jint {
        super::take_cleaned() as jint
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cleaned(u: &str) -> String {
        clean(u).0
    }

    #[test]
    fn clean_link_strips_every_listed_param() {
        for p in TRACKING_PARAMS {
            let url = format!("https://example.com/page?a=1&{p}=xyz&b=2");
            assert_eq!(cleaned(&url), "https://example.com/page?a=1&b=2", "{p} survived");
        }
        assert_eq!(cleaned("https://example.com/?utm_source=x&utm_medium=y&utm_campaign=z"), "https://example.com/");
        assert_eq!(cleaned("https://example.com/?UTM_Source=x&FBCLID=1&q=ok"), "https://example.com/?q=ok");
    }

    #[test]
    fn clean_link_keeps_what_a_site_needs() {
        for u in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "https://m.youtube.com/watch?v=abc&list=PL123&index=3",
            "https://youtu.be/abc?t=10",
            "https://www.google.com/search?q=cats&hl=en&start=10",
            "https://duckduckgo.com/?q=cats&kp=1",
            "https://example.com/oauth?state=abc&code=123&redirect_uri=https%3A%2F%2Fx.com",
            "https://example.com/p?id=7&page=2#section",
            "https://example.com/p?sid=1&signal=2&utmost=3",
        ] {
            let (out, n) = clean(u);
            assert_eq!(out, u, "changed a link a site needs");
            assert_eq!(n, 0);
        }
    }

    #[test]
    fn clean_link_strips_around_what_a_site_needs() {
        assert_eq!(
            cleaned("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=AbCdEf&t=42s&utm_source=share"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"
        );
        assert_eq!(cleaned("https://youtu.be/abc?si=xyz&t=10"), "https://youtu.be/abc?t=10");
        assert_eq!(
            cleaned("https://m.youtube.com/watch?list=PL1&index=2&v=abc&si=q"),
            "https://m.youtube.com/watch?list=PL1&index=2&v=abc"
        );
        assert_eq!(cleaned("https://www.google.com/search?q=cats&gclid=abc"), "https://www.google.com/search?q=cats");
    }

    #[test]
    fn clean_link_si_is_youtube_only() {
        assert_eq!(cleaned("https://example.com/?si=1&q=2"), "https://example.com/?si=1&q=2");
        assert_eq!(cleaned("https://notyoutube.com/?si=1"), "https://notyoutube.com/?si=1");
        assert_eq!(cleaned("https://music.youtube.com/watch?v=a&si=b"), "https://music.youtube.com/watch?v=a");
        assert_eq!(cleaned("http://user@YouTube.com:443/watch?v=a&si=b"), "http://user@YouTube.com:443/watch?v=a");
    }

    #[test]
    fn clean_link_keeps_fragment_and_rest_byte_for_byte() {
        assert_eq!(
            cleaned("https://example.com/a%20b/?q=a%26b+c&fbclid=1#frag?x=1&fbclid=2"),
            "https://example.com/a%20b/?q=a%26b+c#frag?x=1&fbclid=2"
        );
        // Nothing to remove: the exact text comes back, quirks and all.
        assert_eq!(cleaned("https://example.com/?a=1&&b=%zz&c"), "https://example.com/?a=1&&b=%zz&c");
    }

    #[test]
    fn clean_link_leaves_other_schemes_and_junk_alone() {
        for u in ["", "not a url", "javascript:alert(1)?fbclid=1", "intent://x?fbclid=1", "mailto:a@b.c?utm_source=x", "ftp://x.com/?fbclid=1"] {
            assert_eq!(cleaned(u), u);
        }
    }

    #[test]
    fn clean_link_counts_what_it_removed() {
        assert_eq!(clean("https://e.com/?fbclid=1&utm_source=a&utm_medium=b&x=1").1, 3);
        assert_eq!(clean("https://e.com/?x=1").1, 0);
    }

    #[test]
    fn clean_for_navigation_follows_its_switch_and_counts_once_per_link() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_switches(true, true, true);
        take_cleaned();
        assert_eq!(clean_for_navigation("https://e.com/?fbclid=1&utm_source=a"), "https://e.com/");
        assert_eq!(clean_for_navigation("https://e.com/?x=1"), "https://e.com/?x=1");
        assert_eq!(take_cleaned(), 1, "one link cleaned, not one per parameter");
        assert_eq!(take_cleaned(), 0);
        set_switches(true, false, true);
        assert_eq!(clean_for_navigation("https://e.com/?fbclid=1"), "https://e.com/?fbclid=1");
        assert_eq!(take_cleaned(), 0);
        set_switches(true, true, true);
    }

    #[test]
    fn third_party_follows_the_site_not_the_host() {
        assert!(is_third_party("https://tracker.example.net/p.gif", "https://news.example.com/story"));
        assert!(!is_third_party("https://static.example.com/a.js", "https://news.example.com/story"));
        assert!(!is_third_party("not a url", "also not"));
    }
}
