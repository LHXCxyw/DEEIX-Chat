package channel

import (
	"context"
	"encoding/json"
	"net/url"
	"time"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
)

// ListUserUpstreams 查询用户的所有自有渠道
func (s *Service) ListUserUpstreams(ctx context.Context, userID uint) ([]domainchannel.Upstream, error) {
	cfg := s.cfg.Snapshot()
	if !cfg.UserUpstreamEnabled {
		return nil, ErrUserUpstreamDisabled
	}
	
	return s.repo.ListUserUpstreams(ctx, userID)
}

// GetUserUpstreamByID 查询用户指定的自有渠道，仓储层已包含越权校验
func (s *Service) GetUserUpstreamByID(ctx context.Context, userID, upstreamID uint) (*domainchannel.Upstream, error) {
	cfg := s.cfg.Snapshot()
	if !cfg.UserUpstreamEnabled {
		return nil, ErrUserUpstreamDisabled
	}

	return s.repo.GetUserUpstreamByID(ctx, userID, upstreamID)
}

// CreateUserUpstream 用户创建自有渠道
func (s *Service) CreateUserUpstream(ctx context.Context, userID uint, input CreateUserUpstreamInput) (*domainchannel.Upstream, error) {
	cfg := s.cfg.Snapshot()
	
	// 1. 全局开关校验
	if !cfg.UserUpstreamEnabled {
		return nil, ErrUserUpstreamDisabled
	}
	
	// 2. 配额校验
	if cfg.UserUpstreamQuotaLimit > 0 {
		count, err := s.repo.CountUserUpstreams(ctx, userID)
		if err != nil {
			return nil, err
		}
		if count >= int64(cfg.UserUpstreamQuotaLimit) {
			return nil, ErrUserUpstreamQuotaExceeded
		}
	}
	
	// 3. 参数校验
	if err := s.validateUserUpstreamInput(input); err != nil {
		return nil, err
	}
	
	// 4. API Key 加密
	apiKeysConfig := domainchannel.APIKeysConfig{
		Strategy: "random",
		Keys:     make([]domainchannel.APIKey, len(input.APIKeys)),
	}
	for i, key := range input.APIKeys {
		apiKeysConfig.Keys[i] = domainchannel.APIKey{
			Key:    key.Key,
			Status: key.Status,
			Note:   key.Note,
		}
	}
	apiKeysJSON, _ := json.Marshal(apiKeysConfig)
	encryptedKeys, err := encryptAPIKeys(cfg.DataEncryptionKey, string(apiKeysJSON))
	if err != nil {
		return nil, err
	}
	
	// 5. 构建领域对象
	headersJSON, _ := json.Marshal(input.Headers)
	upstream := &domainchannel.Upstream{
		Name:                 input.Name,
		OwnerUserID:          &userID,
		OwnershipType:        "user",
		IsSharedWithPlatform: true,  // 默认同意纳入统计
		BillingMode:          "self", // 默认不计费
		BaseURL:              input.BaseURL,
		Compatible:           input.Compatible,
		Status:               determineInitialStatus(cfg.UserUpstreamRequireApproval),
		ConnectTimeoutMS:     input.ConnectTimeoutMS,
		ReadTimeoutMS:        input.ReadTimeoutMS,
		StreamIdleTimeoutMS:  60000,
		APIKeysEnc:           encryptedKeys,
		HeadersJSON:          string(headersJSON),
		CbFailureThreshold:   0,  // 用户渠道默认不启用熔断
		CreatedAt:            time.Now(),
		UpdatedAt:            time.Now(),
	}
	
	// 设置默认超时值
	if upstream.ConnectTimeoutMS == 0 {
		upstream.ConnectTimeoutMS = 10000
	}
	if upstream.ReadTimeoutMS == 0 {
		upstream.ReadTimeoutMS = 120000
	}
	
	// 6. 持久化
	if err := s.repo.CreateUserUpstream(ctx, upstream); err != nil {
		return nil, err
	}
	
	return upstream, nil
}

// UpdateUserUpstream 用户更新自有渠道
func (s *Service) UpdateUserUpstream(ctx context.Context, userID, upstreamID uint, input UpdateUserUpstreamInput) error {
	cfg := s.cfg.Snapshot()
	if !cfg.UserUpstreamEnabled {
		return ErrUserUpstreamDisabled
	}
	
	// 1. 查询并校验归属
	existing, err := s.repo.GetUserUpstreamByID(ctx, userID, upstreamID)
	if err != nil {
		return err
	}
	
	// 2. 应用更新
	if input.Name != nil {
		existing.Name = *input.Name
	}
	if input.BaseURL != nil {
		existing.BaseURL = *input.BaseURL
	}
	if input.APIKeys != nil {
		apiKeysConfig := domainchannel.APIKeysConfig{
			Strategy: "random",
			Keys:     make([]domainchannel.APIKey, len(*input.APIKeys)),
		}
		for i, key := range *input.APIKeys {
			apiKeysConfig.Keys[i] = domainchannel.APIKey{
				Key:    key.Key,
				Status: key.Status,
				Note:   key.Note,
			}
		}
		apiKeysJSON, _ := json.Marshal(apiKeysConfig)
		encryptedKeys, err := encryptAPIKeys(cfg.DataEncryptionKey, string(apiKeysJSON))
		if err != nil {
			return err
		}
		existing.APIKeysEnc = encryptedKeys
	}
	if input.ConnectTimeoutMS != nil {
		existing.ConnectTimeoutMS = *input.ConnectTimeoutMS
	}
	if input.ReadTimeoutMS != nil {
		existing.ReadTimeoutMS = *input.ReadTimeoutMS
	}
	if input.Headers != nil {
		headersJSON, _ := json.Marshal(*input.Headers)
		existing.HeadersJSON = string(headersJSON)
	}
	if input.Status != nil {
		existing.Status = *input.Status
	}
	
	existing.UpdatedAt = time.Now()
	
	// 3. 持久化
	return s.repo.UpdateUserUpstream(ctx, existing)
}

// DeleteUserUpstream 用户删除自有渠道
func (s *Service) DeleteUserUpstream(ctx context.Context, userID, upstreamID uint) error {
	cfg := s.cfg.Snapshot()
	if !cfg.UserUpstreamEnabled {
		return ErrUserUpstreamDisabled
	}
	
	// 越权校验（仓储层已包含）
	return s.repo.DeleteUserUpstream(ctx, userID, upstreamID)
}

// validateUserUpstreamInput 校验用户输入
func (s *Service) validateUserUpstreamInput(input CreateUserUpstreamInput) error {
	if input.Name == "" {
		return ErrInvalidUpstreamName
	}
	if input.BaseURL == "" {
		return ErrInvalidBaseURL
	}
	if len(input.APIKeys) == 0 {
		return ErrAPIKeysRequired
	}
	// URL 格式校验
	if _, err := url.Parse(input.BaseURL); err != nil {
		return ErrInvalidBaseURL
	}
	return nil
}

// determineInitialStatus 根据审批开关确定初始状态
func determineInitialStatus(requireApproval bool) string {
	if requireApproval {
		return "pending_approval"
	}
	return "active"
}
