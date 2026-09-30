package model

import "time"

// ProjectWorkspace 存储会话项目的一对一文件工作区。
type ProjectWorkspace struct {
	BaseModel
	PublicID              string `gorm:"size:32;not null;uniqueIndex:idx_project_workspaces_public_id;comment:公开工作区ID"`
	OwnerUserID           uint   `gorm:"not null;uniqueIndex:idx_project_workspaces_owner_project,priority:1;index:idx_project_workspaces_owner;comment:归属用户ID"`
	ConversationProjectID uint   `gorm:"not null;uniqueIndex:idx_project_workspaces_project;uniqueIndex:idx_project_workspaces_owner_project,priority:2;comment:会话项目ID"`
	Status                string `gorm:"size:24;not null;default:'active';index:idx_project_workspaces_status;comment:工作区状态"`
	StorageBytes          int64  `gorm:"not null;default:0;comment:工作区存储字节数"`
	FileCount             int    `gorm:"not null;default:0;comment:工作区文件数"`
}

func (ProjectWorkspace) TableName() string { return "project_workspaces" }

// ProjectFile 存储项目文件树节点。
type ProjectFile struct {
	BaseModel
	PublicID       string `gorm:"size:32;not null;uniqueIndex:idx_project_files_public_id;comment:公开文件ID"`
	OwnerUserID    uint   `gorm:"not null;index:idx_project_files_scope,priority:1;index:idx_project_files_owner;comment:归属用户ID"`
	ProjectID      uint   `gorm:"not null;index:idx_project_files_scope,priority:2;index:idx_project_files_parent_scope,priority:1;uniqueIndex:idx_project_files_active_path,priority:1;comment:工作区ID"`
	ParentID       *uint  `gorm:"index:idx_project_files_parent_scope,priority:2;comment:父节点ID"`
	RelativePath   string `gorm:"size:1024;not null;uniqueIndex:idx_project_files_active_path,priority:2;comment:规范化POSIX相对路径"`
	FileName       string `gorm:"size:255;not null;comment:文件名"`
	EntryType      string `gorm:"size:16;not null;index:idx_project_files_entry_type;comment:节点类型(file/directory)"`
	StorageKey     string `gorm:"size:1536;not null;default:'';comment:对象存储键"`
	MimeType       string `gorm:"size:128;not null;default:'';comment:MIME类型"`
	SizeBytes      int64  `gorm:"not null;default:0;comment:文件大小"`
	SHA256         string `gorm:"size:64;not null;default:'';index:idx_project_files_sha256;comment:内容SHA256"`
	SourceImportID *uint  `gorm:"index:idx_project_files_source_import;comment:来源导入任务ID"`
	Version        int    `gorm:"not null;default:1;comment:文件版本"`
}

func (ProjectFile) TableName() string { return "project_files" }

// ProjectFileChange 记录项目文件每次内容变更的前后状态，是消息回退（rewind）
// 推导"目标时点工作区状态"的唯一依据。行一经写入永不修改、永不删除。
// Before*/After* 为空表示该侧文件不存在（创建/删除）。
type ProjectFileChange struct {
	BaseModel
	OwnerUserID     uint   `gorm:"not null;index:idx_project_file_changes_scope,priority:1;comment:归属用户ID"`
	ProjectID       uint   `gorm:"not null;index:idx_project_file_changes_scope,priority:2;comment:工作区ID"`
	RelativePath    string `gorm:"size:1024;not null;index:idx_project_file_changes_path;comment:规范化POSIX相对路径"`
	Op              string `gorm:"size:16;not null;comment:操作类型(write/delete)"`
	Source          string `gorm:"size:16;not null;index:idx_project_file_changes_source;comment:来源(agent/user/import/rewind)"`
	ConversationID  uint   `gorm:"not null;default:0;index:idx_project_file_changes_conversation;comment:产生变更的会话ID(非会话内操作为0)"`
	MessageID       uint   `gorm:"not null;default:0;index:idx_project_file_changes_message;comment:产生变更的消息ID(非消息内操作为0)"`
	RunID           string `gorm:"size:64;not null;default:'';comment:产生变更的运行ID"`
	BeforeVersion   int    `gorm:"not null;default:0;comment:变更前版本号(0表示此前不存在)"`
	BeforeStorageKey string `gorm:"size:1536;not null;default:'';comment:变更前对象存储键"`
	BeforeSHA256    string `gorm:"size:64;not null;default:'';comment:变更前内容SHA256"`
	BeforeSizeBytes int64  `gorm:"not null;default:0;comment:变更前大小"`
	BeforeMimeType  string `gorm:"size:128;not null;default:'';comment:变更前MIME类型"`
	AfterVersion    int    `gorm:"not null;default:0;comment:变更后版本号(0表示已删除)"`
	AfterStorageKey string `gorm:"size:1536;not null;default:'';comment:变更后对象存储键"`
	AfterSHA256     string `gorm:"size:64;not null;default:'';comment:变更后内容SHA256"`
	AfterSizeBytes  int64  `gorm:"not null;default:0;comment:变更后大小"`
	AfterMimeType   string `gorm:"size:128;not null;default:'';comment:变更后MIME类型"`
}

func (ProjectFileChange) TableName() string { return "project_file_changes" }

// ProjectImport 存储项目 ZIP 导入任务及结果。
type ProjectImport struct {
	BaseModel
	PublicID     string     `gorm:"size:32;not null;uniqueIndex:idx_project_imports_public_id;comment:公开导入ID"`
	OwnerUserID  uint       `gorm:"not null;index:idx_project_imports_scope,priority:1;comment:归属用户ID"`
	ProjectID    uint       `gorm:"not null;index:idx_project_imports_scope,priority:2;comment:工作区ID"`
	Status       string     `gorm:"size:24;not null;index:idx_project_imports_status;comment:导入状态"`
	ArchiveName  string     `gorm:"size:255;not null;comment:ZIP文件名"`
	FileCount    int        `gorm:"not null;default:0;comment:导入文件数"`
	TotalBytes   int64      `gorm:"not null;default:0;comment:导入解压总字节数"`
	ErrorCode    string     `gorm:"size:64;not null;default:'';comment:错误码"`
	ErrorMessage string     `gorm:"size:255;not null;default:'';comment:错误信息"`
	CompletedAt  *time.Time `gorm:"comment:完成时间"`
}

func (ProjectImport) TableName() string { return "project_imports" }
