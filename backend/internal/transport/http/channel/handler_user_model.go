package channel

import (
	"errors"
	"net/http"
	"strconv"

	appchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

func toUserModelResponse(item domainchannel.UserModel) UserModelResponse {
	return UserModelResponse{ID: item.ID, OwnerUserID: item.OwnerUserID, UpstreamID: item.UpstreamID, UpstreamName: item.UpstreamName, UpstreamCompatible: item.UpstreamCompatible, UpstreamModelID: item.UpstreamModelID, Name: item.Name, Protocol: item.Protocol, KindsJSON: item.KindsJSON, Status: item.Status, Priority: item.Priority, Weight: item.Weight, HeadersJSON: item.HeadersJSON, CreatedAt: item.CreatedAt.Format("2006-01-02T15:04:05.000Z07:00"), UpdatedAt: item.UpdatedAt.Format("2006-01-02T15:04:05.000Z07:00")}
}

func userModelID(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil || id == 0 {
		response.Error(c, http.StatusBadRequest, "invalid model id")
		return 0, false
	}
	return uint(id), true
}
func userUpstreamID(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil || id == 0 {
		response.Error(c, http.StatusBadRequest, "invalid upstream id")
		return 0, false
	}
	return uint(id), true
}

// ListUserRemoteModels 查询用户渠道远端模型。
func (h *Handler) ListUserRemoteModels(c *gin.Context) {
	upstreamID, ok := userUpstreamID(c)
	if !ok {
		return
	}
	items, err := h.service.ListUserRemoteModels(c.Request.Context(), middleware.MustUserID(c), upstreamID)
	if err != nil {
		userModelError(c, err)
		return
	}
	response.Success(c, gin.H{"items": items, "total": len(items)})
}

// CreateUserModel 创建用户私有模型。
func (h *Handler) CreateUserModel(c *gin.Context) {
	upstreamID, ok := userUpstreamID(c)
	if !ok {
		return
	}
	var req CreateUserModelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.CreateUserModel(c.Request.Context(), middleware.MustUserID(c), upstreamID, appchannel.CreateUserModelInput{UpstreamModelID: req.UpstreamModelID, Name: req.Name, Protocol: req.Protocol, KindsJSON: req.KindsJSON, Status: req.Status, Priority: req.Priority, Weight: req.Weight, HeadersJSON: req.HeadersJSON})
	if err != nil {
		userModelError(c, err)
		return
	}
	c.JSON(http.StatusCreated, toUserModelResponse(*item))
}

// BatchCreateUserModels 批量创建用户私有模型。
func (h *Handler) BatchCreateUserModels(c *gin.Context) {
	upstreamID, ok := userUpstreamID(c)
	if !ok {
		return
	}
	var req BatchCreateUserModelsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	inputs := make([]appchannel.CreateUserModelInput, len(req.Items))
	for i, item := range req.Items {
		inputs[i] = appchannel.CreateUserModelInput{UpstreamModelID: item.UpstreamModelID, Name: item.Name, Protocol: item.Protocol, KindsJSON: item.KindsJSON, Status: item.Status, Priority: item.Priority, Weight: item.Weight, HeadersJSON: item.HeadersJSON}
	}
	created, failed, err := h.service.BatchCreateUserModels(c.Request.Context(), middleware.MustUserID(c), upstreamID, inputs)
	if err != nil {
		userModelError(c, err)
		return
	}
	result := make([]UserModelResponse, len(created))
	for i := range created {
		result[i] = toUserModelResponse(created[i])
	}
	response.Success(c, gin.H{"items": result, "successCount": len(result), "failed": failed, "failedCount": len(failed)})
}

// TestUserUpstream 测试用户渠道连通性。
func (h *Handler) TestUserUpstream(c *gin.Context) {
	upstreamID, ok := userUpstreamID(c)
	if !ok {
		return
	}
	result, err := h.service.TestUserUpstream(c.Request.Context(), middleware.MustUserID(c), upstreamID)
	if err != nil {
		userModelError(c, err)
		return
	}
	response.Success(c, UserUpstreamTestResponse{OK: result.OK, ModelCount: result.ModelCount, LatencyMS: result.LatencyMS, Message: result.Message})
}

// ListUserModels 查询用户私有模型。
func (h *Handler) ListUserModels(c *gin.Context) {
	items, err := h.service.ListUserModels(c.Request.Context(), middleware.MustUserID(c))
	if err != nil {
		userModelError(c, err)
		return
	}
	result := make([]UserModelResponse, len(items))
	for i := range items {
		result[i] = toUserModelResponse(items[i])
	}
	response.Success(c, gin.H{"items": result, "total": len(result)})
}

// UpdateUserModel 更新用户私有模型。
func (h *Handler) UpdateUserModel(c *gin.Context) {
	modelID, ok := userModelID(c)
	if !ok {
		return
	}
	var req UpdateUserModelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.UpdateUserModel(c.Request.Context(), middleware.MustUserID(c), modelID, appchannel.UpdateUserModelInput{Name: req.Name, Protocol: req.Protocol, KindsJSON: req.KindsJSON, Status: req.Status, Priority: req.Priority, Weight: req.Weight, HeadersJSON: req.HeadersJSON})
	if err != nil {
		userModelError(c, err)
		return
	}
	response.Success(c, toUserModelResponse(*item))
}

// BatchUpdateUserModels 批量更新用户私有模型。
func (h *Handler) BatchUpdateUserModels(c *gin.Context) {
	var req BatchUpdateUserModelsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	patch := appchannel.UpdateUserModelInput{Name: req.Patch.Name, Protocol: req.Patch.Protocol, KindsJSON: req.Patch.KindsJSON, Status: req.Patch.Status, Priority: req.Patch.Priority, Weight: req.Patch.Weight, HeadersJSON: req.Patch.HeadersJSON}
	success, failed, err := h.service.BatchUpdateUserModels(c.Request.Context(), middleware.MustUserID(c), req.IDs, patch)
	if err != nil {
		userModelError(c, err)
		return
	}
	response.Success(c, gin.H{"successCount": success, "failed": failed, "failedCount": len(failed)})
}

// BatchDeleteUserModels 批量删除用户私有模型。
func (h *Handler) BatchDeleteUserModels(c *gin.Context) {
	var req BatchDeleteUserModelsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	success, failed, err := h.service.BatchDeleteUserModels(c.Request.Context(), middleware.MustUserID(c), req.IDs)
	if err != nil {
		userModelError(c, err)
		return
	}
	response.Success(c, gin.H{"successCount": success, "failed": failed, "failedCount": len(failed)})
}

// TestUserModel 探测用户私有模型是否在上游可用。
func (h *Handler) TestUserModel(c *gin.Context) {
	modelID, ok := userModelID(c)
	if !ok {
		return
	}
	result, err := h.service.TestUserModel(c.Request.Context(), middleware.MustUserID(c), modelID)
	if err != nil {
		userModelError(c, err)
		return
	}
	response.Success(c, UserModelProbeResponse{OK: result.OK, LatencyMS: result.LatencyMS, Message: result.Message})
}

// DeleteUserModel 删除用户私有模型。
func (h *Handler) DeleteUserModel(c *gin.Context) {
	modelID, ok := userModelID(c)
	if !ok {
		return
	}
	if err := h.service.DeleteUserModel(c.Request.Context(), middleware.MustUserID(c), modelID); err != nil {
		userModelError(c, err)
		return
	}
	response.Success(c, gin.H{"message": "deleted"})
}

func userModelError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, repository.ErrNotFound), errors.Is(err, appchannel.ErrUpstreamNotFound):
		response.Error(c, http.StatusNotFound, "user model or upstream not found")
	case errors.Is(err, repository.ErrInvalidInput):
		response.Error(c, http.StatusBadRequest, "invalid user model")
	case errors.Is(err, repository.ErrDuplicate):
		response.Error(c, http.StatusConflict, "user model already exists")
	default:
		response.Error(c, http.StatusInternalServerError, "user model operation failed")
	}
}
