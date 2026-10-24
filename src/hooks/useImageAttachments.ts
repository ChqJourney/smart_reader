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
  // ref 跟踪最新值：卸载 cleanup 与添加时的上限判断都不能依赖闭包旧值
  const imagesRef = useRef<AttachedImage[]>([]);
  imagesRef.current = images;

  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const notifyLimit = useCallback(() => {
    void showMessage(
      i18n.t("common.notice"),
      i18n.t("chat.askImageLimit", { max: MAX_IMAGE_ATTACHMENTS })
    ).catch(() => undefined);
  }, []);

  const append = useCallback(
    (candidates: AttachedImage[]) => {
      const room = MAX_IMAGE_ATTACHMENTS - imagesRef.current.length;
      if (room <= 0) {
        for (const c of candidates) URL.revokeObjectURL(c.previewUrl);
        notifyLimit();
        return;
      }
      const accepted = candidates.slice(0, room);
      for (const c of candidates.slice(room)) URL.revokeObjectURL(c.previewUrl);
      if (candidates.length > room) notifyLimit();
      setImages((prev) => [...prev, ...accepted]);
    },
    [notifyLimit]
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

  const remove = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((img) => img.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl);
      return [];
    });
  }, []);

  return {
    images,
    canAdd: images.length < MAX_IMAGE_ATTACHMENTS,
    addFromDialog,
    addFromPaste,
    remove,
    clear,
  };
}
