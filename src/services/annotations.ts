import { invoke } from "@tauri-apps/api/core";

export interface AnnotationPosition {
  page: number;
  x: number;
  y: number;
}

export interface Annotation {
  id: string;
  type: "translate" | "explain";
  text: string;
  position: AnnotationPosition;
  content: string;
  isStreaming: boolean;
  hidden?: boolean;
  createdAt: number;
}

export async function loadAnnotations(filePath: string): Promise<Annotation[]> {
  if (!filePath) return [];
  try {
    return await invoke<Annotation[]>("load_annotations", { filePath });
  } catch (err) {
    console.error("Failed to load annotations:", err);
    return [];
  }
}

export async function saveAnnotations(
  filePath: string,
  annotations: Annotation[]
): Promise<void> {
  if (!filePath) return;
  try {
    await invoke("save_annotations", { filePath, annotations });
  } catch (err) {
    console.error("Failed to save annotations:", err);
  }
}

export async function getPdfHash(filePath: string): Promise<string> {
  return await invoke<string>("get_pdf_hash", { filePath });
}

export function createAnnotation(
  type: "translate" | "explain",
  text: string,
  page: number,
  x: number,
  y: number
): Annotation {
  return {
    id: crypto.randomUUID(),
    type,
    text,
    position: { page, x, y },
    content: "",
    isStreaming: true,
    hidden: type === "translate" ? false : undefined,
    createdAt: Date.now(),
  };
}

export function updateAnnotation(
  annotations: Annotation[],
  id: string,
  patch: Partial<Omit<Annotation, "id">>
): Annotation[] {
  return annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

export function deleteAnnotation(annotations: Annotation[], id: string): Annotation[] {
  return annotations.filter((a) => a.id !== id);
}
