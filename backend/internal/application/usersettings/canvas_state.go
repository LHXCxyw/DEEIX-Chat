package usersettings

import (
	"context"
	"fmt"
	"strings"
	"time"

	domainusersettings "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/usersettings"
)

// CanvasStateKey 是画布快照在用户设置表中的存储键。
// 画布快照体积远大于普通偏好项，因此只通过专用端点读写，不进入 ListSettings 的全量返回。
const CanvasStateKey = "canvas.state_v1"

// maxCanvasStateBytes 是单个画布快照的字节上限，避免异常体积的快照占用数据库与传输带宽。
const maxCanvasStateBytes = 16 << 20

// CanvasState 是画布快照内容及其服务端写入时间（毫秒）。
// 时间戳由服务端生成，客户端不得自行推断新旧，避免设备时钟偏差导致误判覆盖。
type CanvasState struct {
	State     string
	UpdatedAt int64
}

// GetCanvasState 读取用户的画布快照；从未保存过时返回空内容与 0 时间戳。
func (s *Service) GetCanvasState(ctx context.Context, userID uint) (CanvasState, error) {
	item, err := s.repo.GetByKey(ctx, userID, CanvasStateKey)
	if err != nil {
		return CanvasState{}, err
	}
	if item == nil {
		return CanvasState{}, nil
	}
	return CanvasState{State: item.Value, UpdatedAt: item.UpdatedAt.UnixMilli()}, nil
}

// PutCanvasState 覆盖写入用户的画布快照，返回服务端写入时间（毫秒）。
// 画布状态是整份快照，服务端不做合并：以服务端为唯一权威，客户端读到的永远是最近一次写入。
func (s *Service) PutCanvasState(ctx context.Context, userID uint, state string) (int64, error) {
	if strings.TrimSpace(state) == "" {
		return 0, settingValidationError(ErrInvalidSettingValue, "canvas state must not be empty")
	}
	if len(state) > maxCanvasStateBytes {
		return 0, settingValidationError(
			ErrInvalidSettingValue,
			fmt.Sprintf("canvas state exceeds %d bytes", maxCanvasStateBytes),
		)
	}
	now := time.Now()
	if err := s.repo.Upsert(ctx, []domainusersettings.UserSetting{{
		UserID:    userID,
		Key:       CanvasStateKey,
		Value:     state,
		UpdatedAt: now,
	}}); err != nil {
		return 0, err
	}
	return now.UnixMilli(), nil
}
