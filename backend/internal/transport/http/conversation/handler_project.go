package conversation

import (
	"errors"
	"net/http"
	"strings"

	appconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/filecontent"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

// GetProjectWorkspace godoc
func (h *Handler) GetProjectWorkspace(c *gin.Context) {
	view, err := h.service.GetProjectWorkspace(c.Request.Context(), middleware.MustUserID(c), c.Param("id"))
	if err != nil {
		response.Error(c, http.StatusNotFound, "project workspace not found")
		return
	}
	response.Success(c, view)
}

// ListProjectFiles 列出项目工作区文件。
func (h *Handler) ListProjectFiles(c *gin.Context) {
	items, err := h.service.ListProjectFiles(c.Request.Context(), middleware.MustUserID(c), c.Param("id"))
	if err != nil {
		response.Error(c, http.StatusNotFound, "project files not found")
		return
	}
	response.Success(c, gin.H{"items": items, "total": len(items)})
}

// ImportProjectZIP 导入项目 ZIP。
func (h *Handler) ImportProjectZIP(c *gin.Context) {
	userID := middleware.MustUserID(c)
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 101<<20)
	file, err := c.FormFile("file")
	if err != nil {
		response.Error(c, http.StatusBadRequest, "ZIP file is required")
		return
	}
	reader, err := file.Open()
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid ZIP file")
		return
	}
	defer reader.Close()
	item, err := h.service.ImportProjectArchive(c.Request.Context(), appconversation.ProjectArchiveInput{UserID: userID, ProjectPublicID: c.Param("id"), ArchiveName: file.Filename, Reader: reader})
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid project archive")
		return
	}
	response.Success(c, item)
}

// GetProjectFileContent 下载项目文件。
func (h *Handler) GetProjectFileContent(c *gin.Context) {
	result, err := h.service.OpenProjectFileContent(c.Request.Context(), middleware.MustUserID(c), c.Param("id"), c.Param("file_id"))
	if err != nil {
		response.Error(c, http.StatusNotFound, "project file not found")
		return
	}
	_ = filecontent.Write(c, result, false)
}

// WriteProjectFile 创建或覆盖项目文本文件。
func (h *Handler) WriteProjectFile(c *gin.Context) {
	var req WriteProjectFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.WriteProjectFile(c.Request.Context(), middleware.MustUserID(c), c.Param("id"), req.Path, []byte(req.Content))
	if err != nil {
		switch {
		case errors.Is(err, appconversation.ErrInvalidFileReference), errors.Is(err, appconversation.ErrFileTooLarge):
			response.Error(c, http.StatusBadRequest, "invalid project file")
		case errors.Is(err, appconversation.ErrConversationProjectNotFound):
			response.Error(c, http.StatusNotFound, "conversation project not found")
		default:
			response.Error(c, http.StatusInternalServerError, "write project file failed")
		}
		return
	}
	response.Success(c, item)
}

// DeleteProjectFile 删除项目文件。
func (h *Handler) DeleteProjectFile(c *gin.Context) {
	deleted, err := h.service.DeleteProjectFile(c.Request.Context(), middleware.MustUserID(c), c.Param("id"), c.Param("file_id"))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) || errors.Is(err, appconversation.ErrConversationProjectNotFound) {
			response.Error(c, http.StatusNotFound, "project file not found")
			return
		}
		response.Error(c, http.StatusInternalServerError, "delete project file failed")
		return
	}
	response.Success(c, gin.H{"deleted": true, "file": deleted})
}

// DownloadProjectArchive 流式下载当前用户项目 ZIP。
func (h *Handler) DownloadProjectArchive(c *gin.Context) {
	userID := middleware.MustUserID(c)
	projectID := strings.TrimSpace(c.Param("id"))
	if projectID == "" {
		response.Error(c, http.StatusBadRequest, "invalid project id")
		return
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", `attachment; filename="project-`+projectID+`.zip"`)
	if err := h.service.ArchiveProjectFiles(c.Request.Context(), userID, projectID, c.Writer); err != nil && errors.Is(err, appconversation.ErrConversationProjectNotFound) {
		response.Error(c, http.StatusNotFound, "conversation project not found")
	}
}

// @Summary 会话项目列表
// @Description 查询当前用户的会话项目分组
// @Tags chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param status query string false "状态筛选: active|archived|all"
// @Success 200 {object} ConversationProjectListResponseDoc
// @Failure 500 {object} ErrorDoc
// @Router /conversation-projects [get]
func (h *Handler) ListConversationProjects(c *gin.Context) {
	userID := middleware.MustUserID(c)
	items, err := h.service.ListConversationProjects(c.Request.Context(), userID, c.Query("status"))
	if err != nil {
		response.Error(c, http.StatusInternalServerError, "list conversation projects failed")
		return
	}
	results := make([]ConversationProjectResponse, 0, len(items))
	for i := range items {
		results = append(results, toConversationProjectResponse(&items[i]))
	}
	response.Success(c, results)
}

// CreateConversationProject godoc
// @Summary 创建会话项目
// @Description 创建当前用户的会话项目分组
// @Tags chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body CreateConversationProjectRequest true "项目参数"
// @Success 200 {object} ConversationProjectResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /conversation-projects [post]
func (h *Handler) CreateConversationProject(c *gin.Context) {
	userID := middleware.MustUserID(c)
	var req CreateConversationProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.CreateConversationProject(c.Request.Context(), userID, appconversation.ConversationProjectInput{
		Name:                    req.Name,
		Description:             req.Description,
		SystemPrompt:            req.SystemPrompt,
		MCPDefaultMode:          req.MCPDefaultMode,
		DefaultMCPToolIDs:       req.DefaultMCPToolIDs,
		DefaultSkillIDs:         req.DefaultSkillIDs,
		DefaultKnowledgeBaseIDs: req.DefaultKnowledgeBaseIDs,
		Color:                   req.Color,
		Icon:                    req.Icon,
	})
	if err != nil {
		if errors.Is(err, appconversation.ErrInvalidConversationProject) {
			response.Error(c, http.StatusBadRequest, "invalid conversation project")
			return
		}
		response.Error(c, http.StatusInternalServerError, "create conversation project failed")
		return
	}
	h.recordAudit(c, "create_conversation_project", "conversation_project", item.PublicID, map[string]interface{}{
		"name":                         item.Name,
		"mcp_default_mode":             item.MCPDefaultMode,
		"default_mcp_tool_count":       len(item.DefaultMCPToolIDs),
		"default_skill_count":          len(item.DefaultSkillIDs),
		"default_knowledge_base_count": len(item.DefaultKnowledgeBaseIDs),
	})
	response.Success(c, toConversationProjectResponse(item))
}

// UpdateConversationProject godoc
// @Summary 更新会话项目
// @Description 更新当前用户的会话项目分组
// @Tags chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "项目 public_id"
// @Param body body UpdateConversationProjectRequest true "项目参数"
// @Success 200 {object} ConversationProjectResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /conversation-projects/{id} [patch]
func (h *Handler) UpdateConversationProject(c *gin.Context) {
	userID := middleware.MustUserID(c)
	publicID, err := stringParam(c, "id")
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid conversation project id")
		return
	}
	var req UpdateConversationProjectRequest
	if err = c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.UpdateConversationProject(c.Request.Context(), userID, publicID, appconversation.ConversationProjectPatchInput{
		Name:                    req.Name,
		Description:             req.Description,
		SystemPrompt:            req.SystemPrompt,
		MCPDefaultMode:          req.MCPDefaultMode,
		DefaultMCPToolIDs:       req.DefaultMCPToolIDs,
		DefaultSkillIDs:         req.DefaultSkillIDs,
		DefaultKnowledgeBaseIDs: req.DefaultKnowledgeBaseIDs,
		Color:                   req.Color,
		Icon:                    req.Icon,
		Status:                  req.Status,
	})
	if err != nil {
		switch {
		case errors.Is(err, appconversation.ErrInvalidConversationProject):
			response.Error(c, http.StatusBadRequest, "invalid conversation project")
			return
		case errors.Is(err, appconversation.ErrConversationProjectNotFound):
			response.Error(c, http.StatusNotFound, "conversation project not found")
			return
		default:
			response.Error(c, http.StatusInternalServerError, "update conversation project failed")
			return
		}
	}
	h.recordAudit(c, "update_conversation_project", "conversation_project", item.PublicID, map[string]interface{}{
		"name":                         item.Name,
		"mcp_default_mode":             item.MCPDefaultMode,
		"default_mcp_tool_count":       len(item.DefaultMCPToolIDs),
		"default_skill_count":          len(item.DefaultSkillIDs),
		"default_knowledge_base_count": len(item.DefaultKnowledgeBaseIDs),
	})
	response.Success(c, toConversationProjectResponse(item))
}

// DeleteConversationProject godoc
// @Summary 删除会话项目
// @Description 删除当前用户项目分组。默认仅解除其下会话归属；delete_conversations=true 时同时软删除项目内会话；delete_files=true 时同步删除不再被其他会话引用的文件。
// @Tags chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "项目 public_id"
// @Param delete_conversations query bool false "是否同时删除项目内会话"
// @Param delete_files query bool false "是否同步删除不再被其他会话引用的会话文件"
// @Success 200 {object} ConversationDeleteResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /conversation-projects/{id} [delete]
func (h *Handler) DeleteConversationProject(c *gin.Context) {
	userID := middleware.MustUserID(c)
	publicID, err := stringParam(c, "id")
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid conversation project id")
		return
	}
	deleteConversations := c.Query("delete_conversations") == "true"
	deleteFiles := c.Query("delete_files") == "true"
	result, err := h.service.DeleteConversationProject(
		c.Request.Context(),
		userID,
		publicID,
		deleteConversations,
		appconversation.DeleteConversationOptions{DeleteFiles: deleteFiles},
	)
	if err != nil {
		if errors.Is(err, appconversation.ErrConversationProjectNotFound) {
			response.Error(c, http.StatusNotFound, "conversation project not found")
			return
		}
		response.Error(c, http.StatusInternalServerError, "delete conversation project failed")
		return
	}
	h.recordAudit(c, "delete_conversation_project", "conversation_project", publicID, map[string]interface{}{
		"deleted":              true,
		"delete_conversations": deleteConversations,
		"delete_files":         deleteFiles,
		"deleted_file_count":   result.DeletedFileCount,
	})
	response.Success(c, toConversationDeleteResponse(result))
}

// ReorderConversationProjects godoc
// @Summary 调整会话项目顺序
// @Description 更新当前用户项目分组展示顺序
// @Tags chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body ReorderConversationProjectsRequest true "排序参数"
// @Success 200 {object} ConversationProjectListResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /conversation-projects/reorder [post]
func (h *Handler) ReorderConversationProjects(c *gin.Context) {
	userID := middleware.MustUserID(c)
	var req ReorderConversationProjectsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	if err := h.service.ReorderConversationProjects(c.Request.Context(), userID, req.ProjectIDs); err != nil {
		switch {
		case errors.Is(err, appconversation.ErrInvalidConversationProject):
			response.Error(c, http.StatusBadRequest, "invalid conversation project")
			return
		case errors.Is(err, appconversation.ErrConversationProjectNotFound):
			response.Error(c, http.StatusNotFound, "conversation project not found")
			return
		default:
			response.Error(c, http.StatusInternalServerError, "reorder conversation projects failed")
			return
		}
	}
	items, err := h.service.ListConversationProjects(c.Request.Context(), userID, "active")
	if err != nil {
		response.Error(c, http.StatusInternalServerError, "list conversation projects failed")
		return
	}
	results := make([]ConversationProjectResponse, 0, len(items))
	for i := range items {
		results = append(results, toConversationProjectResponse(&items[i]))
	}
	h.recordAudit(c, "reorder_conversation_projects", "conversation_project", "", map[string]int{"count": len(req.ProjectIDs)})
	response.Success(c, results)
}

// SetConversationProject godoc
// @Summary 设置会话项目归属
// @Description 设置当前用户单个会话的项目归属
// @Tags chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "会话 public_id"
// @Param body body SetConversationProjectRequest true "项目归属参数"
// @Success 200 {object} ConversationUpdateResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /conversations/{id}/project [patch]
func (h *Handler) SetConversationProject(c *gin.Context) {
	userID := middleware.MustUserID(c)
	publicID, err := stringParam(c, "id")
	if err != nil {
		response.Error(c, http.StatusBadRequest, "invalid conversation id")
		return
	}
	var req SetConversationProjectRequest
	if err = c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.SetConversationProject(c.Request.Context(), userID, publicID, req.ProjectID)
	if err != nil {
		switch {
		case errors.Is(err, appconversation.ErrConversationProjectNotFound):
			response.Error(c, http.StatusNotFound, "conversation project not found")
			return
		case errors.Is(err, appconversation.ErrConversationNotFound):
			response.Error(c, http.StatusNotFound, "conversation not found")
			return
		default:
			response.Error(c, http.StatusInternalServerError, "set conversation project failed")
			return
		}
	}
	h.recordAudit(c, "set_conversation_project", "conversation", item.PublicID, map[string]string{"projectID": item.ProjectPublicID})
	response.Success(c, toConversationResponse(item))
}

// BatchSetConversationProject godoc
// @Summary 批量设置会话项目归属
// @Description 批量设置当前用户会话的项目归属
// @Tags chat
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body BatchSetConversationProjectRequest true "项目归属参数"
// @Success 200 {object} BatchSetConversationProjectResponseDoc
// @Failure 400 {object} ErrorDoc
// @Failure 404 {object} ErrorDoc
// @Failure 500 {object} ErrorDoc
// @Router /conversations/project [post]
func (h *Handler) BatchSetConversationProject(c *gin.Context) {
	userID := middleware.MustUserID(c)
	var req BatchSetConversationProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	updated, err := h.service.BatchSetConversationProject(c.Request.Context(), userID, req.ConversationPublicIDs, req.ProjectID)
	if err != nil {
		switch {
		case errors.Is(err, appconversation.ErrInvalidConversationProject):
			response.Error(c, http.StatusBadRequest, "invalid conversation project")
			return
		case errors.Is(err, appconversation.ErrConversationProjectNotFound):
			response.Error(c, http.StatusNotFound, "conversation project not found")
			return
		case errors.Is(err, appconversation.ErrConversationNotFound):
			response.Error(c, http.StatusNotFound, "conversation not found")
			return
		default:
			response.Error(c, http.StatusInternalServerError, "batch set conversation project failed")
			return
		}
	}
	h.recordAudit(c, "batch_set_conversation_project", "conversation", "", map[string]int64{"updated": updated})
	response.Success(c, BatchSetConversationProjectResponse{Updated: updated})
}
