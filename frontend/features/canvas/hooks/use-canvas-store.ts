"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { parseCanvasState } from "@/features/canvas/model/canvas-persist";
import { type CanvasStoreLabels, canvasStore } from "@/features/canvas/model/canvas-store";
import {
  CANVAS_CLOUD_SETTING_KEY,
  type CanvasNodeReference,
} from "@/features/canvas/model/canvas-types";
import { uploadFile } from "@/shared/api/file";
import { useAuthSession } from "@/shared/auth/auth-session-context";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import {
  loadUserSettingsSnapshot,
  updateUserSettings,
} from "@/shared/model/user-settings-store";

export type CanvasReferenceImage = CanvasNodeReference & {
  previewURL?: string;
};

export function useCanvasStore({
  getSpawnPoint,
}: {
  getSpawnPoint?: () => { x: number; y: number };
} = {}) {
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
    const labels: CanvasStoreLabels = {
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
      imageUnsupported: t("generationUnsupported"),
      noImageModels: t("noImageModels"),
      missingPromptInput: t("missingPromptInput"),
    };
    canvasStore.setLabels(labels);
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
        // 推送失败仅记录日志，不打断画布使用；本地 localStorage 始终是最新状态
        void updateUserSettings(accessToken, { [CANVAS_CLOUD_SETTING_KEY]: raw }).catch((error) => {
          console.warn("[canvas] cloud persist failed", error);
        });
      }
    };
    canvasStore.setCloudPersist((raw) => {
      pendingCloudRaw = raw;
      if (cloudTimer) {
        clearTimeout(cloudTimer);
      }
      cloudTimer = setTimeout(persistCloud, 1200);
    });
    // 页面隐藏或关闭时立即推送挂起的快照，避免防抖丢尾导致云端落后于本地
    const flushPendingCloud = () => {
      if (cloudTimer !== null) {
        clearTimeout(cloudTimer);
        cloudTimer = null;
      }
      persistCloud();
    };

    // 云端快照拉取：多端同步的另一半。推送端 ~1.6s 内落云；
    // 本端采用事件驱动拉取（切回标签页 / 窗口聚焦时），空闲时零请求。
    // seedPersistedState 内部按 savedAt 取更新的一方，云端更旧时自动回推本地，幂等无回环。
    let lastPullAt = 0;
    const pullCloud = () => {
      // 节流：切回标签页时 focus 与 visibilitychange 会先后触发，5 秒内只拉一次
      const now = Date.now();
      if (now - lastPullAt < 5000) {
        return;
      }
      // 生成中不拉取，避免云端旧快照打断进行中的任务展示；
      // 本端有未落盘变更时跳过，等防抖推送完成后再拉，防止覆盖本端编辑
      if (canvasStore.getState().generatingCount > 0 || canvasStore.hasUnsavedChanges()) {
        return;
      }
      lastPullAt = now;
      void loadUserSettingsSnapshot(accessToken, { refresh: true })
        .then((settings) => {
          const cloudState = parseCanvasState(settings[CANVAS_CLOUD_SETTING_KEY] ?? "");
          if (cloudState) {
            canvasStore.seedPersistedState(cloudState);
          }
        })
        .catch(() => {
          // 拉取失败静默跳过，下次回到前台再拉
        });
    };
    const pullOnVisible = () => {
      if (document.visibilityState === "visible") {
        pullCloud();
      }
    };

    const handlePageHide = () => {
      // 关页兜底：防抖中的变更立即落盘并进入云端推送
      canvasStore.flushPersist();
      flushPendingCloud();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        canvasStore.flushPersist();
        flushPendingCloud();
      } else {
        pullOnVisible();
      }
    };
    const handleWindowFocus = () => pullOnVisible();
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    // 初始加载强制取新鲜快照：认证层的缓存快照可能滞后，误判云端新旧会导致错误采纳
    void loadUserSettingsSnapshot(accessToken, { refresh: true }).then((settings) => {
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
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (cloudTimer) {
        clearTimeout(cloudTimer);
        persistCloud();
      }
    };
  }, [accessToken]);

  const spawnPointRef = React.useRef(getSpawnPoint);
  spawnPointRef.current = getSpawnPoint;

  const addGraphNode = React.useCallback((
    kind: Parameters<typeof canvasStore.addGraphNode>[0],
    point?: { x: number; y: number },
  ) => {
    // 调用方显式指定坐标时优先使用，否则回退到视口中心生成点
    return canvasStore.addGraphNode(kind, point ?? spawnPointRef.current?.());
  }, []);

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

  return {
    nodes: state.nodes,
    edges: state.edges,
    decorations: state.decorations,
    bookmarks: state.bookmarks,
    canvases: state.canvases,
    activeCanvasID: state.activeCanvasID,
    projectName: state.projectName,
    versions: state.versions,
    selectedDecorationIDs: state.selectedDecorationIDs,
    selectedEdgeIDs: state.selectedEdgeIDs,
    viewport: state.viewport,
    pointerMode: state.pointerMode,
    selectedNodeIDs: state.selectedNodeIDs,
    generatingCount: state.generatingCount,
    restored: state.restored,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    restoredModelName: state.restoredModelName,
    setViewportState: canvasStore.setViewport,
    resetViewport: canvasStore.resetViewport,
    fitViewport: canvasStore.fitViewport,
    setPointerMode: canvasStore.setPointerMode,
    setSelectedNodeIDs: canvasStore.setSelectedNodeIDs,
    setSelectedDecorationIDs: canvasStore.setSelectedDecorationIDs,
    setSelectedEdgeIDs: canvasStore.setSelectedEdgeIDs,
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
    addGraphNode,
    updateGraphNode: canvasStore.updateGraphNode,
    ensureNodeImagePreview: canvasStore.ensureNodeImagePreview,
    adoptNodeIntoFrame: canvasStore.adoptNodeIntoFrame,
    removeNode: canvasStore.removeNode,
    removeNodes: canvasStore.removeNodes,
    connectGraphNodes: canvasStore.connectGraphNodes,
    removeEdge: canvasStore.removeEdge,
    runGenerateNode: canvasStore.runGenerateNode,
    cancelNode: canvasStore.cancelNode,
    enqueueGraphEdit: canvasStore.enqueueGraphEdit,
    undo: canvasStore.undo,
    redo: canvasStore.redo,
    clearCanvas: canvasStore.clearCanvas,
    uploadReferenceFile,
  };
}
