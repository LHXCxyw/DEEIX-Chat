package conversation

import (
	"errors"
	"net/http"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

func (h *Handler) ListToolApprovals(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	items, err := h.service.ListToolApprovals(c.Request.Context(), middleware.MustUserID(c))
	if err != nil {
		response.InternalError(c, err)
		return
	}
	response.Success(c, items)
}

func (h *Handler) DecideToolApproval(c *gin.Context) {
	var req struct {
		Decision string `json:"decision" binding:"required,oneof=allow deny"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	err := h.service.DecideToolApproval(c.Request.Context(), middleware.MustUserID(c), c.Param("approval_id"), req.Decision == "allow")
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			response.ErrorFrom(c, http.StatusNotFound, err)
		} else if errors.Is(err, repository.ErrConflict) {
			response.ErrorFrom(c, http.StatusConflict, err)
		} else {
			response.InternalError(c, err)
		}
		return
	}
	h.recordAudit(c, "tool_approval_decision", "tool_approval", c.Param("approval_id"), map[string]any{"decision": req.Decision})
	response.Success(c, map[string]any{"decision": req.Decision})
}
