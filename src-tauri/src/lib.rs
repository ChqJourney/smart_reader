use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      read_pdf_bytes,
      open_path,
      get_pdf_hash,
      load_pdf_data,
      save_pdf_data,
      load_session,
      save_session,
      delete_session
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("Failed to open path: {}", e))
}

#[tauri::command]
async fn read_pdf_bytes(file_path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&file_path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| format!("Failed to read PDF file: {}", e))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn get_pdf_hash(file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compute_pdf_hash(&file_path)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn compute_pdf_hash(file_path: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read PDF file: {}", e))?;
    let hash = Sha256::digest(&bytes);
    Ok(hex::encode(hash))
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
    created_at: u64,
    updated_at: u64,
}

fn annotations_dir(base_dir: &std::path::Path) -> std::path::PathBuf {
    let dir = base_dir.join("annotations");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir
}

fn sessions_dir(base_dir: &std::path::Path) -> std::path::PathBuf {
    let dir = annotations_dir(base_dir).join("sessions");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir
}

fn annotations_path(base_dir: &std::path::Path, file_path: &str) -> Result<std::path::PathBuf, String> {
    let hash = compute_pdf_hash(file_path)?;
    let file_name = format!("{}.json", hash);
    let dir = annotations_dir(base_dir);
    Ok(dir.join(file_name))
}

fn session_path(base_dir: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    let dir = sessions_dir(base_dir);
    dir.join(format!("{}.json", session_id))
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
    std::fs::write(&path, raw)
        .map_err(|e| format!("Failed to write annotations file: {}", e))?;
    Ok(())
}

fn load_session_from_disk(base_dir: &std::path::Path, session_id: &str) -> Result<InterpretationSession, String> {
    let path = session_path(base_dir, session_id);
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
    let path = session_path(base_dir, &session.id);
    let raw = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    std::fs::write(&path, raw)
        .map_err(|e| format!("Failed to write session file: {}", e))?;
    Ok(())
}

fn delete_session_from_disk(base_dir: &std::path::Path, session_id: &str) -> Result<(), String> {
    let path = session_path(base_dir, session_id);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete session file: {}", e))?;
    }
    Ok(())
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .resolve(".", tauri::path::BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    // Store all app data under the company/product namespace.
    let dir = base.join("Photonee").join("SpecReader");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    Ok(dir)
}

#[tauri::command]
async fn load_pdf_data(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<PdfAnnotationsFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = app_data_dir(&app)?;
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
        let base_dir = app_data_dir(&app)?;
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
        let base_dir = app_data_dir(&app)?;
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
        let base_dir = app_data_dir(&app)?;
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
        let base_dir = app_data_dir(&app)?;
        delete_session_from_disk(&base_dir, &session_id)
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
            created_at: 1,
            updated_at: 2,
        }
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

        let path = session_path(base.path(), "session-1");
        assert!(!path.exists());
    }

    #[test]
    fn read_pdf_bytes_reads_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.pdf");
        std::fs::write(&path, b"pdf bytes").unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, b"pdf bytes");
    }
}
