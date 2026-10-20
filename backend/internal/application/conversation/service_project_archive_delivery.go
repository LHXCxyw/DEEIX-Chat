package conversation

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
)

func (s *Service) createProjectArchiveDelivery(ctx context.Context, input ExecuteToolInput) (string, error) {
	if input.UserID == 0 || input.ConversationID == 0 || input.MessageID == 0 || strings.TrimSpace(input.RunID) == "" {
		return "", ErrInvalidFileReference
	}
	if err := authorizeAgentFileTool("project_create_archive", input.AgentPermissions); err != nil {
		return "", err
	}
	workspace, err := s.agentToolWorkspace(ctx, input, false)
	if err != nil {
		return "", err
	}
	message, err := s.repo.GetMessageByID(ctx, input.ConversationID, input.MessageID)
	if err != nil {
		return "", err
	}
	if message.UserID != input.UserID || message.Role != "assistant" || message.RunID != input.RunID || message.Status != "pending" {
		return "", ErrInvalidFileReference
	}
	run, err := s.repo.GetConversationRunByRunID(ctx, input.UserID, input.RunID)
	if err != nil {
		return "", err
	}
	if run.ConversationID != input.ConversationID {
		return "", ErrInvalidFileReference
	}
	files, err := s.repo.ListProjectFiles(ctx, input.UserID, workspace.ID)
	if err != nil {
		return "", err
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return "", err
	}
	archive, err := os.CreateTemp("", "project-delivery-*.zip")
	if err != nil {
		return "", err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	count, err := writeArchiveDelivery(ctx, store, files, archive, archiveDeliveryLimits{
		files: maxProjectArchiveFiles, fileBytes: maxProjectArchiveFileBytes,
		totalBytes: maxProjectArchiveTotalBytes, zipBytes: maxProjectArchiveBytes,
	})
	if err != nil {
		return "", err
	}
	size, err := archive.Seek(0, 1)
	if err != nil {
		return "", err
	}
	if _, err = archive.Seek(0, 0); err != nil {
		return "", err
	}
	if s.uploadSvc == nil {
		return "", fmt.Errorf("archive upload service is unavailable")
	}
	result, err := s.uploadSvc.UploadFile(ctx, appupload.UploadFileInput{
		UserID: input.UserID, Purpose: "generated_archive", FileName: "project-" + time.Now().UTC().Format("20060102-150405") + ".zip",
		MimeType: "application/zip", DeclaredSize: size, Reader: archive,
	})
	if err != nil {
		return "", err
	}
	file := result.File
	if err = s.repo.CreateAttachments(ctx, []model.Attachment{{
		ConversationID: input.ConversationID, MessageID: input.MessageID, UserID: input.UserID,
		FileID: file.FileID, Kind: "file", FileName: file.FileName, MimeType: file.MimeType,
		FileSize: file.SizeBytes, SHA256: file.SHA256, StoragePath: file.StoragePath, Status: "active", UploadedAt: time.Now(),
	}}); err != nil {
		return "", err
	}
	return marshalProjectToolResult(map[string]interface{}{
		"project_id": input.ProjectPublicID, "file_id": file.FileID, "file_name": file.FileName,
		"file_count": count, "size_bytes": file.SizeBytes, "download_ui": true,
		"message": "fixed archive saved as an assistant message attachment; download it from the message attachment, not the current project ZIP button. Do not output a download URL or link.",
	})
}
