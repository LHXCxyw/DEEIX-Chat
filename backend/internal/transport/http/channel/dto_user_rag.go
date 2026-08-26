package channel

import "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"

// SaveEmbeddingProfileRequest 用户向量配置请求。
type SaveEmbeddingProfileRequest struct {
	ID                    uint   `json:"id"`
	UpstreamID            uint   `json:"upstreamId" binding:"required"`
	UserModelID           *uint  `json:"userModelId"`
	Name                  string `json:"name" binding:"required,max=128"`
	Protocol              string `json:"protocol" binding:"required,max=64"`
	EmbeddingModelID      string `json:"embeddingModelId" binding:"required,max=256"`
	OutputDimensions      int    `json:"outputDimensions" binding:"required"`
	Normalize             bool   `json:"normalize"`
	BatchSize             int    `json:"batchSize"`
	RequestTimeoutSeconds int    `json:"requestTimeoutSeconds"`
	Status                string `json:"status"`
	IsDefault             bool   `json:"isDefault"`
}

// SaveRAGSettingsRequest 用户或项目 RAG 配置请求。
type SaveRAGSettingsRequest struct {
	InheritUserDefaults bool    `json:"inheritUserDefaults"`
	EmbeddingProfileID  *uint   `json:"embeddingProfileId"`
	RAGEnabled          bool    `json:"ragEnabled"`
	EmbedOnUpload       bool    `json:"embedOnUpload"`
	ChunkSizeTokens     int     `json:"chunkSizeTokens"`
	ChunkOverlapTokens  int     `json:"chunkOverlapTokens"`
	TopK                int     `json:"topK"`
	MinSimilarity       float32 `json:"minSimilarity"`
	TokenBudget         int     `json:"tokenBudget"`
	FetchMultiplier     int     `json:"fetchMultiplier"`
	HybridEnabled       bool    `json:"hybridEnabled"`
}

func ragInput(v SaveRAGSettingsRequest) channel.SaveRAGSettingsInput {
	return channel.SaveRAGSettingsInput{InheritUserDefaults: v.InheritUserDefaults, EmbeddingProfileID: v.EmbeddingProfileID, RAGEnabled: v.RAGEnabled, EmbedOnUpload: v.EmbedOnUpload, ChunkSizeTokens: v.ChunkSizeTokens, ChunkOverlapTokens: v.ChunkOverlapTokens, TopK: v.TopK, MinSimilarity: v.MinSimilarity, TokenBudget: v.TokenBudget, FetchMultiplier: v.FetchMultiplier, HybridEnabled: v.HybridEnabled}
}
