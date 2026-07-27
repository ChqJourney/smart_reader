import { useTranslation } from "react-i18next";
import { useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { useModal } from "../hooks/useModal";
import "./TitleBarToggles.css";

export interface TitleBarTogglesProps {
  /** 词典已下载且可用时才显示悬停查词开关 */
  showHoverTranslate: boolean;
  hoverTranslateEnabled: boolean;
  onToggleHoverTranslate: () => void;
  /** 当前平台已配置 API Key 时才显示智能查阅开关 */
  showAgentTools: boolean;
  agentToolsEnabled: boolean;
  onToggleAgentTools: () => void;
  /** 已配置 API Key 时展示的平台 / 模型文本（纯展示，非按钮），未配置为 null */
  modelDisplay: string | null;
}

interface ToggleButtonProps {
  icon: "dictionary" | "search";
  label: string;
  enabled: boolean;
  title: string;
  testId: string;
  onClick: () => void;
}

function ToggleButton({
  icon,
  label,
  enabled,
  title,
  testId,
  onClick,
}: ToggleButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      className={`titlebar-toggle ${enabled ? "on" : ""}`}
      onClick={onClick}
      role="switch"
      aria-checked={enabled}
      title={title}
    >
      <Icon name={icon} size={13} />
      <span className="titlebar-toggle-label">{label}</span>
      <span className="titlebar-toggle-switch" aria-hidden="true">
        <span className="titlebar-toggle-knob" />
      </span>
    </button>
  );
}

export default function TitleBarToggles({
  showHoverTranslate,
  hoverTranslateEnabled,
  onToggleHoverTranslate,
  showAgentTools,
  agentToolsEnabled,
  onToggleAgentTools,
  modelDisplay,
}: TitleBarTogglesProps) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { contentRef } = useModal({
    open: confirmOpen,
    onClose: () => setConfirmOpen(false),
  });

  // 开启智能查阅前需确认：多轮工具调用会显著放大 token 消耗。
  // 关闭即时生效，不打断用户。
  const handleAgentToolsClick = () => {
    if (agentToolsEnabled) {
      onToggleAgentTools();
    } else {
      setConfirmOpen(true);
    }
  };

  const handleConfirmEnable = () => {
    setConfirmOpen(false);
    onToggleAgentTools();
  };

  if (!showHoverTranslate && !showAgentTools && !modelDisplay) {
    return null;
  }

  return (
    <div className="titlebar-toggles">
      {modelDisplay && (
        <span
          className="titlebar-model-display"
          data-testid="titlebar-model-display"
          title={t("quickToggles.currentModel", { model: modelDisplay })}
        >
          <Icon name="ai" size={12} />
          <span className="titlebar-model-text">{modelDisplay}</span>
        </span>
      )}
      {showHoverTranslate && (
        <ToggleButton
          icon="dictionary"
          label={t("quickToggles.hoverTranslate")}
          enabled={hoverTranslateEnabled}
          title={
            hoverTranslateEnabled
              ? t("quickToggles.hoverTranslateOn")
              : t("quickToggles.hoverTranslateOff")
          }
          testId="toggle-hover-translate"
          onClick={onToggleHoverTranslate}
        />
      )}
      {showAgentTools && (
        <ToggleButton
          icon="search"
          label={t("quickToggles.agentTools")}
          enabled={agentToolsEnabled}
          title={
            agentToolsEnabled
              ? t("quickToggles.agentToolsOn")
              : t("quickToggles.agentToolsOff")
          }
          testId="toggle-agent-tools"
          onClick={handleAgentToolsClick}
        />
      )}

      {confirmOpen &&
        // .titlebar 的 backdrop-filter 会成为 fixed 元素的包含块，
        // 弹窗必须 portal 到 body 才能全屏居中。
        createPortal(
          <div className="titlebar-toggle-modal-overlay">
            <div ref={contentRef} className="titlebar-toggle-modal">
              <h3>{t("quickToggles.agentToolsConfirmTitle")}</h3>
              <p className="titlebar-toggle-modal-body">
                {t("quickToggles.agentToolsConfirmBody")}
              </p>
              <div className="titlebar-toggle-modal-actions">
                <button type="button" onClick={() => setConfirmOpen(false)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={handleConfirmEnable}
                >
                  {t("quickToggles.agentToolsConfirmOk")}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
