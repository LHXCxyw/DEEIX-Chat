package channel

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

const userUpstreamPresetsSettingKey = "user_upstream.presets"

// ListUserUpstreamPresets returns all configured presets for administrators.
func (s *Service) ListUserUpstreamPresets(ctx context.Context) ([]domainchannel.UserUpstreamPreset, error) {
	presets, err := s.loadUserUpstreamPresets(ctx)
	if err != nil {
		return nil, err
	}
	sortUserUpstreamPresets(presets)
	return presets, nil
}

// ListEnabledUserUpstreamPresets returns only presets available to users.
func (s *Service) ListEnabledUserUpstreamPresets(ctx context.Context) ([]domainchannel.UserUpstreamPreset, error) {
	presets, err := s.loadUserUpstreamPresets(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]domainchannel.UserUpstreamPreset, 0, len(presets))
	for _, preset := range presets {
		if preset.Enabled {
			result = append(result, preset)
		}
	}
	sortUserUpstreamPresets(result)
	return result, nil
}

func (s *Service) loadUserUpstreamPresets(ctx context.Context) ([]domainchannel.UserUpstreamPreset, error) {
	item, err := s.repo.GetLLMSetting(ctx, userUpstreamPresetsSettingKey)
	if err != nil {
		if errors.Is(err, repository.ErrLLMSettingNotFound) {
			return []domainchannel.UserUpstreamPreset{}, nil
		}
		return nil, err
	}
	if strings.TrimSpace(item.Value) == "" {
		return []domainchannel.UserUpstreamPreset{}, nil
	}
	var presets []domainchannel.UserUpstreamPreset
	if err := json.Unmarshal([]byte(item.Value), &presets); err != nil {
		return nil, ErrInvalidJSONConfig
	}
	return presets, nil
}

func sortUserUpstreamPresets(presets []domainchannel.UserUpstreamPreset) {
	sort.SliceStable(presets, func(i, j int) bool { return presets[i].SortOrder < presets[j].SortOrder })
}

func (s *Service) ReplaceUserUpstreamPresets(ctx context.Context, presets []domainchannel.UserUpstreamPreset) error {
	seen := make(map[string]struct{}, len(presets))
	for i := range presets {
		preset := &presets[i]
		preset.ID = strings.TrimSpace(preset.ID)
		preset.Name = strings.TrimSpace(preset.Name)
		preset.BaseURL = strings.TrimSpace(preset.BaseURL)
		preset.Compatible = normalizeCompatible(preset.Compatible)
		if preset.ID == "" || preset.Name == "" || preset.BaseURL == "" || preset.Compatible == "" {
			return repository.ErrInvalidInput
		}
		if err := s.validateUpstreamBaseURL(preset.BaseURL); err != nil {
			return err
		}
		if _, ok := seen[preset.ID]; ok {
			return repository.ErrInvalidInput
		}
		seen[preset.ID] = struct{}{}

		protocolDefaults, err := normalizeProtocolDefaultsJSON(preset.ProtocolDefaultsJSON)
		if err != nil {
			if errors.Is(err, ErrInvalidJSONConfig) {
				return ErrInvalidProtocolDefaultsConfig
			}
			return err
		}
		preset.ProtocolDefaultsJSON = protocolDefaults
	}
	value, err := json.Marshal(presets)
	if err != nil {
		return err
	}
	return s.repo.UpsertLLMSetting(ctx, &domainchannel.LLMSetting{Key: userUpstreamPresetsSettingKey, Value: string(value), Description: "用户自用渠道预设"})
}

func (s *Service) resolveUserUpstreamPreset(ctx context.Context, id string) (*domainchannel.UserUpstreamPreset, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil
	}
	presets, err := s.ListEnabledUserUpstreamPresets(ctx)
	if err != nil {
		return nil, err
	}
	for _, preset := range presets {
		if preset.ID == id {
			return &preset, nil
		}
	}
	return nil, repository.ErrInvalidInput
}
