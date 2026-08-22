import i18n from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { InterpretationSession } from "./sessions";
import { error } from "./logs";

/**
 * 将会话（解读 / 自定义解读 / 自由提问）构建为可分享的结构化 Markdown：
 * - 标题：LLM 一句话摘要（无则兜底标题）
 * - 原文片段：引用块（blockquote）+ 来源行（文件名 · 页码）
 * - 正文：assistant 消息原始 Markdown 原样保留
 * - 有来源片段时首条 user 消息是模板拼装的 prompt，不进分享内容；
 *   自由提问会话（空 sources）的首条 user 消息就是问题本身，以加粗标签保留
 * - tool 消息 / toolEvents / usage / 思考内容一律不进分享（分享结论而非过程）
 */
export function buildShareMarkdown(session: InterpretationSession): string {
  const parts: string[] = [];

  const title = session.summary?.trim() || i18n.t("share.defaultTitle");
  parts.push(`# ${title}`);

  for (const stash of session.sources) {
    const quote = stash.text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const ref = i18n.t("share.sourceRef", {
      fileName: stash.source.fileName,
      page: stash.source.page,
    });
    parts.push(`${quote}\n>\n> ${ref}`);
  }

  // 自由提问会话没有模板 prompt：首条 user 消息即问题，不能跳过。
  const skipFirstUserMessage = session.sources.length > 0;
  let firstUserMessageSkipped = false;
  for (const message of session.messages) {
    if (message.role === "tool") continue;
    const content = message.content.trim();
    if (content === "") continue;
    if (message.role === "user") {
      if (skipFirstUserMessage && !firstUserMessageSkipped) {
        firstUserMessageSkipped = true;
        continue;
      }
      parts.push(
        i18n.t(
          firstUserMessageSkipped || skipFirstUserMessage
            ? "share.followUpLine"
            : "share.questionLine",
          { content }
        )
      );
      firstUserMessageSkipped = true;
      continue;
    }
    parts.push(content);
  }

  return parts.join("\n\n") + "\n";
}

/// 文件名中禁止出现的字符（Windows / macOS 通用）
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** 用会话摘要生成安全的导出文件名（兜底用默认标题） */
export function shareFileName(session: InterpretationSession): string {
  const base = (session.summary?.trim() || i18n.t("share.defaultTitle"))
    .replace(INVALID_FILENAME_CHARS, "")
    .trim()
    .slice(0, 50);
  return `${base || i18n.t("share.defaultTitle")}.md`;
}

/**
 * 弹系统保存对话框，将会话导出为 .md 文件。
 * 返回 true 表示已导出；用户取消返回 false。
 */
export async function exportSessionMarkdown(
  session: InterpretationSession
): Promise<boolean> {
  try {
    const path = await save({
      defaultPath: shareFileName(session),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return false;
    await invoke("export_text_file", {
      filePath: path,
      content: buildShareMarkdown(session),
    });
    return true;
  } catch (err) {
    error(`Failed to export session markdown: ${err}`);
    return false;
  }
}
