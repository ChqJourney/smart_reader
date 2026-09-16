import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// react-markdown 依赖树中不带统一前缀的零散工具包（见 manualChunks）。
const MARKDOWN_MISC_VENDORS = new Set([
  "bail",
  "ccount",
  "comma-separated-tokens",
  "decode-named-character-reference",
  "devlop",
  "extend",
  "html-url-attributes",
  "html-void-elements",
  "inline-style-parser",
  "longest-streak",
  "markdown-table",
  "property-information",
  "space-separated-tokens",
  "stringify-entities",
  "trim-lines",
  "trough",
  "web-namespaces",
  "zwitch",
]);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1421,
    },
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 重型 vendor 依赖独立分包：pdfjs / markdown / pdf-lib 均只经懒加载
        // 边界触达（pdfjs 由 services/pdfjs.ts 动态 import，markdown 由
        // React.lazy 的 MarkdownRenderer 触达，pdf-lib 由懒加载的打印链
        // 触达），分包后随异步 chunk 按需加载并独立长缓存。
        // 其余 node_modules 全部进 vendor 兜底：manualChunks 只分大件时，
        // rollup 会把它们与入口共享的依赖（如 tslib）合进异步 chunk，导致
        // 入口静态 import 异步 chunk、首屏 preload 失效。
        manualChunks(id) {
          const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id);
          if (!match) return undefined;
          const pkg = match[1];
          if (pkg === "pdfjs-dist") return "pdfjs";
          // pdf-lib 的专用依赖（pako / tslib / @pdf-lib/* 仅打印链使用，
          // @tauri-apps/api 用的是自己 vendor 的 tslib 副本，不受影响）
          if (
            pkg === "pdf-lib" ||
            pkg === "pako" ||
            pkg === "tslib" ||
            pkg.startsWith("@pdf-lib/")
          ) {
            return "pdf-lib";
          }
          if (
            pkg === "react-markdown" ||
            pkg === "katex" ||
            pkg === "unified" ||
            pkg === "hastscript" ||
            pkg === "@ungap/structured-clone" ||
            pkg === "is-plain-obj" ||
            pkg === "escape-string-regexp" ||
            pkg.startsWith("remark-") ||
            pkg.startsWith("rehype-") ||
            pkg.startsWith("hast-") ||
            pkg.startsWith("mdast-") ||
            pkg.startsWith("micromark") ||
            pkg.startsWith("unist-") ||
            pkg.startsWith("vfile") ||
            pkg.startsWith("estree-util-") ||
            pkg.startsWith("character-entities") ||
            pkg.startsWith("style-to-") ||
            MARKDOWN_MISC_VENDORS.has(pkg)
          ) {
            return "markdown";
          }
          return "vendor";
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/test/**", "src/**/*.d.ts", "src/main.tsx"],
    },
  },
}));
