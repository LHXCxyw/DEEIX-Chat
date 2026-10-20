"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { parseCanvasState } from "@/features/canvas/model/canvas-persist";
import { type CanvasStoreLabels, canvasStore } from "@/features/canvas/model/canvas-store";
import type { CanvasNodeReference } from "@/features/canvas/model/canvas-types";
import { getCanvasState, putCanvasState } from "@/shared/api/canvas-state";
import { uploadFile } from "@/shared/api/file";
import { useAuthSession } from "@/shared/auth/auth-session-context";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

// 画布快照推送防抖：变更停止后写入服务端，避免拖动过程中高频提交
const CLOUD_PERSIST_DEBOUNCE_MS = 1200;
// 云端拉取节流：切回标签页时 focus 与 visibilitychange 会先后触发，5 秒内只拉一次
const CLOUD_PULL_THROTTLE_MS = 5000;

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
      statusVideoQueued: tMediaStatus("mediaStatus.videoQueued"),
      statusVideoRunning: tMediaStatus("mediaStatus.videoRunning"),
      statusVideoSavingArtifact: tMediaStatus("mediaStatus.videoSavingArtifact"),
      nodeProgress: t("nodeProgress"),
      generateFailed: t("generateFailed"),
      canceled: t("canceled"),
      moderationBlocked: t("moderationBlocked"),
      noImageOutput: t("noImageOutput"),
      noVideoOutput: t("noVideoOutput"),
      noVideoModels: t("noVideoModels"),
      editReferenceRequired: t("editReferenceRequired"),
      editUnsupported: t("editUnsupported"),
      imageUnsupported: t("generationUnsupported"),
      videoUnsupported: t("videoUnsupported"),
      videoTooManyReferences: t("videoTooManyReferences"),
      noImageModels: t("noImageModels"),
      missingPromptInput: t("missingPromptInput"),
      videoPromptRequired: t("videoPromptRequired"),
      nodeRequery: t("nodeRequery"),
      requeryStarted: t("requeryStarted"),
      requeryPending: t("requeryPending"),
      requeryTimeout: t("requeryTimeout"),
      requeryUnavailable: t("requeryUnavailable"),
      requeryRecovered: t("requeryRecovered"),
      artifactSavePending: t("artifactSavePending"),
      artifactRetrySaving: t("artifactRetrySaving"),
      artifactRetryFailed: t("artifactRetryFailed"),
      artifactRecovered: t("artifactRecovered"),
      artifactExpired: t("artifactExpired"),
    };
    canvasStore.setLabels(labels);
  }, [t, tMediaStatus]);

  // 刷新恢复：对持久化了运行状态的节点走三层兜底（挂流 → 查消息 → 标记中断）
  React.useEffect(() => {
    if (!accessToken) {
      return;
    }
    if (!canvasStore.getState().restored) {
      canvasStore.restore();
    }
    void canvasStore.resumePendingGenerations();
  }, [accessToken]);

  // 登录用户走服务端权威同步：打开与切回前台都读服务端，改动防抖写回。
  // 服务端是唯一事实来源，本地 localStorage 仅作首屏缓存与离线回退。
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
      if (!raw) {
        return;
      }
      // 推送失败仅记录日志，不打断画布使用；本地 localStorage 仍保留最新内容
      void putCanvasState(accessToken, raw)
        .then((snapshot) => {
          canvasStore.markSynced(snapshot.updatedAt);
        })
        .catch((error) => {
          console.warn("[canvas] cloud persist failed", error);
        });
    };
    canvasStore.setCloudPersist((raw) => {
      pendingCloudRaw = raw;
      if (cloudTimer) {
        clearTimeout(cloudTimer);
      }
      cloudTimer = setTimeout(persistCloud, CLOUD_PERSIST_DEBOUNCE_MS);
    });
    // 页面隐藏或关闭时立即推送挂起的快照，避免防抖丢尾导致服务端落后于本地
    const flushPendingCloud = () => {
      if (cloudTimer !== null) {
        clearTimeout(cloudTimer);
        cloudTimer = null;
      }
      persistCloud();
    };

    // 云端拉取：仅在本地没有未落盘变更时进行，避免打断正在进行的编辑。
    // 服务端 updatedAt 比本端已同步版本新，说明其他设备写过，此时才采纳。
    let lastPullAt = 0;
    const pullCloud = () => {
      const now = Date.now();
      if (now - lastPullAt < CLOUD_PULL_THROTTLE_MS) {
        return;
      }
      // 生成中不拉取，避免云端快照打断进行中的任务展示；
      // 本端有未落盘变更或推送挂起时跳过，等本端写入完成后再拉，避免刚做的编辑被云端覆盖
      if (
        canvasStore.getState().generatingCount > 0
        || canvasStore.hasUnsavedChanges()
        || cloudTimer !== null
      ) {
        return;
      }
      lastPullAt = now;
      void getCanvasState(accessToken)
        .then((snapshot) => {
          if (!snapshot.state || snapshot.updatedAt <= canvasStore.getSyncedAt()) {
            return;
          }
          const cloudState = parseCanvasState(snapshot.state);
          if (!cloudState) {
            return;
          }
          canvasStore.seedPersistedState(cloudState);
          canvasStore.markSynced(snapshot.updatedAt);
          // 采纳的云端快照可能含运行中节点，同样需要恢复
          void canvasStore.resumePendingGenerations();
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

    // 首次加载以服务端为准：有快照即采用；从未保存过时用本地内容初始化服务端
    void getCanvasState(accessToken)
      .then((snapshot) => {
        if (!active) {
          return;
        }
        const cloudState = snapshot.state ? parseCanvasState(snapshot.state) : null;
        if (cloudState) {
          canvasStore.seedPersistedState(cloudState);
          canvasStore.markSynced(snapshot.updatedAt);
        } else {
          canvasStore.restore();
          canvasStore.pushCurrentStateToCloud();
        }
        void canvasStore.resumePendingGenerations();
      })
      .catch(() => {
        // 服务端不可用时回退本地内容，回到前台后再同步
        if (active) {
          canvasStore.restore();
          void canvasStore.resumePendingGenerations();
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
    mediaType?: Parameters<typeof canvasStore.addGraphNode>[2],
  ) => {
    // 调用方显式指定坐标时优先使用，否则回退到视口中心生成点
    return canvasStore.addGraphNode(kind, point ?? spawnPointRef.current?.(), mediaType);
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
    viewMode: state.viewMode,
    selectedNodeIDs: state.selectedNodeIDs,
    generatingCount: state.generatingCount,
    restored: state.restored,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    restoredModelName: state.restoredModelName,
    restoredVideoModelName: state.restoredVideoModelName,
    restoredModelKey: state.restoredModelKey,
    restoredVideoModelKey: state.restoredVideoModelKey,
    resumePendingGenerations: canvasStore.resumePendingGenerations,
    setViewportState: canvasStore.setViewport,
    resetViewport: canvasStore.resetViewport,
    fitViewport: canvasStore.fitViewport,
    setPointerMode: canvasStore.setPointerMode,
    setViewMode: canvasStore.setViewMode,
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
    toggleLockSelected: canvasStore.toggleLockSelected,
    addBookmark: canvasStore.addBookmark,
    goToBookmark: canvasStore.goToBookmark,
    removeBookmark: canvasStore.removeBookmark,
    createVersion: canvasStore.createVersion,
    restoreVersion: canvasStore.restoreVersion,
    exportProject: canvasStore.exportProject,
    importProject: canvasStore.importProject,
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
    connectToNewNode: canvasStore.connectToNewNode,
    removeEdge: canvasStore.removeEdge,
    runGenerateNode: canvasStore.runGenerateNode,
    cancelNode: canvasStore.cancelNode,
    requeryGenerateNode: canvasStore.requeryGenerateNode,
    requeryOutputNode: canvasStore.requeryOutputNode,
    retryOutputNodeSave: canvasStore.retryOutputNodeSave,
    enqueueGraphEdit: canvasStore.enqueueGraphEdit,
    undo: canvasStore.undo,
    redo: canvasStore.redo,
    clearCanvas: canvasStore.clearCanvas,
    uploadReferenceFile,
  };
}
