//! Path helpers shared across the backend.

use std::path::PathBuf;
use tauri::Manager;

const APP_DIR_NAME: &str = "SpecReader";
const OLD_IDENTIFIER: &str = "photonee";

fn copy_dir_all(
    src: impl AsRef<std::path::Path>,
    dst: impl AsRef<std::path::Path>,
) -> Result<(), String> {
    let dst = dst.as_ref();
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create migration target dir: {}", e))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("Failed to read old app data dir: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

/// Resolves the application data directory used for all on-disk storage
/// (annotations, sessions, settings, dictionary, logs).
///
/// The returned path is `<AppData>/SpecReader`.
///
/// When the bundle identifier was changed from `photonee` to `com.photonee.specreader`,
/// Tauri started resolving `BaseDirectory::AppData` to a different parent directory.
/// To avoid losing existing user data, this helper transparently migrates files from
/// the old location the first time the new directory is accessed.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .resolve(".", tauri::path::BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let dir = base.join(APP_DIR_NAME);

    if !dir.exists() {
        // Try to migrate from the old identifier-based data directory.
        if let Ok(data_dir) = app.path().data_dir() {
            let old_dir = data_dir.join(OLD_IDENTIFIER).join(APP_DIR_NAME);
            if old_dir.exists() {
                copy_dir_all(&old_dir, &dir)?;
            }
        }

        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }
    Ok(dir)
}
