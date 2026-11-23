//! Moving items to the Trash (never deleting for good). Same approach as fix-storage's
//! `moveToTrash()` on macOS (`src/core/browse.ts`, MIT, (c) 2026 the fix-storage authors):
//! `/usr/bin/trash` when it exists, otherwise Finder via AppleScript, so "Put Back" works.

use crate::roots::mac_roots;
use crate::safety::{real_path, Guard};
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
/// `on_progress(done, total, current)` is called before each item.
pub fn move_to_trash(paths: &[String], home: &str, on_progress: impl Fn(usize, usize, &str)) -> Vec<TrashOutcome> {
    let roots = mac_roots(home);
    let guard = Guard::new(home, &roots, true);
    let total = paths.len();
    paths
        .iter()
        .enumerate()
        .map(|(i, path)| {
            on_progress(i, total, path);
            let fail = |e: String| TrashOutcome { path: path.clone(), ok: false, error: Some(e) };
            if let Some(why) = guard.check(path) {
                return fail(format!("保護されているため移動しません: {why}"));
            }
            match trash_target(path) {
                Some(target) => match move_one(&target) {
                    Ok(()) => TrashOutcome { path: path.clone(), ok: true, error: None },
                    Err(e) => fail(e),
                },
                None => fail("見つかりません（もう移動・削除された可能性）".into()),
            }
        })
        .collect()
}

/// The place to move: the same real path the guard checked (parents resolved, a symlink at the
/// end is moved itself, never what it points to). None when nothing is there.
fn trash_target(path: &str) -> Option<String> {
    let target = real_path(path).ok().flatten()?;
    std::fs::symlink_metadata(&target).ok()?;
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_is_the_link_itself() {
        let d = std::env::temp_dir().join(format!("fsg-trash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("real")).unwrap();
        std::os::unix::fs::symlink(d.join("real"), d.join("lnk")).unwrap();
        let real_dir = std::fs::canonicalize(&d).unwrap().to_string_lossy().to_string();
        let t = trash_target(&format!("{}/lnk/", d.to_string_lossy())).unwrap();
        assert_eq!(t, format!("{real_dir}/lnk"));
        assert!(trash_target(&format!("{}/nope", d.to_string_lossy())).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn bad_home_moves_nothing() {
        let d = std::env::temp_dir().join(format!("fsg-trash-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("x.txt");
        std::fs::write(&f, b"x").unwrap();
        for home in ["", "/"] {
            let out = move_to_trash(&[f.to_string_lossy().to_string()], home, |_, _, _| {});
            assert!(!out[0].ok, "home={home:?}");
            assert!(f.exists());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
