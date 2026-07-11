import { useTranslation } from "react-i18next";
import { DictEntry } from "../services/dictionary";
import "./WordTooltip.css";

interface WordTooltipProps {
  word: string;
  entry: DictEntry | null;
  loading: boolean;
  x: number;
  y: number;
}

export default function WordTooltip({
  word,
  entry,
  loading,
  x,
  y,
}: WordTooltipProps) {
  const { t } = useTranslation();

  if (!loading && !entry) return null;

  const formatTranslation = (text?: string) => {
    if (!text) return null;
    const lines = text
      .split("\\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    return lines;
  };

  const translationLines = formatTranslation(entry?.translation);

  return (
    <div
      className="word-tooltip"
      style={{
        left: x,
        top: y,
      }}
      data-testid="word-tooltip"
    >
      <div className="word-tooltip-header">
        <span className="word-tooltip-word">{word}</span>
        {entry?.phonetic && (
          <span className="word-tooltip-phonetic">/{entry.phonetic}/</span>
        )}
        {entry?.pos && <span className="word-tooltip-pos">{entry.pos}</span>}
      </div>
      {loading && (
        <div className="word-tooltip-loading">{t("dictionary.querying")}</div>
      )}
      {!loading && translationLines && (
        <ul className="word-tooltip-body">
          {translationLines.slice(0, 5).map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {!loading && !translationLines && entry?.definition && (
        <div className="word-tooltip-body word-tooltip-definition">
          {entry.definition}
        </div>
      )}
    </div>
  );
}
