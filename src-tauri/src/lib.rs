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
      load_annotations,
      save_annotations
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("Failed to open path: {}", e))
}

#[tauri::command]
async fn read_pdf_bytes(file_path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&file_path)
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
struct AnnotationPosition {
    page: u32,
    x: f64,
    y: f64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
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
}

fn annotations_dir(base_dir: &std::path::Path) -> std::path::PathBuf {
    let dir = base_dir.join("annotations");
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

fn load_annotations_from_disk(base_dir: &std::path::Path, file_path: &str) -> Result<Vec<Annotation>, String> {
    let path = annotations_path(base_dir, file_path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read annotations file: {}", e))?;
    let annotations: Vec<Annotation> = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse annotations: {}", e))?;
    Ok(annotations)
}

fn save_annotations_to_disk(
    base_dir: &std::path::Path,
    file_path: &str,
    annotations: Vec<Annotation>,
) -> Result<(), String> {
    let path = annotations_path(base_dir, file_path)?;
    let raw = serde_json::to_string_pretty(&annotations)
        .map_err(|e| format!("Failed to serialize annotations: {}", e))?;
    std::fs::write(&path, raw)
        .map_err(|e| format!("Failed to write annotations file: {}", e))?;
    Ok(())
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve(".", tauri::path::BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))
}

#[tauri::command]
async fn load_annotations(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<Vec<Annotation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = app_data_dir(&app)?;
        load_annotations_from_disk(&base_dir, &file_path)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn save_annotations(
    app: tauri::AppHandle,
    file_path: String,
    annotations: Vec<Annotation>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = app_data_dir(&app)?;
        save_annotations_to_disk(&base_dir, &file_path, annotations)
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
            position: AnnotationPosition { page: 1, x: 10.0, y: 20.0 },
            content: "content".to_string(),
            is_streaming: false,
            hidden: false,
            created_at: 123456,
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
    fn save_and_load_annotations_roundtrip() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let annotations = vec![sample_annotation("1"), sample_annotation("2")];
        save_annotations_to_disk(base.path(), pdf_path.to_str().unwrap(), annotations.clone()).unwrap();

        let loaded = load_annotations_from_disk(base.path(), pdf_path.to_str().unwrap()).unwrap();
        assert_eq!(loaded, annotations);
    }

    #[test]
    fn load_annotations_returns_empty_when_missing() {
        let base = tempfile::tempdir().unwrap();
        let pdf_dir = tempfile::tempdir().unwrap();
        let pdf_path = pdf_dir.path().join("test.pdf");
        std::fs::write(&pdf_path, b"pdf content").unwrap();

        let loaded = load_annotations_from_disk(base.path(), pdf_path.to_str().unwrap()).unwrap();
        assert!(loaded.is_empty());
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
