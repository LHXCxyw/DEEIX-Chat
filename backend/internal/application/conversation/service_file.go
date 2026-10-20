package conversation

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/apperr"
	"go.uber.org/zap"
)

const maxProjectAttachmentBytes = 2 << 20

var ErrProjectAttachmentEditAuthorizationRequired = apperr.New("project.attachment_edit_authorization_required", "explicit edit authorization is required")

// ProjectAttachmentInput 将只读附件复制为用户明确授权编辑的项目工作副本。
type ProjectAttachmentInput struct {
	UserID          uint
	ProjectPublicID string
	FileID          string
	Path            string
	EditAuthorized  bool
}

// ImportProjectFileFromAttachment 只读取附件原件，不解压、不覆盖已有项目文件。
func (s *Service) ImportProjectFileFromAttachment(ctx context.Context, input ProjectAttachmentInput) (*model.ProjectFile, error) {
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
	if _, err = s.repo.GetConversationProjectByPublicID(ctx, input.UserID, strings.TrimSpace(input.ProjectPublicID)); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationProjectNotFound
		}
		return nil, err
	}
	content, err := s.readAttachmentWorkingCopy(ctx, input.UserID, input.FileID, relative)
	if err != nil {
		return nil, err
	}
	expectedVersion := 0
	return s.WriteProjectFile(ctx, input.UserID, input.ProjectPublicID, relative, content, UserFileChangeContext(), &expectedVersion)
}

func (s *Service) readAttachmentWorkingCopy(ctx context.Context, userID uint, fileID string, relative string) ([]byte, error) {
	result, err := s.uploadSvc.OpenFileContent(ctx, userID, fileID)
	if err != nil {
		return nil, err
	}
	defer result.Reader.Close()
	if result.File.UserID != userID {
		return nil, ErrFileNotFound
	}
	if result.File.SizeBytes > maxProjectAttachmentBytes || result.SizeBytes > maxProjectAttachmentBytes {
		return nil, ErrFileTooLarge
	}
	for _, name := range []string{result.File.FileName, relative} {
		if strings.EqualFold(path.Ext(strings.ReplaceAll(name, "\\", "/")), ".zip") {
			return nil, ErrMIMEBlocked
		}
	}
	for _, mediaType := range []string{result.File.MimeType, result.File.DetectedMIME, result.ContentType} {
		if strings.Contains(strings.ToLower(mediaType), "zip") {
			return nil, ErrMIMEBlocked
		}
	}
	return readProjectAttachmentText(result.Reader)
}

func normalizeProjectAttachmentPath(value string) (string, error) {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if len(value) > 1024 || strings.ContainsAny(value, ":\x00") || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return "", ErrInvalidFileReference
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." || strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
			return "", ErrInvalidFileReference
		}
	}
	return normalizeProjectFilePath(value)
}

func readProjectAttachmentText(reader io.Reader) ([]byte, error) {
	content, err := io.ReadAll(io.LimitReader(reader, maxProjectAttachmentBytes+1))
	if err != nil {
		return nil, err
	}
	if len(content) > maxProjectAttachmentBytes {
		return nil, ErrFileTooLarge
	}
	if !utf8.Valid(content) || (len(content) > 0 && !strings.HasPrefix(http.DetectContentType(content), "text/")) {
		return nil, ErrMIMEBlocked
	}
	for _, char := range string(content) {
		if unicode.IsControl(char) && char != '\n' && char != '\r' && char != '\t' {
			return nil, ErrMIMEBlocked
		}
	}
	return content, nil
}

// FileExtractResult 表示当前用户可读取的文件提取文本。
type FileExtractResult struct {
	FileID       string
	ExtractText  string
	PreviewText  string
	ExtractChars int
	ExtractPages int
	OCRUsed      bool
}

func (s *Service) cloneOrTriggerEmbedding(ctx context.Context, source *model.FileObject, target *model.FileObject) {
	if target == nil {
		return
	}
	if source != nil && source.EmbedStatus == "ready" && source.ChunkCount > 0 {
		if err := s.repo.CloneFileEmbeddingArtifacts(ctx, source, target); err == nil {
			return
		} else if s.logger != nil {
			s.logger.Warn("clone_embedding_artifacts_failed",
				zap.String("source_file_id", source.FileID),
				zap.String("target_file_id", target.FileID),
				zap.Error(err),
			)
		}
	}
	s.embeddingSvc.MaybeTrigger(ctx, *target)
}

// GetFileExtract 读取当前用户文件的提取文本产物。
func (s *Service) GetFileExtract(ctx context.Context, userID uint, fileID string) (*FileExtractResult, error) {
	normalizedFileID := strings.TrimSpace(fileID)
	if normalizedFileID == "" {
		return nil, ErrInvalidFileReference
	}
	fileObj, err := s.repo.GetActiveFileObjectByID(ctx, userID, normalizedFileID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) || errors.Is(err, repository.ErrFileNotFound) {
			return nil, ErrFileNotFound
		}
		return nil, err
	}
	if fileObj == nil {
		return nil, ErrFileNotFound
	}

	result, err := s.repo.GetFileObjectProcessingByObjectID(ctx, fileObj.ID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrFileProcessingNotReady
		}
		return nil, err
	}
	if result == nil || strings.TrimSpace(result.ExtractStoragePath) == "" || strings.TrimSpace(fileObj.ExtractStatus) != "ready" {
		return nil, ErrFileProcessingNotReady
	}
	if s.extractSvc == nil {
		return nil, ErrFileProcessingNotReady
	}

	text, err := s.extractSvc.ReadExtractedText(ctx, result.ExtractStoragePath)
	if err != nil {
		return nil, err
	}
	return &FileExtractResult{
		FileID:       fileObj.FileID,
		ExtractText:  text,
		PreviewText:  result.PreviewText,
		ExtractChars: result.ExtractChars,
		ExtractPages: result.ExtractPages,
		OCRUsed:      result.OCRUsed,
	}, nil
}
