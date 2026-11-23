//! Local persistence for Sign in with ChatGPT.
//!
//! * `host.json`      – this host's stable `ext_agent_host_id` (opaque, not a secret).
//! * `accounts.json`  – non-secret account metadata (issued client_id, verified subject, email, flags).
//! * Tokens           – macOS Keychain (one generic-password item per issued client_id).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const KEYCHAIN_SERVICE: &str = "io.github.konaito.fixstoragegui.siwc";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostFile {
    pub ext_agent_host_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountMeta {
    /// Issued client id (`oaiapp_...`). Never `dynamic_agent_client`.
    pub client_id: String,
    /// Validated ID-token `sub`.
    pub subject: String,
    pub email: Option<String>,
    pub scopes: Vec<String>,
    pub plan_enabled: bool,
    /// The refresh token stopped working or the app was disconnected; sign in again.
    #[serde(default)]
    pub needs_reauth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountsFile {
    pub active: Option<String>,
    pub accounts: Vec<AccountMeta>,
    /// "You're using your ChatGPT plan" is shown only once, after the first sign-in with plan usage.
    #[serde(default)]
    pub welcome_shown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub scopes: Vec<String>,
    /// Unix seconds when the token response was received.
    pub saved_at: i64,
}

/// Writes atomically with 0600 permissions.
pub fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Returns this host's ID, creating and persisting a UUIDv4 URN on first use.
    pub fn host_id(&self) -> Result<String, String> {
        let path = self.dir.join("host.json");
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(h) = serde_json::from_str::<HostFile>(&text) {
                if h.ext_agent_host_id.starts_with("urn:uuid:") {
                    return Ok(h.ext_agent_host_id);
                }
            }
        }
        let id = format!("urn:uuid:{}", uuid::Uuid::new_v4().hyphenated());
        let body = serde_json::to_vec_pretty(&HostFile {
            ext_agent_host_id: id.clone(),
        })
        .map_err(|e| e.to_string())?;
        write_private(&path, &body).map_err(|e| format!("host ID を保存できません: {e}"))?;
        Ok(id)
    }

    /// Reads `accounts.json`. A missing file means no accounts yet. A file that can't be parsed is
    /// moved aside (`accounts.json.broken-<unix seconds>`) and reported as an error, so it is never
    /// silently replaced by an empty list on the next save. Other read errors are returned as is.
    pub fn accounts(&self) -> Result<AccountsFile, String> {
        let path = self.dir.join("accounts.json");
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AccountsFile::default())
            }
            Err(e) => return Err(format!("アカウント情報（accounts.json）を読めません: {e}")),
        };
        match parse_accounts(&text) {
            Ok(a) => Ok(a),
            Err(why) => {
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let aside = self.dir.join(format!("accounts.json.broken-{secs}"));
                match fs::rename(&path, &aside) {
                    Ok(()) => Err(format!(
                        "アカウント情報（accounts.json）が壊れていたため {} に退避しました（{why}）。保存済みのアカウントは読み込めないので、もう一度サインインしてください",
                        aside.display()
                    )),
                    Err(e) => Err(format!("アカウント情報（accounts.json）が壊れていて、退避もできませんでした（{why} / {e}）")),
                }
            }
        }
    }

    pub fn save_accounts(&self, a: &AccountsFile) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(a).map_err(|e| e.to_string())?;
        write_private(&self.dir.join("accounts.json"), &body).map_err(|e| e.to_string())
    }

    pub fn load_credentials(&self, client_id: &str) -> Option<Credentials> {
        let text = secret_get(&self.dir, client_id)?;
        serde_json::from_str(&text).ok()
    }

    pub fn save_credentials(&self, client_id: &str, c: &Credentials) -> Result<(), String> {
        let text = serde_json::to_string(c).map_err(|e| e.to_string())?;
        secret_set(&self.dir, client_id, &text)
    }

    pub fn clear_credentials(&self, client_id: &str) -> Result<(), String> {
        secret_delete(&self.dir, client_id)
    }
}

pub(crate) fn parse_accounts(text: &str) -> Result<AccountsFile, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// Client ids (keychain account names) of every item stored under [`KEYCHAIN_SERVICE`].
/// Reads attributes only, never the secrets.
#[cfg(target_os = "macos")]
pub fn keychain_client_ids() -> Result<Vec<String>, String> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    let found = match ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(KEYCHAIN_SERVICE)
        .load_attributes(true)
        .limit(Limit::All)
        .search()
    {
        Ok(r) => r,
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => return Ok(vec![]),
        Err(e) => return Err(format!("キーチェーンを検索できません: {e}")),
    };
    let mut ids: Vec<String> = found
        .iter()
        .filter_map(|r| r.simplify_dict())
        .filter(|d| d.get("svce").map(String::as_str) == Some(KEYCHAIN_SERVICE))
        .filter_map(|d| d.get("acct").cloned())
        .filter(|a| !a.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}
#[cfg(not(target_os = "macos"))]
pub fn keychain_client_ids() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[cfg(target_os = "macos")]
fn secret_get(_dir: &Path, client_id: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, client_id)
        .ok()?
        .get_password()
        .ok()
}
#[cfg(target_os = "macos")]
fn secret_set(_dir: &Path, client_id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, client_id)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("キーチェーンに保存できません: {e}"))
}
#[cfg(target_os = "macos")]
fn secret_delete(_dir: &Path, client_id: &str) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, client_id).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("キーチェーンから削除できません: {e}")),
    }
}

// fix-storage-gui is macOS-only. These stubs only keep `cargo check` working on other systems.
#[cfg(not(target_os = "macos"))]
fn secret_get(_dir: &Path, _client_id: &str) -> Option<String> {
    None
}
#[cfg(not(target_os = "macos"))]
fn secret_set(_dir: &Path, _client_id: &str, _value: &str) -> Result<(), String> {
    Err("このアプリは macOS 専用です（キーチェーンが必要です）".into())
}
#[cfg(not(target_os = "macos"))]
fn secret_delete(_dir: &Path, _client_id: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_id_is_stable_and_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fsg-store-host-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let s = Store::new(dir.clone());
        let a = s.host_id().unwrap();
        let b = s.host_id().unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("urn:uuid:") && a.len() == "urn:uuid:".len() + 36);
        let mode = fs::metadata(dir.join("host.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_accounts_json_is_kept_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("fsg-store-broken-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let broken = b"{\"active\": \"oaiapp_x\", \"accounts\": [ ";
        fs::write(dir.join("accounts.json"), broken).unwrap();
        let s = Store::new(dir.clone());
        let _ = s.accounts();
        let _ = s.save_accounts(&AccountsFile::default());
        let kept = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("accounts.json.broken")
            })
            .any(|e| fs::read(e.path()).unwrap() == broken);
        let _ = fs::remove_dir_all(&dir);
        assert!(
            kept,
            "the broken accounts.json must be moved aside with its original bytes"
        );
    }

    #[test]
    fn broken_accounts_json_is_an_error() {
        let dir = std::env::temp_dir().join(format!("fsg-store-broken-err-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("accounts.json"), b"not json").unwrap();
        let s = Store::new(dir.clone());
        let first = s.accounts();
        // Moved aside: the next read starts from an empty list (the error was already reported).
        let second = s.accounts();
        let _ = fs::remove_dir_all(&dir);
        let msg = first.expect_err("a broken file must not read as empty");
        assert!(msg.contains("退避"), "{msg}");
        assert!(second.unwrap().accounts.is_empty());
    }

    #[test]
    fn missing_accounts_json_is_empty_and_valid_json_parses() {
        let dir = std::env::temp_dir().join(format!("fsg-store-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let s = Store::new(dir.clone());
        assert!(s.accounts().unwrap().accounts.is_empty());
        let a = parse_accounts(r#"{"active":"oaiapp_a","accounts":[{"client_id":"oaiapp_a","subject":"u","email":null,"scopes":[],"plan_enabled":true}]}"#).unwrap();
        assert_eq!(a.active.as_deref(), Some("oaiapp_a"));
        assert_eq!(a.accounts.len(), 1);
        assert!(parse_accounts("{").is_err());
    }
}
