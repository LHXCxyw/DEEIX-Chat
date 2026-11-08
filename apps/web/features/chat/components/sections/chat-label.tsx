"use client";

import * as React from "react";
import { ChevronDown, PencilLine, ScrollText, Star, StarOff, Trash } from "lucide-react";
import { useTranslations } from "next-intl";

import { Sparkles } from "@/components/animate-ui/icons/sparkles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItemIcon,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner, SpinnerLabel } from "@/components/ui/spinner";
import { AnimatedText } from "@/components/ui/animated-text";
import {
  ConversationLabelsDialog,
  ConversationLabelsMenuItem,
  ConversationProjectSubmenu,
  ConversationShareExportSubmenu,
} from "@/entities/conversation";
import { cn } from "@/lib/utils";

type ChatLabelProps = {
  title: string;
  starred?: boolean;
  className?: string;
  onToggleStar?: () => void | Promise<void>;
  onRename?: (title: string) => void | Promise<void>;
  onAutoRename?: () => void | Promise<void>;
  labels?: string[];
  onUpdateLabels?: (labels: string[]) => void | Promise<void>;
  // 当前会话的系统提示词快照；空串表示跟随全局默认。
  systemPrompt?: string;
  onSaveSystemPrompt?: (systemPrompt: string) => void | Promise<void>;
  projectMenu?: {
    label: string;
    unassignedLabel: string;
    currentProjectID?: string;
    projects: Array<{
      publicID: string;
      name: string;
    }>;
    onSelect: (projectID?: string) => void | Promise<void>;
  };
  onShare?: () => void;
  shareActive?: boolean;
  onExport?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  screenshotLatestLabel?: string;
  screenshotSelectLabel?: string;
  onScreenshotLatest?: () => void;
  onScreenshotSelect?: () => void;
};

export function ChatLabel({
  title,
  starred = false,
  className,
  onToggleStar,
  onRename,
  onAutoRename,
  labels = [],
  onUpdateLabels,
  systemPrompt = "",
  onSaveSystemPrompt,
  projectMenu,
  onShare,
  shareActive = false,
  onExport,
  onDelete,
  screenshotLatestLabel,
  screenshotSelectLabel,
  onScreenshotLatest,
  onScreenshotSelect,
}: ChatLabelProps) {
  const t = useTranslations("chat.labelMenu");
  const common = useTranslations("common.actions");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false);
  const [labelsDialogOpen, setLabelsDialogOpen] = React.useState(false);
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = React.useState(false);
  const [systemPromptValue, setSystemPromptValue] = React.useState(systemPrompt);
  const [savingSystemPrompt, setSavingSystemPrompt] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(title);
  const [renaming, setRenaming] = React.useState(false);
  const [autoRenaming, setAutoRenaming] = React.useState(false);

  React.useEffect(() => {
    if (renameDialogOpen) {
      setRenameValue(title);
    }
  }, [renameDialogOpen, title]);

  React.useEffect(() => {
    if (systemPromptDialogOpen) {
      setSystemPromptValue(systemPrompt);
    }
  }, [systemPrompt, systemPromptDialogOpen]);

  const commitRename = React.useCallback(async () => {
    const nextTitle = renameValue.trim();
    if (!onRename || !nextTitle || nextTitle === title || renaming || autoRenaming) {
      setRenameDialogOpen(false);
      return;
    }
    setRenaming(true);
    try {
      await onRename(nextTitle);
      setRenameDialogOpen(false);
    } finally {
      setRenaming(false);
    }
  }, [autoRenaming, onRename, renameValue, title, renaming]);

  const autoRename = React.useCallback(async () => {
    if (!onAutoRename || autoRenaming || renaming) {
      return;
    }
    setAutoRenaming(true);
    try {
      await onAutoRename();
      setRenameDialogOpen(false);
    } catch {
      return;
    } finally {
      setAutoRenaming(false);
    }
  }, [autoRenaming, onAutoRename, renaming]);

  const commitSystemPrompt = React.useCallback(async () => {
    if (!onSaveSystemPrompt || savingSystemPrompt) {
      return;
    }
    setSavingSystemPrompt(true);
    try {
      await onSaveSystemPrompt(systemPromptValue);
      setSystemPromptDialogOpen(false);
    } finally {
      setSavingSystemPrompt(false);
    }
  }, [onSaveSystemPrompt, savingSystemPrompt, systemPromptValue]);

  return (
    <div className={cn("inline-flex max-w-full items-center", className)}>
      <DropdownMenu
        modal={false}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        <DropdownMenuTrigger asChild>
          <Button
            id="chat-label-actions-trigger"
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("actions")}
            className="group h-7 max-w-full gap-0.5 rounded-lg px-0 font-normal"
          >
            <span className="inline-flex min-w-0 items-center px-2">
              <AnimatedText
                text={title}
                className="max-w-full"
                textClassName="text-sm font-medium leading-none text-foreground"
              />
            </span>
            <span className="inline-flex h-7 items-center px-1 text-muted-foreground transition-colors group-hover:text-foreground">
              <ChevronDown className="size-4 stroke-[1.8]" />
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="end"
          sideOffset={8}
          className="w-44"
        >
          <DropdownMenuItem
            disabled={!onToggleStar}
            onSelect={(event) => {
              event.preventDefault();
              if (!onToggleStar) {
                return;
              }
              void onToggleStar();
            }}
          >
            <DropdownMenuItemIcon icon={starred ? StarOff : Star} />
            {starred ? t("unstar") : t("star")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!onRename}
            onSelect={(event) => {
              event.preventDefault();
              if (!onRename) {
                return;
              }
              setMenuOpen(false);
              requestAnimationFrame(() => {
                setRenameDialogOpen(true);
              });
            }}
          >
            <DropdownMenuItemIcon icon={PencilLine} />
            {t("rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!onSaveSystemPrompt}
            onSelect={(event) => {
              event.preventDefault();
              if (!onSaveSystemPrompt) {
                return;
              }
              setMenuOpen(false);
              requestAnimationFrame(() => {
                setSystemPromptDialogOpen(true);
              });
            }}
          >
            <DropdownMenuItemIcon icon={ScrollText} />
            {t("systemPrompt")}
          </DropdownMenuItem>
          <ConversationLabelsMenuItem
            labels={labels}
            disabled={!onUpdateLabels}
            onSelect={() => {
              setMenuOpen(false);
              requestAnimationFrame(() => {
                setLabelsDialogOpen(true);
              });
            }}
          />
          {projectMenu ? (
            <ConversationProjectSubmenu
              label={projectMenu.label}
              unassignedLabel={projectMenu.unassignedLabel}
              currentProjectID={projectMenu.currentProjectID}
              projects={projectMenu.projects}
              onSelect={projectMenu.onSelect}
            />
          ) : null}
          <ConversationShareExportSubmenu
            label={t("shareAndExport")}
            shareLabel={shareActive ? t("manageShare") : t("share")}
            exportLabel={t("exportJSON")}
            onShare={onShare}
            onExport={onExport}
            screenshotLatestLabel={screenshotLatestLabel}
            screenshotSelectLabel={screenshotSelectLabel}
            onScreenshotLatest={onScreenshotLatest}
            onScreenshotSelect={onScreenshotSelect}
            onCloseMenu={() => setMenuOpen(false)}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!onDelete}
            onSelect={(event) => {
              event.preventDefault();
              if (!onDelete) {
                return;
              }
              setMenuOpen(false);
              void onDelete();
            }}
          >
            <DropdownMenuItemIcon icon={Trash} className="text-current" />
            {t("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rename")}</DialogTitle>
            <DialogDescription>{t("renameDescription")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void commitRename();
            }}
            className="space-y-4"
          >
            <div className="relative">
              <Input
                autoFocus
                value={renameValue}
                className={onAutoRename ? "pr-10" : undefined}
                onChange={(event) => setRenameValue(event.target.value)}
                placeholder={t("renamePlaceholder")}
              />
              {onAutoRename ? (
                <button
                  type="button"
                  className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-60"
                  aria-label={t("autoRename")}
                  title={t("autoRename")}
                  disabled={autoRenaming || renaming}
                  onClick={(event) => {
                    event.preventDefault();
                    void autoRename();
                  }}
                >
                  {autoRenaming ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Sparkles size={15} strokeWidth={1.5} animateOnHover="default" />
                  )}
                </button>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRenameDialogOpen(false)}
                disabled={renaming || autoRenaming}
              >
                {common("cancel")}
              </Button>
              <Button type="submit" disabled={renaming || autoRenaming}>
                {renaming ? <SpinnerLabel>{common("saving")}</SpinnerLabel> : common("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {onUpdateLabels ? (
        <ConversationLabelsDialog
          open={labelsDialogOpen}
          labels={labels}
          onOpenChange={setLabelsDialogOpen}
          onSave={onUpdateLabels}
        />
      ) : null}
      {onSaveSystemPrompt ? (
        <Dialog open={systemPromptDialogOpen} onOpenChange={setSystemPromptDialogOpen}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{t("systemPrompt")}</DialogTitle>
              <DialogDescription>{t("systemPromptDescription")}</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void commitSystemPrompt();
              }}
              className="space-y-3"
            >
              <Textarea
                autoFocus
                value={systemPromptValue}
                onChange={(event) => setSystemPromptValue(event.target.value)}
                placeholder={t("systemPromptPlaceholder")}
                maxLength={20000}
                rows={8}
                className="min-h-48 resize-y"
              />
              <div className="flex justify-end text-xs tabular-nums text-muted-foreground">
                <span>{t("systemPromptCount", { count: systemPromptValue.length })}</span>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSystemPromptDialogOpen(false)}
                  disabled={savingSystemPrompt}
                >
                  {common("cancel")}
                </Button>
                <Button type="submit" disabled={savingSystemPrompt}>
                  {savingSystemPrompt ? <SpinnerLabel>{common("saving")}</SpinnerLabel> : common("save")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
