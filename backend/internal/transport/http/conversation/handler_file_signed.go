package conversation

import (
	"errors"
	"net/http"
	"strings"
	"time"

	appconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/filelink"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/filecontent"
	"github.com/gin-gonic/gin"
)

// GetSignedFileContent 凭限时签名访问文件内容，供无登录态的上游服务（如视频生成网关）与浏览器媒体直连加载。
// 签名由服务端在生成媒体任务提交或 DTO 组装时签发，绑定用户、文件与过期时间。
func (h *Handler) GetSignedFileContent(c *gin.Context) {
	fileID := c.Param("file_id")
	if strings.TrimSpace(fileID) == "" {
		response.ErrorFrom(c, http.StatusBadRequest, errInvalidFileID)
		return
	}
	cfg := h.cfg.Snapshot()
	userID, err := filelink.Verify(
		cfg.JWTSecret,
		c.Query("user_id"),
		fileID,
		c.Query("expires"),
		c.Query("signature"),
		time.Now(),
	)
	if err != nil {
		response.ErrorFrom(c, http.StatusUnauthorized, errInvalidFileSignature)
		return
	}
	h.serveFileContent(c, userID, fileID, true)
}

// GetSignedFileThumbnail 凭变体签名访问图片缩略图，供浏览器 <img> 直连加载。
// 签名绑定用户、文件与变体档位，thumb 档签名无法换取 preview 档内容。
func (h *Handler) GetSignedFileThumbnail(c *gin.Context) {
	fileID := c.Param("file_id")
	if strings.TrimSpace(fileID) == "" {
		response.ErrorFrom(c, http.StatusBadRequest, errInvalidFileID)
		return
	}
	variant, err := appupload.ParseThumbnailVariant(c.Query("variant"))
	if err != nil {
		response.ErrorFrom(c, http.StatusBadRequest, errInvalidFileID)
		return
	}
	cfg := h.cfg.Snapshot()
	userID, err := filelink.VerifyThumbnail(
		cfg.JWTSecret,
		c.Query("user_id"),
		fileID,
		variant,
		c.Query("expires"),
		c.Query("signature"),
		time.Now(),
	)
	if err != nil {
		response.ErrorFrom(c, http.StatusUnauthorized, errInvalidFileSignature)
		return
	}
	result, err := h.uploads.OpenThumbnail(c.Request.Context(), userID, fileID, variant)
	if err != nil {
		switch {
		case errors.Is(err, appconversation.ErrFileNotFound),
			errors.Is(err, appupload.ErrThumbnailUnsupported):
			response.ErrorFrom(c, http.StatusNotFound, appconversation.ErrFileNotFound)
		default:
			response.InternalError(c)
		}
		return
	}
	_ = filecontent.Write(c, result, true)
}

// serveFileContent 按用户权限读取并回写文件内容。
// ETag 命中时直接 304，不打开存储内容、不触碰访问时间。
func (h *Handler) serveFileContent(c *gin.Context, userID uint, fileID string, public bool) {
	item, err := h.uploads.StatFileContent(c.Request.Context(), userID, fileID)
	if err != nil {
		switch {
		case errors.Is(err, appconversation.ErrInvalidFileReference):
			response.ErrorFrom(c, http.StatusBadRequest, errInvalidFileID)
			return
		case errors.Is(err, appconversation.ErrFileNotFound):
			response.ErrorFrom(c, http.StatusNotFound, appconversation.ErrFileNotFound)
			return
		default:
			response.InternalError(c)
			return
		}
	}
	if filecontent.RequestNotModified(c, item.SHA256) {
		filecontent.WriteNotModified(c, item.Purpose, public, filecontent.ETag(item.SHA256))
		return
	}
	result, err := h.uploads.OpenFileContent(c.Request.Context(), userID, fileID)
	if err != nil {
		switch {
		case errors.Is(err, appconversation.ErrInvalidFileReference):
			response.ErrorFrom(c, http.StatusBadRequest, errInvalidFileID)
			return
		case errors.Is(err, appconversation.ErrFileNotFound):
			response.ErrorFrom(c, http.StatusNotFound, appconversation.ErrFileNotFound)
			return
		default:
			response.InternalError(c)
			return
		}
	}

	_ = filecontent.Write(c, result, public)
}
