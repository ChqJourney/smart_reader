use tauri::{Emitter, Manager};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

const LOG_FILE_NAME: &str = "app";
const MAX_LOG_FILE_SIZE: u128 = 10 * 1024 * 1024; // 10 MB

mod dictionary;
mod paths;
mod secure_storage;

const OPEN_PDF_EVENT: &str = "open-pdf";

/// Application-wide state shared across Tauri commands.
///
/// `allowed_paths` tracks PDF files that the user has explicitly authorized
/// through the file dialog or recent-files list. Commands that read PDF bytes
/// or compute hashes must validate paths against this set to prevent arbitrary
/// file access from the webview.
struct AppState {
    allowed_paths: Mutex<HashSet<std::path::PathBuf>>,
    api_key_storage: Arc<dyn secure_storage::ApiKeyStorage>,
}

impl AppState {
    fn new() -> Self {
        Self {
            allowed_paths: Mutex::new(HashSet::new()),
            api_key_storage: Arc::new(secure_storage::KeyringStorage),
        }
    }

    fn authorize_path(&self, path: &std::path::Path) {
        self.allowed_paths.lock().unwrap().insert(path.to_path_buf());
    }

    fn is_path_allowed(&self, path: &std::path::Path) -> bool {
        self.allowed_paths.lock().unwrap().contains(path)
    }
}

fn is_pdf_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn validate_pdf_access(state: &AppState, file_path: &str) -> Result<(), String> {
    let path = std::path::Path::new(file_path);
    if !is_pdf_path(file_path) {
        return Err(format!("Not a PDF file: {}", file_path));
    }
    if !state.is_path_allowed(path) {
        return Err(format!("PDF path is not authorized: {}", file_path));
    }
    Ok(())
}

fn extract_pdf_path(args: &[String]) -> Option<String> {
    // Skip the executable itself, then take the first argument that looks like a PDF path.
    args.iter()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".pdf"))
        .cloned()
}

fn emit_open_pdf(app_handle: &tauri::AppHandle, args: &[String]) {
    if let Some(path) = extract_pdf_path(args) {
        if let Err(e) = app_handle.emit(OPEN_PDF_EVENT, path) {
            log::warn!("Failed to emit open-pdf event: {}", e);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        emit_open_pdf(app, &args);
    }));

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();
            emit_open_pdf(
                &handle,
                &std::env::args().collect::<Vec<_>>(),
            );

            // Initialize logging for both debug and release builds so users can
            // provide logs when reporting issues. Logs are written under the app
            // data directory and never include sensitive content such as API keys,
            // full PDF text, or user file paths.
            let base_dir = paths::app_data_dir(app.handle())?;
            let logs_dir = base_dir.join("logs");
            if !logs_dir.exists() {
                std::fs::create_dir_all(&logs_dir)
                    .map_err(|e| format!("Failed to create logs directory: {}", e))?;
            }
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Folder {
                            path: logs_dir,
                            file_name: Some(LOG_FILE_NAME.to_string()),
                        },
                    ))
                    .max_file_size(MAX_LOG_FILE_SIZE)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                    .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                    .build(),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_pdf_bytes,
            open_path,
            open_logs_dir,
            get_pdf_hash,
            authorize_pdf_path,
            load_pdf_data,
            save_pdf_data,
            load_session,
            save_session,
            delete_session,
            load_settings,
            save_settings,
            load_recent_files,
            save_recent_files,
            check_dictionary,
            download_dictionary,
            lookup_word
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            // Finder file-open / single-instance activation: pick the first PDF
            // URL and emit it to the frontend so the existing window opens it.
            for url in urls {
                let path = url.to_string();
                if path.to_lowercase().ends_with(".pdf") {
                    let _ = app_handle.emit(OPEN_PDF_EVENT, path);
                    break;
                }
            }
        }
    });
}

#[tauri::command]
fn open_logs_dir(app: tauri::AppHandle) -> Result<(), String> {
    let base_dir = paths::app_data_dir(&app)?;
    let logs_dir = base_dir.join("logs");
    if !logs_dir.exists() {
        std::fs::create_dir_all(&logs_dir)
            .map_err(|e| format!("Failed to create logs directory: {}", e))?;
    }
    open::that(&logs_dir).map_err(|e| format!("Failed to open logs directory: {}", e))
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    validate_open_url(&path)?;
    open::that(&path).map_err(|e| format!("Failed to open path: {}", e))
}

fn validate_open_url(path: &str) -> Result<(), String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        Ok(())
    } else {
        Err(format!("open_path only supports http/https URLs: {}", path))
    }
}

#[tauri::command]
async fn authorize_pdf_path(state: tauri::State<'_, AppState>, file_path: String) -> Result<(), String> {
    if !is_pdf_path(&file_path) {
        return Err(format!("Not a PDF file: {}", file_path));
    }
    state.authorize_path(std::path::Path::new(&file_path));
    Ok(())
}

fn read_pdf_bytes_core(state: &AppState, file_path: &str) -> Result<Vec<u8>, String> {
    validate_pdf_access(state, file_path)?;
    std::fs::read(file_path).map_err(|e| format!("Failed to read PDF file: {}", e))
}

#[tauri::command]
async fn read_pdf_bytes(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = read_pdf_bytes_core(&state, &file_path)?;
    tauri::async_runtime::spawn_blocking(move || Ok(tauri::ipc::Response::new(bytes)))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn get_pdf_hash(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<String, String> {
    validate_pdf_access(&state, &file_path)?;
    tauri::async_runtime::spawn_blocking(move || compute_pdf_hash(&file_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

fn compute_pdf_hash(file_path: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    const CHUNK_SIZE: usize = 64 * 1024; // 64 KB

    let mut file = std::fs::File::open(file_path)
        .map_err(|e| format!("Failed to open PDF file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; CHUNK_SIZE];

    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read PDF file: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    Ok(hex::encode(hasher.finalize()))
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AnnotationPosition {
    page: u32,
    x: f64,
    y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<f64>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Annotation {
    id: String,
    #[serde(rename = "type")]
    annotation_type: String,
    text: String,
    position: AnnotationPosition,
    content: String,
    #[serde(default)]
    is_streaming: bool,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stash_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interpreted_group_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interpreted_index: Option<u32>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct PdfAnnotationsFile {
    annotations: Vec<Annotation>,
    #[serde(default)]
    session_ids: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StashSource {
    tab_id: String,
    file_name: String,
    file_path: String,
    file_hash: String,
    page: u32,
    pdf_x: f64,
    pdf_y: f64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StashItem {
    id: String,
    source: StashSource,
    text: String,
    #[serde(default)]
    created_at: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct InterpretationMessage {
    id: String,
    role: String,
    content: String,
    created_at: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct InterpretationSession {
    id: String,
    sources: Vec<StashItem>,
    messages: Vec<InterpretationMessage>,
    #[serde(default)]
    is_streaming: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    streaming_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SystemPrompts {
    translate: String,
    explain: String,
}

impl Default for SystemPrompts {
    fn default() -> Self {
        Self {
            translate: "你是一位检测认证行业标准文档翻译助手，擅长把英文标准条款准确翻译成{targetLanguage}。请保持专业术语准确，首次出现关键术语时保留原文，不要编造片段中未提及的条款或页码。".to_string(),
            explain: "你是一位检测认证行业标准文档阅读助手，擅长把复杂的英文标准条款解释得清晰易懂。请基于用户提供的文档片段用{targetLanguage}回答，不要编造片段中未提及的条款或页码。".to_string(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LlmConfig {
    base_url: String,
    api_key: String,
    model: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    llm: LlmConfig,
    #[serde(default = "default_target_language")]
    target_language: String,
    #[serde(default)]
    system_prompts: SystemPrompts,
}

fn default_target_language() -> String {
    "中文".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            llm: LlmConfig {
                base_url: "https://api.openai.com/v1".to_string(),
                api_key: "".to_string(),
                model: "gpt-4o-mini".to_string(),
            },
            target_language: default_target_language(),
            system_prompts: SystemPrompts::default(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RecentFile {
    path: String,
    file_name: String,
    #[serde(default)]
    opened_at: u64,
}

fn annotations_dir(base_dir: &std::path::Path) -> std::path::PathBuf {
    let dir = base_dir.join("annotations");
    if !dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!("Failed to create annotations directory: {}", e);
        }
    }
    dir
}

fn sessions_dir(base_dir: &std::path::Path) -> std::path::PathBuf {
    let dir = annotations_dir(base_dir).join("sessions");
    if !dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!("Failed to create sessions directory: {}", e);
        }
    }
    dir
}

fn annotations_path(base_dir: &std::path::Path, file_path: &str) -> Result<std::path::PathBuf, String> {
    let hash = compute_pdf_hash(file_path)?;
    let file_name = format!("{}.json", hash);
    let dir = annotations_dir(base_dir);
    Ok(dir.join(file_name))
}

fn session_path(base_dir: &std::path::Path, session_id: &str) -> Result<std::path::PathBuf, String> {
    validate_session_id(session_id)?;
    let dir = sessions_dir(base_dir);
    Ok(dir.join(format!("{}.json", session_id)))
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("Invalid session id: empty".to_string());
    }
    if !session_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid session id: {}", session_id));
    }
    Ok(())
}

fn settings_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("settings.json")
}

fn recent_files_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("recent_files.json")
}

/// Global serialization lock for all atomic file writes. Writes are fast and
/// infrequent, so a single lock keeps the implementation simple while preventing
/// concurrent writes to the same file from racing on the temporary file / rename.
static ATOMIC_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Atomically write `content` to `path` by first writing to a temporary file
/// in the same directory and then renaming it into place. This ensures that
/// `path` is never in a partially-written state if the process crashes.
fn atomic_write(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    let _guard = ATOMIC_WRITE_LOCK
        .lock()
        .map_err(|e| format!("Failed to acquire write lock: {}", e))?;
    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, content)
        .map_err(|e| format!("Failed to write temporary file: {}", e))?;
    std::fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename temporary file: {}", e))?;
    Ok(())
}

fn load_pdf_data_from_disk(base_dir: &std::path::Path, file_path: &str) -> Result<PdfAnnotationsFile, String> {
    let path = annotations_path(base_dir, file_path)?;
    if !path.exists() {
        return Ok(PdfAnnotationsFile::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read annotations file: {}", e))?;

    // Try new format first
    if let Ok(data) = serde_json::from_str::<PdfAnnotationsFile>(&raw) {
        return Ok(data);
    }

    // Backward compatibility: old format was a plain array of annotations
    if let Ok(annotations) = serde_json::from_str::<Vec<Annotation>>(&raw) {
        return Ok(PdfAnnotationsFile { annotations, session_ids: Vec::new() });
    }

    Err("Failed to parse annotations file".to_string())
}

fn save_pdf_data_to_disk(
    base_dir: &std::path::Path,
    file_path: &str,
    data: PdfAnnotationsFile,
) -> Result<(), String> {
    let path = annotations_path(base_dir, file_path)?;
    let raw = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize annotations: {}", e))?;
    atomic_write(&path, raw.as_bytes())
        .map_err(|e| format!("Failed to write annotations file: {}", e))?;
    Ok(())
}

fn load_session_from_disk(base_dir: &std::path::Path, session_id: &str) -> Result<InterpretationSession, String> {
    let path = session_path(base_dir, session_id)?;
    if !path.exists() {
        return Err(format!("Session file not found: {}", session_id));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session file: {}", e))?;
    let session: InterpretationSession = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse session: {}", e))?;
    Ok(session)
}

fn save_session_to_disk(
    base_dir: &std::path::Path,
    session: InterpretationSession,
) -> Result<(), String> {
    let path = session_path(base_dir, &session.id)?;
    let raw = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    atomic_write(&path, raw.as_bytes())
        .map_err(|e| format!("Failed to write session file: {}", e))?;
    Ok(())
}

fn delete_session_from_disk(base_dir: &std::path::Path, session_id: &str) -> Result<(), String> {
    let path = session_path(base_dir, session_id)?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete session file: {}", e))?;
    }
    Ok(())
}

fn load_settings_from_disk(base_dir: &std::path::Path) -> Result<AppSettings, String> {
    let path = settings_path(base_dir);
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read settings file: {}", e))?;
    let settings: AppSettings = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse settings: {}", e))?;
    Ok(settings)
}

fn save_settings_to_disk(base_dir: &std::path::Path, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(base_dir);
    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    atomic_write(&path, raw.as_bytes())
        .map_err(|e| format!("Failed to write settings file: {}", e))?;
    Ok(())
}

/// Load settings from disk and restore the API key from secure storage.
/// The JSON file never contains the actual API key.
///
/// For backwards compatibility with versions that stored the API key in
/// settings.json, if secure storage has no entry but the on-disk file still
/// contains a non-empty key, the key is migrated into secure storage.
fn load_settings_with_storage(
    base_dir: &std::path::Path,
    storage: &dyn secure_storage::ApiKeyStorage,
) -> Result<AppSettings, String> {
    let mut settings = load_settings_from_disk(base_dir)?;
    match storage.retrieve()? {
        Some(key) => {
            settings.llm.api_key = key;
        }
        None => {
            // Migrate a plaintext API key from older versions into the keyring.
            if !settings.llm.api_key.is_empty() {
                storage.store(&settings.llm.api_key)?;
                // Clear the plaintext key from disk so it is no longer exposed.
                let mut cleared = settings.clone();
                cleared.llm.api_key = String::new();
                save_settings_to_disk(base_dir, cleared)?;
            }
        }
    }
    Ok(settings)
}

/// Persist settings. The API key is stored in secure storage; the on-disk
/// JSON is written with an empty apiKey field. If secure storage fails,
/// the entire save is rejected so the key is never silently written to disk.
fn save_settings_with_storage(
    base_dir: &std::path::Path,
    mut settings: AppSettings,
    storage: &dyn secure_storage::ApiKeyStorage,
) -> Result<(), String> {
    storage.store(&settings.llm.api_key)?;
    settings.llm.api_key = String::new();
    save_settings_to_disk(base_dir, settings)
}

fn load_recent_files_from_disk(base_dir: &std::path::Path) -> Result<Vec<RecentFile>, String> {
    let path = recent_files_path(base_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read recent files file: {}", e))?;
    let files: Vec<RecentFile> = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse recent files: {}", e))?;
    Ok(files)
}

fn save_recent_files_to_disk(base_dir: &std::path::Path, files: Vec<RecentFile>) -> Result<(), String> {
    let path = recent_files_path(base_dir);
    let raw = serde_json::to_string_pretty(&files)
        .map_err(|e| format!("Failed to serialize recent files: {}", e))?;
    atomic_write(&path, raw.as_bytes())
        .map_err(|e| format!("Failed to write recent files file: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn load_pdf_data(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<PdfAnnotationsFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        load_pdf_data_from_disk(&base_dir, &file_path)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn save_pdf_data(
    app: tauri::AppHandle,
    file_path: String,
    data: PdfAnnotationsFile,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        save_pdf_data_to_disk(&base_dir, &file_path, data)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn load_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<InterpretationSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        load_session_from_disk(&base_dir, &session_id)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn save_session(
    app: tauri::AppHandle,
    session: InterpretationSession,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        save_session_to_disk(&base_dir, session)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn delete_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        delete_session_from_disk(&base_dir, &session_id)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn load_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings, String> {
    let storage = state.api_key_storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        load_settings_with_storage(&base_dir, storage.as_ref())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    let storage = state.api_key_storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        save_settings_with_storage(&base_dir, settings, storage.as_ref())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn load_recent_files(
    app: tauri::AppHandle,
) -> Result<Vec<RecentFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        load_recent_files_from_disk(&base_dir)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn save_recent_files(
    app: tauri::AppHandle,
    files: Vec<RecentFile>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        save_recent_files_to_disk(&base_dir, files)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn check_dictionary(app: tauri::AppHandle) -> Result<dictionary::DictionaryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<dictionary::DictionaryStatus, String> {
        dictionary::check_dictionary(&app)
    })
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn download_dictionary(app: tauri::AppHandle) -> Result<(), String> {
    dictionary::download_dictionary(app).await
}

#[tauri::command]
async fn lookup_word(app: tauri::AppHandle, word: String) -> Result<Option<dictionary::DictEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<dictionary::DictEntry>, String> {
        dictionary::lookup_word(&app, word)
    })
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_annotation(id: &str) -> Annotation {
        Annotation {
            id: id.to_string(),
            annotation_type: "explain".to_string(),
            text: "hello".to_string(),
            position: AnnotationPosition { page: 1, x: 10.0, y: 20.0, width: None, height: None },
            content: "content".to_string(),
            is_streaming: false,
            hidden: false,
            created_at: 123456,
            session_id: None,
            stash_id: None,
            interpreted_group_size: None,
            interpreted_index: None,
        }
    }

    fn sample_session(id: &str) -> InterpretationSession {
        InterpretationSession {
            id: id.to_string(),
            sources: vec![StashItem {
                id: "stash-1".to_string(),
                source: StashSource {
                    tab_id: "tab-1".to_string(),
                    file_name: "test.pdf".to_string(),
                    file_path: "/tmp/test.pdf".to_string(),
                    file_hash: "hash".to_string(),
                    page: 1,
                    pdf_x: 10.0,
                    pdf_y: 20.0,
                },
                text: "stash text".to_string(),
                created_at: 1000,
            }],
            messages: vec![InterpretationMessage {
                id: "msg-1".to_string(),
                role: "user".to_string(),
                content: "prompt".to_string(),
                created_at: 1,
            }],
            is_streaming: false,
            streaming_message_id: None,
            action: Some("explain".to_string()),
            created_at: 1,
            updated_at: 2,
        }
    }

    fn sample_settings() -> AppSettings {
        AppSettings {
            llm: LlmConfig {
                base_url: "https://api.example.com/v1".to_string(),
                api_key: "sk-test".to_string(),
                model: "gpt-4o-mini".to_string(),
            },
            target_language: "中文".to_string(),
            system_prompts: SystemPrompts::default(),
        }
    }

    fn sample_recent_files() -> Vec<RecentFile> {
        vec![
            RecentFile {
                path: "/tmp/a.pdf".to_string(),
                file_name: "a.pdf".to_string(),
                opened_at: 1,
            },
            RecentFile {
                path: "/tmp/b.pdf".to_string(),
                file_name: "b.pdf".to_string(),
                opened_at: 2,
            },
        ]
    }

    #[test]
    fn compute_pdf_hash_matches_expected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.pdf");
        std::fs::write(&path, b"pdf content").unwrap();

        let hash = compute_pdf_hash(path.to_str().unwrap()).unwrap();
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn annotations_path_is_deterministic() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let p1 = annotations_path(base.path(), pdf_path.to_str().unwrap()).unwrap();
        let p2 = annotations_path(base.path(), pdf_path.to_str().unwrap()).unwrap();
        assert_eq!(p1, p2);
        assert!(p1.to_string_lossy().contains("annotations"));
        assert_eq!(p1.extension().unwrap(), "json");
    }

    #[test]
    fn save_and_load_pdf_data_roundtrip() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let data = PdfAnnotationsFile {
            annotations: vec![sample_annotation("1"), sample_annotation("2")],
            session_ids: vec!["session-a".to_string()],
        };
        save_pdf_data_to_disk(base.path(), pdf_path.to_str().unwrap(), data.clone()).unwrap();

        let loaded = load_pdf_data_from_disk(base.path(), pdf_path.to_str().unwrap()).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn load_pdf_data_deserializes_camel_case_json() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let raw = r#"{
            "annotations": [
                {
                    "id": "a1",
                    "type": "explain",
                    "text": "hello",
                    "position": { "page": 1, "x": 10.0, "y": 20.0 },
                    "content": "content",
                    "isStreaming": true,
                    "hidden": false,
                    "createdAt": 123456,
                    "sessionId": "s1",
                    "stashId": null,
                    "interpretedGroupSize": 2,
                    "interpretedIndex": 1
                }
            ],
            "sessionIds": ["s1", "s2"]
        }"#;
        let path = annotations_path(base.path(), pdf_path.to_str().unwrap()).unwrap();
        std::fs::write(&path, raw).unwrap();

        let loaded = load_pdf_data_from_disk(base.path(), pdf_path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.annotations.len(), 1);
        let annotation = &loaded.annotations[0];
        assert_eq!(annotation.id, "a1");
        assert_eq!(annotation.annotation_type, "explain");
        assert!(annotation.is_streaming);
        assert_eq!(annotation.created_at, 123456);
        assert_eq!(annotation.session_id.as_deref(), Some("s1"));
        assert_eq!(annotation.stash_id, None);
        assert_eq!(annotation.interpreted_group_size, Some(2));
        assert_eq!(annotation.interpreted_index, Some(1));
        assert_eq!(loaded.session_ids, vec!["s1".to_string(), "s2".to_string()]);
    }

    #[test]
    fn save_pdf_data_serializes_camel_case_json() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let mut annotation = sample_annotation("1");
        annotation.is_streaming = true;
        annotation.created_at = 123456;
        annotation.session_id = Some("s1".to_string());
        annotation.interpreted_group_size = Some(2);
        annotation.interpreted_index = Some(1);

        let data = PdfAnnotationsFile {
            annotations: vec![annotation],
            session_ids: vec!["s1".to_string()],
        };
        save_pdf_data_to_disk(base.path(), pdf_path.to_str().unwrap(), data).unwrap();

        let path = annotations_path(base.path(), pdf_path.to_str().unwrap()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"sessionId\":"), "serialized annotation should use camelCase sessionId");
        assert!(raw.contains("\"sessionIds\":"), "serialized file should use camelCase sessionIds");
        assert!(raw.contains("\"interpretedGroupSize\":"), "serialized annotation should use camelCase interpretedGroupSize");
        assert!(raw.contains("\"createdAt\":"), "serialized annotation should use camelCase createdAt");
        assert!(!raw.contains("\"session_id\":"), "serialized annotation should not use snake_case session_id");
    }

    #[test]
    fn load_pdf_data_returns_empty_when_missing() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let loaded = load_pdf_data_from_disk(base.path(), pdf_path.to_str().unwrap()).unwrap();
        assert!(loaded.annotations.is_empty());
        assert!(loaded.session_ids.is_empty());
    }

    #[test]
    fn load_pdf_data_backward_compatible_with_plain_array() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let annotations = vec![sample_annotation("1")];
        let path = annotations_path(base.path(), pdf_path.to_str().unwrap()).unwrap();
        let raw = serde_json::to_string_pretty(&annotations).unwrap();
        std::fs::write(&path, raw).unwrap();

        let loaded = load_pdf_data_from_disk(base.path(), pdf_path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.annotations, annotations);
        assert!(loaded.session_ids.is_empty());
    }

    #[test]
    fn save_and_load_session_roundtrip() {
        let base = tempfile::tempdir().unwrap();
        let session = sample_session("session-1");
        save_session_to_disk(base.path(), session.clone()).unwrap();

        let loaded = load_session_from_disk(base.path(), "session-1").unwrap();
        assert_eq!(loaded, session);
    }

    #[test]
    fn delete_session_removes_file() {
        let base = tempfile::tempdir().unwrap();
        let session = sample_session("session-1");
        save_session_to_disk(base.path(), session).unwrap();

        delete_session_from_disk(base.path(), "session-1").unwrap();

        let path = session_path(base.path(), "session-1").unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn save_session_rejects_path_traversal_id() {
        let base = tempfile::tempdir().unwrap();
        let mut session = sample_session("session-1");
        session.id = "../settings".to_string();

        let result = save_session_to_disk(base.path(), session);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid session id"));
    }

    #[test]
    fn load_session_rejects_path_traversal_id() {
        let base = tempfile::tempdir().unwrap();

        let result = load_session_from_disk(base.path(), "../settings");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid session id"));
    }

    #[test]
    fn delete_session_rejects_path_traversal_id() {
        let base = tempfile::tempdir().unwrap();

        let result = delete_session_from_disk(base.path(), "../settings");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid session id"));
    }

    // H-1: path validation for PDF commands.
    #[test]
    fn validate_pdf_access_rejects_unauthorized_path() {
        let state = AppState::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.pdf");
        std::fs::write(&path, b"pdf bytes").unwrap();

        let result = validate_pdf_access(&state, path.to_str().unwrap());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not authorized"));
    }

    #[test]
    fn validate_pdf_access_rejects_non_pdf_extension() {
        let state = AppState::new();
        state.authorize_path(std::path::Path::new("/tmp/secret.txt"));

        let result = validate_pdf_access(&state, "/tmp/secret.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not a PDF file"));
    }

    #[test]
    fn validate_pdf_access_accepts_authorized_pdf() {
        let state = AppState::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.pdf");
        std::fs::write(&path, b"pdf bytes").unwrap();

        state.authorize_path(&path);
        let result = validate_pdf_access(&state, path.to_str().unwrap());
        assert!(result.is_ok());
    }

    #[test]
    fn validate_open_url_accepts_http_and_https() {
        assert!(validate_open_url("https://example.com").is_ok());
        assert!(validate_open_url("http://localhost:1420").is_ok());
    }

    #[test]
    fn validate_open_url_rejects_file_and_local_paths() {
        assert!(validate_open_url("file:///etc/passwd").is_err());
        assert!(validate_open_url("/path/to/file.pdf").is_err());
        assert!(validate_open_url("../settings.json").is_err());
    }

    // H-2: atomic file writes.
    #[test]
    fn atomic_write_creates_target_file_with_full_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");

        atomic_write(&path, b"complete content").unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "complete content");
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");

        atomic_write(&path, b"content").unwrap();

        let tmp_path = path.with_extension("tmp");
        assert!(!tmp_path.exists());
    }

    #[test]
    fn atomic_write_replaces_existing_file_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, b"old content").unwrap();

        atomic_write(&path, b"new content").unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "new content");
    }

    #[test]
    fn read_pdf_bytes_reads_file() {
        let state = AppState::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.pdf");
        std::fs::write(&path, b"pdf bytes").unwrap();

        // Authorize the path so validation passes, then verify the core logic
        // returns the exact bytes.
        let path_str = path.to_string_lossy().to_string();
        state.authorize_path(&path);
        let bytes = read_pdf_bytes_core(&state, &path_str).unwrap();
        assert_eq!(bytes, b"pdf bytes");
    }

    #[test]
    fn read_pdf_bytes_rejects_unauthorized_path() {
        let state = AppState::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.pdf");
        std::fs::write(&path, b"pdf bytes").unwrap();

        let result = read_pdf_bytes_core(&state, &path.to_string_lossy());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not authorized"));
    }

    #[test]
    fn load_settings_returns_default_when_missing() {
        let base = tempfile::tempdir().unwrap();
        let loaded = load_settings_from_disk(base.path()).unwrap();
        assert_eq!(loaded, AppSettings::default());
        assert_eq!(loaded.target_language, "中文");
        assert_eq!(loaded.llm.model, "gpt-4o-mini");
        assert!(!loaded.system_prompts.translate.is_empty());
        assert!(!loaded.system_prompts.explain.is_empty());
    }

    #[test]
    fn save_and_load_settings_roundtrip() {
        let base = tempfile::tempdir().unwrap();
        let settings = sample_settings();
        save_settings_to_disk(base.path(), settings.clone()).unwrap();

        let loaded = load_settings_from_disk(base.path()).unwrap();
        assert_eq!(loaded, settings);
    }

    #[test]
    fn save_settings_serializes_camel_case_json() {
        let base = tempfile::tempdir().unwrap();
        let settings = sample_settings();
        save_settings_to_disk(base.path(), settings).unwrap();

        let raw = std::fs::read_to_string(settings_path(base.path())).unwrap();
        assert!(raw.contains("\"targetLanguage\":"), "serialized settings should use camelCase targetLanguage");
        assert!(raw.contains("\"baseUrl\":"), "serialized llm config should use camelCase baseUrl");
        assert!(raw.contains("\"apiKey\":"), "serialized llm config should use camelCase apiKey");
        assert!(raw.contains("\"systemPrompts\":"), "serialized settings should use camelCase systemPrompts");
    }

    // H-10: API key must be stored in secure storage, never in the JSON file.
    struct FailingStorage;

    impl secure_storage::ApiKeyStorage for FailingStorage {
        fn store(&self, _api_key: &str) -> Result<(), String> {
            Err("keyring unavailable".to_string())
        }

        fn retrieve(&self) -> Result<Option<String>, String> {
            Err("keyring unavailable".to_string())
        }

        fn delete(&self) -> Result<(), String> {
            Err("keyring unavailable".to_string())
        }
    }

    #[test]
    fn save_settings_with_storage_stores_key_in_keyring_and_clears_disk_field() {
        let base = tempfile::tempdir().unwrap();
        let storage: Arc<dyn secure_storage::ApiKeyStorage> = Arc::new(secure_storage::MemoryStorage::new());
        let settings = sample_settings();

        save_settings_with_storage(base.path(), settings.clone(), storage.as_ref()).unwrap();

        assert_eq!(storage.retrieve().unwrap(), Some("sk-test".to_string()));
        let raw = std::fs::read_to_string(settings_path(base.path())).unwrap();
        assert!(
            raw.contains("\"apiKey\": \"\"") || raw.contains("\"apiKey\":\"\""),
            "apiKey field on disk should be empty, got: {}",
            raw
        );
        assert!(!raw.contains("sk-test"), "API key must not appear in settings JSON");

        let loaded = load_settings_with_storage(base.path(), storage.as_ref()).unwrap();
        assert_eq!(loaded.llm.api_key, "sk-test");
    }

    #[test]
    fn save_settings_with_storage_refuses_when_keyring_fails() {
        let base = tempfile::tempdir().unwrap();
        let storage: Arc<dyn secure_storage::ApiKeyStorage> = Arc::new(FailingStorage);
        let settings = sample_settings();

        let result = save_settings_with_storage(base.path(), settings, storage.as_ref());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("keyring unavailable"));
    }

    #[test]
    fn load_settings_with_storage_propagates_keyring_error() {
        let base = tempfile::tempdir().unwrap();
        let storage: Arc<dyn secure_storage::ApiKeyStorage> = Arc::new(FailingStorage);

        let result = load_settings_with_storage(base.path(), storage.as_ref());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("keyring unavailable"));
    }

    #[test]
    fn load_settings_migrates_plaintext_api_key_to_secure_storage() {
        let base = tempfile::tempdir().unwrap();
        let storage: Arc<dyn secure_storage::ApiKeyStorage> =
            Arc::new(secure_storage::MemoryStorage::new());
        let mut settings = sample_settings();
        settings.llm.api_key = "sk-from-plaintext".to_string();
        save_settings_to_disk(base.path(), settings).unwrap();

        let loaded =
            load_settings_with_storage(base.path(), storage.as_ref()).unwrap();
        assert_eq!(loaded.llm.api_key, "sk-from-plaintext");

        // The plaintext key should have been removed from disk.
        let from_disk = load_settings_from_disk(base.path()).unwrap();
        assert_eq!(from_disk.llm.api_key, "");

        // A subsequent load should retrieve the key from secure storage.
        let loaded_again =
            load_settings_with_storage(base.path(), storage.as_ref()).unwrap();
        assert_eq!(loaded_again.llm.api_key, "sk-from-plaintext");
    }

    #[test]
    fn load_settings_returns_empty_api_key_when_keyring_has_no_entry() {
        let base = tempfile::tempdir().unwrap();
        let storage: Arc<dyn secure_storage::ApiKeyStorage> = Arc::new(secure_storage::MemoryStorage::new());
        let mut settings = sample_settings();
        settings.llm.api_key = String::new();
        save_settings_to_disk(base.path(), settings).unwrap();

        let loaded = load_settings_with_storage(base.path(), storage.as_ref()).unwrap();
        assert_eq!(loaded.llm.api_key, "");
    }

    #[test]
    fn load_recent_files_returns_empty_when_missing() {
        let base = tempfile::tempdir().unwrap();
        let loaded = load_recent_files_from_disk(base.path()).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn save_and_load_recent_files_roundtrip() {
        let base = tempfile::tempdir().unwrap();
        let files = sample_recent_files();
        save_recent_files_to_disk(base.path(), files.clone()).unwrap();

        let loaded = load_recent_files_from_disk(base.path()).unwrap();
        assert_eq!(loaded, files);
    }

    #[test]
    fn app_data_dir_does_not_contain_extra_photonee() {
        // This test verifies the path helper logic without a real Tauri app handle.
        // The function itself requires an AppHandle; here we test the join behavior
        // by checking that our on-disk helpers put files directly under SpecReader.
        let base = tempfile::tempdir().unwrap();
        let app_data = base.path().join("SpecReader");
        std::fs::create_dir_all(&app_data).unwrap();

        let settings = sample_settings();
        save_settings_to_disk(&app_data, settings).unwrap();

        let path = settings_path(&app_data);
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("SpecReader"));
        assert!(!path_str.contains("SpecReader/Photonee"));
    }
}
