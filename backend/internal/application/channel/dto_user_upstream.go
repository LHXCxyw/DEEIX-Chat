package channel

// CreateUserUpstreamInput 用户创建自有渠道输入
type CreateUserUpstreamInput struct {
	Name             string
	BaseURL          string
	Compatible       string
	APIKeys          []APIKeyInput
	ConnectTimeoutMS int
	ReadTimeoutMS    int
	Headers          map[string]string
}

// UpdateUserUpstreamInput 用户更新自有渠道输入
type UpdateUserUpstreamInput struct {
	Name             *string
	BaseURL          *string
	APIKeys          *[]APIKeyInput
	ConnectTimeoutMS *int
	ReadTimeoutMS    *int
	Headers          *map[string]string
	Status           *string // "active" | "disabled"
}

// APIKeyInput API密钥输入结构
type APIKeyInput struct {
	Key    string
	Status string // "active" | "disabled"
	Note   string
}
