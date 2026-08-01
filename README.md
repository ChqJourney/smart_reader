# SpecReader AI

**English** | [中文](./README.zh-CN.md)

A desktop AI assistant for testing & certification engineers, designed to reduce the cognitive load of reading, understanding, and applying technical standards in PDF form (IEC / ISO / EN / GB / UL / ASTM / IEEE).

👉 [Product demo page](https://chqjourney.github.io/smart_reader/) | [Download the latest release](https://github.com/ChqJourney/smart_reader/releases)

## Tech Stack

- **Desktop framework**: Tauri 2.0 (Rust backend + Web frontend)
- **Frontend**: React 18 + TypeScript 5.6 + Vite 6
- **PDF rendering**: pdfjs-dist 4.8
- **Markdown rendering**: react-markdown
- **AI integration**: OpenAI-compatible APIs, proxied through the Rust backend — API keys live in the system keychain and never enter the webview. Presets for DeepSeek / Kimi / Bailian / GLM / Volcengine / OpenRouter / OpenAI / custom endpoints (default: DeepSeek, model `deepseek-v4-flash`)

## Requirements

- Node.js >= 18
- Rust >= 1.77.2
- Tauri CLI (optional; `@tauri-apps/cli` is already a project dependency)

## Quick Start

```bash
# Install frontend dependencies
npm install

# Start the Vite dev server only (port 1420)
npm run dev

# Start the Tauri desktop app in dev mode
npm run tauri-dev

# Build the frontend production bundle to dist/
npm run build

# Build the full desktop installer
npm run tauri-build
```

## Testing

```bash
# Frontend unit / integration tests
npm run test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# E2E tests
npm run test:e2e

# E2E UI mode
npm run test:e2e:ui

# Run unit tests then E2E tests
npm run test:all

# TypeScript type check
npm run type-check

# ESLint
npm run lint

# Prettier format check
npm run format:check

# Backend Rust tests
cd src-tauri && cargo test
```

See [TESTING.md](./TESTING.md) for details.

## Project Structure

```
.
├── docs/                              # Product design docs (PRD / Agent Tools design)
├── src/                               # Frontend source
│   ├── App.tsx / App.css / main.tsx   # App shell, global styles, React entry
│   ├── components/                    # React components (30+, each with a matching .css)
│   │   ├── TitleBar.tsx               # Custom title bar (brand area, recent files, window controls)
│   │   ├── SetupWizard.tsx            # First-run setup wizard (pick platform → enter key → test connection)
│   │   ├── PdfViewer.tsx / PdfPage.tsx            # PDF rendering, selection, zoom, single/continuous modes
│   │   ├── PdfAnnotations.tsx / AnnotationMarker.tsx / *Popup.tsx  # Annotations & popups
│   │   ├── AiChatPanel.tsx            # Right panel (stash, interpretation history, follow-ups)
│   │   ├── SettingsModal.tsx / RecentFilesBar.tsx / CustomInterpretModal.tsx
│   │   └── MarkdownRenderer.tsx / ContextWidget.tsx / ThinkingIndicator.tsx / Icon.tsx etc.
│   ├── hooks/                         # Reusable state logic (18 hooks)
│   │   └── useTabs / usePersistence / useRecentFiles / useSplitView /
│   │       usePdfDocument / useViewportManager / useZoomAnchor / useSearchDomain /
│   │       useScrollPageSync / useTabRestore / useWordLookup / useDictionaryStatus /
│   │       useDrag / useClampedPopupPosition / useStreaming / useModal / useRightPanelLayout
│   ├── services/                      # Business logic & Tauri command wrappers
│   │   ├── llm.ts / settings.ts / updater.ts / dialog.ts / logs.ts / selection.ts
│   │   ├── annotations.ts / sessions.ts / stash.ts / recentFiles.ts / dictionary.ts
│   │   └── pdfTools.ts / pdfToolsRegistry.ts      # Agent Tools execution layer & authorization registry
│   ├── data/platformPresets.ts        # LLM platform presets
│   ├── types/llm.ts                   # LLM-related types
│   ├── i18n/ + locales/               # i18next setup (zh-CN / en)
│   └── test/                          # Test utilities & global mocks
├── src-tauri/                         # Tauri Rust backend
│   ├── src/
│   │   ├── lib.rs                     # Tauri commands
│   │   ├── llm_proxy.rs               # LLM request proxy (SSE forwarding, tool-call accumulation, error classification)
│   │   ├── secure_storage.rs          # System keychain wrapper for API keys
│   │   └── dictionary.rs / paths.rs / main.rs
│   ├── capabilities/                  # Tauri permission config
│   ├── Cargo.toml
│   └── tauri.conf.json
├── e2e/                               # Playwright E2E tests (6 specs + fixtures)
├── scripts/                           # Helper scripts (version sync, release, sample PDF generation)
├── package.json / vite.config.ts / playwright.config.ts / tsconfig.json
└── eslint.config.js
```

## Current Features (lightweight edition)

- Open multiple PDFs in tabs (no fixed limit; memory-budget-driven hibernation keeps the app light), with side-by-side split view for comparing two PDFs.
- Custom title bar: frameless window with brand area, recent files, open-PDF / settings, and window controls.
- First-run setup wizard: pick a platform → enter API key → test the connection (a real LLM call); auto-opens when no platform is configured, re-runnable from settings.
- Local PDF rendering, text selection, zoom, page jumping, single-page / continuous scroll modes.
- Full-text search (Ctrl / Cmd + F, phrase matching across text items, per-page highlights) and outline / TOC navigation.
- Floating toolbar on text selection: copy, comment, stash, interpret, translate; comments become draggable purple markers (debounced persistence).
- Translations appear as draggable / hideable / deletable popup annotations.
- Interpretations appear as blue markers, with clickable history records in the right panel and multi-turn follow-up support.
- Custom interpretation: send multiple stashed excerpts to the LLM in one request.
- **Agent Tools for interpretation / custom interpretation / follow-ups**: the LLM can consult the currently open PDFs via Function Calling (`list_open_pdfs` / `read_pdf_page` / `search_in_pdf`) to verify clause references and cross-page content; round limit defaults to 20 with graceful fallback.
- LLM requests are proxied through the Rust backend: API keys are stored per-platform in the system keychain and never exposed to the webview.
- Annotations and interpretation history persist locally in AppData, keyed by the PDF file's SHA-256 hash.
- Recent files panel: pinning, search, grayed-out missing files, last-read page restore, open in split view.
- Hover over an English word to look it up in a local ECDICT dictionary (toggleable; one-time offline dictionary download).
- Context usage bar (ContextWidget), thinking-process display (ThinkingIndicator), Markdown rendering with KaTeX math.
- Auto-update: checks 3 seconds after launch; manual check available in the About page.
- i18n framework in place (i18next, zh-CN / en locales; UI currently fixed to Chinese, English is pre-wired).

Deliberately not implemented yet (planned for later versions):

- Clause indexing and reference tracking.
- Glossary and test-checklist generation.
- Table screenshots + multimodal reading.
- License activation checks.

## Privacy

- PDF content never leaves your machine; files are read and rendered locally only.
- Only the text excerpts you explicitly select are sent to the LLM API you configured; enabling smart document lookup additionally sends relevant excerpts from the standard.
- API keys are stored in the system keychain via the Rust `keyring` crate; `settings.json` keeps only an empty placeholder. Saving fails with an explicit error when the keychain is unavailable — no plaintext fallback.

## License

Source code is open under [GPL-3.0-or-later](./LICENSE): you may freely use, modify, and redistribute it, but derivative works must be published under the same terms.

Official release builds are free to use. The GPL does not allow incorporating this software into proprietary (closed-source) commercial products; for closed-source commercial use — including revenue-sharing arrangements — please reach out via [GitHub Issues](https://github.com/ChqJourney/smart_reader/issues) to negotiate a separate commercial license.
