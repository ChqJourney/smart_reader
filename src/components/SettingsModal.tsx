import { useEffect, useState } from "react";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPTS,
  SystemPrompts,
} from "../services/settings";

type PromptTab = "translate" | "explain";

interface SettingsModalProps {
  open: boolean;
  initialSettings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
}

export default function SettingsModal({
  open,
  initialSettings,
  onClose,
  onSave,
}: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [activePromptTab, setActivePromptTab] = useState<PromptTab>("translate");

  useEffect(() => {
    setSettings(initialSettings);
    setActivePromptTab("translate");
  }, [initialSettings, open]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(settings);
  };

  const updateLlm = (patch: Partial<AppSettings["llm"]>) => {
    setSettings((s) => ({ ...s, llm: { ...s.llm, ...patch } }));
  };

  const updateSystemPrompt = (key: keyof SystemPrompts, value: string) => {
    setSettings((s) => ({
      ...s,
      systemPrompts: { ...s.systemPrompts, [key]: value },
    }));
  };

  const resetPrompt = (key: keyof SystemPrompts) => {
    updateSystemPrompt(key, DEFAULT_SYSTEM_PROMPTS[key]);
  };

  const resetAll = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  const currentPrompt = settings.systemPrompts[activePromptTab];
  const currentDefault = DEFAULT_SYSTEM_PROMPTS[activePromptTab];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content settings-modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <div className="settings-modal-header">
          <h3>设置</h3>
          <p className="modal-hint">配置 LLM API、目标语言与系统提示词。</p>
        </div>

        <form id="settings-form" className="settings-modal-body" onSubmit={handleSubmit}>
          <section className="settings-section">
            <div className="settings-section-title">LLM API</div>
            <div className="settings-section-hint">用于翻译、解读与自定义问答的模型接入信息。</div>
            <div className="settings-form-row">
              <label className="settings-field">
                API Base URL
                <input
                  type="text"
                  value={settings.llm.baseUrl}
                  onChange={(e) => updateLlm({ baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="settings-field">
                Model
                <input
                  type="text"
                  value={settings.llm.model}
                  onChange={(e) => updateLlm({ model: e.target.value })}
                  placeholder="gpt-4o-mini"
                />
              </label>
            </div>
            <label className="settings-field">
              API Key
              <input
                type="password"
                value={settings.llm.apiKey}
                onChange={(e) => updateLlm({ apiKey: e.target.value })}
                placeholder="sk-..."
              />
            </label>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">输出语言</div>
            <div className="settings-section-hint">翻译与解读结果默认使用的语言。</div>
            <div className="settings-form-row">
              <label className="settings-field">
                目标语言
                <input
                  type="text"
                  value={settings.targetLanguage}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, targetLanguage: e.target.value }))
                  }
                  placeholder="中文"
                />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">系统提示词</div>
            <div className="settings-section-hint">
              控制 AI 在不同场景下的角色与回答风格。支持 {"{targetLanguage}"} 占位符。
            </div>
            <div className="settings-prompt-tabs">
              <button
                type="button"
                className={activePromptTab === "translate" ? "active" : ""}
                onClick={() => setActivePromptTab("translate")}
              >
                翻译
              </button>
              <button
                type="button"
                className={activePromptTab === "explain" ? "active" : ""}
                onClick={() => setActivePromptTab("explain")}
              >
                解读
              </button>
            </div>
            <div className="settings-prompt-area">
              <textarea
                value={currentPrompt}
                onChange={(e) => updateSystemPrompt(activePromptTab, e.target.value)}
                rows={5}
                aria-label={`${activePromptTab === "translate" ? "翻译" : "解读"}系统提示词`}
              />
              <div className="settings-prompt-meta">
                <span>{currentPrompt.length} 字符</span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => resetPrompt(activePromptTab)}
                  disabled={currentPrompt === currentDefault}
                >
                  恢复默认
                </button>
              </div>
            </div>
          </section>
        </form>

        <div className="settings-modal-footer">
          <button type="button" className="icon-btn" onClick={resetAll}>
            恢复全部默认
          </button>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button type="submit" form="settings-form">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
