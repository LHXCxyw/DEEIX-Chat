"use client";

import * as React from "react";

// 静态导出部署后，旧页面会引用上一次构建的分块哈希；Turbopack 还会缓存失败状态，
// 再次 import 同一分块不会重新请求。整页刷新是唯一可靠的恢复方式，这里只自动做一次。
const RELOAD_MARKER = "deeix-chat:chunk-reload";
const RELOAD_MARKER_TTL_MS = 10_000;

function isChunkLoadError(value: unknown): boolean {
  if (value instanceof Error) {
    return value.name === "ChunkLoadError" || /Failed to load chunk/i.test(value.message);
  }
  return typeof value === "string" && /Failed to load chunk/i.test(value);
}

function reloadOnce() {
  try {
    if (window.sessionStorage.getItem(RELOAD_MARKER) === "1") {
      return;
    }
    window.sessionStorage.setItem(RELOAD_MARKER, "1");
  } catch {
    // 隐私模式等场景下 sessionStorage 不可用，仍然刷新一次。
  }
  window.location.reload();
}

/**
 * ChunkLoadRecovery 监听分块加载失败并整页刷新一次。
 * 用于部署切换或瞬时网络故障后，让 CodeMirror、截图等懒加载模块自动恢复，
 * 而不是一直停留在“Failed to load chunk”的错误状态。
 */
export function ChunkLoadRecovery() {
  React.useEffect(() => {
    // 加载成功后清除标记，后续部署切换仍可再次自动恢复。
    const clearMarker = window.setTimeout(() => {
      try {
        window.sessionStorage.removeItem(RELOAD_MARKER);
      } catch {
        // ignore
      }
    }, RELOAD_MARKER_TTL_MS);

    const onError = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLScriptElement && target.src.includes("/_next/static/chunks/")) {
        reloadOnce();
        return;
      }
      const errorEvent = event as ErrorEvent;
      if (isChunkLoadError(errorEvent.error) || isChunkLoadError(errorEvent.message)) {
        reloadOnce();
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) {
        reloadOnce();
      }
    };

    // 资源加载错误不会冒泡，必须用捕获阶段监听。
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.clearTimeout(clearMarker);
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
