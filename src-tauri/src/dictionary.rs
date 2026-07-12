use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

const DEFAULT_DICT_DOWNLOAD_URL: &str =
    "https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip";

/// Returns the dictionary download URL.
///
/// The URL can be overridden via the `SPECREADER_DICT_URL` environment variable
/// so mirrors or internal hosting can be used without recompiling.
fn dict_download_url() -> String {
    std::env::var("SPECREADER_DICT_URL").unwrap_or_else(|_| DEFAULT_DICT_DOWNLOAD_URL.to_string())
}

const DICT_DIR: &str = "dict";
const DICT_FILE: &str = "ecdict.sqlite";
const DICT_ZIP_TMP: &str = "ecdict.sqlite.zip.tmp";
const DICT_EXTRACT_DIR: &str = "ecdict.sqlite.extract";
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";
/// Maximum total bytes allowed when extracting the dictionary archive.
/// This guards against zip bombs / decompression bombs.
const MAX_DICT_EXTRACT_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

/// Expected SHA-256 of the downloaded dictionary zip archive.
/// Leave empty to skip zip-level verification. When non-empty, the downloaded
/// file is hashed before extraction and rejected on mismatch.
const EXPECTED_DICT_ZIP_SHA256: &str = "";

/// Expected SHA-256 of the extracted `ecdict.sqlite` file.
/// This guards against tampering of the final dictionary file.
const EXPECTED_DICT_SQLITE_SHA256: &str =
    "2b5b40c2bdba04da0a51c8672e090f166987d5d895f32eb3fbfc5a516455fc75";

const DOWNLOAD_PROGRESS_EVENT: &str = "dictionary-download-progress";

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryStatus {
    pub exists: bool,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DictEntry {
    pub word: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phonetic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    status: &'static str,
    downloaded: u64,
    total: u64,
    message: Option<String>,
}

fn dict_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::app_data_dir(app)?.join(DICT_DIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create dictionary directory: {}", e))?;
    }
    Ok(dir)
}

fn dict_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(dict_dir(app)?.join(DICT_FILE))
}

fn dict_tmp_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(dict_dir(app)?.join(DICT_ZIP_TMP))
}

fn dict_extract_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(dict_dir(app)?.join(DICT_EXTRACT_DIR))
}

pub fn check_dictionary(app: &tauri::AppHandle) -> Result<DictionaryStatus, String> {
    let path = dict_path(app)?;
    if path.exists() {
        let size = std::fs::metadata(&path).map(|m| m.len()).ok();
        Ok(DictionaryStatus {
            exists: true,
            path: path.to_string_lossy().to_string(),
            size,
        })
    } else {
        Ok(DictionaryStatus {
            exists: false,
            path: path.to_string_lossy().to_string(),
            size: None,
        })
    }
}

fn emit_progress(
    app_handle: &tauri::AppHandle,
    status: &'static str,
    downloaded: u64,
    total: u64,
    message: Option<String>,
) {
    if let Err(e) = app_handle.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            status,
            downloaded,
            total,
            message,
        },
    ) {
        log::warn!("Failed to emit dictionary download progress: {}", e);
    }
}

pub async fn download_dictionary(app_handle: tauri::AppHandle) -> Result<(), String> {
    let tmp_path = dict_tmp_path(&app_handle)?;
    let final_path = dict_path(&app_handle)?;

    if final_path.exists() {
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("SpecReader/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    const MAX_RETRIES: u32 = 5;
    const CHUNK_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

    // Probe total size once. This also warms up any redirects.
    let total_size = {
        let head = client
            .head(dict_download_url())
            .send()
            .await
            .map_err(|e| format!("Failed to probe download URL: {}", e))?;
        if !head.status().is_success() {
            return Err(format!(
                "Failed to probe download URL: HTTP {}",
                head.status()
            ));
        }
        head.content_length().unwrap_or(0)
    };

    let mut start_from = tokio::fs::metadata(&tmp_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    emit_progress(
        &app_handle,
        "downloading",
        start_from,
        total_size,
        Some(format!(
            "已下载 {} / {} ({:.0}%)",
            start_from,
            total_size,
            if total_size > 0 {
                (start_from as f64 / total_size as f64) * 100.0
            } else {
                0.0
            }
        )),
    );

    let mut retries = 0;
    let mut downloaded = start_from;

    while retries <= MAX_RETRIES {
        let mut request = client.get(dict_download_url());
        if start_from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={}-", start_from));
        }

        let mut response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                retries += 1;
                emit_progress(
                    &app_handle,
                    "downloading",
                    downloaded,
                    total_size,
                    Some(format!("连接失败: {}，第 {} 次重试...", e, retries)),
                );
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
        };

        if !response.status().is_success() {
            retries += 1;
            emit_progress(
                &app_handle,
                "downloading",
                downloaded,
                total_size,
                Some(format!(
                    "HTTP {}，第 {} 次重试...",
                    response.status(),
                    retries
                )),
            );
            tokio::time::sleep(RETRY_DELAY).await;
            continue;
        }

        let is_partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&tmp_path)
            .await
            .map_err(|e| format!("Failed to open temp file: {}", e))?;

        if !is_partial && start_from > 0 {
            // Server ignored the Range header; restart from scratch.
            file.set_len(0)
                .await
                .map_err(|e| format!("Failed to reset temp file: {}", e))?;
            start_from = 0;
            downloaded = 0;
        }

        if is_partial && start_from > 0 {
            file.seek(std::io::SeekFrom::Start(start_from))
                .await
                .map_err(|e| format!("Failed to seek temp file: {}", e))?;
        }

        let mut last_emit = downloaded;
        let emit_interval = 256 * 1024; // emit every 256 KiB
        let mut stream_finished_cleanly = false;

        loop {
            let chunk_result = tokio::time::timeout(CHUNK_READ_TIMEOUT, response.chunk()).await;
            match chunk_result {
                Ok(Ok(Some(chunk))) => {
                    file.write_all(&chunk)
                        .await
                        .map_err(|e| format!("Failed to write chunk: {}", e))?;
                    downloaded += chunk.len() as u64;

                    if downloaded.saturating_sub(last_emit) >= emit_interval {
                        emit_progress(&app_handle, "downloading", downloaded, total_size, None);
                        last_emit = downloaded;
                    }
                }
                Ok(Ok(None)) => {
                    stream_finished_cleanly = true;
                    break;
                }
                Ok(Err(e)) => {
                    emit_progress(
                        &app_handle,
                        "downloading",
                        downloaded,
                        total_size,
                        Some(format!("下载中断: {}，准备重试...", e)),
                    );
                    start_from = downloaded;
                    retries += 1;
                    break;
                }
                Err(_) => {
                    emit_progress(
                        &app_handle,
                        "downloading",
                        downloaded,
                        total_size,
                        Some("下载超时，准备重试...".to_string()),
                    );
                    start_from = downloaded;
                    retries += 1;
                    break;
                }
            }
        }

        if !stream_finished_cleanly {
            // Inner loop exited because of an error/timeout; the outer loop will retry.
            tokio::time::sleep(RETRY_DELAY).await;
            continue;
        }

        file.flush()
            .await
            .map_err(|e| format!("Failed to flush temp file: {}", e))?;

        if total_size == 0 || downloaded >= total_size {
            // Download completed.
            break;
        }

        // Stream finished but the file is shorter than expected.
        emit_progress(
            &app_handle,
            "downloading",
            downloaded,
            total_size,
            Some("文件不完整，准备重试...".to_string()),
        );
        start_from = downloaded;
        retries += 1;
        tokio::time::sleep(RETRY_DELAY).await;
    }

    if retries > MAX_RETRIES {
        return Err("词典下载失败，已超过最大重试次数".to_string());
    }

    if total_size > 0 && downloaded < total_size {
        return Err(format!(
            "词典下载不完整: {} / {} bytes",
            downloaded, total_size
        ));
    }

    // Verify the downloaded zip archive matches the expected hash, if configured.
    if !EXPECTED_DICT_ZIP_SHA256.is_empty() {
        emit_progress(
            &app_handle,
            "verifying",
            downloaded,
            total_size,
            Some("正在校验词典包...".to_string()),
        );
        let tmp_path_clone = tmp_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            verify_file_hash(&tmp_path_clone, EXPECTED_DICT_ZIP_SHA256)
        })
        .await
        .map_err(|e| format!("Dictionary zip hash verification task failed: {}", e))?
        .map_err(|e| format!("Dictionary zip hash verification failed: {}", e))?;
    }

    emit_progress(
        &app_handle,
        "verifying",
        downloaded,
        total_size,
        Some("正在解压词典...".to_string()),
    );

    let extract_dir = dict_extract_dir(&app_handle)?;
    if extract_dir.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(&extract_dir).await {
            log::warn!("Failed to remove stale extract directory: {}", e);
        }
    }
    tokio::fs::create_dir_all(&extract_dir)
        .await
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    // Extract on a blocking thread because zip I/O is synchronous.
    let tmp_path_clone = tmp_path.clone();
    let extract_dir_clone = extract_dir.clone();
    let final_path_clone = final_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        extract_sqlite(&tmp_path_clone, &extract_dir_clone, &final_path_clone)
    })
    .await
    .map_err(|e| format!("Extraction task failed: {}", e))?
    .map_err(|e| format!("Failed to extract dictionary: {}", e))?;

    emit_progress(
        &app_handle,
        "verifying",
        downloaded,
        total_size,
        Some("正在校验词典...".to_string()),
    );

    // Verify the extracted file is a valid SQLite database by opening it.
    {
        let conn = Connection::open(&final_path)
            .map_err(|e| format!("Extracted dictionary is not a valid SQLite file: {}", e))?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='stardict'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Dictionary schema check failed: {}", e))?;
        if count == 0 {
            return Err("Dictionary file is missing the stardict table".to_string());
        }
    }

    // Verify the extracted SQLite file matches the expected hash.
    {
        let final_path_clone = final_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            verify_file_hash(&final_path_clone, EXPECTED_DICT_SQLITE_SHA256)
        })
        .await
        .map_err(|e| format!("Dictionary SQLite hash verification task failed: {}", e))?
        .map_err(|e| format!("Dictionary SQLite hash verification failed: {}", e))?;
    }

    // Clean up temp files.
    if let Err(e) = tokio::fs::remove_file(&tmp_path).await {
        log::warn!("Failed to remove dictionary temp file: {}", e);
    }
    if let Err(e) = tokio::fs::remove_dir_all(&extract_dir).await {
        log::warn!("Failed to remove dictionary extract directory: {}", e);
    }

    emit_progress(&app_handle, "done", downloaded, total_size, None);
    Ok(())
}

fn extract_sqlite(
    zip_path: &std::path::Path,
    extract_dir: &std::path::Path,
    final_path: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {}", e))?;

    // Extract every entry. We do not rely on file names because some releases
    // use non-UTF8 encodings (e.g. GBK) for Chinese file names.
    let mut extracted_size: u64 = 0;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;
        if file.is_dir() {
            continue;
        }

        let out_path = extract_dir.join(format!("entry_{}", i));
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create extract parent directory: {}", e))?;
        }
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| format!("Failed to create extracted file: {}", e))?;
        let copied = std::io::copy(&mut file, &mut out)
            .map_err(|e| format!("Failed to extract file: {}", e))?;
        extracted_size += copied;
        if extracted_size > MAX_DICT_EXTRACT_BYTES {
            return Err(format!(
                "Extracted dictionary size exceeds the maximum allowed {} bytes",
                MAX_DICT_EXTRACT_BYTES
            ));
        }
    }

    // Locate the SQLite file by its magic header.
    let sqlite_path = find_sqlite_file(extract_dir)
        .ok_or("No SQLite database found in the downloaded archive")?;

    std::fs::rename(&sqlite_path, final_path)
        .map_err(|e| format!("Failed to move dictionary to final location: {}", e))?;

    Ok(())
}

fn find_sqlite_file(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut entries = vec![dir.to_path_buf()];
    while let Some(current) = entries.pop() {
        if let Ok(read_dir) = std::fs::read_dir(&current) {
            for entry in read_dir.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    entries.push(path);
                } else {
                    let mut header = vec![0u8; SQLITE_MAGIC.len()];
                    if let Ok(mut f) = std::fs::File::open(&path) {
                        if std::io::Read::read_exact(&mut f, &mut header).is_ok()
                            && header == SQLITE_MAGIC
                        {
                            return Some(path);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Compute the SHA-256 hex digest of a file.
fn hash_file(path: &std::path::Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = std::io::Read::read(&mut file, &mut buffer)
            .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Verify a file's SHA-256 hex digest matches the expected value.
/// An empty `expected` disables the check.
fn verify_file_hash(path: &std::path::Path, expected: &str) -> Result<(), String> {
    if expected.is_empty() {
        return Ok(());
    }
    let actual = hash_file(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "SHA-256 mismatch: expected {}, got {}",
            expected, actual
        ))
    }
}

pub fn lookup_word(
    dict_connection: &Arc<Mutex<Option<Connection>>>,
    app: &tauri::AppHandle,
    word: String,
) -> Result<Option<DictEntry>, String> {
    let path = dict_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let mut conn_guard = dict_connection
        .lock()
        .map_err(|e| format!("Dictionary connection lock poisoned: {}", e))?;
    if conn_guard.is_none() {
        *conn_guard = Some(
            Connection::open(&path)
                .map_err(|e| format!("Failed to open dictionary database: {}", e))?,
        );
    }
    let db = conn_guard
        .as_ref()
        .ok_or("Dictionary connection is not available")?;

    let mut stmt = db
        .prepare(
            "SELECT word, phonetic, definition, translation, pos FROM stardict WHERE word = ? COLLATE NOCASE",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let entry = stmt
        .query_row([&word], |row| {
            Ok(DictEntry {
                word: row.get(0)?,
                phonetic: row.get(1)?,
                definition: row.get(2)?,
                translation: row.get(3)?,
                pos: row.get(4)?,
            })
        })
        .optional()
        .map_err(|e| format!("Failed to query word: {}", e))?;

    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_magic_matches() {
        assert_eq!(SQLITE_MAGIC, b"SQLite format 3\0");
    }
}
