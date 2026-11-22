//! Local-only preview for the detail panel: QuickLook thumbnail, a short read-only text snippet,
//! or a folder's item count. Nothing here is ever sent to the AI (the AI payload stays metadata-only).
//!
//! Safety: anything the hard block list refuses (keys, .env, ~/.ssh, Keychains, .git, system
//! folders, outside the home folder, ...) is never opened, listed or thumbnailed. Extra name rules
//! below also skip files that look like credentials even when they could be trashed.
//! Every request has a generation number; a newer request (or `cancel_preview`) stops older work.

use crate::roots::mac_roots;
use crate::safety::{cannot_remove, real_path, secret_name};
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

const TEXT_BYTES: usize = 4096;
const TEXT_MAX_FILE: u64 = 50 * 1024 * 1024;
const FOLDER_COUNT_CAP: usize = 10_000;
const QL_TIMEOUT: Duration = Duration::from_secs(8);
const THUMB_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Preview {
    /// Protected item: contents are never read.
    Blocked { reason: String },
    Image { data_url: String },
    Text { snippet: String, truncated: bool },
    Folder { count: usize, more: bool },
    /// Nothing to show (no QuickLook thumbnail, binary file, ...).
    None,
    Missing,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub path: String,
    pub preview: Preview,
    /// File-system metadata (stat only).
    pub created_ms: Option<f64>,
    pub modified_ms: Option<f64>,
    /// Bytes on disk (allocated blocks) for files; None for folders (the scan already measured them).
    pub on_disk: Option<u64>,
    pub apparent: Option<u64>,
}

/// Extra preview-only rules on top of the hard block list: names that usually hold credentials.
pub fn preview_denied(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or("");
    if let Some(why) = secret_name(name) {
        return Some(why);
    }
    let lower = name.to_ascii_lowercase();
    const WORDS: [&str; 7] = ["secret", "credential", "password", "passwd", "token", "private", "apikey"];
    if WORDS.iter().any(|w| lower.contains(w)) {
        return Some("認証情報が入っている可能性");
    }
    const NAMES: [&str; 6] = [".npmrc", ".netrc", ".pgpass", ".git-credentials", "authorized_keys", "known_hosts"];
    if NAMES.contains(&lower.as_str()) {
        return Some("認証情報が入っている可能性");
    }
    None
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<f64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64)
}

const TEXT_EXT: [&str; 26] = [
    "txt", "md", "markdown", "log", "csv", "tsv", "json", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "html", "css", "js", "ts",
    "tsx", "jsx", "py", "rs", "swift", "sh", "rb", "go",
];

fn is_text_ext(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or("");
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => TEXT_EXT.contains(&ext.to_ascii_lowercase().as_str()),
        _ => false,
    }
}

/// First few KB of a text file, read-only. Returns None for binary data.
pub fn text_snippet(path: &str) -> Option<(String, bool)> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(TEXT_BYTES);
    f.by_ref().take(TEXT_BYTES as u64 + 1).read_to_end(&mut buf).ok()?;
    let truncated = buf.len() > TEXT_BYTES;
    buf.truncate(TEXT_BYTES);
    if buf.contains(&0) {
        return None;
    }
    let text = match String::from_utf8(buf) {
        Ok(s) => s,
        // Cut in the middle of a character at the 4 KB boundary: keep the valid part.
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            if valid + 4 < e.as_bytes().len() {
                return None;
            }
            String::from_utf8_lossy(&e.as_bytes()[..valid]).into_owned()
        }
    };
    Some((text, truncated))
}

fn count_entries(path: &str, alive: &dyn Fn() -> bool) -> Option<(usize, bool)> {
    let mut n = 0;
    for _ in fs::read_dir(path).ok()?.flatten() {
        n += 1;
        if n >= FOLDER_COUNT_CAP {
            return Some((n, true));
        }
        if n % 500 == 0 && !alive() {
            return None;
        }
    }
    Some((n, false))
}

/// QuickLook thumbnail via `qlmanage -t` into a private temp folder. Killed on timeout or cancel.
fn quicklook(path: &str, gen: u64, alive: &dyn Fn() -> bool) -> Result<Option<String>, ()> {
    if !cfg!(target_os = "macos") {
        return Ok(None);
    }
    let dir = std::env::temp_dir().join(format!("fsg-ql-{}-{gen}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    if fs::create_dir_all(&dir).is_err() {
        return Ok(None);
    }
    let cleanup = |d: &Path| {
        let _ = fs::remove_dir_all(d);
    };
    let child = Command::new("qlmanage")
        .args(["-t", "-s", "512", "-o"])
        .arg(&dir)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        cleanup(&dir);
        return Ok(None);
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        if !alive() {
            let _ = child.kill();
            let _ = child.wait();
            cleanup(&dir);
            return Err(());
        }
        if start.elapsed() > QL_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            cleanup(&dir);
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    let png = fs::read_dir(&dir)
        .ok()
        .and_then(|rd| rd.flatten().map(|e| e.path()).find(|p| p.extension().map(|x| x == "png").unwrap_or(false)));
    let out = png.and_then(|p| {
        let len = fs::metadata(&p).ok()?.len();
        if len == 0 || len > THUMB_MAX_BYTES {
            return None;
        }
        let bytes = fs::read(&p).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    });
    cleanup(&dir);
    Ok(out)
}

pub fn preview(path: &str, home: &str, gen: u64, current: Arc<AtomicU64>) -> PreviewResult {
    let alive = || current.load(Ordering::SeqCst) == gen;
    let mut res = PreviewResult { path: path.to_string(), preview: Preview::None, created_ms: None, modified_ms: None, on_disk: None, apparent: None };
    // Protected items get no stat either: dates and sizes would tell that they exist.
    let roots = mac_roots(home);
    if let Some(why) = cannot_remove(path, home, &roots, true) {
        res.preview = Preview::Blocked { reason: why };
        return res;
    }
    // Everything below reads the same place the check above looked at.
    let target = match real_path(path) {
        Ok(Some(t)) => t,
        Ok(None) => {
            res.preview = Preview::Missing;
            return res;
        }
        Err(()) => {
            res.preview = Preview::Blocked { reason: "実際の場所を確かめられません".into() };
            return res;
        }
    };
    if let Some(why) = preview_denied(&target).or_else(|| preview_denied(path)) {
        res.preview = Preview::Blocked { reason: why.into() };
        return res;
    }
    let Ok(meta) = fs::symlink_metadata(&target) else {
        res.preview = Preview::Missing;
        return res;
    };
    res.created_ms = ms(meta.created());
    res.modified_ms = ms(meta.modified());
    if meta.is_file() {
        res.on_disk = Some(meta.blocks() * 512);
        res.apparent = Some(meta.len());
    }
    if meta.file_type().is_symlink() {
        return res;
    }
    if !alive() {
        res.preview = Preview::Cancelled;
        return res;
    }
    if meta.is_dir() {
        // .app bundles and packages get their QuickLook icon; plain folders show an item count.
        let package = target.ends_with(".app") || target.ends_with(".photoslibrary") || target.ends_with(".bundle");
        if package {
            match quicklook(&target, gen, &alive) {
                Ok(Some(url)) => {
                    res.preview = Preview::Image { data_url: url };
                    return res;
                }
                Ok(None) => {}
                Err(()) => {
                    res.preview = Preview::Cancelled;
                    return res;
                }
            }
        }
        res.preview = match count_entries(&target, &alive) {
            Some((count, more)) => Preview::Folder { count, more },
            None if !alive() => Preview::Cancelled,
            None => Preview::None,
        };
        return res;
    }
    if is_text_ext(&target) && meta.len() <= TEXT_MAX_FILE {
        if let Some((snippet, truncated)) = text_snippet(&target) {
            res.preview = Preview::Text { snippet, truncated };
            return res;
        }
    }
    res.preview = match quicklook(&target, gen, &alive) {
        Ok(Some(url)) => Preview::Image { data_url: url },
        Ok(None) => Preview::None,
        Err(()) => Preview::Cancelled,
    };
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fsg-prev-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn run(path: &str, home: &str) -> PreviewResult {
        let cur = Arc::new(AtomicU64::new(1));
        preview(path, home, 1, cur)
    }

    #[test]
    fn denies_credential_names() {
        assert!(preview_denied("/Users/a/x/.env").is_some());
        assert!(preview_denied("/Users/a/x/server.pem").is_some());
        assert!(preview_denied("/Users/a/x/aws-credentials.csv").is_some());
        assert!(preview_denied("/Users/a/x/my_token.txt").is_some());
        assert!(preview_denied("/Users/a/x/.git-credentials").is_some());
        assert!(preview_denied("/Users/a/x/notes.txt").is_none());
    }

    #[test]
    fn blocked_items_are_never_read() {
        let home = tmp("home-block");
        let h = home.to_string_lossy().to_string();
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(home.join(".ssh/id_ed25519"), b"PRIVATE KEY").unwrap();
        fs::create_dir_all(home.join("proj")).unwrap();
        fs::write(home.join("proj/.env"), b"SECRET=1").unwrap();
        fs::write(home.join("proj/api_token.txt"), b"tok").unwrap();
        for p in [format!("{h}/.ssh/id_ed25519"), format!("{h}/.ssh"), format!("{h}/proj/.env"), format!("{h}/proj/api_token.txt")] {
            let r = run(&p, &h);
            assert!(matches!(r.preview, Preview::Blocked { .. }), "{p}: {:?}", r.preview);
        }
        // Outside the home folder is blocked too.
        let r = run("/etc/hosts", &h);
        assert!(matches!(r.preview, Preview::Blocked { .. }));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn linked_parent_does_not_leak_secrets() {
        let home = tmp("home-link");
        let h = home.to_string_lossy().to_string();
        fs::create_dir_all(home.join(".config/gh")).unwrap();
        fs::write(home.join(".config/gh/hosts.yml"), b"oauth_token: gho_secret").unwrap();
        fs::create_dir_all(home.join("Downloads")).unwrap();
        std::os::unix::fs::symlink(home.join(".config/gh"), home.join("Downloads/g")).unwrap();
        let r = run(&format!("{h}/Downloads/g/hosts.yml"), &h);
        assert!(matches!(r.preview, Preview::Blocked { .. }), "{:?}", r.preview);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn blocked_items_have_no_stat() {
        let home = tmp("home-nostat");
        let h = home.to_string_lossy().to_string();
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(home.join(".ssh/id_ed25519"), b"PRIVATE KEY").unwrap();
        for p in [format!("{h}/.ssh/id_ed25519"), format!("{h}/.ssh/nope"), "/etc/hosts".to_string()] {
            let r = run(&p, &h);
            assert!(matches!(r.preview, Preview::Blocked { .. }), "{p}: {:?}", r.preview);
            assert_eq!((r.created_ms, r.modified_ms, r.on_disk, r.apparent), (None, None, None, None), "{p}");
        }
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn text_snippet_and_folder_count() {
        let home = tmp("home-ok");
        let h = home.to_string_lossy().to_string();
        fs::create_dir_all(home.join("Downloads/sub")).unwrap();
        fs::write(home.join("Downloads/readme.md"), "こんにちは\n".repeat(1000)).unwrap();
        fs::write(home.join("Downloads/sub/a.bin"), [0u8, 1, 2]).unwrap();
        fs::write(home.join("Downloads/sub/b.bin"), [0u8, 1, 2]).unwrap();
        let r = run(&format!("{h}/Downloads/readme.md"), &h);
        match r.preview {
            Preview::Text { snippet, truncated } => {
                assert!(truncated);
                assert!(snippet.len() <= TEXT_BYTES);
                assert!(snippet.starts_with("こんにちは"));
            }
            other => panic!("{other:?}"),
        }
        assert!(r.created_ms.is_some() || cfg!(target_os = "linux"));
        assert!(r.on_disk.is_some());
        let r = run(&format!("{h}/Downloads/sub"), &h);
        assert_eq!(r.preview, Preview::Folder { count: 2, more: false });
        let r = run(&format!("{h}/Downloads/nope"), &h);
        assert_eq!(r.preview, Preview::Missing);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn superseded_requests_stop() {
        let home = tmp("home-cancel");
        let h = home.to_string_lossy().to_string();
        fs::create_dir_all(home.join("Downloads/sub")).unwrap();
        let cur = Arc::new(AtomicU64::new(2));
        let r = preview(&format!("{h}/Downloads/sub"), &h, 1, cur);
        assert_eq!(r.preview, Preview::Cancelled);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn binary_is_not_text() {
        let home = tmp("home-bin");
        let p = home.join("x.txt");
        fs::write(&p, [b'a', 0, b'b']).unwrap();
        assert!(text_snippet(&p.to_string_lossy()).is_none());
        let _ = fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod serde_tests {
    use super::*;

    #[test]
    fn json_shape() {
        let v = serde_json::to_value(Preview::Image { data_url: "x".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "image", "dataUrl": "x" }));
        let v = serde_json::to_value(Preview::None).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "none" }));
    }
}
