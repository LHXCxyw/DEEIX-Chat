package conversation

import "time"

const (
	ProjectWorkspaceStatusActive = "active"
	ProjectFileEntryTypeFile      = "file"
	ProjectFileEntryTypeDirectory = "directory"
)

// ProjectWorkspace 表示会话项目的一对一文件工作区。
type ProjectWorkspace struct {
	ID                    uint
	PublicID              string
	OwnerUserID           uint
	ConversationProjectID uint
	Status                string
	StorageBytes          int64
	FileCount             int
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// ProjectFile 表示严格归属于用户和项目工作区的文件树节点。
type ProjectFile struct {
	ID             uint
	PublicID       string
	OwnerUserID    uint
	ProjectID      uint
	ParentID       *uint
	RelativePath   string
	FileName       string
	EntryType      string
	StorageKey     string
	MimeType       string
	SizeBytes      int64
	SHA256         string
	SourceImportID *uint
	Version        int
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// ProjectImport 表示一次项目 ZIP 导入结果。
type ProjectImport struct {
	ID             uint
	PublicID       string
	OwnerUserID    uint
	ProjectID      uint
	Status         string
	ArchiveName    string
	FileCount      int
	TotalBytes     int64
	ErrorCode      string
	ErrorMessage   string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	CompletedAt    *time.Time
}
