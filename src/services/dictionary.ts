import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface DictEntry {
  word: string;
  phonetic?: string;
  definition?: string;
  translation?: string;
  pos?: string;
}

export interface DictionaryStatus {
  exists: boolean;
  path: string;
  size?: number;
}

export interface DownloadProgress {
  status: "downloading" | "verifying" | "done" | "error";
  downloaded: number;
  total: number;
  message?: string;
}

export async function checkDictionary(): Promise<DictionaryStatus> {
  return invoke<DictionaryStatus>("check_dictionary");
}

export async function downloadDictionary(): Promise<void> {
  return invoke<void>("download_dictionary");
}

export async function lookupWord(word: string): Promise<DictEntry | null> {
  if (!word || !/^[a-zA-Z][a-zA-Z0-9\-'\.]*$/.test(word)) {
    return null;
  }
  return invoke<DictEntry | null>("lookup_word", { word: word.toLowerCase() });
}

export function onDownloadProgress(
  callback: (progress: DownloadProgress) => void
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("dictionary-download-progress", (event) => {
    callback(event.payload);
  });
}
