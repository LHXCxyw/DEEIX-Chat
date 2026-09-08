package channel

import (
	"errors"
	"net/http"

	appchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/gin-gonic/gin"
)

func toUserUpstreamPresetResponse(item domainchannel.UserUpstreamPreset) UserUpstreamPresetResponse {
	return UserUpstreamPresetResponse{ID: item.ID, Name: item.Name, BaseURL: item.BaseURL, Compatible: item.Compatible, ProtocolDefaults: item.ProtocolDefaultsJSON, Enabled: item.Enabled, SortOrder: item.SortOrder}
}

func (h *Handler) ListUserUpstreamPresets(c *gin.Context) {
	items, err := h.service.ListEnabledUserUpstreamPresets(c.Request.Context())
	writeUserUpstreamPresetList(c, items, err)
}

func (h *Handler) ListAdminUserUpstreamPresets(c *gin.Context) {
	items, err := h.service.ListUserUpstreamPresets(c.Request.Context())
	writeUserUpstreamPresetList(c, items, err)
}

func writeUserUpstreamPresetList(c *gin.Context, items []domainchannel.UserUpstreamPreset, err error) {
	if err != nil {
		response.InternalError(c)
		return
	}
	result := make([]UserUpstreamPresetResponse, 0, len(items))
	for _, item := range items {
		result = append(result, toUserUpstreamPresetResponse(item))
	}
	response.Success(c, result)
}

func (h *Handler) ReplaceUserUpstreamPresets(c *gin.Context) {
	var req []UserUpstreamPresetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	items := make([]domainchannel.UserUpstreamPreset, len(req))
	for i, item := range req {
		enabled := true
		if item.Enabled != nil {
			enabled = *item.Enabled
		}
		items[i] = domainchannel.UserUpstreamPreset{ID: item.ID, Name: item.Name, BaseURL: item.BaseURL, Compatible: item.Compatible, ProtocolDefaultsJSON: item.ProtocolDefaults, Enabled: enabled, SortOrder: item.SortOrder}
	}
	if err := h.service.ReplaceUserUpstreamPresets(c.Request.Context(), items); err != nil {
		switch {
		case errors.Is(err, appchannel.ErrInvalidJSONConfig),
			errors.Is(err, appchannel.ErrInvalidProtocolDefaultsConfig),
			errors.Is(err, appchannel.ErrInvalidAdapter),
			errors.Is(err, appchannel.ErrInvalidCompatible),
			errors.Is(err, appchannel.ErrInvalidUpstreamBaseURL),
			errors.Is(err, repository.ErrInvalidInput):
			response.Error(c, http.StatusBadRequest, err.Error())
		default:
			response.InternalError(c)
		}
		return
	}
	response.Success(c, gin.H{"message": "user upstream presets updated"})
}
