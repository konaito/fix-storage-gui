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
        let http = http_client(READ_TIMEOUT);
        Self {
            store: Store::new(dir),
            http,
            refresh_lock: tokio::sync::Mutex::new(()),
            sign_in_cancel: std::sync::Mutex::new(None),
            respond_cancels: Cancels::default(),
        }
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
    /// Refreshes are serialised (`refresh_lock`) so a rotating refresh token is never used twice.
    /// If `stale_access_token` is `Some`, refresh only when the stored token is still that
    /// value — a concurrent 401 retry may already have refreshed it.
    async fn access_token(&self, stale_access_token: Option<&str>) -> Result<(String, String), SiwcError> {
        let a = self.store.accounts();
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
    /// `cancel_respond(request_id)` or `RESPOND_LIMIT` ends the stream (#21). Only the stream is
    /// cut short: a token refresh always runs to the end, so a rotated refresh token is saved.
    pub async fn respond(&self, request_id: &str, model: &str, instructions: &str, input: &str, on_delta: impl FnMut(usize) + Clone) -> Result<String, SiwcError> {
        let mut guard = self.respond_cancels.register(request_id);
        let (_, token) = self.access_token(None).await?;
        match guarded(api::respond(&self.http, &token, model, instructions, input, on_delta.clone()), RESPOND_LIMIT, &mut guard.rx).await {
            // Retry once with a fresh token; a terminal refresh error turns into reauth_required.
            Err(e) if e.status == Some(401) => {
                let (_, token) = self.access_token(Some(&token)).await?;
                guarded(api::respond(&self.http, &token, model, instructions, input, on_delta), RESPOND_LIMIT, &mut guard.rx).await
            }
            other => other,
        }
    }

    /// Cancels the `respond` call with this request ID, or the next one to start with it.
    pub fn cancel_respond(&self, request_id: &str) {
        self.respond_cancels.cancel(request_id);
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
}
