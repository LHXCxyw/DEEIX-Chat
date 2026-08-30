package conversation

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	appskill "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/skill"
	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	domainknowledgebase "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/knowledgebase"
	domainmcp "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/mcp"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstore"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/google/uuid"
)

const (
	conversationProjectNameMaxChars         = 80
	conversationProjectDescriptionMaxChars  = 255
	conversationProjectSystemPromptMaxChars = 12000
	conversationProjectModelMaxChars        = 128
	conversationProjectMetaMaxChars         = 32
)

// ConversationProjectInput 定义新建项目分组输入。
type ConversationProjectInput struct {
	Name                    string
	Description             string
	SystemPrompt            string
	DefaultModel            string
	MCPDefaultMode          string
	DefaultMCPToolIDs       []uint
	DefaultSkillIDs         []uint
	DefaultKnowledgeBaseIDs []string
	Color                   string
	Icon                    string
}

// ConversationProjectPatchInput 定义项目分组局部更新输入。
type ConversationProjectPatchInput struct {
	Name                    *string
	Description             *string
	SystemPrompt            *string
	DefaultModel            *string
	MCPDefaultMode          *string
	DefaultMCPToolIDs       *[]uint
	DefaultSkillIDs         *[]uint
	DefaultKnowledgeBaseIDs *[]string
	Color                   *string
	Icon                    *string
	Status                  *string
}

// CreateConversationProject 创建当前用户的会话项目分组。
func (s *Service) CreateConversationProject(ctx context.Context, userID uint, input ConversationProjectInput) (*model.ConversationProject, error) {
	normalized, err := normalizeConversationProjectInput(input)
	if err != nil {
		return nil, err
	}
	if err = s.validateConversationProjectDefaults(
		ctx,
		userID,
		normalized.DefaultModel,
		normalized.MCPDefaultMode,
		normalized.DefaultMCPToolIDs,
		normalized.DefaultSkillIDs,
		normalized.DefaultKnowledgeBaseIDs,
		nil,
	); err != nil {
		return nil, err
	}
	item := &model.ConversationProject{
		UserID:                  userID,
		PublicID:                normalizePublicID(uuid.NewString()),
		Name:                    normalized.Name,
		Description:             normalized.Description,
		SystemPrompt:            normalized.SystemPrompt,
		DefaultModel:            normalized.DefaultModel,
		MCPDefaultMode:          normalized.MCPDefaultMode,
		DefaultMCPToolIDs:       normalized.DefaultMCPToolIDs,
		DefaultSkillIDs:         normalized.DefaultSkillIDs,
		DefaultKnowledgeBaseIDs: normalized.DefaultKnowledgeBaseIDs,
		Color:                   normalized.Color,
		Icon:                    normalized.Icon,
		Status:                  "active",
	}
	if err = s.repo.CreateConversationProject(ctx, item); err != nil {
		return nil, err
	}
	return item, nil
}

const (
	maxProjectArchiveBytes      = 100 << 20
	maxProjectArchiveFiles      = 2000
	maxProjectArchiveFileBytes  = 20 << 20
	maxProjectArchiveTotalBytes = 200 << 20
)

// ProjectWorkspaceView 返回当前用户项目工作区及文件列表。
type ProjectWorkspaceView struct {
	Workspace model.ProjectWorkspace
	Files     []model.ProjectFile
}

// ProjectArchiveInput 定义项目 ZIP 导入请求。
type ProjectArchiveInput struct {
	UserID          uint
	ProjectPublicID string
	ArchiveName     string
	Reader          io.Reader
}

// ProjectArchiveResult 返回导入任务及文件统计。
type ProjectArchiveResult struct {
	Import     model.ProjectImport
	FileCount  int
	TotalBytes int64
}

// GetProjectWorkspace 按 user+project 授权读取项目工作区。
func (s *Service) GetProjectWorkspace(ctx context.Context, userID uint, projectPublicID string) (*ProjectWorkspaceView, error) {
	project, err := s.repo.GetConversationProjectByPublicID(ctx, userID, strings.TrimSpace(projectPublicID))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	workspace, err := s.repo.GetOrCreateProjectWorkspace(ctx, userID, project.ID, normalizePublicID(uuid.NewString()))
	if err != nil {
		return nil, err
	}
	files, err := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
	if err != nil {
		return nil, err
	}
	return &ProjectWorkspaceView{Workspace: *workspace, Files: files}, nil
}

// OpenProjectFileContent 按 user+project+file 三重边界读取项目文件。
func (s *Service) OpenProjectFileContent(ctx context.Context, userID uint, projectPublicID string, filePublicID string) (*appupload.FileContentResult, error) {
	project, err := s.repo.GetConversationProjectByPublicID(ctx, userID, strings.TrimSpace(projectPublicID))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	workspace, err := s.repo.GetProjectWorkspaceByProject(ctx, userID, project.ID)
	if err != nil {
		return nil, err
	}
	file, err := s.repo.GetProjectFile(ctx, userID, workspace.ID, strings.TrimSpace(filePublicID))
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

// ArchiveProjectFiles 流式写出当前用户项目文件 ZIP，目录条目不读取对象存储。
func (s *Service) ArchiveProjectFiles(ctx context.Context, userID uint, projectPublicID string, writer io.Writer) error {
	project, err := s.repo.GetConversationProjectByPublicID(ctx, userID, strings.TrimSpace(projectPublicID))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return ErrConversationProjectNotFound
		}
		return err
	}
	workspace, err := s.repo.GetProjectWorkspaceByProject(ctx, userID, project.ID)
	if err != nil {
		return err
	}
	files, err := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
	if err != nil {
		return err
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return err
	}
	archive := zip.NewWriter(writer)
	defer archive.Close()
	for _, file := range files {
		if file.EntryType != model.ProjectFileEntryTypeFile {
			continue
		}
		entry, err := archive.CreateHeader(&zip.FileHeader{Name: file.RelativePath, Method: zip.Deflate})
		if err != nil {
			return err
		}
		reader, _, err := store.Open(ctx, file.StorageKey)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(entry, reader)
		closeErr := reader.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// ImportProjectArchive 解压 ZIP 到项目工作区，所有路径、对象键和数据库写入均绑定 user+project。
func (s *Service) ImportProjectArchive(ctx context.Context, input ProjectArchiveInput) (*ProjectArchiveResult, error) {
	project, err := s.repo.GetConversationProjectByPublicID(ctx, input.UserID, strings.TrimSpace(input.ProjectPublicID))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	workspace, err := s.repo.GetOrCreateProjectWorkspace(ctx, input.UserID, project.ID, normalizePublicID(uuid.NewString()))
	if err != nil {
		return nil, err
	}
	if input.Reader == nil {
		return nil, ErrInvalidFileReference
	}
	data, err := io.ReadAll(io.LimitReader(input.Reader, maxProjectArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxProjectArchiveBytes {
		return nil, ErrFileTooLarge
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid project archive: %w", err)
	}
	job := model.ProjectImport{PublicID: normalizePublicID(uuid.NewString()), OwnerUserID: input.UserID, ProjectID: workspace.ID, Status: "processing", ArchiveName: strings.TrimSpace(input.ArchiveName)}
	if err = s.repo.CreateProjectImport(ctx, &job); err != nil {
		return nil, err
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		_ = s.repo.FailProjectImport(ctx, input.UserID, workspace.ID, job.ID, "storage_unavailable", "storage unavailable")
		return nil, err
	}
	files := make([]model.ProjectFile, 0, min(len(archive.File), maxProjectArchiveFiles))
	var total int64
	for _, entry := range archive.File {
		if len(files) >= maxProjectArchiveFiles {
			_ = s.repo.FailProjectImport(ctx, input.UserID, workspace.ID, job.ID, "too_many_files", "too many files")
			return nil, ErrFileTooLarge
		}
		relative := path.Clean(strings.ReplaceAll(entry.Name, "\\", "/"))
		if relative == "." || strings.HasPrefix(relative, "../") || strings.HasPrefix(relative, "/") {
			_ = s.repo.FailProjectImport(ctx, input.UserID, workspace.ID, job.ID, "invalid_path", "invalid archive path")
			return nil, ErrInvalidFileReference
		}
		if entry.FileInfo().IsDir() {
			continue
		}
		if entry.UncompressedSize64 > maxProjectArchiveFileBytes || total+int64(entry.UncompressedSize64) > maxProjectArchiveTotalBytes {
			_ = s.repo.FailProjectImport(ctx, input.UserID, workspace.ID, job.ID, "archive_too_large", "expanded archive too large")
			return nil, ErrFileTooLarge
		}
		reader, openErr := entry.Open()
		if openErr != nil {
			return nil, openErr
		}
		limited := io.LimitReader(reader, maxProjectArchiveFileBytes+1)
		key := fmt.Sprintf("project/%d/%d/%s", input.UserID, workspace.ID, uuid.NewString()+"/"+relative)
		info, putErr := store.Put(ctx, key, limited, objectstore.PutOptions{SizeBytes: int64(entry.UncompressedSize64), ContentType: mime.TypeByExtension(path.Ext(relative))})
		_ = reader.Close()
		if putErr != nil {
			return nil, putErr
		}
		name := path.Base(relative)
		files = append(files, model.ProjectFile{PublicID: normalizePublicID(uuid.NewString()), OwnerUserID: input.UserID, ProjectID: workspace.ID, RelativePath: relative, FileName: name, EntryType: model.ProjectFileEntryTypeFile, StorageKey: info.Key, MimeType: info.ContentType, SizeBytes: info.SizeBytes, Version: 1})
		total += info.SizeBytes
	}
	if err = s.repo.CompleteProjectImport(ctx, input.UserID, workspace.ID, job.ID, files, len(files), total); err != nil {
		return nil, err
	}
	return &ProjectArchiveResult{Import: job, FileCount: len(files), TotalBytes: total}, nil
}

// ListProjectFiles 列出当前用户项目工作区文件。
func (s *Service) ListProjectFiles(ctx context.Context, userID uint, projectPublicID string) ([]model.ProjectFile, error) {
	project, err := s.repo.GetConversationProjectByPublicID(ctx, userID, strings.TrimSpace(projectPublicID))
	if err != nil {
		return nil, err
	}
	workspace, err := s.repo.GetProjectWorkspaceByProject(ctx, userID, project.ID)
	if err != nil {
		return nil, err
	}
	return s.repo.ListProjectFiles(ctx, userID, workspace.ID)
}

// WriteProjectFile 在当前用户项目中创建文件，路径已存在时覆盖内容并递增版本。
func (s *Service) WriteProjectFile(ctx context.Context, userID uint, projectPublicID string, relativePath string, content []byte) (*model.ProjectFile, error) {
	relative, err := normalizeProjectFilePath(relativePath)
	if err != nil {
		return nil, err
	}
	if len(content) > maxProjectArchiveFileBytes {
		return nil, ErrFileTooLarge
	}
	project, err := s.repo.GetConversationProjectByPublicID(ctx, userID, strings.TrimSpace(projectPublicID))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	workspace, err := s.repo.GetOrCreateProjectWorkspace(ctx, userID, project.ID, normalizePublicID(uuid.NewString()))
	if err != nil {
		return nil, err
	}
	files, err := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
	if err != nil {
		return nil, err
	}
	var existing *model.ProjectFile
	for i := range files {
		if files[i].RelativePath == relative {
			existing = &files[i]
			break
		}
	}
	if existing != nil && existing.EntryType != model.ProjectFileEntryTypeFile {
		return nil, ErrInvalidFileReference
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(content)
	key := fmt.Sprintf("project/%d/%d/%s/%s", userID, workspace.ID, uuid.NewString(), relative)
	info, err := store.Put(ctx, key, bytes.NewReader(content), objectstore.PutOptions{SizeBytes: int64(len(content)), ContentType: mime.TypeByExtension(path.Ext(relative))})
	if err != nil {
		return nil, err
	}
	if existing != nil {
		updated, updateErr := s.repo.UpdateProjectFile(ctx, userID, workspace.ID, existing.PublicID, info.Key, info.ContentType, info.SizeBytes, hex.EncodeToString(digest[:]), existing.Version+1)
		if updateErr != nil {
			_ = store.Delete(ctx, info.Key)
			return nil, updateErr
		}
		if updateErr = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, info.SizeBytes-existing.SizeBytes, 0); updateErr != nil {
			return nil, updateErr
		}
		_ = store.Delete(ctx, existing.StorageKey)
		return updated, nil
	}
	// 创建前清理同路径的软删除残留行，避免 (project_id, relative_path) 唯一索引冲突。
	if err = s.repo.PurgeProjectFileByPath(ctx, userID, workspace.ID, relative); err != nil {
		return nil, err
	}
	item := &model.ProjectFile{PublicID: normalizePublicID(uuid.NewString()), OwnerUserID: userID, ProjectID: workspace.ID, RelativePath: relative, FileName: path.Base(relative), EntryType: model.ProjectFileEntryTypeFile, StorageKey: info.Key, MimeType: info.ContentType, SizeBytes: info.SizeBytes, SHA256: hex.EncodeToString(digest[:]), Version: 1}
	if err = s.repo.CreateProjectFile(ctx, item); err != nil {
		if !errors.Is(err, repository.ErrDuplicate) {
			_ = store.Delete(ctx, info.Key)
			return nil, err
		}
		// 并发写入竞争唯一索引：回读活动记录并按覆盖更新处理。
		latest, listErr := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
		if listErr != nil {
			_ = store.Delete(ctx, info.Key)
			return nil, err
		}
		var raced *model.ProjectFile
		for i := range latest {
			if latest[i].RelativePath == relative {
				raced = &latest[i]
				break
			}
		}
		if raced == nil {
			_ = store.Delete(ctx, info.Key)
			return nil, err
		}
		updated, updateErr := s.repo.UpdateProjectFile(ctx, userID, workspace.ID, raced.PublicID, info.Key, info.ContentType, info.SizeBytes, hex.EncodeToString(digest[:]), raced.Version+1)
		if updateErr != nil {
			_ = store.Delete(ctx, info.Key)
			return nil, updateErr
		}
		if updateErr = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, info.SizeBytes-raced.SizeBytes, 0); updateErr != nil {
			return nil, updateErr
		}
		_ = store.Delete(ctx, raced.StorageKey)
		return updated, nil
	}
	if err = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, info.SizeBytes, 1); err != nil {
		return nil, err
	}
	return item, nil
}

// DeleteProjectFile 按 user+project+file 三重边界删除项目文件。
func (s *Service) DeleteProjectFile(ctx context.Context, userID uint, projectPublicID string, filePublicID string) (*model.ProjectFile, error) {
	project, err := s.repo.GetConversationProjectByPublicID(ctx, userID, strings.TrimSpace(projectPublicID))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	workspace, err := s.repo.GetProjectWorkspaceByProject(ctx, userID, project.ID)
	if err != nil {
		return nil, err
	}
	deleted, err := s.repo.DeleteProjectFile(ctx, userID, workspace.ID, strings.TrimSpace(filePublicID))
	if err != nil {
		return nil, err
	}
	store, storeErr := s.storeProvider.Open(ctx)
	if storeErr == nil && deleted.StorageKey != "" {
		_ = store.Delete(ctx, deleted.StorageKey)
	}
	if err = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, -deleted.SizeBytes, -1); err != nil {
		return nil, err
	}
	return deleted, nil
}

func normalizeProjectFilePath(value string) (string, error) {
	relative := path.Clean(strings.ReplaceAll(strings.TrimSpace(value), "\\", "/"))
	if relative == "." || strings.HasPrefix(relative, "../") || strings.HasPrefix(relative, "/") {
		return "", ErrInvalidFileReference
	}
	return relative, nil
}

// ListConversationProjects 查询当前用户项目分组。
func (s *Service) ListConversationProjects(ctx context.Context, userID uint, statusFilter string) ([]model.ConversationProject, error) {
	return s.repo.ListConversationProjects(ctx, userID, normalizeConversationProjectStatusFilter(statusFilter))
}

// UpdateConversationProject 更新当前用户项目分组。
func (s *Service) UpdateConversationProject(
	ctx context.Context,
	userID uint,
	publicID string,
	input ConversationProjectPatchInput,
) (*model.ConversationProject, error) {
	patch, err := normalizeConversationProjectPatch(input)
	if err != nil {
		return nil, err
	}
	if patch.DefaultModel != nil || patch.MCPDefaultMode != nil || patch.DefaultMCPToolIDs != nil || patch.DefaultSkillIDs != nil || patch.DefaultKnowledgeBaseIDs != nil {
		current, currentErr := s.repo.GetConversationProjectByPublicID(ctx, userID, strings.TrimSpace(publicID))
		if currentErr != nil {
			if errors.Is(currentErr, repository.ErrNotFound) {
				return nil, ErrConversationProjectNotFound
			}
			return nil, currentErr
		}
		defaultModel := current.DefaultModel
		mode := current.MCPDefaultMode
		mcpToolIDs := current.DefaultMCPToolIDs
		skillIDs := current.DefaultSkillIDs
		knowledgeBaseIDs := current.DefaultKnowledgeBaseIDs
		if patch.DefaultModel != nil {
			defaultModel = *patch.DefaultModel
		}
		if patch.MCPDefaultMode != nil {
			mode = *patch.MCPDefaultMode
		}
		if patch.DefaultMCPToolIDs != nil {
			mcpToolIDs = *patch.DefaultMCPToolIDs
		}
		if patch.DefaultSkillIDs != nil {
			skillIDs = *patch.DefaultSkillIDs
		}
		if patch.DefaultKnowledgeBaseIDs != nil {
			knowledgeBaseIDs = *patch.DefaultKnowledgeBaseIDs
		}
		if mode == model.ConversationProjectMCPDefaultModeInherit {
			mcpToolIDs = []uint{}
		}
		if err = s.validateConversationProjectDefaults(ctx, userID, defaultModel, mode, mcpToolIDs, skillIDs, knowledgeBaseIDs, current); err != nil {
			return nil, err
		}
		patch.MCPDefaultMode = &mode
		patch.DefaultMCPToolIDs = &mcpToolIDs
		patch.DefaultSkillIDs = &skillIDs
		patch.DefaultKnowledgeBaseIDs = &knowledgeBaseIDs
	}
	item, err := s.repo.UpdateConversationProjectMetadataByPublicID(ctx, userID, strings.TrimSpace(publicID), patch)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	return item, nil
}

// DeleteConversationProject 删除当前用户项目分组。
func (s *Service) DeleteConversationProject(
	ctx context.Context,
	userID uint,
	publicID string,
	deleteConversations bool,
	options DeleteConversationOptions,
) (*DeleteConversationResult, error) {
	cleanupFileIDs, err := s.repo.DeleteConversationProjectByPublicID(
		ctx,
		userID,
		strings.TrimSpace(publicID),
		deleteConversations,
		deleteConversations && options.DeleteFiles,
	)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	result := &DeleteConversationResult{Deleted: true}
	if deleteConversations && options.DeleteFiles {
		result.DeletedFileCount, result.Quota = s.deleteConversationFiles(ctx, userID, cleanupFileIDs)
	}
	return result, nil
}

// ReorderConversationProjects 更新当前用户项目展示顺序。
func (s *Service) ReorderConversationProjects(ctx context.Context, userID uint, publicIDs []string) error {
	normalizedIDs := normalizeProjectPublicIDs(publicIDs)
	if len(normalizedIDs) == 0 || len(normalizedIDs) != len(publicIDs) {
		return ErrInvalidConversationProject
	}
	if err := s.repo.ReorderConversationProjects(ctx, userID, normalizedIDs); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return ErrConversationProjectNotFound
		}
		return err
	}
	return nil
}

// SetConversationProject 设置当前用户单个会话的项目归属，空项目 ID 表示解除归属。
func (s *Service) SetConversationProject(
	ctx context.Context,
	userID uint,
	conversationPublicID string,
	projectPublicID string,
) (*model.Conversation, error) {
	projectID, err := s.resolveConversationProjectID(ctx, userID, projectPublicID)
	if err != nil {
		return nil, err
	}
	item, err := s.repo.UpdateConversationProjectAssignmentByPublicID(ctx, userID, strings.TrimSpace(conversationPublicID), projectID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationNotFound
		}
		return nil, err
	}
	return item, nil
}

// BatchSetConversationProject 批量设置当前用户会话项目归属。
func (s *Service) BatchSetConversationProject(
	ctx context.Context,
	userID uint,
	conversationPublicIDs []string,
	projectPublicID string,
) (int64, error) {
	normalizedConversationIDs := normalizeProjectPublicIDs(conversationPublicIDs)
	if len(normalizedConversationIDs) == 0 || len(normalizedConversationIDs) != len(conversationPublicIDs) {
		return 0, ErrInvalidConversationProject
	}
	projectID, err := s.resolveConversationProjectID(ctx, userID, projectPublicID)
	if err != nil {
		return 0, err
	}
	updated, err := s.repo.BatchUpdateConversationProjectByPublicIDs(ctx, userID, normalizedConversationIDs, projectID)
	if err != nil {
		return 0, err
	}
	if updated != int64(len(normalizedConversationIDs)) {
		return updated, ErrConversationNotFound
	}
	return updated, nil
}

func (s *Service) resolveConversationProjectID(ctx context.Context, userID uint, publicID string) (*uint, error) {
	normalizedPublicID := strings.TrimSpace(publicID)
	if normalizedPublicID == "" || normalizedPublicID == "unassigned" {
		return nil, nil
	}
	project, err := s.repo.GetConversationProjectByPublicID(ctx, userID, normalizedPublicID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	return &project.ID, nil
}

func normalizeConversationProjectInput(input ConversationProjectInput) (ConversationProjectInput, error) {
	mcpDefaultMode := normalizeConversationProjectMCPDefaultMode(input.MCPDefaultMode)
	if mcpDefaultMode == "" {
		if strings.TrimSpace(input.MCPDefaultMode) != "" {
			return ConversationProjectInput{}, ErrInvalidConversationProject
		}
		mcpDefaultMode = model.ConversationProjectMCPDefaultModeInherit
	}
	normalized := ConversationProjectInput{
		Name:                    strings.TrimSpace(input.Name),
		Description:             strings.TrimSpace(input.Description),
		SystemPrompt:            strings.TrimSpace(input.SystemPrompt),
		DefaultModel:            strings.TrimSpace(input.DefaultModel),
		MCPDefaultMode:          mcpDefaultMode,
		DefaultMCPToolIDs:       uniqueToolIDs(input.DefaultMCPToolIDs),
		DefaultSkillIDs:         normalizeSelectedSkillIDs(input.DefaultSkillIDs),
		DefaultKnowledgeBaseIDs: normalizeProjectPublicIDs(input.DefaultKnowledgeBaseIDs),
		Color:                   strings.TrimSpace(input.Color),
		Icon:                    strings.TrimSpace(input.Icon),
	}
	if normalized.MCPDefaultMode == model.ConversationProjectMCPDefaultModeInherit {
		normalized.DefaultMCPToolIDs = []uint{}
	}
	if normalized.Name == "" || exceedsRuneLimit(normalized.Name, conversationProjectNameMaxChars) {
		return ConversationProjectInput{}, ErrInvalidConversationProject
	}
	if len(normalized.DefaultKnowledgeBaseIDs) != len(input.DefaultKnowledgeBaseIDs) || len(normalized.DefaultKnowledgeBaseIDs) > 8 {
		return ConversationProjectInput{}, ErrInvalidConversationProject
	}
	if exceedsRuneLimit(normalized.Description, conversationProjectDescriptionMaxChars) ||
		exceedsRuneLimit(normalized.SystemPrompt, conversationProjectSystemPromptMaxChars) ||
		exceedsRuneLimit(normalized.DefaultModel, conversationProjectModelMaxChars) ||
		exceedsRuneLimit(normalized.Color, conversationProjectMetaMaxChars) ||
		exceedsRuneLimit(normalized.Icon, conversationProjectMetaMaxChars) {
		return ConversationProjectInput{}, ErrInvalidConversationProject
	}
	return normalized, nil
}

func normalizeConversationProjectPatch(input ConversationProjectPatchInput) (model.ConversationProjectPatch, error) {
	var patch model.ConversationProjectPatch
	if input.Name != nil {
		value := strings.TrimSpace(*input.Name)
		if value == "" || exceedsRuneLimit(value, conversationProjectNameMaxChars) {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.Name = &value
	}
	if input.Description != nil {
		value := strings.TrimSpace(*input.Description)
		if exceedsRuneLimit(value, conversationProjectDescriptionMaxChars) {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.Description = &value
	}
	if input.SystemPrompt != nil {
		value := strings.TrimSpace(*input.SystemPrompt)
		if exceedsRuneLimit(value, conversationProjectSystemPromptMaxChars) {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.SystemPrompt = &value
	}
	if input.DefaultModel != nil {
		value := strings.TrimSpace(*input.DefaultModel)
		if exceedsRuneLimit(value, conversationProjectModelMaxChars) {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.DefaultModel = &value
	}
	if input.MCPDefaultMode != nil {
		value := normalizeConversationProjectMCPDefaultMode(*input.MCPDefaultMode)
		if value == "" {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.MCPDefaultMode = &value
	}
	if input.DefaultMCPToolIDs != nil {
		value := uniqueToolIDs(*input.DefaultMCPToolIDs)
		patch.DefaultMCPToolIDs = &value
	}
	if input.DefaultSkillIDs != nil {
		value := normalizeSelectedSkillIDs(*input.DefaultSkillIDs)
		patch.DefaultSkillIDs = &value
	}
	if input.DefaultKnowledgeBaseIDs != nil {
		value := normalizeProjectPublicIDs(*input.DefaultKnowledgeBaseIDs)
		if len(value) != len(*input.DefaultKnowledgeBaseIDs) || len(value) > 8 {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.DefaultKnowledgeBaseIDs = &value
	}
	if input.Color != nil {
		value := strings.TrimSpace(*input.Color)
		if exceedsRuneLimit(value, conversationProjectMetaMaxChars) {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.Color = &value
	}
	if input.Icon != nil {
		value := strings.TrimSpace(*input.Icon)
		if exceedsRuneLimit(value, conversationProjectMetaMaxChars) {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.Icon = &value
	}
	if input.Status != nil {
		value := normalizeConversationProjectStatus(*input.Status)
		if value == "" {
			return model.ConversationProjectPatch{}, ErrInvalidConversationProject
		}
		patch.Status = &value
	}
	if patch.Name == nil && patch.Description == nil && patch.SystemPrompt == nil && patch.DefaultModel == nil && patch.MCPDefaultMode == nil &&
		patch.DefaultMCPToolIDs == nil && patch.DefaultSkillIDs == nil && patch.DefaultKnowledgeBaseIDs == nil && patch.Color == nil && patch.Icon == nil && patch.Status == nil {
		return model.ConversationProjectPatch{}, ErrInvalidConversationProject
	}
	return patch, nil
}

// validateConversationProjectDefaults 校验项目默认能力的数量和新增关联的可用性。
func (s *Service) validateConversationProjectDefaults(
	ctx context.Context,
	userID uint,
	defaultModel string,
	mcpDefaultMode string,
	mcpToolIDs []uint,
	skillIDs []uint,
	knowledgeBaseIDs []string,
	current *model.ConversationProject,
) error {
	if normalizeConversationProjectMCPDefaultMode(mcpDefaultMode) == "" {
		return ErrInvalidConversationProject
	}
	normalizedDefaultModel := strings.TrimSpace(defaultModel)
	defaultModelChanged := current == nil || normalizedDefaultModel != strings.TrimSpace(current.DefaultModel)
	if defaultModelChanged && normalizedDefaultModel != "" {
		available, err := s.isAvailableConversationProjectDefaultModel(ctx, userID, normalizedDefaultModel)
		if err != nil {
			return err
		}
		if !available {
			return ErrInvalidConversationProject
		}
	}
	mcpSelectionChanged := current == nil ||
		mcpDefaultMode != current.MCPDefaultMode ||
		!slices.Equal(mcpToolIDs, current.DefaultMCPToolIDs)
	skillSelectionChanged := current == nil || !slices.Equal(skillIDs, current.DefaultSkillIDs)
	knowledgeBaseSelectionChanged := current == nil || !slices.Equal(knowledgeBaseIDs, current.DefaultKnowledgeBaseIDs)
	if (mcpSelectionChanged && len(mcpToolIDs) > s.resolveMaxSelectedToolsPerMessage()) ||
		(skillSelectionChanged && len(skillIDs) > s.resolveMaxSelectedSkillsPerMessage()) {
		return ErrInvalidConversationProject
	}
	mcpToolIDsToValidate := mcpToolIDs
	skillIDsToValidate := skillIDs
	knowledgeBaseIDsToValidate := knowledgeBaseIDs
	if current != nil {
		mcpToolIDsToValidate = newProjectDefaultIDs(mcpToolIDs, current.DefaultMCPToolIDs)
		skillIDsToValidate = newProjectDefaultIDs(skillIDs, current.DefaultSkillIDs)
		knowledgeBaseIDsToValidate = newProjectDefaultPublicIDs(knowledgeBaseIDs, current.DefaultKnowledgeBaseIDs)
	}
	var selectedToolsByID map[uint]domainmcp.Tool
	if mcpDefaultMode == model.ConversationProjectMCPDefaultModeCustom &&
		len(mcpToolIDs) > 0 &&
		(mcpSelectionChanged || len(mcpToolIDsToValidate) > 0) {
		if s.mcpRepo == nil {
			return ErrInvalidConversationProject
		}
		tools, err := s.mcpRepo.ListToolsByIDs(ctx, mcpToolIDs)
		if err != nil {
			return err
		}
		selectedToolsByID = make(map[uint]domainmcp.Tool, len(tools))
		imageProcessorCount := 0
		for _, tool := range tools {
			selectedToolsByID[tool.ID] = tool
			if tool.AttachmentInputMode == domainmcp.AttachmentInputModeImage {
				imageProcessorCount++
			}
		}
		if imageProcessorCount > 1 {
			return ErrInvalidConversationProject
		}
	}
	if mcpDefaultMode == model.ConversationProjectMCPDefaultModeCustom && len(mcpToolIDsToValidate) > 0 {
		for _, toolID := range mcpToolIDsToValidate {
			if _, ok := selectedToolsByID[toolID]; !ok {
				return ErrInvalidConversationProject
			}
		}
		servers, err := s.mcpRepo.ListServers(ctx)
		if err != nil {
			return err
		}
		activeServerIDs := make(map[uint]struct{}, len(servers))
		for _, server := range servers {
			if server.Status == "active" {
				activeServerIDs[server.ID] = struct{}{}
			}
		}
		for _, toolID := range mcpToolIDsToValidate {
			tool := selectedToolsByID[toolID]
			if tool.Status != "active" {
				return ErrInvalidConversationProject
			}
			if _, active := activeServerIDs[tool.ServerID]; !active {
				return ErrInvalidConversationProject
			}
		}
	}
	if len(skillIDsToValidate) > 0 {
		if s.skillResolver == nil {
			return ErrInvalidConversationProject
		}
		_, total, err := s.skillResolver.ListVisible(ctx, userID, appskill.ListInput{
			IDs:      skillIDsToValidate,
			Page:     1,
			PageSize: 1,
		})
		if err != nil {
			return err
		}
		if total != int64(len(skillIDsToValidate)) {
			return ErrInvalidConversationProject
		}
	}
	if knowledgeBaseSelectionChanged && len(knowledgeBaseIDs) > 8 {
		return ErrInvalidConversationProject
	}
	if len(knowledgeBaseIDsToValidate) > 0 {
		if s.knowledgeBaseResolver == nil {
			return ErrInvalidConversationProject
		}
		bases, _, err := s.knowledgeBaseResolver.ResolveFiles(ctx, userID, knowledgeBaseIDsToValidate)
		if err != nil {
			if errors.Is(err, domainknowledgebase.ErrReferenceUnavailable) {
				return ErrInvalidConversationProject
			}
			return err
		}
		for _, base := range bases {
			if base.ReadyFileCount == 0 {
				return ErrInvalidConversationProject
			}
		}
	}
	return nil
}

func (s *Service) isAvailableConversationProjectDefaultModel(ctx context.Context, userID uint, platformModelName string) (bool, error) {
	resolver, ok := s.routeResolver.(activeModelCatalogResolver)
	if !ok {
		return false, nil
	}
	models, err := resolver.ListActiveModels(ctx, userID)
	if err != nil {
		return false, err
	}
	name := strings.TrimSpace(platformModelName)
	for _, item := range models {
		if strings.TrimSpace(item.PlatformModelName) == name && channel.ModelSupportsTask(item.KindsJSON, channel.TaskTypeChat) {
			return true, nil
		}
	}
	return false, nil
}

func newProjectDefaultPublicIDs(selectedIDs []string, existingIDs []string) []string {
	existing := make(map[string]struct{}, len(existingIDs))
	for _, id := range existingIDs {
		existing[id] = struct{}{}
	}
	added := make([]string, 0, len(selectedIDs))
	for _, id := range selectedIDs {
		if _, ok := existing[id]; !ok {
			added = append(added, id)
		}
	}
	return added
}

// newProjectDefaultIDs 返回本次更新新增的默认能力 ID。
func newProjectDefaultIDs(selectedIDs []uint, existingIDs []uint) []uint {
	existing := make(map[uint]struct{}, len(existingIDs))
	for _, id := range existingIDs {
		existing[id] = struct{}{}
	}
	added := make([]uint, 0, len(selectedIDs))
	for _, id := range selectedIDs {
		if _, ok := existing[id]; !ok {
			added = append(added, id)
		}
	}
	return added
}

// normalizeConversationProjectMCPDefaultMode 规范项目 MCP 默认模式。
func normalizeConversationProjectMCPDefaultMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case model.ConversationProjectMCPDefaultModeInherit:
		return model.ConversationProjectMCPDefaultModeInherit
	case model.ConversationProjectMCPDefaultModeCustom:
		return model.ConversationProjectMCPDefaultModeCustom
	default:
		return ""
	}
}

func normalizeProjectPublicIDs(values []string) []string {
	results := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		normalized := strings.TrimSpace(value)
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		results = append(results, normalized)
	}
	return results
}

func normalizeConversationProjectStatusFilter(value string) string {
	switch normalizeConversationProjectStatus(value) {
	case "archived":
		return "archived"
	case "active":
		return "active"
	default:
		if strings.TrimSpace(value) == "all" {
			return "all"
		}
		return "active"
	}
}

func normalizeConversationProjectStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "active":
		return "active"
	case "archived":
		return "archived"
	default:
		return ""
	}
}

func normalizeConversationProjectFilter(value string) string {
	normalized := strings.TrimSpace(value)
	switch normalized {
	case "", "all":
		return "all"
	case "unassigned":
		return "unassigned"
	default:
		return normalized
	}
}

func exceedsRuneLimit(value string, limit int) bool {
	return limit >= 0 && utf8.RuneCountInString(value) > limit
}
