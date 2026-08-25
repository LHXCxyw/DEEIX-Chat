package channel

import (
	"context"
	"errors"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
)

func toUserModelDomain(item model.LLMUserModel) domainchannel.UserModel {
	return domainchannel.UserModel{ID: item.ID, OwnerUserID: item.OwnerUserID, UpstreamID: item.UpstreamID, UpstreamName: item.Upstream.Name, UpstreamCompatible: item.Upstream.Compatible, UpstreamModelID: item.UpstreamModelID, Name: item.Name, Protocol: item.Protocol, KindsJSON: item.KindsJSON, Status: item.Status, Priority: item.Priority, Weight: item.Weight, HeadersJSON: item.HeadersJSON, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func toUserModelModel(item *domainchannel.UserModel) model.LLMUserModel {
	return model.LLMUserModel{BaseModel: model.BaseModel{ID: item.ID, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}, OwnerUserID: item.OwnerUserID, UpstreamID: item.UpstreamID, UpstreamModelID: item.UpstreamModelID, Name: item.Name, Protocol: item.Protocol, KindsJSON: item.KindsJSON, Status: item.Status, Priority: item.Priority, Weight: item.Weight, HeadersJSON: item.HeadersJSON}
}

// ListUserModels 查询用户私有模型。
func (r *Repo) ListUserModels(ctx context.Context, userID uint) ([]domainchannel.UserModel, error) {
	var items []model.LLMUserModel
	if err := r.db.WithContext(ctx).
		Joins("JOIN llm_upstreams u ON u.id = llm_user_models.upstream_id").
		Where("llm_user_models.owner_user_id = ? AND llm_user_models.status = ? AND u.owner_user_id = ? AND u.ownership_type = ? AND u.status = ?", userID, "active", userID, "user", "active").
		Order("llm_user_models.priority ASC, llm_user_models.created_at DESC").
		Preload("Upstream").Find(&items).Error; err != nil {
		return nil, translateError(err)
	}
	result := make([]domainchannel.UserModel, len(items))
	for i := range items {
		result[i] = toUserModelDomain(items[i])
	}
	return result, nil
}

// GetUserModelByID 获取用户私有模型并校验归属。
func (r *Repo) GetUserModelByID(ctx context.Context, userID, modelID uint) (*domainchannel.UserModel, error) {
	var item model.LLMUserModel
	err := r.db.WithContext(ctx).Preload("Upstream", "owner_user_id = ? AND ownership_type = ?", userID, "user").Where("id = ? AND owner_user_id = ?", modelID, userID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, repository.ErrNotFound
	}
	if err != nil {
		return nil, translateError(err)
	}
	result := toUserModelDomain(item)
	return &result, nil
}

// CreateUserModel 创建用户私有模型。
func (r *Repo) CreateUserModel(ctx context.Context, item *domainchannel.UserModel) error {
	if item == nil {
		return repository.ErrInvalidInput
	}
	entity := toUserModelModel(item)
	var existing model.LLMUserModel
	lookup := r.db.WithContext(ctx).
		Where("owner_user_id = ? AND upstream_id = ? AND name = ?", item.OwnerUserID, item.UpstreamID, item.Name).
		First(&existing)
	if lookup.Error == nil {
		entity = existing
		if err := r.db.WithContext(ctx).Preload("Upstream", "owner_user_id = ? AND ownership_type = ?", item.OwnerUserID, "user").First(&entity, existing.ID).Error; err != nil {
			return translateError(err)
		}
		*item = toUserModelDomain(entity)
		return nil
	}
	if !errors.Is(lookup.Error, gorm.ErrRecordNotFound) {
		return translateError(lookup.Error)
	}
	if err := r.db.WithContext(ctx).Create(&entity).Error; err != nil {
		return translateError(err)
	}
	if err := r.db.WithContext(ctx).Preload("Upstream", "owner_user_id = ? AND ownership_type = ?", item.OwnerUserID, "user").First(&entity, entity.ID).Error; err != nil {
		return translateError(err)
	}
	*item = toUserModelDomain(entity)
	return nil
}

// UpdateUserModel 更新用户私有模型。
func (r *Repo) UpdateUserModel(ctx context.Context, item *domainchannel.UserModel) error {
	if item == nil || item.ID == 0 {
		return repository.ErrInvalidInput
	}
	entity := toUserModelModel(item)
	result := r.db.WithContext(ctx).Model(&model.LLMUserModel{}).Where("id = ? AND owner_user_id = ?", item.ID, item.OwnerUserID).Updates(&entity)
	if result.Error != nil {
		return translateError(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

// DeleteUserModel 删除用户私有模型。
func (r *Repo) DeleteUserModel(ctx context.Context, userID, modelID uint) error {
	result := r.db.WithContext(ctx).Where("id = ? AND owner_user_id = ?", modelID, userID).Delete(&model.LLMUserModel{})
	if result.Error != nil {
		return translateError(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}
