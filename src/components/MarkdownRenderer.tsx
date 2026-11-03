import ReactMarkdown from "react-markdown";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { error as logError } from "@tauri-apps/plugin-log";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { defaultSchema, type Schema } from "hast-util-sanitize";
import "katex/dist/katex.min.css";
import { useModal } from "../hooks/useModal";
import { copyToClipboard } from "../utils/clipboard";
import Icon from "./Icon";
import "./MarkdownRenderer.css";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

interface ErrorBoundaryProps {
  content: string;
  className: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// 扩展 sanitize schema：保留 KaTeX 所需的 class/style，并允许常见 SVG 标签。
const svgTagNames = [
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "defs",
  "use",
  "symbol",
  "text",
  "tspan",
  "title",
];

const svgAttributes = [
  "xmlns",
  "viewBox",
  "width",
  "height",
  "fill",
  "stroke",
  "strokeWidth",
  "strokeLinecap",
  "strokeLinejoin",
  "d",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "rx",
  "ry",
  "transform",
  "opacity",
];

const sanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...svgTagNames],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "style"],
    svg: [...(defaultSchema.attributes?.svg ?? []), ...svgAttributes],
    g: [...(defaultSchema.attributes?.g ?? []), ...svgAttributes],
    path: [...(defaultSchema.attributes?.path ?? []), ...svgAttributes],
    circle: [...(defaultSchema.attributes?.circle ?? []), ...svgAttributes],
    rect: [...(defaultSchema.attributes?.rect ?? []), ...svgAttributes],
    line: [...(defaultSchema.attributes?.line ?? []), ...svgAttributes],
    polyline: [...(defaultSchema.attributes?.polyline ?? []), ...svgAttributes],
    polygon: [...(defaultSchema.attributes?.polygon ?? []), ...svgAttributes],
    ellipse: [...(defaultSchema.attributes?.ellipse ?? []), ...svgAttributes],
    text: [
      ...(defaultSchema.attributes?.text ?? []),
      ...svgAttributes,
      "fontSize",
      "fontFamily",
    ],
    tspan: [...(defaultSchema.attributes?.tspan ?? []), ...svgAttributes],
  },
};

function MarkdownTable({
  children,
  className = "",
  ...props
}: React.ComponentPropsWithoutRef<"table">) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { contentRef } = useModal({
    open: expanded,
    onClose: () => setExpanded(false),
  });
  const table = (
    <table {...props} className={`markdown-table ${className}`}>
      {children}
    </table>
  );

  return (
    <>
      <div className="markdown-table-card">
        <div className="markdown-table-toolbar">
          <span>{t("markdown.table")}</span>
          <button
            type="button"
            className="markdown-icon-btn"
            onClick={() => setExpanded(true)}
            aria-label={t("markdown.expandTable")}
            title={t("markdown.expandTable")}
          >
            <Icon name="maximize" size={13} />
          </button>
        </div>
        <div className="markdown-table-scroll">{table}</div>
      </div>
      {expanded &&
        createPortal(
          <div
            className="markdown-dialog-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
            }}
          >
            <div
              ref={contentRef}
              className="markdown-dialog markdown-table-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={t("markdown.tableDialog")}
            >
              <div className="markdown-dialog-header">
                <h3>{t("markdown.tableDialog")}</h3>
                <button
                  type="button"
                  className="markdown-icon-btn"
                  onClick={() => setExpanded(false)}
                  aria-label={t("common.close")}
                  title={t("common.close")}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="markdown-table-dialog-scroll">{table}</div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

interface SvgPreviewProps extends React.ComponentPropsWithoutRef<"svg"> {
  source?: string;
  isComplete?: boolean;
}

function serializeSvg(container: HTMLDivElement | null): string {
  const svg = container?.querySelector("svg");
  if (!svg) return "";
  const serialized = svg.outerHTML;
  return /\sxmlns\s*=/.test(serialized)
    ? serialized
    : serialized.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function SvgPreview({
  source,
  isComplete = true,
  children,
  ...svgProps
}: SvgPreviewProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"preview" | "source">(
    isComplete ? "preview" : "source"
  );
  const [expanded, setExpanded] = useState(false);
  const [serializedSource, setSerializedSource] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);
  const { contentRef } = useModal({
    open: expanded,
    onClose: () => setExpanded(false),
  });

  useEffect(() => {
    if (isComplete) setMode("preview");
  }, [isComplete]);

  useEffect(() => {
    if (mode !== "preview" || !isComplete) return;
    const serialized = serializeSvg(previewRef.current);
    if (serialized) setSerializedSource(serialized);
  }, [children, isComplete, mode, source]);

  const graphic =
    source === undefined ? (
      <svg {...svgProps}>{children}</svg>
    ) : (
      <ReactMarkdown
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={{
          svg: ({ node: _node, ...props }) => <svg {...props} />,
        }}
      >
        {source}
      </ReactMarkdown>
    );

  const getSvgSource = () =>
    serializeSvg(previewRef.current) || serializedSource;

  const handleCopy = () => {
    const content = getSvgSource();
    if (!content) return;
    void copyToClipboard(content).catch((err) =>
      logError(`Failed to copy SVG: ${err}`)
    );
  };

  const handleDownload = async () => {
    const content = getSvgSource();
    if (!content) return;
    try {
      const filePath = await save({
        defaultPath: "diagram.svg",
        filters: [{ name: "SVG", extensions: ["svg"] }],
      });
      if (!filePath) return;
      await invoke("export_text_file", { filePath, content });
    } catch (err) {
      logError(`Failed to export SVG: ${err}`);
    }
  };

  return (
    <>
      <div className="markdown-svg-card">
        <div className="markdown-svg-toolbar">
          <div
            className="markdown-svg-tabs"
            aria-label={t("markdown.svgDialog")}
          >
            <button
              type="button"
              className={mode === "preview" ? "active" : ""}
              onClick={() => setMode("preview")}
              disabled={!isComplete}
              aria-pressed={mode === "preview"}
            >
              {t("markdown.preview")}
            </button>
            <button
              type="button"
              className={mode === "source" ? "active" : ""}
              onClick={() => setMode("source")}
              aria-pressed={mode === "source"}
            >
              {t("markdown.source")}
            </button>
          </div>
          <div className="markdown-svg-actions">
            <button
              type="button"
              className="markdown-icon-btn"
              onClick={handleCopy}
              disabled={!isComplete}
              aria-label={t("markdown.copySvg")}
              title={t("markdown.copySvg")}
            >
              <Icon name="copy" size={13} />
            </button>
            <button
              type="button"
              className="markdown-icon-btn"
              onClick={() => void handleDownload()}
              disabled={!isComplete}
              aria-label={t("markdown.downloadSvg")}
              title={t("markdown.downloadSvg")}
            >
              <Icon name="download" size={13} />
            </button>
            <button
              type="button"
              className="markdown-icon-btn"
              onClick={() => setExpanded(true)}
              disabled={!isComplete}
              aria-label={t("markdown.expandSvg")}
              title={t("markdown.expandSvg")}
            >
              <Icon name="maximize" size={13} />
            </button>
          </div>
        </div>
        {mode === "preview" && isComplete ? (
          <div ref={previewRef} className="markdown-svg-stage">
            {graphic}
          </div>
        ) : (
          <pre className="markdown-svg-source">
            <code>{source ?? serializedSource}</code>
          </pre>
        )}
      </div>
      {expanded &&
        createPortal(
          <div
            className="markdown-dialog-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
            }}
          >
            <div
              ref={contentRef}
              className="markdown-dialog markdown-svg-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={t("markdown.svgDialog")}
            >
              <div className="markdown-dialog-header">
                <h3>{t("markdown.svgDialog")}</h3>
                <button
                  type="button"
                  className="markdown-icon-btn"
                  onClick={() => setExpanded(false)}
                  aria-label={t("common.close")}
                  title={t("common.close")}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="markdown-svg-dialog-stage">{graphic}</div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

// 流式输出中可能出现在数学公式中间被截断，导致 remark-math 解析失败。
// ErrorBoundary 在 Markdown 解析异常时降级为纯文本，避免整个消息白屏。
class MarkdownErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={`markdown-content ${this.props.className}`}>
          {this.props.content}
        </div>
      );
    }
    return this.props.children;
  }
}

// props 只有字符串（content / className），包一层 memo：流式输出时
// AiChatPanel 每次状态更新都会重渲染，未变化的历史消息不必重跑
// react-markdown（解析 + KaTeX 渲染成本高）。
function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  return (
    <MarkdownErrorBoundary content={content} className={className}>
      <div className={`markdown-content ${className}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[
            rehypeRaw,
            [rehypeSanitize, sanitizeSchema],
            rehypeKatex,
          ]}
          components={{
            a: ({ node: _node, ...props }) => (
              <a target="_blank" rel="noopener noreferrer" {...props} />
            ),
            table: ({ node: _node, ...props }) => <MarkdownTable {...props} />,
            svg: ({ node: _node, ...props }) => <SvgPreview {...props} />,
            p: ({ node: _node, children, ...props }) => {
              const onlyChild = React.Children.toArray(children)[0];
              const isSvg =
                React.isValidElement<{
                  node?: { tagName?: string };
                }>(onlyChild) && onlyChild.props.node?.tagName === "svg";
              return React.Children.count(children) === 1 && isSvg ? (
                <>{children}</>
              ) : (
                <p {...props}>{children}</p>
              );
            },
            pre: ({ node: _node, children, ...props }) => {
              const onlyChild = React.Children.toArray(children)[0];
              const isSvgCode =
                React.isValidElement<{
                  node?: { tagName?: string };
                  className?: string;
                }>(onlyChild) &&
                onlyChild.props.node?.tagName === "code" &&
                /language-svg\b/i.test(onlyChild.props.className ?? "");
              return React.Children.count(children) === 1 && isSvgCode ? (
                <>{children}</>
              ) : (
                <pre {...props}>{children}</pre>
              );
            },
            code: ({ node, className, children, ...props }) => {
              if (!/language-svg\b/i.test(className ?? "")) {
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              }
              const start = node?.position?.start.offset;
              const end = node?.position?.end.offset;
              const isComplete =
                start === undefined || end === undefined
                  ? true
                  : content.slice(start, end).trimEnd().endsWith("```");
              return (
                <SvgPreview
                  source={String(children).replace(/\n$/, "")}
                  isComplete={isComplete}
                />
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
}

export default React.memo(MarkdownRenderer);
