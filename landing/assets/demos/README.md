# 演示媒体资源目录

落地页的演示位**无需改 HTML**：`main.js` 会自动探测本目录下的媒体文件并替换占位区。

## 放置规则（按 data-demo 名称匹配）

- **视频**：放入 `{名称}.mp4`，可选配套首帧 `{名称}-poster.jpg`（加载前显示）。
- **静态图**：放入 `{名称}.jpg`（仅当无同名 mp4 时生效，适合 hover-word / persist）。
- 两者都不存在时，页面保持虚线占位样式。

录好一个放一个即可，页面自动生效。

## 命名与对应位置

| 名称                | 页面位置 | 优先级 | 建议内容                                                                        |
| ------------------- | -------- | ------ | ------------------------------------------------------------------------------- |
| `hero`              | Hero 区域 | 必需   | 15–20s 完整闭环：打开标准 → 选中英文条款 → 点"解读" → 右侧流式输出中文 → 点击解读记录跳回原文高亮 |
| `explain`           | 功能 05  | 必需   | 选中复杂条款 → 解读流式输出 → 追加一句追问 → 继续回答                            |
| `translate`         | 功能 04  | 必需   | 选中 → 翻译浮层出现 → 拖动浮层 → （拼接镜头）重开文件批注仍在                    |
| `search-outline`    | 功能 02  | 必需   | Ctrl/Cmd+F 搜术语 → 全文高亮 → Enter 逐个跳转；再点大纲条目跳章节                |
| `split-view`        | 功能 01  | 建议   | 打开多份标准 → Tab 切换 → 左右分屏对照新旧两个版本的同一条款                      |
| `stash-interpret`   | 功能 06  | 建议   | 第 5 页选一段入暂存 → 第 42 页选一段入暂存 → 自定义提问 → AI 综合回答            |
| `hover-word`        | 功能 03  | 可选   | 悬停英文单词约 500ms 弹出词典释义；可用静态截图 `hover-word.jpg` 替代             |
| `persist`           | 功能 07  | 可选   | 关闭文件 → 重新打开 → 批注与解读记录自动恢复 → 点击记录跳回原文                   |

## 录制规范

- **格式：录 MP4，不要录 GIF**（同画质体积相差 5–10 倍）。Windows 推荐 ScreenToGif（可逐帧剪辑）或 OBS Studio。
- 画面比例 **16:10**（建议 1440×900 录制，导出 1280×800），页面按此比例预留位置。
- 界面用**中文 UI + 英文标准内容**；示例 PDF 用自编测试文档（`scripts/gen-sample-*.mjs`）或标准组织公开的 preview 页面，注意版权。
- 流式输出保留真实速度（至多 1.5x 加速），"逐字打出"本身就是卖点。
- 单个视频控制在 **3 MB 以内、20 秒以内**。

## 压缩命令（ffmpeg）

```bash
# 压缩 + 缩放到 1280 宽；faststart 支持边下边播；-an 去音轨
ffmpeg -i input.mp4 -vf "scale=1280:-2" -c:v libx264 -crf 26 -preset slow -movflags +faststart -an hero.mp4

# 抽首帧做 poster
ffmpeg -i hero.mp4 -vframes 1 -q:v 3 hero-poster.jpg
```

## 可选：jsDelivr 分流

GitHub Pages 在国内访问不稳定时，可把 `<source>`/视频地址改为 jsDelivr 加速：

```
https://cdn.jsdelivr.net/gh/ChqJourney/smart_reader@main/landing/assets/demos/hero.mp4
```

注意 jsDelivr 缓存刷新慢，改版时建议把 `@main` 换成具体 tag 或 commit。
