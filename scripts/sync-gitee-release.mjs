#!/usr/bin/env node
/**
 * 把 GitHub Release 的更新资产同步到 Gitee 固定 release（tag: updater），作为国内备用更新源。
 *
 * 用法：node scripts/sync-gitee-release.mjs [assetsDir]
 *   assetsDir 内需包含 latest.json 及其中引用的更新包与签名（默认 ./assets，一般整个 release 资产目录原样传入）。
 *
 * 背景：Tauri v2 `createUpdaterArtifacts: true` 对 NSIS 直接签名 `-setup.exe`（不产 .nsis.zip），
 * 且 tauri-action 生成的 latest.json 里 url 是 API asset URL（无法取文件名），
 * 因此脚本通过「signature 字段 == .sig 文件内容」反查每个平台对应的更新包文件名。
 *
 * 步骤：
 *   1. 解析 latest.json，按 signature 匹配 .sig 反查更新包文件名，改写 url 指向 Gitee 附件直链（文件名不变，签名无需重签）；
 *   2. 删除 Gitee 侧旧的 latest.json / 更新包 / 签名附件（避免多版本堆积）；
 *   3. 上传 latest.json + 更新包 + .sig。
 *
 * 环境变量：
 *   GITEE_TOKEN        Gitee 私人令牌（projects 权限），必填
 *   GITEE_REPO         owner/repo，默认 patrickchq/SpecReader
 *   GITEE_RELEASE_TAG 固定 release 的 tag，默认 updater；不存在则报错退出（由人工保证存在）
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const GITEE_REPO = process.env.GITEE_REPO ?? "patrickchq/SpecReader";
const GITEE_RELEASE_TAG = process.env.GITEE_RELEASE_TAG ?? "updater";
const API_BASE = "https://gitee.com/api/v5";

const assetsDir = process.argv[2] ?? "assets";
const token = process.env.GITEE_TOKEN;
if (!token) {
  console.error("缺少 GITEE_TOKEN 环境变量（Gitee 私人令牌）");
  process.exit(1);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------- 1. 解析 latest.json，反查更新包并改写下载地址 ----------
const files = readdirSync(assetsDir);
if (!files.includes("latest.json")) {
  fail(
    `资产不完整：${assetsDir} 下缺少 latest.json，实际：${files.join(", ")}`
  );
}

const latestPath = path.join(assetsDir, "latest.json");
const manifest = JSON.parse(readFileSync(latestPath, "utf8"));
const sigFiles = files.filter((f) => f.endsWith(".sig"));

const bundleNames = new Set();
for (const [platform, info] of Object.entries(manifest.platforms ?? {})) {
  if (!info.url || !info.signature) continue;
  // .sig 文件内容就是 base64 签名本身（与 signature 字段一致）；
  // 兼容少数工具链存原始 minisign 文本的情况，此时 signature == base64(文件内容)
  const expected = info.signature.trim();
  const sigFile = sigFiles.find((f) => {
    const content = readFileSync(path.join(assetsDir, f), "utf8").trim();
    return (
      content === expected ||
      Buffer.from(expected, "base64").toString("utf8").trim() === content
    );
  });
  if (!sigFile) {
    fail(
      `平台 ${platform} 的 signature 在 ${assetsDir} 下找不到匹配的 .sig 文件`
    );
  }
  const bundleName = sigFile.slice(0, -".sig".length);
  if (!files.includes(bundleName)) {
    fail(`平台 ${platform} 对应的更新包 ${bundleName} 不在 ${assetsDir} 下`);
  }
  bundleNames.add(bundleName);
  info.url = `https://gitee.com/${GITEE_REPO}/releases/download/${GITEE_RELEASE_TAG}/${bundleName}`;
  console.log(`[latest.json] ${platform} -> ${info.url}`);
}
if (bundleNames.size === 0) {
  fail("latest.json 的 platforms 为空或缺少 url/signature，无法确定更新包");
}

writeFileSync(latestPath, JSON.stringify(manifest, null, 2));
const uploadFiles = [
  "latest.json",
  ...[...bundleNames].flatMap((name) => [name, `${name}.sig`]),
];

// ---------- 2. Gitee API ----------
async function giteeApi(apiPath, init = {}) {
  const res = await fetch(`${API_BASE}${apiPath}`, {
    ...init,
    headers: { Authorization: `token ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gitee API ${init.method ?? "GET"} ${apiPath} 失败：HTTP ${res.status} ${body.slice(0, 300)}`
    );
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// 固定 release 由人工保证存在，不存在直接报错
const release = await giteeApi(
  `/repos/${GITEE_REPO}/releases/tags/${GITEE_RELEASE_TAG}`
).catch((err) => {
  fail(
    `获取 Gitee 固定 release（tag: ${GITEE_RELEASE_TAG}）失败，请确认已在 Gitee 手动创建该 release。\n${err.message}`
  );
});
console.log(`[gitee] release id=${release.id}（${release.name}）`);

// 删除旧附件（latest.json + 各版本更新包与签名，其他附件不动）
const attachments = await giteeApi(
  `/repos/${GITEE_REPO}/releases/${release.id}/attach_files`
);
const stale = (attachments ?? []).filter(
  (a) =>
    a.name === "latest.json" ||
    a.name.endsWith(".sig") ||
    a.name.endsWith("-setup.exe") ||
    a.name.endsWith(".nsis.zip")
);
for (const a of stale) {
  await giteeApi(
    `/repos/${GITEE_REPO}/releases/${release.id}/attach_files/${a.id}`,
    { method: "DELETE" }
  );
  console.log(`[gitee] 已删除旧附件 ${a.name}`);
}

// 上传新附件
for (const name of uploadFiles) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([readFileSync(path.join(assetsDir, name))]),
    name
  );
  await giteeApi(`/repos/${GITEE_REPO}/releases/${release.id}/attach_files`, {
    method: "POST",
    body: form,
  });
  console.log(`[gitee] 已上传 ${name}`);
}

console.log(
  `同步完成：https://gitee.com/${GITEE_REPO}/releases/download/${GITEE_RELEASE_TAG}/latest.json`
);
