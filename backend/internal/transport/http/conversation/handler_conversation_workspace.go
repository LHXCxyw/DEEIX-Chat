package conversation

import (
	"errors"
	"net/http"

	appconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
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
