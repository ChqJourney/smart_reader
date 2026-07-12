import { useTranslation } from "react-i18next";
import { RecentFile } from "../hooks/useRecentFiles";
import { getBasename } from "../utils/path";
import Icon from "./Icon";
import "./RecentFilesBar.css";

interface RecentFilesBarProps {
  files: RecentFile[];
  activeFilePath?: string | null;
  onFileClick: (file: RecentFile) => void;
  onClear: () => void;
}

export default function RecentFilesBar({
  files,
  activeFilePath,
  onFileClick,
  onClear,
}: RecentFilesBarProps) {
  const { t } = useTranslation();

  return (
    <div className="recent-files-bar" aria-label={t("recentFiles.title")}>
      <div className="recent-files-list">
        {files.length === 0 && (
          <span className="recent-files-empty">{t("recentFiles.empty")}</span>
        )}
        {files.map((file) => (
          <button
            key={file.path}
            className={`recent-file-card ${file.path === activeFilePath ? "active" : ""}`}
            onClick={() => onFileClick(file)}
            title={file.path}
          >
            <Icon name="pdf" size={14} />
            <span className="recent-file-name">{getBasename(file.path)}</span>
          </button>
        ))}
      </div>
      {files.length > 0 && (
        <button
          className="icon-btn recent-files-clear"
          onClick={onClear}
          aria-label={t("recentFiles.clear")}
          title={t("recentFiles.clear")}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}
