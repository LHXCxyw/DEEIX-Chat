package channel

import (
	"context"
	"errors"
	"strings"

	domainchannel "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/google/uuid"
)

var ErrUserEmbeddingDisabled = errors.New("user embedding disabled")
var ErrUserRAGDisabled = errors.New("user rag disabled")

type SaveEmbeddingProfileInput struct {
	ID                               uint
	UpstreamID                       uint
	UserModelID                      *uint
	Name, Protocol, EmbeddingModelID string
	OutputDimensions                 int
	Normalize                        bool
	BatchSize, RequestTimeoutSeconds int
	Status                           string
	IsDefault                        bool
}
type SaveRAGSettingsInput struct {
	InheritUserDefaults                       bool
	EmbeddingProfileID                        *uint
	RAGEnabled, EmbedOnUpload                 bool
	ChunkSizeTokens, ChunkOverlapTokens, TopK int
	MinSimilarity                             float32
	TokenBudget, FetchMultiplier              int
	HybridEnabled                             bool
}

func (s *Service) ragRepo() (repository.UserRAGRepository, error) {
	v, ok := s.repo.(repository.UserRAGRepository)
	if !ok {
		return nil, repository.ErrInvalidInput
	}
	return v, nil
}
func (s *Service) ensureEmbeddingAdmission() error {
	c := s.cfg.Snapshot()
	if !c.UserUpstreamEnabled || !c.UserEmbeddingEnabled {
		return ErrUserEmbeddingDisabled
	}
	return nil
}

func (s *Service) ensureRAGAdmission() error {
	c := s.cfg.Snapshot()
	if !c.UserUpstreamEnabled || !c.UserEmbeddingEnabled || !c.UserRAGEnabled {
		return ErrUserRAGDisabled
	}
	return nil
}
func (s *Service) ListUserEmbeddingProfiles(ctx context.Context, userID uint) ([]domainchannel.UserEmbeddingProfile, error) {
	if err := s.ensureEmbeddingAdmission(); err != nil {
		return nil, err
	}
	r, err := s.ragRepo()
	if err != nil {
		return nil, err
	}
	return r.ListUserEmbeddingProfiles(ctx, userID)
}
func (s *Service) SaveUserEmbeddingProfile(ctx context.Context, userID uint, in SaveEmbeddingProfileInput) (*domainchannel.UserEmbeddingProfile, error) {
	if err := s.ensureEmbeddingAdmission(); err != nil {
		return nil, err
	}
	c := s.cfg.Snapshot()
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.EmbeddingModelID) == "" || in.OutputDimensions < c.UserEmbeddingMinDimensions || in.OutputDimensions > c.UserEmbeddingMaxDimensions || in.BatchSize < 1 || in.BatchSize > 256 || in.RequestTimeoutSeconds < 1 || in.RequestTimeoutSeconds > 120 {
		return nil, repository.ErrInvalidInput
	}
	protocol := strings.ToLower(strings.TrimSpace(in.Protocol))
	allowed := false
	for _, p := range strings.Split(c.UserEmbeddingAllowedProtocols, ",") {
		if strings.TrimSpace(p) == protocol {
			allowed = true
		}
	}
	if !allowed {
		return nil, repository.ErrInvalidInput
	}
	if _, err := s.repo.GetUserUpstreamByID(ctx, userID, in.UpstreamID); err != nil {
		return nil, err
	}
	r, err := s.ragRepo()
	if err != nil {
		return nil, err
	}
	if in.ID == 0 && c.UserEmbeddingProfileLimit > 0 {
		rows, err := r.ListUserEmbeddingProfiles(ctx, userID)
		if err != nil {
			return nil, err
		}
		if len(rows) >= c.UserEmbeddingProfileLimit {
			return nil, repository.ErrInvalidInput
		}
	}
	item := &domainchannel.UserEmbeddingProfile{ID: in.ID, PublicID: strings.ReplaceAll(uuid.NewString(), "-", ""), OwnerUserID: userID, UpstreamID: in.UpstreamID, UserModelID: in.UserModelID, Name: strings.TrimSpace(in.Name), Protocol: protocol, EmbeddingModelID: strings.TrimSpace(in.EmbeddingModelID), OutputDimensions: in.OutputDimensions, Normalize: in.Normalize, BatchSize: in.BatchSize, RequestTimeoutSeconds: in.RequestTimeoutSeconds, Status: in.Status, IsDefault: in.IsDefault}
	if item.Status == "" {
		item.Status = "active"
	}
	if in.ID > 0 {
		old, err := r.GetUserEmbeddingProfile(ctx, userID, in.ID)
		if err != nil {
			return nil, err
		}
		item.PublicID = old.PublicID
	}
	if err := r.SaveUserEmbeddingProfile(ctx, item); err != nil {
		return nil, err
	}
	return item, nil
}
func (s *Service) DeleteUserEmbeddingProfile(ctx context.Context, userID, profileID uint) error {
	if err := s.ensureEmbeddingAdmission(); err != nil {
		return err
	}
	r, _ := s.ragRepo()
	return r.DeleteUserEmbeddingProfile(ctx, userID, profileID)
}

func defaultRAG(userID uint) *domainchannel.RAGSettings {
	return &domainchannel.RAGSettings{OwnerUserID: userID, ChunkSizeTokens: 800, ChunkOverlapTokens: 120, TopK: 8, MinSimilarity: .25, TokenBudget: 6000, FetchMultiplier: 4, HybridEnabled: true}
}
func (s *Service) validateRAG(ctx context.Context, userID uint, in SaveRAGSettingsInput) (*domainchannel.RAGSettings, error) {
	c := s.cfg.Snapshot()
	if !c.UserUpstreamEnabled || !c.UserEmbeddingEnabled || !c.UserRAGEnabled {
		return nil, ErrUserRAGDisabled
	}
	if in.ChunkSizeTokens < 100 || in.ChunkSizeTokens > 8000 || in.ChunkOverlapTokens < 0 || in.ChunkOverlapTokens >= in.ChunkSizeTokens || in.TopK < 1 || in.TopK > 100 || in.MinSimilarity < 0 || in.MinSimilarity > 1 || in.TokenBudget < 256 || in.TokenBudget > 100000 || in.FetchMultiplier < 1 || in.FetchMultiplier > 20 {
		return nil, repository.ErrInvalidInput
	}
	if in.EmbeddingProfileID != nil {
		r, _ := s.ragRepo()
		p, err := r.GetUserEmbeddingProfile(ctx, userID, *in.EmbeddingProfileID)
		if err != nil || p.Status != "active" {
			return nil, repository.ErrNotFound
		}
	}
	if in.RAGEnabled && in.EmbeddingProfileID == nil {
		return nil, repository.ErrInvalidInput
	}
	return &domainchannel.RAGSettings{OwnerUserID: userID, InheritUserDefaults: in.InheritUserDefaults, EmbeddingProfileID: in.EmbeddingProfileID, RAGEnabled: in.RAGEnabled, EmbedOnUpload: in.EmbedOnUpload, ChunkSizeTokens: in.ChunkSizeTokens, ChunkOverlapTokens: in.ChunkOverlapTokens, TopK: in.TopK, MinSimilarity: in.MinSimilarity, TokenBudget: in.TokenBudget, FetchMultiplier: in.FetchMultiplier, HybridEnabled: in.HybridEnabled}, nil
}
func (s *Service) GetUserRAGSettings(ctx context.Context, userID uint) (*domainchannel.RAGSettings, error) {
	if err := s.ensureRAGAdmission(); err != nil {
		return nil, err
	}
	r, err := s.ragRepo()
	if err != nil {
		return nil, err
	}
	v, err := r.GetUserRAGSettings(ctx, userID)
	if errors.Is(err, repository.ErrNotFound) {
		return defaultRAG(userID), nil
	}
	return v, err
}
func (s *Service) SaveUserRAGSettings(ctx context.Context, userID uint, in SaveRAGSettingsInput) (*domainchannel.RAGSettings, error) {
	v, err := s.validateRAG(ctx, userID, in)
	if err != nil {
		return nil, err
	}
	r, _ := s.ragRepo()
	if err = r.SaveUserRAGSettings(ctx, v); err != nil {
		return nil, err
	}
	return v, nil
}
func (s *Service) GetProjectRAGSettings(ctx context.Context, userID uint, projectID string) (*domainchannel.RAGSettings, error) {
	if err := s.ensureRAGAdmission(); err != nil {
		return nil, err
	}
	r, err := s.ragRepo()
	if err != nil {
		return nil, err
	}
	v, err := r.GetProjectRAGSettings(ctx, userID, projectID)
	if errors.Is(err, repository.ErrNotFound) {
		v, err = s.GetUserRAGSettings(ctx, userID)
		if err == nil {
			v.InheritUserDefaults = true
		}
		return v, err
	}
	return v, err
}
func (s *Service) SaveProjectRAGSettings(ctx context.Context, userID uint, projectID string, in SaveRAGSettingsInput) (*domainchannel.RAGSettings, error) {
	v, err := s.validateRAG(ctx, userID, in)
	if err != nil {
		return nil, err
	}
	r, err := s.ragRepo()
	if err != nil {
		return nil, err
	}
	if err = r.SaveProjectRAGSettings(ctx, userID, projectID, v); err != nil {
		return nil, err
	}
	return r.GetProjectRAGSettings(ctx, userID, projectID)
}
