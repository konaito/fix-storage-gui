//! Moving items to the Trash (never deleting for good). Same approach as fix-storage's
//! `moveToTrash()` on macOS (`src/core/browse.ts`, MIT, (c) 2026 the fix-storage authors):
//! `/usr/bin/trash` when it exists, otherwise Finder via AppleScript, so "Put Back" works.

use crate::roots::mac_roots;
use crate::safety::cannot_remove;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashOutcome {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

fn run(file: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(file).args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("{file} が失敗しました ({})", out.status) } else { err })
    }
}

fn move_one(path: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        if Path::new("/usr/bin/trash").exists() {
            return run("/usr/bin/trash", &[path]);
        }
        return run(
            "osascript",
            &["-e", "on run argv", "-e", "tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)", "-e", "end run", path],
        );
    }
    let _ = path;
    Err("このアプリは macOS 専用です".into())
}

/// Re-checks the hard block list for every path right before moving it.
pub fn move_to_trash(paths: &[String], home: &str) -> Vec<TrashOutcome> {
    let roots = mac_roots(home);
    paths
        .iter()
        .map(|path| {
            if let Some(why) = cannot_remove(path, home, &roots, true) {
                return TrashOutcome { path: path.clone(), ok: false, error: Some(format!("保護されているため移動しません: {why}")) };
            }
            if std::fs::symlink_metadata(path).is_err() {
                return TrashOutcome { path: path.clone(), ok: false, error: Some("見つかりません（もう移動・削除された可能性）".into()) };
            }
            match move_one(path) {
                Ok(()) => TrashOutcome { path: path.clone(), ok: true, error: None },
                Err(e) => TrashOutcome { path: path.clone(), ok: false, error: Some(e) },
            }
        })
        .collect()
}
