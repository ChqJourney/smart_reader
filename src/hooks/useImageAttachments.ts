import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "i18next";
import {
  MAX_IMAGE_ATTACHMENTS,
  normalizeImage,
  normalizeImageFile,
  pickImagePaths,
  readUserImageBytes,
} from "../services/imageAttachments";
import { showMessage } from "../services/dialog";
import { error as logError } from "../services/logs";

export interface AttachedImage {
  id: string;
  data: Uint8Array;
  previewUrl: string;
}

export interface ImageAttachments {
  images: AttachedImage[];
  /** 达上限后为 false，组件据此隐藏添加入口 */
  canAdd: boolean;
  addFromDialog: () => Promise<void>;
  addFromPaste: (file: File) => Promise<void>;
  remove: (id: string) => void;
  /** 发送后清空（revoke 全部 previewUrl） */
  clear: () => void;
}

/**
 * 提问/追问输入框的图片附件状态：最多 MAX_IMAGE_ATTACHMENTS 张，
 * 统一归一化为 JPEG（缩略图用 object URL，卸载/删除时 revoke）。
 */
export function useImageAttachments(): ImageAttachments {
  const [images, setImages] = useState<AttachedImage[]>([]);
  // 所有写操作同步维护 ref；不能在 render 期回写，避免并发渲染覆盖新值。
  const imagesRef = useRef<AttachedImage[]>([]);
  const limitNotifiedRef = useRef(false);

  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const commitImages = useCallback((next: AttachedImage[]) => {
    imagesRef.current = next;
    if (next.length < MAX_IMAGE_ATTACHMENTS) {
      limitNotifiedRef.current = false;
    }
    setImages(next);
  }, []);

  const notifyLimit = useCallback(() => {
    if (limitNotifiedRef.current) return;
    limitNotifiedRef.current = true;
    void showMessage(
      i18n.t("common.notice"),
      i18n.t("chat.askImageLimit", { max: MAX_IMAGE_ATTACHMENTS })
    ).catch(() => undefined);
  }, []);

  const append = useCallback(
    (candidates: AttachedImage[]) => {
      const current = imagesRef.current;
      const room = MAX_IMAGE_ATTACHMENTS - current.length;
      const accepted = room > 0 ? candidates.slice(0, room) : [];
      const rejected = room > 0 ? candidates.slice(room) : candidates;
      if (accepted.length > 0) commitImages([...current, ...accepted]);
      for (const candidate of rejected) {
        URL.revokeObjectURL(candidate.previewUrl);
      }
      if (rejected.length > 0) notifyLimit();
    },
    [commitImages, notifyLimit]
  );

  const addFromDialog = useCallback(async () => {
    try {
      const paths = await pickImagePaths();
      if (paths.length === 0) return;
      const normalized: AttachedImage[] = [];
      for (const path of paths) {
        try {
          const bytes = await readUserImageBytes(path);
          const img = await normalizeImage(bytes);
          normalized.push({ id: crypto.randomUUID(), ...img });
        } catch (err) {
          logError(`Failed to attach image ${path}: ${err}`);
          void showMessage(
            i18n.t("common.notice"),
            i18n.t("chat.imageLoadFailed")
          ).catch(() => undefined);
        }
      }
      append(normalized);
    } catch (err) {
      logError(`Failed to pick images: ${err}`);
    }
  }, [append]);

  const addFromPaste = useCallback(
    async (file: File) => {
      try {
        const img = await normalizeImageFile(file);
        append([{ id: crypto.randomUUID(), ...img }]);
      } catch (err) {
        logError(`Failed to attach pasted image: ${err}`);
        void showMessage(
          i18n.t("common.notice"),
          i18n.t("chat.imageLoadFailed")
        ).catch(() => undefined);
      }
    },
    [append]
  );

  const remove = useCallback(
    (id: string) => {
      const current = imagesRef.current;
      const target = current.find((img) => img.id === id);
      if (!target) return;
      commitImages(current.filter((img) => img.id !== id));
      URL.revokeObjectURL(target.previewUrl);
    },
    [commitImages]
  );

  const clear = useCallback(() => {
    const current = imagesRef.current;
    commitImages([]);
    for (const img of current) URL.revokeObjectURL(img.previewUrl);
  }, [commitImages]);

  return {
    images,
    canAdd: images.length < MAX_IMAGE_ATTACHMENTS,
    addFromDialog,
    addFromPaste,
    remove,
    clear,
  };
}
