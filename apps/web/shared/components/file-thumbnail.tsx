"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { loadThumbnailURL, readCachedThumbnailURL, resolveSignedThumbnailURL } from "@/shared/lib/file-thumbnail";

type FileThumbnailProps = {
  fileID: string;
  alt: string;
  className?: string;
  // 服务端签发的 thumb 档直连地址；缺省时回退鉴权 fetch。
  signedURL?: string;
};

// 懒加载图片缩略图：进入视口（含预加载边距）才加载。
// 优先签名直连（<img> 由 HTTP/CDN 缓存），否则鉴权 fetch 全量（并发受限）。
// 加载失败时保持空容器，由调用方决定回退展示。
export function FileThumbnail({ fileID, alt, className, signedURL }: FileThumbnailProps) {
  const [objectURL, setObjectURL] = React.useState<string | null>(() => readCachedThumbnailURL(fileID));
  const [visible, setVisible] = React.useState(Boolean(signedURL) || objectURL !== null);
  const containerRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (objectURL || signedURL) {
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "256px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [objectURL, signedURL]);

  React.useEffect(() => {
    if (!visible || objectURL || signedURL) {
      return;
    }
    let cancelled = false;
    void loadThumbnailURL(fileID)
      .then((nextURL) => {
        if (!cancelled) {
          setObjectURL(nextURL);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [visible, objectURL, signedURL, fileID]);

  const src = signedURL ? resolveSignedThumbnailURL(signedURL) : objectURL;

  return (
    <span ref={containerRef} aria-hidden="true" className={cn("block overflow-hidden rounded-[inherit]", className)}>
      {src ? <img src={src} alt={alt} className="size-full object-cover" /> : null}
    </span>
  );
}

// 可出缩略图的文件判断：仅位图类图片；SVG 服务端会改写为 text/plain 无法作为图片渲染
export function canShowFileThumbnail(fileCategory: string, mimeType: string): boolean {
  if (fileCategory !== "image") {
    return false;
  }
  return !mimeType.toLowerCase().includes("svg");
}
