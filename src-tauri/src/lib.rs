// SiwcError carries a kind, a message and optional details for the UI, so it is larger than
// clippy's 128-byte default. Boxing it would change every command and siwc function signature;
// errors are rare and small in absolute terms, so the size is accepted crate-wide (#45).
#![allow(clippy::result_large_err)]

mod app_menu;
mod docs;
mod preview;
mod roots;
mod safety;
mod scan;
mod siwc;
mod trash;

use serde::Serialize;
use siwc::error::SiwcError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    siwc: siwc::Siwc,
    scan_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Generation of the latest preview request; older requests stop when it changes.
    preview_gen: Arc<std::sync::atomic::AtomicU64>,
}

/// The home folder: $HOME, or the account's home from the user database when $HOME is unset.
/// Never "/" or empty: with those, "inside the home folder" would match every path.
fn home() -> Result<String, String> {
    if let Ok(h) = std::env::var("HOME") {
        if safety::home_ok(&h) {
            return Ok(h);
        }
    }
    passwd_home().filter(|h| safety::home_ok(h)).ok_or_else(|| "ホームフォルダが分からないため、スキャンも移動もしません".into())
}

fn passwd_home() -> Option<String> {
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    let dir = unsafe { std::ffi::CStr::from_ptr(pwd.pw_dir) };
    dir.to_str().ok().map(str::to_string)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvInfo {
    home: String,
    user: String,
    os: &'static str,
    version: &'static str,
}

#[tauri::command]
fn env_info() -> EnvInfo {
    let home = home().unwrap_or_default();
    let user = home.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
    EnvInfo { home, user, os: std::env::consts::OS, version: env!("CARGO_PKG_VERSION") }
}

/// A scan progress event tagged with the scan it belongs to, so the window can drop
/// events from an earlier scan that is still winding down.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent {
    scan_id: u64,
    #[serde(flatten)]
    progress: scan::Progress,
}

/// `scan_id` is chosen by the window (a counter per scan) and echoed in every `scan-progress` event.
#[tauri::command]
async fn scan(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    folder: Option<String>,
    min_size: u64,
    scan_id: u64,
) -> Result<scan::ScanResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.scan_cancel.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    let folder = match folder {
        Some(f) => Some(safety::normalize(&f).ok_or("正しいフォルダではありません")?),
        None => None,
    };
    let opts = scan::ScanOptions { home: home()?, folder, min_size, limit: 400 };
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        scan::run_scan(opts, cancel, move |progress| {
            let _ = emitter.emit("scan-progress", ScanProgressEvent { scan_id, progress });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Local-only preview for the detail panel (never sent to the AI). Supersedes any earlier request.
#[tauri::command]
async fn preview_item(
    state: State<'_, AppState>,
    path: String,
) -> Result<preview::PreviewResult, String> {
    let gen = state.preview_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let current = state.preview_gen.clone();
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || preview::preview(&path, &h, gen, current)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_preview(state: State<'_, AppState>) {
    state.preview_gen.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    if let Some(c) = state.scan_cancel.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn move_to_trash(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<trash::TrashOutcome>, String> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = trash::move_to_trash(&paths, &h, |done, total, current| {
            let _ = app.emit(
                "trash-progress",
                TrashProgress {
                    done,
                    total,
                    current: current.to_string(),
                },
            );
        });
        let _ = app.emit(
            "trash-progress",
            TrashProgress {
                done: paths.len(),
                total: paths.len(),
                current: String::new(),
            },
        );
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashProgress {
    done: usize,
    total: usize,
    current: String,
}

/// Waits for `open -R` (off the main thread) so a failure reaches the window and no zombie is left.
#[tauri::command(async)]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = safety::normalize(&path).ok_or("正しいパスではありません")?;
    let status = std::process::Command::new("open")
        .args(["-R", &p])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("open コマンドを起動できませんでした（{e}）"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open -R が失敗しました（{p}）"))
    }
}

#[tauri::command]
fn open_usage(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(siwc::USAGE_URL, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Opens an official Sign in with ChatGPT documentation page in the system browser.
#[tauri::command]
fn open_siwc_doc(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !docs::is_official_siwc_doc(&url) {
        return Err("公式ドキュメント以外の URL は開けません".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Tells the login gate that the signed-in account may have changed.
fn notify_siwc_changed(app: &tauri::AppHandle, reason: &'static str, remote_revoked: Option<bool>) {
    let _ = app.emit(
        "siwc-changed",
        SiwcChanged {
            reason,
            remote_revoked,
        },
    );
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SiwcChanged {
    reason: &'static str,
    remote_revoked: Option<bool>,
}

#[tauri::command]
#[allow(clippy::result_large_err)]
fn siwc_status(state: State<'_, AppState>) -> Result<siwc::Status, SiwcError> {
    state.siwc.status()
}

#[tauri::command]
#[allow(clippy::result_large_err)]
async fn siwc_sign_in(app: tauri::AppHandle, state: State<'_, AppState>, client_id: Option<String>, prompt_consent: bool) -> Result<siwc::AccountView, SiwcError> {
    let opener = app.clone();
    let res = state
        .siwc
        .sign_in(client_id, prompt_consent, move |url| {
            opener
                .opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())
        })
        .await;
    if res.is_ok() {
        notify_siwc_changed(&app, "signed_in", None);
    }
    res
}

#[tauri::command]
fn siwc_cancel_sign_in(state: State<'_, AppState>) {
    state.siwc.cancel_sign_in();
}

#[tauri::command]
#[allow(clippy::result_large_err)]
fn siwc_switch(app: tauri::AppHandle, state: State<'_, AppState>, client_id: String) -> Result<(), SiwcError> {
    state.siwc.switch_account(&client_id)?;
    notify_siwc_changed(&app, "switched", None);
    Ok(())
}

#[tauri::command]
#[allow(clippy::result_large_err)]
fn siwc_ack_welcome(state: State<'_, AppState>) -> Result<(), SiwcError> {
    state.siwc.ack_welcome()
}

#[tauri::command]
#[allow(clippy::result_large_err)]
async fn siwc_sign_out(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<siwc::SignOutResult, SiwcError> {
    let res = state.siwc.sign_out().await?;
    notify_siwc_changed(&app, "signed_out", Some(res.remote_revoked));
    Ok(res)
}

#[tauri::command]
async fn siwc_models(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Vec<siwc::api::Model>, SiwcError> {
    let res = state.siwc.models().await;
    notify_if_signed_out(&app, &res);
    res
}

/// A token that stopped working (refresh refused, registration gone) changes the stored sign-in
/// state; the login gate reads it again instead of staying "ready" (#29).
fn notify_if_signed_out<T>(app: &tauri::AppHandle, res: &Result<T, SiwcError>) {
    if let Err(e) = res {
        if let Some(reason) = siwc::sign_in_change(&e.kind) {
            notify_siwc_changed(app, reason, None);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProgress {
    request_id: String,
    chars: usize,
}

#[tauri::command]
async fn siwc_respond(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    client_id: String,
    model: String,
    instructions: String,
    input: String,
) -> Result<String, SiwcError> {
    let progress_id = request_id.clone();
    let emitter = app.clone();
    let on_delta = move |chars: usize| {
        let _ = emitter.emit("ai-progress", AiProgress { request_id: progress_id.clone(), chars });
    };
    let res = state.siwc.respond(&request_id, &client_id, &model, &instructions, &input, on_delta).await;
    notify_if_signed_out(&app, &res);
    res
}

/// Drops the stream of a `siwc_respond` call when the user stops the AI run (#21).
#[tauri::command]
fn siwc_cancel(state: State<'_, AppState>, request_id: String) {
    state.siwc.cancel_respond(&request_id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // アプリ内アップデート。公開鍵とエンドポイントは tauri.conf.json の plugins.updater。
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            app_menu::install(app)?;
            let dir = app.path().app_data_dir()?.join("siwc");
            let siwc = siwc::Siwc::new(dir);
            // Keychain items that accounts.json doesn't know: picked here, before any sign-in can
            // store a new item, then revoked and deleted in the background. A broken accounts.json
            // skips this (status() reports it) instead of treating every item as orphaned.
            let orphans = siwc.orphan_credentials().unwrap_or_else(|e| {
                eprintln!("siwc: skipped keychain cleanup: {e}");
                Vec::new()
            });
            app.manage(AppState { siwc, scan_cancel: Mutex::new(None), preview_gen: Default::default() });
            if !orphans.is_empty() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    handle.state::<AppState>().siwc.remove_orphans(orphans).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            env_info,
            scan,
            cancel_scan,
            preview_item,
            cancel_preview,
            move_to_trash,
            reveal_in_finder,
            open_usage,
            open_siwc_doc,
            siwc_status,
            siwc_sign_in,
            siwc_cancel_sign_in,
            siwc_switch,
            siwc_ack_welcome,
            siwc_sign_out,
            siwc_models,
            siwc_respond,
            siwc_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #40: progress events carry the scan id next to the progress fields.
    #[test]
    fn scan_progress_event_shape() {
        let e = ScanProgressEvent { scan_id: 7, progress: scan::Progress { phase: "measuring", current: "/a".into(), done: 1, total: 2 } };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            serde_json::json!({ "scanId": 7, "phase": "measuring", "current": "/a", "done": 1, "total": 2 })
        );
    }

    /// #39: a failed `open -R` is reported instead of being dropped.
    #[test]
    fn reveal_missing_path_fails() {
        let r = reveal_in_finder("/nonexistent/fsg-reveal-test".into());
        assert!(r.is_err(), "missing path was reported as revealed");
        // #63: the window adds "Finder で表示できませんでした: " in front, so the Rust side returns only the reason.
        assert!(!r.unwrap_err().starts_with("Finder で表示できませんでした"));
    }

    #[test]
    fn passwd_home_is_usable() {
        let h = super::passwd_home().expect("home from the user database");
        assert!(crate::safety::home_ok(&h), "{h}");
    }
}
