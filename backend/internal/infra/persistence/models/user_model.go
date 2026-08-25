package model

// LLMUserModel 存储用户私有模型及其上游调用配置。
type LLMUserModel struct {
	BaseModel
	OwnerUserID     uint        `gorm:"not null;index:idx_llm_user_models_owner;uniqueIndex:idx_llm_user_models_owner_upstream_name;comment:归属用户ID"`
	UpstreamID      uint        `gorm:"not null;index:idx_llm_user_models_upstream;uniqueIndex:idx_llm_user_models_owner_upstream_name;comment:上游渠道ID"`
	Upstream        LLMUpstream `gorm:"foreignKey:UpstreamID;references:ID"`
	UpstreamModelID string      `gorm:"size:256;not null;comment:上游模型标识"`
	Name            string      `gorm:"size:128;not null;uniqueIndex:idx_llm_user_models_owner_upstream_name,where:deleted_at IS NULL;comment:用户模型名称"`
	Protocol        string      `gorm:"size:64;not null;default:'openai';comment:适配协议"`
	KindsJSON       string      `gorm:"type:text;not null;default:'[\"chat\"]';comment:模型类型JSON"`
	Status          string      `gorm:"size:32;not null;default:'active';index:idx_llm_user_models_status;comment:模型状态"`
	Priority        int         `gorm:"not null;default:1;comment:优先级"`
	Weight          int         `gorm:"not null;default:1;comment:权重"`
	HeadersJSON     string      `gorm:"type:text;not null;default:'{}';comment:请求头JSON"`
}

func (LLMUserModel) TableName() string { return "llm_user_models" }
