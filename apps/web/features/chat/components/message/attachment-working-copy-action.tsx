"use client";

import * as React from "react";
import { Download, FilePenLine, FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { AttachmentAction, AttachmentActions } from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveFilePreviewKind } from "@/entities/file";
import type { MessageAttachment } from "@/features/chat/types/messages";
import { useLocalizedErrorMessage } from "@/i18n/use-localized-error";
import {
  fetchConversationWorkspaceFileBlob, fetchProjectFileBlob, getConversation,
  importConversationFileFromAttachment, importProjectFileFromAttachment,
} from "@/shared/api/conversation";
import type { ProjectWorkspaceFileDTO } from "@/shared/api/conversation-types";
import { ApiError } from "@/shared/api/http-client";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { downloadBlob } from "@/shared/lib/export-download";

type WorkingCopyTarget = { projectID: string; conversationID: string; scope: string };
type WorkingCopyResult = { target: WorkingCopyTarget; file: ProjectWorkspaceFileDTO };

function currentScope(): string {
  const params = new URLSearchParams(window.location.search);
  return JSON.stringify([window.location.pathname, params.get("conversation_id"), params.get("project_id"), params.get("temporary")]);
}

async function currentTarget(token: string): Promise<WorkingCopyTarget | null> {
  const scope = currentScope();
  const params = new URLSearchParams(window.location.search);
  if (window.location.pathname !== "/chat" || params.get("temporary") === "true") return null;
  const conversationID = params.get("conversation_id")?.trim() || "";
  const projectID = conversationID
    ? (await getConversation(token, conversationID)).projectID?.trim() || ""
    : params.get("project_id")?.trim() || "";
  return projectID || conversationID ? { projectID, conversationID, scope } : null;
}

function validPath(value: string): boolean {
  if (!value || value.length > 1024 || value.startsWith("/") || value.includes(":")) return false;
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.endsWith(".") && !part.endsWith(" "));
}

export function AttachmentWorkingCopyAction({ attachment }: { attachment: MessageAttachment }) {
  const t = useTranslations("chat.attachmentWorkingCopy");
  const tCommon = useTranslations("common.actions");
  const tError = useLocalizedErrorMessage();
  const [target, setTarget] = React.useState<WorkingCopyTarget | null>(null);
  const [result, setResult] = React.useState<WorkingCopyResult | null>(null);
  const [content, setContent] = React.useState<string | null>(null);
  const [path, setPath] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const pathID = React.useId();

  const open = async () => {
    if (busyRef.current) return;
    const mime = `${attachment.mimeType} ${attachment.detectedMime ?? ""}`.toLowerCase();
    const kind = resolveFilePreviewKind(attachment, attachment.detectedMime || attachment.mimeType);
    if (attachment.fileName.toLowerCase().endsWith(".zip") || mime.includes("zip") ||
      !(mime.includes("text/") || ["text", "code", "markdown"].includes(kind))) {
      toast.error(t("textOnly"));
      return;
    }
    if (attachment.sizeBytes > 2 * 1024 * 1024) {
      toast.error(t("tooLarge"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const scope = currentScope();
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error(t("sessionExpired"));
      const nextTarget = await currentTarget(token);
      if (currentScope() !== scope) return;
      if (!nextTarget) {
        toast.error(t("conversationRequired"));
        return;
      }
      setResult(null);
      setContent(null);
      setPath(attachment.fileName.replaceAll("\\", "/").split("/").pop() || "");
      setTarget(nextTarget);
    } catch (error) {
      toast.error(tError(error, t("failed")));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!target || busyRef.current) return;
    const relativePath = path.trim().replaceAll("\\", "/");
    if (!validPath(relativePath)) {
      toast.error(t("invalidPath"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error(t("sessionExpired"));
      const latest = await currentTarget(token);
      if (currentScope() !== target.scope || latest?.projectID !== target.projectID || latest?.conversationID !== target.conversationID) {
        setTarget(null);
        toast.error(t("projectChanged"));
        return;
      }
      const input = { fileID: attachment.fileID, path: relativePath, editAuthorized: true } as const;
      const file = target.projectID
        ? await importProjectFileFromAttachment(token, target.projectID, input)
        : await importConversationFileFromAttachment(token, target.conversationID, input);
      setTarget(null);
      toast.success(t("success"));
      if (currentScope() === target.scope) {
        setResult({ target, file });
        setContent(null);
        if (target.projectID) window.dispatchEvent(new Event("deeix-chat:open-project-panel"));
      }
    } catch (error) {
      toast.error(error instanceof ApiError && error.status === 409 ? t("conflict") : tError(error, t("failed")));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const readCopy = async (download: boolean) => {
    if (!result || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error(t("sessionExpired"));
      const blob = result.target.projectID
        ? await fetchProjectFileBlob(token, result.target.projectID, result.file.PublicID)
        : await fetchConversationWorkspaceFileBlob(token, result.target.conversationID, result.file.PublicID);
      if (download) downloadBlob(blob, result.file.FileName);
      else setContent(await blob.text());
    } catch (error) {
      toast.error(tError(error, t("readFailed")));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <AttachmentActions>
        <AttachmentAction disabled={busy} title={t("action")} aria-label={t("action")} onClick={() => void open()}>
          <FilePenLine className="size-3.5" />
        </AttachmentAction>
      </AttachmentActions>
      <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !busyRef.current) setTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{target?.projectID
              ? t("description", { file: attachment.fileName, project: target.projectID })
              : t("conversationDescription", { file: attachment.fileName })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={pathID}>{t(target?.projectID ? "path" : "conversationPath")}</Label>
            <Input id={pathID} value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} autoComplete="off" />
            <p className="text-xs text-muted-foreground">{t("limits")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>{tCommon("cancel")}</Button>
            <Button disabled={busy || !path.trim()} onClick={() => void confirm()}>{t(busy ? "copying" : "authorize")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={result !== null} onOpenChange={(open) => { if (!open && !busyRef.current) { setResult(null); setContent(null); } }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("copyTitle")}</DialogTitle>
            <DialogDescription>{t(result?.target.projectID ? "projectCopyDescription" : "conversationCopyDescription")}</DialogDescription>
          </DialogHeader>
          <p className="break-all font-mono text-sm">{result?.file.RelativePath}</p>
          {content !== null && <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-4 text-xs">{content}</pre>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => void readCopy(false)}><FileText className="size-4" />{t("readCopy")}</Button>
            <Button disabled={busy} onClick={() => void readCopy(true)}><Download className="size-4" />{t("downloadCopy")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
