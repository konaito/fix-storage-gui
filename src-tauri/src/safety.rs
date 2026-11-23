//! Hard block list. Anything this module refuses can never be moved to the Trash,
//! no matter what the AI review or the user's selection says.
//!
//! The first part ports fix-storage's `protectedPaths()` / `cannotRemove()` for macOS
//! (`src/core/browse.ts`, MIT, (c) 2026 the fix-storage authors). The rest are extra
//! rules added by fix-storage-gui: secrets, keys, Git repositories, Keychains.

use crate::roots::Root;
use std::io::ErrorKind;
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

/// A home folder the rules can work with: absolute and not the root folder.
/// An empty or "/" home would make "inside the home folder" true for every path.
pub fn home_ok(home: &str) -> bool {
    let h = home.trim_end_matches('/');
    h.starts_with('/') && normalize(h).is_some()
}

/// Where `path` really is: its parent folders resolved through symlinks, its last name kept
/// as is (a symlink at the end is the item itself and is not followed).
/// Ok(None) when the parent folder does not exist; Err for other failures (permission, loops).
pub fn real_path(path: &str) -> Result<Option<String>, ()> {
    let Some(target) = normalize(path) else {
        return Err(());
    };
    if target == "/" {
        return Ok(Some(target));
    }
    let (parent, name) = target.rsplit_once('/').ok_or(())?;
    let parent = if parent.is_empty() { "/" } else { parent };
    match std::fs::canonicalize(parent) {
        Ok(p) => {
            let p = p.to_str().ok_or(())?.trim_end_matches('/');
            Ok(Some(format!("{p}/{name}")))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

/// `path == dir` or `path` is inside `dir`. Both must already be lowercased.
fn same_or_within(path: &str, dir: &str) -> bool {
    path == dir || within(path, dir)
}

fn within(path: &str, dir: &str) -> bool {
    path.starts_with(dir) && path.as_bytes().get(dir.len()) == Some(&b'/')
}

/// fix-storage's macOS protected folders: removing them breaks macOS or the account.
fn protected_paths(home: &str, roots: &[Root]) -> Vec<String> {
    let lib = |name: &str| format!("{home}/Library/{name}");
    let mut v: Vec<String> = roots.iter().map(|r| r.path.clone()).collect();
    v.extend([
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
    ]);
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
        (
            "/Library/Keychains".into(),
            "キーチェーン（パスワードや証明書）",
        ),
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
    if lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower.starts_with("id_ecdsa")
        || lower.starts_with("id_dsa")
    {
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

/// Protected paths and folders, lowercased: APFS ignores case by default, so `~/.SSH` is `~/.ssh`.
struct Rules {
    home: String,
    protected: Vec<String>,
    trees: Vec<(String, &'static str)>,
}

impl Rules {
    fn new(home: &str, protected: Vec<String>, trees: Vec<(String, &'static str)>) -> Self {
        Rules {
            home: home.to_ascii_lowercase(),
            protected: protected
                .into_iter()
                .map(|p| p.to_ascii_lowercase())
                .collect(),
            trees: trees
                .into_iter()
                .map(|(p, why)| (p.to_ascii_lowercase(), why))
                .collect(),
        }
    }

    /// The rules that only look at the path text. `target` is normalized; case is ignored.
    fn check(&self, target: &str) -> Option<String> {
        let lower = target.to_ascii_lowercase();
        if self.protected.iter().any(|p| p == &lower) {
            return Some("macOS かアカウントに必要なフォルダです".into());
        }
        for (dir, why) in &self.trees {
            if same_or_within(&lower, dir) {
                return Some((*why).into());
            }
        }
        // Only the home folder and /Applications are ever offered (fix-storage limits itself to its roots too).
        if !(within(&lower, &self.home) || within(&lower, "/applications")) {
            return Some("ホームフォルダと /Applications の外は扱いません".into());
        }
        for comp in lower.split('/') {
            if comp == ".git" {
                return Some("Git の履歴（.git）".into());
            }
            if comp == "keychains" {
                return Some("キーチェーン（パスワードや証明書）".into());
            }
        }
        let name = target.rsplit('/').next().unwrap_or("");
        secret_name(name).map(Into::into)
    }
}

/// The hard block list for one home folder. Build it once and reuse it for many paths.
pub struct Guard {
    /// None when the home folder is unusable (empty, "/", relative): everything is refused.
    home: Option<String>,
    rules: Rules,
    /// Set when `check_fs`: also checks where each path really is, against the rules with
    /// the protected folders and roots resolved through symlinks too.
    real: Option<RealRules>,
}

struct RealRules {
    /// The home folder resolved through symlinks (on macOS `/var/...` becomes `/private/var/...`).
    home: String,
    rules: Rules,
}

impl Guard {
    /// `check_fs` enables checks that look at the disk (symlinks, Git repository roots).
    pub fn new(home: &str, roots: &[Root], check_fs: bool) -> Self {
        let h = home.trim_end_matches('/');
        let protected = protected_paths(h, roots);
        let trees = blocked_trees(h);
        if !home_ok(h) {
            return Guard {
                home: None,
                rules: Rules::new(h, protected, trees),
                real: None,
            };
        }
        let real = if check_fs {
            let real_home = std::fs::canonicalize(h)
                .ok()
                .and_then(|p| p.to_str().map(|s| s.trim_end_matches('/').to_string()))
                .filter(|s| home_ok(s))
                .unwrap_or_else(|| h.to_string());
            let to_home = |p: &str| to_home_ns(p, &real_home, h);
            let resolve = |p: &str| {
                std::fs::canonicalize(p)
                    .ok()
                    .and_then(|r| r.to_str().map(to_home))
            };
            let mut real_protected = protected.clone();
            real_protected.extend(protected.iter().filter_map(|p| resolve(p)));
            let mut real_trees = trees.clone();
            real_trees.extend(
                trees
                    .iter()
                    .filter_map(|(p, why)| resolve(p).map(|r| (r, *why))),
            );
            Some(RealRules {
                rules: Rules::new(h, real_protected, real_trees),
                home: real_home,
            })
        } else {
            None
        };
        Guard {
            home: Some(h.to_string()),
            rules: Rules::new(h, protected, trees),
            real,
        }
    }

    /// Why `path` must never be moved to the Trash, or None when it may be.
    /// With `check_fs`, the path is checked both as written and where it really is; either one blocks.
    pub fn check(&self, path: &str) -> Option<String> {
        let Some(target) = normalize(path) else {
            return Some("正しいパスではありません".into());
        };
        let Some(home) = &self.home else {
            return Some("ホームフォルダが分からないため扱いません".into());
        };
        if let Some(why) = self.rules.check(&target) {
            return Some(why);
        }
        let Some(real) = &self.real else { return None };
        let resolved = match real_path(&target) {
            Ok(Some(r)) => r,
            // The parent folder does not exist, so neither does the item.
            Ok(None) => return None,
            Err(()) => return Some("実際の場所を確かめられません".into()),
        };
        // Compare inside the home folder as written, so that a home under /var (really /private/var)
        // is not caught by the /private rule.
        let resolved = to_home_ns(&resolved, &real.home, home);
        if let Some(why) = real.rules.check(&resolved) {
            return Some(why);
        }
        let p = Path::new(&resolved);
        if p.is_dir() && p.join(".git").exists() {
            return Some("Git リポジトリ（未 push の変更が失われるおそれ）".into());
        }
        None
    }
}

/// Rewrites a path inside `real_home` to the same place under `home` (case-insensitive prefix).
fn to_home_ns(path: &str, real_home: &str, home: &str) -> String {
    let lower = path.to_ascii_lowercase();
    let rh = real_home.to_ascii_lowercase();
    if lower == rh {
        home.to_string()
    } else if within(&lower, &rh) {
        // ASCII lowercasing keeps byte offsets, so this index is a char boundary in `path`.
        format!("{home}{}", &path[real_home.len()..])
    } else {
        path.to_string()
    }
}

/// Why `path` must never be moved to the Trash, or None when it may be.
/// `check_fs` enables checks that look at the disk (symlinks, Git repository roots).
/// For many paths, build a [`Guard`] once instead.
pub fn cannot_remove(path: &str, home: &str, roots: &[Root], check_fs: bool) -> Option<String> {
    Guard::new(home, roots, check_fs).check(path)
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
        assert!(
            check("/Users/a/Library/Caches").is_some(),
            "roots themselves are protected"
        );
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
    fn blocks_case_variants() {
        // APFS ignores case by default, so these name the same protected items.
        assert!(check("/Users/a/.SSH/config").is_some());
        assert!(check("/Users/a/library/Mail/V10/x.emlx").is_some());
        assert!(check("/Users/a/.AWS/credentials").is_some());
        assert!(check("/Users/a/.config/GH/hosts.yml").is_some());
        assert!(check("/Users/a/proj/.GIT/objects").is_some());
        assert!(check("/Users/a/LIBRARY").is_some());
        assert!(check("/Users/a/library/caches").is_some());
        assert!(check("/SYSTEM/Library/Fonts").is_some());
        assert!(check("/users/a").is_some());
    }

    #[test]
    fn empty_or_root_home_blocks_everything() {
        for home in ["", "/", "//", "relative"] {
            let roots = mac_roots(home);
            for p in [
                "/etc/hosts",
                "/opt/homebrew/Cellar/x",
                "/Library/LaunchDaemons/x.plist",
                "/var/db/x",
                "/Users/a/Downloads/x.dmg",
            ] {
                assert!(
                    cannot_remove(p, home, &roots, false).is_some(),
                    "home={home:?} path={p}"
                );
            }
        }
    }

    /// A home folder on the real disk under the temp dir. On macOS the temp dir is under /var,
    /// which canonicalizes to /private/var, so this also covers that trap.
    fn real_home(name: &str) -> (std::path::PathBuf, String) {
        let d = std::env::temp_dir().join(format!("fsg-safety-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let h = d.to_string_lossy().trim_end_matches('/').to_string();
        (d, h)
    }

    #[test]
    fn blocks_through_symlinks() {
        use std::os::unix::fs::symlink;
        let (d, h) = real_home("symlink");
        let roots = mac_roots(&h);
        let c = |p: String| cannot_remove(&p, &h, &roots, true);
        std::fs::create_dir_all(d.join(".ssh")).unwrap();
        std::fs::write(d.join(".ssh/config"), b"Host x").unwrap();
        std::fs::create_dir_all(d.join("Downloads")).unwrap();
        std::fs::write(d.join("Downloads/ok.txt"), b"hi").unwrap();
        symlink(d.join(".ssh"), d.join("Downloads/lnk")).unwrap();
        // dotfile managers: ~/.config/gh is a link into ~/dotfiles
        std::fs::create_dir_all(d.join("dotfiles/gh")).unwrap();
        std::fs::write(d.join("dotfiles/gh/hosts.yml"), b"oauth_token: x").unwrap();
        std::fs::create_dir_all(d.join(".config")).unwrap();
        symlink(d.join("dotfiles/gh"), d.join(".config/gh")).unwrap();
        // a root that is a link: ~/Movies -> ~/media/movies
        std::fs::create_dir_all(d.join("media/movies")).unwrap();
        symlink(d.join("media/movies"), d.join("Movies")).unwrap();

        assert!(
            c(format!("{h}/Downloads/lnk/config")).is_some(),
            "through a linked parent"
        );
        assert!(
            c(format!("{h}/Downloads/lnk/")).is_none(),
            "the link itself is an ordinary item"
        );
        assert!(
            c(format!("{h}/dotfiles/gh/hosts.yml")).is_some(),
            "real place of a protected folder"
        );
        assert!(c(format!("{h}/dotfiles/gh")).is_some());
        assert!(
            c(format!("{h}/media/movies")).is_some(),
            "real place of a root"
        );
        // Ordinary items in a home under /var (-> /private/var) must stay allowed.
        assert!(
            c(format!("{h}/Downloads/ok.txt")).is_none(),
            "{:?}",
            c(format!("{h}/Downloads/ok.txt"))
        );
        assert!(c(format!("{h}/media/movies/clip.mov")).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn normalize_works() {
        assert_eq!(normalize("/a//b/./c/").as_deref(), Some("/a/b/c"));
        assert_eq!(normalize("/a/../b"), None);
    }
}
