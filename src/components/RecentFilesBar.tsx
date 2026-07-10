import { RecentFile } from "../hooks/useRecentFiles";
import Icon from "./Icon";

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
  return (
    <div className="recent-files-bar" aria-label="最近打开的文件">
      <div className="recent-files-list">
        {files.length === 0 && (
          <span className="recent-files-empty">最近打开的文件将显示在这里</span>
        )}
        {files.map((file) => (
          <button
            key={file.path}
            className={`recent-file-card ${file.path === activeFilePath ? "active" : ""}`}
            onClick={() => onFileClick(file)}
            title={file.fileName}
          >
            <Icon name="pdf" size={14} />
            <span className="recent-file-name">{file.fileName}</span>
          </button>
        ))}
      </div>
      {files.length > 0 && (
        <button
          className="icon-btn recent-files-clear"
          onClick={onClear}
          aria-label="清空最近文件"
          title="清空最近文件"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}
