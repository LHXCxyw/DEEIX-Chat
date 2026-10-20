package conversation

import (
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/gin-gonic/gin"
)

func (h *Handler) GetAgentCapabilities(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	response.Success(c, h.service.AgentCapabilities(c.Request.Context()))
}
