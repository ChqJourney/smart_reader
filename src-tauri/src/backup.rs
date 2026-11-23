use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

const FORMAT_VERSION: u32 = 1;
const MAX_FILES: usize = 10_000;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MANAGED_PATHS: [&str; 3] = ["annotations", "settings.json", "recent_files.json"];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format_version: u32,
    app_version: String,
    created_at: u64,
    files: Vec<BackupFileEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileEntry {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub files: usize,
    pub bytes: u64,
    pub safety_backup_path: String,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{}", std::process::id(), nanos)
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn normalized_archive_path(path: &Path) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or_else(|| "Backup contains a non-UTF-8 path".to_string())?;
    Ok(path.replace('\\', "/"))
}

fn allowed_file_path(path: &str) -> bool {
    if matches!(path, "settings.json" | "recent_files.json") {
        return true;
    }
    let Some(rest) = path.strip_prefix("annotations/") else {
        return false;
    };
    if !rest.contains('/') {
        return rest.ends_with(".json") && rest.len() > ".json".len();
    }
    let Some(session_rest) = rest.strip_prefix("sessions/") else {
        return false;
    };
    let mut parts = session_rest.split('/');
    let first = parts.next().unwrap_or_default();
    let second = parts.next();
    let third = parts.next();
    match (second, third) {
        (None, _) => first.ends_with(".json") && first.len() > ".json".len(),
        (Some(file), None) => {
            !first.is_empty()
                && !file.is_empty()
                && file != ".json"
                && first
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        }
        _ => false,
    }
}

fn safe_relative_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.contains('\0')
    {
        return Err("Unsafe backup path".to_string());
    }
    let relative = Path::new(path);
    if !relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
        || !allowed_file_path(path)
    {
        return Err(format!("Backup path is not allowed: {}", path));
    }
    Ok(relative.to_path_buf())
}

fn collect_regular_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(directory)
        .map_err(|e| format!("Failed to inspect backup source: {}", e))?
        .file_type()
        .is_symlink()
    {
        return Err("Backup source contains a symbolic link".to_string());
    }
    for entry in
        fs::read_dir(directory).map_err(|e| format!("Failed to read backup source: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read backup entry: {}", e))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect backup entry: {}", e))?;
        if file_type.is_symlink() {
            return Err("Backup source contains a symbolic link".to_string());
        }
        if file_type.is_dir() {
            collect_regular_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|e| format!("Failed to resolve backup source path: {}", e))?;
            let archive_path = normalized_archive_path(relative)?;
            if allowed_file_path(&archive_path) {
                files.push(path);
            }
        }
    }
    Ok(())
}

fn backup_source_files(base_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for name in ["settings.json", "recent_files.json"] {
        let path = base_dir.join(name);
        if path.exists() {
            let metadata = fs::symlink_metadata(&path)
                .map_err(|e| format!("Failed to inspect backup source: {}", e))?;
            if metadata.file_type().is_symlink() {
                return Err("Backup source contains a symbolic link".to_string());
            }
            if metadata.is_file() {
                files.push(path);
            }
        }
    }
    collect_regular_files(base_dir, &base_dir.join("annotations"), &mut files)?;
    files.sort();
    if files.len() > MAX_FILES {
        return Err("Too many files to back up".to_string());
    }
    Ok(files)
}

fn read_source_file(base_dir: &Path, path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = fs::read(path).map_err(|e| format!("Failed to read backup source: {}", e))?;
    if path == base_dir.join("settings.json") {
        let mut value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Cannot safely back up malformed settings.json: {}", e))?;
        if let Some(llm) = value.get_mut("llm").and_then(|value| value.as_object_mut()) {
            llm.insert(
                "apiKey".to_string(),
                serde_json::Value::String(String::new()),
            );
        }
        bytes = serde_json::to_vec_pretty(&value)
            .map_err(|e| format!("Failed to sanitize settings backup: {}", e))?;
    }
    Ok(bytes)
}

fn replace_with_temp(temp: &Path, target: &Path) -> Result<(), String> {
    let previous = target.with_file_name(format!(
        ".{}.previous-{}",
        target.file_name().unwrap_or_default().to_string_lossy(),
        unique_suffix()
    ));
    let had_previous = target.exists();
    if had_previous {
        fs::rename(target, &previous)
            .map_err(|e| format!("Failed to stage existing backup: {}", e))?;
    }
    match fs::rename(temp, target) {
        Ok(()) => {
            if had_previous {
                let _ = fs::remove_file(previous);
            }
            Ok(())
        }
        Err(error) => {
            if had_previous {
                let _ = fs::rename(&previous, target);
            }
            Err(format!("Failed to finalize backup: {}", error))
        }
    }
}

pub fn export_backup(base_dir: &Path, target: &Path) -> Result<BackupSummary, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Backup target has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err("Backup target directory does not exist".to_string());
    }
    let source_files = backup_source_files(base_dir)?;
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    for path in &source_files {
        let bytes = read_source_file(base_dir, path)?;
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("Backup data exceeds the size limit".to_string());
        }
        let relative = path
            .strip_prefix(base_dir)
            .map_err(|e| format!("Failed to resolve backup path: {}", e))?;
        entries.push(BackupFileEntry {
            path: normalized_archive_path(relative)?,
            size: bytes.len() as u64,
            sha256: sha256(&bytes),
        });
    }
    let manifest = BackupManifest {
        format_version: FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: now_seconds(),
        files: entries,
    };
    let summary = BackupSummary {
        files: manifest.files.len(),
        bytes: total_bytes,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize backup manifest: {}", e))?;
    let temp = parent.join(format!(".SpecReader-backup-{}.tmp", unique_suffix()));
    let result = (|| {
        let file = File::create(&temp).map_err(|e| format!("Failed to create backup: {}", e))?;
        let mut writer = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file("manifest.json", options)
            .map_err(|e| format!("Failed to write backup manifest: {}", e))?;
        writer
            .write_all(&manifest_bytes)
            .map_err(|e| format!("Failed to write backup manifest: {}", e))?;
        for (path, entry) in source_files.iter().zip(manifest.files.iter()) {
            writer
                .start_file(&entry.path, options)
                .map_err(|e| format!("Failed to add backup file: {}", e))?;
            let bytes = read_source_file(base_dir, path)?;
            if bytes.len() as u64 != entry.size || sha256(&bytes) != entry.sha256 {
                return Err(format!(
                    "Backup source changed while it was being exported: {}",
                    entry.path
                ));
            }
            writer
                .write_all(&bytes)
                .map_err(|e| format!("Failed to write backup data: {}", e))?;
        }
        let file = writer
            .finish()
            .map_err(|e| format!("Failed to finish backup: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync backup: {}", e))?;
        replace_with_temp(&temp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map(|_| summary)
}

fn read_zip_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("Missing or invalid backup entry {}: {}", name, e))?;
    if entry.is_dir() {
        return Err(format!("Backup entry is a directory: {}", name));
    }
    let mut bytes = Vec::new();
    entry
        .by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read backup entry: {}", e))?;
    if bytes.len() as u64 > limit {
        return Err(format!("Backup entry exceeds its size limit: {}", name));
    }
    Ok(bytes)
}

fn validate_archive(archive: &mut ZipArchive<File>) -> Result<BackupManifest, String> {
    if archive.len() > MAX_FILES + 1 {
        return Err("Backup contains too many files".to_string());
    }
    let manifest_bytes = read_zip_entry(archive, "manifest.json", MAX_MANIFEST_BYTES)?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Invalid backup manifest: {}", e))?;
    if manifest.format_version != FORMAT_VERSION {
        return Err(format!(
            "Unsupported backup format version: {}",
            manifest.format_version
        ));
    }
    if manifest.files.len() > MAX_FILES {
        return Err("Backup manifest contains too many files".to_string());
    }
    let mut expected = HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        safe_relative_path(&entry.path)?;
        if !expected.insert(entry.path.clone()) {
            return Err("Backup manifest contains duplicate paths".to_string());
        }
        total = total.saturating_add(entry.size);
        if total > MAX_TOTAL_BYTES {
            return Err("Backup exceeds the uncompressed size limit".to_string());
        }
    }
    let mut actual = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to inspect backup archive: {}", e))?;
        let name = entry
            .name()
            .map_err(|e| format!("Invalid backup entry name: {}", e))?
            .to_string();
        if name == "manifest.json" || name.ends_with('/') {
            continue;
        }
        if !actual.insert(name.clone()) || !expected.contains(&name) {
            return Err(format!("Unexpected or duplicate backup entry: {}", name));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Backup contains a symbolic link".to_string());
        }
    }
    if actual != expected {
        return Err("Backup file list does not match its manifest".to_string());
    }
    for entry in &manifest.files {
        let bytes = read_zip_entry(archive, &entry.path, entry.size)?;
        if bytes.len() as u64 != entry.size || sha256(&bytes) != entry.sha256 {
            return Err(format!("Backup checksum mismatch: {}", entry.path));
        }
        if entry.path.ends_with(".json") {
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|e| format!("Invalid JSON in {}: {}", entry.path, e))?;
        }
    }
    Ok(manifest)
}

fn extract_archive(
    archive: &mut ZipArchive<File>,
    manifest: &BackupManifest,
    staging: &Path,
) -> Result<(), String> {
    for entry in &manifest.files {
        let mut bytes = read_zip_entry(archive, &entry.path, entry.size)?;
        if entry.path == "settings.json" {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid restored settings.json: {}", e))?;
            if let Some(llm) = value.get_mut("llm").and_then(|value| value.as_object_mut()) {
                llm.insert(
                    "apiKey".to_string(),
                    serde_json::Value::String(String::new()),
                );
            }
            bytes = serde_json::to_vec_pretty(&value)
                .map_err(|e| format!("Failed to sanitize restored settings: {}", e))?;
        }
        let target = staging.join(safe_relative_path(&entry.path)?);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create restore staging directory: {}", e))?;
        }
        fs::write(&target, bytes).map_err(|e| format!("Failed to stage restored data: {}", e))?;
    }
    fs::create_dir_all(staging.join("annotations"))
        .map_err(|e| format!("Failed to prepare restored annotations: {}", e))?;
    Ok(())
}

fn move_existing_to_rollback(base_dir: &Path, rollback: &Path) -> Result<(), String> {
    for name in MANAGED_PATHS {
        let source = base_dir.join(name);
        if source.exists() {
            let target = rollback.join(name);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to prepare restore rollback: {}", e))?;
            }
            fs::rename(&source, &target)
                .map_err(|e| format!("Failed to stage current data: {}", e))?;
        }
    }
    Ok(())
}

fn restore_rollback(base_dir: &Path, rollback: &Path) {
    for name in MANAGED_PATHS {
        let target = base_dir.join(name);
        if target.exists() {
            if target.is_dir() {
                let _ = fs::remove_dir_all(&target);
            } else {
                let _ = fs::remove_file(&target);
            }
        }
        let source = rollback.join(name);
        if source.exists() {
            let _ = fs::rename(source, target);
        }
    }
}

fn apply_staging(base_dir: &Path, staging: &Path, rollback: &Path) -> Result<(), String> {
    fs::create_dir_all(rollback)
        .map_err(|e| format!("Failed to create rollback directory: {}", e))?;
    if let Err(error) = move_existing_to_rollback(base_dir, rollback) {
        restore_rollback(base_dir, rollback);
        return Err(error);
    }
    for name in MANAGED_PATHS {
        let source = staging.join(name);
        if !source.exists() {
            continue;
        }
        if let Err(error) = fs::rename(&source, base_dir.join(name)) {
            restore_rollback(base_dir, rollback);
            return Err(format!("Failed to apply restored data: {}", error));
        }
    }
    Ok(())
}

pub fn restore_backup(base_dir: &Path, archive_path: &Path) -> Result<RestoreReport, String> {
    let file = File::open(archive_path).map_err(|e| format!("Failed to open backup: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid backup archive: {}", e))?;
    let manifest = validate_archive(&mut archive)?;
    let summary = BackupSummary {
        files: manifest.files.len(),
        bytes: manifest.files.iter().map(|entry| entry.size).sum(),
    };
    let parent = archive_path
        .parent()
        .ok_or_else(|| "Backup source has no parent directory".to_string())?;
    let safety_path = parent.join(format!("SpecReader-pre-restore-{}.zip", unique_suffix()));
    export_backup(base_dir, &safety_path)?;

    let base_parent = base_dir
        .parent()
        .ok_or_else(|| "Application data directory has no parent".to_string())?;
    let suffix = unique_suffix();
    let staging = base_parent.join(format!(".SpecReader-restore-staging-{}", suffix));
    let rollback = base_parent.join(format!(".SpecReader-restore-rollback-{}", suffix));
    let result = (|| {
        fs::create_dir_all(&staging)
            .map_err(|e| format!("Failed to create restore staging directory: {}", e))?;
        extract_archive(&mut archive, &manifest, &staging)?;
        apply_staging(base_dir, &staging, &rollback)
    })();
    if result.is_err() {
        restore_rollback(base_dir, &rollback);
    }
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&rollback);
    result.map(|_| RestoreReport {
        files: summary.files,
        bytes: summary.bytes,
        safety_backup_path: safety_path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn sample_data(base: &Path) {
        write(
            base.join("settings.json").as_path(),
            br#"{"llm":{"apiKey":"secret","model":"test"}}"#,
        );
        write(base.join("recent_files.json").as_path(), b"[]");
        write(
            base.join("annotations/hash.json").as_path(),
            br#"{"annotations":[],"sessionIds":["session-1"]}"#,
        );
        write(
            base.join("annotations/sessions/session-1.json").as_path(),
            br#"{"id":"session-1"}"#,
        );
        write(
            base.join("annotations/sessions/session-1/image.jpg")
                .as_path(),
            &[1, 2, 3],
        );
        write(base.join("logs/app.log").as_path(), b"keep me");
    }

    #[test]
    fn backup_roundtrip_restores_data_and_preserves_unmanaged_files() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("SpecReader");
        fs::create_dir_all(&base).unwrap();
        sample_data(&base);
        let archive = tmp.path().join("backup.zip");
        let summary = export_backup(&base, &archive).unwrap();
        assert_eq!(summary.files, 5);

        let file = File::open(&archive).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        let settings = read_zip_entry(&mut zip, "settings.json", 10000).unwrap();
        assert!(!String::from_utf8(settings).unwrap().contains("secret"));
        assert!(zip.by_name("logs/app.log").is_err());

        write(base.join("annotations/hash.json").as_path(), b"changed");
        fs::remove_file(base.join("annotations/sessions/session-1/image.jpg")).unwrap();
        let report = restore_backup(&base, &archive).unwrap();
        assert_eq!(report.files, 5);
        assert!(Path::new(&report.safety_backup_path).is_file());
        assert_eq!(
            fs::read(base.join("annotations/hash.json")).unwrap(),
            br#"{"annotations":[],"sessionIds":["session-1"]}"#
        );
        assert_eq!(
            fs::read(base.join("annotations/sessions/session-1/image.jpg")).unwrap(),
            vec![1, 2, 3]
        );
        assert_eq!(fs::read(base.join("logs/app.log")).unwrap(), b"keep me");
    }

    #[test]
    fn checksum_mismatch_does_not_modify_current_data() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("SpecReader");
        fs::create_dir_all(&base).unwrap();
        sample_data(&base);
        let archive_path = tmp.path().join("bad.zip");
        let file = File::create(&archive_path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        let manifest = BackupManifest {
            format_version: FORMAT_VERSION,
            app_version: "test".to_string(),
            created_at: 1,
            files: vec![BackupFileEntry {
                path: "recent_files.json".to_string(),
                size: 2,
                sha256: "wrong".to_string(),
            }],
        };
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        writer.start_file("recent_files.json", options).unwrap();
        writer.write_all(b"[]").unwrap();
        writer.finish().unwrap();

        let before = fs::read(base.join("settings.json")).unwrap();
        assert!(restore_backup(&base, &archive_path).is_err());
        assert_eq!(fs::read(base.join("settings.json")).unwrap(), before);
    }

    #[test]
    fn restore_sanitizes_api_key_from_external_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("SpecReader");
        fs::create_dir_all(&base).unwrap();
        sample_data(&base);
        let settings = br#"{"llm":{"apiKey":"imported-secret","model":"restored"}}"#;
        let archive_path = tmp.path().join("external.zip");
        let file = File::create(&archive_path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        let manifest = BackupManifest {
            format_version: FORMAT_VERSION,
            app_version: "test".to_string(),
            created_at: 1,
            files: vec![BackupFileEntry {
                path: "settings.json".to_string(),
                size: settings.len() as u64,
                sha256: sha256(settings),
            }],
        };
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        writer.start_file("settings.json", options).unwrap();
        writer.write_all(settings).unwrap();
        writer.finish().unwrap();

        restore_backup(&base, &archive_path).unwrap();
        let restored = fs::read_to_string(base.join("settings.json")).unwrap();
        assert!(!restored.contains("imported-secret"));
        assert!(restored.contains("restored"));
    }

    #[test]
    fn path_traversal_is_rejected() {
        let path = "../outside.json";
        assert!(safe_relative_path(path).is_err());
        assert!(safe_relative_path("annotations/../../outside.json").is_err());
        assert!(safe_relative_path("annotations/sessions/id/image.jpg").is_ok());
    }
}
