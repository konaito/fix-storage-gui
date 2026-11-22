//! OAuth for ChatGPT plan usage in open-source / local apps:
//! dynamic registration, PKCE (S256), loopback callback on 127.0.0.1, ID-token validation,
//! refresh and revocation. Written from the official docs:
//! https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//! https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions

use super::error::{is_terminal_refresh_error, SiwcError};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ISSUER: &str = "https://auth.openai.com";
pub const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
pub const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub const RESOURCE: &str = "https://api.openai.com/v1";
pub const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
pub const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
pub const AGENT_NAME: &str = "Fix Storage GUI";
pub const CALLBACK_PATH: &str = "/auth/callback";
pub const PREFERRED_PORT: u16 = 1455;

pub fn random_value() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// base64url(SHA-256(verifier)) without padding.
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[derive(Debug, Clone, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub jwks_uri: String,
    pub revocation_endpoint: Option<String>,
}

pub async fn discovery(http: &reqwest::Client) -> Result<Discovery, SiwcError> {
    let res = http.get(format!("{ISSUER}/.well-known/openid-configuration")).send().await.map_err(SiwcError::network)?;
    let d: Discovery = res.json().await.map_err(|_| SiwcError::new("discovery_failed", "サインイン設定を確認できませんでした"))?;
    let ok_origin = |u: &str| url::Url::parse(u).map(|u| u.origin().ascii_serialization() == ISSUER).unwrap_or(false);
    if d.issuer != ISSUER || !ok_origin(&d.jwks_uri) || d.revocation_endpoint.as_deref().is_some_and(|r| !ok_origin(r)) {
        return Err(SiwcError::new("discovery_failed", "サインイン設定を確認できませんでした"));
    }
    Ok(d)
}

pub struct AuthRequest<'a> {
    pub client_id: Option<&'a str>,
    pub host_id: &'a str,
    pub redirect_uri: &'a str,
    pub state: &'a str,
    pub nonce: &'a str,
    pub challenge: &'a str,
    pub id_token_hint: Option<&'a str>,
    pub login_hint: Option<&'a str>,
    /// Ask for consent again (used when the user enables ChatGPT plan usage after declining).
    pub prompt_consent: bool,
}

pub fn authorize_url(r: &AuthRequest) -> String {
    let mut u = url::Url::parse(AUTHORIZE_URL).unwrap();
    {
        let mut q = u.query_pairs_mut();
        match r.client_id {
            None => {
                q.append_pair("client_id", DYNAMIC_CLIENT);
                q.append_pair("agent_name_hint", AGENT_NAME);
            }
            Some(id) => {
                q.append_pair("client_id", id);
                if let Some(h) = r.id_token_hint {
                    q.append_pair("id_token_hint", h);
                }
                if let Some(h) = r.login_hint {
                    q.append_pair("login_hint", h);
                }
            }
        }
        q.append_pair("ext_agent_host_id", r.host_id);
        q.append_pair("response_type", "code");
        q.append_pair("redirect_uri", r.redirect_uri);
        q.append_pair("scope", SCOPES);
        q.append_pair("resource", RESOURCE);
        q.append_pair("state", r.state);
        q.append_pair("nonce", r.nonce);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("code_challenge", r.challenge);
        if r.prompt_consent {
            q.append_pair("prompt", "consent");
        }
    }
    u.into()
}

/// Binds the loopback listener: 127.0.0.1:1455 if free, otherwise any free port (only the port may vary).
pub fn bind_loopback() -> Result<(TcpListener, String), SiwcError> {
    let listener = TcpListener::bind(("127.0.0.1", PREFERRED_PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| SiwcError::new("callback_failed", format!("ローカルの受け口を開けません: {e}")))?;
    let port = listener.local_addr().map_err(|e| SiwcError::new("callback_failed", e.to_string()))?.port();
    Ok((listener, format!("http://127.0.0.1:{port}{CALLBACK_PATH}")))
}

const DONE_HTML: &str = "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>Fix Storage GUI</title><body style=\"font-family:-apple-system,sans-serif;padding:40px\"><h2>Fix Storage GUI に戻ってください</h2><p>このタブは閉じて大丈夫です。</p></body></html>";

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
}

/// Parses `GET /auth/callback?a=b HTTP/1.1` into its query map, or None for any other path.
pub fn parse_callback_request(first_line: &str) -> Option<HashMap<String, String>> {
    let mut parts = first_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let u = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if u.path() != CALLBACK_PATH {
        return None;
    }
    Some(u.query_pairs().into_owned().collect())
}

/// What one request to the loopback listener is.
#[derive(Debug, PartialEq, Eq)]
pub enum CallbackRequest {
    /// Another path (e.g. /favicon.ico): 404, keep waiting.
    Other,
    /// The callback path, but not with this sign-in's `state` (an old tab, an `<img>` on any page):
    /// 400, keep waiting (#30).
    WrongState,
    /// This sign-in's callback.
    Done(HashMap<String, String>),
}

pub fn classify_callback(first_line: &str, expected_state: &str) -> CallbackRequest {
    match parse_callback_request(first_line) {
        None => CallbackRequest::Other,
        Some(q) if q.get("state").map(String::as_str) == Some(expected_state) => CallbackRequest::Done(q),
        Some(_) => CallbackRequest::WrongState,
    }
}

const WRONG_STATE_HTML: &str = "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>Fix Storage GUI</title><body style=\"font-family:-apple-system,sans-serif;padding:40px\"><h2>このサインインの応答ではありません</h2><p>Fix Storage GUI で始めたサインインのタブから続けてください。</p></body></html>";

/// Waits (blocking) for the browser to hit the callback with `expected_state`.
/// Other paths get 404 and callbacks with another state get 400; neither ends the wait.
pub fn wait_for_callback(listener: TcpListener, cancel: Arc<AtomicBool>, timeout: Duration, expected_state: &str) -> Result<HashMap<String, String>, SiwcError> {
    listener.set_nonblocking(true).map_err(|e| SiwcError::new("callback_failed", e.to_string()))?;
    let start = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(SiwcError::new("cancelled", "サインインを中止しました"));
        }
        if start.elapsed() > timeout {
            return Err(SiwcError::new("timeout", "サインインが時間内に完了しませんでした"));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = Vec::new();
                let mut chunk = [0u8; 2048];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16384 {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&buf);
                let first = text.lines().next().unwrap_or("");
                match classify_callback(first, expected_state) {
                    CallbackRequest::Done(q) => {
                        respond(&mut stream, "200 OK", DONE_HTML);
                        return Ok(q);
                    }
                    CallbackRequest::WrongState => respond(&mut stream, "400 Bad Request", WRONG_STATE_HTML),
                    CallbackRequest::Other => respond(&mut stream, "404 Not Found", ""),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(SiwcError::new("callback_failed", e.to_string())),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_in: Option<i64>,
    pub scope: Option<String>,
}

#[derive(Deserialize)]
struct OAuthErrorBody {
    error: Option<serde_json::Value>,
    error_description: Option<String>,
    code: Option<String>,
}

/// Pulls a machine-readable code out of OAuth / API error bodies of various shapes.
pub fn oauth_error_code(body: &str) -> Option<String> {
    let b: OAuthErrorBody = serde_json::from_str(body).ok()?;
    if let Some(c) = b.code {
        return Some(c);
    }
    match b.error? {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Object(o) => o.get("code").and_then(|c| c.as_str()).map(String::from),
        _ => b.error_description,
    }
}

async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> Result<TokenResponse, SiwcError> {
    let res = http.post(TOKEN_URL).form(form).send().await.map_err(SiwcError::network)?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(SiwcError::network)?;
    if status != 200 {
        let code = oauth_error_code(&body);
        let kind = match code.as_deref() {
            Some(c) if is_terminal_refresh_error(c) => "reauth_required",
            Some("invalid_client") => "invalid_client",
            _ => "token_failed",
        };
        return Err(SiwcError::new(kind, format!("トークンの取得に失敗しました (HTTP {status})")).with_code(code).with_status(status));
    }
    serde_json::from_str(&body).map_err(|_| SiwcError::new("token_failed", "トークン応答を読めませんでした"))
}

pub async fn exchange_code(http: &reqwest::Client, client_id: &str, code: &str, verifier: &str, redirect_uri: &str) -> Result<TokenResponse, SiwcError> {
    token_request(
        http,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("resource", RESOURCE),
        ],
    )
    .await
}

/// Refresh without `scope` so the existing grant is kept.
pub async fn refresh(http: &reqwest::Client, client_id: &str, refresh_token: &str) -> Result<TokenResponse, SiwcError> {
    token_request(http, &[("grant_type", "refresh_token"), ("client_id", client_id), ("refresh_token", refresh_token), ("resource", RESOURCE)]).await
}

/// Revokes the renewable session. Ok(true) when the server confirmed (HTTP 200).
pub async fn revoke(http: &reqwest::Client, client_id: &str, refresh_token: &str) -> bool {
    let Ok(d) = discovery(http).await else { return false };
    let Some(endpoint) = d.revocation_endpoint else { return false };
    for attempt in 0..3 {
        let res = http
            .post(&endpoint)
            .form(&[("token", refresh_token), ("token_type_hint", "refresh_token"), ("client_id", client_id)])
            .send()
            .await;
        match res {
            Ok(r) if r.status().as_u16() == 200 => return true,
            Ok(r) if r.status().is_server_error() => {}
            Ok(_) => return false,
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
    }
    false
}

#[derive(Debug, Clone, Deserialize)]
pub struct IdClaims {
    pub sub: String,
    pub email: Option<String>,
    pub nonce: Option<String>,
}

/// Verifies signature (JWKS), issuer, audience (= issued client id), expiry and nonce.
pub async fn verify_id_token(http: &reqwest::Client, id_token: &str, client_id: &str, nonce: Option<&str>) -> Result<IdClaims, SiwcError> {
    use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
    let unavailable = || SiwcError::new("identity_unavailable", "本人確認を一時的に行えません。少し待ってからもう一度試してください");
    let invalid = |why: &str| SiwcError::new("invalid_id_token", format!("ID トークンを検証できませんでした: {why}"));
    let header = decode_header(id_token).map_err(|_| invalid("ヘッダー"))?;
    if !matches!(header.alg, Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512 | Algorithm::ES256 | Algorithm::ES384 | Algorithm::PS256) {
        return Err(invalid("署名方式"));
    }
    let d = discovery(http).await.map_err(|_| unavailable())?;
    let jwks: JwkSet = http.get(&d.jwks_uri).send().await.map_err(|_| unavailable())?.json().await.map_err(|_| unavailable())?;
    let jwk = match &header.kid {
        Some(kid) => jwks.find(kid),
        None if jwks.keys.len() == 1 => jwks.keys.first(),
        None => None,
    }
    .ok_or_else(|| invalid("鍵が見つかりません"))?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| invalid("鍵"))?;
    let mut v = Validation::new(header.alg);
    v.set_issuer(&[ISSUER]);
    v.set_audience(&[client_id]);
    v.validate_exp = true;
    v.leeway = 60;
    let data = decode::<IdClaims>(id_token, &key, &v).map_err(|e| invalid(&e.to_string()))?;
    if let Some(n) = nonce {
        if data.claims.nonce.as_deref() != Some(n) {
            return Err(invalid("nonce が一致しません"));
        }
    }
    Ok(data.claims)
}

pub fn split_scopes(scope: Option<&str>) -> Vec<String> {
    let mut v: Vec<String> = scope.unwrap_or("").split_whitespace().map(String::from).collect();
    v.sort();
    v.dedup();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_s256_no_padding() {
        // SHA-256("abc") = ba7816bf...15ad (FIPS 180-2), base64url without padding.
        assert_eq!(pkce_challenge("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
        assert_eq!(random_value().len(), 43);
    }

    #[test]
    fn authorize_url_new_registration() {
        let u = authorize_url(&AuthRequest {
            client_id: None,
            host_id: "urn:uuid:1",
            redirect_uri: "http://127.0.0.1:1455/auth/callback",
            state: "s",
            nonce: "n",
            challenge: "c",
            id_token_hint: Some("ignored"),
            login_hint: None,
            prompt_consent: false,
        });
        let parsed = url::Url::parse(&u).unwrap();
        let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert!(u.starts_with(AUTHORIZE_URL));
        assert_eq!(q["client_id"], "dynamic_agent_client");
        assert_eq!(q["agent_name_hint"], AGENT_NAME);
        assert_eq!(q["ext_agent_host_id"], "urn:uuid:1");
        assert_eq!(q["scope"], SCOPES);
        assert_eq!(q["resource"], RESOURCE);
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(!q.contains_key("id_token_hint"));
    }

    #[test]
    fn authorize_url_reauth_omits_name_hint() {
        let u = authorize_url(&AuthRequest {
            client_id: Some("oaiapp_x"),
            host_id: "urn:uuid:1",
            redirect_uri: "http://127.0.0.1:5555/auth/callback",
            state: "s",
            nonce: "n",
            challenge: "c",
            id_token_hint: Some("tok"),
            login_hint: Some("a@b.c"),
            prompt_consent: true,
        });
        let q: HashMap<_, _> = url::Url::parse(&u).unwrap().query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "oaiapp_x");
        assert!(!q.contains_key("agent_name_hint"));
        assert_eq!(q["id_token_hint"], "tok");
        assert_eq!(q["login_hint"], "a@b.c");
        assert_eq!(q["prompt"], "consent");
    }

    #[test]
    fn callback_parsing() {
        let q = parse_callback_request("GET /auth/callback?code=abc&state=xyz&client_id=oaiapp_1 HTTP/1.1").unwrap();
        assert_eq!(q["code"], "abc");
        assert_eq!(q["client_id"], "oaiapp_1");
        assert!(parse_callback_request("GET /callback?code=abc HTTP/1.1").is_none());
        assert!(parse_callback_request("GET /favicon.ico HTTP/1.1").is_none());
    }

    /// A request to the callback path with someone else's state (an old tab, an `<img>` on any page)
    /// gets 400 and the wait goes on (#30).
    #[test]
    fn callback_with_wrong_state_keeps_waiting() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = cancel.clone();
        let waiting = std::thread::spawn(move || wait_for_callback(listener, cancel, Duration::from_secs(5), "good"));
        let get = |target: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
            let mut r = String::new();
            let _ = s.read_to_string(&mut r);
            r
        };
        let stale = get("/auth/callback?code=old&state=stale");
        let missing = get("/auth/callback?code=old");
        let good = get("/auth/callback?code=new&state=good");
        stop.store(true, Ordering::Relaxed);
        let q = waiting.join().unwrap().unwrap();
        assert!(stale.starts_with("HTTP/1.1 400"), "{stale}");
        assert!(missing.starts_with("HTTP/1.1 400"), "{missing}");
        assert!(good.starts_with("HTTP/1.1 200"), "{good}");
        assert_eq!(q["state"], "good");
        assert_eq!(q["code"], "new");
    }

    #[test]
    fn callback_state_check() {
        let done = classify_callback("GET /auth/callback?code=c&state=s1 HTTP/1.1", "s1");
        assert!(matches!(done, CallbackRequest::Done(q) if q["code"] == "c"));
        assert_eq!(classify_callback("GET /auth/callback?code=c&state=s0 HTTP/1.1", "s1"), CallbackRequest::WrongState);
        assert_eq!(classify_callback("GET /auth/callback?error=access_denied HTTP/1.1", "s1"), CallbackRequest::WrongState);
        assert_eq!(classify_callback("GET /favicon.ico HTTP/1.1", "s1"), CallbackRequest::Other);
    }

    #[test]
    fn error_codes() {
        assert_eq!(oauth_error_code(r#"{"error":"invalid_grant"}"#).as_deref(), Some("invalid_grant"));
        assert_eq!(oauth_error_code(r#"{"error":{"code":"refresh_token_reused"}}"#).as_deref(), Some("refresh_token_reused"));
    }
}
