import { invoke } from "@tauri-apps/api/core";
import i18n from "i18next";
import type { ToolCallResult } from "./pdfTools";

/**
 * 联网搜索 / 网页抓取工具执行层（web_search / web_fetch）。
 *
 * 实际请求由后端 `web_tools_search` / `web_tools_fetch` 命令经 DeepSeek
 * Search/Fetch API 完成（API Key 只存在后端钥匙串，webview 无外联通道）。
 * 这里只负责参数校验、结果格式化与上下文截断。与 pdfTools 同一约定：
 * 任何错误都转为 result 文本回喂模型，不向 agent loop 抛异常。
 */

/** 单条搜索结果正文截断上限：need_content 的正文可能极长。 */
const PER_RESULT_CONTENT_LIMIT = 4000;
/** 搜索工具结果整体上限：防止 count=50 + need_content 把上下文打爆。 */
const SEARCH_TOTAL_LIMIT = 16000;
/** fetch 单页正文上限。 */
const FETCH_CONTENT_LIMIT = 12000;

interface WebSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string | null;
  date?: string | null;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 把搜索结果格式化为带编号的列表，整体超长时丢弃尾部结果并注明截断。 */
function formatSearchResults(
  query: string,
  results: WebSearchResultItem[]
): string {
  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const lines = [`${i + 1}. ${r.title?.trim() || "(untitled)"}`];
    if (r.url) lines.push(`   URL: ${r.url}`);
    const meta = [
      r.date ? `Date: ${r.date.slice(0, 10)}` : "",
      r.site_name ? `Site: ${r.site_name}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    if (meta) lines.push(`   ${meta}`);
    const abstract = (r.summary || r.snippet || "").trim();
    if (abstract) lines.push(`   ${abstract}`);
    const content = (r.content ?? "").trim();
    if (content) {
      lines.push(`   Content: ${truncate(content, PER_RESULT_CONTENT_LIMIT)}`);
    }
    const block = lines.join("\n");
    if (total + block.length > SEARCH_TOTAL_LIMIT) {
      truncated = true;
      break;
    }
    parts.push(block);
    total += block.length;
  }
  let text = parts.join("\n\n");
  if (truncated) {
    text += "\n\n… [remaining results truncated to fit context]";
  }
  return `Search results for "${query}":\n\n${text}`;
}

export async function executeWebToolCall(
  name: string,
  argsJson: string
): Promise<ToolCallResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return {
      summary: i18n.t("tools.callUnknown", { name }),
      result: `Error: invalid arguments JSON for ${name}`,
    };
  }

  switch (name) {
    case "web_search": {
      const query = String(args.query ?? "").trim();
      const summary = i18n.t("tools.callWebSearch", { query: query || "?" });
      if (!query) {
        return { summary, result: "Error: query is required" };
      }
      let count = Number(args.count ?? 5);
      if (!Number.isFinite(count)) count = 5;
      count = Math.max(1, Math.min(50, Math.floor(count)));
      const needContent = args.need_content === true;
      try {
        const data = await invoke<{ results?: WebSearchResultItem[] }>(
          "web_tools_search",
          { query, count, needContent }
        );
        const results = Array.isArray(data?.results) ? data.results : [];
        if (results.length === 0) {
          return { summary, result: `No results found for "${query}".` };
        }
        return { summary, result: formatSearchResults(query, results) };
      } catch (err) {
        // 后端错误文本已是面向模型的友好文案（含未配置 Key 的引导）。
        return { summary, result: `${err}` };
      }
    }

    case "web_fetch": {
      const url = String(args.url ?? "").trim();
      const summary = i18n.t("tools.callWebFetch", {
        url: truncate(url, 60) || "?",
      });
      if (!url) {
        return { summary, result: "Error: url is required" };
      }
      try {
        const data = await invoke<{ title?: string; content?: string }>(
          "web_tools_fetch",
          { url }
        );
        const content = (data?.content ?? "").trim();
        if (!content) {
          return { summary, result: `No extractable content at ${url}.` };
        }
        const title = (data?.title ?? "").trim();
        const header = `${title ? `# ${title}\n` : ""}URL: ${url}\n\n`;
        return {
          summary,
          result: header + truncate(content, FETCH_CONTENT_LIMIT),
        };
      } catch (err) {
        return { summary, result: `${err}` };
      }
    }

    default:
      return {
        summary: i18n.t("tools.callUnknown", { name }),
        result: `Error: unknown tool ${name}`,
      };
  }
}
