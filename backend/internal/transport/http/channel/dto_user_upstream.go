package channel

import (
	"time"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
)

// UserUpstreamAPIKeyRequest 用户渠道密钥请求项。
type UserUpstreamAPIKeyRequest struct {
	Key    string `json:"key" binding:"required"`
	Status string `json:"status"`
	Note   string `json:"note"`
}

// CreateUserUpstreamRequest 创建用户自有渠道请求。
type CreateUserUpstreamRequest struct {
	Name             string                      `json:"name" binding:"required"`
	BaseURL          string                      `json:"base_url" binding:"required"`
	Compatible       string                      `json:"compatible" binding:"required"`
	APIKeys          []UserUpstreamAPIKeyRequest `json:"api_keys" binding:"required,min=1"`
	ConnectTimeoutMS int                         `json:"connect_timeout_ms"`
	ReadTimeoutMS    int                         `json:"read_timeout_ms"`
	Headers          map[string]string           `json:"headers"`
}

// UpdateUserUpstreamRequest 更新用户自有渠道请求，未传字段保持原值。
type UpdateUserUpstreamRequest struct {
	Name             *string                      `json:"name"`
	BaseURL          *string                      `json:"base_url"`
	APIKeys          *[]UserUpstreamAPIKeyRequest `json:"api_keys"`
	ConnectTimeoutMS *int                         `json:"connect_timeout_ms"`
	ReadTimeoutMS    *int                         `json:"read_timeout_ms"`
	Headers          *map[string]string           `json:"headers"`
	Status           *string                      `json:"status"`
}

// UserUpstreamResponse 用户自有渠道响应，不返回任何密钥明文。
type UserUpstreamResponse struct {
	ID               uint      `json:"id"`
	Name             string    `json:"name"`
	BaseURL          string    `json:"base_url"`
	Compatible       string    `json:"compatible"`
	Status           string    `json:"status"`
	BillingMode      string    `json:"billing_mode"`
	ConnectTimeoutMS int       `json:"connect_timeout_ms"`
	ReadTimeoutMS    int       `json:"read_timeout_ms"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// UserUpstreamListResponse 用户自有渠道列表响应。
type UserUpstreamListResponse struct {
	Items []UserUpstreamResponse `json:"items"`
}

func toUserUpstreamResponse(item domainchannel.Upstream) UserUpstreamResponse {
	return UserUpstreamResponse{
		ID:               item.ID,
		Name:             item.Name,
		BaseURL:          item.BaseURL,
		Compatible:       item.Compatible,
		Status:           item.Status,
		BillingMode:      item.BillingMode,
		ConnectTimeoutMS: item.ConnectTimeoutMS,
		ReadTimeoutMS:    item.ReadTimeoutMS,
		CreatedAt:        item.CreatedAt,
		UpdatedAt:        item.UpdatedAt,
	}
}

func toUserUpstreamResponses(items []domainchannel.Upstream) []UserUpstreamResponse {
	result := make([]UserUpstreamResponse, 0, len(items))
	for _, item := range items {
		result = append(result, toUserUpstreamResponse(item))
	}
	return result
}
