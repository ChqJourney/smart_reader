import ReactMarkdown from "react-markdown";
import React from "react";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { defaultSchema, type Schema } from "hast-util-sanitize";
import "katex/dist/katex.min.css";
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

export default function MarkdownRenderer({
  content,
  className = "",
}: MarkdownRendererProps) {
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
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
}
