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
      if (!active) {
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
    (prompt: string, references: CanvasReferenceImage[] = [], parentID?: string | null, maskReference?: CanvasReferenceImage | null, operation?: "generate" | "edit" | "inpaint" | "outpaint" | "crop", optionsOverride?: ConversationOptions, modelOverride?: ChatModelOption) => {
      const model = modelOverride ?? selectedModel;
      if (!model) {
        toast.error(t("noImageModels"));
        return;
      }
      void canvasStore.generate({
        prompt,
        model,
        imageOptions: optionsOverride ?? imageOptions,
        references: references.map(({ fileID, fileName, mimeType, sizeBytes }) => ({
          fileID,
          fileName,
          mimeType,
          sizeBytes,
        })),
        maskReference: maskReference
          ? {
            fileID: maskReference.fileID,
            fileName: maskReference.fileName,
            mimeType: maskReference.mimeType,
            sizeBytes: maskReference.sizeBytes,
          }
          : null,
        parentID: parentID ?? null,
        operation,
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
    decorations: state.decorations,
    bookmarks: state.bookmarks,
    canvases: state.canvases,
    activeCanvasID: state.activeCanvasID,
    projectName: state.projectName,
    versions: state.versions,
    selectedDecorationIDs: state.selectedDecorationIDs,
    viewport: state.viewport,
    conversationID: state.conversationID,
    pointerMode: state.pointerMode,
    selectedNodeIDs: state.selectedNodeIDs,
    generatingCount: state.generatingCount,
    restored: state.restored,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    imageOptions,
    setImageOptions,
    setViewportState: canvasStore.setViewport,
    resetViewport: canvasStore.resetViewport,
    fitViewport: canvasStore.fitViewport,
    setPointerMode: canvasStore.setPointerMode,
    setSelectedNodeIDs: canvasStore.setSelectedNodeIDs,
    setSelectedDecorationIDs: canvasStore.setSelectedDecorationIDs,
    setProjectName: canvasStore.setProjectName,
    addCanvas: canvasStore.addCanvas,
    switchCanvas: canvasStore.switchCanvas,
    renameCanvas: canvasStore.renameCanvas,
    removeCanvas: canvasStore.removeCanvas,
    addDecoration: canvasStore.addDecoration,
    updateDecoration: canvasStore.updateDecoration,
    moveDecoration: canvasStore.moveDecoration,
    removeSelected: canvasStore.removeSelected,
    groupSelected: canvasStore.groupSelected,
    ungroupSelected: canvasStore.ungroupSelected,
    toggleLockSelected: canvasStore.toggleLockSelected,
    arrangeSelected: canvasStore.arrangeSelected,
    addBookmark: canvasStore.addBookmark,
    goToBookmark: canvasStore.goToBookmark,
    removeBookmark: canvasStore.removeBookmark,
    createVersion: canvasStore.createVersion,
    restoreVersion: canvasStore.restoreVersion,
    exportProject: canvasStore.exportProject,
    importProject: canvasStore.importProject,
    applyTemplate: canvasStore.applyTemplate,
    beginNodeMove: canvasStore.beginNodeMove,
    moveNodes: canvasStore.moveNodes,
    endNodeMove: canvasStore.endNodeMove,
    removeNode: canvasStore.removeNode,
    removeNodes: canvasStore.removeNodes,
    undo: canvasStore.undo,
    redo: canvasStore.redo,
    cancelNode: canvasStore.cancelNode,
    clearCanvas: canvasStore.clearCanvas,
    retryNode,
    generate,
    uploadReferenceFile,
  };
}
