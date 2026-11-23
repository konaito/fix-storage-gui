//! Sign in with ChatGPT (ChatGPT plan usage for open-source / local apps).
//! Tokens never leave the Rust side: the web view only sees account metadata and results.

pub mod api;
pub mod error;
pub mod oauth;
pub mod store;

use error::SiwcError;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use store::{AccountMeta, Credentials, Store};
use tokio::sync::watch;

/// ChatGPT Settings → Usage (same URL as the official DevKit's CHATGPT_USAGE_URL).
pub const USAGE_URL: &str = "https://chatgpt.com/settings/usage";

/// Longest wait for the next bytes of a response (headers or a stream chunk). A stalled stream
/// ends as `interrupted` instead of hanging (#21). Our own choice; the docs give no number.
pub const READ_TIMEOUT: Duration = Duration::from_secs(90);

/// Longest time one Responses API stream may take in total, ending as `ai_timeout` (#21).
/// Our own choice for a batch of 25 items; the docs give no number.
pub const RESPOND_LIMIT: Duration = Duration::from_secs(300);

pub(crate) fn http_client(read_timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("fix-storage-gui/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(read_timeout)
        .build()
        .expect("http client")
}

/// Cancel switches for in-flight `respond` calls, keyed by the UI's request ID (#21).
#[derive(Default)]
pub(crate) struct Cancels {
    inner: std::sync::Mutex<CancelsInner>,
}

#[derive(Default)]
struct CancelsInner {
    live: HashMap<String, watch::Sender<bool>>,
    /// IDs cancelled before their request reached Rust.
    early: HashSet<String>,
}

/// Bound for `early`: a cancel that loses the race with a finished request would otherwise stay forever.
const EARLY_CANCELS_MAX: usize = 256;

impl Cancels {
    pub(crate) fn register(&self, id: &str) -> CancelGuard<'_> {
        let mut inner = self.inner.lock().unwrap();
        let already = inner.early.remove(id);
        let (tx, rx) = watch::channel(already);
        inner.live.insert(id.to_string(), tx);
        CancelGuard { cancels: self, id: id.to_string(), rx }
    }

    pub(crate) fn cancel(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        match inner.live.get(id) {
            Some(tx) => {
                let _ = tx.send(true);
            }
            None => {
                if inner.early.len() >= EARLY_CANCELS_MAX {
                    inner.early.clear();
                }
                inner.early.insert(id.to_string());
            }
        }
    }
}

pub(crate) struct CancelGuard<'a> {
    cancels: &'a Cancels,
    id: String,
    rx: watch::Receiver<bool>,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.cancels.inner.lock().unwrap().live.remove(&self.id);
    }
}

/// Runs `fut` until it finishes, `limit` passes (`ai_timeout`) or the request is cancelled
/// (`ai_cancelled`). Dropping `fut` closes its HTTP stream.
pub(crate) async fn guarded<T>(fut: impl Future<Output = Result<T, SiwcError>>, limit: Duration, cancel: &mut watch::Receiver<bool>) -> Result<T, SiwcError> {
    let cancelled = async {
        if cancel.wait_for(|c| *c).await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        biased;
        _ = cancelled => Err(SiwcError::new("ai_cancelled", "中止しました")),
        r = tokio::time::timeout(limit, fut) => r.unwrap_or_else(|_| Err(SiwcError::new("ai_timeout", format!("{} 秒以内に応答が終わりませんでした", limit.as_secs())))),
    }
}

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
    respond_cancels: Cancels,
    /// A broken `accounts.json` found outside `status()` (e.g. by the startup cleanup).
    /// The file is moved aside on first read, so the error is kept here for `status()` to show once.
    storage_error: std::sync::Mutex<Option<SiwcError>>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn label_for(m: &AccountMeta) -> String {
    let short: String = m
        .client_id
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    match &m.email {
        Some(e) => format!("{e} (…{short})"),
        None => format!("ChatGPT アカウント (…{short})"),
    }
}

impl Siwc {
    pub fn new(dir: PathBuf) -> Self {
        let http = http_client(READ_TIMEOUT);
        Self {
            store: Store::new(dir),
            http,
            refresh_lock: tokio::sync::Mutex::new(()),
            sign_in_cancel: std::sync::Mutex::new(None),
            respond_cancels: Cancels::default(),
            storage_error: std::sync::Mutex::new(None),
        }
    }

    /// `accounts.json`, or a `storage` error. Never an empty list in place of an unreadable file.
    fn accounts(&self) -> Result<store::AccountsFile, SiwcError> {
        self.store.accounts().map_err(|e| {
            let err = SiwcError::new("storage", e);
            *self.storage_error.lock().unwrap() = Some(err.clone());
            err
        })
    }

    #[allow(clippy::result_large_err)]
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
        let active_plan = a
            .active
            .as_ref()
            .and_then(|id| accounts.iter().find(|x| &x.client_id == id))
            .map(|x| x.plan_enabled && x.signed_in)
            .unwrap_or(false);
        Ok(Status {
            host_id,
            active: a.active.clone(),
            accounts,
            show_welcome: active_plan && !a.welcome_shown,
        })
    }

    #[allow(clippy::result_large_err)]
    pub fn ack_welcome(&self) -> Result<(), SiwcError> {
        let mut a = self.accounts()?;
        a.welcome_shown = true;
        self.store
            .save_accounts(&a)
            .map_err(|e| SiwcError::new("storage", e))
    }

    /// Makes this the only running sign-in: a sign-in still waiting is cancelled (it ends as
    /// `cancelled` and frees its loopback port), and the returned turn owns the cancel switch.
    /// Dropping the turn, on any path out of `sign_in`, clears the switch if it is still this one (#30).
    fn begin_sign_in(&self) -> SignInTurn<'_> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self.sign_in_cancel.lock().unwrap().replace(flag.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
        SignInTurn { slot: &self.sign_in_cancel, flag }
    }

    pub fn cancel_sign_in(&self) {
        if let Some(flag) = self.sign_in_cancel.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    #[allow(clippy::result_large_err)]
    pub fn switch_account(&self, client_id: &str) -> Result<(), SiwcError> {
        let mut a = self.accounts()?;
        if !a.accounts.iter().any(|m| m.client_id == client_id) {
            return Err(SiwcError::new(
                "invalid",
                "そのアカウントは登録されていません",
            ));
        }
        a.active = Some(client_id.to_string());
        self.store
            .save_accounts(&a)
            .map_err(|e| SiwcError::new("storage", e))
    }

    /// Runs the whole browser sign-in. `client_id = None` registers a new client
    /// (`dynamic_agent_client`); otherwise reauthorises that saved registration.
    #[allow(clippy::result_large_err)]
    pub async fn sign_in(&self, client_id: Option<String>, prompt_consent: bool, open_browser: impl FnOnce(&str) -> Result<(), String>) -> Result<AccountView, SiwcError> {
        let turn = self.begin_sign_in();
        let host_id = self.store.host_id().map_err(|e| SiwcError::new("storage", e))?;
        let accounts = self.accounts()?;
        let existing = client_id.as_ref().and_then(|id| accounts.accounts.iter().find(|m| &m.client_id == id).cloned());
        if client_id.is_some() && existing.is_none() {
            return Err(SiwcError::new(
                "invalid",
                "そのアカウントは登録されていません",
            ));
        }
        let old_creds = existing
            .as_ref()
            .and_then(|m| self.store.load_credentials(&m.client_id));

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

        let cancel = turn.flag.clone();
        // Listener is already bound, so it is safe to open the browser now.
        open_browser(&url).map_err(|e| SiwcError::new("browser", format!("ブラウザを開けません: {e}")))?;
        let expected_state = state.clone();
        let params = tokio::task::spawn_blocking(move || oauth::wait_for_callback(listener, cancel, Duration::from_secs(600), &expected_state))
            .await
            .map_err(|e| SiwcError::new("callback_failed", e.to_string()))??;
        // The browser part is over; "cancel" no longer applies to this sign-in.
        drop(turn);

        // 1. state first (wait_for_callback only returns a matching one; checked again here), then OAuth errors.
        if params.get("state").map(String::as_str) != Some(state.as_str()) {
            return Err(SiwcError::new(
                "state_mismatch",
                "サインインの応答が一致しません。もう一度試してください",
            ));
        }
        if let Some(err) = params.get("error") {
            if err == "access_denied" {
                return Err(SiwcError::new(
                    "consent_declined",
                    "ChatGPT プランの利用が許可されませんでした",
                )
                .with_code(Some(err.clone())));
            }
            return Err(SiwcError::new(
                "oauth_error",
                params.get("error_description").cloned().unwrap_or_default(),
            )
            .with_code(Some(err.clone())));
        }
        let code = params
            .get("code")
            .ok_or_else(|| SiwcError::new("oauth_error", "認可コードがありません"))?;

        // 2. issued client id.
        let issued = match &existing {
            None => {
                let id = params.get("client_id").cloned().unwrap_or_default();
                if id.is_empty() || id == oauth::DYNAMIC_CLIENT {
                    return Err(SiwcError::new(
                        "registration_incomplete",
                        "クライアント登録が完了しませんでした",
                    ));
                }
                id
            }
            Some(m) => {
                if let Some(id) = params.get("client_id") {
                    if id != &m.client_id {
                        return Err(SiwcError::new(
                            "client_mismatch",
                            "別のクライアント ID が返されたため中止しました",
                        ));
                    }
                }
                m.client_id.clone()
            }
        };

        // 3. exchange.
        let tokens =
            oauth::exchange_code(&self.http, &issued, code, &verifier, &redirect_uri).await?;
        let received = now();
        let id_token = tokens
            .id_token
            .clone()
            .ok_or_else(|| SiwcError::new("invalid_id_token", "ID トークンがありません"))?;

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

    /// The token endpoint no longer knows this registration (`invalid_client` on refresh, #29).
    /// Its tokens are deleted and it is removed from `accounts.json`, so the next sign-in registers
    /// a new client instead of reauthorising one that can't work.
    fn forget_registration(&self, client_id: &str) {
        let _ = self.store.clear_credentials(client_id);
        let Ok(mut a) = self.accounts() else { return };
        remove_registration(&mut a, client_id);
        let _ = self.store.save_accounts(&a);
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
    /// `pinned` is the account an AI run started with (#28): if it is no longer the active one,
    /// nothing is sent. Refreshes are serialised (`refresh_lock`) so a rotating refresh token is
    /// never used twice. If `stale_access_token` is `Some`, refresh only when the stored token is
    /// still that value — a concurrent 401 retry may already have refreshed it.
    async fn access_token(&self, pinned: Option<&str>, stale_access_token: Option<&str>) -> Result<(String, String), SiwcError> {
        let a = self.accounts()?;
        let client_id = request_client(a.active.as_deref(), pinned)?;
        let meta = a.accounts.iter().find(|m| m.client_id == client_id).cloned().ok_or_else(|| SiwcError::new("signed_out", "ChatGPT にサインインしていません"))?;
        let _guard = self.refresh_lock.lock().await;
        let creds = self
            .store
            .load_credentials(&client_id)
            .ok_or_else(|| SiwcError::new("reauth_required", "もう一度サインインしてください"))?;
        if !creds.scopes.iter().any(|s| s == oauth::PLAN_SCOPE) {
            return Err(SiwcError::new(
                "plan_not_enabled",
                "ChatGPT プランの利用が許可されていません",
            ));
        }
        if !needs_refresh(&creds, now(), stale_access_token) {
            return Ok((client_id, creds.access_token));
        }
        let Some(rt) = creds.refresh_token.clone() else {
            self.mark_reauth(&client_id);
            return Err(SiwcError::new(
                "reauth_required",
                "もう一度サインインしてください",
            ));
        };
        match oauth::refresh(&self.http, &client_id, &rt).await {
            Ok(t) => {
                let received = now();
                let mut id_token = creds.id_token.clone();
                if let Some(new_id) = t.id_token.clone() {
                    if let Ok(c) =
                        oauth::verify_id_token(&self.http, &new_id, &client_id, None).await
                    {
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
                self.store
                    .save_credentials(&client_id, &new)
                    .map_err(|e| SiwcError::new("storage", e))?;
                Ok((client_id, t.access_token))
            }
            Err(e) => match refresh_failure(&e.kind) {
                RefreshFailure::Reauth => {
                    self.mark_reauth(&client_id);
                    Err(e)
                }
                RefreshFailure::Forget => {
                    self.forget_registration(&client_id);
                    Err(SiwcError { kind: "client_revoked".into(), ..e })
                }
                // Temporary failure: keep credentials.
                RefreshFailure::Keep => Err(e),
            },
        }
    }

    #[allow(clippy::result_large_err)]
    pub async fn models(&self) -> Result<Vec<api::Model>, SiwcError> {
        let (_, token) = self.access_token(None, None).await?;
        match api::list_models(&self.http, &token).await {
            Err(e) if e.status == Some(401) => {
                let (_, token) = self.access_token(None, Some(&token)).await?;
                api::list_models(&self.http, &token).await
            }
            other => other,
        }
    }

    /// Streams one Responses API request. Concurrent calls are supported: each has its own
    /// HTTP stream, and `siwc_respond` does not take a global lock around inference.
    /// Token refresh is single-flight (see `access_token`). `client_id` is the account the AI run
    /// started with; it is required so a request can't silently use another account (#28).
    /// `cancel_respond(request_id)` or `RESPOND_LIMIT` ends the stream (#21). Only the stream is
    /// cut short: a token refresh always runs to the end, so a rotated refresh token is saved.
    pub async fn respond(&self, request_id: &str, client_id: &str, model: &str, instructions: &str, input: &str, on_delta: impl FnMut(usize) + Clone) -> Result<String, SiwcError> {
        let mut guard = self.respond_cancels.register(request_id);
        let (_, token) = self.access_token(Some(client_id), None).await?;
        match guarded(api::respond(&self.http, &token, model, instructions, input, on_delta.clone()), RESPOND_LIMIT, &mut guard.rx).await {
            // Retry once with a fresh token; a terminal refresh error turns into reauth_required.
            Err(e) if e.status == Some(401) => {
                let (_, token) = self.access_token(Some(client_id), Some(&token)).await?;
                guarded(api::respond(&self.http, &token, model, instructions, input, on_delta), RESPOND_LIMIT, &mut guard.rx).await
            }
            other => other,
        }
    }

    /// Cancels the `respond` call with this request ID, or the next one to start with it.
    pub fn cancel_respond(&self, request_id: &str) {
        self.respond_cancels.cancel(request_id);
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

/// Clears the cancel switch of a sign-in when it ends, unless a newer sign-in has replaced it.
struct SignInTurn<'a> {
    slot: &'a std::sync::Mutex<Option<Arc<AtomicBool>>>,
    flag: Arc<AtomicBool>,
}

impl Drop for SignInTurn<'_> {
    fn drop(&mut self) {
        let mut slot = self.slot.lock().unwrap();
        if slot.as_ref().is_some_and(|f| Arc::ptr_eq(f, &self.flag)) {
            *slot = None;
        }
    }
}

/// The account a request is sent with. Without `pinned` (model list) it is the active one.
/// With `pinned` (an AI run, #28) it must still be the active one: after a switch or a sign-out
/// the remaining batches stop instead of going to another account.
pub(crate) fn request_client(active: Option<&str>, pinned: Option<&str>) -> Result<String, SiwcError> {
    let active = active.ok_or_else(|| SiwcError::new("signed_out", "ChatGPT にサインインしていません"))?;
    match pinned {
        Some(p) if p != active => Err(SiwcError::new("account_changed", "AI 判定の途中でアカウントが切り替わったため、残りは送りませんでした")),
        _ => Ok(active.to_string()),
    }
}

/// What a failed refresh means for the saved registration.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RefreshFailure {
    /// The refresh token is dead: delete it and ask to sign in again with the same registration.
    Reauth,
    /// The registration itself is gone (`invalid_client`, #29): forget it so a new one is made.
    Forget,
    /// Temporary (network, 5xx…): keep everything.
    Keep,
}

pub(crate) fn refresh_failure(kind: &str) -> RefreshFailure {
    match kind {
        "reauth_required" => RefreshFailure::Reauth,
        "invalid_client" => RefreshFailure::Forget,
        _ => RefreshFailure::Keep,
    }
}

/// `siwc-changed` reason for errors after which the stored sign-in state has changed, so the
/// login gate must read it again (#29): "reauth" (sign in again to the same registration) or
/// "client_revoked" (the registration was removed; a new one is needed).
pub fn sign_in_change(kind: &str) -> Option<&'static str> {
    match kind {
        "reauth_required" => Some("reauth"),
        "client_revoked" => Some("client_revoked"),
        _ => None,
    }
}

pub(crate) fn remove_registration(a: &mut store::AccountsFile, client_id: &str) {
    a.accounts.retain(|m| m.client_id != client_id);
    if a.active.as_deref() == Some(client_id) {
        a.active = None;
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
pub(crate) fn needs_refresh(
    creds: &store::Credentials,
    now: i64,
    stale_access_token: Option<&str>,
) -> bool {
    match stale_access_token {
        Some(stale) => creds.access_token == stale,
        None => creds.expires_at.saturating_sub(now) <= 300,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use store::Credentials;

    /// A local server that sends the response headers and one SSE event, then goes silent
    /// without closing the connection (a stalled stream after a Wi-Fi switch or sleep, #21).
    fn stalled_server() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = sock.read(&mut buf);
            let event = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\"}\n\n";
            let head = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{event}\r\n", event.len());
            sock.write_all(head.as_bytes()).unwrap();
            sock.flush().unwrap();
            std::thread::sleep(Duration::from_secs(30));
            drop(sock);
        });
        format!("http://{addr}/v1/responses")
    }

    #[tokio::test]
    async fn stalled_stream_does_not_hang_respond() {
        let url = stalled_server();
        // Siwc::new's client, with a read timeout short enough for a test.
        let http = http_client(Duration::from_millis(300));
        let r = tokio::time::timeout(Duration::from_secs(3), api::respond_to(&http, &url, "tok", "m", "i", "x", |_| {})).await;
        let Ok(r) = r else { panic!("respond was still waiting after 3 s on a stalled stream") };
        assert_eq!(r.unwrap_err().kind, "interrupted");
    }

    #[tokio::test]
    async fn guarded_gives_up_after_the_limit() {
        let (_tx, mut rx) = watch::channel(false);
        let r = guarded(std::future::pending::<Result<(), SiwcError>>(), Duration::from_millis(50), &mut rx).await;
        assert_eq!(r.unwrap_err().kind, "ai_timeout");
    }

    #[tokio::test]
    async fn guarded_passes_results_through() {
        let (_tx, mut rx) = watch::channel(false);
        assert_eq!(guarded(async { Ok::<_, SiwcError>(7) }, Duration::from_secs(5), &mut rx).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn cancel_ends_a_request_that_never_answers() {
        let cancels = Arc::new(Cancels::default());
        let c2 = cancels.clone();
        let task = tokio::spawn(async move {
            let mut g = c2.register("req-1");
            guarded(std::future::pending::<Result<(), SiwcError>>(), Duration::from_secs(60), &mut g.rx).await
        });
        // Let the task register first.
        while !cancels.inner.lock().unwrap().live.contains_key("req-1") {
            tokio::task::yield_now().await;
        }
        cancels.cancel("req-1");
        let r = tokio::time::timeout(Duration::from_secs(2), task).await.expect("cancel did not end the request").unwrap();
        assert_eq!(r.unwrap_err().kind, "ai_cancelled");
        assert!(cancels.inner.lock().unwrap().live.is_empty());
    }

    #[tokio::test]
    async fn cancel_before_the_request_starts_still_applies() {
        let cancels = Cancels::default();
        cancels.cancel("req-2");
        let mut g = cancels.register("req-2");
        let r = guarded(std::future::pending::<Result<(), SiwcError>>(), Duration::from_secs(60), &mut g.rx).await;
        assert_eq!(r.unwrap_err().kind, "ai_cancelled");
        drop(g);
        let inner = cancels.inner.lock().unwrap();
        assert!(inner.live.is_empty() && inner.early.is_empty());
    }

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
    fn requests_stay_on_the_account_the_run_started_with() {
        assert_eq!(request_client(Some("oaiapp_a"), Some("oaiapp_a")).unwrap(), "oaiapp_a");
        assert_eq!(request_client(Some("oaiapp_b"), Some("oaiapp_a")).unwrap_err().kind, "account_changed");
        assert_eq!(request_client(None, Some("oaiapp_a")).unwrap_err().kind, "signed_out");
        // Model list: whatever is active.
        assert_eq!(request_client(Some("oaiapp_b"), None).unwrap(), "oaiapp_b");
        assert_eq!(request_client(None, None).unwrap_err().kind, "signed_out");
    }

    #[test]
    fn refresh_failures() {
        assert_eq!(refresh_failure("reauth_required"), RefreshFailure::Reauth);
        assert_eq!(refresh_failure("invalid_client"), RefreshFailure::Forget);
        assert_eq!(refresh_failure("network"), RefreshFailure::Keep);
        assert_eq!(refresh_failure("token_failed"), RefreshFailure::Keep);
        assert_eq!(sign_in_change("reauth_required"), Some("reauth"));
        assert_eq!(sign_in_change("client_revoked"), Some("client_revoked"));
        assert_eq!(sign_in_change("network"), None);
        assert_eq!(sign_in_change("usage_limit"), None);
    }

    #[test]
    fn removed_registration_is_no_longer_active() {
        let mut a = store::AccountsFile { active: Some("oaiapp_a".into()), accounts: vec![meta("oaiapp_a", "u"), meta("oaiapp_b", "v")], welcome_shown: true };
        remove_registration(&mut a, "oaiapp_a");
        assert_eq!(a.active, None);
        assert_eq!(a.accounts.iter().map(|m| m.client_id.as_str()).collect::<Vec<_>>(), vec!["oaiapp_b"]);
        let mut a = store::AccountsFile { active: Some("oaiapp_b".into()), accounts: vec![meta("oaiapp_a", "u"), meta("oaiapp_b", "v")], welcome_shown: true };
        remove_registration(&mut a, "oaiapp_a");
        assert_eq!(a.active.as_deref(), Some("oaiapp_b"));
    }

    fn temp_siwc() -> Arc<Siwc> {
        let dir = std::env::temp_dir().join(format!("fsg-siwc-test-{}", oauth::random_value()));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(Siwc::new(dir))
    }

    fn running_flag(s: &Siwc) -> Option<Arc<AtomicBool>> {
        s.sign_in_cancel.lock().unwrap().clone()
    }

    /// A sign-in that fails before the callback (here: the browser can't be opened) must not leave
    /// its cancel switch behind (#30). Uses no keychain and no network.
    #[tokio::test]
    async fn failed_sign_in_clears_its_cancel_switch() {
        let s = temp_siwc();
        let e = s.sign_in(None, false, |_| Err("no browser".into())).await.unwrap_err();
        assert_eq!(e.kind, "browser");
        assert!(running_flag(&s).is_none());
    }

    /// Starting a second sign-in ends the first one, so it doesn't hold the loopback port for 600 s,
    /// and the cancel button stops the one still running (#30). Uses no keychain and no network.
    #[tokio::test]
    async fn second_sign_in_cancels_the_first() {
        let s = temp_siwc();
        let s1 = s.clone();
        let first = tokio::spawn(async move { s1.sign_in(None, false, |_| Ok(())).await });
        let first_flag = loop {
            if let Some(f) = running_flag(&s) {
                break f;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let s2 = s.clone();
        let second = tokio::spawn(async move { s2.sign_in(None, false, |_| Ok(())).await });
        let first_result = tokio::time::timeout(Duration::from_secs(3), first).await;
        // Wait for the second to be the running one, then press "cancel" once.
        let mut second_running = false;
        for _ in 0..300 {
            if running_flag(&s).is_some_and(|f| !Arc::ptr_eq(&f, &first_flag)) {
                second_running = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        s.cancel_sign_in();
        let second_result = tokio::time::timeout(Duration::from_secs(3), second).await;
        // Never leave a listener waiting for 600 s, whatever happened above.
        first_flag.store(true, Ordering::Relaxed);
        if let Some(f) = running_flag(&s) {
            f.store(true, Ordering::Relaxed);
        }
        let first_err = first_result.expect("first sign-in is still waiting").unwrap().unwrap_err();
        assert_eq!(first_err.kind, "cancelled");
        assert!(second_running, "second sign-in never became the running one");
        let second_err = second_result.expect("cancel did not stop the second sign-in").unwrap().unwrap_err();
        assert_eq!(second_err.kind, "cancelled");
        assert!(running_flag(&s).is_none());
    }

    #[test]
    fn no_orphans_when_every_item_is_known() {
        let a = store::AccountsFile { active: None, accounts: vec![meta("oaiapp_a", "u"), meta("oaiapp_b", "v")], welcome_shown: false };
        assert!(orphan_items(&["oaiapp_a".to_string(), "oaiapp_b".to_string()], &a).is_empty());
        // No accounts.json (fresh data folder): every item is unreachable.
        assert_eq!(orphan_items(&["oaiapp_a".to_string()], &store::AccountsFile::default()), vec!["oaiapp_a".to_string()]);
    }
}

