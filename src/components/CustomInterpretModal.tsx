import { useState } from "react";

interface CustomInterpretModalProps {
  stashCount: number;
  onSubmit: (prompt: string) => void;
  onClose: () => void;
}

export default function CustomInterpretModal({
  stashCount,
  onSubmit,
  onClose,
}: CustomInterpretModalProps) {
  const [prompt, setPrompt] = useState("");

  const handleSubmit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setPrompt("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>自定义解读</h3>
        <p className="modal-hint">
          基于 {stashCount} 个选中片段进行解读
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入你的解读要求..."
          rows={4}
          autoFocus
        />
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button onClick={handleSubmit} disabled={!prompt.trim()}>发送</button>
        </div>
      </div>
    </div>
  );
}
