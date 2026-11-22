//! Links shown on the login screen. Only the official Sign in with ChatGPT docs may be
//! opened from the web view, and they always open in the system browser.

/// True for `https://developers.openai.com/siwc` and pages under it (no credentials, no other host).
pub fn is_official_siwc_doc(raw: &str) -> bool {
    let Ok(u) = url::Url::parse(raw) else { return false };
    u.scheme() == "https"
        && u.host_str() == Some("developers.openai.com")
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none()
        && (u.path() == "/siwc" || u.path().starts_with("/siwc/"))
}

#[cfg(test)]
mod tests {
    use super::is_official_siwc_doc as ok;

    #[test]
    fn allows_only_official_siwc_pages() {
        assert!(ok("https://developers.openai.com/siwc"));
        assert!(ok("https://developers.openai.com/siwc/ui-ux-guidelines"));
        assert!(ok("https://developers.openai.com/siwc/token-sharing-open-source/sign-in"));
        assert!(!ok("http://developers.openai.com/siwc"));
        assert!(!ok("https://developers.openai.com/api"));
        assert!(!ok("https://developers.openai.com/siwcx"));
        assert!(!ok("https://developers.openai.com.evil.example/siwc"));
        assert!(!ok("https://user@developers.openai.com/siwc"));
        assert!(!ok("https://developers.openai.com:8443/siwc"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("not a url"));
    }
}
