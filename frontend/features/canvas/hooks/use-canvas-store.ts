"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { canvasStore } from "@/features/canvas/model/canvas-store";
import { parseCanvasState } from "@/features/canvas/model/canvas-persist";
import {
  CANVAS_CLOUD_SETTING_KEY,
  type CanvasNodeReference,
} from "@/features/canvas/model/canvas-types";
import type { ConversationOptions } from "@/shared/api/conversation.types";
import { uploadFile } from "@/shared/api/file";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { useAuthSession } from "@/shared/auth/auth-session-context";
import {
  loadUserSettingsSnapshot,
  updateUserSettings,
} from "@/shared/model/user-settings-store";

export type CanvasReferenceImage = CanvasNodeReference & {
  previewURL?: string;
};

const EMPTY_OPTIONS: ConversationOptions = {};

export function useCanvasStore({
  selectedModel,
  getSpawnPoint,
}: {
  selectedModel: ChatModelOption | null;
  getSpawnPoint?: () => { x: number; y: number };
}) {
  const t = useTranslations("canvas");
  const tMediaStatus = useTranslations("chat.submit");
  const { accessToken } = useAuthSession();

  const state = React.useSyncExternalStore(
    canvasStore.subscribe,
    canvasStore.getState,
    canvasStore.getServerState,
  );

  // 生成流程所需文案随语言变化同步到 store
  React.useEffect(() => {
    canvasStore.setLabels({
      conversationTitle: t("conversationTitle"),
      needLogin: t("needLogin"),
      conversationCreateFailed: t("conversationCreateFailed"),
      nodePreparing: t("nodePreparing"),
      nodeSavingLocal: t("nodeSavingLocal"),
      nodeGenerationInterrupted: t("nodeGenerationInterrupted"),
      statusQueued: tMediaStatus("mediaStatus.queued"),
      statusRunning: tMediaStatus("mediaStatus.running"),
      statusSavingArtifact: tMediaStatus("mediaStatus.savingArtifact"),
      generateFailed: t("generateFailed"),
      canceled: t("canceled"),
      moderationBlocked: t("moderationBlocked"),
      noImageOutput: t("noImageOutput"),
      editReferenceRequired: t("editReferenceRequired"),
      editUnsupported: t("editUnsupported"),
      chatCapabilityRequired: t("chatCapabilityRequired"),
      imageUnsupported: t("generationUnsupported"),
    });
  }, [t, tMediaStatus]);

  // 登录用户优先恢复云端状态；云端不可用或无有效状态时回退本地记录。
  React.useEffect(() => {
    let active = true;
    if (!accessToken) {
      canvasStore.setCloudPersist(null);
      canvasStore.restore();
      return () => {
        active = false;
      };
    }

    let cloudTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingCloudRaw = "";
    const persistCloud = () => {
      cloudTimer = null;
      const raw = pendingCloudRaw;
      pendingCloudRaw = "";
      if (raw) {
        void updateUserSettings(accessToken, { [CANVAS_CLOUD_SETTING_KEY]: raw }).catch(() => undefined);
      }
    };
    canvasStore.setCloudPersist((raw) => {
      pendingCloudRaw = raw;
      if (cloudTimer) {
        clearTimeout(cloudTimer);
      }
      cloudTimer = setTimeout(persistCloud, 1200);
    });
    void loadUserSettingsSnapshot(accessToken).then((settings) => {
      if (!active || canvasStore.getState().restored) {
        return;
      }
      const cloudState = parseCanvasState(settings[CANVAS_CLOUD_SETTING_KEY] ?? "");
      if (cloudState) {
        canvasStore.seedPersistedState(cloudState);
      } else {
        canvasStore.restore();
        canvasStore.pushCurrentStateToCloud();
      }
    });

    return () => {
      active = false;
      canvasStore.setCloudPersist(null);
      if (cloudTimer) {
        clearTimeout(cloudTimer);
        persistCloud();
      }
    };
  }, [accessToken]);

  React.useEffect(() => {
    canvasStore.setModelName(selectedModel?.platformModelName ?? null);
  }, [selectedModel]);

  const modelName = selectedModel?.platformModelName ?? "";
  const imageOptions = state.imageOptions[modelName] ?? EMPTY_OPTIONS;

  const setImageOptions = React.useCallback(
    (options: ConversationOptions) => {
      if (!modelName) {
        return;
      }
      canvasStore.setImageOptions(modelName, options);
    },
    [modelName],
  );

  const uploadReferenceFile = React.useCallback(
    async (file: File): Promise<CanvasReferenceImage | null> => {
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("needLogin"));
        return null;
      }
      try {
        const result = await uploadFile(token, file, { purpose: "conversation_attachment" });
        return {
          fileID: result.file.fileID,
          fileName: result.file.fileName,
          mimeType: result.file.mimeType,
          sizeBytes: result.file.sizeBytes,
          previewURL: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        };
      } catch {
        toast.error(t("uploadFailed"));
        return null;
      }
    },
    [t],
  );

  const generate = React.useCallback(
    (prompt: string, reference?: CanvasReferenceImage | null, parentID?: string | null) => {
      if (!selectedModel) {
        toast.error(t("noImageModels"));
        return;
      }
      void canvasStore.generate({
        prompt,
        model: selectedModel,
        imageOptions,
        reference: reference
          ? {
            fileID: reference.fileID,
            fileName: reference.fileName,
            mimeType: reference.mimeType,
            sizeBytes: reference.sizeBytes,
          }
          : null,
        parentID: parentID ?? null,
        spawnPoint: getSpawnPoint?.(),
      });
    },
    [getSpawnPoint, imageOptions, selectedModel, t],
  );

  const retryNode = React.useCallback(
    (nodeID: string) => {
      if (!selectedModel) {
        toast.error(t("noImageModels"));
        return;
      }
      void canvasStore.retryNode(nodeID, selectedModel);
    },
    [selectedModel, t],
  );

  return {
    nodes: state.nodes,
    viewport: state.viewport,
    conversationID: state.conversationID,
    pointerMode: state.pointerMode,
    selectedNodeIDs: state.selectedNodeIDs,
    generatingCount: state.generatingCount,
    restored: state.restored,
    imageOptions,
    setImageOptions,
    setViewportState: canvasStore.setViewport,
    resetViewport: canvasStore.resetViewport,
    fitViewport: canvasStore.fitViewport,
    setPointerMode: canvasStore.setPointerMode,
    setSelectedNodeIDs: canvasStore.setSelectedNodeIDs,
    moveNodes: canvasStore.moveNodes,
    removeNode: canvasStore.removeNode,
    cancelNode: canvasStore.cancelNode,
    clearCanvas: canvasStore.clearCanvas,
    retryNode,
    generate,
    uploadReferenceFile,
  };
}
