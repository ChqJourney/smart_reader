import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface BackupSummary {
  files: number;
  bytes: number;
}

export interface RestoreReport extends BackupSummary {
  safetyBackupPath: string;
}

function defaultBackupName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `SpecReader-backup-${now.getFullYear()}-${pad(
    now.getMonth() + 1
  )}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

export async function chooseBackupExportPath(): Promise<string | null> {
  return save({
    defaultPath: defaultBackupName(),
    filters: [{ name: "SpecReader Backup", extensions: ["zip"] }],
  });
}

export async function chooseBackupRestorePath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "SpecReader Backup", extensions: ["zip"] }],
  });
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

export async function exportDataBackup(
  filePath: string
): Promise<BackupSummary> {
  return invoke<BackupSummary>("export_data_backup", { filePath });
}

export async function restoreDataBackup(
  filePath: string
): Promise<RestoreReport> {
  return invoke<RestoreReport>("restore_data_backup", { filePath });
}
