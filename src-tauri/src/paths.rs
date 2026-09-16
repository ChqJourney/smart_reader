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
        if ty.is_symlink() {
            // 符号链接显式分支（file_type 不跟随链接，fs::copy 跟随）：指向
            // 文件的复制目标内容；指向目录或 dangling 的跳过并记日志——单个
            // 坏链接不应中止整个迁移（旧实现里目录 symlink 会让 fs::copy
            // 报 EISDIR 直接 ? 中止）。
            match std::fs::canonicalize(&src_path) {
                Ok(target) if target.is_file() => {
                    std::fs::copy(&target, &dst_path).map_err(|e| {
                        format!(
                            "Failed to copy symlink target {} to {}: {}",
                            target.display(),
                            dst_path.display(),
                            e
                        )
                    })?;
                }
                Ok(_) => {
                    log::warn!(
                        "Migration: skipping directory symlink: {}",
                        src_path.display()
                    );
                }
                Err(_) => {
                    log::warn!(
                        "Migration: skipping dangling symlink: {}",
                        src_path.display()
                    );
                }
            }
        } else if ty.is_dir() {
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

/// 事务化迁移旧数据目录：先完整拷贝到同级临时目录
/// `SpecReader.migrating-<pid>`，全部成功后 rename 为正式目录（同卷原子）。
/// 中途失败时清理临时目录并返回 Err，正式目录不存在、下次启动可重试——
/// 避免旧实现「第一步就建好正式目录、中途失败后因 dir.exists() 永久跳过
/// 迁移」的半迁移永久化问题。
fn migrate_old_dir(old: &std::path::Path, new: &std::path::Path) -> Result<(), String> {
    let staging = new.with_file_name(format!("{}.migrating-{}", APP_DIR_NAME, std::process::id()));
    // 清理上次崩溃遗留的 staging 目录，否则 copy_dir_all 会混入旧残留。
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| format!("Failed to remove stale migration staging dir: {}", e))?;
    }
    if let Err(e) = copy_dir_all(old, &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&staging, new) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "Failed to finalize migration to {}: {}",
            new.display(),
            e
        ));
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
        // 迁移成功后 rename 已建好正式目录，随后的 create_dir_all 为 no-op。
        if let Ok(data_dir) = app.path().data_dir() {
            let old_dir = data_dir.join(OLD_IDENTIFIER).join(APP_DIR_NAME);
            if old_dir.exists() {
                migrate_old_dir(&old_dir, &dir)?;
            }
        }

        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_old_dir_copies_full_tree_and_removes_staging() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old").join(APP_DIR_NAME);
        std::fs::create_dir_all(old.join("annotations").join("sessions")).unwrap();
        std::fs::write(old.join("settings.json"), b"{}").unwrap();
        std::fs::write(old.join("annotations").join("abc.json"), b"data").unwrap();
        let new = tmp.path().join("new").join(APP_DIR_NAME);

        migrate_old_dir(&old, &new).unwrap();

        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), b"{}");
        assert_eq!(
            std::fs::read(new.join("annotations").join("abc.json")).unwrap(),
            b"data"
        );
        // 临时目录已 rename 为正式目录，不留 staging 残留。
        let staging =
            new.with_file_name(format!("{}.migrating-{}", APP_DIR_NAME, std::process::id()));
        assert!(!staging.exists());
    }

    #[test]
    fn migrate_old_dir_cleans_up_pre_existing_staging() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("new.txt"), b"new").unwrap();
        let new = tmp.path().join(APP_DIR_NAME);
        // 模拟上次崩溃遗留的 staging 目录与残留文件。
        let staging = tmp
            .path()
            .join(format!("{}.migrating-{}", APP_DIR_NAME, std::process::id()));
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("stale.txt"), b"stale").unwrap();

        migrate_old_dir(&old, &new).unwrap();

        assert!(new.join("new.txt").exists());
        assert!(!new.join("stale.txt").exists());
        assert!(!staging.exists());
    }

    /// 中途失败后正式目录不存在、staging 被清理，下次启动（重试）可成功。
    #[cfg(unix)]
    #[test]
    fn migrate_old_dir_failure_is_retryable() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        std::fs::create_dir_all(&old).unwrap();
        let unreadable = old.join("unreadable.bin");
        std::fs::write(&unreadable, b"x").unwrap();
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        let new = tmp.path().join(APP_DIR_NAME);

        let result = migrate_old_dir(&old, &new);
        // 恢复权限以便 tempdir 清理与重试读取。
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(result.is_err());
        // 失败不留半迁移的正式目录，也不留 staging。
        assert!(!new.exists());
        let staging = tmp
            .path()
            .join(format!("{}.migrating-{}", APP_DIR_NAME, std::process::id()));
        assert!(!staging.exists());

        // 重试成功。
        migrate_old_dir(&old, &new).unwrap();
        assert_eq!(std::fs::read(new.join("unreadable.bin")).unwrap(), b"x");
    }

    /// 符号链接不中止迁移：指向文件的复制目标内容，目录链接与 dangling
    /// 链接跳过，其余普通条目照常迁移。
    #[cfg(unix)]
    #[test]
    fn migrate_old_dir_symlinks_do_not_abort() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        std::fs::create_dir_all(old.join("real_dir")).unwrap();
        std::fs::write(old.join("real.txt"), b"real").unwrap();
        std::fs::write(old.join("real_dir").join("inner.txt"), b"inner").unwrap();
        symlink(old.join("real.txt"), old.join("link_to_file")).unwrap();
        symlink(old.join("real_dir"), old.join("link_to_dir")).unwrap();
        symlink(old.join("missing.txt"), old.join("dangling")).unwrap();
        let new = tmp.path().join(APP_DIR_NAME);

        migrate_old_dir(&old, &new).unwrap();

        // 文件链接复制了目标内容（落地为普通文件）。
        assert_eq!(std::fs::read(new.join("link_to_file")).unwrap(), b"real");
        // 目录链接与 dangling 链接被跳过。
        assert!(!new.join("link_to_dir").exists());
        assert!(!new.join("dangling").exists());
        // 普通文件与目录照常迁移。
        assert_eq!(std::fs::read(new.join("real.txt")).unwrap(), b"real");
        assert_eq!(
            std::fs::read(new.join("real_dir").join("inner.txt")).unwrap(),
            b"inner"
        );
    }
}
