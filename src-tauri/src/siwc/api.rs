//! Model list and streamed Responses API calls with a ChatGPT-plan OAuth access token.
//! https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//! https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

use super::error::{kind_for_code, kind_for_status, SiwcError};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

pub const MODELS_URL: &str = "https://api.openai.com/v1/models";
pub const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}

/// Keeps `visibility == "list"` entries in server order (docs). Falls back to the
/// standard `data[].id` shape if `models` is absent. Nothing is hard-coded.
pub fn parse_models(v: &Value) -> Vec<Model> {
    if let Some(arr) = v.get("models").and_then(|m| m.as_array()) {
        return arr
            .iter()
            .filter(|m| m.get("visibility").and_then(|x| x.as_str()) == Some("list"))
            .filter_map(|m| {
                let slug = m.get("slug").and_then(|s| s.as_str())?.to_string();
                let display_name = m
                    .get("display_name")
                    .and_then(|s| s.as_str())
                    .unwrap_or(&slug)
                    .to_string();
                Some(Model { slug, display_name })
            })
            .collect();
    }
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|s| s.as_str()))
                .map(|id| Model {
                    slug: id.to_string(),
                    display_name: id.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Turns a non-2xx HTTP response (before any stream) into a SiwcError, keeping status,
/// code, param and request ID. Admission errors may be `{"detail": "..."}` without a code.
pub fn http_error(status: u16, request_id: Option<String>, body: &str) -> SiwcError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let err = v.get("error");
    let code = err
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_str())
        .map(String::from);
    let param = err
        .and_then(|e| e.get("param"))
        .and_then(|c| c.as_str())
        .map(String::from);
    let message = err
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .or_else(|| v.get("detail").and_then(|d| d.as_str()))
        .unwrap_or("")
        .chars()
        .take(500)
        .collect::<String>();
    let kind = match &code {
        Some(c) => kind_for_code(c),
        None => kind_for_status(status),
    };
    SiwcError {
        kind: kind.into(),
        code,
        param,
        status: Some(status),
        request_id,
        message,
    }
}

#[allow(clippy::result_large_err)]
pub async fn list_models(http: &reqwest::Client, token: &str) -> Result<Vec<Model>, SiwcError> {
    let res = http
        .get(MODELS_URL)
        .bearer_auth(token)
        .send()
        .await
        .map_err(SiwcError::network)?;
    let status = res.status().as_u16();
    let rid = res
        .headers()
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .map(String::from);
    let body = res.text().await.map_err(SiwcError::network)?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, rid, &body));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|_| SiwcError::new("api_error", "モデル一覧を読めませんでした"))?;
    Ok(parse_models(&v))
}

/// Request body. Only fields allowed in the preview: no temperature, max_output_tokens, metadata, etc.
pub fn request_body(model: &str, instructions: &str, input: &str) -> Value {
    json!({
        "model": model,
        "instructions": instructions,
        "input": [{ "role": "user", "content": input }],
        "store": false,
        "stream": true
    })
}

/// Incremental SSE parser for Responses streaming events.
#[derive(Default)]
pub struct StreamState {
    buf: String,
    pub text: String,
    pub completed: bool,
    pub error: Option<SiwcError>,
}

impl StreamState {
    /// Feeds raw bytes; returns how many characters of text were appended.
    pub fn feed(&mut self, chunk: &str) -> usize {
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let before = self.text.chars().count();
        while let Some(idx) = self.buf.find("\n\n") {
            let event: String = self.buf[..idx].to_string();
            self.buf.drain(..idx + 2);
            let data: Vec<&str> = event
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|l| l.trim_start())
                .collect();
            if data.is_empty() {
                continue;
            }
            let joined = data.join("\n");
            if joined == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&joined) {
                self.handle(&v);
            }
        }
        self.text.chars().count() - before
    }

    fn handle(&mut self, v: &Value) {
        let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match t {
            "response.output_text.delta" => {
                if let Some(d) = v.get("delta").and_then(|d| d.as_str()) {
                    self.text.push_str(d);
                }
            }
            "response.completed" => {
                self.completed = true;
                if self.text.is_empty() {
                    self.text = output_text(v.get("response").unwrap_or(&Value::Null));
                }
            }
            "response.failed" => {
                let err = v.get("response").and_then(|r| r.get("error"));
                let code = err
                    .and_then(|e| e.get("code"))
                    .and_then(|c| c.as_str())
                    .map(String::from);
                let msg = err
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
                let kind = code.as_deref().map(kind_for_code).unwrap_or("api_error");
                self.error = Some(SiwcError::new(kind, msg).with_code(code));
            }
            "response.incomplete" => {
                let reason = v
                    .pointer("/response/incomplete_details/reason")
                    .and_then(|r| r.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                self.error = Some(
                    SiwcError::new("incomplete", format!("応答が途中で終わりました ({reason})"))
                        .with_code(Some(reason)),
                );
            }
            "error" => {
                let code = v
                    .get("code")
                    .and_then(|c| c.as_str())
                    .or_else(|| v.pointer("/error/code").and_then(|c| c.as_str()))
                    .map(String::from);
                let msg = v
                    .get("message")
                    .and_then(|c| c.as_str())
                    .or_else(|| v.pointer("/error/message").and_then(|c| c.as_str()))
                    .unwrap_or("")
                    .to_string();
                let param = v.get("param").and_then(|c| c.as_str()).map(String::from);
                let kind = code.as_deref().map(kind_for_code).unwrap_or("api_error");
                let mut e = SiwcError::new(kind, msg).with_code(code);
                e.param = param;
                self.error = Some(e);
            }
            _ => {}
        }
    }
}

fn output_text(response: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = response.get("output").and_then(|o| o.as_array()) {
        for item in items {
            if let Some(parts) = item.get("content").and_then(|c| c.as_array()) {
                for p in parts {
                    if p.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                        out.push_str(p.get("text").and_then(|t| t.as_str()).unwrap_or(""));
                    }
                }
            }
        }
    }
    out
}

/// Streams one request to completion. Success only after `response.completed`.
#[allow(clippy::result_large_err)]
pub async fn respond(
    http: &reqwest::Client,
    token: &str,
    model: &str,
    instructions: &str,
    input: &str,
    on_delta: impl FnMut(usize),
) -> Result<String, SiwcError> {
    respond_to(
        http,
        RESPONSES_URL,
        token,
        model,
        instructions,
        input,
        on_delta,
    )
    .await
}

/// `respond` against any URL (tests point it at a local server).
pub(crate) async fn respond_to(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    model: &str,
    instructions: &str,
    input: &str,
    mut on_delta: impl FnMut(usize),
) -> Result<String, SiwcError> {
    let res = http
        .post(url)
        .bearer_auth(token)
        .header("Accept", "text/event-stream")
        .json(&request_body(model, instructions, input))
        .send()
        .await
        .map_err(SiwcError::network)?;
    let status = res.status().as_u16();
    let rid = res
        .headers()
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .map(String::from);
    if !(200..300).contains(&status) {
        let body = res.text().await.unwrap_or_default();
        return Err(http_error(status, rid, &body));
    }
    let mut state = StreamState::default();
    let mut stream = res.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let mut err = SiwcError::new("interrupted", format!("ストリームが途切れました: {e}"));
            err.request_id = rid.clone();
            err
        })?;
        pending.extend_from_slice(&chunk);
        // Only decode complete UTF-8 prefixes.
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) => e.valid_up_to(),
        };
        let text = String::from_utf8_lossy(&pending[..valid]).to_string();
        pending.drain(..valid);
        let added = state.feed(&text);
        if added > 0 {
            on_delta(state.text.chars().count());
        }
        if let Some(mut e) = state.error.take() {
            e.request_id = e.request_id.or(rid.clone());
            return Err(e);
        }
        if state.completed {
            break;
        }
    }
    let _ = state.feed("\n\n");
    if let Some(mut e) = state.error.take() {
        e.request_id = e.request_id.or(rid);
        return Err(e);
    }
    if !state.completed {
        let mut e = SiwcError::new(
            "interrupted",
            "response.completed を受け取る前にストリームが終わりました",
        );
        e.request_id = rid;
        return Err(e);
    }
    Ok(state.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_visibility_and_order() {
        let v = json!({"models":[
            {"slug":"b","display_name":"B","visibility":"list"},
            {"slug":"hidden","display_name":"H","visibility":"hide"},
            {"slug":"a","display_name":"A","visibility":"list"}]});
        let m = parse_models(&v);
        assert_eq!(
            m.iter().map(|x| x.slug.as_str()).collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        let v2 = json!({"data":[{"id":"x"}]});
        assert_eq!(parse_models(&v2)[0].slug, "x");
    }

    #[test]
    fn body_has_required_flags_only() {
        let b = request_body("m", "i", "x");
        assert_eq!(b["store"], json!(false));
        assert_eq!(b["stream"], json!(true));
        for f in [
            "temperature",
            "max_output_tokens",
            "metadata",
            "previous_response_id",
            "user",
            "top_p",
        ] {
            assert!(b.get(f).is_none());
        }
    }

    #[test]
    fn stream_completes() {
        let mut s = StreamState::default();
        s.feed("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"He\"}\n\n");
        s.feed("data: {\"type\":\"response.output_text.delta\",\"delta\":\"llo\"}\n\ndata: {\"type\":\"response.comp");
        assert!(!s.completed);
        s.feed("leted\",\"response\":{}}\n\n");
        assert!(s.completed);
        assert_eq!(s.text, "Hello");
    }

    #[test]
    fn stream_usage_limit() {
        let mut s = StreamState::default();
        s.feed("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"x\"}}}\n\n");
        let e = s.error.unwrap();
        assert_eq!(e.kind, "usage_limit");
        assert!(!s.completed);
    }

    #[test]
    fn admission_detail_body() {
        let e = http_error(
            503,
            Some("req_1".into()),
            r#"{"detail":"Direct routing unavailable"}"#,
        );
        assert_eq!(e.kind, "unavailable");
        assert_eq!(e.code, None);
        assert_eq!(e.message, "Direct routing unavailable");
        assert_eq!(e.request_id.as_deref(), Some("req_1"));
        let e2 = http_error(
            400,
            None,
            r#"{"error":{"code":"subscription_sharing_unsupported_capability","param":"tools"}}"#,
        );
        assert_eq!(e2.kind, "unsupported_capability");
        assert_eq!(e2.param.as_deref(), Some("tools"));
    }
}
