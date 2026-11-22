//! Hard block list. Anything this module refuses can never be moved to the Trash,
//! no matter what the AI review or the user's selection says.
//!
//! The first part ports fix-storage's `protectedPaths()` / `cannotRemove()` for macOS
//! (`src/core/browse.ts`, MIT, (c) 2026 the fix-storage authors). The rest are extra
//! rules added by fix-storage-gui: secrets, keys, Git repositories, Keychains.

use crate::roots::Root;
use std::path::{Component, Path};

/// Lexically normalises an absolute path. Returns None for relative paths or paths with `..`.
pub fn normalize(path: &str) -> Option<String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for c in p.components() {
        match c {
            Component::RootDir => {}
            Component::CurDir => {}
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(format!("/{}", parts.join("/")))
}

fn within(path: &str, dir: &str) -> bool {
    path.starts_with(dir) && path.as_bytes().get(dir.len()) == Some(&b'/')
}

/// fix-storage's macOS protected folders: removing them breaks macOS or the account.
fn protected_paths(home: &str, roots: &[Root]) -> Vec<String> {
    let lib = |name: &str| format!("{home}/Library/{name}");
    let mut v: Vec<String> = roots.iter().map(|r| r.path.clone()).collect();
    v.extend(
        [
            "/".to_string(),
            home.to_string(),
            "/System".into(),
            "/Library".into(),
            "/usr".into(),
            "/usr/local/bin".into(),
            "/usr/local/lib".into(),
            "/opt/homebrew/bin".into(),
            "/opt/homebrew/lib".into(),
            "/Users".into(),
            "/Applications".into(),
            "/Volumes".into(),
            format!("{home}/Library"),
            lib("Keychains"),
            lib("Preferences"),
            lib("Mail"),
            lib("Messages"),
            lib("Accounts"),
            lib("Cookies"),
            lib("Calendars"),
            lib("Safari"),
            lib("Photos"),
            lib("Biome"),
        ]
        .into_iter(),
    );
    v
}

/// Folders where nothing inside may be touched (added by fix-storage-gui, on top of fix-storage).
fn blocked_trees(home: &str) -> Vec<(String, &'static str)> {
    let h = |p: &str| format!("{home}/{p}");
    vec![
        ("/System".into(), "macOS が管理しています"),
        ("/private".into(), "macOS が管理しています"),
        ("/usr".into(), "macOS が管理しています"),
        ("/bin".into(), "macOS が管理しています"),
        ("/sbin".into(), "macOS が管理しています"),
        ("/Library/Keychains".into(), "キーチェーン（パスワードや証明書）"),
        (h("Library/Keychains"), "キーチェーン（パスワードや証明書）"),
        (h("Library/Accounts"), "アカウント情報"),
        (h("Library/Mail"), "メールのデータ"),
        (h("Library/Messages"), "メッセージのデータ"),
        (h("Library/Calendars"), "カレンダーのデータ"),
        (h("Library/Cookies"), "ログイン情報（Cookie）"),
        (h("Library/Preferences"), "アプリの設定"),
        (h(".ssh"), "SSH の鍵"),
        (h(".gnupg"), "GPG の鍵"),
        (h(".aws"), "クラウドの認証情報"),
        (h(".azure"), "クラウドの認証情報"),
        (h(".kube"), "Kubernetes の認証情報"),
        (h(".config/gcloud"), "クラウドの認証情報"),
        (h(".config/gh"), "GitHub の認証情報"),
        (h(".password-store"), "パスワードストア"),
        (h(".docker/config.json"), "Docker の認証情報"),
        (h(".netrc"), "認証情報"),
        (h(".npmrc"), "認証トークンが入っている可能性"),
    ]
}

/// Names that usually hold private keys or secrets.
pub(crate) fn secret_name(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("id_rsa") || lower.starts_with("id_ed25519") || lower.starts_with("id_ecdsa") || lower.starts_with("id_dsa") {
        return Some("SSH の秘密鍵");
    }
    if lower == ".env" || lower.starts_with(".env.") {
        return Some("秘密情報（.env）が入っている可能性");
    }
    const EXT: [(&str, &str); 8] = [
        (".pem", "鍵または証明書"),
        (".key", "鍵ファイル"),
        (".p12", "証明書と秘密鍵"),
        (".pfx", "証明書と秘密鍵"),
        (".keychain", "キーチェーン"),
        (".keychain-db", "キーチェーン"),
        (".kdbx", "パスワードデータベース"),
        (".gpg", "暗号化された鍵やデータ"),
    ];
    for (ext, why) in EXT {
        if lower.ends_with(ext) {
            return Some(why);
        }
    }
    None
}

/// Why `path` must never be moved to the Trash, or None when it may be.
/// `check_fs` enables checks that look at the disk (Git repository roots).
pub fn cannot_remove(path: &str, home: &str, roots: &[Root], check_fs: bool) -> Option<String> {
    let Some(target) = normalize(path) else {
        return Some("正しいパスではありません".into());
    };
    let home = home.trim_end_matches('/');
    if protected_paths(home, roots).iter().any(|p| p == &target) {
        return Some("macOS かアカウントに必要なフォルダです".into());
    }
    for (dir, why) in blocked_trees(home) {
        if target == dir || within(&target, &dir) {
            return Some(why.into());
        }
    }
    // Only the home folder and /Applications are ever offered (fix-storage limits itself to its roots too).
    if !(within(&target, home) || within(&target, "/Applications")) {
        return Some("ホームフォルダと /Applications の外は扱いません".into());
    }
    for comp in target.split('/') {
        if comp == ".git" {
            return Some("Git の履歴（.git）".into());
        }
        if comp.eq_ignore_ascii_case("Keychains") {
            return Some("キーチェーン（パスワードや証明書）".into());
        }
    }
    let name = target.rsplit('/').next().unwrap_or("");
    if let Some(why) = secret_name(name) {
        return Some(why.into());
    }
    if check_fs {
        let p = Path::new(&target);
        if p.is_dir() && p.join(".git").exists() {
            return Some("Git リポジトリ（未 push の変更が失われるおそれ）".into());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roots::mac_roots;

    fn check(p: &str) -> Option<String> {
        let roots = mac_roots("/Users/a");
        cannot_remove(p, "/Users/a", &roots, false)
    }

    #[test]
    fn blocks_system_and_secrets() {
        assert!(check("/").is_some());
        assert!(check("/Users/a").is_some());
        assert!(check("/Users/a/Library").is_some());
        assert!(check("/Users/a/Library/Caches").is_some(), "roots themselves are protected");
        assert!(check("/System/Library/Fonts").is_some());
        assert!(check("/Users/a/Library/Keychains/login.keychain-db").is_some());
        assert!(check("/Users/a/.ssh/id_ed25519").is_some());
        assert!(check("/Users/a/Documents/backup/id_rsa").is_some());
        assert!(check("/Users/a/proj/.git").is_some());
        assert!(check("/Users/a/proj/.git/objects").is_some());
        assert!(check("/Users/a/proj/.env").is_some());
        assert!(check("/Users/a/certs/server.pem").is_some());
        assert!(check("/opt/homebrew/Cellar/x").is_some());
        assert!(check("/Users/a/../b/file").is_some());
        assert!(check("relative/path").is_some());
    }

    #[test]
    fn allows_normal_items() {
        assert!(check("/Users/a/Library/Caches/com.example").is_none());
        assert!(check("/Users/a/Downloads/Installer.dmg").is_none());
        assert!(check("/Users/a/proj/node_modules").is_none());
        assert!(check("/Applications/Old.app").is_none());
    }

    #[test]
    fn normalize_works() {
        assert_eq!(normalize("/a//b/./c/").as_deref(), Some("/a/b/c"));
        assert_eq!(normalize("/a/../b"), None);
    }
}
