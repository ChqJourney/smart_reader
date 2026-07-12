import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import Icon from "./Icon";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPTS,
  SystemPrompts,
  openDefaultAppsSettings,
} from "../services/settings";
import { useDictionaryStatus } from "../hooks/useDictionaryStatus";
import { useModal } from "../hooks/useModal";
import { openLogsDir } from "../services/logs";
import "./CustomInterpretModal.css";
import "./SettingsModal.css";

type PromptTab = "translate" | "explain";
type SettingsPage = "model" | "feature" | "system";

interface SettingsModalProps {
  open: boolean;
  initialSettings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
}

const PAGE_LIST: SettingsPage[] = ["model", "feature", "system"];

export default function SettingsModal({
  open,
  initialSettings,
  onClose,
  onSave,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [activePromptTab, setActivePromptTab] =
    useState<PromptTab>("translate");
  const [activePage, setActivePage] = useState<SettingsPage>("model");
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [downloadPending, setDownloadPending] = useState(false);
  const [version, setVersion] = useState<string>("0.1.0");
  const [licenseText, setLicenseText] = useState<string | null>(null);
  const [currentPlatform, setCurrentPlatform] = useState<string | null>(null);
  const dictionaryStatus = useDictionaryStatus();

  useEffect(() => {
    setSettings(initialSettings);
    setActivePromptTab("translate");
    setActivePage("model");
    setShowDownloadConfirm(false);
    setDownloadPending(false);
  }, [initialSettings, open]);

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("0.1.0"));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setCurrentPlatform(navigator.platform);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/LICENSE.txt")
      .then((res) => {
        if (!res.ok) throw new Error("failed");
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setLicenseText(text);
      })
      .catch(() => {
        if (!cancelled) setLicenseText(t("settings.licenseError"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  useEffect(() => {
    if (
      open &&
      downloadPending &&
      dictionaryStatus.progress?.status === "done"
    ) {
      setSettings((prev) => ({ ...prev, hoverTranslate: true }));
      setShowDownloadConfirm(false);
      setDownloadPending(false);
    }
  }, [open, downloadPending, dictionaryStatus.progress]);

  const handleHoverTranslateToggle = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        setSettings((prev) => ({ ...prev, hoverTranslate: false }));
        return;
      }

      if (dictionaryStatus.status?.exists) {
        setSettings((prev) => ({ ...prev, hoverTranslate: true }));
        return;
      }

      setShowDownloadConfirm(true);
    },
    [dictionaryStatus.status]
  );

  const handleConfirmDownload = useCallback(async () => {
    setShowDownloadConfirm(false);
    setDownloadPending(true);
    await dictionaryStatus.startDownload();
  }, [dictionaryStatus]);

  const handleCancelDownload = useCallback(() => {
    setShowDownloadConfirm(false);
    setDownloadPending(false);
  }, []);

  const handleOpenLogs = useCallback(async () => {
    try {
      await openLogsDir();
    } catch (e) {
      console.error("Failed to open logs directory:", e);
    }
  }, []);

  const handleOpenDefaultApps = useCallback(async () => {
    try {
      await openDefaultAppsSettings();
    } catch (e) {
      console.error("Failed to open default apps settings:", e);
    }
  }, []);

  const { contentRef } = useModal({ open, onClose });

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

  const downloadProgressPercent =
    dictionaryStatus.progress && dictionaryStatus.progress.total > 0
      ? Math.min(
          100,
          Math.round(
            (dictionaryStatus.progress.downloaded /
              dictionaryStatus.progress.total) *
              100
          )
        )
      : 0;

  const promptTabLabel =
    activePromptTab === "translate"
      ? t("action.translate")
      : t("action.explain");

  return (
    <div className="modal-overlay">
      <div
        ref={contentRef}
        className="modal-content settings-modal-content"
        role="dialog"
        aria-label={t("settings.title")}
      >
        <div className="settings-modal-header">
          <button
            type="button"
            className="settings-modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="close" size={18} />
          </button>
          <h3>{t("settings.title")}</h3>
          <p className="modal-hint">{t("settings.description")}</p>
        </div>

        <form
          id="settings-form"
          className="settings-modal-body"
          onSubmit={handleSubmit}
        >
          <div className="settings-modal-layout">
            <nav
              className="settings-modal-sidebar"
              aria-label={t("settings.title")}
            >
              {PAGE_LIST.map((page) => (
                <button
                  key={page}
                  type="button"
                  className={activePage === page ? "active" : ""}
                  onClick={() => setActivePage(page)}
                  aria-current={activePage === page ? "page" : undefined}
                >
                  {t(`settings.pages.${page}`)}
                </button>
              ))}
            </nav>

            <div className="settings-modal-page-content">
              {activePage === "model" && (
                <section className="settings-section">
                  <div className="settings-section-title">
                    {t("settings.llmApi")}
                  </div>
                  <div className="settings-section-hint">
                    {t("settings.llmApiHint")}
                  </div>
                  <div className="settings-form-row">
                    <label className="settings-field">
                      {t("settings.apiBaseUrl")}
                      <input
                        type="text"
                        value={settings.llm.baseUrl}
                        onChange={(e) => updateLlm({ baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                      />
                    </label>
                    <label className="settings-field">
                      {t("settings.model")}
                      <input
                        type="text"
                        value={settings.llm.model}
                        onChange={(e) => updateLlm({ model: e.target.value })}
                        placeholder="gpt-4o-mini"
                      />
                    </label>
                  </div>
                  <label className="settings-field">
                    {t("settings.apiKey")}
                    <input
                      type="password"
                      value={settings.llm.apiKey}
                      onChange={(e) => updateLlm({ apiKey: e.target.value })}
                      placeholder="sk-..."
                    />
                  </label>
                </section>
              )}

              {activePage === "feature" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.outputLanguage")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.outputLanguageHint")}
                    </div>
                    <div className="settings-form-row">
                      <label className="settings-field">
                        {t("settings.targetLanguage")}
                        <input
                          type="text"
                          value={settings.targetLanguage}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              targetLanguage: e.target.value,
                            }))
                          }
                          placeholder={t("settings.targetLanguagePlaceholder")}
                        />
                      </label>
                    </div>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.hoverTranslate")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.hoverTranslateHint")}
                    </div>
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={settings.hoverTranslate}
                        onChange={(e) =>
                          handleHoverTranslateToggle(e.target.checked)
                        }
                        disabled={dictionaryStatus.downloading}
                      />
                      {t("settings.enableHoverTranslate")}
                    </label>
                    {settings.hoverTranslate &&
                      dictionaryStatus.status?.exists && (
                        <p className="settings-status-ok">
                          {t("settings.dictionaryReady")}
                        </p>
                      )}
                    {dictionaryStatus.downloading && (
                      <div className="settings-download-progress">
                        <div className="settings-progress-bar">
                          <div
                            className="settings-progress-fill"
                            style={{ width: `${downloadProgressPercent}%` }}
                          />
                        </div>
                        <span className="settings-progress-text">
                          {dictionaryStatus.progress?.message ||
                            t("settings.downloadingProgress", {
                              percent: downloadProgressPercent,
                            })}
                        </span>
                      </div>
                    )}
                    {dictionaryStatus.error && (
                      <p className="settings-status-error">
                        {dictionaryStatus.error}
                      </p>
                    )}
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.systemPrompts")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.systemPromptsHint")}
                    </div>
                    <div className="settings-prompt-tabs">
                      <button
                        type="button"
                        className={
                          activePromptTab === "translate" ? "active" : ""
                        }
                        onClick={() => setActivePromptTab("translate")}
                      >
                        {t("action.translate")}
                      </button>
                      <button
                        type="button"
                        className={
                          activePromptTab === "explain" ? "active" : ""
                        }
                        onClick={() => setActivePromptTab("explain")}
                      >
                        {t("action.explain")}
                      </button>
                    </div>
                    <div className="settings-prompt-area">
                      <textarea
                        value={currentPrompt}
                        onChange={(e) =>
                          updateSystemPrompt(activePromptTab, e.target.value)
                        }
                        rows={5}
                        aria-label={t("settings.promptAriaLabel", {
                          action: promptTabLabel,
                        })}
                      />
                      <div className="settings-prompt-meta">
                        <span>
                          {currentPrompt.length} {t("settings.characters")}
                        </span>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => resetPrompt(activePromptTab)}
                          disabled={currentPrompt === currentDefault}
                        >
                          {t("common.reset")}
                        </button>
                      </div>
                    </div>
                  </section>
                </>
              )}

              {activePage === "system" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.appInfo")}
                    </div>
                    <dl className="settings-info-list">
                      <div>
                        <dt>{t("settings.productName")}</dt>
                        <dd>SpecReader AI</dd>
                      </div>
                      <div>
                        <dt>{t("settings.version")}</dt>
                        <dd>{version}</dd>
                      </div>
                      <div>
                        <dt>{t("settings.identifier")}</dt>
                        <dd>com.photonee.specreader</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.license")}
                    </div>
                    <pre className="settings-license-text">
                      {licenseText ?? t("settings.licenseLoading")}
                    </pre>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.openLogs")}
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={handleOpenLogs}
                    >
                      {t("settings.openLogs")}
                    </button>
                  </section>

                  {currentPlatform?.startsWith("Win") && (
                    <section className="settings-section">
                      <div className="settings-section-title">
                        {t("settings.defaultPdfReader")}
                      </div>
                      <div className="settings-section-hint">
                        {t("settings.defaultPdfReaderHint")}
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={handleOpenDefaultApps}
                      >
                        {t("settings.setAsDefaultPdfReader")}
                      </button>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </form>

        <div className="settings-modal-footer">
          <div className="settings-modal-footer-left">
            <button type="button" className="icon-btn" onClick={resetAll}>
              {t("settings.resetAll")}
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" form="settings-form">
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>

      {showDownloadConfirm && (
        <div className="modal-overlay" onClick={handleCancelDownload}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("settings.downloadDictionaryTitle")}
          >
            <div className="settings-modal-header">
              <h3>{t("settings.downloadDictionaryTitle")}</h3>
              <p className="modal-hint">
                {t("settings.downloadDictionaryHint")}
              </p>
            </div>
            <div className="settings-modal-footer">
              <button type="button" onClick={handleCancelDownload}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleConfirmDownload}
              >
                {t("settings.downloadNow")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
