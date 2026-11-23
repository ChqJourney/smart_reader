import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.save,
  open: mocks.open,
}));

import {
  chooseBackupExportPath,
  chooseBackupRestorePath,
  exportDataBackup,
  restoreDataBackup,
} from "./backup";

describe("backup service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects zip paths for export and restore", async () => {
    mocks.save.mockResolvedValue("/tmp/backup.zip");
    mocks.open.mockResolvedValue("/tmp/restore.zip");
    expect(await chooseBackupExportPath()).toBe("/tmp/backup.zip");
    expect(await chooseBackupRestorePath()).toBe("/tmp/restore.zip");
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^SpecReader-backup-.*\.zip$/),
      })
    );
  });

  it("invokes the backend backup commands", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ files: 5, bytes: 100 })
      .mockResolvedValueOnce({
        files: 5,
        bytes: 100,
        safetyBackupPath: "/tmp/safety.zip",
      });
    expect(await exportDataBackup("/tmp/backup.zip")).toEqual({
      files: 5,
      bytes: 100,
    });
    expect(await restoreDataBackup("/tmp/backup.zip")).toEqual({
      files: 5,
      bytes: 100,
      safetyBackupPath: "/tmp/safety.zip",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "export_data_backup", {
      filePath: "/tmp/backup.zip",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "restore_data_backup", {
      filePath: "/tmp/backup.zip",
    });
  });
});
