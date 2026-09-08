"use client";

import * as React from "react";
import { modelCanvasMediaType } from "@/features/canvas/model/canvas-image-options";
import { canvasStore } from "@/features/canvas/model/canvas-store";
import { useChatModelOptions } from "@/features/chat/hooks/use-chat-model-options";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";

const CANVAS_MODEL_STORAGE_KEY = "deeix_canvas_selected_model_v1";
const CANVAS_VIDEO_MODEL_STORAGE_KEY = "deeix_canvas_selected_video_model_v1";

function readStoredModelName(key: string): string | null {
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

function writeStoredModelName(key: string, modelName: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, modelName);
  } catch {
    // 存储失败时静默降级
  }
}

export function useCanvasModels() {
  const { modelOptions, modelsLoading, modelsErrorMsg } = useChatModelOptions({
    conversationPublicID: null,
    conversationModel: null,
  });

  // 创作画布：图像（生成/编辑）与视频两类模型都进入画布模型目录
  const imageModels = React.useMemo(
    () =>
      modelOptions.filter(
        (item) => item.kinds.includes("image_gen") || item.kinds.includes("image_edit"),
      ),
    [modelOptions],
  );
  const videoModels = React.useMemo(
    () => modelOptions.filter((item) => modelCanvasMediaType(item) === "video"),
    [modelOptions],
  );
  const mediaModels = React.useMemo(
    () => [...imageModels, ...videoModels],
    [imageModels, videoModels],
  );

  const [selectedModelName, setSelectedModelName] = React.useState<string | null>(null);
  const [selectedVideoModelName, setSelectedVideoModelName] = React.useState<string | null>(null);
  const resolvedSelectionRef = React.useRef(false);

  // 模型目录注入 store，供生成节点按名称解析运行时模型
  React.useEffect(() => {
    canvasStore.setModelCatalog(mediaModels);
  }, [mediaModels]);

  const selectedModel = React.useMemo<ChatModelOption | null>(() => {
    if (imageModels.length === 0) {
      return null;
    }
    if (selectedModelName) {
      const exact = imageModels.find((item) => item.platformModelName === selectedModelName);
      if (exact) {
        return exact;
      }
    }
    return imageModels[0];
  }, [imageModels, selectedModelName]);

  const selectedVideoModel = React.useMemo<ChatModelOption | null>(() => {
    if (videoModels.length === 0) {
      return null;
    }
    if (selectedVideoModelName) {
      const exact = videoModels.find((item) => item.platformModelName === selectedVideoModelName);
      if (exact) {
        return exact;
      }
    }
    return videoModels[0];
  }, [videoModels, selectedVideoModelName]);

  // 首次加载目录后恢复上次选择，否则保持首个可用模型
  React.useEffect(() => {
    if (resolvedSelectionRef.current || mediaModels.length === 0) {
      return;
    }
    resolvedSelectionRef.current = true;
    const stored = readStoredModelName(CANVAS_MODEL_STORAGE_KEY);
    if (stored && imageModels.some((item) => item.platformModelName === stored)) {
      setSelectedModelName(stored);
      canvasStore.setModelName(stored, "image");
    } else if (imageModels.length > 0) {
      setSelectedModelName(imageModels[0].platformModelName);
      canvasStore.setModelName(imageModels[0].platformModelName, "image");
    }
    const storedVideo = readStoredModelName(CANVAS_VIDEO_MODEL_STORAGE_KEY);
    if (storedVideo && videoModels.some((item) => item.platformModelName === storedVideo)) {
      setSelectedVideoModelName(storedVideo);
      canvasStore.setModelName(storedVideo, "video");
    } else if (videoModels.length > 0) {
      setSelectedVideoModelName(videoModels[0].platformModelName);
      canvasStore.setModelName(videoModels[0].platformModelName, "video");
    }
  }, [imageModels, mediaModels.length, videoModels]);

  const selectModel = React.useCallback(
    (platformModelName: string, mediaType: "image" | "video" = "image") => {
      if (mediaType === "video") {
        setSelectedVideoModelName(platformModelName);
        writeStoredModelName(CANVAS_VIDEO_MODEL_STORAGE_KEY, platformModelName);
      } else {
        setSelectedModelName(platformModelName);
        writeStoredModelName(CANVAS_MODEL_STORAGE_KEY, platformModelName);
      }
      canvasStore.setModelName(platformModelName, mediaType);
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
