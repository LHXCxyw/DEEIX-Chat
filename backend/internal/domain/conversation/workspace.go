package conversation

import "time"

const (
	ProjectWorkspaceStatusActive  = "active"
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
	ID           uint
	PublicID     string
	OwnerUserID  uint
	ProjectID    uint
	Status       string
	ArchiveName  string
	FileCount    int
	TotalBytes   int64
	ErrorCode    string
	ErrorMessage string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	CompletedAt  *time.Time
}

// 项目文件变更来源。
const (
	ProjectFileChangeSourceAgent  = "agent"
	ProjectFileChangeSourceUser   = "user"
	ProjectFileChangeSourceImport = "import"
	ProjectFileChangeSourceRewind = "rewind"
)

// 项目文件变更操作类型。
const (
	ProjectFileChangeOpWrite  = "write"
	ProjectFileChangeOpDelete = "delete"
)

// ProjectFileSnapshot 表示某次变更发生前后单个文件的内容状态；全部零值表示文件不存在。
type ProjectFileSnapshot struct {
	Version    int
	StorageKey string
	SHA256     string
	SizeBytes  int64
	MimeType   string
}

// Empty 表示该快照对应"文件不存在"。
func (s ProjectFileSnapshot) Empty() bool {
	return s.Version == 0 && s.StorageKey == ""
}

// ProjectFileChange 表示项目文件的一次历史变更记录。
type ProjectFileChange struct {
	ID             uint
	OwnerUserID    uint
	ProjectID      uint
	RelativePath   string
	Op             string
	Source         string
	ConversationID uint
	MessageID      uint
	RunID          string
	Before         ProjectFileSnapshot
	After          ProjectFileSnapshot
	CreatedAt      time.Time
	UpdatedAt      time.Time
}
