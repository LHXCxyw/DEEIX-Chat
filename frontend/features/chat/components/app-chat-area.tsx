"use client";

import { FileCode2, Glasses, MessageSquare, PanelRightOpen, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ConversationShareDialog,
  sharePatchFromDTO,
  useSidebarConversationField,
} from "@/entities/conversation";
import { ChatArea, ChatAreaLoadError, ChatAreaSkeleton } from "@/features/chat/components/sections/chat-area";
import { ChatArtifactWorkspace } from "@/features/chat/components/sections/chat-artifact";
import { ChatEmptyState } from "@/features/chat/components/sections/chat-empty";
import { ChatInput } from "@/features/chat/components/sections/chat-input";
import { ChatProjectWorkspace, collectProjectFileChanges, type ProjectChange, ProjectFileEditor, type ProjectFileTab, type ProjectWorkspaceHandle, reconstructProjectFileInitial } from "@/features/chat/components/sections/chat-project-workspace";
import { ChatScreenshotPreviewDialog } from "@/features/chat/components/sections/chat-screenshot-preview-dialog";
import { TemporaryChatModeControl } from "@/features/chat/components/temporary-chat-mode-control";
import { useChatSession } from "@/features/chat/context/chat-session-context";
import { useChatArtifactResize } from "@/features/chat/hooks/use-chat-artifact-resize";
import { useChatArtifacts } from "@/features/chat/hooks/use-chat-artifacts";
import { useChatAttachments } from "@/features/chat/hooks/use-chat-attachments";
import { useChatComposerSelection } from "@/features/chat/hooks/use-chat-composer-selection";
import {
  resolveConversationComposerKey,
  useChatComposerState,
} from "@/features/chat/hooks/use-chat-composer-state";
import { useChatConversationActions } from "@/features/chat/hooks/use-chat-conversation-actions";
import { useChatConversationDefaults } from "@/features/chat/hooks/use-chat-conversation-defaults";
import { useChatData } from "@/features/chat/hooks/use-chat-data";
import { useChatFileDrag } from "@/features/chat/hooks/use-chat-file-drag";
import { useChatMCPTools } from "@/features/chat/hooks/use-chat-mcp-tools";
import { useChatMediaAttachmentActions } from "@/features/chat/hooks/use-chat-media-attachment-actions";
import { useChatModelOptionState } from "@/features/chat/hooks/use-chat-model-option-state";
import { useChatModelOptions } from "@/features/chat/hooks/use-chat-model-options";
import { useChatRuntime } from "@/features/chat/hooks/use-chat-runtime";
import { useChatScreenshot } from "@/features/chat/hooks/use-chat-screenshot";
import { useChatScreenshotPreview } from "@/features/chat/hooks/use-chat-screenshot-preview";
import { useChatTemporaryRuntime } from "@/features/chat/hooks/use-chat-temporary-runtime";
import { useChatViewerProfile } from "@/features/chat/hooks/use-chat-viewer-profile";
import { useChatVisualPrompt } from "@/features/chat/hooks/use-chat-visual-prompt";
import { filterAvailableMCPToolIDs } from "@/features/chat/model/chat-mcp-tool-defaults";
import type { ChatAreaMessage, } from "@/features/chat/types/messages";
import { useSettingsChatPreferences } from "@/features/settings";
import { cn } from "@/lib/utils";
import {
  deleteProjectFile,
  downloadProjectArchive,
  fetchProjectFileContent,
  getConversation,
  getProjectWorkspace,
  type ProjectWorkspaceFileDTO,
  saveProjectFile,
} from "@/shared/api/conversation";
import type { ConversationDTO, ConversationOptions } from "@/shared/api/conversation.types";
import { useAuthSession } from "@/shared/auth/auth-session-context";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { DeleteFilesOption } from "@/shared/components/delete-files-option";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import {
  hasMultipleImageAttachmentProcessors,
  normalizeImageAttachmentProcessorSelection,
} from "@/shared/lib/mcp-tool-selection";
import { resolveChatContentWidthClassName } from "@/shared/model/chat-content-width";

const EMPTY_CONVERSATION_OPTIONS: ConversationOptions = {};
const EMPTY_LIST: never[] = [];
const TOP_LOAD_OLDER_MESSAGES_THRESHOLD_PX = 48;
const PROJECT_PANEL_OPEN_KEY = "deeix-chat:project-panel-open";
const PROJECT_PANEL_WIDTH_KEY = "deeix-chat:project-panel-width";

function upsertIn(previous: ProjectFileTab[], tab: ProjectFileTab): ProjectFileTab[] {
  const index = previous.findIndex((item) => item.key === tab.key);
  return index < 0 ? [...previous, tab] : previous.map((item) => (item.key === tab.key ? tab : item));
}

export function AppChatArea() {
  const t = useTranslations("chat");
  const tRecent = useTranslations("recent");
  const tScreenshot = useTranslations("chat.screenshot");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuthSession();
  const temporaryMode = searchParams.get("temporary") === "true";
  const routeConversationID = temporaryMode ? null : searchParams.get("conversation_id")?.trim() || null;
  const routeProjectID = temporaryMode ? null : searchParams.get("project_id")?.trim() || null;
  const {
    detachConversationRun,
    finishConversationRun,
    newConversationRevision,
    newConversationProjectID: requestedNewConversationProjectID,
    registerConversationRun,
    requestNewConversation,
  } = useChatSession();
  const [locallyCreatedConversationID, setLocallyCreatedConversationID] = React.useState<string | null>(null);
  const [newConversationOverride, setNewConversationOverride] = React.useState<{
    ignoredConversationID: string | null;
  } | null>(null);
  const previousNewConversationRevisionRef = React.useRef(newConversationRevision);

  React.useEffect(() => {
    if (previousNewConversationRevisionRef.current === newConversationRevision) {
      return;
    }
    previousNewConversationRevisionRef.current = newConversationRevision;
    setLocallyCreatedConversationID(null);
    setNewConversationOverride({
      ignoredConversationID: routeConversationID,
    });
  }, [newConversationRevision, routeConversationID]);

  React.useEffect(() => {
    if (routeConversationID) {
      setLocallyCreatedConversationID(null);
    }
  }, [routeConversationID]);

  React.useEffect(() => {
    setNewConversationOverride((prev) =>
      prev && routeConversationID !== prev.ignoredConversationID ? null : prev,
    );
  }, [routeConversationID]);

  const resolvedRouteConversationID = temporaryMode
    ? null
    : routeConversationID ?? locallyCreatedConversationID;
  const conversationID =
    newConversationOverride && resolvedRouteConversationID === newConversationOverride.ignoredConversationID
      ? null
      : resolvedRouteConversationID;
  const onNewConversationFromLoadError = React.useCallback(() => {
    const projectID = routeProjectID ?? "";
    requestNewConversation({ projectID });
    router.push(projectID ? `/chat?project_id=${encodeURIComponent(projectID)}` : "/chat");
  }, [requestNewConversation, routeProjectID, router]);
  const activeGenerationRunsRef = React.useRef<Set<string>>(new Set());
  // Set 的原地增删不会触发 effect，revision 用于同步断流恢复判断。
  const [activeGenerationRunsRevision, setActiveGenerationRunsRevision] = React.useState(0);
  const onActiveGenerationRunsChange = React.useCallback(() => {
    setActiveGenerationRunsRevision((current) => current + 1);
  }, []);
  const {
    autoExpandThinking,
    autoExpandToolCalls,
    autoGenerateLabels,
    deleteFilesByDefault,
    loaded: chatPreferencesLoaded,
    reuseModelOptions,
  } = useSettingsChatPreferences();
  const items = useSidebarConversationField("items");
  const projects = useSidebarConversationField("projects");
  const projectsLoading = useSidebarConversationField("projectsLoading");
  const prependNewConversation = useSidebarConversationField("prependNewConversation");
  const touchByPublicID = useSidebarConversationField("touchByPublicID");
  const renameByPublicID = useSidebarConversationField("renameByPublicID");
  const upsertConversation = useSidebarConversationField("upsertConversation");
  const {
    cancelResumedGeneration,
    conversationPublicID: messageDataConversationID,
    loading,
    loadingOlder,
    errorMsg,
    hasOlder,
    loadOlderMessages,
    messages,
    reload,
    replaceMessage,
    resumingActivityLabel,
    resumingRunID,
  } = useChatData(conversationID, {
    activeGenerationRunsRef,
    activeGenerationRunsRevision,
    onConversationRunFinished: finishConversationRun,
  });
  const { greetingTitle } = useChatViewerProfile();
  const activeConversation = React.useMemo(() => {
    if (!conversationID) {
      return null;
    }
    return items.find((item) => item.publicID === conversationID) ?? null;
  }, [conversationID, items]);
  const [loadedConversation, setLoadedConversation] = React.useState<ConversationDTO | null>(null);
  React.useEffect(() => {
    const normalizedConversationID = conversationID?.trim() || "";
    if (!normalizedConversationID || activeConversation?.publicID === normalizedConversationID) {
      setLoadedConversation(null);
      return;
    }

    let cancelled = false;
    async function loadConversation() {
      const token = await resolveAccessToken();
      if (!token) {
        return;
      }
      const item = await getConversation(token, normalizedConversationID);
      if (cancelled) {
        return;
      }
      setLoadedConversation(item);
    }

    void loadConversation().catch(() => {
      if (!cancelled) {
        setLoadedConversation(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeConversation?.publicID, conversationID]);
  const currentConversation =
    activeConversation ?? (loadedConversation?.publicID === conversationID ? loadedConversation : null);
  const activeRouteProject = React.useMemo(() => {
    if (!routeProjectID || conversationID) {
      return null;
    }
    return projects.find((item) => item.publicID === routeProjectID) ?? null;
  }, [conversationID, projects, routeProjectID]);
  const newConversationProjectID = !conversationID ? routeProjectID ?? requestedNewConversationProjectID : "";
  const newConversationProject = React.useMemo(
    () => projects.find((item) => item.publicID === newConversationProjectID) ?? null,
    [newConversationProjectID, projects],
  );
  const newConversationDefaultsPending = Boolean(newConversationProjectID && projectsLoading);
  // 首次对话时尚无会话，输入框工具栏设置的系统提示词暂存于此，随首条消息创建会话时一并写入。
  const [pendingSystemPrompt, setPendingSystemPrompt] = React.useState("");
  const pendingSystemPromptRef = React.useRef(pendingSystemPrompt);
  pendingSystemPromptRef.current = pendingSystemPrompt;
  const prependNewConversationInContext = React.useCallback(
    async (platformModelName?: string) => {
      const pendingPrompt = pendingSystemPromptRef.current.trim();
      const created = await prependNewConversation(platformModelName, newConversationProjectID || undefined, pendingPrompt || undefined);
      if (created && pendingPrompt) {
        setPendingSystemPrompt("");
      }
      return created;
    },
    [newConversationProjectID, prependNewConversation],
  );

  const handleConversationForked = React.useCallback(
    async (forked: ConversationDTO) => {
      const baseTitle = forked.title?.trim() || "";
      let listed = false;
      if (baseTitle) {
        try {
          const suffix = t("messages.forkTitle", { title: "" });
          const title = `${Array.from(baseTitle)
            .slice(0, Math.max(0, 255 - Array.from(suffix).length))
            .join("")}${suffix}`;
          listed = Boolean(await renameByPublicID(forked.publicID, title));
        } catch {
          listed = false;
        }
      }
      if (!listed) {
        upsertConversation(forked);
      }
      router.push(`/chat?conversation_id=${forked.publicID}`);
    },
    [renameByPublicID, router, t, upsertConversation],
  );

  const {
    modelOptions,
    refreshModelCatalog,
    refreshModelOption,
    modelsLoading,
    modelsErrorMsg,
    sendShortcut,
    restoreDraftOnFailure,
    preserveConversationDrafts,
    inputHeight,
    contentWidth,
    markdownRender,
    showModelInfo,
    showLatency,
    showTokenUsage,
    showBillingCost,
    billingDisplayCurrency,
    billingDisplayUsdToCnyRate,
    modelOptionPolicy,
    mcpMaxSelectedTools,
    selectedPlatformModelName,
    setSelectedPlatformModelName,
  } = useChatModelOptions({
    conversationPublicID: conversationID,
    conversationModel: currentConversation?.model ?? null,
    newConversationDefaultModel: newConversationProject?.defaultModel ?? "",
    newConversationDefaultsPending,
    resetToken: newConversationRevision,
  });
  const {
    conversationKey,
    draft,
    attachments,
    setDraft,
    setAttachments,
    appendAttachmentsForKey,
  } = useChatComposerState(conversationID, {
    preserveDrafts: preserveConversationDrafts,
    storageScope: user?.publicID ?? "",
    transient: temporaryMode,
  });
  const selectionConversationKey = resolveConversationComposerKey(conversationID);
  const selectedModel = React.useMemo(
    () => modelOptions.find((item) => item.platformModelName === selectedPlatformModelName) ?? null,
    [modelOptions, selectedPlatformModelName],
  );
  const modelOptionPolicyDisabled = modelOptionPolicy?.mode?.trim() === "disabled";
  const refreshModelCatalogForComposer = React.useCallback(async () => {
    await refreshModelCatalog();
  }, [refreshModelCatalog]);
  const {
    options,
    setModelOptions,
    resetModelOptions,
    restoreBackendDefaultModelOptions,
  } = useChatModelOptionState({
    selectedModel,
    selectedPlatformModelName,
    chatPreferencesLoaded,
    reuseModelOptions,
    refreshModelOption,
  });
  const {
    selectedToolIDs,
    selectedSkills,
    selectedKnowledgeBaseIDs,
    setSelectedToolIDs,
    setSelectedSkills,
    setSelectedKnowledgeBaseIDs,
  } = useChatComposerSelection({
    conversationKey: selectionConversationKey,
    createdConversationID: locallyCreatedConversationID,
    resetToken: newConversationRevision,
    hasConversation: Boolean(conversationID),
    storageScope: user?.publicID ?? "",
  });
  const {
    availableTools,
    toolsLoading,
    defaultToolIDs,
    defaultToolsReady,
    onDefaultToolIDsChange,
  } = useChatMCPTools({
    mcpMaxSelectedTools,
    selectedToolIDs,
    setSelectedToolIDs,
  });
  const newConversationSelectionKey = `${newConversationRevision}:${newConversationProjectID || "unassigned"}`;
  const warnedUnavailableProjectModelRef = React.useRef("");
  React.useEffect(() => {
    const configuredModel = newConversationProject?.defaultModel.trim() ?? "";
    if (
      conversationID ||
      !configuredModel ||
      modelsLoading ||
      modelOptions.length === 0 ||
      modelsErrorMsg.trim() ||
      modelOptions.some((model) => model.platformModelName === configuredModel)
    ) {
      return;
    }

    const warningKey = `${newConversationSelectionKey}:${configuredModel}`;
    if (warnedUnavailableProjectModelRef.current === warningKey) {
      return;
    }
    warnedUnavailableProjectModelRef.current = warningKey;
    toast.warning(t("projectDefaultModelUnavailable", { model: configuredModel }));
  }, [
    conversationID,
    modelOptions,
    modelsErrorMsg,
    modelsLoading,
    newConversationProject?.defaultModel,
    newConversationSelectionKey,
    t,
  ]);
  const newConversationDefaultMCPToolIDs = React.useMemo(
    () => normalizeImageAttachmentProcessorSelection(
      filterAvailableMCPToolIDs(
        newConversationProject?.mcpDefaultMode === "custom"
          ? newConversationProject.defaultMCPToolIDs
          : defaultToolIDs,
        availableTools,
        mcpMaxSelectedTools,
      ),
      availableTools,
    ),
    [availableTools, defaultToolIDs, mcpMaxSelectedTools, newConversationProject],
  );
  const newConversationDefaultSkillIDs = React.useMemo(
    () => (newConversationProject?.defaultSkillIDs ?? []).slice(0, mcpMaxSelectedTools),
    [mcpMaxSelectedTools, newConversationProject],
  );
  const newConversationDefaultKnowledgeBaseIDs = React.useMemo(
    () => (newConversationProject?.defaultKnowledgeBaseIDs ?? []).slice(0, 8),
    [newConversationProject],
  );
  const { onSelectedKnowledgeBasesChange, onSelectedSkillsChange, onSelectedToolsChange: applySelectedToolsChange } = useChatConversationDefaults({
    conversationID,
    contextKey: newConversationSelectionKey,
    defaultsPending: newConversationDefaultsPending,
    defaultMCPToolIDs: newConversationDefaultMCPToolIDs,
    defaultSkillIDs: newConversationDefaultSkillIDs,
    defaultKnowledgeBaseIDs: newConversationDefaultKnowledgeBaseIDs,
    mcpDefaultsPending: toolsLoading || !defaultToolsReady,
    setSelectedToolIDs,
    setSelectedSkills,
    setSelectedKnowledgeBaseIDs,
  });
  const onSelectedToolsChange = React.useCallback((nextToolIDs: number[]) => {
    if (hasMultipleImageAttachmentProcessors(nextToolIDs, availableTools)) {
      toast.error(t("composer.mcpImageProcessorLimitTitle"), {
        description: t("composer.mcpImageProcessorLimitDescription"),
      });
      return;
    }
    applySelectedToolsChange(nextToolIDs);
  }, [applySelectedToolsChange, availableTools, t]);
  const htmlVisualPrompt = useChatVisualPrompt();

  const {
    uploading,
    uploadingAttachments,
    maxFilesPerMessage,
    fileMode,
    ragAvailable,
    ragAvailabilityReason,
    releaseAttachments,
    transferAttachments,
    onRemoveAttachment,
    onUploadFiles,
    onCaptureScreenshot,
  } = useChatAttachments({
    conversationKey,
    attachments,
    setAttachments,
    appendAttachmentsForKey,
    temporary: temporaryMode,
  });

  const onTemporaryAttachmentsConsumed = React.useCallback((items: typeof attachments) => {
    transferAttachments(items);
    const consumedIDs = new Set(items.map((item) => item.fileID));
    setAttachments((current) => current.filter((item) => !consumedIDs.has(item.fileID)));
  }, [setAttachments, transferAttachments]);

  const {
    currentLeafMessage,
    onCycleMessageBranch,
    onEditAssistantMessage,
    onEditUserMessage,
    onContinueAssistantMessage,
    onForkMessage,
    onDeleteMessage,
    onRetryAssistantMessage,
    onRetryUserMessage,
    onSendMessage,
    onStopMessage,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onGuideQueuedMessage,
    queuedMessages,
    sending,
    visibleMessageCount,
    visibleMessages,
    isConversationMode,
  } = useChatRuntime({
    conversationID,
    resetToken: newConversationRevision,
    messages,
    activeConversation: currentConversation,
    selectedPlatformModelName,
    modelOptions,
    selectedToolIDs,
    selectedSkills,
    selectedKnowledgeBaseIDs,
    htmlVisualPromptEnabled: htmlVisualPrompt.enabled,
    options: modelOptionPolicyDisabled ? EMPTY_CONVERSATION_OPTIONS : options,
    draft,
    attachments,
    maxFilesPerMessage,
    uploading,
    restoreDraftOnFailure,
    autoGenerateLabels,
    prependNewConversation: prependNewConversationInContext,
    onConversationCreated: setLocallyCreatedConversationID,
    onConversationForked: handleConversationForked,
    touchByPublicID,
    reload,
    replaceMessage,
    setDraft,
    setAttachments,
    releaseAttachments,
    transferAttachments,
    activeGenerationRunsRef,
    activeGenerationRunsRevision,
    onActiveGenerationRunsChange,
    onConversationRunDetached: detachConversationRun,
    onConversationRunFinished: finishConversationRun,
    onConversationRunStarted: registerConversationRun,
    resumingActivityLabel,
    resumingRunID,
  });
  const generating = sending;
  const uploadDropDisabled = loading || uploading;
  const onStopActiveMessage = React.useCallback(() => {
    const visibleRunID = currentLeafMessage?.runID?.trim() || "";
    if (resumingRunID && visibleRunID === resumingRunID) {
      void cancelResumedGeneration();
      return;
    }
    if (onStopMessage()) {
      return;
    }
  }, [
    cancelResumedGeneration,
    currentLeafMessage?.runID,
    onStopMessage,
    resumingRunID,
  ]);

  const messageContentRef = React.useRef<HTMLDivElement | null>(null);
  const loadingOlderInFlightRef = React.useRef(false);
  const onScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (
        viewport.scrollTop > TOP_LOAD_OLDER_MESSAGES_THRESHOLD_PX ||
        distanceFromBottom <= TOP_LOAD_OLDER_MESSAGES_THRESHOLD_PX ||
        !hasOlder ||
        loadingOlder ||
        loadingOlderInFlightRef.current
      ) {
        return;
      }

      loadingOlderInFlightRef.current = true;
      Promise.resolve(loadOlderMessages())
        .catch((): undefined => undefined)
        .finally(() => {
          loadingOlderInFlightRef.current = false;
        });
    },
    [hasOlder, loadOlderMessages, loadingOlder],
  );

  const {
    onEditGeneratedImageAttachment,
    onExtendGeneratedVideoAttachment,
    onAttachExistingFile,
  } = useChatMediaAttachmentActions({
    attachments,
    maxFilesPerMessage,
    modelOptions,
    selectedModel,
    selectedPlatformModelName,
    setAttachments,
    setSelectedPlatformModelName,
    releaseAttachments,
  });

  const {
    actionConversationID,
    canOperateConversation,
    activeConversationTitle,
    activeConversationStarred,
    activeConversationLabels,
    activeConversationShared,
    shareDialogOpen,
    setShareDialogOpen,
    deleteDialogOpen,
    setDeleteDialogOpen,
    deleteFiles,
    setDeleteFiles,
    deleteFilesID,
    onToggleActiveConversationStar,
    onRenameActiveConversation,
    onSetSystemPrompt,
    onAutoRenameActiveConversation,
    onUpdateActiveConversationLabels,
    onRequestDeleteActiveConversation,
    onConfirmDeleteActiveConversation,
    onSetActiveConversationProject,
    onShareActiveConversation,
    onExportActiveConversation,
  } = useChatConversationActions({
    conversationID,
    currentConversation,
    deleteFilesByDefault,
  });
  const shareDefaultMessagePublicIDs = React.useMemo(
    () =>
      visibleMessages
        .filter((item) => !item.isPending && Boolean(item.serverMessageID) && item.publicID.trim())
        .map((item) => item.publicID.trim()),
    [visibleMessages],
  );

  const screenshotMessages = React.useMemo(
    () => ({
      emptySelection: tScreenshot("emptySelection"),
      selectionLimitReached: tScreenshot("selectionLimitReached"),
      generating: tScreenshot("generating"),
      ready: tScreenshot("ready"),
      failed: tScreenshot("failed"),
      tooLarge: tScreenshot("tooLarge"),
      downloaded: tScreenshot("downloaded"),
      copied: tScreenshot("copied"),
      copyFailed: tScreenshot("copyFailed"),
      copyUnsupported: tScreenshot("copyUnsupported"),
    }),
    [tScreenshot],
  );
  const screenshot = useChatScreenshot({
    conversationID: actionConversationID || null,
    messageContentRef,
    conversationTitle: activeConversationTitle,
    messages: screenshotMessages,
  });
  const screenshotPreview = screenshot.preview;
  const { screenshotPreviewOpen, closeScreenshotPreviewDialog } = useChatScreenshotPreview({
    preview: screenshotPreview,
    closePreview: screenshot.closePreview,
  });

  const messagesWithInlineError = React.useMemo<ChatAreaMessage[]>(() => {
    const errors = [
      modelsErrorMsg.trim()
        ? {
          title: t("modelListLoadFailed"),
          message: modelsErrorMsg.trim(),
        }
        : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);

    if (errors.length === 0) {
      return visibleMessages;
    }

    return [
      ...visibleMessages,
      {
        key: `chat-inline-error-${conversationID ?? "current"}`,
        publicID: `chat-inline-error-${conversationID ?? "current"}`,
        parentPublicID: visibleMessages.at(-1)?.publicID ?? null,
        sourcePublicID: null,
        role: "system",
        content: "",
        branchReason: "default",
        isPending: false,
        isStreaming: false,
        inlineAlert: {
          title: errors.map((item) => item.title).join(" / "),
          message: errors.map((item) => item.message).join("\n"),
        },
      },
    ];
  }, [conversationID, modelsErrorMsg, t, visibleMessages]);

  const effectiveOptions = modelOptionPolicyDisabled ? EMPTY_CONVERSATION_OPTIONS : options;
  const temporaryAvailableTools = React.useMemo(
    () => availableTools.filter((tool) => tool.attachmentInputMode !== "image"),
    [availableTools],
  );
  const temporarySelectedToolIDs = React.useMemo(() => {
    const supportedIDs = new Set(temporaryAvailableTools.map((tool) => tool.id));
    return selectedToolIDs.filter((id) => supportedIDs.has(id));
  }, [selectedToolIDs, temporaryAvailableTools]);
  const temporarySelectedSkillIDs = React.useMemo(
    () => selectedSkills.map((skill) => skill.id),
    [selectedSkills],
  );
  const temporaryRuntime = useChatTemporaryRuntime({
    active: temporaryMode,
    draft,
    model: selectedPlatformModelName,
    options: effectiveOptions,
    selectedToolIDs: temporarySelectedToolIDs,
    selectedSkillIDs: temporarySelectedSkillIDs,
    selectedKnowledgeBaseIDs,
    htmlVisualPromptEnabled: htmlVisualPrompt.enabled,
    attachments,
    onDraftChange: setDraft,
    onAttachmentsConsumed: onTemporaryAttachmentsConsumed,
    releaseAttachments,
  });
  const displayMessages = temporaryMode ? temporaryRuntime.messages : messagesWithInlineError;
  const artifactWorkspace = useChatArtifacts({
    scopeKey: conversationID,
    transient: temporaryMode,
    messages: displayMessages,
  });
  const { workspaceRef, artifactResizing, onArtifactResizeStart } = useChatArtifactResize(artifactWorkspace);
  const projectWorkspaceRef = React.useRef<ProjectWorkspaceHandle | null>(null);
  const [projectPanelOpen, setProjectPanelOpen] = React.useState(true);
  const [projectPanelWidth, setProjectPanelWidth] = React.useState(360);
  React.useEffect(() => {
    setProjectPanelOpen(window.localStorage.getItem(PROJECT_PANEL_OPEN_KEY) !== "false");
    const storedWidth = Number(window.localStorage.getItem(PROJECT_PANEL_WIDTH_KEY));
    if (Number.isFinite(storedWidth)) setProjectPanelWidth(Math.min(720, Math.max(280, storedWidth)));
    const openProjectPanel = () => setProjectPanelOpen(true);
    window.addEventListener("deeix-chat:open-project-panel", openProjectPanel);
    return () => window.removeEventListener("deeix-chat:open-project-panel", openProjectPanel);
  }, []);
  const setProjectPanelVisibility = React.useCallback((open: boolean) => {
    setProjectPanelOpen(open);
    window.localStorage.setItem(PROJECT_PANEL_OPEN_KEY, String(open));
  }, []);
  const hasInlineArtifact = Boolean(artifactWorkspace.activeArtifact && artifactWorkspace.isInlineViewport);
  const workspaceProjectID = currentConversation?.projectID || routeProjectID || "";
  // 聊天区文件标签页：第一个固定为聊天，其余为打开的项目文件。
  const [projectFileTabs, setProjectFileTabs] = React.useState<ProjectFileTab[]>([]);
  const [activeProjectTabKey, setActiveProjectTabKey] = React.useState("");
  const [projectFileBusy, setProjectFileBusy] = React.useState(false);

  // 切换项目后清空所有文件标签页并回到聊天页。
  React.useEffect(() => {
    setProjectFileTabs([]);
    setActiveProjectTabKey("");
  }, [workspaceProjectID]);

  // 活动标签页被关闭后自动回到聊天页。
  React.useEffect(() => {
    if (activeProjectTabKey && !projectFileTabs.some((tab) => tab.key === activeProjectTabKey)) {
      setActiveProjectTabKey("");
    }
  }, [projectFileTabs, activeProjectTabKey]);

  // 从资源管理器打开项目文件：拉取完整内容并激活对应标签页。
  const openProjectFile = React.useCallback(async (file: ProjectWorkspaceFileDTO) => {
    setProjectFileBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      const content = await fetchProjectFileContent(token, workspaceProjectID, file.PublicID);
      setProjectFileTabs((previous) => {
        const existing = previous.find((item) => item.key === file.RelativePath);
        const tab: ProjectFileTab = existing
          ? { ...existing, fileID: file.PublicID, content, savedContent: content, diff: existing.diff ? { ...existing.diff, next: content } : null, note: "", deleted: false }
          : { key: file.RelativePath, path: file.RelativePath, fileID: file.PublicID, content, savedContent: content, diff: null, note: "", deleted: false };
        return upsertIn(previous, tab);
      });
      setActiveProjectTabKey(file.RelativePath);
    } catch (error) { toast.error(error instanceof Error ? error.message : "无法读取项目文件"); }
    finally { setProjectFileBusy(false); }
  }, [workspaceProjectID]);

  // 点击消息卡片或每轮变更：打开对应文件的 Diff 视图、下载归档或显示删除提示。
  const openProjectChange = React.useCallback(async (change: ProjectChange) => {
    if (change.name === "project_create_archive") {
      setProjectFileBusy(true);
      try {
        const token = await resolveAccessToken();
        if (!token) throw new Error("登录状态已失效");
        const { blob, fileName } = await downloadProjectArchive(token, workspaceProjectID);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch (error) { toast.error(error instanceof Error ? error.message : "下载失败"); }
      finally { setProjectFileBusy(false); }
      return;
    }
    setProjectPanelVisibility(true);
    setProjectFileBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      // 优先读取工作区中的实际文件内容（完整无截断），trace 明细仅作兜底。
      let file: ProjectWorkspaceFileDTO | undefined;
      let fetched = "";
      try {
        const view = await getProjectWorkspace(token, workspaceProjectID);
        file = (view.Files ?? []).find((item) => item.RelativePath === change.path);
        if (file && change.name !== "project_delete_file") {
          fetched = await fetchProjectFileContent(token, workspaceProjectID, file.PublicID);
        }
      } catch { /* 工作区查询失败时回退到 trace 内容 */ }
      if (change.name === "project_delete_file") {
        const tab: ProjectFileTab = {
          key: change.path,
          path: change.path,
          fileID: file?.PublicID ?? "",
          content: fetched,
          savedContent: fetched,
          diff: null,
          note: "该文件已被删除",
          deleted: true,
        };
        setProjectFileTabs((previous) => upsertIn(previous, tab));
        setActiveProjectTabKey(change.path);
        return;
      }
      // 同一文件的多次修改合并为累计 Diff：跨轮次收集原子变更，从当前内容逆序还原初始内容。
      const finalContent = fetched || change.newContent || "";
      const atomics = collectProjectFileChanges(displayMessages, change.path);
      let initial = atomics.length > 0
        ? reconstructProjectFileInitial(finalContent, atomics)
        : change.name === "project_write_file" ? "" : change.oldContent ?? "";
      // 还原失败（片段在当前内容中已不存在）时回退到首个变更的原始片段。
      if (initial === finalContent && atomics.length > 0) {
        initial = atomics[0].name === "project_write_file" ? "" : atomics[0].oldContent ?? "";
      }
      const tab: ProjectFileTab = {
        key: change.path,
        path: change.path,
        fileID: file?.PublicID ?? "",
        content: finalContent,
        savedContent: fetched,
        diff: { old: initial, next: finalContent },
        note: atomics.length > 1 ? `累计 ${atomics.length} 次修改的合并 Diff（初始 → 当前）` : "",
        deleted: false,
      };
      setProjectFileTabs((previous) => upsertIn(previous, tab));
      setActiveProjectTabKey(change.path);
    } catch (error) { toast.error(error instanceof Error ? error.message : "无法读取项目文件"); }
    finally { setProjectFileBusy(false); }
  }, [displayMessages, workspaceProjectID, setProjectPanelVisibility]);

  const onOpenProjectChange = React.useCallback((change: ProjectChange) => {
    setProjectPanelVisibility(true);
    void openProjectChange(change);
  }, [openProjectChange, setProjectPanelVisibility]);

  // 新建文件标签页：目录参数作为路径前缀，自动生成不重名的 untitled 文件。
  const createProjectFile = React.useCallback((directory: string) => {
    const prefix = directory.trim().replace(/^\/+|\/+$/g, "");
    const base = prefix ? `${prefix}/untitled` : "untitled";
    let path = `${base}.ts`;
    let index = 1;
    while (projectFileTabs.some((tab) => tab.path === path || tab.key === path)) {
      index += 1;
      path = `${base}-${index}.ts`;
    }
    const tab: ProjectFileTab = { key: path, path, fileID: "", content: "", savedContent: "", diff: null, note: "", deleted: false };
    setProjectFileTabs((previous) => [...previous, tab]);
    setActiveProjectTabKey(path);
    setProjectPanelVisibility(true);
  }, [projectFileTabs, setProjectPanelVisibility]);

  const closeProjectTab = React.useCallback((key: string) => {
    setProjectFileTabs((previous) => previous.filter((tab) => tab.key !== key));
  }, []);

  // 资源管理器批量删除后，同步关闭命中的文件标签页（含目录前缀匹配）。
  const onProjectFilesDeleted = React.useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setProjectFileTabs((previous) => previous.filter((tab) => !paths.some((path) => path !== "" && (tab.path === path || tab.path.startsWith(`${path}/`)))));
  }, []);

  const activeProjectTab = projectFileTabs.find((tab) => tab.key === activeProjectTabKey) ?? null;

  const updateActiveProjectTab = React.useCallback((patch: Partial<ProjectFileTab>) => {
    setProjectFileTabs((previous) => previous.map((tab) => (tab.key === activeProjectTabKey ? { ...tab, ...patch } : tab)));
  }, [activeProjectTabKey]);

  // 保存当前标签页文件：新文件按输入路径创建，已存在文件覆盖更新。
  const saveActiveProjectTab = React.useCallback(async () => {
    const tab = projectFileTabs.find((item) => item.key === activeProjectTabKey);
    if (!tab || !tab.path.trim()) return;
    setProjectFileBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      const file = await saveProjectFile(token, workspaceProjectID, tab.path.trim(), tab.content);
      const nextKey = tab.path.trim();
      setProjectFileTabs((previous) => previous
        .filter((item) => item.key === nextKey || item.key === tab.key)
        .map((item) => (item.key === tab.key ? { ...item, key: nextKey, path: nextKey, fileID: file.PublicID, savedContent: item.content, diff: null, deleted: false, note: "" } : item)));
      setActiveProjectTabKey(nextKey);
      projectWorkspaceRef.current?.refresh();
      toast.success("项目文件已保存");
    } catch (error) { toast.error(error instanceof Error ? error.message : "保存失败"); }
    finally { setProjectFileBusy(false); }
  }, [activeProjectTabKey, projectFileTabs, workspaceProjectID]);

  // 删除当前标签页文件：新文件仅关闭标签页，已保存文件调用删除接口。
  const deleteActiveProjectTab = React.useCallback(async () => {
    const tab = projectFileTabs.find((item) => item.key === activeProjectTabKey);
    if (!tab) return;
    if (!tab.fileID) {
      closeProjectTab(tab.key);
      return;
    }
    setProjectFileBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      await deleteProjectFile(token, workspaceProjectID, tab.fileID);
      closeProjectTab(tab.key);
      projectWorkspaceRef.current?.refresh();
      toast.success("项目文件已删除");
    } catch (error) { toast.error(error instanceof Error ? error.message : "删除失败"); }
    finally { setProjectFileBusy(false); }
  }, [activeProjectTabKey, closeProjectTab, projectFileTabs, workspaceProjectID]);

  const isMobileViewport = useIsMobile();
  // 移动端面板为全宽抽屉：网格退化为单列，避免固定像素的第二列把聊天区挤到一边。
  const workspaceGridColumns = hasInlineArtifact
    ? `minmax(0, ${1 - artifactWorkspace.artifactRatio}fr) minmax(0, ${artifactWorkspace.artifactRatio}fr)`
    : isMobileViewport
      ? "minmax(0, 1fr)"
      : workspaceProjectID && projectPanelOpen
        ? `minmax(0, 1fr) ${projectPanelWidth}px`
        : "minmax(0, 1fr) minmax(0, 0fr)";

  const selectedModelDefaultOptions = modelOptionPolicyDisabled
    ? EMPTY_CONVERSATION_OPTIONS
    : (selectedModel?.defaultOptions ?? EMPTY_CONVERSATION_OPTIONS);
  const {
    fileDragActive,
    onFileDragEnter,
    onFileDragOver,
    onFileDragLeave,
    onFileDrop,
  } = useChatFileDrag({
    disabled: uploadDropDisabled,
    onUploadFiles,
  });

  const composerSending = temporaryMode ? temporaryRuntime.sending : generating;
  const composerConversationMode = temporaryMode ? temporaryRuntime.messages.length > 0 : isConversationMode;
  const composerLoading =
    !temporaryMode &&
    Boolean(conversationID) &&
    (loading || messageDataConversationID !== conversationID);
  const chatInputProps = {
    draft,
    loading: composerLoading,
    sending: composerSending,
    uploading: temporaryMode ? false : uploading,
    isConversationMode: composerConversationMode,
    fileMode,
    ragAvailable,
    ragAvailabilityReason,
    sendShortcut,
    inputHeight,
    attachments,
    uploadingAttachments,
    modelOptions,
    billingDisplayCurrency,
    billingDisplayUsdToCnyRate,
    selectedPlatformModelName,
    availableTools: temporaryMode ? temporaryAvailableTools : availableTools,
    selectedToolIDs: temporaryMode ? temporarySelectedToolIDs : selectedToolIDs,
    selectedSkills,
    selectedKnowledgeBaseIDs,
    defaultToolIDs,
    queuedMessages: temporaryMode ? EMPTY_LIST : queuedMessages,
    htmlVisualPromptEnabled: htmlVisualPrompt.enabled,
    maxSelectedTools: mcpMaxSelectedTools,
    toolsLoading,
    options: effectiveOptions,
    defaultOptions: selectedModelDefaultOptions,
    modelOptionPolicy,
    modelLoading: modelsLoading,
    dropActive: fileDragActive,
    temporaryMode,
    systemPromptEditor: temporaryMode
      ? undefined
      : {
          value: conversationID ? currentConversation?.systemPrompt ?? "" : pendingSystemPrompt,
          onSave: conversationID ? onSetSystemPrompt : setPendingSystemPrompt,
        },
    autoFocusKey: conversationID ?? `${conversationKey}:${newConversationRevision}`,
    onDraftChange: setDraft,
    onModelChange: setSelectedPlatformModelName,
    onModelCatalogRefresh: refreshModelCatalogForComposer,
    onSelectedToolsChange,
    maxSelectedSkills: mcpMaxSelectedTools,
    onSelectedSkillsChange,
    onSelectedKnowledgeBasesChange,
    onDefaultToolsChange: onDefaultToolIDsChange,
    onHTMLVisualPromptChange: htmlVisualPrompt.setEnabled,
    onOptionsChange: setModelOptions,
    onOptionsReset: resetModelOptions,
    onOptionsDefaultRestore: restoreBackendDefaultModelOptions,
    onAttachExistingFile,
    onUploadFiles,
    onCaptureScreenshot,
    onRemoveAttachment,
    onSendMessage: temporaryMode ? temporaryRuntime.send : onSendMessage,
    onStopMessage: temporaryMode ? temporaryRuntime.stop : onStopActiveMessage,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onGuideQueuedMessage,
  };
  const chatContentWidthClassName = resolveChatContentWidthClassName(contentWidth);
  const isConversationLoading = !temporaryMode && Boolean(conversationID) && loading && visibleMessageCount === 0 && displayMessages.length === 0;
  const isConversationLoadFailed = !temporaryMode && Boolean(conversationID) && !loading && errorMsg.trim().length > 0 && visibleMessageCount === 0;
  const shouldUseCenteredComposer =
    !workspaceProjectID && !isConversationLoading && !isConversationLoadFailed && !composerConversationMode && displayMessages.length === 0;

  // 聊天区标签条：第一个固定为聊天，其后为已打开的项目文件，可自由切换。
  const projectTabStrip = workspaceProjectID && projectFileTabs.length > 0 ? (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2">
      <button
        type="button"
        onClick={() => setActiveProjectTabKey("")}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
          activeProjectTabKey === "" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted",
        )}
      >
        <MessageSquare className="size-3.5 shrink-0" />
        <span className="shrink-0">聊天</span>
      </button>
      {projectFileTabs.map((tab) => (
        <div
          key={tab.key}
          className={cn(
            "group flex h-7 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs transition-colors",
            activeProjectTabKey === tab.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted",
          )}
        >
          <button
            type="button"
            onClick={() => setActiveProjectTabKey(tab.key)}
            className="flex min-w-0 items-center gap-1.5"
            title={tab.path}
          >
            <FileCode2 className="size-3.5 shrink-0" />
            <span className="max-w-[180px] truncate">{tab.path.split("/").at(-1) ?? tab.path}</span>
            {!tab.diff && !tab.deleted && tab.content !== tab.savedContent ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="未保存" /> : null}
          </button>
          <button
            type="button"
            aria-label="关闭标签页"
            className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted-foreground/20"
            onClick={() => closeProjectTab(tab.key)}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden md:overflow-visible"
      onDragEnter={onFileDragEnter}
      onDragOver={onFileDragOver}
      onDragLeave={onFileDragLeave}
      onDrop={onFileDrop}
    >
      {workspaceProjectID && !projectPanelOpen ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          title="打开 IDE"
          aria-label="打开 IDE"
          // 移动端为抽屉入口按钮（底部悬浮），桌面为右缘贴边按钮。
          className="absolute bottom-4 right-4 z-30 inline-flex rounded-lg border shadow-sm md:bottom-auto md:right-0 md:top-1/2 md:-translate-y-1/2 md:rounded-l-lg md:rounded-r-none md:border-r-0"
          onClick={() => setProjectPanelVisibility(true)}
        >
          <PanelRightOpen className="size-4" />
        </Button>
      ) : null}
      {/* 项目对话不显示临时对话控件：避免与右侧 IDE 按钮区域重叠，且项目会话不适用临时模式 */}
      {!conversationID && !workspaceProjectID ? (
        <TemporaryChatModeControl
          active={temporaryMode}
          requiresExitConfirmation={temporaryRuntime.sending || temporaryRuntime.messages.length > 0}
        />
      ) : null}
      {shouldUseCenteredComposer ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatEmptyState
            greetingTitle={activeRouteProject?.name || greetingTitle}
            badgeLabel={activeRouteProject ? t("projectMode") : undefined}
            badgeTooltip={activeRouteProject ? t("projectModeTooltip") : undefined}
            titleAdornment={temporaryMode ? (
              <Glasses
                aria-hidden
                className="size-5 shrink-0 text-muted-foreground md:size-[22px]"
                strokeWidth={1.6}
              />
            ) : null}
            contentWidthClassName={chatContentWidthClassName}
          >
            <ChatInput {...chatInputProps} />
          </ChatEmptyState>
        </div>
        ) : (
          <div
            ref={workspaceRef}
            className={cn(
              "relative grid min-h-0 flex-1 overflow-hidden",
              artifactResizing
                ? "transition-none"
                : "transition-[grid-template-columns] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
              hasInlineArtifact && "md:overflow-visible",
            )}
            style={{ gridTemplateColumns: workspaceGridColumns }}
          >
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {projectTabStrip}
              {activeProjectTab ? (
                <ProjectFileEditor
                  key={activeProjectTab.key}
                  tab={activeProjectTab}
                  busy={projectFileBusy}
                  projectID={workspaceProjectID}
                  onPathChange={(path) => updateActiveProjectTab({ path })}
                  onContentChange={(content) => updateActiveProjectTab({ content })}
                  onSave={() => void saveActiveProjectTab()}
                  onDelete={() => void deleteActiveProjectTab()}
                />
              ) : null}
              <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", activeProjectTab && "hidden")}>
                {isConversationLoading ? (
                  <ChatAreaSkeleton contentWidthClassName={chatContentWidthClassName} />
                ) : isConversationLoadFailed ? (
                  <ChatAreaLoadError onRefresh={reload} onNewConversation={onNewConversationFromLoadError} />
                ) : (
                  <ChatArea
                    title={temporaryMode ? t("temporary.title") : activeConversationTitle}
                    starred={activeConversationStarred}
                    canOperateConversation={temporaryMode ? false : canOperateConversation}
                    messages={displayMessages}
                    messagesReadOnly={temporaryMode}
                    busy={composerSending}
                    messageContentRef={messageContentRef}
                    onScroll={onScroll}
                    onRetryUserMessage={onRetryUserMessage}
                    onRetryAssistantMessage={onRetryAssistantMessage}
                    onContinueAssistantMessage={onContinueAssistantMessage}
                    onEditAssistantMessage={onEditAssistantMessage}
                    onEditUserMessage={onEditUserMessage}
                    onForkMessage={temporaryMode ? undefined : onForkMessage}
                    onDeleteMessage={temporaryMode ? undefined : onDeleteMessage}
                    modelOptions={modelOptions}
                    selectedPlatformModelName={selectedPlatformModelName}
                    onModelChange={setSelectedPlatformModelName}
                    onModelCatalogRefresh={refreshModelCatalogForComposer}
                    onEditImageAttachment={onEditGeneratedImageAttachment}
                    onExtendVideoAttachment={onExtendGeneratedVideoAttachment}
                    onOpenCodeArtifact={artifactWorkspace.openArtifact}
                    onOpenProjectChange={workspaceProjectID ? onOpenProjectChange : undefined}
                    onCycleMessageBranch={onCycleMessageBranch}
                    onToggleStar={temporaryMode ? undefined : onToggleActiveConversationStar}
                    onRename={temporaryMode ? undefined : onRenameActiveConversation}
                    onSetSystemPrompt={temporaryMode ? undefined : onSetSystemPrompt}
                    systemPrompt={currentConversation?.systemPrompt ?? ""}
                    onAutoRename={temporaryMode ? undefined : onAutoRenameActiveConversation}
                    labels={temporaryMode ? EMPTY_LIST : activeConversationLabels}
                    onUpdateLabels={temporaryMode ? undefined : onUpdateActiveConversationLabels}
                    projectMenu={temporaryMode ? undefined : {
                      label: t("labelMenu.moveToProject"),
                      unassignedLabel: t("labelMenu.unassignedProject"),
                      currentProjectID: currentConversation?.projectID,
                      projects,
                      onSelect: onSetActiveConversationProject,
                    }}
                    onShare={temporaryMode ? undefined : onShareActiveConversation}
                    shareActive={activeConversationShared}
                    onExport={temporaryMode ? undefined : onExportActiveConversation}
                    onDelete={temporaryMode ? undefined : onRequestDeleteActiveConversation}
                    markdownRender={markdownRender}
                    autoExpandThinking={autoExpandThinking}
                    autoExpandToolCalls={autoExpandToolCalls}
                    showModelInfo={showModelInfo}
                    showLatency={showLatency}
                    showTokenUsage={showTokenUsage}
                    showBillingCost={showBillingCost}
                    billingDisplayCurrency={billingDisplayCurrency}
                    billingDisplayUsdToCnyRate={billingDisplayUsdToCnyRate}
                    splitRightInset={hasInlineArtifact}
                    contentWidthClassName={chatContentWidthClassName}
                    onScreenshotLatest={screenshot.captureLatestMessages}
                    onScreenshotSelect={screenshot.startSelectionScreenshot}
                    screenshot={{
                      selectionMode: screenshot.selectionMode,
                      selectedIDs: screenshot.selectedIDs,
                      selectedCount: screenshot.selectedCount,
                      capturing: screenshot.capturing,
                      onToggleSelection: screenshot.toggleSelection,
                      onSelectAll: screenshot.selectMany,
                      onClearSelection: screenshot.clearSelection,
                      onPruneSelection: screenshot.pruneSelection,
                      onCapture: screenshot.captureSelectedMessages,
                      onExit: screenshot.exitSelectionMode,
                    }}
                  />
                )}
              </div>

              {!isConversationLoadFailed ? (
                <div className="relative z-10 shrink-0 px-3 pb-3 md:px-6">
                  <div className={cn("mx-auto w-full", chatContentWidthClassName)}>
                    <ChatInput {...chatInputProps} />
                  </div>
                </div>
              ) : null}
            </div>

            {hasInlineArtifact ? (
              <ChatArtifactWorkspace
                artifact={artifactWorkspace.activeArtifact}
                artifacts={artifactWorkspace.artifacts}
                isInlineViewport={artifactWorkspace.isInlineViewport}
                onArtifactChange={artifactWorkspace.selectArtifact}
                onClose={artifactWorkspace.closeArtifact}
                onResizeReset={artifactWorkspace.resetArtifactRatio}
                onResizeStart={onArtifactResizeStart}
              />
            ) : workspaceProjectID && projectPanelOpen ? (
              <div className={cn("relative h-full min-h-0", isMobileViewport && "static")}>
                {/* 移动端遮罩：点击抽屉外区域关闭资源管理器。 */}
                {isMobileViewport ? (
                  <button
                    type="button"
                    aria-label="关闭资源管理器"
                    className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
                    onClick={() => setProjectPanelVisibility(false)}
                  />
                ) : null}
                <button
                  type="button"
                  aria-label="拖动调整 IDE 宽度"
                  // 移动端抽屉为全宽，无拖拽意义；仅桌面显示。
                  className="absolute -left-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none md:block"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const startX = event.clientX;
                    const startWidth = projectPanelWidth;
                    const handle = event.currentTarget;
                    let nextWidth = startWidth;
                    const move = (moveEvent: PointerEvent) => {
                      nextWidth = Math.min(720, Math.max(280, startWidth - (moveEvent.clientX - startX)));
                      setProjectPanelWidth(nextWidth);
                    };
                    const stop = () => {
                      window.localStorage.setItem(PROJECT_PANEL_WIDTH_KEY, String(nextWidth));
                      handle.removeEventListener("pointermove", move);
                      handle.removeEventListener("pointerup", stop);
                      handle.removeEventListener("pointercancel", stop);
                    };
                    handle.addEventListener("pointermove", move);
                    handle.addEventListener("pointerup", stop);
                    handle.addEventListener("pointercancel", stop);
                  }}
                />
                <ChatProjectWorkspace
                  ref={projectWorkspaceRef}
                  projectID={workspaceProjectID}
                  messages={displayMessages}
                  width={isMobileViewport ? 0 : projectPanelWidth}
                  isDrawer={isMobileViewport}
                  onClose={() => setProjectPanelVisibility(false)}
                  activeTabPath={activeProjectTabKey}
                  // 移动端打开文件后收起抽屉，露出聊天区的文件标签页。
                  onOpenFile={(file) => { void openProjectFile(file); if (isMobileViewport) setProjectPanelVisibility(false); }}
                  onOpenChange={(change) => { void openProjectChange(change); if (isMobileViewport) setProjectPanelVisibility(false); }}
                  onNewFile={createProjectFile}
                  onFilesDeleted={onProjectFilesDeleted}
                />
              </div>
            ) : (
              <ChatArtifactWorkspace
                artifact={artifactWorkspace.activeArtifact}
                artifacts={artifactWorkspace.artifacts}
                isInlineViewport={artifactWorkspace.isInlineViewport}
                onArtifactChange={artifactWorkspace.selectArtifact}
                onClose={artifactWorkspace.closeArtifact}
                onResizeReset={artifactWorkspace.resetArtifactRatio}
                onResizeStart={onArtifactResizeStart}
              />
            )}
          </div>
        )
      }

      <ChatScreenshotPreviewDialog
        open={screenshotPreviewOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeScreenshotPreviewDialog();
          }
        }}
        previewURL={screenshotPreview?.url ?? null}
        clipboardSupported={screenshot.clipboardSupported}
        onDownload={screenshot.downloadPreview}
        onCopy={screenshot.copyPreviewToClipboard}
      />

      {
        canOperateConversation ? (
          <>
            <ConversationShareDialog
              open={shareDialogOpen}
              onOpenChange={setShareDialogOpen}
              conversationPublicID={actionConversationID}
              conversationTitle={activeConversationTitle}
              defaultMessagePublicIDs={shareDefaultMessagePublicIDs}
              onShareChange={(share) => {
                touchByPublicID(actionConversationID, sharePatchFromDTO(share));
              }}
            />

            <AlertDialog
              open={deleteDialogOpen}
              onOpenChange={(open) => {
                setDeleteDialogOpen(open);
                if (!open) {
                  setDeleteFiles(false);
                }
              }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{tRecent("dialogs.deleteTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {tRecent("dialogs.deleteDescription", {
                      label: tRecent("deleteConversationLabel", { title: activeConversationTitle }),
                    })}
                  </AlertDialogDescription>
                  <DeleteFilesOption
                    id={deleteFilesID}
                    checked={deleteFiles}
                    onCheckedChange={setDeleteFiles}
                  />
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tRecent("dialogs.cancel")}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void onConfirmDeleteActiveConversation()}>
                    {tRecent("dialogs.delete")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null
      }
    </div >
  );
}
