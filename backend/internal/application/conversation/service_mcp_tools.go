package conversation

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	domainmcp "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/mcp"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/secretbox"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/mcp"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/security"
)

type selectedToolRuntime struct {
	definitions         []llm.ToolDefinition
	nameMap             map[string]string
	mcpBindings         map[string]mcpToolCallBinding
	schemas             map[string]json.RawMessage
	attachmentProcessor *selectedAttachmentProcessor
}

// mcpToolCallBinding 绑定模型侧工具名对应的 MCP 调用配置与计量元数据。
// 服务器归属与价格在解析选中工具时快照，保证同名工具跨服务器可区分、计费按调用时价格结算。
type mcpToolCallBinding struct {
	Config       mcp.CallConfig
	ServerID     uint
	ServerName   string
	ToolName     string
	PriceNanousd int64
}

type selectedAttachmentProcessor struct {
	toolID         uint
	modelName      string
	toolName       string
	displayName    string
	argument       string
	encoding       string
	promptArgument string
}

func addProjectToolDefinitions(runtime *selectedToolRuntime) {
	if runtime == nil || runtime.nameMap == nil || runtime.schemas == nil {
		return
	}
	definitions := []llm.ToolDefinition{
		{Name: "project_list_files", Description: "列出当前项目文件。需要了解项目文件树、确认文件是否存在或获取文件标识时必须调用，不得凭上下文猜测。", InputSchema: json.RawMessage(`{"type":"object","properties":{"prefix":{"type":"string","description":"可选的项目内相对路径前缀"}}}`)},
		{Name: "project_read_file", Description: "读取当前项目文件内容。回答、分析或修改现有项目文件前必须调用；聊天上下文、记忆或代码块不能替代实际读取。", InputSchema: json.RawMessage(`{"type":"object","properties":{"file":{"type":"string","description":"文件 public_id 或项目内相对路径"}},"required":["file"]}`)},
		{Name: "project_search_files", Description: "搜索当前项目文件的实际内容。需要定位实现、符号或文本时必须调用，不得用记忆或推测替代搜索。", InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","description":"要搜索的非空文本"}},"required":["query"]}`)},
		{Name: "project_write_file", Description: "创建或完整覆盖当前项目文件。用户要求创建、生成、保存或覆盖项目文件时必须调用；仅在回复中给出代码块、补丁或声称已完成不等于文件写入。路径已存在时会覆盖并递增版本。", InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"项目内相对路径，不得为绝对路径或包含上级目录穿越"},"content":{"type":"string","description":"要写入的完整文件内容"}},"required":["path","content"]}`)},
		{Name: "project_patch_file", Description: "像 IDE 一样对已有项目文件做片段编辑：提供文件中唯一且连续的原始片段 old 与替换文本 new，或多处修改时用 patches 数组一次提交多个片段（全部成功才写入，任一 old 未命中则整体失败并提示片段序号）。用户要求编辑、修复或更新已有文件时优先使用本工具，不要用 project_write_file 重写整个文件。调用前必须实际读取目标文件，回复中的 diff 不能替代修改。", InputSchema: json.RawMessage(`{"type":"object","properties":{"file":{"type":"string","description":"文件 public_id 或项目内相对路径"},"old":{"type":"string","description":"单片段模式：文件中唯一且连续的原始文本"},"new":{"type":"string","description":"单片段模式：替换后的文本"},"patches":{"type":"array","description":"多片段模式：一次提交多处修改，全部命中才写入","items":{"type":"object","properties":{"old":{"type":"string","description":"文件中唯一且连续的原始文本"},"new":{"type":"string","description":"替换后的文本"}},"required":["old","new"]}}},"required":["file"]}`)},
		{Name: "project_delete_file", Description: "删除当前项目文件。用户要求删除项目文件时必须调用；口头确认、空内容覆盖或建议用户自行删除均不能替代此工具。", InputSchema: json.RawMessage(`{"type":"object","properties":{"file":{"type":"string","description":"文件 public_id 或项目内相对路径"}},"required":["file"]}`)},
		{Name: "project_create_archive", Description: "创建当前项目 ZIP 归档。归档通过界面的下载按钮交付给用户，调用成功后只需说明归档已生成；严禁输出任何下载 URL、链接或路径，直接链接因需要鉴权而无法访问。", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)},
	}
	for _, definition := range definitions {
		runtime.definitions = append(runtime.definitions, definition)
		runtime.nameMap[definition.Name] = definition.Name
		runtime.schemas[definition.Name] = definition.InputSchema
	}
}

func (r selectedToolRuntime) withoutProjectTools() selectedToolRuntime {
	projectNames := map[string]struct{}{
		"project_list_files": {}, "project_read_file": {}, "project_search_files": {},
		"project_write_file": {}, "project_patch_file": {}, "project_delete_file": {}, "project_create_archive": {},
	}
	definitions := make([]llm.ToolDefinition, 0, len(r.definitions))
	for _, definition := range r.definitions {
		if _, ok := projectNames[definition.Name]; !ok {
			definitions = append(definitions, definition)
		}
	}
	r.definitions = definitions
	for name := range projectNames {
		delete(r.nameMap, name)
		delete(r.mcpBindings, name)
		delete(r.schemas, name)
	}
	return r
}
func injectMCPToolGuidance(messages []llm.Message, runtime selectedToolRuntime, customPrompt string) []llm.Message {
	if len(runtime.definitions) == 0 {
		return messages
	}

	content := defaultMCPToolGuidancePrompt(runtime)
	if custom := strings.TrimSpace(customPrompt); custom != "" {
		content += "\n\n# custom_tool_use\n" + custom
	}

	insertAt := 0
	for insertAt < len(messages) && messages[insertAt].Role == "system" {
		insertAt++
	}
	next := make([]llm.Message, 0, len(messages)+1)
	next = append(next, messages[:insertAt]...)
	next = append(next, llm.Message{Role: "system", Content: content})
	next = append(next, messages[insertAt:]...)
	return next
}

func defaultMCPToolGuidancePrompt(runtime selectedToolRuntime) string {
	var builder strings.Builder
	builder.WriteString("# tool_use\n")
	builder.WriteString("- Tools are declared separately via the API schema; follow that schema exactly.\n")
	builder.WriteString("- Use tools only for external, realtime, private, or explicitly requested data.\n")
	builder.WriteString("- Use the fewest useful calls; each call must add new information.\n")
	builder.WriteString("- Do not repeat an identical failed call. Adjust arguments, use another tool, or answer from available evidence.\n")
	builder.WriteString("- If tools fail or lack enough data, state the gap in the final answer.\n")
	builder.WriteString("- Do not expose raw tool JSON, internal fields, or tool logs unless the user asks.\n")
	if hasProjectToolDefinitions(runtime) {
		builder.WriteString("- Project file operations are real side effects: listing, reading, searching, creating, overwriting, patching, deleting, or archiving project files MUST use the corresponding project_* tool when available.\n")
		builder.WriteString("- Never substitute a code block, diff, explanation, memory, or claim of completion for a required project file tool call. Read an existing file before modifying it, and report success only after the tool succeeds.\n")
		builder.WriteString("- Prefer project_patch_file with focused old/new snippets (or the patches array for multiple edits) when modifying existing files; reserve project_write_file for creating files or explicit full rewrites.\n")
	}
	return strings.TrimSpace(builder.String())
}

func hasProjectToolDefinitions(runtime selectedToolRuntime) bool {
	for _, definition := range runtime.definitions {
		switch definition.Name {
		case "project_list_files", "project_read_file", "project_search_files", "project_write_file", "project_patch_file", "project_delete_file", "project_create_archive":
			return true
		}
	}
	return false
}

func summarizeToolInputSchema(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var schema map[string]interface{}
	if err := json.Unmarshal(raw, &schema); err != nil {
		return ""
	}
	properties, _ := schema["properties"].(map[string]interface{})
	if len(properties) == 0 {
		return "无需参数"
	}
	required := map[string]struct{}{}
	if items, ok := schema["required"].([]interface{}); ok {
		for _, item := range items {
			if name, ok := item.(string); ok && strings.TrimSpace(name) != "" {
				required[strings.TrimSpace(name)] = struct{}{}
			}
		}
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		if strings.TrimSpace(name) != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		prop, _ := properties[name].(map[string]interface{})
		fieldType := schemaFieldType(prop)
		label := name
		if fieldType != "" {
			label = fmt.Sprintf("%s:%s", name, fieldType)
		}
		if _, ok := required[name]; ok {
			label += " 必填"
		}
		parts = append(parts, label)
	}
	if len(parts) > 6 {
		parts = append(parts[:6], fmt.Sprintf("等 %d 个字段", len(parts)))
	}
	return "参数 " + strings.Join(parts, "，")
}

func schemaFieldType(prop map[string]interface{}) string {
	if len(prop) == 0 {
		return ""
	}
	if value, ok := prop["type"].(string); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	if items, ok := prop["type"].([]interface{}); ok && len(items) > 0 {
		types := make([]string, 0, len(items))
		for _, item := range items {
			if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
				types = append(types, strings.TrimSpace(value))
			}
		}
		if len(types) > 0 {
			return strings.Join(types, "|")
		}
	}
	if _, ok := prop["enum"].([]interface{}); ok {
		return "enum"
	}
	return ""
}

func (s *Service) resolveSelectedToolRuntime(ctx context.Context, toolIDs []uint) (selectedToolRuntime, error) {
	result := selectedToolRuntime{
		definitions: make([]llm.ToolDefinition, 0),
		nameMap:     map[string]string{},
		mcpBindings: map[string]mcpToolCallBinding{},
		schemas:     map[string]json.RawMessage{},
	}
	addProjectToolDefinitions(&result)
	if len(toolIDs) == 0 || !s.cfg.Snapshot().MCPEnable {
		return result, nil
	}
	if s.mcpRepo == nil {
		return selectedToolRuntime{}, fmt.Errorf("resolve selected MCP tools: repository unavailable")
	}
	tools, err := s.mcpRepo.ListToolsByIDs(ctx, uniqueToolIDs(toolIDs))
	if err != nil {
		return selectedToolRuntime{}, fmt.Errorf("resolve selected MCP tools: %w", err)
	}
	if len(tools) == 0 {
		return selectedToolRuntime{}, nil
	}

	cfg := s.cfg.Snapshot()
	result.definitions = make([]llm.ToolDefinition, 0, len(tools)+7)
	addProjectToolDefinitions(&result)
	usedNames := map[string]int{
		"project_list_files": 1, "project_read_file": 1, "project_search_files": 1,
		"project_write_file": 1, "project_patch_file": 1, "project_delete_file": 1, "project_create_archive": 1,
	}
	serverCache := map[uint]*domainmcp.Server{}
	for _, tool := range tools {
		if tool.Status != "active" {
			continue
		}
		isAttachmentProcessor := strings.EqualFold(strings.TrimSpace(tool.AttachmentInputMode), domainmcp.AttachmentInputModeImage)
		server, ok := serverCache[tool.ServerID]
		if !ok {
			server, err = s.mcpRepo.GetServer(ctx, tool.ServerID)
			if err != nil {
				return selectedToolRuntime{}, fmt.Errorf("resolve MCP server %d: %w", tool.ServerID, err)
			}
			if server == nil || server.Status != "active" {
				if isAttachmentProcessor {
					return selectedToolRuntime{}, fmt.Errorf("%w: processor server is unavailable", ErrImageAttachmentProcessingFailed)
				}
				continue
			}
			if validateErr := security.ValidateTrustedOutboundHTTPURL(server.BaseURL); validateErr != nil {
				if isAttachmentProcessor {
					return selectedToolRuntime{}, fmt.Errorf("%w: processor server URL is not allowed", ErrImageAttachmentProcessingFailed)
				}
				continue
			}
			serverCache[tool.ServerID] = server
		}
		modelName := uniqueModelToolName(llm.NormalizeToolName(tool.Name), usedNames)
		if modelName == "" {
			continue
		}
		schema := json.RawMessage(strings.TrimSpace(tool.InputSchemaJSON))
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		token, err := secretbox.DecryptString(cfg.DataEncryptionKey, server.AuthTokenEnc)
		if err != nil {
			if isAttachmentProcessor {
				return selectedToolRuntime{}, fmt.Errorf("%w: processor credentials are unavailable", ErrImageAttachmentProcessingFailed)
			}
			continue
		}
		headers := parseMCPHeaders(server.HeadersJSON)
		result.definitions = append(result.definitions, llm.ToolDefinition{
			Name:        modelName,
			Description: strings.TrimSpace(tool.Description),
			InputSchema: schema,
		})
		result.nameMap[modelName] = tool.Name
		result.schemas[modelName] = schema
		result.mcpBindings[modelName] = mcpToolCallBinding{
			Config: mcp.CallConfig{
				BaseURL:   server.BaseURL,
				AuthToken: token,
				TimeoutMS: cfg.MCPToolTimeoutSeconds * 1000,
				Headers:   headers,
			},
			ServerID:     server.ID,
			ServerName:   server.Name,
			ToolName:     tool.Name,
			PriceNanousd: tool.PriceNanousd,
		}
		if isAttachmentProcessor {
			if bindErr := result.bindAttachmentProcessor(selectedAttachmentProcessor{
				toolID:         tool.ID,
				modelName:      modelName,
				toolName:       tool.Name,
				displayName:    firstNonEmptyString(tool.DisplayName, tool.Name),
				argument:       strings.TrimSpace(tool.AttachmentArgument),
				encoding:       strings.TrimSpace(tool.AttachmentEncoding),
				promptArgument: strings.TrimSpace(tool.AttachmentPromptArgument),
			}); bindErr != nil {
				return selectedToolRuntime{}, bindErr
			}
		}
	}
	return result, nil
}

func (r *selectedToolRuntime) bindAttachmentProcessor(processor selectedAttachmentProcessor) error {
	if r.attachmentProcessor != nil {
		return ErrMultipleImageAttachmentProcessors
	}
	r.attachmentProcessor = &processor
	return nil
}

func (r selectedToolRuntime) withoutAttachmentProcessor() selectedToolRuntime {
	processor := r.attachmentProcessor
	if processor == nil {
		return r
	}
	definitions := make([]llm.ToolDefinition, 0, len(r.definitions))
	for _, definition := range r.definitions {
		if definition.Name != processor.modelName {
			definitions = append(definitions, definition)
		}
	}
	r.definitions = definitions
	delete(r.nameMap, processor.modelName)
	delete(r.mcpBindings, processor.modelName)
	delete(r.schemas, processor.modelName)
	r.attachmentProcessor = nil
	return r
}

func (r selectedToolRuntime) withoutDefinitions() selectedToolRuntime {
	r.definitions = nil
	r.nameMap = nil
	r.mcpBindings = nil
	r.schemas = nil
	r.attachmentProcessor = nil
	return r
}

func uniqueToolIDs(items []uint) []uint {
	seen := make(map[uint]struct{}, len(items))
	result := make([]uint, 0, len(items))
	for _, item := range items {
		if item == 0 {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		result = append(result, item)
	}
	return result
}

func uniqueModelToolName(base string, used map[string]int) string {
	value := strings.TrimSpace(base)
	if value == "" {
		return ""
	}
	count := used[value]
	used[value] = count + 1
	if count == 0 {
		return value
	}
	suffix := "_" + strconv.Itoa(count+1)
	if len(value)+len(suffix) > 64 {
		value = value[:64-len(suffix)]
	}
	return value + suffix
}

func parseMCPHeaders(raw string) map[string]string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return map[string]string{}
	}
	payload := map[string]string{}
	if err := json.Unmarshal([]byte(value), &payload); err != nil {
		return map[string]string{}
	}
	result := make(map[string]string, len(payload))
	for key, item := range payload {
		headerKey := strings.TrimSpace(key)
		if headerKey == "" {
			continue
		}
		result[headerKey] = strings.TrimSpace(item)
	}
	return result
}
