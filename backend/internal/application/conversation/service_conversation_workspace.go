package conversation

import (
	"archive/zip"
	"context"
	"io"
	"strings"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/google/uuid"
)

// ConversationWorkspaceArchive 是已通过目标、数量与体积校验的会话工作区打包下载计划。
type ConversationWorkspaceArchive struct {
	FileName   string
	Files      []model.ProjectFile
	TotalBytes int64
}

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
	if file == nil {
		return nil, ErrFileNotFound
	}
	return s.openConversationWorkspaceFile(ctx, *file)
}

// OpenConversationWorkspacePath 按相对路径读取会话工作区文件内容。
// 路径先经 normalizeProjectFilePath 归一化，再与数据库记录精确匹配；服务端从不按路径直接访问磁盘。
func (s *Service) OpenConversationWorkspacePath(ctx context.Context, userID uint, publicID string, relativePath string) (*appupload.FileContentResult, error) {
	relative, err := normalizeProjectFilePath(relativePath)
	if err != nil {
		return nil, err
	}
	workspace, err := s.conversationWorkspace(ctx, userID, publicID, false)
	if err != nil {
		return nil, err
	}
	files, err := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		if file.RelativePath != relative {
			continue
		}
		if file.EntryType != model.ProjectFileEntryTypeFile {
			return nil, ErrInvalidFileReference
		}
		return s.openConversationWorkspaceFile(ctx, file)
	}
	return nil, ErrFileNotFound
}

// PrepareConversationWorkspaceArchive 校验下载目标并返回打包计划。
// targets 为空表示整个工作区；目录目标按路径前缀递归包含其下所有文件；显式目标无匹配时返回 ErrFileNotFound。
func (s *Service) PrepareConversationWorkspaceArchive(ctx context.Context, userID uint, publicID string, targets []string) (*ConversationWorkspaceArchive, error) {
	workspace, err := s.conversationWorkspace(ctx, userID, publicID, false)
	if err != nil {
		return nil, err
	}
	files, err := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
	if err != nil {
		return nil, err
	}
	selected, err := selectConversationWorkspaceFiles(files, targets)
	if err != nil {
		return nil, err
	}
	if len(selected) > maxProjectArchiveFiles {
		return nil, ErrFileTooLarge
	}
	var totalBytes int64
	for _, file := range selected {
		if file.SizeBytes > maxProjectArchiveFileBytes || totalBytes+file.SizeBytes > maxProjectArchiveTotalBytes {
			return nil, ErrFileTooLarge
		}
		totalBytes += file.SizeBytes
	}
	fileName := "workspace-files.zip"
	if conversation, conversationErr := s.GetConversationByPublicID(ctx, userID, strings.TrimSpace(publicID)); conversationErr == nil {
		fileName = safeConversationArchiveFileName(conversation.Title)
	}
	return &ConversationWorkspaceArchive{FileName: fileName, Files: selected, TotalBytes: totalBytes}, nil
}

// WriteConversationWorkspaceArchive 流式写出已校验的会话工作区 ZIP。
func (s *Service) WriteConversationWorkspaceArchive(ctx context.Context, archive *ConversationWorkspaceArchive, writer io.Writer) error {
	if archive == nil {
		return ErrInvalidFileReference
	}
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return err
	}
	zipWriter := zip.NewWriter(writer)
	defer zipWriter.Close()
	for _, file := range archive.Files {
		entry, err := zipWriter.CreateHeader(&zip.FileHeader{Name: file.RelativePath, Method: zip.Deflate})
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

func (s *Service) openConversationWorkspaceFile(ctx context.Context, file model.ProjectFile) (*appupload.FileContentResult, error) {
	store, err := s.storeProvider.Open(ctx)
	if err != nil {
		return nil, err
	}
	reader, info, err := store.Open(ctx, file.StorageKey)
	if err != nil {
		return nil, err
	}
	return &appupload.FileContentResult{
		File:        model.FileObject{FileID: file.PublicID, FileName: file.FileName, MimeType: file.MimeType, SizeBytes: file.SizeBytes},
		Reader:      reader,
		ContentType: info.ContentType,
		SizeBytes:   info.SizeBytes,
		ModTime:     info.ModTime,
	}, nil
}

// selectConversationWorkspaceFiles 按目标筛选可打包的文件条目。
func selectConversationWorkspaceFiles(files []model.ProjectFile, targets []string) ([]model.ProjectFile, error) {
	fileOnly := make([]model.ProjectFile, 0, len(files))
	for _, file := range files {
		if file.EntryType == model.ProjectFileEntryTypeFile {
			fileOnly = append(fileOnly, file)
		}
	}
	if len(targets) == 0 {
		return fileOnly, nil
	}

	selected := make([]model.ProjectFile, 0, len(fileOnly))
	seen := make(map[string]struct{}, len(fileOnly))
	for _, rawTarget := range targets {
		target, err := normalizeProjectFilePath(rawTarget)
		if err != nil {
			return nil, err
		}
		prefix := strings.TrimSuffix(target, "/") + "/"
		matched := false
		for _, file := range fileOnly {
			if file.RelativePath != target && !strings.HasPrefix(file.RelativePath, prefix) {
				continue
			}
			matched = true
			if _, exists := seen[file.PublicID]; exists {
				continue
			}
			seen[file.PublicID] = struct{}{}
			selected = append(selected, file)
		}
		if matched {
			continue
		}
		// 空目录没有文件条目，但目录本身存在，视为合法目标。
		for _, file := range files {
			if file.EntryType == model.ProjectFileEntryTypeDirectory && strings.TrimSuffix(file.RelativePath, "/") == strings.TrimSuffix(target, "/") {
				matched = true
				break
			}
		}
		if !matched {
			return nil, ErrFileNotFound
		}
	}
	return selected, nil
}

// safeConversationArchiveFileName 生成可安全写入 Content-Disposition 的中文友好文件名。
func safeConversationArchiveFileName(title string) string {
	name := strings.TrimSpace(title)
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		}
		if r < 32 {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if name == "" {
		return "workspace-files.zip"
	}
	if runes := []rune(name); len(runes) > 80 {
		name = string(runes[:80])
	}
	return name + "-files.zip"
}
