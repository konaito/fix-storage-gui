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
    let out = Command::new(file)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{file} が失敗しました ({})", out.status)
        } else {
            err
        })
    }
}

fn move_one(path: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        if Path::new("/usr/bin/trash").exists() {
            return run("/usr/bin/trash", &[path]);
        }
        return run(
            "osascript",
            &[
                "-e",
                "on run argv",
                "-e",
                "tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)",
                "-e",
                "end run",
                path,
            ],
        );
    }
    let _ = path;
    Err("このアプリは macOS 専用です".into())
}

/// Re-checks the hard block list for every path right before moving it.
/// `on_progress(done, total, current)` is called before each item.
pub fn move_to_trash(
    paths: &[String],
    home: &str,
    on_progress: impl Fn(usize, usize, &str),
) -> Vec<TrashOutcome> {
    move_to_trash_with(paths, home, on_progress, move_one)
}

/// [`move_to_trash`] with the step that really moves an item passed in, so tests can see
/// which paths would have reached it.
fn move_to_trash_with(
    paths: &[String],
    home: &str,
    on_progress: impl Fn(usize, usize, &str),
    mover: impl Fn(&str) -> Result<(), String>,
) -> Vec<TrashOutcome> {
    let roots = mac_roots(home);
    let guard = Guard::new(home, &roots, true);
    let total = paths.len();
    paths
        .iter()
        .enumerate()
        .map(|(i, path)| {
            on_progress(i, total, path);
            let fail = |e: String| TrashOutcome {
                path: path.clone(),
                ok: false,
                error: Some(e),
            };
            if let Some(why) = guard.check(path) {
                return fail(format!("保護されているため移動しません: {why}"));
            }
            match trash_target(path) {
                Some(target) => match mover(&target) {
                    Ok(()) => TrashOutcome {
                        path: path.clone(),
                        ok: true,
                        error: None,
                    },
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
        let real_dir = std::fs::canonicalize(&d)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let t = trash_target(&format!("{}/lnk/", d.to_string_lossy())).unwrap();
        assert_eq!(t, format!("{real_dir}/lnk"));
        assert!(trash_target(&format!("{}/nope", d.to_string_lossy())).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// #47: protected items never reach the step that moves things to the Trash.
    #[test]
    fn protected_paths_never_reach_the_mover() {
        use std::cell::RefCell;
        let d = std::env::temp_dir().join(format!("fsg-trash-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let h = d.to_string_lossy().trim_end_matches('/').to_string();
        let file = |rel: &str| {
            let p = d.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"x").unwrap();
        };
        file(".ssh/config");
        file("proj/.git/HEAD");
        file("proj2/.env");
        file("work/repoA/.git/HEAD");
        file("Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw");
        file(".ollama/models/blobs/sha256-abc");
        file("Downloads/ok.txt");
        let protected = [
            ".ssh/config",
            "proj",
            "proj2/.env",
            "work",
            "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
            ".ollama/models",
        ];
        let mut paths: Vec<String> = protected.iter().map(|r| format!("{h}/{r}")).collect();
        paths.push(format!("{h}/Downloads/ok.txt"));

        let moved = RefCell::new(Vec::<String>::new());
        let out = move_to_trash_with(
            &paths,
            &h,
            |_, _, _| {},
            |p| {
                moved.borrow_mut().push(p.to_string());
                Ok(())
            },
        );

        let moved = moved.into_inner();
        assert_eq!(
            moved.len(),
            1,
            "only the ordinary file may reach the mover: {moved:?}"
        );
        assert!(moved[0].ends_with("/Downloads/ok.txt"));
        for (o, rel) in out.iter().zip(protected) {
            assert!(!o.ok, "{rel} was moved");
            assert!(
                o.error
                    .as_deref()
                    .unwrap_or("")
                    .starts_with("保護されているため移動しません"),
                "{rel}: {:?}",
                o.error
            );
            assert!(d.join(rel).exists());
        }
        assert!(out.last().unwrap().ok);
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
