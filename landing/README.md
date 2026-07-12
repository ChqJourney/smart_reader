# SpecReader AI Landing Page

本目录存放 SpecReader AI 的独立宣传落地页，用于 GitHub Pages 部署。

## 本地预览

由于页面使用纯静态 HTML/CSS/JS，直接用浏览器打开 `index.html` 即可预览：

```bash
# 方式一：直接用浏览器打开
open landing/index.html

# 方式二：启动本地静态服务器（推荐，路径更真实）
cd landing
python3 -m http.server 8080
# 然后访问 http://localhost:8080
```

## 文件结构

```
landing/
├── index.html          # 页面入口
├── css/
│   └── style.css       # 样式
├── js/
│   └── main.js         # 打字机、滚动动画
├── assets/
│   ├── logo.svg        # 产品 Logo
│   └── demos/          # 操作演示 GIF
│       ├── README.md   # GIF 替换说明
│       ├── open-pdf.gif
│       ├── translate.gif
│       ├── explain.gif
│       ├── stash-interpret.gif
│       ├── hover-word.gif
│       └── layout.gif
└── README.md           # 本文件
```

## 部署

本页面通过 `.github/workflows/landing.yml` 自动部署到 GitHub Pages。

- 触发条件：`main` 分支下 `landing/` 目录有变更时自动触发，也可手动触发。
- 访问地址：`https://chqjourney.github.io/smart_reader/`

## 替换 GIF

详见 `assets/demos/README.md`。

## 样式说明

- 浅色专业风：以白色/浅灰为底，靛蓝为主色。
- 响应式布局：适配桌面、平板、手机。
- 动效：Hero 区域打字机、区块滚动淡入。
- 无第三方依赖：纯原生 HTML/CSS/JS，加载速度快。
