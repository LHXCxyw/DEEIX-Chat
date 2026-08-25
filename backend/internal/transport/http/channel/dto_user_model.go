package channel

// CreateUserModelRequest 用户创建私有模型请求。
type CreateUserModelRequest struct {
	UpstreamModelID string `json:"upstreamModelId" binding:"required,max=256"`
	Name            string `json:"name" binding:"required,min=1,max=128"`
	Protocol        string `json:"protocol" binding:"required,max=64"`
	KindsJSON       string `json:"kinds" binding:"omitempty,max=1000"`
	Status          string `json:"status" binding:"omitempty,oneof=active disabled"`
	Priority        int    `json:"priority" binding:"gte=0"`
	Weight          int    `json:"weight" binding:"gte=0"`
	HeadersJSON     string `json:"headers" binding:"omitempty,max=10000"`
}

// UpdateUserModelRequest 用户更新私有模型请求。
type UpdateUserModelRequest struct {
	Name        *string `json:"name,omitempty" binding:"omitempty,max=128"`
	Protocol    *string `json:"protocol,omitempty" binding:"omitempty,max=64"`
	KindsJSON   *string `json:"kinds,omitempty" binding:"omitempty,max=1000"`
	Status      *string `json:"status,omitempty" binding:"omitempty,oneof=active disabled"`
	Priority    *int    `json:"priority,omitempty" binding:"omitempty,gte=0"`
	Weight      *int    `json:"weight,omitempty" binding:"omitempty,gte=0"`
	HeadersJSON *string `json:"headers,omitempty" binding:"omitempty,max=10000"`
}

// BatchCreateUserModelsRequest 用户批量导入私有模型请求。
type BatchCreateUserModelsRequest struct {
	Items []CreateUserModelRequest `json:"items" binding:"required,min=1,max=200,dive"`
}

// UserUpstreamTestResponse 用户渠道连通性测试响应。
type UserUpstreamTestResponse struct {
	OK         bool   `json:"ok"`
	ModelCount int    `json:"modelCount"`
	LatencyMS  int64  `json:"latencyMs"`
	Message    string `json:"message,omitempty"`
}

// BatchUpdateUserModelsRequest 用户批量更新私有模型请求。
type BatchUpdateUserModelsRequest struct {
	IDs   []uint                 `json:"ids" binding:"required,min=1,max=500"`
	Patch UpdateUserModelRequest `json:"patch"`
}

// BatchDeleteUserModelsRequest 用户批量删除私有模型请求。
type BatchDeleteUserModelsRequest struct {
	IDs []uint `json:"ids" binding:"required,min=1,max=500"`
}

// UserModelProbeResponse 用户模型探测响应。
type UserModelProbeResponse struct {
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latencyMs"`
	Message   string `json:"message,omitempty"`
}

// UserModelResponse 用户私有模型响应。
type UserModelResponse struct {
	ID                 uint   `json:"id"`
	OwnerUserID        uint   `json:"ownerUserId"`
	UpstreamID         uint   `json:"upstreamId"`
	UpstreamName       string `json:"upstreamName"`
	UpstreamCompatible string `json:"upstreamCompatible"`
	UpstreamModelID    string `json:"upstreamModelId"`
	Name               string `json:"name"`
	Protocol           string `json:"protocol"`
	KindsJSON          string `json:"kinds"`
	Status             string `json:"status"`
	Priority           int    `json:"priority"`
	Weight             int    `json:"weight"`
	HeadersJSON        string `json:"headers"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
}
