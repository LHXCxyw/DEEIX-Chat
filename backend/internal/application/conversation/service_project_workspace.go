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
	"strings"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

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
		info, putErr := store.Put(ctx, key, limited, objectstorage.PutOptions{SizeBytes: int64(entry.UncompressedSize64), ContentType: mime.TypeByExtension(path.Ext(relative))})
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
	// 导入产生的文件同样进入变更日志（来源 import），保证消息回退能恢复到导入前/后的状态。
	changes := make([]model.ProjectFileChange, 0, len(files))
	for i := range files {
		changes = append(changes, model.ProjectFileChange{
			OwnerUserID: input.UserID, ProjectID: workspace.ID, RelativePath: files[i].RelativePath,
			Op: model.ProjectFileChangeOpWrite, Source: model.ProjectFileChangeSourceImport,
			Before: model.ProjectFileSnapshot{}, After: projectFileSnapshot(&files[i]),
		})
	}
	if err = s.repo.CreateProjectFileChanges(ctx, input.UserID, workspace.ID, changes); err != nil {
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

// ProjectFileChangeContext 描述一次项目文件写入/删除的来源上下文，供文件变更日志记录。
type ProjectFileChangeContext struct {
	Source         string
	ConversationID uint
	MessageID      uint
	RunID          string
}

// AgentFileChangeContext 返回 agent 工具调用场景的变更来源上下文。
func AgentFileChangeContext(conversationID uint, messageID uint, runID string) ProjectFileChangeContext {
	return ProjectFileChangeContext{Source: model.ProjectFileChangeSourceAgent, ConversationID: conversationID, MessageID: messageID, RunID: runID}
}

// UserFileChangeContext 返回用户在项目面板直接操作的变更来源上下文。
func UserFileChangeContext() ProjectFileChangeContext {
	return ProjectFileChangeContext{Source: model.ProjectFileChangeSourceUser}
}

func projectFileSnapshot(item *model.ProjectFile) model.ProjectFileSnapshot {
	if item == nil {
		return model.ProjectFileSnapshot{}
	}
	return model.ProjectFileSnapshot{
		Version: item.Version, StorageKey: item.StorageKey, SHA256: item.SHA256,
		SizeBytes: item.SizeBytes, MimeType: item.MimeType,
	}
}

// recordProjectFileChange 追加一条文件变更日志。变更日志是消息回退（rewind）推导
// 历史工作区状态的唯一依据，写入失败必须让整个操作失败，避免日志与实际状态脱节。
func (s *Service) recordProjectFileChange(ctx context.Context, userID uint, workspaceID uint, changeCtx ProjectFileChangeContext, relativePath string, op string, before model.ProjectFileSnapshot, after model.ProjectFileSnapshot) error {
	item := model.ProjectFileChange{
		OwnerUserID: userID, ProjectID: workspaceID, RelativePath: relativePath,
		Op: op, Source: changeCtx.Source, ConversationID: changeCtx.ConversationID,
		MessageID: changeCtx.MessageID, RunID: changeCtx.RunID,
		Before: before, After: after,
	}
	return s.repo.CreateProjectFileChanges(ctx, userID, workspaceID, []model.ProjectFileChange{item})
}

// WriteProjectFile 在当前用户项目中创建文件，路径已存在时覆盖内容并递增版本。
// 覆盖时旧对象保留在对象存储中不再删除，配合文件变更日志支持消息回退恢复历史内容。
// expectedVersion 缺省兼容旧调用；0 表示仅创建，正整数表示仅覆盖对应版本。
func (s *Service) WriteProjectFile(ctx context.Context, userID uint, projectPublicID string, relativePath string, content []byte, changeCtx ProjectFileChangeContext, expectedVersion ...*int) (*model.ProjectFile, error) {
	var expected *int
	if len(expectedVersion) > 0 {
		expected = expectedVersion[0]
	}
	return s.writeProjectFile(ctx, userID, projectPublicID, relativePath, content, changeCtx, expected, "")
}

func (s *Service) writeProjectFile(ctx context.Context, userID uint, projectPublicID string, relativePath string, content []byte, changeCtx ProjectFileChangeContext, expected *int, expectedPublicID string) (*model.ProjectFile, error) {
	if expected != nil && *expected < 0 {
		return nil, ErrInvalidProjectFileVersion
	}
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
	return s.writeWorkspaceFile(ctx, userID, workspace, relative, content, changeCtx, expected, expectedPublicID)
}

func (s *Service) writeWorkspaceFile(ctx context.Context, userID uint, workspace *model.ProjectWorkspace, relative string, content []byte, changeCtx ProjectFileChangeContext, expected *int, expectedPublicID string) (*model.ProjectFile, error) {
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
	if expectedPublicID != "" && (existing == nil || existing.PublicID != expectedPublicID) {
		return nil, ErrProjectFileVersionConflict
	}
	if expected != nil && ((existing == nil && *expected != 0) || (existing != nil && existing.Version != *expected)) {
		return nil, ErrProjectFileVersionConflict
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
	info, err := store.Put(ctx, key, bytes.NewReader(content), objectstorage.PutOptions{SizeBytes: int64(len(content)), ContentType: mime.TypeByExtension(path.Ext(relative))})
	if err != nil {
		return nil, err
	}
	if existing != nil {
		beforeSnapshot := projectFileSnapshot(existing)
		updated, updateErr := s.repo.CompareAndSwapProjectFile(ctx, userID, workspace.ID, existing.PublicID, info.Key, info.ContentType, info.SizeBytes, hex.EncodeToString(digest[:]), existing.Version)
		if updateErr != nil {
			_ = store.Delete(ctx, info.Key)
			if errors.Is(updateErr, repository.ErrConflict) || errors.Is(updateErr, repository.ErrNotFound) {
				return nil, ErrProjectFileVersionConflict
			}
			return nil, updateErr
		}
		if updateErr = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, info.SizeBytes-existing.SizeBytes, 0); updateErr != nil {
			return nil, updateErr
		}
		if err = s.recordProjectFileChange(ctx, userID, workspace.ID, changeCtx, relative, model.ProjectFileChangeOpWrite, beforeSnapshot, projectFileSnapshot(updated)); err != nil {
			return nil, err
		}
		return updated, nil
	}
	// 创建前清理同路径的软删除残留行，避免 (project_id, relative_path) 唯一索引冲突。
	if err = s.repo.PurgeProjectFileByPath(ctx, userID, workspace.ID, relative); err != nil {
		_ = store.Delete(ctx, info.Key)
		return nil, err
	}
	item := &model.ProjectFile{PublicID: normalizePublicID(uuid.NewString()), OwnerUserID: userID, ProjectID: workspace.ID, RelativePath: relative, FileName: path.Base(relative), EntryType: model.ProjectFileEntryTypeFile, StorageKey: info.Key, MimeType: info.ContentType, SizeBytes: info.SizeBytes, SHA256: hex.EncodeToString(digest[:]), Version: 1}
	if err = s.repo.CreateProjectFile(ctx, item); err != nil {
		if expected != nil && errors.Is(err, repository.ErrDuplicate) {
			_ = store.Delete(ctx, info.Key)
			return nil, ErrProjectFileVersionConflict
		}
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
		updated, updateErr := s.repo.CompareAndSwapProjectFile(ctx, userID, workspace.ID, raced.PublicID, info.Key, info.ContentType, info.SizeBytes, hex.EncodeToString(digest[:]), raced.Version)
		if updateErr != nil {
			_ = store.Delete(ctx, info.Key)
			if errors.Is(updateErr, repository.ErrConflict) || errors.Is(updateErr, repository.ErrNotFound) {
				return nil, ErrProjectFileVersionConflict
			}
			return nil, updateErr
		}
		if updateErr = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, info.SizeBytes-raced.SizeBytes, 0); updateErr != nil {
			return nil, updateErr
		}
		if err = s.recordProjectFileChange(ctx, userID, workspace.ID, changeCtx, relative, model.ProjectFileChangeOpWrite, projectFileSnapshot(raced), projectFileSnapshot(updated)); err != nil {
			return nil, err
		}
		return updated, nil
	}
	if err = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, info.SizeBytes, 1); err != nil {
		return nil, err
	}
	if err = s.recordProjectFileChange(ctx, userID, workspace.ID, changeCtx, relative, model.ProjectFileChangeOpWrite, model.ProjectFileSnapshot{}, projectFileSnapshot(item)); err != nil {
		return nil, err
	}
	return item, nil
}

// DeleteProjectFile 按 user+project+file 三重边界删除项目文件。
// 文件行被删除，但其内容对象保留在对象存储中（由变更日志引用），支持消息回退恢复。
func (s *Service) DeleteProjectFile(ctx context.Context, userID uint, projectPublicID string, filePublicID string, changeCtx ProjectFileChangeContext) (*model.ProjectFile, error) {
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
		if errors.Is(err, repository.ErrNotFound) && s.logger != nil {
			// 404 诊断：记录当前工作区内全部现有 PublicID，用于定位"列表 ID 与库内行不一致"。
			existing, listErr := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
			if listErr == nil {
				ids := make([]string, 0, len(existing))
				for i := range existing {
					ids = append(ids, existing[i].PublicID)
				}
				s.logger.Warn("project_file_delete_not_found",
					zap.Uint("user_id", userID),
					zap.String("project_public_id", strings.TrimSpace(projectPublicID)),
					zap.Uint("workspace_id", workspace.ID),
					zap.String("requested_file_id", strings.TrimSpace(filePublicID)),
					zap.Strings("existing_file_ids", ids),
				)
			}
		}
		return nil, err
	}
	// 删除主体已成功；变更日志与用量统计为附属簿记，失败不回滚删除结果，
	// 仅告警并携带具体步骤与错误（此前这两步失败会让用户看到 500，但文件其实已删）。
	if err = s.recordProjectFileChange(ctx, userID, workspace.ID, changeCtx, deleted.RelativePath, model.ProjectFileChangeOpDelete, projectFileSnapshot(deleted), model.ProjectFileSnapshot{}); err != nil {
		if s.logger != nil {
			s.logger.Warn("project_file_delete_change_log_failed",
				zap.Uint("user_id", userID),
				zap.Uint("workspace_id", workspace.ID),
				zap.String("file_public_id", deleted.PublicID),
				zap.String("relative_path", deleted.RelativePath),
				zap.Error(err),
			)
		}
	}
	if err = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, workspace.ID, -deleted.SizeBytes, -1); err != nil && s.logger != nil {
		s.logger.Warn("project_file_delete_usage_update_failed",
			zap.Uint("user_id", userID),
			zap.Uint("workspace_id", workspace.ID),
			zap.String("file_public_id", deleted.PublicID),
			zap.Error(err),
		)
	}
	return deleted, nil
}

func normalizeProjectFilePath(value string) (string, error) {
	relative := path.Clean(strings.ReplaceAll(strings.TrimSpace(value), "\\", "/"))
	if relative == "." || relative == ".." || strings.ContainsAny(relative, ":\x00") || strings.HasPrefix(relative, "../") || strings.HasPrefix(relative, "/") {
		return "", ErrInvalidFileReference
	}
	return relative, nil
}
