#!/usr/bin/env node
/**
 * 应用图标烘焙脚本（方案 B：§ 条款印记）
 *
 * 把内嵌的 64 viewBox SVG 渲染成 1024×1024 透明背景 PNG，
 * 之后执行 `npx tauri icon <输出.png>` 重新生成 src-tauri/icons/ 全套尺寸。
 *
 * 用法：node scripts/gen-app-icon.mjs [输出路径，默认 /tmp/app-icon-1024.png]
 *
 * 注意：§ 字形由 Georgia 字体渲染（macOS/Windows 均内置），
 * 渲染结果即为最终资产，PNG 落地后不依赖字体。
 */
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "/tmp/app-icon-1024.png";
const SIZE = 1024;

// 与 docs/icon-proposals.html 中 symbol#b-app 保持一致
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="gOrange" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ff5a1a"/>
      <stop offset="100%" stop-color="#dd3a00"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="58" height="58" rx="14" fill="url(#gOrange)"/>
  <text x="32" y="45" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
        font-weight="700" font-size="40" fill="#fffbf5">&#167;</text>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: SIZE, height: SIZE },
  deviceScaleFactor: 1,
});
await page.setContent(`<!DOCTYPE html><body style="margin:0">${svg}</body>`);
await page.screenshot({ path: OUT, omitBackground: true });
await browser.close();

console.log(`baked: ${OUT} (${SIZE}x${SIZE})`);
console.log(`next:  npx tauri icon "${OUT}"`);
