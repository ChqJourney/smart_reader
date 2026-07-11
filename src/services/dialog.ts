import { confirm, message } from "@tauri-apps/plugin-dialog";

export async function showConfirm(
  title: string,
  body: string
): Promise<boolean> {
  return confirm(body, { title, kind: "warning" });
}

export async function showMessage(title: string, body: string): Promise<void> {
  await message(body, { title, kind: "info" });
}
