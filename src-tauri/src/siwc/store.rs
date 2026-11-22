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
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
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
        let body = serde_json::to_vec_pretty(&HostFile { ext_agent_host_id: id.clone() }).map_err(|e| e.to_string())?;
        write_private(&path, &body).map_err(|e| format!("host ID を保存できません: {e}"))?;
        Ok(id)
    }

    pub fn accounts(&self) -> AccountsFile {
        fs::read_to_string(self.dir.join("accounts.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
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

#[cfg(target_os = "macos")]
fn secret_get(_dir: &Path, client_id: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, client_id).ok()?.get_password().ok()
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
        let dir = std::env::temp_dir().join(format!("fsg-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let s = Store::new(dir.clone());
        let a = s.host_id().unwrap();
        let b = s.host_id().unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("urn:uuid:") && a.len() == "urn:uuid:".len() + 36);
        let mode = fs::metadata(dir.join("host.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }
}
