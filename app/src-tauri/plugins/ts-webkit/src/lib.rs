//! iOS WebKit hooks for tamescroll (#16).
//!
//! Android gets its page hooks from MainActivity (WebViewClient, JS
//! bridges). iOS has no MainActivity: the WKWebView belongs to Tauri, and
//! the only supported way to reach it is a mobile plugin, whose Swift half
//! receives the webview in `load(webview:)`. Everything here is a no-op on
//! every other platform, so the shared code can call it unconditionally.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ts_webkit);

#[cfg(target_os = "ios")]
struct Handle<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ts-webkit")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_ts_webkit)?;
                _app.manage(Handle(handle));
            }
            Ok(())
        })
        // The Home pill and the window.close() override send the page to
        // http(s)://tauri.localhost/, which is the launcher's origin on
        // Android and Windows. On iOS the launcher lives at
        // tauri://localhost, so the request is turned around here, the
        // way MainActivity's shouldOverrideUrlLoading does it on Android.
        .on_navigation(|_webview, _url| {
            #[cfg(target_os = "ios")]
            if _url.host_str() == Some("tauri.localhost") {
                let webview = _webview.clone();
                let _ = _webview.app_handle().run_on_main_thread(move || {
                    if let Ok(home) = "tauri://localhost/".parse() {
                        let _ = webview.navigate(home);
                    }
                });
                return false;
            }
            true
        })
        .build()
}

/// Replaces tamescroll's document-start script.
///
/// WebKit runs user scripts at document start on every navigation, which
/// is what the rules need: scriptlets have to be in place before the
/// page's own scripts read the ad payload. Android gets the same timing
/// from onPageStarted; on iOS the page-load "Started" event fires before
/// the new document exists, so an eval there lands in the OLD page.
/// Tauri's own user scripts (IPC, init scripts) are kept as they are.
#[allow(unused_variables)]
pub fn set_page_script<R: Runtime, M: tauri::Manager<R>>(
    manager: &M,
    source: String,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        #[derive(serde::Serialize)]
        struct Args {
            source: String,
        }
        let handle = manager
            .try_state::<Handle<R>>()
            .ok_or_else(|| "ts-webkit not initialised".to_string())?;
        return handle
            .0
            .run_mobile_plugin::<()>("setPageScript", Args { source })
            .map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Ok(())
}

/// Hands WebKit the network block list (a JSON file at `path`) under
/// `id`. WebKit compiles it once and keeps the compiled form, so a later
/// start with the same id only looks it up. Lists stored under any other
/// id are deleted. Blocks until WebKit has the list or has refused it.
#[allow(unused_variables)]
pub fn prepare_blocker<R: Runtime, M: tauri::Manager<R>>(
    manager: &M,
    id: String,
    path: String,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        #[derive(serde::Serialize)]
        struct Args {
            id: String,
            path: String,
        }
        let handle = manager
            .try_state::<Handle<R>>()
            .ok_or_else(|| "ts-webkit not initialised".to_string())?;
        return handle
            .0
            .run_mobile_plugin::<()>("prepareBlocker", Args { id, path })
            .map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Ok(())
}

/// Turns network blocking on or off for the pages that follow: the
/// per-platform Ads switch (#23) set to Shown means no blocking at all.
#[allow(unused_variables)]
pub fn set_blocking<R: Runtime, M: tauri::Manager<R>>(manager: &M, on: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        #[derive(serde::Serialize)]
        struct Args {
            on: bool,
        }
        let handle = manager
            .try_state::<Handle<R>>()
            .ok_or_else(|| "ts-webkit not initialised".to_string())?;
        return handle
            .0
            .run_mobile_plugin::<()>("setBlocking", Args { on })
            .map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Ok(())
}

/// Runs `source` in the current page and writes what it returns (or the
/// error) to the file at `path`. For the CI job only: the simulator has
/// no web inspector, so this is how it reads the page's own state.
#[allow(unused_variables)]
pub fn eval_to_file<R: Runtime, M: tauri::Manager<R>>(
    manager: &M,
    source: String,
    path: String,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        #[derive(serde::Serialize)]
        struct Args {
            source: String,
            path: String,
        }
        let handle = manager
            .try_state::<Handle<R>>()
            .ok_or_else(|| "ts-webkit not initialised".to_string())?;
        return handle
            .0
            .run_mobile_plugin::<()>("evalToFile", Args { source, path })
            .map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Ok(())
}
