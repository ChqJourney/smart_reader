//! Web search & fetch tool execution, backed by DeepSeek's standalone
//! Search/Fetch JSON APIs (`POST /v1/tools/search`, `POST /v1/tools/fetch`).
//!
//! These are billed per call (not per token). The agent loop exposes them to
//! the model as ordinary function tools (`web_search` / `web_fetch`); execution
//! happens here in the Rust backend so the DeepSeek API key never enters the
//! webview (CSP forbids webview egress anyway).
//!
//! Key source: the keyring entry of the `deepseek` platform
//! (`llm_api_key_deepseek`), regardless of which platform is configured for
//! chat — this is what makes the tools usable with every chat provider.

use crate::secure_storage::ApiKeyStorage;
use crate::AppState;

/// DeepSeek Search/Fetch API base（与 chat 的 baseUrl 无关，固定官方地址）。
const DEEPSEEK_TOOLS_BASE: &str = "https://api.deepseek.com";

/// 非流式请求总超时：fetch 大页面可能较慢，给 60s；搜索通常数秒内返回。
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// DeepSeek 平台在钥匙串中的条目 id（`llm_api_key_deepseek`）。
const DEEPSEEK_PLATFORM_ID: &str = "deepseek";

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// 读取 DeepSeek 平台 API Key。缺失时返回面向模型/用户的引导文案
/// （该错误最终作为 tool 结果文本回喂模型，不弹窗）。
fn deepseek_api_key(storage: &dyn ApiKeyStorage) -> Result<String, String> {
    match storage.retrieve(DEEPSEEK_PLATFORM_ID) {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err(
            "DeepSeek API key is not configured. Web search/fetch is provided by the DeepSeek Search API; ask the user to configure an API key for the DeepSeek platform in Settings → Model Settings."
                .to_string(),
        ),
        Err(e) => Err(format!("Failed to read DeepSeek API key: {}", e)),
    }
}

/// 校验 fetch 目标 URL：必须含 host 的 http/https，且不携带用户名/密码
/// （DeepSeek API 侧同样拒绝，这里提前拦截给出明确错误）。
fn validate_fetch_url(url: &str) -> Result<(), String> {
    if url.len() > 8192 {
        return Err("Error: url is too long (max 8192 chars)".to_string());
    }
    let parsed =
        reqwest::Url::parse(url).map_err(|_| format!("Error: invalid url: {}", url))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Error: url scheme must be http or https, got {}",
                scheme
            ))
        }
    }
    if parsed.host_str().is_none() {
        return Err(format!("Error: url must contain a host: {}", url));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Error: url must not contain username or password".to_string());
    }
    Ok(())
}

/// 把 DeepSeek Search/Fetch 的错误响应映射为简短中文/英文混合的工具结果
/// 文本（回喂模型，模型会转告用户）。401 不回显原始 body，防止平台在错误
/// 消息中带回 API Key。
fn classify_web_tool_error(status: u16, body: &str) -> String {
    match status {
        401 => "Error: DeepSeek API key is invalid or expired (401).".to_string(),
        402 => "Error: DeepSeek account balance is insufficient (402). Please top up.".to_string(),
        403 => "Error: the fetch request was rejected by the safety policy (403).".to_string(),
        404 => "Error: no usable web content could be fetched (404) — the URL may be unavailable, blocked, or has no extractable content.".to_string(),
        429 => "Error: rate limit exceeded (429). Wait a moment and retry.".to_string(),
        s if s >= 500 => format!("Error: DeepSeek server error (HTTP {}). Retry later.", s),
        s => {
            let detail = body
                .get(..200)
                .unwrap_or(body)
                .trim();
            format!("Error: request failed (HTTP {}): {}", s, detail)
        }
    }
}

/// 共用 POST 逻辑：Bearer 鉴权 + JSON body，非 2xx 映射为工具错误文本。
async fn post_tool_request(
    path: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = build_http_client()?;
    let url = format!("{}{}", DEEPSEEK_TOOLS_BASE, path);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Error: request timed out. Retry later.".to_string()
            } else if e.is_connect() {
                "Error: cannot connect to DeepSeek servers. Check the network.".to_string()
            } else {
                format!("Error: network request failed: {}", e)
            }
        })?;

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body_text = response.text().await.unwrap_or_default();
        return Err(classify_web_tool_error(status, &body_text));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Error: failed to parse response: {}", e))
}

/// Search the web via DeepSeek Search API. Returns the raw `results` JSON;
/// formatting/truncation for the model context happens in the frontend.
#[tauri::command]
pub async fn web_tools_search(
    state: tauri::State<'_, AppState>,
    query: String,
    count: Option<u32>,
    need_content: Option<bool>,
) -> Result<serde_json::Value, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Error: query must not be empty".to_string());
    }
    // 服务端合法区间 1..=50；前端 schema 默认 5。
    let count = count.unwrap_or(5).clamp(1, 50);
    let api_key = deepseek_api_key(state.api_key_storage.as_ref())?;

    log::info!(
        "webToolsSearch: queryChars={} count={} needContent={}",
        query.chars().count(),
        count,
        need_content.unwrap_or(false)
    );

    let body = serde_json::json!({
        "query": query,
        "count": count,
        "need_content": need_content.unwrap_or(false),
    });
    post_tool_request("/v1/tools/search", &api_key, &body).await
}

/// Fetch a single web page via DeepSeek Fetch API. Returns `{title, content}`
/// (Markdown body); formatting/truncation happens in the frontend.
#[tauri::command]
pub async fn web_tools_fetch(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<serde_json::Value, String> {
    let url = url.trim().to_string();
    validate_fetch_url(&url)?;
    let api_key = deepseek_api_key(state.api_key_storage.as_ref())?;

    log::info!("webToolsFetch: host={}", reqwest::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default());

    let body = serde_json::json!({ "url": url });
    post_tool_request("/v1/tools/fetch", &api_key, &body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_storage::MemoryStorage;

    #[test]
    fn validate_fetch_url_accepts_http_and_https() {
        assert!(validate_fetch_url("https://example.com/article").is_ok());
        assert!(validate_fetch_url("http://example.com/a?b=c#d").is_ok());
    }

    #[test]
    fn validate_fetch_url_rejects_non_http_schemes() {
        assert!(validate_fetch_url("ftp://example.com/a").is_err());
        assert!(validate_fetch_url("file:///etc/passwd").is_err());
        assert!(validate_fetch_url("not-a-url").is_err());
    }

    #[test]
    fn validate_fetch_url_rejects_credentials() {
        assert!(validate_fetch_url("https://user:pass@example.com/").is_err());
        assert!(validate_fetch_url("https://user@example.com/").is_err());
    }

    #[test]
    fn validate_fetch_url_rejects_overlong_url() {
        let url = format!("https://example.com/{}", "a".repeat(8192));
        assert!(validate_fetch_url(&url).is_err());
    }

    #[test]
    fn deepseek_api_key_missing_guides_user_to_settings() {
        let storage = MemoryStorage::new();
        let err = deepseek_api_key(&storage).unwrap_err();
        assert!(err.contains("DeepSeek API key is not configured"));
    }

    #[test]
    fn deepseek_api_key_reads_deepseek_platform_entry() {
        let storage = MemoryStorage::new();
        storage.store("deepseek", "sk-ds").unwrap();
        storage.store("kimi", "sk-km").unwrap();
        // 只读 deepseek 条目：聊天平台换成 Kimi 时搜索仍用 DeepSeek Key。
        assert_eq!(deepseek_api_key(&storage).unwrap(), "sk-ds");
    }

    #[test]
    fn classify_401_never_echoes_body() {
        let msg = classify_web_tool_error(401, "Authentication Fails, your key sk-secret is invalid");
        assert!(!msg.contains("sk-secret"));
    }

    #[test]
    fn classify_maps_billing_and_rate_limit() {
        assert!(classify_web_tool_error(402, "").contains("balance"));
        assert!(classify_web_tool_error(429, "").contains("rate limit"));
        assert!(classify_web_tool_error(500, "").contains("server error"));
    }

    #[test]
    fn classify_404_explains_no_content() {
        assert!(classify_web_tool_error(404, "").contains("no usable web content"));
    }
}
