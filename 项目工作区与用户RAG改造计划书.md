# 项目工作区与用户 RAG 改造计划书

## 一、文档目标

本计划用于将现有 Projects 从“会话分组”升级为适合软件开发场景的“项目工作区”，支持 ZIP 项目导入、安全解压、项目文件树、AI 受控读写、项目打包下载，并同步调整文件与检索配置模式。

改造后的系统必须同时满足以下目标：

1. 不同用户之间的项目、文件、向量、知识库、缓存、异步任务和生成附件严格隔离。
2. 同一用户的不同项目之间默认严格隔离，任何项目文件不能被其他项目的会话、AI 工具或 RAG 检索隐式访问。
3. 管理员不再为所有用户统一配置业务级向量模型和 RAG 策略，只负责功能准入、系统安全上限、平台内置知识库和基础设施健康状态。
4. 只有管理员开启“用户自有渠道”及“用户自有检索”后，用户才能使用自己的渠道配置向量模型，并自行控制 RAG 开关和检索参数。
5. 用户渠道密钥保持加密存储，不回显明文，不允许跨用户引用。
6. AI 生成的项目压缩包必须进入当前用户、当前项目的文件域，并以受保护的消息附件形式交付。

## 二、现状与主要缺口

当前 Projects 是会话项目分组，不拥有独立文件树。用户文件属于全局个人文件库，Project 与文件只有通过会话附件发生间接关系。

当前文件与检索配置主要由管理后台统一维护，包括 Embedding 服务地址、密钥、向量模型、向量维度、分片参数、全局 RAG 开关、Top K、相似度阈值和混合检索等。

现有用户自有渠道已经具备以下基础能力：

- 用户渠道按 `owner_user_id` 隔离。
- 用户私有模型按用户和渠道双重校验。
- API Key 使用系统数据加密密钥加密存储。
- 聊天请求可以通过 `modelScope=user` 和 `userModelID` 路由到当前用户的私有模型。
- 用户模型不会进入平台公共模型目录。

当前仍缺少：

- Project 与文件的直接归属关系。
- 同一用户不同 Project 间的强制文件隔离。
- ZIP 安全导入、解压和项目文件树。
- 项目级 AI 文件访问工具。
- 项目 ZIP 生成和助手附件桥接。
- 用户自有向量模型配置。
- 用户级与项目级 RAG 策略。
- 向量数据、检索缓存和异步任务中的项目隔离维度。

## 三、权限模型

### 3.1 核心安全原则

所有项目资源访问必须采用“服务端身份注入 + 多层所有权校验”，禁止信任客户端提交的用户 ID。

统一授权上下文：

```text
AuthenticatedUserID
ProjectPublicID
ResolvedProjectInternalID
ConversationID（可选）
RequestID
```

所有 Project API 的处理顺序必须为：

```text
JWT / Session 校验
→ 从服务端上下文取得当前 user_id
→ 使用 user_id + project_public_id 解析 Project
→ 使用 project_internal_id 操作子资源
→ Repository 再次附加 user_id + project_id 条件
```

任何一步授权失败，统一返回 Not Found 或 Forbidden，不得返回其他用户资源是否存在、文件名、大小、处理状态等侧信道信息。

### 3.2 用户隔离

以下资源必须直接或间接带有不可为空的 `owner_user_id`：

- Project Workspace
- Project File
- ZIP Import Job
- Archive Export Job
- Embedding Profile
- RAG Profile
- File Chunk
- Retrieval Cache
- AI Project Tool Run
- AI Generated Archive
- Message Attachment

数据库查询不得仅按资源 ID 查询用户资源。至少使用：

```text
owner_user_id = 当前用户
AND resource_id = 请求资源
AND deleted_at IS NULL
```

对象存储 Key 建议采用：

```text
users/{user_public_id}/projects/{project_public_id}/files/{file_id}/{safe_name}
users/{user_public_id}/projects/{project_public_id}/archives/{archive_id}/{safe_name}.zip
```

对象存储 Key 只能由服务端生成，客户端不得提交完整存储路径。

### 3.3 项目隔离

同一用户的不同 Project 也必须视为不同安全域。

所有项目文件查询、内容读取、重命名、删除、AI 读取、AI 修改、向量化、检索和归档必须同时满足：

```text
owner_user_id = 当前用户
AND project_id = 当前 Project
```

禁止仅凭 `file_id` 将用户全局文件直接加入 Project。需要复用个人文件时，必须显式执行“导入到项目”，并创建项目文件记录或项目文件引用记录。

建议初期采用“项目独占文件”模式：一个 Project File 只属于一个 Project。即使底层对象通过 SHA-256 去重，权限记录、生命周期、向量状态和删除操作也必须独立。

Project 会话只能访问所属 Project 的文件和知识库。无 Project 会话只能访问显式附加的个人文件，不得自动访问任何 Project Workspace。

### 3.4 管理员边界

管理员负责：

- 开启或关闭用户自有渠道。
- 开启或关闭用户自有 Embedding 与 RAG。
- 设置用户渠道数量、项目数量、项目存储、ZIP 大小、解压总大小、文件数量和并发任务上限。
- 设置允许的 Embedding 协议、向量维度范围、请求超时范围和允许访问的网络目标策略。
- 维护平台内置知识库和平台资料。
- 查看脱敏后的运行状态、错误码、用量和审计日志。

管理员不负责：

- 代用户填写用户渠道 API Key。
- 为某个用户选择其私有向量模型。
- 直接打开或关闭某个用户项目的 RAG。
- 默认浏览用户项目文件内容、向量内容或检索命中正文。

如业务确需管理员排障访问，必须设计单独的授权流程、原因填写、短期授权、全量审计和用户可见记录，不得复用普通后台接口直接读取。

## 四、数据模型改造

### 4.1 Project Workspace

建议新增 `project_workspaces`：

```text
id
public_id
owner_user_id
conversation_project_id
status
storage_bytes
file_count
created_at
updated_at
deleted_at
```

约束：

- `conversation_project_id` 唯一。
- `owner_user_id + public_id` 唯一。
- Workspace 的用户必须与 Conversation Project 的用户一致。

### 4.2 Project File

建议新增 `project_files`：

```text
id
public_id
owner_user_id
project_id
parent_id
relative_path
file_name
entry_type
storage_key
mime_type
size_bytes
sha256
source_archive_id
version
embed_status
embed_signature
rag_opt_out
created_at
updated_at
deleted_at
```

关键约束：

- `owner_user_id + project_id + relative_path + deleted_at` 保证活动路径唯一。
- `relative_path` 必须是规范化的 POSIX 相对路径。
- 不允许空路径、绝对路径、盘符、`..`、NUL 字符和超限路径。
- `parent_id` 如存在，父节点必须属于同一用户和同一 Project。
- 文件内容记录与目录记录通过 `entry_type` 区分。

### 4.3 用户 Embedding Profile

建议新增 `user_embedding_profiles`：

```text
id
public_id
owner_user_id
upstream_id
user_model_id
name
protocol
embedding_model_id
output_dimensions
normalize
batch_size
request_timeout_seconds
status
is_default
created_at
updated_at
deleted_at
```

约束：

- `upstream_id` 必须属于 `owner_user_id`，且渠道处于可用状态。
- `user_model_id` 如存在，必须属于同一用户和同一渠道。
- 模型能力必须声明为 Embedding，不允许把聊天模型静默当作向量模型。
- 用户不能提交 Base URL 和 Key 的副本，只能引用自己的已保存渠道。
- 一个用户最多一个活动默认 Profile。

### 4.4 用户与项目 RAG 配置

建议分为用户默认配置和项目覆盖配置。

`user_rag_settings`：

```text
owner_user_id
embedding_profile_id
rag_enabled
embed_on_upload
chunk_size_tokens
chunk_overlap_tokens
top_k
min_similarity
token_budget
fetch_multiplier
hybrid_enabled
updated_at
```

`project_rag_settings`：

```text
owner_user_id
project_id
inherit_user_defaults
embedding_profile_id
rag_enabled
embed_on_import
chunk_size_tokens
chunk_overlap_tokens
top_k
min_similarity
token_budget
fetch_multiplier
hybrid_enabled
updated_at
```

项目级配置必须属于同一用户。项目未配置时可继承用户默认值，但不得继承其他项目配置。

### 4.5 File Chunk 与向量空间

现有向量分片需要补齐或强化：

```text
owner_user_id
project_id
project_file_id
embedding_profile_id
embedding_signature
chunk_index
content
content_hash
embedding
created_at
```

Embedding Signature 应至少包含：

```text
用户 Embedding Profile ID
协议
渠道 ID
模型 ID
输出维度
归一化设置
分片版本
```

模型、维度或分片策略变化时，只将当前用户当前项目的旧向量标记为 stale，不允许触发平台全量或其他用户数据重建。

## 五、管理后台改造

### 5.1 保留内容

“文件与检索”后台保留为平台治理页，继续配置：

- 用户文件功能总开关。
- 用户自有渠道总开关。
- 用户自有 Embedding 总开关。
- 用户自有 RAG 总开关。
- 平台内置知识库的 Embedding 配置。
- 全局安全上限和配额。
- 允许的协议与网络策略。
- 向量数据库和任务队列健康状态。
- 脱敏统计、失败率和审计查询。

### 5.2 移出内容

以下业务配置从管理后台移到用户设置：

- 用户个人文件使用哪个向量模型。
- 用户项目使用哪个向量模型。
- 用户个人 RAG 总开关。
- 项目 RAG 开关。
- 用户或项目的 Top K、相似度、Token Budget、混合检索和自动向量化策略。

管理后台不再通过全局 `file:rag_model` 和 `chat:rag_enabled` 直接决定所有用户的私有文件检索行为。

### 5.3 新的管理员策略键

建议增加：

```text
chat:user_upstream_enabled
file:user_embedding_enabled
chat:user_rag_enabled
file:user_embedding_profile_limit
file:user_embedding_allowed_protocols
file:user_embedding_min_dimensions
file:user_embedding_max_dimensions
file:project_storage_limit_bytes
file:project_archive_max_bytes
file:project_extract_max_bytes
file:project_file_count_limit
file:project_path_depth_limit
file:project_import_concurrency
file:project_archive_concurrency
```

原全局 Embedding/RAG 设置只服务平台内置知识库或作为迁移期兼容配置，不再作为用户私有文件的最终配置来源。

## 六、用户设置改造

### 6.1 启用条件

只有以下条件同时满足时，用户界面才展示向量模型与 RAG 配置：

```text
管理员开启用户自有渠道
AND 管理员开启用户自有 Embedding
AND 用户至少有一个 active 自有渠道
```

RAG 开关可用条件：

```text
管理员开启用户自有 RAG
AND 用户已创建 active Embedding Profile
AND Profile 连通性测试通过
```

前端隐藏仅用于体验；所有条件必须在后端再次验证。

### 6.2 用户配置入口

在“我的渠道与模型”中增加“向量模型”能力：

1. 用户选择自己的渠道。
2. 从远端模型列表选择向量模型，或手工填写模型 ID。
3. 配置输出维度、归一化、批量大小和超时。
4. 执行测试向量化，校验响应维度和数值有效性。
5. 保存为用户默认 Embedding Profile。
6. 用户自行打开个人 RAG，并配置检索参数。
7. 用户可以在每个 Project 内继承默认配置或单独覆盖。

用户界面不得显示其他用户的渠道、模型、Profile、项目和运行状态。

### 6.3 密钥与网络安全

继续复用现有用户渠道 API Key 加密机制，Embedding Profile 只保存渠道引用，不重复保存密钥。

后端请求用户渠道前必须执行 SSRF 防护：

- 默认禁止环回地址、链路本地地址、云元数据地址和内网保留网段。
- 对 DNS 解析结果再次校验。
- 限制重定向次数，并校验每次重定向目标。
- 限制请求和响应大小。
- 记录脱敏后的目标主机、耗时和错误码，不记录 API Key 和完整向量正文。

如产品明确支持私有部署内网渠道，应由管理员通过目标白名单显式开放，不应由普通用户绕过。

## 七、ZIP 项目导入

### 7.1 API 建议

```text
POST /api/v1/conversation-projects/:project_id/imports
GET  /api/v1/conversation-projects/:project_id/imports/:import_id
GET  /api/v1/conversation-projects/:project_id/files
GET  /api/v1/conversation-projects/:project_id/files/:file_id/content
PATCH /api/v1/conversation-projects/:project_id/files/:file_id
DELETE /api/v1/conversation-projects/:project_id/files/:file_id
```

每个接口都必须先以当前用户解析 Project，再操作项目资源。

### 7.2 导入流程

```text
接收 ZIP
→ 校验用户和 Project
→ 校验配额与并发限制
→ 流式写入临时对象
→ 扫描 ZIP 中央目录
→ 校验条目和解压预算
→ 解压到隔离临时目录
→ MIME 与危险文件检测
→ 对象存储写入
→ 事务创建 Project File
→ 异步文本提取与向量化
→ 更新导入任务状态
```

禁止边解压边直接写入正式对象存储后再补授权记录。应先完成校验，再提交资源记录；失败时清理临时文件和已写对象。

### 7.3 ZIP 安全要求

必须防护：

- Zip Slip：拒绝绝对路径、盘符路径和规范化后包含 `..` 的路径。
- 压缩炸弹：限制压缩比、条目数、单文件解压大小和总解压大小。
- 符号链接与硬链接：默认拒绝。
- 嵌套压缩包：默认作为普通文件，不递归自动解压。
- 加密 ZIP：默认拒绝，并返回明确错误。
- 路径冲突：大小写不敏感环境下也必须检测重复路径。
- 深层目录和超长路径：按管理员上限拒绝。
- 危险文件：根据平台策略拒绝或隔离可执行文件、设备文件和特殊文件。
- `.env`、私钥、凭据文件：允许导入策略必须明确；默认不进入 AI 上下文和向量索引，并向用户告警。

## 八、AI 项目工具

### 8.1 工具范围

建议提供后端内置项目工具，而不是允许模型访问服务器真实文件系统：

```text
project_list_files
project_read_file
project_search_files
project_write_file
project_patch_file
project_delete_file
project_create_directory
project_create_archive
```

### 8.2 工具授权

工具定义中不得接受 `owner_user_id`。执行器从当前 Run 上下文注入：

```text
UserID
ProjectID
ConversationID
RunID
RequestID
```

执行前必须验证：

- Conversation 属于当前用户。
- Conversation 属于当前 Project。
- Project 属于当前用户。
- 目标文件属于当前用户和当前 Project。
- 工具在当前 Project 中已启用。

写操作应产生版本记录或变更审计，至少包含操作者类型、模型、Run ID、旧 Hash、新 Hash 和路径。

## 九、项目打包与助手附件

### 9.1 API 与工具

```text
POST /api/v1/conversation-projects/:project_id/archives
GET  /api/v1/conversation-projects/:project_id/archives/:archive_id
```

AI 使用 `project_create_archive` 时调用同一应用服务，禁止维护两套打包逻辑。

### 9.2 打包流程

```text
验证用户与 Project
→ 建立文件清单快照
→ 排除已删除、临时和策略禁止文件
→ 按 relative_path 流式写 ZIP
→ 写入当前用户当前 Project 的对象存储域
→ 创建 FileObject / Project Archive
→ 创建 Assistant Attachment
→ 附件绑定当前会话和助手消息
→ 前端通过受保护文件接口下载
```

归档文件不得进入全局公共文件池。下载时必须校验：

```text
当前用户
AND 当前 Project
AND 当前附件或归档记录
```

如果通过公开分享开放项目归档，必须显式勾选归档附件，使用独立分享快照，并支持撤销和过期时间。

## 十、RAG 执行与隔离

### 10.1 配置解析顺序

```text
平台功能准入与安全上限
→ 用户默认 Embedding / RAG 配置
→ Project 覆盖配置
→ 文件级 rag_opt_out
→ 当前请求选择
```

任何下层配置只能在平台允许范围内收紧或选择，不能突破管理员安全上限。

### 10.2 检索查询约束

向量检索和 BM25 查询必须包含：

```text
owner_user_id = 当前用户
AND project_id = 当前 Project
AND project_file_id IN 已授权文件集合
AND embedding_profile_id = 当前 Profile
AND embedding_signature = 当前签名
AND rag_opt_out = false
```

禁止仅按客户端提交的文件 ID 集合检索。Repository 必须再次连接 Project 与用户归属表确认范围。

### 10.3 检索缓存隔离

缓存键至少包含：

```text
user_id
project_id
embedding_profile_id
embedding_signature
query_hash
authorized_file_set_hash
retrieval_parameters_hash
```

缓存值中不保存跨项目混合结果。用户切换模型、项目文件更新、RAG 配置变化或权限变化时，必须使相关缓存失效。

### 10.4 异步任务隔离

导入、文本提取、Embedding、重建索引、归档任务都必须携带：

```text
owner_user_id
project_id
resource_id
configuration_snapshot_id
```

Worker 执行时重新加载并校验资源归属，不能只信任消息队列载荷。任务重试、取消和状态查询也必须使用用户与 Project 双重过滤。

## 十一、API 权限要求

所有用户级新接口必须挂在认证路由组，禁止放入公开路由。

Repository 方法签名应显式体现权限范围，例如：

```text
GetProjectFile(ctx, userID, projectID, filePublicID)
ListProjectFiles(ctx, userID, projectID, query)
SearchProjectChunks(ctx, userID, projectID, profileID, fileIDs, query)
CreateProjectArchive(ctx, userID, projectID, input)
```

禁止新增以下形式的用户资源方法：

```text
GetProjectFileByID(ctx, fileID)
SearchChunks(ctx, fileIDs, query)
DeleteArchive(ctx, archiveID)
```

管理员统计接口只能返回聚合数据和脱敏错误。平台内置知识库接口继续使用系统所有者域 `owner_user_id = 0`，不得与用户 Project 向量混用。

## 十二、迁移策略

### 12.1 配置迁移

现有全局 Embedding/RAG 配置保留给平台内置知识库。

用户私有文件迁移采用显式选择：

- 管理员开启用户自有 Embedding/RAG 后，用户需要创建自己的 Embedding Profile。
- 未配置用户 Profile 的个人文件继续支持全文模式，不自动使用平台向量模型。
- 不将平台 Embedding Key 或模型配置复制给用户。
- 旧用户文件向量可标记为 legacy；在用户选择自己的 Profile 后按需重建。

### 12.2 Project 迁移

现有 Project 保留会话关系，并为每个 Project 延迟创建 Workspace。

旧会话附件不自动归入 Project，避免产生跨项目隐式共享。用户可执行：

```text
复制到项目
移动到项目
保持个人附件
```

“移动到项目”完成后，原个人文件只有在无其他引用时才能删除。

### 12.3 灰度开关

建议使用平台能力开关控制上线范围：

```text
project_workspace_enabled
project_zip_import_enabled
project_ai_tools_enabled
project_archive_enabled
user_embedding_enabled
user_rag_enabled
```

灰度开关只用于发布控制，不得作为权限校验的唯一依据。

## 十三、测试计划

### 13.1 权限测试

必须覆盖两个用户 A/B、两个项目 A1/A2 的矩阵：

1. A 不能读取、修改、删除、下载 B 的文件。
2. A 不能读取 B 的导入任务、向量状态和归档任务。
3. A1 的会话不能读取或检索 A2 的文件。
4. A1 的 AI 工具不能写入或打包 A2。
5. 修改 URL 中的 Project ID、File ID、Archive ID、Profile ID 均不能越权。
6. A 不能引用 B 的用户渠道、Embedding Profile 或知识库。
7. 管理员普通后台接口不能直接返回用户文件正文和向量正文。
8. 已删除、归档或禁用 Project 的任务不能继续执行。

### 13.2 ZIP 安全测试

覆盖：

- `../` 和绝对路径。
- Windows 盘符和反斜杠混合路径。
- 大小写路径冲突。
- 符号链接和特殊文件。
- 高压缩比文件。
- 超多条目、超深目录和超长路径。
- 声明大小与实际大小不一致。
- 加密 ZIP、损坏 ZIP 和嵌套 ZIP。
- 导入中断、数据库失败和对象存储失败后的清理。

### 13.3 RAG 隔离测试

覆盖：

- 向量查询只返回当前用户当前项目分片。
- BM25 与混合检索遵守相同隔离条件。
- 缓存键包含用户、Project、Profile 和授权文件集合。
- 用户切换向量模型后旧签名结果不再命中。
- 文件设置 `rag_opt_out` 后立即退出检索范围。
- 用户渠道禁用、删除或密钥替换后任务行为正确。
- Worker 重试时重新验证权限和配置快照。

### 13.4 密钥和网络测试

覆盖：

- API 响应、日志、错误、审计和追踪中不出现明文 Key。
- 用户不能通过 Profile API 获取其他用户渠道信息。
- SSRF 规则阻止环回、元数据地址、内网地址和恶意重定向。
- 用户渠道请求受到超时、响应大小和并发限制。

## 十四、审计与可观测性

记录以下审计事件：

```text
project_import_started / completed / failed
project_file_read / written / deleted
project_archive_created / downloaded
user_embedding_profile_created / updated / deleted / tested
user_rag_enabled / disabled
project_rag_changed
project_embedding_reindex_started / completed / failed
permission_denied
```

审计字段至少包含：

```text
user_id
project_id
resource_id
action
actor_type
conversation_id
run_id
request_id
result
error_code
timestamp
```

日志不得记录：

- API Key。
- 完整文件正文。
- 完整向量。
- 敏感文件内容。
- 未脱敏的上游鉴权头。

## 十五、实施阶段

### 阶段一：权限与数据基础

建立 Workspace、Project File、用户 Embedding Profile、用户/项目 RAG 配置和所有权约束；补充统一授权上下文与 Repository 方法。

验收标准：跨用户和跨项目 IDOR 测试全部通过，数据库唯一约束与外键能够阻止错误归属数据。

### 阶段二：管理后台与用户设置拆分

将管理员页面调整为平台治理与准入；在用户自有渠道页面增加向量模型和 RAG 配置。

验收标准：管理员关闭功能时用户接口后端拒绝；开启后用户只能配置自己的渠道与模型。

### 阶段三：ZIP 导入与项目文件树

实现安全解压、导入任务、项目文件 API、前端文件树和配额。

验收标准：安全 ZIP 测试通过，导入失败无残留，Project 文件无法跨域访问。

### 阶段四：用户向量化与 Project RAG

实现用户渠道 Embedding 客户端、Profile 测试、项目向量任务、签名管理和隔离检索。

验收标准：不同用户、不同 Project、不同 Profile 的向量与缓存完全隔离。

### 阶段五：AI 项目工具

实现受控文件列表、读取、搜索、写入、补丁和删除，加入审计及版本记录。

验收标准：工具只能访问当前 Run 绑定的用户和 Project，任何参数篡改均不能越权。

### 阶段六：项目归档与助手附件

实现流式 ZIP 打包、对象存储、归档记录和通用助手文件附件桥接。

验收标准：AI 可生成当前 Project 的 ZIP 附件，用户可下载，其他用户和其他 Project 无法访问。

## 十六、实施清单

1. 为 Conversation Project 增加一对一 Workspace。
2. 新增 Project File 数据模型、迁移、索引、唯一约束和外键。
3. 将 Project File 所有查询统一为 `user_id + project_id + resource_id`。
4. 设计项目对象存储 Key，禁止客户端提供存储路径。
5. 新增用户 Embedding Profile，并强制引用当前用户自有渠道。
6. 新增用户默认 RAG 配置和 Project 覆盖配置。
7. 将 File Chunk 增加用户、Project、Profile 和签名隔离字段。
8. 调整管理后台，只保留平台治理、准入、安全上限和平台内置知识库配置。
9. 在用户渠道设置中增加向量模型发现、配置、测试和状态管理。
10. 在用户设置和 Project 设置中增加 RAG 开关与检索参数。
11. 增加用户渠道 Embedding 的 SSRF、超时、响应大小和并发防护。
12. 实现 ZIP 导入任务和安全预扫描。
13. 实现 ZIP 解压预算、路径、链接、加密包和危险文件校验。
14. 实现 Project 文件树 API 和前端交互。
15. 实现 Project 文件提取、向量化和按 Profile 重建。
16. 修改向量检索、BM25、混合检索与缓存，使其强制按用户和 Project 隔离。
17. 修改异步 Worker，在执行时重新验证用户、Project 和配置快照。
18. 实现项目 AI 文件工具及统一授权执行器。
19. 为 AI 写操作增加版本记录和审计日志。
20. 实现流式项目 ZIP 归档服务。
21. 实现通用助手文件附件桥接，将归档绑定到当前用户、Project、会话和消息。
22. 增加旧 Project、旧附件和旧向量配置迁移策略。
23. 补充跨用户、跨项目、ZIP 安全、RAG 隔离、密钥与 SSRF 自动化测试。
24. 通过灰度开关分阶段上线并观察错误率、任务堆积、存储和向量成本。

## 十七、完成标准

本改造只有在以下条件全部满足时才视为完成：

- 任意用户资源访问均不能仅凭资源 ID 完成。
- 同一用户的不同 Project 无法互相读取、检索、修改或归档文件。
- 用户向量模型只能引用自己的自有渠道，密钥不重复存储、不回显、不写日志。
- 管理员可以控制功能准入和安全上限，但不会替用户配置私有 RAG。
- 向量分片、BM25、混合检索、缓存和异步任务都具备用户与 Project 双重隔离。
- ZIP 导入能抵御路径穿越、压缩炸弹、链接和资源耗尽攻击。
- AI 只能通过受控 Project 工具访问当前项目，不能访问服务器任意文件系统。
- AI 生成的 ZIP 只能由当前用户在授权范围内下载。
- 权限、安全和失败回滚测试全部通过。
