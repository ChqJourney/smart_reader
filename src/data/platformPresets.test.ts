import { describe, it, expect } from "vitest";
import {
  modelSupportsVision,
  findModel,
  PLATFORM_PRESETS,
} from "./platformPresets";

describe("modelSupportsVision", () => {
  it("官方文档确认的视觉模型被标记", () => {
    expect(
      modelSupportsVision("deepseek", "deepseek-v4-flash-vision-exp")
    ).toBe(true);
    expect(modelSupportsVision("kimi", "kimi-k2.6")).toBe(true);
    expect(modelSupportsVision("xiaomimimo", "mimo-v2.5")).toBe(true);
    expect(modelSupportsVision("bailian", "qwen-plus")).toBe(true);
    expect(modelSupportsVision("glm", "glm-4.6v")).toBe(true);
    expect(
      modelSupportsVision("volcengine", "doubao-seed-2-0-pro-260215")
    ).toBe(true);
    expect(
      modelSupportsVision("volcengine", "doubao-seed-2-0-lite-260215")
    ).toBe(true);
  });

  it("纯文本 / 未收录 / 自定义平台模型一律视为不支持", () => {
    expect(modelSupportsVision("deepseek", "deepseek-v4-flash")).toBe(false);
    expect(modelSupportsVision("deepseek", "deepseek-v4-pro")).toBe(false);
    // GLM-5.2 是纯文本旗舰（视觉由 4.6V 系列承担）
    expect(modelSupportsVision("glm", "glm-5.2")).toBe(false);
    expect(modelSupportsVision("xiaomimimo", "mimo-v2.5-pro")).toBe(false);
    // openrouter / openai / custom 不提供截图工具
    expect(modelSupportsVision("openai", "gpt-4o")).toBe(false);
    expect(modelSupportsVision("openrouter", "openai/gpt-4o-mini")).toBe(false);
    expect(modelSupportsVision("custom", "any-model")).toBe(false);
    // 未收录的模型 id
    expect(modelSupportsVision("kimi", "no-such-model")).toBe(false);
  });

  it("新增的视觉模型条目存在于预设模型列表中", () => {
    expect(
      findModel("deepseek", "deepseek-v4-flash-vision-exp")
    ).not.toBeNull();
    expect(findModel("glm", "glm-4.6v")).not.toBeNull();
  });

  it("各平台默认模型仍存在于模型列表中", () => {
    for (const preset of Object.values(PLATFORM_PRESETS)) {
      if (preset.models.length === 0) continue;
      expect(
        preset.models.some((m) => m.id === preset.defaultModelId),
        `${preset.id} 的 defaultModelId 应在 models 中`
      ).toBe(true);
    }
  });
});
