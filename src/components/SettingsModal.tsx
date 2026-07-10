import { useEffect, useState } from "react";
import { AppSettings } from "../services/settings";

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

  useEffect(() => {
    setSettings(initialSettings);
  }, [initialSettings, open]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(settings);
  };

  const updateLlm = (patch: Partial<AppSettings["llm"]>) => {
    setSettings((s) => ({ ...s, llm: { ...s.llm, ...patch } }));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        <p className="modal-hint">配置 LLM API 与目标语言。</p>
        <form className="settings-form" onSubmit={handleSubmit}>
          <label>
            API Base URL
            <input
              type="text"
              value={settings.llm.baseUrl}
              onChange={(e) => updateLlm({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={settings.llm.apiKey}
              onChange={(e) => updateLlm({ apiKey: e.target.value })}
              placeholder="sk-..."
            />
          </label>
          <label>
            Model
            <input
              type="text"
              value={settings.llm.model}
              onChange={(e) => updateLlm({ model: e.target.value })}
              placeholder="gpt-4o-mini"
            />
          </label>
          <label>
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
          <div className="modal-actions">
            <button type="button" onClick={onClose}>取消</button>
            <button type="submit">保存</button>
          </div>
        </form>
      </div>
    </div>
  );
}
