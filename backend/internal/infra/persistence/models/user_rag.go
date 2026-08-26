package model

// UserEmbeddingProfile 存储用户自有渠道的向量模型配置，不重复保存渠道密钥。
type UserEmbeddingProfile struct {
	BaseModel
	PublicID              string        `gorm:"size:32;not null;uniqueIndex:idx_user_embedding_profiles_public_id;comment:公开配置ID"`
	OwnerUserID           uint          `gorm:"not null;index:idx_user_embedding_profiles_owner;comment:归属用户ID"`
	UpstreamID            uint          `gorm:"not null;index:idx_user_embedding_profiles_upstream;comment:用户自有渠道ID"`
	Upstream              LLMUpstream   `gorm:"foreignKey:UpstreamID;references:ID"`
	UserModelID           *uint         `gorm:"index:idx_user_embedding_profiles_model;comment:可选用户私有模型ID"`
	UserModel             *LLMUserModel `gorm:"foreignKey:UserModelID;references:ID"`
	Name                  string        `gorm:"size:128;not null;comment:配置名称"`
	Protocol              string        `gorm:"size:64;not null;default:'openai';comment:Embedding协议"`
	EmbeddingModelID      string        `gorm:"size:256;not null;comment:上游向量模型标识"`
	OutputDimensions      int           `gorm:"not null;comment:输出向量维度"`
	Normalize             bool          `gorm:"not null;default:true;comment:是否归一化"`
	BatchSize             int           `gorm:"not null;default:16;comment:批大小"`
	RequestTimeoutSeconds int           `gorm:"not null;default:30;comment:请求超时秒数"`
	Status                string        `gorm:"size:32;not null;default:'active';index:idx_user_embedding_profiles_status;comment:状态"`
	IsDefault             bool          `gorm:"not null;default:false;index:idx_user_embedding_profiles_default;comment:是否默认"`
}

func (UserEmbeddingProfile) TableName() string { return "user_embedding_profiles" }

// UserRAGSetting 存储用户默认 RAG 策略。
type UserRAGSetting struct {
	OwnerUserID        uint    `gorm:"primaryKey;comment:归属用户ID"`
	EmbeddingProfileID *uint   `gorm:"index:idx_user_rag_settings_profile;comment:Embedding配置ID"`
	RAGEnabled         bool    `gorm:"not null;default:false;comment:是否启用RAG"`
	EmbedOnUpload      bool    `gorm:"not null;default:false;comment:上传后自动向量化"`
	ChunkSizeTokens    int     `gorm:"not null;default:800;comment:分片大小"`
	ChunkOverlapTokens int     `gorm:"not null;default:120;comment:分片重叠"`
	TopK               int     `gorm:"not null;default:8;comment:召回数量"`
	MinSimilarity      float32 `gorm:"not null;default:0.25;comment:最低相似度"`
	TokenBudget        int     `gorm:"not null;default:6000;comment:上下文Token预算"`
	FetchMultiplier    int     `gorm:"not null;default:4;comment:候选扩展倍数"`
	HybridEnabled      bool    `gorm:"not null;default:true;comment:是否混合检索"`
	UpdatedAt          int64   `gorm:"autoUpdateTime:milli"`
}

func (UserRAGSetting) TableName() string { return "user_rag_settings" }

// ProjectRAGSetting 存储当前用户项目的 RAG 覆盖策略。
type ProjectRAGSetting struct {
	ProjectID           uint    `gorm:"primaryKey;comment:项目ID"`
	OwnerUserID         uint    `gorm:"not null;index:idx_project_rag_settings_owner;comment:归属用户ID"`
	InheritUserDefaults bool    `gorm:"not null;default:true;comment:是否继承用户默认值"`
	EmbeddingProfileID  *uint   `gorm:"index:idx_project_rag_settings_profile;comment:Embedding配置ID"`
	RAGEnabled          bool    `gorm:"not null;default:false;comment:是否启用RAG"`
	EmbedOnImport       bool    `gorm:"not null;default:false;comment:导入后自动向量化"`
	ChunkSizeTokens     int     `gorm:"not null;default:800;comment:分片大小"`
	ChunkOverlapTokens  int     `gorm:"not null;default:120;comment:分片重叠"`
	TopK                int     `gorm:"not null;default:8;comment:召回数量"`
	MinSimilarity       float32 `gorm:"not null;default:0.25;comment:最低相似度"`
	TokenBudget         int     `gorm:"not null;default:6000;comment:上下文Token预算"`
	FetchMultiplier     int     `gorm:"not null;default:4;comment:候选扩展倍数"`
	HybridEnabled       bool    `gorm:"not null;default:true;comment:是否混合检索"`
	UpdatedAt           int64   `gorm:"autoUpdateTime:milli"`
}

func (ProjectRAGSetting) TableName() string { return "project_rag_settings" }
