package channel

import "time"

// UserModel 表示用户私有模型。
type UserModel struct {
	ID                 uint
	OwnerUserID        uint
	UpstreamID         uint
	UpstreamName       string
	UpstreamCompatible string
	UpstreamModelID    string
	Name               string
	Protocol           string
	KindsJSON          string
	Status             string
	Priority           int
	Weight             int
	HeadersJSON        string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}
