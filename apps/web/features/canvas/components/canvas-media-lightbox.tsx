"use client";

import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// 画布媒体预览弹层：资产列表中的视频/音频资产在画布内直接播放，
// 不跳转文件页，也不需要额外拉取（输出节点已缓存 blob 地址）
export type CanvasMediaPreview = {
  source: string;
  fileName: string;
  kind: "video" | "audio";
};

export function CanvasMediaLightbox({
  media,
  onClose,
}: {
  media: CanvasMediaPreview | null;
  onClose: () => void;
}) {
  const t = useTranslations("canvas");

  return (
    <Dialog open={media !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="w-[calc(100vw-2rem)] gap-3 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate text-sm">{media?.fileName || t("mediaPreviewTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("mediaPreviewDescription")}</DialogDescription>
        </DialogHeader>
        {media ? (
          <div className="overflow-hidden rounded-xl border border-border/60 bg-black">
            {media.kind === "video" ? (
              // biome-ignore lint/a11y/useMediaCaption: 生成/上传素材无字幕轨道，预览播放器仅作查看
              <video
                src={media.source}
                controls
                autoPlay
                playsInline
                preload="metadata"
                className="max-h-[70svh] w-full bg-black object-contain"
              />
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: 生成/上传素材无字幕轨道，预览播放器仅作查看
              <audio src={media.source} controls autoPlay className="w-full" />
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
