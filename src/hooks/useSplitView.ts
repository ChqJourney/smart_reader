import { useCallback, useState } from "react";

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

  return {
    isSplitView,
    secondaryTabId,
    enterSplitView,
    exitSplitView,
    setSecondaryTabId,
  };
}
