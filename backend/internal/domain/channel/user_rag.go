package channel

import "time"

// UserEmbeddingProfile 表示仅引用用户本人渠道的向量模型配置。
type UserEmbeddingProfile struct {
	ID                    uint
	PublicID              string
	OwnerUserID           uint
	UpstreamID            uint
	UserModelID           *uint
	Name                  string
	Protocol              string
	EmbeddingModelID      string
	OutputDimensions      int
	Normalize             bool
	BatchSize             int
	RequestTimeoutSeconds int
	Status                string
	IsDefault             bool
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// RAGSettings 表示用户默认或项目覆盖的检索策略。
type RAGSettings struct {
	OwnerUserID         uint
	ProjectID           uint
	InheritUserDefaults bool
	EmbeddingProfileID  *uint
	RAGEnabled          bool
	EmbedOnUpload       bool
	ChunkSizeTokens     int
	ChunkOverlapTokens  int
	TopK                int
	MinSimilarity       float32
	TokenBudget         int
	FetchMultiplier     int
	HybridEnabled       bool
}
