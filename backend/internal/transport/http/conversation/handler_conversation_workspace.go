package conversation

import (
	"errors"
	"net/http"
	"strings"
	"time"

	appconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/filelink"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/filecontent"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

func conversationWorkspaceError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, appconversation.ErrProjectAttachmentEditAuthorizationRequired):
		response.ErrorFrom(c, http.StatusForbidden, err)
	case errors.Is(err, appconversation.ErrInvalidFileReference):
		response.ErrorFrom(c, http.StatusBadRequest, err)
	case errors.Is(err, appconversation.ErrConversationNotFound), errors.Is(err, appconversation.ErrFileNotFound), errors.Is(err, repository.ErrNotFound):
		response.ErrorFrom(c, http.StatusNotFound, err)
	case errors.Is(err, appconversation.ErrProjectFileVersionConflict):
		response.ErrorFrom(c, http.StatusConflict, err)
	case errors.Is(err, appconversation.ErrFileTooLarge):
		response.ErrorFrom(c, http.StatusRequestEntityTooLarge, err)
	case errors.Is(err, appconversation.ErrMIMEBlocked):
		response.ErrorFrom(c, http.StatusUnsupportedMediaType, err)
	default:
		response.InternalError(c, err)
	}
}

func (h *Handler) GetConversationWorkspace(c *gin.Context) {
	view, err := h.service.GetConversationWorkspace(c.Request.Context(), middleware.MustUserID(c), c.Param("id"))
	if err != nil {
		conversationWorkspaceError(c, err)
		return
	}
	response.Success(c, view)
}

func (h *Handler) ImportConversationFileFromAttachment(c *gin.Context) {
	var req ImportProjectAttachmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	if !req.EditAuthorized {
		response.ErrorFrom(c, http.StatusForbidden, appconversation.ErrProjectAttachmentEditAuthorizationRequired)
		return
	}
	item, err := h.service.ImportConversationFileFromAttachment(c.Request.Context(), appconversation.ConversationAttachmentInput{UserID: middleware.MustUserID(c), ConversationPublicID: c.Param("id"), FileID: req.FileID, Path: req.Path, EditAuthorized: req.EditAuthorized})
	if err != nil {
		conversationWorkspaceError(c, err)
		return
	}
	response.Success(c, item)
}

func (h *Handler) GetConversationWorkspaceFileContent(c *gin.Context) {
	content, err := h.service.OpenConversationWorkspaceFileContent(c.Request.Context(), middleware.MustUserID(c), c.Param("id"), c.Param("file_id"))
	if err != nil {
		conversationWorkspaceError(c, err)
		return
	}
	_ = filecontent.Write(c, content, false)
}

// GetConversationWorkspaceDownload 按相对路径下载会话工作区中的单个文件。
// 路径只与数据库记录精确匹配，客户端无法借助路径穿越访问工作区之外的存储对象。
func (h *Handler) GetConversationWorkspaceDownload(c *gin.Context) {
	relativePath := strings.TrimSpace(c.Query("path"))
	if relativePath == "" {
		response.ErrorFrom(c, http.StatusBadRequest, appconversation.ErrInvalidFileReference)
		return
	}
	content, err := h.service.OpenConversationWorkspacePath(c.Request.Context(), middleware.MustUserID(c), c.Param("id"), relativePath)
	if err != nil {
		conversationWorkspaceError(c, err)
		return
	}
	_ = filecontent.Write(c, content, false)
}

// GetConversationWorkspaceArchive 流式打包下载会话工作区：path 可重复传入多个文件或目录，
// 不传 path 表示整个工作区。目录按路径前缀递归包含其下所有文件。
func (h *Handler) GetConversationWorkspaceArchive(c *gin.Context) {
	userID := middleware.MustUserID(c)
	archive, err := h.service.PrepareConversationWorkspaceArchive(c.Request.Context(), userID, c.Param("id"), workspaceTargets(c))
	if err != nil {
		conversationWorkspaceError(c, err)
		return
	}
	filecontent.WriteArchiveHeaders(c, archive.FileName, false)
	if err := h.service.WriteConversationWorkspaceArchive(c.Request.Context(), archive, c.Writer); err != nil {
		c.Abort()
	}
}

// GetSignedWorkspaceDownload 凭限时签名下载会话工作区文件或目录 ZIP。
// 签名绑定用户、会话公开 ID、模式与目标路径；过期、篡改或换会话都会返回 401。
func (h *Handler) GetSignedWorkspaceDownload(c *gin.Context) {
	cfg := h.cfg.Snapshot()
	targets := workspaceTargets(c)
	userID, err := filelink.VerifyWorkspace(
		cfg.JWTSecret,
		c.Query("user_id"),
		c.Query("conversation_id"),
		c.Query("mode"),
		targets,
		c.Query("expires"),
		c.Query("signature"),
		time.Now(),
	)
	if err != nil {
		response.ErrorFrom(c, http.StatusUnauthorized, errInvalidFileSignature)
		return
	}
	conversationPublicID := strings.TrimSpace(c.Query("conversation_id"))
	mode := filelink.NormalizeWorkspaceMode(c.Query("mode"), targets)
	if mode == filelink.WorkspaceDownloadModeFile {
		if len(targets) != 1 {
			response.ErrorFrom(c, http.StatusBadRequest, appconversation.ErrInvalidFileReference)
			return
		}
		content, openErr := h.service.OpenConversationWorkspacePath(c.Request.Context(), userID, conversationPublicID, targets[0])
		if openErr != nil {
			conversationWorkspaceError(c, openErr)
			return
		}
		_ = filecontent.Write(c, content, true)
		return
	}
	archive, prepareErr := h.service.PrepareConversationWorkspaceArchive(c.Request.Context(), userID, conversationPublicID, targets)
	if prepareErr != nil {
		conversationWorkspaceError(c, prepareErr)
		return
	}
	filecontent.WriteArchiveHeaders(c, archive.FileName, true)
	if writeErr := h.service.WriteConversationWorkspaceArchive(c.Request.Context(), archive, c.Writer); writeErr != nil {
		c.Abort()
	}
}

// workspaceTargets 收集可重复的 path 查询参数，去空后返回。
func workspaceTargets(c *gin.Context) []string {
	raw := c.QueryArray("path")
	targets := make([]string, 0, len(raw))
	for _, item := range raw {
		value := strings.TrimSpace(item)
		if value == "" {
			continue
		}
		targets = append(targets, value)
	}
	return targets
}
