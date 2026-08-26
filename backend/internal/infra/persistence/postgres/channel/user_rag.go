package channel

import (
	"context"
	"errors"
	"strings"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func profileDomain(v model.UserEmbeddingProfile) domainchannel.UserEmbeddingProfile {
	return domainchannel.UserEmbeddingProfile{ID: v.ID, PublicID: v.PublicID, OwnerUserID: v.OwnerUserID, UpstreamID: v.UpstreamID, UserModelID: v.UserModelID, Name: v.Name, Protocol: v.Protocol, EmbeddingModelID: v.EmbeddingModelID, OutputDimensions: v.OutputDimensions, Normalize: v.Normalize, BatchSize: v.BatchSize, RequestTimeoutSeconds: v.RequestTimeoutSeconds, Status: v.Status, IsDefault: v.IsDefault, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}

func (r *Repo) ListUserEmbeddingProfiles(ctx context.Context, userID uint) ([]domainchannel.UserEmbeddingProfile, error) {
	var rows []model.UserEmbeddingProfile
	if err := r.db.WithContext(ctx).Joins("JOIN llm_upstreams u ON u.id = user_embedding_profiles.upstream_id").Where("user_embedding_profiles.owner_user_id = ? AND u.owner_user_id = ? AND u.ownership_type = ?", userID, userID, "user").Order("is_default DESC, id DESC").Find(&rows).Error; err != nil {
		return nil, translateError(err)
	}
	out := make([]domainchannel.UserEmbeddingProfile, len(rows))
	for i := range rows {
		out[i] = profileDomain(rows[i])
	}
	return out, nil
}

func (r *Repo) GetUserEmbeddingProfile(ctx context.Context, userID, profileID uint) (*domainchannel.UserEmbeddingProfile, error) {
	var row model.UserEmbeddingProfile
	if err := r.db.WithContext(ctx).Joins("JOIN llm_upstreams u ON u.id = user_embedding_profiles.upstream_id").Where("user_embedding_profiles.id = ? AND user_embedding_profiles.owner_user_id = ? AND u.owner_user_id = ? AND u.ownership_type = ?", profileID, userID, userID, "user").First(&row).Error; err != nil {
		return nil, translateError(err)
	}
	v := profileDomain(row)
	return &v, nil
}

func (r *Repo) SaveUserEmbeddingProfile(ctx context.Context, item *domainchannel.UserEmbeddingProfile) error {
	if item == nil {
		return repository.ErrInvalidInput
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.LLMUpstream{}).Where("id = ? AND owner_user_id = ? AND ownership_type = ? AND status = ?", item.UpstreamID, item.OwnerUserID, "user", "active").Count(&count).Error; err != nil || count != 1 {
			return repository.ErrNotFound
		}
		if item.UserModelID != nil {
			if err := tx.Model(&model.LLMUserModel{}).Where("id = ? AND owner_user_id = ? AND upstream_id = ?", *item.UserModelID, item.OwnerUserID, item.UpstreamID).Count(&count).Error; err != nil || count != 1 {
				return repository.ErrNotFound
			}
		}
		if item.IsDefault {
			if err := tx.Model(&model.UserEmbeddingProfile{}).Where("owner_user_id = ?", item.OwnerUserID).Update("is_default", false).Error; err != nil {
				return err
			}
		}
		row := model.UserEmbeddingProfile{BaseModel: model.BaseModel{ID: item.ID}, PublicID: item.PublicID, OwnerUserID: item.OwnerUserID, UpstreamID: item.UpstreamID, UserModelID: item.UserModelID, Name: item.Name, Protocol: item.Protocol, EmbeddingModelID: item.EmbeddingModelID, OutputDimensions: item.OutputDimensions, Normalize: item.Normalize, BatchSize: item.BatchSize, RequestTimeoutSeconds: item.RequestTimeoutSeconds, Status: item.Status, IsDefault: item.IsDefault}
		if item.ID == 0 {
			if err := tx.Create(&row).Error; err != nil {
				return translateError(err)
			}
		} else {
			res := tx.Model(&model.UserEmbeddingProfile{}).Where("id = ? AND owner_user_id = ?", item.ID, item.OwnerUserID).Updates(&row)
			if res.Error != nil {
				return translateError(res.Error)
			}
			if res.RowsAffected == 0 {
				return repository.ErrNotFound
			}
		}
		if err := tx.First(&row, row.ID).Error; err != nil {
			return translateError(err)
		}
		*item = profileDomain(row)
		return nil
	})
}

func (r *Repo) DeleteUserEmbeddingProfile(ctx context.Context, userID, profileID uint) error {
	res := r.db.WithContext(ctx).Where("id = ? AND owner_user_id = ?", profileID, userID).Delete(&model.UserEmbeddingProfile{})
	if res.Error != nil {
		return translateError(res.Error)
	}
	if res.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

func ragDomain(v model.UserRAGSetting) domainchannel.RAGSettings {
	return domainchannel.RAGSettings{OwnerUserID: v.OwnerUserID, InheritUserDefaults: false, EmbeddingProfileID: v.EmbeddingProfileID, RAGEnabled: v.RAGEnabled, EmbedOnUpload: v.EmbedOnUpload, ChunkSizeTokens: v.ChunkSizeTokens, ChunkOverlapTokens: v.ChunkOverlapTokens, TopK: v.TopK, MinSimilarity: v.MinSimilarity, TokenBudget: v.TokenBudget, FetchMultiplier: v.FetchMultiplier, HybridEnabled: v.HybridEnabled}
}

func (r *Repo) GetUserRAGSettings(ctx context.Context, userID uint) (*domainchannel.RAGSettings, error) {
	var row model.UserRAGSetting
	err := r.db.WithContext(ctx).First(&row, "owner_user_id = ?", userID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, repository.ErrNotFound
	}
	if err != nil {
		return nil, translateError(err)
	}
	v := ragDomain(row)
	return &v, nil
}
func (r *Repo) SaveUserRAGSettings(ctx context.Context, item *domainchannel.RAGSettings) error {
	if item == nil {
		return repository.ErrInvalidInput
	}
	row := model.UserRAGSetting{OwnerUserID: item.OwnerUserID, EmbeddingProfileID: item.EmbeddingProfileID, RAGEnabled: item.RAGEnabled, EmbedOnUpload: item.EmbedOnUpload, ChunkSizeTokens: item.ChunkSizeTokens, ChunkOverlapTokens: item.ChunkOverlapTokens, TopK: item.TopK, MinSimilarity: item.MinSimilarity, TokenBudget: item.TokenBudget, FetchMultiplier: item.FetchMultiplier, HybridEnabled: item.HybridEnabled}
	return translateError(r.db.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_user_id"}}, DoUpdates: clause.AssignmentColumns([]string{"embedding_profile_id", "rag_enabled", "embed_on_upload", "chunk_size_tokens", "chunk_overlap_tokens", "top_k", "min_similarity", "token_budget", "fetch_multiplier", "hybrid_enabled", "updated_at"})}).Create(&row).Error)
}

func (r *Repo) GetProjectRAGSettings(ctx context.Context, userID uint, projectPublicID string) (*domainchannel.RAGSettings, error) {
	var row model.ProjectRAGSetting
	err := r.db.WithContext(ctx).Table("project_rag_settings prs").Select("prs.*").Joins("JOIN chat_conversation_projects p ON p.id = prs.project_id").Where("p.user_id = ? AND p.public_id = ? AND prs.owner_user_id = ?", userID, strings.TrimSpace(projectPublicID), userID).Scan(&row).Error
	if err != nil {
		return nil, translateError(err)
	}
	if row.ProjectID == 0 {
		return nil, repository.ErrNotFound
	}
	return &domainchannel.RAGSettings{OwnerUserID: row.OwnerUserID, ProjectID: row.ProjectID, InheritUserDefaults: row.InheritUserDefaults, EmbeddingProfileID: row.EmbeddingProfileID, RAGEnabled: row.RAGEnabled, EmbedOnUpload: row.EmbedOnImport, ChunkSizeTokens: row.ChunkSizeTokens, ChunkOverlapTokens: row.ChunkOverlapTokens, TopK: row.TopK, MinSimilarity: row.MinSimilarity, TokenBudget: row.TokenBudget, FetchMultiplier: row.FetchMultiplier, HybridEnabled: row.HybridEnabled}, nil
}
func (r *Repo) SaveProjectRAGSettings(ctx context.Context, userID uint, projectPublicID string, item *domainchannel.RAGSettings) error {
	if item == nil {
		return repository.ErrInvalidInput
	}
	var project model.ConversationProject
	if err := r.db.WithContext(ctx).Where("user_id = ? AND public_id = ?", userID, strings.TrimSpace(projectPublicID)).First(&project).Error; err != nil {
		return translateError(err)
	}
	row := model.ProjectRAGSetting{ProjectID: project.ID, OwnerUserID: userID, InheritUserDefaults: item.InheritUserDefaults, EmbeddingProfileID: item.EmbeddingProfileID, RAGEnabled: item.RAGEnabled, EmbedOnImport: item.EmbedOnUpload, ChunkSizeTokens: item.ChunkSizeTokens, ChunkOverlapTokens: item.ChunkOverlapTokens, TopK: item.TopK, MinSimilarity: item.MinSimilarity, TokenBudget: item.TokenBudget, FetchMultiplier: item.FetchMultiplier, HybridEnabled: item.HybridEnabled}
	return translateError(r.db.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "project_id"}}, DoUpdates: clause.AssignmentColumns([]string{"owner_user_id", "inherit_user_defaults", "embedding_profile_id", "rag_enabled", "embed_on_import", "chunk_size_tokens", "chunk_overlap_tokens", "top_k", "min_similarity", "token_budget", "fetch_multiplier", "hybrid_enabled", "updated_at"})}).Create(&row).Error)
}
