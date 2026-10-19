import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../hooks/useModal";
import Icon from "./Icon";
import "./WhatsNewModal.css";

// Markdown/KaTeX 走代码分割按需加载，与 AiChatPanel 一致，不进首屏 chunk。
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

interface WhatsNewModalProps {
  /** 弹窗标题（调用方完成 i18n 与版本号插值） */
  title: string;
  /** changelog 段落 markdown 正文 */
  content: string;
  onClose: () => void;
  /** 主操作（如「马上升级」）；缺省时底部只有单个关闭按钮 */
  primaryAction?: { label: string; onClick: () => void };
}

/**
 * 更新内容展示弹窗：更新前（发现新版本，带主操作按钮）与更新后
 * （本次更新内容，仅关闭按钮）两种场景复用。
 */
export default function WhatsNewModal({
  title,
  content,
  onClose,
  primaryAction,
}: WhatsNewModalProps) {
  const { t } = useTranslation();
  const { contentRef } = useModal({ open: true, onClose });

  return (
    <div className="whats-new-overlay">
      <div
        ref={contentRef}
        className="whats-new-modal"
        role="dialog"
        aria-label={title}
      >
        <div className="whats-new-header">
          <h3>{title}</h3>
          <button
            className="whats-new-close"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="whats-new-body">
          <Suspense fallback={null}>
            <MarkdownRenderer content={content} />
          </Suspense>
        </div>
        <div className="whats-new-footer">
          <button type="button" className="icon-btn" onClick={onClose}>
            {primaryAction ? t("updater.later") : t("whatsNew.gotIt")}
          </button>
          {primaryAction && (
            <button
              type="button"
              className="icon-btn primary"
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
