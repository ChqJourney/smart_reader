import { describe, it, expect } from "vitest";
import {
  modelSupportsVision,
  findModel,
  PLATFORM_PRESETS,
} from "./platformPresets";

describe("modelSupportsVision", () => {
  it("官方文档确认的视觉模型被标记", () => {
    expect(modelSupportsVision("deepseek", "deepseek-flash")).toBe(true);
    expect(modelSupportsVision("kimi", "kimi-k3")).toBe(true);
    expect(modelSupportsVision("kimi", "kimi-k2.6")).toBe(true);
    expect(modelSupportsVision("xiaomimimo", "mimo-v2.6-pro")).toBe(true);
    expect(modelSupportsVision("xiaomimimo", "mimo-v2.6-flash")).toBe(true);
    expect(modelSupportsVision("bailian", "qwen3.7-plus")).toBe(true);
    expect(modelSupportsVision("bailian", "qwen3.8-max")).toBe(true);
    expect(modelSupportsVision("glm", "glm-5.3-flash")).toBe(true);
    expect(modelSupportsVision("glm", "glm-4.6v")).toBe(true);
    expect(
      modelSupportsVision("volcengine", "doubao-seed-2-1-pro-260915")
    ).toBe(true);
    expect(
      modelSupportsVision("volcengine", "doubao-seed-2-1-lite-260915")
    ).toBe(true);
    expect(modelSupportsVision("openai", "gpt-5.6-terra")).toBe(true);
    expect(modelSupportsVision("openrouter", "openai/gpt-5-mini")).toBe(true);
    expect(
      modelSupportsVision("openrouter", "anthropic/claude-sonnet-4.5")
    ).toBe(true);
  });

  it("纯文本 / 未收录 / 自定义平台模型一律视为不支持", () => {
    expect(modelSupportsVision("deepseek", "deepseek-v4-pro")).toBe(false);
    // GLM-5.3 是纯文本旗舰（视觉由 5.3-Flash / 4.6V 承担）
    expect(modelSupportsVision("glm", "glm-5.3")).toBe(false);
    expect(modelSupportsVision("bailian", "deepseek-v4-pro")).toBe(false);
    expect(modelSupportsVision("custom", "any-model")).toBe(false);
    // 未收录的模型 id（含已下线的旧名）
    expect(modelSupportsVision("deepseek", "deepseek-v4-flash")).toBe(false);
    expect(modelSupportsVision("kimi", "moonshot-v1-8k")).toBe(false);
    expect(modelSupportsVision("bailian", "qwen-turbo")).toBe(false);
    expect(modelSupportsVision("kimi", "no-such-model")).toBe(false);
  });

  it("新增的视觉模型条目存在于预设模型列表中", () => {
    expect(findModel("deepseek", "deepseek-flash")).not.toBeNull();
    expect(findModel("glm", "glm-4.6v")).not.toBeNull();
    expect(findModel("kimi", "kimi-k3")).not.toBeNull();
    expect(findModel("xiaomimimo", "mimo-v2.6-pro")).not.toBeNull();
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
