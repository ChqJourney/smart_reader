//! LLM proxy module: streams chat completions through the Rust backend.
//!
//! This bypasses webview CORS restrictions (e.g. Volcengine ARK) and keeps
//! the API key in backend memory only (never exposed to the webview).
//!
//! Flow:
//! 1. Frontend calls `chat_completions_stream` with messages + config flags.
//! 2. Backend reads baseUrl/model from settings, apiKey from keyring.
//! 3. Backend sends a streaming POST via reqwest, parses SSE chunks.
//! 4. Each chunk is pushed to the frontend via a Tauri Channel as StreamEvent.
//! 5. Frontend receives Chunk / ReasoningChunk / Usage / Error / Done events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::AppState;

/// Thinking mode control.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingMode {
    Enabled,
    Disabled,
    #[default]
    Auto,
}

/// Chat message (mirrors frontend ChatMessage type).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

/// Accumulator for a single streaming tool_call so that fragments can be
/// merged by `index` before emitting a complete `StreamEvent::ToolCall`.
#[derive(Debug, Clone, Default)]
struct ToolCallAcc {
    id: String,
    call_type: String,
    name: String,
    arguments: String,
}

/// Token usage info from the last SSE chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u32>,
}

/// Structured LLM error (mirrors frontend LlmError type).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LlmError {
    Network { detail: String },
    Auth { detail: String },
    ModelNotFound { model: String, detail: String },
    RateLimit {
        retry_after: Option<u32>,
        detail: String,
    },
    ContextLengthExceeded {
        limit: u32,
        requested: u32,
        detail: String,
    },
    ServerError { status: u16, detail: String },
    StreamInterrupted { partial_content: String },
    InvalidConfig { field: String, detail: String },
    ToolError { tool_name: String, detail: String },
    Unknown { status: u16, body: String },
}

/// Stream events pushed to the frontend via Channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum StreamEvent {
    Chunk { content: String },
    ReasoningChunk { content: String },
    ToolCall {
        name: String,
        args: String,
        #[serde(rename = "callId")]
        call_id: String,
    },
    ToolResult { call_id: String, summary: String },
    Usage { usage: TokenUsage },
    Error { error: LlmError },
    Done,
}

/// Parameters for chat_completions_stream command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamParams {
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub thinking: ThinkingMode,
    #[serde(default)]
    pub enable_tools: bool,
    #[serde(default)]
    #[allow(dead_code)] // reserved for future tool-call file_hash whitelist (Phase 6)
    pub authorized_file_hashes: Vec<String>,
    pub request_id: String,
}

/// Active cancellation tokens keyed by request_id.
/// When a cancel request comes in, the corresponding flag is set to true
/// and the streaming loop exits on the next iteration.
pub type CancelMap = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

/// Convert a frontend-facing `ChatMessage` (camelCase) into the wire format
/// expected by OpenAI-compatible APIs (snake_case). Tool messages never carry
/// `name` on the wire; assistant tool_calls messages always send empty content.
fn chat_message_to_wire(msg: &ChatMessage) -> serde_json::Value {
    let mut out = serde_json::json!({
        "role": msg.role,
        "content": msg.content,
    });
    if let Some(tool_call_id) = &msg.tool_call_id {
        out["tool_call_id"] = serde_json::json!(tool_call_id);
    }
    if let Some(tool_calls) = &msg.tool_calls {
        let wire_calls: Vec<serde_json::Value> = tool_calls
            .iter()
            .map(|call| {
                let id = call
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let call_type = call
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("function")
                    .to_string();
                let name = call
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = call
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}")
                    .to_string();
                serde_json::json!({
                    "id": id,
                    "type": call_type,
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    }
                })
            })
            .collect();
        out["tool_calls"] = serde_json::json!(wire_calls);
    }
    if let Some(reasoning_content) = &msg.reasoning_content {
        out["reasoning_content"] = serde_json::json!(reasoning_content);
    }
    out
}

/// Build the JSON request body for the chat completions API.
///
/// Platform-specific thinking parameter handling:
/// - DeepSeek: sends `thinking: {type:"enabled"}` + `reasoning_effort: "high"`
///   (DeepSeek v4 models support thinking via parameter, not model name switch)
/// - Other platforms: sends `thinking: {type:"enabled"|"disabled"}` top-level
/// - Auto: omits the parameter entirely (uses model default)
/// - Always sends `stream_options: {include_usage: true}` to get token counts
fn build_request_body(
    messages: &[ChatMessage],
    model: &str,
    thinking: &ThinkingMode,
    enable_tools: bool,
) -> serde_json::Value {
    let wire_messages: Vec<serde_json::Value> =
        messages.iter().map(chat_message_to_wire).collect();
    let mut body = serde_json::json!({
        "model": model,
        "messages": wire_messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });

    match thinking {
        ThinkingMode::Enabled => {
            body["thinking"] = serde_json::json!({"type": "enabled"});
            // DeepSeek uses reasoning_effort for intensity control
            body["reasoning_effort"] = serde_json::json!("high");
        }
        ThinkingMode::Disabled => {
            body["thinking"] = serde_json::json!({"type": "disabled"});
        }
        ThinkingMode::Auto => {
            // Don't send the parameter; use model default
        }
    }

    if enable_tools {
        body["tools"] = serde_json::json!(crate::llm_proxy::builtin_tools());
    }

    body
}

/// The set of built-in tools offered to the LLM (PDF read/search).
/// Only active when enable_tools is true.
pub fn builtin_tools() -> &'static [serde_json::Value] {
    static TOOLS: std::sync::OnceLock<Vec<serde_json::Value>> = std::sync::OnceLock::new();
    TOOLS.get_or_init(|| {
        vec![
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": "list_open_pdfs",
                    "description": "List currently open PDF files with their basic info (file name, total pages).",
                    "parameters": {"type": "object", "properties": {}, "required": []}
                }
            }),
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": "read_pdf_page",
                    "description": "Read the text content of a specific page from an open PDF. Page numbers start from 1.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "file_hash": {"type": "string", "description": "PDF file identifier (from list_open_pdfs)"},
                            "page_number": {"type": "integer", "description": "Page number, starting from 1"}
                        },
                        "required": ["file_hash", "page_number"]
                    }
                }
            }),
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": "search_in_pdf",
                    "description": "Search for a keyword in an open PDF, returns matching page numbers and context snippets.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "file_hash": {"type": "string"},
                            "query": {"type": "string", "description": "Search keyword"},
                            "max_results": {"type": "integer", "default": 5, "description": "Max number of results"}
                        },
                        "required": ["file_hash", "query"]
                    }
                }
            }),
        ]
    })
}

/// Classify an HTTP error response into a structured LlmError.
fn classify_http_error(status: u16, body: &str, model: &str) -> LlmError {
    let body_trimmed = body.trim();
    match status {
        401 => LlmError::Auth {
            // Never echo the provider's raw 401 body: some services (e.g. DeepSeek)
            // include the API key in the error message. Use a safe fixed detail.
            detail: "API Key 不正确或已失效".into(),
        },
        404 => {
            let detail = extract_error_message(body_trimmed)
                .unwrap_or_else(|| "资源未找到".into());
            if body_trimmed.to_lowercase().contains("model") {
                LlmError::ModelNotFound {
                    model: model.to_string(),
                    detail,
                }
            } else {
                LlmError::Unknown {
                    status,
                    body: body_trimmed.to_string(),
                }
            }
        }
        429 => LlmError::RateLimit {
            retry_after: None,
            detail: extract_error_message(body_trimmed)
                .unwrap_or_else(|| "请求过于频繁，请稍后重试".into()),
        },
        400 => {
            let detail = extract_error_message(body_trimmed).unwrap_or_default();
            let lower = detail.to_lowercase();
            if lower.contains("context length") || lower.contains("context_length") {
                LlmError::ContextLengthExceeded {
                    limit: 0,
                    requested: 0,
                    detail,
                }
            } else {
                LlmError::Unknown {
                    status,
                    body: body_trimmed.to_string(),
                }
            }
        }
        s if s >= 500 => LlmError::ServerError {
            status,
            detail: extract_error_message(body_trimmed)
                .unwrap_or_else(|| format!("服务端错误 (HTTP {})", status)),
        },
        _ => LlmError::Unknown {
            status,
            body: body_trimmed.to_string(),
        },
    }
}

/// Try to extract the `error.message` field from a JSON error body.
fn extract_error_message(body: &str) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    // OpenAI-style: {"error": {"message": "..."}}
    if let Some(msg) = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
        return Some(msg.to_string());
    }
    // Direct message field
    if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
        return Some(msg.to_string());
    }
    None
}

/// Flush any accumulated tool_calls as complete `StreamEvent::ToolCall`s.
fn flush_tool_calls(
    accumulators: &mut Vec<ToolCallAcc>,
    on_event: &Channel<StreamEvent>,
) {
    for acc in accumulators.drain(..) {
        if acc.id.is_empty() || acc.name.is_empty() {
            continue;
        }
        let _ = on_event.send(StreamEvent::ToolCall {
            name: acc.name,
            args: acc.arguments,
            call_id: acc.id,
        });
    }
}

/// Parse a single SSE `data:` line and emit appropriate StreamEvent(s).
///
/// `accumulators` keeps per-index tool_call fragments across chunks; they are
/// flushed when `finish_reason` is non-empty or `[DONE]` is received.
///
/// Returns true if the stream should continue, false if [DONE] was received.
fn parse_sse_line(
    line: &str,
    accumulators: &mut Vec<ToolCallAcc>,
    on_event: &Channel<StreamEvent>,
) -> Result<bool, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(true);
    }
    if trimmed == "data: [DONE]" {
        flush_tool_calls(accumulators, on_event);
        return Ok(false);
    }
    if !trimmed.starts_with("data: ") {
        return Ok(true);
    }

    let json_str = &trimmed[6..];
    let data: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Ok(true), // skip malformed lines
    };

    // Check for API-level error in the stream
    if let Some(err) = data.get("error") {
        let detail = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown API error")
            .to_string();
        let _ = on_event.send(StreamEvent::Error {
            error: LlmError::Unknown {
                status: 0,
                body: detail,
            },
        });
        return Ok(false);
    }

    // Extract usage from the last chunk (choices is empty or null)
    if let Some(usage) = data.get("usage").filter(|u| !u.is_null()) {
        let prompt_tokens = usage.get("prompt_tokens").and_then(|t| t.as_u64()).unwrap_or(0) as u32;
        let completion_tokens = usage
            .get("completion_tokens")
            .and_then(|t| t.as_u64())
            .unwrap_or(0) as u32;
        let total_tokens = usage.get("total_tokens").and_then(|t| t.as_u64()).unwrap_or(0) as u32;
        let reasoning_tokens = usage
            .get("completion_tokens_details")
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(|t| t.as_u64())
            .map(|t| t as u32);
        let cached_tokens = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|t| t.as_u64())
            .map(|t| t as u32);

        let _ = on_event.send(StreamEvent::Usage {
            usage: TokenUsage {
                prompt_tokens,
                completion_tokens,
                total_tokens,
                reasoning_tokens,
                cached_tokens,
            },
        });
    }

    // Extract content / reasoning_content from choices[0].delta
    if let Some(choices) = data.get("choices").and_then(|c| c.as_array()) {
        if let Some(choice) = choices.first() {
            if let Some(delta) = choice.get("delta") {
                // Normal content
                if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                    if !content.is_empty() {
                        let _ = on_event.send(StreamEvent::Chunk {
                            content: content.to_string(),
                        });
                    }
                }
                // Reasoning content (thinking mode)
                if let Some(reasoning) = delta.get("reasoning_content").and_then(|c| c.as_str()) {
                    if !reasoning.is_empty() {
                        let _ = on_event.send(StreamEvent::ReasoningChunk {
                            content: reasoning.to_string(),
                        });
                    }
                }
            }

            // Accumulate tool_call fragments by index; flush on finish_reason.
            if let Some(tool_calls) = choice
                .get("delta")
                .and_then(|d| d.get("tool_calls"))
                .and_then(|tc| tc.as_array())
            {
                for tc in tool_calls {
                    let index = tc
                        .get("index")
                        .and_then(|i| i.as_u64())
                        .unwrap_or(0) as usize;
                    if accumulators.len() <= index {
                        accumulators.resize_with(index + 1, ToolCallAcc::default);
                    }
                    let acc = &mut accumulators[index];
                    if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                        acc.id = id.to_string();
                    }
                    if let Some(call_type) = tc.get("type").and_then(|t| t.as_str()) {
                        acc.call_type = call_type.to_string();
                    }
                    if let Some(function) = tc.get("function").and_then(|f| f.as_object()) {
                        if let Some(name) = function.get("name").and_then(|n| n.as_str()) {
                            acc.name = name.to_string();
                        }
                        if let Some(args) = function.get("arguments").and_then(|a| a.as_str()) {
                            acc.arguments.push_str(args);
                        }
                    }
                }
            }

            // Flush accumulated tool_calls whenever finish_reason is present.
            // We do not require finish_reason == "tool_calls"; platform behavior
            // varies, so any non-empty finish_reason is treated as a flush signal.
            if choice
                .get("finish_reason")
                .and_then(|f| f.as_str())
                .filter(|s| !s.is_empty())
                .is_some()
            {
                flush_tool_calls(accumulators, on_event);
            }
        }
    }

    Ok(true)
}

/// Main streaming command. Reads config from settings + keyring, sends the
/// request via reqwest, and pushes StreamEvents to the frontend Channel.
#[tauri::command]
pub async fn chat_completions_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    params: StreamParams,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let request_id = params.request_id.clone();
    let cancel_flag = Arc::new(AtomicBool::new(false));

    // Register cancel flag
    {
        let mut map = state
            .cancel_tokens
            .lock()
            .map_err(|e| format!("Failed to lock cancel map: {}", e))?;
        map.insert(request_id.clone(), cancel_flag.clone());
    }

    // Ensure cleanup on exit (normal or error)
    let cancel_map = state.cancel_tokens.clone();
    let cleanup_request_id = request_id.clone();
    let cleanup = || {
        if let Ok(mut map) = cancel_map.lock() {
            map.remove(&cleanup_request_id);
        }
    };

    // Load settings to get baseUrl + model
    let base_dir = crate::paths::app_data_dir(&app)?;
    let settings = tauri::async_runtime::spawn_blocking(move || {
        crate::load_settings_from_disk(&base_dir)
    })
    .await
    .map_err(|e| format!("Failed to load settings: {}", e))??;

    let base_url = settings.llm.base_url.trim_end_matches('/').to_string();
    let model = settings.llm.model.clone();

    if base_url.is_empty() {
        cleanup();
        let _ = on_event.send(StreamEvent::Error {
            error: LlmError::InvalidConfig {
                field: "baseUrl".into(),
                detail: "Base URL is empty".into(),
            },
        });
        return Ok(());
    }
    if model.is_empty() {
        cleanup();
        let _ = on_event.send(StreamEvent::Error {
            error: LlmError::InvalidConfig {
                field: "model".into(),
                detail: "Model is empty".into(),
            },
        });
        return Ok(());
    }

    // Read API key from keyring (never from webview) — per-platform storage
    let api_key = match state.api_key_storage.retrieve(&settings.platform_id) {
        Ok(Some(k)) => k,
        Ok(None) => {
            cleanup();
            let _ = on_event.send(StreamEvent::Error {
                error: LlmError::Auth {
                    detail: "API Key 未设置，请到设置中配置".into(),
                },
            });
            return Ok(());
        }
        Err(e) => {
            cleanup();
            let _ = on_event.send(StreamEvent::Error {
                error: LlmError::Auth {
                    detail: format!("读取 API Key 失败: {}", e),
                },
            });
            return Ok(());
        }
    };

    // Build request
    let url = format!("{}/chat/completions", base_url);
    let body = build_request_body(&params.messages, &model, &params.thinking, params.enable_tools);

    log::info!("llmRequestStarted: model={} url={}", model, base_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            cleanup();
            let detail = if e.is_timeout() {
                "请求超时，请检查网络或稍后重试".to_string()
            } else if e.is_connect() {
                "无法连接到服务器，请检查 Base URL 或网络".to_string()
            } else {
                format!("网络请求失败: {}", e)
            };
            let _ = on_event.send(StreamEvent::Error {
                error: LlmError::Network { detail },
            });
            return Ok(());
        }
    };

    // Check HTTP status
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();
        cleanup();
        let error = classify_http_error(status, &body_text, &model);
        let _ = on_event.send(StreamEvent::Error { error });
        return Ok(());
    }

    // Stream the response body
    let stream = response.bytes_stream();

    pump_sse_stream(stream, &cancel_flag, &on_event).await;
    cleanup();
    Ok(())
}

/// 轮询等待取消标志被置位。
///
/// `cancel_chat_completions` 只能置 `AtomicBool`（无通知机制），
/// 短间隔轮询即可做到用户感知上的「立即」取消（延迟 ≤ 50ms）。
async fn wait_for_cancel(flag: &AtomicBool) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// 消费 SSE 字节流，把解析出的 StreamEvent 推给前端 Channel。
///
/// 取消标志与 `stream.next()` 通过 `futures_util::select!` 竞争：连接停滞
/// （服务器不再吐数据）时 `stream.next()` 永不返回，若只在循环顶部
/// 检查取消标志，取消请求将永远不会被处理，前端只能等 300s 总超时兜底。
/// （tokio 未启用 macros feature，故用 futures_util 的 select!。）
async fn pump_sse_stream<S, B, E>(
    mut stream: S,
    cancel_flag: &AtomicBool,
    on_event: &Channel<StreamEvent>,
) where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    use futures_util::{FutureExt, StreamExt};

    let mut buffer = String::new();
    let mut tool_call_accumulators: Vec<ToolCallAcc> = Vec::new();

    loop {
        let cancel = wait_for_cancel(cancel_flag).fuse();
        let next = stream.next().fuse();
        futures_util::pin_mut!(cancel, next);

        let next_item = futures_util::select! {
            _ = cancel => {
                // 与原有取消路径一致：发送 StreamInterrupted，由前端
                // （signal.aborted 检查）决定不显示为错误。
                let _ = on_event.send(StreamEvent::Error {
                    error: LlmError::StreamInterrupted {
                        partial_content: String::new(),
                    },
                });
                return;
            }
            item = next => item,
        };

        match next_item {
            Some(Ok(chunk)) => {
                buffer.push_str(&String::from_utf8_lossy(chunk.as_ref()));

                // Take ownership of buffer content to avoid borrow conflicts.
                // Split into complete lines + remaining partial line.
                let content = std::mem::take(&mut buffer);
                let mut lines: Vec<&str> = content.split('\n').collect();
                // The last element is the potentially incomplete line; put it back.
                if let Some(remainder) = lines.pop() {
                    buffer = remainder.to_string();
                }

                let mut done = false;
                for line in &lines {
                    match parse_sse_line(line, &mut tool_call_accumulators, on_event) {
                        Ok(should_continue) => {
                            if !should_continue {
                                done = true;
                                break;
                            }
                        }
                        Err(e) => {
                            log::warn!("SSE parse error: {}", e);
                        }
                    }
                }
                if done {
                    let _ = on_event.send(StreamEvent::Done);
                    return;
                }
            }
            Some(Err(e)) => {
                let _ = on_event.send(StreamEvent::Error {
                    error: LlmError::Network {
                        detail: format!("流式读取失败: {}", e),
                    },
                });
                return;
            }
            None => {
                // Stream ended — process any remaining buffer
                if !buffer.is_empty() {
                    let _ = parse_sse_line(&buffer, &mut tool_call_accumulators, on_event);
                }
                // 未收到 [DONE]/finish_reason 而流直接结束时，残余 buffer
                // 解析不会触发 flush，需兜底 flush，否则已累积的
                // tool_calls 会被静默丢弃。
                flush_tool_calls(&mut tool_call_accumulators, on_event);
                let _ = on_event.send(StreamEvent::Done);
                return;
            }
        }
    }
}

/// Cancel an in-flight streaming request by request_id.
#[tauri::command]
pub async fn cancel_chat_completions(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    let map = state
        .cancel_tokens
        .lock()
        .map_err(|e| format!("Failed to lock cancel map: {}", e))?;
    if let Some(flag) = map.get(&request_id) {
        flag.store(true, Ordering::Relaxed);
        log::info!("llmRequestCancelled: {}", request_id);
    }
    Ok(())
}

/// Test connection with current settings. Sends a minimal request and
/// reports success or a structured error.
#[tauri::command]
pub async fn test_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base_dir = crate::paths::app_data_dir(&app)?;
    let settings = tauri::async_runtime::spawn_blocking(move || {
        crate::load_settings_from_disk(&base_dir)
    })
    .await
    .map_err(|e| format!("Failed to load settings: {}", e))??;

    let base_url = settings.llm.base_url.trim_end_matches('/').to_string();
    let model = settings.llm.model.clone();
    let api_key = state
        .api_key_storage
        .retrieve(&settings.platform_id)
        .map_err(|e| format!("Failed to read API key: {}", e))?;

    let api_key = match api_key {
        Some(k) => k,
        None => {
            return Ok(serde_json::json!({
                "success": false,
                "model": model,
                "error": {"kind": "auth", "detail": "API Key 未设置"}
            }));
        }
    };

    let url = format!("{}/chat/completions", base_url);
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "stream": false,
        "max_tokens": 5,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await;

    match response {
        Ok(r) if r.status().is_success() => Ok(serde_json::json!({
            "success": true,
            "model": model,
        })),
        Ok(r) => {
            let status = r.status().as_u16();
            let body_text = r.text().await.unwrap_or_default();
            let error = classify_http_error(status, &body_text, &model);
            Ok(serde_json::json!({
                "success": false,
                "model": model,
                "error": error,
            }))
        }
        Err(e) => {
            let detail = if e.is_timeout() {
                "请求超时".to_string()
            } else if e.is_connect() {
                "无法连接到服务器".to_string()
            } else {
                format!("{}", e)
            };
            Ok(serde_json::json!({
                "success": false,
                "model": model,
                "error": {"kind": "network", "detail": detail}
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_body_auto_thinking_omits_param() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
        }];
        let body = build_request_body(&messages, "deepseek-v4-flash", &ThinkingMode::Auto, false);
        assert!(body.get("thinking").is_none());
        assert_eq!(body["model"], "deepseek-v4-flash");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn build_request_body_enabled_thinking_sends_param() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
        }];
        let body = build_request_body(&messages, "qwen-plus", &ThinkingMode::Enabled, false);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "high");
    }

    #[test]
    fn build_request_body_disabled_thinking_sends_param() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
        }];
        let body = build_request_body(&messages, "qwen-plus", &ThinkingMode::Disabled, false);
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn build_request_body_with_tools() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
        }];
        let body = build_request_body(&messages, "deepseek-v4-flash", &ThinkingMode::Auto, true);
        assert!(body.get("tools").is_some());
        let tools = body["tools"].as_array().unwrap();
        assert!(tools.len() >= 3);
    }

    #[test]
    fn build_request_body_uses_snake_case_for_tool_messages() {
        let messages = vec![
            ChatMessage {
                role: "assistant".into(),
                content: "".into(),
                tool_call_id: None,
                tool_calls: Some(vec![serde_json::json!({
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "read_pdf_page",
                        "arguments": "{\"page_number\":1}"
                    }
                })]),
                reasoning_content: Some("reasoning".into()),
            },
            ChatMessage {
                role: "tool".into(),
                content: "result".into(),
                tool_call_id: Some("call_1".into()),
                tool_calls: None,
                reasoning_content: None,
            },
        ];
        let body = build_request_body(&messages, "qwen-plus", &ThinkingMode::Auto, false);
        let wire = body["messages"].as_array().unwrap();
        assert_eq!(wire[0]["role"], "assistant");
        assert_eq!(wire[0]["content"], "");
        assert!(wire[0].get("reasoning_content").is_some());
        let tool_calls = wire[0]["tool_calls"].as_array().unwrap();
        assert_eq!(tool_calls[0]["id"], "call_1");
        assert_eq!(tool_calls[0]["function"]["name"], "read_pdf_page");
        assert_eq!(wire[1]["role"], "tool");
        assert_eq!(wire[1]["tool_call_id"], "call_1");
        assert!(wire[1].get("name").is_none());
    }

    #[test]
    fn classify_401_as_auth_error() {
        let body = r#"{"error":{"message":"Authentication Fails, Your api key: fake is invalid","type":"authentication_error"}}"#;
        let error = classify_http_error(401, body, "deepseek-chat");
        match error {
            LlmError::Auth { detail } => {
                // The raw provider message (which may contain the API key) must not leak.
                assert!(!detail.contains("fake"));
                assert!(detail.contains("API Key"));
            }
            _ => panic!("Expected Auth error"),
        }
    }

    #[test]
    fn classify_404_with_model_as_model_not_found() {
        let body = r#"{"error":{"message":"model not found: deepseek-chat","type":"invalid_request_error"}}"#;
        let error = classify_http_error(404, body, "deepseek-chat");
        match error {
            LlmError::ModelNotFound { model, detail } => {
                assert_eq!(model, "deepseek-chat");
                assert!(detail.contains("model not found"));
            }
            _ => panic!("Expected ModelNotFound error"),
        }
    }

    #[test]
    fn classify_429_as_rate_limit() {
        let body = r#"{"error":{"message":"Rate limit exceeded"}}"#;
        let error = classify_http_error(429, body, "deepseek-chat");
        assert!(matches!(error, LlmError::RateLimit { .. }));
    }

    #[test]
    fn classify_500_as_server_error() {
        let body = r#"{"error":{"message":"Internal server error"}}"#;
        let error = classify_http_error(500, body, "deepseek-chat");
        assert!(matches!(error, LlmError::ServerError { .. }));
    }

    #[test]
    fn classify_400_context_length_as_context_exceeded() {
        let body = r#"{"error":{"message":"This model's maximum context length is 128000 tokens"}}"#;
        let error = classify_http_error(400, body, "deepseek-chat");
        assert!(matches!(error, LlmError::ContextLengthExceeded { .. }));
    }

    #[test]
    fn extract_error_message_from_openai_format() {
        let body = r#"{"error":{"message":"Invalid API key","type":"auth_error"}}"#;
        let msg = extract_error_message(body).unwrap();
        assert_eq!(msg, "Invalid API key");
    }

    #[test]
    fn extract_error_message_from_direct_message() {
        let body = r#"{"message":"Something went wrong"}"#;
        let msg = extract_error_message(body).unwrap();
        assert_eq!(msg, "Something went wrong");
    }

    #[test]
    fn extract_error_message_returns_none_for_empty() {
        assert!(extract_error_message("").is_none());
    }

    #[test]
    fn extract_error_message_returns_none_for_non_json() {
        assert!(extract_error_message("not json").is_none());
    }

    #[test]
    fn builtin_tools_has_three_tools() {
        let tools = builtin_tools();
        assert_eq!(tools.len(), 3);
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"list_open_pdfs"));
        assert!(names.contains(&"read_pdf_page"));
        assert!(names.contains(&"search_in_pdf"));
    }

    fn test_channel() -> (Channel<StreamEvent>, Arc<Mutex<Vec<StreamEvent>>>) {
        let events: Arc<Mutex<Vec<StreamEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            let event: Option<StreamEvent> = match body {
                tauri::ipc::InvokeResponseBody::Json(s) => {
                    serde_json::from_str(&s).ok()
                }
                tauri::ipc::InvokeResponseBody::Raw(bytes) => {
                    serde_json::from_slice(&bytes).ok()
                }
            };
            if let Some(event) = event {
                events_clone.lock().unwrap().push(event);
            }
            Ok(())
        });
        (channel, events)
    }

    fn send_lines(lines: &[&str]) -> Vec<StreamEvent> {
        let (channel, events) = test_channel();
        let mut acc: Vec<ToolCallAcc> = Vec::new();
        for line in lines {
            let _ = parse_sse_line(line, &mut acc, &channel);
        }
        let guard = events.lock().unwrap();
        let cloned = guard.clone();
        drop(guard);
        cloned
    }

    #[test]
    fn parse_sse_accumulates_tool_call_arguments() {
        let events = send_lines(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_pdf_page","arguments":"{"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"file_hash\":\""}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"abc\"}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        ]);
        let tool_calls: Vec<&StreamEvent> = events
            .iter()
            .filter(|e| matches!(e, StreamEvent::ToolCall { .. }))
            .collect();
        assert_eq!(tool_calls.len(), 1);
        if let StreamEvent::ToolCall { name, args, call_id } = tool_calls[0] {
            assert_eq!(name, "read_pdf_page");
            assert_eq!(call_id, "call_1");
            assert_eq!(args, r#"{"file_hash":"abc"}"#);
        } else {
            panic!("Expected ToolCall event");
        }
    }

    #[test]
    fn parse_sse_flushes_tool_calls_on_done() {
        let events = send_lines(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"search_in_pdf"}}]}}]}"#,
            r#"data: [DONE]"#,
        ]);
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::ToolCall {
                name,
                call_id,
                ..
            } if name == "search_in_pdf" && call_id == "call_2"
        )));
    }

    #[test]
    fn parse_sse_merges_parallel_tool_calls_by_index() {
        let events = send_lines(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_pdf_page"}},{"index":1,"id":"call_b","function":{"name":"search_in_pdf"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"A"}},{"index":1,"function":{"arguments":"B"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        ]);
        let tool_calls: Vec<&StreamEvent> = events
            .iter()
            .filter(|e| matches!(e, StreamEvent::ToolCall { .. }))
            .collect();
        assert_eq!(tool_calls.len(), 2);
    }

    /// 在 current-thread runtime 上运行异步测试（tokio 未启用 macros feature）。
    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(fut)
    }

    #[test]
    fn pump_cancels_when_stream_stalls() {
        use futures_util::StreamExt;

        block_on(async {
            let (channel, events) = test_channel();
            let cancel_flag = Arc::new(AtomicBool::new(false));
            // 停滞的连接：吐出一段内容后再也不产生新数据。
            let stream = futures_util::stream::iter(vec![Ok::<_, String>(
                b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n".to_vec(),
            )])
            .chain(futures_util::stream::pending());

            let flag = cancel_flag.clone();
            let pump = pump_sse_stream(stream, &cancel_flag, &channel);
            tokio::pin!(pump);

            // 取消置位后 pump 必须在轮询间隔内结束，而不是永远等待。
            let cancelled = async {
                flag.store(true, Ordering::Relaxed);
                pump.await
            };
            tokio::time::timeout(std::time::Duration::from_secs(5), cancelled)
                .await
                .expect("stalled stream must terminate promptly after cancel");

            let guard = events.lock().unwrap();
            assert!(guard.iter().any(|e| matches!(
                e,
                StreamEvent::Error {
                    error: LlmError::StreamInterrupted { .. }
                }
            )));
        });
    }

    #[test]
    fn pump_flushes_tool_calls_when_stream_ends_without_done() {
        block_on(async {
            let (channel, events) = test_channel();
            let cancel_flag = Arc::new(AtomicBool::new(false));
            // 流正常结束，但没有 [DONE] 也没有 finish_reason。
            let stream = futures_util::stream::iter(vec![Ok::<_, String>(
                b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_9\",\"function\":{\"name\":\"search_in_pdf\",\"arguments\":\"{}\"}}]}}]}\n\n".to_vec(),
            )]);

            pump_sse_stream(stream, &cancel_flag, &channel).await;

            let guard = events.lock().unwrap();
            assert!(guard.iter().any(|e| matches!(
                e,
                StreamEvent::ToolCall { name, call_id, .. }
                    if name == "search_in_pdf" && call_id == "call_9"
            )));
            assert!(guard.iter().any(|e| matches!(e, StreamEvent::Done)));
        });
    }

    #[test]
    fn pump_streams_chunks_and_done_normally() {
        block_on(async {
            let (channel, events) = test_channel();
            let cancel_flag = Arc::new(AtomicBool::new(false));
            let stream = futures_util::stream::iter(vec![
                Ok::<_, String>(b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n".to_vec()),
                Ok::<_, String>(b"data: [DONE]\n\n".to_vec()),
            ]);

            pump_sse_stream(stream, &cancel_flag, &channel).await;

            let guard = events.lock().unwrap();
            assert!(guard.iter().any(|e| matches!(
                e,
                StreamEvent::Chunk { content } if content == "hello"
            )));
            assert!(guard.iter().any(|e| matches!(e, StreamEvent::Done)));
        });
    }
}
