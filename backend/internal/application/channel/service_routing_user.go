package channel

import (
	"context"
	"strconv"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func (s *Service) getUserModelRoute(ctx context.Context, input ResolveRouteInput) ([]repository.ChannelUpstreamRouteRow, error) {
	if s.userModelRepo == nil || input.UserID == 0 || input.UserModelID == 0 {
		return nil, ErrModelAccessDenied
	}
	userModel, err := s.userModelRepo.GetUserModelByID(ctx, input.UserID, input.UserModelID)
	if err != nil {
		return nil, err
	}
	if userModel == nil || userModel.Status != "active" {
		return nil, ErrModelNotFound
	}
	upstream, err := s.repo.GetUserUpstreamByID(ctx, input.UserID, userModel.UpstreamID)
	if err != nil {
		return nil, err
	}
	if upstream == nil || upstream.Status != "active" {
		return nil, ErrRouteNotFound
	}
	row := repository.ChannelUpstreamRouteRow{
		RouteID: userModel.ID, UpstreamModelID: userModel.ID, UpstreamID: upstream.ID,
		UpstreamName: upstream.Name, UpstreamOwnerUserID: upstream.OwnerUserID,
		UpstreamOwnershipType: "user", UpstreamBillingMode: "self", PlatformModelName: userModel.Name,
		ModelKindsJSON: userModel.KindsJSON, ModelCapabilitiesJSON: userModel.KindsJSON,
		Protocol: userModelRouteProtocol(input.TaskType, userModel.KindsJSON, userModel.Protocol), BaseURL: upstream.BaseURL, APIKeysEnc: upstream.APIKeysEnc,
		ConnectTimeoutMS: upstream.ConnectTimeoutMS, ReadTimeoutMS: upstream.ReadTimeoutMS,
		StreamIdleTimeoutMS: upstream.StreamIdleTimeoutMS, HeadersJSON: upstream.HeadersJSON,
		RouteHeadersJSON: userModel.HeadersJSON, BindingCode: "user-model-" + strconv.FormatUint(uint64(userModel.ID), 10),
		UpstreamModelName: userModel.UpstreamModelID, Weight: userModel.Weight, RoutePriority: userModel.Priority,
	}
	return []repository.ChannelUpstreamRouteRow{row}, nil
}

func userModelRouteProtocol(taskType string, kindsJSON string, protocol string) string {
	if NormalizeTaskType(taskType) == TaskTypeImageEdit &&
		protocol == protocolOpenAIImageGenerations &&
		hasModelKind(parseKinds(kindsJSON), modelKindImageEdit) {
		return protocolOpenAIImageEdits
	}
	return protocol
}

// getAvailableRoutesWithUserPriority 按用户渠道优先返回可用路由
func (s *Service) getAvailableRoutesWithUserPriority(
	ctx context.Context,
	input ResolveRouteInput,
) ([]repository.ChannelUpstreamRouteRow, error) {
	cfg := s.cfg.Snapshot()

	// 全局开关判定或计费模式 disabled：仅查询平台渠道
	if !cfg.UserUpstreamEnabled || cfg.UserUpstreamBillingMode == "disabled" {
		return s.repo.ListActiveRoutesByModelWithOwnership(ctx, input.PlatformModelName, "platform", nil)
	}

	// 优先查询用户自有渠道
	userRoutes, err := s.repo.ListActiveRoutesByModelWithOwnership(
		ctx,
		input.PlatformModelName,
		"user",
		&input.UserID,
	)
	if err != nil {
		return nil, err
	}

	// 用户渠道存在时优先返回
	if len(userRoutes) > 0 {
		return userRoutes, nil
	}

	// 无用户渠道时 fallback 到平台渠道
	return s.repo.ListActiveRoutesByModelWithOwnership(ctx, input.PlatformModelName, "platform", nil)
}
