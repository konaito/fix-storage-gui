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
        Self { store: Store::new(dir), http, refresh_lock: tokio::sync::Mutex::new(()), sign_in_cancel: std::sync::Mutex::new(None) }
    }

    pub fn status(&self) -> Result<Status, SiwcError> {
        let host_id = self.store.host_id().map_err(|e| SiwcError::new("storage", e))?;
        let a = self.store.accounts();
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
        let mut a = self.store.accounts();
        a.welcome_shown = true;
        self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))
    }

    pub fn cancel_sign_in(&self) {
        if let Some(flag) = self.sign_in_cancel.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn switch_account(&self, client_id: &str) -> Result<(), SiwcError> {
        let mut a = self.store.accounts();
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
        let accounts = self.store.accounts();
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

        // 5. store.
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
        let mut a = self.store.accounts();
        let meta = AccountMeta { client_id: issued.clone(), subject: claims.sub, email: claims.email, scopes, plan_enabled, needs_reauth: false };
        match a.accounts.iter_mut().find(|m| m.client_id == issued) {
            Some(m) => *m = meta.clone(),
            None => a.accounts.push(meta.clone()),
        }
        a.active = Some(issued.clone());
        self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))?;
        Ok(AccountView { client_id: issued, label: label_for(&meta), email: meta.email, plan_enabled, signed_in: true, needs_reauth: false })
    }

    fn mark_reauth(&self, client_id: &str) {
        let _ = self.store.clear_credentials(client_id);
        let mut a = self.store.accounts();
        if let Some(m) = a.accounts.iter_mut().find(|m| m.client_id == client_id) {
            m.needs_reauth = true;
        }
        let _ = self.store.save_accounts(&a);
    }

    /// Returns a usable access token for the active account, refreshing near expiry.
    /// Refreshes are serialised so a rotating refresh token is never used twice.
    async fn access_token(&self, force_refresh: bool) -> Result<(String, String), SiwcError> {
        let a = self.store.accounts();
        let client_id = a.active.clone().ok_or_else(|| SiwcError::new("signed_out", "ChatGPT にサインインしていません"))?;
        let meta = a.accounts.iter().find(|m| m.client_id == client_id).cloned().ok_or_else(|| SiwcError::new("signed_out", "ChatGPT にサインインしていません"))?;
        let _guard = self.refresh_lock.lock().await;
        let creds = self.store.load_credentials(&client_id).ok_or_else(|| SiwcError::new("reauth_required", "もう一度サインインしてください"))?;
        if !creds.scopes.iter().any(|s| s == oauth::PLAN_SCOPE) {
            return Err(SiwcError::new("plan_not_enabled", "ChatGPT プランの利用が許可されていません"));
        }
        if !force_refresh && creds.expires_at - now() > 300 {
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
        let (_, token) = self.access_token(false).await?;
        match api::list_models(&self.http, &token).await {
            Err(e) if e.status == Some(401) => {
                let (_, token) = self.access_token(true).await?;
                api::list_models(&self.http, &token).await
            }
            other => other,
        }
    }

    pub async fn respond(&self, model: &str, instructions: &str, input: &str, on_delta: impl FnMut(usize) + Clone) -> Result<String, SiwcError> {
        let (_, token) = self.access_token(false).await?;
        match api::respond(&self.http, &token, model, instructions, input, on_delta.clone()).await {
            // Retry once with a fresh token; a terminal refresh error turns into reauth_required.
            Err(e) if e.status == Some(401) => {
                let (_, token) = self.access_token(true).await?;
                api::respond(&self.http, &token, model, instructions, input, on_delta).await
            }
            other => other,
        }
    }

    /// Revokes the refresh token (best effort with retries), then clears local tokens.
    /// The account/client mapping and host ID are kept for a later sign-in.
    pub async fn sign_out(&self) -> Result<SignOutResult, SiwcError> {
        let mut a = self.store.accounts();
        let Some(client_id) = a.active.clone() else { return Ok(SignOutResult { remote_revoked: true }) };
        let _guard = self.refresh_lock.lock().await;
        let creds = self.store.load_credentials(&client_id);
        let remote_revoked = match creds.as_ref().and_then(|c| c.refresh_token.clone()) {
            Some(rt) => oauth::revoke(&self.http, &client_id, &rt).await,
            None => creds.is_none(),
        };
        self.store.clear_credentials(&client_id).map_err(|e| SiwcError::new("storage", e))?;
        a.active = None;
        self.store.save_accounts(&a).map_err(|e| SiwcError::new("storage", e))?;
        Ok(SignOutResult { remote_revoked })
    }
}
