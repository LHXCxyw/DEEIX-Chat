package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/filelink"
)

// maxDeliveredFilesPayloadChars 限制逐文件列表在工具输出中的序列化体积。
// 消息轨迹只会保留工具详情的前 4096 个字符，超出即截断成非法 JSON，
// 前端将无法解析出下载卡片；因此这里按字节预算提前收口，剩余文件改由整包 ZIP 链接下载。
const maxDeliveredFilesPayloadChars = 2800

// workspaceDeliveredFile 是交付给前端的单个文件引用，只含元数据与限时链接，不含文件内容。
type workspaceDeliveredFile struct {
	Path      string `json:"path"`
	FileName  string `json:"file_name"`
	SizeBytes int64  `json:"size_bytes"`
	// DownloadURL 是限时下载地址：配置了公开 API 域名时为绝对链接，否则为相对路径。
	DownloadURL string `json:"download_url"`
}

// workspaceDeliveredArchive 是目录或多文件的整包下载引用。
type workspaceDeliveredArchive struct {
	FileName    string `json:"file_name"`
	FileCount   int    `json:"file_count"`
	TotalBytes  int64  `json:"total_bytes"`
	DownloadURL string `json:"download_url"`
}

// deliverWorkspaceFiles 为 agent 生成带时效的文件下载引用：单文件直接给出文件链接，
// 目录或多文件额外给出整包 ZIP 链接。整个流程只读取文件元数据，不读取也不回传文件内容。
func (s *Service) deliverWorkspaceFiles(ctx context.Context, input ExecuteToolInput, args map[string]interface{}) (string, error) {
	if input.UserID == 0 || input.ConversationID == 0 {
		return "", ErrInvalidFileReference
	}
	conversation, err := s.repo.GetConversationByUser(ctx, input.ConversationID, input.UserID)
	if err != nil {
		return "", ErrConversationNotFound
	}
	// 项目会话已有独立的工作区文件接口与固定版本归档工具，避免出现两套互相矛盾的下载入口。
	if conversation.ProjectID != nil {
		return "", fmt.Errorf("project conversation: use project_create_archive for fixed ZIP delivery; workspace download links are only for non-project conversations")
	}
	conversationPublicID := strings.TrimSpace(conversation.PublicID)
	if conversationPublicID == "" {
		return "", ErrInvalidFileReference
	}

	targets := deliveryTargetsArg(args)
	archive, err := s.PrepareConversationWorkspaceArchive(ctx, input.UserID, conversationPublicID, targets)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			// 工作区尚未创建时返回空结果，而不是让模型误以为工具失败。
			return marshalProjectToolResult(map[string]interface{}{
				"files": []workspaceDeliveredFile{}, "total_files": 0, "total_bytes": 0,
				"download_ui": true, "message": "workspace is empty; no files to deliver",
			})
		}
		return "", err
	}

	cfg := s.cfg.Snapshot()
	now := time.Now()
	files := make([]workspaceDeliveredFile, 0, len(archive.Files))
	payloadChars := 0
	for _, file := range archive.Files {
		entry := workspaceDeliveredFile{
			Path:        file.RelativePath,
			FileName:    file.FileName,
			SizeBytes:   file.SizeBytes,
			DownloadURL: filelink.BuildWorkspaceDownloadURL(cfg.PublicAPIBaseURL, cfg.JWTSecret, input.UserID, conversationPublicID, filelink.WorkspaceDownloadModeFile, []string{file.RelativePath}, now),
		}
		if entry.DownloadURL == "" {
			entry.DownloadURL = filelink.BuildSignedWorkspaceDownloadPath(cfg.JWTSecret, input.UserID, conversationPublicID, filelink.WorkspaceDownloadModeFile, []string{file.RelativePath}, now)
		}
		encoded, marshalErr := json.Marshal(entry)
		if marshalErr != nil {
			return "", marshalErr
		}
		// 至少保留第一条，避免超长路径导致卡片完全没有文件条目；
		// 其余条目按预算收口，超出的文件仍可通过整包 ZIP 下载。
		if len(files) > 0 && payloadChars+len(encoded)+1 > maxDeliveredFilesPayloadChars {
			break
		}
		payloadChars += len(encoded) + 1
		files = append(files, entry)
	}

	result := map[string]interface{}{
		"files":       files,
		"total_files": len(archive.Files),
		"total_bytes": archive.TotalBytes,
		"truncated":   len(files) < len(archive.Files),
		"download_ui": true,
		"message":     "download links are valid for about one hour; print each download_url verbatim in the final reply",
	}
	if len(archive.Files) == 0 {
		result["message"] = "workspace is empty; no files to deliver"
		return marshalProjectToolResult(result)
	}
	// 仅当目标精确指向单个文件时才走单文件模式；目录目标即使只有一条也必须打包。
	if singleDeliveredFile(archive.Files, targets) {
		return marshalProjectToolResult(result)
	}
	archiveURL := filelink.BuildWorkspaceDownloadURL(cfg.PublicAPIBaseURL, cfg.JWTSecret, input.UserID, conversationPublicID, filelink.WorkspaceDownloadModeArchive, targets, now)
	if archiveURL == "" {
		archiveURL = filelink.BuildSignedWorkspaceDownloadPath(cfg.JWTSecret, input.UserID, conversationPublicID, filelink.WorkspaceDownloadModeArchive, targets, now)
	}
	result["archive"] = workspaceDeliveredArchive{
		FileName:    archive.FileName,
		FileCount:   len(archive.Files),
		TotalBytes:  archive.TotalBytes,
		DownloadURL: archiveURL,
	}
	return marshalProjectToolResult(result)
}

// singleDeliveredFile 判断本次交付是否就是单个具体文件：只有一个目标且与命中的文件路径完全一致。
func singleDeliveredFile(files []model.ProjectFile, targets []string) bool {
	if len(files) != 1 || len(targets) != 1 {
		return false
	}
	normalized, err := normalizeProjectFilePath(targets[0])
	if err != nil {
		return false
	}
	return files[0].RelativePath == normalized
}

// deliveryTargetsArg 解析交付目标：支持字符串数组或单个字符串，去空去重后返回。
func deliveryTargetsArg(args map[string]interface{}) []string {
	raw, ok := args["files"]
	if !ok || raw == nil {
		return nil
	}
	appendValue := func(targets []string, value string) []string {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return append(targets, trimmed)
		}
		return targets
	}
	switch typed := raw.(type) {
	case string:
		return appendValue(nil, typed)
	case []interface{}:
		targets := make([]string, 0, len(typed))
		for _, item := range typed {
			if value, isString := item.(string); isString {
				targets = appendValue(targets, value)
			}
		}
		return targets
	case []string:
		targets := make([]string, 0, len(typed))
		for _, value := range typed {
			targets = appendValue(targets, value)
		}
		return targets
	default:
		return nil
	}
}
