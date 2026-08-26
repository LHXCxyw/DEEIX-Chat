package repository

import (
	"context"

	domainconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
)

// ProjectWorkspaceRepository 封装项目工作区资源访问。
// 所有子资源查询都必须同时携带 ownerUserID 与 projectID，形成仓储层第二道权限边界。
type ProjectWorkspaceRepository interface {
	GetOrCreateProjectWorkspace(ctx context.Context, ownerUserID uint, conversationProjectID uint, publicID string) (*domainconversation.ProjectWorkspace, error)
	GetProjectWorkspaceByProject(ctx context.Context, ownerUserID uint, conversationProjectID uint) (*domainconversation.ProjectWorkspace, error)
	CreateProjectImport(ctx context.Context, item *domainconversation.ProjectImport) error
	CompleteProjectImport(ctx context.Context, ownerUserID uint, projectID uint, importID uint, files []domainconversation.ProjectFile, fileCount int, totalBytes int64) error
	FailProjectImport(ctx context.Context, ownerUserID uint, projectID uint, importID uint, code string, message string) error
	GetProjectImport(ctx context.Context, ownerUserID uint, projectID uint, publicID string) (*domainconversation.ProjectImport, error)
	ListProjectFiles(ctx context.Context, ownerUserID uint, projectID uint) ([]domainconversation.ProjectFile, error)
	CreateProjectFile(ctx context.Context, item *domainconversation.ProjectFile) error
	UpdateProjectFile(ctx context.Context, ownerUserID uint, projectID uint, publicID string, storageKey string, mimeType string, sizeBytes int64, sha256 string, version int) (*domainconversation.ProjectFile, error)
	UpdateProjectWorkspaceUsage(ctx context.Context, ownerUserID uint, workspaceID uint, storageDelta int64, fileDelta int) error
	DeleteProjectFile(ctx context.Context, ownerUserID uint, projectID uint, publicID string) (*domainconversation.ProjectFile, error)
	PurgeProjectFileByPath(ctx context.Context, ownerUserID uint, projectID uint, relativePath string) error
	GetProjectFile(ctx context.Context, ownerUserID uint, projectID uint, publicID string) (*domainconversation.ProjectFile, error)
}
