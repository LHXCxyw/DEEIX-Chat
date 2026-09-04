"use client";

import * as React from "react";

import { useChatModelOptions } from "@/features/chat/hooks/use-chat-model-options";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { canvasStore } from "@/features/canvas/model/canvas-store";

const CANVAS_MODEL_STORAGE_KEY = "deeix_canvas_selected_model_v1";

function readStoredModelName(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CANVAS_MODEL_STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredModelName(modelName: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CANVAS_MODEL_STORAGE_KEY, modelName);
  } catch {
    // 存储失败时静默降级
  }
}

export function useCanvasModels() {
  const { modelOptions, modelsLoading, modelsErrorMsg } = useChatModelOptions({
    conversationPublicID: null,
    conversationModel: null,
  });

  // 自动识别所有具备图像生成或图像编辑能力的模型
  const imageModels = React.useMemo(
    () =>
      modelOptions.filter(
        (item) => item.kinds.includes("image_gen") || item.kinds.includes("image_edit"),
      ),
    [modelOptions],
  );

  const [selectedModelName, setSelectedModelName] = React.useState<string | null>(null);
  const resolvedSelectionRef = React.useRef(false);

  // 模型目录注入 store，供生成节点按名称解析运行时模型
  React.useEffect(() => {
    canvasStore.setModelCatalog(imageModels);
  }, [imageModels]);

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

  // 首次加载目录后恢复上次选择，否则保持首个可用图像模型
  React.useEffect(() => {
    if (resolvedSelectionRef.current || imageModels.length === 0) {
      return;
    }
    resolvedSelectionRef.current = true;
    const stored = readStoredModelName();
    if (stored && imageModels.some((item) => item.platformModelName === stored)) {
      setSelectedModelName(stored);
      return;
    }
    setSelectedModelName(imageModels[0].platformModelName);
  }, [imageModels]);

  const selectModel = React.useCallback((platformModelName: string) => {
    setSelectedModelName(platformModelName);
    writeStoredModelName(platformModelName);
  }, []);

  return {
    imageModels,
    selectedModel,
    selectModel,
    modelsLoading,
    modelsErrorMsg,
  };
}
