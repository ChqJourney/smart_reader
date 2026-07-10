# SpecReader AI 功能改造实施计划（修正版）

> 基于 2026-07-10 需求沟通及后续反馈整理，已按反馈修正单实例跨平台处理、文件关联、继续生成语义、双栏状态隔离、identifier 与 AppData 路径关系等关键问题。

---

## 1. 已确认的关键决策

| 序号 | 需求点 | 确认结论 |
|------|--------|----------|
| 1 | 设置面板与目标语言 | 设置改为全局 Modal；LLM 配置与目标语言统一持久化到 AppData；目标语言默认“中文”，同时影响翻译、解读的 **user prompt 与 system prompt**。 |
| 2 | 最近文件 | 存到 AppData，最多 20 条；点击切换到已有 tab；支持一键清空。 |
| 3 | 双文件并排视图 | 三栏布局：PDF-A \| PDF-B \| AI 面板；入口为拖拽未激活 tab 到内容区；退出后恢复单 PDF + AI 面板。 |
| 4 | AI 会话流式中断 | LLM 流式输出时，AI 面板输入区的发送按钮变为**中止按钮**；点击后停止流式生成，**保留已输出内容**；中止后按钮恢复为发送按钮。**不需要“继续生成”功能。** |
| 5 | identifier / AppData 路径 | identifier 保持 `photonee`；最终 Windows 路径为 `AppData/Roaming/photonee/SpecReader/annotations`；去掉多余的 `Photonee` 层；不做旧数据迁移。 |

---

## 2. 待最终确认项

### 2.1 接受 identifier 非规范的风险

已确认 identifier 保持 `photonee`。Tauri 2.x 文档建议使用反向域名格式（如 `com.standardread.app`），`photonee` 作为单段字符串可能在 `tauri build` 时产生警告，极端情况下可能导致打包失败。

**结论**：本次按你要求保留 `photonee`，并在风险中记录该潜在告警。若后续 build 失败，再评估是否改为规范 identifier。

---

## 3. 建议实施顺序

### 第一批：基础 UI / 体验小改动
1. 设置面板改为 Modal + 目标语言设置
2. Tab header 去掉纵向滚动条
3. PDF 增加“适合容器宽度”按钮
4. 页码输入框横向/竖向居中
5. Top bar 改为 Recent Files 区域

### 第二批：数据与持久化
6. LLM 配置迁移到 AppData
7. Recent Files 持久化到 AppData
8. identifier 与 AppData 路径定型
9. 翻译浮层边界调整

### 第三批：架构大改动
10. AI 会话流式中断（发送按钮变中止按钮）
11. 双文件并排视图（三栏布局 + tab 拖拽）
12. 禁止多开 + PDF 文件关联

---

## 4. 详细实施方案

### 4.1 设置面板改为 Modal + 目标语言设置

**目标**：把 `AiChatPanel` 中内嵌的 LLM 设置表单提取为全局 Modal；新增“目标语言”字段；目标语言影响 system prompt 与 user prompt。

**涉及文件**：
- `src/components/SettingsModal.tsx`（新增）
- `src/components/AiChatPanel.tsx`
- `src/App.tsx`
- `src/services/llm.ts`
- `src/services/settings.ts`（新增，替代/扩展当前 `llm.ts` 中的 load/save）
- `src/App.css`

**关键改动**：
1. 新增类型 `AppSettings`：
   ```ts
   export interface AppSettings {
     llm: LlmConfig;        // baseUrl / apiKey / model
     targetLanguage: string; // 默认 "中文"
   }
   ```
2. 持久化改为后端 AppData：
   - 新增 Rust 命令 `load_settings` / `save_settings`。
   - 前端 `services/settings.ts` 封装调用，并提供一次性 localStorage 旧配置迁移。
3. `SettingsModal` 使用现有 `.modal-overlay` / `.modal-content` 样式，渲染在 `App.tsx` 根节点，避免被右侧面板裁剪。
4. `AiChatPanel` header 的齿轮按钮改为触发 `props.onOpenSettings()`，由 `App.tsx` 控制 Modal 显隐。
5. `services/llm.ts` 中：
   - `buildSystemPrompt(targetLang)`：根据目标语言生成 system prompt。
   - `buildSelectionPrompt(action, text, targetLang)` 增加目标语言参数。
   - `buildCustomInterpretPrompt(prompt, sources, targetLang)` 同样增加。
   - 翻译/解读 user prompt 模板均使用 `${targetLang}`。
6. `usePersistence.ts` 的 `runSessionStream` 使用 `buildSystemPrompt(targetLang)` 替代写死中文 system prompt。
7. 调用 prompt 构建的地方统一读取 `targetLanguage`。

---

### 4.2 Tab header 去掉纵向滚动条

**目标**：消除 tab 栏不必要的纵向滚动条。

**涉及文件**：`src/App.css`

**关键改动**：
```css
.tab-bar {
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.tab-bar::-webkit-scrollbar {
  display: none;
}
```
必要时将 `.tab-bar` 的 `align-items: flex-end` 调整为 `center` 或给 `.tab-item` 固定高度，避免内容高度不一致导致溢出。

---

### 4.3 PDF 增加“适合容器宽度”按钮

**目标**：一键把当前页宽度缩放到容器可用宽度。

**涉及文件**：
- `src/components/PdfViewer.tsx`
- `src/components/Icon.tsx`
- `src/App.css`

**关键改动**：
1. `Icon.tsx` 新增 `fit-width` 图标。
2. `PdfViewer.tsx` 新增 `fitToWidth()`：
   - 根据当前 `viewMode` 取 `singleContainerRef` 或 `continuousContainerRef`。
   - 用 `container.getBoundingClientRect()` 取实际可用宽度，并按实际 CSS padding 扣除（single 模式左右 padding 24px；continuous 模式左右 0 但内容区仍居中，建议取容器宽度扣除 48px 安全边距）。
   - 计算 `newScale = (availableWidth) / pageViewport.width`，`setScale(Math.max(0.5, newScale))`。
3. 在工具栏缩放按钮与缩放百分比之间增加按钮，tooltip “适应宽度”。

---

### 4.4 页码输入框横向/竖向居中

**目标**：当前页码输入框在框内水平和垂直都居中。

**涉及文件**：`src/App.css`

**关键改动**：
```css
.pdf-controls .page-info {
  display: inline-flex;
  align-items: center;
}
.pdf-controls .page-input {
  text-align: center;
  height: 24px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
```

---

### 4.5 Top bar 改为 Recent Files 区域

**目标**：移除顶部 “SpecReader AI” 标题，改为占据 60% 宽度的最近文件卡片区，支持横向滚动、清空、点击切换 tab。

**涉及文件**：
- `src/components/RecentFilesBar.tsx`（新增）
- `src/hooks/useRecentFiles.ts`（新增）
- `src/App.tsx`
- `src/App.css`

**关键改动**：
1. 新增 `useRecentFiles` hook：
   - 维护 `RecentFile[] = { path, fileName, openedAt }`。
   - 提供 `addRecentFile(path, fileName)`、`clearRecentFiles()`。
   - 持久化通过后端命令 `load_recent_files` / `save_recent_files` 写入 AppData。
2. 新增 `RecentFilesBar` 组件：
   - 渲染横向卡片列表；
   - 点击卡片：若路径已打开则切换 tab，否则打开新 tab；
   - 提供“清空”按钮或右键菜单。
3. `App.tsx` header 布局改为：
   ```tsx
   <header className="app-header">
     <RecentFilesBar files={recentFiles} onOpen={...} onClear={...} />
     <button className="open-pdf-btn">Open PDF</button>
   </header>
   ```
4. CSS：
   ```css
   .recent-files-container {
     width: 60%;
     flex-shrink: 0;
     display: flex;
     align-items: center;
     gap: 8px;
     overflow-x: auto;
     overflow-y: hidden;
     scrollbar-width: none;
     -ms-overflow-style: none;
   }
   .recent-files-container::-webkit-scrollbar { display: none; }
   .recent-file-card { /* card 样式 */ }
   ```

---

### 4.6 LLM 配置与 Recent Files 迁移到 AppData

**目标**：把原本存在 `localStorage` 的 LLM 配置和即将新增的 Recent Files 都持久化到后端 AppData。

**涉及文件**：
- `src-tauri/src/lib.rs`
- `src/services/settings.ts`
- `src/hooks/useRecentFiles.ts`
- `src/services/llm.ts`

**关键改动**：
1. Rust 端新增命令：
   - `load_settings() -> Result<AppSettings, String>`
   - `save_settings(settings: AppSettings) -> Result<(), String>`
   - `load_recent_files() -> Result<Vec<RecentFile>, String>`
   - `save_recent_files(files: Vec<RecentFile>) -> Result<(), String>`
2. 数据文件位置：
   - `settings.json`
   - `recent_files.json`
   - 均放在 `${app_data_dir}/SpecReader/` 下（与 `annotations` 目录同级）。
3. 前端首次加载时：
   - 若后端没有 settings，尝试从 `localStorage` 的 `standardread-llm-config` 读取并迁移，随后删除旧 key。
4. 同步移除 `services/llm.ts` 中直接读写 `localStorage` 的逻辑，改为通过 `services/settings.ts`。

---

### 4.7 identifier 与 AppData 路径定型

**目标**：identifier 保持 `photonee`，并去掉 `Photonee` 多余目录层。

**涉及文件**：
- `src-tauri/tauri.conf.json`
- `src-tauri/src/lib.rs`

**关键改动**：
1. `tauri.conf.json`：
   - `identifier` 保持 `photonee`。
   - 同步在 `bundle` 中增加 `fileAssociations` 注册 `.pdf`（为 4.12 文件关联做准备）。
2. `src-tauri/src/lib.rs` 中 `app_data_dir`：
   - 从 `base.join("Photonee").join("SpecReader")` 简化为 `base.join("SpecReader")`。
   - 最终 Windows 路径：`AppData/Roaming/photonee/SpecReader/annotations`。
3. 不做旧 AppData 数据迁移；老用户升级后历史批注和会话丢失，需在 release note 中说明。
4. 移除或停用 `usePersistence.ts` 中从 legacy `localStorage` 迁移 session 到 AppData 的逻辑，避免新路径下产生不一致状态。
5. 更新 `src-tauri/src/lib.rs` 单元测试，路径断言同步调整。

---

### 4.8 翻译浮层边界调整

**目标**：翻译浮层渲染时保证不超出所在 PDF 页面边界；若下方空间不足则自动显示在标记上方。

**涉及文件**：
- `src/components/TranslatePopup.tsx`
- `src/App.css`

**关键改动**：
1. 在 `TranslatePopup` 中通过 `popupRef.current.closest('.pdf-page-wrapper')` 获取所在页面容器（比 `offsetParent` 更可靠）。
2. 使用 `useLayoutEffect` 测量 popup 实际宽高与 wrapper 宽高，计算 `displayLeft / displayTop`：
   - 水平限制在 `[0, wrapperWidth - popupWidth]`；
   - 垂直优先显示在标记下方，若下方超出页面则翻转显示在标记上方。
3. 渲染时使用测量后的 `displayLeft / displayTop` 覆盖基于 annotation position 的默认位置。
4. 拖拽结束时对 `annotation.position` 做一次边界钳制并持久化。

---

### 4.9 AI 会话流式中断（发送按钮变中止按钮）

**目标**：LLM 流式输出时，AI 面板输入区的发送按钮变为中止按钮；点击后停止流式生成并保留已输出内容；中止后按钮恢复为发送按钮。不需要“继续生成”。

**涉及文件**：
- `src/hooks/usePersistence.ts`
- `src/components/AiChatPanel.tsx`
- `src/App.css`

**关键改动**：
1. `usePersistence.ts`：
   - 已有 `abortControllersRef` 按 `messageId` 保存 `AbortController`。
   - 新增 `interruptSession(sessionId)`：
     - 查找 `session.streamingMessageId`，abort 对应 controller；
     - 更新 session `isStreaming: false`；
     - 保留已生成的 message content。
   - `runSessionStream` 保持现有逻辑（被 abort 后自然退出，不再继续追加）。
2. `AiChatPanel.tsx`：
   - `FollowUpInput` 组件增加 `isStreaming` 状态感知：
     - 当 `session.isStreaming` 为 true 时，按钮文案从“发送”变为“中止”，点击调用 `onInterrupt(session.id)`；
     - 非 streaming 时恢复为“发送”，点击发送用户输入。
   - 为避免误操作，streaming 状态下输入框仍可编辑或禁用（按产品偏好决定；建议禁用，避免用户在中途修改问题）。
3. CSS：
   - 中止按钮使用危险色（如 `#c42b1c`），与发送按钮区分。

---

### 4.10 双文件并排视图（三栏布局 + tab 拖拽）

**目标**：实现 PDF-A \| PDF-B \| AI 三栏；通过拖拽未激活 tab 到内容区进入并排；退出后恢复单 PDF + AI。

**涉及文件**：
- `src/hooks/useTabs.ts`
- `src/App.tsx`
- `src/components/PdfViewer.tsx`（复用，必要时 minor 调整）
- `src/App.css`

**关键改动**：
1. `useTabs.ts`：
   - 增加状态 `splitMode: boolean` 和 `secondaryTabId: string | null`。
   - 增加 `enterSplit(secondaryTabId)`、`exitSplit()`。
   - **修改 `handleViewerStateChange` 签名**：`(tabId: string, state: PdfViewerState) => void`，内部按传入的 `tabId` 落盘，不再写死 `activeTabId`。
2. `App.tsx`：
   - 维护 `primaryViewerRef` 和 `secondaryViewerRef`（或 ref map），`gotoTabPage` 根据 tabId 选择对应 ref 调用 `goToPage`。
   - 正常模式：左 PDF（activeTab）+ 右 AI。
   - 并排模式：左 PDF（activeTab）+ 中 PDF（secondaryTab）+ 右 AI；三个面板之间均使用可拖拽分隔条。
   - 给两个 `PdfViewer` 分别传入 curried state callback：
     ```tsx
     onStateChange={(state) => tabs.handleViewerStateChange(primaryTab.id, state)}
     onStateChange={(state) => tabs.handleViewerStateChange(secondaryTab.id, state)}
     ```
3. tab 拖拽入口：
   - 给 `.tab-item` 添加 `draggable` 和 `onDragStart`（携带 tabId）；
   - 给 `.pdf-panel` / `.pdf-canvas-container` 添加 `onDragOver` + `onDrop`；
   - 当非激活 tab 被 drop 到内容区时调用 `enterSplit(tabId)`。
4. 退出并排视图：
   - 在并排视图工具栏或 AI 面板顶部提供“退出并排”按钮；
   - 调用 `exitSplit()` 恢复单 PDF + AI 面板。
5. annotations / sessions 按各自 `fileHash` 过滤（现有逻辑已支持）。
6. CSS：
   - 新增 `.app-main.split` 三栏布局；
   - 新增 `.pdf-panel.secondary` 样式；
   - 三个面板之间均使用 `.panel-divider`。

---

### 4.11 禁止多开 + PDF 文件关联

**目标**：同一时刻只允许运行一个 SpecReader AI 进程；第二次启动或双击 PDF 时聚焦已有窗口并打开文件。

**涉及文件**：
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/lib.rs`
- `src/App.tsx`

**关键改动**：
1. `tauri.conf.json`：
   - 在 `bundle` 中注册 `fileAssociations`，示例：
     ```json
     "fileAssociations": [
       {
         "ext": ["pdf"],
         "name": "PDF Document",
         "role": "Viewer"
       }
     ]
     ```
2. Windows / Linux：使用 `tauri-plugin-single-instance`。
   - `Cargo.toml` 增加依赖（仅 Windows/Linux 启用）。
   - `src-tauri/src/lib.rs` 用 `#[cfg(any(target_os = "windows", target_os = "linux"))]` 包裹 plugin 注册：
     ```rust
     #[cfg(any(target_os = "windows", target_os = "linux"))]
     let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
         let _ = app.get_webview_window("main").map(|w| {
             let _ = w.set_focus();
             let _ = w.unminimize();
             w
         });
         // 取第一个非自身可执行文件参数
         if args.len() > 1 {
             let path = args[1].clone();
             let _ = app.emit("single-instance-open", path);
         }
     }));
     ```
3. macOS：
   - 不使用 `tauri-plugin-single-instance`（官方不支持）。
   - 在 `run()` 的 event loop 中监听 `RunEvent::Opened { urls }` / `RunEvent::Reopen`；当收到 PDF URL 时 emit `single-instance-open`。
   - macOS 通常不会启动第二个实例，Finder 会直接触发 `Opened` 事件给已运行实例。
4. `src/App.tsx`：
   - 在 mount 时 `listen("single-instance-open", (event) => handleOpenPdfByPath(event.payload))`。
   - 对路径做基础校验（存在、扩展名为 pdf）后再打开。
5. 打包后分别在三端验证：双击 PDF / 再次启动程序 / 命令行传参打开 PDF。

---

## 5. 测试要点

### 5.1 前端单元测试
- `services/llm.test.ts`：prompt 模板需增加 `targetLanguage` 参数断言，包括 system prompt。
- `services/settings.test.ts`（新增）：AppSettings 默认值、后端 invoke mock、localStorage 旧配置迁移。
- `hooks/usePersistence.test.ts`（新增）：
  - mock `streamChatCompletion`；
  - 验证 `interruptSession` 后 `isStreaming=false` 且 content 保留；
  - 验证 streaming 结束后 controller 被清理。
- `AiChatPanel.test.tsx`：设置入口改为触发外部回调；新增“发送变中止”按钮状态测试。
- `App.test.tsx`：Recent Files 渲染、双栏布局切换。

### 5.2 后端测试
- `src-tauri/src/lib.rs` 中：
  - `app_data_dir` 返回路径不再包含多余 `Photonee`。
  - `load_settings` / `save_settings` 往返测试。
  - `load_recent_files` / `save_recent_files` 往返测试。
  - annotations 路径测试同步更新。
  - 文件关联配置 JSON 结构正确性（可选）。

### 5.3 E2E 测试
- `app.spec.ts`：Recent Files 区域、设置 Modal。
- 新增/扩展双栏视图、适合宽度、翻译浮层边界的 E2E 用例。
- 单实例与文件关联需在打包后的安装包上手动验证，E2E 较难覆盖。

---

## 6. 风险与注意事项

1. **identifier 非规范**：`photonee` 作为单段 identifier 可能在 `tauri build` 时产生警告，极端情况下可能导致打包失败。若失败，需回退改为反向域名格式（如 `com.standardread.app`），届时 AppData 路径也会变化。
2. **macOS 单实例** 不能直接用 `tauri-plugin-single-instance`，必须单独通过 `RunEvent::Opened` 处理，跨平台实现复杂度高于预期。
3. **AppData 路径修复不做迁移**，老用户升级后会丢失历史批注和会话，需要在 release note 中明确说明。
4. **legacy localStorage session 迁移** 与新的 AppData 路径变更叠加可能导致不一致。建议在本批次直接移除该 legacy 迁移逻辑（它本是旧版本一次性升级桥接）。
5. **目标语言** 引入后，system prompt 与所有 user prompt 模板都要同步修改，避免漏改导致翻译/解读仍写死为中文。
6. **双文件并排视图** 会改变 `App.tsx` 的核心布局模型和 `useTabs` 状态结构，建议放在最后实现，并充分测试拖拽、状态同步、面板显隐。
7. **单实例与文件关联** 在开发模式（`npm run tauri-dev`）下行为可能与生产包不同，最终需要在 Windows / macOS 安装包上实测。
8. **双排 AI 记录合并**：当前已合并两个 PDF 的 session 与 stash 显示，但 PDF 页面上的 annotation marker 仍按主 PDF 过滤，如需完全分离两个 PDF 的标记，需给 `Annotation` 增加 `fileHash` 字段。

---

## 7. 实施完成说明

本批次 12 项改造已全部实现并跑通测试：

- 前端单元测试：`npm run test` 通过（17 files / 126 tests）。
- E2E 测试：`npm run test:e2e` 通过（10 tests）。
- 后端测试：`cd src-tauri && cargo test` 通过（16 tests）。
- 生产构建：`npm run build` 通过。

主要新增/修改文件：
- `src/components/SettingsModal.tsx` + `SettingsModal.test.tsx`
- `src/components/RecentFilesBar.tsx` + `RecentFilesBar.test.tsx`
- `src/services/settings.ts` + `settings.test.ts`
- `src/hooks/useRecentFiles.ts` + `useRecentFiles.test.ts`
- `src/hooks/useSplitView.ts` + `useSplitView.test.ts`
- `src/hooks/usePersistence.ts`（流式中断、双排合并显示）
- `src/components/PdfViewer.tsx`（适合宽度按钮）
- `src/components/TranslatePopup.tsx`（边界限制）
- `src/App.tsx` / `src/App.css`（顶部最近文件栏、双排布局、分隔条拖拽）
- `src-tauri/src/lib.rs` / `tauri.conf.json` / `Cargo.toml`（AppData 路径、settings/recent files 命令、单实例、文件关联、macOS `RunEvent::Opened`）
- `e2e/app.spec.ts` / `e2e/pdf-page-jump.spec.ts`（适配新版 UI）
- `AGENTS.md` / `docs/FEATURE_PLAN.md`（文档同步）
