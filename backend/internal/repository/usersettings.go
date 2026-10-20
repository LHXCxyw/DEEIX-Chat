package repository

import (
	"context"

	domainusersettings "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/usersettings"
)

// UserSettingsRepository 定义用户个人配置读写能力。
type UserSettingsRepository interface {
	ListByUserID(ctx context.Context, userID uint) ([]domainusersettings.UserSetting, error)
	// GetByKey 查询指定用户的单个配置项，不存在时返回 nil（调用方据此区分「无记录」与「空值」）。
	GetByKey(ctx context.Context, userID uint, key string) (*domainusersettings.UserSetting, error)
	Upsert(ctx context.Context, items []domainusersettings.UserSetting) error
}
