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

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
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
    let home = home();
    let user = home
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();
    EnvInfo {
        home,
        user,
        os: std::env::consts::OS,
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
async fn scan(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    folder: Option<String>,
    min_size: u64,
) -> Result<scan::ScanResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.scan_cancel.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    let folder = match folder {
        Some(f) => Some(safety::normalize(&f).ok_or("正しいフォルダではありません")?),
        None => None,
    };
    let opts = scan::ScanOptions {
        home: home(),
        folder,
        min_size,
        limit: 400,
    };
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        scan::run_scan(opts, cancel, move |p| {
            let _ = emitter.emit("scan-progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Local-only preview for the detail panel (never sent to the AI). Supersedes any earlier request.
#[tauri::command]
async fn preview_item(
    state: State<'_, AppState>,
    path: String,
) -> Result<preview::PreviewResult, String> {
    let gen = state.preview_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let current = state.preview_gen.clone();
    let h = home();
    tauri::async_runtime::spawn_blocking(move || preview::preview(&path, &h, gen, current))
        .await
        .map_err(|e| e.to_string())
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
async fn move_to_trash(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<trash::TrashOutcome>, String> {
    let h = home();
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

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = safety::normalize(&path).ok_or("正しいパスではありません")?;
    std::process::Command::new("open")
        .args(["-R", &p])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
fn siwc_status(state: State<'_, AppState>) -> Result<siwc::Status, SiwcError> {
    state.siwc.status()
}

#[tauri::command]
async fn siwc_sign_in(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    client_id: Option<String>,
    prompt_consent: bool,
) -> Result<siwc::AccountView, SiwcError> {
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
fn siwc_switch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    client_id: String,
) -> Result<(), SiwcError> {
    state.siwc.switch_account(&client_id)?;
    notify_siwc_changed(&app, "switched", None);
    Ok(())
}

#[tauri::command]
fn siwc_ack_welcome(state: State<'_, AppState>) -> Result<(), SiwcError> {
    state.siwc.ack_welcome()
}

#[tauri::command]
async fn siwc_sign_out(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<siwc::SignOutResult, SiwcError> {
    let res = state.siwc.sign_out().await?;
    notify_siwc_changed(&app, "signed_out", Some(res.remote_revoked));
    Ok(res)
}

#[tauri::command]
async fn siwc_models(state: State<'_, AppState>) -> Result<Vec<siwc::api::Model>, SiwcError> {
    state.siwc.models().await
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
    model: String,
    instructions: String,
    input: String,
) -> Result<String, SiwcError> {
    let on_delta = move |chars: usize| {
        let _ = app.emit(
            "ai-progress",
            AiProgress {
                request_id: request_id.clone(),
                chars,
            },
        );
    };
    state
        .siwc
        .respond(&model, &instructions, &input, on_delta)
        .await
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
            app.manage(AppState {
                siwc: siwc::Siwc::new(dir),
                scan_cancel: Mutex::new(None),
                preview_gen: Default::default(),
            });
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
            siwc_respond
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
