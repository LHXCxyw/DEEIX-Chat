package conversation

import (
	"errors"
	"net/http"
	"strings"
	"time"

	appconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/filelink"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/filecontent"
	"github.com/gin-gonic/gin"
)

// GetSignedFileContent 凭限时签名访问文件内容，供无登录态的上游服务（如视频生成网关）回源拉取。
// 签名由服务端在生成媒体任务提交时签发，绑定用户、文件与过期时间。
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
	h.serveFileContent(c, userID, fileID)
}

// serveFileContent 按用户权限读取并回写文件内容。
func (h *Handler) serveFileContent(c *gin.Context, userID uint, fileID string) {
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

	_ = filecontent.Write(c, result, false)
}