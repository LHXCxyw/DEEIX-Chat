package usersettings

import (
	"errors"
	"net/http"

	appusersettings "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/usersettings"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

// CanvasStateResponse 画布快照响应：快照内容与服务端写入时间（毫秒）。
// updatedAt 由服务端生成，客户端据此判断云端是否已被其他设备更新。
type CanvasStateResponse struct {
	State     string `json:"state"`
	UpdatedAt int64  `json:"updatedAt"`
}

// CanvasStateResponseDoc Swagger 响应文档。
type CanvasStateResponseDoc struct {
	ErrorMsg string              `json:"errorMsg"`
	Data     CanvasStateResponse `json:"data"`
}

// CanvasStatePutRequest 覆盖写入画布快照请求。
type CanvasStatePutRequest struct {
	State string `json:"state" binding:"required"`
}

// GetCanvasState godoc
// @Summary 读取当前用户的画布快照
// @Description 返回最近一次保存的画布快照与服务端写入时间；从未保存过时 state 为空、updatedAt 为 0
// @Tags user/canvas-state
// @Produce json
// @Security BearerAuth
// @Success 200 {object} CanvasStateResponseDoc
// @Failure 500 {object} response.Envelope
// @Router /user/canvas-state [get]
func (h *Handler) GetCanvasState(c *gin.Context) {
	userID := middleware.MustUserID(c)
	data, err := h.service.GetCanvasState(c.Request.Context(), userID)
	if err != nil {
		response.InternalError(c, err)
		return
	}
	response.Success(c, CanvasStateResponse{State: data.State, UpdatedAt: data.UpdatedAt})
}

// PutCanvasState godoc
// @Summary 保存当前用户的画布快照
// @Description 整份覆盖保存画布快照，返回服务端写入时间；服务端不做合并，读取始终以最近一次写入为准
// @Tags user/canvas-state
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body CanvasStatePutRequest true "画布快照"
// @Success 200 {object} CanvasStateResponseDoc
// @Failure 400 {object} response.Envelope
// @Failure 500 {object} response.Envelope
// @Router /user/canvas-state [put]
func (h *Handler) PutCanvasState(c *gin.Context) {
	var req CanvasStatePutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}

	userID := middleware.MustUserID(c)
	updatedAt, err := h.service.PutCanvasState(c.Request.Context(), userID, req.State)
	if err != nil {
		if errors.Is(err, appusersettings.ErrInvalidSettingValue) {
			response.ErrorFrom(c, http.StatusBadRequest, err)
		} else {
			response.InternalError(c, err)
		}
		return
	}
	response.Success(c, CanvasStateResponse{State: req.State, UpdatedAt: updatedAt})
}
