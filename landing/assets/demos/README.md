# 演示 GIF 资源目录

将产品的操作录屏 GIF 放置在此目录下，然后在 `../index.html` 中对应位置替换占位区域即可。

## 建议命名与对应位置

| 文件名 | 对应页面位置 | 建议尺寸 | 建议内容 |
|---|---|---|---|
| `open-pdf.gif` | 功能 01 右侧 | 1280×720 或 1440×900 | 打开本地 PDF、多 Tab 切换 |
| `translate.gif` | 功能 02 右侧 | 同上 | 选中文本 → 点击翻译 → 浮层批注 |
| `explain.gif` | 功能 03 右侧 | 同上 | 选中文本 → 点击解读 → 右侧面板流式输出 |
| `stash-interpret.gif` | 功能 04 右侧 | 同上 | 多个片段加入暂存 → 自定义解读 |
| `hover-word.gif` | 功能 05 右侧 | 同上 | 悬停英文单词显示 ECDICT 释义 |
| `layout.gif` | 功能 06 右侧 | 同上 | 分栏拖拽、单页/连续模式切换 |
| `hero.gif` | Hero 区域右侧 | 1440×900 或更大 | 主界面整体演示，可选 |

## 替换方法

1. 把 GIF 文件放入本目录。
2. 打开 `landing/index.html`。
3. 找到对应的 `.demo-placeholder` 元素。
4. 用 `<img src="assets/demos/xxx.gif" alt="..." loading="lazy" />` 替换整个 `.demo-placeholder` 元素，
   或者保留 `.demo-placeholder` 容器并把内部图标/文字替换为 `<img>`。

示例：

```html
<div class="feature-visual">
  <img
    src="assets/demos/translate.gif"
    alt="选中文本后点击翻译，页面上出现可拖动的翻译浮层"
    loading="lazy"
    class="feature-gif"
  />
</div>
```

## 文件大小建议

- 单个 GIF 控制在 **2–5 MB** 以内。
- 如果文件过大，可使用 `ffmpeg` 压缩帧率/分辨率，或转换为 WebM/MP4 后用 `<video autoplay muted loop playsinline>` 替代。

## 可选：使用视频替代 GIF

如需用视频替代，可参考如下结构：

```html
<video class="feature-gif" autoplay muted loop playsinline poster="assets/demos/xxx-poster.jpg">
  <source src="assets/demos/xxx.webm" type="video/webm" />
  <source src="assets/demos/xxx.mp4" type="video/mp4" />
</video>
```
