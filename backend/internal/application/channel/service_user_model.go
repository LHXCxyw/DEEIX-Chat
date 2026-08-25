package channel

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func (s *Service) userModelsRepo() (repository.UserModelRepository, error) {
	repo, ok := s.repo.(repository.UserModelRepository)
	if !ok {
		return nil, repository.ErrInvalidInput
	}
	return repo, nil
}

// CreateUserModelInput 用户创建私有模型输入。
type CreateUserModelInput struct {
	UpstreamModelID string
	Name            string
	Protocol        string
	KindsJSON       string
	Status          string
	Priority        int
	Weight          int
	HeadersJSON     string
}

// UpdateUserModelInput 用户更新私有模型输入。
type UpdateUserModelInput struct {
	Name        *string
	Protocol    *string
	KindsJSON   *string
	Status      *string
	Priority    *int
	Weight      *int
	HeadersJSON *string
}

// ListUserModels 查询用户私有模型。
func (s *Service) ListUserModels(ctx context.Context, userID uint) ([]domainchannel.UserModel, error) {
	if !s.cfg.Snapshot().UserUpstreamEnabled {
		return []domainchannel.UserModel{}, nil
	}
	repo, err := s.userModelsRepo()
	if err != nil {
		return nil, err
	}
	items, err := repo.ListUserModels(ctx, userID)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// ListUserRemoteModels 查询用户渠道的远端模型，渠道归属由服务层严格校验。
func (s *Service) ListUserRemoteModels(ctx context.Context, userID, upstreamID uint) ([]string, error) {
	upstream, err := s.repo.GetUserUpstreamByID(ctx, userID, upstreamID)
	if err != nil {
		return nil, err
	}
	items, err := s.fetchRemoteModels(ctx, upstream)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if name := strings.TrimSpace(item.ID); name != "" {
			result = append(result, name)
		}
	}
	return result, nil
}

// CreateUserModel 创建用户私有模型并校验上游归属。
func (s *Service) CreateUserModel(ctx context.Context, userID, upstreamID uint, input CreateUserModelInput) (*domainchannel.UserModel, error) {
	repo, repoErr := s.userModelsRepo()
	if repoErr != nil {
		return nil, repoErr
	}
	if _, err := s.repo.GetUserUpstreamByID(ctx, userID, upstreamID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.UpstreamModelID) == "" || strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.Protocol) == "" {
		return nil, repository.ErrInvalidInput
	}
	item := &domainchannel.UserModel{OwnerUserID: userID, UpstreamID: upstreamID, UpstreamModelID: strings.TrimSpace(input.UpstreamModelID), Name: strings.TrimSpace(input.Name), Protocol: strings.TrimSpace(input.Protocol), KindsJSON: input.KindsJSON, Status: input.Status, Priority: input.Priority, Weight: input.Weight, HeadersJSON: input.HeadersJSON, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if item.KindsJSON == "" {
		item.KindsJSON = `["chat"]`
	}
	if item.Status == "" {
		item.Status = "active"
	}
	if item.Priority == 0 {
		item.Priority = 1
	}
	if item.Weight == 0 {
		item.Weight = 1
	}
	if item.HeadersJSON == "" {
		item.HeadersJSON = `{}`
	}
	if !json.Valid([]byte(item.KindsJSON)) || !json.Valid([]byte(item.HeadersJSON)) {
		return nil, repository.ErrInvalidInput
	}
	if err := repo.CreateUserModel(ctx, item); err != nil {
		return nil, err
	}
	return item, nil
}

// UpdateUserModel 更新用户私有模型并校验归属。
func (s *Service) UpdateUserModel(ctx context.Context, userID, modelID uint, input UpdateUserModelInput) (*domainchannel.UserModel, error) {
	repo, repoErr := s.userModelsRepo()
	if repoErr != nil {
		return nil, repoErr
	}
	item, err := repo.GetUserModelByID(ctx, userID, modelID)
	if err != nil {
		return nil, err
	}
	if input.Name != nil {
		item.Name = strings.TrimSpace(*input.Name)
	}
	if input.Protocol != nil {
		item.Protocol = strings.TrimSpace(*input.Protocol)
	}
	if input.KindsJSON != nil {
		item.KindsJSON = *input.KindsJSON
	}
	if input.Status != nil {
		item.Status = *input.Status
	}
	if input.Priority != nil {
		item.Priority = *input.Priority
	}
	if input.Weight != nil {
		item.Weight = *input.Weight
	}
	if input.HeadersJSON != nil {
		item.HeadersJSON = *input.HeadersJSON
	}
	if item.Name == "" || item.Protocol == "" || !json.Valid([]byte(item.KindsJSON)) || !json.Valid([]byte(item.HeadersJSON)) {
		return nil, repository.ErrInvalidInput
	}
	item.UpdatedAt = time.Now()
	if err := repo.UpdateUserModel(ctx, item); err != nil {
		return nil, err
	}
	return item, nil
}

// UserUpstreamTestResult 用户渠道连通性测试结果。
type UserUpstreamTestResult struct {
	OK         bool
	ModelCount int
	LatencyMS  int64
	Message    string
}

// TestUserUpstream 通过拉取远端模型列表验证用户渠道是否可用。
func (s *Service) TestUserUpstream(ctx context.Context, userID, upstreamID uint) (*UserUpstreamTestResult, error) {
	upstream, err := s.repo.GetUserUpstreamByID(ctx, userID, upstreamID)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	items, fetchErr := s.fetchRemoteModels(ctx, upstream)
	latency := time.Since(start).Milliseconds()
	if fetchErr != nil {
		return &UserUpstreamTestResult{OK: false, LatencyMS: latency, Message: fetchErr.Error()}, nil
	}
	return &UserUpstreamTestResult{OK: true, ModelCount: len(items), LatencyMS: latency}, nil
}

// BatchCreateUserModels 批量创建用户私有模型，逐条独立处理，单条失败不影响其余。
func (s *Service) BatchCreateUserModels(ctx context.Context, userID, upstreamID uint, inputs []CreateUserModelInput) ([]domainchannel.UserModel, []string, error) {
	if len(inputs) == 0 {
		return nil, nil, repository.ErrInvalidInput
	}
	if _, err := s.repo.GetUserUpstreamByID(ctx, userID, upstreamID); err != nil {
		return nil, nil, err
	}
	created := make([]domainchannel.UserModel, 0, len(inputs))
	failed := make([]string, 0)
	for _, input := range inputs {
		item, err := s.CreateUserModel(ctx, userID, upstreamID, input)
		if err != nil {
			failed = append(failed, strings.TrimSpace(input.UpstreamModelID))
			continue
		}
		created = append(created, *item)
	}
	return created, failed, nil
}

// BatchUpdateUserModels 批量更新用户私有模型，逐条独立处理。
func (s *Service) BatchUpdateUserModels(ctx context.Context, userID uint, modelIDs []uint, input UpdateUserModelInput) (int, []uint, error) {
	if len(modelIDs) == 0 {
		return 0, nil, repository.ErrInvalidInput
	}
	success := 0
	failed := make([]uint, 0)
	for _, modelID := range modelIDs {
		if _, err := s.UpdateUserModel(ctx, userID, modelID, input); err != nil {
			failed = append(failed, modelID)
			continue
		}
		success++
	}
	return success, failed, nil
}

// BatchDeleteUserModels 批量删除用户私有模型，逐条独立处理。
func (s *Service) BatchDeleteUserModels(ctx context.Context, userID uint, modelIDs []uint) (int, []uint, error) {
	repo, err := s.userModelsRepo()
	if err != nil {
		return 0, nil, err
	}
	if len(modelIDs) == 0 {
		return 0, nil, repository.ErrInvalidInput
	}
	success := 0
	failed := make([]uint, 0)
	for _, modelID := range modelIDs {
		if delErr := repo.DeleteUserModel(ctx, userID, modelID); delErr != nil && !isUserModelNotFound(delErr) {
			failed = append(failed, modelID)
			continue
		}
		success++
	}
	return success, failed, nil
}

// UserModelProbeResult 用户模型路由探测结果。
type UserModelProbeResult struct {
	OK        bool
	LatencyMS int64
	Message   string
}

// TestUserModel 校验用户私有模型在其上游远端模型列表中真实可用。
func (s *Service) TestUserModel(ctx context.Context, userID, modelID uint) (*UserModelProbeResult, error) {
	repo, err := s.userModelsRepo()
	if err != nil {
		return nil, err
	}
	item, err := repo.GetUserModelByID(ctx, userID, modelID)
	if err != nil {
		return nil, err
	}
	upstream, err := s.repo.GetUserUpstreamByID(ctx, userID, item.UpstreamID)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	remoteItems, fetchErr := s.fetchRemoteModels(ctx, upstream)
	latency := time.Since(start).Milliseconds()
	if fetchErr != nil {
		return &UserModelProbeResult{OK: false, LatencyMS: latency, Message: fetchErr.Error()}, nil
	}
	for _, remote := range remoteItems {
		if strings.EqualFold(strings.TrimSpace(remote.ID), item.UpstreamModelID) {
			return &UserModelProbeResult{OK: true, LatencyMS: latency}, nil
		}
	}
	return &UserModelProbeResult{OK: false, LatencyMS: latency, Message: "上游模型列表中不存在 " + item.UpstreamModelID}, nil
}

// DeleteUserModel 删除用户私有模型并校验归属。
func (s *Service) DeleteUserModel(ctx context.Context, userID, modelID uint) error {
	repo, err := s.userModelsRepo()
	if err != nil {
		return err
	}
	return repo.DeleteUserModel(ctx, userID, modelID)
}

func isUserModelNotFound(err error) bool { return err == repository.ErrNotFound }
