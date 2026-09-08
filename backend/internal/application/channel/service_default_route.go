package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

const DefaultTaskRoutesSettingKey = "default_task_routes"

var defaultTaskTypeOrder = []string{
	TaskTypeChat,
	TaskTypeImageGeneration,
	TaskTypeImageEdit,
	TaskTypeVideoGeneration,
	TaskTypeVideoExtension,
}

func parseDefaultTaskRoutes(raw string) (map[string]string, error) {
	decoder := json.NewDecoder(strings.NewReader(strings.TrimSpace(raw)))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, ErrInvalidJSONConfig
	}
	normalized := make(map[string]string)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, ErrInvalidJSONConfig
		}
		taskType, ok := keyToken.(string)
		if !ok {
			return nil, ErrInvalidJSONConfig
		}
		normalizedTaskType, ok := normalizeDefaultTaskType(taskType)
		if !ok || normalizedTaskType != strings.TrimSpace(taskType) {
			return nil, ErrInvalidJSONConfig
		}
		if _, exists := normalized[normalizedTaskType]; exists {
			return nil, ErrInvalidJSONConfig
		}
		var modelName string
		if err := decoder.Decode(&modelName); err != nil {
			return nil, ErrInvalidJSONConfig
		}
		modelName = strings.TrimSpace(modelName)
		if modelName == "" {
			return nil, ErrInvalidJSONConfig
		}
		normalized[normalizedTaskType] = modelName
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, ErrInvalidJSONConfig
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, ErrInvalidJSONConfig
	}
	return normalized, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("unexpected trailing JSON value")
	}
	return err
}

func normalizeDefaultTaskType(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	for _, taskType := range defaultTaskTypeOrder {
		if value == taskType {
			return taskType, true
		}
	}
	return "", false
}

func normalizeDefaultTaskTypes(values []string) ([]string, error) {
	selected := make(map[string]struct{}, len(values))
	for _, value := range values {
		taskType, ok := normalizeDefaultTaskType(value)
		if !ok {
			return nil, ErrInvalidJSONConfig
		}
		if _, exists := selected[taskType]; exists {
			return nil, ErrInvalidJSONConfig
		}
		selected[taskType] = struct{}{}
	}
	result := make([]string, 0, len(selected))
	for _, taskType := range defaultTaskTypeOrder {
		if _, ok := selected[taskType]; ok {
			result = append(result, taskType)
		}
	}
	return result, nil
}

func (s *Service) loadDefaultTaskRoutes(ctx context.Context, repo repository.ChannelRepository) (map[string]string, *domainchannel.LLMSetting, error) {
	setting, err := repo.GetLLMSetting(ctx, DefaultTaskRoutesSettingKey)
	if err != nil {
		return nil, nil, err
	}
	routes, err := parseDefaultTaskRoutes(setting.Value)
	if err != nil {
		return nil, nil, err
	}
	return routes, setting, nil
}

func applyDefaultTaskTypes(views []ModelView, routes map[string]string) {
	byName := make(map[string][]string)
	for _, taskType := range defaultTaskTypeOrder {
		if modelName := routes[taskType]; modelName != "" {
			byName[modelName] = append(byName[modelName], taskType)
		}
	}
	for index := range views {
		views[index].DefaultTaskTypes = append([]string(nil), byName[views[index].PlatformModelName]...)
	}
}

func validateDefaultTaskTypesForModel(status string, kindsJSON string, taskTypes []string) error {
	if len(taskTypes) == 0 {
		return nil
	}
	if strings.TrimSpace(status) != "active" {
		return ErrInvalidKinds
	}
	for _, taskType := range taskTypes {
		if !ModelSupportsTask(kindsJSON, taskType) {
			return ErrInvalidKinds
		}
	}
	return nil
}

func updateDefaultTaskRoutesForModel(routes map[string]string, oldModelName string, newModelName string, selected []string) {
	for taskType, modelName := range routes {
		if modelName == oldModelName {
			delete(routes, taskType)
		}
	}
	for _, taskType := range selected {
		routes[taskType] = newModelName
	}
}

func marshalDefaultTaskRoutes(routes map[string]string) string {
	payload, _ := json.Marshal(routes)
	return string(payload)
}

// ResolveDefaultRoute 返回指定任务类型的默认可路由模型。
// 显式模型优先；配置模型不可用时再按目录顺序兜底。
func (s *Service) ResolveDefaultRoute(ctx context.Context, input ResolveRouteInput) (*ResolvedRoute, error) {
	if explicit := strings.TrimSpace(input.PlatformModelName); explicit != "" {
		return s.ResolveRoute(ctx, input)
	}
	routes, _, err := s.loadDefaultTaskRoutes(ctx, s.repo)
	if err != nil && !errors.Is(err, repository.ErrLLMSettingNotFound) {
		return nil, err
	}
	if configured := strings.TrimSpace(routes[NormalizeTaskType(input.TaskType)]); configured != "" {
		configuredInput := input
		configuredInput.PlatformModelName = configured
		return s.ResolveRoute(ctx, configuredInput)
	}
	models, err := s.ListActiveModels(ctx, 0)
	if err != nil {
		return nil, err
	}
	for _, item := range models {
		name := strings.TrimSpace(item.PlatformModelName)
		if name == "" {
			continue
		}
		if !ModelSupportsTask(item.KindsJSON, input.TaskType) {
			continue
		}
		route, routeErr := s.ResolveRoute(ctx, ResolveRouteInput{
			PlatformModelName: name,
			TaskType:          input.TaskType,
			Scope:             input.Scope,
			UserID:            input.UserID,
			ConversationID:    input.ConversationID,
			RequestID:         strings.TrimSpace(input.RequestID),
		})
		if routeErr == nil {
			return route, nil
		}
	}
	return nil, ErrAllRoutesUnavailable
}

// ModelSupportsTask 判断模型声明的能力是否包含指定任务类型。
// 这里只校验静态目录能力，不读取路由健康或熔断状态。
func ModelSupportsTask(kindsJSON string, taskType string) bool {
	kinds := parseKinds(kindsJSON)
	if len(kinds) == 0 {
		return true
	}
	switch NormalizeTaskType(taskType) {
	case TaskTypeImageGeneration:
		return hasModelKind(kinds, modelKindImageGen)
	case TaskTypeImageEdit:
		return hasModelKind(kinds, modelKindImageEdit)
	case TaskTypeVideoGeneration:
		return hasModelKind(kinds, modelKindVideoGen)
	case TaskTypeVideoExtension:
		return hasModelKind(kinds, modelKindVideoExtension)
	default:
		return hasModelKind(kinds, modelKindChat)
	}
}
