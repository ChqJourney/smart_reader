import { useCallback, useEffect, useRef, useState } from "react";
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

export function useDictionaryStatus(): UseDictionaryStatusResult {
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
      console.error("Failed to check dictionary:", err);
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
        refresh();
      } else if (p.status === "error") {
        setDownloading(false);
        setError(p.message || "词典下载失败");
      }
    })
      .then((unlisten) => {
        unlistenRef.current = unlisten;
      })
      .catch((err) => {
        console.error("Failed to listen download progress:", err);
      });

    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [refresh]);

  const startDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    setProgress(null);
    try {
      await downloadDictionary();
    } catch (err) {
      setDownloading(false);
      setError(String(err));
    }
  }, []);

  return {
    status,
    progress,
    downloading,
    error,
    startDownload,
    refresh,
  };
}
