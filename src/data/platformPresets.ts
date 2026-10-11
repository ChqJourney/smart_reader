/**
 * 平台预设数据源
 *
 * 每个平台的在线推理 API 预设配置。一旦平台有更新（新增模型、改端点、改 Key 申请入口），
 * 开发者只需修改本文件即可，无需改组件代码。
 *
 * 注意：
 * - 这里只收录「在线推理 API」（按量计费），不收录 Coding Plan / Token Plan 等订阅套餐
 *   （条款禁止第三方应用使用）。
 * - DeepSeek 当前仅余 deepseek-flash / deepseek-v4-pro 两个模型；
 *   旧模型名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍可调用，
 *   但对应模型已下线，请求均由 DeepSeek-V4.1-Flash 承接（deepseek-flash 原生支持图片输入）。
 */

export type PlatformId =
  | "deepseek"
  | "kimi"
  | "xiaomimimo"
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
  /**
   * 是否支持图片输入（视觉模型）。缺省 = false。
   * 为 true 且 Agent Tools 开启时，agent loop 会额外提供页面截图工具。
   */
  supportsVision?: boolean;
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
        // DeepSeek 官方：deepseek-flash 为当前唯一推荐调用名，原生支持图片输入
        id: "deepseek-flash",
        label: "DeepSeek Flash（快速，便宜，支持看图）",
        supportsThinking: true,
        contextWindow: 1048576,
        supportsVision: true,
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro（旗舰，最强）",
        supportsThinking: true,
        contextWindow: 1048576,
      },
    ],
    defaultModelId: "deepseek-flash",
    apiKeyHelpUrl: "https://platform.deepseek.com/api_keys",
    supportsTools: true,
  },
  kimi: {
    id: "kimi",
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    // moonshot-v1 全系列与 kimi-k2 早期版本已于 2026-08-31 全平台下线（调用返回 404）
    models: [
      {
        // 官方当前旗舰：1M 上下文、原生视觉、reasoning_effort 控制推理强度
        id: "kimi-k3",
        label: "Kimi K3（最新旗舰，1M 上下文，支持看图）",
        supportsThinking: true,
        contextWindow: 1048576,
        supportsVision: true,
      },
      {
        id: "kimi-k2.6",
        label: "Kimi K2.6（通用，256K 上下文，支持看图）",
        supportsThinking: true,
        contextWindow: 262144,
        supportsVision: true,
      },
    ],
    defaultModelId: "kimi-k3",
    apiKeyHelpUrl: "https://platform.kimi.com/console/api-keys",
    supportsTools: true,
  },
  xiaomimimo: {
    id: "xiaomimimo",
    label: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    // v2.6 全系原生全模态（图像/视频/音频输入）；v2.5 系列已于 2026-10-21 失效
    models: [
      {
        id: "mimo-v2.6-pro",
        label: "MiMo-V2.6-Pro（旗舰，1M 上下文，支持看图）",
        supportsThinking: true,
        contextWindow: 1048576,
        supportsVision: true,
      },
      {
        id: "mimo-v2.6-flash",
        label: "MiMo-V2.6-Flash（快速，1M 上下文，支持看图）",
        supportsThinking: true,
        contextWindow: 1048576,
        supportsVision: true,
      },
    ],
    defaultModelId: "mimo-v2.6-pro",
    apiKeyHelpUrl: "https://platform.xiaomimimo.com/console/api-keys",
    supportsTools: true,
  },
  bailian: {
    id: "bailian",
    label: "阿里云百炼（通义千问等）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // qwen-turbo 已于 2026-07-13 停止调用、deepseek-v3 已下架；官方当前旗舰为 qwen3.8-max
    models: [
      {
        id: "qwen3.7-plus",
        label: "Qwen3.7 Plus（官方首选，1M 上下文，支持看图）",
        supportsThinking: true,
        contextWindow: 1048576,
        supportsVision: true,
      },
      {
        id: "qwen3.8-max",
        label: "Qwen3.8 Max（最新旗舰，1M 上下文，支持看图）",
        supportsThinking: false,
        contextWindow: 1048576,
        supportsVision: true,
      },
      {
        id: "qwen-flash",
        label: "Qwen Flash（最快，最便宜，1M 上下文）",
        supportsThinking: true,
        contextWindow: 1048576,
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro（百炼直供，1M 上下文）",
        supportsThinking: true,
        contextWindow: 1048576,
      },
    ],
    defaultModelId: "qwen3.7-plus",
    apiKeyHelpUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    supportsTools: true,
  },
  glm: {
    id: "glm",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    // GLM-5.3 系列 thinking 只接受 enabled（不可关闭），后端对 glm-5.3* 的
    // disabled 请求会静默省略 thinking 参数（见 llm_proxy.rs）
    models: [
      {
        // GLM-5.3 为纯文本旗舰，视觉输入由 5.3-Flash / 4.6V 系列承担
        id: "glm-5.3",
        label: "GLM-5.3（最新旗舰，1M 上下文）",
        supportsThinking: true,
        contextWindow: 1048576,
      },
      {
        id: "glm-5.3-flash",
        label: "GLM-5.3 Flash（原生多模态，1M 上下文，支持看图）",
        supportsThinking: true,
        contextWindow: 1048576,
        supportsVision: true,
      },
      {
        id: "glm-4.6v",
        label: "GLM-4.6V（视觉，128K 上下文）",
        supportsThinking: true,
        contextWindow: 128000,
        supportsVision: true,
      },
      {
        id: "glm-4.7-flash",
        label: "GLM-4.7 Flash（轻量，免费）",
        supportsThinking: false,
        contextWindow: 200000,
      },
    ],
    defaultModelId: "glm-5.3",
    apiKeyHelpUrl: "https://open.bigmodel.cn/apikey/platform",
    apiKeyHint: "API Key 是两段式（含点号），请完整复制",
    supportsTools: true,
  },
  volcengine: {
    id: "volcengine",
    label: "火山引擎方舟（豆包等）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    // seed-2.1 系列为原生多模态、全系 256K 上下文；seed-2.0 已于 2026-10/11 分批下线
    models: [
      {
        id: "doubao-seed-2-1-pro-260915",
        label: "Doubao Seed 2.1 Pro（旗舰，支持看图）",
        supportsThinking: true,
        contextWindow: 256000,
        supportsVision: true,
      },
      {
        id: "doubao-seed-2-1-lite-260915",
        label: "Doubao Seed 2.1 Lite（轻量，支持看图）",
        supportsThinking: false,
        contextWindow: 256000,
        supportsVision: true,
      },
    ],
    defaultModelId: "doubao-seed-2-1-pro-260915",
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
        id: "openai/gpt-5-mini",
        label: "GPT-5 mini（便宜，支持看图）",
        supportsThinking: false,
        contextWindow: 400000,
        supportsVision: true,
      },
      {
        id: "anthropic/claude-sonnet-4.5",
        label: "Claude Sonnet 4.5（强，1M 上下文，支持看图）",
        supportsThinking: false,
        contextWindow: 1000000,
        supportsVision: true,
      },
      {
        id: "deepseek/deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash（1M 上下文，支持看图）",
        supportsThinking: false,
        contextWindow: 1048576,
        supportsVision: true,
      },
    ],
    defaultModelId: "openai/gpt-5-mini",
    apiKeyHelpUrl: "https://openrouter.ai/keys",
    apiKeyHint: "OpenRouter 的 Key 以 sk-or- 开头",
    supportsTools: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    // 不收录 gpt-6.x 系列：其 tool calling 仅支持 Responses API，
    // 与本应用的 Chat Completions 代理不兼容（收录会导致 Agent Tools 失效）
    models: [
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra（均衡，推荐，支持看图）",
        supportsThinking: false,
        contextWindow: 1050000,
        supportsVision: true,
      },
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol（旗舰，支持看图）",
        supportsThinking: false,
        contextWindow: 1050000,
        supportsVision: true,
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna（最便宜，支持看图）",
        supportsThinking: false,
        contextWindow: 1050000,
        supportsVision: true,
      },
    ],
    defaultModelId: "gpt-5.6-terra",
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

/**
 * 当前模型是否支持图片输入（视觉能力）。
 * 自定义平台或未收录的模型一律视为不支持（不使用截图工具）。
 */
export function modelSupportsVision(
  platformId: PlatformId,
  modelId: string
): boolean {
  return findModel(platformId, modelId)?.supportsVision === true;
}
