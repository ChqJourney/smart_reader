#!/usr/bin/env node
/**
 * 把 GitHub Release 的更新资产同步到 Gitee 固定 release（tag: updater），作为国内备用更新源。
 *
 * 用法：node scripts/sync-gitee-release.mjs [assetsDir]
 *   assetsDir 内需包含 latest.json、*.nsis.zip、*.nsis.zip.sig（默认 ./assets）。
 *
 * 步骤：
 *   1. 改写 latest.json 各平台 url，指向 Gitee 附件直链（文件名不变，签名无需重签）；
 *   2. 删除 Gitee 侧旧的 latest.json / *.nsis.zip / *.nsis.zip.sig 附件（避免多版本堆积）；
 *   3. 上传三个文件。
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

// ---------- 1. 收集并校验资产文件 ----------
const files = readdirSync(assetsDir);
const latestJson = files.find((f) => f === "latest.json");
const nsisZip = files.find((f) => f.endsWith(".nsis.zip"));
const nsisSig = files.find((f) => f.endsWith(".nsis.zip.sig"));
if (!latestJson || !nsisZip || !nsisSig) {
  console.error(
    `资产不完整：${assetsDir} 下需要 latest.json / *.nsis.zip / *.nsis.zip.sig，实际：${files.join(", ")}`
  );
  process.exit(1);
}
const uploadFiles = ["latest.json", nsisZip, nsisSig];

// ---------- 2. 改写 latest.json 下载地址 ----------
const latestPath = path.join(assetsDir, "latest.json");
const manifest = JSON.parse(readFileSync(latestPath, "utf8"));
for (const [platform, info] of Object.entries(manifest.platforms ?? {})) {
  if (info.url) {
    const fileName = info.url.split("/").pop();
    info.url = `https://gitee.com/${GITEE_REPO}/releases/download/${GITEE_RELEASE_TAG}/${fileName}`;
    console.log(`[latest.json] ${platform} -> ${info.url}`);
  }
}
writeFileSync(latestPath, JSON.stringify(manifest, null, 2));

// ---------- 3. Gitee API ----------
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
  console.error(
    `获取 Gitee 固定 release（tag: ${GITEE_RELEASE_TAG}）失败，请确认已在 Gitee 手动创建该 release。\n${err.message}`
  );
  process.exit(1);
});
console.log(`[gitee] release id=${release.id}（${release.name}）`);

// 删除旧附件（仅 latest.json / nsis 更新包，其他附件不动）
const attachments = await giteeApi(
  `/repos/${GITEE_REPO}/releases/${release.id}/attach_files`
);
const stale = (attachments ?? []).filter(
  (a) =>
    a.name === "latest.json" ||
    a.name.endsWith(".nsis.zip") ||
    a.name.endsWith(".nsis.zip.sig")
);
for (const a of stale) {
  await giteeApi(
    `/repos/${GITEE_REPO}/releases/${release.id}/attach_files/${a.id}`,
    {
      method: "DELETE",
    }
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
