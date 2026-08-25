package channel

import (
	"context"
	"errors"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
)

// ListUserUpstreams 查询用户的所有自有渠道
func (r *Repo) ListUserUpstreams(ctx context.Context, userID uint) ([]domainchannel.Upstream, error) {
	var items []model.LLMUpstream
	err := r.db.WithContext(ctx).
		Where("owner_user_id = ?", userID).
		Where("ownership_type = ?", "user").
		Order("created_at DESC").
		Find(&items).Error
	if err != nil {
		return nil, translateError(err)
	}

	upstreams := make([]domainchannel.Upstream, len(items))
	for i, m := range items {
		upstreams[i] = toUpstreamDomain(m)
	}
	return upstreams, nil
}

// GetUserUpstreamByID 获取用户指定的自有渠道（带越权校验）
func (r *Repo) GetUserUpstreamByID(ctx context.Context, userID, upstreamID uint) (*domainchannel.Upstream, error) {
	var m model.LLMUpstream
	err := r.db.WithContext(ctx).
		Where("id = ?", upstreamID).
		Where("owner_user_id = ?", userID).
		Where("ownership_type = ?", "user").
		First(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, repository.ErrNotFound
		}
		return nil, translateError(err)
	}

	upstream := toUpstreamDomain(m)
	return &upstream, nil
}

// CreateUserUpstream 创建用户自有渠道
func (r *Repo) CreateUserUpstream(ctx context.Context, upstream *domainchannel.Upstream) error {
	if upstream == nil {
		return repository.ErrInvalidInput
	}
	m := toUpstreamModel(upstream)
	if err := r.db.WithContext(ctx).Create(&m).Error; err != nil {
		return translateError(err)
	}
	upstream.ID = m.ID
	upstream.CreatedAt = m.CreatedAt
	upstream.UpdatedAt = m.UpdatedAt
	return nil
}

// UpdateUserUpstream 更新用户自有渠道
func (r *Repo) UpdateUserUpstream(ctx context.Context, upstream *domainchannel.Upstream) error {
	if upstream == nil || upstream.ID == 0 {
		return repository.ErrInvalidInput
	}
	m := toUpstreamModel(upstream)
	result := r.db.WithContext(ctx).
		Model(&model.LLMUpstream{}).
		Where("id = ?", upstream.ID).
		Where("owner_user_id = ?", upstream.OwnerUserID).
		Where("ownership_type = ?", "user").
		Updates(&m)
	if result.Error != nil {
		return translateError(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

// DeleteUserUpstream 软删除用户自有渠道
func (r *Repo) DeleteUserUpstream(ctx context.Context, userID, upstreamID uint) error {
	result := r.db.WithContext(ctx).
		Where("id = ?", upstreamID).
		Where("owner_user_id = ?", userID).
		Where("ownership_type = ?", "user").
		Delete(&model.LLMUpstream{})
	if result.Error != nil {
		return translateError(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

// CountUserUpstreams 统计用户已创建的渠道数量
func (r *Repo) CountUserUpstreams(ctx context.Context, userID uint) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).
		Model(&model.LLMUpstream{}).
		Where("owner_user_id = ?", userID).
		Where("ownership_type = ?", "user").
		Count(&count).Error
	return count, translateError(err)
}
