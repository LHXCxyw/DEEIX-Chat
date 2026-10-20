package conversation

import (
	"context"
	"strings"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/google/uuid"
)

type ConversationAttachmentInput struct {
	UserID               uint
	ConversationPublicID string
	FileID               string
	Path                 string
	EditAuthorized       bool
}

func (s *Service) conversationWorkspace(ctx context.Context, userID uint, publicID string, create bool) (*model.ProjectWorkspace, error) {
	conversation, err := s.GetConversationByPublicID(ctx, userID, strings.TrimSpace(publicID))
	if err != nil {
		return nil, err
	}
	if conversation.ProjectID != nil {
		return nil, ErrInvalidFileReference
	}
	if create {
		return s.repo.GetOrCreateConversationWorkspace(ctx, userID, conversation.ID, normalizePublicID(uuid.NewString()))
	}
	return s.repo.GetConversationWorkspace(ctx, userID, conversation.ID)
}

func (s *Service) GetConversationWorkspace(ctx context.Context, userID uint, publicID string) (*ProjectWorkspaceView, error) {
	workspace, err := s.conversationWorkspace(ctx, userID, publicID, true)
	if err != nil {
		return nil, err
	}
	files, err := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
	if err != nil {
		return nil, err
	}
	return &ProjectWorkspaceView{Workspace: *workspace, Files: files}, nil
}

func (s *Service) ImportConversationFileFromAttachment(ctx context.Context, input ConversationAttachmentInput) (*model.ProjectFile, error) {
	if !input.EditAuthorized {
		return nil, ErrProjectAttachmentEditAuthorizationRequired
	}
	if input.UserID == 0 || strings.TrimSpace(input.FileID) == "" {
		return nil, ErrInvalidFileReference
	}
	relative, err := normalizeProjectAttachmentPath(input.Path)
	if err != nil {
		return nil, err
	}
	workspace, err := s.conversationWorkspace(ctx, input.UserID, input.ConversationPublicID, true)
	if err != nil {
		return nil, err
	}
	content, err := s.readAttachmentWorkingCopy(ctx, input.UserID, input.FileID, relative)
	if err != nil {
		return nil, err
	}
	expected := 0
	change := UserFileChangeContext()
	change.ConversationID = *workspace.ConversationID
	return s.writeWorkspaceFile(ctx, input.UserID, workspace, relative, content, change, &expected, "")
}

func (s *Service) OpenConversationWorkspaceFileContent(ctx context.Context, userID uint, publicID string, fileID string) (*appupload.FileContentResult, error) {
	workspace, err := s.conversationWorkspace(ctx, userID, publicID, false)
	if err != nil {
		return nil, err
	}
	file, err := s.repo.GetProjectFile(ctx, userID, workspace.ID, strings.TrimSpace(fileID))
	if err != nil {
		return nil, err
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return nil, err
	}
	reader, info, err := store.Open(ctx, file.StorageKey)
	if err != nil {
		return nil, err
	}
	return &appupload.FileContentResult{File: model.FileObject{FileID: file.PublicID, FileName: file.FileName, MimeType: file.MimeType, SizeBytes: file.SizeBytes}, Reader: reader, ContentType: info.ContentType, SizeBytes: info.SizeBytes, ModTime: info.ModTime}, nil
}
