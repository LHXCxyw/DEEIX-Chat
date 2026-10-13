"use client";

import * as React from "react";
import {
  canvasModelKey,
  modelCanvasMediaType,
  toCanvasModelOption,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import { canvasStore } from "@/features/canvas/model/canvas-store";
import { useChatModelOptions } from "@/features/chat";

const CANVAS_MODEL_STORAGE_KEY = "deeix_canvas_selected_model_v1";
const CANVAS_VIDEO_MODEL_STORAGE_KEY = "deeix_canvas_selected_video_model_v1";

function readStoredModelKey(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredModelKey(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存储失败时静默降级
  }
}

// 按身份键（优先）或旧版模型名（历史本地存储为纯名称）定位目录条目
function findModelByStoredKey(
  models: ReadonlyArray<CanvasModelOption>,
  stored: string | null,
): CanvasModelOption | null {
  if (!stored) {
    return null;
  }
  return (
    models.find((item) => canvasModelKey(item) === stored)
    ?? models.find((item) => item.platformModelName === stored)
    ?? null
  );
}

export function useCanvasModels() {
  const { modelOptions, modelsLoading, modelsErrorMsg } = useChatModelOptions({
    conversationPublicID: null,
    conversationModel: null,
  });

  // 上游模型条目 → 画布扩展条目：补齐 modelScope / userModelID / upstreamName 等适配字段
  const canvasModelOptions = React.useMemo(
    () => modelOptions.map(toCanvasModelOption),
    [modelOptions],
  );

  // 创作画布：图像（生成/编辑）与视频两类模型都进入画布模型目录
  const imageModels = React.useMemo(
    () =>
      canvasModelOptions.filter(
        (item) => item.kinds.includes("image_gen") || item.kinds.includes("image_edit"),
      ),
    [canvasModelOptions],
  );
  const videoModels = React.useMemo(
    () => canvasModelOptions.filter((item) => modelCanvasMediaType(item) === "video"),
    [canvasModelOptions],
  );
  const mediaModels = React.useMemo(
    () => [...imageModels, ...videoModels],
    [imageModels, videoModels],
  );

  // 选择态以身份键保存：同一模型名可能存在于多个接口（用户模型按上游重复）
  const [selectedModelKey, setSelectedModelKey] = React.useState<string | null>(null);
  const [selectedVideoModelKey, setSelectedVideoModelKey] = React.useState<string | null>(null);
  const resolvedSelectionRef = React.useRef(false);

  // 模型目录注入 store，供生成节点按身份键/名称解析运行时模型
  React.useEffect(() => {
    canvasStore.setModelCatalog(mediaModels);
  }, [mediaModels]);

  const selectedModel = React.useMemo<CanvasModelOption | null>(() => {
    if (imageModels.length === 0) {
      return null;
    }
    if (selectedModelKey) {
      const exact = imageModels.find((item) => canvasModelKey(item) === selectedModelKey);
      if (exact) {
        return exact;
      }
    }
    return imageModels[0];
  }, [imageModels, selectedModelKey]);

  const selectedVideoModel = React.useMemo<CanvasModelOption | null>(() => {
    if (videoModels.length === 0) {
      return null;
    }
    if (selectedVideoModelKey) {
      const exact = videoModels.find((item) => canvasModelKey(item) === selectedVideoModelKey);
      if (exact) {
        return exact;
      }
    }
    return videoModels[0];
  }, [videoModels, selectedVideoModelKey]);

  // 首次加载目录后恢复上次选择（身份键优先，兼容旧版纯名称存储），否则保持首个可用模型
  React.useEffect(() => {
    if (resolvedSelectionRef.current || mediaModels.length === 0) {
      return;
    }
    resolvedSelectionRef.current = true;
    const storedImage = findModelByStoredKey(imageModels, readStoredModelKey(CANVAS_MODEL_STORAGE_KEY));
    if (storedImage) {
      setSelectedModelKey(canvasModelKey(storedImage));
      canvasStore.setSelectedModel(storedImage, "image");
    } else if (imageModels.length > 0) {
      setSelectedModelKey(canvasModelKey(imageModels[0]));
      canvasStore.setSelectedModel(imageModels[0], "image");
    }
    const storedVideo = findModelByStoredKey(videoModels, readStoredModelKey(CANVAS_VIDEO_MODEL_STORAGE_KEY));
    if (storedVideo) {
      setSelectedVideoModelKey(canvasModelKey(storedVideo));
      canvasStore.setSelectedModel(storedVideo, "video");
    } else if (videoModels.length > 0) {
      setSelectedVideoModelKey(canvasModelKey(videoModels[0]));
      canvasStore.setSelectedModel(videoModels[0], "video");
    }
  }, [imageModels, mediaModels.length, videoModels]);

  const selectModel = React.useCallback(
    (model: CanvasModelOption, mediaType: "image" | "video" = "image") => {
      const key = canvasModelKey(model);
      if (mediaType === "video") {
        setSelectedVideoModelKey(key);
        writeStoredModelKey(CANVAS_VIDEO_MODEL_STORAGE_KEY, key);
      } else {
        setSelectedModelKey(key);
        writeStoredModelKey(CANVAS_MODEL_STORAGE_KEY, key);
      }
      canvasStore.setSelectedModel(model, mediaType);
    },
    [],
  );

  return {
    imageModels,
    videoModels,
    mediaModels,
    selectedModel,
    selectedVideoModel,
    selectModel,
    modelsLoading,
    modelsErrorMsg,
  };
}
