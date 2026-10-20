package conversation

import (
	"context"
	"errors"
	"strings"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/google/uuid"
)

func authorizeAgentFileTool(name string, permissions AgentPermissions) error {
	if err := ValidateAgentPermissions(permissions); err != nil {
		return err
	}
	switch strings.TrimSpace(name) {
	case "project_render_screenshot", "project_browser_run":
		if !permissions.ExecuteCode {
			return ErrAgentPermissionUnsupported
		}
	case "project_preview":
		return ErrAgentPermissionUnsupported
	case "project_delete_file":
		return ErrAgentDeleteDenied
	case "project_write_file", "project_patch_file", "project_create_archive":
		if !permissions.EditFiles {
			return ErrAgentEditRequired
		}
	}
	return nil
}

func (r selectedToolRuntime) withAgentFilePermissions(p AgentPermissions, available bool) selectedToolRuntime {
	definitions := r.definitions[:0]
	for _, definition := range r.definitions {
		denied := isProjectTool(definition.Name) && (!available || authorizeAgentFileTool(definition.Name, p) != nil)
		if denied {
			delete(r.nameMap, definition.Name)
			delete(r.schemas, definition.Name)
			continue
		}
		definitions = append(definitions, definition)
	}
	r.definitions = definitions
	return r
}

func (s *Service) agentToolWorkspace(ctx context.Context, input ExecuteToolInput, create bool) (*model.ProjectWorkspace, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conversation, err := s.repo.GetConversationByUser(ctx, input.ConversationID, input.UserID)
	if err != nil {
		return nil, ErrConversationNotFound
	}
	if conversation.Status == "deleting" {
		return nil, ErrDeletionPending
	}
	var workspace *model.ProjectWorkspace
	if conversation.ProjectID != nil {
		project, projectErr := s.repo.GetConversationProjectByPublicID(ctx, input.UserID, input.ProjectPublicID)
		if projectErr != nil {
			return nil, projectErr
		}
		if project.ID != *conversation.ProjectID {
			return nil, ErrInvalidFileReference
		}
		if create {
			workspace, err = s.repo.GetOrCreateProjectWorkspace(ctx, input.UserID, project.ID, normalizePublicID(uuid.NewString()))
		} else {
			workspace, err = s.repo.GetProjectWorkspaceByProject(ctx, input.UserID, project.ID)
		}
	} else {
		if strings.TrimSpace(input.ProjectPublicID) != "" {
			return nil, ErrInvalidFileReference
		}
		if create {
			workspace, err = s.repo.GetOrCreateConversationWorkspace(ctx, input.UserID, conversation.ID, normalizePublicID(uuid.NewString()))
		} else {
			workspace, err = s.repo.GetConversationWorkspace(ctx, input.UserID, conversation.ID)
		}
	}
	if err != nil {
		return nil, err
	}
	if workspace.OwnerUserID != input.UserID || (input.WorkspaceID != 0 && workspace.ID != input.WorkspaceID) {
		return nil, ErrInvalidFileReference
	}
	return workspace, nil
}

func (s *Service) writeAgentWorkspaceFile(ctx context.Context, input ExecuteToolInput, relative string, content []byte, expected *int, expectedID string) (*model.ProjectFile, error) {
	relative, err := normalizeProjectFilePath(relative)
	if err != nil {
		return nil, err
	}
	if len(content) > maxProjectArchiveFileBytes {
		return nil, ErrFileTooLarge
	}
	workspace, err := s.agentToolWorkspace(ctx, input, true)
	if err != nil {
		return nil, err
	}
	return s.writeWorkspaceFile(ctx, input.UserID, workspace, relative, content, AgentFileChangeContext(input.ConversationID, input.MessageID, input.RunID), expected, expectedID)
}

func (s *Service) openAgentWorkspaceFile(ctx context.Context, file *model.ProjectFile) (*appupload.FileContentResult, error) {
	if file.EntryType != model.ProjectFileEntryTypeFile {
		return nil, ErrInvalidFileReference
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return nil, err
	}
	reader, info, err := store.Open(ctx, file.StorageKey)
	if err != nil {
		return nil, err
	}
	return &appupload.FileContentResult{Reader: reader, ContentType: info.ContentType, SizeBytes: info.SizeBytes}, nil
}

func (s *Service) prepareAgentFileRuntime(ctx context.Context, input SendMessageInput, runtime selectedToolRuntime) (selectedToolRuntime, uint, error) {
	s.addAgentCommandTool(&runtime, input.AgentPermissions)
	s.addScreenshotTool(&runtime, input.AgentPermissions)
	s.addProjectBrowserTool(&runtime, input.AgentPermissions)
	workspace, err := s.agentToolWorkspace(ctx, ExecuteToolInput{UserID: input.UserID, ConversationID: input.ConversationID, ProjectPublicID: input.ProjectPublicID}, input.AgentPermissions.EditFiles)
	if errors.Is(err, repository.ErrNotFound) {
		return runtime.withAgentFilePermissions(input.AgentPermissions, input.ProjectPublicID != ""), 0, nil
	}
	if err != nil {
		return runtime, 0, err
	}
	return runtime.withAgentFilePermissions(input.AgentPermissions, true), workspace.ID, nil
}
