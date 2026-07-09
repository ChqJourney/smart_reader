export interface StashSource {
  tabId: string;
  fileName: string;
  filePath: string;
  fileHash: string;
  page: number;
  pdfX: number;
  pdfY: number;
}

export interface StashItem {
  id: string;
  source: StashSource;
  text: string;
  createdAt: number;
}

export function createStashItem(source: StashSource, text: string): StashItem {
  return {
    id: crypto.randomUUID(),
    source,
    text,
    createdAt: Date.now(),
  };
}

export function addStash(stashes: StashItem[], item: StashItem): StashItem[] {
  return [...stashes, item];
}

export function removeStash(stashes: StashItem[], id: string): StashItem[] {
  return stashes.filter((item) => item.id !== id);
}

export function updateStash(stashes: StashItem[], id: string, text: string): StashItem[] {
  return stashes.map((item) => (item.id === id ? { ...item, text } : item));
}
