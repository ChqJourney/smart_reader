/* eslint-disable react-refresh/only-export-components */
import { useTranslation } from "react-i18next";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { error as logError, info, warn } from "../services/logs";
import {
  checkDictionary,
  downloadDictionary,
  DownloadProgress,
  onDownloadProgress,
  DictionaryStatus,
} from "../services/dictionary";

export interface UseDictionaryStatusResult {
  status: DictionaryStatus | null;
  progress: DownloadProgress | null;
  downloading: boolean;
  error: string | null;
  startDownload: () => Promise<void>;
  refresh: () => Promise<void>;
}

const DictionaryStatusContext = createContext<UseDictionaryStatusResult | null>(
  null
);

export function DictionaryStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DictionaryStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await checkDictionary();
      setStatus(s);
    } catch (err) {
      logError(`Failed to check dictionary: ${err}`);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    onDownloadProgress((p) => {
      setProgress(p);
      if (p.status === "done") {
        setDownloading(false);
        info("dictionaryDownloadCompleted");
        refresh();
      } else if (p.status === "error") {
        setDownloading(false);
        const message = p.message || t("dictionary.downloadFailed");
        warn(`dictionaryDownloadFailed: ${message}`);
        setError(message);
      }
    })
      .then((unlisten) => {
        unlistenRef.current = unlisten;
      })
      .catch((err) => {
        logError(`Failed to listen download progress: ${err}`);
      });

    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [refresh, t]);

  const startDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    setProgress(null);
    info("dictionaryDownloadStarted");
    try {
      await downloadDictionary();
    } catch (err) {
      setDownloading(false);
      warn(`dictionaryDownloadFailed: ${err}`);
      setError(String(err));
    }
  }, []);

  const value: UseDictionaryStatusResult = {
    status,
    progress,
    downloading,
    error,
    startDownload,
    refresh,
  };

  return (
    <DictionaryStatusContext.Provider value={value}>
      {children}
    </DictionaryStatusContext.Provider>
  );
}

export function useDictionaryStatus(): UseDictionaryStatusResult {
  const ctx = useContext(DictionaryStatusContext);
  if (!ctx) {
    throw new Error(
      "useDictionaryStatus must be used within a DictionaryStatusProvider"
    );
  }
  return ctx;
}
