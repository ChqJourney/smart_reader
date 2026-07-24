import { useCallback, useMemo, useState } from "react";

export interface UseSplitViewReturn {
  isSplitView: boolean;
  secondaryTabId: string | null;
  enterSplitView: (secondaryTabId: string) => void;
  exitSplitView: () => void;
  setSecondaryTabId: (tabId: string | null) => void;
}

export function useSplitView(): UseSplitViewReturn {
  const [isSplitView, setIsSplitView] = useState(false);
  const [secondaryTabId, setSecondaryTabId] = useState<string | null>(null);

  const enterSplitView = useCallback((tabId: string) => {
    setSecondaryTabId(tabId);
    setIsSplitView(true);
  }, []);

  const exitSplitView = useCallback(() => {
    setIsSplitView(false);
    setSecondaryTabId(null);
  }, []);

  // 返回对象用 useMemo 固定引用，避免 App 层依赖它的回调每次渲染重建。
  return useMemo(
    () => ({
      isSplitView,
      secondaryTabId,
      enterSplitView,
      exitSplitView,
      setSecondaryTabId,
    }),
    [isSplitView, secondaryTabId, enterSplitView, exitSplitView]
  );
}
