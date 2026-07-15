/**
 * 平台预设数据源
 *
 * 每个平台的在线推理 API 预设配置。一旦平台有更新（新增模型、改端点、改 Key 申请入口），
 * 开发者只需修改本文件即可，无需改组件代码。
 *
 * 注意：
 * - 这里只收录「在线推理 API」（按量计费），不收录 Coding Plan / Token Plan 等订阅套餐
 *   （条款禁止第三方应用使用）。
 * - DeepSeek 老模型 deepseek-chat / deepseek-reasoner 将于 2026/07/24 弃用，
 *   已替换为 deepseek-v4-flash / deepseek-v4-pro。
 */

export type PlatformId =
  | "deepseek"
  | "kimi"
  | "bailian"
  | "glm"
  | "volcengine"
  | "openrouter"
  | "openai"
  | "custom";

export interface PlatformModel {
  /** 模型 ID，发送给 API 的 model 字段 */
  id: string;
  /** 用户可读的模型名 + 简短说明 */
  label: string;
  /** 是否支持 thinking / 推理模式 */
  supportsThinking: boolean;
  /** 上下文窗口大小（tokens），用于 context widget 计算 */
  contextWindow: number;
}

export interface PlatformPreset {
  /** 平台标识 */
  id: PlatformId;
  /** 用户可读的平台名 */
  label: string;
  /** 默认 Base URL */
  baseUrl: string;
  /** 该平台常用模型列表 */
  models: PlatformModel[];
  /** 默认选中的模型 ID（新建 profile 时） */
  defaultModelId: string;
  /** 「如何获取 API Key」的帮助链接 */
  apiKeyHelpUrl: string;
  /** API Key 输入提示（如格式要求） */
  apiKeyHint?: string;
  /** 该平台是否支持 OpenAI tools/function calling */
  supportsTools: boolean;
}

export const PLATFORM_PRESETS: Record<PlatformId, PlatformPreset> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash（快速，便宜）",
        supportsThinking: true,
        contextWindow: 128000,
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro（旗舰，最强）",
        supportsThinking: true,
        contextWindow: 128000,
      },
    ],
    defaultModelId: "deepseek-v4-flash",
    apiKeyHelpUrl: "https://platform.deepseek.com/api_keys",
    supportsTools: true,
  },
  kimi: {
    id: "kimi",
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      {
        id: "kimi-k2.6",
        label: "Kimi K2.6（最新，最强）",
        supportsThinking: true,
        contextWindow: 131072,
      },
      {
        id: "moonshot-v1-8k",
        label: "Moonshot V1 8K（短上下文，便宜）",
        supportsThinking: false,
        contextWindow: 8192,
      },
      {
        id: "moonshot-v1-32k",
        label: "Moonshot V1 32K（中等上下文）",
        supportsThinking: false,
        contextWindow: 32768,
      },
      {
        id: "moonshot-v1-128k",
        label: "Moonshot V1 128K（超长上下文）",
        supportsThinking: false,
        contextWindow: 131072,
      },
    ],
    defaultModelId: "kimi-k2.6",
    apiKeyHelpUrl: "https://platform.moonshot.cn/console/api-keys",
    supportsTools: true,
  },
  bailian: {
    id: "bailian",
    label: "阿里云百炼（通义千问等）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      {
        id: "qwen-plus",
        label: "Qwen Plus（性能均衡，推荐）",
        supportsThinking: true,
        contextWindow: 131072,
      },
      {
        id: "qwen-max",
        label: "Qwen Max（旗舰，最强）",
        supportsThinking: true,
        contextWindow: 131072,
      },
      {
        id: "qwen-turbo",
        label: "Qwen Turbo（最快，最便宜）",
        supportsThinking: true,
        contextWindow: 131072,
      },
      {
        id: "deepseek-v3",
        label: "DeepSeek V3（百炼直供）",
        supportsThinking: true,
        contextWindow: 131072,
      },
    ],
    defaultModelId: "qwen-plus",
    apiKeyHelpUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    supportsTools: true,
  },
  glm: {
    id: "glm",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    models: [
      {
        id: "glm-5.2",
        label: "GLM-5.2（最新旗舰）",
        supportsThinking: true,
        contextWindow: 128000,
      },
      {
        id: "glm-4-flash",
        label: "GLM-4 Flash（轻量，免费）",
        supportsThinking: false,
        contextWindow: 128000,
      },
    ],
    defaultModelId: "glm-5.2",
    apiKeyHelpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    apiKeyHint: "API Key 是两段式（含点号），请完整复制",
    supportsTools: true,
  },
  volcengine: {
    id: "volcengine",
    label: "火山引擎方舟（豆包等）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      {
        id: "doubao-seed-2-0-pro-260215",
        label: "Doubao Seed 2.0 Pro（旗舰）",
        supportsThinking: true,
        contextWindow: 128000,
      },
      {
        id: "doubao-seed-2-0-lite-260215",
        label: "Doubao Seed 2.0 Lite（轻量）",
        supportsThinking: false,
        contextWindow: 128000,
      },
    ],
    defaultModelId: "doubao-seed-2-0-pro-260215",
    apiKeyHelpUrl:
      "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
    apiKeyHint:
      "火山引擎的模型名是「Model ID」长串，请从方舟控制台「在线推理」页复制",
    supportsTools: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter（聚合多家模型）",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      {
        id: "openai/gpt-4o-mini",
        label: "GPT-4o mini（便宜）",
        supportsThinking: false,
        contextWindow: 128000,
      },
      {
        id: "anthropic/claude-sonnet-4",
        label: "Claude Sonnet 4（强）",
        supportsThinking: false,
        contextWindow: 200000,
      },
      {
        id: "deepseek/deepseek-chat",
        label: "DeepSeek Chat",
        supportsThinking: false,
        contextWindow: 128000,
      },
    ],
    defaultModelId: "openai/gpt-4o-mini",
    apiKeyHelpUrl: "https://openrouter.ai/keys",
    apiKeyHint: "OpenRouter 的 Key 以 sk-or- 开头",
    supportsTools: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        id: "gpt-4o-mini",
        label: "GPT-4o mini（便宜，推荐）",
        supportsThinking: false,
        contextWindow: 128000,
      },
      {
        id: "gpt-4o",
        label: "GPT-4o（旗舰）",
        supportsThinking: false,
        contextWindow: 128000,
      },
    ],
    defaultModelId: "gpt-4o-mini",
    apiKeyHelpUrl: "https://platform.openai.com/api-keys",
    supportsTools: true,
  },
  custom: {
    id: "custom",
    label: "自定义（高级）",
    baseUrl: "",
    models: [],
    defaultModelId: "",
    apiKeyHelpUrl: "",
    supportsTools: true,
  },
};

/** 平台选项列表（用于下拉选择） */
export const PLATFORM_LIST: PlatformPreset[] = Object.values(PLATFORM_PRESETS);

/** 默认平台 ID（新用户首次使用时的默认选择） */
export const DEFAULT_PLATFORM_ID: PlatformId = "deepseek";

/**
 * 根据 platformId 和 modelId 查找模型信息。
 * 自定义平台或未找到时返回 null。
 */
export function findModel(
  platformId: PlatformId,
  modelId: string
): PlatformModel | null {
  const preset = PLATFORM_PRESETS[platformId];
  if (!preset) return null;
  return preset.models.find((m) => m.id === modelId) ?? null;
}

/**
 * 根据 platformId 获取 context window。
 * 优先用 modelId 精确匹配，找不到则用该平台第一个模型的 contextWindow。
 */
export function getContextWindow(
  platformId: PlatformId,
  modelId: string
): number {
  const model = findModel(platformId, modelId);
  if (model) return model.contextWindow;
  const preset = PLATFORM_PRESETS[platformId];
  return preset?.models[0]?.contextWindow ?? 128000;
}
