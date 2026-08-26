package channel

import (
	"errors"
	"net/http"
	"strconv"

	appchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

func (h *Handler) ListUserEmbeddingProfiles(c *gin.Context) {
	v, e := h.service.ListUserEmbeddingProfiles(c.Request.Context(), middleware.MustUserID(c))
	if e != nil {
		userRAGError(c, e)
		return
	}
	response.Success(c, gin.H{"items": v, "total": len(v)})
}
func (h *Handler) SaveUserEmbeddingProfile(c *gin.Context) {
	var q SaveEmbeddingProfileRequest
	if e := c.ShouldBindJSON(&q); e != nil {
		response.InvalidRequestBody(c, e)
		return
	}
	v, e := h.service.SaveUserEmbeddingProfile(c.Request.Context(), middleware.MustUserID(c), appchannel.SaveEmbeddingProfileInput{ID: q.ID, UpstreamID: q.UpstreamID, UserModelID: q.UserModelID, Name: q.Name, Protocol: q.Protocol, EmbeddingModelID: q.EmbeddingModelID, OutputDimensions: q.OutputDimensions, Normalize: q.Normalize, BatchSize: q.BatchSize, RequestTimeoutSeconds: q.RequestTimeoutSeconds, Status: q.Status, IsDefault: q.IsDefault})
	if e != nil {
		userRAGError(c, e)
		return
	}
	response.Success(c, v)
}
func (h *Handler) DeleteUserEmbeddingProfile(c *gin.Context) {
	id, e := strconv.ParseUint(c.Param("id"), 10, 32)
	if e != nil || id == 0 {
		response.Error(c, 400, "invalid profile id")
		return
	}
	if e = h.service.DeleteUserEmbeddingProfile(c.Request.Context(), middleware.MustUserID(c), uint(id)); e != nil {
		userRAGError(c, e)
		return
	}
	response.Success(c, gin.H{"message": "deleted"})
}
func (h *Handler) GetUserRAGSettings(c *gin.Context) {
	v, e := h.service.GetUserRAGSettings(c.Request.Context(), middleware.MustUserID(c))
	if e != nil {
		userRAGError(c, e)
		return
	}
	response.Success(c, v)
}
func (h *Handler) SaveUserRAGSettings(c *gin.Context) {
	var q SaveRAGSettingsRequest
	if e := c.ShouldBindJSON(&q); e != nil {
		response.InvalidRequestBody(c, e)
		return
	}
	v, e := h.service.SaveUserRAGSettings(c.Request.Context(), middleware.MustUserID(c), ragInput(q))
	if e != nil {
		userRAGError(c, e)
		return
	}
	response.Success(c, v)
}
func (h *Handler) GetProjectRAGSettings(c *gin.Context) {
	v, e := h.service.GetProjectRAGSettings(c.Request.Context(), middleware.MustUserID(c), c.Param("project_id"))
	if e != nil {
		userRAGError(c, e)
		return
	}
	response.Success(c, v)
}
func (h *Handler) SaveProjectRAGSettings(c *gin.Context) {
	var q SaveRAGSettingsRequest
	if e := c.ShouldBindJSON(&q); e != nil {
		response.InvalidRequestBody(c, e)
		return
	}
	v, e := h.service.SaveProjectRAGSettings(c.Request.Context(), middleware.MustUserID(c), c.Param("project_id"), ragInput(q))
	if e != nil {
		userRAGError(c, e)
		return
	}
	response.Success(c, v)
}
func userRAGError(c *gin.Context, e error) {
	switch {
	case errors.Is(e, appchannel.ErrUserEmbeddingDisabled), errors.Is(e, appchannel.ErrUserRAGDisabled):
		response.Error(c, http.StatusForbidden, e.Error())
	case errors.Is(e, repository.ErrNotFound):
		response.Error(c, http.StatusNotFound, "resource not found")
	case errors.Is(e, repository.ErrInvalidInput):
		response.Error(c, http.StatusBadRequest, "invalid embedding or RAG settings")
	default:
		response.Error(c, http.StatusInternalServerError, "embedding or RAG operation failed")
	}
}
