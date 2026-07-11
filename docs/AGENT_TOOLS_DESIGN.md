# SpecReader AI - Agent Tools 设计方案

> 目标：用“轻量 PDF 解析 + LLM Function Calling Tools”替代传统 RAG，实现标准文档的智能阅读理解  
> 适用：文本型 PDF，强章节结构，多语言，答案需精确溯源  
> 状态：本文为完整目标架构。当前「超轻量版」暂不实现 Clause 索引、Tools 调用、术语表、测试清单等功能，仅保留 PDF 阅读 + 翻译 + 解读。

---

## 1. 设计目标

本方案的核心设计决策：

1. **不做 Embedding，不做向量索引，不做 RAG 检索。**
2. **PDF 只做轻量解析**：提取为 Markdown/文本，清洗格式化噪声，识别 Clause 编号建立位置索引。
3. **内容查找交给 LLM**：通过 Function Calling Tools，让 LLM 按需查询文档。
4. **表格不解析为文本**：保留表格标题，精确读取时通过截图调用多模态 LLM。

这样做的好处：

- 技术栈极简，开发周期短。
- 不需要本地 Embedding 模型或向量库。
- LLM 可以基于完整上下文做更灵活的推理。
- 对长文档友好，不受上下文窗口硬性限制。

代价：

- 单次复杂问题可能需要多次 Tool 调用。
- 对 LLM 的 Function Calling 能力有一定要求。
- 需要精心设计 Tools，避免无效调用。

---

## 2. 整体架构

```
用户打开 PDF
    │
    ▼
[本地 PDF 渲染层]  ← 用户可直接阅读、选区
    │
    ▼
[轻量解析层] PDF → Markdown/文本
    │
    ├── 清洗页眉/页脚/页码/重复表头
    ├── 保留段落、标题、列表
    ├── 表格仅保留标题（如 "Table 1 - Test levels"）
    └── 生成 ClauseIndex（章节编号 → 文本位置）
    │
    ▼
[本地存储层] SQLite：Document + ClauseIndex + Term + TestItem
    │
    ▼
用户提问 / 选中即问
    │
    ▼
[LLM Agent 层] Function Calling Tools
    │
    ├── search_document(keywords)
    ├── get_clause(clause_number)
    ├── get_page(page_number)
    ├── get_context(position)
    ├── list_clauses()
    ├── find_definition(term)
    └── extract_table(page, bbox) [多模态]
    │
    ▼
[答案生成] 带引用溯源的流式回复
```

### 2.1 超轻量版（当前阶段）架构

```
用户打开 PDF（支持多 Tab，最多 10 个）
    │
    ▼
[本地 PDF 渲染层]  ← 单页/连续滚动阅读、文本选区、缩放、页码跳转
    │
    ├── 连续滚动模式：基于 IntersectionObserver 懒加载渲染页面
    │
    ▼
用户点击「加入暂存」「翻译」或「解读」
    │
    ├── 加入暂存 → 在 PDF 页面上生成橙色暂存标记，文本进入右侧面板暂存区
    │
    ├── 翻译 → 在 PDF 页面上生成可拖动、可隐藏、可删除的浮层批注
    │            流式生成翻译结果，位置按 PDF hash 持久化到 AppData
    │
    └── 解读 → 在 PDF 页面上生成蓝色标记，右侧面板显示缩略条目
                 点击条目跳转并高亮对应标记，内容流式生成
    │
    ▼
自定义解读（基于暂存区）
    │
    ├── 用户在暂存区选择多个片段并输入解读要求
    └── 系统把片段合并为 Prompt，创建新的解读会话并流式输出
    │
    ▼
会话追问
    │
    └── 在已展开的解读记录下继续提问，追加 user/assistant 消息并流式输出
    │
    ▼
[LLM 直接调用] 携带选中文本 + Prompt 生成回答
    │
    ▼
[答案生成] 流式回复（Markdown 渲染）
```

超轻量版说明：

- 不做 PDF 文本提取与 Clause 索引。
- 不调用 Function Calling Tools。
- AI 仅基于用户当前选中的文本片段或暂存区片段进行翻译、解读或自定义解读。
- 翻译结果以浮层批注形式锚定在 PDF 页面上，可拖动、隐藏、删除，并按 PDF 文件 hash 持久化到 AppData。
- 解读结果以条目形式展示在右侧面板，默认折叠，点击条目可跳转到 PDF 对应位置并高亮标记；支持多轮追问。
- 选中文本可「加入暂存」，暂存片段在右侧面板汇聚，可编辑、删除、清空、跳转回原文，也可一次性发起自定义解读。
- AI 输出支持 Markdown 渲染。
- 选区工具条点击外部自动消失。
- PDF 阅读器支持单页与连续滚动两种模式，连续模式下用鼠标滚轮或方向键浏览。
- 主界面支持多 PDF Tab，最多同时打开 10 个文件。
- 主界面左右分栏宽度可拖拽调节，左右面板均可隐藏/显示。
- 后续按本文完整架构逐步补齐。

---

## 3. PDF 轻量解析流程

### 3.1 文本提取

使用 Rust 端的 PDF 解析库（如 `pdf-extract`、`lopdf` 或前端 PDF.js）提取文本，保留：

> 注：当前「超轻量版」仅使用前端 `pdfjs-dist` 进行本地渲染与文本选区，尚未实现 PDF 文本提取与后续解析流程。

- 段落文本
- 标题行
- 列表项
- 表格位置信息（用于后续截图）

### 3.2 清洗规则

| 清洗目标  | 策略                                 |
| --------- | ------------------------------------ |
| 页眉/页脚 | 识别重复出现的小字号文本，按位置过滤 |
| 页码      | 识别页边距处的独立数字               |
| 重复表头  | 表格跨页时重复的表头行去重           |
| 换行符    | 段落内软换行合并为连续文本           |
| 多余空格  | 多个空格合并为一个                   |

### 3.3 Markdown 输出示例

输入 PDF 页面：

```
IEC 61000-4-2
© IEC 2020 – 23 –
4.2 Test conditions
The EUT shall be tested under the following environmental conditions:
• Temperature: 15 °C to 35 °C
• Relative humidity: 25 % to 75 %
Table 1 - Test levels
[表格内容不解析]
```

清洗后 Markdown：

```markdown
## 4.2 Test conditions

The EUT shall be tested under the following environmental conditions:

- Temperature: 15 °C to 35 °C
- Relative humidity: 25 % to 75 %

**Table 1 - Test levels**
```

### 3.4 表格位置记录

虽然不解析表格内容，但需要记录表格在 PDF 页面中的位置（bounding box），用于后续截图：

```typescript
interface TableInfo {
  page: number;
  title: string; // e.g. "Table 1 - Test levels"
  bbox: { x: number; y: number; width: number; height: number };
}
```

---

## 4. Clause 索引生成

> 本章节为完整目标架构。当前「超轻量版」暂不实现 Clause 索引，PDF 仅用于本地渲染和文本选区。

### 4.1 常见编号格式

用正则表达式识别以下 Clause 编号格式：

```regex
^\d+\s+                    # 1 Scope
^\d+\.\d+\s+               # 4.2 Test conditions
^\d+\.\d+\.\d+\s+          # 4.2.1 Environmental conditions
^Annex\s+[A-Z]\b           # Annex A
^Appendix\s+[A-Z]\b        # Appendix A
```

### 4.2 初始索引流程

1. 按行扫描清洗后的 Markdown 文本。
2. 用正则匹配可能的标题行。
3. 记录每个匹配项的编号、标题、字符位置、页码。
4. 推断层级关系：根据编号中的点数确定 level。
5. 写入 `ClauseIndex` 表。

### 4.3 LLM 复核（手动触发）

因 LLM 复核会消耗大量 Token，**默认不自动执行**，需要用户手动触发。

用户在 PDF 解析完成后，可点击“复核 Clause 索引”，系统会：

1. 把整份文档的 Markdown 和初始索引传给 LLM。
2. LLM 检查是否有遗漏、错误编号、层级关系错误。
3. 返回修正后的 ClauseIndex。
4. 用户确认后更新索引。

**Prompt 示例**：

```text
You are a technical document structure analyzer.
Review the following document text and its initial clause index.
Identify any missing clauses, incorrect numbering, or wrong hierarchy.
Return the corrected index as a JSON array.

Document text:
{markdown_text}

Initial index:
{initial_index}
```

### 4.4 ClauseIndex 数据结构

```typescript
interface ClauseIndex {
  id: string;
  document_id: string;
  clause_number: string; // e.g. "4.2.1"
  clause_title: string; // e.g. "Environmental conditions"
  level: number; // 1, 2, 3, ...
  parent_clause: string; // e.g. "4.2"
  page_start: number;
  page_end: number;
  start_position: number; // 在 raw_text 中的字符位置
  end_position: number;
  is_verified: boolean; // 是否经过 LLM 复核
}
```

---

## 5. LLM Tools 定义

> 本章节为完整目标架构。当前「超轻量版」不启用 Function Calling Tools，AI 直接基于用户选中文本进行翻译/解读。所有 Tools 在后续完整版中启用。

所有 Tools 通过 OpenAI 兼容的 Function Calling 接口暴露给 LLM。

### 5.1 search_document

**用途**：全文关键词搜索，返回最相关的若干文本片段。

```json
{
  "name": "search_document",
  "description": "Search the standard document for relevant text passages by keywords. Returns text snippets with clause numbers and page numbers.",
  "parameters": {
    "type": "object",
    "properties": {
      "keywords": {
        "type": "string",
        "description": "Keywords to search for, space separated. Use both English and translated terms if possible."
      },
      "top_k": {
        "type": "integer",
        "description": "Number of passages to return, default 5",
        "default": 5
      }
    },
    "required": ["keywords"]
  }
}
```

**返回示例**：

```json
[
  {
    "clause_number": "4.2.1",
    "page": 23,
    "snippet": "The EUT shall be tested under the following environmental conditions...",
    "start_position": 15200,
    "end_position": 15600
  }
]
```

### 5.2 get_clause

**用途**：获取指定 Clause 的完整文本。

```json
{
  "name": "get_clause",
  "description": "Get the full text of a specific clause or sub-clause by its number.",
  "parameters": {
    "type": "object",
    "properties": {
      "clause_number": {
        "type": "string",
        "description": "Clause number, e.g. '4.2.1' or 'Annex A'"
      },
      "include_sub_clauses": {
        "type": "boolean",
        "description": "Whether to include all sub-clauses under this clause",
        "default": false
      }
    },
    "required": ["clause_number"]
  }
}
```

### 5.3 get_page

**用途**：获取指定页的内容。

```json
{
  "name": "get_page",
  "description": "Get the text content of a specific page.",
  "parameters": {
    "type": "object",
    "properties": {
      "page_number": {
        "type": "integer",
        "description": "Page number, 1-based"
      }
    },
    "required": ["page_number"]
  }
}
```

### 5.4 get_context

**用途**：获取 raw_text 中某个位置前后半径范围内的文本。

```json
{
  "name": "get_context",
  "description": "Get text around a specific character position in the document.",
  "parameters": {
    "type": "object",
    "properties": {
      "position": {
        "type": "integer",
        "description": "Character position in raw_text"
      },
      "radius": {
        "type": "integer",
        "description": "Number of characters before and after the position",
        "default": 1500
      }
    },
    "required": ["position"]
  }
}
```

### 5.5 list_clauses

**用途**：列出文档的章节大纲。

```json
{
  "name": "list_clauses",
  "description": "List the document structure/outline up to a certain depth.",
  "parameters": {
    "type": "object",
    "properties": {
      "max_depth": {
        "type": "integer",
        "description": "Maximum clause level to include, default 2",
        "default": 2
      }
    }
  }
}
```

### 5.6 find_definition

**用途**：查找术语或缩写的定义。

```json
{
  "name": "find_definition",
  "description": "Find the definition of a term or abbreviation in the document, especially in the 'Terms and definitions' clause.",
  "parameters": {
    "type": "object",
    "properties": {
      "term": {
        "type": "string",
        "description": "Term or abbreviation to look up, e.g. 'ESD' or 'electrostatic discharge'"
      }
    },
    "required": ["term"]
  }
}
```

### 5.7 extract_table

**用途**：当问题涉及表格精确数值时，截取表格图片并用多模态 LLM 读取。**需要用户已配置 vision model，否则该 Tool 不可用。**

```json
{
  "name": "extract_table",
  "description": "Extract precise information from a table by taking a screenshot and using a vision-capable LLM. Use only when the user asks for exact numerical values from a table.",
  "parameters": {
    "type": "object",
    "properties": {
      "table_title": {
        "type": "string",
        "description": "Title of the table, e.g. 'Table 1 - Test levels'"
      },
      "page_number": {
        "type": "integer",
        "description": "Page number where the table is located"
      }
    },
    "required": ["table_title", "page_number"]
  }
}
```

**实现说明**：

- 后端根据 `table_title` 查找本地记录的 `TableInfo`。
- 使用 PDF 渲染库截取表格区域的图片。
- 调用用户配置的多模态模型（如 gpt-4o、qwen-vl、glm-4v）。
- 若用户未配置多模态模型，该 Tool 对 LLM 不可见，前端对应功能灰色禁用。
- 返回结构化结果。

---

## 6. Agent 调用流程

> 本章节为完整目标架构。当前「超轻量版」的调用流程见 2.1 节：用户选中文本后直接调用 LLM，不经过 Tools。

### 6.1 标准问答流程

```
用户提问
    │
    ▼
System Prompt + 可用 Tools 发送给 LLM
    │
    ▼
LLM 第一次响应：决定调用哪些 Tools
    │
    ▼
App 执行 Tools，获取结果
    │
    ▼
把 Tool 结果再次发送给 LLM
    │
    ▼
LLM 生成最终答案（流式输出）
```

### 6.2 示例：用户问 ESD 测试等级

**用户**：ESD 测试的电压等级是多少？

**LLM 第一次调用**：

```json
[
  { "name": "find_definition", "arguments": { "term": "ESD" } },
  {
    "name": "search_document",
    "arguments": { "keywords": "ESD test level voltage discharge", "top_k": 5 }
  }
]
```

**Tool 结果**：

- `find_definition`：ESD = Electrostatic Discharge, Clause 3.2
- `search_document`：找到 Clause 5.3 提到 "Table 1 - Test levels"

**LLM 第二次调用**：

```json
[
  {
    "name": "get_clause",
    "arguments": { "clause_number": "5.3", "include_sub_clauses": true }
  }
]
```

**Tool 结果**：

- Clause 5.3 文本包含 "Table 1 - Test levels" 标题，但表格内容未解析。

**LLM 第三次调用**（判断需要精确值）：

```json
[
  {
    "name": "extract_table",
    "arguments": { "table_title": "Table 1 - Test levels", "page_number": 42 }
  }
]
```

**最终答案**：

> ESD（静电放电）测试的电压等级如 Table 1 所示（Clause 5.3, Page 42）：
>
> - 接触放电：Level 1 ±2 kV，Level 2 ±4 kV
> - 空气放电：Level 1 ±2 kV，Level 2 ±4 kV

### 6.3 防止无限循环

- 设置最大 Tool 调用轮数（如 5 轮）。
- 同一 Tool 参数去重，避免重复调用。
- 超过轮数仍未获得答案时，提示用户问题过于复杂。

---

## 7. Prompt 设计

### 7.1 System Prompt

```text
You are an expert assistant for testing and certification engineers reading standard documents (IEC, ISO, EN, GB, UL, etc.).

Your job is to help the user understand, translate, and apply the standard document.

Rules:
1. ALWAYS base your answers on the document content retrieved via Tools.
2. NEVER make up clause numbers, page numbers, or requirements.
3. Cite every fact with "(Clause X.Y.Z, Page N)".
4. If the answer requires exact values from a table, use the extract_table tool to read it precisely.
5. Keep technical terms in the original language and provide translations in parentheses.
6. Answer in the user's target language.

Source language of the document: {source_lang}
Target language for answers: {target_lang}
```

### 7.2 选中解读 Prompt

选中解读直接把选中文本传给 LLM，不需要 Tools：

```text
Explain the following standard clause/excerpt in plain language for a testing engineer.
Include: what it requires, why it matters, how to test it, and any related clauses.

Excerpt:
{text}

Clause: {clause_number}
Page: {page_number}
```

### 7.3 测试清单生成 Prompt

```text
Review the following standard document excerpts and extract all test requirements.
For each requirement, create a test item with these fields:
- Test item name
- Standard clause
- Test condition
- Limit/criteria
- Acceptance criterion
- Required equipment (if mentioned)
- Notes

Excerpts:
{excerpts}

Return as a JSON array.
```

---

### 7.4 超轻量版 Prompt

超轻量版直接把选中文本传给 LLM，不需要 Tools。当前保留「翻译」「解读」和「自定义解读」三个动作：

**翻译 Prompt**（固定输出中文）：

```text
请将以下标准文档内容翻译成中文，保持专业术语准确，并在首次出现关键术语时保留原文：

{text}
```

**解读 Prompt**（固定输出中文）：

```text
请用通俗易懂的中文解读以下标准条款/段落，说明其要求、意义、与测试工作的关系，并指出可能相关的其他条款：

{text}
```

**自定义解读 Prompt**：

```text
{用户输入的 prompt}

片段 1（{fileName} 第 {page} 页）：
{text}

片段 2（{fileName} 第 {page} 页）：
{text}

...
```

自定义解读由用户在弹窗中输入解读要求，系统将暂存片段按上述格式拼接后发送给 LLM。

**System Prompt**（解读会话，包括选中解读与自定义解读）：

```text
你是一位检测认证行业标准文档阅读助手，擅长把复杂的英文标准条款解释得清晰易懂。请基于用户提供的文档片段回答，不要编造片段中未提及的条款或页码。
```

---

## 8. 多语言处理

### 8.1 语言配置

- `source_lang`：文档源语言（auto 检测）。
- `target_lang`：用户希望 AI 回答的语言。
- 支持：中/英/德/葡/西/日。

### 8.2 跨语言查询策略

当用户用中文问英文文档时：

1. 搜索关键词同时包含中文和英文术语（通过术语表扩展）。
2. LLM 理解中文问题后，用英文关键词调用 `search_document`。
3. 答案用中文输出。

**示例**：

- 用户问：“静电放电要求”
- 系统扩展关键词："静电放电 ESD electrostatic discharge"
- `search_document("ESD electrostatic discharge requirement")`

---

## 9. 实现代码结构

### 9.1 Rust 后端模块（完整目标架构）

```
src-tauri/src/
├── main.rs
├── pdf/
│   ├── parser.rs          # PDF 文本提取
│   ├── cleaner.rs         # 页眉页脚清洗
│   ├── table_detector.rs  # 表格位置检测
│   └── clause_indexer.rs  # Clause 索引生成与复核
├── agent/
│   ├── tools.rs           # Tool 定义与实现
│   ├── executor.rs        # Tool 执行器
│   └── prompts.rs         # Prompt 模板
├── llm/
│   ├── client.rs          # OpenAI 兼容客户端
│   └── function_call.rs   # Function Calling 解析
├── vision/
│   └── screenshot.rs      # PDF 表格截图 + 多模态调用
└── store/
    └── db.rs              # SQLite 数据访问
```

### 9.2 超轻量版代码结构

当前阶段后端保留 PDF 文件读取、hash 计算、批注 JSON 文件读写，以及解读会话 JSON 文件读写：

```
src-tauri/src/
├── main.rs
└── lib.rs                 # 注册 read_pdf_bytes、open_path、get_pdf_hash、load_pdf_data、save_pdf_data、load_session、save_session、delete_session 等命令
```

前端保留：

- `App.tsx`：多 Tab 管理、双栏布局、拖拽调节宽度、面板显隐状态、annotations / sessions / stashes 状态管理，legacy localStorage 会话迁移。
- `PdfViewer.tsx`：本地渲染、单页/连续滚动模式、键盘导航、文本选区、annotation 渲染。
- `SelectionToolbar.tsx`：「加入暂存」「解读」「翻译」三个按钮，点击外部自动消失。
- `AnnotationMarker.tsx`：页面内可拖动的翻译/解读/暂存标记。
- `TranslatePopup.tsx`：附着在 PDF 页面上的翻译浮层，可拖动、隐藏、删除，流式显示翻译。
- `ExplainPopup.tsx`：解读标记点击后弹出的详情浮层。
- `StashInterpretedPopup.tsx`：已解读暂存标记点击后弹出的浮层，支持查看解读会话或删除。
- `PdfAnnotations.tsx`：按页渲染 markers 和各类 popup。
- `AiChatPanel.tsx`：LLM 配置、暂存区、解读条目列表（默认折叠，点击跳转，支持追问）。
- `CustomInterpretModal.tsx`：自定义解读弹窗，输入 Prompt 后基于暂存区片段发起解读。
- `Icon.tsx`：SVG 图标集合。
- `services/llm.ts`：OpenAI 兼容流式请求、LLM 配置读写、Prompt 模板。
- `services/annotations.ts`：Annotation / PdfData 类型定义与 Tauri 命令封装。
- `services/sessions.ts`：InterpretationSession / InterpretationMessage 类型与会话 CRUD、后端存储调用。
- `services/stash.ts`：StashSource / StashItem 类型与暂存片段管理。

连续滚动实现要点：

- 每页在 `PdfViewer` 内部通过独立状态维护 canvas、wrapper、text items。
- 父组件通过 `IntersectionObserver` 监听各页可见性，仅渲染可见页及相邻页。
- 连续模式下滚动容器监听键盘事件，支持方向键、`PageUp/PageDown`、`Home/End`。
- 连续滚动页码检测以「页面顶部距离视口顶部最近」为准，避免大视口下以页面中心为基准导致的页码漂移。

Annotation 持久化要点：

- 坐标以 PDF 原始坐标（scale=1）保存，渲染时乘以当前 scale，自动适应缩放。
- 后端读取 PDF 内容计算 SHA-256 hash，作为文件唯一标识。
- 批注与关联的 session ids 以 JSON 形式存储在 `<AppData>/annotations/{hash}.json`。
- 解读会话以独立 JSON 文件存储在 `<AppData>/annotations/sessions/{session_id}.json`。
- 切换或重新打开同一 PDF 时自动恢复批注位置、内容与关联会话。

### 9.2 前端调用示例（当前已实现）

```typescript
// 读取 PDF 原始字节
const bytes = await invoke("read_pdf_bytes", { filePath });

// 获取 PDF 文件 hash
const hash = await invoke("get_pdf_hash", { filePath });

// 加载 PDF 关联的批注与 session ids
const data = await invoke("load_pdf_data", { filePath });

// 保存 PDF 关联的批注与 session ids
await invoke("save_pdf_data", { filePath, data });

// 加载 / 保存 / 删除解读会话
const session = await invoke("load_session", { sessionId });
await invoke("save_session", { session });
await invoke("delete_session", { sessionId });

// 使用系统默认程序打开路径
await invoke("open_path", { path });
```

以下为未来完整架构中的示例调用，当前暂未实现：

```typescript
// 打开 PDF 并解析（完整版）
await invoke("open_and_parse_pdf", { filePath });

// 用户提问（Agent 自动调用 Tools）
const answer = await invoke("ask_document", {
  documentId,
  question: "What are the ESD test levels?",
  sourceLang: "en",
  targetLang: "zh-CN",
});

// 复核 Clause 索引
await invoke("verify_clause_index", { documentId });
```

---

## 10. 方案优势与风险

### 10.1 优势

| 优势         | 说明                                    |
| ------------ | --------------------------------------- |
| 技术栈简单   | 无 Embedding、无向量库、无 RAG 检索逻辑 |
| 开发周期短   | MVP 预计 4-6 周                         |
| 灵活性强     | LLM 自主决定如何查询文档                |
| 跨语言友好   | LLM 自身具备多语言能力                  |
| 表格精确读取 | 通过多模态截图避免解析错误              |
| 可解释性好   | 用户可看到 LLM 调用了哪些 Tools         |

### 10.2 风险与应对

| 风险                        | 影响                     | 应对                                                                 |
| --------------------------- | ------------------------ | -------------------------------------------------------------------- |
| LLM Function Calling 不稳定 | 调错 Tool 或参数         | 严格定义 Tool schema；对参数做校验；失败后重试                       |
| 多次 Tool 调用导致延迟      | 用户体验下降             | 设置最大轮数；优化 Tool 设计；在 Debug 模式下可查看调用过程          |
| 长 Clause 超出 LLM 上下文   | 无法完整读取             | 不分段，整个传给 LLM；若超出模型上下文窗口，则提示用户该 Clause 过长 |
| 表格标题识别不准            | extract_table 找不到表格 | 允许用户手动框选表格区域；记录用户修正                               |
| LLM 幻觉                    | 编造条款                 | 强制引用来源；Prompt 中强调只基于 Tool 结果回答                      |

---

## 11. 待确认事项

- [x] 是否确认采用本 Agent Tools 方案，放弃 RAG/向量索引？
- [x] Clause 索引 LLM 复核采用手动触发（默认不自动执行，因消耗 Token）
- [ ] 最大 Tool 调用轮数设为多少？（建议 5 轮）
- [x] 多模态模型为可选项：用户未配置时，表格精确读取功能灰色不可用（如 gpt-4o、qwen-vl、glm-4v）
- [x] 前端不显示 LLM 的 Tool 调用过程；仅在 Debug 模式下可见
- [x] 超长 Clause 不分段，整个传给 LLM

---

## 12. 变更记录

| 版本 | 日期       | 变更人 | 变更内容                                                                                                                                                                                              |
| ---- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1  | 2026-07-06 | Kimi   | 初始版本，轻量解析 + LLM Function Calling Tools 方案                                                                                                                                                  |
| 0.2  | 2026-07-07 | Kimi   | 增加「超轻量版」说明：当前仅保留翻译/解读，Tools、Clause 索引、术语表、测试清单等功能延后                                                                                                             |
| 0.3  | 2026-07-07 | Kimi   | 同步已实现功能：PDF 连续滚动阅读、单页/连续切换、键盘导航、左右分栏拖拽调节与显隐、AI 流式输出单气泡修复                                                                                              |
| 0.4  | 2026-07-07 | Kimi   | 同步已实现功能：多 PDF Tab（最多 10 个）、AI 消息 Markdown 渲染、翻译浮层批注（可拖动/隐藏/删除/持久化）、解读条目列表（默认折叠/点击跳转）、选区工具条点击外部消失、批注按 PDF hash 持久化到 AppData |
| 0.5  | 2026-07-08 | Kimi   | 同步当前代码结构：新增暂存区、自定义解读、会话追问；修正 Prompt 示例与前端组件清单；删除不存在的 `PdfPage.tsx` 引用；补充 session 持久化说明                                                          |
