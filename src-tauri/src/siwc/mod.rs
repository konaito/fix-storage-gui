//! Sign in with ChatGPT (ChatGPT plan usage for open-source / local apps).
//! Tokens never leave the Rust side: the web view only sees account metadata and results.

pub mod api;
pub mod error;
pub mod oauth;
pub mod store;

use error::SiwcError;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use store::{AccountMeta, Credentials, Store};

/// ChatGPT Settings → Usage (same URL as the official DevKit's CHATGPT_USAGE_URL).
pub const USAGE_URL: &str = "https://chatgpt.com/settings/usage";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub client_id: String,
    pub label: String,
    pub email: Option<String>,
    pub plan_enabled: bool,
    pub signed_in: bool,
    pub needs_reauth: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub host_id: String,
    pub active: Option<String>,
    pub accounts: Vec<AccountView>,
    /// Show "You're using your ChatGPT plan" once.
    pub show_welcome: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    pub remote_revoked: bool,
}

pub struct Siwc {
    store: Store,
    http: reqwest::Client,
    refresh_lock: tokio::sync::Mutex<()>,
    sign_in_cancel: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    /// A broken `accounts.json` found outside `status()` (e.g. by the startup cleanup).
    /// The file is moved aside on first read, so the error is kept here for `status()` to show once.
    storage_error: std::sync::Mutex<Option<SiwcError>>,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn label_for(m: &AccountMeta) -> String {
    let short: String = m.client_id.chars().rev().take(6).collect::<String>().chars().rev().collect();
    match &m.email {
        Some(e) => format!("{e} (…{short})"),
        None => format!("ChatGPT アカウント (…{short})"),
    }
}

impl Siwc {
    pub fn new(dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("fix-storage-gui/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("http client");
        Self { store: Store::new(dir), http, refresh_lock: tokio::sync::Mutex::new(()), sign_in_cancel: std::sync::Mutex::new(None), storage_error: std::sync::Mutex::new(None) }
    }

    /// `accounts.json`, or a `storage` error. Never an empty list in place of an unreadable file.
    fn accounts(&self) -> Result<store::AccountsFile, SiwcError> {
        self.store.accounts().map_err(|e| {
            let err = SiwcError::new("storage", e);
            *self.storage_error.lock().unwrap() = Some(err.clone());
            err
        })
    }

    pub fn status(&self) -> Result<Status, SiwcError> {
        let host_id = self.store.host_id().map_err(|e| SiwcError::new("storage", e))?;
        if let Some(e) = self.storage_error.lock().unwrap().take() {
            return Err(e);
        }
        let a = self.accounts().inspect_err(|_| {
            self.storage_error.lock().unwrap().take();
        })?;
        let accounts = a
            .accounts
            .iter()
            .map(|m| AccountView {
                client_id: m.client_id.clone(),
                label: label_for(m),
                email: m.email.clone(),
                plan_enabled: m.plan_enabled,
                signed_in: self.store.load_credentials(&m.client_id).is_some(),
                needs_reauth: m.needs_reauth,
            })
            .collect::<Vec<_>>();
        let active_plan = a.active.as_ref().and_then(|id| accounts.iter().find(|x| &x.client_id == id)).map(|x| x.plan_enabled && x.signed_in).unwrap_or(false);
        Ok(Status { host_id, active: a.active.clone(), accounts, show_welcome: active_plan && !a.welcome_shown })
    }

    pub fn ack_welcome(&self) -> Result<(), SiwcError> {
        let mut a = self.accounts()?;
        a.welcome_shown = true;
        self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))
    }

    pub fn cancel_sign_in(&self) {
        if let Some(flag) = self.sign_in_cancel.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn switch_account(&self, client_id: &str) -> Result<(), SiwcError> {
        let mut a = self.accounts()?;
        if !a.accounts.iter().any(|m| m.client_id == client_id) {
            return Err(SiwcError::new("invalid", "そのアカウントは登録されていません"));
        }
        a.active = Some(client_id.to_string());
        self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))
    }

    /// Runs the whole browser sign-in. `client_id = None` registers a new client
    /// (`dynamic_agent_client`); otherwise reauthorises that saved registration.
    pub async fn sign_in(&self, client_id: Option<String>, prompt_consent: bool, open_browser: impl FnOnce(&str) -> Result<(), String>) -> Result<AccountView, SiwcError> {
        let host_id = self.store.host_id().map_err(|e| SiwcError::new("storage", e))?;
        let accounts = self.accounts()?;
        let existing = client_id.as_ref().and_then(|id| accounts.accounts.iter().find(|m| &m.client_id == id).cloned());
        if client_id.is_some() && existing.is_none() {
            return Err(SiwcError::new("invalid", "そのアカウントは登録されていません"));
        }
        let old_creds = existing.as_ref().and_then(|m| self.store.load_credentials(&m.client_id));

        let (listener, redirect_uri) = oauth::bind_loopback()?;
        let state = oauth::random_value();
        let nonce = oauth::random_value();
        let verifier = oauth::random_value();
        let challenge = oauth::pkce_challenge(&verifier);
        let url = oauth::authorize_url(&oauth::AuthRequest {
            client_id: existing.as_ref().map(|m| m.client_id.as_str()),
            host_id: &host_id,
            redirect_uri: &redirect_uri,
            state: &state,
            nonce: &nonce,
            challenge: &challenge,
            id_token_hint: old_creds.as_ref().map(|c| c.id_token.as_str()),
            login_hint: existing.as_ref().and_then(|m| m.email.as_deref()),
            prompt_consent,
        });

        let cancel = Arc::new(AtomicBool::new(false));
        *self.sign_in_cancel.lock().unwrap() = Some(cancel.clone());
        // Listener is already bound, so it is safe to open the browser now.
        open_browser(&url).map_err(|e| SiwcError::new("browser", format!("ブラウザを開けません: {e}")))?;
        let params = tokio::task::spawn_blocking(move || oauth::wait_for_callback(listener, cancel, Duration::from_secs(600)))
            .await
            .map_err(|e| SiwcError::new("callback_failed", e.to_string()))??;
        *self.sign_in_cancel.lock().unwrap() = None;

        // 1. state first, then OAuth errors.
        if params.get("state").map(String::as_str) != Some(state.as_str()) {
            return Err(SiwcError::new("state_mismatch", "サインインの応答が一致しません。もう一度試してください"));
        }
        if let Some(err) = params.get("error") {
            if err == "access_denied" {
                return Err(SiwcError::new("consent_declined", "ChatGPT プランの利用が許可されませんでした").with_code(Some(err.clone())));
            }
            return Err(SiwcError::new("oauth_error", params.get("error_description").cloned().unwrap_or_default()).with_code(Some(err.clone())));
        }
        let code = params.get("code").ok_or_else(|| SiwcError::new("oauth_error", "認可コードがありません"))?;

        // 2. issued client id.
        let issued = match &existing {
            None => {
                let id = params.get("client_id").cloned().unwrap_or_default();
                if id.is_empty() || id == oauth::DYNAMIC_CLIENT {
                    return Err(SiwcError::new("registration_incomplete", "クライアント登録が完了しませんでした"));
                }
                id
            }
            Some(m) => {
                if let Some(id) = params.get("client_id") {
                    if id != &m.client_id {
                        return Err(SiwcError::new("client_mismatch", "別のクライアント ID が返されたため中止しました"));
                    }
                }
                m.client_id.clone()
            }
        };

        // 3. exchange.
        let tokens = oauth::exchange_code(&self.http, &issued, code, &verifier, &redirect_uri).await?;
        let received = now();
        let id_token = tokens.id_token.clone().ok_or_else(|| SiwcError::new("invalid_id_token", "ID トークンがありません"))?;

        // 4. validate ID token and scopes.
        let claims = oauth::verify_id_token(&self.http, &id_token, &issued, Some(&nonce)).await?;
        if let Some(m) = &existing {
            if !m.subject.is_empty() && m.subject != claims.sub {
                return Err(SiwcError::new("account_mismatch", "選んだアカウントとは別のアカウントでサインインされました。保存済みの情報は変更していません"));
            }
        }
        let scopes = oauth::split_scopes(tokens.scope.as_deref());
        let plan_enabled = scopes.iter().any(|s| s == oauth::PLAN_SCOPE);

        // 5. one registration per person: decide before anything is stored.
        // Held so a refresh of an account that is about to be dropped can't run at the same time.
        let _guard = self.refresh_lock.lock().await;
        let mut a = self.accounts()?;
        let resolution = resolve_same_subject(&a.accounts, &issued, &claims.sub, existing.is_none(), plan_enabled, |m| {
            !m.needs_reauth && self.store.load_credentials(&m.client_id).is_some()
        });
        match resolution {
            SubjectResolution::UseExisting { client_id: keep, drop } => {
                // The registration just created is not kept: revoke its tokens without storing them.
                if let Some(rt) = tokens.refresh_token.as_deref() {
                    let _ = oauth::revoke(&self.http, &issued, rt).await;
                }
                for id in drop.iter().filter(|id| **id != issued) {
                    let _ = self.discard(id).await;
                }
                a.accounts.retain(|m| !drop.contains(&m.client_id));
                a.active = Some(keep.clone());
                self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))?;
                let m = a.accounts.iter().find(|m| m.client_id == keep).cloned().unwrap_or_default();
                Ok(AccountView { client_id: keep, label: label_for(&m), email: m.email.clone(), plan_enabled: m.plan_enabled, signed_in: true, needs_reauth: false })
            }
            SubjectResolution::KeepNew { drop } => {
                let creds = Credentials {
                    id_token,
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    token_type: tokens.token_type.unwrap_or_else(|| "Bearer".into()),
                    expires_at: received + tokens.expires_in.unwrap_or(3600),
                    scopes: scopes.clone(),
                    saved_at: received,
                };
                self.store.save_credentials(&issued, &creds).map_err(|e| SiwcError::new("storage", e))?;
                let meta = AccountMeta { client_id: issued.clone(), subject: claims.sub, email: claims.email, scopes, plan_enabled, needs_reauth: false };
                a.accounts.retain(|m| !drop.contains(&m.client_id));
                match a.accounts.iter_mut().find(|m| m.client_id == issued) {
                    Some(m) => *m = meta.clone(),
                    None => a.accounts.push(meta.clone()),
                }
                a.active = Some(issued.clone());
                self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))?;
                for id in &drop {
                    let _ = self.discard(id).await;
                }
                Ok(AccountView { client_id: issued, label: label_for(&meta), email: meta.email, plan_enabled, signed_in: true, needs_reauth: false })
            }
        }
    }

    /// Revokes the refresh token of `client_id` (best effort) and deletes its keychain item.
    /// Returns whether the remote revocation is known to have happened. Caller holds `refresh_lock`.
    async fn discard(&self, client_id: &str) -> Result<bool, SiwcError> {
        let creds = self.store.load_credentials(client_id);
        let revoked = match creds.as_ref().and_then(|c| c.refresh_token.clone()) {
            Some(rt) => oauth::revoke(&self.http, client_id, &rt).await,
            None => creds.is_none(),
        };
        self.store.clear_credentials(client_id).map_err(|e| SiwcError::new("storage", e))?;
        Ok(revoked)
    }

    /// Keychain items under this app's service that `accounts.json` doesn't know. Run once at startup,
    /// synchronously, before any sign-in can store a new item. Errors (including a broken
    /// `accounts.json`) mean "don't clean up"; they never mean "no accounts".
    pub fn orphan_credentials(&self) -> Result<Vec<String>, SiwcError> {
        let a = self.accounts()?;
        let ids = store::keychain_client_ids().map_err(|e| SiwcError::new("storage", e))?;
        Ok(orphan_items(&ids, &a))
    }

    /// Revokes and deletes the items found by [`Self::orphan_credentials`].
    pub async fn remove_orphans(&self, client_ids: Vec<String>) {
        let _guard = self.refresh_lock.lock().await;
        for id in client_ids {
            if let Err(e) = self.discard(&id).await {
                eprintln!("siwc: could not remove orphaned keychain item {id}: {e}");
            }
        }
    }

    fn mark_reauth(&self, client_id: &str) {
        let _ = self.store.clear_credentials(client_id);
        // An unreadable accounts.json is left alone (not replaced by an empty list).
        let Ok(mut a) = self.accounts() else { return };
        if let Some(m) = a.accounts.iter_mut().find(|m| m.client_id == client_id) {
            m.needs_reauth = true;
        }
        let _ = self.store.save_accounts(&a);
    }

    /// Returns a usable access token for the active account, refreshing near expiry.
    /// Refreshes are serialised (`refresh_lock`) so a rotating refresh token is never used twice.
    /// If `stale_access_token` is `Some`, refresh only when the stored token is still that
    /// value — a concurrent 401 retry may already have refreshed it.
    async fn access_token(&self, stale_access_token: Option<&str>) -> Result<(String, String), SiwcError> {
        let a = self.accounts()?;
        let client_id = a.active.clone().ok_or_else(|| SiwcError::new("signed_out", "ChatGPT にサインインしていません"))?;
        let meta = a.accounts.iter().find(|m| m.client_id == client_id).cloned().ok_or_else(|| SiwcError::new("signed_out", "ChatGPT にサインインしていません"))?;
        let _guard = self.refresh_lock.lock().await;
        let creds = self.store.load_credentials(&client_id).ok_or_else(|| SiwcError::new("reauth_required", "もう一度サインインしてください"))?;
        if !creds.scopes.iter().any(|s| s == oauth::PLAN_SCOPE) {
            return Err(SiwcError::new("plan_not_enabled", "ChatGPT プランの利用が許可されていません"));
        }
        if !needs_refresh(&creds, now(), stale_access_token) {
            return Ok((client_id, creds.access_token));
        }
        let Some(rt) = creds.refresh_token.clone() else {
            self.mark_reauth(&client_id);
            return Err(SiwcError::new("reauth_required", "もう一度サインインしてください"));
        };
        match oauth::refresh(&self.http, &client_id, &rt).await {
            Ok(t) => {
                let received = now();
                let mut id_token = creds.id_token.clone();
                if let Some(new_id) = t.id_token.clone() {
                    if let Ok(c) = oauth::verify_id_token(&self.http, &new_id, &client_id, None).await {
                        if c.sub == meta.subject {
                            id_token = new_id;
                        }
                    }
                }
                let scopes = match t.scope.as_deref() {
                    Some(s) => oauth::split_scopes(Some(s)),
                    None => creds.scopes.clone(),
                };
                let new = Credentials {
                    id_token,
                    access_token: t.access_token.clone(),
                    refresh_token: t.refresh_token.or(creds.refresh_token),
                    token_type: t.token_type.unwrap_or(creds.token_type),
                    expires_at: received + t.expires_in.unwrap_or(3600),
                    scopes,
                    saved_at: received,
                };
                self.store.save_credentials(&client_id, &new).map_err(|e| SiwcError::new("storage", e))?;
                Ok((client_id, t.access_token))
            }
            Err(e) if e.kind == "reauth_required" => {
                self.mark_reauth(&client_id);
                Err(e)
            }
            // Temporary failure: keep credentials.
            Err(e) => Err(e),
        }
    }

    pub async fn models(&self) -> Result<Vec<api::Model>, SiwcError> {
        let (_, token) = self.access_token(None).await?;
        match api::list_models(&self.http, &token).await {
            Err(e) if e.status == Some(401) => {
                let (_, token) = self.access_token(Some(&token)).await?;
                api::list_models(&self.http, &token).await
            }
            other => other,
        }
    }

    /// Streams one Responses API request. Concurrent calls are supported: each has its own
    /// HTTP stream, and `siwc_respond` does not take a global lock around inference.
    /// Token refresh is single-flight (see `access_token`).
    pub async fn respond(&self, model: &str, instructions: &str, input: &str, on_delta: impl FnMut(usize) + Clone) -> Result<String, SiwcError> {
        let (_, token) = self.access_token(None).await?;
        match api::respond(&self.http, &token, model, instructions, input, on_delta.clone()).await {
            // Retry once with a fresh token; a terminal refresh error turns into reauth_required.
            Err(e) if e.status == Some(401) => {
                let (_, token) = self.access_token(Some(&token)).await?;
                api::respond(&self.http, &token, model, instructions, input, on_delta).await
            }
            other => other,
        }
    }

    /// Signs out of every saved account: revokes each refresh token (best effort with retries),
    /// then deletes its keychain item. The account/client mapping and host ID are kept for a later
    /// sign-in. `remote_revoked` is true only if every revocation is known to have happened.
    pub async fn sign_out(&self) -> Result<SignOutResult, SiwcError> {
        let mut a = self.accounts()?;
        let _guard = self.refresh_lock.lock().await;
        let mut remote_revoked = true;
        let mut first_err = None;
        for client_id in sign_out_targets(&a) {
            match self.discard(&client_id).await {
                Ok(r) => remote_revoked &= r,
                Err(e) => {
                    remote_revoked = false;
                    first_err.get_or_insert(e);
                }
            }
        }
        a.active = None;
        self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))?;
        match first_err {
            Some(e) => Err(e),
            None => Ok(SignOutResult { remote_revoked }),
        }
    }
}

/// What to do when a sign-in's ID-token subject already has another saved registration.
/// `drop` lists registrations to revoke, delete from the keychain and remove from `accounts.json`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SubjectResolution {
    /// Keep the registration just signed in to (`issued`).
    KeepNew { drop: Vec<String> },
    /// Throw away the registration just created and switch to this saved one.
    UseExisting { client_id: String, drop: Vec<String> },
}

/// One registration per person (ID-token `sub`).
///
/// * A brand-new registration (`is_new`) for someone who already has a usable saved registration
///   (signed in, and allowing plan usage if the new one does) is discarded in favour of it.
/// * Otherwise the new/reauthorised registration is kept and every other one for that person is
///   dropped. This covers re-signing in after a sign-out, when no saved registration has tokens.
/// * Registrations with an empty subject never match (same rule as the reauth subject check).
pub(crate) fn resolve_same_subject(
    accounts: &[AccountMeta],
    issued: &str,
    subject: &str,
    is_new: bool,
    new_plan: bool,
    usable: impl Fn(&AccountMeta) -> bool,
) -> SubjectResolution {
    if subject.is_empty() {
        return SubjectResolution::KeepNew { drop: vec![] };
    }
    let same: Vec<&AccountMeta> = accounts.iter().filter(|m| !m.subject.is_empty() && m.subject == subject && m.client_id != issued).collect();
    if is_new {
        if let Some(keep) = same.iter().find(|m| (m.plan_enabled || !new_plan) && usable(m)) {
            let mut drop = vec![issued.to_string()];
            drop.extend(same.iter().filter(|m| m.client_id != keep.client_id).map(|m| m.client_id.clone()));
            return SubjectResolution::UseExisting { client_id: keep.client_id.clone(), drop };
        }
    }
    SubjectResolution::KeepNew { drop: same.iter().map(|m| m.client_id.clone()).collect() }
}

/// Every saved registration (and the active one, even if its metadata is missing).
pub(crate) fn sign_out_targets(a: &store::AccountsFile) -> Vec<String> {
    let mut ids: Vec<String> = a.accounts.iter().map(|m| m.client_id.clone()).chain(a.active.clone()).collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Keychain items `accounts.json` doesn't list. Their tokens can't be reached from the app any more.
pub(crate) fn orphan_items(keychain: &[String], a: &store::AccountsFile) -> Vec<String> {
    keychain.iter().filter(|id| !a.accounts.iter().any(|m| &m.client_id == *id)).cloned().collect()
}

/// Whether the stored credentials need a refresh, given the refresh lock is already held.
/// `stale_access_token` is the token a request just got a 401 with.
pub(crate) fn needs_refresh(creds: &store::Credentials, now: i64, stale_access_token: Option<&str>) -> bool {
    match stale_access_token {
        Some(stale) => creds.access_token == stale,
        None => creds.expires_at.saturating_sub(now) <= 300,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use store::Credentials;

    fn creds(access: &str, expires_at: i64) -> Credentials {
        Credentials {
            id_token: "id".into(),
            access_token: access.into(),
            refresh_token: Some("rt".into()),
            token_type: "Bearer".into(),
            expires_at,
            scopes: vec![oauth::PLAN_SCOPE.into()],
            saved_at: 0,
        }
    }

    #[test]
    fn refresh_when_near_expiry() {
        let c = creds("tok-a", 1_000);
        assert!(needs_refresh(&c, 800, None)); // 200s left
        assert!(!needs_refresh(&c, 600, None)); // 400s left
    }

    #[test]
    fn concurrent_401_does_not_refresh_a_replaced_token() {
        let c = creds("tok-new", 10_000);
        // Another request already refreshed; this 401 was for the old token.
        assert!(!needs_refresh(&c, 1, Some("tok-old")));
        // Still the same stale token: refresh.
        assert!(needs_refresh(&creds("tok-old", 10_000), 1, Some("tok-old")));
    }

    fn meta(client: &str, subject: &str) -> AccountMeta {
        AccountMeta { client_id: client.into(), subject: subject.into(), plan_enabled: true, ..Default::default() }
    }

    #[test]
    fn same_subject_new_registration_uses_existing_signed_in_one() {
        let accounts = vec![meta("oaiapp_old", "user-1"), meta("oaiapp_other", "user-2")];
        let r = resolve_same_subject(&accounts, "oaiapp_new", "user-1", true, true, |_| true);
        assert_eq!(r, SubjectResolution::UseExisting { client_id: "oaiapp_old".into(), drop: vec!["oaiapp_new".into()] });
    }

    #[test]
    fn sign_out_covers_every_saved_account() {
        let a = store::AccountsFile { active: Some("oaiapp_a".into()), accounts: vec![meta("oaiapp_a", "u"), meta("oaiapp_b", "u")], welcome_shown: true };
        let mut t = sign_out_targets(&a);
        t.sort();
        assert_eq!(t, vec!["oaiapp_a".to_string(), "oaiapp_b".to_string()]);
    }

    #[test]
    fn orphan_items_are_keychain_entries_missing_from_accounts() {
        let a = store::AccountsFile { active: None, accounts: vec![meta("oaiapp_a", "u")], welcome_shown: false };
        let kc = vec!["oaiapp_a".to_string(), "oaiapp_gone".to_string()];
        assert_eq!(orphan_items(&kc, &a), vec!["oaiapp_gone".to_string()]);
    }

    #[test]
    fn same_subject_rules() {
        let mut no_plan = meta("oaiapp_old", "user-1");
        no_plan.plan_enabled = false;
        // Saved one has no tokens (signed out): keep the new one, drop the old.
        let r = resolve_same_subject(&[meta("oaiapp_old", "user-1")], "oaiapp_new", "user-1", true, true, |_| false);
        assert_eq!(r, SubjectResolution::KeepNew { drop: vec!["oaiapp_old".into()] });
        // New one allows plan usage, saved one doesn't: keep the new one.
        let r = resolve_same_subject(&[no_plan.clone()], "oaiapp_new", "user-1", true, true, |_| true);
        assert_eq!(r, SubjectResolution::KeepNew { drop: vec!["oaiapp_old".into()] });
        // Neither allows plan usage: the saved one is enough.
        let r = resolve_same_subject(&[no_plan], "oaiapp_new", "user-1", true, false, |_| true);
        assert_eq!(r, SubjectResolution::UseExisting { client_id: "oaiapp_old".into(), drop: vec!["oaiapp_new".into()] });
        // Different person: nothing to do.
        let r = resolve_same_subject(&[meta("oaiapp_old", "user-2")], "oaiapp_new", "user-1", true, true, |_| true);
        assert_eq!(r, SubjectResolution::KeepNew { drop: vec![] });
        // Empty subjects never match.
        let r = resolve_same_subject(&[meta("oaiapp_old", "")], "oaiapp_new", "", true, true, |_| true);
        assert_eq!(r, SubjectResolution::KeepNew { drop: vec![] });
        let r = resolve_same_subject(&[meta("oaiapp_old", "")], "oaiapp_new", "user-1", true, true, |_| true);
        assert_eq!(r, SubjectResolution::KeepNew { drop: vec![] });
    }

    #[test]
    fn reauth_of_a_saved_registration_keeps_it_and_drops_duplicates() {
        // accounts.json that already has the same person twice (the state found on a real Mac).
        let accounts = vec![meta("oaiapp_a", "user-1"), meta("oaiapp_b", "user-1")];
        let r = resolve_same_subject(&accounts, "oaiapp_a", "user-1", false, true, |_| true);
        assert_eq!(r, SubjectResolution::KeepNew { drop: vec!["oaiapp_b".into()] });
        // A new registration on top of two saved ones: use the first usable one, drop the rest.
        let r = resolve_same_subject(&accounts, "oaiapp_new", "user-1", true, true, |m| m.client_id == "oaiapp_b");
        assert_eq!(r, SubjectResolution::UseExisting { client_id: "oaiapp_b".into(), drop: vec!["oaiapp_new".into(), "oaiapp_a".into()] });
    }

    #[test]
    fn sign_out_with_no_active_account_still_covers_saved_ones() {
        let a = store::AccountsFile { active: None, accounts: vec![meta("oaiapp_a", "u")], welcome_shown: true };
        assert_eq!(sign_out_targets(&a), vec!["oaiapp_a".to_string()]);
        assert!(sign_out_targets(&store::AccountsFile::default()).is_empty());
    }

    #[test]
    fn no_orphans_when_every_item_is_known() {
        let a = store::AccountsFile { active: None, accounts: vec![meta("oaiapp_a", "u"), meta("oaiapp_b", "v")], welcome_shown: false };
        assert!(orphan_items(&["oaiapp_a".to_string(), "oaiapp_b".to_string()], &a).is_empty());
        // No accounts.json (fresh data folder): every item is unreachable.
        assert_eq!(orphan_items(&["oaiapp_a".to_string()], &store::AccountsFile::default()), vec!["oaiapp_a".to_string()]);
    }
}

