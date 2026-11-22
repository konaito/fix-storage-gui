use serde::Serialize;

/// Error sent to the UI. `kind` drives the recovery UI; the rest is kept for diagnostics
/// (the docs ask to preserve status, error code and request ID).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiwcError {
    pub kind: String,
    pub code: Option<String>,
    pub param: Option<String>,
    pub status: Option<u16>,
    pub request_id: Option<String>,
    pub message: String,
}

impl SiwcError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), code: None, param: None, status: None, request_id: None, message: message.into() }
    }
    pub fn with_code(mut self, code: Option<String>) -> Self {
        self.code = code;
        self
    }
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
    pub fn network(e: impl std::fmt::Display) -> Self {
        Self::new("network", format!("通信エラー: {e}"))
    }
}

impl std::fmt::Display for SiwcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

/// Maps a Responses-layer `error.code` to a recovery kind
/// (https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).
pub fn kind_for_code(code: &str) -> &'static str {
    match code {
        "subscription_sharing_user_not_eligible" => "not_eligible",
        "subscription_sharing_usage_limit_exceeded" => "usage_limit",
        "subscription_sharing_usage_unavailable" => "usage_unavailable",
        "subscription_sharing_unsupported_capability" => "unsupported_capability",
        "subscription_sharing_route_not_supported" => "route_not_supported",
        "subscription_sharing_invalid_user" => "invalid_user",
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => "not_authorized",
        "subscription_sharing_user_unavailable" => "user_unavailable",
        _ => "api_error",
    }
}

/// Kind for a failure before a stream opens, when no structured code is present.
pub fn kind_for_status(status: u16) -> &'static str {
    match status {
        401 => "unauthorized",
        403 => "forbidden",
        429 => "rate_limited",
        503 => "unavailable",
        _ => "api_error",
    }
}

/// Refresh error codes that mean the refresh token can't be used any more.
pub fn is_terminal_refresh_error(code: &str) -> bool {
    matches!(
        code,
        "invalid_grant" | "invalid_refresh_token" | "token_expired" | "refresh_token_expired" | "refresh_token_invalidated" | "refresh_token_reused"
    )
}
