package conversation

import (
	"context"
	"time"

	domainconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	models "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
)

func (r *Repo) GetOrCreateProjectWorkspace(ctx context.Context, ownerUserID uint, conversationProjectID uint, publicID string) (*domainconversation.ProjectWorkspace, error) {
	var result models.ProjectWorkspace
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var project models.ConversationProject
		if err := tx.Where("id = ? AND user_id = ?", conversationProjectID, ownerUserID).First(&project).Error; err != nil {
			return err
		}
		// 先按 owner+project 精确查询已有工作区；
		// 不能用 FirstOrCreate 携带 struct 参数——非零的 PublicID 会进入查询条件，
		// 导致已存在的工作区查不到而重复插入，触发唯一索引冲突。
		err := tx.Where("owner_user_id = ? AND conversation_project_id = ?", ownerUserID, conversationProjectID).
			First(&result).Error
		if err == nil {
			return nil
		}
		if !dberror.IsRecordNotFound(err) {
			return err
		}
		workspace := models.ProjectWorkspace{
			PublicID: publicID, OwnerUserID: ownerUserID, ConversationProjectID: conversationProjectID,
			Status: domainconversation.ProjectWorkspaceStatusActive,
		}
		if err := tx.Create(&workspace).Error; err != nil {
			// 并发创建竞争唯一索引时回读已存在记录。
			if dberror.IsUniqueConstraint(err) {
				return tx.Where("owner_user_id = ? AND conversation_project_id = ?", ownerUserID, conversationProjectID).
					First(&result).Error
			}
			return err
		}
		result = workspace
		return nil
	})
	if err != nil {
		return nil, dberror.Translate(err)
	}
	value := toProjectWorkspaceDomain(result)
	return &value, nil
}

func (r *Repo) GetProjectWorkspaceByProject(ctx context.Context, ownerUserID uint, conversationProjectID uint) (*domainconversation.ProjectWorkspace, error) {
	var item models.ProjectWorkspace
	if err := r.db.WithContext(ctx).
		Where("owner_user_id = ? AND conversation_project_id = ?", ownerUserID, conversationProjectID).
		First(&item).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	result := toProjectWorkspaceDomain(item)
	return &result, nil
}

func (r *Repo) CreateProjectImport(ctx context.Context, item *domainconversation.ProjectImport) error {
	entity := toProjectImportModel(item)
	if err := r.db.WithContext(ctx).Create(&entity).Error; err != nil {
		return dberror.Translate(err)
	}
	*item = toProjectImportDomain(entity)
	return nil
}

func (r *Repo) CompleteProjectImport(ctx context.Context, ownerUserID uint, projectID uint, importID uint, files []domainconversation.ProjectFile, fileCount int, totalBytes int64) error {
	return dberror.Translate(r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var job models.ProjectImport
		if err := tx.Where("id = ? AND owner_user_id = ? AND project_id = ?", importID, ownerUserID, projectID).First(&job).Error; err != nil {
			return err
		}
		for i := range files {
			entity := toProjectFileModel(&files[i])
			if err := tx.Create(&entity).Error; err != nil {
				return err
			}
			files[i] = toProjectFileDomain(entity)
		}
		now := time.Now()
		if err := tx.Model(&job).Updates(map[string]interface{}{
			"status": "completed", "file_count": fileCount, "total_bytes": totalBytes,
			"error_code": "", "error_message": "", "completed_at": now,
		}).Error; err != nil {
			return err
		}
		return tx.Model(&models.ProjectWorkspace{}).
			Where("id = ? AND owner_user_id = ?", job.ProjectID, ownerUserID).
			Updates(map[string]interface{}{
				"file_count":    gorm.Expr("file_count + ?", fileCount),
				"storage_bytes": gorm.Expr("storage_bytes + ?", totalBytes),
			}).Error
	}))
}

func (r *Repo) FailProjectImport(ctx context.Context, ownerUserID uint, projectID uint, importID uint, code string, message string) error {
	now := time.Now()
	result := r.db.WithContext(ctx).Model(&models.ProjectImport{}).
		Where("id = ? AND owner_user_id = ? AND project_id = ?", importID, ownerUserID, projectID).
		Updates(map[string]interface{}{"status": "failed", "error_code": code, "error_message": message, "completed_at": now})
	if result.Error != nil {
		return dberror.Translate(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

func (r *Repo) GetProjectImport(ctx context.Context, ownerUserID uint, projectID uint, publicID string) (*domainconversation.ProjectImport, error) {
	var item models.ProjectImport
	if err := r.db.WithContext(ctx).
		Where("owner_user_id = ? AND project_id = ? AND public_id = ?", ownerUserID, projectID, publicID).
		First(&item).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	result := toProjectImportDomain(item)
	return &result, nil
}

func (r *Repo) ListProjectFiles(ctx context.Context, ownerUserID uint, projectID uint) ([]domainconversation.ProjectFile, error) {
	items := make([]models.ProjectFile, 0)
	if err := r.db.WithContext(ctx).
		Where("owner_user_id = ? AND project_id = ?", ownerUserID, projectID).
		Order("relative_path ASC").Find(&items).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	result := make([]domainconversation.ProjectFile, 0, len(items))
	for _, item := range items {
		result = append(result, toProjectFileDomain(item))
	}
	return result, nil
}

func (r *Repo) CreateProjectFile(ctx context.Context, item *domainconversation.ProjectFile) error {
	entity := toProjectFileModel(item)
	if err := r.db.WithContext(ctx).Create(&entity).Error; err != nil {
		return dberror.Translate(err)
	}
	*item = toProjectFileDomain(entity)
	return nil
}

func (r *Repo) UpdateProjectWorkspaceUsage(ctx context.Context, ownerUserID uint, workspaceID uint, storageDelta int64, fileDelta int) error {
	result := r.db.WithContext(ctx).Model(&models.ProjectWorkspace{}).
		Where("id = ? AND owner_user_id = ?", workspaceID, ownerUserID).
		Updates(map[string]interface{}{
			"storage_bytes": gorm.Expr("storage_bytes + ?", storageDelta),
			"file_count":    gorm.Expr("file_count + ?", fileDelta),
		})
	if result.Error != nil {
		return dberror.Translate(result.Error)
	}
	if result.RowsAffected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

func (r *Repo) UpdateProjectFile(ctx context.Context, ownerUserID uint, projectID uint, publicID string, storageKey string, mimeType string, sizeBytes int64, sha256 string, version int) (*domainconversation.ProjectFile, error) {
	var item models.ProjectFile
	result := r.db.WithContext(ctx).Where("owner_user_id = ? AND project_id = ? AND public_id = ?", ownerUserID, projectID, publicID).First(&item)
	if result.Error != nil {
		return nil, dberror.Translate(result.Error)
	}
	if err := r.db.WithContext(ctx).Model(&item).Updates(map[string]interface{}{"storage_key": storageKey, "mime_type": mimeType, "size_bytes": sizeBytes, "sha256": sha256, "version": version}).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	item.StorageKey, item.MimeType, item.SizeBytes, item.SHA256, item.Version = storageKey, mimeType, sizeBytes, sha256, version
	value := toProjectFileDomain(item)
	return &value, nil
}

func (r *Repo) DeleteProjectFile(ctx context.Context, ownerUserID uint, projectID uint, publicID string) (*domainconversation.ProjectFile, error) {
	var item models.ProjectFile
	if err := r.db.WithContext(ctx).Where("owner_user_id = ? AND project_id = ? AND public_id = ?", ownerUserID, projectID, publicID).First(&item).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	// 硬删除：软删除行会继续占据 (project_id, relative_path) 唯一索引，
	// 导致同路径文件重新创建时触发唯一约束冲突。
	if err := r.db.WithContext(ctx).Unscoped().Delete(&item).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	value := toProjectFileDomain(item)
	return &value, nil
}
func (r *Repo) GetProjectFile(ctx context.Context, ownerUserID uint, projectID uint, publicID string) (*domainconversation.ProjectFile, error) {
	var item models.ProjectFile
	if err := r.db.WithContext(ctx).
		Where("owner_user_id = ? AND project_id = ? AND public_id = ?", ownerUserID, projectID, publicID).
		First(&item).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	result := toProjectFileDomain(item)
	return &result, nil
}

// PurgeProjectFileByPath 硬删除指定路径的全部文件行（含历史软删除残留），
// 为同路径重新创建腾出 (project_id, relative_path) 唯一索引。
func (r *Repo) PurgeProjectFileByPath(ctx context.Context, ownerUserID uint, projectID uint, relativePath string) error {
	return dberror.Translate(r.db.WithContext(ctx).Unscoped().
		Where("owner_user_id = ? AND project_id = ? AND relative_path = ?", ownerUserID, projectID, relativePath).
		Delete(&models.ProjectFile{}).Error)
}

func toProjectWorkspaceDomain(item models.ProjectWorkspace) domainconversation.ProjectWorkspace {
	return domainconversation.ProjectWorkspace{ID: item.ID, PublicID: item.PublicID, OwnerUserID: item.OwnerUserID,
		ConversationProjectID: item.ConversationProjectID, Status: item.Status, StorageBytes: item.StorageBytes,
		FileCount: item.FileCount, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func toProjectFileDomain(item models.ProjectFile) domainconversation.ProjectFile {
	return domainconversation.ProjectFile{ID: item.ID, PublicID: item.PublicID, OwnerUserID: item.OwnerUserID,
		ProjectID: item.ProjectID, ParentID: item.ParentID, RelativePath: item.RelativePath, FileName: item.FileName,
		EntryType: item.EntryType, StorageKey: item.StorageKey, MimeType: item.MimeType, SizeBytes: item.SizeBytes,
		SHA256: item.SHA256, SourceImportID: item.SourceImportID, Version: item.Version,
		CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func toProjectFileModel(item *domainconversation.ProjectFile) models.ProjectFile {
	return models.ProjectFile{BaseModel: models.BaseModel{ID: item.ID}, PublicID: item.PublicID,
		OwnerUserID: item.OwnerUserID, ProjectID: item.ProjectID, ParentID: item.ParentID, RelativePath: item.RelativePath,
		FileName: item.FileName, EntryType: item.EntryType, StorageKey: item.StorageKey, MimeType: item.MimeType,
		SizeBytes: item.SizeBytes, SHA256: item.SHA256, SourceImportID: item.SourceImportID, Version: item.Version}
}

func toProjectImportDomain(item models.ProjectImport) domainconversation.ProjectImport {
	return domainconversation.ProjectImport{ID: item.ID, PublicID: item.PublicID, OwnerUserID: item.OwnerUserID,
		ProjectID: item.ProjectID, Status: item.Status, ArchiveName: item.ArchiveName, FileCount: item.FileCount,
		TotalBytes: item.TotalBytes, ErrorCode: item.ErrorCode, ErrorMessage: item.ErrorMessage,
		CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt, CompletedAt: item.CompletedAt}
}

func toProjectImportModel(item *domainconversation.ProjectImport) models.ProjectImport {
	return models.ProjectImport{BaseModel: models.BaseModel{ID: item.ID}, PublicID: item.PublicID,
		OwnerUserID: item.OwnerUserID, ProjectID: item.ProjectID, Status: item.Status, ArchiveName: item.ArchiveName,
		FileCount: item.FileCount, TotalBytes: item.TotalBytes, ErrorCode: item.ErrorCode,
		ErrorMessage: item.ErrorMessage, CompletedAt: item.CompletedAt}
}
