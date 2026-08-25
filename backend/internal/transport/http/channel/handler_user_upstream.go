package channel

import (
	"errors"
	"net/http"
	"strconv"

	appchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

// ListUserUpstreams godoc
// @Summary 查询用户自有渠道列表
// @Description 用户查询自己创建的所有上游渠道
// @Tags user-upstream
// @Accept json
// @Produce json
// @Security BearerAuth
// @Success 200 {object} UserUpstreamListResponse
// @Failure 403 {object} response.Envelope "功能未启用"
// @Failure 500 {object} response.Envelope
// @Router /user/upstreams [get]
func (h *Handler) ListUserUpstreams(c *gin.Context) {
	ctx := c.Request.Context()
	userID := middleware.MustUserID(c)
	
	upstreams, err := h.service.ListUserUpstreams(ctx, userID)
	if err != nil {
		if errors.Is(err, appchannel.ErrUserUpstreamDisabled) {
			response.Error(c, http.StatusForbidden, "user upstream feature is disabled")
			return
		}
		response.Error(c, http.StatusInternalServerError, "list user upstreams failed")
		return
	}
	
	response.Success(c, UserUpstreamListResponse{
		Items: toUserUpstreamResponses(upstreams),
	})
}

// CreateUserUpstream godoc
// @Summary 创建用户自有渠道
// @Description 用户创建自己的上游渠道（BYOK）
// @Tags user-upstream
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body CreateUserUpstreamRequest true "渠道配置"
// @Success 201 {object} UserUpstreamResponse
// @Failure 400 {object} response.Envelope "参数错误"
// @Failure 403 {object} response.Envelope "功能未启用或超过配额"
// @Failure 500 {object} response.Envelope
// @Router /user/upstreams [post]
func (h *Handler) CreateUserUpstream(c *gin.Context) {
	ctx := c.Request.Context()
	userID := middleware.MustUserID(c)
	
	var req CreateUserUpstreamRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	
	input := appchannel.CreateUserUpstreamInput{
		Name:             req.Name,
		BaseURL:          req.BaseURL,
		Compatible:       req.Compatible,
		APIKeys:          convertAPIKeyInputs(req.APIKeys),
		ConnectTimeoutMS: req.ConnectTimeoutMS,
		ReadTimeoutMS:    req.ReadTimeoutMS,
		Headers:          req.Headers,
	}
	
	upstream, err := h.service.CreateUserUpstream(ctx, userID, input)
	if err != nil {
		switch {
		case errors.Is(err, appchannel.ErrUserUpstreamDisabled):
			response.Error(c, http.StatusForbidden, "user upstream feature is disabled")
		case errors.Is(err, appchannel.ErrUserUpstreamQuotaExceeded):
			response.Error(c, http.StatusForbidden, "user upstream quota exceeded")
		case errors.Is(err, appchannel.ErrInvalidUpstreamName),
			errors.Is(err, appchannel.ErrInvalidBaseURL),
			errors.Is(err, appchannel.ErrAPIKeysRequired):
			response.Error(c, http.StatusBadRequest, err.Error())
		default:
			response.Error(c, http.StatusInternalServerError, "create user upstream failed")
		}
		return
	}
	
	c.JSON(http.StatusCreated, toUserUpstreamResponse(*upstream))
}

// GetUserUpstream godoc
// @Summary 获取用户指定渠道详情
// @Description 查询用户自有渠道的详细信息
// @Tags user-upstream
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "渠道ID"
// @Success 200 {object} UserUpstreamResponse
// @Failure 404 {object} response.Envelope
// @Failure 500 {object} response.Envelope
// @Router /user/upstreams/{id} [get]
func (h *Handler) GetUserUpstream(c *gin.Context) {
	ctx := c.Request.Context()
	userID := middleware.MustUserID(c)
	upstreamID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid upstream id")
		return
	}
	
	// 使用仓储层方法获取（带越权校验）
	upstream, err := h.service.GetUserUpstreamByID(ctx, userID, uint(upstreamID))
	if err != nil {
		if errors.Is(err, appchannel.ErrUserUpstreamDisabled) {
			response.Error(c, http.StatusForbidden, "user upstream feature is disabled")
			return
		}
		response.Error(c, http.StatusNotFound, "user upstream not found")
		return
	}
	
	response.Success(c, toUserUpstreamResponse(*upstream))
}

// UpdateUserUpstream godoc
// @Summary 更新用户自有渠道
// @Description 更新用户自有渠道配置，未传字段保持原值
// @Tags user-upstream
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "渠道ID"
// @Param body body UpdateUserUpstreamRequest true "更新内容"
// @Success 200 {object} response.Envelope
// @Failure 400 {object} response.Envelope
// @Failure 403 {object} response.Envelope
// @Failure 404 {object} response.Envelope
// @Failure 500 {object} response.Envelope
// @Router /user/upstreams/{id} [patch]
func (h *Handler) UpdateUserUpstream(c *gin.Context) {
	ctx := c.Request.Context()
	userID := middleware.MustUserID(c)
	upstreamID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid upstream id")
		return
	}
	
	var req UpdateUserUpstreamRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	
	input := appchannel.UpdateUserUpstreamInput{
		Name:             req.Name,
		BaseURL:          req.BaseURL,
		ConnectTimeoutMS: req.ConnectTimeoutMS,
		ReadTimeoutMS:    req.ReadTimeoutMS,
		Headers:          req.Headers,
		Status:           req.Status,
	}
	if req.APIKeys != nil {
		converted := convertAPIKeyInputs(*req.APIKeys)
		input.APIKeys = &converted
	}
	
	if err := h.service.UpdateUserUpstream(ctx, userID, uint(upstreamID), input); err != nil {
		switch {
		case errors.Is(err, appchannel.ErrUserUpstreamDisabled):
			response.Error(c, http.StatusForbidden, "user upstream feature is disabled")
		default:
			response.Error(c, http.StatusInternalServerError, "update user upstream failed")
		}
		return
	}
	
	response.Success(c, gin.H{"message": "updated"})
}

// DeleteUserUpstream godoc
// @Summary 删除用户自有渠道
// @Description 软删除用户自有渠道
// @Tags user-upstream
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "渠道ID"
// @Success 200 {object} response.Envelope
// @Failure 400 {object} response.Envelope
// @Failure 403 {object} response.Envelope
// @Failure 404 {object} response.Envelope
// @Failure 500 {object} response.Envelope
// @Router /user/upstreams/{id} [delete]
func (h *Handler) DeleteUserUpstream(c *gin.Context) {
	ctx := c.Request.Context()
	userID := middleware.MustUserID(c)
	upstreamID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid upstream id")
		return
	}
	
	if err := h.service.DeleteUserUpstream(ctx, userID, uint(upstreamID)); err != nil {
		switch {
		case errors.Is(err, appchannel.ErrUserUpstreamDisabled):
			response.Error(c, http.StatusForbidden, "user upstream feature is disabled")
		default:
			response.Error(c, http.StatusInternalServerError, "delete user upstream failed")
		}
		return
	}
	
	response.Success(c, gin.H{"message": "deleted"})
}

// convertAPIKeyInputs 转换 API Key 输入为应用层 DTO
func convertAPIKeyInputs(reqs []UserUpstreamAPIKeyRequest) []appchannel.APIKeyInput {
	result := make([]appchannel.APIKeyInput, len(reqs))
	for i, req := range reqs {
		status := req.Status
		if status == "" {
			status = "active"
		}
		result[i] = appchannel.APIKeyInput{
			Key:    req.Key,
			Status: status,
			Note:   req.Note,
		}
	}
	return result
}
